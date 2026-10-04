import { decodeLayerPng, encodeLayerPng } from './layer-png-codec';
import { resizeLayerPixels } from './layer-pixel-resize';

// This module runs only inside the dedicated worker created by the caller.
// The caller owns timeout, termination and input transfer. No Canvas or fetch.
const scope = self as unknown as {
  addEventListener(type: 'message', handler: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
scope.addEventListener('message', (event) => {
  const request = event.data;
  if (!request || typeof request !== 'object' || !('id' in request)
    || !Number.isSafeInteger(request.id) || Number(request.id) < 0) return;
  const id = Number(request.id);
  try {
    if ('type' in request && request.type === 'decode' && 'bytes' in request && request.bytes instanceof ArrayBuffer) {
      const decoded = decodeLayerPng(new Uint8Array(request.bytes));
      if (!decoded) { scope.postMessage({ id, type: 'decoded', result: null }); return; }
      let width = decoded.width, height = decoded.height, pixels = decoded.rgba;
      if ('width' in request || 'height' in request) {
        if (!('width' in request) || !('height' in request) || typeof request.width !== 'number' || typeof request.height !== 'number'
          || !Number.isInteger(request.width) || !Number.isInteger(request.height)) throw new Error('PNG worker 目标尺寸无效');
        width = request.width; height = request.height;
        pixels = resizeLayerPixels(pixels, decoded.width, decoded.height, width, height);
      }
      const rgba = pixels.buffer as ArrayBuffer;
      scope.postMessage({ id, type: 'decoded', result: { width, height, rgba } }, [rgba]);
    } else if ('type' in request && request.type === 'encode' && 'rgba' in request && request.rgba instanceof ArrayBuffer
      && 'width' in request && typeof request.width === 'number' && 'height' in request && typeof request.height === 'number') {
      const bytes = encodeLayerPng(new Uint8Array(request.rgba), request.width, request.height).buffer as ArrayBuffer;
      scope.postMessage({ id, type: 'encoded', bytes }, [bytes]);
    } else throw new Error('PNG worker 请求无效');
  } catch (error) {
    scope.postMessage({ id, type: 'error', error: error instanceof Error ? error.message : 'PNG 处理失败' });
  }
});
