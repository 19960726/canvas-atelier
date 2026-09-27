import {expect,it} from 'vitest';
import {isShadowOnlyLayer} from './shadow-layer-role';
it('only migrates explicit shadow tasks and leaves ambiguous object descriptions alone',()=>{
  expect(isShadowOnlyLayer({layerId:'shadow-fruits',kind:'transparent',name:'水果阴影与倒影',description:'仅水果在台面的阴影与倒影，不含水果本体'})).toBe(true);
  expect(isShadowOnlyLayer({layerId:'fruit',name:'水果及阴影',description:'仅水果与投影，不含背景'})).toBe(false);
  expect(isShadowOnlyLayer({layerId:'shadow-fruits',name:'水果',description:'仅水果，不含投影'})).toBe(false);
  expect(isShadowOnlyLayer({layerId:'shadow-fruits',name:'水果及阴影',description:'仅提取水果与投影，不含背景'})).toBe(false);
});
