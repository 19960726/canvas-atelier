import { useCallback, useEffect, useRef, useState } from 'react';
import { applyNodeChanges } from '@xyflow/react';
import type { Node, NodeChange, XYPosition } from '@xyflow/react';

export interface CanvasDraftOptions<TNode extends Node = Node> {
  nodes: readonly TNode[];
  onCommitPositions: (
    updates: readonly { readonly nodeId: string; readonly position: XYPosition }[],
  ) => Promise<boolean>;
}

export function useCanvasDraft<TNode extends Node = Node>({
  nodes: sourceNodes,
  onCommitPositions,
}: CanvasDraftOptions<TNode>) {
  const [nodes, setNodes] = useState<TNode[]>(() => [...sourceNodes]);
  const draftNodesRef = useRef<readonly TNode[]>(nodes);
  draftNodesRef.current = nodes;
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
    setNodes((current) => {
      const next = mergeDurableNodes(current, sourceNodes, activeDraggedNodeIds, pendingCommitNodeIds);
      if (sameDraftNodeList(current, next)) return current;
      draftNodesRef.current = next;
      return next;
    });
  }, [sourceNodes]);

  const onNodesChange = useCallback((changes: NodeChange<TNode>[]) => {
    // Durable deletion is performed by CanvasWorkspace. React Flow's remove
    // change would race that transaction and reintroduce controlled-state loops.
    const interactionChanges = changes.filter((change) => change.type !== 'remove');
    if (interactionChanges.length === 0) return;
    for (const change of interactionChanges) {
      if (change.type === 'position' && change.dragging === true) {
        activeDraggedNodeIdsRef.current.add(change.id);
      }
    }
    setNodes((current) => {
      const next = applyNodeChanges(interactionChanges, current) as TNode[];
      if (sameDraftNodeList(current, next)) return current;
      draftNodesRef.current = next;
      return next;
    });
  }, []);

  const onNodeDragStop = useCallback(async (_event: unknown, node: TNode) => {
    const activeDraggedNodeIds = activeDraggedNodeIdsRef.current;
    const movedNodes = draftNodesRef.current.filter((candidate) => (
      activeDraggedNodeIds.has(candidate.id)
      && candidate.draggable !== false
      && (candidate.id === node.id || candidate.selected === true)
    ));
    if (!movedNodes.some((candidate) => candidate.id === node.id) && node.draggable !== false) {
      movedNodes.push(node);
    }
    const updates = movedNodes.map((candidate) => ({ nodeId: candidate.id, position: candidate.position }));
    for (const candidate of movedNodes) activeDraggedNodeIds.delete(candidate.id);
    if (updates.length === 0) return false;

    const token = commitTokenRef.current + 1;
    commitTokenRef.current = token;
    for (const update of updates) pendingCommitRef.current.set(update.nodeId, { position: update.position, token });
    try {
      return await onCommitPositions(updates);
    } finally {
      const reconciledNodeIds = new Set<string>();
      for (const update of updates) {
        const pendingCommit = pendingCommitRef.current.get(update.nodeId);
        if (pendingCommit?.token !== token) continue;
        pendingCommitRef.current.delete(update.nodeId);
        reconciledNodeIds.add(update.nodeId);
      }
      if (reconciledNodeIds.size > 0) {
        const durableNodesById = new Map(latestSourceNodesRef.current.map((sourceNode) => [sourceNode.id, sourceNode]));
        setNodes((current) => {
          const next = current.flatMap((currentNode) => {
            if (!reconciledNodeIds.has(currentNode.id)) return [currentNode];
            const durableNode = durableNodesById.get(currentNode.id);
            return durableNode === undefined ? [] : [preserveReactFlowState(durableNode, currentNode)];
          });
          draftNodesRef.current = next;
          return next;
        });
      }
    }
  }, [onCommitPositions]);

  return { nodes, onNodesChange, onNodeDragStop };
}

function preserveReactFlowState<TNode extends Node>(durableNode: TNode, currentNode: TNode): TNode {
  return {
    ...durableNode,
    ...(durableNode.width === undefined && currentNode.width !== undefined ? { width: currentNode.width } : {}),
    ...(durableNode.height === undefined && currentNode.height !== undefined ? { height: currentNode.height } : {}),
    ...(durableNode.measured === undefined && currentNode.measured !== undefined ? { measured: currentNode.measured } : {}),
    ...(currentNode.selected === undefined ? {} : { selected: currentNode.selected }),
    ...(currentNode.dragging === undefined ? {} : { dragging: currentNode.dragging }),
    ...(currentNode.resizing === undefined ? {} : { resizing: currentNode.resizing }),
  } as TNode;
}

function sameDraftNodeList<TNode extends Node>(left: readonly TNode[], right: readonly TNode[]): boolean {
  return left.length === right.length && left.every((node, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && node.id === candidate.id
      && node.position.x === candidate.position.x
      && node.position.y === candidate.position.y
      && node.selected === candidate.selected
      && node.dragging === candidate.dragging
      && node.resizing === candidate.resizing
      && node.width === candidate.width
      && node.height === candidate.height
      && sameMeasuredNodeSize(node.measured, candidate.measured)
      && node.data === candidate.data;
  });
}

function sameMeasuredNodeSize(
  left: Node['measured'] | undefined,
  right: Node['measured'] | undefined,
): boolean {
  return left?.width === right?.width && left?.height === right?.height;
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
    if (!draftNode) return sourceNode;
    const keepsPosition = activeDraggedNodeIds.has(sourceNode.id) || pendingCommitNodeIds.has(sourceNode.id);
    const keepsMeasurement = (sourceNode.width === undefined && draftNode.width !== undefined)
      || (sourceNode.height === undefined && draftNode.height !== undefined)
      || (sourceNode.measured === undefined && draftNode.measured !== undefined);
    const keepsInteraction = draftNode.selected !== undefined
      || draftNode.dragging !== undefined
      || draftNode.resizing !== undefined;
    if (!keepsPosition && !keepsMeasurement && !keepsInteraction) return sourceNode;
    return {
      ...sourceNode,
      ...(keepsPosition ? { position: draftNode.position } : {}),
      // React Flow owns these transient measurements. Durable project updates
      // (including text edits) must not erase them, otherwise every data update
      // schedules another measurement/update cycle and can hit React #185.
      ...(sourceNode.width === undefined && draftNode.width !== undefined ? { width: draftNode.width } : {}),
      ...(sourceNode.height === undefined && draftNode.height !== undefined ? { height: draftNode.height } : {}),
      ...(sourceNode.measured === undefined && draftNode.measured !== undefined ? { measured: draftNode.measured } : {}),
      ...(draftNode.selected === undefined ? {} : { selected: draftNode.selected }),
      ...(draftNode.dragging === undefined ? {} : { dragging: draftNode.dragging }),
      ...(draftNode.resizing === undefined ? {} : { resizing: draftNode.resizing }),
    };
  });
}
