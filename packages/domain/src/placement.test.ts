import { describe, expect, it } from 'vitest';
import type { PlacementBoard, PlacementObject } from './project-schema';
import { normalizePlacementObject, placementToPromptConstraints } from './placement';

const board: PlacementBoard = {
  board: {
    id: 'board-1',
    aspectRatio: '4:5',
    width: 1080,
    height: 1350,
    safeAreas: [{ id: 'copy-top', x: 0.08, y: 0.08, w: 0.84, h: 0.15, purpose: 'copy_safe' }],
  },
  objects: [{
    id: 'product-1',
    assetId: 'asset-product',
    role: 'product_identity',
    x: 0.34,
    y: 0.42,
    w: 0.32,
    h: 0.38,
    rotation: 0,
    zIndex: 20,
    locked: true,
    visible: true,
    flipX: false,
    flipY: false,
    semanticLayer: 'hero_product',
    name: '主产品',
  }],
};

describe('normalizePlacementObject', () => {
  it('clamps normalized geometry and rotation while preserving placement metadata', () => {
    const input: PlacementObject = {
      ...board.objects[0]!,
      x: -0.2,
      y: 1.4,
      w: 1.2,
      h: -0.1,
      rotation: 270,
    };

    expect(normalizePlacementObject(input)).toMatchObject({
      x: 0,
      y: 0.98,
      w: 1,
      h: 0.02,
      rotation: 180,
      role: 'product_identity',
      locked: true,
      zIndex: 20,
    });
  });

  it('keeps the complete object inside the board with a selectable minimum size', () => {
    const input: PlacementObject = {
      ...board.objects[0]!,
      x: 0.9,
      y: 0.95,
      w: 0.4,
      h: 0,
    };

    expect(normalizePlacementObject(input)).toMatchObject({
      x: 0.6,
      y: 0.95,
      w: 0.4,
      h: 0.02,
    });
  });
});

describe('placementToPromptConstraints', () => {
  it('converts product geometry and copy-safe areas into prompt constraints', () => {
    expect(placementToPromptConstraints(board)).toEqual(expect.arrayContaining([
      '主产品位于画面水平 34% 至 66% 区间',
      '主产品约占画面宽度 32%',
      '主产品位于画面垂直 42% 至 80% 区间',
      '主产品约占画面高度 38%',
      '顶部 8% 至 23% 为文案安全区，禁止产品和道具侵入',
    ]));
  });

  it('makes locked placement override scene composition without weakening product identity', () => {
    expect(placementToPromptConstraints(board)).toEqual(expect.arrayContaining([
      '锁定主产品的摆放位置与尺寸，摆放预览优先于场景构图',
      '保持主产品身份、外形、品牌颜色与标志可读性',
    ]));
  });

  it('describes horizontal and vertical flips', () => {
    const flippedBoard: PlacementBoard = {
      ...board,
      objects: [{ ...board.objects[0]!, flipX: true, flipY: true }],
    };

    expect(placementToPromptConstraints(flippedBoard)).toEqual(expect.arrayContaining([
      '主产品需要水平翻转',
      '主产品需要垂直翻转',
    ]));
  });

  it('excludes hidden objects from prompt constraints', () => {
    const hiddenBoard: PlacementBoard = {
      ...board,
      objects: [{ ...board.objects[0]!, visible: false, name: '隐藏产品' }],
    };

    expect(placementToPromptConstraints(hiddenBoard).join('\n')).not.toContain('隐藏产品');
  });
});