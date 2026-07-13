import { memo } from 'react';
import type { NodeProps, NodeTypes } from '@xyflow/react';
import { Handle, Position } from '@xyflow/react';

interface CanvasNodeData extends Record<string, unknown> {
  title?: string;
  subtitle?: string;
}

const BaseNode = memo(function BaseNode({ data, selected }: NodeProps) {
  const nodeData = data as CanvasNodeData;
  return (
    <div className={`canvas-node${selected ? ' is-selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="canvas-node__title">{nodeData.title ?? '画布节点'}</div>
      <div className="canvas-node__meta">{nodeData.subtitle ?? '等待内容'}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

export const nodeTypes: NodeTypes = {
  reference: BaseNode,
  prompt: BaseNode,
  placement_preview: BaseNode,
  image_result: BaseNode,
};
