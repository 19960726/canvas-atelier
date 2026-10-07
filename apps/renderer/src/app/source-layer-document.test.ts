import { expect, it } from 'vitest';
import { initializeCanvas, readPsd } from 'ag-psd';
import { composeLayeredRgba, encodeLayeredPsd } from './layered-psd';
import { buildDraftSourceLayerDocument, buildSourceLayerDocument } from './source-layer-document';

it('keeps returned source-matte alpha outside analysis bounds in a hidden editable draft', async () => {
  const width = 12, height = 12, source = new Uint8Array(width * height * 4), mask = new Uint8Array(source.length);
  for (let pixel = 0; pixel < width * height; pixel++) source.set([80, 110, 140, 255], pixel * 4);
  mask.set([255, 255, 255, 1], 0);
  mask.set([255, 255, 255, 255], (5 * width + 5) * 4);
  mask.set([255, 255, 255, 8], (5 * width + 6) * 4);
  mask.set([255, 255, 255, 1], mask.length - 4);
  const document = await buildDraftSourceLayerDocument({ width, height, source, selection: { mode: 'whole' }, layers: [
    { id: 'background', name: 'Background', kind: 'background', visible: true, opacity: 1, load: async () => source },
    { id: 'matte', name: 'Returned matte', kind: 'transparent', visible: true, opacity: 1, maskSpace: 'source',
      bounds: { x: .4, y: .4, width: .2, height: .2 }, load: async () => mask },
  ] });
  const layer = document.layers.find(candidate => candidate.id === 'matte')!;
  expect([layer.x, layer.y, layer.width, layer.height, layer.visible]).toEqual([0, 0, width, height, false]);
  expect(Array.from(layer.rgba.slice(0, 4))).toEqual([80, 110, 140, 1]);
  expect(Array.from(layer.rgba.slice((5 * width + 6) * 4, (5 * width + 6) * 4 + 4))).toEqual([80, 110, 140, 8]);
  expect(Array.from(layer.rgba.slice(-4))).toEqual([80, 110, 140, 1]);
  expect(composeLayeredRgba(document)).toEqual(source);
});

it('keeps explicitly imported background pixels beneath coverage without running donor harmonization again', async () => {
  const width=8,height=8,source=new Uint8Array(width*height*4),background=new Uint8Array(source.length),foreground=new Uint8Array(source.length);
  for(let p=0;p<width*height;p++){source.set([120,120,120,255],p*4);background.set([40,40,40,255],p*4);}
  const offset=(4*width+4)*4;foreground.set([210,30,40,255],offset);source.set([210,30,40,255],offset);
  const document=await buildSourceLayerDocument({width,height,source,selection:{mode:'whole'},layers:[
    {id:'bg',name:'本地背景',kind:'background',visible:true,opacity:1,independentRgbaCandidate:true,
      rgbaCandidateOrigin:'local-rgba-import',outputContract:'opaque-background-v2',load:async()=>background},
    {id:'cupbody',name:'杯身',kind:'transparent',visible:true,opacity:1,preparedRgb:true,maskSpace:'source',
      bounds:{x:0,y:0,width:1,height:1},load:async()=>foreground},
  ]});
  expect(document.layers[0]!.rgba.slice(offset,offset+4)).toEqual(background.slice(offset,offset+4));
  expect(document.layers[0]!.rgba.slice(0,4)).toEqual(source.slice(0,4));
});

it('preserves local imported RGBA without rewriting its old v1 provider contract and keeps it untrusted', async () => {
  const width = 2, height = 1, background = Uint8Array.from([100,100,100,255,100,100,100,255]);
  const foreground = Uint8Array.from([19,87,201,128,0,0,0,0]);
  const source = Uint8Array.from([59,93,151,255,100,100,100,255]);
  const input = { width, height, source, selection: {mode:'whole' as const}, layers: [
    {id:'bg',name:'背景',kind:'background' as const,visible:true,opacity:1,load:async()=>background},
    {id:'cupbody',name:'杯身',kind:'transparent' as const,visible:true,opacity:1,maskSpace:'source' as const,
      bounds:{x:0,y:0,width:1,height:1}, outputContract:'source-alpha-matte-v1' as const,
      independentRgbaCandidate:true, rgbaCandidateOrigin:'local-rgba-import' as const, load:async()=>foreground},
  ]};
  const draft = await buildDraftSourceLayerDocument(input);
  expect(draft.layers.find(layer=>layer.id==='cupbody')!.rgba).toEqual(foreground);
  expect(draft.layers.slice(1).every(layer=>!layer.visible)).toBe(true);
  await expect(buildSourceLayerDocument({...input,independentValidation:'strict'})).rejects.toThrow(/尚未完成核验/);
  const digest='a'.repeat(64);
  const accepted={...input,groupConfirmationDigest:digest,independentValidation:'strict' as const,
    layers:input.layers.map(layer=>({...layer,layeringConfirmationDigest:digest,semanticReviewAccepted:true,semanticReviewDigest:digest}))};
  await expect(buildSourceLayerDocument(accepted)).resolves.toMatchObject({width,height});
  await expect(buildSourceLayerDocument({...accepted,layers:accepted.layers.map(layer=>layer.id==='cupbody'
    ? {...layer,semanticReviewDigest:'b'.repeat(64)}:layer)})).rejects.toThrow(/摘要.*不匹配/);
});

it('refuses to certify independent colors from two raw translucent source contributions and retains a draft', async () => {
  const width = 8, height = 8, background = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) background.set([200, 200, 200, 255], p * 4);
  const offset = (3 * width + 3) * 4;
  const lower = new Uint8Array(background.length), upper = new Uint8Array(background.length);
  lower.set([0, 0, 200, 128], offset); upper.set([200, 0, 0, 64], offset);
  const base = { kind: 'transparent' as const, visible: true, opacity: 1, maskSpace: 'source' as const,
    bounds: { x: 0, y: 0, width: 1, height: 1 } };
  const known = { width, height, layers: [
    { id: 'bg', name: '背景', kind: 'background' as const, x: 0, y: 0, width, height, visible: true, opacity: 1, rgba: background },
    { ...base, id: 'lower', name: '下层玻璃', x: 0, y: 0, width, height, rgba: lower },
    { ...base, id: 'upper', name: '上层玻璃', x: 0, y: 0, width, height, rgba: upper },
  ] };
  const source = composeLayeredRgba(known);
  expect([...source.slice(offset, offset + 4)]).toEqual([125, 75, 150, 255]);
  expect([...composeLayeredRgba({ ...known, layers: known.layers.map(layer => ({ ...layer,
    visible: layer.id !== 'upper' })) }).slice(offset, offset + 4)]).toEqual([100, 100, 200, 255]);
  const input = { width, height, source, selection: { mode: 'whole' as const }, layers: [
    { id: 'bg', name: '背景', kind: 'background' as const, visible: true, opacity: 1, load: async () => background },
    { ...base, id: 'lower', name: '下层玻璃', load: async () => lower },
    { ...base, id: 'upper', name: '上层玻璃', load: async () => upper },
  ] };
  await expect(buildSourceLayerDocument(input)).rejects.toThrow(/下层玻璃.*上层玻璃.*透明贡献.*独立颜色.*请先本地精修图层“下层玻璃”/u);
  const draft = await buildDraftSourceLayerDocument(input);
  expect(composeLayeredRgba(draft)).toEqual(source);
  expect(draft.layers.slice(1).every(layer => !layer.visible)).toBe(true);
  const alphaAt = (id: string) => {
    const layer = draft.layers.find(layer => layer.id === id)!;
    return layer.rgba[((3 - layer.y) * layer.width + 3 - layer.x) * 4 + 3];
  };
  expect(alphaAt('lower')).toBe(128); expect(alphaAt('upper')).toBe(64);
  expect(() => encodeLayeredPsd(draft)).not.toThrow();
});

it('runs the full-frame independent RGBA check before a strict PSD/preview document is returned', async () => {
  const width = 4, height = 1;
  const background = new Uint8Array([
    240, 240, 240, 255, 240, 240, 240, 255, 240, 240, 240, 255, 240, 240, 240, 255,
  ]);
  const red = new Uint8Array(16), blue = new Uint8Array(16);
  red.set([255, 0, 0, 255], 0);
  blue.set([0, 0, 255, 255], 8);
  const source = composeLayeredRgba({ width, height, layers: [
    { id: 'bg', name: '背景', kind: 'background', x: 0, y: 0, width, height, visible: true, opacity: 1, rgba: background },
    { id: 'red', name: '红色物体', kind: 'transparent', x: 0, y: 0, width, height, visible: true, opacity: 1, rgba: red },
    { id: 'blue', name: '蓝色物体', kind: 'transparent', x: 0, y: 0, width, height, visible: true, opacity: 1, rgba: blue },
  ] });
  const document = await buildSourceLayerDocument({ width, height, source, selection: { mode: 'whole' }, independentValidation: 'strict', layers: [
    { id: 'bg', name: '背景', kind: 'background', visible: true, opacity: 1, load: async () => background },
    { id: 'red', name: '红色物体', kind: 'transparent', visible: true, opacity: 1, preparedRgb: true, maskSpace: 'source', bounds: { x: 0, y: 0, width: 1, height: 1 }, load: async () => red },
    { id: 'blue', name: '蓝色物体', kind: 'transparent', visible: true, opacity: 1, preparedRgb: true, maskSpace: 'source', bounds: { x: 0, y: 0, width: 1, height: 1 }, load: async () => blue },
  ] });
  expect(composeLayeredRgba(document)).toEqual(source);
});

it('preserves straight RGBA bytes for an independent v2 candidate instead of treating them as an alpha matte', async () => {
  const width = 1, height = 1;
  const background = Uint8Array.from([100, 100, 100, 255]);
  const lower = Uint8Array.from([10, 20, 30, 128]);
  const upper = Uint8Array.from([200, 100, 50, 128]);
  const source = composeLayeredRgba({ width, height, layers: [
    { id: 'bg', name: '背景', kind: 'background' as const, x: 0, y: 0, width, height, visible: true, opacity: 1, rgba: background },
    { id: 'lower', name: '下层候选', kind: 'transparent' as const, x: 0, y: 0, width, height, visible: true, opacity: 1, rgba: lower },
    { id: 'upper', name: '上层候选', kind: 'transparent' as const, x: 0, y: 0, width, height, visible: true, opacity: 1, rgba: upper },
  ] });
  const base = { kind: 'transparent' as const, visible: true, opacity: 1, maskSpace: 'source' as const,
    bounds: { x: 0, y: 0, width: 1, height: 1 }, outputContract: 'source-independent-rgba-v2' as const,
    independentRgbaCandidate: true };
  const document = await buildSourceLayerDocument({ width, height, source, selection: { mode: 'whole' }, independentValidation: 'audit', layers: [
    { id: 'bg', name: '背景', kind: 'background', visible: true, opacity: 1, load: async () => background },
    { ...base, id: 'lower', name: '下层候选', load: async () => lower },
    { ...base, id: 'upper', name: '上层候选', load: async () => upper },
  ] });
  expect([...document.layers.find(layer => layer.id === 'lower')!.rgba]).toEqual([...lower]);
  expect([...document.layers.find(layer => layer.id === 'upper')!.rgba]).toEqual([...upper]);
});

it('refuses an unreviewed independent v2 candidate at strict PSD export', async () => {
  const width = 2, height = 1;
  const background = Uint8Array.from([100, 100, 100, 255, 100, 100, 100, 255]);
  const foreground = Uint8Array.from([10, 20, 30, 255, 0, 0, 0, 0]);
  const source = composeLayeredRgba({ width, height, layers: [
    { id: 'bg', name: '背景', kind: 'background' as const, x: 0, y: 0, width, height, visible: true, opacity: 1, rgba: background },
    { id: 'foreground', name: '候选前景', kind: 'transparent' as const, x: 0, y: 0, width, height, visible: true, opacity: 1, rgba: foreground },
  ] });
  await expect(buildSourceLayerDocument({ width, height, source, selection: { mode: 'whole' }, independentValidation: 'strict', layers: [
    { id: 'bg', name: '背景', kind: 'background', visible: true, opacity: 1, load: async () => background },
    { id: 'foreground', name: '候选前景', kind: 'transparent', visible: true, opacity: 1, maskSpace: 'source',
      bounds: { x: 0, y: 0, width: 1, height: 1 }, outputContract: 'source-independent-rgba-v2', independentRgbaCandidate: true,
      load: async () => foreground },
  ] })).rejects.toThrow(/独立 RGBA 候选尚未完成核验/u);
});

it('refuses a strict export when the layering group needs reconfirmation', async () => {
  const pixels = Uint8Array.from([100, 100, 100, 255]);
  await expect(buildSourceLayerDocument({ width: 1, height: 1, source: pixels, selection: { mode: 'whole' },
    independentValidation: 'strict', needsReconfirm: true, layers: [
      { id: 'bg', name: '背景', kind: 'background', visible: true, opacity: 1, load: async () => pixels },
      { id: 'subject', name: '主体', kind: 'transparent', visible: true, opacity: 1, preparedRgb: true,
        bounds: { x: 0, y: 0, width: 1, height: 1 }, load: async () => pixels },
    ] })).rejects.toThrow(/重新确认|reconfirm/u);
});

it('refuses a strict export when a layer result has a stale layering confirmation digest', async () => {
  const pixels = Uint8Array.from([100, 100, 100, 255]);
  await expect(buildSourceLayerDocument({ width: 1, height: 1, source: pixels, selection: { mode: 'whole' },
    independentValidation: 'strict', groupConfirmationDigest: 'a'.repeat(64), layers: [
      { id: 'bg', name: '背景', kind: 'background', visible: true, opacity: 1, layeringConfirmationDigest: 'b'.repeat(64), load: async () => pixels },
      { id: 'subject', name: '主体', kind: 'transparent', visible: true, opacity: 1, preparedRgb: true,
        layeringConfirmationDigest: 'b'.repeat(64), bounds: { x: 0, y: 0, width: 1, height: 1 }, load: async () => pixels },
    ] })).rejects.toThrow(/确认摘要|digest/u);
});

it.each([
  { label: 'raw overlay above a prepared carrier', carrierPrepared: true, overlayPrepared: false, target: '水流' },
  { label: 'prepared overlay above a raw carrier', carrierPrepared: false, overlayPrepared: true, target: '独立杯身' },
])('identifies the raw layer needing refinement for $label', async ({ carrierPrepared, overlayPrepared, target }) => {
  const width = 8, height = 8, background = new Uint8Array(width * height * 4).fill(255);
  const offset = (3 * width + 3) * 4, carrier = new Uint8Array(background.length), mask = new Uint8Array(background.length);
  carrier.set([0, 0, 200, 255], offset); mask.set([200, 0, 0, 64], offset);
  const source = background.slice(); source.set([50, 0, 150, 255], offset);
  const base = { kind: 'transparent' as const, visible: true, opacity: 1, maskSpace: 'source' as const,
    bounds: { x: 0, y: 0, width: 1, height: 1 } };
  await expect(buildSourceLayerDocument({ width, height, source, selection: { mode: 'whole' }, layers: [
    { id: 'bg', name: '背景', kind: 'background', visible: true, opacity: 1, load: async () => background },
    { ...base, id: 'carrier', name: '独立杯身', preparedRgb: carrierPrepared, load: async () => carrier },
    { ...base, id: 'water', name: '水流', preparedRgb: overlayPrepared, load: async () => mask },
  ] })).rejects.toThrow(new RegExp(`独立杯身.*水流.*透明贡献.*独立颜色.*请先本地精修图层“${target}”`, 'u'));
});

it('prioritizes object contamination over unresolved translucent colors without changing the overlap limit', async () => {
  const width = 20, height = 20, source = new Uint8Array(width * height * 4).fill(255);
  const background = source.map((value, i) => i % 4 === 3 ? value : 0);
  const first = new Uint8Array(source.length), second = new Uint8Array(source.length);
  for (let y = 4; y < 16; y++) for (let x = 4; x < 16; x++) first[(y * width + x) * 4 + 3] = 200;
  for (let y = 5; y < 17; y++) for (let x = 5; x < 17; x++) second[(y * width + x) * 4 + 3] = 200;
  const base = { kind: 'transparent' as const, visible: true, opacity: 1, maskSpace: 'source' as const,
    bounds: { x: .1, y: .1, width: .8, height: .8 } };
  await expect(buildSourceLayerDocument({ width, height, source, selection: { mode: 'whole' }, layers: [
    { id: 'bg', name: '背景', kind: 'background', visible: true, opacity: 1, load: async () => background },
    { ...base, id: 'lid', name: '杯盖', load: async () => first },
    { ...base, id: 'hand', name: '手部', load: async () => second },
  ] })).rejects.toThrow(/杯盖.*手部.*内容重叠 84%/u);
});

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

it('preserves overlapping provider masks as hidden editable layers over the original in a draft PSD', async () => {
  const width = 8, height = 8, source = new Uint8Array(width * height * 4);
  const background = new Uint8Array(source.length);
  const first = new Uint8Array(source.length), second = new Uint8Array(source.length);
  for (let p = 0; p < width * height; p++) {
    source.set([p + 10, 70, 90, 255], p * 4);
    background.set([20, 30, 40, 255], p * 4);
  }
  for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) {
    first[(y * width + x) * 4 + 3] = 255;
    second[(y * width + x) * 4 + 3] = 255;
  }
  const layers = [
    { id: 'bg', name: '背景返图', kind: 'background' as const, visible: true, opacity: 1, load: async () => background },
    { id: 'source-original', name: '杯身', kind: 'transparent' as const, visible: true, opacity: 1,
      maskSpace: 'source' as const, bounds: { x: .25, y: .25, width: .5, height: .5 }, load: async () => first },
    { id: 'hand', name: '握杯手部', kind: 'transparent' as const, visible: true, opacity: 1,
      maskSpace: 'source' as const, bounds: { x: .25, y: .25, width: .5, height: .5 }, load: async () => second },
  ];
  await expect(buildSourceLayerDocument({ width, height, source, selection: { mode: 'whole' }, layers }))
    .rejects.toThrow(/内容重叠/);
  const draft = await buildDraftSourceLayerDocument({ width, height, source, selection: { mode: 'whole' }, layers });
  expect(draft.layers.map(layer => [layer.id, layer.visible, layer.kind])).toEqual([
    ['source-original-copy', true, 'background'], ['bg', false, 'alternate-background'],
    ['source-original', false, 'transparent'], ['hand', false, 'transparent'],
  ]);
  expect([...composeLayeredRgba(draft)]).toEqual([...source]);
  expect([...composeLayeredRgba({ ...draft, layers: draft.layers.map(layer => ({ ...layer,
    visible: layer.kind === 'alternate-background' })) })]).toEqual([...background]);
  expect(() => encodeLayeredPsd(draft)).not.toThrow();
  for (const layer of draft.layers.slice(2)) {
    expect(layer.name).toContain('待修整');
    const pixel = (3 - layer.y) * layer.width + 3 - layer.x;
    expect([...layer.rgba.slice(pixel * 4, pixel * 4 + 4)]).toEqual([...source.slice((3 * width + 3) * 4, (3 * width + 3) * 4 + 4)]);
  }
});

it('keeps the original outside a selected region in the draft background candidate', async () => {
  const width = 8, height = 8;
  const source = new Uint8Array(width * height * 4), background = new Uint8Array(source.length), mask = new Uint8Array(source.length);
  for (let pixel = 0; pixel < width * height; pixel++) {
    source.set([20, 30, 40, 255], pixel * 4);
    background.set([100, 110, 120, 255], pixel * 4);
  }
  mask.set([255, 255, 255, 255], (3 * width + 3) * 4);
  const draft = await buildDraftSourceLayerDocument({ width, height, source,
    selection: { mode: 'region', box: { x: .25, y: .25, width: .5, height: .5 } }, layers: [
      { id: 'bg', name: '背景', kind: 'background', visible: true, opacity: 1, load: async () => background },
      { id: 'object', name: '物体', kind: 'transparent', visible: true, opacity: 1,
        maskSpace: 'source', bounds: { x: .25, y: .25, width: .5, height: .5 }, load: async () => mask },
    ] });
  const candidate = draft.layers[1]!.rgba;
  expect([...candidate.slice(0, 4)]).toEqual([20, 30, 40, 255]);
  expect([...candidate.slice((3 * width + 3) * 4, (3 * width + 3) * 4 + 4)]).toEqual([100, 110, 120, 255]);
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

it('refuses unresolved raw shadow colors reordered above local and raw objects while retaining their draft',async()=>{
  const w=8,h=8,source=new Uint8Array(w*h*4).fill(255),background=source.slice(),local=new Uint8Array(source.length),legacy=new Uint8Array(source.length),shadow=new Uint8Array(source.length);
  local.set([210,10,10,255],(3*w+3)*4);source.set([210,10,10,255],(3*w+3)*4);legacy.set([0,0,255,255],(4*w+4)*4);
  for(let y=1;y<7;y++)for(let x=1;x<7;x++)shadow.set([0,0,0,128],(y*w+x)*4);
  const base={kind:'transparent' as const,visible:true,opacity:1,maskSpace:'source' as const,bounds:{x:0,y:0,width:1,height:1}};
  const input={width:w,height:h,source,selection:{mode:'whole' as const},layers:[
    {id:'bg',name:'bg',kind:'background' as const,visible:true,opacity:1,load:async()=>background},
    {...base,id:'local',name:'local',preparedRgb:true,load:async()=>local},
    {...base,id:'legacy',name:'legacy',load:async()=>legacy},
    {...base,id:'shadow',name:'shadow',shadowOnly:true,load:async()=>shadow},
  ]};
  await expect(buildSourceLayerDocument(input)).rejects.toThrow(/legacy.*shadow.*透明贡献.*独立颜色.*请先本地精修图层“legacy”/u);
  const draft=await buildDraftSourceLayerDocument(input);
  expect(composeLayeredRgba(draft)).toEqual(source);
  expect(draft.layers.slice(1).every(layer=>!layer.visible)).toBe(true);
  const returned=draft.layers.find(layer=>layer.id==='shadow')!,p=((3-returned.y)*returned.width+3-returned.x)*4;
  expect(returned.rgba[p+3]).toBe(128);
});

it.each([true, false])('refuses an impossible raw shadow backdrop instead of keeping the shadow in the background (has object: %s)', async (hasObject) => {
  const width = 4, height = 4, source = new Uint8Array(width * height * 4).fill(255);
  const background = source.slice();
  const shadow = new Uint8Array(source.length), object = new Uint8Array(source.length);
  const shadowOffset = (1 * width + 1) * 4, objectOffset = (2 * width + 2) * 4;
  // A black shadow with alpha 64 over white yields gray 191; no black donor
  // can reproduce gray 191 with this alpha using a valid independent RGB.
  source.set([191, 191, 191, 255], shadowOffset);
  background.set([0, 0, 0, 255], shadowOffset);
  shadow.set([255, 255, 255, 64], shadowOffset);
  object.set([255, 255, 255, 255], objectOffset);
  const base = { kind: 'transparent' as const, visible: true, opacity: 1, maskSpace: 'source' as const,
    bounds: { x: 0, y: 0, width: 1, height: 1 } };
  const input = { width, height, source, selection: { mode: 'whole' as const }, layers: [
    { id: 'bg', name: '背景', kind: 'background' as const, visible: true, opacity: 1, load: async () => background },
    { ...base, id: 'shadow', name: '真实黑色阴影', shadowOnly: true, load: async () => shadow },
    ...(hasObject ? [{ ...base, id: 'object', name: '不透明物体', load: async () => object }] : []),
  ] };
  await expect(buildSourceLayerDocument(input)).rejects.toThrow(/真实黑色阴影.*透明蒙版.*补全背景.*独立颜色.*请先本地精修图层“真实黑色阴影”/u);
  const draft = await buildDraftSourceLayerDocument(input);
  expect(composeLayeredRgba(draft)).toEqual(source);
  expect(draft.layers.slice(1).every(layer => !layer.visible)).toBe(true);
  const raw = draft.layers.find(layer => layer.id === 'shadow')!, p = ((1 - raw.y) * raw.width + 1 - raw.x) * 4;
  expect([...raw.rgba.slice(p, p + 4)]).toEqual([191, 191, 191, 64]);
  expect(draft.layers[1]!.rgba).toEqual(background);
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

it('uses the entire clean donor for whole-image local refinement when background replacement is selected', async () => {
  const width = 8, height = 8;
  const source = new Uint8Array(width * height * 4), donor = new Uint8Array(source.length), object = new Uint8Array(source.length);
  for (let pixel = 0; pixel < width * height; pixel++) {
    source.set([180, 190, 200, 255], pixel * 4);
    donor.set([20, 30, 40, 255], pixel * 4);
  }
  const center = (4 * width + 4) * 4;
  source.set([220, 40, 20, 255], center); object.set([220, 40, 20, 255], center);
  const document = await buildSourceLayerDocument({ width, height, source, selection: { mode: 'whole' }, backgroundMode: 'replace', layers: [
    { id: 'bg', name: '背景', kind: 'background', visible: true, opacity: 1, load: async () => donor },
    { id: 'object', name: '主体', kind: 'transparent', visible: true, opacity: 1, preparedRgb: true,
      maskSpace: 'source', bounds: { x: .25, y: .25, width: .5, height: .5 }, load: async () => object },
  ] });
  expect([...document.layers[0]!.rgba]).toEqual([...donor]);
  const composite = composeLayeredRgba(document);
  expect([...composite.slice(center, center + 4)]).toEqual([220, 40, 20, 255]);
  expect([...composite.slice(0, 4)]).toEqual([20, 30, 40, 255]);
});

it('refuses a source-space matte that cannot recover independent colors from the supplied background', async () => {
  const source = new Uint8Array(4 * 4 * 4).fill(255);
  const background = source.map((value, i) => i % 4 === 3 ? value : 0);
  const mask = source.map((value, i) => i % 4 === 3 ? 64 : value);
  await expect(buildSourceLayerDocument({ width: 4, height: 4, source, selection: { mode: 'whole' }, layers: [
    { id: 'bg', name: '背景', kind: 'background', visible: true, opacity: 1, load: async () => background },
    { id: 'glass', name: '玻璃', kind: 'transparent', visible: true, opacity: 1, maskSpace: 'source',
      bounds: { x: 0, y: 0, width: 1, height: 1 }, load: async () => mask },
  ] })).rejects.toThrow(/玻璃.*透明蒙版.*补全背景.*独立颜色.*请先本地精修图层“玻璃”/u);
});

it.each(['preserve', 'replace'] as const)('does not certify a single raw translucent object by restoring source RGB into a %s background', async (backgroundMode) => {
  const width = 4, height = 4, offset = (1 * width + 1) * 4;
  const background = Uint8Array.from(Array.from({ length: width * height }, () => [0, 0, 0, 255]).flat());
  const foreground = new Uint8Array(background.length); foreground.set([255, 0, 0, 64], offset);
  const known = { width, height, layers: [
    { id: 'bg', name: '真实背景', kind: 'background' as const, x: 0, y: 0, width, height, visible: true, opacity: 1, rgba: background },
    { id: 'water', name: '红色透明水流', kind: 'transparent' as const, x: 0, y: 0, width, height, visible: true, opacity: 1, rgba: foreground },
  ] };
  const source = composeLayeredRgba(known), donor = background.slice(), matte = new Uint8Array(source.length);
  donor.set([0, 255, 0, 255], offset); matte.set([255, 255, 255, 64], offset);
  expect([...source.slice(offset, offset + 4)]).toEqual([64, 0, 0, 255]);
  const input = { width, height, source, backgroundMode, selection: { mode: 'whole' as const }, layers: [
    { id: 'bg', name: '错误补全背景', kind: 'background' as const, visible: true, opacity: 1, load: async () => donor },
    { id: 'water', name: '红色透明水流', kind: 'transparent' as const, visible: true, opacity: 1,
      maskSpace: 'source' as const, bounds: { x: 0, y: 0, width: 1, height: 1 }, load: async () => matte },
  ] };
  await expect(buildSourceLayerDocument(input)).rejects.toThrow(/红色透明水流.*透明蒙版.*补全背景.*独立颜色.*请先本地精修图层“红色透明水流”/u);
  const draft = await buildDraftSourceLayerDocument(input);
  expect(composeLayeredRgba(draft)).toEqual(source);
  expect(draft.layers.slice(1).every(layer => !layer.visible)).toBe(true);
  expect(draft.layers[1]!.rgba).toEqual(donor);
  const raw = draft.layers[2]!, p = ((1 - raw.y) * raw.width + 1 - raw.x) * 4;
  expect([...raw.rgba.slice(p, p + 4)]).toEqual([64, 0, 0, 64]);
  expect(() => encodeLayeredPsd(draft)).not.toThrow();
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

// These literal source pixels are calculated independently of the assembler:
// alpha 128 of [200,220,240] over [100,80,60] is [150,150,150],
// and over [240,240,240] it is [220,230,240].
function reviewedSourceContractFixture(optical = false): Parameters<typeof buildSourceLayerDocument>[0] {
  const digest = 'a'.repeat(64);
  const background = Uint8Array.from([240,240,240,255,240,240,240,255,240,240,240,255,240,240,240,255]);
  const body = Uint8Array.from([0,0,0,0,100,80,60,255,100,80,60,255,0,0,0,0]);
  const water = Uint8Array.from([0,0,0,0,200,220,240,128,0,0,0,0,200,220,240,128]);
  const proof = { independentRgbaCandidate: true, rgbaCandidateOrigin: 'local-rgba-import' as const,
    semanticReviewAccepted: true, semanticReviewDigest: digest, layeringConfirmationDigest: digest };
  const foreground = { kind: 'transparent' as const, visible: true, opacity: 1, maskSpace: 'source' as const,
    bounds: { x: 0, y: 0, width: 1, height: 1 }, outputContract: 'source-alpha-matte-v1' as const, ...proof };
  return { width: 4, height: 1, source: Uint8Array.from(optical
    ? [240,240,240,255,150,150,150,255,100,80,60,255,220,230,240,255]
    : [240,240,240,255,100,80,60,255,100,80,60,255,240,240,240,255]),
  selection: { mode: 'whole' }, backgroundMode: 'preserve', independentValidation: 'strict', groupConfirmationDigest: digest,
  layers: [
    { id: 'bg', name: '已检查背景', kind: 'background', visible: true, opacity: 1,
      outputContract: 'opaque-background-v2', ...proof, load: async () => background.slice() },
    { id: 'body', name: '已检查杯身', ...foreground, load: async () => body.slice() },
    ...(optical ? [{ id: 'water', name: '已检查独立水流', ...foreground, load: async () => water.slice() }] : []),
  ] };
}

it('allows a reviewed whole-background replacement at an uncovered background pixel during strict export', async () => {
  const input = reviewedSourceContractFixture();
  const replacement = await input.layers[0]!.load();
  replacement.set([200,240,240,255], 0);
  const document = await buildSourceLayerDocument({ ...input, backgroundMode: 'replace', layers: [
    { ...input.layers[0]!, load: async () => replacement.slice() }, ...input.layers.slice(1),
  ] });
  expect([...composeLayeredRgba(document)]).toEqual([
    200,240,240,255,100,80,60,255,100,80,60,255,240,240,240,255,
  ]);
  expect(document.layers.map(layer => layer.id)).toEqual(['bg', 'body']);
});

it('keeps the same unoccluded source pixel unchanged when preserve mode is used for a reviewed donor', async () => {
  const input = reviewedSourceContractFixture();
  const donor = await input.layers[0]!.load();
  donor.set([200,240,240,255], 0);
  const document = await buildSourceLayerDocument({ ...input, layers: [
    { ...input.layers[0]!, load: async () => donor.slice() }, ...input.layers.slice(1),
  ] });
  expect([...composeLayeredRgba(document)]).toEqual([
    240,240,240,255,100,80,60,255,100,80,60,255,240,240,240,255,
  ]);
});

it('requires an explicit current background review before a legacy background can use strict replacement', async () => {
  const input = reviewedSourceContractFixture();
  await expect(buildSourceLayerDocument({ ...input, backgroundMode: 'replace', layers: [
    { ...input.layers[0]!, independentRgbaCandidate: false, rgbaCandidateOrigin: undefined,
      semanticReviewAccepted: false, semanticReviewDigest: undefined }, ...input.layers.slice(1),
  ] })).rejects.toThrow(/背景.*核验|背景.*复核|背景.*检查/u);
});

it('requires a group confirmation binding for a reviewed full-background replacement', async () => {
  const input = reviewedSourceContractFixture();
  await expect(buildSourceLayerDocument({ ...input, backgroundMode: 'replace', groupConfirmationDigest: undefined }))
    .rejects.toThrow(/确认|摘要|绑定/u);
});

it('refuses a raw alpha matte to authorize strict full-background replacement through a review flag', async () => {
  const input = reviewedSourceContractFixture();
  await expect(buildSourceLayerDocument({ ...input, backgroundMode: 'replace', layers: [
    input.layers[0]!, { ...input.layers[1]!, independentRgbaCandidate: false,
      rgbaCandidateOrigin: undefined, preparedRgb: false },
  ] })).rejects.toThrow(/独立.*RGBA|蒙版|独立前景/u);
});

it.each(['unreviewed', 'stale-review', 'stale-result'] as const)(
  'rejects %s background proof for strict whole-background replacement', async (problem) => {
    const input = reviewedSourceContractFixture();
    const background = { ...input.layers[0]!, ...(problem === 'unreviewed' ? { semanticReviewAccepted: false }
      : problem === 'stale-review' ? { semanticReviewDigest: 'b'.repeat(64) }
        : { layeringConfirmationDigest: 'b'.repeat(64) }) };
    await expect(buildSourceLayerDocument({ ...input, backgroundMode: 'replace', layers: [background, ...input.layers.slice(1)] }))
      .rejects.toThrow(/核验|摘要|过期/u);
  },
);

it('refuses full-background replacement for a regional selection even with current review', async () => {
  const input = reviewedSourceContractFixture();
  await expect(buildSourceLayerDocument({ ...input, backgroundMode: 'replace',
    selection: { mode: 'region', box: { x: 0, y: 0, width: .5, height: 1 } } }))
    .rejects.toThrow(/整图/u);
});

it.each(['wrong-rgb', 'wrong-position'] as const)(
  'does not excuse a foreground with %s when reviewed background replacement is selected', async (problem) => {
    const input = reviewedSourceContractFixture();
    const background = await input.layers[0]!.load();
    background.set([200,240,240,255], 0);
    const body = await input.layers[1]!.load();
    if (problem === 'wrong-rgb') body.set([200,0,0,255], 4);
    else { body.fill(0); body.set([100,80,60,255], 8); body.set([100,80,60,255], 12); }
    await expect(buildSourceLayerDocument({ ...input, backgroundMode: 'replace', layers: [
      { ...input.layers[0]!, load: async () => background.slice() },
      { ...input.layers[1]!, load: async () => body.slice() },
    ] })).rejects.toThrow(/合成.*原图.*不一致|原图位置|前景/u);
  },
);

it('exports reviewed independent body and optical RGBA whose complete composite exactly matches the source', async () => {
  const input = reviewedSourceContractFixture(true);
  const document = await buildSourceLayerDocument(input);
  expect([...composeLayeredRgba(document)]).toEqual([
    240,240,240,255,150,150,150,255,100,80,60,255,220,230,240,255,
  ]);
  expect([...composeLayeredRgba({ ...document, layers: document.layers.map(layer => ({ ...layer, visible: layer.id !== 'water' })) })])
    .toEqual([240,240,240,255,100,80,60,255,100,80,60,255,240,240,240,255]);
  expect(document.layers.map(layer => layer.id)).toEqual(['bg', 'body', 'water']);
  initializeCanvas(() => { throw new Error('Native canvas rasterization is not used by this PSD readback'); },
    (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as ImageData);
  const decoded = readPsd(encodeLayeredPsd(document), { useImageData: true, skipThumbnail: true });
  expect([decoded.width, decoded.height]).toEqual([4, 1]);
  expect(decoded.children?.map(layer => layer.name)).toEqual(['已检查背景', '已检查杯身', '已检查独立水流']);
  expect(decoded.children?.map(layer => [layer.left, layer.top, layer.right, layer.bottom]))
    .toEqual([[0,0,4,1], [0,0,4,1], [0,0,4,1]]);
  expect([...decoded.children![1]!.imageData!.data]).toEqual([0,0,0,0,100,80,60,255,100,80,60,255,0,0,0,0]);
  expect([...decoded.children![2]!.imageData!.data]).toEqual([0,0,0,0,200,220,240,128,0,0,0,0,200,220,240,128]);
  expect([...decoded.imageData!.data]).toEqual([240,240,240,255,150,150,150,255,100,80,60,255,220,230,240,255]);
});

it.each(['unreviewed', 'stale-review', 'stale-result'] as const)(
  'does not allow %s body proof to bypass the optical review requirement', async (problem) => {
    const input = reviewedSourceContractFixture(true);
    await expect(buildSourceLayerDocument({ ...input, layers: input.layers.map(layer => layer.id === 'body'
      ? { ...layer, ...(problem === 'unreviewed' ? { semanticReviewAccepted: false }
        : problem === 'stale-review' ? { semanticReviewDigest: 'b'.repeat(64) }
          : { layeringConfirmationDigest: 'b'.repeat(64) }) } : layer) }))
      .rejects.toThrow(/核验|摘要|过期/u);
  },
);

it('rejects a reviewed optical candidate with foreground RGB contamination instead of treating its review as composite proof', async () => {
  const input = reviewedSourceContractFixture(true);
  const water = await input.layers[2]!.load();
  water.set([255,0,0,128], 4);
  await expect(buildSourceLayerDocument({ ...input, layers: [
    ...input.layers.slice(0, 2), { ...input.layers[2]!, load: async () => water.slice() },
  ] })).rejects.toThrow(/合成.*原图.*不一致/u);
});

it('rejects a fully hidden reviewed body even when the other layers reproduce the source exactly', async () => {
  const input = reviewedSourceContractFixture(true);
  const water = await input.layers[2]!.load();
  water.set([150,150,150,255], 4); water.set([100,80,60,255], 8);
  await expect(buildSourceLayerDocument({ ...input, layers: [
    ...input.layers.slice(0, 2), { ...input.layers[2]!, load: async () => water.slice() },
  ] })).rejects.toThrow(/没有.*可.*像素|隐藏.*不发生变化/u);
});

it('keeps partial foreground coverage outside the authorized background-only replacement domain', async () => {
  const input = reviewedSourceContractFixture(true);
  const background = await input.layers[0]!.load();
  background.set([100,100,100,255], 12);
  await expect(buildSourceLayerDocument({ ...input, backgroundMode: 'replace', layers: [
    { ...input.layers[0]!, load: async () => background.slice() }, ...input.layers.slice(1),
  ] })).rejects.toThrow(/半透明|合成.*原图.*不一致/u);
});

it('does not waive optical review uncertainty using a legacy preparedRgb flag without independent candidate provenance', async () => {
  const input = reviewedSourceContractFixture(true);
  await expect(buildSourceLayerDocument({ ...input, layers: input.layers.map(layer => layer.kind === 'transparent'
    ? { ...layer, independentRgbaCandidate: false, rgbaCandidateOrigin: undefined, preparedRgb: true } : layer) }))
    .rejects.toThrow(/独立.*RGB|人工复核|独立 RGBA/u);
});

it('does not relax the one-channel source tolerance after a current local review', async () => {
  const input = reviewedSourceContractFixture();
  const body = await input.layers[1]!.load();
  body[4] = 102;
  await expect(buildSourceLayerDocument({ ...input, layers: [input.layers[0]!,
    { ...input.layers[1]!, load: async () => body.slice() },
  ] })).rejects.toThrow(/最大颜色误差 2/u);
});

it.each(['background-hole', 'empty-foreground'] as const)(
  'rejects %s in reviewed whole-background replacement', async (problem) => {
    const input = reviewedSourceContractFixture();
    const background = await input.layers[0]!.load();
    const body = await input.layers[1]!.load();
    if (problem === 'background-hole') background[3] = 128;
    else body.fill(0);
    await expect(buildSourceLayerDocument({ ...input, backgroundMode: 'replace', layers: [
      { ...input.layers[0]!, load: async () => background.slice() },
      { ...input.layers[1]!, load: async () => body.slice() },
    ] })).rejects.toThrow(problem === 'background-hole' ? /透明空洞/u : /没有可见像素/u);
  },
);

it.each([.5, 0])('rejects background opacity %s instead of certifying a mismatched optical PSD composite', async (opacity) => {
  const input = reviewedSourceContractFixture(true);
  await expect(buildSourceLayerDocument({ ...input, layers: [
    { ...input.layers[0]!, opacity }, ...input.layers.slice(1),
  ] })).rejects.toThrow(/不透明背景|背景.*透明度|合成.*原图.*不一致/u);
});

it('does not license an alpha change in the background-only replacement domain', async () => {
  const input = reviewedSourceContractFixture();
  const background = await input.layers[0]!.load();
  background.set([200,240,240,255], 0);
  await expect(buildSourceLayerDocument({ ...input, backgroundMode: 'replace', layers: [
    { ...input.layers[0]!, opacity: .5, load: async () => background.slice() }, ...input.layers.slice(1),
  ] })).rejects.toThrow(/不透明背景|背景.*透明度|透明度.*误差/u);
});
