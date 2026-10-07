import { initializeCanvas, readPsd } from 'ag-psd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DraftPsdEncoder } from './draft-psd-encoder';
import { encodeDraftPsd, type DraftPsdRequest, type DraftPsdResponse } from './encode-draft-psd';
import type { LayeredPsdLayer } from './layered-psd';
import { encodeDraftSourceLayerPsd } from './source-layer-document';

initializeCanvas(() => { throw new Error('Canvas is not used'); },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as ImageData);
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const original: LayeredPsdLayer = { id: 'original', name: '原图', kind: 'background', x: 0, y: 0,
  width: 2, height: 1, visible: true, opacity: 1, rgba: new Uint8Array([20,30,40,255,50,60,70,255]) };
const background: LayeredPsdLayer = { ...original, id: 'candidate', name: '背景', kind: 'alternate-background', visible: false };
const foreground: LayeredPsdLayer = { ...original, id: 'foreground', name: '透明层🫧', kind: 'transparent', visible: false,
  rgba: new Uint8Array([123,45,67,1,78,90,120,0]) };
async function* layers() { for (const layer of [original, background, foreground]) yield { ...layer, rgba: layer.rgba.slice() }; }

describe('draft PSD encoding transport', () => {
  function workerFixture(failAt?: 'init' | 'layer' | 'finish' | 'bad-order' | 'message-error' | 'timeout') {
    const requests: DraftPsdRequest[] = [];
    const terminate = vi.fn();
    const transfers: number[] = [];
    class TestWorker {
      onmessage: ((event: MessageEvent<DraftPsdResponse>) => void) | null = null;
      onerror: (() => void) | null = null;
      onmessageerror: (() => void) | null = null;
      encoder?: DraftPsdEncoder;
      terminate = terminate;
      postMessage(message: DraftPsdRequest, transfer: Transferable[]) {
        const copied = structuredClone(message, { transfer });
        requests.push(copied);
        transfers.push(transfer.length);
        if (failAt === 'timeout') return;
        queueMicrotask(() => {
          if (failAt === 'message-error') { this.onmessageerror?.(); return; }
          const respond = (result: DraftPsdResponse) => this.onmessage?.({ data: result } as MessageEvent<DraftPsdResponse>);
          if (copied.type === failAt) return respond({ id: copied.id, type: 'error', error: 'owned worker failure' });
          if (failAt === 'bad-order') return respond({ id: copied.id + 1, type: 'ack' });
          if (copied.type === 'init') this.encoder = new DraftPsdEncoder(copied.width, copied.height);
          if (copied.type === 'layer') this.encoder!.append({ ...copied.layer, rgba: new Uint8Array(copied.layer.rgba) });
          if (copied.type === 'finish') return respond({ id: copied.id, type: 'finished', bytes: this.encoder!.finish().slice().buffer as ArrayBuffer });
          respond({ id: copied.id, type: 'ack' });
        });
      }
    }
    vi.stubGlobal('Worker', TestWorker);
    return { requests, terminate, transfers };
  }

  it('ACKs each transferred layer before loading the next and preserves straight RGBA', async () => {
    const fixture = workerFixture();
    let count = 0;
    async function* checkedLayers() {
      for await (const layer of layers()) {
        expect(fixture.requests.filter(request => request.type === 'layer').length).toBe(count++);
        yield layer;
        expect(layer.rgba.byteLength).toBe(0);
      }
    }
    const bytes = await encodeDraftPsd(2, 1, checkedLayers());
    expect(fixture.requests.map(request => request.type)).toEqual(['init', 'layer', 'layer', 'layer', 'finish']);
    expect(fixture.transfers).toEqual([0, 1, 1, 1, 0]);
    expect(fixture.terminate).toHaveBeenCalledOnce();
    const psd = readPsd(bytes, { useImageData: true });
    expect([...psd.children![2]!.imageData!.data]).toEqual([...foreground.rgba]);
    expect([...psd.imageData!.data]).toEqual([...original.rgba]);
    expect(psd.children![2]!.name).toBe(foreground.name);
  });

  it('transfers actual prepared draft layers without leaking their source loader functions', async () => {
    const worker = workerFixture();
    const bytes = await encodeDraftSourceLayerPsd({ width: 2, height: 1, source: original.rgba,
      selection: { mode: 'whole' }, layers: [
        { ...background, kind: 'background', load: async () => background.rgba },
        { ...foreground, kind: 'transparent', preparedRgb: true, bounds: { x: 0, y: 0, width: 1, height: 1 },
          load: async () => foreground.rgba },
      ] });
    const psd = readPsd(bytes, { useImageData: true });
    expect([...psd.children![2]!.imageData!.data]).toEqual([...foreground.rgba]);
    for (const request of worker.requests) if (request.type === 'layer') expect(Object.keys(request.layer).sort())
      .toEqual(['height','id','kind','name','opacity','rgba','visible','width','x','y']);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(original.rgba.byteLength).toBe(8);
    expect(foreground.rgba.byteLength).toBe(8);
  });

  it.each(['init', 'layer', 'finish', 'bad-order', 'message-error'] as const)('releases its worker and rejects partial output on %s failure', async failure => {
    const fixture = workerFixture(failure);
    await expect(encodeDraftPsd(2, 1, layers())).rejects.toThrow();
    expect(fixture.terminate).toHaveBeenCalledOnce();
    if (failure !== 'finish') expect(fixture.requests.some(request => request.type === 'finish')).toBe(false);
  });

  it('terminates a timed-out worker without a fallback export', async () => {
    vi.useFakeTimers();
    const fixture = workerFixture('timeout');
    const pending = encodeDraftPsd(2, 1, layers());
    const assertion = expect(pending).rejects.toThrow(/超时/u);
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
    expect(fixture.terminate).toHaveBeenCalledOnce();
    expect(fixture.requests).toHaveLength(1);
  });

  it('rejects invalid draft visibility, missing alpha, duplicate IDs, bounds and canvas allocation', () => {
    expect(() => new DraftPsdEncoder(8192,8192)).toThrow(/尺寸/u);
    const encoder = new DraftPsdEncoder(2,1);
    encoder.append(original);
    expect(() => encoder.append({ ...background, visible: true })).toThrow(/隐藏/u);
    expect(() => encoder.append({ ...background, id: original.id })).toThrow(/身份/u);
    expect(() => encoder.append({ ...background, x: 1 })).toThrow(/位置/u);
    encoder.append(background);
    expect(() => encoder.append({ ...foreground, rgba: original.rgba })).toThrow(/透明通道/u);
    expect(() => new DraftPsdEncoder(2,1).finish()).toThrow(/缺少/u);
  });
});
