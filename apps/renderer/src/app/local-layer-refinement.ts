import type { LocalMattingRequest, LocalMattingResult } from '@agent-canvas/desktop-core/preload-api';
import { validateLayerPixels } from './layering-quality';

/** No paid provider call is involved. Revalidate ownership at every async boundary. */
export async function refineOwnedLayer(input: {
  request: Omit<LocalMattingRequest,'rgba'>;
  isCurrent: () => boolean;
  decode: () => Promise<Uint8Array>;
  refine: (request: LocalMattingRequest) => Promise<LocalMattingResult>;
  save: (result: LocalMattingResult) => Promise<void>;
}) {
  const assertCurrent=()=>{if(!input.isCurrent())throw new Error('项目、原图或图层已变更，请重新打开精修');};
  assertCurrent();
  const rgba=await input.decode();assertCurrent();
  const result=await input.refine({...input.request,rgba});assertCurrent();
  if(result.width!==input.request.width||result.height!==input.request.height||result.rgba.length!==rgba.length)
    throw new Error('精修结果尺寸与原图不一致，已有图层未替换');
  const verdict=await validateLayerPixels('transparent','image/png',result.width,result.height,result.rgba,input.request.width,input.request.height);
  if(!verdict.ok)throw new Error(verdict.reason==='alpha_empty'?'精修结果没有可见像素，已有图层未替换'
    :verdict.reason==='alpha_opaque'?'精修结果没有透明背景，请缩小保留区域，已有图层未替换':'精修结果像素无效，已有图层未替换');
  assertCurrent();
  await input.save(result);
}
