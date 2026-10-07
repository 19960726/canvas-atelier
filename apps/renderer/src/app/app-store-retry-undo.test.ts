import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvasModuleNode, type CanvasProject, type ProjectTransaction } from '@agent-canvas/domain';
import { replaceProjectPersistenceClientForTests, resetAppStoreForTests, useAppStore } from './app-store';
import { createBrowserPersistenceClient, type ProjectCommitRequest, type ProjectCommitResult } from './desktop-persistence';
import { loadPersistedProjectBundle } from './project-persistence';

const asset = {
  assetId: 'aaaaaaaaaaaaaaaa', byteSize: 42, extension: 'png' as const, height: 100,
  label: 'Retry image', mediaType: 'image/png' as const, origin: 'generated' as const,
  sha256: 'a'.repeat(64), width: 100,
};

beforeEach(() => {
  delete window.novusDesktop;
  localStorage.clear();
  sessionStorage.clear();
  replaceProjectPersistenceClientForTests(createBrowserPersistenceClient());
  resetAppStoreForTests({ project: 'empty' });
  useAppStore.setState({
    project: { ...useAppStore.getState().project, assets: [asset] },
    projectLifecycle: 'durable', saveStatus: 'saved',
  });
});

afterEach(() => {
  resetAppStoreForTests({ project: 'empty' });
  vi.restoreAllMocks();
  delete window.novusDesktop;
});

describe('acknowledged failed-commit retry undo', () => {
  it.each(['retry', 'save'] as const)('undoes the recovered image after %s while preserving earlier history and durable nodes', async recovery => {
    const client = failingBrowserClient();
    expect(await useAppStore.getState().addModuleNode('text_prompt', { x: 20, y: 30 })).toBe(true);
    const previousNode = useAppStore.getState().project.nodes[0]!;
    const previousHistory = useAppStore.getState().undoStack;
    client.failNext();

    expect(await useAppStore.getState().addProjectImageInput(asset.assetId, { x: 420, y: 30 })).toBe(false);
    const imageNode = useAppStore.getState().project.nodes.find(node => node.id !== previousNode.id)!;
    expect(useAppStore.getState().undoStack).toBe(previousHistory);
    expect(durableNodes()).toEqual([previousNode]);
    const failedRequest = client.commit.mock.calls[1]![0];

    expect(await (recovery === 'retry'
      ? useAppStore.getState().retryFailedProjectCommit()
      : useAppStore.getState().saveProjectExplicitly())).toBe(true);
    expect(client.commit.mock.calls[2]![0].transaction).toEqual(failedRequest.transaction);
    expect(useAppStore.getState().undoStack).toHaveLength(previousHistory.length + 1);
    expect(useAppStore.getState().undoStack[0]).toBe(previousHistory[0]);
    expect(durableNodes()).toEqual([previousNode, imageNode]);

    await useAppStore.getState().undo();
    expect(useAppStore.getState().project.nodes).toEqual([previousNode]);
    expect(durableNodes()).toEqual([previousNode]);
    expect(useAppStore.getState().undoStack).toEqual(previousHistory);
    await useAppStore.getState().undo();
    expect(useAppStore.getState().project.nodes).toEqual([]);
    expect(durableNodes()).toEqual([]);
    expect(useAppStore.getState().undoStack).toEqual([]);
  });

  it('adds exactly one inverse after repeated failures and concurrent retry requests', async () => {
    const client = failingBrowserClient();
    client.failNext(2);
    expect(await useAppStore.getState().addProjectImageInput(asset.assetId, { x: 20, y: 30 })).toBe(false);
    const retained = useAppStore.getState().project.nodes[0]!;
    expect(useAppStore.getState().undoStack).toEqual([]);
    expect(await useAppStore.getState().retryFailedProjectCommit()).toBe(false);
    expect(useAppStore.getState().undoStack).toEqual([]);

    expect(await Promise.all([
      useAppStore.getState().retryFailedProjectCommit(),
      useAppStore.getState().retryFailedProjectCommit(),
    ])).toEqual([true, false]);
    expect(useAppStore.getState().undoStack).toHaveLength(1);
    expect(useAppStore.getState().project.nodes).toEqual([retained]);
    expect(durableNodes()).toEqual([retained]);
    for (const [request] of client.commit.mock.calls) {
      expect(request.transaction).toEqual(client.commit.mock.calls[0]![0].transaction);
    }
    expect(await useAppStore.getState().retryFailedProjectCommit()).toBe(false);
    expect(useAppStore.getState().undoStack).toHaveLength(1);
    await useAppStore.getState().undo();
    expect(durableNodes()).toEqual([]);
    expect(useAppStore.getState().undoStack).toEqual([]);
  });

  it('keeps undo history unchanged until the retry acknowledgement arrives', async () => {
    const client = failingBrowserClient();
    client.failNext();
    expect(await useAppStore.getState().addProjectImageInput(asset.assetId, { x: 20, y: 30 })).toBe(false);
    const acknowledgement = deferred<ProjectCommitResult>();
    client.commit.mockImplementationOnce(() => acknowledgement.promise);
    const retry = useAppStore.getState().retryFailedProjectCommit();
    expect(useAppStore.getState().saveStatus).toBe('saving');
    expect(useAppStore.getState().undoStack).toEqual([]);
    const request = client.commit.mock.calls[1]![0];
    acknowledgement.resolve(await client.browser.commit(request));
    expect(await retry).toBe(true);
    expect(useAppStore.getState().undoStack).toHaveLength(1);
    await useAppStore.getState().undo();
    expect(durableNodes()).toEqual([]);
  });

  it.each(['retry', 'save'] as const)('consumes only the recovered failed undo after %s and retains earlier history', async recovery => {
    const client = failingBrowserClient();
    expect(await useAppStore.getState().addModuleNode('text_prompt', { x: 20, y: 30 })).toBe(true);
    const previousNode = useAppStore.getState().project.nodes[0]!;
    expect(await useAppStore.getState().addProjectImageInput(asset.assetId, { x: 420, y: 30 })).toBe(true);
    const previousHistory = useAppStore.getState().undoStack;
    const durableBefore = durableNodes();
    client.failNext(2);

    await useAppStore.getState().undo();
    expect(useAppStore.getState().project.nodes).toEqual([previousNode]);
    expect(durableNodes()).toEqual(durableBefore);
    expect(useAppStore.getState().undoStack).toBe(previousHistory);
    const failedRequest = client.commit.mock.calls[2]![0];
    expect(failedRequest.kind).toBe('system');
    const recover = () => recovery === 'retry'
      ? useAppStore.getState().retryFailedProjectCommit()
      : useAppStore.getState().saveProjectExplicitly();
    expect(await recover()).toBe(false);
    expect(useAppStore.getState().undoStack).toBe(previousHistory);
    expect(await recover()).toBe(true);
    expect(useAppStore.getState().undoStack).toEqual([previousHistory[0]]);
    expect(durableNodes()).toEqual([previousNode]);
    expect(await useAppStore.getState().retryFailedProjectCommit()).toBe(false);
    expect(useAppStore.getState().undoStack).toEqual([previousHistory[0]]);
    for (const [request] of client.commit.mock.calls.slice(2)) {
      expect(request.transaction).toEqual(failedRequest.transaction);
      expect(request).not.toHaveProperty('undoEntryToConsume');
    }
    await useAppStore.getState().undo();
    expect(useAppStore.getState().project.nodes).toEqual([]);
    expect(durableNodes()).toEqual([]);
    expect(useAppStore.getState().undoStack).toEqual([]);
  });

  it('does not add an undo entry for a recovered idle autosave', async () => {
    const client = failingBrowserClient();
    const node = createCanvasModuleNode('autosaved-node', 'text_prompt', { x: 20, y: 30 });
    client.failNext();
    useAppStore.getState().setProject({ ...useAppStore.getState().project, nodes: [node] });
    expect(await useAppStore.getState().saveProjectExplicitly()).toBe(false);
    expect(client.commit.mock.calls[0]![0].kind).toBe('system');
    expect(useAppStore.getState().undoStack).toEqual([]);
    expect(await useAppStore.getState().saveProjectExplicitly()).toBe(true);
    expect(useAppStore.getState().undoStack).toEqual([]);
    expect(durableNodes()).toEqual([node]);
  });

  it.each(['agent', 'mixed-canvas'] as const)('preserves custom history ownership for a recovered %s commit', async kind => {
    const client = failingBrowserClient();
    const node = createCanvasModuleNode('custom-node', 'text_prompt', { x: 20, y: 30 });
    const transaction: ProjectTransaction = {
      id: 'custom-commit', label: 'Custom history owner',
      operations: [{ kind: 'canvas', operation: { kind: 'create_node', node } },
        ...(kind === 'mixed-canvas' ? [{ kind: 'set_skill_candidates' as const, candidates: [] }] : [])],
    };
    client.failNext();
    expect(await useAppStore.getState().commitProjectTransaction(transaction, {
      kind: kind === 'agent' ? 'agent' : 'canvas',
    })).toBe(false);
    expect(await useAppStore.getState().retryFailedProjectCommit()).toBe(true);
    expect(useAppStore.getState().undoStack).toEqual([]);
    expect(durableNodes()).toEqual([node]);
  });

  it.each(['project', 'session'] as const)('does not append an obsolete inverse after the %s changes before acknowledgement', async boundary => {
    const client = failingBrowserClient();
    const current = useAppStore.getState().project;
    const replacement = { ...current, id: boundary === 'project' ? 'replacement-project' : current.id,
      nodes: [createCanvasModuleNode('replacement-node', 'text_prompt', { x: 20, y: 30 })] };
    let sessionId = 'retry-session-a';
    replaceProjectPersistenceClientForTests({ ...client.browser, commit: client.commit,
      getSessionId: () => sessionId,
      openProject: async () => {
        sessionId = 'retry-session-b';
        return { availableSnapshotIds: [], lifecycle: 'durable', mode: 'desktop',
          project: replacement, revision: 9, saveStatus: 'saved' };
      },
    });
    client.failNext();
    expect(await useAppStore.getState().addProjectImageInput(asset.assetId, { x: 420, y: 30 })).toBe(false);
    const acknowledgement = deferred<ProjectCommitResult>();
    client.commit.mockImplementationOnce(() => acknowledgement.promise);
    const retry = useAppStore.getState().retryFailedProjectCommit();
    const request = client.commit.mock.calls[1]![0];
    expect(await useAppStore.getState().openProject()).toBe(true);
    const history = useAppStore.getState().undoStack;
    acknowledgement.resolve({ ok: true, project: request.nextProject, revision: request.baseRevision + 1 });
    expect(await retry).toBe(false);
    expect(useAppStore.getState().project).toEqual(replacement);
    expect(useAppStore.getState().desktopRevision).toBe(9);
    expect(useAppStore.getState().undoStack).toBe(history);
  });

  it('does not append an inverse if the same project is reopened between acknowledgement and completion', async () => {
    const client = failingBrowserClient();
    const replacement = { ...useAppStore.getState().project,
      nodes: [createCanvasModuleNode('reopened-node', 'text_prompt', { x: 20, y: 30 })] };
    replaceProjectPersistenceClientForTests({ ...client.browser, commit: client.commit,
      openProject: async () => ({ availableSnapshotIds: [], lifecycle: 'durable', mode: 'browser',
        project: replacement, revision: 9, saveStatus: 'saved' }),
    });
    client.failNext();
    expect(await useAppStore.getState().addProjectImageInput(asset.assetId, { x: 420, y: 30 })).toBe(false);
    let opened: Promise<boolean> | null = null;
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (opened === null && state.saveStatus === 'saved' && previous.saveStatus === 'saving') {
        opened = useAppStore.getState().openProject();
      }
    });
    try {
      await useAppStore.getState().retryFailedProjectCommit();
      expect(opened).not.toBeNull();
      expect(await opened).toBe(true);
      expect(useAppStore.getState().project).toEqual(replacement);
      expect(useAppStore.getState().undoStack).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it('does not create undo history for an image failure that cannot be retained or retried', async () => {
    const client = failingBrowserClient();
    client.commit.mockImplementationOnce(async request => ({
      ok: false, code: 'INVALID_REQUEST', retryable: false,
      project: request.previousProject, revision: request.baseRevision,
    }));
    expect(await useAppStore.getState().addProjectImageInput(asset.assetId, { x: 20, y: 30 })).toBe(false);
    expect(useAppStore.getState().project.nodes).toEqual([]);
    expect(useAppStore.getState().undoStack).toEqual([]);
    expect(await useAppStore.getState().retryFailedProjectCommit()).toBe(false);
    expect(useAppStore.getState().undoStack).toEqual([]);
  });
});

function failingBrowserClient() {
  const browser = createBrowserPersistenceClient();
  let failures = 0;
  const commit = vi.fn(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => {
    if (failures > 0) {
      failures -= 1;
      return { ok: false, code: 'DISK_FULL', project: request.previousProject, revision: request.baseRevision };
    }
    return browser.commit(request);
  });
  replaceProjectPersistenceClientForTests({ ...browser, commit });
  return { browser, commit, failNext: (count = 1) => { failures = count; } };
}

function durableNodes(): CanvasProject['nodes'] {
  const saved = loadPersistedProjectBundle(localStorage);
  expect(saved).not.toBeNull();
  return saved!.current.nodes;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
