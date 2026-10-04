import { expect, it } from 'vitest';
import { createCanvasModuleNode } from '@agent-canvas/domain';
import { sourceLayerInputFromNodes } from '../canvas/source-layer-preview';

const fixture = () => {
  const source = { assetId:'1'.repeat(16),sha256:'a'.repeat(64),width:2,height:2,displayUrl:'source',mediaType:'image/png' };
  const result = { assetId:'2'.repeat(16),sha256:'b'.repeat(64),width:2,height:2,displayUrl:'result',mediaType:'image/png' };
  const group = {pixelMode:'source',sourceAssetId:source.assetId,canvasWidth:2,canvasHeight:2,layerSelection:{mode:'whole'},
    planLayers:[{layerId:'background',kind:'background',name:'background'},{layerId:'cupbody',kind:'transparent',name:'cupbody'}]};
  const nodes = ['background','cupbody'].map((layerId,index) => {
    const n = createCanvasModuleNode('node-'+layerId,'image_layer',{x:0,y:0});
    n.data.config = {layerId,layerKind:index?'transparent':'background',sourceAssetId:source.assetId,resultAssetId:result.assetId,
      canvasWidth:2,canvasHeight:2,qualityStatus:'passed',sourceBounds:{x:0,y:0,width:1,height:1},
      layeringOutputContract:index?'source-alpha-matte-v1':'opaque-background-v2',pixelColorSpace:index?'foreground':null,
      resultRepresentation:index?'independent-rgba-candidate':'opaque-background-candidate',
      foregroundProvenance:index?{kind:'local-rgba-import',version:1,assetId:result.assetId,sha256:result.sha256,
        sourceAssetId:source.assetId,sourceSha256:source.sha256,width:2,height:2}:undefined};
    return n;
  });
  return {source,result,group,nodes};
};
it('recognizes bound local RGBA as an untrusted candidate without rewriting the v1 provider contract',()=>{
  const f=fixture(), input=sourceLayerInputFromNodes(f.group,f.nodes,[f.source,f.result] as never)!;
  expect(input.layers[1]).toMatchObject({preparedRgb:false,independentRgbaCandidate:true,rgbaCandidateOrigin:'local-rgba-import',
    outputContract:'source-alpha-matte-v1'});
  expect(f.nodes[1]!.data.config.layeringOutputContract).toBe('source-alpha-matte-v1');
});
it.each(['assetId','sha256','sourceAssetId','sourceSha256','width'] as const)('rejects stale local physical provenance: %s',field=>{
  const f=fixture();
  const p=f.nodes[1]!.data.config.foregroundProvenance as Record<string,unknown>;
  p[field]=field==='width'?1:'0'.repeat(field.endsWith('256')?64:16);
  expect(sourceLayerInputFromNodes(f.group,f.nodes,[f.source,f.result] as never)!.layers[1]!.representationError).toMatch(/本地.*素材|归属/);
});
