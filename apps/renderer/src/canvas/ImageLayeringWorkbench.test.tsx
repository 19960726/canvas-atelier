import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvasModuleNode, type ModelJob } from '@agent-canvas/domain';
import { ImageLayeringWorkbench } from './ImageLayeringWorkbench';
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

  it('requires another explicit confirmation before retrying a failed paid layer task', async () => {
    const failedNode = createCanvasModuleNode('failed-subject', 'image_layer', { x: 0, y: 0 });
    failedNode.data.config = { ...failedNode.data.config, layerId: 'subject', name: 'Subject', jobId: 'failed-job', status: 'failed' };
    const failedJob = { id: 'failed-job', status: 'failed', layeringLayerId: 'subject' } as ModelJob;
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
