import { useState } from 'react';
import type { MattingRegion } from '@agent-canvas/desktop-core/preload-api';
import { Droplets, LoaderCircle, MinusSquare, Plus, PlusSquare, Scan, Trash2, WandSparkles } from 'lucide-react';
import { LayeringSelectionEditor } from './LayeringSelectionEditor';
import type { LayeringBox } from '../app/layering-selection';
import { LayerCorrectionDialog } from './LayerCorrectionDialog';

const tools = [
  { mode: 'keep', label: '保留实体', hint: '标记需要保留的主体', icon: PlusSquare },
  { mode: 'clear', label: '清除背景', hint: '排除误选的物体与背景', icon: MinusSquare },
  { mode: 'glass', label: '玻璃半透明', hint: '调整玻璃等透光区域', icon: Droplets },
] as const;
const labels = { keep: '保留实体', clear: '清除背景', glass: '玻璃半透明' };

export function SourceLayerRefinement({ sourceUrl, width, height, layers, suggestedLayerName, onApply }: {
  sourceUrl: string; width: number; height: number;
  layers: { nodeId: string; name: string; regions: MattingRegion[]; resultAssetId?: string; clearOnly?: boolean; fixedRegionCount?: number }[];
  suggestedLayerName?: string;
  onApply: (nodeId: string, regions: MattingRegion[]) => Promise<void>;
}) {
  const [open, setOpen] = useState(false), [selected, setSelected] = useState(''), [mode, setMode] = useState<MattingRegion['mode']>('keep');
  const [box, setBox] = useState<LayeringBox | null>(null), [drafts, setDrafts] = useState<Record<string, { base: string; regions: MattingRegion[] }>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const layer = layers.find(item => item.nodeId === selected);
  const clearOnly = layer?.clearOnly === true;
  const activeMode = clearOnly ? 'clear' : mode;
  const base = JSON.stringify([sourceUrl, layer?.resultAssetId, layer?.regions]);
  const regions = drafts[selected]?.base === base ? drafts[selected]!.regions : layer?.regions ?? [];
  const updateRegions = (next: MattingRegion[]) => setDrafts(old => ({ ...old, [selected]: { base, regions: next } }));
  const close = () => { setDrafts({}); setBox(null); setError(null); setOpen(false); };
  const apply = () => {
    if (busy) return;
    setBusy(true); setError(null);
    void onApply(selected, structuredClone(regions)).then(() => {
      setDrafts(old => { const next = { ...old }; delete next[selected]; return next; }); setBox(null);
    }).catch(caught => setError(caught instanceof Error ? caught.message : '本地精修失败')).finally(() => setBusy(false));
  };
  return <div className="image-layering__alignment">
    <button className="image-layering__repair-tool" type="button" aria-label="本地抠图与边缘精修" title="清除残留背景、保留主体或调整玻璃透明区域"
      disabled={busy || !layers.length} onClick={() => {
        const next = layers.find(item => item.name === suggestedLayerName) ?? layers[0]!;
        setSelected(next.nodeId); setMode(next.clearOnly ? 'clear' : 'keep'); setBox(null); setError(null); setOpen(true);
      }}><WandSparkles size={15} />边缘精修</button>
    {open && layer && <LayerCorrectionDialog title="边缘精修" busy={busy} onClose={close} className="layer-correction-dialog--refinement">
      <div className="source-refinement" role="group" aria-label="原图蒙版精修">
        <div className="source-refinement__workspace">
          <div className="source-refinement__preview" data-mode={activeMode}>
            <div className="source-refinement__preview-heading"><span><Scan size={14} />原图标记</span><small>{width} × {height}</small></div>
            <LayeringSelectionEditor key={selected} url={sourceUrl} label={`精修 ${layer.name}`} width={width} height={height} selecting disabled={busy}
              box={box} onChange={setBox} annotations={regions.map((region, index) => ({ ...region, kind: region.mode, label: `${index + 1} · ${labels[region.mode]}` }))} />
            <p className="source-refinement__preview-tip">在原图上拖动小框，标记需要保留或排除的区域。</p>
          </div>
          <aside className="source-refinement__sidebar" aria-label="精修工具与区域">
            <label className="source-refinement__layer"><span>当前图层</span>
              <select aria-label="精修图层" disabled={busy} value={selected} onChange={event => {
                setSelected(event.target.value); if (layers.find(item => item.nodeId === event.target.value)?.clearOnly) setMode('clear');
                setBox(null); setError(null);
              }}>
                {layers.map(item => <option key={item.nodeId} value={item.nodeId}>{item.name}</option>)}
              </select>
            </label>
            <div className="source-refinement__tools" role="group" aria-label="精修方式">
              <span className="source-refinement__section-title">标记工具</span>
              {tools.map(tool => <button key={tool.mode} type="button" data-mode={tool.mode} aria-label={tool.label} aria-pressed={activeMode === tool.mode}
                disabled={busy || (clearOnly && tool.mode !== 'clear')}
                title={clearOnly && tool.mode !== 'clear' ? '独立图层保留已有颜色与透明度，可用清除背景移除残留' : tool.hint}
                onClick={() => setMode(tool.mode)}><tool.icon size={18} /><span><strong>{tool.label}</strong><small>{tool.hint}</small></span></button>)}
            </div>
            <button className="source-refinement__add" type="button" disabled={busy || !box || regions.length >= 64}
              onClick={() => { if (box) updateRegions([...regions, { mode: activeMode, box }]); setBox(null); }}><Plus size={15} />添加精修区域</button>
            <section className="source-refinement__regions" aria-label="区域记录">
              <div className="source-refinement__regions-heading"><strong>已标记区域</strong><span>{regions.length} / 64</span></div>
              {!regions.length && <p className="source-refinement__empty">选择工具，在原图上框选后添加。</p>}
              <ol aria-label="已添加的精修区域">{regions.map((region, index) => <li key={index} data-mode={region.mode}>
                <span className="source-refinement__region-number">{index + 1}</span><span>{labels[region.mode]}</span>
                <button type="button" disabled={busy || (clearOnly && index < (layer.fixedRegionCount ?? 0))} aria-label={`移除精修区域 ${index + 1}`}
                  title={clearOnly && index < (layer.fixedRegionCount ?? 0) ? '保留原有抠图标记，可移除新增清除标记' : '移除区域'}
                  onClick={() => updateRegions(regions.filter((_, i) => i !== index))}><Trash2 size={14} /></button>
              </li>)}</ol>
            </section>
            <details className="source-refinement__help"><summary>使用提示</summary>
              <p>{clearOnly ? '只清除标记范围，保留已有图层的其他区域。删除新增清除标记并应用可恢复对应区域；原有抠图标记保留。'
                : '小框用于提示本地抠图，后添加的区域优先。玻璃内的实体、刻度可用“保留实体”标记。'}应用后请在黑底、白底检查边缘与透光。</p>
            </details>
          </aside>
        </div>
        <footer className="source-refinement__footer" role="group" aria-label="精修操作">
          <div className="source-refinement__feedback">{error ? <p role="alert">{error}</p>
            : <span aria-live="polite">{busy ? '正在处理当前图层…' : clearOnly ? '仅清除标记区域 · 保留已有图层' : '本地处理 · 保持原尺寸与位置'}</span>}</div>
          <button type="button" aria-label="关闭精修" disabled={busy} onClick={close}>取消</button>
          <button className="source-refinement__apply" type="button" aria-label="应用本地精修" disabled={busy} onClick={apply}>
            {busy ? <LoaderCircle className="is-spinning" size={15} /> : <WandSparkles size={15} />}{busy ? '正在精修…' : '应用精修'}
          </button>
        </footer>
      </div>
    </LayerCorrectionDialog>}
  </div>;
}
