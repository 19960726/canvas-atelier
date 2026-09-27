import { useState } from 'react';
import type { MattingRegion } from '@agent-canvas/desktop-core/preload-api';
import { LayeringSelectionEditor } from './LayeringSelectionEditor';
import type { LayeringBox } from '../app/layering-selection';

export function SourceLayerRefinement({sourceUrl,width,height,layers,onApply}:{
  sourceUrl:string;width:number;height:number;
  layers:{nodeId:string;name:string;regions:MattingRegion[];resultAssetId?:string}[];
  onApply:(nodeId:string,regions:MattingRegion[])=>Promise<void>;
}) {
  const [open,setOpen]=useState(false),[selected,setSelected]=useState(''),[mode,setMode]=useState<MattingRegion['mode']>('glass');
  const [box,setBox]=useState<LayeringBox|null>(null),[drafts,setDrafts]=useState<Record<string,{base:string;regions:MattingRegion[]}>>({});
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const layer=layers.find(item=>item.nodeId===selected);
  const base=JSON.stringify([sourceUrl,layer?.resultAssetId,layer?.regions]);
  const regions=drafts[selected]?.base===base?drafts[selected]!.regions:layer?.regions??[];
  const updateRegions=(next:MattingRegion[])=>setDrafts(old=>({...old,[selected]:{base,regions:next}}));
  const labels={keep:'保留实体',clear:'清除背景',glass:'玻璃半透明'};
  return <div className="image-layering__alignment">
    <button type="button" disabled={busy||!layers.length} onClick={()=>{setSelected(layers[0]!.nodeId);setBox(null);setError(null);setOpen(true);}}>本地抠图与边缘精修</button>
    {open&&layer&&<div role="group" aria-label="原图蒙版精修">
      <p>从原图提取，保持原大小和位置，不产生生成费用。可框选残留背景、需要保留的实体或玻璃；后添加的区域优先。</p>
      <select aria-label="精修图层" disabled={busy} value={selected} onChange={event=>{setSelected(event.target.value);setBox(null);setError(null);}}>
        {layers.map(item=><option key={item.nodeId} value={item.nodeId}>{item.name}</option>)}
      </select>
      <select aria-label="精修方式" disabled={busy} value={mode} onChange={event=>setMode(event.target.value as MattingRegion['mode'])}>
        {Object.entries(labels).map(([value,label])=><option key={value} value={value}>{label}</option>)}
      </select>
      <LayeringSelectionEditor key={selected} url={sourceUrl} label={`精修 ${layer.name}`} width={width} height={height} selecting disabled={busy} box={box} onChange={setBox}/>
      <button type="button" disabled={busy||!box||regions.length>=64} onClick={()=>{if(box)updateRegions([...regions,{mode,box}]);setBox(null);}}>添加精修区域</button>
      <ol>{regions.map((region,index)=><li key={index}>{labels[region.mode]} · {index+1} <button type="button" disabled={busy} aria-label={`移除精修区域 ${index+1}`} onClick={()=>updateRegions(regions.filter((_,i)=>i!==index))}>移除</button></li>)}</ol>
      <p>玻璃中需要保留的篮体、刻度等可再框选为“保留实体”。应用后请在黑底、白底检查边缘与透光。</p>
      <button type="button" disabled={busy} onClick={()=>setOpen(false)}>关闭精修</button>
      <button type="button" disabled={busy} onClick={()=>{setBusy(true);setError(null);void onApply(selected,structuredClone(regions)).then(()=>{setDrafts(old=>{const next={...old};delete next[selected];return next;});setBox(null);}).catch(caught=>setError(caught instanceof Error?caught.message:'本地精修失败')).finally(()=>setBusy(false));}}>{busy?'正在本地精修…':'应用本地精修'}</button>
      {error&&<p role="alert">{error}</p>}
    </div>}
  </div>;
}
