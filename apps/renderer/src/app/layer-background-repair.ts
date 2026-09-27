import type {LayeringBox} from './layering-selection';

/** Match donor color to the original around erased areas. Solve only a smooth
 * correction field; donor RGB and its texture stay at the original resolution. */
export function repairLayerBackground(source:Uint8Array,donor:Uint8Array,width:number,height:number,coverage:Uint8Array):Uint8Array {
  const count=width*height;
  if(source.length!==count*4||donor.length!==source.length||coverage.length!==count)throw new Error('背景修复像素尺寸无效');
  const distance=new Float32Array(count).fill(width+height);
  for(let p=0;p<count;p++)if(coverage[p])distance[p]=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const p=y*width+x;if(x)distance[p]=Math.min(distance[p]!,distance[p-1]!+1);if(y)distance[p]=Math.min(distance[p]!,distance[p-width]!+1);}
  for(let y=height-1;y>=0;y--)for(let x=width-1;x>=0;x--){const p=y*width+x;if(x+1<width)distance[p]=Math.min(distance[p]!,distance[p+1]!+1);if(y+1<height)distance[p]=Math.min(distance[p]!,distance[p+width]!+1);}
  const padding=Math.max(1,Math.round(Math.min(width,height)*.026)),feather=Math.max(1,Math.round(padding/2));
  let previous:Float32Array|undefined,pw=0,ph=0;
  const maxSide=Math.max(width,height),target=Math.min(512,maxSide),scales:number[]=[];
  for(let size=Math.min(32,target);size<target;size*=2)scales.push(size);scales.push(target);
  for(const size of scales){
    const w=Math.max(1,Math.round(width/maxSide*size)),h=Math.max(1,Math.round(height/maxSide*size)),field=new Float32Array(w*h*3),unknown=new Uint8Array(w*h);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const sx=Math.min(width-1,Math.floor((x+.5)*width/w)),sy=Math.min(height-1,Math.floor((y+.5)*height/h)),p=y*w+x,s=sy*width+sx;
      unknown[p]=distance[s]!<=padding+Math.max(width/w,height/h)?1:0;
      for(let c=0;c<3;c++)field[p*3+c]=unknown[p]?(previous?sample(previous,pw,ph,(x+.5)*pw/w-.5,(y+.5)*ph/h-.5,c):0):source[s*4+c]!-donor[s*4+c]!;
    }
    for(let iteration=0;iteration<150;iteration++)for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const p=y*w+x;if(!unknown[p])continue;
      const neighbors=[x?p-1:-1,x+1<w?p+1:-1,y?p-w:-1,y+1<h?p+w:-1].filter(q=>q>=0);
      if(!neighbors.length)continue;
      for(let c=0;c<3;c++){let sum=0;for(const n of neighbors)sum+=field[n*3+c]!;field[p*3+c]=sum/neighbors.length;}
    }
    previous=field;pw=w;ph=h;
  }
  const result=Uint8Array.from(source);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const p=y*width+x;if(distance[p]!>=padding+feather)continue;
    const weight=Math.min(1,(padding+feather-distance[p]!)/feather);
    for(let c=0;c<3;c++)result[p*4+c]=Math.round(Math.max(0,Math.min(255,
      (donor[p*4+c]!+sample(previous!,pw,ph,(x+.5)*pw/width-.5,(y+.5)*ph/height-.5,c))*weight+source[p*4+c]!*(1-weight))));
  }
  return result;
}

function sample(field:Float32Array,w:number,h:number,x:number,y:number,c:number):number{
  x=Math.max(0,Math.min(w-1,x));y=Math.max(0,Math.min(h-1,y));
  const x0=Math.floor(x),y0=Math.floor(y),x1=Math.min(w-1,x0+1),y1=Math.min(h-1,y0+1),fx=x-x0,fy=y-y0;
  return (field[(y0*w+x0)*3+c]!*(1-fx)+field[(y0*w+x1)*3+c]!*fx)*(1-fy)+(field[(y1*w+x0)*3+c]!*(1-fx)+field[(y1*w+x1)*3+c]!*fx)*fy;
}

/** A shadow/reflection is the signed residual against the repaired background.
 * Exclude object pixels; coincident shadows are assigned by the caller once. */
export function extractShadowResidual(source:Uint8Array,background:Uint8Array,width:number,height:number,bounds:LayeringBox,excluded:Uint8Array):Uint8Array {
  if(source.length!==width*height*4||background.length!==source.length||excluded.length!==width*height)throw new Error('阴影提取像素尺寸无效');
  const result=new Uint8Array(source.length);
  const left=Math.floor(bounds.x*width),top=Math.floor(bounds.y*height),right=Math.min(width,Math.ceil((bounds.x+bounds.width)*width)),bottom=Math.min(height,Math.ceil((bounds.y+bounds.height)*height));
  const rawWidth=right-left,rawHeight=bottom-top,scale=Math.max(1,Math.ceil(Math.max(rawWidth,rawHeight)/512));
  const w=Math.ceil(rawWidth/scale),h=Math.ceil(rawHeight/scale),stride=w+1,radius=Math.min(width,height)>=64?Math.max(1,Math.round(Math.min(width,height)*.006/scale)):0;
  const feather=radius?Math.min(rawWidth/4,rawHeight/4,Math.min(width,height)*.025):0;
  const integrals=Array.from({length:4},()=>new Float64Array((w+1)*(h+1)));
  for(let y=0;y<h;y++){
    const sums=[0,0,0,0];
    for(let x=0;x<w;x++){
      for(let py=top+y*scale;py<Math.min(bottom,top+(y+1)*scale);py++)for(let px=left+x*scale;px<Math.min(right,left+(x+1)*scale);px++){
        const p=py*width+px;if(excluded[p])continue;
        for(let c=0;c<4;c++)sums[c]!+=c===3?1:source[p*4+c]!-background[p*4+c]!;
      }
      for(let c=0;c<4;c++)integrals[c]![(y+1)*stride+x+1]=integrals[c]![y*stride+x+1]!+sums[c]!;
    }
  }
  for(let y=Math.floor(bounds.y*height);y<Math.min(height,Math.ceil((bounds.y+bounds.height)*height));y++)for(let x=Math.floor(bounds.x*width);x<Math.min(width,Math.ceil((bounds.x+bounds.width)*width));x++){
    const p=y*width+x,o=p*4;if(excluded[p])continue;
    const sx=Math.floor((x-left)/scale),sy=Math.floor((y-top)/scale);
    const x0=Math.max(0,sx-radius),y0=Math.max(0,sy-radius),x1=Math.min(w,sx+radius+1),y1=Math.min(h,sy+radius+1);
    const sum=(c:number)=>integrals[c]![y1*stride+x1]!-integrals[c]![y0*stride+x1]!-integrals[c]![y1*stride+x0]!+integrals[c]![y0*stride+x0]!;
    const count=sum(3);if(!count)continue;
    const edge=feather?Math.max(0,Math.min(1,Math.min(x-left,y-top,right-1-x,bottom-1-y)/feather)):1;
    const colors=[0,1,2].map(c=>Math.max(0,Math.min(255,background[o+c]!+sum(c)/count*edge)));
    let a=0,difference=0;
    for(let c=0;c<3;c++){const C=colors[c]!,B=background[o+c]!;difference=Math.max(difference,Math.abs(C-B));a=Math.max(a,C<B?(B-C)/Math.max(1,B):(C-B)/Math.max(1,255-B));}
    if(difference<=1)continue;
    const alpha=Math.ceil(a*255);result[o+3]=alpha;
    for(let c=0;c<3;c++)result[o+c]=Math.round(Math.max(0,Math.min(255,(colors[c]!-(1-alpha/255)*background[o+c]!)/(alpha/255))));
  }
  return result;
}
