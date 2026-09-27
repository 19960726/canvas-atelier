import { expect, it } from 'vitest';
import { estimateMatteForeground } from './matting-colors.js';
it('removes backdrop color from a translucent edge while preserving opaque source colors', () => {
  const width=32,height=8,rgba=new Uint8Array(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const a=x<10?1:x>21?0:(21-x)/11,i=(y*width+x)*4;
    rgba.set([Math.round(a*255),0,Math.round((1-a)*255),Math.round(a*255)],i);
  }
  const result=estimateMatteForeground(rgba,width,height);
  const edge=(4*width+15)*4;
  expect(result[edge]).toBeGreaterThan(245);
  expect(result[edge+2]).toBeLessThan(10);
  expect(result[edge+3]).toBe(rgba[edge+3]);
  expect([...result.slice(0,4)]).toEqual([255,0,0,255]);
});
