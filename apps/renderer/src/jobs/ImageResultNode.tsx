import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { Handle, Position } from '@xyflow/react';
import { Image } from 'lucide-react';
import type { CanvasNodeData } from '../canvas/node-types';

export const ImageResultNode = memo(function ImageResultNode({ data, selected }: NodeProps) {
  const nodeData = data as CanvasNodeData;
  return (
    <div className={`canvas-node image-result-node${selected ? ' is-selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="image-result-node__heading">
        <Image size={15} />
        <span>{nodeData.title}</span>
      </div>
      <div className="canvas-node__meta">{nodeData.subtitle}</div>
      {nodeData.resultAssetId && <div className="image-result-node__asset">{nodeData.resultAssetId}</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
});
