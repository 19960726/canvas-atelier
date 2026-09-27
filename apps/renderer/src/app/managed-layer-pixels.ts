import { compatibleLayerDimensions } from './layering-selection';
import { decodeImageWithTimeout } from './decode-image-timeout';

export async function decodeLayerPixels(url: string, width: number, height: number): Promise<Uint8Array> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192
    || width * height * 4 > 128 * 1024 * 1024) throw new Error('原图尺寸超出当前分层处理范围');
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.src = url;
  try {
    await decodeImageWithTimeout(image);
    if (!compatibleLayerDimensions(image.naturalWidth, image.naturalHeight, width, height)) throw new Error('返回图层的画幅比例与原图不符');
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    try {
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('当前环境无法读取图层像素');
      context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, width, height);
      return new Uint8Array(context.getImageData(0, 0, width, height).data);
    } finally { canvas.width = 0; canvas.height = 0; }
  } finally { image.src = ''; }
}

export function layerPixelsUrl(rgba: Uint8Array, width: number, height: number): string {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前环境无法显示图层像素');
    const data = context.createImageData(width, height); data.data.set(rgba);
    context.putImageData(data, 0, 0);
    return canvas.toDataURL('image/png');
  } finally { canvas.width = 0; canvas.height = 0; }
}
