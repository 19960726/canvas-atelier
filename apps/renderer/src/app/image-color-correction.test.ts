import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_IMAGE_COLOR_CORRECTION,
  ORIGINAL_IMAGE_COLOR_CORRECTION,
  analyzeImageColorCorrection,
  applyImageColorCorrectionToPixels,
  DEFAULT_IMAGE_COLOR_CORRECTION,
  imageColorCorrectionFilter,
  imageColorCorrectionMatrix,
  normalizeImageColorCorrection,
  resolveImageColorCorrection,
  renderImageColorCorrectionBlob,
} from './image-color-correction';

function pixels(colors: readonly (readonly number[])[], repetitions = 64) {
  return new Uint8ClampedArray(Array.from({ length: repetitions }, () => colors.flat()).flat());
}

function chroma(pixel: ArrayLike<number>): number {
  return Math.max(pixel[0]!, pixel[1]!, pixel[2]!) - Math.min(pixel[0]!, pixel[1]!, pixel[2]!);
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('image color correction', () => {
  it('keeps new and legacy untouched results on their original pixels until the user opts in', () => {
    expect(normalizeImageColorCorrection(undefined).mode).toBe('original');
    expect(DEFAULT_IMAGE_COLOR_CORRECTION.mode).toBe('original');
    expect(normalizeImageColorCorrection({ mode: 'original', temperature: 0, tint: 0, saturation: 100, contrast: 100, brightness: 100 }).mode).toBe('original');
    expect(normalizeImageColorCorrection({ ...AUTO_IMAGE_COLOR_CORRECTION, version: 1 }).mode).toBe('original');
    expect(normalizeImageColorCorrection(AUTO_IMAGE_COLOR_CORRECTION).mode).toBe('auto');
  });

  it('retains an explicit original choice through a save and reload', () => {
    const saved = JSON.parse(JSON.stringify(ORIGINAL_IMAGE_COLOR_CORRECTION));
    expect(normalizeImageColorCorrection(saved).mode).toBe('original');
    expect(imageColorCorrectionFilter(normalizeImageColorCorrection(saved))).toBe('none');
  });

  it('bounds persisted custom values before they reach CSS', () => {
    expect(normalizeImageColorCorrection({
      mode: 'custom', temperature: -99, tint: 99, saturation: 200, contrast: 0, brightness: 300,
    })).toMatchObject({ mode: 'custom', temperature: -30, tint: 30, saturation: 130, contrast: 85, brightness: 120 });
  });

  it.each([
    [[204, 180, 180, 255], [153, 135, 135, 255]],
    [[204, 180, 201, 255], [153, 135, 151, 255]],
  ])('derives correction from a widespread red or purple cast and reduces its pixel chroma', (light, shadow) => {
    const sample = pixels([light, shadow]);
    const correction = analyzeImageColorCorrection(sample);
    const corrected = applyImageColorCorrectionToPixels(sample, correction);
    expect(correction.mode).toBe('auto');
    expect(correction.tint).toBeLessThan(0);
    expect(chroma(corrected)).toBeLessThan(chroma(light) * 0.4);
    expect(corrected[3]).toBe(255);
  });

  it('adapts the correction amount and temperature independently to each image', () => {
    const red = analyzeImageColorCorrection(pixels([[204, 180, 180, 255]]));
    const magenta = analyzeImageColorCorrection(pixels([[204, 180, 204, 255]]));
    const mild = analyzeImageColorCorrection(pixels([[190, 180, 190, 255]]));
    expect(red.temperature).toBeLessThan(magenta.temperature);
    expect(Math.abs(mild.tint)).toBeLessThan(Math.abs(magenta.tint));
  });

  it.each([
    [[[200, 200, 200, 255], [100, 100, 100, 255]]],
    [[[220, 35, 130, 255], [50, 100, 230, 255], [50, 210, 40, 255]]],
    [[[200, 180, 152, 255], [150, 125, 103, 255]]],
    [[[204, 180, 204, 0], [140, 140, 140, 255]]],
    [[[10, 6, 10, 255], [255, 230, 255, 255]]],
  ])('does not tint neutral, deliberate saturated/warm, transparent or clipped images', (colors) => {
    const sample = pixels(colors);
    const correction = analyzeImageColorCorrection(sample);
    expect(imageColorCorrectionFilter(correction, 'neutral')).toBe('none');
    expect(applyImageColorCorrectionToPixels(sample, correction)).toEqual(sample);
  });

  it('uses existing neutral anchors to protect a colored subject from global desaturation', () => {
    const sample = pixels([[205, 180, 204, 255], [180, 180, 180, 255], [110, 110, 110, 255]]);
    expect(analyzeImageColorCorrection(sample)).toEqual(AUTO_IMAGE_COLOR_CORRECTION);
  });

  it.each([
    [255, 255, 255, 255],
    [250, 250, 250, 255],
    [250, 247, 249, 255],
    [248, 248, 248, 255],
    [245, 242, 244, 255],
  ])('preserves a pale pink product on a neutral white or near-white studio background (%s,%s,%s)', (red, green, blue, alpha) => {
    const colors = [...Array.from({ length: 65 }, () => [red, green, blue, alpha]),
      ...Array.from({ length: 35 }, () => [230, 198, 222, 255])];
    const sample = pixels(colors, 1);
    const correction = analyzeImageColorCorrection(sample);
    expect(correction).toEqual(AUTO_IMAGE_COLOR_CORRECTION);
    expect(imageColorCorrectionFilter(correction, 'white-studio')).toBe('none');
    expect(applyImageColorCorrectionToPixels(sample, correction)).toEqual(sample);
  });

  it('keeps CSS channel gains and exported pixels on the same sRGB transform', () => {
    const correction = analyzeImageColorCorrection(pixels([[204, 180, 200, 255]]));
    const matrix = imageColorCorrectionMatrix(correction).split(' ').map(Number);
    expect(matrix).toHaveLength(20);
    expect(matrix.slice(15)).toEqual([0, 0, 0, 1, 0]);
    const source = new Uint8ClampedArray([200, 180, 198, 145]);
    const output = applyImageColorCorrectionToPixels(source, correction);
    expect(output[0]).toBe(Math.round(source[0]! * matrix[0]!));
    expect(output[1]).toBe(Math.round(source[1]! * matrix[6]!));
    expect(output[2]).toBe(Math.round(source[2]! * matrix[12]!));
    expect(output[3]).toBe(145);
  });

  it('samples at most 96 by 96 pixels and shares one analysis across previews and exports', async () => {
    const sample = pixels([[204, 180, 204, 255]], 96 * 48);
    const drawImage = vi.fn();
    const getImageData = vi.fn(() => ({ data: sample }));
    const context = { drawImage, getImageData };
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getContext').mockReturnValue(context as never);
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string, options?: ElementCreationOptions) => tag === 'canvas' ? canvas : createElement(tag, options)) as typeof document.createElement);
    let loadCount = 0;
    vi.stubGlobal('Image', class {
      naturalWidth = 8000;
      naturalHeight = 4000;
      onload: (() => void) | null = null;
      set src(_value: string) { loadCount += 1; queueMicrotask(() => this.onload?.()); }
    });
    const source = 'novus-asset://analysis/bounded-and-shared';
    const [first, second] = await Promise.all([
      resolveImageColorCorrection(source, AUTO_IMAGE_COLOR_CORRECTION),
      resolveImageColorCorrection(source, AUTO_IMAGE_COLOR_CORRECTION),
    ]);
    expect(first).toEqual(second);
    expect(first.tint).toBeLessThan(0);
    expect(loadCount).toBe(1);
    expect(canvas.width).toBe(96);
    expect(canvas.height).toBe(48);
    expect(getImageData).toHaveBeenCalledExactlyOnceWith(0, 0, 96, 48);

    // Full image processing happens only when exporting; its transform is
    // the same cached analysis already used by the preview.
    const originalPixels = new Uint8ClampedArray([204, 180, 204, 145]);
    const exportedPixels = new Uint8ClampedArray(originalPixels);
    getImageData.mockReturnValue({ data: exportedPixels });
    Object.assign(context, { putImageData: vi.fn() });
    vi.spyOn(canvas, 'toBlob').mockImplementation((callback) => callback(new Blob([exportedPixels], { type: 'image/png' })));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['source']) })));
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1, height: 1, close })));
    const exported = await renderImageColorCorrectionBlob(source, AUTO_IMAGE_COLOR_CORRECTION);
    expect(new Uint8ClampedArray(await exported.arrayBuffer())).toEqual(applyImageColorCorrectionToPixels(originalPixels, first));
    expect(loadCount).toBe(1);
    expect(close).toHaveBeenCalledOnce();
  });

  it('preserves custom and explicit original choices without loading pixels', async () => {
    const image = vi.fn();
    vi.stubGlobal('Image', image);
    const custom = normalizeImageColorCorrection({ mode: 'custom', tint: 12, temperature: 8 });
    expect(await resolveImageColorCorrection('unused', custom)).toEqual(custom);
    expect(await resolveImageColorCorrection('unused', ORIGINAL_IMAGE_COLOR_CORRECTION)).toEqual(ORIGINAL_IMAGE_COLOR_CORRECTION);
    expect(image).not.toHaveBeenCalled();
  });

  it('encodes an unchanged automatic JPEG export as PNG to match the corrected download extension', async () => {
    vi.stubGlobal('Image', class {
      onerror: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onerror?.()); }
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['jpeg'], { type: 'image/jpeg' }) })));
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() })));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray([180, 180, 180, 255]) }), putImageData: vi.fn() } as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback, type) => callback(new Blob(['png'], { type })));
    expect((await renderImageColorCorrectionBlob('novus-asset://analysis/neutral-jpeg', AUTO_IMAGE_COLOR_CORRECTION)).type).toBe('image/png');
  });

  it('fails safely to unchanged pixels if image analysis cannot read the source', async () => {
    vi.stubGlobal('Image', class {
      onerror: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onerror?.()); }
    });
    expect(await resolveImageColorCorrection('novus-asset://analysis/unreadable', AUTO_IMAGE_COLOR_CORRECTION)).toEqual(AUTO_IMAGE_COLOR_CORRECTION);
  });
});
