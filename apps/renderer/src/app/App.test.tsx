import { StrictMode } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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
import { mcpUiConfirmationStore } from './mcp-ui-confirmation-store';

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
    const desktopProject = { ...createStarterProject(), name: 'Desktop Hydrated Project', nodes: [], edges: [] };
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
    await waitFor(() => expect(useAppStore.getState().desktopRevision).toBe(8));
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

  it('saves the current project with Ctrl+S and prevents the browser save dialog', async () => {
    const saveProjectExplicitly = vi.fn(async () => true);
    useAppStore.setState({ saveProjectExplicitly } as never);
    render(<App />);

    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(saveProjectExplicitly).toHaveBeenCalledOnce());
  });

  it('routes Ctrl+Z to canvas undo without stealing text-field undo', async () => {
    const undo = vi.fn(async () => {});
    useAppStore.setState({ undo } as never);
    render(<App />);

    const canvasEvent = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true });
    window.dispatchEvent(canvasEvent);
    expect(canvasEvent.defaultPrevented).toBe(true);
    await waitFor(() => expect(undo).toHaveBeenCalledOnce());

    const editor = document.createElement('textarea');
    document.body.append(editor);
    const textEvent = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true, bubbles: true });
    editor.dispatchEvent(textEvent);
    expect(textEvent.defaultPrevented).toBe(false);
    expect(undo).toHaveBeenCalledOnce();
    editor.remove();
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
    const hydrate = vi.fn(async () => ({
      availableSnapshotIds: [],
      lifecycle: 'durable' as const,
      mode: 'desktop' as const,
      project: { ...createStarterProject(), name: 'Strict close hydrated base', nodes: [], edges: [] },
      revision: 20,
      saveStatus: 'saved' as const,
    }));
    replaceProjectPersistenceClientForTests(createHydrationClient({ close, commit, hydrate, stablePoint }));

    render(<StrictMode><App /></StrictMode>);
    await waitFor(() => expect(window.novusDesktop?.lifecycle.subscribeCloseFlushRequest).toHaveBeenCalled());
    await waitFor(() => expect(useAppStore.getState().project.name).toBe('Strict close hydrated base'));
    useAppStore.getState().setProject({ ...createStarterProject(), name: 'Pending strict close draft', nodes: [], edges: [] });

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
    const hydrate = vi.fn(async () => ({
      availableSnapshotIds: [],
      lifecycle: 'durable' as const,
      mode: 'desktop' as const,
      project: { ...createStarterProject(), name: 'Failed close hydrated base', nodes: [], edges: [] },
      revision: 19,
      saveStatus: 'saved' as const,
    }));
    replaceProjectPersistenceClientForTests(createHydrationClient({ close, commit, hydrate, stablePoint }));

    render(<App />);
    await waitFor(() => expect(window.novusDesktop?.lifecycle.subscribeCloseFlushRequest).toHaveBeenCalled());
    await waitFor(() => expect(useAppStore.getState().project.name).toBe('Failed close hydrated base'));
    useAppStore.getState().setProject({ ...createStarterProject(), name: 'Pending failed close draft', nodes: [], edges: [] });

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

  it('automatically saves a renamed untitled project on close without opening a decision dialog', async () => {
    const renamedUntitled = { ...createStarterProject(), name: 'Renamed draft', nodes: [], edges: [] };
    const listeners: Array<(request: { requestId: string }) => void | Promise<void>> = [];
    const ackCloseFlush = vi.fn();
    const chooseCloseDecision = vi.fn(async () => 'cancel' as const);
    const close = vi.fn(async () => {});
    const stablePoint = vi.fn(async () => ({
      availableSnapshotIds: ['close-stable-renamed'],
      lifecycle: 'durable' as const,
      project: renamedUntitled,
      revision: 0,
    }));
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
        project: renamedUntitled,
        revision: 0,
        saveStatus: 'pending' as const,
      })),
      stablePoint,
    }));

    render(<App />);
    await waitFor(() => expect(useAppStore.getState().project.name).toBe('Renamed draft'));
    await listeners[0]?.({ requestId: 'close-request-renamed-untitled' });

    expect(chooseCloseDecision).not.toHaveBeenCalled();
    expect(stablePoint).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(ackCloseFlush.mock.calls).toEqual([
      [{ requestId: 'close-request-renamed-untitled', phase: 'save_started' }],
      [{ requestId: 'close-request-renamed-untitled', phase: 'completed', outcome: 'saved' }],
    ]);
  });

  it('closes a clean untitled project without opening a save decision', async () => {
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
        project: { ...createStarterProject(), nodes: [], edges: [] },
        revision: 0,
        saveStatus: 'saved' as const,
      })),
    }));

    render(<App />);
    await waitFor(() => expect(window.novusDesktop?.lifecycle.subscribeCloseFlushRequest).toHaveBeenCalled());
    await listeners[0]?.({ requestId: 'close-request-clean-untitled' });

    expect(chooseCloseDecision).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(ackCloseFlush.mock.calls).toEqual([
      [{ requestId: 'close-request-clean-untitled', phase: 'save_started' }],
      [{ requestId: 'close-request-clean-untitled', phase: 'completed', outcome: 'saved' }],
    ]);
  });

  it('automatically saves an unnamed dirty project on close without opening a decision dialog', async () => {
    const listeners: Array<(request: { requestId: string }) => void | Promise<void>> = [];
    const ackCloseFlush = vi.fn();
    const chooseCloseDecision = vi.fn(async () => 'cancel' as const);
    const close = vi.fn(async () => {});
    const untitledProject = { ...createStarterProject(), name: '未命名画布', nodes: [], edges: [] };
    const stablePoint = vi.fn(async () => ({
      availableSnapshotIds: ['close-stable-untitled'],
      lifecycle: 'durable' as const,
      project: untitledProject,
      revision: 0,
    }));
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
        project: untitledProject,
        revision: 0,
        saveStatus: 'pending' as const,
      })),
      stablePoint,
    }));
    resetAppStoreForTests({ project: 'empty' });

    render(<App />);
    await waitFor(() => expect(window.novusDesktop?.lifecycle.subscribeCloseFlushRequest).toHaveBeenCalled());
    await listeners[0]?.({ requestId: 'close-request-cancel-1' });

    expect(chooseCloseDecision).not.toHaveBeenCalled();
    expect(stablePoint).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(ackCloseFlush.mock.calls).toEqual([
      [{ requestId: 'close-request-cancel-1', phase: 'save_started' }],
      [{ requestId: 'close-request-cancel-1', phase: 'completed', outcome: 'saved' }],
    ]);
  });
  it('clears MCP confirmation state when the App test lifecycle is reset', () => {
    mcpUiConfirmationStore.publish({
      id: 'plan-reset', kind: 'workflow', title: 'Reset pending workflow', projectId: 'project-reset', expectedRevision: 1,
      mutations: [], paidJobs: [], limitations: [],
    }, { confirm: () => ({ token: 'grant-reset', expiresAt: 301_000 }), reject: vi.fn() });

    resetAppHydrationForTests();

    expect(mcpUiConfirmationStore.getSnapshot()).toEqual([]);
  });
  it('invalidates pending MCP confirmations when the active project changes', async () => {
    const initialProject = { ...createStarterProject(), id: 'project-before-switch', name: 'Before switch', nodes: [], edges: [] };
    replaceProjectPersistenceClientForTests(createHydrationClient({
      hydrate: vi.fn(async () => ({
        availableSnapshotIds: [],
        lifecycle: 'durable' as const,
        mode: 'desktop' as const,
        project: initialProject,
        revision: 4,
        saveStatus: 'saved' as const,
      })),
    }));

    render(<App />);
    await waitFor(() => expect(useAppStore.getState().project.id).toBe('project-before-switch'));
    mcpUiConfirmationStore.publish({
      id: 'plan-before-switch',
      kind: 'workflow',
      title: 'Pending workflow',
      projectId: 'project-before-switch',
      expectedRevision: 4,
      mutations: [],
      paidJobs: [],
      limitations: [],
    }, { confirm: () => ({ token: 'grant-before-switch', expiresAt: 301_000 }), reject: vi.fn() });
    expect(mcpUiConfirmationStore.getSnapshot()).toHaveLength(1);

    act(() => {
      useAppStore.getState().setProject({ ...initialProject, id: 'project-after-switch', name: 'After switch' });
    });

    await waitFor(() => expect(mcpUiConfirmationStore.getSnapshot()).toEqual([]));
  });
  it('subscribes once to MCP runtime requests in StrictMode and responds from the live canvas store', async () => {
    const listeners: Array<(payload: { requestId: string; request: { tool: 'canvas_read_workflow' } }) => void | Promise<void>> = [];
    const respond = vi.fn();
    const onRequest = vi.fn((listener) => {
      listeners.push(listener as (payload: { requestId: string; request: { tool: 'canvas_read_workflow' } }) => void | Promise<void>);
      return vi.fn();
    });
    window.novusDesktop = {
      mcpRuntime: {
        getStatus: vi.fn(async () => ({ state: 'running', rendererConnected: true, serverVersion: '1.0.0', toolCount: 14, lastError: null })),
        onRequest,
        respond,
      },
    } as unknown as typeof window.novusDesktop;
    resetAppStoreForTests({ project: 'empty' });

    render(<StrictMode><App /></StrictMode>);
    await waitFor(() => expect(onRequest).toHaveBeenCalledTimes(1));
    await listeners[0]?.({ requestId: 'mcp-renderer-1', request: { tool: 'canvas_read_workflow' } });

    await waitFor(() => expect(respond).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'mcp-renderer-1',
      response: expect.objectContaining({ ok: true }),
    })));
    const response = respond.mock.calls[0]?.[0]?.response;
    expect(response.result).toMatchObject({
      protocol: 'canvasforge.mcp.snapshot.v1',
      projectId: useAppStore.getState().project.id,
      revision: useAppStore.getState().desktopRevision,
    });
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
