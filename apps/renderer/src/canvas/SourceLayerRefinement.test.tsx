import { cleanup,fireEvent,render,screen,waitFor,within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach,expect,it,vi } from 'vitest';
import { SourceLayerRefinement } from './SourceLayerRefinement';
vi.mock('./LayeringSelectionEditor',()=>({LayeringSelectionEditor:({onChange}:any)=><button onClick={()=>onChange({x:.2,y:.2,width:.1,height:.1})}>draw box</button>}));
afterEach(cleanup);
it('offers only reversible clear corrections on an independent returned RGBA layer',async()=>{
  const keep={mode:'keep' as const,box:{x:.1,y:.1,width:.05,height:.05}};
  const clear={mode:'clear' as const,box:{x:.2,y:.2,width:.05,height:.05}};
  const apply=vi.fn(async()=>{});
  render(<SourceLayerRefinement sourceUrl="source" width={100} height={100}
    layers={[{nodeId:'hands',name:'手部',regions:[keep,clear],clearOnly:true,fixedRegionCount:1}]} onApply={apply}/>);
  fireEvent.click(screen.getByRole('button',{name:'本地抠图与边缘精修'}));
  const tools=screen.getByRole('group',{name:'精修方式'});
  expect(within(tools).getByRole('button',{name:'清除背景'})).toHaveAttribute('aria-pressed','true');
  expect(within(tools).getByRole('button',{name:'保留实体'})).toBeDisabled();
  expect(within(tools).getByRole('button',{name:'玻璃半透明'})).toBeDisabled();
  expect(screen.getByRole('button',{name:'移除精修区域 1'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'移除精修区域 2'}));
  fireEvent.click(screen.getByRole('button',{name:'draw box'}));
  fireEvent.click(screen.getByRole('button',{name:'添加精修区域'}));
  fireEvent.click(screen.getByRole('button',{name:'应用本地精修'}));
  await waitFor(()=>expect(apply).toHaveBeenCalledWith('hands',[keep,{mode:'clear',box:{x:.2,y:.2,width:.1,height:.1}}]));
});
it('updates correction tools when switching between initial matting and independent layers',()=>{
  render(<SourceLayerRefinement sourceUrl="source" width={100} height={100}
    layers={[{nodeId:'initial',name:'初始',regions:[]},{nodeId:'independent',name:'独立',regions:[],clearOnly:true}]} onApply={async()=>{}}/>);
  fireEvent.click(screen.getByRole('button',{name:'本地抠图与边缘精修'}));
  const tools=screen.getByRole('group',{name:'精修方式'});
  fireEvent.click(within(tools).getByRole('button',{name:'玻璃半透明'}));
  fireEvent.change(screen.getByRole('combobox',{name:'精修图层'}),{target:{value:'independent'}});
  expect(within(tools).getByRole('button',{name:'清除背景'})).toHaveAttribute('aria-pressed','true');
  expect(within(tools).getByRole('button',{name:'玻璃半透明'})).toBeDisabled();
  fireEvent.change(screen.getByRole('combobox',{name:'精修图层'}),{target:{value:'initial'}});
  expect(within(tools).getByRole('button',{name:'保留实体'})).toBeEnabled();
  expect(within(tools).getByRole('button',{name:'玻璃半透明'})).toBeEnabled();
});
it('uses clear if the returned layer changes to independent RGBA while the dialog is open',async()=>{
  const apply=vi.fn(async()=>{}), props={sourceUrl:'source',width:100,height:100,onApply:apply};
  const view=render(<SourceLayerRefinement {...props} layers={[{nodeId:'hands',name:'手部',regions:[],resultAssetId:'old'}]}/>);
  fireEvent.click(screen.getByRole('button',{name:'本地抠图与边缘精修'}));
  fireEvent.click(within(screen.getByRole('group',{name:'精修方式'})).getByRole('button',{name:'玻璃半透明'}));
  view.rerender(<SourceLayerRefinement {...props} layers={[{nodeId:'hands',name:'手部',regions:[],resultAssetId:'new',clearOnly:true}]}/>);
  fireEvent.click(screen.getByRole('button',{name:'draw box'}));
  fireEvent.click(screen.getByRole('button',{name:'添加精修区域'}));
  fireEvent.click(screen.getByRole('button',{name:'应用本地精修'}));
  await waitFor(()=>expect(apply).toHaveBeenCalledWith('hands',[{mode:'clear',box:{x:.2,y:.2,width:.1,height:.1}}]));
});
it('discards unapplied region edits when cancelling and restores the saved layer on reopening',()=>{
  const saved={mode:'clear' as const,box:{x:.1,y:.1,width:.05,height:.05}}, apply=vi.fn(async()=>{});
  render(<SourceLayerRefinement sourceUrl="source" width={100} height={200}
    layers={[{nodeId:'hands',name:'手部',regions:[saved]}]} onApply={apply}/>);
  fireEvent.click(screen.getByRole('button',{name:'本地抠图与边缘精修'}));
  fireEvent.click(screen.getByRole('button',{name:'移除精修区域 1'}));
  fireEvent.click(screen.getByRole('button',{name:'关闭精修'}));
  fireEvent.click(screen.getByRole('button',{name:'本地抠图与边缘精修'}));
  expect(screen.getByRole('list',{name:'已添加的精修区域'}).children).toHaveLength(1);
  expect(apply).not.toHaveBeenCalled();
});
it('offers explicit correction tools, keeps saved regions when switching tools, and applies the chosen intent',async()=>{
  const apply=vi.fn(async()=>{});
  render(<SourceLayerRefinement sourceUrl="source" width={100} height={200}
    layers={[{nodeId:'hands',name:'手部',regions:[{mode:'clear',box:{x:.1,y:.1,width:.05,height:.05}}]}]} onApply={apply}/>);
  fireEvent.click(screen.getByRole('button',{name:'本地抠图与边缘精修'}));
  const tools=screen.getByRole('group',{name:'精修方式'});
  expect(within(tools).getByRole('button',{name:'保留实体'})).toHaveAttribute('aria-pressed','true');
  fireEvent.click(within(tools).getByRole('button',{name:'玻璃半透明'}));
  expect(within(tools).getByRole('button',{name:'玻璃半透明'})).toHaveAttribute('aria-pressed','true');
  fireEvent.click(screen.getByRole('button',{name:'draw box'}));
  fireEvent.click(screen.getByRole('button',{name:'添加精修区域'}));
  expect(screen.getByRole('list',{name:'已添加的精修区域'}).children).toHaveLength(2);
  fireEvent.click(screen.getByRole('button',{name:'应用本地精修'}));
  await waitFor(()=>expect(apply).toHaveBeenCalledWith('hands',[
    {mode:'clear',box:{x:.1,y:.1,width:.05,height:.05}},
    {mode:'glass',box:{x:.2,y:.2,width:.1,height:.1}},
  ]));
});
it('keeps the footer available while a real local correction is pending and prevents duplicate submission',async()=>{
  let finish!:()=>void;
  const apply=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
  render(<SourceLayerRefinement sourceUrl="source" width={100} height={200}
    layers={[{nodeId:'hands',name:'手部',regions:[]}]} onApply={apply}/>);
  fireEvent.click(screen.getByRole('button',{name:'本地抠图与边缘精修'}));
  const actions=screen.getByRole('group',{name:'精修操作'});
  fireEvent.click(within(actions).getByRole('button',{name:'应用本地精修'}));
  expect(within(actions).getByRole('button',{name:'关闭精修'})).toBeDisabled();
  expect(within(actions).getByRole('button',{name:'应用本地精修'})).toBeDisabled();
  expect(screen.getByRole('dialog',{name:'边缘精修'})).toHaveAttribute('aria-busy','true');
  finish();
  await waitFor(()=>expect(within(actions).getByRole('button',{name:'应用本地精修'})).toBeEnabled());
  expect(apply).toHaveBeenCalledTimes(1);
});
it('opens on the layer named in a composition conflict',()=>{
  render(<SourceLayerRefinement sourceUrl="source" width={100} height={100}
    layers={[{nodeId:'background',name:'背景',regions:[]},{nodeId:'cup',name:'杯身',regions:[]}]}
    suggestedLayerName="杯身" onApply={async()=>{}}/>);
  fireEvent.click(screen.getByRole('button',{name:'本地抠图与边缘精修'}));
  expect(screen.getByRole('combobox',{name:'精修图层'})).toHaveValue('cup');
});
it('reuses saved corrections for the selected original layer and shows failures without closing',async()=>{
  const regions=[{mode:'clear' as const,box:{x:.2,y:.2,width:.1,height:.1}}];
  const onApply=vi.fn(async()=>{throw new Error('精修保存失败');});
  render(<SourceLayerRefinement sourceUrl="source" width={100} height={200} layers={[{nodeId:'fruit',name:'水果',regions}]} onApply={onApply}/>);
  fireEvent.click(screen.getByRole('button',{name:'本地抠图与边缘精修'}));
  fireEvent.click(screen.getByRole('button',{name:'应用本地精修'}));
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('精修保存失败'));
  expect(onApply).toHaveBeenCalledWith('fruit',regions);
  expect(screen.getByRole('group',{name:'原图蒙版精修'})).toBeVisible();
});

it('audit ui: reopening must not carry the second layer selection rectangle into the first layer',async()=>{
 const apply=vi.fn(async()=>{});
 render(<SourceLayerRefinement sourceUrl="source" width={100} height={100} layers={[{nodeId:'a',name:'A',regions:[]},{nodeId:'b',name:'B',regions:[]}]} onApply={apply}/>);
 fireEvent.click(screen.getByRole('button',{name:'本地抠图与边缘精修'}));
 fireEvent.change(screen.getByRole('combobox',{name:'精修图层'}),{target:{value:'b'}});
 fireEvent.click(screen.getByRole('button',{name:'draw box'}));
 fireEvent.click(screen.getByRole('button',{name:'关闭精修'}));
 fireEvent.click(screen.getByRole('button',{name:'本地抠图与边缘精修'}));
 expect((screen.getByRole('combobox',{name:'精修图层'}) as HTMLSelectElement).value).toBe('a');
 expect((screen.getByRole('button',{name:'添加精修区域'}) as HTMLButtonElement).disabled).toBe(true);
});
it('audit ui: saved correction drafts must follow an externally undone layer result',async()=>{
 const clear={mode:'clear' as const,box:{x:.2,y:.2,width:.1,height:.1}};
 const apply=vi.fn(async()=>{});
 const props={sourceUrl:'source',width:100,height:100,onApply:apply};
 const view=render(<SourceLayerRefinement {...props} layers={[{nodeId:'a',name:'A',regions:[clear]}]}/>);
 fireEvent.click(screen.getByRole('button',{name:'本地抠图与边缘精修'}));
 fireEvent.click(screen.getByRole('button',{name:'移除精修区域 1'}));
 fireEvent.click(screen.getByRole('button',{name:'应用本地精修'}));
 await waitFor(()=>expect((screen.getByRole('button',{name:'应用本地精修'}) as HTMLButtonElement).disabled).toBe(false));
 view.rerender(<SourceLayerRefinement {...props} layers={[{nodeId:'a',name:'A',regions:[]}]}/>);
 view.rerender(<SourceLayerRefinement {...props} layers={[{nodeId:'a',name:'A',regions:[clear]}]}/>);
 fireEvent.click(screen.getByRole('button',{name:'关闭精修'}));
 fireEvent.click(screen.getByRole('button',{name:'本地抠图与边缘精修'}));
 fireEvent.click(screen.getByRole('button',{name:'应用本地精修'}));
 await waitFor(()=>expect(apply).toHaveBeenCalledTimes(2));
 expect(apply.mock.calls[1]).toEqual(['a',[clear]]);
});
