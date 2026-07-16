import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStarterProject,
  replaceKnowledgeClientForTests,
  replaceProjectPersistenceClientForTests,
  resetAppStoreForTests,
  useAppStore,
} from './app-store';
import type { KnowledgeClient } from './knowledge-client';
import type { ProjectCommitRequest, ProjectCommitResult, ProjectPersistenceClient } from './desktop-persistence';
import { App, resetAppHydrationForTests } from './App';

describe('App persistence hydration', () => {
  beforeEach(() => {
    delete window.novusDesktop;
    localStorage.clear();
    resetAppHydrationForTests();
    replaceProjectPersistenceClientForTests(createHydrationClient());
    resetAppStoreForTests();
  });

  it('hydrates the renderer from the persistence client on startup', async () => {
    const desktopProject = { ...createStarterProject(), name: 'Desktop Hydrated Project' };
    const hydrate = vi.fn(async () => ({
      availableSnapshotIds: ['desktop-after'],
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

    await waitFor(() => expect(ackCloseFlush).toHaveBeenCalledTimes(1));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(stablePoint).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(ackCloseFlush).toHaveBeenCalledWith({ requestId: 'close-request-strict-1', ok: true });
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

    await waitFor(() => expect(ackCloseFlush).toHaveBeenCalledTimes(1));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(stablePoint).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(useAppStore.getState().saveErrorCode).toBe('INVALID_REQUEST');
    expect(ackCloseFlush).toHaveBeenCalledWith({ requestId: 'close-request-failed-1', ok: false });
  });
});

function createKnowledgeClient(overrides: Partial<KnowledgeClient> = {}): KnowledgeClient {
  return {
    configure: overrides.configure ?? (async () => {}),
    getLease: overrides.getLease ?? (() => {
      throw new Error('getLease not expected');
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
