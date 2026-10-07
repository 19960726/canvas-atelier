import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createCanvasModuleNode } from '@agent-canvas/domain';
import { afterEach, expect, it, vi } from 'vitest';
import { ImageLayeringWorkbench } from './ImageLayeringWorkbench';
import { Blob as NodeBlob } from 'node:buffer';
import { fixturePng } from '../test/rgba-png-fixture';

afterEach(cleanup);

it.each([
  { label: 'two raw low-alpha layers', alpha: 64, shift: 0, preparedCarrier: false },
  { label: 'existing two-layer strong overlap', alpha: 255, shift: 1, preparedCarrier: false },
  { label: 'raw water over an already prepared carrier', alpha: 64, shift: 0, preparedCarrier: true },
])('opens and applies local refinement to the exact offending layer for $label', async ({ alpha, shift, preparedCarrier }) => {
  const width = 24, height = 24;
  const source = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) source.set([120, 140, 160, 255], pixel * 4);
  const rectangle = (left: number, top: number, size: number, opacity: number) => {
    const mask = new Uint8ClampedArray(source.length);
    for (let y = top; y < top + size; y++) for (let x = left; x < left + size; x++) mask.set([255, 255, 255, opacity], (y * width + x) * 4);
    return mask;
  };
  const records = [
    { layerId: 'bg', name: '背景', kind: 'background' as const, assetId: 'a'.repeat(16), pixels: source },
    // A similar name comes first, so a prefix match or fallback would select the wrong layer.
    { layerId: 'water', name: '杯身透明水流', kind: 'transparent' as const, assetId: 'b'.repeat(16), pixels: rectangle(1, 1, 2, 64) },
    { layerId: 'cup', name: '杯身', kind: 'transparent' as const, assetId: 'c'.repeat(16), pixels: rectangle(6, 6, 12, preparedCarrier ? 255 : alpha) },
    { layerId: 'copy', name: preparedCarrier ? '水流' : '握杯手部返图', kind: 'transparent' as const, assetId: 'd'.repeat(16), pixels: rectangle(6 + shift, 6 + shift, 12, alpha) },
  ];
  class TestImage { naturalWidth = width; naturalHeight = height; crossOrigin = ''; src = ''; decode() { return Promise.resolve(); } }
  vi.stubGlobal('Image', TestImage);
  vi.stubGlobal('Blob', NodeBlob);
  const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
    let imageUrl = '';
    return { imageSmoothingEnabled: true, imageSmoothingQuality: 'high',
      createImageData: (canvasWidth: number, canvasHeight: number) => ({ width: canvasWidth, height: canvasHeight,
        data: new Uint8ClampedArray(canvasWidth * canvasHeight * 4) }), putImageData: () => {},
      drawImage: (image: TestImage) => { imageUrl = image.src; },
      getImageData: () => ({ data: new Uint8ClampedArray(records.find(record => imageUrl.includes(record.assetId))?.pixels ?? source) }),
    } as never;
  });
  const onRefineLayer = vi.fn(async (_nodeId: string, _regions: unknown[]) => {});
  try {
    const nodes = records.map((record, order) => {
      const node = createCanvasModuleNode(`layer-${record.layerId}`, 'image_layer', { x: 0, y: order * 100 });
      node.data.config = { ...node.data.config, name: record.name, layerId: record.layerId, layerKind: record.kind,
        order, qualityStatus: 'passed', resultAssetId: record.assetId,
        ...(record.kind === 'transparent' ? { maskSpace: 'source', sourceBounds: { x: 0, y: 0, width: 1, height: 1 } } : {}) };
      if (preparedCarrier && record.layerId === 'cup') node.data.config.pixelColorSpace = 'foreground';
      return node;
    });
    render(<ImageLayeringWorkbench config={{ canvasWidth: width, canvasHeight: height, sourceAssetId: 'source',
      pixelMode: 'source', layerSelection: { mode: 'whole' }, planLayers: records.map(({ pixels: _pixels, ...record }, order) => ({ ...record, order })) }}
      assets={[...records.map(record => ({ assetId: record.assetId, mediaType: 'image/png' as const,
        displayUrl: fixturePng(record.pixels, width, height), width, height })),
        { assetId: 'source', mediaType: 'image/png', displayUrl: fixturePng(source, width, height), width, height }]}
      layerNodes={nodes} onLayersChange={() => {}} onRefineLayer={onRefineLayer} />);
    await waitFor(() => expect(screen.getByText(alpha < 255
      ? '透明图层需要本地精修，暂不能正式合成或导出正式 PSD'
      : '图层内容重叠，暂不能正式合成或导出正式 PSD')).toBeVisible());
    if (alpha < 255) expect(screen.getByText(preparedCarrier
      ? /图层“杯身”与“水流”的透明贡献叠加/u
      : /图层“杯身”与“握杯手部返图”的透明贡献叠加/u)).toBeVisible();
    expect(screen.getByRole('button', { name: '导出 PSD' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '本地抠图与边缘精修' }));
    const targetNodeId = preparedCarrier ? 'layer-copy' : 'layer-cup';
    expect(screen.getByRole('combobox', { name: '精修图层' })).toHaveValue(targetNodeId);
    expect(onRefineLayer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '应用本地精修' }));
    await waitFor(() => expect(onRefineLayer).toHaveBeenCalledWith(targetNodeId, []));
  } finally { context.mockRestore(); vi.unstubAllGlobals(); }
});
