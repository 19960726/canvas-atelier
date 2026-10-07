import { compatibleLayerDimensions } from './layering-selection';
import { decodeImageWithTimeout } from './decode-image-timeout';
import { readImageSourceBlob } from './image-source-blob';
import { decodeLayerPng, encodeLayerPng } from './layer-png-codec';
import { resizeLayerPixels } from './layer-pixel-resize';

type DecodedPng = { width: number; height: number; rgba: Uint8Array };
type PngRequest = { type: 'decode'; bytes: ArrayBuffer; width: number; height: number } | { type: 'encode'; rgba: ArrayBuffer; width: number; height: number };
type PngResponse = { id: number; type: 'decoded'; result: { width: number; height: number; rgba: ArrayBuffer } | null }
  | { id: number; type: 'encoded'; bytes: ArrayBuffer } | { id: number; type: 'error'; error: string };
const pixelTimeoutMs = 30_000;

function validateDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192
    || width * height * 4 > 128 * 1024 * 1024) throw new Error('原图尺寸超出当前分层处理范围');
}

/** Each operation owns a short-lived worker. Failure must not fall back to the
 * lossy Canvas path; the existing result remains available to the caller. */
function runPngWorker(request: PngRequest): Promise<PngResponse> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./layer-png-worker.ts', import.meta.url), { type: 'module' });
    let settled = false;
    const finish = (response: PngResponse | null, error?: Error) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      worker.terminate();
      if (error) reject(error); else resolve(response!);
    };
    const timeout = globalThis.setTimeout(() => finish(null, new Error('图层 PNG 像素处理超时，请重试')), pixelTimeoutMs);
    worker.onmessage = (event: MessageEvent<PngResponse>) => {
      const result = event.data;
      if (result?.id !== 1 || !['decoded', 'encoded', 'error'].includes(result.type)) {
        finish(null, new Error('图层 PNG 像素处理返回无效结果')); return;
      }
      if (result.type === 'error') finish(null, new Error(typeof result.error === 'string' ? result.error : '图层 PNG 像素处理失败'));
      else if (result.type !== (request.type === 'decode' ? 'decoded' : 'encoded')) finish(null, new Error('图层 PNG 像素处理返回类型不符'));
      else finish(result);
    };
    worker.onerror = () => finish(null, new Error('图层 PNG 像素处理失败'));
    worker.onmessageerror = () => finish(null, new Error('图层 PNG 像素传输失败'));
    try { worker.postMessage({ ...request, id: 1 }, [request.type === 'decode' ? request.bytes : request.rgba]); }
    catch (error) { finish(null, error instanceof Error ? error : new Error('图层 PNG 像素传输失败')); }
  });
}

async function readPngPixels(url: string, width: number, height: number): Promise<DecodedPng | null> {
  const abort = new AbortController();
  const timeout = globalThis.setTimeout(() => abort.abort(), pixelTimeoutMs);
  let bytes: Uint8Array;
  try {
    const blob = await readImageSourceBlob(url, abort.signal);
    if (blob.size > 129 * 1024 * 1024) throw new Error('图层 PNG 文件超出当前分层处理范围');
    bytes = new Uint8Array(await blob.arrayBuffer());
  } finally { globalThis.clearTimeout(timeout); abort.abort(); }
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return null;
  if (typeof Worker === 'undefined') {
    const decoded = decodeLayerPng(bytes);
    if (!decoded) throw new Error('当前分层不支持此 PNG 像素格式，请使用 8 位 PNG');
    return { width, height, rgba: resizeLayerPixels(decoded.rgba, decoded.width, decoded.height, width, height) };
  }
  const response = await runPngWorker({ type: 'decode', bytes: bytes.buffer as ArrayBuffer, width, height });
  if (response.type !== 'decoded') throw new Error('图层 PNG 像素读取失败');
  if (response.result === null) throw new Error('当前分层不支持此 PNG 像素格式，请使用 8 位 PNG');
  const result = response.result;
  validateDimensions(result.width, result.height);
  if (result.width !== width || result.height !== height || !(result.rgba instanceof ArrayBuffer)
    || result.rgba.byteLength !== width * height * 4) throw new Error('图层 PNG 像素长度不符');
  return { width, height, rgba: new Uint8Array(result.rgba) };
}

export async function decodeLayerPixels(url: string, width: number, height: number): Promise<Uint8Array> {
  validateDimensions(width, height);
  const png = await readPngPixels(url, width, height);
  if (png) return png.rgba;
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

export async function layerPixelsUrl(rgba: Uint8Array, width: number, height: number): Promise<string> {
  validateDimensions(width, height);
  if (rgba.length !== width * height * 4) throw new Error('图层 PNG 像素长度不符');
  let bytes: Uint8Array;
  if (typeof Worker === 'undefined') bytes = encodeLayerPng(rgba, width, height);
  else {
    // Transfer a copy: source document pixels are still needed by the preview/PSD.
    const response = await runPngWorker({ type: 'encode', rgba: rgba.slice().buffer, width, height });
    if (response.type !== 'encoded' || !(response.bytes instanceof ArrayBuffer)) throw new Error('图层 PNG 编码失败');
    bytes = new Uint8Array(response.bytes);
  }
  if (Math.ceil(bytes.length / 3) * 4 > 90_000_000) throw new Error('图层 PNG 文件超出当前预览和本地精修范围');
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 32768) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
  return `data:image/png;base64,${btoa(chunks.join(''))}`;
}
