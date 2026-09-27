import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageLayerNodeWorkbench, validateManagedImageLayer } from './ImageLayerNodeWorkbench';
import { buildSourceLayerDocument } from '../app/source-layer-document';
import { composeLayeredRgba } from '../app/layered-psd';
afterEach(cleanup);

describe('ImageLayerNodeWorkbench', () => {
  it('does not present format validation as a clean cutout acceptance', () => {
    render(<ImageLayerNodeWorkbench nodeId="layer-a" config={{ name: '产品', qualityStatus: 'passed' }} onQualityResult={vi.fn()} onVisibilityChange={vi.fn()} />);
    const region = screen.getByRole('region', { name: '画布图层：产品' });
    expect(within(region).getByText('格式检查通过 · 待检查边缘')).toBeVisible();
    expect(within(region).queryByText('像素验证通过')).not.toBeInTheDocument();
  });
  it('places a centered provider mask into the original corner before testing selection visibility', async () => {
    const width = 8, height = 8;
    const mask = Uint8ClampedArray.from(Array.from({ length: 64 }, (_, i) => [255, 255, 255,
      i % 8 >= 3 && i % 8 <= 4 && i >= 24 && i < 40 ? 255 : 0]).flat());
    vi.stubGlobal('Image', class { naturalWidth = width; naturalHeight = height; decode = async () => {}; });
    const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(), getImageData: () => ({ data: mask }),
    } as never);
    try {
      const selection = { mode: 'region' as const, box: { x: 0, y: 0, width: .25, height: .25 } };
      const config = { layerKind: 'transparent', canvasWidth: width, canvasHeight: height, layerSelection: selection };
      const asset = { assetId: 'mask', displayUrl: 'novus-asset://mask', mediaType: 'image/png' as const, width, height };
      expect(await validateManagedImageLayer(asset, config, true)).toEqual({ ok: false, reason: 'alpha_empty' });
      expect(await validateManagedImageLayer(asset, { ...config, pixelMode: 'source' }, true)).toEqual({ ok: true });
      const source = new Uint8Array(width * height * 4).fill(255);
      const document = await buildSourceLayerDocument({ width, height, source, selection, layers: [
        { id: 'bg', name: '背景', kind: 'background', visible: true, opacity: 1, load: async () => source },
        { id: 'object', name: '角落物品', kind: 'transparent', visible: true, opacity: 1,
          bounds: selection.box, load: async () => new Uint8Array(mask) },
      ] });
      // Trimming retains one transparent pixel around the 2 x 2 selection.
      expect(document.layers[1]).toMatchObject({ x: 0, y: 0, width: 3, height: 3 });
      expect(composeLayeredRgba(document)).toEqual(source);
    } finally { context.mockRestore(); vi.unstubAllGlobals(); }
  });
  it('shows independent layer identity, transparent kind and status without a fake preview', () => {
    render(<ImageLayerNodeWorkbench nodeId="layer-a" config={{ name: '产品主体', layerKind: 'transparent', status: 'queued' }} onQualityResult={vi.fn()} onVisibilityChange={vi.fn()} />);
    expect(screen.getByRole('region', { name: '画布图层：产品主体' })).toHaveAttribute('data-layer-status', 'queued');
    expect(screen.getByText('透明层')).toBeVisible();
    expect(screen.getByText('排队中')).toBeVisible();
    expect(screen.queryByRole('img', { name: '产品主体图层预览' })).not.toBeInTheDocument();
  });

  it('offers a compact accessible visibility action', () => {
    const onVisibilityChange = vi.fn();
    render(<ImageLayerNodeWorkbench nodeId="layer-a" config={{ name: '背景', layerKind: 'background', visible: true }} onQualityResult={vi.fn()} onVisibilityChange={onVisibilityChange} />);
    fireEvent.click(screen.getByRole('button', { name: '隐藏图层 背景' }));
    expect(onVisibilityChange).toHaveBeenCalledWith(false);
  });

  it('reloads a returned asset missing from the UI catalog and displays it when available', async () => {
    const onRefreshAsset = vi.fn(async () => {});
    const config = { name: '料理机', layerKind: 'transparent', resultAssetId: 'image-result', status: 'validating', qualityStatus: 'pending' };
    const props = { nodeId: 'layer-a', config, onQualityResult: vi.fn(), onVisibilityChange: vi.fn(), onRefreshAsset };
    const view = render(<ImageLayerNodeWorkbench {...props} />);
    expect(screen.getByText('图片已返回，正在读取')).toBeVisible();
    await waitFor(() => expect(onRefreshAsset).toHaveBeenCalledOnce());
    view.rerender(<ImageLayerNodeWorkbench {...props} asset={{ assetId: 'image-result', displayUrl: 'novus-asset://result', mediaType: 'image/png', width: 2480, height: 3312 }} />);
    expect(screen.getByRole('img', { name: '料理机图层预览' })).toHaveAttribute('src', 'novus-asset://result');
  });

  it.each(['pending', 'failed'])('continues %s pixel validation after refresh, including old resolution-only failures', async qualityStatus => {
    const resolveDecode: Array<() => void> = [];
    class TestImage {
      naturalWidth = 2;
      naturalHeight = 2;
      crossOrigin = '';
      private source = '';
      set src(value: string) {
        if (this.crossOrigin !== 'anonymous') throw new Error('Managed image would taint the pixel canvas');
        this.source = value;
      }
      get src() { return this.source; }
      decode() { return new Promise<void>((resolve) => resolveDecode.push(resolve)); }
    }
    vi.stubGlobal('Image', TestImage);
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
      getImageData: () => ({ data: Uint8ClampedArray.from([0, 0, 0, 0, 40, 90, 130, 255, 0, 0, 0, 0, 0, 0, 0, 0]) }),
    } as never);
    try {
      const config = { name: '产品', layerKind: 'transparent', resultAssetId: 'image-result', qualityStatus, qualityReason: 'dimensions', status: 'validating', canvasWidth: 1, canvasHeight: 1 };
      const asset = { assetId: 'image-result', displayUrl: 'novus-asset://result', mediaType: 'image/png' as const, width: 2, height: 2 };
      const onQualityResult = vi.fn(async () => {});
      const props = { nodeId: 'layer-a', config, onQualityResult, onVisibilityChange: vi.fn() };
      const view = render(<ImageLayerNodeWorkbench {...props} asset={asset} />);
      expect(resolveDecode).toHaveLength(1);
      view.rerender(<ImageLayerNodeWorkbench {...props} asset={{ ...asset }} />);
      expect(resolveDecode).toHaveLength(2);
      await act(async () => { resolveDecode[0]!(); resolveDecode[1]!(); });
      await waitFor(() => expect(onQualityResult).toHaveBeenCalledOnce());
      expect(onQualityResult).toHaveBeenCalledWith('image-result', { ok: true });
    } finally {
      getContext.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
