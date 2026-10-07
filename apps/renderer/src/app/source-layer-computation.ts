import { buildSourceLayerDocument, type SourcePixelLayer } from './source-layer-document';
import { applyLayerSelection, type LayeringBox, type LayeringSelection } from './layering-selection';
import { extractOriginalLayer } from './source-layer-pixels';
import type { LayeredPsdDocument, LayeredPsdLayer } from './layered-psd';

export type SourceDocumentInput = Parameters<typeof buildSourceLayerDocument>[0];
export type SourceDocumentPixels = Omit<SourceDocumentInput, 'layers'> & { layers: Omit<SourcePixelLayer, 'load'>[] };
export interface SourceForegroundPixels {
  width: number; height: number; source?: Uint8Array; mask: Uint8Array;
  bounds: LayeringBox; selection: LayeringSelection; maskSpace?: 'source' | 'bounds';
}
export type SourceComputeStart = { type: 'document'; input: SourceDocumentPixels }
  | { type: 'foreground'; input: SourceForegroundPixels };
export type SourceComputeRequest = SourceComputeStart | { type: 'pixels'; sequence: number; rgba: Uint8Array };
export type SourceComputeResponse = { type: 'load'; sequence: number; index: number }
  | { type: 'document'; document: LayeredPsdDocument } | { type: 'foreground'; rgba: Uint8Array }
  | { type: 'error'; error: string };

export function isLayerBytes(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]';
}

// Never spread runtime source layers across a worker boundary: they also
// contain load() and provenance. Keep only serializable output pixels.
function pixelDto(layer: LayeredPsdLayer): LayeredPsdLayer {
  const { id, name, kind, x, y, width, height, visible, opacity, rgba } = layer;
  return { id, name, kind, x, y, width, height, visible, opacity, rgba };
}

export async function computeSourceDocument(input: SourceDocumentPixels,
  load: (index: number) => Promise<Uint8Array>): Promise<LayeredPsdDocument> {
  const document = await buildSourceLayerDocument({ ...input,
    layers: input.layers.map((layer, index) => ({ ...layer, load: () => load(index) })),
  });
  return { width: document.width, height: document.height, layers: document.layers.map(pixelDto) };
}

export function computeSourceForeground(input: SourceForegroundPixels): Uint8Array {
  const { width, height, source, mask, bounds, selection, maskSpace } = input;
  const rgba = applyLayerSelection(source ? extractOriginalLayer(source, mask, width, height, bounds, maskSpace)
    : mask, width, height, selection);
  if (!rgba.some((value, index) => index % 4 === 3 && value > 0))
    throw new Error('所选范围内没有可见像素，请校正原图位置');
  return rgba;
}

/** A single job owns the worker. Pixel loads are sequential RPCs back to the
 * renderer's managed asset decoder; no credentials or URLs enter this worker. */
export function createSourceComputation(send: (response: SourceComputeResponse, transfer: Transferable[]) => void) {
  let started = false, ended = false, sequence = 0;
  let waiting: { sequence: number; resolve: (rgba: Uint8Array) => void; reject: (error: Error) => void } | undefined;
  const fail = (error: unknown) => {
    if (ended) return;
    ended = true;
    waiting?.reject(new Error('图层计算已终止')); waiting = undefined;
    send({ type: 'error', error: error instanceof Error ? error.message : '图层计算失败' }, []);
  };
  return (request: SourceComputeRequest) => {
    if (ended) return;
    if (request.type === 'pixels') {
      if (!waiting || waiting.sequence !== request.sequence || !isLayerBytes(request.rgba))
        return fail(new Error('图层像素响应顺序无效'));
      const pending = waiting; waiting = undefined; pending.resolve(request.rgba); return;
    }
    if (started || !['document', 'foreground'].includes(request.type)) return fail(new Error('图层计算重复或无效'));
    started = true;
    const load = (index: number) => new Promise<Uint8Array>((resolve, reject) => {
      if (ended || waiting) { reject(new Error('图层计算顺序无效')); return; }
      waiting = { sequence: ++sequence, resolve, reject };
      send({ type: 'load', sequence, index }, []);
    });
    void (async () => {
      if (request.type === 'document') {
        const document = await computeSourceDocument(request.input, load);
        if (ended) return;
        ended = true;
        send({ type: 'document', document }, [...new Set(document.layers.map(layer => layer.rgba.buffer as ArrayBuffer))]);
      } else {
        const rgba = computeSourceForeground(request.input);
        ended = true;
        send({ type: 'foreground', rgba }, [rgba.buffer as ArrayBuffer]);
      }
    })().catch(fail);
  };
}
