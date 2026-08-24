import { describe, expect, it } from 'vitest';
import { getCanvasBezierMidpoint, getCanvasBezierPath, shouldShowCanvasEdgeCancel } from './CanvasBezierEdge';

describe('getCanvasBezierPath', () => {
  it('keeps horizontally aligned ports on a visible smooth Bezier arc', () => {
    const path = getCanvasBezierPath({ sourceX: 240, sourceY: 336, targetX: 520, targetY: 336 });

    expect(path).toContain('C');
    expect(path).not.toContain(' L ');
    expect(path).not.toContain('H');
    expect(path).not.toContain('V');
    expect(path).not.toBe('M 240,336 L 520,336');
  });

  it('gives near-vertical upstream insert edges enough lateral bow to separate them from neighboring links', () => {
    const path = getCanvasBezierPath({ sourceX: 317, sourceY: 583, targetX: 342, targetY: 360 });

    expect(path).toContain('C 395.05,');
    expect(path).toContain('263.95,');
  });
});

describe('getCanvasBezierMidpoint', () => {
  it('places the cancel control on the middle of the curved connector', () => {
    expect(getCanvasBezierMidpoint({ sourceX: 100, sourceY: 200, targetX: 500, targetY: 360 })).toEqual({ x: 300, y: 259 });
  });
});

describe('shouldShowCanvasEdgeCancel', () => {
  it('shows the cancel control only while a disconnectable edge is hovered', () => {
    expect(shouldShowCanvasEdgeCancel({ hasCancelHandler: true, hovered: false })).toBe(false);
    expect(shouldShowCanvasEdgeCancel({ hasCancelHandler: true, hovered: true })).toBe(true);
    expect(shouldShowCanvasEdgeCancel({ hasCancelHandler: false, hovered: true })).toBe(false);
  });
});
