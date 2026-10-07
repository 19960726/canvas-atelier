import { parentPort, workerData } from 'node:worker_threads';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseLocalMattingRequest, createSourceTrimap, createLocalMattingPrompts } from '../../../packages/desktop-core/src/local-matting.js';
import { estimateMatteForeground } from '../../../packages/desktop-core/src/matting-colors.js';
import { refineGlassForeground } from '../../../packages/desktop-core/src/glass-refinement.js';

async function run() {
  const request = parseLocalMattingRequest(workerData.request);
  const root: string = workerData.runtimeDirectory;
  const { SamModel, VitMatteForImageMatting, AutoProcessor, RawImage, env } = await import(pathToFileURL(join(root,'node_modules/@huggingface/transformers/dist/transformers.node.mjs')).href);
  env.cacheDir=join(root,'model-cache');
  env.allowRemoteModels=false;
  const samId='Xenova/slimsam-77-uniform',samRevision='7c8459c48dabad6291b384c97be46c451c25d6c4';
  const matteId='Xenova/vitmatte-small-composition-1k',matteRevision='6bc1297f6140f055a227b6d2cfe8c093281f35d2';
  const options={dtype:'fp32',device:'cpu',local_files_only:true,session_options:{intraOpNumThreads:4}};
  const model=await SamModel.from_pretrained(samId,{...options,revision:samRevision});
  let matte: { dispose:()=>Promise<void> } | undefined;
  try {
    const processor=await AutoProcessor.from_pretrained(samId,{revision:samRevision,local_files_only:true});
    const {width,height,rgba,bounds,regions}=request;
    const prompts=createLocalMattingPrompts(width,height,bounds,regions);
    const original=new RawImage(new Uint8ClampedArray(rgba),width,height,4);
    const inputs=await processor(original,{
      input_boxes:[[[bounds.x*width,bounds.y*height,(bounds.x+bounds.width)*width,(bounds.y+bounds.height)*height]]],
      input_points:[prompts.points],input_labels:[prompts.labels],
    });
    const prediction=await model(inputs);
    const masks=await processor.post_process_masks(prediction.pred_masks,inputs.original_sizes,inputs.reshaped_input_sizes);
    const scores=Array.from(prediction.iou_scores.data) as number[];
    const best=scores.indexOf(Math.max(...scores)),pixels=width*height,mask=new Uint8Array(pixels);
    for(let i=0;i<pixels;i++)mask[i]=masks[0].data[best*pixels+i]?255:0;
    const trimap=createSourceTrimap(mask,width,height,24,regions);
    let left=width,top=height,right=-1,bottom=-1;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(trimap[y*width+x]){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
    if(right<left)throw new Error('选定范围中没有可提取的物体');
    left=Math.max(0,left-8);top=Math.max(0,top-8);right=Math.min(width-1,right+8);bottom=Math.min(height-1,bottom+8);
    const w=right-left+1,h=bottom-top+1,crop=new Uint8Array(w*h*4),cropTrimap=new Uint8Array(w*h);
    for(let y=0;y<h;y++){
      crop.set(rgba.subarray(((y+top)*width+left)*4,((y+top)*width+left+w)*4),y*w*4);
      cropTrimap.set(trimap.subarray((y+top)*width+left,(y+top)*width+left+w),y*w);
    }
    const matteModel=await VitMatteForImageMatting.from_pretrained(matteId,{...options,revision:matteRevision});matte=matteModel;
    const matteProcessor=await AutoProcessor.from_pretrained(matteId,{revision:matteRevision,local_files_only:true});
    const matteInputs=await matteProcessor(new RawImage(new Uint8ClampedArray(crop),w,h,4),new RawImage(new Uint8ClampedArray(cropTrimap),w,h,1));
    const {alphas}=await matteModel(matteInputs),stride=alphas.dims.at(-1);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++) {
      const p=y*w+x;
      const alpha=cropTrimap[p]===0?0:cropTrimap[p]===255?255:Math.max(0,Math.min(255,Math.round(alphas.data[y*stride+x]*255)));
      crop[p*4+3]=Math.round(alpha*rgba[((y+top)*width+x+left)*4+3]!/255);
    }
    const foreground=estimateMatteForeground(crop,w,h),result=new Uint8Array(rgba.length);
    for(let y=0;y<h;y++)result.set(foreground.subarray(y*w*4,(y+1)*w*4),((y+top)*width+left)*4);
    return {width,height,rgba:new Uint8Array(refineGlassForeground(rgba,result,width,height,bounds,regions))};
  } finally {await model.dispose();await matte?.dispose();}
}
void run().then(result=>parentPort!.postMessage({ok:true,result},[result.rgba.buffer]),error=>parentPort!.postMessage({ok:false,error:error instanceof Error?error.message:'本地精修失败'}));
