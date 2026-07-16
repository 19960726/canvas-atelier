import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasProject } from '@agent-canvas/domain';
import {
  createStarterProject,
  replaceProjectPersistenceClientForTests,
  resetAppStoreForTests,
  useAppStore,
} from './app-store';
import { AUTOSAVE_IDLE_MS } from './autosave';
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
      mode: 'browser',
      project: createStarterProject(),
      revision: 0,
      saveStatus: 'pending',
    })),
    restore: overrides.restore ?? (async () => ({
      availableSnapshotIds: [],
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
