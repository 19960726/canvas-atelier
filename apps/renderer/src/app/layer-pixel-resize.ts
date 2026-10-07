import { compatibleLayerDimensions } from './layering-selection';

/** Resample in floating point associated color, then quantize only the final
 * independent RGBA. An 8-bit premultiplied intermediate loses low-alpha RGB. */
export function resizeLayerPixels(rgba: Uint8Array, sourceWidth: number, sourceHeight: number, width: number, height: number): Uint8Array {
  for (const [w, h] of [[sourceWidth, sourceHeight], [width, height]] as const) {
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 8192 || h > 8192
      || w * h * 4 > 128 * 1024 * 1024) throw new Error('原图尺寸超出当前分层处理范围');
  }
  if (rgba.length !== sourceWidth * sourceHeight * 4) throw new Error('图层 PNG 像素长度不符');
  if (!compatibleLayerDimensions(sourceWidth, sourceHeight, width, height)) throw new Error('返回图层的画幅比例与原图不符');
  if (sourceWidth === width && sourceHeight === height) return rgba;
  if (width < sourceWidth || height < sourceHeight) return downsampleLayerPixels(rgba, sourceWidth, sourceHeight, width, height);
  const result = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.max(0, Math.min(sourceHeight - 1, (y + .5) * sourceHeight / height - .5));
    const y0 = Math.floor(sy), y1 = Math.min(sourceHeight - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < width; x++) {
      const sx = Math.max(0, Math.min(sourceWidth - 1, (x + .5) * sourceWidth / width - .5));
      const x0 = Math.floor(sx), x1 = Math.min(sourceWidth - 1, x0 + 1), fx = sx - x0;
      const i0 = (y0 * sourceWidth + x0) * 4, i1 = (y0 * sourceWidth + x1) * 4;
      const i2 = (y1 * sourceWidth + x0) * 4, i3 = (y1 * sourceWidth + x1) * 4;
      const w0 = (1 - fy) * (1 - fx), w1 = (1 - fy) * fx, w2 = fy * (1 - fx), w3 = fy * fx;
      const a0 = rgba[i0 + 3]! * w0, a1 = rgba[i1 + 3]! * w1;
      const a2 = rgba[i2 + 3]! * w2, a3 = rgba[i3 + 3]! * w3;
      const alpha = a0 + a1 + a2 + a3;
      const target = (y * width + x) * 4;
      result[target + 3] = Math.round(alpha);
      for (let channel = 0; channel < 3; channel++) {
        const color = alpha > 0
          ? rgba[i0 + channel]! * a0 + rgba[i1 + channel]! * a1 + rgba[i2 + channel]! * a2 + rgba[i3 + channel]! * a3
          : rgba[i0 + channel]! * w0 + rgba[i1 + channel]! * w1 + rgba[i2 + channel]! * w2 + rgba[i3 + channel]! * w3;
        result[target + channel] = Math.round(alpha > 0 ? color / alpha : color);
      }
    }
  }
  return result;
}

/** Area coverage preserves narrow droplets that point sampling can skip. */
function downsampleLayerPixels(rgba: Uint8Array, sourceWidth: number, sourceHeight: number, width: number, height: number): Uint8Array {
  const result = new Uint8Array(width * height * 4);
  const scaleX = sourceWidth / width, scaleY = sourceHeight / height, area = scaleX * scaleY;
  for (let y = 0; y < height; y++) {
    const top = y * scaleY, bottom = Math.min(sourceHeight, (y + 1) * scaleY);
    for (let x = 0; x < width; x++) {
      const left = x * scaleX, right = Math.min(sourceWidth, (x + 1) * scaleX);
      let alpha = 0, red = 0, green = 0, blue = 0, hiddenRed = 0, hiddenGreen = 0, hiddenBlue = 0;
      for (let sy = Math.floor(top); sy < Math.ceil(bottom); sy++) {
        const weightY = Math.min(bottom, sy + 1) - Math.max(top, sy);
        for (let sx = Math.floor(left); sx < Math.ceil(right); sx++) {
          const weight = weightY * (Math.min(right, sx + 1) - Math.max(left, sx));
          const source = (sy * sourceWidth + sx) * 4, contribution = rgba[source + 3]! * weight;
          alpha += contribution;
          red += rgba[source]! * contribution; green += rgba[source + 1]! * contribution; blue += rgba[source + 2]! * contribution;
          hiddenRed += rgba[source]! * weight; hiddenGreen += rgba[source + 1]! * weight; hiddenBlue += rgba[source + 2]! * weight;
        }
      }
      const target = (y * width + x) * 4;
      result[target] = Math.round(alpha > 0 ? red / alpha : hiddenRed / area);
      result[target + 1] = Math.round(alpha > 0 ? green / alpha : hiddenGreen / area);
      result[target + 2] = Math.round(alpha > 0 ? blue / alpha : hiddenBlue / area);
      result[target + 3] = Math.round(alpha / area);
    }
  }
  return result;
}
