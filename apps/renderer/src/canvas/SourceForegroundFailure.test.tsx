import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { ImageLayerNodeWorkbench } from './ImageLayerNodeWorkbench';

vi.mock('../app/managed-layer-pixels', () => ({
  decodeLayerPixels: async () => { throw new Error('返回蒙版与标注的原图位置不符'); },
  layerPixelsUrl: vi.fn(),
}));
afterEach(cleanup);

it('surfaces an individual extraction failure before the other layers finish', async () => {
  render(<ImageLayerNodeWorkbench nodeId="hand" validatePixels={false}
    config={{ name: '手臂', layerId: 'hand', layerKind: 'transparent', pixelMode: 'source', maskSpace: 'source',
      sourceBounds: { x: 0, y: 0, width: .5, height: .5 }, resultAssetId: 'mask', qualityStatus: 'passed' }}
    asset={{ assetId: 'mask', displayUrl: 'mask.png', mediaType: 'image/png', width: 4, height: 4 }}
    sourceAsset={{ assetId: 'source', displayUrl: 'source.png', mediaType: 'image/png', width: 4, height: 4 }}
    onQualityResult={vi.fn()} onVisibilityChange={vi.fn()} />);
  await screen.findByText('返回蒙版与标注的原图位置不符');
  expect(screen.getByRole('region', { name: '画布图层：手臂' })).toHaveAttribute('data-layer-status', 'blocked');
  expect(screen.queryByText('格式检查通过 · 待检查边缘')).not.toBeInTheDocument();
});
