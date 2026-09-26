import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { ImageLayerNodeWorkbench } from './ImageLayerNodeWorkbench';

describe('ImageLayerNodeWorkbench', () => {
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
