import { DraftPsdEncoder } from './draft-psd-encoder';
import type { LayeredPsdLayer } from './layered-psd';

export type DraftPsdRequest = { id: number; type: 'init'; width: number; height: number }
  | { id: number; type: 'layer'; layer: Omit<LayeredPsdLayer, 'rgba'> & { rgba: ArrayBuffer } }
  | { id: number; type: 'finish' };
export type DraftPsdResponse = { id: number; type: 'ack' } | { id: number; type: 'finished'; bytes: ArrayBuffer }
  | { id: number; type: 'error'; error: string };

/** ACK backpressure: at most one decoded layer is sent at a time. The iterator
 * yields owned buffers, which this function transfers, never shared assets. */
export async function encodeDraftPsd(width: number, height: number, layers: AsyncIterable<LayeredPsdLayer>,
  assertCurrent: () => void = () => {}): Promise<Uint8Array> {
  assertCurrent();
  if (typeof Worker === 'undefined') {
    const encoder = new DraftPsdEncoder(width, height);
    for await (const layer of layers) { assertCurrent(); encoder.append(layer); assertCurrent(); }
    assertCurrent();
    return encoder.finish();
  }
  const worker = new Worker(new URL('./draft-psd-worker.ts', import.meta.url), { type: 'module' });
  let sequence = 0;
  const request = (message: DraftPsdRequest, transfer: Transferable[] = []) => new Promise<DraftPsdResponse>((resolve, reject) => {
    const settle = (result?: DraftPsdResponse, error?: Error) => {
      globalThis.clearTimeout(timeout);
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      if (error) reject(error); else resolve(result!);
    };
    const timeout = globalThis.setTimeout(() => settle(undefined, new Error('PSD 编码超时，请重试')), 120_000);
    worker.onmessage = (event: MessageEvent<DraftPsdResponse>) => {
      const response = event.data;
      if (response?.id !== message.id || !['ack', 'finished', 'error'].includes(response.type))
        return settle(undefined, new Error('PSD 编码响应无效'));
      if (response.type === 'error') return settle(undefined, new Error(response.error || 'PSD 编码失败'));
      if (response.type !== (message.type === 'finish' ? 'finished' : 'ack'))
        return settle(undefined, new Error('PSD 编码响应顺序无效'));
      settle(response);
    };
    worker.onerror = () => settle(undefined, new Error('PSD 后台编码失败'));
    worker.onmessageerror = () => settle(undefined, new Error('PSD 像素传输失败'));
    try { worker.postMessage(message, transfer); } catch (error) { settle(undefined, error instanceof Error ? error : new Error('PSD 像素传输失败')); }
  });
  try {
    await request({ id: ++sequence, type: 'init', width, height });
    assertCurrent();
    for await (const layer of layers) {
      assertCurrent();
      const rgba = layer.rgba.byteOffset === 0 && layer.rgba.byteLength === layer.rgba.buffer.byteLength
        && layer.rgba.buffer instanceof ArrayBuffer ? layer.rgba.buffer : layer.rgba.slice().buffer as ArrayBuffer;
      // Runtime source layers also carry load() and provenance. Select the
      // pixel DTO explicitly: spreading a typed layer still clones those
      // extra properties and makes real browser postMessage fail.
      const { id, kind, name, x, y, width: layerWidth, height: layerHeight, visible, opacity } = layer;
      await request({ id: ++sequence, type: 'layer', layer: {
        id, kind, name, x, y, width: layerWidth, height: layerHeight, visible, opacity, rgba,
      } }, [rgba]);
      assertCurrent();
    }
    const response = await request({ id: ++sequence, type: 'finish' });
    assertCurrent();
    if (response.type !== 'finished' || !(response.bytes instanceof ArrayBuffer) || response.bytes.byteLength < 26
      || response.bytes.byteLength > 256 * 1024 * 1024) throw new Error('PSD 编码结果无效');
    return new Uint8Array(response.bytes);
  } finally { worker.terminate(); }
}
