import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { PlacementBoard as PlacementBoardValue } from '@agent-canvas/domain';
import { PlacementBoard } from './PlacementBoard';
import { PlacementInspector } from './PlacementInspector';

afterEach(() => cleanup());

const initialValue: PlacementBoardValue = {
  board: {
    id: 'board-1',
    aspectRatio: '4:5',
    width: 1080,
    height: 1350,
    safeAreas: [],
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
    locked: false,
    visible: true,
    flipX: false,
    flipY: false,
    semanticLayer: 'hero_product',
    name: '主产品',
  }],
};

function BoardHarness({ rotation = 0 }: { rotation?: number }) {
  const [value, setValue] = useState({
    ...initialValue,
    objects: [{ ...initialValue.objects[0]!, rotation }],
  });
  return (
    <>
      <PlacementBoard value={value} selectedObjectId="product-1" onChange={setValue} onSelect={() => {}} />
      <output data-testid="board-state">{JSON.stringify(value)}</output>
    </>
  );
}

function InspectorHarness({ locked = false, zIndex = 20 }: { locked?: boolean; zIndex?: number }) {
  const [value, setValue] = useState({
    ...initialValue,
    objects: [{ ...initialValue.objects[0]!, locked, zIndex }],
  });
  return (
    <>
      <PlacementInspector value={value} selectedObjectId="product-1" onChange={setValue} />
      <output data-testid="inspector-state">{JSON.stringify(value)}</output>
    </>
  );
}

function setBoardRect(element: HTMLElement) {
  Object.defineProperty(element, 'getBoundingClientRect', {
    value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 500, bottom: 500, width: 500, height: 500, toJSON: () => ({}) }),
  });
}

describe('PlacementBoard', () => {
  it('drags and resizes objects using normalized board coordinates', () => {
    render(<BoardHarness />);
    const board = screen.getByTestId('placement-board');
    const object = screen.getByTestId('placement-object-product-1');
    setBoardRect(board);

    fireEvent.pointerDown(object, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(board, { clientX: 150, clientY: 125, pointerId: 1 });
    fireEvent.pointerUp(board, { pointerId: 1 });

    let state = JSON.parse(screen.getByTestId('board-state').textContent ?? '{}') as PlacementBoardValue;
    expect(state.objects[0]?.x).toBeCloseTo(0.44);
    expect(state.objects[0]?.y).toBeCloseTo(0.47);

    fireEvent.pointerDown(screen.getByLabelText('缩放主产品'), { clientX: 150, clientY: 125, pointerId: 2 });
    fireEvent.pointerMove(board, { clientX: 200, clientY: 175, pointerId: 2 });
    fireEvent.pointerUp(board, { pointerId: 2 });

    state = JSON.parse(screen.getByTestId('board-state').textContent ?? '{}') as PlacementBoardValue;
    expect(state.objects[0]?.w).toBeCloseTo(0.42);
    expect(state.objects[0]?.h).toBeCloseTo(0.48);
  });

  it('resizes a rotated object in its local coordinate system', () => {
    render(<BoardHarness rotation={90} />);
    const board = screen.getByTestId('placement-board');
    setBoardRect(board);

    fireEvent.pointerDown(screen.getByLabelText('从e缩放主产品'), { clientX: 200, clientY: 200, pointerId: 3 });
    fireEvent.pointerMove(board, { clientX: 200, clientY: 250, pointerId: 3 });
    fireEvent.pointerUp(board, { pointerId: 3 });

    const state = JSON.parse(screen.getByTestId('board-state').textContent ?? '{}') as PlacementBoardValue;
    expect(state.objects[0]?.w).toBeCloseTo(0.42);
    expect(state.objects[0]?.h).toBeCloseTo(0.38);
  });

  it('does not move locked objects', () => {
    render(<PlacementBoard value={{ ...initialValue, objects: [{ ...initialValue.objects[0]!, locked: true }] }} selectedObjectId="product-1" onChange={() => { throw new Error('locked object changed'); }} onSelect={() => {}} />);
    const board = screen.getByTestId('placement-board');
    setBoardRect(board);

    fireEvent.pointerDown(screen.getByTestId('placement-object-product-1'), { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(board, { clientX: 200, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(board, { pointerId: 1 });
  });
});

describe('PlacementInspector', () => {
  it('changes role, lock state, and layer order', () => {
    render(<InspectorHarness />);

    fireEvent.change(screen.getByLabelText('参考职责'), { target: { value: 'prop_reference' } });
    fireEvent.click(screen.getByLabelText('上移一层'));
    fireEvent.click(screen.getByLabelText('锁定对象'));

    const state = JSON.parse(screen.getByTestId('inspector-state').textContent ?? '{}') as PlacementBoardValue;
    expect(state.objects[0]).toMatchObject({ role: 'prop_reference', locked: true, zIndex: 21 });
  });

  it('disables transform controls while the object is locked', () => {
    render(<InspectorHarness locked />);

    expect(screen.getByLabelText('旋转角度')).toBeDisabled();
    expect(screen.getByLabelText('水平翻转')).toBeDisabled();
    expect(screen.getByLabelText('垂直翻转')).toBeDisabled();
    expect(screen.getByLabelText('下移一层')).toBeDisabled();
    expect(screen.getByLabelText('上移一层')).toBeDisabled();
  });

  it('does not move a layer below zero', () => {
    render(<InspectorHarness zIndex={0} />);

    fireEvent.click(screen.getByLabelText('下移一层'));

    const state = JSON.parse(screen.getByTestId('inspector-state').textContent ?? '{}') as PlacementBoardValue;
    expect(state.objects[0]?.zIndex).toBe(0);
  });
});