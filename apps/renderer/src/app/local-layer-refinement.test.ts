import { expect,it,vi } from 'vitest';
import { refineOwnedLayer } from './local-layer-refinement';
const request={width:2,height:2,bounds:{x:0,y:0,width:1,height:1},regions:[]};
it.each([0,255])('rejects unusable all-%s-alpha foregrounds before saving',async alpha=>{
  const rgba=new Uint8Array(16);for(let i=3;i<rgba.length;i+=4)rgba[i]=alpha;
  const save=vi.fn();
  await expect(refineOwnedLayer({request,isCurrent:()=>true,decode:async()=>new Uint8Array(16),refine:async()=>({width:2,height:2,rgba}),save})).rejects.toThrow(/透明|像素/);
  expect(save).not.toHaveBeenCalled();
});
it('discards finished inference if the source or layer changed before completion',async()=>{
  let current=true;
  const save=vi.fn(),refine=vi.fn(async()=>{current=false;return{width:2,height:2,rgba:new Uint8Array(16)};});
  await expect(refineOwnedLayer({request,isCurrent:()=>current,decode:async()=>new Uint8Array(16),refine,save})).rejects.toThrow(/变更/);
  expect(save).not.toHaveBeenCalled();
});
it('does not save resized output even if the byte count matches',async()=>{
  const save=vi.fn();
  await expect(refineOwnedLayer({request,isCurrent:()=>true,decode:async()=>new Uint8Array(16),refine:async()=>({width:1,height:4,rgba:new Uint8Array(16)}),save})).rejects.toThrow(/尺寸/);
  expect(save).not.toHaveBeenCalled();
});
