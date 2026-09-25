import { describe, expect, it } from 'vitest';
import { validateLayerPixels } from './layering-quality';

function rgba(alpha: readonly number[]): Uint8Array {
  return new Uint8Array(alpha.flatMap((value) => [40, 90, 130, value]));
}

describe('generated image layer quality gate', () => {
  it('accepts a fully opaque full-canvas background', async () => {
    await expect(validateLayerPixels('background', 'image/png', 2, 2, rgba([255, 255, 255, 255]), 2, 2)).resolves.toEqual({ ok: true });
  });

  it('accepts a transparent foreground containing both clear and visible pixels', async () => {
    await expect(validateLayerPixels('transparent', 'image/webp', 2, 2, rgba([0, 80, 210, 255]), 2, 2)).resolves.toEqual({ ok: true });
  });

  it('rejects JPEG data for an editable layer', async () => {
    await expect(validateLayerPixels('transparent', 'image/jpeg', 2, 2, rgba([0, 255, 0, 255]), 2, 2)).resolves.toEqual({ ok: false, reason: 'media_type' });
  });

  it('rejects a layer with the wrong decoded dimensions', async () => {
    await expect(validateLayerPixels('transparent', 'image/png', 1, 2, rgba([0, 255]), 2, 2)).resolves.toEqual({ ok: false, reason: 'dimensions' });
  });

  it('rejects an all-transparent foreground', async () => {
    await expect(validateLayerPixels('transparent', 'image/png', 2, 2, rgba([0, 0, 0, 0]), 2, 2)).resolves.toEqual({ ok: false, reason: 'alpha_empty' });
  });

  it('rejects a fully opaque foreground because it has no transparent area', async () => {
    await expect(validateLayerPixels('transparent', 'image/png', 2, 2, rgba([255, 255, 255, 255]), 2, 2)).resolves.toEqual({ ok: false, reason: 'alpha_opaque' });
  });

  it('rejects transparent pixels in a full-canvas background', async () => {
    await expect(validateLayerPixels('background', 'image/png', 2, 2, rgba([255, 255, 0, 255]), 2, 2)).resolves.toEqual({ ok: false, reason: 'background_holes' });
  });

  it('rejects an undecodable RGBA buffer length', async () => {
    await expect(validateLayerPixels('transparent', 'image/png', 2, 2, rgba([0, 255]), 2, 2)).resolves.toEqual({ ok: false, reason: 'decode' });
  });
});
