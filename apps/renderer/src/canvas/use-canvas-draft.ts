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
  const latestSourceNodesRef = useRef(sourceNodes);
  latestSourceNodesRef.current = sourceNodes;
  const sourceNodesRef = useRef(sourceNodes);
  const activeDraggedNodeIdsRef = useRef(new Set<string>());
  const pendingCommitRef = useRef(new Map<string, { position: XYPosition; token: number }>());
  const commitTokenRef = useRef(0);

  useEffect(() => {
    if (sourceNodesRef.current === sourceNodes) return;
    sourceNodesRef.current = sourceNodes;
    const activeDraggedNodeIds = activeDraggedNodeIdsRef.current;
    const pendingCommitNodeIds = new Set(pendingCommitRef.current.keys());
    setNodes((current) => mergeDurableNodes(current, sourceNodes, activeDraggedNodeIds, pendingCommitNodeIds));
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
    const token = commitTokenRef.current + 1;
    commitTokenRef.current = token;
    pendingCommitRef.current.set(node.id, { position: node.position, token });
    try {
      return await onCommitPosition(node.id, node.position);
    } finally {
      const pendingCommit = pendingCommitRef.current.get(node.id);
      if (pendingCommit?.token === token) {
        pendingCommitRef.current.delete(node.id);
        const durableNode = latestSourceNodesRef.current.find((sourceNode) => sourceNode.id === node.id);
        setNodes((current) => durableNode === undefined
          ? current.filter((currentNode) => currentNode.id !== node.id)
          : current.map((currentNode) => currentNode.id === node.id ? durableNode : currentNode));
      }
    }
  }, [onCommitPosition]);

  return { nodes, onNodesChange, onNodeDragStop };
}

function mergeDurableNodes<TNode extends Node>(
  current: readonly TNode[],
  source: readonly TNode[],
  activeDraggedNodeIds: ReadonlySet<string>,
  pendingCommitNodeIds: ReadonlySet<string>,
): TNode[] {
  const currentById = new Map(current.map((node) => [node.id, node]));
  return source.map((sourceNode) => {
    const draftNode = currentById.get(sourceNode.id);
    if (!draftNode || (!activeDraggedNodeIds.has(sourceNode.id) && !pendingCommitNodeIds.has(sourceNode.id))) {
      return sourceNode;
    }
    return {
      ...sourceNode,
      position: draftNode.position,
      ...(draftNode.selected === undefined ? {} : { selected: draftNode.selected }),
      ...(draftNode.dragging === undefined ? {} : { dragging: draftNode.dragging }),
      ...(draftNode.resizing === undefined ? {} : { resizing: draftNode.resizing }),
    };
  });
}
