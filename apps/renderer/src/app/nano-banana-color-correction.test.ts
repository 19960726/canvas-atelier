import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_IMAGE_COLOR_CORRECTION, ORIGINAL_IMAGE_COLOR_CORRECTION,
  analyzeImageColorCorrection, applyImageColorCorrectionToPixels,
  normalizeImageColorCorrection, normalizeImageColorCorrections,
  resolveImageColorCorrection, renderImageColorCorrectionBlob,
} from './image-color-correction';

const nano = { ...AUTO_IMAGE_COLOR_CORRECTION, profile: 'nano-banana' as const, strength: 60 };
const sample = (colors: number[][]) => new Uint8ClampedArray(Array.from({ length: 64 }, () => colors.flat()).flat());
const chroma = (p: ArrayLike<number>) => Math.max(p[0]!, p[1]!, p[2]!) - Math.min(p[0]!, p[1]!, p[2]!);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('opt-in Nano Banana correction', () => {
  it.each([[218, 202, 180, 255], [210, 184, 183, 255], [204, 180, 201, 255], [204, 180, 204, 255]])('reduces red/purple/yellow cast while keeping real warm material and red product colors', (r, g, b, a) => {
    const input = sample([[r, g, b, a], [r * .8, g * .8, b * .8, 255], [190, 26, 22, 255], [144, 97, 61, 255]]);
    const correction = analyzeImageColorCorrection(input, 'nano-banana');
    const output = applyImageColorCorrectionToPixels(input, correction);
    expect(chroma(output)).toBeLessThan(chroma(input) * .8);
    expect(chroma(output)).toBeGreaterThan(chroma(input) * .35);
    expect(output[8]).toBeGreaterThanOrEqual(181);
    expect(output[12]! - output[14]!).toBeGreaterThan(74);
    expect(correction.saturation).toBe(100);
  });
  it('preserves original defaults and stores the preset and bounded strength by asset identity', () => {
    const saved = JSON.parse(JSON.stringify({ a: nano, b: ORIGINAL_IMAGE_COLOR_CORRECTION }));
    expect(normalizeImageColorCorrections(saved, undefined, ['b', 'a'])).toMatchObject({ a: { profile: 'nano-banana', strength: 60 }, b: { mode: 'original' } });
    expect(normalizeImageColorCorrection({ ...nano, strength: 999 })).toMatchObject({ strength: 100 });
    expect(normalizeImageColorCorrection({ ...nano, strength: -2 })).toMatchObject({ strength: 0 });
    expect(normalizeImageColorCorrection(undefined).mode).toBe('original');
  });
  it.each([
    [[230, 230, 230, 255], [210, 184, 183, 255]],
    [[190, 26, 22, 255], [144, 97, 61, 255]],
    [[240, 225, 198, 255], [200, 220, 240, 255]],
  ])('does not force a correction for neutral anchors, saturated material or mixed lighting', (...colors) => {
    const input = sample(colors);
    expect(applyImageColorCorrectionToPixels(input, analyzeImageColorCorrection(input, 'nano-banana'))).toEqual(input);
  });
  it('reuses analysis across strength changes, separates generic analysis and exports the same correction', async () => {
    const input = sample([[218, 202, 180, 255], [174, 162, 144, 255]]);
    let loads = 0;
    vi.stubGlobal('Image', class {
      naturalWidth = 100; naturalHeight = 100; onload: (() => void) | null = null;
      set src(_value: string) { loads++; queueMicrotask(() => this.onload?.()); }
    });
    const context = { drawImage: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray(input) }), putImageData: vi.fn() };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
    const url = 'novus-asset://nano/strength-export';
    const zero = await resolveImageColorCorrection(url, { ...nano, strength: 0 });
    const medium = await resolveImageColorCorrection(url, nano);
    const full = await resolveImageColorCorrection(url, { ...nano, strength: 100 });
    expect(applyImageColorCorrectionToPixels(input, zero)).toEqual(input);
    expect(chroma(applyImageColorCorrectionToPixels(input, full))).toBeLessThan(chroma(applyImageColorCorrectionToPixels(input, medium)));
    expect(loads).toBe(1);
    const generic = await resolveImageColorCorrection(url, AUTO_IMAGE_COLOR_CORRECTION);
    expect(generic).not.toEqual(full);
    expect(loads).toBe(2);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['source']) })));
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 100, height: 100, close: vi.fn() })));
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(new Blob(['png'], { type: 'image/png' })));
    await renderImageColorCorrectionBlob(url, nano);
    expect(context.putImageData.mock.calls[0]![0].data).toEqual(applyImageColorCorrectionToPixels(input, medium));
    expect(loads).toBe(2);
  });
});
