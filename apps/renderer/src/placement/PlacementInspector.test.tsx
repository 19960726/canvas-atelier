import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlacementBoard as PlacementBoardValue } from '@agent-canvas/domain';
import { PlacementInspector } from './PlacementInspector';

afterEach(() => cleanup());

const selectedBoard: PlacementBoardValue = {
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
    name: 'Hero product',
  }],
};

describe('PlacementInspector hierarchy hooks', () => {
  it('uses confined picker buttons and never accepts renderer File objects', () => {
    const onUploadReference = vi.fn();
    render(
      <PlacementInspector
        value={selectedBoard}
        selectedObjectId="product-1"
        onChange={() => {}}
        onUploadReference={onUploadReference}
      />,
    );

    const productUpload = screen.getByTestId('upload-product');
    expect(productUpload.tagName).toBe('BUTTON');
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(productUpload.closest('.placement-upload')).toHaveAttribute('data-reference-role', 'product_identity');
    expect(screen.getByTestId('upload-scene').closest('.placement-upload')).toHaveAttribute('data-reference-role', 'scene_composition');
    expect(screen.getByTestId('upload-prop').closest('.placement-upload')).toHaveAttribute('data-reference-role', 'prop_reference');
    expect(screen.getByTestId('upload-material').closest('.placement-upload')).toHaveAttribute('data-reference-role', 'material_lighting');

    fireEvent.click(productUpload);
    expect(onUploadReference).toHaveBeenCalledWith('product_identity');
  });

  it('groups selected object properties while preserving layer action states', () => {
    render(
      <PlacementInspector
        value={selectedBoard}
        selectedObjectId="product-1"
        onChange={() => {}}
      />,
    );

    expect(document.querySelector('.placement-properties__identity')).toBeVisible();
    expect(document.querySelector('.placement-properties__transform')).toBeVisible();
    expect(document.querySelector('.placement-properties__visibility')).toBeVisible();
    expect(document.querySelector('.placement-properties__layers')).toBeVisible();
    actionButtons().forEach((button) => expect(button).toBeEnabled());
  });

  it('keeps locked layer actions disabled exactly as before', () => {
    render(
      <PlacementInspector
        value={{ ...selectedBoard, objects: [{ ...selectedBoard.objects[0]!, locked: true }] }}
        selectedObjectId="product-1"
        onChange={() => {}}
      />,
    );

    actionButtons().forEach((button) => expect(button).toBeDisabled());
  });
});

function actionButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.placement-action-row button'));
}
