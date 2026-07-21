import { StrictMode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStarterProject,
  replaceKnowledgeClientForTests,
  replaceProjectPersistenceClientForTests,
  resetAppStoreForTests,
  useAppStore,
} from './app-store';
import type { KnowledgeClient } from './knowledge-client';
import type { ProjectCommitRequest, ProjectCommitResult, ProjectPersistenceClient } from './desktop-persistence';
import { createBrowserPersistenceClient } from './desktop-persistence';
import { PROJECT_STORAGE_KEY } from './project-persistence';
import { App, resetAppHydrationForTests } from './App';

describe('App persistence hydration', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    delete window.novusDesktop;
    localStorage.clear();
    resetAppHydrationForTests();
    replaceProjectPersistenceClientForTests(createHydrationClient());
    resetAppStoreForTests();
  });

  it('does not restore browser-local canvas content during a normal App launch', async () => {
    localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify({
      current: { ...createStarterProject(), name: '旧浏览器画布' },
      schemaVersion: 2,
      snapshots: [],
    }));
    replaceProjectPersistenceClientForTests(createBrowserPersistenceClient());
    resetAppStoreForTests();

    render(<App />);

    await waitFor(() => expect(useAppStore.getState().persistenceMode).toBe('browser'));
    expect(useAppStore.getState().project).toMatchObject({ name: '未命名画布', nodes: [], edges: [] });
    expect(useAppStore.getState().saveStatus).toBe('pending');
    expect(screen.queryByText('旧浏览器画布')).toBeNull();
  });

  it('hydrates the renderer from the persistence client on startup', async () => {
    const desktopProject = { ...createStarterProject(), name: 'Desktop Hydrated Project' };
    const hydrate = vi.fn(async () => ({
      availableSnapshotIds: ['desktop-after'],
      lifecycle: 'durable' as const,
      mode: 'desktop' as const,
      project: desktopProject,
      revision: 8,
      saveStatus: 'saved' as const,
    }));
    replaceProjectPersistenceClientForTests(createHydrationClient({ hydrate }));

    render(<App />);

    await waitFor(() => expect(hydrate).toHaveBeenCalledTimes(1));
    expect(useAppStore.getState()).toMatchObject({
      availableSnapshotIds: ['desktop-after'],
      desktopRevision: 8,
      persistenceMode: 'desktop',
      project: { name: 'Desktop Hydrated Project' },
      saveStatus: 'saved',
    });
    expect(screen.getByText('Desktop Hydrated Project')).toBeInTheDocument();
  });

  it('initializes renderer knowledge on startup', async () => {
    const start = vi.fn(async () => {});
    replaceKnowledgeClientForTests(createKnowledgeClient({ start }));

    render(<App />);

    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
  });

  it('does not close persistence during StrictMode mount cleanup replay', async () => {
    const hydratedProject = { ...createStarterProject(), name: 'StrictMode Durable Project' };
    const close = vi.fn(async () => {});
    const hydrate = vi.fn(async () => ({
      availableSnapshotIds: ['strict-snapshot'],
      lifecycle: 'durable' as const,
      mode: 'desktop' as const,
      project: hydratedProject,
      revision: 15,
      saveStatus: 'saved' as const,
    }));
    const start = vi.fn(async () => {});
    const stop = vi.fn();
    replaceProjectPersistenceClientForTests(createHydrationClient({ close, hydrate }));
    replaceKnowledgeClientForTests(createKnowledgeClient({ start, stop }));

    const view = render(<StrictMode><App /></StrictMode>);

    await waitFor(() => expect(hydrate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(close).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(useAppStore.getState().project.name).toBe('StrictMode Durable Project');

    view.unmount();

    expect(close).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(useAppStore.getState().project.name).toBe('StrictMode Durable Project');
  });

  it('subscribes once to desktop close-flush requests in StrictMode and ACKs after durable close', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 21,
    }));
    const stablePoint = vi.fn(async () => ({
      availableSnapshotIds: ['strict-close-stable'],
      project: { ...createStarterProject(), name: 'Strict close stable' },
      revision: 21,
    }));
    const close = vi.fn(async () => {});
    const listeners: Array<(request: { requestId: string }) => void | Promise<void>> = [];
    const ackCloseFlush = vi.fn();
    const unsubscribe = vi.fn();
    window.novusDesktop = {
      lifecycle: {
        ackCloseFlush,
        subscribeCloseFlushRequest: vi.fn((listener) => {
          listeners.push(listener);
          return unsubscribe;
        }),
      },
    } as unknown as typeof window.novusDesktop;
    replaceProjectPersistenceClientForTests(createHydrationClient({ close, commit, stablePoint }));

    render(<StrictMode><App /></StrictMode>);
    await waitFor(() => expect(window.novusDesktop?.lifecycle.subscribeCloseFlushRequest).toHaveBeenCalled());
    useAppStore.getState().setProject({ ...createStarterProject(), name: 'Pending strict close draft' });

    await listeners[listeners.length - 1]?.({ requestId: 'close-request-strict-1' });

    await waitFor(() => expect(ackCloseFlush).toHaveBeenCalledTimes(2));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(stablePoint).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(ackCloseFlush.mock.calls).toEqual([
      [{ requestId: 'close-request-strict-1', phase: 'save_started' }],
      [{ requestId: 'close-request-strict-1', phase: 'completed', outcome: 'saved' }],
    ]);
  });

  it('ACKs close-flush false when the pending durable save fails', async () => {
    const commit = vi.fn(async ({ previousProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      code: 'INVALID_REQUEST',
      ok: false,
      project: previousProject,
      revision: 20,
    }));
    const stablePoint = vi.fn();
    const close = vi.fn(async () => {});
    const listeners: Array<(request: { requestId: string }) => void | Promise<void>> = [];
    const ackCloseFlush = vi.fn();
    window.novusDesktop = {
      lifecycle: {
        ackCloseFlush,
        subscribeCloseFlushRequest: vi.fn((listener) => {
          listeners.push(listener);
          return vi.fn();
        }),
      },
    } as unknown as typeof window.novusDesktop;
    replaceProjectPersistenceClientForTests(createHydrationClient({ close, commit, stablePoint }));

    render(<App />);
    await waitFor(() => expect(window.novusDesktop?.lifecycle.subscribeCloseFlushRequest).toHaveBeenCalled());
    useAppStore.getState().setProject({ ...createStarterProject(), name: 'Pending failed close draft' });

    await listeners[listeners.length - 1]?.({ requestId: 'close-request-failed-1' });

    await waitFor(() => expect(ackCloseFlush).toHaveBeenCalledTimes(2));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(stablePoint).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(useAppStore.getState().saveErrorCode).toBe('INVALID_REQUEST');
    expect(ackCloseFlush.mock.calls).toEqual([
      [{ requestId: 'close-request-failed-1', phase: 'save_started' }],
      [{ requestId: 'close-request-failed-1', phase: 'completed', outcome: 'failed' }],
    ]);
  });

  it('treats an explicitly opened durable project named 未命名画布 as durable lifecycle state', async () => {
    const durableProject = { ...createStarterProject(), name: '未命名画布' };
    const listeners: Array<(request: { requestId: string }) => void | Promise<void>> = [];
    const ackCloseFlush = vi.fn();
    const chooseCloseDecision = vi.fn(async () => 'cancel' as const);
    window.novusDesktop = {
      lifecycle: {
        ackCloseFlush,
        chooseCloseDecision,
        subscribeCloseFlushRequest: vi.fn((listener) => {
          listeners.push(listener);
          return vi.fn();
        }),
      },
    } as unknown as typeof window.novusDesktop;
    replaceProjectPersistenceClientForTests(createHydrationClient({
      hydrate: vi.fn(async () => ({
        availableSnapshotIds: [],
        lifecycle: 'durable' as const,
        mode: 'desktop' as const,
        project: durableProject,
        revision: 4,
        saveStatus: 'saved' as const,
      })),
    }));

    render(<App />);
    await waitFor(() => expect(useAppStore.getState().project.name).toBe('未命名画布'));
    useAppStore.getState().setProject({ ...durableProject, graphVersion: 2 });
    await listeners[0]?.({ requestId: 'close-request-durable-name' });

    expect(chooseCloseDecision).not.toHaveBeenCalled();
    expect(ackCloseFlush).toHaveBeenLastCalledWith({ requestId: 'close-request-durable-name', phase: 'completed', outcome: 'saved' });
  });

  it('keeps a renamed untitled project on the untitled close-choice path', async () => {
    const renamedUntitled = { ...createStarterProject(), name: 'Renamed draft', nodes: [], edges: [] };
    const listeners: Array<(request: { requestId: string }) => void | Promise<void>> = [];
    const ackCloseFlush = vi.fn();
    const chooseCloseDecision = vi.fn(async () => 'cancel' as const);
    window.novusDesktop = {
      lifecycle: {
        ackCloseFlush,
        chooseCloseDecision,
        subscribeCloseFlushRequest: vi.fn((listener) => {
          listeners.push(listener);
          return vi.fn();
        }),
      },
    } as unknown as typeof window.novusDesktop;
    replaceProjectPersistenceClientForTests(createHydrationClient({
      hydrate: vi.fn(async () => ({
        availableSnapshotIds: [],
        lifecycle: 'untitled' as const,
        mode: 'desktop' as const,
        project: renamedUntitled,
        revision: 0,
        saveStatus: 'pending' as const,
      })),
    }));

    render(<App />);
    await waitFor(() => expect(useAppStore.getState().project.name).toBe('Renamed draft'));
    await listeners[0]?.({ requestId: 'close-request-renamed-untitled' });

    expect(chooseCloseDecision).toHaveBeenCalledWith({ dirty: true, projectName: 'Renamed draft', untitled: true });
    expect(ackCloseFlush).toHaveBeenCalledWith({ requestId: 'close-request-renamed-untitled', phase: 'completed', outcome: 'cancelled' });
  });

  it('uses the desktop Save Discard Cancel choice for an unnamed dirty project and aborts on cancel', async () => {
    const listeners: Array<(request: { requestId: string }) => void | Promise<void>> = [];
    const ackCloseFlush = vi.fn();
    const chooseCloseDecision = vi.fn(async () => 'cancel' as const);
    const close = vi.fn(async () => {});
    window.novusDesktop = {
      lifecycle: {
        ackCloseFlush,
        chooseCloseDecision,
        subscribeCloseFlushRequest: vi.fn((listener) => {
          listeners.push(listener);
          return vi.fn();
        }),
      },
    } as unknown as typeof window.novusDesktop;
    replaceProjectPersistenceClientForTests(createHydrationClient({
      close,
      hydrate: vi.fn(async () => ({
        availableSnapshotIds: [],
        lifecycle: 'untitled' as const,
        mode: 'desktop' as const,
        project: { ...createStarterProject(), name: '未命名画布', nodes: [], edges: [] },
        revision: 0,
        saveStatus: 'pending' as const,
      })),
    }));
    resetAppStoreForTests({ project: 'empty' });

    render(<App />);
    await waitFor(() => expect(window.novusDesktop?.lifecycle.subscribeCloseFlushRequest).toHaveBeenCalled());
    await listeners[0]?.({ requestId: 'close-request-cancel-1' });

    expect(chooseCloseDecision).toHaveBeenCalledWith({ dirty: true, projectName: '未命名画布', untitled: true });
    expect(close).not.toHaveBeenCalled();
    expect(ackCloseFlush).toHaveBeenCalledWith({ requestId: 'close-request-cancel-1', phase: 'completed', outcome: 'cancelled' });
  });
});

function createKnowledgeClient(overrides: Partial<KnowledgeClient> = {}): KnowledgeClient {
  return {
    configure: overrides.configure ?? (async () => {}),
    getLease: overrides.getLease ?? (() => {
      throw new Error('getLease not expected');
    }),
    prepareSkillCandidateReview: overrides.prepareSkillCandidateReview ?? (async () => {
      throw new Error('prepareSkillCandidateReview not expected');
    }),
    review: overrides.review ?? (async () => {
      throw new Error('review not expected');
    }),
    start: overrides.start ?? (async () => {}),
    stop: overrides.stop ?? (() => {}),
  };
}

function createHydrationClient(overrides: Partial<ProjectPersistenceClient> = {}): ProjectPersistenceClient {
  return {
    close: overrides.close ?? (async () => {}),
    commit: overrides.commit ?? (async ({ nextProject }) => ({
      ok: true,
      project: nextProject,
      revision: 1,
    })),
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
