import { useEffect, useRef, useState } from 'react';
import type { CanvasNode, CanvasModuleNode } from '@agent-canvas/domain';
import type { ProjectImageAssetSummary } from '@agent-canvas/desktop-core';
import type { LayerQualityVerdict } from '../app/layering-quality';
import { needsLayerPixelValidation, validateManagedImageLayer } from './ImageLayerNodeWorkbench';
import { readLayeringSelection } from '../app/layering-selection';

function requiredAssetIds(node: CanvasModuleNode): string[] {
  const config = node.data.config;
  const ids = [String(config.resultAssetId)];
  try {
    if (config.layerKind === 'background' && readLayeringSelection(config.layerSelection).mode !== 'whole'
      && typeof config.sourceAssetId === 'string') ids.push(config.sourceAssetId);
  } catch { /* Invalid saved selections are reported by the pixel validator. */ }
  return ids;
}

interface QueueProps {
  projectId: string;
  nodes: readonly CanvasNode[];
  assets: readonly Pick<ProjectImageAssetSummary, 'assetId' | 'displayUrl' | 'mediaType' | 'width' | 'height'>[];
  onQualityResult: (nodeId: string, assetId: string, verdict: LayerQualityVerdict) => Promise<void>;
  onRefreshAssets: () => Promise<void>;
}
export function ImageLayerValidationQueue(props: QueueProps) {
  const latest = useRef(props); latest.current = props;
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [assetError, setAssetError] = useState<string | null>(null);
  const pending = props.nodes.filter((node): node is CanvasModuleNode => node.type === 'module'
    && node.data.moduleType === 'image_layer' && needsLayerPixelValidation(node.data.config));
  const candidate = pending.find(node => requiredAssetIds(node).every(id => props.assets.some(asset => asset.assetId === id)));
  const asset = props.assets.find(item => item.assetId === candidate?.data.config.resultAssetId);
  const key = candidate && asset ? JSON.stringify([props.projectId, candidate.id, candidate.data.config, asset.displayUrl]) : '';
  const missingIds = [...new Set(pending.flatMap(requiredAssetIds))].filter(id => !props.assets.some(item => item.assetId === id));
  const missingKey = missingIds.sort().join(',');
  useEffect(() => {
    setAssetError(null);
    if (!missingKey) return;
    let cancelled = false;
    void Promise.resolve().then(() => latest.current.onRefreshAssets()).then(() => {
      if (!cancelled && missingIds.some(id => !latest.current.assets.some(item => item.assetId === id))) setAssetError('部分已返回图片或分层原图未能读取。');
    }).catch(() => { if (!cancelled) setAssetError('部分已返回图片或分层原图未能读取。'); });
    return () => { cancelled = true; };
  }, [props.projectId, missingKey, retry]);
  useEffect(() => {
    setError(null);
    if (!candidate || !asset) return;
    let cancelled = false;
    void validateManagedImageLayer(asset, candidate.data.config, props.assets.some(item => item.assetId === candidate.data.config.sourceAssetId))
      .then(async verdict => {
        if (!cancelled) await latest.current.onQualityResult(candidate.id, asset.assetId, verdict);
      }).catch(() => { if (!cancelled) setError('图层检查结果未能保存。'); });
    return () => { cancelled = true; };
    // Candidate identity includes every saved setting; catalog object refreshes must not restart decoding.
  }, [key, retry]);
  return error || assetError ? <div className="image-layering__validation-error" role="alert">{error ?? assetError}
    <button type="button" onClick={() => { setError(null); setAssetError(null); setRetry(value => value + 1); }}>重新读取并检查</button>
  </div> : null;
}
