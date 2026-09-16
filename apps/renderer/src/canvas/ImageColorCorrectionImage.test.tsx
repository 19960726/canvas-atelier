import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTO_IMAGE_COLOR_CORRECTION, ORIGINAL_IMAGE_COLOR_CORRECTION, normalizeImageColorCorrection } from '../app/image-color-correction';
import { ImageColorCorrectionControls } from './ImageColorCorrectionControls';
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
  it('applies default correction to a legacy node result without a preset click', async () => {
    resetAppStoreForTests();
    const { finish } = mockImageSamples();
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
    expect(screen.getByRole('img', { name: 'Generated image preview 1' }).style.filter).toContain('url(');
    fireEvent.click(screen.getByRole('button', { name: 'Open image generation editor' }));
    await finish();
    expect(screen.getByRole('img', { name: 'Generated image 1' }).style.filter).toContain('url(');
    expect(screen.getByRole('button', { name: '切换原图对比' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '切换原图对比' }));
    expect(screen.getByRole('img', { name: 'Generated image 1' }).style.filter).toBe('none');
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
