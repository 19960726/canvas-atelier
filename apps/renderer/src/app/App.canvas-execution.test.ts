import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canConnectCanvasPorts, createCanvasModuleNode, DEFAULT_MCP_PERMISSION_FLAGS, parseCanvasProject, type CanvasModuleNode, type CanvasProject, type CanvasWorkflowMutation, type ModelJob } from '@agent-canvas/domain';
import { runMcpCanvasNode, resolveMcpPaidJobRoute } from './App';
import { createMcpWorkspaceAdapter } from './mcp-workspace-adapter';
import { mcpUiConfirmationStore } from './mcp-ui-confirmation-store';
import { createBrowserPersistenceClient, createDesktopPersistenceClient, type ProjectPersistenceClient } from './desktop-persistence';
import { createKnowledgeClient } from './knowledge-client';
import { createInMemoryModelJobStorage } from '../jobs/job-store';
import { createStarterProject, replaceKnowledgeClientForTests, replaceModelJobExecutorForTests, replaceModelJobStorageForTests, replaceProjectPersistenceClientForTests, resetAppStoreForTests, useAppStore } from './app-store';

const originalDesktop = window.novusDesktop;
const assets = ['a', 'b'].map(letter => ({ assetId: letter.repeat(16), byteSize: 42, extension: 'png' as const, height: 100, width: 100, label: 'Owned material', mediaType: 'image/png' as const, origin: 'imported' as const, sha256: letter.repeat(64) }));
const submit = vi.fn(async (job: ModelJob) => ({ providerTaskId: 'fixture-' + job.id }));
const analyze = vi.fn(async (input: Parameters<NonNullable<ProjectPersistenceClient['analyzeReversePrompt']>>[0], beforeProviderDispatch?: () => void) => {
  beforeProviderDispatch?.();
  let imageNumber = 0; let videoNumber = 0;
  const mediaResponsibilities = [...input.run.orderedMedia].sort((left, right) => left.order - right.order).map(item => ({
    mention: item.kind === 'image' ? `@图片${++imageNumber}` : `@视频${++videoNumber}`,
    sourceId: item.assetId, role: 'product_identity', priority: 'primary' as const,
    inheritance: ['Product identity'], conflicts: [], usableElements: ['Source geometry'],
  }));
  return { sessionId: input.run.sessionId, nonce: input.run.nonce, knowledgeSnapshotVersion: input.run.knowledgeLease.versionKey, analysis: 'Owned product analysis', keywords: ['product'], positivePrompt: 'Keep the product identity', negativeConstraints: ['Do not alter the product'], executionChecklist: ['Verify source identity'], mediaResponsibilities };
});
const profiles = [
  { provider: 'comfly', modelRoute: 'fixture/image_generation', displayName: 'Fixture image', capabilities: ['image_generation', 'image_edit', 'async_tasks'] },
  { provider: 'comfly', modelRoute: 'fixture/video_generation', modelId: 'doubao-seedance-2.5', displayName: 'Fixture video', capabilities: ['video_generation', 'async_tasks'] },
  { provider: 'comfly', modelRoute: 'fixture/reverse_agent', displayName: 'Fixture reverse', capabilities: ['chat', 'vision'] },
];

function install(project: CanvasProject, overrides: Partial<ProjectPersistenceClient> = {}) {
  replaceProjectPersistenceClientForTests(Object.assign(createBrowserPersistenceClient(), {
    ensureModelExecutionSession: async () => 'mcp-execution-fixture', getSessionId: () => 'mcp-execution-fixture',
    commit: async (request: { nextProject: CanvasProject; baseRevision: number }) => ({ ok: true as const, project: parseCanvasProject(request.nextProject), revision: request.baseRevision + 1 }),
    stablePoint: async () => ({ project: parseCanvasProject(useAppStore.getState().project), revision: useAppStore.getState().desktopRevision, availableSnapshotIds: [], lifecycle: 'durable' as const }),
    analyzeReversePrompt: analyze,
  }, overrides));
  useAppStore.setState({ project, projectLifecycle: 'durable', saveStatus: 'saved', desktopRevision: 7, projectImages: assets.map(asset => ({ ...asset, displayUrl: 'novus-asset://project/fixture/' + asset.assetId, usageCount: 1 })) });
}

function project(kind: 'image_generation' | 'video_generation' | 'reverse_agent', connected = true) {
  const prompt = createCanvasModuleNode('prompt', 'text_prompt', { x: 0, y: 0 });
  prompt.data.config = { prompt: 'Preserve exactly two products in the original positions.' };
  const generator = createCanvasModuleNode('generator', kind, { x: 600, y: 0 });
  generator.data.config = { ...generator.data.config, prompt: 'Stale cached prompt', task: 'Stale cached task', modelRoute: 'fixture/' + kind, role: 'Product analyst', analysisDepth: 'standard', knowledgeBaseIds: [], referenceAssetIds: [] };
  const material = assets.map((asset, index) => {
    const node = createCanvasModuleNode('material-' + index, 'image_input', { x: 0, y: 200 + index * 200 });
    node.data.config = { assetId: asset.assetId };
    return node;
  });
  return parseCanvasProject({ ...createStarterProject(), assets, nodes: [prompt, ...material, generator], edges: connected ? [
    { id: 'prompt-edge', source: 'prompt', sourcePortId: 'prompt', target: 'generator', targetPortId: kind === 'reverse_agent' ? 'task' : 'prompt', order: 0 },
    ...material.map((node, index) => ({ id: 'media-edge-' + index, source: node.id, sourcePortId: 'image', target: 'generator', targetPortId: kind === 'video_generation' ? 'media' : 'references', order: 1 - index })),
  ] : [] });
}

function adapter(executeAllowed: () => boolean = () => true) {
  return createMcpWorkspaceAdapter({
    getProject: () => useAppStore.getState().project, getRevision: () => useAppStore.getState().desktopRevision,
    getSelection: () => ({ nodeIds: [], edgeIds: [] }), getJobs: () => [],
    commitProjectTransaction: transaction => useAppStore.getState().commitProjectTransaction(transaction, { kind: 'agent' }),
    resolvePaidJobRoute: resolveMcpPaidJobRoute, runNode: runMcpCanvasNode,
    cancelJob: async () => {}, requestMediaImport: () => false,
  }, undefined, { getPermissions: () => ({ ...DEFAULT_MCP_PERMISSION_FLAGS, readCanvas: true, editCanvas: true, executeAiGeneration: executeAllowed() }) });
}

function attachUnsupportedInput(current: CanvasProject, port: string) {
  const kind = port === 'mask' ? 'drawing_mask' : port === 'pose' ? 'openpose' : port === 'sourceVideo' ? 'video_input' : undefined;
  const source = kind ? createCanvasModuleNode('unsupported-source', kind, { x: 0, y: 800 }) : current.nodes.find(node => node.id === 'material-0') as CanvasModuleNode;
  if (kind) current.nodes.push(source);
  const sourcePort = port === 'mask' ? 'mask' : port === 'pose' ? 'pose' : port === 'sourceVideo' ? 'video' : 'image';
  const target = current.nodes.find(node => node.id === 'generator') as CanvasModuleNode;
  expect(canConnectCanvasPorts(source, sourcePort, target, port)).toMatchObject({ ok: true });
  current.edges.push({ id: 'unsupported', source: source.id, sourcePortId: sourcePort, target: target.id, targetPortId: port, order: 0 });
}

async function runConfirmed(kind: 'image_generation' | 'video_generation' | 'reverse_agent') {
  const mcp = adapter();
  const input = { tool: 'canvas_run_node' as const, expectedRevision: useAppStore.getState().desktopRevision, nodeId: 'generator' };
  const first = await mcp.handle(input);
  if (kind === 'image_generation' || first.ok) return first;
  const confirmation = mcpUiConfirmationStore.getSnapshot().find(item => item.kind === 'paid_job');
  if (!confirmation) return first;
  const grant = mcpUiConfirmationStore.confirm(confirmation.id);
  return mcp.handle({ ...input, confirmationToken: grant.token });
}

async function runWithAdapter(mcp: ReturnType<typeof adapter>, kind: 'image_generation' | 'video_generation' | 'reverse_agent') {
  const input = { tool: 'canvas_run_node' as const, expectedRevision: useAppStore.getState().desktopRevision, nodeId: 'generator' };
  const first = await mcp.handle(input);
  if (kind === 'image_generation' || first.ok) return first;
  const confirmation = mcpUiConfirmationStore.getSnapshot().find(item => item.kind === 'paid_job');
  if (!confirmation) return first;
  return mcp.handle({ ...input, confirmationToken: mcpUiConfirmationStore.confirm(confirmation.id).token });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  localStorage.clear(); resetAppStoreForTests(); mcpUiConfirmationStore.clear(); submit.mockClear(); analyze.mockClear();
  replaceKnowledgeClientForTests(createKnowledgeClient());
  replaceModelJobStorageForTests(createInMemoryModelJobStorage());
  replaceModelJobExecutorForTests({ submit, poll: async () => ({ status: 'running', progress: 0.1 }), cancel: async () => {} });
  window.novusDesktop = { provider: { getStatus: async () => ({ configured: true, locked: false, encryption: 'safeStorage' }), listProfiles: async () => profiles } } as unknown as typeof window.novusDesktop;
});
afterEach(() => { resetAppStoreForTests(); replaceProjectPersistenceClientForTests(createBrowserPersistenceClient()); mcpUiConfirmationStore.clear(); window.novusDesktop = originalDesktop; localStorage.clear(); });

describe('real MCP canvas execution inputs', () => {
  it.each(['image_generation', 'video_generation', 'reverse_agent'] as const)('rejects missing @ references in %s before confirmation or dispatch', async kind => {
    const current = project(kind);
    (current.nodes.find(node => node.id === 'prompt') as CanvasModuleNode).data.config.prompt = '使用 @图片3 与 @视频1';
    install(current);
    expect(await adapter().handle({ tool: 'canvas_run_node', expectedRevision: 7, nodeId: 'generator' })).toMatchObject({ ok: false, error: { code: 'REFERENCE_MENTION_INVALID', message: expect.stringContaining('@图片3') } });
    expect(mcpUiConfirmationStore.getSnapshot()).toEqual([]);
    expect(submit).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
  });
  it.each(['first', 'pair', 'saved pair'] as const)('executes dedicated video %s inputs in frame order after confirmation', async mode => {
    const current = project('video_generation', false);
    const generator = current.nodes.find(node => node.id === 'generator') as CanvasModuleNode;
    if (mode === 'saved pair') {
      generator.data.config.firstFrameAssetId = assets[0]!.assetId;
      generator.data.config.lastFrameAssetId = assets[1]!.assetId;
    } else {
      current.edges = [
        ...(mode === 'pair' ? [{ id: 'last', source: 'material-1', sourcePortId: 'image', target: 'generator', targetPortId: 'lastFrame', order: 0 }] : []),
        { id: 'first', source: 'material-0', sourcePortId: 'image', target: 'generator', targetPortId: 'firstFrame', order: 99 },
      ];
      // A saved cache must not override actual graph input.
      generator.data.config.referenceAssetIds = [assets[1]!.assetId];
      generator.data.config.firstFrameAssetId = assets[1]!.assetId;
    }
    install(current);
    const mcp = adapter();
    const input = { tool: 'canvas_run_node' as const, expectedRevision: 7, nodeId: 'generator' };
    expect(await mcp.handle(input)).toMatchObject({ ok: false, error: { code: 'PAID_CONFIRMATION_REQUIRED' } });
    expect(submit).not.toHaveBeenCalled();
    const grant = mcpUiConfirmationStore.confirm(mcpUiConfirmationStore.getSnapshot()[0]!.id);
    expect(await mcp.handle({ ...input, confirmationToken: grant.token })).toMatchObject({ ok: true });
    const expected = mode === 'first' ? ['aaaaaaaaaaaaaaaa'] : ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'];
    expect(useAppStore.getState().modelJobs[0]!.referenceAssetIds).toEqual(expected);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0]![0].referenceAssetIds).toEqual(expected);
    expect(useAppStore.getState().project.edges).toEqual(current.edges);
  });

  it('executes a connected line drawing as actual reverse media after confirmation', async () => {
    const current = project('reverse_agent', false);
    current.edges = [{ id: 'drawing', source: 'material-0', sourcePortId: 'image', target: 'generator', targetPortId: 'line_art', order: 0 }];
    install(current);
    expect(await runConfirmed('reverse_agent')).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce());
    expect(analyze.mock.calls[0]![0].media).toEqual([{ kind: 'image', assetId: 'aaaaaaaaaaaaaaaa', sha256: 'a'.repeat(64), byteSize: 42, mediaType: 'image/png' }]);
    expect(analyze.mock.calls[0]![0].run.orderedMedia).toEqual([expect.objectContaining({ kind: 'image', assetId: 'aaaaaaaaaaaaaaaa', order: 0 })]);
  });

  it.each(['comfly text', 'comfly components', 'julun'] as const)('rejects dedicated frames on incompatible %s routes before confirmation', async providerMode => {
    const current = project('video_generation', false);
    current.edges = [
      { id: 'first', source: 'material-0', sourcePortId: 'image', target: 'generator', targetPortId: 'firstFrame', order: 1 },
      { id: 'last', source: 'material-1', sourcePortId: 'image', target: 'generator', targetPortId: 'lastFrame', order: 0 },
    ];
    install(current);
    window.novusDesktop!.provider.listProfiles = async () => [{ ...profiles[1], provider: providerMode === 'julun' ? 'julun' : 'comfly',
      modelId: providerMode === 'comfly text' ? 'wan2.2-t2v-plus' : 'veo2-fast-components' }] as never;
    expect(await adapter().handle({ tool: 'canvas_run_node', expectedRevision: 7, nodeId: 'generator' })).toMatchObject({ ok: false });
    expect(mcpUiConfirmationStore.getSnapshot()).toEqual([]);
    expect(useAppStore.getState().modelJobs).toEqual([]);
  });

  it.each(['missing node', 'foreign asset', 'wrong source port', 'multiple drawings'] as const)('rejects %s line art before paid confirmation', async fault => {
    const current = project('reverse_agent', false);
    current.edges = [{ id: 'drawing', source: 'material-0', sourcePortId: 'image', target: 'generator', targetPortId: 'line_art', order: 0 }];
    if (fault === 'missing node') current.nodes = current.nodes.filter(node => node.id !== 'material-0');
    if (fault === 'foreign asset') current.assets = current.assets!.filter(asset => asset.assetId !== assets[0]!.assetId);
    if (fault === 'wrong source port') current.edges[0]!.sourcePortId = 'video';
    if (fault === 'multiple drawings') current.edges.push({ ...current.edges[0]!, id: 'second', source: 'material-1' });
    install(current);
    expect(await adapter().handle({ tool: 'canvas_run_node', expectedRevision: 7, nodeId: 'generator' })).toMatchObject({ ok: false });
    expect(mcpUiConfirmationStore.getSnapshot()).toEqual([]);
    expect(analyze).not.toHaveBeenCalled();
  });

  it.each(['firstFrameAssetId', 'lastFrameAssetId'] as const)('does not let a stale %s cache replace connected media', async field => {
    const current = project('video_generation');
    (current.nodes.find(node => node.id === 'generator') as CanvasModuleNode).data.config[field] = assets[0]!.assetId;
    install(current);
    expect(await runConfirmed('video_generation')).toMatchObject({ ok: true });
    expect(useAppStore.getState().modelJobs[0]!.referenceAssetIds).toEqual(['bbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaa']);
  });

  it('invalidates frame confirmation when a frame connection changes without a revision bump', async () => {
    const current = project('video_generation', false);
    current.edges = [{ id: 'first', source: 'material-0', sourcePortId: 'image', target: 'generator', targetPortId: 'firstFrame', order: 0 }];
    install(current); const mcp = adapter();
    const input = { tool: 'canvas_run_node' as const, expectedRevision: 7, nodeId: 'generator' };
    await mcp.handle(input);
    const grant = mcpUiConfirmationStore.confirm(mcpUiConfirmationStore.getSnapshot()[0]!.id);
    useAppStore.setState({ project: { ...current, edges: [{ ...current.edges[0]!, source: 'material-1' }] } });
    expect(await mcp.handle({ ...input, confirmationToken: grant.token })).toMatchObject({ ok: false, error: { code: 'PAID_CONFIRMATION_REQUIRED' } });
    expect(submit).not.toHaveBeenCalled();
  });

  it.each(['last only', 'duplicate first', 'mixed ports', 'missing source', 'invalid asset', 'multiple results'] as const)
  ('rejects invalid dedicated frames: %s before confirmation', async fault => {
    const current = project('video_generation', false);
    current.edges = [{ id: 'first', source: 'material-0', sourcePortId: 'image', target: 'generator', targetPortId: fault === 'last only' ? 'lastFrame' : 'firstFrame', order: 0 }];
    if (fault === 'duplicate first') current.edges.push({ ...current.edges[0]!, id: 'extra', source: 'material-1' });
    if (fault === 'mixed ports') current.edges.push({ ...current.edges[0]!, id: 'extra', source: 'material-1', targetPortId: 'media' });
    if (fault === 'missing source') current.nodes = current.nodes.filter(node => node.id !== 'material-0');
    const source = current.nodes.find(node => node.id === 'material-0') as CanvasModuleNode;
    if (fault === 'invalid asset') source.data.config.assetId = 'c'.repeat(16);
    if (fault === 'multiple results') { source.data.moduleType = 'image_generation'; source.data.config.resultAssetIds = assets.map(asset => asset.assetId); }
    install(current);
    expect(await adapter().handle({ tool: 'canvas_run_node', expectedRevision: 7, nodeId: 'generator' })).toMatchObject({ ok: false });
    expect(mcpUiConfirmationStore.getSnapshot()).toEqual([]);
    expect(submit).not.toHaveBeenCalled();
  });

  it.each(['absent', 'empty', 'stale'] as const)('runs graph refs from an approved workflow mutation with %s config refs', async cached => {
    const initial = project('image_generation', false);
    const generator = initial.nodes.find(node => node.id === 'generator') as CanvasModuleNode;
    if (cached === 'absent') delete generator.data.config.referenceAssetIds;
    if (cached === 'stale') generator.data.config.referenceAssetIds = [assets[0]!.assetId];
    install(initial);
    const mcp = adapter();
    const mutations: CanvasWorkflowMutation[] = project('image_generation').edges.sort((left, right) => left.order! - right.order!).map(edge => ({ kind: 'connect_nodes', edgeId: edge.id, sourceNodeId: edge.source, sourcePortId: edge.sourcePortId!, targetNodeId: edge.target, targetPortId: edge.targetPortId! }));
    const planned = await mcp.handle({ tool: 'canvas_plan_workflow', expectedRevision: 7, workflowIntent: 'Use the exact prompt and both ordered source images', mutations });
    expect(planned).toMatchObject({ ok: true });
    if (!planned.ok) throw new Error('workflow plan failed');
    const planId = (planned.result as { planId: string }).planId;
    const grant = mcpUiConfirmationStore.confirm(planId);
    expect(await mcp.handle({ tool: 'canvas_apply_workflow', expectedRevision: 7, planId, confirmationToken: grant.token })).toMatchObject({ ok: true });
    expect((useAppStore.getState().project.nodes.find(node => node.id === 'generator') as CanvasModuleNode).data.config.referenceAssetIds).toEqual(generator.data.config.referenceAssetIds);
    expect(await mcp.handle({ tool: 'canvas_run_node', expectedRevision: 8, nodeId: 'generator' })).toMatchObject({ ok: true });
    expect(useAppStore.getState().modelJobs[0]).toMatchObject({ prompt: 'Preserve exactly two products in the original positions.', referenceAssetIds: [assets[1]!.assetId, assets[0]!.assetId] });
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Preserve exactly two products in the original positions.', referenceAssetIds: [assets[1]!.assetId, assets[0]!.assetId] })));
    expect(mcpUiConfirmationStore.getSnapshot()).toEqual([]); // image uses workflow authorization, not a paid_job token
  });

  it.each(['image_generation', 'video_generation'] as const)('executes a connected %s prompt when the generator has no cached prompt', async kind => {
    const current = project(kind); delete (current.nodes.find(node => node.id === 'generator') as CanvasModuleNode).data.config.prompt; install(current);
    expect(await runConfirmed(kind)).toEqual(expect.objectContaining({ ok: true }));
    expect(useAppStore.getState().modelJobs[0]).toMatchObject({ prompt: 'Preserve exactly two products in the original positions.', referenceAssetIds: [assets[1]!.assetId, assets[0]!.assetId] });
  });

  it('sends the connected task to actual reverse analysis under its paid_job confirmation', async () => {
    install(project('reverse_agent'));
    const response = await runConfirmed('reverse_agent');
    expect(response).toEqual(expect.objectContaining({ ok: true }));
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce());
    expect(analyze.mock.calls[0]![0].run.agentConfig?.task).toBe('Preserve exactly two products in the original positions.');
  });

  it.each([
    ['image_generation', 'mask'], ['image_generation', 'pose'],
    ['video_generation', 'sourceVideo'],
  ] as const)('rejects unimplemented %s %s input before publishing a paid confirmation or dispatching', async (kind, port) => {
    const current = project(kind);
    attachUnsupportedInput(current, port);
    install(current); const original = JSON.stringify(current);
    const response = await adapter().handle({ tool: 'canvas_run_node', expectedRevision: 7, nodeId: 'generator' });
    expect(response).toMatchObject({ ok: false });
    expect(response.ok ? '' : response.error.message).toMatch(/not supported|尚未支持/iu);
    expect(mcpUiConfirmationStore.getSnapshot()).toEqual([]);
    expect(useAppStore.getState().modelJobs).toEqual([]); expect(analyze).not.toHaveBeenCalled();
    expect(JSON.stringify(useAppStore.getState().project)).toBe(original);
  });

  it('rejects a same-revision prompt draft arriving during the final provider catalog await', async () => {
    install(project('image_generation'));
    let reads = 0;
    window.novusDesktop!.provider.listProfiles = vi.fn(async () => {
      reads += 1;
      if (reads === 5) {
        const current = useAppStore.getState().project;
        useAppStore.setState({ project: { ...current, nodes: current.nodes.map(node => node.id === 'prompt' && node.type === 'module' ? { ...node, data: { ...node.data, config: { prompt: 'Unconfirmed changed prompt' } } } : node) } });
      }
      return profiles as never;
    });
    expect(await runConfirmed('image_generation')).toMatchObject({ ok: false });
    expect(useAppStore.getState().modelJobs).toEqual([]);
  });

  it('honors permission revocation during the final provider await before dispatch', async () => {
    install(project('image_generation'));
    let allowed = true; let reads = 0;
    window.novusDesktop!.provider.listProfiles = vi.fn(async () => { if (++reads === 5) allowed = false; return profiles as never; });
    expect(await adapter(() => allowed).handle({ tool: 'canvas_run_node', expectedRevision: 7, nodeId: 'generator' })).toMatchObject({ ok: false });
    expect(useAppStore.getState().modelJobs).toEqual([]);
    expect(submit).not.toHaveBeenCalled();
  });

  it.each(['image_generation', 'video_generation', 'reverse_agent'] as const)('rejects invalid connected %s text before job confirmation', async kind => {
    for (const fault of ['empty', 'missing source', 'multiple', 'wrong port', 'wrong type', 'cycle', 'credential', 'object']) {
      const current = project(kind); const source = current.nodes.find(node => node.id === 'prompt') as CanvasModuleNode;
      if (fault === 'empty') source.data.config.prompt = '  ';
      if (fault === 'missing source') current.nodes = current.nodes.filter(node => node.id !== source.id);
      if (fault === 'multiple') current.edges.push({ ...current.edges[0]!, id: 'duplicate' });
      if (fault === 'wrong port') current.edges[0]!.sourcePortId = 'image';
      if (fault === 'wrong type') source.data.moduleType = 'image_input';
      if (fault === 'cycle') current.edges.push({ id: 'cycle', source: 'generator', sourcePortId: 'result', target: 'prompt', targetPortId: 'prompt', order: 0 });
      if (fault === 'credential') source.data.config.prompt = 'Authorization: Bearer sk-fixture-private-key';
      if (fault === 'object') source.data.config.prompt = { goal: 'Hidden unvalidated prompt' };
      install(current);
      const response = await adapter().handle({ tool: 'canvas_run_node', expectedRevision: 7, nodeId: 'generator' });
      expect(response, fault).toMatchObject({ ok: false });
      expect(mcpUiConfirmationStore.getSnapshot(), fault).toEqual([]);
      expect(useAppStore.getState().modelJobs, fault).toEqual([]); expect(analyze, fault).not.toHaveBeenCalled();
      expect(JSON.stringify(response), fault).not.toContain('sk-fixture-private-key');
    }
  });

  it.each([
    ['image_generation', 'mask'], ['image_generation', 'pose'],
    ['video_generation', 'sourceVideo'],
  ] as const)('guards the real %s store executor against ignored %s edges', async (kind, port) => {
    const current = project(kind); attachUnsupportedInput(current, port); install(current);
    const state = useAppStore.getState();
    const run = kind === 'image_generation' ? state.runImageGenerationNode('generator', { prompt: 'Valid direct task', referenceAssetIds: [] })
      : kind === 'video_generation' ? state.runVideoPreviewNode('generator', { prompt: 'Valid direct task', referenceAssetIds: [], aspectRatio: '16:9', keyframe: 'auto', durationSeconds: 5, resolution: '720p', outputCount: 1, audioEnabled: false })
        : state.runReverseAgentNode('generator');
    await expect(run).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(useAppStore.getState().modelJobs).toEqual([]); expect(analyze).not.toHaveBeenCalled();
    expect(useAppStore.getState().project.edges).toEqual(current.edges);
  });

  it.each([
    ['image_generation', 'maskAssetId'], ['image_generation', 'poseId'],
    ['video_generation', 'sourceVideoAssetId'],
    ['reverse_agent', 'lineArtAssetId'],
  ] as const)('rejects standalone legacy %s %s without silently stripping it', async (kind, field) => {
    const current = project(kind); (current.nodes.find(node => node.id === 'generator') as CanvasModuleNode).data.config[field] = assets[0]!.assetId; install(current);
    expect(await adapter().handle({ tool: 'canvas_run_node', expectedRevision: 7, nodeId: 'generator' })).toMatchObject({ ok: false });
    expect(mcpUiConfirmationStore.getSnapshot()).toEqual([]); expect(useAppStore.getState().modelJobs).toEqual([]); expect(analyze).not.toHaveBeenCalled();
    expect((useAppStore.getState().project.nodes.find(node => node.id === 'generator') as CanvasModuleNode).data.config[field]).toBe(assets[0]!.assetId);
  });

  it('preserves legitimate cached media-reference first/last fields on a subsequent video run', async () => {
    const current = project('video_generation');
    Object.assign((current.nodes.find(node => node.id === 'generator') as CanvasModuleNode).data.config, { referenceAssetIds: assets.map(asset => asset.assetId), firstFrameAssetId: assets[0]!.assetId, lastFrameAssetId: assets[1]!.assetId });
    install(current);
    expect(await runConfirmed('video_generation')).toMatchObject({ ok: true });
    expect(useAppStore.getState().modelJobs[0]!.referenceAssetIds).toEqual([assets[1]!.assetId, assets[0]!.assetId]);
  });

  it('does not reuse a paid reverse token after its connected task changes at the same revision', async () => {
    install(project('reverse_agent')); const mcp = adapter();
    await mcp.handle({ tool: 'canvas_run_node', expectedRevision: 7, nodeId: 'generator' });
    const pending = mcpUiConfirmationStore.getSnapshot()[0]!; const grant = mcpUiConfirmationStore.confirm(pending.id);
    const current = useAppStore.getState().project;
    useAppStore.setState({ project: { ...current, nodes: current.nodes.map(node => node.id === 'prompt' && node.type === 'module' ? { ...node, data: { ...node.data, config: { prompt: 'A different unconfirmed task' } } } : node) } });
    expect(await mcp.handle({ tool: 'canvas_run_node', expectedRevision: 7, nodeId: 'generator', confirmationToken: grant.token })).toMatchObject({ ok: false, error: { code: 'PAID_CONFIRMATION_REQUIRED' } });
    expect(analyze).not.toHaveBeenCalled();
  });

  it('rejects an unconfirmed connected reference change during final route validation', async () => {
    install(project('image_generation')); let reads = 0;
    window.novusDesktop!.provider.listProfiles = vi.fn(async () => {
      if (++reads === 5) { const current = useAppStore.getState().project; useAppStore.setState({ project: { ...current, edges: current.edges.filter(edge => edge.source !== 'material-0') } }); }
      return profiles as never;
    });
    expect(await runConfirmed('image_generation')).toMatchObject({ ok: false }); expect(useAppStore.getState().modelJobs).toEqual([]);
  });

  it.each([
    ['image_generation', 'session'], ['video_generation', 'session'],
    ['image_generation', 'enqueue'], ['video_generation', 'enqueue'],
    ['image_generation', 'commit'], ['video_generation', 'commit'], ['reverse_agent', 'commit'],
    ['image_generation', 'queue read'], ['video_generation', 'queue read'],
  ] as const)('blocks %s provider execution when permission is revoked during the %s await', async (kind, phase) => {
    const entered = deferred(); const release = deferred(); let gated = false; let ownCommitted = false; let allowed = true;
    const storage = createInMemoryModelJobStorage();
    replaceModelJobStorageForTests({ ...storage,
      bulkPut: async jobs => { if (phase === 'enqueue' && !gated) { gated = true; entered.resolve(); await release.promise; } await storage.bulkPut(jobs); },
      list: async () => { if (phase === 'queue read' && ownCommitted && !gated) { gated = true; entered.resolve(); await release.promise; } return storage.list(); },
    });
    install(project(kind), {
      ensureModelExecutionSession: async () => { if (phase === 'session' && !gated) { gated = true; entered.resolve(); await release.promise; } return 'mcp-execution-fixture'; },
      commit: async request => {
        const result = { ok: true as const, project: parseCanvasProject(request.nextProject), revision: request.baseRevision + 1 };
        if (/^Run (?:image|video) generation node$|^Start reverse Agent run$/u.test(request.transaction.label)) {
          if (phase === 'commit' && !gated) { gated = true; entered.resolve(); await release.promise; }
          ownCommitted = true;
        }
        return result;
      },
    });
    const running = runWithAdapter(adapter(() => allowed), kind);
    await entered.promise; allowed = false; release.resolve();
    expect(await running).toMatchObject({ ok: false });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(submit).not.toHaveBeenCalled(); expect(analyze).not.toHaveBeenCalled();
    expect(useAppStore.getState().modelJobs.every(job => job.status === 'cancelled' || job.status === 'failed')).toBe(true);
    if (kind === 'reverse_agent') expect((useAppStore.getState().project.nodes.find(node => node.id === 'generator') as CanvasModuleNode).data.config.reverseAgentRunState).not.toBe('running');
  });

  it.each(['image_generation', 'video_generation', 'reverse_agent'] as const)('rejects a newer %s source draft during its own native commit ACK', async kind => {
    const entered = deferred(); const release = deferred(); let gated = false;
    install(project(kind), { commit: async request => {
      const result = { ok: true as const, project: parseCanvasProject(request.nextProject), revision: request.baseRevision + 1 };
      if (!gated && /^Run (?:image|video) generation node$|^Start reverse Agent run$/u.test(request.transaction.label)) { gated = true; entered.resolve(); await release.promise; }
      return result;
    } });
    const running = runWithAdapter(adapter(), kind); await entered.promise;
    const current = useAppStore.getState().project;
    useAppStore.setState({ project: { ...current, nodes: current.nodes.map(node => node.id === 'prompt' && node.type === 'module' ? { ...node, data: { ...node.data, config: { prompt: 'A newer draft after the native commit began' } } } : node) }, saveStatus: 'pending' });
    release.resolve(); expect(await running).toMatchObject({ ok: false });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(submit).not.toHaveBeenCalled(); expect(analyze).not.toHaveBeenCalled();
    expect((useAppStore.getState().project.nodes.find(node => node.id === 'prompt') as CanvasModuleNode).data.config.prompt).toBe('A newer draft after the native commit began');
    expect(useAppStore.getState().modelJobs.every(job => job.status === 'cancelled' || job.status === 'failed')).toBe(true);
  });

  it.each(['image_generation', 'video_generation'] as const)('checks %s permission at the actual executor call after its queue has started', async kind => {
    const entered = deferred(); const release = deferred(); let gated = false; let allowed = true;
    const storage = createInMemoryModelJobStorage();
    replaceModelJobStorageForTests({ ...storage, get: async id => {
      const job = await storage.get(id);
      if (job?.status === 'submitting' && !gated) { gated = true; entered.resolve(); await release.promise; }
      return job;
    } });
    install(project(kind));
    expect(await runWithAdapter(adapter(() => allowed), kind)).toMatchObject({ ok: true });
    await entered.promise; allowed = false; release.resolve();
    await vi.waitFor(() => expect(useAppStore.getState().modelJobs[0]?.status).toBe('cancelled'));
    expect(submit).not.toHaveBeenCalled();
  });

  it.each(['image_generation', 'video_generation', 'reverse_agent'] as const)('accepts its unchanged %s native start ACK before provider execution', async kind => {
    const entered = deferred(); const release = deferred(); let gated = false;
    install(project(kind), { commit: async request => {
      const result = { ok: true as const, project: parseCanvasProject(request.nextProject), revision: request.baseRevision + 1 };
      if (!gated && /^Run (?:image|video) generation node$|^Start reverse Agent run$/u.test(request.transaction.label)) { gated = true; entered.resolve(); await release.promise; }
      return result;
    } });
    const running = runWithAdapter(adapter(), kind); await entered.promise;
    expect(submit).not.toHaveBeenCalled(); expect(analyze).not.toHaveBeenCalled();
    release.resolve(); expect(await running).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(kind === 'reverse_agent' ? analyze : submit).toHaveBeenCalledOnce());
  });

  it.each(['permission', 'input draft', 'unchanged'] as const)('guards the actual cached desktop reverse wrapper against a %s change before its native provider call', async fault => {
    const current = project('reverse_agent'); let allowed = true;
    const nativeAnalyze = vi.fn(analyze);
    const desktop = createDesktopPersistenceClient({
      openProject: async () => ({ sessionId: 'cached-reverse-session', projectId: current.id, mode: 'write', project: current, currentRevision: 7, stableSnapshotRevision: 7 }),
      getRecoveryPlan: async () => ({ candidates: [] }), closeProject: async () => {},
      provider: { analyzeReversePrompt: nativeAnalyze },
    } as never);
    await desktop.openProject?.(); expect(desktop.getSessionId?.()).toBe('cached-reverse-session');
    install(current, { analyzeReversePrompt: (input, beforeProviderDispatch) => {
      const pending = desktop.analyzeReversePrompt!(input, beforeProviderDispatch);
      // Cached session resolution still resumes through nested Promise jobs.
      // Interrupt the real wrapper before its native provider IPC is invoked.
      if (fault === 'permission') allowed = false;
      else if (fault === 'input draft') { const latest = useAppStore.getState().project; useAppStore.setState({ project: { ...latest, nodes: latest.nodes.map(node => node.id === 'prompt' && node.type === 'module' ? { ...node, data: { ...node.data, config: { prompt: 'Changed before native analysis' } } } : node) } }); }
      return pending;
    } });
    const response = await runWithAdapter(adapter(() => allowed), 'reverse_agent');
    expect({ accepted: response.ok, nativeProviderCalls: nativeAnalyze.mock.calls.length }).toEqual({ accepted: fault === 'unchanged', nativeProviderCalls: fault === 'unchanged' ? 1 : 0 });
    await vi.waitFor(() => {
      const finalConfig = (useAppStore.getState().project.nodes.find(node => node.id === 'generator') as CanvasModuleNode).data.config;
      expect({ state: finalConfig.reverseAgentRunState, error: finalConfig.reverseAgentError }).toMatchObject(fault === 'unchanged' ? { state: 'completed', error: null } : { state: 'failed' });
    });
    if (fault === 'unchanged') expect(Object.keys(nativeAnalyze.mock.calls[0]![0]).sort()).toEqual(['media', 'provider', 'run', 'sessionId']);
  });
});
