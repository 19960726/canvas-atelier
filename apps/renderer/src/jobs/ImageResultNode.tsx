import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { CanvasNodeCard } from '../canvas/CanvasNodeCard';
import type { CanvasNodeData } from '../canvas/node-types';

export const ImageResultNode = memo(function ImageResultNode({ data, selected }: NodeProps) {
  const nodeData = data as CanvasNodeData;
  return (
    <CanvasNodeCard {...nodeData} selected={selected}>
      <div className="image-result-node__preview">
        <span className="image-result-node__asset-label">Durable asset</span>
        {nodeData.resultAssetId && <code className="image-result-node__asset">{nodeData.resultAssetId}</code>}
      </div>
    </CanvasNodeCard>
  );
});
