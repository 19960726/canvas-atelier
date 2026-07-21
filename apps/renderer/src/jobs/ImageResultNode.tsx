import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { CanvasNodeCard } from '../canvas/CanvasNodeCard';
import type { CanvasNodeData } from '../canvas/node-types';
import { useAppStore } from '../app/app-store';
import { isRenderableManagedImageUrl } from '../app/managed-image-url';
import { formatMediaDisplayAspectRatio } from '../canvas/media-display';

export const ImageResultNode = memo(function ImageResultNode({ data, selected }: NodeProps) {
  const nodeData = data as CanvasNodeData;
  const projectImages = useAppStore((state) => state.projectImages);
  const asset = projectImages.find((candidate) => candidate.assetId === nodeData.resultAssetId);
  const previewUrl = isRenderableManagedImageUrl(asset?.displayUrl, asset?.assetId) ? asset.displayUrl : null;
  const aspectRatio = formatMediaDisplayAspectRatio(asset?.width, asset?.height);
  return (
    <CanvasNodeCard {...nodeData} selected={selected}>
      {previewUrl && asset ? (
        <>
          <div className="image-result-node__media" style={{ aspectRatio }}>
            <img src={previewUrl} alt={asset.label} draggable={false} />
          </div>
          <div className="image-result-node__meta">
            <strong title={asset.label}>{asset.label}</strong>
            <small>{asset.width && asset.height ? `${asset.width} × ${asset.height}` : '尺寸不可用'}</small>
          </div>
        </>
      ) : (
        <div className="image-result-node__empty">结果预览不可用</div>
      )}
    </CanvasNodeCard>
  );
});
