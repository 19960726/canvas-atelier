import type { Connection } from '@xyflow/react';
import {
  canConnectCanvasPorts,
  getCanvasModuleDefinition,
  MAX_GENERATION_REFERENCES,
  type CanvasEdge,
  type CanvasModuleNode,
} from '@agent-canvas/domain';

export type PlannedBatchConnection = Connection & { readonly order: number };

export type BatchConnectionSkip = {
  readonly nodeId: string;
  readonly reason: string;
};

export function sortSelectedMediaNodes(nodes: readonly CanvasModuleNode[]): CanvasModuleNode[] {
  return [...nodes].sort((left, right) => (
    left.position.y - right.position.y
    || left.position.x - right.position.x
    || left.id.localeCompare(right.id)
  ));
}

export function planBatchConnections({
  selectedNodes,
  targetNode,
  existingEdges,
}: {
  readonly selectedNodes: readonly CanvasModuleNode[];
  readonly targetNode: CanvasModuleNode;
  readonly existingEdges: readonly CanvasEdge[];
}): {
  readonly connections: PlannedBatchConnection[];
  readonly skipped: BatchConnectionSkip[];
} {
  const targetDefinition = getCanvasModuleDefinition(targetNode.data.moduleType);
  const targetInputs = targetDefinition.ports.filter((port) => port.direction === 'input' && port.cardinality === 'many');
  const orderedNodes = sortSelectedMediaNodes(selectedNodes);
  const connections: PlannedBatchConnection[] = [];
  const skipped: BatchConnectionSkip[] = [];
  const existingInputCount = targetInputs.reduce((count, port) => count + existingEdges.filter((edge) => (
    edge.target === targetNode.id && edge.targetPortId === port.id
  )).length, 0);

  for (const sourceNode of orderedNodes) {
    if (existingInputCount + connections.length >= MAX_GENERATION_REFERENCES) {
      skipped.push({ nodeId: sourceNode.id, reason: `已达到最多 ${MAX_GENERATION_REFERENCES} 个素材的限制` });
      continue;
    }
    const sourcePorts = getCanvasModuleDefinition(sourceNode.data.moduleType).ports.filter((port) => port.direction === 'output');
    const match = targetInputs.flatMap((targetPort) => sourcePorts.map((sourcePort) => ({ sourcePort, targetPort })))
      .find(({ sourcePort, targetPort }) => canConnectCanvasPorts(sourceNode, sourcePort.id, targetNode, targetPort.id).ok);
    if (match === undefined) {
      skipped.push({ nodeId: sourceNode.id, reason: `没有可连接到 ${targetNode.data.moduleType} 的素材输入端口` });
      continue;
    }
    connections.push({
      source: sourceNode.id,
      sourceHandle: match.sourcePort.id,
      target: targetNode.id,
      targetHandle: match.targetPort.id,
      order: existingInputCount + connections.length,
    });
  }
  return { connections, skipped };
}
