import { useState } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createCanvasModuleNode } from '@agent-canvas/domain';
import { ImageLayerValidationQueue } from './ImageLayerValidationQueue';
import { needsLayerPixelValidation } from './ImageLayerNodeWorkbench';

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
        : { ...node, data: { ...node.data, config: { ...node.data.config, qualityStatus: verdict.ok ? 'passed' : 'failed', qualityValidationVersion: 2,
          formatQualityStatus: verdict.ok ? 'passed' : 'failed', qualityFormatCheckedAssetId: assetId } } })); }} />;
  }
  const view = render(<Fixture />);
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(2));
  expect(saved.mock.calls.every(call => call[2].ok)).toBe(true);
  expect(maximum).toBe(1);
  expect(view.container.querySelector('[data-layer-node-id]')).toBeNull();
});

it('advances through independent RGBA candidates after format checks while semantic review stays pending', async () => {
  let active = 0, maximum = 0;
  const decoded: string[] = [];
  class TestImage {
    naturalWidth = 2; naturalHeight = 2; crossOrigin = ''; src = '';
    async decode() {
      decoded.push(this.src);
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
    }
  }
  vi.stubGlobal('Image', TestImage);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn(),
    getImageData: () => ({ data: new Uint8ClampedArray([30, 60, 90, 255, 30, 60, 90, 64, 0, 0, 0, 0, 0, 0, 0, 0]) }),
  } as never);
  const nodes = [0, 1, 2].map(index => {
    const node = createCanvasModuleNode(`rgba-candidate-${index}`, 'image_layer', { x: 50000, y: 50000 });
    node.data.config = { resultAssetId: `rgba-${index}`, layerKind: 'transparent', canvasWidth: 2, canvasHeight: 2,
      pixelMode: 'source', qualityStatus: 'pending', status: 'validating',
      layeringOutputContract: 'source-independent-rgba-v2', resultRepresentation: 'independent-rgba-candidate' };
    return node;
  });
  const assets = nodes.map((node, index) => ({ assetId: `rgba-${index}`, displayUrl: `novus-asset://rgba-${index}`,
    mediaType: 'image/png' as const, width: 2, height: 2 }));
  const saved = vi.fn();
  let latest = nodes;
  function Fixture() {
    const [current, setCurrent] = useState(nodes);
    latest = current;
    return <ImageLayerValidationQueue projectId="project" nodes={current} assets={assets} onRefreshAssets={async () => {}}
      onQualityResult={async (nodeId, assetId, verdict) => {
        saved(nodeId, assetId, verdict);
        setCurrent(items => items.map(node => node.id !== nodeId ? node : { ...node, data: { ...node.data, config: {
          ...node.data.config, qualityStatus: verdict.ok ? 'pending' : 'failed', qualityValidationVersion: 2,
          formatQualityStatus: verdict.ok ? 'passed' : 'failed', qualityFormatCheckedAssetId: assetId,
        } } }));
      }} />;
  }
  render(<Fixture />);
  await waitFor(() => expect(saved.mock.calls.map(call => call[0])).toEqual(nodes.map(node => node.id)));
  expect(saved.mock.calls.every(call => call[2].ok)).toBe(true);
  expect(decoded).toEqual(assets.map(asset => asset.displayUrl));
  expect(maximum).toBe(1);
  for (const node of latest) {
    expect(node.data.config.qualityStatus).toBe('pending');
    expect(node.data.config.semanticReviewAccepted).toBeUndefined();
    expect(needsLayerPixelValidation(node.data.config)).toBe(false);
  }
});

it.each([
  { qualityFormatCheckedAssetId: 'old-result', qualityValidationVersion: 2 },
  { qualityFormatCheckedAssetId: 'current-result', qualityValidationVersion: 1 },
  { qualityFormatCheckedAssetId: 'current-result', qualityValidationVersion: undefined },
])('requires a new format check for a stale asset binding or validation version: %o', stale => {
  expect(needsLayerPixelValidation({ resultAssetId: 'current-result', qualityStatus: 'pending',
    formatQualityStatus: 'passed', ...stale })).toBe(true);
});

it.each([
  { qualityValidationVersion: 2 },
  { formatQualityStatus: 'passed', qualityFormatCheckedAssetId: 'old-result', qualityValidationVersion: 2 },
  { formatQualityStatus: 'passed', qualityFormatCheckedAssetId: 'current-result', qualityValidationVersion: 1 },
  { formatQualityStatus: 'passed', qualityFormatCheckedAssetId: 'current-result' },
])('rechecks legacy passed results with missing or stale format proof: %o', proof => {
  expect(needsLayerPixelValidation({ resultAssetId: 'current-result', qualityStatus: 'passed', status: 'completed',
    confirmationDigest: 'e'.repeat(64), ...proof })).toBe(true);
});

it.each(['queued', 'submitting', 'running'])('does not recheck a retained legacy result during an active %s task', status => {
  expect(needsLayerPixelValidation({ resultAssetId: 'old-result', qualityStatus: 'passed', qualityValidationVersion: 2, status })).toBe(false);
});

it.each(['passed', 'pending', 'failed'])('keeps an explicit current format failure stable for quality status %s', qualityStatus => {
  expect(needsLayerPixelValidation({ resultAssetId: 'current-result', qualityStatus, formatQualityStatus: 'failed',
    qualityFormatCheckedAssetId: 'current-result', qualityValidationVersion: 2, qualityReason: 'alpha_opaque' })).toBe(false);
});

it.each([
  { qualityStatus: 'failed', qualityReason: 'alpha_opaque', qualityValidationVersion: 1 },
  { qualityStatus: 'failed', qualityReason: 'dimensions', qualityValidationVersion: 2 },
])('does not automatically retry a stable pixel failure: %o', failed => {
  expect(needsLayerPixelValidation({ resultAssetId: 'current-result', ...failed })).toBe(false);
});

it('keeps the existing recovery for old dimension-only failures', () => {
  expect(needsLayerPixelValidation({ resultAssetId: 'current-result', qualityStatus: 'failed',
    qualityReason: 'dimensions', qualityValidationVersion: 1 })).toBe(true);
});

it('rechecks the saved 728 legacy pattern serially once and records only current format proof', async () => {
  let active = 0, maximum = 0;
  const decoded: string[] = [];
  class TestImage {
    naturalWidth = 2; naturalHeight = 2; crossOrigin = ''; src = '';
    async decode() {
      decoded.push(this.src); active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5)); active--;
    }
  }
  vi.stubGlobal('Image', TestImage);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn(),
    getImageData: () => ({ data: new Uint8ClampedArray([30, 60, 90, 255, 30, 60, 90, 64, 0, 0, 0, 0, 0, 0, 0, 0]) }),
  } as never);
  const nodes = ['lid', 'hands'].map(layerId => {
    const node = createCanvasModuleNode(`saved-728-${layerId}`, 'image_layer', { x: 50000, y: 50000 });
    node.data.config = { resultAssetId: `saved-${layerId}`, layerId, layerKind: 'transparent', canvasWidth: 2, canvasHeight: 2,
      pixelMode: 'source', status: 'completed', qualityStatus: 'passed', qualityValidationVersion: 2,
      confirmationDigest: 'e'.repeat(64), pixelColorSpace: null };
    return node;
  });
  const assets = nodes.map(node => ({ assetId: String(node.data.config.resultAssetId),
    displayUrl: `novus-asset://${node.data.config.resultAssetId}`, mediaType: 'image/png' as const, width: 2, height: 2 }));
  const saved = vi.fn();
  let latest = nodes;
  function Fixture() {
    const [current, setCurrent] = useState(nodes); latest = current;
    return <ImageLayerValidationQueue projectId="project" nodes={current} assets={assets} onRefreshAssets={async () => {}}
      onQualityResult={async (nodeId, assetId, verdict) => {
        saved(nodeId, assetId, verdict);
        setCurrent(items => items.map(node => node.id !== nodeId ? node : { ...node, data: { ...node.data, config: {
          ...node.data.config, qualityStatus: verdict.ok ? 'passed' : 'failed', qualityValidationVersion: 2,
          formatQualityStatus: verdict.ok ? 'passed' : 'failed', qualityFormatCheckedAssetId: assetId,
        } } }));
      }} />;
  }
  const view = render(<Fixture />);
  await waitFor(() => expect(saved.mock.calls.map(call => call[0])).toEqual(nodes.map(node => node.id)));
  view.rerender(<Fixture />);
  expect(decoded).toEqual(assets.map(asset => asset.displayUrl));
  expect(maximum).toBe(1);
  expect(saved.mock.calls.every(call => call[2].ok)).toBe(true);
  for (const node of latest) {
    expect(node.data.config).toMatchObject({ qualityStatus: 'passed', formatQualityStatus: 'passed',
      qualityFormatCheckedAssetId: node.data.config.resultAssetId, qualityValidationVersion: 2 });
    expect(node.data.config.semanticReviewAccepted).toBeUndefined();
    expect(node.data.config.semanticReviewDigest).toBeUndefined();
    expect(needsLayerPixelValidation(node.data.config)).toBe(false);
  }
});
