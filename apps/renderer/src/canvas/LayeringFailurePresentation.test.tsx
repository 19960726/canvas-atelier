import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { ImageLayerNodeWorkbench } from './ImageLayerNodeWorkbench';
const previewState = vi.hoisted(() => ({ error: '水流蒙版与背景不匹配' }));
vi.mock('./source-layer-preview', () => ({ useSourceLayerPreview: () => ({ preview: null, error: previewState.error }) }));
afterEach(cleanup);
it('does not present a shared composition failure as a passed layer or cover the preview with the full error', () => {
  render(<ImageLayerNodeWorkbench nodeId="cup" config={{ layerId: 'cup', name: '杯身', pixelMode: 'source',
    resultAssetId: 'cup', qualityStatus: 'passed', layerSelection: { mode: 'whole' } }}
    asset={{ assetId: 'cup', displayUrl: 'cup.png', mediaType: 'image/png', width: 2, height: 2 }}
    sourceDocumentInput={{ sourceUrl: 'source', width: 2, height: 2, selection: { mode: 'whole' }, layers: [] }}
    validatePixels={false} onQualityResult={() => {}} onVisibilityChange={() => {}} />);
  expect(screen.getByText('合成受阻 · 图片已返回')).toBeVisible();
  expect(screen.getByText('水流蒙版与背景不匹配').closest('details')).not.toBeNull();
  expect(screen.queryByText('格式检查通过 · 待检查边缘')).not.toBeInTheDocument();
});

it('names returned masks with duplicate content instead of calling the issue a generic composition problem', () => {
  previewState.error = '图层“杯身”与“握杯手部”的内容重叠 86%；返图混入其他物体';
  render(<ImageLayerNodeWorkbench nodeId="hand" config={{ layerId: 'hand', name: '握杯手部', pixelMode: 'source',
    resultAssetId: 'hand', qualityStatus: 'passed', layerSelection: { mode: 'whole' } }}
    asset={{ assetId: 'hand', displayUrl: 'hand.png', mediaType: 'image/png', width: 2, height: 2 }}
    sourceDocumentInput={{ sourceUrl: 'source', width: 2, height: 2, selection: { mode: 'whole' }, layers: [] }}
    validatePixels={false} onQualityResult={() => {}} onVisibilityChange={() => {}} />);
  expect(screen.getByText('内容重叠 · 图片已返回')).toBeVisible();
  expect(screen.getByText(/杯身.*握杯手部.*86%/).closest('details')).not.toBeNull();
  expect(screen.getByText('查看图层内容重叠原因')).toBeVisible();
});
