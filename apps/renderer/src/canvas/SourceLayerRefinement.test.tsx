import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach,expect,it,vi } from 'vitest';
import { SourceLayerRefinement } from './SourceLayerRefinement';
vi.mock('./LayeringSelectionEditor',()=>({LayeringSelectionEditor:({onChange}:any)=><button onClick={()=>onChange({x:.2,y:.2,width:.1,height:.1})}>draw box</button>}));
afterEach(cleanup);
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
