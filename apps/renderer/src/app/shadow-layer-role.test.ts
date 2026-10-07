import {expect,it} from 'vitest';
import {isShadowOnlyLayer} from './shadow-layer-role';
it('only migrates explicit shadow tasks and leaves ambiguous object descriptions alone',()=>{
  expect(isShadowOnlyLayer({layerId:'shadow-fruits',kind:'transparent',name:'水果阴影与倒影',description:'仅水果在台面的阴影与倒影，不含水果本体'})).toBe(true);
  expect(isShadowOnlyLayer({layerId:'fruit',name:'水果及阴影',description:'仅水果与投影，不含背景'})).toBe(false);
  expect(isShadowOnlyLayer({layerId:'shadow-fruits',name:'水果',description:'仅水果，不含投影'})).toBe(false);
  expect(isShadowOnlyLayer({layerId:'shadow-fruits',name:'水果及阴影',description:'仅提取水果与投影，不含背景'})).toBe(false);
});

it('recognizes an explicit Chinese shadow-only layer with a valid non-shadow ID',()=>{
  expect(isShadowOnlyLayer({layerId:'cast-cup',kind:'transparent',name:'杯子投影',description:'仅杯子在台面的投影，不含杯子本体'})).toBe(true);
});

it('recognizes an explicit English shadow-only layer with a valid non-shadow ID',()=>{
  expect(isShadowOnlyLayer({layerId:'cast-cup',kind:'transparent',name:'Cup shadow',description:'Only the cup shadow on the table, excluding the cup object.'})).toBe(true);
});

it('does not let a legacy shadow ID turn a body-and-shadow layer into a shadow-only layer',()=>{
  expect(isShadowOnlyLayer({layerId:'shadow-cup',kind:'transparent',name:'Cup and shadow',description:'Only the cup body and its shadow, excluding other objects.'})).toBe(false);
});

it('keeps a Chinese object layer that includes its shadow and excludes other objects',()=>{
  expect(isShadowOnlyLayer({layerId:'cup',kind:'transparent',name:'杯子及投影',description:'仅杯子本体及投影，不含其他物体'})).toBe(false);
});

it('keeps body-and-shadow requests as object layers when they omit the word body',()=>{
  expect(isShadowOnlyLayer({layerId:'shadow-cup',kind:'transparent',name:'Cup and shadow',description:'Only the cup and its shadow, excluding other objects.'})).toBe(false);
  expect(isShadowOnlyLayer({layerId:'shadow-cup',kind:'transparent',name:'杯子及投影',description:'仅杯子及其投影，不含其他物体'})).toBe(false);
});

it('preserves the existing contact-shadow and shadow-plus-reflection contracts',()=>{
  expect(isShadowOnlyLayer({layerId:'shadow-product',kind:'transparent',name:'产品接触阴影',description:'仅产品与台面接触处的阴影，不包含产品像素。'})).toBe(true);
  expect(isShadowOnlyLayer({layerId:'shadow-vase',kind:'transparent',name:'花瓶投影',description:'仅花瓶投在背景上的投影，不包含花瓶像素。'})).toBe(true);
  expect(isShadowOnlyLayer({layerId:'shadow-cup',kind:'transparent',name:'Cup shadow and reflection',description:'Only the cup shadow and reflection, excluding the cup object.'})).toBe(true);
});

it('does not mistake a projector object for a projected shadow',()=>{
  expect(isShadowOnlyLayer({layerId:'projector',kind:'transparent',name:'黑色投影仪',description:'仅投影仪本体，不含其他物体'})).toBe(false);
});

it('keeps ambiguous shadow names and background layers out of the shadow-only role',()=>{
  expect(isShadowOnlyLayer({layerId:'cast-cup',name:'杯子投影',description:'杯子在台面的投影和边缘细节'})).toBe(false);
  expect(isShadowOnlyLayer({layerId:'shadow-bg',kind:'background',name:'背景阴影',description:'仅台面阴影，不含物体本体'})).toBe(false);
  expect(isShadowOnlyLayer({layerId:'shadow-bg',layerKind:'background',name:'背景阴影',description:'仅台面阴影，不含物体本体'})).toBe(false);
});

it('does not classify shadow-and-object requests as pure shadows when the object is named last',()=>{
  expect(isShadowOnlyLayer({layerId:'cup',kind:'transparent',name:'杯子及阴影',description:'仅杯子的阴影和杯子，不含其他物体'})).toBe(false);
  expect(isShadowOnlyLayer({layerId:'cup',kind:'transparent',name:'Cup and shadow',description:'Only the cup shadow and the cup, excluding other objects.'})).toBe(false);
});

it('requires excluding the associated subject rather than merely excluding other objects',()=>{
  expect(isShadowOnlyLayer({layerId:'cast-cup',kind:'transparent',name:'杯子投影',description:'仅杯子在台面的投影，不含其他物体'})).toBe(false);
  expect(isShadowOnlyLayer({layerId:'cast-cup',kind:'transparent',name:'Cup shadow',description:'Only the cup shadow on the table, excluding other objects.'})).toBe(false);
});

it('does not mistake reflective hardware names for an explicitly requested effect',()=>{
  expect(isShadowOnlyLayer({layerId:'reflector',kind:'transparent',name:'反光板',description:'仅反光板，不含其他物体'})).toBe(false);
  expect(isShadowOnlyLayer({layerId:'mirror',kind:'transparent',name:'反射镜',description:'仅反射镜，不含其他物体'})).toBe(false);
  expect(isShadowOnlyLayer({layerId:'reflector',kind:'transparent',name:'反光板',description:'仅反光板，不含反光板本体'})).toBe(false);
  expect(isShadowOnlyLayer({layerId:'mirror',kind:'transparent',name:'反射镜',description:'仅反射镜，不含反射镜本体'})).toBe(false);
  expect(isShadowOnlyLayer({layerId:'cast-reflector',kind:'transparent',name:'反光板投影',description:'仅反光板在台面的投影，不含反光板本体'})).toBe(true);
});

it('does not treat a negated only statement as an exclusive shadow request',()=>{
  expect(isShadowOnlyLayer({layerId:'cast-cup',kind:'transparent',name:'杯子阴影',description:'不仅杯子阴影，不含杯子本体'})).toBe(false);
  expect(isShadowOnlyLayer({layerId:'cast-cup',kind:'transparent',name:'Cup shadow',description:'Not only the cup shadow, excluding the cup object.'})).toBe(false);
});

it.each([
  { name: '杯子表面及阴影', description: '仅杯子表面、杯子阴影，不含花瓶本体' },
  { name: 'Cup surface and shadow', description: 'Only cup surface, cup shadow, excluding vase object.' },
  { name: '杯子阴影', description: '仅杯子阴影、杯子表面，不含杯子本体' },
  { name: 'Cup shadow', description: 'Only cup shadow, cup surface, excluding cup object.' },
])('keeps every explicitly included object scope ordinary: $description',({ name, description })=>{
  expect(isShadowOnlyLayer({ layerId: 'cup', kind: 'transparent', name, description })).toBe(false);
});

it.each([
  { name: '杯子投影', description: '仅杯子在台面的投影，不含花瓶本体' },
  { name: 'Cup shadow', description: 'Only the cup shadow on the table, excluding the vase object.' },
])('does not use an unrelated subject exclusion to authorize a pure effect: $description',({ name, description })=>{
  expect(isShadowOnlyLayer({ layerId: 'cast-cup', kind: 'transparent', name, description })).toBe(false);
});

it('preserves explicitly requested comma-separated pure effects for the excluded subject',()=>{
  expect(isShadowOnlyLayer({ layerId: 'cast-cup', kind: 'transparent', name: '杯子投影及倒影', description: '仅杯子在台面的投影、倒影，不含杯子本体' })).toBe(true);
  expect(isShadowOnlyLayer({ layerId: 'cast-cup', kind: 'transparent', name: 'Cup shadow and reflection', description: 'Only the cup shadow, reflection, excluding the cup object.' })).toBe(true);
});

it('keeps an explicitly mixed object-and-effect title ordinary even when the description requests an effect',()=>{
  expect(isShadowOnlyLayer({ layerId: 'cup', kind: 'transparent', name: '杯子表面及阴影', description: '仅杯子阴影，不含杯子本体' })).toBe(false);
});

it.each([
  { layerId: 'shadow-blender', name: '养生料理机接触阴影与倒影', description: '仅中央红色养生料理机在台面上投下的底部接触阴影与镜面反光倒影，不含机身本体' },
  { layerId: 'shadow-dessert', name: '甜品餐盘投影与倒影', description: '仅左侧黑色餐盘在台面上的接触阴影与微弱倒影，不含餐盘和甜点本身' },
  { layerId: 'shadow-fruits', name: '柑橘水果投影与倒影', description: '仅右侧西柚切片、整果及薄荷叶在台面上的接触阴影与倒影，不含水果本体' },
])('preserves the actual historical explicit-only contract: $layerId',layer=>{
  expect(isShadowOnlyLayer({ ...layer, kind: 'transparent' })).toBe(true);
});

it('does not discard an explicitly included subject scope before a later spatial shadow predicate',()=>{
  expect(isShadowOnlyLayer({ layerId: 'cup', kind: 'transparent', name: '杯子阴影', description: '仅杯子表面、杯子在台面的阴影，不含杯子本体' })).toBe(false);
});

it.each([
  { name: '杯子阴影', description: '仅杯子在花瓶旁的阴影，不含花瓶本体' },
  { name: 'Cup shadow', description: 'Only the cup shadow beside the vase, excluding the vase object.' },
])('does not treat a spatial reference as the excluded effect subject: $description',({ name, description })=>{
  expect(isShadowOnlyLayer({ layerId: 'cast-cup', kind: 'transparent', name, description })).toBe(false);
});

it.each([
  { name: '杯子阴影', description: '仅玻璃表面、杯子在台面的阴影，不含杯子本体' },
  { name: '柑橘水果投影与倒影', description: '仅玻璃表面、右侧西柚切片、整果及薄荷叶在台面上的接触阴影与倒影，不含水果本体' },
])('does not grant a shared shadow predicate to a preceding foreign or unknown object scope: $description',({ name, description })=>{
  expect(isShadowOnlyLayer({ layerId: 'shadow-fruits', kind: 'transparent', name, description })).toBe(false);
});
