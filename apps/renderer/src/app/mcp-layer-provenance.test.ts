import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyProjectTransaction, createCanvasModuleNode, parseCanvasProject, type CanvasModuleNode, type ProjectTransaction } from '@agent-canvas/domain';
import { createMcpWorkspaceAdapter, type McpWorkspaceSource } from './mcp-workspace-adapter';
import { buildSourceLayerDocument } from './source-layer-document';
import { sourceLayerInputFromNodes } from '../canvas/source-layer-preview';
import { mcpUiConfirmationStore } from './mcp-ui-confirmation-store';

beforeEach(() => mcpUiConfirmationStore.clear());

describe('MCP cannot forge protected image layer provenance', () => {
  it('rejects forged independent-RGB provenance for low-alpha source layers', async () => {
    const fixture = setup();
    await expect(fixture.document()).rejects.toThrow(/杯身.*copy.*透明贡献.*独立颜色/u);
    const attempted = await fixture.adapter.handle({ tool: 'canvas_update_node', expectedRevision: fixture.revision(), nodeId: 'cup', config: { pixelColorSpace: 'foreground' } });
    if (attempted.ok) {
      // Reproduce the real consequence through the node→source-input→export helper chain before requiring rejection.
      expect(fixture.input()!.layers.find(layer => layer.record.layerId === 'cup')!.preparedRgb).toBe(true);
      await expect(fixture.document()).rejects.toThrow(/透明贡献.*独立颜色/u);
    }
    expect(attempted).toMatchObject({ ok: false, error: { code: 'INVALID_WORKFLOW', message: expect.stringContaining('pixelColorSpace') } });
    expect(fixture.commit).not.toHaveBeenCalled();
  });

  it.each([
    { nodeId: 'cup', config: { pixelMode: 'generated' }, field: 'pixelMode' },
    { nodeId: 'cup', config: { maskSpace: 'bounds' }, field: 'maskSpace' },
    { nodeId: 'cup', config: { qualityStatus: 'failed' }, field: 'qualityStatus' },
    { nodeId: 'cup', config: { resultAssetId: 'forged-asset' }, field: 'resultAssetId' },
    { nodeId: 'cup', config: { previousVideoResults: [{ assetId: 'forged-video' }] }, field: 'previousVideoResults' },
    { nodeId: 'cup', config: { status: 'ready' }, field: 'status' },
    { nodeId: 'group', config: { layers: [{ layerId: 'forged', assetId: 'forged-asset' }] }, field: 'layers' },
    { nodeId: 'group', config: { planLayers: [] }, field: 'planLayers' },
    { nodeId: 'group', config: { foregroundOutputContract: 'source-independent-rgba-v2' }, field: 'foregroundOutputContract' },
    { nodeId: 'group', config: { resultState: 'ready' }, field: 'resultState' },
    { nodeId: 'group', config: { needsReconfirm: false }, field: 'needsReconfirm' },
    { nodeId: 'cup', config: { semanticReviewAccepted: true }, field: 'semanticReviewAccepted' },
    { nodeId: 'cup', config: { semanticReviewDigest: 'a'.repeat(64) }, field: 'semanticReviewDigest' },
    { nodeId: 'group', config: { assemblyConfirmationDigest: 'a'.repeat(64) }, field: 'assemblyConfirmationDigest' },
    { nodeId: 'cup', config: { formatQualityStatus: 'passed' }, field: 'formatQualityStatus' },
    { nodeId: 'cup', config: { qualityFormatCheckedAssetId: 'asset-cup' }, field: 'qualityFormatCheckedAssetId' },
    { nodeId: 'cup', config: { foregroundProvenance: 'local-accepted' }, field: 'foregroundProvenance' },
    { nodeId: 'cup', config: { foregroundValidation: true }, field: 'foregroundValidation' },
    { nodeId: 'cup', config: { sourceAssetId: 'another-source' }, field: 'sourceAssetId' },
    { nodeId: 'cup', config: { layerSelection: { mode: 'rect', box: { x: .1, y: .1, width: .5, height: .5 } } }, field: 'layerSelection' },
  ])('rejects direct update of $field before a durable transaction', async ({ nodeId, config, field }) => {
    const fixture = setup();
    expect(await fixture.adapter.handle({ tool: 'canvas_update_node', expectedRevision: fixture.revision(), nodeId, config }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_WORKFLOW', message: expect.stringContaining(field) } });
    expect(fixture.commit).not.toHaveBeenCalled();
  });

  it.each(['image_layer', 'image_layering'] as const)('rejects forged protected fields on direct creation of %s', async moduleType => {
    const fixture = setup();
    expect(await fixture.adapter.handle({ tool: 'canvas_create_node', expectedRevision: fixture.revision(), moduleType,
      position: { x: 0, y: 0 }, config: moduleType === 'image_layer' ? { pixelColorSpace: 'foreground' } : { layers: [{ assetId: 'forged-asset' }] } }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_WORKFLOW', message: expect.stringContaining('受保护') } });
    expect(fixture.commit).not.toHaveBeenCalled();
  });

  it.each(['create', 'update'] as const)('rejects protected provenance in a workflow plan %s before approval', async kind => {
    const fixture = setup();
    const mutation = kind === 'create'
      ? { kind: 'create_node' as const, nodeId: 'forged-layer', moduleType: 'image_layer' as const, position: { x: 0, y: 0 }, config: { qualityStatus: 'passed' } }
      : { kind: 'update_node' as const, nodeId: 'cup', config: { maskSpace: 'bounds' } };
    expect(await fixture.adapter.handle({ tool: 'canvas_plan_workflow', expectedRevision: fixture.revision(), workflowIntent: 'Forge layer provenance', mutations: [mutation] }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_WORKFLOW', message: expect.stringContaining('受保护') } });
    expect(fixture.commit).not.toHaveBeenCalled();
  });

  it('keeps existing assets but invalidates the entire group after semantic, position or order edits', async () => {
    const fixture = setup();
    expect(await fixture.adapter.handle({ tool: 'canvas_update_node', expectedRevision: fixture.revision(), nodeId: 'cup', config: {
      ...fixture.nodes().find(node => node.id === 'cup')!.data.config, name: '透明杯身', visible: false, opacity: .5, order: 5,
      sourceBounds: { x: .1, y: .1, width: .8, height: .8 },
    } })).toMatchObject({ ok: true });
    expect(fixture.nodes().find(node => node.id === 'cup')!.data.config).toMatchObject({ name: '透明杯身', visible: false, opacity: .5, order: 5,
      resultAssetId: 'asset-cup', qualityStatus: 'pending', needsReconfirm: true });
    expect(fixture.nodes().filter(node => node.data.moduleType === 'image_layer').every(node => node.data.config.needsReconfirm === true)).toBe(true);
    expect(fixture.nodes().find(node => node.id === 'group')!.data.config).toMatchObject({ needsReconfirm: true, resultState: 'needs_review' });
    const plan = (fixture.nodes().find(node => node.id === 'group')!.data.config.planLayers as Record<string, unknown>[]).find(row => row.layerId === 'cup')!;
    expect(plan).toMatchObject({ name: '透明杯身', order: 5, sourceBounds: { x: .1, y: .1, width: .8, height: .8 } });
    expect(plan).not.toHaveProperty('resultAssetId');
    expect(plan).not.toHaveProperty('sourceAssetId');
    expect(fixture.input()).toBeNull();
    expect(fixture.commit).toHaveBeenCalledOnce();
  });

  it.each([
    { name: '保温杯本体' }, { description: '只包含杯身，不含杯盖和手部' },
    { order: 7 }, { sourceBounds: { x: .1, y: .1, width: .8, height: .8 } },
  ])('invalidates old proof for a changed layer field %j', async config => {
    const fixture = setup();
    for (const node of fixture.nodes()) Object.assign(node.data.config, { semanticReviewAccepted: true,
      semanticReviewDigest: 'a'.repeat(64), layeringConfirmationDigest: 'a'.repeat(64), assemblyConfirmationDigest: 'a'.repeat(64) });
    const cup = fixture.nodes().find(node => node.id === 'cup')!;
    Object.assign(cup.data.config, { pixelColorSpace: 'foreground', preparedRgb: true, layerPrepared: true });
    expect(await fixture.adapter.handle({ tool: 'canvas_update_node', expectedRevision: fixture.revision(), nodeId: 'cup', config })).toMatchObject({ ok: true });
    const plans = fixture.nodes().find(node => node.id === 'group')!.data.config.planLayers as Record<string, unknown>[];
    expect(plans.find(plan => plan.layerId === 'cup')).toMatchObject(config);
    for (const node of fixture.nodes()) {
      expect(node.data.config.needsReconfirm).toBe(true);
      expect(node.data.config.semanticReviewAccepted).toBeUndefined();
      expect(node.data.config.semanticReviewDigest).toBeUndefined();
      expect(node.data.config.assemblyConfirmationDigest).toBeUndefined();
    }
    expect(fixture.nodes().find(node => node.id === 'cup')!.data.config).toMatchObject({ resultAssetId: 'asset-cup',
      pixelColorSpace: 'foreground', preparedRgb: true, layerPrepared: true });
  });

  it('does not invalidate proof for visibility, opacity or a same-value plan patch', async () => {
    const fixture = setup();
    const before = fixture.nodes().find(node => node.id === 'cup')!.data.config;
    expect(await fixture.adapter.handle({ tool: 'canvas_update_node', expectedRevision: fixture.revision(), nodeId: 'cup', config: {
      name: before.name, description: before.description, order: before.order, sourceBounds: structuredClone(before.sourceBounds),
      visible: false, opacity: .5,
    } })).toMatchObject({ ok: true });
    expect(fixture.nodes().find(node => node.id === 'cup')!.data.config).toMatchObject({ qualityStatus: 'passed', visible: false, opacity: .5 });
    expect(fixture.nodes().some(node => node.data.config.needsReconfirm === true)).toBe(false);
  });

  it('cannot clear an invalid group proof or insert semantic acceptance through an approved workflow', async () => {
    const fixture = setup();
    fixture.nodes().find(node => node.id === 'group')!.data.config.needsReconfirm = true;
    for (const mutation of [
      { kind: 'update_node' as const, nodeId: 'group', config: { needsReconfirm: false } },
      { kind: 'update_node' as const, nodeId: 'cup', config: { semanticReviewAccepted: true, semanticReviewDigest: 'a'.repeat(64) } },
    ]) {
      expect(await fixture.adapter.handle({ tool: 'canvas_plan_workflow', expectedRevision: fixture.revision(),
        workflowIntent: '复用旧分层证明', mutations: [mutation] })).toMatchObject({ ok: false, error: { code: 'INVALID_WORKFLOW' } });
    }
    expect(fixture.commit).not.toHaveBeenCalled();
  });

  it('invalidates the same group when a reviewed workflow applies a legitimate position change', async () => {
    const fixture = setup();
    const plan = await fixture.adapter.handle({ tool: 'canvas_plan_workflow', expectedRevision: fixture.revision(),
      workflowIntent: '校正杯身原图范围', mutations: [{ kind: 'update_node', nodeId: 'cup',
        config: { sourceBounds: { x: .1, y: .1, width: .8, height: .8 } } }] });
    expect(plan.ok).toBe(true);
    expect(fixture.nodes().some(node => node.data.config.needsReconfirm === true)).toBe(false);
    if (!plan.ok) throw new Error('Expected valid local edit plan');
    const planId = (plan.result as { planId: string }).planId;
    const grant = fixture.adapter.confirmPlan(planId);
    expect(await fixture.adapter.handle({ tool: 'canvas_apply_workflow', expectedRevision: fixture.revision(), planId,
      confirmationToken: grant.token })).toMatchObject({ ok: true });
    expect(fixture.nodes().every(node => node.data.config.needsReconfirm === true)).toBe(true);
    expect(fixture.input()).toBeNull();
    expect(fixture.commit).toHaveBeenCalledOnce();
  });

  it('does not let a renamed non-shadow layer masquerade as a shadow-only mask', async () => {
    const fixture = setup();
    fixture.nodes().find(node => node.id === 'cup')!.data.config.layerId = 'shadow-cup';
    expect(await fixture.adapter.handle({ tool: 'canvas_update_node', expectedRevision: fixture.revision(), nodeId: 'cup',
      config: { name: '杯子投影', description: '仅投影，不含杯子本体' } })).toMatchObject({ ok: false,
        error: { code: 'INVALID_WORKFLOW', message: expect.stringContaining('受保护') } });
    expect(fixture.commit).not.toHaveBeenCalled();
  });

  it('protects an ordinary object ID from a name-and-description change into a shadow-only mask', async () => {
    const fixture = setup();
    expect(fixture.nodes().find(node => node.id === 'cup')!.data.config.layerId).toBe('cup');
    expect(fixture.input()!.layers.find(layer => layer.record.layerId === 'cup')!.shadowOnly).toBe(false);
    expect(await fixture.adapter.handle({ tool: 'canvas_update_node', expectedRevision: fixture.revision(), nodeId: 'cup',
      config: { name: '杯子投影', description: '仅杯子在台面的投影，不含杯子本体' } })).toMatchObject({ ok: false,
        error: { code: 'INVALID_WORKFLOW', message: expect.stringContaining('受保护') } });
    expect(fixture.commit).not.toHaveBeenCalled();
    expect(fixture.nodes().find(node => node.id === 'cup')!.data.config).toMatchObject({ layerId: 'cup', name: '杯身', description: '原图物体' });
  });

  it('keeps ordinary generation and prompt configuration editable', async () => {
    const fixture = setup();
    expect(await fixture.adapter.handle({ tool: 'canvas_create_node', expectedRevision: fixture.revision(), moduleType: 'image_generation', position: { x: 1, y: 1 },
      config: { prompt: '保留产品，调整灯光', resultState: 'empty', resolution: '4K' } })).toMatchObject({ ok: true });
  });
});

function setup() {
  const width = 24, height = 24, sourcePixels = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) sourcePixels.set([120, 140, 160, 255], pixel * 4);
  const mask = new Uint8Array(sourcePixels.length);
  for (let y = 6; y < 18; y++) for (let x = 6; x < 18; x++) mask.set([255, 255, 255, 64], (y * width + x) * 4);
  const nodes = ['bg', 'cup', 'copy'].map((layerId, order) => {
    const node = createCanvasModuleNode(layerId, 'image_layer', { x: 0, y: order * 100 });
    node.data.config = { ...node.data.config, groupId: 'group', layerId, name: layerId === 'cup' ? '杯身' : layerId,
      description: '原图物体', layerKind: order === 0 ? 'background' : 'transparent', resultAssetId: 'asset-' + layerId,
      sourceAssetId: 'source', qualityStatus: 'passed', status: 'completed', pixelMode: 'source', maskSpace: 'source',
      sourceBounds: { x: 0, y: 0, width: 1, height: 1 }, order };
    return node;
  });
  const group = createCanvasModuleNode('group', 'image_layering', { x: 500, y: 0 });
  group.data.config = { ...group.data.config, groupId: 'group', sourceAssetId: 'source', pixelMode: 'source', canvasWidth: width, canvasHeight: height,
    layerSelection: { mode: 'whole' }, planLayers: nodes.map((node, order) => ({ layerId: node.id, name: node.data.config.name,
      kind: order === 0 ? 'background' : 'transparent', order })) };
  let project = parseCanvasProject({ version: 1, graphVersion: 2, id: 'project-layer-guard', name: 'Layer guard',
    assets: [], projectMemory: [], skillPromotionCandidates: [], nodes: [...nodes, group], edges: [] });
  let revision = 4;
  const commit = vi.fn(async (transaction: ProjectTransaction) => { project = applyProjectTransaction(project, transaction); revision++; return true; });
  const workspace: McpWorkspaceSource = { getProject: () => project, getRevision: () => revision,
    getSelection: () => ({ nodeIds: [], edgeIds: [] }), getJobs: () => [], commitProjectTransaction: commit,
    runNode: async () => ({ started: false, jobIds: [] }), cancelJob: async () => {}, requestMediaImport: () => false };
  const currentNodes = () => project.nodes.filter((node): node is CanvasModuleNode => node.type === 'module');
  const input = () => sourceLayerInputFromNodes(currentNodes().find(node => node.id === 'group')!.data.config, currentNodes(),
    ['source', 'asset-bg', 'asset-cup', 'asset-copy'].map(assetId => ({ assetId, mediaType: 'image/png', displayUrl: assetId, width, height })) as never);
  const document = () => {
    const derived = input()!;
    return buildSourceLayerDocument({ width, height, source: sourcePixels, selection: { mode: 'whole' },
      layers: derived.layers.map(layer => ({ ...layer.record, id: layer.record.layerId, kind: layer.record.kind === 'background' ? 'background' as const : 'transparent' as const,
        preparedRgb: layer.preparedRgb, shadowOnly: layer.shadowOnly, maskSpace: layer.maskSpace,
        bounds: layer.bounds as { x: number; y: number; width: number; height: number }, load: async () => layer.record.kind === 'background' ? sourcePixels : mask })) });
  };
  return { adapter: createMcpWorkspaceAdapter(workspace), commit, revision: () => revision, nodes: currentNodes, input, document };
}
