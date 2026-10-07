import { DraftPsdEncoder } from './draft-psd-encoder';
import type { DraftPsdRequest, DraftPsdResponse } from './encode-draft-psd';

let encoder: DraftPsdEncoder | undefined;
globalThis.onmessage = (event: MessageEvent<DraftPsdRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'init') {
      if (encoder) throw new Error('PSD 编码任务重复初始化');
      encoder = new DraftPsdEncoder(request.width, request.height);
    } else if (!encoder) throw new Error('PSD 编码任务尚未初始化');
    else if (request.type === 'layer') encoder.append({ ...request.layer, rgba: new Uint8Array(request.layer.rgba) });
    else if (request.type === 'finish') {
      const result = encoder.finish();
      encoder = undefined;
      const bytes = result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) as ArrayBuffer;
      globalThis.postMessage({ id: request.id, type: 'finished', bytes } satisfies DraftPsdResponse, { transfer: [bytes] });
      return;
    } else throw new Error('PSD 编码请求无效');
    globalThis.postMessage({ id: request.id, type: 'ack' } satisfies DraftPsdResponse);
  } catch (error) {
    encoder = undefined;
    globalThis.postMessage({ id: request.id, type: 'error', error: error instanceof Error ? error.message : 'PSD 编码失败' } satisfies DraftPsdResponse);
  }
};
