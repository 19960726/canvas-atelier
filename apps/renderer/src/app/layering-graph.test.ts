import { describe, expect, it } from 'vitest';
import {
  applyProjectTransaction,
  canConnectCanvasPorts,
  createCanvasModuleNode,
  parseCanvasProject,
  type CanvasProject,
} from '@agent-canvas/domain';
import { confirmLayeringPlan, parseLayeringAnalysis } from './layering-plan';
import { buildDistantLayeringRepairTransaction, buildLayeringGraphTransaction } from './layering-graph';

const assetId = 'a1b2c3d4e5f60718';
const reply = JSON.stringify({ layers: [
  { layerId: 'background', kind: 'background', name: '背景', description: '补全遮挡后的厨房', included: true },
  { layerId: 'product', kind: 'transparent', name: '主体', description: '保留产品轮廓', included: true },
  { layerId: 'text-mark', kind: 'transparent', name: '标记', description: '像素形式的包装标记', included: true },
] });

function sourceProject(): CanvasProject {
  const source = createCanvasModuleNode('source-image', 'image_input', { x: 120, y: 180 });
  source.data.config = { ...source.data.config, assetId };
  return parseCanvasProject({
    version: 1, id: 'project-layering', name: 'Layering test', nodes: [source], edges: [],
    assets: [{
      assetId, byteSize: 16, extension: 'png', height: 768, label: '原图', mediaType: 'image/png',
      origin: 'imported', sha256: `${assetId}${'b'.repeat(48)}`, width: 1024,
    }],
    projectMemory: [], skillPromotionCandidates: [],
  });
}

describe('durable AI layering graph', () => {
  it('repairs a previously saved distant seven-layer group without moving unrelated nodes', () => {
    const source = createCanvasModuleNode('source-generated', 'image_generation', { x: 2074, y: 96 });
    source.data.config = { ...source.data.config, resultAssetIds: [assetId] };
    const layers = Array.from({ length: 7 }, (_, index) => {
      const layer = createCanvasModuleNode(`old-layer-${index}`, 'image_layer', { x: 9816, y: 96 + index * 248 });
      layer.data.config = { ...layer.data.config, groupId: 'old-group', sourceNodeId: source.id, order: index };
      return layer;
    });
    const composite = createCanvasModuleNode('old-composite', 'image_layering', { x: 10336, y: 96 });
    composite.data.config = { ...composite.data.config, groupId: 'old-group', sourceNodeId: source.id };
    const unrelated = createCanvasModuleNode('unrelated', 'image_input', { x: 1600, y: 96 });
    const project = { ...sourceProject(), nodes: [source, unrelated, ...layers, composite] };
    const transaction = buildDistantLayeringRepairTransaction(project);
    expect(transaction).not.toBeNull();
    const repaired = applyProjectTransaction(project, transaction!);
    const movedLayers = repaired.nodes.filter((node) => node.type === 'module' && node.data.config.groupId === 'old-group'
      && node.data.moduleType === 'image_layer');
    expect(Math.min(...movedLayers.map((node) => node.position.x)) - source.position.x).toBeLessThan(2500);
    expect(Math.max(...movedLayers.map((node) => node.position.y)) - Math.min(...movedLayers.map((node) => node.position.y))).toBeLessThan(1200);
    expect(repaired.nodes.find((node) => node.id === unrelated.id)).toEqual(unrelated);
    expect(buildDistantLayeringRepairTransaction(repaired)).toBeNull();
  });
  it('starts a seven-layer split beside its source instead of after the rightmost unrelated node', async () => {
    const project = sourceProject();
    const distant = createCanvasModuleNode('unrelated', 'image_input', { x: 8000, y: 180 });
    const layers = Array.from({ length: 7 }, (_, index) => ({
      layerId: `part-${index}`, kind: index === 0 ? 'background' : 'transparent',
      name: `Part ${index}`, description: 'Independent layer', included: true,
    }));
    const plan = parseLayeringAnalysis(JSON.stringify({ layers }), assetId, 1024, 768);
    const confirmation = await confirmLayeringPlan(plan, 'comfly', 'comfly-gpt-image-2', '1K', '2026-09-23T06:00:00.000Z');
    const next = applyProjectTransaction({ ...project, nodes: [...project.nodes, distant] },
      buildLayeringGraphTransaction({ ...project, nodes: [...project.nodes, distant] }, plan, confirmation, 'nearby'));
    const split = next.nodes.filter((node) => node.type === 'module' && node.data.config.groupId === 'nearby');
    const children = split.filter((node) => node.type === 'module' && node.data.moduleType === 'image_layer');
    const composite = split.find((node) => node.type === 'module' && node.data.moduleType === 'image_layering')!;
    expect(children).toHaveLength(7);
    expect(Math.min(...children.map((node) => node.position.x))).toBeGreaterThan(120);
    expect(Math.max(...children.map((node) => node.position.x))).toBeLessThan(2500);
    expect(new Set(children.map((node) => node.position.x)).size).toBeGreaterThan(1);
    expect(Math.max(...children.map((node) => node.position.y)) - Math.min(...children.map((node) => node.position.y))).toBeLessThan(1200);
    expect(composite.position.x).toBeGreaterThan(Math.max(...children.map((node) => node.position.x)));
  });
  it('creates one planned node per included layer, one composite and ordered valid connections in a single transaction', async () => {
    const project = sourceProject();
    const plan = parseLayeringAnalysis(reply, assetId, 1024, 768);
    const confirmation = await confirmLayeringPlan(plan, 'comfly', 'comfly-gpt-image-2', '1K', '2026-09-23T06:00:00.000Z');
    const transaction = buildLayeringGraphTransaction(project, plan, confirmation, 'group-123');

    expect(transaction.operations.filter((operation) => operation.kind === 'canvas' && operation.operation.kind === 'create_node')).toHaveLength(4);
    expect(transaction.operations.filter((operation) => operation.kind === 'canvas' && operation.operation.kind === 'create_edge')).toHaveLength(4);
    const next = applyProjectTransaction(project, transaction);
    const created = next.nodes.filter((node) => !project.nodes.some((existing) => existing.id === node.id));
    const layers = created.filter((node) => node.type === 'module' && node.data.moduleType === 'image_layer');
    const composite = created.find((node) => node.type === 'module' && node.data.moduleType === 'image_layering');
    expect(layers).toHaveLength(3);
    expect(layers.filter((node) => node.type === 'module').map((node) => node.data.config)).toEqual(expect.arrayContaining([
      expect.objectContaining({ groupId: 'group-123', layerId: 'background', layerKind: 'background', order: 0, status: 'planned' }),
      expect.objectContaining({ groupId: 'group-123', layerId: 'product', layerKind: 'transparent', order: 1, status: 'planned' }),
      expect.objectContaining({ groupId: 'group-123', layerId: 'text-mark', layerKind: 'transparent', order: 2, status: 'planned' }),
    ]));
    expect(layers.every((node) => node.type === 'module' && !('assetId' in node.data.config))).toBe(true);
    expect(composite).toMatchObject({ type: 'module', data: { moduleType: 'image_layering', config: { groupId: 'group-123', sourceNodeId: 'source-image', sourceAssetId: assetId } } });
    const layerEdges = next.edges.filter((edge) => layers.some((layer) => layer.id === edge.source));
    expect(layerEdges.map((edge) => [edge.source, edge.sourcePortId, edge.target, edge.targetPortId, edge.order])).toEqual(
      layers.map((layer, order) => [layer.id, 'image', composite!.id, 'layerImages', order]),
    );
    expect(next.edges).toContainEqual(expect.objectContaining({ source: 'source-image', sourcePortId: 'image', target: composite!.id, targetPortId: 'image' }));
    const compositeNode = composite!;
    for (const layer of layers) expect(canConnectCanvasPorts(layer as never, 'image', compositeNode as never, 'layerImages')).toEqual({ ok: true });
    expect(next.nodes.find((node) => node.id === 'source-image')).toEqual(project.nodes[0]);
    const reopened = parseCanvasProject(JSON.parse(JSON.stringify(next)) as unknown);
    expect(reopened.nodes.filter((node) => node.type === 'module' && node.data.moduleType === 'image_layer')).toHaveLength(3);
    expect(reopened.nodes.find((node) => node.id === 'image-layering-group-123')).toMatchObject({
      type: 'module', data: { moduleType: 'image_layering', config: { groupId: 'group-123', status: 'planned' } },
    });
  });

  it('rejects duplicate groups, missing source nodes and a confirmation from another image', async () => {
    const project = sourceProject();
    const plan = parseLayeringAnalysis(reply, assetId, 1024, 768);
    const confirmation = await confirmLayeringPlan(plan, 'comfly', 'comfly-gpt-image-2', '2K', '2026-09-23T06:00:00.000Z');
    const first = applyProjectTransaction(project, buildLayeringGraphTransaction(project, plan, confirmation, 'group-duplicate'));
    expect(() => buildLayeringGraphTransaction(first, plan, confirmation, 'group-duplicate')).toThrow(/already exists/u);
    expect(() => buildLayeringGraphTransaction({ ...project, nodes: [] }, plan, confirmation, 'group-no-source')).toThrow(/source image node/u);
    expect(() => buildLayeringGraphTransaction(project, { ...plan, sourceAssetId: 'b2c3d4e5f6071829' }, confirmation, 'group-other-source')).toThrow(/confirmation/u);
  });

  it('connects a selected generated result to the composite through its managed image output', async () => {
    const project = sourceProject();
    const generated = createCanvasModuleNode('generated-image', 'image_generation', { x: 180, y: 260 });
    generated.data.config = { ...generated.data.config, resultAssetIds: [assetId] };
    const generatedProject = parseCanvasProject({ ...project, nodes: [generated] });
    const plan = parseLayeringAnalysis(reply, assetId, 1024, 768);
    const confirmation = await confirmLayeringPlan(plan, 'comfly', 'comfly-gpt-image-2', '1K', '2026-09-23T06:00:00.000Z');

    const next = applyProjectTransaction(generatedProject, buildLayeringGraphTransaction(generatedProject, plan, confirmation, 'generated-group'));

    expect(next.edges).toContainEqual(expect.objectContaining({
      source: 'generated-image', sourcePortId: 'image', target: 'image-layering-generated-group', targetPortId: 'image',
    }));
    expect(canConnectCanvasPorts(generated as never, 'image', next.nodes.find((node) => node.id === 'image-layering-generated-group') as never, 'image')).toEqual({ ok: true });
  });
});
