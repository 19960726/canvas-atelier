import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageLayerNodeWorkbench } from './ImageLayerNodeWorkbench';
import * as preview from './source-layer-preview';
import * as pixels from '../app/managed-layer-pixels';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const source = { assetId: 'source', displayUrl: 'novus-asset://source', mediaType: 'image/png' as const, width: 2, height: 2 };
const returned = { assetId: 'mask', displayUrl: 'novus-asset://mask', mediaType: 'image/png' as const, width: 2, height: 2 };
const config = { name: '手部', layerId: 'hands', layerKind: 'transparent', resultAssetId: 'mask', pixelMode: 'source',
  sourceBounds: { x: 0, y: 0, width: 1, height: 1 }, maskSpace: 'source', layerSelection: { mode: 'whole' },
  canvasWidth: 2, canvasHeight: 2, qualityStatus: 'passed' };
const documentInput: preview.SourceLayerInput = { sourceUrl: source.displayUrl, width: 2, height: 2, selection: { mode: 'whole' }, layers: [] };
const baseProps = { nodeId: 'layer', config, asset: returned, sourceAsset: source, sourceDocumentInput: documentInput,
  validatePixels: false, onQualityResult: vi.fn(), onVisibilityChange: vi.fn() };

describe('real layer repair preview and replacement controls', () => {
  it('keeps original colors behind a legacy alpha mask when the whole group cannot assemble', async () => {
    vi.spyOn(preview, 'useSourceLayerPreview').mockReturnValue({ key: 'blocked', preview: null, error: '图层内容重叠，需精修' });
    const sourceRgba = new Uint8Array([180, 90, 60, 255, 180, 90, 60, 255, 180, 90, 60, 255, 180, 90, 60, 255]);
    const whiteMask = new Uint8Array([255, 255, 255, 255, 255, 255, 255, 128, 255, 255, 255, 0, 255, 255, 255, 0]);
    vi.spyOn(pixels, 'decodeLayerPixels').mockImplementation(async url => url === source.displayUrl ? sourceRgba : whiteMask);
    const encode = vi.spyOn(pixels, 'layerPixelsUrl').mockResolvedValue('blob:source-colors-and-mask-alpha');
    render(<ImageLayerNodeWorkbench {...baseProps} />);
    await waitFor(() => expect(screen.getByRole('img', { name: '手部图层预览' })).toHaveAttribute('src', 'blob:source-colors-and-mask-alpha'));
    expect(encode).toHaveBeenCalledWith(new Uint8Array([180, 90, 60, 255, 180, 90, 60, 128, 0, 0, 0, 0, 0, 0, 0, 0]), 2, 2);
    expect(screen.getByRole('region', { name: '画布图层：手部' })).toHaveAttribute('data-layer-status', 'blocked');
    expect(screen.getByText('内容重叠 · 图片已返回')).toBeVisible();
    expect(baseProps.onQualityResult).not.toHaveBeenCalled();
  });

  it.each([
    { pixelColorSpace: 'foreground' },
    { layeringOutputContract: 'source-independent-rgba-v2', resultRepresentation: 'independent-rgba-candidate' },
  ])('preserves actual independent RGBA even when another layer blocks composition: %j', extra => {
    vi.spyOn(preview, 'useSourceLayerPreview').mockReturnValue({ key: 'blocked', preview: null, error: '图层内容重叠，需精修' });
    const decode = vi.spyOn(pixels, 'decodeLayerPixels');
    render(<ImageLayerNodeWorkbench {...baseProps} config={{ ...config, ...extra }} />);
    expect(screen.getByRole('img', { name: '手部已返回原始图片，尚未合成' })).toHaveAttribute('src', returned.displayUrl);
    expect(decode).not.toHaveBeenCalled();
  });

  it('lets the user pick a local PNG replacement and reports a real rejected import', async () => {
    const replace = vi.fn(async () => { throw new Error('图层 PNG 尺寸须与原图一致'); });
    render(<ImageLayerNodeWorkbench {...baseProps} config={{ ...config, pixelColorSpace: 'foreground' }} sourceDocumentInput={null} onReplaceAsset={replace} />);
    const picker = screen.getByLabelText('选择替换图层 PNG');
    expect(picker).toHaveAttribute('accept', 'image/png');
    const file = new File(['wrong-size'], 'repaired.png', { type: 'image/png' });
    fireEvent.change(picker, { target: { files: [file] } });
    await waitFor(() => expect(replace).toHaveBeenCalledWith(file));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('图层 PNG 尺寸须与原图一致'));
    expect(screen.getByRole('button', { name: '替换图层素材' })).toBeEnabled();
    expect(baseProps.onQualityResult).not.toHaveBeenCalled();
  });

  it('shows the physically bound local RGBA without recoloring it through the original v1 mask contract', () => {
    vi.spyOn(preview, 'useSourceLayerPreview').mockReturnValue({ key: 'pending', preview: null, error: '图层尚未完成本地检查' });
    const decode = vi.spyOn(pixels, 'decodeLayerPixels');
    const sourceHash = 'a'.repeat(64), resultHash = 'b'.repeat(64);
    const localConfig = { ...config, sourceAssetId: source.assetId, pixelColorSpace: 'foreground',
      layeringOutputContract: 'source-alpha-matte-v1', qualityStatus: 'pending', foregroundProvenance: {
        kind: 'local-rgba-import', version: 1, assetId: returned.assetId, sha256: resultHash,
        sourceAssetId: source.assetId, sourceSha256: sourceHash, width: 2, height: 2,
      } };
    const view = render(<ImageLayerNodeWorkbench {...baseProps} config={localConfig}
      sourceAsset={{ ...source, sha256: sourceHash }} asset={{ ...returned, sha256: resultHash }} />);
    expect(screen.getByRole('img', { name: '手部已返回原始图片，尚未合成' })).toHaveAttribute('src', returned.displayUrl);
    expect(decode).not.toHaveBeenCalled();
    expect(screen.queryByText('格式检查通过 · 待检查边缘')).not.toBeInTheDocument();
    view.rerender(<ImageLayerNodeWorkbench {...baseProps} config={localConfig}
      sourceAsset={{ ...source, sha256: sourceHash }} asset={{ ...returned, sha256: 'c'.repeat(64) }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('本地 RGBA 素材归属已过期');
    expect(screen.getByRole('region', { name: '画布图层：手部' })).toHaveAttribute('data-layer-status', 'blocked');
    expect(baseProps.onQualityResult).not.toHaveBeenCalled();
  });
});
