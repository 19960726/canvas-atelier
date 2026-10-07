import { afterEach, expect, it, vi } from 'vitest';
import { computeSourceDocumentOffThread, computeSourceForegroundOffThread } from './source-layer-compute';
import { createSourceComputation, type SourceComputeRequest, type SourceComputeResponse, type SourceDocumentInput } from './source-layer-computation';
import { buildSourceLayerDocument } from './source-layer-document';
import { applyLayerSelection } from './layering-selection';
import { extractOriginalLayer } from './source-layer-pixels';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const bounds = { x: 0, y: 0, width: 1, height: 1 };
function fixture() {
  const background = new Uint8Array(8 * 8 * 4), foreground = new Uint8Array(background.length);
  for (let p = 0; p < 64; p++) background.set([70,90,110,255], p * 4);
  foreground.set([210,30,40,255], (4 * 8 + 4) * 4);
  const source = background.slice(); source.set([210,30,40,255], (4 * 8 + 4) * 4);
  const loadBackground = vi.fn(async () => background), loadForeground = vi.fn(async () => foreground);
  const input: SourceDocumentInput = { width: 8, height: 8, source, selection: { mode: 'whole' }, layers: [
    { id: 'bg', name: '背景', kind: 'background', visible: true, opacity: 1, load: loadBackground },
    { id: 'subject', name: '杯身🫧', kind: 'transparent', visible: true, opacity: 1, maskSpace: 'source', bounds, load: loadForeground },
  ] };
  return { input, source, background, foreground, loadBackground, loadForeground };
}

function workerFixture(mode?: 'silent' | 'message-error' | 'error' | 'bad-load' | 'bad-result') {
  const sent: SourceComputeRequest[] = [], responses: SourceComputeResponse[] = [];
  const terminate = vi.fn();
  class TestWorker {
    onmessage: ((event: MessageEvent<SourceComputeResponse>) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessageerror: (() => void) | null = null;
    terminate = terminate;
    compute = createSourceComputation((response, transfer) => {
      const copy = structuredClone(response, { transfer }); responses.push(copy);
      queueMicrotask(() => this.onmessage?.({ data: copy } as MessageEvent<SourceComputeResponse>));
    });
    postMessage(request: SourceComputeRequest, transfer: Transferable[]) {
      const copy = structuredClone(request, { transfer }); sent.push(copy);
      queueMicrotask(() => {
        if (mode === 'silent') return;
        if (mode === 'error') { this.onerror?.(); return; }
        if (mode === 'message-error') { this.onmessageerror?.(); return; }
        if (mode === 'bad-load') { this.onmessage?.({ data: { type: 'load', index: -1, sequence: 1 } } as MessageEvent<SourceComputeResponse>); return; }
        if (mode === 'bad-result') { this.onmessage?.({ data: { type: 'foreground', rgba: new Uint8Array(4) } } as MessageEvent<SourceComputeResponse>); return; }
        this.compute(copy);
      });
    }
  }
  vi.stubGlobal('Worker', TestWorker);
  return { sent, responses, terminate };
}

it('transfers a real source document sequentially and retains original/cached RGBA ownership', async () => {
  const value = fixture();
  const expected = await buildSourceLayerDocument(value.input);
  const worker = workerFixture();
  const actual = await computeSourceDocumentOffThread(value.input);
  expect(actual.layers.map(layer => [layer.id,layer.name,layer.x,layer.y,layer.width,layer.height,layer.opacity,layer.visible,[...layer.rgba]]))
    .toEqual(expected.layers.map(layer => [layer.id,layer.name,layer.x,layer.y,layer.width,layer.height,layer.opacity,layer.visible,[...layer.rgba]]));
  expect(worker.sent.map(message => message.type)).toEqual(['document','pixels','pixels']);
  expect(worker.responses.map(message => message.type)).toEqual(['load','load','document']);
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(value.source.byteLength).toBe(256); expect(value.foreground.byteLength).toBe(256); expect(value.background.byteLength).toBe(256);
  for (const layer of actual.layers) expect(Object.keys(layer).sort())
    .toEqual(['height','id','kind','name','opacity','rgba','visible','width','x','y']);
});

it('preserves standalone extraction bounds, regional selection and every retained alpha/RGB byte', async () => {
  const value = fixture(), worker = workerFixture();
  value.foreground.set([1,2,3,1], (3 * 8 + 3) * 4);
  const selection = { mode: 'region' as const, box: { x: .25,y:.25,width:.5,height:.5 } };
  const actual = await computeSourceForegroundOffThread({ width: 8,height:8,source:value.source,mask:value.foreground,bounds,maskSpace:'source',selection });
  expect([...actual]).toEqual([...applyLayerSelection(extractOriginalLayer(value.source,value.foreground,8,8,bounds,'source'),8,8,selection)]);
  const independent = new Uint8Array([19,87,201,1,32,45,67,0]);
  expect([...(await computeSourceForegroundOffThread({width:2,height:1,mask:independent,bounds,selection:{mode:'whole'}}))]).toEqual([...independent]);
  expect(independent.byteLength).toBe(8);
  expect(worker.terminate).toHaveBeenCalledTimes(2);
});

it('preserves the strict review refusal before loading any candidate pixels', async () => {
  const value=fixture(), worker=workerFixture();
  const input={...value.input, independentValidation:'strict' as const, layers:value.input.layers.map(layer=>({...layer,independentRgbaCandidate:true,rgbaCandidateOrigin:'local-rgba-import' as const}))};
  const expected = await buildSourceLayerDocument(input).catch(error => error.message);
  expect(typeof expected).toBe('string');
  await expect(computeSourceDocumentOffThread(input)).rejects.toThrow(expected);
  expect(value.loadBackground).not.toHaveBeenCalled();
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it('rejects a loader failure, terminates its worker and never loads later layers', async () => {
  const value=fixture(),worker=workerFixture();
  value.loadBackground.mockRejectedValueOnce(new Error('missing owned PNG'));
  await expect(computeSourceDocumentOffThread(value.input)).rejects.toThrow('missing owned PNG');
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(value.loadForeground).not.toHaveBeenCalled();
});

it.each(['error','message-error','bad-load','bad-result'] as const)('fails closed and terminates on %s', async mode => {
  const value=fixture(),worker=workerFixture(mode);
  await expect(computeSourceDocumentOffThread(value.input)).rejects.toThrow();
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(value.loadBackground).not.toHaveBeenCalled();
});

it('bounds a silent worker and performs no synchronous fallback', async () => {
  vi.useFakeTimers(); const value=fixture(),worker=workerFixture('silent');
  const assertion=expect(computeSourceDocumentOffThread(value.input)).rejects.toThrow(/超时/u);
  await vi.advanceTimersByTimeAsync(120_000); await assertion;
  expect(worker.terminate).toHaveBeenCalledOnce(); expect(value.loadBackground).not.toHaveBeenCalled();
});
