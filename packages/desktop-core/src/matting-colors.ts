/** Separate foreground and backdrop colors using C = a F + (1-a) B and local smoothness. */
export function estimateMatteForeground(rgba: Uint8Array, width: number, height: number): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 12_000_000 || rgba.length !== width * height * 4)
    throw new Error('精修颜色的像素尺寸无效');
  const rgb = new Float32Array(width * height * 3), alpha = new Float32Array(width * height);
  for (let p=0;p<alpha.length;p++) { alpha[p]=rgba[p*4+3]!/255; for(let c=0;c<3;c++)rgb[p*3+c]=rgba[p*4+c]!/255; }
  const scales: [number,number][]=[];
  for(let factor=1;factor<Math.max(width,height)*2;factor*=2) {
    const w=Math.max(1,Math.ceil(width/factor)),h=Math.max(1,Math.ceil(height/factor));
    scales.push([w,h]); if(w===1&&h===1)break;
  }
  scales.reverse();
  let foreground: Float32Array | undefined, backdrop: Float32Array | undefined, previousWidth=1,previousHeight=1;
  for(const [w,h] of scales) {
    const image=resize(rgb,width,height,w,h,3),aMap=resize(alpha,width,height,w,h,1);
    const f: Float32Array=foreground?resize(foreground,previousWidth,previousHeight,w,h,3):image.slice();
    const b: Float32Array=backdrop?resize(backdrop,previousWidth,previousHeight,w,h,3):image.slice();
    for(let iteration=0;iteration<(Math.max(w,h)<64?20:5);iteration++) {
      for(let y=0;y<h;y++)for(let x=0;x<w;x++) {
        const p=y*w+x,a=aMap[p]!,inverse=1-a;
        const neighbors=[x>0?p-1:-1,x+1<w?p+1:-1,y>0?p-w:-1,y+1<h?p+w:-1].filter(q=>q>=0);
        let sum=.00001;
        const weights=neighbors.map(q=>{const value=.00001+Math.abs(a-aMap[q]!);sum+=value;return value;});
        const ff=a*a+sum,bb=inverse*inverse+sum,fb=a*inverse,det=ff*bb-fb*fb;
        for(let c=0;c<3;c++) {
          const index=p*3+c;
          let rf=a*image[index]!+.00001*f[index]!,rb=inverse*image[index]!+.00001*b[index]!;
          for(let j=0;j<neighbors.length;j++){rf+=weights[j]!*f[neighbors[j]!*3+c]!;rb+=weights[j]!*b[neighbors[j]!*3+c]!;}
          f[index]=a>.9999?image[index]!:Math.max(0,Math.min(1,(bb*rf-fb*rb)/det));
          b[index]=a<.0001?image[index]!:Math.max(0,Math.min(1,(ff*rb-fb*rf)/det));
        }
      }
    }
    foreground=f;backdrop=b;previousWidth=w;previousHeight=h;
  }
  const result=rgba.slice();
  for(let p=0;p<alpha.length;p++) {
    if(!result[p*4+3]) result.fill(0,p*4,p*4+4);
    else if(result[p*4+3]!==255) for(let c=0;c<3;c++)result[p*4+c]=Math.round(foreground![p*3+c]!*255);
  }
  return result;
}

function resize(data: Float32Array,w: number,h: number,nw: number,nh: number,channels: number): Float32Array {
  const out=new Float32Array(nw*nh*channels);
  for(let y=0;y<nh;y++)for(let x=0;x<nw;x++) {
    const sx=Math.max(0,Math.min(w-1,(x+.5)*w/nw-.5)),sy=Math.max(0,Math.min(h-1,(y+.5)*h/nh-.5));
    const x0=Math.floor(sx),y0=Math.floor(sy),x1=Math.min(w-1,x0+1),y1=Math.min(h-1,y0+1),fx=sx-x0,fy=sy-y0;
    for(let c=0;c<channels;c++)out[(y*nw+x)*channels+c]=(data[(y0*w+x0)*channels+c]!*(1-fx)+data[(y0*w+x1)*channels+c]!*fx)*(1-fy)
      +(data[(y1*w+x0)*channels+c]!*(1-fx)+data[(y1*w+x1)*channels+c]!*fx)*fy;
  }
  return out;
}
