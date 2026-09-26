import { useState } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createCanvasModuleNode } from '@agent-canvas/domain';
import { ImageLayerValidationQueue } from './ImageLayerValidationQueue';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('reports missing returned assets even when the store absorbs a catalog read failure, and offers local retry', async () => {
  const node = createCanvasModuleNode('missing', 'image_layer', { x: 50000, y: 50000 });
  node.data.config = { resultAssetId: 'missing-output', qualityStatus: 'pending' };
  const refresh = vi.fn(async () => {});
  const view = render(<ImageLayerValidationQueue projectId="project" nodes={[node]} assets={[]} onQualityResult={vi.fn()} onRefreshAssets={refresh} />);
  await waitFor(() => expect(view.getByRole('alert').textContent).toContain('未能读取'));
  fireEvent.click(view.getByRole('button', { name: '重新读取并检查' }));
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
});
it('waits for the source asset before validating a scoped background', async () => {
  const node = createCanvasModuleNode('scoped', 'image_layer', { x: 50000, y: 50000 });
  node.data.config = { resultAssetId: 'output', sourceAssetId: 'source', qualityStatus: 'pending', layerKind: 'background', layerSelection: { mode: 'region', box: { x: 0, y: 0, width: .5, height: .5 } } };
  const saved = vi.fn(); const refresh = vi.fn(async () => {});
  const view = render(<ImageLayerValidationQueue projectId="project" nodes={[node]} assets={[{ assetId: 'output', displayUrl: 'local-output', mediaType: 'image/png', width: 2, height: 2 }]} onQualityResult={saved} onRefreshAssets={refresh} />);
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  await waitFor(() => expect(view.getByRole('alert')).toBeTruthy());
  expect(saved).not.toHaveBeenCalled();
});
it('validates offscreen returned layers serially without mounting their canvas nodes', async () => {
  let active = 0, maximum = 0;
  class TestImage {
    naturalWidth = 2; naturalHeight = 2; crossOrigin = ''; src = '';
    async decode() { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; }
  }
  vi.stubGlobal('Image', TestImage);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn(),
    getImageData: () => ({ data: new Uint8ClampedArray(16).fill(255) }),
  } as never);
  const nodes = [0, 1].map(i => {
    const node = createCanvasModuleNode(`offscreen-${i}`, 'image_layer', { x: 50000, y: 50000 });
    node.data.config = { ...node.data.config, resultAssetId: `asset-${i}`, layerKind: 'background', canvasWidth: 2, canvasHeight: 2, qualityStatus: 'pending' };
    return node;
  });
  const assets = nodes.map((node, i) => ({ assetId: `asset-${i}`, displayUrl: `novus-asset://asset-${i}`, mediaType: 'image/png' as const, width: 2, height: 2 }));
  const saved = vi.fn();
  function Fixture() {
    const [current, setCurrent] = useState(nodes);
    return <ImageLayerValidationQueue projectId="project" nodes={current} assets={assets} onRefreshAssets={async () => {}}
      onQualityResult={async (nodeId, assetId, verdict) => { saved(nodeId, assetId, verdict); setCurrent(items => items.map(node => node.id !== nodeId ? node
        : { ...node, data: { ...node.data, config: { ...node.data.config, qualityStatus: verdict.ok ? 'passed' : 'failed', qualityValidationVersion: 2 } } })); }} />;
  }
  const view = render(<Fixture />);
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(2));
  expect(saved.mock.calls.every(call => call[2].ok)).toBe(true);
  expect(maximum).toBe(1);
  expect(view.container.querySelector('[data-layer-node-id]')).toBeNull();
});
