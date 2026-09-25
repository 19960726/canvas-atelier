import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTO_IMAGE_COLOR_CORRECTION, ORIGINAL_IMAGE_COLOR_CORRECTION, normalizeImageColorCorrection } from '../app/image-color-correction';
import { ImageColorCorrectionControls } from './ImageColorCorrectionControls';
import { ImageComparisonDivider } from './ImageComparisonDivider';
import { ImageColorCorrectionImage } from './ImageColorCorrectionImage';
import { ProjectImageLightbox } from './ProjectImageLightbox';
import { ReactFlowProvider } from '@xyflow/react';
import { createCanvasModuleNode } from '@agent-canvas/domain';
import { ModuleNodeCard } from './ModuleNodeCard';
import { resetAppStoreForTests, useAppStore } from '../app/app-store';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function mockImageSamples() {
  const loads: string[] = [];
  const pending: (() => void)[] = [];
  vi.stubGlobal('Image', class {
    naturalWidth = 800;
    naturalHeight = 800;
    onload: (() => void) | null = null;
    source = '';
    set src(value: string) { this.source = value; loads.push(value); pending.push(() => this.onload?.()); }
  });
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
    let source = '';
    return {
      drawImage: (image: { source: string }) => { source = image.source; drawImage(image); },
      getImageData: () => ({ data: new Uint8ClampedArray(Array.from({ length: 64 }, () => source.includes('neutral') ? [180, 180, 180, 255] : source.includes('red') ? [204, 180, 180, 255] : [204, 180, 204, 255]).flat()) }),
    } as never;
  });
  const finish = async () => { await act(async () => { pending.splice(0).forEach((load) => load()); }); };
  return { loads, drawImage, finish };
}

describe('analyzed image previews', () => {
  it('offers an opt-in Nano Banana preset with independent strength and keeps manual adjustments', () => {
    const onChange = vi.fn();
    const onCompareChange = vi.fn();
    const props = { comparingOriginal: true, comparisonPresentation: 'split' as const, onChange, onCompareChange };
    const { rerender } = render(<ImageColorCorrectionControls {...props} value={ORIGINAL_IMAGE_COLOR_CORRECTION} />);
    fireEvent.click(screen.getByRole('button', { name: '图片颜色校正' }));
    fireEvent.click(screen.getByRole('button', { name: 'Nano Banana 去偏色' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'auto', profile: 'nano-banana', strength: 60 }));
    const nano = { ...AUTO_IMAGE_COLOR_CORRECTION, profile: 'nano-banana' as const, strength: 60, temperature: -5, tint: -1 };
    rerender(<ImageColorCorrectionControls {...props} value={nano} analysisStatus="applied" />);
    expect(screen.getByRole('button', { name: '图片颜色校正' })).toHaveTextContent('Nano Banana');
    fireEvent.change(screen.getByRole('slider', { name: '去偏色强度' }), { target: { value: '80' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'auto', profile: 'nano-banana', strength: 80 }));
    fireEvent.change(screen.getByRole('slider', { name: '饱和度' }), { target: { value: '110' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'custom', temperature: -5, tint: -1, saturation: 110 }));
    fireEvent.click(screen.getByRole('button', { name: '恢复原图颜色' }));
    expect(onChange).toHaveBeenLastCalledWith(ORIGINAL_IMAGE_COLOR_CORRECTION);
  });
  it('keeps a legacy untouched result original until the user chooses a correction', async () => {
    resetAppStoreForTests();
    const { loads, finish } = mockImageSamples();
    const node = createCanvasModuleNode('legacy-auto-color', 'image_generation', { x: 0, y: 0 });
    const asset = {
      assetId: '0123456789abcdef', byteSize: 42, displayUrl: 'novus-asset://project/red-node/0123456789abcdef',
      extension: 'png' as const, height: 800, label: 'Product', mediaType: 'image/png' as const,
      origin: 'generated' as const, sha256: '0'.repeat(64), usageCount: 1, width: 800,
    };
    node.data.config = { ...node.data.config, resultAssetIds: [asset.assetId], resultState: 'fresh',
      colorCorrection: { mode: 'original', temperature: 0, tint: 0, saturation: 100, contrast: 100, brightness: 100 } };
    useAppStore.setState({ projectImages: [asset], project: { ...useAppStore.getState().project, nodes: [node], edges: [] } } as never);
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    await finish();
    expect(screen.getByRole('img', { name: 'Generated image preview 1' }).style.filter).toBe('none');
    fireEvent.click(screen.getByRole('button', { name: 'Open image generation editor' }));
    await finish();
    expect(screen.getByRole('img', { name: 'Generated image 1' }).style.filter).toBe('none');
    expect(screen.getByRole('button', { name: '图片颜色校正' })).toHaveTextContent('原图');
    expect(screen.getByRole('button', { name: '切换原图对比' })).toBeDisabled();
    expect(loads).toHaveLength(0);
  });

  it('keeps separate corrections for four results and never repeats sampling on interaction renders', async () => {
    const { loads, drawImage, finish } = mockImageSamples();
    const urls = ['red', 'magenta', 'neutral', 'magenta-2'].map((name) => `novus-asset://four-results/${name}`);
    const gallery = (comparingOriginal: boolean) => <>{urls.map((src) => <ImageColorCorrectionImage key={src} src={src} alt={src} correction={AUTO_IMAGE_COLOR_CORRECTION} comparingOriginal={comparingOriginal} />)}</>;
    const { rerender, container } = render(gallery(false));
    await finish();
    const images = screen.getAllByRole('img');
    await waitFor(() => expect(images[0]!.style.filter).toContain('url('));
    expect(images[1]!.style.filter).toContain('url(');
    expect(images[2]!.style.filter).toBe('none');
    const filters = [...container.querySelectorAll('feColorMatrix')].map((filter) => filter.getAttribute('values'));
    expect(filters[0]).not.toBe(filters[1]);
    expect(filters[1]).toBe(filters[3]);
    expect(new Set([...container.querySelectorAll('filter')].map((filter) => filter.id)).size).toBe(4);
    rerender(gallery(true));
    expect(screen.getAllByRole('img').every((image) => image.style.filter === 'none')).toBe(true);
    rerender(gallery(false));
    expect(screen.getAllByRole('img')[0]!.style.filter).toContain('url(');
    expect(loads).toHaveLength(4);
    expect(drawImage).toHaveBeenCalledTimes(4);
  });

  it('does not replace a later explicit original selection with a late analysis result', async () => {
    const { finish } = mockImageSamples();
    const src = 'novus-asset://late-analysis/magenta';
    const { rerender } = render(<ImageColorCorrectionImage src={src} alt="Late image" correction={AUTO_IMAGE_COLOR_CORRECTION} />);
    rerender(<ImageColorCorrectionImage src={src} alt="Late image" correction={ORIGINAL_IMAGE_COLOR_CORRECTION} />);
    await finish();
    expect(screen.getByRole('img').style.filter).toBe('none');
  });

  it('does not display the previous image correction while the next source is being analyzed', async () => {
    const { finish } = mockImageSamples();
    const { rerender } = render(<ImageColorCorrectionImage src="novus-asset://source-change/red" alt="Changing image" correction={AUTO_IMAGE_COLOR_CORRECTION} />);
    await finish();
    expect(screen.getByRole('img').style.filter).toContain('url(');
    rerender(<ImageColorCorrectionImage src="novus-asset://source-change/neutral" alt="Changing image" correction={AUTO_IMAGE_COLOR_CORRECTION} />);
    expect(screen.getByRole('img').style.filter).toBe('none');
    await finish();
    expect(screen.getByRole('img').style.filter).toBe('none');
  });

  it('exposes an enabled default original comparison and persists an explicit reset', () => {
    const onChange = vi.fn();
    const onCompareChange = vi.fn();
    render(<ImageColorCorrectionControls value={AUTO_IMAGE_COLOR_CORRECTION} comparingOriginal={false} onChange={onChange} onCompareChange={onCompareChange} />);
    const compare = screen.getByRole('button', { name: '切换原图对比' });
    expect(compare).toBeEnabled();
    fireEvent.click(compare);
    expect(onCompareChange).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: '恢复原图颜色' }));
    expect(normalizeImageColorCorrection(onChange.mock.calls[0]![0]).mode).toBe('original');
  });

  it('keeps a split comparison visible while node color controls are adjusted', () => {
    const onChange = vi.fn();
    const onCompareChange = vi.fn();
    render(<ImageColorCorrectionControls
      value={AUTO_IMAGE_COLOR_CORRECTION}
      comparingOriginal
      comparisonPresentation="split"
      onChange={onChange}
      onCompareChange={onCompareChange}
    />);

    expect(screen.getByRole('button', { name: '切换原图对比' })).toHaveTextContent('关闭对比');
    fireEvent.click(screen.getByRole('button', { name: '图片颜色校正' }));
    fireEvent.change(screen.getByRole('slider', { name: '饱和度' }), { target: { value: '112' } });

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ mode: 'custom', saturation: 112 }));
    expect(onCompareChange).not.toHaveBeenCalled();
  });

  it('exposes one keyboard-accessible divider for the whole before-and-after preview', () => {
    const onChange = vi.fn();
    const { container } = render(<ImageComparisonDivider position={50} onChange={onChange} />);
    const divider = screen.getByRole('slider', { name: '原图与校正后对比线' });

    expect(divider).toHaveAttribute('aria-valuetext', '原图 50%，校正后 50%');
    expect(screen.getByText('原图')).toBeInTheDocument();
    expect(screen.getByText('校正后')).toBeInTheDocument();
    expect(container.querySelector('.module-node__image-comparison-divider')).toHaveStyle({ left: '50%' });

    fireEvent.change(divider, { target: { value: '72' } });
    expect(onChange).toHaveBeenCalledWith(72);
  });

  it('corrects and compares only the selected result', async () => {
    resetAppStoreForTests();
    const { finish } = mockImageSamples();
    const node = createCanvasModuleNode('split-color-comparison', 'image_generation', { x: 0, y: 0 });
    const assets = ['red', 'magenta', 'neutral', 'magenta-2'].map((name, index) => {
      const assetId = `${index + 1}`.repeat(16);
      return {
        assetId, byteSize: 42, displayUrl: `novus-asset://project/split-${name}/${assetId}`,
        extension: 'png' as const, height: 800, label: `Product ${index + 1}`, mediaType: 'image/png' as const,
        origin: 'generated' as const, sha256: `${index}`.repeat(64), usageCount: 1, width: 800,
      };
    });
    node.data.config = {
      ...node.data.config,
      resultAssetIds: assets.map((asset) => asset.assetId),
      resultState: 'fresh',
      colorCorrection: AUTO_IMAGE_COLOR_CORRECTION,
    };
    const draftGenerationNodeConfig = vi.fn(async (_nodeId: string, _draft: Record<string, unknown>) => true);
    useAppStore.setState({ draftGenerationNodeConfig, projectImages: assets, project: { ...useAppStore.getState().project, nodes: [node], edges: [] } } as never);
    const { container, unmount } = render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    await finish();

    expect(container.querySelector('.module-node > .module-node__header')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open image generation editor' }));
    await finish();
    fireEvent.click(screen.getByRole('button', { name: '切换原图对比' }));

    expect(screen.getAllByRole('slider', { name: '原图与校正后对比线' })).toHaveLength(1);
    const stage = container.querySelector('.module-node__generation-comparison-stage');
    expect(stage).not.toBeNull();
    expect(stage?.querySelectorAll('.module-node__generation-comparison-original img')).toHaveLength(1);
    expect(screen.getByRole('img', { name: 'Generated image 2' }).style.filter).toBe('none');
    expect(stage?.querySelector('.module-node__image-comparison-divider')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Generated image 1' }).style.filter).toContain('url(');
    fireEvent.click(screen.getByRole('button', { name: 'Generated image 2; double click to preview' }));
    expect(screen.getByRole('button', { name: '图片颜色校正' })).toHaveTextContent('原图');
    fireEvent.click(screen.getByRole('button', { name: '图片颜色校正' }));
    fireEvent.change(screen.getByRole('slider', { name: '饱和度' }), { target: { value: '112' } });
    expect(screen.getByRole('img', { name: 'Generated image 2' }).style.filter).toContain('url(');
    expect(screen.getByRole('img', { name: 'Generated image 3' }).style.filter).toBe('none');
    fireEvent.click(screen.getByRole('button', { name: '切换原图对比' }));
    expect(screen.getByRole('slider', { name: '原图与校正后对比线' }).closest('.module-node__generation-preview-item'))
      .toContainElement(screen.getByRole('img', { name: 'Generated image 2' }));
    fireEvent.click(screen.getByRole('button', { name: '恢复原图颜色' }));
    expect(screen.getByRole('img', { name: 'Generated image 2' }).style.filter).toBe('none');
    expect(screen.getByRole('img', { name: 'Generated image 1' }).style.filter).toContain('url(');
    await act(async () => { await useAppStore.getState().preparePersistenceForClose(); });
    const saved = JSON.parse(JSON.stringify(draftGenerationNodeConfig.mock.calls[draftGenerationNodeConfig.mock.calls.length - 1]?.[1]));
    expect(saved.imageColorCorrections[assets[0]!.assetId].mode).toBe('auto');
    expect(saved.imageColorCorrections[assets[1]!.assetId].mode).toBe('original');
    unmount();
    node.data.config = { ...node.data.config, ...saved, resultAssetIds: [assets[1]!.assetId, assets[0]!.assetId, assets[2]!.assetId, assets[3]!.assetId] };
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Open image generation editor' }));
    await finish();
    expect(screen.getByRole('img', { name: 'Generated image 1' }).style.filter).toBe('none');
    expect(screen.getByRole('img', { name: 'Generated image 2' }).style.filter).toContain('url(');
  });

  it('analyzes a lightbox independently and bases a custom adjustment on its displayed correction', async () => {
    const { finish, loads } = mockImageSamples();
    const onChange = vi.fn();
    const asset = {
      assetId: '0123456789abcdef', byteSize: 42, displayUrl: 'novus-asset://lightbox-test/red',
      extension: 'png' as const, height: 800, label: 'Product', mediaType: 'image/png' as const,
      origin: 'generated' as const, sha256: '0'.repeat(64), usageCount: 1, width: 800,
    };
    render(<ProjectImageLightbox asset={asset} colorCorrection={AUTO_IMAGE_COLOR_CORRECTION} onColorCorrectionChange={onChange}
      index={0} total={1} onClose={() => undefined} onPrevious={() => undefined} onNext={() => undefined} />);
    await finish();
    const preview = screen.getByRole('img', { name: 'Generated image 1 full preview' });
    expect(preview.style.filter).toContain('url(');
    fireEvent.click(screen.getByRole('button', { name: '切换原图对比' }));
    expect(preview.style.filter).toBe('none');
    fireEvent.click(screen.getByRole('button', { name: '切换原图对比' }));
    expect(preview.style.filter).toContain('url(');
    fireEvent.click(screen.getByRole('button', { name: '图片颜色校正' }));
    fireEvent.click(screen.getByRole('button', { name: '自定义颜色校正' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ mode: 'custom', tint: expect.any(Number), temperature: expect.any(Number) }));
    expect(onChange.mock.calls[0]![0].tint).toBeLessThan(0);
    expect(loads).toHaveLength(1);
  });
});
