import { expect, it } from 'vitest';
import { createLocalMattingPrompts, createSourceTrimap, parseLocalMattingRequest } from './local-matting.js';

it('uses keep and glass corrections as foreground hints and clear corrections as background hints', () => {
  const bounds = { x: .2, y: .2, width: .6, height: .6 };
  expect(createLocalMattingPrompts(100, 200, bounds, [
    { mode: 'keep', box: { x: .1, y: .05, width: .1, height: .1 } },
    { mode: 'clear', box: { x: .4, y: .4, width: .2, height: .1 } },
    { mode: 'glass', box: { x: .7, y: .2, width: .1, height: .1 } },
  ])).toEqual({ points: [[15, 20], [75, 50], [50, 90]], labels: [1, 1, 0] });
  expect(createLocalMattingPrompts(100, 200, bounds, [])).toEqual({ points: [[50, 100]], labels: [1] });
  expect(createLocalMattingPrompts(1, 1, { x: 0, y: 0, width: 1, height: 1 }, []))
    .toEqual({ points: [[0, 0]], labels: [1] });
});

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

it('does not force a neighboring pixel when an integer source rectangle is normalized', () => {
  const width = 2196, height = 8;
  const region = { box: { x: 970 / width, y: .25, width: 8 / width, height: .25 } };
  const kept = createSourceTrimap(new Uint8Array(width * height), width, height, 1, [{ ...region, mode: 'keep' }]);
  expect(kept[2 * width + 969]).toBe(0);
  expect(kept[2 * width + 970]).toBe(255);
  expect(kept[3 * width + 977]).toBe(255);
  expect(kept[3 * width + 978]).toBe(0);
  expect([...kept].filter(value => value === 255)).toHaveLength(16);

  const cleared = createSourceTrimap(new Uint8Array(width * height).fill(255), width, height, 1, [{ ...region, mode: 'clear' }]);
  expect(cleared[2 * width + 969]).toBe(255);
  expect(cleared[2 * width + 970]).toBe(0);
  expect([...cleared].filter(value => value === 0)).toHaveLength(16);
});

it('does not add a row or column at the far edge of normalized keep and glass rectangles', () => {
  const width = 19, height = 19;
  const box = { x: 11 / width, y: 11 / height, width: 3 / width, height: 3 / height };
  for (const mode of ['keep', 'glass'] as const) {
    const result = createSourceTrimap(new Uint8Array(width * height), width, height, 1, [{ mode, box }]);
    expect(result[13 * width + 13]).toBe(mode === 'keep' ? 255 : 128);
    expect(result[13 * width + 14]).toBe(0);
    expect(result[14 * width + 13]).toBe(0);
    expect([...result].filter(value => value !== 0)).toHaveLength(9);
  }
});

it('still covers genuinely fractional source pixels instead of rounding the rectangle inward', () => {
  const width = 19, height = 19;
  const result = createSourceTrimap(new Uint8Array(width * height), width, height, 1, [{ mode: 'keep',
    box: { x: 5.25 / width, y: 6.75 / height, width: 1.5 / width, height: 1.5 / height } }]);
  expect(result[6 * width + 5]).toBe(255);
  expect(result[8 * width + 6]).toBe(255);
  expect(result[8 * width + 7]).toBe(0);
  expect(result[9 * width + 6]).toBe(0);
  expect([...result].filter(value => value === 255)).toHaveLength(6);
});
