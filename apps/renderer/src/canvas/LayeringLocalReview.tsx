import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { CanvasModuleNode } from '@agent-canvas/domain';
import { SourceForegroundPreview } from './SourceForegroundPreview';
import { getLayerPixelRepresentation } from '../app/layer-pixel-representation';

export interface LocalLayeringReview {
  snapshotDigest: string;
  reviewedLayerIds: readonly string[];
}

/** The review is an explicit local action on an immutable displayed snapshot. */
export function LayeringLocalReview({ snapshotDigest, config, nodes, assets, onComplete, onClose }: {
  snapshotDigest: string;
  config: Readonly<Record<string, unknown>>;
  nodes: readonly CanvasModuleNode[];
  assets: readonly { assetId: string; displayUrl: string; width?: number | null; height?: number | null; sha256?: string; mediaType?: string }[];
  onComplete: (review: LocalLayeringReview) => Promise<void>;
  onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState(String(nodes[0]?.data.config.layerId ?? ''));
  const [checked, setChecked] = useState<readonly string[]>([]);
  const [dark, setDark] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const source = assets.find(asset => asset.assetId === config.sourceAssetId);
  const selected = nodes.find(node => node.data.config.layerId === selectedId);
  const layer = selected?.data.config;
  const returned = assets.find(asset => asset.assetId === layer?.resultAssetId);
  const representation = getLayerPixelRepresentation(layer ?? {}, source, returned);
  const complete = async () => {
    setSaving(true); setError(null);
    try { await onComplete({ snapshotDigest, reviewedLayerIds: checked }); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '本地检查无法保存，请重新检查当前图层'); }
    finally { setSaving(false); }
  };
  return createPortal(<div className="layer-correction-backdrop nodrag nowheel">
    <section className="layer-correction-dialog" role="dialog" aria-modal="true" aria-label="检查当前分层">
      <header><div><strong>检查当前分层</strong><span>对照原图逐层查看，再保存本地检查结果。</span></div>
        <button type="button" aria-label="关闭图层检查" disabled={saving} onClick={onClose}>关闭</button></header>
      <div className="layer-correction-dialog__body image-layering__local-review">
        <p>检查背景是否有残影或拼缝；检查每层的对象归属、边缘、透明颜色及原图位置。未通过的图层请先精修。</p>
        <div className="image-layering__review-controls"><label>查看图层 <select aria-label="检查图层" value={selectedId}
          onChange={event => setSelectedId(event.target.value)}>{nodes.map(node => <option key={node.id} value={String(node.data.config.layerId)}>
            {String(node.data.config.name ?? node.data.config.layerId)}</option>)}</select></label>
          <button type="button" aria-pressed={dark} onClick={() => setDark(value => !value)}>{dark ? '浅底检查' : '深底检查'}</button></div>
        <div className="image-layering__review-previews">
          <figure><figcaption>原图</figcaption>{source && <img src={source.displayUrl} alt="检查原图" />}</figure>
          <figure style={{ background: dark ? '#202523' : '#fff' }}><figcaption>{String(layer?.name ?? '图层')}</figcaption>
            {returned && source && config.pixelMode === 'source' && layer?.layerKind !== 'background' && layer?.pixelColorSpace !== 'foreground'
              ? <SourceForegroundPreview sourceUrl={source.displayUrl} maskUrl={returned.displayUrl} bounds={layer?.sourceBounds}
                selection={config.layerSelection} maskSpace={layer?.maskSpace === 'source' ? 'source' : 'bounds'}
                independentRgba={representation.independentRgbaCandidate}
                width={source.width ?? Number(config.canvasWidth)} height={source.height ?? Number(config.canvasHeight)} label="待检查图层" />
              : returned && <img src={returned.displayUrl} alt="待检查图层" />}</figure>
        </div>
        <div className="image-layering__review-checklist">{nodes.map(node => {
          const id = String(node.data.config.layerId);
          return <label key={id}><input type="checkbox" checked={checked.includes(id)} disabled={saving}
            onChange={event => setChecked(value => event.target.checked ? [...value, id] : value.filter(item => item !== id))} />
            已检查 {String(node.data.config.name ?? id)} 的内容、边缘和位置</label>;
        })}</div>
        {(error || representation.error) && <p role="alert">{error ?? representation.error}</p>}
        <div className="layer-correction-dialog__footer"><button type="button" disabled={saving || checked.length !== nodes.length || !!representation.error}
          onClick={() => { void complete(); }}>{saving ? '正在保存…' : '完成本地检查'}</button></div>
      </div>
    </section>
  </div>, document.body);
}
