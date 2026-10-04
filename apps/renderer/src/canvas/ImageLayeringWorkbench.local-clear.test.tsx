import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createCanvasModuleNode } from '@agent-canvas/domain';
import { afterEach, expect, it, vi } from 'vitest';
import { ImageLayeringWorkbench } from './ImageLayeringWorkbench';

vi.mock('./source-layer-preview', () => ({
  orderedLayerPlan: (config: { planLayers?: unknown[] }) => config.planLayers ?? [],
  useSourceLayerPreview: () => ({ preview: null, error: null }),
  prepareDraftSourceLayerDocument: vi.fn(),
  prepareSourceLayerDocument: vi.fn(),
}));
afterEach(cleanup);

it.each([false, true])('protects the independent layer baseline markers with saved history=%s', hasHistory => {
  const keep = { mode: 'keep', box: { x: 0, y: 0, width: .5, height: .5 } };
  const clear = { mode: 'clear', box: { x: .5, y: .5, width: .5, height: .5 } };
  const layer = createCanvasModuleNode('independent', 'image_layer', { x: 0, y: 0 });
  layer.data.config = { sourceAssetId: 'source', resultAssetId: 'result', layerId: 'hands',
    layerKind: 'transparent', name: 'hands', layeringOutputContract: 'source-independent-rgba-v2',
    resultRepresentation: 'independent-rgba-candidate', sourceBounds: { x: 0, y: 0, width: 1, height: 1 },
    mattingRegions: hasHistory ? [keep, clear] : [keep],
    ...(hasHistory ? { foregroundProvenance: { localClear: { baselineRegions: [keep], clearRegions: [clear] } } } : {}),
  };
  render(<ImageLayeringWorkbench config={{ canvasWidth: 2, canvasHeight: 2, sourceAssetId: 'source',
    groupId: 'g', planLayers: [], layerSelection: { mode: 'whole' } }}
    assets={[{ assetId: 'source', displayUrl: 'data:image/png;base64,AA==', mediaType: 'image/png', width: 2, height: 2 }]}
    layerNodes={[layer]} onLayersChange={() => {}} onRefineLayer={async () => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '本地抠图与边缘精修' }));
  expect(screen.getByRole('button', { name: '保留实体' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '移除精修区域 1' })).toBeDisabled();
  if (hasHistory) expect(screen.getByRole('button', { name: '移除精修区域 2' })).toBeEnabled();
});
