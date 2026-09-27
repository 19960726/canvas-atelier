import type {MattingRegion,LocalMattingRequest} from './local-matting.js';

/** Explicit glass corrections may override erroneous opaque matte pixels. Use
 * clean source samples on both sides; never infer from a generated backdrop. */
export function refineGlassForeground(source:Uint8Array,foreground:Uint8Array,width:number,height:number,
  bounds:LocalMattingRequest['bounds'],regions:readonly MattingRegion[]):Uint8Array {
  if(source.length!==width*height*4||foreground.length!==source.length)throw new Error('玻璃精修像素尺寸无效');
  const result=Uint8Array.from(foreground),modes=new Uint8Array(width*height);
  for(const {box,mode} of regions)for(let y=Math.floor(box.y*height);y<Math.min(height,Math.ceil((box.y+box.height)*height));y++)
    for(let x=Math.floor(box.x*width);x<Math.min(width,Math.ceil((box.x+box.width)*width));x++)modes[y*width+x]=mode==='glass'?1:2;
  if(!modes.includes(1))return result;
  const gap=Math.max(4,Math.round(width*.013)),sampleWidth=Math.max(4,Math.round(width*.007));
  const lx=Math.floor(bounds.x*width)-gap,rx=Math.ceil((bounds.x+bounds.width)*width)+gap;
  if(lx<0||rx>=width)return result;
  for(let y=0;y<height;y++){
    const left=[0,0,0],right=[0,0,0];let lc=0,rc=0;
    for(let i=0;i<sampleWidth;i++){
      for(const side of [0,1]){
        const x=side===0?lx-i:rx+i;if(x<0||x>=width)continue;
        const p=(y*width+x)*4;if(foreground[p+3]!>3||source[p+3]!==255)continue;
        const samples=side===0?left:right;for(let c=0;c<3;c++)samples[c]!+=source[p+c]!;
        if(side===0)lc++;else rc++;
      }
    }
    if(lc<Math.min(4,sampleWidth)||rc<Math.min(4,sampleWidth))continue;
    for(let c=0;c<3;c++){left[c]!/=lc;right[c]!/=rc;}
    // Different surfaces across the object do not supply a reliable glass plate.
    if(left.some((value,c)=>Math.abs(value-right[c]!)>65))continue;
    for(let x=0;x<width;x++){
      const p=y*width+x,o=p*4;if(modes[p]!==1||!foreground[o+3])continue;
      const t=Math.max(0,Math.min(1,(x-lx)/(rx-lx))),background=left.map((v,c)=>v*(1-t)+right[c]!*t);
      let minimum=0;
      for(let c=0;c<3;c++){
        const color=source[o+c]!,back=background[c]!;
        minimum=Math.max(minimum,color<back?(back-color)/Math.max(1,back):(color-back)/Math.max(1,255-back));
      }
      // An opaque, strongly contrasting component is a solid inside the vessel,
      // even when the coarse glass correction rectangle crosses it. Preserve it
      // consistently with explicit keep areas; only revise backdrop-like opacity.
      const smooth=(value:number,lo:number,hi:number)=>{const t=Math.max(0,Math.min(1,(value-lo)/(hi-lo)));return t*t*(3-2*t);};
      const preserve=smooth(foreground[o+3]!/255,.90,.99)*smooth(minimum,.25,.75);
      // Small opacity reserve avoids amplifying noise at nearly clear pixels.
      const a=Math.ceil(Math.min(1,minimum+.04)*255)/255;
      if(a>.97)continue;
      const oldAlpha=foreground[o+3]!/255,newAlpha=a*source[o+3]!/255,alpha=newAlpha*(1-preserve)+oldAlpha*preserve;
      result[o+3]=Math.round(alpha*255);
      for(let c=0;c<3;c++){
        const color=Math.max(0,Math.min(255,(source[o+c]!-(1-a)*background[c]!)/a));
        result[o+c]=Math.round((color*newAlpha*(1-preserve)+foreground[o+c]!*oldAlpha*preserve)/alpha);
      }
    }
  }
  return result;
}
