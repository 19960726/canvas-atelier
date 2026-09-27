import {expect,it} from 'vitest';
import {repairLayerBackground,extractShadowResidual} from './layer-background-repair';

it('matches an exposure-shifted donor to the original border while retaining native texture and untouched exterior',()=>{
  const w=96,h=96,source=new Uint8Array(w*h*4),donor=new Uint8Array(source.length),coverage=new Uint8Array(w*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const p=y*w+x,v=150+((x+y)%2)*10;
    source.set([v,v,v,255],p*4);donor.set([v-35,v-35,v-35,255],p*4);
    if(x>=30&&x<66&&y>=30&&y<66){coverage[p]=255;source.set([180,0,0,255],p*4);}
  }
  const before=source.slice(),result=repairLayerBackground(source,donor,w,h,coverage);
  expect(result.slice(0,4)).toEqual(source.slice(0,4));expect(source).toEqual(before);
  expect(result[(48*w+48)*4]).toBeGreaterThan(145);expect(result[(48*w+48)*4]).toBeLessThan(155);
  expect(result[(48*w+49)*4]! -result[(48*w+48)*4]!).toBeGreaterThan(7);
});

it('extracts a translucent shadow without copying an opaque object or duplicating the clean background',()=>{
  const source=Uint8Array.from([100,90,80,255,210,20,20,255,200,180,160,255]);
  const bg=Uint8Array.from([200,180,160,255,200,180,160,255,200,180,160,255]);
  const result=extractShadowResidual(source,bg,3,1,{x:0,y:0,width:1,height:1},Uint8Array.from([0,255,0]));
  const a=result[3]!/255;expect(a).toBeGreaterThan(.49);expect(a).toBeLessThan(.55);
  for(let c=0;c<3;c++)expect(Math.abs(result[c]!*a+bg[c]!*(1-a)-source[c]!)).toBeLessThanOrEqual(1);
  expect(result[7]).toBe(0);expect(result[11]).toBe(0);
});

it('does not turn background texture differences into a hard rectangular shadow patch',()=>{
  const w=100,h=100,source=new Uint8Array(w*h*4),background=new Uint8Array(source.length);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const p=(y*w+x)*4;source.set([140+(x%2)*20,140,140,255],p);background.set([180,180,180,255],p);}
  const result=extractShadowResidual(source,background,w,h,{x:.2,y:.2,width:.6,height:.6},new Uint8Array(w*h));
  expect(result[(20*w+50)*4+3]).toBe(0);expect(result[(50*w+50)*4+3]).toBeGreaterThan(20);
  expect(Math.abs(result[(50*w+50)*4+3]!-result[(50*w+51)*4+3]!)).toBeLessThan(8);
});
