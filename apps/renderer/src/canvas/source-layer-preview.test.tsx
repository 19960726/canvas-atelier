import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSourceLayerPreview, sourceLayerInputFromNodes, type SourceLayerInput } from './source-layer-preview';
import { createCanvasModuleNode } from '@agent-canvas/domain';
import { decodeLayerPixels } from '../app/managed-layer-pixels';
vi.mock('../app/managed-layer-pixels', () => ({
  decodeLayerPixels: vi.fn(async () => new Uint8Array(4 * 4 * 4).fill(255)),
  layerPixelsUrl: () => 'data:image/png;base64,preview',
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('uses saved layer order in individual layer previews just as the workbench and PSD do',()=>{
  const ids=['bg','lower','upper'];
  const nodes=ids.map((id,index)=>{const node=createCanvasModuleNode(id,'image_layer',{x:0,y:0});node.data.config={layerId:id,resultAssetId:id,qualityStatus:'passed',order:index===0?0:3-index};return node;});
  const assets=['source',...ids].map(assetId=>({assetId,width:4,height:4,displayUrl:assetId,mediaType:'image/png' as const}));
  const input=sourceLayerInputFromNodes({pixelMode:'source',sourceAssetId:'source',planLayers:ids.map((layerId,index)=>({layerId,name:layerId,kind:index===0?'background':'transparent'}))},nodes,assets as never);
  expect(input?.layers.map(layer=>layer.record.layerId)).toEqual(['bg','upper','lower']);
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
