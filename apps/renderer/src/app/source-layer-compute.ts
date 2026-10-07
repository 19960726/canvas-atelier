import { buildSourceLayerDocument } from './source-layer-document';
import { computeSourceForeground, isLayerBytes, type SourceComputeStart, type SourceComputeResponse,
  type SourceDocumentInput, type SourceDocumentPixels, type SourceForegroundPixels } from './source-layer-computation';
import type { LayeredPsdDocument } from './layered-psd';

function run(request: SourceComputeStart, load?: (index: number) => Promise<Uint8Array>): Promise<SourceComputeResponse> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./source-layer-compute-worker.ts', import.meta.url), { type: 'module' });
    let settled = false, loading = false, sequence = 0;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (response?: SourceComputeResponse, error?: Error) => {
      if (settled) return;
      settled = true; globalThis.clearTimeout(timer);
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate();
      if (error) reject(error); else resolve(response!);
    };
    const resetTimeout = () => {
      globalThis.clearTimeout(timer);
      timer = globalThis.setTimeout(() => finish(undefined, new Error('图层计算超时，请重试')), 120_000);
    };
    worker.onerror = () => finish(undefined, new Error('图层后台计算失败'));
    worker.onmessageerror = () => finish(undefined, new Error('图层像素传输失败'));
    worker.onmessage = (event: MessageEvent<SourceComputeResponse>) => {
      if (settled) return;
      const response = event.data;
      if (response?.type === 'error') return finish(undefined, new Error(response.error || '图层计算失败'));
      if (response?.type === 'load') {
        if (request.type !== 'document' || !load || loading || response.sequence !== sequence + 1
          || !Number.isInteger(response.index) || response.index < 0 || response.index >= request.input.layers.length)
          return finish(undefined, new Error('图层像素请求顺序无效'));
        sequence = response.sequence; loading = true; resetTimeout();
        void (async () => {
          const pixels = await load(response.index);
          if (settled) return;
          if (pixels.length !== request.input.width * request.input.height * 4) throw new Error('图层像素尺寸与原图不一致');
          const rgba = pixels.slice(); // A loader can return a shared cached view.
          loading = false; resetTimeout();
          worker.postMessage({ type: 'pixels', sequence: response.sequence, rgba }, [rgba.buffer]);
        })().catch(error => finish(undefined, error instanceof Error ? error : new Error('图层像素读取失败')));
        return;
      }
      if (loading || response?.type !== request.type) return finish(undefined, new Error('图层计算返回类型无效'));
      finish(response);
    };
    resetTimeout();
    try {
      const buffers = request.type === 'document' ? [request.input.source.buffer]
        : [request.input.mask.buffer, ...(request.input.source ? [request.input.source.buffer] : [])];
      worker.postMessage(request, buffers as ArrayBuffer[]);
    } catch (error) { finish(undefined, error instanceof Error ? error : new Error('图层像素传输失败')); }
  });
}

export async function computeSourceDocumentOffThread(input: SourceDocumentInput): Promise<LayeredPsdDocument> {
  if (typeof Worker === 'undefined') return buildSourceLayerDocument(input);
  const { width, height, selection, backgroundMode, independentValidation, groupConfirmationDigest, needsReconfirm } = input;
  const dto: SourceDocumentPixels = { width, height, selection, backgroundMode, independentValidation,
    groupConfirmationDigest, needsReconfirm, source: input.source.slice(),
    layers: input.layers.map(layer => {
      const { id, name, kind, visible, opacity, bounds, maskSpace, preparedRgb, independentRgbaCandidate,
        rgbaCandidateOrigin, representationError, semanticReviewAccepted, semanticReviewDigest,
        layeringConfirmationDigest, shadowOnly, outputContract } = layer;
      return { id, name, kind, visible, opacity, bounds, maskSpace, preparedRgb, independentRgbaCandidate,
        rgbaCandidateOrigin, representationError, semanticReviewAccepted, semanticReviewDigest,
        layeringConfirmationDigest, shadowOnly, outputContract };
    }),
  };
  const result = await run({ type: 'document', input: dto }, index => input.layers[index]!.load());
  if (result.type !== 'document' || result.document?.width !== width || result.document.height !== height
    || !Array.isArray(result.document.layers) || result.document.layers.length !== input.layers.length)
    throw new Error('图层计算文档无效');
  let bytes = 0;
  for (const layer of result.document.layers) {
    if (!isLayerBytes(layer.rgba) || layer.rgba.length !== layer.width * layer.height * 4)
      throw new Error('图层计算像素无效');
    bytes += layer.rgba.length;
  }
  if (bytes > 256 * 1024 * 1024) throw new Error('图层计算像素超出内存范围');
  return result.document;
}

export async function computeSourceForegroundOffThread(input: SourceForegroundPixels): Promise<Uint8Array> {
  if (typeof Worker === 'undefined') return computeSourceForeground(input);
  const { width, height, bounds, selection, maskSpace } = input;
  const result = await run({ type: 'foreground', input: { width, height, bounds, selection, maskSpace,
    mask: input.mask.slice(), ...(input.source ? { source: input.source.slice() } : {}) } });
  if (result.type !== 'foreground' || !isLayerBytes(result.rgba) || result.rgba.length !== width * height * 4)
    throw new Error('前景计算像素无效');
  return result.rgba;
}
