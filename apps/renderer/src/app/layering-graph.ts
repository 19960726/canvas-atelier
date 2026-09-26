import {
  canConnectCanvasPorts,
  createCanvasModuleNode,
  getCanvasModuleDefinition,
  type CanvasEdge,
  type CanvasModuleNode,
  type CanvasProject,
  type ProjectTransaction,
} from '@agent-canvas/domain';
import type { LayeringConfirmation, LayeringPlan } from './layering-plan';
import { canvasLayoutNodeSize, layeringBundleGeometry } from '../canvas/auto-layout';

export function buildLayeringGraphTransaction(
  project: CanvasProject,
  plan: LayeringPlan,
  confirmation: LayeringConfirmation,
  groupId: string,
): ProjectTransaction {
  if (!isSafeId(groupId)) throw new Error('The layering group identifier is invalid.');
  if (confirmation.sourceAssetId !== plan.sourceAssetId
    || confirmation.layerIds.length !== plan.layers.filter((layer) => layer.included).length
    || !plan.layers.filter((layer) => layer.included).every((layer, index) => confirmation.layerIds[index] === layer.layerId)) {
    throw new Error('Layering confirmation does not match the current source and layer plan.');
  }
  if (project.nodes.some((node) => node.type === 'module' && node.data.config.groupId === groupId)) {
    throw new Error('This layering group already exists in the project.');
  }
  const sourceNode = project.nodes.find((node): node is CanvasModuleNode => node.type === 'module'
    && (node.data.config.assetId === plan.sourceAssetId
      || (Array.isArray(node.data.config.resultAssetIds) && node.data.config.resultAssetIds.includes(plan.sourceAssetId))));
  if (sourceNode === undefined) throw new Error('A source image node for the selected managed asset is required.');
  if (project.assets !== undefined && !project.assets.some((asset) => asset.assetId === plan.sourceAssetId && asset.mediaType.startsWith('image/'))) {
    throw new Error('The selected source image is not a managed project asset.');
  }

  const includedLayers = plan.layers.filter((layer) => layer.included);
  const geometry = layeringBundleGeometry(includedLayers.length);
  const origin = nearbyLayeringOrigin(project, sourceNode, geometry);
  const groupNodeId = `image-layering-${groupId}`;
  const layerNodes = includedLayers.map((layer, order) => {
    const nodeId = `image-layer-${groupId}-${layer.layerId}`;
    if (project.nodes.some((node) => node.id === nodeId)) throw new Error('A layering node identifier already exists in the project.');
    const node = createCanvasModuleNode(nodeId, 'image_layer', {
      x: origin.x + geometry.layerOffsets[order]!.x,
      y: origin.y + geometry.layerOffsets[order]!.y,
    });
    node.data.config = {
      ...node.data.config,
      groupId,
      sourceNodeId: sourceNode.id,
      sourceAssetId: plan.sourceAssetId,
      layerId: layer.layerId,
      layerKind: layer.kind,
      canvasWidth: plan.canvasWidth,
      canvasHeight: plan.canvasHeight,
      ...(plan.selection ? { layerSelection: plan.selection } : {}),
      name: layer.name,
      description: layer.description,
      order,
      status: 'planned',
      modelRoute: confirmation.modelRoute,
      provider: confirmation.provider,
      resolution: confirmation.resolution,
      confirmationDigest: confirmation.digest,
    };
    return node;
  });
  if (project.nodes.some((node) => node.id === groupNodeId)) throw new Error('A composite node identifier already exists in the project.');
  const composite = createCanvasModuleNode(groupNodeId, 'image_layering', {
    x: origin.x + geometry.compositeOffset.x,
    y: origin.y + geometry.compositeOffset.y,
  });
  composite.data.config = {
    ...composite.data.config,
    groupId,
    sourceNodeId: sourceNode.id,
    sourceAssetId: plan.sourceAssetId,
    analysisId: groupId,
    planVersion: 1,
    canvasWidth: plan.canvasWidth,
    canvasHeight: plan.canvasHeight,
    ...(plan.selection ? { layerSelection: plan.selection } : {}),
    planLayers: includedLayers.map((layer, order) => ({
      layerId: layer.layerId,
      kind: layer.kind,
      name: layer.name,
      description: layer.description,
      order,
    })),
    resultState: 'empty',
    status: 'planned',
  };

  const operations: ProjectTransaction['operations'][number][] = [
    ...layerNodes.map((node) => ({ kind: 'canvas' as const, operation: { kind: 'create_node' as const, node } })),
    { kind: 'canvas', operation: { kind: 'create_node', node: composite } },
  ];
  const sourceOutput = findImageOutputPort(sourceNode);
  if (sourceOutput !== undefined && canConnectCanvasPorts(sourceNode, sourceOutput, composite, 'image').ok) {
    operations.push({ kind: 'canvas', operation: { kind: 'create_edge', edge: {
      id: `image-layer-source-${groupId}`,
      source: sourceNode.id,
      sourcePortId: sourceOutput,
      target: composite.id,
      targetPortId: 'image',
      order: 0,
    } satisfies CanvasEdge } });
  }
  layerNodes.forEach((node, order) => {
    operations.push({ kind: 'canvas', operation: { kind: 'create_edge', edge: {
      id: `image-layer-edge-${groupId}-${includedLayers[order]!.layerId}`,
      source: node.id,
      sourcePortId: 'image',
      target: composite.id,
      targetPortId: 'layerImages',
      order,
    } satisfies CanvasEdge } });
  });
  return {
    id: `create-image-layering-${groupId}`,
    label: `创建图片分层组 ${groupId}`,
    operations,
  };
}

function findImageOutputPort(node: CanvasModuleNode): string | undefined {
  return getCanvasModuleDefinition(node.data.moduleType).ports.find((port) => port.direction === 'output'
    && port.dataType === 'image_asset')?.id;
}

function nearbyLayeringOrigin(
  project: CanvasProject,
  sourceNode: CanvasModuleNode,
  geometry: ReturnType<typeof layeringBundleGeometry>,
  ignoredNodeIds: ReadonlySet<string> = new Set(),
): { x: number; y: number } {
  const sourceSize = canvasLayoutNodeSize(sourceNode.data.moduleType);
  const baseX = sourceNode.position.x + sourceSize.width + 72;
  const baseY = sourceNode.position.y;
  const occupied = project.nodes.filter((node): node is CanvasModuleNode => node.type === 'module' && !ignoredNodeIds.has(node.id))
    .map((node) => ({ ...node.position, ...canvasLayoutNodeSize(node.data.moduleType) }));
  const xOffsets = [0, 400, -400, 800, -800, 1200, -1200];
  const yOffsets = Array.from({ length: 13 }, (_, index) => index).flatMap((step) => step === 0 ? [0] : [step * 360, -step * 360]);
  const candidates = xOffsets.flatMap((dx) => yOffsets.map((dy) => ({ x: baseX + dx, y: baseY + dy })))
    .sort((left, right) => (left.x - baseX) ** 2 + (left.y - baseY) ** 2
      - ((right.x - baseX) ** 2 + (right.y - baseY) ** 2));
  for (const candidate of candidates) {
    if (candidate.x < 16 || candidate.y < 16) continue;
    const intersects = occupied.some((rect) => candidate.x < rect.x + rect.width + 32
      && candidate.x + geometry.width + 32 > rect.x
      && candidate.y < rect.y + rect.height + 32
      && candidate.y + geometry.height + 32 > rect.y);
    if (!intersects) return candidate;
  }
  return { x: baseX, y: Math.max(16, baseY + 12 * 360) };
}

/** Move only the old, single-column layout produced before compact layering was added. */
export function buildDistantLayeringRepairTransaction(project: CanvasProject): ProjectTransaction | null {
  const moduleNodes = project.nodes.filter((node): node is CanvasModuleNode => node.type === 'module');
  const byId = new Map(moduleNodes.map((node) => [node.id, node]));
  const operations: ProjectTransaction['operations'][number][] = [];
  for (const composite of moduleNodes.filter((node) => node.data.moduleType === 'image_layering')) {
    const groupId = composite.data.config.groupId;
    const sourceNodeId = composite.data.config.sourceNodeId;
    if (typeof groupId !== 'string' || typeof sourceNodeId !== 'string') continue;
    const source = byId.get(sourceNodeId);
    if (!source) continue;
    const layers = moduleNodes.filter((node) => node.data.moduleType === 'image_layer' && node.data.config.groupId === groupId)
      .sort((left, right) => Number(left.data.config.order ?? 0) - Number(right.data.config.order ?? 0));
    if (layers.length < 4 || new Set(layers.map((node) => node.position.x)).size !== 1) continue;
    const first = layers[0]!;
    const legacyColumn = layers.every((node, index) => Math.abs(node.position.y - (first.position.y + index * 248)) < 4)
      && Math.abs(composite.position.x - first.position.x - 520) < 24;
    if (!legacyColumn || first.position.x - source.position.x < 2500) continue;
    const geometry = layeringBundleGeometry(layers.length);
    const groupIds = new Set([...layers.map((node) => node.id), composite.id]);
    const origin = nearbyLayeringOrigin(project, source, geometry, groupIds);
    if (Math.hypot(origin.x - source.position.x, origin.y - source.position.y) > 3000) continue;
    for (const [index, node] of layers.entries()) {
      const offset = geometry.layerOffsets[index]!;
      operations.push({ kind: 'canvas', operation: { kind: 'update_node', node: {
        ...node, position: { x: origin.x + offset.x, y: origin.y + offset.y },
      } } });
    }
    operations.push({ kind: 'canvas', operation: { kind: 'update_node', node: {
      ...composite, position: { x: origin.x + geometry.compositeOffset.x, y: origin.y + geometry.compositeOffset.y },
    } } });
  }
  return operations.length === 0 ? null : {
    id: `repair-distant-image-layers-${Date.now()}`,
    label: '将旧版图片分层节点移回原图附近',
    operations,
  };
}

function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,80}$/u.test(value);
}
