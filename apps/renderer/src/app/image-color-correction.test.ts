import { describe, expect, it } from 'vitest';
import {
  AUTO_IMAGE_COLOR_CORRECTION,
  applyImageColorCorrectionToPixels,
  DEFAULT_IMAGE_COLOR_CORRECTION,
  imageColorCorrectionFilter,
  imageColorCorrectionMatrix,
  normalizeImageColorCorrection,
} from './image-color-correction';

describe('image color correction', () => {
  it('keeps old projects on the untouched original image', () => {
    expect(normalizeImageColorCorrection(undefined)).toEqual(DEFAULT_IMAGE_COLOR_CORRECTION);
    expect(imageColorCorrectionFilter(DEFAULT_IMAGE_COLOR_CORRECTION)).toBe('none');
  });

  it('provides a restrained anti-red and anti-magenta auto preset', () => {
    expect(AUTO_IMAGE_COLOR_CORRECTION).toMatchObject({ mode: 'auto', temperature: -6, tint: -10 });
    expect(imageColorCorrectionMatrix(AUTO_IMAGE_COLOR_CORRECTION)).toMatch(/^0\.956 0 0 0 0 0 1\.040/u);
    expect(imageColorCorrectionFilter(AUTO_IMAGE_COLOR_CORRECTION, 'correction')).toBe('url("#correction") saturate(0.96) contrast(1.02) brightness(1.00)');
  });

  it('bounds persisted custom values before they reach CSS', () => {
    expect(normalizeImageColorCorrection({
      mode: 'custom', temperature: -99, tint: 99, saturation: 200, contrast: 0, brightness: 300,
    })).toEqual({ mode: 'custom', temperature: -30, tint: 30, saturation: 130, contrast: 85, brightness: 120 });
  });

  it('reduces a red-purple cast while retaining alpha', () => {
    const corrected = applyImageColorCorrectionToPixels(new Uint8ClampedArray([220, 80, 180, 145]), AUTO_IMAGE_COLOR_CORRECTION);
    expect(corrected[0]).toBeLessThan(220);
    expect(corrected[1]).toBeGreaterThan(80);
    expect(corrected[2]).toBeLessThanOrEqual(180);
    expect(corrected[3]).toBe(145);
  });
});
