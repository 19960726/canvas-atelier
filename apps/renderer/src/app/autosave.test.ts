import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasProject } from '@agent-canvas/domain';
import {
  createStarterProject,
  replaceProjectPersistenceClientForTests,
  resetAppStoreForTests,
  useAppStore,
} from './app-store';
import {
  AUTOSAVE_IDLE_MS,
  createAutosaveController,
  type AutosaveDraft,
  type AutosaveFlushReason,
} from './autosave';
import type {
  ProjectCommitRequest,
  ProjectCommitResult,
  ProjectPersistenceClient,
} from './desktop-persistence';

describe('renderer autosave', () => {
  beforeEach(() => {
    delete window.novusDesktop;
    vi.useFakeTimers();
    replaceProjectPersistenceClientForTests(createMockClient());
    resetAppStoreForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('debounces normal draft saves at 750ms and shows saved only after durable ACK', async () => {
    const ack = deferred<ProjectCommitResult>();
    const commit = vi.fn(() => ack.promise);
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    resetAppStoreForTests();

    useAppStore.getState().setProject(namedProject('draft-at-750ms'));

    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS - 1);
    expect(commit).not.toHaveBeenCalled();
    expect(useAppStore.getState().saveStatus).toBe('pending');

    await vi.advanceTimersByTimeAsync(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().saveStatus).toBe('saving');

    ack.resolve({ ok: true, project: namedProject('draft-at-750ms'), revision: 3 });
    await vi.runAllTimersAsync();

    expect(useAppStore.getState().saveStatus).toBe('saved');
    expect(useAppStore.getState().desktopRevision).toBe(3);
  });

  it('coalesces multiple draft mutations into the newest project and never full-saves pointermove previews', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    resetAppStoreForTests();

    useAppStore.getState().setProject(namedProject('first-draft'));
    await vi.advanceTimersByTimeAsync(400);
    useAppStore.getState().setProject(namedProject('newest-draft'));
    useAppStore.getState().setProject(namedProject('pointermove-preview'), { schedulePersist: false });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]?.[0].nextProject.name).toBe('newest-draft');
  });

  it('preserves a newer draft scheduled while an older autosave commit is in flight', async () => {
    const firstAck = deferred<boolean>();
    const commit = vi.fn()
      .mockReturnValueOnce(firstAck.promise)
      .mockResolvedValueOnce(true);
    const controller = createAutosaveController<CanvasProject>({ commit });

    controller.schedule({ project: namedProject('older-in-flight'), revision: 1 });
    const flush = controller.flush('idle');
    controller.schedule({ project: namedProject('latest-autosave-must-survive'), revision: 1 });
    firstAck.resolve(true);

    await expect(flush).resolves.toBe(true);
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls[1]![0].project.name).toBe('latest-autosave-must-survive');
  });

  it('shares one in-flight controller flush promise across concurrent close boundaries', async () => {
    const ack = deferred<boolean>();
    const commit = vi.fn((_draft: AutosaveDraft<CanvasProject>, _reason: AutosaveFlushReason) => ack.promise);
    const controller = createAutosaveController<CanvasProject>({ commit });

    controller.schedule({ project: namedProject('shared-in-flight'), revision: 2 });
    const blurFlush = controller.flush('blur');
    const closeFlush = controller.flush('close');

    expect(closeFlush).toBe(blurFlush);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]![0].project.name).toBe('shared-in-flight');

    ack.resolve(true);
    await expect(blurFlush).resolves.toBe(true);
    await expect(closeFlush).resolves.toBe(true);
  });

  it('dedupes concurrent blur/pagehide/close flushes through one commit and one stable point', async () => {
    const ack = deferred<ProjectCommitResult>();
    const commit = vi.fn(() => ack.promise);
    const stablePoint = vi.fn(async () => ({
      availableSnapshotIds: ['stable-concurrent'],
      project: namedProject('concurrent-draft'),
      revision: 12,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit, stablePoint }));
    resetAppStoreForTests();

    useAppStore.getState().setProject(namedProject('concurrent-draft'));
    const blurFlush = useAppStore.getState().flushProjectSave('blur');
    const closeFlush = useAppStore.getState().flushProjectSave('close');

    expect(commit).toHaveBeenCalledTimes(1);
    expect(stablePoint).not.toHaveBeenCalled();

    ack.resolve({ ok: true, project: namedProject('concurrent-draft'), revision: 12 });
    await expect(Promise.all([blurFlush, closeFlush])).resolves.toEqual([true, true]);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(stablePoint).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().availableSnapshotIds).toEqual(['stable-concurrent']);
  });

  it('flushes blur and close boundaries through the existing commit and stablePoint bridge', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 8,
    }));
    const stablePoint = vi.fn(async () => ({
      availableSnapshotIds: ['stable-8'],
      project: namedProject('blur-draft'),
      revision: 8,
    }));
    const close = vi.fn(async () => {});
    replaceProjectPersistenceClientForTests(createMockClient({ close, commit, stablePoint }));
    resetAppStoreForTests();

    useAppStore.getState().setProject(namedProject('blur-draft'));
    await useAppStore.getState().flushProjectSave('blur');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    await useAppStore.getState().closePersistence();

    expect(commit).toHaveBeenCalledTimes(1);
    expect(stablePoint).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().availableSnapshotIds).toEqual(['stable-8']);
  });

  it('returns false and preserves the save error when a pending autosave ACK fails', async () => {
    const commit = vi.fn(async ({ previousProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      code: 'INVALID_REQUEST',
      ok: false,
      project: previousProject,
      revision: 4,
    }));
    const stablePoint = vi.fn(async () => ({
      availableSnapshotIds: ['should-not-read'],
      project: namedProject('stable-should-not-apply'),
      revision: 4,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit, stablePoint }));
    resetAppStoreForTests();

    useAppStore.getState().setProject(namedProject('will-fail-ack'));
    const flushed = await useAppStore.getState().flushProjectSave('blur');

    expect(flushed).toBe(false);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(stablePoint).not.toHaveBeenCalled();
    expect(useAppStore.getState().saveStatus).toBe('error');
    expect(useAppStore.getState().saveErrorCode).toBe('INVALID_REQUEST');
  });

  it('keeps an untitled workflow pending after an in-memory autosave and stable-point boundary', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 0,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    resetAppStoreForTests({ project: 'empty' });
    useAppStore.getState().setProject({ ...useAppStore.getState().project, name: 'Renamed untitled draft' });

    await expect(useAppStore.getState().flushProjectSave('blur')).resolves.toBe(true);

    expect(commit).toHaveBeenCalledOnce();
    expect(useAppStore.getState().projectLifecycle).toBe('untitled');
    expect(useAppStore.getState().saveStatus).toBe('pending');
  });

  it('creates a stable point and succeeds when close flush has no pending or in-flight draft', async () => {
    const commit = vi.fn();
    const stablePoint = vi.fn(async () => ({
      availableSnapshotIds: ['stable-no-pending'],
      project: namedProject('already-durable'),
      revision: 9,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit, stablePoint }));
    resetAppStoreForTests();
    useAppStore.setState({ saveStatus: 'saved' });

    const flushed = await useAppStore.getState().flushProjectSave('close');

    expect(flushed).toBe(true);
    expect(commit).not.toHaveBeenCalled();
    expect(stablePoint).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().saveStatus).toBe('saved');
    expect(useAppStore.getState().availableSnapshotIds).toEqual(['stable-no-pending']);
  });
});

function namedProject(name: string): CanvasProject {
  return { ...createStarterProject(), name };
}

function createMockClient(overrides: Partial<ProjectPersistenceClient> = {}): ProjectPersistenceClient {
  return {
    close: overrides.close ?? (async () => {}),
    commit: overrides.commit ?? (async ({ nextProject }) => ({ ok: true, project: nextProject, revision: 1 })),
    hydrate: overrides.hydrate ?? (async () => ({
      availableSnapshotIds: [],
      lifecycle: 'durable',
      mode: 'browser',
      project: createStarterProject(),
      revision: 0,
      saveStatus: 'pending',
    })),
    importProjectImage: overrides.importProjectImage ?? (async () => null),
    listProjectImages: overrides.listProjectImages ?? (async () => []),
    pasteClipboardImage: overrides.pasteClipboardImage ?? (async () => null),
    restore: overrides.restore ?? (async () => ({
      availableSnapshotIds: [],
      lifecycle: 'durable',
      project: createStarterProject(),
      revision: 0,
      saveStatus: 'saved',
    })),
    stablePoint: overrides.stablePoint ?? (async () => ({
      availableSnapshotIds: [],
      project: createStarterProject(),
      revision: 0,
    })),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
