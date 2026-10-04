import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeCanvas, readPsd } from 'ag-psd';
import { describe, expect, it } from 'vitest';
import { buildDraftSourceLayerDocument, buildSourceLayerDocument, type SourcePixelLayer } from './source-layer-document';
import { composeLayeredRgba, type LayeredPsdDocument } from './layered-psd';

describe('independent source matte pixels after export ordering', () => {
  it.each(physicalShadowCases())('keeps or refuses the physical contribution matrix: $label', async (testCase) => {
    const { input, expected, source, expectedReject, refinement } = physicalShadowFixture(testCase);
    if (expectedReject) {
      await expect(buildSourceLayerDocument(input)).rejects.toThrow(new RegExp(`透明贡献.*独立颜色.*请先本地精修图层“${refinement}”`, 'u'));
      const draft = await buildDraftSourceLayerDocument(input);
      expect(composeLayeredRgba(draft)).toEqual(source);
      expect(draft.layers.slice(1).every(layer => !layer.visible)).toBe(true);
      expect(alphaAt(draft.layers.find(layer => layer.id === 'lower')!, 2, 2)).toBe(testCase.lowerAlpha);
      expect(alphaAt(draft.layers.find(layer => layer.id === 'upper')!, 2, 2)).toBe(testCase.upperAlpha);
      return;
    }
    const document = await buildSourceLayerDocument(input);
    for (const ids of [['bg', 'lower', 'upper'], ['bg', 'lower'], ['bg', 'upper'], ['lower'], ['upper']]) {
      const show = (value: LayeredPsdDocument) => ({ ...value, layers: value.layers.map(layer => ({ ...layer, visible: ids.includes(layer.id) })) });
      expect(composeLayeredRgba(show(document))).toEqual(composeLayeredRgba(show(expected)));
    }
    if (testCase.lower.prepared && testCase.upper.prepared) {
      const reordered = (value: LayeredPsdDocument) => ({ ...value, layers: [value.layers[0]!, value.layers[2]!, value.layers[1]!] });
      expect(composeLayeredRgba(reordered(document))).toEqual(composeLayeredRgba(reordered(expected)));
    }
  });

  it.each([32, 64, 128, 255])('checks a single raw shadow alpha=$alpha even beside a prepared object', async (alpha) => {
    const { layer, width, height } = pixelFixture(), background = new Uint8Array(width * height * 4).fill(255);
    const source = background.slice(), shadow = new Uint8Array(source.length), object = new Uint8Array(source.length);
    const offset = (8 * width + 8) * 4, objectOffset = (12 * width + 12) * 4;
    source.set([255 - alpha, 255 - alpha, 255 - alpha, 255], offset);
    source.set([200, 0, 0, 255], objectOffset); shadow.set([255, 255, 255, alpha], offset); object.set([200, 0, 0, 255], objectOffset);
    const input = { width, height, source, backgroundMode: 'replace' as const, selection: { mode: 'whole' as const }, layers: [
      layer('bg', '背景', background, { kind: 'background' }),
      layer('shadow', '独立黑色阴影', shadow, { shadowOnly: true }), layer('object', '已精修产品', object, { preparedRgb: true }),
    ] };
    const document = await buildSourceLayerDocument(input);
    expect(composeLayeredRgba(document)).toEqual(source);
    const isolated = composeLayeredRgba({ ...document, layers: document.layers.map(item => ({ ...item, visible: item.id === 'shadow' })) });
    expect([...isolated.slice(offset, offset + 4)]).toEqual([0, 0, 0, alpha]);
    const hidden = composeLayeredRgba({ ...document, layers: document.layers.map(item => ({ ...item, visible: item.id !== 'shadow' })) });
    expect([...hidden.slice(offset, offset + 4)]).toEqual([255, 255, 255, 255]);
    expect(document.layers[0]!.rgba).toEqual(background);
    if (alpha < 128) {
      const impossibleDonor = background.slice(); impossibleDonor.set([0, 0, 0, 255], offset);
      const rejected = { ...input, layers: [layer('bg', '不匹配背景', impossibleDonor, { kind: 'background' }), ...input.layers.slice(1)] };
      await expect(buildSourceLayerDocument(rejected)).rejects.toThrow(/独立黑色阴影.*透明蒙版.*补全背景.*独立颜色.*请先本地精修图层“独立黑色阴影”/u);
      expect(composeLayeredRgba(await buildDraftSourceLayerDocument(rejected))).toEqual(source);
    }
  });

  it('retains a trusted prepared shadow entirely covered by an opaque prepared object', async () => {
    const { layer, width, height } = pixelFixture(), background = new Uint8Array(width * height * 4).fill(255);
    const shadow = new Uint8Array(background.length), object = new Uint8Array(background.length), offset = (8 * width + 8) * 4;
    shadow.set([30, 60, 90, 128], offset); object.set([20, 40, 200, 255], offset);
    const source = background.slice(); source.set([20, 40, 200, 255], offset);
    const document = await buildSourceLayerDocument({ width, height, source, backgroundMode: 'replace', selection: { mode: 'whole' }, layers: [
      layer('bg', '背景', background, { kind: 'background' }),
      layer('shadow', '已精修阴影', shadow, { shadowOnly: true, preparedRgb: true }),
      layer('object', '已精修产品', object, { preparedRgb: true }),
    ] });
    expect(composeLayeredRgba(document)).toEqual(source);
    const visibleShadow = composeLayeredRgba({ ...document, layers: document.layers.map(item => ({ ...item, visible: item.id !== 'object' })) });
    expect([...visibleShadow.slice(offset, offset + 4)]).toEqual([142, 157, 172, 255]);
    const isolatedShadow = composeLayeredRgba({ ...document, layers: document.layers.map(item => ({ ...item, visible: item.id === 'shadow' })) });
    expect([...isolatedShadow.slice(offset, offset + 4)]).toEqual([30, 60, 90, 128]);
    expect(alphaAt(document.layers.find(item => item.id === 'shadow')!, 8, 8)).toBe(128);
  });

  it.each([{ alpha: 64, backgroundMode: 'preserve' as const }, { alpha: 128, backgroundMode: 'replace' as const }])(
    'recovers a single alpha=$alpha foreground from a clean plate without keeping its color in the $backgroundMode background',
    async ({ alpha, backgroundMode }) => {
      const { layer, width, height } = pixelFixture();
      const background = new Uint8Array(width * height * 4), foreground = new Uint8Array(background.length);
      for (let pixel = 0; pixel < width * height; pixel++) background[pixel * 4 + 3] = 255;
      const offset = (8 * width + 8) * 4;
      foreground.set([255, 0, 0, alpha], offset);
      const known: LayeredPsdDocument = { width, height, layers: [
        { id: 'bg', name: '背景', kind: 'background', x: 0, y: 0, width, height, visible: true, opacity: 1, rgba: background },
        { id: 'glass', name: '红色玻璃', kind: 'transparent', x: 0, y: 0, width, height, visible: true, opacity: 1, rgba: foreground },
      ] };
      const source = composeLayeredRgba(known), matte = new Uint8Array(source.length);
      matte.set([255, 255, 255, alpha], offset);
      const document = await buildSourceLayerDocument({ width, height, source, backgroundMode, selection: { mode: 'whole' }, layers: [
        layer('bg', '背景', background, { kind: 'background' }), layer('glass', '红色玻璃', matte),
      ] });
      expect(composeLayeredRgba(document)).toEqual(source);
      const isolated = composeLayeredRgba({ ...document, layers: document.layers.map(item => ({ ...item, visible: item.id === 'glass' })) });
      expect([...isolated.slice(offset, offset + 4)]).toEqual([255, 0, 0, alpha]);
      const hidden = composeLayeredRgba({ ...document, layers: document.layers.map(item => ({ ...item, visible: item.id !== 'glass' })) });
      expect(hidden).toEqual(background);
      expect(document.layers[0]!.rgba).toEqual(background);
    },
  );

  it.each([{ alpha: 64, opacity: 1 }, { alpha: 96, opacity: .25 }])(
    'blocks unresolved source colors under a repeated alpha=$alpha matte with layer opacity=$opacity',
    async ({ alpha, opacity }) => {
      const { source, layer, width, height } = pixelFixture();
      const repeated = rectangle(width, height, 4, 4, 12, 12, alpha);
      await expect(buildSourceLayerDocument({ width, height, source, selection: { mode: 'whole' }, layers: [
        layer('bg', '背景', source, { kind: 'background' }),
        layer('cup', '杯身', repeated, { opacity }),
        layer('copy', '另一独立对象返图', repeated, { opacity }),
      ] })).rejects.toThrow(/杯身.*另一独立对象返图.*透明贡献.*独立颜色/u);
    },
  );

  it('recovers a raw black shadow over a clean white plate and removes its gray color when hidden', async () => {
    const { layer, width, height } = pixelFixture();
    const background = new Uint8Array(width * height * 4).fill(255), shadow = new Uint8Array(background.length), object = new Uint8Array(background.length);
    const offset = (8 * width + 8) * 4, objectOffset = (12 * width + 12) * 4;
    const source = background.slice();
    source.set([191, 191, 191, 255], offset); source.set([200, 0, 0, 255], objectOffset);
    shadow.set([255, 255, 255, 64], offset); object.set([255, 255, 255, 255], objectOffset);
    const document = await buildSourceLayerDocument({ width, height, source, selection: { mode: 'whole' }, layers: [
      layer('bg', '背景', background, { kind: 'background' }),
      layer('shadow', '真实黑色阴影', shadow, { shadowOnly: true }), layer('object', '不透明物体', object),
    ] });
    expect(composeLayeredRgba(document)).toEqual(source);
    const isolated = composeLayeredRgba({ ...document, layers: document.layers.map(item => ({ ...item, visible: item.id === 'shadow' })) });
    expect([...isolated.slice(offset, offset + 4)]).toEqual([0, 0, 0, 64]);
    const hidden = composeLayeredRgba({ ...document, layers: document.layers.map(item => ({ ...item, visible: item.id !== 'shadow' })) });
    expect([...hidden.slice(offset, offset + 4)]).toEqual([255, 255, 255, 255]);
    expect([...hidden.slice(objectOffset, objectOffset + 4)]).toEqual([200, 0, 0, 255]);
    expect(document.layers[0]!.rgba).toEqual(background);
  });

  it('retains both low-alpha returned masks independently in the repair draft', async () => {
    const { source, layer, width, height } = pixelFixture();
    const repeated = rectangle(width, height, 4, 4, 12, 12, 64);
    const draft = await buildDraftSourceLayerDocument({ width, height, source, selection: { mode: 'whole' }, layers: [
      layer('bg', '背景', source, { kind: 'background' }),
      layer('cup', '杯身', repeated), layer('copy', '另一返图', repeated),
    ] });
    expect(composeLayeredRgba(draft)).toEqual(source);
    for (const returned of draft.layers.slice(2)) {
      expect(returned.visible).toBe(false);
      expect(alphaAt(returned, 8, 8)).toBe(64);
    }
  });

  it('does not certify raw overlapping water and cup colors from the source composite alone', async () => {
    const { source, layer, width, height } = pixelFixture();
    const cup = rectangle(width, height, 4, 4, 8, 8, 255);
    const water = rectangle(width, height, 10, 0, 2, 20, 64);
    const input = { width, height, source, selection: { mode: 'whole' as const }, layers: [
      layer('bg', '背景', source, { kind: 'background' }),
      layer('cup', '杯身', cup, { bounds: { x: 4 / 24, y: 4 / 24, width: 8 / 24, height: 8 / 24 } }),
      layer('water', '杯前细水流', water, { bounds: { x: 10 / 24, y: 0, width: 2 / 24, height: 20 / 24 } }),
    ] };
    await expect(buildSourceLayerDocument(input)).rejects.toThrow(/杯身.*杯前细水流.*透明贡献.*独立颜色/u);
    const document = await buildDraftSourceLayerDocument(input);
    const cupLayer = document.layers.find(item => item.id === 'cup')!;
    const waterLayer = document.layers.find(item => item.id === 'water')!;
    expect(alphaAt(cupLayer, 4, 4)).toBe(255);
    expect(alphaAt(cupLayer, 3, 4)).toBe(0);
    expect(alphaAt(waterLayer, 10, 0)).toBe(64);
    expect(alphaAt(waterLayer, 11, 19)).toBe(64);
    expect(alphaAt(waterLayer, 12, 19)).toBe(0);
    expect(composeLayeredRgba(document)).toEqual(source);
  });

  it('keeps real independent overlapping water and cup pixels at their source coordinates', async () => {
    const { source: background, layer, width, height } = pixelFixture();
    const cup = rectangle(width, height, 4, 4, 8, 8, 255, [0, 0, 200]);
    const water = rectangle(width, height, 10, 0, 2, 20, 64, [200, 0, 0]);
    const records = [
      { id: 'bg', name: '背景', kind: 'background' as const, rgba: background },
      { id: 'cup', name: '杯身', kind: 'transparent' as const, rgba: cup },
      { id: 'water', name: '杯前细水流', kind: 'transparent' as const, rgba: water },
    ].map(record => ({ ...record, x: 0, y: 0, width, height, visible: true, opacity: 1 }));
    const source = composeLayeredRgba({ width, height, layers: records });
    const document = await buildSourceLayerDocument({ width, height, source, backgroundMode: 'replace',
      selection: { mode: 'whole' }, layers: [
        layer('bg', '背景', background, { kind: 'background' }),
        layer('cup', '杯身', cup, { preparedRgb: true, bounds: { x: 4 / 24, y: 4 / 24, width: 8 / 24, height: 8 / 24 } }),
        layer('water', '杯前细水流', water, { preparedRgb: true, bounds: { x: 10 / 24, y: 0, width: 2 / 24, height: 20 / 24 } }),
      ] });
    const cupLayer = document.layers.find(item => item.id === 'cup')!;
    const waterLayer = document.layers.find(item => item.id === 'water')!;
    expect([cupLayer.x, cupLayer.y, cupLayer.width, cupLayer.height]).toEqual([3, 3, 10, 10]);
    expect([waterLayer.x, waterLayer.y, waterLayer.width, waterLayer.height]).toEqual([9, 0, 4, 21]);
    expect(alphaAt(cupLayer, 10, 4)).toBe(255);
    expect(alphaAt(waterLayer, 10, 4)).toBe(64);
    expect(composeLayeredRgba(document)).toEqual(source);
    const withoutWater = composeLayeredRgba({ ...document, layers: document.layers.map(item => ({ ...item,
      visible: item.id !== 'water' })) });
    expect([...withoutWater.slice((4 * width + 10) * 4, (4 * width + 10) * 4 + 4)]).toEqual([0, 0, 200, 255]);
  });

  it('refuses unresolved raw shadow and object colors even when both have nonoverlapping visible pixels', async () => {
    const { source, layer, width, height } = pixelFixture();
    const cup = rectangle(width, height, 4, 4, 12, 12, 64);
    const shadow = rectangle(width, height, 10, 14, 10, 6, 32);
    const input = { width, height, source, selection: { mode: 'whole' as const }, layers: [
      layer('bg', '背景', source, { kind: 'background' }),
      layer('shadow-cup', '杯子投影', shadow, { shadowOnly: true }),
      layer('cup', '杯身', cup),
    ] };
    await expect(buildSourceLayerDocument(input)).rejects.toThrow(/杯子投影.*杯身.*透明贡献.*独立颜色.*请先本地精修图层“杯子投影”/u);
    const document = await buildDraftSourceLayerDocument(input);
    expect(composeLayeredRgba(document)).toEqual(source);
    expect(document.layers.slice(1).every(item => !item.visible)).toBe(true);
    expect(alphaAt(document.layers.find(item => item.id === 'shadow-cup')!, 18, 18)).toBe(32);
    expect(alphaAt(document.layers.find(item => item.id === 'cup')!, 8, 8)).toBe(64);
  });

  it('preserves independently prepared glass and underlying object pixels even with identical footprints', async () => {
    const { source, layer, width, height } = pixelFixture();
    const lower = rectangle(width, height, 4, 4, 12, 12, 255, [0, 0, 200]);
    const glass = rectangle(width, height, 4, 4, 12, 12, 64, [200, 0, 0]);
    const document = await buildSourceLayerDocument({ width, height, source, backgroundMode: 'replace', selection: { mode: 'whole' }, layers: [
      layer('bg', '背景', source, { kind: 'background' }),
      layer('cup', '独立杯身', lower, { preparedRgb: true }),
      layer('glass', '半透明玻璃与水', glass, { preparedRgb: true }),
    ] });
    expect(alphaAt(document.layers.find(item => item.id === 'cup')!, 8, 8)).toBe(255);
    expect(alphaAt(document.layers.find(item => item.id === 'glass')!, 8, 8)).toBe(64);
    const isolatedCup = composeLayeredRgba({ ...document, layers: document.layers.map(item => ({ ...item, visible: item.id === 'cup' })) });
    expect([...isolatedCup.slice((8 * width + 8) * 4, (8 * width + 8) * 4 + 4)]).toEqual([0, 0, 200, 255]);
  });
});

const r7PsdPath = join(process.cwd(), 'work/repair-185/qa-scripts/output/seven-candidate-1790733777858-79143c02/ui-current-seven-1.6.185.psd');
// The delivered local r7 artifact is an additional compatibility gate, not a required tracked source fixture.
const r7ArtifactTest = existsSync(r7PsdPath) ? it : it.skip;
r7ArtifactTest('preserves the exact existing r7 prepared seven-layer PSD pixels and placement in the source document helper', async () => {
  const bytes = readFileSync(r7PsdPath);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('63ccdd39f8aa4e26d8b59e3f5dbe12662ef4c12b64fb2d8a40303ecf2e00611f');
  initializeCanvas(() => { throw new Error('Canvas creation is not needed for PSD pixel readback'); },
    (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: 'srgb' }));
  const psd = readPsd(bytes, { useImageData: true, skipThumbnail: true });
  const expected: LayeredPsdDocument = { width: psd.width, height: psd.height,
    layers: psd.children!.map((item, index) => ({
      id: 'r7-layer-' + index, name: item.name!, kind: index === 0 ? 'background' as const : 'transparent' as const,
      x: item.left!, y: item.top!, width: item.imageData!.width, height: item.imageData!.height,
      visible: !item.hidden, opacity: item.opacity ?? 1, rgba: new Uint8Array(item.imageData!.data),
    })) };
  expect(expected.layers).toHaveLength(7);
  const source = composeLayeredRgba(expected);
  const document = await buildSourceLayerDocument({ width: expected.width, height: expected.height, source,
    backgroundMode: 'replace', selection: { mode: 'whole' },
    layers: expected.layers.map(item => ({ ...item, kind: item.kind === 'background' ? 'background' as const : 'transparent' as const,
      maskSpace: 'source', preparedRgb: item.kind === 'transparent',
      bounds: item.kind === 'transparent' ? { x: item.x / expected.width, y: item.y / expected.height,
        width: item.width / expected.width, height: item.height / expected.height } : undefined,
      load: async () => {
        const full = new Uint8Array(source.length);
        for (let y = 0; y < item.height; y++) full.set(item.rgba.subarray(y * item.width * 4, (y + 1) * item.width * 4),
          ((item.y + y) * expected.width + item.x) * 4);
        return full;
      },
    })) });
  expect(document.layers.map(item => [item.name, item.x, item.y, item.width, item.height]))
    .toEqual(expected.layers.map(item => [item.name, item.x, item.y, item.width, item.height]));
  for (const [index, item] of document.layers.entries()) expect(pixelHash(item.rgba)).toBe(pixelHash(expected.layers[index]!.rgba));
  expect(pixelHash(composeLayeredRgba(document))).toBe(pixelHash(source));
}, 30_000);

function pixelFixture() {
  const width = 24, height = 24, source = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) source.set([120, 140, 160, 255], pixel * 4);
  const layer = (id: string, name: string, pixels: Uint8Array, patch: Partial<SourcePixelLayer> = {}): SourcePixelLayer => ({
    id, name, kind: 'transparent', visible: true, opacity: 1, maskSpace: 'source',
    bounds: { x: 0, y: 0, width: 1, height: 1 }, load: async () => pixels, ...patch,
  });
  return { width, height, source, layer };
}

function rectangle(width: number, height: number, left: number, top: number, w: number, h: number, alpha: number,
  rgb: readonly number[] = [255, 255, 255]) {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = top; y < top + h; y++) for (let x = left; x < left + w; x++) pixels.set([...rgb, alpha], (y * width + x) * 4);
  return pixels;
}

function alphaAt(layer: LayeredPsdDocument['layers'][number], x: number, y: number): number {
  if (x < layer.x || y < layer.y || x >= layer.x + layer.width || y >= layer.y + layer.height) return 0;
  return layer.rgba[((y - layer.y) * layer.width + x - layer.x) * 4 + 3]!;
}

function pixelHash(pixels: Uint8Array) {
  return createHash('sha256').update(pixels).digest('hex');
}

interface PhysicalShadowType { prepared: boolean; shadow: boolean }
interface PhysicalShadowCase { label: string; lower: PhysicalShadowType; upper: PhysicalShadowType; lowerAlpha: number; upperAlpha: number }
function physicalShadowCases(): PhysicalShadowCase[] {
  const types: PhysicalShadowType[] = [{ prepared: false, shadow: false }, { prepared: true, shadow: false },
    { prepared: false, shadow: true }, { prepared: true, shadow: true }];
  const cases: PhysicalShadowCase[] = [], alphas = [32, 64, 128, 255];
  const name = (type: PhysicalShadowType) => `${type.prepared ? 'prepared' : 'raw'}-${type.shadow ? 'shadow' : 'object'}`;
  for (const lower of types) for (const upper of types) for (const lowerAlpha of alphas) for (const upperAlpha of alphas)
    cases.push({ label: `${name(lower)} ${lowerAlpha} below ${name(upper)} ${upperAlpha}`, lower, upper, lowerAlpha, upperAlpha });
  return cases;
}
function physicalShadowFixture(testCase: PhysicalShadowCase) {
  const width = 6, height = 6, shared = (2 * width + 2) * 4, background = new Uint8Array(width * height * 4).fill(255);
  const make = (type: PhysicalShadowType, alpha: number, slot: 'lower' | 'upper') => {
    const name = `${type.prepared ? 'prepared' : 'raw'}-${type.shadow ? 'shadow' : 'object'} ${slot}`;
    const rgba = new Uint8Array(background.length), rgb = type.shadow ? [0, 0, 0] : [255, 255, 255];
    rgba.set([...rgb, alpha], shared); rgba.set([...rgb, alpha], (2 * width + (slot === 'lower' ? 1 : 3)) * 4);
    const pixels = rgba.slice(); if (!type.prepared) for (let p = 0; p < pixels.length; p += 4) if (pixels[p + 3]) pixels.set([255, 255, 255], p);
    const input: SourcePixelLayer = { id: slot, name, kind: 'transparent', visible: true, opacity: 1,
      preparedRgb: type.prepared, shadowOnly: type.shadow, maskSpace: 'source', bounds: { x: 0, y: 0, width: 1, height: 1 }, load: async () => pixels };
    return { input, known: { id: slot, name, kind: 'transparent' as const, x: 0, y: 0, width, height, visible: true, opacity: 1, rgba } };
  };
  const lower = make(testCase.lower, testCase.lowerAlpha, 'lower'), upper = make(testCase.upper, testCase.upperAlpha, 'upper');
  const expected: LayeredPsdDocument = { width, height, layers: [
    { id: 'bg', name: '可信背景', kind: 'background', x: 0, y: 0, width, height, visible: true, opacity: 1, rgba: background }, lower.known, upper.known,
  ] };
  const source = composeLayeredRgba(expected);
  // A raw lower matte cannot invent pixels hidden by an opaque upper layer.
  // Trusted prepared lower RGBA already has those independently known pixels.
  if (!testCase.lower.prepared && testCase.upperAlpha === 255) lower.known.rgba.fill(0, shared, shared + 4);
  const input = { width, height, source, backgroundMode: 'replace' as const, selection: { mode: 'whole' as const }, layers: [
    { id: 'bg', name: '可信背景', kind: 'background' as const, visible: true, opacity: 1, load: async () => background }, lower.input, upper.input,
  ] };
  return { input, source, expected, expectedReject: testCase.upperAlpha < 255 && (!testCase.lower.prepared || !testCase.upper.prepared),
    refinement: !testCase.lower.prepared ? lower.input.name : upper.input.name };
}
