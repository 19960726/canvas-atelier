import { useCallback, useEffect, useRef, useState } from 'react';
import { applyNodeChanges } from '@xyflow/react';
import type { Node, NodeChange, XYPosition } from '@xyflow/react';

export interface CanvasDraftOptions<TNode extends Node = Node> {
  nodes: readonly TNode[];
  onCommitPosition: (nodeId: string, position: XYPosition) => Promise<boolean>;
}

export function useCanvasDraft<TNode extends Node = Node>({
  nodes: sourceNodes,
  onCommitPosition,
}: CanvasDraftOptions<TNode>) {
  const [nodes, setNodes] = useState<TNode[]>(() => [...sourceNodes]);
  const sourceNodesRef = useRef(sourceNodes);
  const activeDraggedNodeIdsRef = useRef(new Set<string>());

  useEffect(() => {
    if (sourceNodesRef.current === sourceNodes) return;
    sourceNodesRef.current = sourceNodes;
    const activeDraggedNodeIds = activeDraggedNodeIdsRef.current;
    setNodes((current) => mergeDurableNodes(current, sourceNodes, activeDraggedNodeIds));
  }, [sourceNodes]);

  const onNodesChange = useCallback((changes: NodeChange<TNode>[]) => {
    for (const change of changes) {
      if (change.type === 'position' && change.dragging === true) {
        activeDraggedNodeIdsRef.current.add(change.id);
      }
    }
    setNodes((current) => applyNodeChanges(changes, current) as TNode[]);
  }, []);

  const onNodeDragStop = useCallback(async (_event: unknown, node: TNode) => {
    activeDraggedNodeIdsRef.current.delete(node.id);
    return onCommitPosition(node.id, node.position);
  }, [onCommitPosition]);

  return { nodes, onNodesChange, onNodeDragStop };
}

function mergeDurableNodes<TNode extends Node>(
  current: readonly TNode[],
  source: readonly TNode[],
  activeDraggedNodeIds: ReadonlySet<string>,
): TNode[] {
  const currentById = new Map(current.map((node) => [node.id, node]));
  return source.map((sourceNode) => {
    const draftNode = currentById.get(sourceNode.id);
    if (!draftNode || !activeDraggedNodeIds.has(sourceNode.id)) return sourceNode;
    return {
      ...sourceNode,
      position: draftNode.position,
      ...(draftNode.selected === undefined ? {} : { selected: draftNode.selected }),
      ...(draftNode.dragging === undefined ? {} : { dragging: draftNode.dragging }),
      ...(draftNode.resizing === undefined ? {} : { resizing: draftNode.resizing }),
    };
  });
}
