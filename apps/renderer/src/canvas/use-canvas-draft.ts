import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  const sourceSignature = useMemo(() => JSON.stringify(sourceNodes), [sourceNodes]);
  const lastSourceSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    if (lastSourceSignatureRef.current === sourceSignature) return;
    lastSourceSignatureRef.current = sourceSignature;
    setNodes([...sourceNodes]);
  }, [sourceNodes, sourceSignature]);

  const onNodesChange = useCallback((changes: NodeChange<TNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current) as TNode[]);
  }, []);

  const onNodeDragStop = useCallback(async (_event: unknown, node: TNode) => (
    onCommitPosition(node.id, node.position)
  ), [onCommitPosition]);

  return { nodes, onNodesChange, onNodeDragStop };
}
