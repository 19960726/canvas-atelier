import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyProjectTransaction,
  createCanvasModuleNode,
  DEFAULT_MCP_PERMISSION_FLAGS,
  parseCanvasProject,
  type CanvasModuleNode,
  type CanvasProject,
  type ReverseAgentNodeConfig,
} from '@agent-canvas/domain';
import {
  createStarterProject,
  replaceProjectPersistenceClientForTests,
  resetAppStoreForTests,
  useAppStore,
} from './app-store';
import { AUTOSAVE_IDLE_MS } from './autosave';
import { createBrowserPersistenceClient, createDesktopPersistenceClient, type ProjectCommitRequest } from './desktop-persistence';
import { createMcpWorkspaceAdapter } from './mcp-workspace-adapter';

const imageAssetId = '0123456789abcdef';
const oldDraft: ReverseAgentNodeConfig = {
  modelRoute: 'old-route', role: 'Older analyst', task: 'Preserve the original reference',
  analysisDepth: 'standard', knowledgeBaseIds: [], referenceAssetIds: [imageAssetId],
};
const selectedDraft: ReverseAgentNodeConfig = {
  ...oldDraft, modelRoute: 'selected-route', role: 'Current analyst',
  task: 'Preserve the latest explicit constraint', analysisDepth: 'deep',
};

beforeEach(() => {
  delete window.novusDesktop;
  localStorage.clear();
  vi.useFakeTimers();
  resetAppStoreForTests();
});

afterEach(() => {
  resetAppStoreForTests();
  replaceProjectPersistenceClientForTests(createBrowserPersistenceClient());
  vi.useRealTimers();
  delete window.novusDesktop;
  localStorage.clear();
});

describe('reverse route and native queued autosave', () => {
  it('never republishes an older queued route after the new draft has reached the real store', async () => {
    const fixture = await nativeFixture(true);
    const moving = useAppStore.getState().commitNodePositions([{ nodeId: 'reference', position: { x: 30, y: 50 } }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.nativeCommits).toHaveBeenCalledTimes(1);

    // The timer dequeues this old snapshot into the real stable operation
    // queue while the native position acknowledgement remains unresolved.
    await expect(useAppStore.getState().draftReverseAgentConfig('reverse', oldDraft)).resolves.toBe(true);
    // Change a real old draft field so this call schedules an idle save.
    await expect(useAppStore.getState().draftReverseAgentConfig('reverse', { ...oldDraft, task: 'Older queued task' })).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    expect(fixture.nativeCommits).toHaveBeenCalledTimes(1);

    const observedRoutes: string[] = [];
    const stopObserving = useAppStore.subscribe(state => {
      const route = reverseNode(state.project).data.config.modelRoute;
      if (typeof route === 'string' && observedRoutes[observedRoutes.length - 1] !== route) observedRoutes.push(route);
    });
    try {
      await expect(useAppStore.getState().draftReverseAgentConfig('reverse', selectedDraft)).resolves.toBe(true);
      expect(reverseNode(useAppStore.getState().project).data.config).toMatchObject(selectedDraft);
      fixture.releaseFirstAck();
      await expect(moving).resolves.toBe(true);
      await vi.runAllTimersAsync();

      expect(reverseNode(fixture.durable()).data.config).toMatchObject(selectedDraft);
      expect(reverseNode(useAppStore.getState().project).data.config).toMatchObject(selectedDraft);
      fixture.assertProtectedGraph();
      // A final correct snapshot is insufficient: the mounted route must
      // never see the old value between the optimistic edit and final ACK.
      expect(observedRoutes, JSON.stringify(fixture.events)).toEqual(['selected-route']);
    } finally {
      fixture.releaseFirstAck();
      stopObserving();
    }
  });

  it('already retains the newer route when only an older in-flight native ACK remains', async () => {
    const fixture = await nativeFixture(true);
    const moving = useAppStore.getState().commitNodePositions([{ nodeId: 'reference', position: { x: 30, y: 50 } }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.nativeCommits).toHaveBeenCalledTimes(1);
    const observedRoutes: string[] = [];
    const stopObserving = useAppStore.subscribe(state => {
      const route = reverseNode(state.project).data.config.modelRoute;
      if (typeof route === 'string' && observedRoutes[observedRoutes.length - 1] !== route) observedRoutes.push(route);
    });
    try {
      await useAppStore.getState().draftReverseAgentConfig('reverse', selectedDraft);
      fixture.releaseFirstAck();
      await expect(moving).resolves.toBe(true);
      expect(reverseNode(useAppStore.getState().project).data.config).toMatchObject(selectedDraft);
      await vi.runAllTimersAsync();
      expect(observedRoutes).toEqual(['selected-route']);
      expect(reverseNode(fixture.durable()).data.config).toMatchObject(selectedDraft);
      fixture.assertProtectedGraph();
    } finally {
      fixture.releaseFirstAck();
      stopObserving();
    }
  });

  it('keeps MCP revision and edit permission checks while accepting a later authoritative route', async () => {
    const fixture = await nativeFixture(false);
    await useAppStore.getState().draftReverseAgentConfig('reverse', selectedDraft);
    await vi.runAllTimersAsync();
    const permissions = { ...DEFAULT_MCP_PERMISSION_FLAGS, editCanvas: true };
    const runNode = vi.fn(async () => ({ started: false, jobIds: [] }));
    const adapter = createMcpWorkspaceAdapter({
      getProject: () => useAppStore.getState().project,
      getRevision: () => useAppStore.getState().desktopRevision,
      getSelection: () => ({ nodeIds: [], edgeIds: [] }),
      getJobs: () => [],
      commitProjectTransaction: transaction => useAppStore.getState().commitProjectTransaction(transaction),
      runNode,
      cancelJob: async () => {},
      requestMediaImport: async () => false,
    }, undefined, { getPermissions: () => permissions });
    const before = JSON.stringify(useAppStore.getState().project);
    const revision = useAppStore.getState().desktopRevision;
    const commitCount = fixture.nativeCommits.mock.calls.length;
    await expect(adapter.handle({ tool: 'canvas_update_node', expectedRevision: revision - 1, nodeId: 'reverse', config: { modelRoute: 'stale-mcp-route' } }))
      .resolves.toMatchObject({ ok: false, error: { code: 'PROJECT_REVISION_CONFLICT' } });
    permissions.editCanvas = false;
    await expect(adapter.handle({ tool: 'canvas_update_node', expectedRevision: revision, nodeId: 'reverse', config: { modelRoute: 'forbidden-mcp-route' } }))
      .resolves.toMatchObject({ ok: false, error: { code: 'MCP_PERMISSION_DENIED' } });
    expect(JSON.stringify(useAppStore.getState().project)).toBe(before);
    expect(fixture.nativeCommits).toHaveBeenCalledTimes(commitCount);

    permissions.editCanvas = true;
    await expect(adapter.handle({ tool: 'canvas_update_node', expectedRevision: revision, nodeId: 'reverse', config: { modelRoute: 'authoritative-mcp-route' } }))
      .resolves.toMatchObject({ ok: true });
    expect(reverseNode(fixture.durable()).data.config).toMatchObject({ ...selectedDraft, modelRoute: 'authoritative-mcp-route' });
    expect(reverseNode(useAppStore.getState().project).data.config).toMatchObject({ ...selectedDraft, modelRoute: 'authoritative-mcp-route' });
    expect(useAppStore.getState().project.assets).toEqual(fixture.base.assets);
    expect(useAppStore.getState().project.edges).toEqual(fixture.base.edges);
    expect(runNode).not.toHaveBeenCalled();
  });
});

async function nativeFixture(holdFirstCommit: boolean) {
  const image = {
    assetId: imageAssetId, byteSize: 64, extension: 'png' as const, height: 8, width: 8,
    label: 'Owned reference', mediaType: 'image/png' as const, origin: 'imported' as const,
    sha256: imageAssetId.repeat(4),
  };
  const reference = createCanvasModuleNode('reference', 'image_input', { x: 0, y: 0 });
  reference.data.config = { ...reference.data.config, assetId: image.assetId };
  const reverse = createCanvasModuleNode('reverse', 'reverse_agent', { x: 300, y: 0 });
  reverse.data.config = { ...reverse.data.config, ...oldDraft };
  const output = createCanvasModuleNode('output', 'reverse_result', { x: 900, y: 0 });
  const untouched = createCanvasModuleNode('untouched', 'text_prompt', { x: 1200, y: 0 });
  untouched.data.config = { ...untouched.data.config, prompt: 'Do not modify this independent node' };
  const base = parseCanvasProject({
    ...createStarterProject(), nodes: [reference, reverse, output, untouched], assets: [image],
    edges: [
      { id: 'owned-reference-edge', source: 'reference', sourcePortId: 'image', target: 'reverse', targetPortId: 'references', order: 0 },
      { id: 'reverse-output-edge', source: 'reverse', sourcePortId: 'analysis', target: 'output', targetPortId: 'analysis', order: 0 },
    ],
  });
  let durable = base;
  let revision = 0;
  let releaseFirstAck!: () => void;
  const firstAck = new Promise<void>(resolve => { releaseFirstAck = resolve; });
  const events: Array<{ phase: string; route: unknown; revision: number; label: string }> = [];
  const nativeCommits = vi.fn(async (request: { sessionId: string; projectId: string; baseRevision: number; transaction: ProjectCommitRequest['transaction'] }): Promise<{ revision: number }> => {
    expect(request.sessionId).toBe('reverse-race-session');
    expect(request.projectId).toBe(base.id);
    expect(request.baseRevision).toBe(revision);
    events.push({ phase: 'native-request', route: reverseNode(useAppStore.getState().project).data.config.modelRoute, revision, label: request.transaction.label });
    if (holdFirstCommit && nativeCommits.mock.calls.length === 1) await firstAck;
    durable = parseCanvasProject(applyProjectTransaction(durable, request.transaction));
    revision += 1;
    events.push({ phase: 'native-ack', route: reverseNode(durable).data.config.modelRoute, revision, label: request.transaction.label });
    return { revision };
  });
  const nativeClient = createDesktopPersistenceClient({
    openProject: async () => ({ project: durable, projectId: base.id, projectName: base.name, sessionId: 'reverse-race-session', mode: 'write', currentRevision: revision, stableSnapshotId: null, stableSnapshotRevision: revision }),
    getRecoveryPlan: async () => ({ action: 'auto_recover', candidates: [], issues: [], projectId: base.id, recoveredRevision: null, stableSnapshotId: null, targetRevision: revision }),
    closeProject: async () => {},
    commit: nativeCommits,
    projectImages: { list: async () => [] },
  } as never);
  await nativeClient.openProject!();
  replaceProjectPersistenceClientForTests(nativeClient);
  useAppStore.setState({ project: base, persistenceMode: 'desktop', desktopRevision: 0, saveStatus: 'saved', projectLifecycle: 'durable', undoStack: [] });
  return {
    base, events, nativeCommits, releaseFirstAck, durable: () => durable,
    assertProtectedGraph() {
      for (const project of [useAppStore.getState().project, durable]) {
        expect(project.id).toBe(base.id);
        expect(project.assets).toEqual(base.assets);
        expect(project.edges).toEqual(base.edges);
        expect(project.nodes.find(node => node.id === 'reference')).toMatchObject({ position: { x: 30, y: 50 }, data: { config: { assetId: imageAssetId } } });
        expect(project.nodes.find(node => node.id === 'output')).toEqual(output);
        expect(project.nodes.find(node => node.id === 'untouched')).toEqual(untouched);
      }
    },
  };
}

function reverseNode(project: CanvasProject): CanvasModuleNode {
  return project.nodes.find(node => node.id === 'reverse') as CanvasModuleNode;
}
