import {expect,it} from 'vitest';
import {refineGlassForeground} from './glass-refinement.js';

it('removes an opaque backdrop mistake in explicit glass regions without moving pixels or changing protected solids',()=>{
  const width=80,height=24,source=new Uint8Array(width*height*4),foreground=new Uint8Array(source.length);
  for(let p=0;p<width*height;p++)source.set([200,180,160,255],p*4);
  for(let y=4;y<20;y++)for(let x=20;x<60;x++){const p=(y*width+x)*4;source.set([180,162,144,255],p);foreground.set([180,162,144,255],p);}
  const protectedPixel=(10*width+40)*4;source.set([90,10,5,255],protectedPixel);foreground.set(source.slice(protectedPixel,protectedPixel+4),protectedPixel);
  const before=source.slice();const result=refineGlassForeground(source,foreground,width,height,{x:.25,y:0,width:.5,height:1},[
    {mode:'glass',box:{x:.25,y:0,width:.5,height:1}},
    {mode:'keep',box:{x:.5,y:10/24,width:1/80,height:1/24}},
  ]);
  const p=(12*width+30)*4,a=result[p+3]!/255;
  expect(a).toBeLessThan(.25);expect(a).toBeGreaterThan(.09);
  for(let c=0;c<3;c++)expect(Math.abs(result[p+c]!*a+before[p+c]!/ .9*(1-a)-before[p+c]!)).toBeLessThanOrEqual(1);
  expect(result.slice(protectedPixel,protectedPixel+4)).toEqual(foreground.slice(protectedPixel,protectedPixel+4));
  expect(source).toEqual(before);expect(result[3]).toBe(0);
});

it('does not extrapolate glass color when both clean background sides are unavailable',()=>{
  const rgba=new Uint8Array(16*16*4).fill(200);for(let i=3;i<rgba.length;i+=4)rgba[i]=255;
  expect(refineGlassForeground(rgba,rgba,16,16,{x:0,y:0,width:1,height:1},[{mode:'glass',box:{x:0,y:0,width:1,height:1}}])).toEqual(rgba);
});

it('keeps confidently opaque dark internal components continuous across a keep rectangle',()=>{
  const w=80,h=24,source=new Uint8Array(w*h*4),foreground=new Uint8Array(source.length);
  for(let p=0;p<w*h;p++)source.set([200,180,160,255],p*4);
  for(let y=4;y<20;y++)for(let x=20;x<60;x++){const p=(y*w+x)*4;source.set([110,30,20,255],p);foreground.set([110,30,20,255],p);}
  const result=refineGlassForeground(source,foreground,w,h,{x:.25,y:0,width:.5,height:1},[
    {mode:'glass',box:{x:.25,y:0,width:.5,height:1}},{mode:'keep',box:{x:.5,y:.25,width:.15,height:.5}},
  ]);
  expect(result).toEqual(foreground);
});

it('does not recolor a neighboring pixel beyond an integer glass rectangle after normalization', () => {
  const width = 76, height = 24, source = new Uint8Array(width * height * 4), foreground = new Uint8Array(source.length);
  for (let p = 0; p < width * height; p++) source.set([200, 180, 160, 255], p * 4);
  for (let y = 4; y < 20; y++) for (let x = 20; x < 60; x++) {
    const p = (y * width + x) * 4;
    source.set([180, 162, 144, 255], p); foreground.set([180, 162, 144, 255], p);
  }
  // 52/76 + 4/76 maps to 56.00000000000001 with IEEE arithmetic.
  const result = refineGlassForeground(source, foreground, width, height, { x: 20 / width, y: 0, width: 40 / width, height: 1 }, [
    { mode: 'glass', box: { x: 52 / width, y: 4 / height, width: 4 / width, height: 16 / height } },
  ]);
  expect(result[(10 * width + 55) * 4 + 3]).toBeLessThan(255);
  const neighbor = (10 * width + 56) * 4;
  expect(result.slice(neighbor, neighbor + 4)).toEqual(foreground.slice(neighbor, neighbor + 4));
});
