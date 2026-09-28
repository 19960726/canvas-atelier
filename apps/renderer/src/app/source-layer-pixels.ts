import { boxSchema, type LayeringBox } from './layering-selection';

/** The provider supplies a silhouette; RGB and placement always come from the source. */
export function extractOriginalLayer(source: Uint8Array, mask: Uint8Array, width: number, height: number, bounds: LayeringBox,
  maskSpace: 'source' | 'bounds' = 'bounds'): Uint8Array {
  boxSchema.parse(bounds);
  if (source.length !== width * height * 4 || mask.length !== source.length) throw new Error('原图与蒙版像素尺寸不一致');
  let peak = 0;
  for (let i = 3; i < mask.length; i += 4) peak = Math.max(peak, mask[i]!);
  if (!peak) throw new Error('返回的蒙版没有可见内容');
  // Newly requested mattes already use the full source canvas. A bounding box
  // describes the object; it is not a transform. Keep holes, fine detail and
  // continuous alpha instead of stretching/thresholding an already aligned matte.
  if (maskSpace === 'source') {
    let totalAlpha = 0, outsideAlpha = 0;
    // Analysis boxes are approximate, so tolerate small boundary errors but
    // reject a centered/enlarged model result instead of reshaping it silently.
    const marginX = Math.max(2 / width, bounds.width * .15), marginY = Math.max(2 / height, bounds.height * .15);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const alpha = mask[(y * width + x) * 4 + 3]!;
      totalAlpha += alpha;
      if ((x + .5) / width < bounds.x - marginX || (x + .5) / width > bounds.x + bounds.width + marginX
        || (y + .5) / height < bounds.y - marginY || (y + .5) / height > bounds.y + bounds.height + marginY) outsideAlpha += alpha;
    }
    if (outsideAlpha > totalAlpha * .2) {
      // A provider matte can contain a second object outside the requested
      // search box. Keep the requested object when the matte also has real
      // coverage inside the box; discard only the out-of-scope alpha. A matte
      // with no in-scope coverage remains a hard placement failure.
      const canvasAlpha = width * height * 255;
      if (outsideAlpha >= totalAlpha || totalAlpha >= canvasAlpha * .95) {
        throw new Error('返回蒙版与标注的原图位置不符，请检查返图或校正位置；未自动拉伸物体');
      }
    }
    const result = source.slice();
    for (let i = 0; i < result.length; i += 4) {
      const x = (i / 4) % width, y = Math.floor(i / 4 / width);
      if ((x + .5) / width < bounds.x - marginX || (x + .5) / width > bounds.x + bounds.width + marginX
        || (y + .5) / height < bounds.y - marginY || (y + .5) / height > bounds.y + bounds.height + marginY) {
        result.fill(0, i, i + 4);
        continue;
      }
      result[i + 3] = Math.round(source[i + 3]! * mask[i + 3]! / 255);
      if (!result[i + 3]) result.fill(0, i, i + 4);
    }
    return result;
  }
  // Discard diffuse generated halos and isolated background speckles. The source
  // already contains the original edge pixels, so the provider alpha is only a
  // coarse silhouette signal.
  const cleanedMask = refineMaskAlpha(mask, width, height, peak);
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (cleanedMask[(y * width + x) * 4 + 3] === 0) continue;
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  const x0 = Math.max(0, Math.round(bounds.x * width)), y0 = Math.max(0, Math.round(bounds.y * height));
  const x1 = Math.min(width, Math.round((bounds.x + bounds.width) * width)), y1 = Math.min(height, Math.round((bounds.y + bounds.height) * height));
  if (x1 <= x0 || y1 <= y0 || right < left) throw new Error('请标注该图层在原图中的有效范围');
  const result = new Uint8Array(source.length);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const mx = Math.min(right, left + Math.floor((x - x0 + .5) * (right - left + 1) / (x1 - x0)));
    const my = Math.min(bottom, top + Math.floor((y - y0 + .5) * (bottom - top + 1) / (y1 - y0)));
    if (cleanedMask[(my * width + mx) * 4 + 3] === 0) continue;
    const offset = (y * width + x) * 4;
    result.set(source.subarray(offset, offset + 4), offset);
  }
  return result;
}

/** Convert provider alpha to a binary silhouette while removing soft halos and isolated pixels. */
export function refineMaskAlpha(mask: Uint8Array, width: number, height: number, peak = findAlphaPeak(mask)): Uint8Array {
  if (mask.length !== width * height * 4 || width < 1 || height < 1) throw new Error('蒙版像素尺寸无效');
  const threshold = Math.max(1, Math.ceil(peak * .7));
  const result = mask.slice();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    if (mask[offset + 3]! < threshold) { result[offset + 3] = 0; continue; }
    let neighbors = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < width && ny >= 0 && ny < height && mask[(ny * width + nx) * 4 + 3]! >= threshold) neighbors++;
    }
    result[offset + 3] = neighbors >= 2 ? 255 : 0;
  }
  return result;
}

function findAlphaPeak(mask: Uint8Array): number {
  let peak = 0;
  for (let i = 3; i < mask.length; i += 4) peak = Math.max(peak, mask[i]!);
  return peak;
}

/** Only replace pixels actually lifted into foregrounds. Visible layers reconstruct the original. */
export function fillRemovedLayerBackground(source: Uint8Array, generated: Uint8Array, cutouts: readonly Uint8Array[]): Uint8Array {
  if (generated.length !== source.length || cutouts.some(layer => layer.length !== source.length)) throw new Error('背景补全像素尺寸不一致');
  const result = source.slice();
  for (let i = 0; i < source.length; i += 4) {
    if (!cutouts.some(layer => layer[i + 3] !== 0)) continue;
    result.set(generated.subarray(i, i + 4), i);
  }
  return result;
}
