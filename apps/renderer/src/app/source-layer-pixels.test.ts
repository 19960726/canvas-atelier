import { describe, expect, it } from 'vitest';
import { extractOriginalLayer, fillRemovedLayerBackground, refineMaskAlpha } from './source-layer-pixels';
import { composeLayeredRgba } from './layered-psd';

describe('original pixel cutouts', () => {
  it('reports a source-space matte enlarged beyond the selected object instead of silently rescaling it', () => {
    const source = new Uint8Array(32 * 32 * 4).fill(255);
    expect(() => extractOriginalLayer(source, source, 32, 32,
      { x: .6, y: .6, width: .2, height: .2 }, 'source')).toThrow(/蒙版.*原图位置/);
  });
  it('keeps a source-space matte at its actual coordinates and retains partial alpha and fine details', () => {
    const source = new Uint8Array(8 * 8 * 4).fill(255);
    const mask = new Uint8Array(source.length);
    mask.set([255, 255, 255, 96], (2 * 8 + 5) * 4);
    mask.set([255, 255, 255, 255], (3 * 8 + 5) * 4);
    const cut = extractOriginalLayer(source, mask, 8, 8, { x: .25, y: .25, width: .5, height: .5 }, 'source');
    expect(cut[(2 * 8 + 5) * 4 + 3]).toBe(96);
    expect(cut[(3 * 8 + 5) * 4 + 3]).toBe(255);
    expect(cut[(4 * 8 + 4) * 4 + 3]).toBe(0);
    expect(Array.from(cut).filter((value, i) => i % 4 === 3 && value)).toHaveLength(2);
  });
  it('clips a mixed matte to the annotated search area without rescaling the in-scope pixels', () => {
    const source = new Uint8Array(16 * 16 * 4).fill(255);
    const mask = new Uint8Array(source.length);
    mask[(4 * 16 + 4) * 4 + 3] = 255;
    mask[(15 * 16 + 15) * 4 + 3] = 255;
    const cut = extractOriginalLayer(source, mask, 16, 16, { x: .125, y: .125, width: .5, height: .5 }, 'source');
    expect(cut[(4 * 16 + 4) * 4 + 3]).toBe(255);
    expect(cut[(15 * 16 + 15) * 4 + 3]).toBe(0);
  });
  it('removes soft halo and isolated mask speckles before extracting source pixels', () => {
    const mask = new Uint8Array(7 * 7 * 4);
    for (let y = 2; y <= 4; y++) for (let x = 2; x <= 4; x++) mask[(y * 7 + x) * 4 + 3] = 255;
    mask[(1 * 7 + 1) * 4 + 3] = 255;
    mask[(1 * 7 + 2) * 4 + 3] = 100;
    const cleaned = refineMaskAlpha(mask, 7, 7);
    expect(cleaned[(1 * 7 + 1) * 4 + 3]).toBe(0);
    expect(cleaned[(1 * 7 + 2) * 4 + 3]).toBe(0);
    expect(cleaned[(3 * 7 + 3) * 4 + 3]).toBe(255);
  });
  it('uses original pixels at original coordinates even when the returned object fills the canvas', () => {
    const width = 8, height = 8;
    const original = Uint8Array.from(Array.from({ length: 64 }, (_, i) => [i, 90, 180, 255]).flat());
    const mask = new Uint8Array(64 * 4);
    for (let y = 1; y < 7; y++) for (let x = 1; x < 7; x++) mask.set([255, 0, 0, 255], (y * 8 + x) * 4);
    const cut = extractOriginalLayer(original, mask, width, height, { x: .5, y: .5, width: .25, height: .25 });
    expect([...cut.slice((4 * 8 + 4) * 4, (4 * 8 + 4) * 4 + 4)]).toEqual([36, 90, 180, 255]);
    expect(cut[3]).toBe(0);
    expect(Array.from(cut).filter((_, i) => i % 4 === 3 && cut[i] !== 0)).toHaveLength(4);
    const generatedBackground = new Uint8Array(original.length).fill(240);
    const background = fillRemovedLayerBackground(original, generatedBackground, [cut]);
    const layer = (id: string, kind: 'background' | 'transparent', rgba: Uint8Array) => ({ id, name: id, kind, x: 0, y: 0, width, height, visible: true, opacity: 1, rgba });
    expect(composeLayeredRgba({ width, height, layers: [layer('base', 'background', background), layer('object', 'transparent', cut)] })).toEqual(original);
    expect(background.slice(0, 4)).toEqual(original.slice(0, 4));
  });
  it('rejects missing or invalid original bounds instead of silently centering a generated object', () => {
    expect(() => extractOriginalLayer(new Uint8Array(64), new Uint8Array(64), 4, 4, undefined as never)).toThrow();
  });
});
