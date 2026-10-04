import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvasModuleNode, parseCanvasProject, type CanvasModuleNode, type CanvasProject, type ModelJob } from '@agent-canvas/domain';
import { createBrowserPersistenceClient } from './desktop-persistence';
import { createInMemoryModelJobStorage } from '../jobs/job-store';
import { registerEditorDraft } from './editor-draft-boundary';
import { createStarterProject, replaceModelJobExecutorForTests, replaceModelJobStorageForTests, replaceProjectPersistenceClientForTests, resetAppStoreForTests, useAppStore } from './app-store';

const originalDesktop = window.novusDesktop;
const submit = vi.fn(async (job: ModelJob) => ({ providerTaskId: 'fixture-' + job.id }));

function installProject(project: CanvasProject) {
  replaceProjectPersistenceClientForTests(Object.assign(createBrowserPersistenceClient(), {
    ensureModelExecutionSession: async () => 'pipeline-fixture-session',
    getSessionId: () => 'pipeline-fixture-session',
    commit: async (request: { nextProject: CanvasProject; baseRevision: number }) => ({ ok: true as const, project: parseCanvasProject(request.nextProject), revision: request.baseRevision + 1 }),
    stablePoint: async () => ({ project: parseCanvasProject(useAppStore.getState().project), revision: useAppStore.getState().desktopRevision, availableSnapshotIds: [], lifecycle: 'durable' as const }),
  }));
  useAppStore.setState({ project, projectLifecycle: 'durable', saveStatus: 'saved', desktopRevision: 7 });
}

function linkedProject(kind: 'image_generation' | 'video_generation') {
  const prompt = createCanvasModuleNode('source-prompt', 'text_prompt', { x: 100, y: 160 });
  prompt.data.config = { prompt: 'Source controls the actual generation.' };
  const generation = createCanvasModuleNode('generation', kind, { x: 500, y: 160 });
  generation.data.config = { ...generation.data.config, prompt: 'Old generation text.', modelRoute: 'fixture/' + kind };
  return parseCanvasProject({ ...createStarterProject(), nodes: [prompt, generation], edges: [
    { id: 'source-to-generation', source: prompt.id, sourcePortId: 'prompt', target: generation.id, targetPortId: 'prompt', order: 0 },
  ], assets: [] });
}

function start(kind: 'image_generation' | 'video_generation', executionRoute?: { projectId: string; expectedRevision: number; provider: 'comfly'; modelRoute: string }) {
  const input = { prompt: 'Old generation text.', modelRoute: 'fixture/' + kind, ...(executionRoute ? { executionRoute } : {}) };
  return kind === 'image_generation'
    ? useAppStore.getState().runImageGenerationNode('generation', input)
    : useAppStore.getState().runVideoPreviewNode('generation', { ...input, referenceAssetIds: [], aspectRatio: '16:9', keyframe: 'auto', durationSeconds: 5, resolution: '720p', outputCount: 1, audioEnabled: true });
}

beforeEach(() => {
  localStorage.clear();
  resetAppStoreForTests();
  submit.mockClear();
  replaceModelJobStorageForTests(createInMemoryModelJobStorage());
  replaceModelJobExecutorForTests({ submit, poll: async () => ({ status: 'running', progress: 0.1 }), cancel: async () => {} });
  window.novusDesktop = { provider: {
    getStatus: async () => ({ configured: true, locked: false, encryption: 'safeStorage' }),
    listProfiles: async () => ['image_generation', 'video_generation'].map(kind => ({ provider: kind === 'image_generation' ? 'comfly' : 'relayme', modelRoute: 'fixture/' + kind, displayName: 'Fixture ' + kind, capabilities: kind === 'image_generation' ? ['image_generation', 'image_edit', 'async_tasks'] : ['video_generation', 'async_tasks'] })),
  } } as unknown as typeof window.novusDesktop;
});

afterEach(() => {
  resetAppStoreForTests();
  replaceProjectPersistenceClientForTests(createBrowserPersistenceClient());
  window.novusDesktop = originalDesktop;
  localStorage.clear();
});

describe('real confirmed Agent generation workflow', () => {
  it('places a new workflow past an existing expanded card and stacks complete portrait materials without moving user nodes', async () => {
    const existing = createCanvasModuleNode('existing-expanded', 'image_generation', { x: 120, y: 160 });
    const assets = [
      { assetId: 'a'.repeat(16), byteSize: 42, extension: 'png' as const, height: 1280, width: 720, label: 'Portrait material', mediaType: 'image/png' as const, origin: 'imported' as const, sha256: 'a'.repeat(64) },
      { assetId: 'b'.repeat(16), byteSize: 42, extension: 'png' as const, height: 800, width: 1200, label: 'Landscape material', mediaType: 'image/png' as const, origin: 'imported' as const, sha256: 'b'.repeat(64) },
    ];
    installProject(parseCanvasProject({ ...createStarterProject(), nodes: [existing], edges: [], assets }));
    await expect(useAppStore.getState().ensureAgentGenerationNode('new-layout', 'image_generation', assets.map(asset => asset.assetId), { prompt: 'Keep all original materials.' })).resolves.toBeTruthy();
    const project = useAppStore.getState().project;
    const source = project.nodes.find(node => node.id === 'new-layout-prompt')!;
    const references = assets.map((_, index) => project.nodes.find(node => node.id === `new-layout-ref-${index}`)!);
    expect.soft(source.position.x).toBeGreaterThan(existing.position.x + 704);
    for (const reference of references) expect.soft(reference.position.x).toBeGreaterThan(existing.position.x + 704);
    // The actual input UI has a 272px complete image plus its heading/controls.
    expect.soft(references[1]!.position.y).toBeGreaterThan(references[0]!.position.y + 272 * 1280 / 720 + 77);
    expect(project.nodes.find(node => node.id === existing.id)).toEqual(existing);
    expect(submit).not.toHaveBeenCalled();
  });

  it.each(['image_generation', 'video_generation'] as const)('creates a durable prompt, %s and typed output chain idempotently', async kind => {
    installProject(parseCanvasProject({ ...createStarterProject(), nodes: [], edges: [], assets: [] }));
    const placement = await useAppStore.getState().ensureAgentGenerationNode('chosen', kind, [], { prompt: 'Chosen complete source prompt.' });
    expect(placement).toEqual({ generationNodeId: 'chosen', workflowNodeIds: ['chosen-prompt', 'chosen', 'chosen-output'] });
    const first = useAppStore.getState().project;
    expect(first.nodes).toHaveLength(3);
    expect(first.nodes.find(node => node.id === 'chosen-prompt')).toMatchObject({ data: { moduleType: 'text_prompt', config: { prompt: 'Chosen complete source prompt.' } } });
    expect(first.nodes.find(node => node.id === 'chosen-output')).toMatchObject({ data: { moduleType: kind === 'image_generation' ? 'result_output' : 'video_result' } });
    expect(first.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'chosen-prompt', sourcePortId: 'prompt', target: 'chosen', targetPortId: 'prompt' }),
      expect.objectContaining({ source: 'chosen', sourcePortId: 'result', target: 'chosen-output', targetPortId: kind === 'image_generation' ? 'result' : 'video' }),
    ]));
    expect(first.edges).toHaveLength(2);
    await expect(useAppStore.getState().ensureAgentGenerationNode('chosen', kind, [], { prompt: 'Do not overwrite the edited source.' })).resolves.toEqual(placement);
    expect(useAppStore.getState().project).toBe(first);
    expect(submit).not.toHaveBeenCalled();
  });

  it('upgrades an existing lean generation node without duplicating it', async () => {
    const project = linkedProject('image_generation');
    installProject({ ...project, nodes: project.nodes.filter(node => node.id === 'generation'), edges: [] });
    await expect(useAppStore.getState().ensureAgentGenerationNode('generation', 'image_generation', [], { prompt: 'Existing source text.' })).resolves.toEqual({ generationNodeId: 'generation', workflowNodeIds: ['generation-prompt', 'generation', 'generation-output'] });
    expect(useAppStore.getState().project.nodes).toHaveLength(3);
    expect(useAppStore.getState().project.nodes.filter(node => node.id === 'generation')).toHaveLength(1);
    expect(useAppStore.getState().project.edges).toHaveLength(2);
  });
});

describe('connected generation prompt authority', () => {
  it.each(['image_generation', 'video_generation'] as const)('sends the current connected source prompt to the real %s queue', async kind => {
    installProject(linkedProject(kind));
    await expect(start(kind)).resolves.toBe(true);
    const job = useAppStore.getState().modelJobs[0]!;
    expect(job.prompt).toBe('Source controls the actual generation.');
    expect(job.promptNodeId).toBe('generation');
    expect(useAppStore.getState().project.nodes.find(node => node.id === 'generation')).toMatchObject({ data: { config: { prompt: job.prompt } } });
  });

  it.each(['image_generation', 'video_generation'] as const)('refuses an empty connected %s source instead of falling back to old text', async kind => {
    const project = linkedProject(kind);
    (project.nodes[0] as CanvasModuleNode).data.config.prompt = '  ';
    installProject(project);
    await expect(start(kind)).resolves.toBe(false);
    expect(useAppStore.getState().modelJobs).toHaveLength(0);
    expect(submit).not.toHaveBeenCalled();
  });

  it.each(['missing source', 'multiple sources', 'wrong source port'] as const)('refuses %s without creating a job', async fault => {
    const project = linkedProject('image_generation');
    if (fault === 'missing source') project.nodes = project.nodes.filter(node => node.id !== 'source-prompt');
    if (fault === 'multiple sources') project.edges.push({ ...project.edges[0]!, id: 'extra-prompt-edge' });
    if (fault === 'wrong source port') project.edges[0]!.sourcePortId = 'image';
    installProject(project);
    await expect(start('image_generation')).resolves.toBe(false);
    expect(useAppStore.getState().modelJobs).toHaveLength(0);
  });

  it('keeps direct generation text when there is no connected prompt edge', async () => {
    const project = linkedProject('image_generation');
    project.edges = [];
    installProject(project);
    await expect(start('image_generation')).resolves.toBe(true);
    expect(useAppStore.getState().modelJobs[0]!.prompt).toBe('Old generation text.');
  });

  it('flushes an unblurred editor source draft even when the store still reports saved', async () => {
    installProject(linkedProject('image_generation'));
    const flush = vi.fn(async () => {
      const current = useAppStore.getState().project.nodes[0] as CanvasModuleNode;
      return useAppStore.getState().commitProjectTransaction({ id: 'flush-source', label: 'Flush source prompt', operations: [{ kind: 'canvas', operation: { kind: 'update_node', node: { ...current, data: { ...current.data, config: { ...current.data.config, prompt: 'Unblurred latest source.' } } } } }] });
    });
    const unregister = registerEditorDraft(flush);
    try {
      await expect(start('image_generation')).resolves.toBe(true);
      expect(flush).toHaveBeenCalledOnce();
      expect(useAppStore.getState().modelJobs[0]!.prompt).toBe('Unblurred latest source.');
    } finally { unregister(); }
  });

  it('does not dispatch when flushing the source draft fails', async () => {
    installProject(linkedProject('image_generation'));
    const unregister = registerEditorDraft(async () => false);
    try {
      await expect(start('image_generation')).rejects.toMatchObject({ code: 'PROJECT_COMMIT_FAILED' });
      expect(useAppStore.getState().modelJobs).toHaveLength(0);
      expect(submit).not.toHaveBeenCalled();
    } finally { unregister(); }
  });

  it('rejects an MCP confirmed revision that becomes stale after source draft persistence', async () => {
    installProject(linkedProject('image_generation'));
    const projectId = useAppStore.getState().project.id;
    const unregister = registerEditorDraft(async () => useAppStore.getState().draftTextPromptNodeConfig('source-prompt', 'Changed after MCP confirmation.', projectId));
    try {
      await expect(start('image_generation', { projectId, expectedRevision: 7, provider: 'comfly', modelRoute: 'fixture/image_generation' })).rejects.toMatchObject({ code: 'PROJECT_CONTEXT_CHANGED' });
      expect(useAppStore.getState().desktopRevision).toBeGreaterThan(7);
      expect(useAppStore.getState().modelJobs).toHaveLength(0);
      expect(submit).not.toHaveBeenCalled();
    } finally { unregister(); }
  });

  it('rejects a project change during source flush even when generation IDs are reused', async () => {
    installProject(linkedProject('image_generation'));
    const unregister = registerEditorDraft(async () => {
      useAppStore.getState().setProject({ ...linkedProject('image_generation'), id: 'other-project' }, { schedulePersist: false });
      return true;
    });
    try {
      await expect(start('image_generation')).rejects.toMatchObject({ code: 'PROJECT_COMMIT_FAILED' });
      expect(useAppStore.getState().project.id).toBe('other-project');
      expect(useAppStore.getState().modelJobs).toHaveLength(0);
    } finally { unregister(); }
  });

  it('does not publish a source draft under the wrong project owner or in read only mode', async () => {
    installProject(linkedProject('image_generation'));
    const before = useAppStore.getState().project;
    await expect(useAppStore.getState().draftTextPromptNodeConfig('source-prompt', 'Wrong owner.', 'other-project')).resolves.toBe(false);
    useAppStore.setState({ saveStatus: 'read_only' });
    await expect(useAppStore.getState().draftTextPromptNodeConfig('source-prompt', 'Cannot write.', before.id)).resolves.toBe(false);
    expect(useAppStore.getState().project).toBe(before);
  });

  it('keeps the source authoritative when a stale generation editor draft flushes afterwards', async () => {
    installProject(linkedProject('image_generation'));
    const state = useAppStore.getState();
    await state.draftTextPromptNodeConfig('source-prompt', 'Newest source.', state.project.id);
    await expect(state.draftGenerationNodeConfig('generation', { prompt: 'Stale local editor.', modelRoute: 'fixture/image_generation' })).resolves.toBe(true);
    expect((useAppStore.getState().project.nodes.find(n => n.id === 'generation') as CanvasModuleNode).data.config.prompt).toBe('Newest source.');
  });
});

describe('connected image materials cannot silently become text-only execution', () => {
  const firstAsset = { assetId: 'a'.repeat(16), byteSize: 42, extension: 'png' as const, height: 100, width: 100, label: 'First managed material', mediaType: 'image/png' as const, origin: 'imported' as const, sha256: 'a'.repeat(64) };
  const secondAsset = { ...firstAsset, assetId: 'b'.repeat(16), sha256: 'b'.repeat(64), label: 'Second managed material' };
  function materialProject() {
    const project = linkedProject('image_generation');
    const material = createCanvasModuleNode('material', 'image_input', { x: 0, y: 0 });
    material.data.config.assetId = firstAsset.assetId;
    project.nodes.push(material);
    project.assets = [firstAsset, secondAsset];
    project.edges.push({ id: 'material-edge', source: material.id, sourcePortId: 'image', target: 'generation', targetPortId: 'references', order: 0 });
    return project;
  }
  function imageStart(referenceAssetIds?: readonly string[]) {
    return useAppStore.getState().runImageGenerationNode('generation', { prompt: 'Ignored old prompt.', modelRoute: 'fixture/image_generation', ...(referenceAssetIds === undefined ? {} : { referenceAssetIds }) });
  }
  it.each(['undefined', 'empty'] as const)('rejects an unimported connected image with %s explicit references before any enqueue', async requested => {
    const project = materialProject();
    (project.nodes.find(n => n.id === 'material') as CanvasModuleNode).data.config = {};
    installProject(project);
    await expect(imageStart(requested === 'empty' ? [] : undefined)).resolves.toBe(false);
    expect(useAppStore.getState().modelJobs).toHaveLength(0);
    expect(submit).not.toHaveBeenCalled();
  });
  it.each(['foreign asset', 'missing source', 'wrong source port', 'wrong source type'] as const)('rejects a connected %s even when the visible selection is empty', async fault => {
    const project = materialProject();
    if (fault === 'foreign asset') project.assets = [secondAsset];
    if (fault === 'missing source') project.nodes = project.nodes.filter(n => n.id !== 'material');
    if (fault === 'wrong source port') project.edges[1]!.sourcePortId = 'prompt';
    if (fault === 'wrong source type') (project.nodes.find(n => n.id === 'material') as CanvasModuleNode).data.moduleType = 'text_prompt';
    installProject(project);
    await expect(imageStart([])).resolves.toBe(false);
    expect(useAppStore.getState().modelJobs).toHaveLength(0);
    expect(submit).not.toHaveBeenCalled();
  });
  it('keeps the ordered connected owned materials when no explicit selection is supplied', async () => {
    const project = materialProject();
    const material = createCanvasModuleNode('material-2', 'upload_image', { x: 0, y: 500 });
    material.data.config.assetId = secondAsset.assetId;
    project.nodes.push(material);
    project.edges[1]!.order = 1;
    project.edges.push({ id: 'second-material-edge', source: material.id, sourcePortId: 'image', target: 'generation', targetPortId: 'references', order: 0 });
    installProject(project);
    await expect(imageStart()).resolves.toBe(true);
    expect(useAppStore.getState().modelJobs[0]!.referenceAssetIds).toEqual([secondAsset.assetId, firstAsset.assetId]);
  });
  it.each([{ requested: [] }, { requested: [secondAsset.assetId] }])('keeps an explicit valid material selection $requested after every connected source validates', async ({ requested }) => {
    installProject(materialProject());
    await expect(imageStart(requested)).resolves.toBe(true);
    expect(useAppStore.getState().modelJobs[0]!.referenceAssetIds).toEqual(requested);
  });
  it('keeps text-only generation available when there are no material wires', async () => {
    installProject(linkedProject('image_generation'));
    await expect(imageStart([])).resolves.toBe(true);
    expect(useAppStore.getState().modelJobs[0]!.referenceAssetIds).toEqual([]);
  });
  it.each(['canvas_library', 'image_generation', 'result_output'] as const)('preserves the existing owned %s material source type', async kind => {
    const project = materialProject();
    const source = project.nodes.find(n => n.id === 'material') as CanvasModuleNode;
    source.data.moduleType = kind;
    source.data.config = kind === 'canvas_library' ? { assetIds: [firstAsset.assetId, secondAsset.assetId] } : { assetId: firstAsset.assetId };
    project.edges[1]!.sourcePortId = kind === 'canvas_library' ? 'images' : 'image';
    installProject(project);
    await expect(imageStart()).resolves.toBe(true);
    expect(useAppStore.getState().modelJobs[0]!.referenceAssetIds).toEqual(kind === 'canvas_library' ? [firstAsset.assetId, secondAsset.assetId] : [firstAsset.assetId]);
  });
  it('preserves an owned legacy image_result on its image output', async () => {
    const project = materialProject();
    project.nodes = project.nodes.map(node => node.id === 'material' ? {
      id: 'material', type: 'image_result' as const, position: { x: 0, y: 0 },
      data: { assetId: firstAsset.assetId, modelId: 'fixture-model', parentNodeIds: [], referenceAssetIds: [] },
    } : node);
    installProject(project);
    await expect(imageStart()).resolves.toBe(true);
    expect(useAppStore.getState().modelJobs[0]!.referenceAssetIds).toEqual([firstAsset.assetId]);
  });
  it.each(['image_generation', 'result_output'] as const)('uses current owned results from a legally connected %s image output', async kind => {
    const project = materialProject();
    const source = project.nodes.find(n => n.id === 'material') as CanvasModuleNode;
    source.data.moduleType = kind;
    source.data.config = kind === 'image_generation' ? { resultAssetIds: [secondAsset.assetId], previousResultAssetIds: [firstAsset.assetId] } : {};
    project.edges[1]!.sourcePortId = 'image';
    if (kind === 'result_output') {
      const producer = createCanvasModuleNode('upstream-result-producer', 'image_generation', { x: 0, y: 500 });
      producer.data.config = { resultAssetIds: [secondAsset.assetId], previousResultAssetIds: [firstAsset.assetId] };
      project.nodes.push(producer);
      project.edges.push({ id: 'producer-result-edge', source: producer.id, sourcePortId: 'result', target: source.id, targetPortId: 'result', order: 0 });
    }
    installProject(project);
    await expect(imageStart()).resolves.toBe(true);
    expect(useAppStore.getState().modelJobs[0]!.referenceAssetIds).toEqual([secondAsset.assetId]);
  });
  it.each(['pending generation', 'multiple output inputs', 'foreign current result'] as const)('rejects %s instead of substituting previous results', async fault => {
    const project = materialProject();
    const source = project.nodes.find(n => n.id === 'material') as CanvasModuleNode;
    source.data.moduleType = fault === 'multiple output inputs' ? 'result_output' : 'image_generation';
    source.data.config = { resultAssetIds: fault === 'pending generation' ? [] : ['c'.repeat(16)], previousResultAssetIds: [firstAsset.assetId] };
    project.edges[1]!.sourcePortId = 'image';
    if (fault === 'multiple output inputs') {
      const producer = createCanvasModuleNode('upstream-result-producer', 'image_generation', { x: 0, y: 500 });
      producer.data.config.resultAssetIds = [firstAsset.assetId];
      project.nodes.push(producer);
      project.edges.push(...['one', 'two'].map(id => ({ id: 'producer-' + id, source: producer.id, sourcePortId: 'result', target: source.id, targetPortId: 'result', order: 0 })));
    }
    installProject(project);
    await expect(imageStart([])).resolves.toBe(false);
    expect(useAppStore.getState().modelJobs).toHaveLength(0);
  });
  it.each(['image_generation', 'result_output'] as const)('preserves the legally connected current %s image result for video execution', async kind => {
    window.novusDesktop!.provider.listProfiles = async () => [{ provider: 'comfly', modelRoute: 'fixture/video_generation', modelId: 'doubao-seedance-2.5', displayName: 'Verified fixture Seedance', capabilities: ['video_generation', 'async_tasks'] }];
    const project = linkedProject('video_generation');
    const producer = createCanvasModuleNode('material-producer', 'image_generation', { x: 0, y: 0 });
    producer.data.config.resultAssetIds = [firstAsset.assetId];
    const output = createCanvasModuleNode('material-output', 'result_output', { x: 920, y: 0 });
    project.nodes.push(producer, ...(kind === 'result_output' ? [output] : []));
    project.assets = [firstAsset];
    project.edges.push({ id: 'image-result-to-video', source: kind === 'result_output' ? output.id : producer.id, sourcePortId: 'image', target: 'generation', targetPortId: 'media', order: 0 });
    if (kind === 'result_output') project.edges.push({ id: 'producer-output', source: producer.id, sourcePortId: 'result', target: output.id, targetPortId: 'result', order: 0 });
    installProject(project);
    await expect(start('video_generation')).resolves.toBe(true);
    expect(useAppStore.getState().modelJobs[0]!.referenceAssetIds).toEqual([firstAsset.assetId]);
  });
});
