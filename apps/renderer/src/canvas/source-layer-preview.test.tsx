import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareSourceLayerDocument, useSourceLayerPreview, sourceLayerInputFromNodes, type SourceLayerInput } from './source-layer-preview';
import { SourceForegroundPreview } from './SourceForegroundPreview';
import { createCanvasModuleNode } from '@agent-canvas/domain';
import { decodeLayerPixels } from '../app/managed-layer-pixels';
vi.mock('../app/managed-layer-pixels', () => ({
  decodeLayerPixels: vi.fn(async () => new Uint8Array(4 * 4 * 4).fill(255)),
  layerPixelsUrl: () => 'data:image/png;base64,preview',
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
it('uses saved layer order in individual layer previews just as the workbench and PSD do',()=>{
  const ids=['bg','lower','upper'];
  const nodes=ids.map((id,index)=>{const node=createCanvasModuleNode(id,'image_layer',{x:0,y:0});node.data.config={layerId:id,resultAssetId:id,qualityStatus:'passed',order:index===0?0:3-index};return node;});
  const assets=['source',...ids].map(assetId=>({assetId,width:4,height:4,displayUrl:assetId,mediaType:'image/png' as const}));
  const input=sourceLayerInputFromNodes({pixelMode:'source',sourceAssetId:'source',planLayers:ids.map((layerId,index)=>({layerId,name:layerId,kind:index===0?'background':'transparent'}))},nodes,assets as never);
  expect(input?.layers.map(layer=>layer.record.layerId)).toEqual(['bg','upper','lower']);
});

it('marks a v2 independent result as a candidate representation without making it trusted', () => {
  const ids = ['bg', 'subject'];
  const nodes = ids.map((id, index) => {
    const node = createCanvasModuleNode(id, 'image_layer', { x: 0, y: 0 });
    node.data.config = { layerId: id, resultAssetId: id, qualityStatus: 'passed', order: index,
      ...(id === 'subject' ? {
        layeringOutputContract: 'source-independent-rgba-v2', resultRepresentation: 'independent-rgba-candidate',
      } : {}) };
    return node;
  });
  const assets = ['source', ...ids].map(assetId => ({ assetId, width: 4, height: 4, displayUrl: assetId, mediaType: 'image/png' as const }));
  const input = sourceLayerInputFromNodes({ pixelMode: 'source', sourceAssetId: 'source', planLayers: ids.map((layerId, index) => ({
    layerId, name: layerId, kind: index === 0 ? 'background' : 'transparent',
  })) }, nodes, assets as never);
  expect(input?.layers[1]).toMatchObject({ outputContract: 'source-independent-rgba-v2', independentRgbaCandidate: true });
  expect(input?.layers[1]).not.toHaveProperty('preparedRgb', true);
});

it('passes the group confirmation binding into source preparation', () => {
  const digest = 'a'.repeat(64);
  const ids = ['bg', 'subject'];
  const nodes = ids.map((id, index) => {
    const node = createCanvasModuleNode(id, 'image_layer', { x: 0, y: 0 });
    node.data.config = { layerId: id, resultAssetId: id, qualityStatus: 'passed', order: index,
      layeringConfirmationDigest: digest };
    return node;
  });
  const assets = ['source', ...ids].map(assetId => ({ assetId, width: 4, height: 4, displayUrl: assetId, mediaType: 'image/png' as const }));
  const input = sourceLayerInputFromNodes({ pixelMode: 'source', sourceAssetId: 'source', layeringConfirmationDigest: digest,
    planLayers: ids.map((layerId, index) => ({ layerId, name: layerId, kind: index === 0 ? 'background' : 'transparent' })) }, nodes, assets as never);
  expect(input).toMatchObject({ groupConfirmationDigest: digest, needsReconfirm: false });
  expect(input?.layers.every(layer => layer.layeringConfirmationDigest === digest)).toBe(true);
});
it('uses current assembly binding and allows format-checked pending candidates for local inspection', () => {
  const generationDigest = 'a'.repeat(64), assemblyDigest = 'b'.repeat(64);
  const ids = ['bg', 'subject'];
  const nodes = ids.map((id, order) => {
    const node = createCanvasModuleNode(id, 'image_layer', { x: 0, y: 0 });
    node.data.config = { layerId: id, resultAssetId: id, name: `current-${id}`, qualityStatus: 'pending', order,
      formatQualityStatus: 'passed', qualityFormatCheckedAssetId: id,
      layeringConfirmationDigest: generationDigest, assemblyConfirmationDigest: assemblyDigest };
    return node;
  });
  const assets = ['source', ...ids].map(assetId => ({ assetId, width: 4, height: 4, displayUrl: assetId, mediaType: 'image/png' as const }));
  const config = { pixelMode: 'source', sourceAssetId: 'source', layeringConfirmationDigest: generationDigest,
    assemblyConfirmationDigest: assemblyDigest, planLayers: ids.map((layerId, index) => ({ layerId, name: layerId,
      kind: index === 0 ? 'background' : 'transparent' })) };
  const input = sourceLayerInputFromNodes(config, nodes, assets as never);
  expect(input?.groupConfirmationDigest).toBe(assemblyDigest);
  expect(input?.layers.map(layer => layer.layeringConfirmationDigest)).toEqual([assemblyDigest, assemblyDigest]);
  expect(input?.layers[1]?.record.name).toBe('current-subject');
  nodes[1]!.data.config.qualityFormatCheckedAssetId = 'old-asset';
  expect(sourceLayerInputFromNodes(config, nodes, assets as never)).toBeNull();
});
it('shares a source document between visible layer nodes instead of decoding every mask for each node', async () => {
  const input: SourceLayerInput = { sourceUrl: 'source', width: 4, height: 4, selection: { mode: 'whole' }, layers: [
    { record: { layerId: 'bg', kind: 'background', name: 'bg', assetId: 'bg', x: 0, y: 0, width: 4, height: 4, visible: true, opacity: 1 }, url: 'bg', bounds: null },
    { record: { layerId: 'fg', kind: 'transparent', name: 'fg', assetId: 'fg', x: 0, y: 0, width: 4, height: 4, visible: true, opacity: 1 }, url: 'fg', bounds: { x: .25, y: .25, width: .5, height: .5 } },
  ] };
  function Consumer() { const state = useSourceLayerPreview(input); return <span>{state.preview ? 'ready' : 'loading'}</span>; }
  render(<><Consumer /><Consumer /></>);
  await waitFor(() => expect(screen.getAllByText('ready')).toHaveLength(2));
  expect(decodeLayerPixels).toHaveBeenCalledTimes(3);
});

function rejectComputationWorker() {
  const started = vi.fn();
  const terminated = vi.fn();
  vi.stubGlobal('Worker', class {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessageerror: (() => void) | null = null;
    terminate = terminated;
    constructor(url: URL) { expect(url.pathname).toContain('source-layer-compute-worker'); }
    postMessage(request: unknown, transfers: Transferable[]) {
      started(structuredClone(request, { transfer: transfers }));
      queueMicrotask(() => this.onmessage?.({ data: { type: 'error', error: 'worker computation sentinel' } } as MessageEvent));
    }
  });
  return { started, terminated };
}

it('runs source group computation outside the renderer and surfaces worker failure without retrying locally', async () => {
  const worker = rejectComputationWorker();
  const input: SourceLayerInput = { sourceUrl: 'source', width: 4, height: 4, selection: { mode: 'whole' }, layers: [
    { record: { layerId: 'bg', kind: 'background', name: 'bg', assetId: 'bg', x: 0, y: 0, width: 4, height: 4, visible: true, opacity: 1 }, url: 'bg', bounds: null },
    { record: { layerId: 'fg', kind: 'transparent', name: 'fg', assetId: 'fg', x: 0, y: 0, width: 4, height: 4, visible: true, opacity: 1 }, url: 'fg', bounds: { x: .25, y: .25, width: .5, height: .5 } },
  ] };
  await expect(prepareSourceLayerDocument(input)).rejects.toThrow('worker computation sentinel');
  expect(worker.started).toHaveBeenCalledOnce();
  expect(worker.terminated).toHaveBeenCalledOnce();
  expect(decodeLayerPixels).toHaveBeenCalledTimes(1);
});

it('runs individual source foreground extraction outside the renderer too', async () => {
  const worker = rejectComputationWorker();
  render(<SourceForegroundPreview sourceUrl="source" maskUrl="mask" width={4} height={4}
    bounds={{ x: .25, y: .25, width: .5, height: .5 }} selection={{ mode: 'whole' }} label="foreground" />);
  expect((await screen.findByRole('alert')).textContent).toContain('worker computation sentinel');
  expect(worker.started).toHaveBeenCalledOnce();
  expect(worker.terminated).toHaveBeenCalledOnce();
});
