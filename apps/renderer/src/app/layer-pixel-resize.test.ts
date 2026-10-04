import { describe, expect, it } from 'vitest';
import { resizeLayerPixels } from './layer-pixel-resize';

describe('independent RGBA resizing', () => {
  it('keeps native PNG pixels byte exact, including invisible RGB', () => {
    const rgba = new Uint8Array([37, 83, 129, 0, 100, 150, 200, 32]);
    expect(resizeLayerPixels(rgba, 2, 1, 2, 1)).toBe(rgba);
  });
  it.each([0, 1, 32, 64, 128, 255])('preserves uniform independent color at alpha %i through a provider resolution change', alpha => {
    const rgba = new Uint8Array([37, 83, 129, alpha, 37, 83, 129, alpha]);
    const result = resizeLayerPixels(rgba, 2, 1, 6, 3);
    for (let at = 0; at < result.length; at += 4) expect([...result.subarray(at, at + 4)]).toEqual([37, 83, 129, alpha]);
  });
  it('weights foreground color by coverage without introducing invisible blue into a visible red edge', () => {
    const result = resizeLayerPixels(new Uint8Array([200, 20, 10, 64, 0, 0, 255, 0]), 2, 1, 4, 2);
    expect([...result.subarray(0, 16)]).toEqual([200, 20, 10, 64, 200, 20, 10, 48, 200, 20, 10, 16, 0, 0, 255, 0]);
  });
  it('uses physical contributions of both translucent colors before one final quantization', () => {
    const result = resizeLayerPixels(new Uint8Array([255, 0, 0, 32, 0, 0, 255, 96]), 2, 1, 4, 2);
    expect([...result.subarray(4, 12)]).toEqual([128, 0, 128, 48, 26, 0, 230, 80]);
  });
  it.each([32, 255])('retains a narrow droplet at alpha %i when reducing resolution beyond two times', alpha => {
    const rgba = new Uint8Array(6 * 6 * 4);
    rgba.set([37, 83, 129, alpha], (2 * 6 + 2) * 4);
    const result = resizeLayerPixels(rgba, 6, 6, 2, 2);
    expect([...result.subarray(0, 4)]).toEqual([37, 83, 129, Math.round(alpha / 9)]);
    expect([...result.subarray(4)]).toEqual(new Array(12).fill(0));
  });
  it('rejects incompatible geometry and excessive allocation before processing', () => {
    expect(() => resizeLayerPixels(new Uint8Array(8), 2, 1, 2, 2)).toThrow(/画幅比例/);
    expect(() => resizeLayerPixels(new Uint8Array(8), 2, 1, 10000, 5000)).toThrow(/范围/);
  });
});
