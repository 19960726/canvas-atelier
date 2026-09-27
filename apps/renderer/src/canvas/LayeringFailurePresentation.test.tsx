import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { ImageLayerNodeWorkbench } from './ImageLayerNodeWorkbench';
vi.mock('./source-layer-preview', () => ({ useSourceLayerPreview: () => ({ preview: null, error: '水流蒙版与背景不匹配' }) }));
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
