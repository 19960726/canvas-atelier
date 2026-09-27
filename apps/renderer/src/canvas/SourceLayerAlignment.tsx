import { useState } from 'react';
import { boxSchema, type LayeringBox } from '../app/layering-selection';
import { LayeringSelectionEditor } from './LayeringSelectionEditor';

export function SourceLayerAlignment({ sourceUrl, width, height, layers, onApply }: {
  sourceUrl: string; width: number; height: number;
  layers: { layerId: string; name: string; bounds: unknown }[];
  onApply: (bounds: Record<string, LayeringBox>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [bounds, setBounds] = useState<Record<string, LayeringBox>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = layers[index];
  const start = () => {
    setBounds(Object.fromEntries(layers.flatMap(layer => { const result = boxSchema.safeParse(layer.bounds); return result.success ? [[layer.layerId, result.data]] : []; })));
    setIndex(0); setError(null); setOpen(true);
  };
  return <div className="image-layering__alignment">
    <button type="button" onClick={start}>按原图位置校正图层</button>
    {open && current && <div role="group" aria-label="原图图层位置校正">
      <p>逐层框选原图中物体或阴影的边界。应用后使用原图像素；已有返图保留，不会提交生成任务。</p>
      <select aria-label="校正图层" value={index} disabled={busy} onChange={e => setIndex(Number(e.target.value))}>
        {layers.map((layer, i) => <option value={i} key={layer.layerId}>{layer.name}{bounds[layer.layerId] ? ' · 已标注' : ' · 待标注'}</option>)}
      </select>
      <LayeringSelectionEditor url={sourceUrl} label={`标注 ${current.name}`} width={width} height={height} selecting disabled={busy}
        box={bounds[current.layerId] ?? null} onChange={box => setBounds(old => { const next = { ...old }; if (box) next[current.layerId] = box; else delete next[current.layerId]; return next; })} />
      <button type="button" disabled={busy} onClick={() => setOpen(false)}>取消</button>
      <button type="button" disabled={busy || layers.some(layer => !bounds[layer.layerId])} onClick={() => {
        setBusy(true); setError(null);
        void onApply(bounds).then(() => setOpen(false)).catch(caught => setError(caught instanceof Error ? caught.message : '位置保存失败')).finally(() => setBusy(false));
      }}>{busy ? '正在应用…' : '应用原图像素'}</button>
      {error && <p role="alert">{error}</p>}
    </div>}
  </div>;
}
