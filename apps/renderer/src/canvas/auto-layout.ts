import type { CanvasModuleType } from '@agent-canvas/domain';

export interface AutoLayoutNode {
  readonly id: string;
  readonly moduleType: CanvasModuleType;
  readonly position: { readonly x: number; readonly y: number };
  readonly groupId?: string;
  readonly order?: number;
  readonly layoutSize?: { readonly width: number; readonly height: number };
}

export interface AutoLayoutEdge {
  readonly source: string;
  readonly target: string;
}

export interface AutoLayoutPosition {
  readonly nodeId: string;
  readonly position: { readonly x: number; readonly y: number };
}

const COLUMN_GAP = 96;
const ROW_GAP = 72;
const GROUP_COLUMN_GAP = 160;
const GROUP_ROW_GAP = 120;
const START_X = 96;
const START_Y = 96;

const NODE_SIZES: Partial<Record<CanvasModuleType, { readonly width: number; readonly height: number }>> = {
  image_generation: { width: 654, height: 486 },
  reverse_agent: { width: 426, height: 594 },
  video_generation: { width: 654, height: 486 },
  result_output: { width: 404, height: 230 },
  video_result: { width: 400, height: 323 },
  reverse_result: { width: 520, height: 648 },
  image_input: { width: 292, height: 326 },
  upload_image: { width: 292, height: 326 },
  video_input: { width: 138, height: 108 },
  image_layer: { width: 320, height: 300 },
  image_layering: { width: 440, height: 700 },
};

const FALLBACK_NODE_SIZE = { width: 420, height: 320 };

interface LayoutGroup {
  readonly positions: readonly AutoLayoutPosition[];
  readonly width: number;
  readonly height: number;
}

const LAYER_COLUMN_GAP = 36;
const LAYER_ROW_GAP = 36;
const LAYER_COMPOSITE_GAP = 88;

export function canvasLayoutNodeSize(moduleType: CanvasModuleType): { readonly width: number; readonly height: number } {
  return NODE_SIZES[moduleType] ?? FALLBACK_NODE_SIZE;
}

/** Reserve the same compact geometry for initial placement and Arrange Canvas. */
export function layeringBundleGeometry(layerCount: number): {
  readonly width: number;
  readonly height: number;
  readonly layerOffsets: readonly { readonly x: number; readonly y: number }[];
  readonly compositeOffset: { readonly x: number; readonly y: number };
} {
  const count = Math.max(1, layerCount);
  const columns = Math.min(3, Math.ceil(Math.sqrt(count)));
  const rows = Math.ceil(count / columns);
  const layerSize = canvasLayoutNodeSize('image_layer');
  const compositeSize = canvasLayoutNodeSize('image_layering');
  const layerHeight = rows * layerSize.height + (rows - 1) * LAYER_ROW_GAP;
  const compositeHeight = Math.max(compositeSize.height, 420 + count * 40);
  const height = Math.max(layerHeight, compositeHeight);
  const gridWidth = columns * layerSize.width + (columns - 1) * LAYER_COLUMN_GAP;
  return {
    width: gridWidth + LAYER_COMPOSITE_GAP + compositeSize.width,
    height,
    layerOffsets: Array.from({ length: layerCount }, (_, index) => ({
      x: (index % columns) * (layerSize.width + LAYER_COLUMN_GAP),
      y: (height - layerHeight) / 2 + Math.floor(index / columns) * (layerSize.height + LAYER_ROW_GAP),
    })),
    compositeOffset: { x: gridWidth + LAYER_COMPOSITE_GAP, y: (height - compositeHeight) / 2 },
  };
}

function bundleLayeringNodes(nodes: readonly AutoLayoutNode[], edges: readonly AutoLayoutEdge[]): {
  nodes: AutoLayoutNode[];
  edges: AutoLayoutEdge[];
  offsets: ReadonlyMap<string, readonly { readonly id: string; readonly x: number; readonly y: number }[]>;
} {
  const members = new Map<string, string>();
  const offsets = new Map<string, readonly { readonly id: string; readonly x: number; readonly y: number }[]>();
  const virtualNodes: AutoLayoutNode[] = [];
  for (const composite of nodes.filter((node) => node.moduleType === 'image_layering' && node.groupId)) {
    const layers = nodes.filter((node) => node.moduleType === 'image_layer' && node.groupId === composite.groupId)
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id));
    if (layers.length === 0) continue;
    const geometry = layeringBundleGeometry(layers.length);
    const bundleId = `layout-bundle:${composite.id}`;
    for (const member of [...layers, composite]) members.set(member.id, bundleId);
    offsets.set(bundleId, [
      ...layers.map((layer, index) => ({ id: layer.id, ...geometry.layerOffsets[index]! })),
      { id: composite.id, ...geometry.compositeOffset },
    ]);
    virtualNodes.push({
      id: bundleId, moduleType: 'image_layering', position: composite.position,
      layoutSize: { width: geometry.width, height: geometry.height },
    });
  }
  virtualNodes.push(...nodes.filter((node) => !members.has(node.id)));
  const virtualEdges: AutoLayoutEdge[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    const source = members.get(edge.source) ?? edge.source;
    const target = members.get(edge.target) ?? edge.target;
    const key = `${source}\u0000${target}`;
    if (source === target || seen.has(key)) continue;
    seen.add(key);
    virtualEdges.push({ source, target });
  }
  return { nodes: virtualNodes, edges: virtualEdges, offsets };
}

/** Arrange connected workflows as compact groups with left-to-right dependency layers. */
export function arrangeCanvasNodePositions(
  nodes: readonly AutoLayoutNode[],
  edges: readonly AutoLayoutEdge[],
): AutoLayoutPosition[] {
  if (nodes.length === 0) return [];
  const bundled = bundleLayeringNodes(nodes, edges);
  nodes = bundled.nodes;
  edges = bundled.edges;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  const adjacent = new Map<string, Set<string>>();
  for (const node of nodes) {
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
    adjacent.set(node.id, new Set());
  }
  for (const edge of edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target) || edge.source === edge.target) continue;
    outgoing.get(edge.source)!.push(edge.target);
    incoming.get(edge.target)!.push(edge.source);
    adjacent.get(edge.source)!.add(edge.target);
    adjacent.get(edge.target)!.add(edge.source);
  }

  const compareNodes = (left: AutoLayoutNode, right: AutoLayoutNode): number => (
    left.position.y - right.position.y
    || left.position.x - right.position.x
    || left.id.localeCompare(right.id)
  );
  const visited = new Set<string>();
  const components: AutoLayoutNode[][] = [];
  for (const root of [...nodes].sort(compareNodes)) {
    if (visited.has(root.id)) continue;
    const component: AutoLayoutNode[] = [];
    const pending = [root.id];
    visited.add(root.id);
    while (pending.length > 0) {
      const nodeId = pending.pop()!;
      component.push(nodeById.get(nodeId)!);
      const neighbours = [...(adjacent.get(nodeId) ?? [])]
        .map((id) => nodeById.get(id)!)
        .sort(compareNodes);
      for (const neighbour of neighbours) {
        if (visited.has(neighbour.id)) continue;
        visited.add(neighbour.id);
        pending.push(neighbour.id);
      }
    }
    component.sort(compareNodes);
    components.push(component);
  }

  const groups = components.map((component) => layoutConnectedComponent(component, outgoing, incoming, compareNodes));
  const groupColumnCount = Math.ceil(Math.sqrt(groups.length));
  const groupRowCount = Math.ceil(groups.length / groupColumnCount);
  const columnWidths = Array.from({ length: groupColumnCount }, () => 0);
  const rowHeights = Array.from({ length: groupRowCount }, () => 0);
  for (const [index, group] of groups.entries()) {
    const column = index % groupColumnCount;
    const row = Math.floor(index / groupColumnCount);
    columnWidths[column] = Math.max(columnWidths[column] ?? 0, group.width);
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, group.height);
  }
  const columnOffsets = cumulativeOffsets(columnWidths, GROUP_COLUMN_GAP);
  const rowOffsets = cumulativeOffsets(rowHeights, GROUP_ROW_GAP);

  const arranged = groups.flatMap((group, index) => {
    const column = index % groupColumnCount;
    const row = Math.floor(index / groupColumnCount);
    return group.positions.map(({ nodeId, position }) => ({
      nodeId,
      position: {
        x: START_X + (columnOffsets[column] ?? 0) + position.x,
        y: START_Y + (rowOffsets[row] ?? 0) + position.y,
      },
    }));
  });
  return arranged.flatMap(({ nodeId, position }) => {
    const members = bundled.offsets.get(nodeId);
    return members === undefined ? [{ nodeId, position }] : members.map((member) => ({
      nodeId: member.id,
      position: { x: position.x + member.x, y: position.y + member.y },
    }));
  });
}

function layoutConnectedComponent(
  nodes: readonly AutoLayoutNode[],
  outgoing: ReadonlyMap<string, readonly string[]>,
  incoming: ReadonlyMap<string, readonly string[]>,
  compareNodes: (left: AutoLayoutNode, right: AutoLayoutNode) => number,
): LayoutGroup {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const componentIds = new Set(nodeById.keys());
  const indegree = new Map(nodes.map((node) => [
    node.id,
    (incoming.get(node.id) ?? []).filter((sourceId) => componentIds.has(sourceId)).length,
  ]));
  const rank = new Map(nodes.map((node) => [node.id, 0]));
  const processed = new Set<string>();
  const queue = nodes.filter((node) => indegree.get(node.id) === 0).sort(compareNodes).map((node) => node.id);
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    processed.add(nodeId);
    for (const targetId of outgoing.get(nodeId) ?? []) {
      if (!componentIds.has(targetId)) continue;
      rank.set(targetId, Math.max(rank.get(targetId) ?? 0, (rank.get(nodeId) ?? 0) + 1));
      const nextDegree = (indegree.get(targetId) ?? 0) - 1;
      indegree.set(targetId, nextDegree);
      if (nextDegree === 0) {
        queue.push(targetId);
        queue.sort((leftId, rightId) => compareNodes(nodeById.get(leftId)!, nodeById.get(rightId)!));
      }
    }
  }

  // Cycles have no topological root. Keep their members in a stable layer
  // after any already-processed predecessor instead of looping forever.
  for (const node of nodes) {
    if (processed.has(node.id)) continue;
    const predecessorRanks = (incoming.get(node.id) ?? [])
      .filter((sourceId) => processed.has(sourceId))
      .map((sourceId) => (rank.get(sourceId) ?? 0) + 1);
    rank.set(node.id, predecessorRanks.length > 0 ? Math.max(...predecessorRanks) : 0);
  }

  const layers = new Map<number, AutoLayoutNode[]>();
  for (const node of nodes) {
    const layerIndex = rank.get(node.id) ?? 0;
    const layer = layers.get(layerIndex) ?? [];
    layer.push(node);
    layers.set(layerIndex, layer);
  }
  for (const layer of layers.values()) layer.sort(compareNodes);

  const orderedLayers = [...layers.keys()].sort((left, right) => left - right).map((index) => layers.get(index)!);
  const layerHeights = orderedLayers.map((layer) => (
    layer.reduce((height, node) => height + nodeSize(node).height, 0) + Math.max(0, layer.length - 1) * ROW_GAP
  ));
  const groupHeight = Math.max(...layerHeights);
  const positions: AutoLayoutPosition[] = [];
  let x = 0;
  for (const [layerIndex, layer] of orderedLayers.entries()) {
    let y = (groupHeight - layerHeights[layerIndex]!) / 2;
    let layerWidth = 0;
    for (const node of layer) {
      const size = nodeSize(node);
      positions.push({ nodeId: node.id, position: { x, y } });
      y += size.height + ROW_GAP;
      layerWidth = Math.max(layerWidth, size.width);
    }
    x += layerWidth + COLUMN_GAP;
  }
  return { positions, width: Math.max(0, x - COLUMN_GAP), height: groupHeight };
}

function nodeSize(node: AutoLayoutNode): { readonly width: number; readonly height: number } {
  return node.layoutSize ?? canvasLayoutNodeSize(node.moduleType);
}

function cumulativeOffsets(sizes: readonly number[], gap: number): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const size of sizes) {
    offsets.push(offset);
    offset += size + gap;
  }
  return offsets;
}
