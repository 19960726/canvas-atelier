import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvasModuleNode, type ModelJob } from '@agent-canvas/domain';
import { ImageLayeringWorkbench } from './ImageLayeringWorkbench';
import { readPsd } from 'ag-psd';
import type { LayeredImageRecord } from '../app/layered-image-config';

const base = 'a'.repeat(16);
const subject = 'b'.repeat(16);
const glass = 'c'.repeat(16);
const assets = [base, subject, glass].map(assetId => ({ assetId, mediaType: 'image/png' as const, displayUrl: `data:image/png;base64,${assetId}` }));
const layers: LayeredImageRecord[] = [
  { layerId: 'base', kind: 'background', name: 'Background', assetId: base, x: 0, y: 0, width: 2, height: 2, visible: true, opacity: 1 },
  { layerId: 'subject', kind: 'transparent', name: 'Subject', assetId: subject, x: 0, y: 0, width: 2, height: 2, visible: true, opacity: 1 },
  { layerId: 'glass', kind: 'transparent', name: 'Glass', assetId: glass, x: 0, y: 0, width: 2, height: 2, visible: true, opacity: 1 },
];
afterEach(cleanup);

describe('image layering workbench', () => {
  it('saves the whole-image clean-background choice separately from the preview toggle', async () => {
    const onBackgroundModeChange = vi.fn(async () => {});
    render(<ImageLayeringWorkbench config={{ pixelMode: 'source', layerSelection: { mode: 'whole' }, sourceAssetId: base, layers: [] }}
      assets={assets} onLayersChange={() => {}} onBackgroundModeChange={onBackgroundModeChange} />);
    const choices = screen.getByRole('group', { name: '背景合成方式' });
    expect(within(choices).getByRole('button', { name: '保留原图背景' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(choices).getByRole('button', { name: '使用完整补全背景' }));
    await waitFor(() => expect(onBackgroundModeChange).toHaveBeenCalledWith('replace'));
    expect(screen.getByRole('group', { name: '分层预览模式' })).toBeInTheDocument();
  });
  it.each(['bounds', 'source'] as const)('exports %s masks using their own coordinate space and reconstructs source pixels', async (maskSpace) => {
    const sourcePixels = Uint8ClampedArray.from(Array.from({ length: 64 }, (_, i) => [i * 3, 60, 80, 255]).flat());
    const maskAlpha = maskSpace === 'source' ? 224 : 255;
    const maskPixels = Uint8ClampedArray.from(Array.from({ length: 64 }, (_, i) => [255, 0, 0, i % 8 >= 2 && i % 8 <= 5 && i >= 16 && i < 48 ? maskAlpha : 0]).flat());
    class TestImage { naturalWidth = 8; naturalHeight = 8; crossOrigin = ''; src = ''; decode() { return Promise.resolve(); } }
    vi.stubGlobal('Image', TestImage);
    const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function(this: HTMLCanvasElement) {
      let url = '';
      return { imageSmoothingEnabled: true, imageSmoothingQuality: 'high',
        createImageData: (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
        putImageData: () => {}, drawImage: (image: TestImage) => { url = image.src; },
        getImageData: () => ({ data: url === 'source-url' ? sourcePixels : url.includes(subject) ? maskPixels : new Uint8ClampedArray(256).fill(255) }),
      } as never;
    });
    const preview = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,preview');
    const open = vi.fn(async (_bytes: Uint8Array) => ({ ok: true as const }));
    const previous = window.novusDesktop;
    Object.defineProperty(window, 'novusDesktop', { configurable: true, value: { projectImages: { openLayeredPsdInPhotoshop: open } } });
    try {
      const planLayers = layers.slice(0, 2).map(record => ({ ...record }));
      const nodes = planLayers.map(record => {
        const node = createCanvasModuleNode(record.layerId, 'image_layer', { x: 0, y: 0 });
        node.data.config = { layerId: record.layerId, resultAssetId: record.assetId, qualityStatus: 'passed',
          ...(record.kind === 'transparent' ? { maskSpace, sourceBounds: maskSpace === 'source'
            ? { x: .375, y: .25, width: .5, height: .5 }
            : { x: .625, y: .5, width: .25, height: .25 } } : {}) };
        return node;
      });
      render(<ImageLayeringWorkbench config={{ canvasWidth: 8, canvasHeight: 8, sourceAssetId: 'source', planLayers, pixelMode: 'source' }}
        assets={[...assets, { assetId: 'source', mediaType: 'image/png', displayUrl: 'source-url', width: 8, height: 8 }]} layerNodes={nodes} onLayersChange={() => {}} />);
      await waitFor(() => expect(screen.getByRole('button', { name: '在 Photoshop 中打开' })).toBeEnabled());
      expect(screen.getByText('图层已返回 · 待检查边缘与背景')).toBeVisible();
      expect(screen.queryByText('已完成')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: '在 Photoshop 中打开' }));
      await waitFor(() => expect(open).toHaveBeenCalledOnce());
      const psd = readPsd(open.mock.calls[0]![0], { useImageData: true });
      expect([psd.width, psd.height]).toEqual([8, 8]);
      expect([...psd.imageData!.data]).toEqual([...sourcePixels]);
      const foreground = psd.children!.find(layer => layer.name === 'Subject')!;
      expect([foreground.left, foreground.top]).toEqual(maskSpace === 'source' ? [1, 1] : [4, 3]);
      const offset = (foreground.imageData!.width + 1) * 4;
      const sourceRed = sourcePixels[(maskSpace === 'source' ? 2 * 8 + 2 : 4 * 8 + 5) * 4]!;
      expect(foreground.imageData!.data[offset]).toBe(maskSpace === 'source' ? Math.round((sourceRed - (255 - maskAlpha)) * 255 / maskAlpha) : sourceRed);
      expect(foreground.imageData!.data[offset + 3]).toBe(maskAlpha);
    } finally { context.mockRestore(); preview.mockRestore(); vi.unstubAllGlobals(); Object.defineProperty(window, 'novusDesktop', { configurable: true, value: previous }); }
  });
  it('exports scoped high resolution layers without shrinking them to the source size', async () => {
    class TestImage {
      naturalWidth = 4; naturalHeight = 4; crossOrigin = ''; src = '';
      decode() { return Promise.resolve(); }
    }
    vi.stubGlobal('Image', TestImage);
    const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function(this: HTMLCanvasElement) {
      let src = '';
      return { imageSmoothingEnabled: true, imageSmoothingQuality: 'high',
        createImageData: (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
        drawImage: (image: TestImage) => { src = image.src; },
        getImageData: () => ({ data: Uint8ClampedArray.from(Array.from({ length: this.width * this.height }, (_, i) =>
          src === 'source-url' ? [90, 80, 70, 255] : src.includes(subject) && i === 5 ? [0, 0, 0, 0] : [200, 50, 40, 255]).flat()) }),
      } as never;
    });
    const open = vi.fn(async (_bytes: Uint8Array) => ({ ok: true as const }));
    const previous = window.novusDesktop;
    Object.defineProperty(window, 'novusDesktop', { configurable: true, value: { projectImages: { openLayeredPsdInPhotoshop: open } } });
    try {
      const planLayers = layers.slice(0, 2).map(record => ({ ...record }));
      const nodes = planLayers.map(record => {
        const node = createCanvasModuleNode(record.layerId, 'image_layer', { x: 0, y: 0 });
        node.data.config = { ...node.data.config, layerId: record.layerId, resultAssetId: record.assetId, resultWidth: 4, resultHeight: 4, qualityStatus: 'passed' };
        return node;
      });
      render(<ImageLayeringWorkbench config={{ canvasWidth: 2, canvasHeight: 2, sourceAssetId: 'source', planLayers,
        layerSelection: { mode: 'region', box: { x: .25, y: .25, width: .5, height: .5 } } }}
        assets={[...assets, { assetId: 'source', mediaType: 'image/png', displayUrl: 'source-url' }]} layerNodes={nodes} onLayersChange={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: '在 Photoshop 中打开' }));
      await waitFor(() => expect(open).toHaveBeenCalledOnce());
      const psd = readPsd(open.mock.calls[0]![0], { useImageData: true });
      expect([psd.width, psd.height]).toEqual([4, 4]);
      const foreground = psd.children!.find(layer => layer.name === 'Subject')!;
      const background = psd.children!.find(layer => layer.name === 'Background')!;
      expect(foreground.imageData!.data[3]).toBe(0);
      expect(foreground.imageData!.data[6 * 4 + 3]).toBe(255);
      expect([...background.imageData!.data.slice(0, 4)]).toEqual([90, 80, 70, 255]);
    } finally { context.mockRestore(); vi.unstubAllGlobals(); Object.defineProperty(window, 'novusDesktop', { configurable: true, value: previous }); }
  });
  it('keeps the empty node honest about the unverified GPT transparency route', () => {
    render(<ImageLayeringWorkbench config={{ layers: [] }} assets={assets} onLayersChange={() => {}} />);
    expect(screen.queryByRole('button', { name: '自动分层' })).not.toBeInTheDocument();
    expect(screen.getByText(/GPT Image 透明背景路由/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导出 PSD' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '在 Photoshop 中打开' })).toBeDisabled();
  });

  it('previews genuine layer assets and persists visibility and order choices', () => {
    function Fixture() {
      const [current, setCurrent] = useState(layers);
      return <ImageLayeringWorkbench config={{ canvasWidth: 2, canvasHeight: 2, layers: current }} assets={assets}
        onLayersChange={setCurrent} />;
    }
    render(<Fixture />);
    const stack = screen.getByRole('list', { name: '分层图层' });
    expect(within(stack).getAllByRole('listitem').map(item => item.textContent)).toEqual([
      expect.stringContaining('Background'), expect.stringContaining('Subject'), expect.stringContaining('Glass'),
    ]);
    expect(screen.getByRole('img', { name: '合成预览图层 Glass' })).toHaveAttribute('src', assets[2]!.displayUrl);
    fireEvent.click(screen.getByRole('button', { name: '隐藏图层 Glass' }));
    expect(screen.getByRole('button', { name: '显示图层 Glass' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: '合成预览图层 Glass' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '上移图层 Subject' }));
    expect(within(stack).getAllByRole('listitem').map(item => item.textContent)).toEqual([
      expect.stringContaining('Background'), expect.stringContaining('Glass'), expect.stringContaining('Subject'),
    ]);
    expect(screen.getByRole('button', { name: '导出 PSD' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '在 Photoshop 中打开' })).toBeEnabled();
  });

  it('reads managed layer pixels with CORS enabled before opening the PSD', async () => {
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
      decode() { return Promise.resolve(); }
    }
    vi.stubGlobal('Image', TestImage);
    let currentSource = '';
    const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: (image: TestImage) => { currentSource = image.src; },
      getImageData: () => ({ data: Uint8ClampedArray.from(Array.from({ length: 4 }, (_, index) =>
        currentSource.includes(subject) && index === 0 ? [0, 0, 0, 0] : [40, 90, 130, 255]).flat()) }),
    } as never);
    const previousDesktop = window.novusDesktop;
    const open = vi.fn(async () => ({ ok: true as const }));
    Object.defineProperty(window, 'novusDesktop', { configurable: true, value: { projectImages: { openLayeredPsdInPhotoshop: open } } });
    try {
      render(<ImageLayeringWorkbench config={{ canvasWidth: 2, canvasHeight: 2, layers: layers.slice(0, 2) }} assets={assets} onLayersChange={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: '在 Photoshop 中打开' }));
      await waitFor(() => expect(open).toHaveBeenCalledOnce());
      expect(screen.queryByText(/无法解码图层像素/u)).not.toBeInTheDocument();
    } finally {
      Object.defineProperty(window, 'novusDesktop', { configurable: true, value: previousDesktop });
      context.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('builds the composite from completed independent layer nodes while the default layers array is empty', () => {
    const planLayers = [
      { layerId: 'base', kind: 'background', name: 'Background', order: 0 },
      { layerId: 'subject', kind: 'transparent', name: 'Subject', order: 1 },
      { layerId: 'glass', kind: 'transparent', name: 'Glass', order: 2 },
    ];
    const layerNodes = [base, subject, glass].map((assetId, index) => {
      const layer = createCanvasModuleNode(`generated-layer-${index}`, 'image_layer', { x: 0, y: index * 100 });
      layer.data.config = {
        ...layer.data.config, groupId: 'generated-group', layerId: planLayers[index]!.layerId, name: planLayers[index]!.name,
        layerKind: planLayers[index]!.kind, order: index, resultAssetId: assetId, resultWidth: 2, resultHeight: 2,
        qualityStatus: 'passed', status: 'completed', visible: true,
      };
      return layer;
    });
    render(<ImageLayeringWorkbench config={{ groupId: 'generated-group', canvasWidth: 2, canvasHeight: 2, layers: [], planLayers }} assets={assets} layerNodes={layerNodes} onLayersChange={() => {}} />);

    expect(within(screen.getByRole('list', { name: '分层图层' })).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByRole('button', { name: '导出 PSD' })).toBeEnabled();
    expect(screen.getByRole('img', { name: '合成预览图层 Glass' })).toHaveAttribute('src', assets[2]!.displayUrl);
  });

  it('reports a failed layer save instead of silently discarding it', async () => {
    render(<ImageLayeringWorkbench config={{ canvasWidth: 2, canvasHeight: 2, layers }} assets={assets}
      onLayersChange={async () => { throw new Error('Storage unavailable'); }} />);
    fireEvent.click(screen.getByRole('button', { name: '隐藏图层 Glass' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Storage unavailable'));
  });

  it('shows the original and durable task progress before every layer passes, then allows status sync', async () => {
    const backgroundNode = createCanvasModuleNode('layer-background', 'image_layer', { x: 0, y: 0 });
    backgroundNode.data.config = { ...backgroundNode.data.config, layerId: 'base', name: 'Background', status: 'completed',
      qualityStatus: 'passed', resultAssetId: base, order: 0 };
    const subjectNode = createCanvasModuleNode('layer-subject', 'image_layer', { x: 0, y: 100 });
    subjectNode.data.config = { ...subjectNode.data.config, layerId: 'subject', name: 'Subject', status: 'queued', order: 1 };
    const onRefreshJobs = vi.fn(async () => {});
    render(<ImageLayeringWorkbench config={{ sourceAssetId: base, canvasWidth: 2, canvasHeight: 2, layers: [],
      planLayers: [{ layerId: 'base', name: 'Background' }, { layerId: 'subject', name: 'Subject' }] }}
      assets={assets} layerNodes={[backgroundNode, subjectNode]} onLayersChange={() => {}} onRefreshJobs={onRefreshJobs} />);
    expect(screen.getByRole('img', { name: '原图预览' })).toHaveAttribute('src', assets[0]!.displayUrl);
    expect(screen.getByRole('list', { name: '分层任务进度' })).toHaveTextContent('排队中');
    expect(screen.getByRole('button', { name: '导出 PSD' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '同步任务状态' }));
    await waitFor(() => expect(onRefreshJobs).toHaveBeenCalledOnce());
  });

  it.each(['failed', 'completed'] as const)('requires explicit confirmation before retrying a rejected %s layer task', async (status) => {
    const failedNode = createCanvasModuleNode('failed-subject', 'image_layer', { x: 0, y: 0 });
    failedNode.data.config = { ...failedNode.data.config, layerId: 'subject', name: 'Subject', jobId: 'failed-job', status: 'failed', qualityStatus: 'failed' };
    const failedJob = { id: 'failed-job', status, layeringLayerId: 'subject' } as ModelJob;
    const onRetryJob = vi.fn(async (_jobId: string) => {});
    render(<ImageLayeringWorkbench config={{ sourceAssetId: base, canvasWidth: 2, canvasHeight: 2, layers: [],
      planLayers: [{ layerId: 'base', name: 'Background' }, { layerId: 'subject', name: 'Subject' }] }}
      assets={assets} layerNodes={[failedNode]} jobs={[failedJob]} onLayersChange={() => {}}
      canRetryJob={() => true} onRetryJob={onRetryJob} />);
    fireEvent.click(screen.getByRole('button', { name: '重试图层 Subject' }));
    expect(onRetryJob).not.toHaveBeenCalled();
    expect(screen.getByText(/可能产生费用/u)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '确认重新生成 Subject' }));
    await waitFor(() => expect(onRetryJob).toHaveBeenCalledWith('failed-job'));
  });
});
