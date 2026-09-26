import { compatibleLayerDimensions } from './layering-selection';
const MAX_SIDE = 8_192;
const MAX_RGBA_BYTES = 256 * 1024 * 1024;

export type LayerQualityVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'decode' | 'media_type' | 'dimensions' | 'alpha_empty' | 'alpha_opaque' | 'background_holes' };

export async function validateLayerPixels(
  kind: 'background' | 'transparent',
  mediaType: string,
  width: number,
  height: number,
  rgba: Uint8Array,
  expectedWidth: number,
  expectedHeight: number,
): Promise<LayerQualityVerdict> {
  if (mediaType !== 'image/png' && mediaType !== 'image/webp') return { ok: false, reason: 'media_type' };
  if (!isValidDimension(width) || !isValidDimension(height)
    || !isValidDimension(expectedWidth) || !isValidDimension(expectedHeight)
    || !compatibleLayerDimensions(width, height, expectedWidth, expectedHeight)) return { ok: false, reason: 'dimensions' };
  const expectedBytes = width * height * 4;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes > MAX_RGBA_BYTES || rgba.byteLength !== expectedBytes) {
    return { ok: false, reason: 'decode' };
  }

  let hasTransparent = false;
  let hasVisible = false;
  let hasBackgroundHole = false;
  const pixelsPerSlice = 1_000_000;
  const pixelCount = rgba.length / 4;
  for (let start = 0; start < pixelCount; start += pixelsPerSlice) {
    const end = Math.min(pixelCount, start + pixelsPerSlice);
    for (let pixel = start; pixel < end; pixel += 1) {
      const alpha = rgba[pixel * 4 + 3]!;
      if (alpha < 255) hasBackgroundHole = true;
      if (alpha === 0) hasTransparent = true;
      if (alpha > 0) hasVisible = true;
      if (kind === 'background' && hasBackgroundHole) return { ok: false, reason: 'background_holes' };
      if (kind === 'transparent' && hasTransparent && hasVisible) return { ok: true };
    }
    if (end < pixelCount) await yieldToEventLoop();
  }
  if (kind === 'background') return { ok: true };
  if (!hasVisible) return { ok: false, reason: 'alpha_empty' };
  if (!hasTransparent) return { ok: false, reason: 'alpha_opaque' };
  return { ok: true };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

function isValidDimension(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= MAX_SIDE;
}
