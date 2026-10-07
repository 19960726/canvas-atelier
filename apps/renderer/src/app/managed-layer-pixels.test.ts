import { Blob as NodeBlob } from 'node:buffer';
import { inflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeLayerPixels, layerPixelsUrl } from './managed-layer-pixels';

// Encoded independently with Node zlib/PNG CRC from straight RGBA, never Canvas.
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAIklEQVR4nGNQDW5USJl2wkE1uPE/g2pwI+P/evsG1eBGBgB6mglE+XrOoAAAAABJRU5ErkJggg==';
const quantizedPng = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAI0lEQVR4AWLSCGhQSJl+3EE1uPE/040N9Q9nv6x0uL22nhEAAAD//+UB0N4AAAAGSURBVAMAkskMROJRJQsAAAAASUVORK5CYII=';
const original = new Uint8Array([37, 83, 129, 32, 100, 150, 200, 64, 37, 83, 129, 255,
  37, 83, 129, 1, 255, 127, 63, 128, 37, 83, 129, 0]);
const quantized = new Uint8Array([40, 80, 128, 32, 100, 151, 199, 64, 37, 83, 129, 255,
  0, 0, 255, 1, 255, 128, 64, 128, 0, 0, 0, 0]);
type WorkerRequest = { id: number; type: string; bytes?: ArrayBuffer; rgba?: ArrayBuffer; width: number; height: number };

function installWorker(reply: (request: WorkerRequest) => unknown) {
  const workers: FakeWorker[] = [];
  class FakeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessageerror: (() => void) | null = null;
    terminate = vi.fn();
    postMessage = vi.fn((request: WorkerRequest, transfer: Transferable[]) => {
      const transferred = structuredClone(request, { transfer });
      const response = reply(transferred);
      if (response !== undefined) queueMicrotask(() => this.onmessage?.({ data: response } as MessageEvent));
    });
    constructor() { workers.push(this); }
  }
  vi.stubGlobal('Worker', FakeWorker);
  return workers;
}

// Independent Node inflater and PNG filter reader; never the product decoder.
function readEncodedRgba(url: string): Uint8Array {
  const bytes = Buffer.from(url.split(',')[1]!, 'base64');
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  expect([...bytes.subarray(24, 29)]).toEqual([8, 6, 0, 0, 0]);
  const chunks: Buffer[] = [];
  for (let at = 8; at < bytes.length;) {
    const size = bytes.readUInt32BE(at);
    if (bytes.toString('ascii', at + 4, at + 8) === 'IDAT') chunks.push(bytes.subarray(at + 8, at + 8 + size));
    at += size + 12;
  }
  const rows = inflateSync(Buffer.concat(chunks));
  expect(rows.length).toBe((width * 4 + 1) * height);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width * 4; x++) {
    const filter = rows[y * (width * 4 + 1)]!, at = y * width * 4 + x;
    const a = x >= 4 ? rgba[at - 4]! : 0, b = y ? rgba[at - width * 4]! : 0;
    const c = y && x >= 4 ? rgba[at - width * 4 - 4]! : 0;
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    const prediction = [0, a, b, Math.floor((a + b) / 2), pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
    expect(prediction).toBeDefined();
    rgba[at] = (rows[y * (width * 4 + 1) + x + 1]! + prediction!) & 255;
  }
  return rgba;
}

describe('managed independent PNG pixels', () => {
  let canvas: unknown;
  beforeEach(() => {
    vi.stubGlobal('Blob', NodeBlob);
    vi.stubGlobal('Worker', undefined);
    vi.stubGlobal('Image', class { naturalWidth = 3; naturalHeight = 2; src = ''; crossOrigin = ''; decode = async () => {}; });
    canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(), getImageData: () => ({ data: quantized }),
      createImageData: () => ({ data: new Uint8ClampedArray(24) }), putImageData: vi.fn(),
    } as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(`data:image/png;base64,${quantizedPng}`);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('reads exact low-alpha and zero-alpha RGB without Canvas premultiplication', async () => {
    expect(await decodeLayerPixels(`data:image/png;base64,${png}`, 3, 2)).toEqual(original);
    expect(canvas).not.toHaveBeenCalled();
  });
  it('encodes exact independent RGB and alpha instead of quantizing in Canvas', async () => {
    expect(readEncodedRgba(await layerPixelsUrl(original, 3, 2))).toEqual(original);
    expect(canvas).not.toHaveBeenCalled();
  });
  it('rejects a damaged PNG instead of silently replacing pixels through Canvas', async () => {
    const bytes = Buffer.from(png, 'base64'); bytes[50] = bytes[50]! ^ 1;
    await expect(decodeLayerPixels(`data:image/png;base64,${bytes.toString('base64')}`, 3, 2)).rejects.toThrow();
    expect(canvas).not.toHaveBeenCalled();
  });
  it('rejects incompatible PNG coordinates before drawing', async () => {
    await expect(decodeLayerPixels(`data:image/png;base64,${png}`, 3, 3)).rejects.toThrow(/画幅比例/);
    expect(canvas).not.toHaveBeenCalled();
  });
  it('rescales a compatible PNG without low-alpha RGB quantization', async () => {
    const rgba = await decodeLayerPixels(`data:image/png;base64,${png}`, 6, 4);
    expect(rgba.length).toBe(6 * 4 * 4);
    expect([...rgba.subarray(0, 4)]).toEqual([37, 83, 129, 32]);
    expect(canvas).not.toHaveBeenCalled();
  });
  it('rejects an unsupported valid 16-bit PNG instead of silently reducing its pixels in Canvas', async () => {
    const png16 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABEAYAAABPhRjKAAAAC0lEQVR4nGNggAIAAAkAAftSuKkAAAAASUVORK5CYII=';
    await expect(decodeLayerPixels(`data:image/png;base64,${png16}`, 1, 1)).rejects.toThrow(/8 位 PNG/);
    expect(canvas).not.toHaveBeenCalled();
  });
  it('keeps the existing Image decoder for non-PNG formats', async () => {
    expect(await decodeLayerPixels('data:image/jpeg;base64,AA==', 3, 2)).toEqual(quantized);
    expect(canvas).toHaveBeenCalledOnce();
  });
  it('uses the worker to read transferred native PNG bytes and closes it after success', async () => {
    const workers = installWorker(request => {
      expect(request).toMatchObject({ type: 'decode', width: 3, height: 2 });
      expect(Buffer.from(request.bytes!).toString('base64')).toBe(png);
      return { id: request.id, type: 'decoded', result: { width: 3, height: 2, rgba: original.slice().buffer } };
    });
    expect(await decodeLayerPixels(`data:image/png;base64,${png}`, 3, 2)).toEqual(original);
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    expect(canvas).not.toHaveBeenCalled();
  });
  it('transfers a copy for worker encoding and preserves the source document for PSD/export', async () => {
    const before = original.slice();
    const workers = installWorker(request => {
      expect(new Uint8Array(request.rgba!)).toEqual(before);
      return { id: request.id, type: 'encoded', bytes: Uint8Array.from(Buffer.from(png, 'base64')).buffer };
    });
    expect(readEncodedRgba(await layerPixelsUrl(original, 3, 2))).toEqual(before);
    expect(original).toEqual(before);
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    expect(canvas).not.toHaveBeenCalled();
  });
  it.each([
    { id: 1, type: 'error', error: 'damaged PNG' },
    { id: 2, type: 'encoded', bytes: new ArrayBuffer(1) },
    { id: 1, type: 'decoded', result: null },
  ])('closes a failed worker and rejects without Canvas fallback: %j', async response => {
    const workers = installWorker(() => response);
    await expect(layerPixelsUrl(original, 3, 2)).rejects.toThrow();
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    expect(original.length).toBe(24);
    expect(canvas).not.toHaveBeenCalled();
  });
  it('rejects a worker pixel buffer with the wrong size instead of publishing it', async () => {
    const workers = installWorker(request => ({ id: request.id, type: 'decoded', result: { width: 3, height: 2, rgba: new ArrayBuffer(4) } }));
    await expect(decodeLayerPixels(`data:image/png;base64,${png}`, 3, 2)).rejects.toThrow(/长度/);
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    expect(canvas).not.toHaveBeenCalled();
  });
  it('terminates a stalled worker at the bounded timeout while retaining the original RGBA', async () => {
    vi.useFakeTimers();
    const workers = installWorker(() => undefined);
    const failed = expect(layerPixelsUrl(original, 3, 2)).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(30_000);
    await failed;
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    expect(original.length).toBe(24);
    expect(canvas).not.toHaveBeenCalled();
  });
});
