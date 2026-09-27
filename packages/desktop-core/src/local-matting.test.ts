import { expect, it } from 'vitest';
import { createSourceTrimap, parseLocalMattingRequest } from './local-matting.js';

it('rejects mismatched pixel buffers and out-of-frame refinement regions', () => {
  expect(() => parseLocalMattingRequest({width:8,height:8,rgba:new Uint8Array(12),bounds:{x:0,y:0,width:1,height:1},regions:[]})).toThrow();
  expect(() => parseLocalMattingRequest({width:8,height:8,rgba:new Uint8Array(256),bounds:{x:0,y:0,width:1,height:1},regions:[{mode:'clear',box:{x:.9,y:0,width:.4,height:1}}]})).toThrow();
});

it('keeps an interior foreground and builds an unknown band on both sides without moving the mask', () => {
  const mask=new Uint8Array(15*15);
  for(let y=4;y<11;y++)for(let x=4;x<11;x++)mask[y*15+x]=255;
  const trimap=createSourceTrimap(mask,15,15,1,[]);
  expect(trimap[0]).toBe(0);
  expect(trimap[7*15+7]).toBe(255);
  expect(trimap[7*15+3]).toBe(128);
  expect(trimap[7*15+4]).toBe(128);
  expect([...new Set(trimap)].sort()).toEqual([0,128,255]);
});

it('retains ordered keep / clear / glass corrections at original pixel coordinates', () => {
  const mask=new Uint8Array(8*8).fill(255);
  const trimap=createSourceTrimap(mask,8,8,1,[
    {mode:'glass',box:{x:.25,y:.25,width:.5,height:.5}},
    {mode:'keep',box:{x:.375,y:.375,width:.125,height:.125}},
    {mode:'clear',box:{x:.5,y:.5,width:.125,height:.125}},
  ]);
  expect(trimap[2*8+2]).toBe(128);
  expect(trimap[3*8+3]).toBe(255);
  expect(trimap[4*8+4]).toBe(0);
  expect(trimap[6*8+6]).toBe(255);
});
