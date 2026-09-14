import type { CanvasModuleType } from '@agent-canvas/domain';

export interface AutoLayoutNode {
  readonly id: string;
  readonly moduleType: CanvasModuleType;
  readonly position: { readonly x: number; readonly y: number };
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
};

const FALLBACK_NODE_SIZE = { width: 420, height: 320 };

/** Arrange every canvas node in deterministic left-to-right dependency layers. */
export function arrangeCanvasNodePositions(
  nodes: readonly AutoLayoutNode[],
  edges: readonly AutoLayoutEdge[],
): AutoLayoutPosition[] {
  if (nodes.length === 0) return [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const node of nodes) {
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
  }
  for (const edge of edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target) || edge.source === edge.target) continue;
    outgoing.get(edge.source)!.push(edge.target);
    incoming.get(edge.target)!.push(edge.source);
  }

  const indegree = new Map([...incoming].map(([id, sources]) => [id, sources.length]));
  const rank = new Map(nodes.map((node) => [node.id, 0]));
  const processed = new Set<string>();
  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id).sort();
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    processed.add(nodeId);
    for (const targetId of outgoing.get(nodeId) ?? []) {
      rank.set(targetId, Math.max(rank.get(targetId) ?? 0, (rank.get(nodeId) ?? 0) + 1));
      const nextDegree = (indegree.get(targetId) ?? 0) - 1;
      indegree.set(targetId, nextDegree);
      if (nextDegree === 0) {
        queue.push(targetId);
        queue.sort();
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
  for (const layer of layers.values()) {
    layer.sort((left, right) => (
      left.position.y - right.position.y
      || left.position.x - right.position.x
      || left.id.localeCompare(right.id)
    ));
  }

  const positions: AutoLayoutPosition[] = [];
  let x = START_X;
  for (const layerIndex of [...layers.keys()].sort((left, right) => left - right)) {
    const layer = layers.get(layerIndex)!;
    const columnCount = Math.ceil(Math.sqrt(layer.length));
    const cellWidth = Math.max(...layer.map((node) => (NODE_SIZES[node.moduleType] ?? FALLBACK_NODE_SIZE).width));
    const cellHeight = Math.max(...layer.map((node) => (NODE_SIZES[node.moduleType] ?? FALLBACK_NODE_SIZE).height));
    for (const [index, node] of layer.entries()) {
      const column = index % columnCount;
      const row = Math.floor(index / columnCount);
      positions.push({
        nodeId: node.id,
        position: {
          x: x + column * (cellWidth + COLUMN_GAP),
          y: START_Y + row * (cellHeight + ROW_GAP),
        },
      });
    }
    x += columnCount * cellWidth + columnCount * COLUMN_GAP;
  }
  return positions;
}
