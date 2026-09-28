import { expect, it } from 'vitest';
import { composeLayeredRgba } from './layered-psd';
import { buildSourceLayerDocument } from './source-layer-document';

it('identifies the offending layer when its source-space mask exceeds its bounds', async () => {
  const width = 32, height = 32, source = new Uint8Array(width * height * 4).fill(255);
  const mask = new Uint8Array(source.length);
  mask.set([255, 255, 255, 255], (28 * width + 28) * 4);
  await expect(buildSourceLayerDocument({ width, height, source, selection: { mode: 'whole' }, layers: [
    { id: 'bg', name: '背景', kind: 'background', visible: true, opacity: 1, load: async () => source },
    { id: 'hand', name: '下方托握手部与手臂', kind: 'transparent', visible: true, opacity: 1,
      maskSpace: 'source', bounds: { x: 0, y: 0, width: .3, height: .3 }, load: async () => mask },
  ] })).rejects.toThrow(/下方托握手部与手臂.*原图位置不符/);
});

it('rejects source-space provider mattes that duplicate most of another independent object', async () => {
  const width = 20, height = 20, source = new Uint8Array(width * height * 4).fill(255);
  const first = new Uint8Array(source.length), second = new Uint8Array(source.length);
  for (let y = 4; y < 16; y++) for (let x = 4; x < 16; x++) first[(y * width + x) * 4 + 3] = 255;
  for (let y = 5; y < 17; y++) for (let x = 5; x < 17; x++) second[(y * width + x) * 4 + 3] = 255;
  const make = (id: string, name: string, mask: Uint8Array) => ({ id, name, kind: 'transparent' as const,
    visible: true, opacity: 1, maskSpace: 'source' as const, bounds: { x: .1, y: .1, width: .8, height: .8 }, load: async () => mask });
  await expect(buildSourceLayerDocument({ width, height, source, selection: { mode: 'whole' }, layers: [
    { id: 'bg', name: '背景', kind: 'background', visible: true, opacity: 1, load: async () => source },
    make('cup', '杯身', first), make('hand', '握杯手部', second),
  ] })).rejects.toThrow(/杯身.*握杯手部.*内容重叠/);
});

it('reconstructs a shadow from original pixels after local object refinement instead of a redrawn provider shadow',async()=>{
  const width=48,height=48,source=new Uint8Array(width*height*4),background=new Uint8Array(source.length),object=new Uint8Array(source.length),wrongShadow=new Uint8Array(source.length);
  for(let p=0;p<width*height;p++){source.set([200,180,160,255],p*4);background.set([180,160,140,255],p*4);}
  const shadowOffset=(32*width+24)*4,objectOffset=(24*width+24)*4;
  source.set([100,90,80,255],shadowOffset);source.set([200,10,10,255],objectOffset);object.set([200,10,10,255],objectOffset);wrongShadow.set([255,0,255,255],shadowOffset);
  const doc=await buildSourceLayerDocument({width,height,source,selection:{mode:'whole'},layers:[
    {id:'bg',name:'背景',kind:'background',visible:true,opacity:1,load:async()=>background},
    {id:'shadow',name:'接触阴影',kind:'transparent',visible:true,opacity:1,shadowOnly:true,bounds:{x:.25,y:.5,width:.5,height:.4},load:async()=>wrongShadow},
    {id:'object',name:'产品',kind:'transparent',visible:true,opacity:1,preparedRgb:true,maskSpace:'source',bounds:{x:.4,y:.4,width:.2,height:.2},load:async()=>object},
  ]});
  const result=composeLayeredRgba(doc);for(let c=0;c<3;c++)expect(Math.abs(result[shadowOffset+c]!-source[shadowOffset+c]!)).toBeLessThanOrEqual(1);
  const isolated=composeLayeredRgba({...doc,layers:doc.layers.map(l=>({...l,visible:l.id==='shadow'}))});
  expect(isolated[objectOffset+3]).toBe(0);expect(isolated[shadowOffset+3]).toBeLessThan(200);
  const without=composeLayeredRgba({...doc,layers:doc.layers.map(l=>({...l,visible:l.id==='bg'}))});expect(without[shadowOffset]).toBeGreaterThan(190);
});

it('keeps independent prepared foreground pixels beneath partial-alpha glass when hiding or reordering', async () => {
  const source=new Uint8Array(4*4*4).fill(255),lower=new Uint8Array(source.length),upper=new Uint8Array(source.length),offset=(1*4+1)*4;
  lower.set([0,0,200,255],offset);upper.set([200,0,0,64],offset);
  const base={kind:'transparent' as const,visible:true,opacity:1,maskSpace:'source' as const,preparedRgb:true,bounds:{x:0,y:0,width:1,height:1}};
  const doc=await buildSourceLayerDocument({width:4,height:4,source,selection:{mode:'whole'},layers:[
    {id:'bg',name:'background',kind:'background',visible:true,opacity:1,load:async()=>source},
    {...base,id:'lower',name:'lower object',load:async()=>lower},
    {...base,id:'glass',name:'glass',load:async()=>upper},
  ]});
  expect([...composeLayeredRgba(doc).slice(offset,offset+4)]).toEqual([50,0,150,255]);
  expect([...composeLayeredRgba({...doc,layers:doc.layers.map(layer=>({...layer,visible:layer.id!=='glass'}))}).slice(offset,offset+4)]).toEqual([0,0,200,255]);
});

it('excludes object pixels from a legacy shadow reordered above a mixture of local and generated objects',async()=>{
  const w=8,h=8,source=new Uint8Array(w*h*4).fill(255),background=source.slice(),local=new Uint8Array(source.length),legacy=new Uint8Array(source.length),shadow=new Uint8Array(source.length);
  local.set([210,10,10,255],(3*w+3)*4);source.set([210,10,10,255],(3*w+3)*4);legacy.set([0,0,255,255],(4*w+4)*4);
  for(let y=1;y<7;y++)for(let x=1;x<7;x++)shadow.set([0,0,0,128],(y*w+x)*4);
  const base={kind:'transparent' as const,visible:true,opacity:1,maskSpace:'source' as const,bounds:{x:0,y:0,width:1,height:1}};
  const doc=await buildSourceLayerDocument({width:w,height:h,source,selection:{mode:'whole'},layers:[
    {id:'bg',name:'bg',kind:'background',visible:true,opacity:1,load:async()=>background},
    {...base,id:'local',name:'local',preparedRgb:true,load:async()=>local},
    {...base,id:'legacy',name:'legacy',load:async()=>legacy},
    {...base,id:'shadow',name:'shadow',shadowOnly:true,load:async()=>shadow},
  ]});
  const isolated=composeLayeredRgba({...doc,layers:doc.layers.map(l=>({...l,visible:l.id==='shadow'}))});expect(isolated[(3*w+3)*4+3]).toBe(0);
});

it('exports a locally refined foreground without applying source color extraction a second time', async () => {
  const source=new Uint8Array(4*4*4).fill(255),refined=new Uint8Array(source.length);
  refined.set([30,60,90,128],(1*4+2)*4);
  const doc=await buildSourceLayerDocument({width:4,height:4,source,selection:{mode:'whole'},layers:[
    {id:'bg',name:'bg',kind:'background',visible:true,opacity:1,load:async()=>source},
    {id:'object',name:'object',kind:'transparent',visible:true,opacity:1,maskSpace:'source',preparedRgb:true,
      bounds:{x:0,y:0,width:1,height:1},load:async()=>refined},
  ]});
  const isolated=composeLayeredRgba({...doc,layers:doc.layers.map(layer=>({...layer,visible:layer.id==='object'}))});
  expect([...isolated.slice((1*4+2)*4,(1*4+2)*4+4)]).toEqual([30,60,90,128]);
});

it('keeps original background pixels outside local foreground coverage', async () => {
  const width = 32, height = 32, source = new Uint8Array(width * height * 4), donor = new Uint8Array(source.length), object = new Uint8Array(source.length);
  for (let pixel = 0; pixel < width * height; pixel++) {
    source.set([180, 190, 200, 255], pixel * 4);
    donor.set([20, 30, 40, 255], pixel * 4);
  }
  const center = (16 * width + 16) * 4;
  source.set([220, 40, 20, 255], center); object.set([220, 40, 20, 255], center);
  donor.set([255, 0, 255, 255], (16 * width + 17) * 4);
  const doc = await buildSourceLayerDocument({ width, height, source, selection: { mode: 'whole' }, layers: [
    { id: 'bg', name: '背景', kind: 'background', visible: true, opacity: 1, load: async () => donor },
    { id: 'object', name: '主体', kind: 'transparent', visible: true, opacity: 1, preparedRgb: true,
      maskSpace: 'source', bounds: { x: .4, y: .4, width: .2, height: .2 }, load: async () => object },
  ] });
  const composite = composeLayeredRgba(doc);
  expect([...composite.slice((16 * width + 17) * 4, (16 * width + 17) * 4 + 4)])
    .toEqual([...source.slice((16 * width + 17) * 4, (16 * width + 17) * 4 + 4)]);
});

it('keeps original edge pixels when source-space matte and generated background colors differ', async () => {
  const source = new Uint8Array(4 * 4 * 4).fill(255);
  const background = source.map((value, i) => i % 4 === 3 ? value : 0);
  const mask = source.map((value, i) => i % 4 === 3 ? 64 : value);
  const doc = await buildSourceLayerDocument({ width: 4, height: 4, source, selection: { mode: 'whole' }, layers: [
    { id: 'bg', name: '背景', kind: 'background', visible: true, opacity: 1, load: async () => background },
    { id: 'glass', name: '玻璃', kind: 'transparent', visible: true, opacity: 1, maskSpace: 'source',
      bounds: { x: 0, y: 0, width: 1, height: 1 }, load: async () => mask },
  ] });
  expect(composeLayeredRgba(doc)).toEqual(source);
});

it('keeps the full source image unchanged when a provider matte leaks beyond its annotated object', async () => {
  const width = 16, height = 16;
  const source = Uint8Array.from(Array.from({ length: width * height }, (_, i) => [i % 240, 80, 140, 255]).flat());
  const donor = source.map((value, i) => i % 4 === 3 ? value : Math.min(255, value + 50));
  const mask = new Uint8Array(source.length);
  for (let y = 4; y < 8; y++) for (let x = 4; x < 8; x++) mask[(y * width + x) * 4 + 3] = 255;
  mask[(6 * width + 8) * 4 + 3] = 128;
  for (let y = 12; y < 16; y++) for (let x = 12; x < 16; x++) mask[(y * width + x) * 4 + 3] = 255;
  const doc = await buildSourceLayerDocument({ width, height, source, selection: { mode: 'whole' }, layers: [
    { id: 'bg', name: '背景', kind: 'background', visible: true, opacity: 1, load: async () => donor },
    { id: 'object', name: '物体', kind: 'transparent', visible: true, opacity: 1, maskSpace: 'source',
      bounds: { x: .2, y: .2, width: .4, height: .4 }, load: async () => mask },
  ] });
  const composite = composeLayeredRgba(doc);
  for (let i = 0; i < source.length; i++) expect(Math.abs(composite[i]! - source[i]!)).toBeLessThanOrEqual(1);
  const isolated = composeLayeredRgba({ ...doc, layers: doc.layers.map(layer => ({ ...layer, visible: layer.id === 'object' })) });
  expect(isolated[(13 * width + 13) * 4 + 3]).toBe(0);
});

it('removes background color contribution from native partial-alpha mattes and retains source appearance', async () => {
  const width = 8, height = 8;
  const background = Uint8Array.from(Array.from({ length: 64 }, () => [240, 200, 160, 255]).flat());
  const source = background.slice(), mask = new Uint8Array(source.length);
  const offset = (3 * width + 5) * 4;
  // A half-transparent dark red foreground against a known clean background.
  source.set([170, 110, 95, 255], offset); mask.set([255, 255, 255, 128], offset);
  const doc = await buildSourceLayerDocument({ width, height, source, selection: { mode: 'whole' }, layers: [
    { id: 'bg', name: '背景', kind: 'background', visible: true, opacity: 1, load: async () => background },
    { id: 'glass', name: '玻璃', kind: 'transparent', visible: true, opacity: 1, maskSpace: 'source',
      bounds: { x: .25, y: .25, width: .5, height: .5 }, load: async () => mask },
  ] });
  const isolated = composeLayeredRgba({ ...doc, layers: doc.layers.map(layer => ({ ...layer, visible: layer.id === 'glass' })) });
  expect(isolated[offset + 3]).toBe(128);
  expect(isolated[offset]).toBeCloseTo(101, 0);
  expect(isolated[offset + 1]).toBeCloseTo(21, 0);
  const composite = composeLayeredRgba(doc);
  for (let i = 0; i < source.length; i++) expect(Math.abs(composite[i]! - source[i]!)).toBeLessThanOrEqual(1);
});

it('uses only original foreground RGB and exactly reconstructs an opaque source at its native size', async () => {
  const width = 8, height = 8;
  const source = Uint8Array.from(Array.from({ length: 64 }, (_, i) => [i * 3, 30, 70, 255]).flat());
  const mask = Uint8Array.from(Array.from({ length: 64 }, (_, i) => [255, 0, 0, i % 8 > 0 && i % 8 < 7 && i >= 8 && i < 56 ? 255 : 0]).flat());
  const background = new Uint8Array(256).fill(240);
  for (let i = 3; i < 256; i += 4) background[i] = 255;
  const output = await buildSourceLayerDocument({ width, height, source, selection: { mode: 'whole' }, layers: [
    { id: 'bg', name: '背景', kind: 'background', visible: true, opacity: 1, load: async () => background },
    { id: 'fruit', name: '水果', kind: 'transparent', visible: true, opacity: 1, bounds: { x: .625, y: .5, width: .25, height: .25 }, load: async () => mask },
  ] });
  expect([output.width, output.height]).toEqual([8, 8]);
  expect(composeLayeredRgba(output)).toEqual(source);
  const foreground = output.layers[1]!;
  const isolated = composeLayeredRgba({ ...output, layers: output.layers.map(layer => layer.kind === 'background' ? { ...layer, visible: false } : layer) });
  expect([...isolated.slice((4 * 8 + 5) * 4, (4 * 8 + 5) * 4 + 4)]).toEqual([...source.slice((4 * 8 + 5) * 4, (4 * 8 + 5) * 4 + 4)]);
  expect(isolated[(3 * 8 + 5) * 4 + 3]).toBe(0);
  expect(foreground.width).toBeLessThan(width);
  expect(composeLayeredRgba({ ...output, layers: output.layers.map(layer => layer.id === 'fruit' ? { ...layer, visible: false } : layer) })[(4 * 8 + 5) * 4]).toBe(240);
});

it('refuses missing original placement', async () => {
  const source = new Uint8Array(64).fill(255);
  const load = async () => source;
  await expect(buildSourceLayerDocument({ width: 4, height: 4, source, selection: { mode: 'whole' }, layers: [
    { id: 'bg', name: '背景', kind: 'background', visible: true, opacity: 1, load },
    { id: 'subject', name: '主体', kind: 'transparent', visible: true, opacity: 1, load },
  ] })).rejects.toThrow(/原图.*位置/);
});

it('does not leave the removed object pixels in an overlapping lower layer', async () => {
  const width = 8, height = 8;
  const source = new Uint8Array(width * height * 4).fill(255);
  const mask = source.slice();
  const background = source.map((value, i) => i % 4 === 3 ? value : 20);
  const doc = await buildSourceLayerDocument({ width, height, source, selection: { mode: 'whole' }, layers: [
    { id: 'bg', name: '背景', kind: 'background', visible: true, opacity: 1, load: async () => background },
    { id: 'shadow', name: '投影', kind: 'transparent', visible: true, opacity: 1, bounds: { x: .125, y: .125, width: .75, height: .75 }, load: async () => mask },
    { id: 'product', name: '产品', kind: 'transparent', visible: false, opacity: 1, bounds: { x: .25, y: .25, width: .5, height: .5 }, load: async () => mask },
  ] });
  const hidden = composeLayeredRgba(doc);
  expect([...hidden.slice((3 * width + 3) * 4, (3 * width + 3) * 4 + 4)]).toEqual([20, 20, 20, 255]);
  expect([...hidden.slice((1 * width + 1) * 4, (1 * width + 1) * 4 + 4)]).toEqual([255, 255, 255, 255]);
  expect(composeLayeredRgba({ ...doc, layers: doc.layers.map(layer => ({ ...layer, visible: true })) })).toEqual(source);
});

it('rejects a foreground whose corrected placement is entirely outside the selected region', async () => {
  const pixels = new Uint8Array(8 * 8 * 4).fill(255);
  await expect(buildSourceLayerDocument({ width: 8, height: 8, source: pixels,
    selection: { mode: 'region', box: { x: 0, y: 0, width: .25, height: .25 } }, layers: [
      { id: 'bg', name: '背景', kind: 'background', visible: true, opacity: 1, load: async () => pixels },
      { id: 'fruit', name: '水果', kind: 'transparent', visible: true, opacity: 1,
        bounds: { x: .75, y: .75, width: .25, height: .25 }, load: async () => pixels },
    ] })).rejects.toThrow(/水果.*没有可见像素/);
});
