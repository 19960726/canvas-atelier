import { readFileSync } from 'node:fs';
import { useLayoutEffect, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReactFlowProvider, useStoreApi } from '@xyflow/react';
import { createCanvasModuleNode } from '@agent-canvas/domain';
import { ModuleNodeCard, promptContainsImageMention, resolveAutomaticVideoAspectRatio } from './ModuleNodeCard';
import { resetAppStoreForTests, useAppStore } from '../app/app-store';
import { createProjectPersistenceClient } from '../app/desktop-persistence';
import { PROVIDER_MODEL_DEFAULTS_STORAGE_KEY, writeProviderModelDefaults } from '../settings/provider-model-defaults';
import { ORIGINAL_IMAGE_COLOR_CORRECTION } from '../app/image-color-correction';

const originalDesktop = window.novusDesktop;

const projectImage = {
  assetId: '0123456789abcdef',
  byteSize: 42,
  displayUrl: 'novus-asset://project/session/0123456789abcdef',
  extension: 'png' as const,
  height: 3,
  label: 'Product front',
  mediaType: 'image/png' as const,
  origin: 'imported' as const,
  sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  usageCount: 1,
  width: 2,
};

const projectVideo = {
  assetId: 'fedcba9876543210',
  byteSize: 2048,
  displayUrl: 'novus-asset://project/session/fedcba9876543210',
  durationMs: null,
  extension: 'mp4' as const,
  height: null,
  label: 'Product turntable',
  mediaType: 'video/mp4' as const,
  origin: 'imported' as const,
  sha256: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
  usageCount: 1,
  width: null,
};

beforeEach(() => {
  resetAppStoreForTests();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.novusDesktop = originalDesktop;
  createProjectPersistenceClient();
});

function openImageGenerationEditor() {
  fireEvent.click(screen.getByRole('button', { name: 'Open image generation editor' }));
}

function FlowZoom({ children, zoom }: { children: ReactNode; zoom: number }) {
  const store = useStoreApi();
  useLayoutEffect(() => {
    store.setState({ transform: [0, 0, zoom] });
  }, [store, zoom]);
  return children;
}

function openVideoGenerationEditor() {
  fireEvent.click(screen.getByRole('button', { name: 'Open video generation editor' }));
}
function openGenerationParameterOptions(label: string) {
  if (label.startsWith('Video preview ')) {
    const current = screen.queryByRole('dialog', { name: '视频生成参数' });
    if (current) return current;
    fireEvent.click(screen.getByRole('button', { name: '打开视频参数设置' }));
    return screen.getByRole('dialog', { name: '视频生成参数' });
  }
  const current = screen.queryByRole('menu', { name: label + ' options' });
  if (current) return current;
  fireEvent.click(screen.getByRole('button', { name: label }));
  return screen.getByRole('menu', { name: label + ' options' });
}

function createPhotoshopDesktopBridge(importToPhotoshop: ReturnType<typeof vi.fn>) {
  return {
    closeProject: vi.fn(async () => undefined),
    commit: vi.fn(),
    createStablePoint: vi.fn(),
    getRecoveryPlan: vi.fn(),
    openProject: vi.fn(async () => ({
      currentRevision: 0,
      mode: 'write' as const,
      project: useAppStore.getState().project,
      projectId: useAppStore.getState().project.id,
      projectName: useAppStore.getState().project.name,
      sessionId: 'photoshop-session',
      stableSnapshotId: null,
      stableSnapshotRevision: 0,
    })),
    projectImages: {
      importImage: vi.fn(),
      importToPhotoshop,
      list: vi.fn(async () => []),
      pasteClipboardImage: vi.fn(),
    },
    restore: vi.fn(),
  };
}

function readGenerationParameterOptions(label: string): Array<string | null> {
  if (label === 'Video preview aspect ratio') {
    return within(openGenerationParameterOptions(label).querySelector('[aria-label="比例"]') as HTMLElement).getAllByRole('menuitemradio').map((item) => item.textContent);
  }
  if (label === 'Video preview resolution') {
    return within(openGenerationParameterOptions(label).querySelector('[aria-label="清晰度"]') as HTMLElement).getAllByRole('menuitemradio').map((item) => item.textContent);
  }
  return within(openGenerationParameterOptions(label)).getAllByRole('menuitemradio').map((item) => item.textContent);
}

function chooseGenerationParameterOption(label: string, option: string): void {
  fireEvent.click(within(openGenerationParameterOptions(label)).getByRole('menuitemradio', { name: option }));
}
describe('ModuleNodeCard', () => {
  it('marks the entire node as a React Flow no-wheel boundary', () => {
    const node = createCanvasModuleNode('wheel-boundary', 'image_generation', { x: 0, y: 0 });
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    expect(screen.getByTestId('module-node-card')).toHaveClass('nowheel');
  });

  it('uses a lightweight node shell in a low-zoom overview and restores full controls when zoomed in', async () => {
    const node = createCanvasModuleNode('overview-image-node', 'image_input', { x: 0, y: 0 });
    const view = render(<ReactFlowProvider><FlowZoom zoom={0.2}><ModuleNodeCard id={node.id} data={node.data} selected={false} /></FlowZoom></ReactFlowProvider>);

    await waitFor(() => expect(screen.getByTestId('module-node-card')).toHaveAttribute('data-render-detail', 'overview'));
    expect(screen.queryByRole('button', { name: '锁定位置 / Lock position' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('模块端口 / Module ports')).toBeInTheDocument();

    view.rerender(<ReactFlowProvider><FlowZoom zoom={0.2}><ModuleNodeCard id={node.id} data={node.data} selected /></FlowZoom></ReactFlowProvider>);
    await waitFor(() => expect(screen.getByTestId('module-node-card')).toHaveAttribute('data-render-detail', 'full'));
    expect(screen.getByRole('button', { name: '锁定位置 / Lock position' })).toBeInTheDocument();

    view.rerender(<ReactFlowProvider><FlowZoom zoom={0.2}><ModuleNodeCard id={node.id} data={node.data} selected={false} /></FlowZoom></ReactFlowProvider>);
    await waitFor(() => expect(screen.getByTestId('module-node-card')).toHaveAttribute('data-render-detail', 'overview'));

    view.rerender(<ReactFlowProvider><FlowZoom zoom={0.7}><ModuleNodeCard id={node.id} data={node.data} selected={false} /></FlowZoom></ReactFlowProvider>);
    await waitFor(() => expect(screen.getByTestId('module-node-card')).toHaveAttribute('data-render-detail', 'full'));
    expect(screen.getByRole('button', { name: '锁定位置 / Lock position' })).toBeInTheDocument();
  });

  it.each([
    ['image_generation', 'prompt', '柔光红色产品主图', '生图节点 · 柔光红色产品主图 · #aaa111'],
    ['video_generation', 'prompt', '三秒推进产品镜头', '视频生成节点 · 三秒推进产品镜头 · #bbb222'],
    ['reverse_agent', 'task', '分析产品构图与灯光', '反推节点 · 分析产品构图与灯光 · #ccc333'],
  ] as const)('shows a stable fallback workflow label for a legacy %s node', (moduleType, configKey, summary, expectedLabel) => {
    const id = `legacy-${moduleType}-${expectedLabel.slice(-6)}`;
    const node = createCanvasModuleNode(id, moduleType, { x: 0, y: 0 });
    node.data.config = { ...node.data.config, [configKey]: summary };

    const { container } = render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    const workflowLabel = container.querySelector('.module-node__workflow-label');
    expect(workflowLabel).toHaveTextContent(expectedLabel);
    expect(workflowLabel).toHaveAttribute('title', expectedLabel);
  });

  it('distinguishes legacy nodes with the same prompt by their stable short ids', () => {
    const first = createCanvasModuleNode('legacy-image-node-aaa111', 'image_generation', { x: 0, y: 0 });
    const second = createCanvasModuleNode('legacy-image-node-bbb222', 'image_generation', { x: 400, y: 0 });
    first.data.config = { ...first.data.config, prompt: '相同的产品主图提示词' };
    second.data.config = { ...second.data.config, prompt: '相同的产品主图提示词' };

    const { container } = render(<ReactFlowProvider><>
      <ModuleNodeCard id={first.id} data={first.data} selected={false} />
      <ModuleNodeCard id={second.id} data={second.data} selected={false} />
    </></ReactFlowProvider>);

    const labels = Array.from(container.querySelectorAll('.module-node__workflow-label')).map((label) => label.textContent);
    expect(labels).toEqual([
      '生图节点 · 相同的产品主图提示词 · #aaa111',
      '生图节点 · 相同的产品主图提示词 · #bbb222',
    ]);
  });

  it('keeps an explicit Agent workflow label ahead of the legacy fallback', () => {
    const node = createCanvasModuleNode('legacy-image-node-ddd444', 'image_generation', { x: 0, y: 0 });
    node.data.config = {
      ...node.data.config,
      prompt: '不应替代显式标签',
      agentWorkflowLabel: '方案 7 · 红色产品早餐场景',
    };

    const { container } = render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    expect(container.querySelector('.module-node__workflow-label')).toHaveTextContent('方案 7 · 红色产品早餐场景');
    expect(container.querySelector('.module-node__workflow-label')).not.toHaveTextContent('#ddd444');
  });

  it('drafts image-generation text and parameters before Generate is pressed', async () => {
    const node = createCanvasModuleNode('image-draft-ui', 'image_generation', { x: 0, y: 0 });
    const draftGenerationNodeConfig = vi.fn(async () => true);
    useAppStore.setState({
      draftGenerationNodeConfig,
      project: { ...useAppStore.getState().project, nodes: [node], edges: [] },
    } as never);
    const data = {
      ...node.data,
      imageGenerationRoutes: [{ provider: 'comfly', modelRoute: 'image-route', displayName: 'Image Route', capabilities: ['image_generation'] }],
    } as typeof node.data;
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    fireEvent.change(screen.getByLabelText('Image generation prompt'), { target: { value: 'Persist this image prompt.' } });

    await waitFor(() => expect(draftGenerationNodeConfig).toHaveBeenLastCalledWith(node.id, expect.objectContaining({
      prompt: 'Persist this image prompt.',
      modelRoute: 'image-route',
      aspectRatio: '1:1',
      resolution: '2K',
      outputCount: 1,
    })));
  });

  it('shows GPT Image quality as a real control and submits the selected tier', async () => {
    const node = createCanvasModuleNode('gpt-image-quality-ui', 'image_generation', { x: 0, y: 0 });
    const runImageGenerationNode = vi.fn(async () => true);
    const draftGenerationNodeConfig = vi.fn(async () => true);
    const data = {
      ...node.data,
      imageGenerationRoutes: [{
        provider: 'comfly', modelRoute: 'comfly-gpt-image-2', displayName: 'GPT Image 2', modelId: 'gpt-image-2',
        capabilities: ['image_generation'],
      }],
    } as typeof node.data;
    useAppStore.setState({
      draftGenerationNodeConfig,
      runImageGenerationNode,
      project: { ...useAppStore.getState().project, nodes: [{ ...node, data }], edges: [] },
    } as never);
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    expect(readGenerationParameterOptions('Image generation quality')).toEqual(['自动', '低', '中', '高']);
    chooseGenerationParameterOption('Image generation quality', '高');
    fireEvent.change(screen.getByLabelText('Image generation prompt'), { target: { value: 'High quality product photo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));

    await waitFor(() => expect(runImageGenerationNode).toHaveBeenCalledWith(node.id, expect.objectContaining({
      imageQuality: 'high',
    })));
    await waitFor(() => expect(draftGenerationNodeConfig).toHaveBeenLastCalledWith(node.id, expect.objectContaining({
      imageQuality: 'high',
    })));
  });

  it('groups GPT resolution variants and persists output format and background with the exact route', async () => {
    const node = createCanvasModuleNode('gpt-output-controls', 'image_generation', { x: 0, y: 0 });
    const runImageGenerationNode = vi.fn(async () => true);
    const draftGenerationNodeConfig = vi.fn(async () => true);
    const routes = ['1K', '2K', '4K'].map((tier, index) => ({
      provider: 'comfly', modelRoute: `sunburst-${tier}`, modelId: `gpt-image-2.5-sunburst${index ? `-${tier.toLowerCase()}` : ''}`,
      displayName: `GPT Image 2.5 Sunburst${index ? ` ${tier}` : ''}`,
      capabilities: ['image_generation', 'image_edit'], capabilityStatus: 'complete',
      constraints: { image: { resolutions: [tier] } },
    }));
    const data = { ...node.data, imageGenerationRoutes: routes } as typeof node.data;
    useAppStore.setState({ draftGenerationNodeConfig, runImageGenerationNode,
      project: { ...useAppStore.getState().project, nodes: [{ ...node, data }], edges: [] },
    } as never);
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();
    fireEvent.click(screen.getByRole('button', { name: '打开生图模型列表' }));
    const items = within(screen.getByRole('listbox', { name: '生图模型' })).getAllByRole('menuitemradio');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('GPT Image 2.5 Sunburst');
    expect(items[0]).not.toHaveTextContent('2K');
    fireEvent.click(items[0]!);
    expect(readGenerationParameterOptions('Image generation aspect ratio')).toEqual(['AUTO', '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']);
    chooseGenerationParameterOption('Image generation aspect ratio', '4:5');
    chooseGenerationParameterOption('Image generation resolution', '4K');
    chooseGenerationParameterOption('Image generation quality', '自动');
    chooseGenerationParameterOption('Image generation format', 'WEBP');
    chooseGenerationParameterOption('Image generation background', '透明');
    chooseGenerationParameterOption('Image generation batch count', '9张');
    fireEvent.change(screen.getByLabelText('Image generation prompt'), { target: { value: 'Product on transparent background' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));
    const expected = { modelRoute: 'sunburst-4K', aspectRatio: '4:5', resolution: '4K', imageQuality: 'auto', imageOutputFormat: 'webp', imageBackground: 'transparent', outputCount: 9 };
    await waitFor(() => expect(runImageGenerationNode).toHaveBeenCalledWith(node.id, expect.objectContaining(expected)));
    await waitFor(() => expect(draftGenerationNodeConfig).toHaveBeenLastCalledWith(node.id, expect.objectContaining(expected)));
    chooseGenerationParameterOption('Image generation format', 'JPEG');
    expect(screen.getByRole('button', { name: 'Image generation background' })).toHaveTextContent('不透明');
    const backgroundMenu = openGenerationParameterOptions('Image generation background');
    expect(within(backgroundMenu).getByRole('menuitemradio', { name: '透明' })).toBeDisabled();
  });

  it('renders every result in a saved nine-image batch and can preview the ninth image', () => {
    const node = createCanvasModuleNode('nine-image-gallery', 'image_generation', { x: 0, y: 0 });
    const images = Array.from({ length: 9 }, (_, index) => ({ ...projectImage,
      assetId: (index + 1).toString(16).padStart(16, '0'),
      displayUrl: `novus-asset://project/session/${(index + 1).toString(16).padStart(16, '0')}`,
    }));
    node.data.config = { ...node.data.config, resultAssetIds: images.map((asset) => asset.assetId), resultState: 'fresh' };
    useAppStore.setState({ projectImages: images, project: { ...useAppStore.getState().project, nodes: [node], edges: [] } } as never);
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    expect(screen.getAllByRole('img', { name: /Generated image preview/ })).toHaveLength(9);
    openImageGenerationEditor();
    const canvasCss = readFileSync('apps/renderer/src/styles/canvas-layout.css', 'utf8');
    const stateAwareRule = canvasCss.slice(canvasCss.lastIndexOf('STATE-AWARE IMAGE EDITOR LAYOUT'));
    expect(stateAwareRule).toMatch(/generation-preview-gallery--9[\s\S]*?generation-preview-item\s*>\s*img[\s\S]*?object-fit:\s*cover/);
    const releaseCss = readFileSync('apps/renderer/src/styles/release-layout-contract.css', 'utf8');
    const releaseStateAwareRule = releaseCss.slice(releaseCss.lastIndexOf('STATE-AWARE IMAGE EDITOR LAYOUT'));
    expect(releaseStateAwareRule).toMatch(/generation-preview-gallery--9[\s\S]*?generation-preview-item\s*>\s*img[\s\S]*?object-fit:\s*cover/);
    const collapsedRule = canvasCss.slice(canvasCss.lastIndexOf('COLLAPSED IMAGE RESULT SQUARE CONTRACT'));
    expect(collapsedRule).toMatch(/data-editor-expanded='false'\]\[data-has-result='true'\][\s\S]*?width:\s*448px\s*!important[\s\S]*?height:\s*448px\s*!important/);
    expect(collapsedRule).toMatch(/generation-preview-gallery--9[\s\S]*?grid-template-columns:\s*repeat\(3,[\s\S]*?grid-template-rows:\s*repeat\(3,/);
    const releaseCollapsedRule = releaseCss.slice(releaseCss.lastIndexOf('COLLAPSED IMAGE RESULT SQUARE CONTRACT'));
    expect(releaseCollapsedRule).toMatch(/data-editor-expanded='false'\]\[data-has-result='true'\][\s\S]*?width:\s*448px\s*!important[\s\S]*?height:\s*448px\s*!important/);
    expect(releaseCollapsedRule).toMatch(/generation-preview-gallery--9[\s\S]*?grid-template-columns:\s*repeat\(3,[\s\S]*?grid-template-rows:\s*repeat\(3,/);
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Generated image 9; double click to preview' }));
    expect(screen.getByRole('img', { name: 'Generated image 9 full preview' })).toHaveAttribute('src', images[8]!.displayUrl);
  });

  it('offers provider-independent color correction above completed image results and persists it', async () => {
    vi.stubGlobal('Image', class {
      naturalWidth = 96;
      naturalHeight = 96;
      onload: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
      getImageData: () => ({ data: new Uint8ClampedArray(Array.from({ length: 64 }, () => [204, 180, 204, 255]).flat()) }),
    } as never);
    const node = createCanvasModuleNode('color-correction-results', 'image_generation', { x: 0, y: 0 });
    node.data.config = { ...node.data.config, resultAssetIds: [projectImage.assetId], resultState: 'fresh' };
    const draftGenerationNodeConfig = vi.fn(async () => true);
    useAppStore.setState({
      projectImages: [{ ...projectImage, displayUrl: 'novus-asset://project/color-persist/0123456789abcdef' }],
      project: { ...useAppStore.getState().project, nodes: [node], edges: [] },
      draftGenerationNodeConfig,
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();
    fireEvent.click(screen.getByRole('button', { name: '图片颜色校正' }));
    const panel = screen.getByRole('dialog', { name: '图片颜色校正' });
    fireEvent.click(within(panel).getByRole('button', { name: '自动中和红紫偏色' }));

    const result = screen.getByRole('img', { name: 'Generated image 1' });
    await waitFor(() => expect(result.style.filter).toContain('url("#image-color-correction-color-correction-results-0")'));
    const compare = screen.getByRole('button', { name: '切换原图对比' });
    expect(compare).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(compare);
    expect(result.style.filter).toBe('none');
    expect(compare).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(compare);
    expect(result.style.filter).toContain('url("#image-color-correction-color-correction-results-0")');
    expect(compare).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => expect(draftGenerationNodeConfig).toHaveBeenLastCalledWith(node.id, expect.objectContaining({
      colorCorrection: expect.objectContaining({ mode: 'auto', version: 1, temperature: 0, tint: 0 }),
    })));
    expect(screen.getByRole('button', { name: '图片颜色校正' })).toHaveTextContent('自动中和');

    fireEvent.click(within(panel).getByRole('button', { name: '自定义颜色校正' }));
    fireEvent.change(within(panel).getByRole('slider', { name: '洋红绿色' }), { target: { value: '-14' } });
    await waitFor(() => expect(draftGenerationNodeConfig).toHaveBeenLastCalledWith(node.id, expect.objectContaining({
      colorCorrection: expect.objectContaining({ mode: 'custom', tint: -14 }),
    })));

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Generated image 1; double click to preview' }));
    const lightbox = screen.getByRole('dialog', { name: 'Generated image preview' });
    fireEvent.click(within(lightbox).getByRole('button', { name: '图片颜色校正' }));
    const lightboxCorrection = within(lightbox).getByRole('dialog', { name: '图片颜色校正' });
    fireEvent.change(within(lightboxCorrection).getByRole('slider', { name: '色温' }), { target: { value: '-18' } });
    const lightboxImage = within(lightbox).getByRole('img', { name: 'Generated image 1 full preview' });
    expect(lightboxImage.style.filter).toContain('url("#image-color-correction-color-correction-results-lightbox")');
    fireEvent.click(within(lightbox).getByRole('button', { name: '切换原图对比' }));
    expect(lightboxImage.style.filter).toBe('none');
    await waitFor(() => expect(draftGenerationNodeConfig).toHaveBeenLastCalledWith(node.id, expect.objectContaining({
      colorCorrection: expect.objectContaining({ mode: 'custom', temperature: -18, tint: -14 }),
    })));
  });

  it('keeps a four-result batch in an unobscured square two-by-two gallery', () => {
    const node = createCanvasModuleNode('four-image-gallery', 'image_generation', { x: 0, y: 0 });
    const images = Array.from({ length: 4 }, (_, index) => ({
      ...projectImage,
      assetId: (index + 41).toString(16).padStart(16, '0'),
      displayUrl: `novus-asset://project/session/${(index + 41).toString(16).padStart(16, '0')}`,
    }));
    node.data.config = { ...node.data.config, resultAssetIds: images.map((asset) => asset.assetId), resultState: 'fresh' };
    useAppStore.setState({ projectImages: images, project: { ...useAppStore.getState().project, nodes: [node], edges: [] } } as never);

    const { container } = render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    const gallery = container.querySelector('.module-node__generation-preview-gallery--4');
    expect(gallery).not.toBeNull();
    expect(within(gallery as HTMLElement).getAllByRole('button', { name: /Generated image/u })).toHaveLength(4);
    const css = readFileSync('apps/renderer/src/styles/canvas-layout.css', 'utf8');
    const terminalRule = css.slice(css.lastIndexOf('Final four-result gallery and color-correction placement'));
    expect(terminalRule).toMatch(/module-node__generation-preview-gallery--4[\s\S]*?aspect-ratio:\s*1\s*\/\s*1/);
    expect(terminalRule).toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    expect(terminalRule).toMatch(/grid-template-rows:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    expect(terminalRule).toMatch(/module-node__generation-preview-gallery--4[\s\S]*?module-node__generation-preview-item\s*>\s*img[\s\S]*?object-fit:\s*cover/);
    const releaseCss = readFileSync('apps/renderer/src/styles/release-layout-contract.css', 'utf8');
    const finalFourUpRule = releaseCss.slice(releaseCss.lastIndexOf('FINAL FOUR-UP RESULT CONTRACT'));
    expect(finalFourUpRule).toMatch(/data-result-count='4'[\s\S]*?module-node__workbench-header\s*\{[^}]*?left:\s*156px\s*!important/);
    expect(finalFourUpRule).toMatch(/data-result-count='4'[\s\S]*?module-node__generation-preview-item\s*>\s*:is\(img,\s*video\)[\s\S]*?object-fit:\s*cover/);
  });

  it('uses the reference-style borderless four-up surface and keeps correction controls outside the preview', () => {
    const node = createCanvasModuleNode('reference-style-four-up', 'image_generation', { x: 0, y: 0 });
    const images = Array.from({ length: 4 }, (_, index) => ({
      ...projectImage,
      assetId: (index + 61).toString(16).padStart(16, '0'),
      displayUrl: `novus-asset://project/reference-style/${(index + 61).toString(16).padStart(16, '0')}`,
    }));
    node.data.config = { ...node.data.config, resultAssetIds: images.map((asset) => asset.assetId), resultState: 'fresh' };
    useAppStore.setState({ projectImages: images, project: { ...useAppStore.getState().project, nodes: [node], edges: [] } } as never);

    const { container } = render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    const correction = screen.getByRole('button', { name: '图片颜色校正' }).closest('.module-node__color-correction');
    expect(correction).not.toBeNull();
    expect(correction?.closest('.module-node__generation-editor-preview')).toBeNull();
    expect(correction?.parentElement).toHaveClass('module-node__generation-result-toolbar');

    const css = readFileSync('apps/renderer/src/styles/canvas-layout.css', 'utf8');
    const terminalRule = css.slice(css.lastIndexOf('REFERENCE-STYLE FOUR-UP RESULT SURFACE'));
    expect(terminalRule).toMatch(/data-result-count='4'[\s\S]*?width:\s*760px\s*!important/);
    expect(terminalRule).toMatch(/data-result-count='4'[\s\S]*?background:\s*transparent\s*!important/);
    expect(terminalRule).toMatch(/generation-preview-gallery--4[\s\S]*?width:\s*448px\s*!important[\s\S]*?height:\s*448px\s*!important/);
    expect(terminalRule).toMatch(/generation-preview-gallery--4[\s\S]*?gap:\s*2px\s*!important/);
    expect(terminalRule).toMatch(/module-node__workbench-header\s*\{[^}]*?left:\s*156px\s*!important/);
    expect(terminalRule).toMatch(/generation-result-toolbar[\s\S]*?top:\s*-44px\s*!important/);
    expect(terminalRule).toMatch(/generation-control-bar[\s\S]*?top:\s*600px\s*!important/);
    expect(terminalRule).toMatch(/generation-control-bar[\s\S]*?bottom:\s*auto\s*!important/);
    const stateAwareContract = css.slice(css.lastIndexOf('STATE-AWARE IMAGE EDITOR LAYOUT'));
    expect(stateAwareContract).toMatch(/data-has-result='true'[\s\S]*?--image-editor-prompt-top:\s*526px/);
    expect(stateAwareContract).toMatch(/data-has-result='true'[\s\S]*?--image-editor-control-top:\s*662px/);
    expect(stateAwareContract).toMatch(/generation-control-bar\.has-image-quality[\s\S]*?height:\s*106px\s*!important/);
    const fourPromptRule = stateAwareContract.match(/data-result-count='4'\]\s*\n\) \.module-node__prompt-workspace\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(fourPromptRule).toMatch(/height:\s*136px\s*!important/);
    expect(fourPromptRule).toMatch(/min-height:\s*136px\s*!important/);
    expect(fourPromptRule).toMatch(/max-height:\s*136px\s*!important/);
    const fourPromptEditorRule = stateAwareContract.match(/data-result-count='4'\]\s*\n\) \.module-node__prompt-editor\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(fourPromptEditorRule).toMatch(/height:\s*76px\s*!important/);
    expect(fourPromptEditorRule).toMatch(/max-height:\s*76px\s*!important/);
    expect(fourPromptEditorRule).toMatch(/overflow-y:\s*auto\s*!important/);
  });

  it('keeps a square generation stage above the prompt before the first result', () => {
    const node = createCanvasModuleNode('compact-empty-image-editor', 'image_generation', { x: 0, y: 0 });
    useAppStore.setState({ project: { ...useAppStore.getState().project, nodes: [node], edges: [] } } as never);

    const { container } = render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    const summary = container.querySelector('.module-node__summary--generation');
    expect(summary).toHaveAttribute('data-editor-expanded', 'true');
    expect(summary).toHaveAttribute('data-has-result', 'false');
    expect(container.querySelector('.module-node__generation-editor-preview--empty')).not.toBeNull();
    expect(screen.getByText('图片生成 V2')).toBeInTheDocument();

    const css = readFileSync('apps/renderer/src/styles/canvas-layout.css', 'utf8');
    const contract = css.slice(css.lastIndexOf('STATE-AWARE IMAGE EDITOR LAYOUT'));
    expect(contract).toMatch(/data-has-result='false'[\s\S]*?--image-editor-prompt-top:\s*526px/);
    expect(contract).toMatch(/data-has-result='false'[\s\S]*?--image-editor-control-top:\s*662px/);
    expect(contract).toMatch(/data-has-result='false'[\s\S]*?--image-editor-height:\s*722px/);
    expect(contract).toMatch(/module-node__workbench-header\s*\{[^}]*?left:\s*156px\s*!important/);
    expect(contract).toMatch(/generation-editor-preview--empty[\s\S]*?width:\s*448px[\s\S]*?height:\s*448px/);
    expect(contract).toMatch(/generation-empty-stage[\s\S]*?place-items:\s*center/);
    expect(contract).toMatch(/module-node__prompt-workspace[\s\S]*?height:\s*136px\s*!important/);
    expect(contract).toMatch(/module-node__prompt-editor[\s\S]*?height:\s*76px\s*!important/);
    expect(contract).toMatch(/module-node__prompt-workspace[\s\S]*?border-radius:\s*12px\s+12px\s+0\s+0\s*!important/);
    expect(contract).toMatch(/module-node__generation-control-bar[\s\S]*?border-radius:\s*0\s+0\s+12px\s+12px\s*!important/);
    expect(contract).toMatch(/ports-column--inputs[\s\S]*?left:\s*156px\s*!important/);
    expect(contract).toMatch(/ports-column--outputs[\s\S]*?right:\s*156px\s*!important/);
    const releaseCss = readFileSync('apps/renderer/src/styles/release-layout-contract.css', 'utf8');
    const releaseContract = releaseCss.slice(releaseCss.lastIndexOf('STATE-AWARE IMAGE EDITOR LAYOUT'));
    expect(releaseContract).toMatch(/module-node__workbench-header\s*\{[^}]*?left:\s*156px\s*!important/);
    expect(releaseContract).toMatch(/data-has-result='false'[\s\S]*?--image-editor-control-top:\s*662px/);
    expect(releaseContract).toMatch(/ports-column--inputs[\s\S]*?left:\s*156px\s*!important/);
    const collapsedEmptyContract = css.slice(css.lastIndexOf('COLLAPSED EMPTY IMAGE SQUARE CONTRACT'));
    expect(collapsedEmptyContract).toMatch(/data-editor-expanded='false'\]\[data-has-result='false'\][\s\S]*?width:\s*448px\s*!important[\s\S]*?height:\s*448px\s*!important/);
    expect(collapsedEmptyContract).toMatch(/generation-collapsed-preview[\s\S]*?place-items:\s*center\s*!important/);
    expect(collapsedEmptyContract).toMatch(/ports-column[\s\S]*?top:\s*224px\s*!important/);
    const releaseCollapsedEmptyContract = releaseCss.slice(releaseCss.lastIndexOf('COLLAPSED EMPTY IMAGE SQUARE CONTRACT'));
    expect(releaseCollapsedEmptyContract).toMatch(/data-editor-expanded='false'\]\[data-has-result='false'\][\s\S]*?width:\s*448px\s*!important[\s\S]*?height:\s*448px\s*!important/);
    expect(releaseCollapsedEmptyContract).toMatch(/generation-collapsed-preview[\s\S]*?place-items:\s*center\s*!important/);
    expect(releaseCollapsedEmptyContract).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?generation-empty-stage\[data-generation-state='running'\][\s\S]*?animation:\s*none\s*!important/);
  });

  it('constrains a single result to the compact preview stage without covering the editor', () => {
    const node = createCanvasModuleNode('compact-single-image-editor', 'image_generation', { x: 0, y: 0 });
    node.data.config = { ...node.data.config, resultAssetIds: [projectImage.assetId], resultState: 'fresh' };
    useAppStore.setState({
      projectImages: [projectImage],
      project: { ...useAppStore.getState().project, nodes: [node], edges: [] },
    } as never);

    const { container } = render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    expect(container.querySelector('.module-node__summary--generation')).toHaveAttribute('data-result-count', '1');
    expect(container.querySelector('.module-node__generation-preview-gallery--1')).not.toBeNull();
    expect(screen.getByRole('img', { name: 'Generated image 1' })).toBeInTheDocument();

    const css = readFileSync('apps/renderer/src/styles/canvas-layout.css', 'utf8');
    const contract = css.slice(css.lastIndexOf('STATE-AWARE IMAGE EDITOR LAYOUT'));
    expect(contract).toMatch(/data-has-result='true'[\s\S]*?--image-editor-prompt-top:\s*526px/);
    expect(contract).toMatch(/data-has-result='true'[\s\S]*?--image-editor-control-top:\s*662px/);
    expect(contract).toMatch(/generation-editor-preview[\s\S]*?width:\s*448px[\s\S]*?height:\s*448px/);
    expect(contract).toMatch(/generation-preview-gallery--1[\s\S]*?module-node__generation-preview-item\s*>\s*img[\s\S]*?object-fit:\s*contain/);
  });

  it('reserves a separate row for connected material between a result and the prompt', () => {
    const source = createCanvasModuleNode('compact-result-reference-source', 'image_input', { x: -420, y: 0 });
    source.data.config = { assetId: projectImage.assetId };
    const node = createCanvasModuleNode('compact-result-reference-target', 'image_generation', { x: 0, y: 0 });
    node.data.config = { ...node.data.config, resultAssetIds: [projectImage.assetId], resultState: 'fresh' };
    useAppStore.setState({
      projectImages: [projectImage],
      project: {
        ...useAppStore.getState().project,
        nodes: [source, node],
        edges: [{ id: 'compact-result-reference-edge', source: source.id, sourcePortId: 'image', target: node.id, targetPortId: 'references', order: 0 }],
      },
    } as never);

    const { container } = render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    expect(container.querySelector('.module-node__summary--generation')).toHaveClass('is-reference-connected');
    expect(screen.getByLabelText('Image generation reference slots')).toBeInTheDocument();

    const css = readFileSync('apps/renderer/src/styles/canvas-layout.css', 'utf8');
    const contract = css.slice(css.lastIndexOf('STATE-AWARE IMAGE EDITOR LAYOUT'));
    expect(contract).toMatch(/is-reference-connected[^}]*data-has-result='true'[\s\S]*?--image-editor-reference-top:\s*464px/);
    expect(contract).toMatch(/is-reference-connected[^}]*data-has-result='true'[\s\S]*?--image-editor-prompt-top:\s*526px/);
    expect(contract).toMatch(/is-reference-connected[^}]*data-has-result='true'[\s\S]*?--image-editor-control-top:\s*662px/);
  });

  it('shows both 4D Nano Banana routes with native image sizes and no GPT-only quality control', () => {
    const node = createCanvasModuleNode('4d-nano-banana-ui', 'image_generation', { x: 0, y: 0 });
    const imageConstraints = {
      aspectRatios: ['1:1' as const, '2:3' as const, '3:2' as const, '4:3' as const, '3:4' as const, '16:9' as const, '9:16' as const],
      resolutions: ['1K' as const, '2K' as const, '4K' as const],
      outputCounts: [1 as const],
    };
    const data = {
      ...node.data,
      imageGenerationRoutes: [
        {
          provider: '4dai', modelRoute: '4dai-gemini-3-1-flash-image-preview',
          displayName: 'Nano Banana 2', modelId: 'gemini-3.1-flash-image-preview',
          capabilities: ['image_generation', 'image_edit'], capabilityStatus: 'complete',
          constraints: { image: imageConstraints },
        },
        {
          provider: '4dai', modelRoute: '4dai-gemini-3-pro-image-preview',
          displayName: 'Nano Banana Pro', modelId: 'gemini-3-pro-image-preview',
          capabilities: ['image_generation', 'image_edit'], capabilityStatus: 'complete',
          constraints: { image: imageConstraints },
        },
      ],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    const modelSelect = screen.getByLabelText('Image generation model route');
    expect(within(modelSelect).getByRole('option', { name: 'Nano Banana 2', hidden: true })).toBeInTheDocument();
    expect(within(modelSelect).getByRole('option', { name: 'Nano Banana Pro', hidden: true })).toBeInTheDocument();
    expect(readGenerationParameterOptions('Image generation resolution')).toEqual(['1K', '2K', '4K']);
    expect(screen.queryByRole('button', { name: 'Image generation quality' })).not.toBeInTheDocument();
  });

  it('keeps clarity visible and switches a Nano Banana family to its selected 4K route', async () => {
    const node = createCanvasModuleNode('nano-banana-resolution-family', 'image_generation', { x: 0, y: 0 });
    node.data.config = {
      ...node.data.config,
      prompt: 'Preserve the product and refine the surface',
      modelRoute: 'comfly-nano-banana-2',
      resolution: '1K',
    };
    const runImageGenerationNode = vi.fn(async () => true);
    const routes = [
      {
        provider: 'comfly', modelRoute: 'comfly-nano-banana-2', displayName: 'Nano Banana 2', modelId: 'nano-banana-2',
        capabilities: ['image_generation', 'image_edit'], capabilityStatus: 'complete', constraints: { image: { resolutions: ['1K'] } },
      },
      {
        provider: 'comfly', modelRoute: 'comfly-nano-banana-2-2k', displayName: 'Nano Banana 2', modelId: 'nano-banana-2-2k',
        capabilities: ['image_generation', 'image_edit'], capabilityStatus: 'complete', constraints: { image: { resolutions: ['2K'] } },
      },
      {
        provider: 'comfly', modelRoute: 'comfly-nano-banana-2-4k', displayName: 'Nano Banana 2', modelId: 'nano-banana-2-4k',
        capabilities: ['image_generation', 'image_edit'], capabilityStatus: 'complete', constraints: { image: { resolutions: ['4K'] } },
      },
    ] as const;
    const data = { ...node.data, imageGenerationRoutes: routes } as typeof node.data;
    useAppStore.setState({
      runImageGenerationNode,
      project: { ...useAppStore.getState().project, nodes: [{ ...node, data }], edges: [] },
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    expect(readGenerationParameterOptions('Image generation resolution')).toEqual(['1K', '2K', '4K']);
    chooseGenerationParameterOption('Image generation resolution', '4K');
    fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));

    await waitFor(() => expect(runImageGenerationNode).toHaveBeenCalledWith(node.id, expect.objectContaining({
      modelRoute: 'comfly-nano-banana-2-4k',
      resolution: '4K',
    })));
  });

  it('replaces locally edited image parameters when another project reuses the same node id', async () => {
    const nodeA = createCanvasModuleNode('shared-image-draft-node', 'image_generation', { x: 0, y: 0 });
    nodeA.data.config = {
      ...nodeA.data.config,
      prompt: 'Project A saved prompt',
      modelRoute: 'comfly-gpt-image-2',
      modelDisplayName: 'GPT Image 2',
      aspectRatio: '1:1',
      resolution: '2K',
      imageQuality: 'medium',
      outputCount: 1,
    };
    const imageGenerationRoutes = [{
      provider: 'comfly' as const,
      modelRoute: 'comfly-gpt-image-2',
      displayName: 'GPT Image 2',
      modelId: 'gpt-image-2',
      capabilities: ['image_generation' as const],
    }];
    const dataA = { ...nodeA.data, imageGenerationRoutes } as typeof nodeA.data;
    const draftGenerationNodeConfig = vi.fn(async () => true);
    useAppStore.setState({
      draftGenerationNodeConfig,
      project: { ...useAppStore.getState().project, id: 'draft-project-a', nodes: [{ ...nodeA, data: dataA }], edges: [] },
    } as never);
    const view = render(<ReactFlowProvider><ModuleNodeCard id={nodeA.id} data={dataA} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    fireEvent.change(screen.getByLabelText('Image generation prompt'), { target: { value: 'Unsaved project A prompt' } });
    chooseGenerationParameterOption('Image generation resolution', '4K');
    chooseGenerationParameterOption('Image generation quality', '高');

    const nodeB = createCanvasModuleNode(nodeA.id, 'image_generation', { x: 0, y: 0 });
    nodeB.data.config = {
      ...nodeB.data.config,
      prompt: 'Project B saved prompt',
      modelRoute: 'comfly-gpt-image-2',
      modelDisplayName: 'GPT Image 2',
      aspectRatio: '1:1',
      resolution: '2K',
      imageQuality: 'low',
      outputCount: 1,
    };
    const dataB = { ...nodeB.data, imageGenerationRoutes } as typeof nodeB.data;
    act(() => {
      useAppStore.setState({
        project: { ...useAppStore.getState().project, id: 'draft-project-b', nodes: [{ ...nodeB, data: dataB }], edges: [] },
      });
      view.rerender(<ReactFlowProvider><ModuleNodeCard id={nodeB.id} data={dataB} selected={false} /></ReactFlowProvider>);
    });

    await waitFor(() => expect(screen.getByLabelText('Image generation prompt')).toHaveValue('Project B saved prompt'));
    expect(screen.getByRole('button', { name: 'Image generation resolution' })).toHaveTextContent('2K');
    expect(screen.getByRole('button', { name: 'Image generation quality' })).toHaveTextContent('低');
  });

  it('preserves a saved GPT high-quality draft while its exact same-name route is temporarily absent', async () => {
    const node = createCanvasModuleNode('gpt-image-quality-catalog-refresh', 'image_generation', { x: 0, y: 0 });
    node.data.config = {
      ...node.data.config,
      prompt: 'Keep this high quality draft',
      modelRoute: 'comfly-gpt-image-2-4k',
      modelDisplayName: 'GPT Image 2',
      resolution: '4K',
      imageQuality: 'high',
    };
    const draftGenerationNodeConfig = vi.fn(async () => true);
    const data = {
      ...node.data,
      imageGenerationRoutes: [{
        provider: 'comfly', modelRoute: 'comfly-gpt-image-2', displayName: 'GPT Image 2', modelId: 'gpt-image-2',
        capabilities: ['image_generation'],
      }],
    } as typeof node.data;
    useAppStore.setState({
      draftGenerationNodeConfig,
      project: { ...useAppStore.getState().project, nodes: [{ ...node, data }], edges: [] },
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    expect(screen.getByRole('button', { name: 'Image generation quality' })).toHaveTextContent('高');
    await waitFor(() => expect(draftGenerationNodeConfig).toHaveBeenLastCalledWith(node.id, expect.objectContaining({
      modelRoute: 'comfly-gpt-image-2-4k',
      resolution: '4K',
      imageQuality: 'high',
    })));
  });

  it('drafts video-generation text and parameters before Generate is pressed', async () => {
    const node = createCanvasModuleNode('video-draft-ui', 'video_generation', { x: 0, y: 0 });
    const draftGenerationNodeConfig = vi.fn(async () => true);
    useAppStore.setState({
      draftGenerationNodeConfig,
      project: { ...useAppStore.getState().project, nodes: [node], edges: [] },
    } as never);
    const data = {
      ...node.data,
      videoGenerationRoutes: [{ provider: 'comfly', modelRoute: 'video-route', displayName: 'Video Route', capabilities: ['video_generation'] }],
    } as typeof node.data;
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openVideoGenerationEditor();

    fireEvent.change(screen.getByLabelText('Video preview prompt'), { target: { value: 'Persist this video prompt.' } });

    await waitFor(() => expect(draftGenerationNodeConfig).toHaveBeenLastCalledWith(node.id, expect.objectContaining({
      prompt: 'Persist this video prompt.',
      modelRoute: 'video-route',
      aspectRatio: '16:9',
      resolution: '1080p',
      outputCount: 1,
    })));
  });

  it('replaces a locally edited video prompt when another project reuses the same node id', async () => {
    const nodeA = createCanvasModuleNode('shared-video-draft-node', 'video_generation', { x: 0, y: 0 });
    nodeA.data.config = {
      ...nodeA.data.config,
      prompt: 'Project A video prompt',
      modelRoute: 'video-route',
      aspectRatio: '16:9',
      keyframe: 'auto',
      durationSeconds: 4,
      resolution: '1080p',
      outputCount: 1,
      audioEnabled: true,
    };
    const videoGenerationRoutes = [{
      provider: 'comfly' as const,
      modelRoute: 'video-route',
      displayName: 'Video Route',
      capabilities: ['video_generation' as const],
    }];
    const dataA = { ...nodeA.data, videoGenerationRoutes } as typeof nodeA.data;
    useAppStore.setState({
      draftGenerationNodeConfig: vi.fn(async () => true),
      project: { ...useAppStore.getState().project, id: 'video-draft-project-a', nodes: [{ ...nodeA, data: dataA }], edges: [] },
    } as never);
    const view = render(<ReactFlowProvider><ModuleNodeCard id={nodeA.id} data={dataA} selected={false} /></ReactFlowProvider>);
    openVideoGenerationEditor();
    fireEvent.change(screen.getByLabelText('Video preview prompt'), { target: { value: 'Unsaved project A video prompt' } });

    const nodeB = createCanvasModuleNode(nodeA.id, 'video_generation', { x: 0, y: 0 });
    nodeB.data.config = { ...nodeA.data.config, prompt: 'Project B video prompt' };
    const dataB = { ...nodeB.data, videoGenerationRoutes } as typeof nodeB.data;
    act(() => {
      useAppStore.setState({
        project: { ...useAppStore.getState().project, id: 'video-draft-project-b', nodes: [{ ...nodeB, data: dataB }], edges: [] },
      });
      view.rerender(<ReactFlowProvider><ModuleNodeCard id={nodeB.id} data={dataB} selected={false} /></ReactFlowProvider>);
    });

    await waitFor(() => expect(screen.getByLabelText('Video preview prompt')).toHaveValue('Project B video prompt'));
  });

  it('replaces locally edited reverse-agent fields when another project reuses the same node id', async () => {
    const nodeA = createCanvasModuleNode('shared-reverse-draft-node', 'reverse_agent', { x: 0, y: 0 });
    nodeA.data.config = {
      ...nodeA.data.config,
      modelRoute: 'gemini-reverse',
      role: 'Project A saved role',
      task: 'Project A saved task',
    };
    const reverseAgentRoutes = [{
      provider: 'comfly' as const,
      modelRoute: 'gemini-reverse',
      displayName: 'Gemini Reverse',
      modelId: 'gemini-reverse',
      capabilities: ['reverse_prompt' as const, 'gemini_native' as const],
    }];
    const dataA = { ...nodeA.data, reverseAgentRoutes } as typeof nodeA.data;
    useAppStore.setState({
      draftReverseAgentConfig: vi.fn(async () => true),
      project: { ...useAppStore.getState().project, id: 'reverse-draft-project-a', nodes: [{ ...nodeA, data: dataA }], edges: [] },
    } as never);
    const view = render(<ReactFlowProvider><ModuleNodeCard id={nodeA.id} data={dataA} selected={false} /></ReactFlowProvider>);

    fireEvent.change(screen.getByLabelText('Role positioning'), { target: { value: 'Unsaved project A role' } });
    fireEvent.change(screen.getByLabelText('Analysis task'), { target: { value: 'Unsaved project A task' } });

    const nodeB = createCanvasModuleNode(nodeA.id, 'reverse_agent', { x: 0, y: 0 });
    nodeB.data.config = {
      ...nodeB.data.config,
      modelRoute: 'gemini-reverse',
      role: 'Project B saved role',
      task: 'Project B saved task',
    };
    const dataB = { ...nodeB.data, reverseAgentRoutes } as typeof nodeB.data;
    act(() => {
      useAppStore.setState({
        project: { ...useAppStore.getState().project, id: 'reverse-draft-project-b', nodes: [{ ...nodeB, data: dataB }], edges: [] },
      });
      view.rerender(<ReactFlowProvider><ModuleNodeCard id={nodeB.id} data={dataB} selected={false} /></ReactFlowProvider>);
    });

    await waitFor(() => expect(screen.getByLabelText('Role positioning')).toHaveValue('Project B saved role'));
    expect(screen.getByLabelText('Analysis task')).toHaveValue('Project B saved task');
  });

  it('drops queued reverse-agent draft writes after the owning project changes', async () => {
    const nodeA = createCanvasModuleNode('shared-reverse-write-node', 'reverse_agent', { x: 0, y: 0 });
    nodeA.data.config = {
      ...nodeA.data.config,
      modelRoute: 'gemini-reverse',
      role: 'Project A saved role',
      task: 'Project A saved task',
    };
    const reverseAgentRoutes = [{
      provider: 'comfly' as const,
      modelRoute: 'gemini-reverse',
      displayName: 'Gemini Reverse',
      modelId: 'gemini-reverse',
      capabilities: ['reverse_prompt' as const, 'gemini_native' as const],
    }];
    const dataA = { ...nodeA.data, reverseAgentRoutes } as typeof nodeA.data;
    let releaseInitialWrite!: (saved: boolean) => void;
    const initialWrite = new Promise<boolean>((resolve) => { releaseInitialWrite = resolve; });
    const draftReverseAgentConfig = vi.fn()
      .mockImplementationOnce(() => initialWrite)
      .mockResolvedValue(true);
    useAppStore.setState({
      draftReverseAgentConfig,
      project: { ...useAppStore.getState().project, id: 'reverse-write-project-a', nodes: [{ ...nodeA, data: dataA }], edges: [] },
    } as never);
    const view = render(<ReactFlowProvider><ModuleNodeCard id={nodeA.id} data={dataA} selected={false} /></ReactFlowProvider>);
    await waitFor(() => expect(draftReverseAgentConfig).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Role positioning'), { target: { value: 'Queued project A role' } });
    await act(async () => { await Promise.resolve(); });

    const nodeB = createCanvasModuleNode(nodeA.id, 'reverse_agent', { x: 0, y: 0 });
    nodeB.data.config = {
      ...nodeB.data.config,
      modelRoute: 'gemini-reverse',
      role: 'Project B saved role',
      task: 'Project B saved task',
    };
    const dataB = { ...nodeB.data, reverseAgentRoutes } as typeof nodeB.data;
    act(() => {
      useAppStore.setState({
        project: { ...useAppStore.getState().project, id: 'reverse-write-project-b', nodes: [{ ...nodeB, data: dataB }], edges: [] },
      });
      view.rerender(<ReactFlowProvider><ModuleNodeCard id={nodeB.id} data={dataB} selected={false} /></ReactFlowProvider>);
    });
    await waitFor(() => expect(draftReverseAgentConfig).toHaveBeenCalledWith(nodeB.id, expect.objectContaining({
      role: 'Project B saved role',
      task: 'Project B saved task',
    })));

    await act(async () => {
      releaseInitialWrite(true);
      await initialWrite;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(draftReverseAgentConfig).not.toHaveBeenCalledWith(nodeA.id, expect.objectContaining({
      role: 'Queued project A role',
    }));
  });

  it('replaces a locally edited storyboard draft when another project reuses the same node id', async () => {
    const nodeA = createCanvasModuleNode('shared-storyboard-draft-node', 'storyboard_sheet', { x: 0, y: 0 });
    nodeA.data.config = {
      ...nodeA.data.config,
      modelRoute: 'storyboard-route',
      script: 'Project A saved script',
      shotCount: 4,
    };
    const storyboardRoutes = [{
      provider: 'comfly' as const,
      modelRoute: 'storyboard-route',
      displayName: 'Storyboard Route',
      capabilities: ['chat' as const],
    }];
    const dataA = { ...nodeA.data, storyboardRoutes } as typeof nodeA.data;
    useAppStore.setState({
      project: { ...useAppStore.getState().project, id: 'storyboard-draft-project-a', nodes: [{ ...nodeA, data: dataA }], edges: [] },
    });
    const view = render(<ReactFlowProvider><ModuleNodeCard id={nodeA.id} data={dataA} selected={false} /></ReactFlowProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Open storyboard composer' }));
    fireEvent.change(screen.getByLabelText('Storyboard script'), { target: { value: 'Unsaved project A script' } });

    const nodeB = createCanvasModuleNode(nodeA.id, 'storyboard_sheet', { x: 0, y: 0 });
    nodeB.data.config = {
      ...nodeB.data.config,
      modelRoute: 'storyboard-route',
      script: 'Project B saved script',
      shotCount: 6,
    };
    const dataB = { ...nodeB.data, storyboardRoutes } as typeof nodeB.data;
    act(() => {
      useAppStore.setState({
        project: { ...useAppStore.getState().project, id: 'storyboard-draft-project-b', nodes: [{ ...nodeB, data: dataB }], edges: [] },
      });
      view.rerender(<ReactFlowProvider><ModuleNodeCard id={nodeB.id} data={dataB} selected={false} /></ReactFlowProvider>);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open storyboard composer' }));
    await waitFor(() => expect(screen.getByLabelText('Storyboard script')).toHaveValue('Project B saved script'));
    expect(screen.getByLabelText('Storyboard shot count')).toHaveValue('6');
  });

  it('preserves a saved video route while the provider catalog is empty', async () => {
    const node = createCanvasModuleNode('video-empty-catalog-route', 'video_generation', { x: 0, y: 0 });
    node.data.config = {
      ...node.data.config,
      prompt: 'Keep this saved draft',
      modelRoute: 'saved/video-route',
      aspectRatio: '16:9',
      keyframe: 'auto',
      durationSeconds: 4,
      resolution: '1080p',
      outputCount: 1,
      audioEnabled: true,
    };
    const draftGenerationNodeConfig = vi.fn(async () => true);
    const data = { ...node.data, videoGenerationRoutes: [] } as typeof node.data;
    useAppStore.setState({
      draftGenerationNodeConfig,
      project: { ...useAppStore.getState().project, nodes: [{ ...node, data }], edges: [] },
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openVideoGenerationEditor();

    await waitFor(() => expect(draftGenerationNodeConfig).toHaveBeenLastCalledWith(node.id, expect.objectContaining({
      modelRoute: 'saved/video-route',
      prompt: 'Keep this saved draft',
    })));
    expect(screen.getByRole('button', { name: '生成视频' })).toBeDisabled();
  });

  it('opens a reference-style video model picker with only one visible model control', () => {
    const node = createCanvasModuleNode('video-model-picker', 'video_generation', { x: 0, y: 0 });
    const data = {
      ...node.data,
      videoGenerationRoutes: [
        { provider: 'comfly', modelRoute: 'video-route-a', displayName: 'Seedance 2.5', capabilities: ['video_generation'] },
        { provider: 'relayme', modelRoute: 'video-route-b', displayName: 'MiniMax H3 Max', capabilities: ['video_generation'] },
      ],
    } as typeof node.data;
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openVideoGenerationEditor();

    fireEvent.click(screen.getByRole('button', { name: '打开视频模型列表' }));
    expect(screen.getByRole('listbox', { name: '视频模型' })).toBeVisible();
    expect(screen.getByRole('menuitemradio', { name: /Seedance 2\.5/ })).toBeVisible();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /MiniMax H3 Max/ }));

    expect(screen.getByLabelText('Video preview model')).toHaveValue('video-route-b');
    expect(screen.getByLabelText('Video preview model')).toHaveClass('module-node__video-native-select');
    expect(screen.queryByRole('listbox', { name: '视频模型' })).not.toBeInTheDocument();
  });

  it('shows only the exact video input modes compatible with a connected reference image', async () => {
    const image = createCanvasModuleNode('video-route-reference-image', 'image_input', { x: 0, y: 0 });
    image.data.config = { assetId: projectImage.assetId };
    const node = createCanvasModuleNode('video-route-reference-target', 'video_generation', { x: 420, y: 0 });
    node.data.config = { ...node.data.config, modelRoute: 'relay/video', prompt: 'Animate the product' };
    const runVideoPreviewNode = vi.fn(async () => true);
    const draftGenerationNodeConfig = vi.fn(async () => true);
    const data = {
      ...node.data,
      videoGenerationRoutes: [
        { provider: 'relayme', modelRoute: 'relay/video', displayName: 'Relay video', modelId: 'relay-video', capabilities: ['video_generation'] },
        { provider: 'comfly', modelRoute: 'wan/text', displayName: 'Wan text', modelId: 'wan2.2-t2v-plus', capabilities: ['video_generation'] },
        { provider: 'comfly', modelRoute: 'wan/image', displayName: 'Wan image', modelId: 'wan2.2-i2v-plus', capabilities: ['video_generation'] },
        { provider: 'comfly', modelRoute: 'wan/keyframe', displayName: 'Wan keyframe', modelId: 'wanx2.1-kf2v-plus', capabilities: ['video_generation'] },
        { provider: 'julun', modelRoute: 'julun/seedance', displayName: 'Julun Seedance', modelId: 'seedance-2.0-deal', capabilities: ['video_generation'] },
      ],
    } as typeof node.data;
    useAppStore.setState({
      draftGenerationNodeConfig,
      runVideoPreviewNode,
      project: {
        ...useAppStore.getState().project,
        nodes: [image, { ...node, data }],
        edges: [{ id: 'video-route-reference-edge', source: image.id, sourcePortId: 'image', target: node.id, targetPortId: 'media', order: 0 }],
        assets: [projectImage],
      },
      projectImages: [projectImage],
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openVideoGenerationEditor();
    await waitFor(() => expect(screen.getByLabelText('Video preview model')).toHaveValue('wan/image'));
    fireEvent.click(screen.getByRole('button', { name: '打开视频模型列表' }));
    expect(screen.getByRole('menuitemradio', { name: /Wan image/u })).toBeVisible();
    expect(screen.getByRole('menuitemradio', { name: /Julun Seedance/u })).toBeVisible();
    expect(screen.queryByRole('menuitemradio', { name: /Relay video/u })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitemradio', { name: /Wan text/u })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitemradio', { name: /Wan keyframe/u })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '打开视频模型列表' }));
    fireEvent.click(screen.getByRole('button', { name: '生成视频' }));
    expect(runVideoPreviewNode).toHaveBeenCalledWith(node.id, expect.objectContaining({
      modelRoute: 'wan/image',
      referenceAssetIds: [projectImage.assetId],
    }));
  });

  it('counts config-only video reference mentions when filtering routes', async () => {
    const node = createCanvasModuleNode('video-config-reference-target', 'video_generation', { x: 0, y: 0 });
    node.data.config = {
      ...node.data.config,
      modelRoute: 'relay/video',
      prompt: 'Animate @图片1',
      referenceAssetIds: [projectImage.assetId],
    };
    const data = {
      ...node.data,
      videoGenerationRoutes: [
        { provider: 'relayme', modelRoute: 'relay/video', displayName: 'Relay video', modelId: 'relay-video', capabilities: ['video_generation'] },
        { provider: 'comfly', modelRoute: 'wan/image', displayName: 'Wan image', modelId: 'wan2.2-i2v-plus', capabilities: ['video_generation'] },
      ],
    } as typeof node.data;
    useAppStore.setState({
      project: { ...useAppStore.getState().project, nodes: [{ ...node, data }], edges: [], assets: [projectImage] },
      projectImages: [projectImage],
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openVideoGenerationEditor();
    await waitFor(() => expect(screen.getByLabelText('Video preview model')).toHaveValue('wan/image'));
    fireEvent.click(screen.getByRole('button', { name: '打开视频模型列表' }));
    expect(screen.queryByRole('menuitemradio', { name: /Relay video/u })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: /Wan image/u })).toBeVisible();
  });

  it('clears and disables video generation when a source video is connected', async () => {
    const source = createCanvasModuleNode('video-to-video-source', 'video_input', { x: 0, y: 0 });
    source.data.config = { assetId: projectVideo.assetId };
    const node = createCanvasModuleNode('video-to-video-target', 'video_generation', { x: 420, y: 0 });
    node.data.config = { ...node.data.config, modelRoute: 'veo/text', prompt: 'Transform this clip' };
    const runVideoPreviewNode = vi.fn(async () => true);
    const draftGenerationNodeConfig = vi.fn(async () => true);
    const data = {
      ...node.data,
      videoGenerationRoutes: [{ provider: 'comfly', modelRoute: 'veo/text', displayName: 'Veo', modelId: 'veo3.1', capabilities: ['video_generation'] }],
    } as typeof node.data;
    useAppStore.setState({
      draftGenerationNodeConfig,
      runVideoPreviewNode,
      project: {
        ...useAppStore.getState().project,
        nodes: [source, { ...node, data }],
        edges: [{ id: 'video-to-video-edge', source: source.id, sourcePortId: 'video', target: node.id, targetPortId: 'media', order: 0 }],
        assets: [projectVideo],
      },
      projectVideos: [projectVideo],
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openVideoGenerationEditor();
    expect(screen.getByRole('alert')).toHaveTextContent('当前版本尚无支持视频作为生成输入的模型');
    await waitFor(() => expect(screen.getByLabelText('Video preview model')).toHaveValue(''));
    expect(screen.getByRole('button', { name: '生成视频' })).toBeDisabled();
    await waitFor(() => expect(draftGenerationNodeConfig).toHaveBeenLastCalledWith(node.id, expect.objectContaining({ modelRoute: '' })));
    expect(runVideoPreviewNode).not.toHaveBeenCalled();
  });

  it('labels an empty image model picker as an image model control', () => {
    const node = createCanvasModuleNode('image-empty-model-picker', 'image_generation', { x: 0, y: 0 });
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    expect(screen.getByRole('button', { name: '打开生图模型列表' })).toHaveTextContent('选择图片模型');
  });

  it('does not roll back newer video controls when an older draft snapshot arrives', async () => {
    const node = createCanvasModuleNode('video-stale-control-draft', 'video_generation', { x: 0, y: 0 });
    const routes = [
      { provider: 'comfly', modelRoute: 'video-route-a', displayName: 'Video Route A', capabilities: ['video_generation'] },
      { provider: 'comfly', modelRoute: 'video-route-b', displayName: 'Video Route B', capabilities: ['video_generation'] },
    ] as const;
    const data = {
      ...node.data,
      config: { ...node.data.config, modelRoute: 'video-route-a', durationSeconds: 4, audioEnabled: true },
      videoGenerationRoutes: routes,
    } as typeof node.data;
    const view = render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openVideoGenerationEditor();

    fireEvent.change(screen.getByLabelText('Video preview model'), { target: { value: 'video-route-b' } });
    fireEvent.change(screen.getByLabelText('Video preview duration'), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('Video preview audio'), { target: { value: 'off' } });

    view.rerender(<ReactFlowProvider><ModuleNodeCard id={node.id} data={{
      ...data,
      config: { ...data.config, modelRoute: 'video-route-b', durationSeconds: 8, audioEnabled: false },
    }} selected={false} /></ReactFlowProvider>);
    view.rerender(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    await waitFor(() => expect(screen.getByLabelText('Video preview model')).toHaveValue('video-route-b'));
    expect(screen.getByLabelText('Video preview duration')).toHaveValue('8');
    expect(screen.getByLabelText('Video preview audio')).toHaveValue('off');
  });

  it('shows live seconds and terminal duration for image generation jobs', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T08:00:12.000Z'));
    const node = createCanvasModuleNode('image-timing', 'image_generation', { x: 0, y: 0 });
    useAppStore.setState({
      modelJobs: [{
        id: 'image-running-job',
        kind: 'image',
        promptNodeId: node.id,
        status: 'running',
        startedAt: '2026-08-17T08:00:00.000Z',
      }],
    } as never);

    const { rerender } = render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();
    expect(screen.getByLabelText('Image generation task timing')).toHaveTextContent('生成中 · 12秒');

    useAppStore.setState({
      modelJobs: [{
        id: 'image-completed-job',
        kind: 'image',
        promptNodeId: node.id,
        status: 'completed',
        startedAt: '2026-08-17T08:00:00.000Z',
        completedAt: '2026-08-17T08:00:09.000Z',
      }],
    } as never);
    rerender(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    expect(screen.getByLabelText('Image generation task timing')).toHaveTextContent('成功 · 9秒');
  });

  it('shows the completed result timing instead of a later startup-recovered cancellation', () => {
    const baseNode = createCanvasModuleNode('image-recovered-cancel', 'image_generation', { x: 0, y: 0 });
    const node = {
      ...baseNode,
      data: {
        ...baseNode.data,
        config: { ...baseNode.data.config, resultAssetIds: [projectImage.assetId], resultState: 'fresh' },
        execution: { state: 'completed' as const },
      },
    };
    useAppStore.setState({
      projectImages: [projectImage],
      modelJobs: [
        {
          id: 'completed-image-job',
          kind: 'image',
          promptNodeId: node.id,
          status: 'completed',
          resultAssetId: projectImage.assetId,
          startedAt: '2026-08-19T08:00:00.000Z',
          completedAt: '2026-08-19T08:00:09.000Z',
          updatedAt: '2026-08-19T08:00:09.000Z',
        },
        {
          id: 'startup-recovered-image-job',
          kind: 'image',
          promptNodeId: node.id,
          status: 'cancelled',
          startedAt: '2026-08-19T08:10:00.000Z',
          completedAt: '2026-08-19T09:10:00.000Z',
          updatedAt: '2026-08-19T09:10:00.000Z',
        },
      ],
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    expect(screen.getByLabelText('Image generation task timing')).toHaveTextContent('成功 · 9秒');
    expect(screen.getByLabelText('Image generation task timing')).not.toHaveTextContent('已取消');
  });

  it('does not show an older failure after a newer image generation completed', () => {
    const node = createCanvasModuleNode('image-newer-success', 'image_generation', { x: 0, y: 0 });
    node.data.config = { ...node.data.config, modelRoute: 'image-route' };
    useAppStore.setState({
      modelJobs: [
        {
          id: 'older-failed-image-job',
          kind: 'image',
          modelRoute: 'image-route',
          promptNodeId: node.id,
          status: 'failed',
          error: 'Provider authentication failed with status 401',
          updatedAt: '2026-09-08T06:20:00.000Z',
        },
        {
          id: 'newer-completed-image-job',
          kind: 'image',
          modelRoute: 'image-route',
          promptNodeId: node.id,
          status: 'completed',
          resultAssetId: projectImage.assetId,
          updatedAt: '2026-09-08T06:31:54.000Z',
        },
      ],
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('restarts image timing at zero as soon as a new generation is requested', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T08:00:30.000Z'));
    const node = createCanvasModuleNode('image-timing-restart', 'image_generation', { x: 0, y: 0 });
    const runImageGenerationNode = vi.fn(async () => true);
    useAppStore.setState({
      modelJobs: [{
        id: 'previous-image-job',
        kind: 'image',
        promptNodeId: node.id,
        status: 'completed',
        startedAt: '2026-08-19T07:59:00.000Z',
        completedAt: '2026-08-19T07:59:20.000Z',
      }],
    } as never);
    const data = {
      ...node.data,
      config: { ...node.data.config, prompt: 'Generate a new product image', modelRoute: 'image-route' },
      onGenerateImage: runImageGenerationNode,
      imageGenerationRoutes: [{
        provider: 'comfly', modelRoute: 'image-route', displayName: 'Image Model', modelId: 'image-route', capabilities: ['image_generation'],
      }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();
    expect(screen.getByLabelText('Image generation task timing')).toHaveTextContent('成功 · 20秒');

    fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));

    expect(screen.getByLabelText('Image generation task timing')).toHaveTextContent('生成中 · 0秒');
  });

  it('shows failed duration and reason for video generation jobs', () => {
    const node = createCanvasModuleNode('video-timing', 'video_generation', { x: 0, y: 0 });
    useAppStore.setState({
      modelJobs: [{
        id: 'video-failed-job',
        kind: 'video',
        promptNodeId: node.id,
        status: 'failed',
        startedAt: '2026-08-17T08:00:00.000Z',
        completedAt: '2026-08-17T08:00:08.000Z',
        error: 'timeout while waiting for provider',
      }],
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    openVideoGenerationEditor();

    expect(screen.getByLabelText('Video generation task timing')).toHaveTextContent('失败 · 8秒');
    expect(screen.getByRole('alert')).toHaveTextContent('无法连接模型服务');
  });

  it.each([
    ['image_generation', 'image', 'Image generation task timing'],
    ['video_generation', 'video', 'Video generation task timing'],
  ] as const)('keeps a failed %s provider reason visible while the generation node is collapsed', (moduleType, kind, timingLabel) => {
    const node = createCanvasModuleNode(`collapsed-${kind}-failure`, moduleType, { x: 0, y: 0 });
    node.data.config = { ...node.data.config, modelRoute: `${kind}-route` };
    useAppStore.setState({
      modelJobs: [{
        id: `collapsed-${kind}-failed-job`,
        kind,
        modelRoute: `${kind}-route`,
        promptNodeId: node.id,
        status: 'failed',
        startedAt: '2026-09-07T06:41:38.000Z',
        completedAt: '2026-09-07T06:43:42.000Z',
        error: 'Comfly request failed: Provider network request failed (net::ERR_CONNECTION_CLOSED)',
      }],
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    expect(screen.getByLabelText(timingLabel)).toHaveTextContent('失败 · 124秒');
    expect(screen.getByRole('alert')).toHaveTextContent('无法连接模型服务');
  });

  it('shows persisted reverse task duration after the result survives a rerender', () => {
    const baseNode = createCanvasModuleNode('reverse-timing', 'reverse_agent', { x: 0, y: 0 });
    const node = {
      ...baseNode,
      data: {
        ...baseNode.data,
        config: {
          ...baseNode.data.config,
          modelRoute: 'reverse-route',
          role: '视觉分析师',
          task: '分析构图',
          reverseAgentRunState: 'completed',
          reverseAgentStartedAt: '2026-08-17T08:00:00.000Z',
          reverseAgentCompletedAt: '2026-08-17T08:00:21.000Z',
          reverseAgentResult: { positivePrompt: 'durable result' },
        },
        reverseAgentRoutes: [{
          provider: 'comfly',
          modelRoute: 'reverse-route',
          displayName: 'Reverse',
          modelId: 'reverse-route',
          capabilities: ['reverse_prompt', 'gemini_native'],
        }],
      },
    };

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data as never} selected={false} /></ReactFlowProvider>);

    expect(screen.getByLabelText('Reverse task timing')).toHaveTextContent('成功 · 21秒');
    expect(screen.getByText('durable result')).toBeVisible();
    expect(screen.getByText('durable result')).toBeVisible();
  });

  it('keeps a cancelled reverse rerun cancelled even when an older result is retained', () => {
    const baseNode = createCanvasModuleNode('reverse-cancelled-stale-result', 'reverse_agent', { x: 0, y: 0 });
    const node = {
      ...baseNode,
      data: {
        ...baseNode.data,
        config: {
          ...baseNode.data.config,
          modelRoute: 'reverse-route',
          role: '视觉分析师',
          task: '分析构图',
          reverseAgentRunId: 'reverse-run-cancelled-1',
          reverseAgentRunState: 'cancelled',
          reverseAgentStartedAt: '2026-08-17T08:00:00.000Z',
          reverseAgentCompletedAt: '2026-08-17T08:00:03.000Z',
          reverseAgentResult: { positivePrompt: 'stale earlier result' },
        },
        reverseAgentRoutes: [{
          provider: 'comfly',
          modelRoute: 'reverse-route',
          displayName: 'Reverse',
          modelId: 'reverse-route',
          capabilities: ['reverse_prompt', 'gemini_native'],
        }],
      },
    };

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data as never} selected={false} /></ReactFlowProvider>);

    expect(screen.getByLabelText('Reverse task timing'))
      .toHaveAttribute('data-task-status', 'cancelled');
    expect(screen.getByLabelText('Reverse task timing'))
      .toHaveAttribute('data-task-run-id', 'reverse-run-cancelled-1');
    expect(screen.getByLabelText('Reverse task timing')).toHaveTextContent('已取消 · 3秒');
    expect(screen.queryByText('已完成')).not.toBeInTheDocument();
  });

  it('renders persisted reverse analysis, prompt, constraints, and checklist', () => {
    const baseNode = createCanvasModuleNode('reverse-complete-result', 'reverse_agent', { x: 0, y: 0 });
    const node = {
      ...baseNode,
      data: {
        ...baseNode.data,
        config: {
          ...baseNode.data.config,
          modelRoute: 'reverse-route',
          role: '视觉分析师',
          task: '分析构图',
          reverseAgentRunState: 'completed',
          reverseAgentResult: {
            analysis: 'Keep the centered camera and rim light.',
            keywords: ['centered', 'rim light'],
            positivePrompt: 'Verified product prompt',
            negativeConstraints: ['Do not change the logo'],
            executionChecklist: ['Check product identity'],
          },
        },
        reverseAgentRoutes: [{
          provider: 'comfly',
          modelRoute: 'reverse-route',
          displayName: 'Reverse',
          modelId: 'reverse-route',
          capabilities: ['reverse_prompt', 'gemini_native'],
        }],
      },
    };

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data as never} selected={false} /></ReactFlowProvider>);

    expect(screen.getByText('Verified product prompt')).toBeVisible();
    expect(screen.getByText('Keep the centered camera and rim light.')).toBeVisible();
    expect(screen.getByText('Do not change the logo')).toBeVisible();
    expect(screen.getByText('Check product identity')).toBeVisible();
    expect(document.querySelector('.module-node__agent-form-flow')).not.toBeNull();
    expect(document.querySelector('.module-node__agent-result-scroll')).not.toBeNull();
  });

  it('offers an explicit rerun action after reverse analysis completed', async () => {
    const node = createCanvasModuleNode('reverse-rerun', 'reverse_agent', { x: 0, y: 0 });
    const runReverseAgentNode = vi.fn(async () => ({ positivePrompt: 'Second reverse result' }));
    const data = {
      ...node.data,
      onReversePrompt: runReverseAgentNode,
      config: {
        ...node.data.config,
        modelRoute: 'reverse-route',
        role: '视觉分析师',
        task: '重新分析构图',
        reverseAgentRunState: 'completed',
        reverseAgentResult: { positivePrompt: 'First reverse result' },
      },
      reverseAgentRoutes: [{
        provider: 'comfly', modelRoute: 'reverse-route', displayName: 'Reverse Model', modelId: 'reverse-route', capabilities: ['reverse_prompt', 'gemini_native'],
      }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    const rerun = screen.getByRole('button', { name: 'Start reverse analysis' });
    expect(rerun).toBeEnabled();
    expect(rerun).toHaveTextContent('重新反推');
    fireEvent.click(rerun);
    await waitFor(() => expect(runReverseAgentNode).toHaveBeenCalledTimes(1));
  });

  it('keeps same-named image and reverse models available once per provider', () => {
    const imageNode = createCanvasModuleNode('dedupe-image-routes', 'image_generation', { x: 0, y: 0 });
    const imageData = {
      ...imageNode.data,
      imageGenerationRoutes: [
        { provider: 'comfly', modelRoute: 'comfly/nano-banana-2', displayName: 'Nano Banana 2', capabilities: ['image_generation'] },
        { provider: 'relayme', modelRoute: 'relayme/nano-banana-2', displayName: 'Nano Banana 2', capabilities: ['image_generation'] },
      ],
    } as typeof imageNode.data;
    const { unmount } = render(<ReactFlowProvider><ModuleNodeCard id={imageNode.id} data={imageData} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();
    expect(within(screen.getByLabelText('Image generation model route')).getAllByRole('option', { name: 'Nano Banana 2', hidden: true })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '打开生图模型列表' }));
    const imageMenu = screen.getByRole('listbox', { name: '生图模型' });
    expect(within(imageMenu).getByText('Comfly')).toBeVisible();
    expect(within(imageMenu).getByText('RelayMe')).toBeVisible();
    unmount();

    const reverseNode = createCanvasModuleNode('dedupe-reverse-routes', 'reverse_agent', { x: 0, y: 0 });
    reverseNode.data.config = { modelRoute: 'comfly/gemini', role: '视觉分析师', task: '分析构图' };
    const reverseData = {
      ...reverseNode.data,
      reverseAgentRoutes: [
        { provider: 'comfly', modelRoute: 'comfly/gemini', displayName: 'Gemini 3.1 Pro', capabilities: ['reverse_prompt', 'gemini_native'] },
        { provider: 'relayme', modelRoute: 'relayme/gemini', displayName: 'Gemini 3.1 Pro', capabilities: ['reverse_prompt', 'vision', 'chat'] },
      ],
    } as typeof reverseNode.data;
    render(<ReactFlowProvider><ModuleNodeCard id={reverseNode.id} data={reverseData} selected={false} /></ReactFlowProvider>);
    expect(within(screen.getByLabelText('Agent model route')).getAllByRole('option', { name: 'Gemini 3.1 Pro' })).toHaveLength(2);
  });

  it('preserves same-name fixed-resolution image routes instead of collapsing their 2K and 4K identities', () => {
    const node = createCanvasModuleNode('dedupe-image-family-resolution', 'image_generation', { x: 0, y: 0 });
    const data = {
      ...node.data,
      imageGenerationRoutes: [
        {
          provider: 'comfly', modelRoute: 'comfly-gpt-image-2-2k', displayName: 'GPT Image 2',
          modelId: 'gpt-image-2-2k', capabilities: ['image_generation'], capabilityStatus: 'complete',
          constraints: { image: { resolutions: ['2K'] } },
        },
        {
          provider: 'comfly', modelRoute: 'comfly-gpt-image-2', displayName: 'GPT Image 2',
          modelId: 'gpt-image-2', capabilities: ['image_generation'], capabilityStatus: 'complete',
          constraints: { image: { resolutions: ['2K', '4K'] } },
        },
      ],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    const routeSelect = screen.getByLabelText('Image generation model route');
    expect(within(routeSelect).getAllByRole('option')).toHaveLength(2);
    expect(within(routeSelect).getByRole('option', { name: 'GPT Image 2 · 2K' })).toHaveValue('comfly-gpt-image-2-2k');
    expect(within(routeSelect).getByRole('option', { name: 'GPT Image 2' })).toHaveValue('comfly-gpt-image-2');
    expect(readGenerationParameterOptions('Image generation resolution')).toEqual(['1K', '2K', '4K']);
    expect(screen.getByRole('menuitemradio', { name: '1K' })).toBeDisabled();
  });

  it('keeps the active provider route when duplicate reverse names are supplied', () => {
    const node = createCanvasModuleNode('reverse-comfly-preferred', 'reverse_agent', { x: 0, y: 0 });
    const data = {
      ...node.data,
      reverseAgentRoutes: [
        { provider: 'relayme', modelRoute: 'relayme-gemini', displayName: 'Gemini 3.1 Pro', modelId: 'gemini-3.1-pro', capabilities: ['reverse_prompt', 'vision', 'chat'] },
        { provider: 'comfly', modelRoute: 'comfly-gemini', displayName: 'Gemini 3.1 Pro', modelId: 'gemini-3.1-pro', capabilities: ['reverse_prompt', 'vision', 'chat'] },
      ],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    expect(screen.getByLabelText('Agent model route')).toHaveValue('relayme-gemini');
  });

  it('keeps the missing reverse-model guidance inline without a duplicate settings button', () => {
    const node = createCanvasModuleNode('reverse-no-compatible-route', 'reverse_agent', { x: 0, y: 0 });
    const data = {
      ...node.data,
      reverseAgentRoutes: [],
      onOpenReverseAgentSettings: vi.fn(),
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    expect(screen.getByRole('status')).toHaveTextContent('该账号没有此类模型，请先在设置中切换供应商。');
    expect(screen.queryByRole('button', { name: '打开设置检查连接' })).not.toBeInTheDocument();
  });

  it('replaces a stale reverse route when the active provider catalog changes', async () => {
    const node = createCanvasModuleNode('reverse-stale-route', 'reverse_agent', { x: 0, y: 0 });
    const data = {
      ...node.data,
      config: {
        ...node.data.config,
        modelRoute: 'comfly-old-gemini',
        role: '视觉分析师',
        task: '分析产品画面',
      },
      reverseAgentRoutes: [{
        provider: 'relayme',
        modelRoute: 'relayme-gemini-vision',
        displayName: 'Gemini Vision',
        modelId: 'gemini-vision',
        capabilities: ['reverse_prompt', 'vision', 'chat'],
      }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    await waitFor(() => expect(screen.getByLabelText('Agent model route')).toHaveValue('relayme-gemini-vision'));
  });

  it('edits every reverse result field and persists the complete result on its source node', async () => {
    const node = createCanvasModuleNode('reverse-edit-result', 'reverse_agent', { x: 0, y: 0 });
    node.data.config = {
      modelRoute: 'reverse-route',
      role: 'Visual analyst',
      task: 'Analyze the product image.',
      reverseAgentResult: {
        analysis: 'Original analysis',
        keywords: ['original keyword'],
        positivePrompt: 'Original prompt',
        negativeConstraints: ['Original constraint'],
        executionChecklist: ['Original check'],
      },
    };
    useAppStore.setState((state) => ({ project: { ...state.project, nodes: [node] } }));
    const data = {
      ...node.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'reverse-route', displayName: 'Reverse', modelId: 'reverse-route', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    fireEvent.change(screen.getByLabelText('Reverse analysis'), { target: { value: 'Updated analysis' } });
    fireEvent.change(screen.getByLabelText('Reverse keywords'), { target: { value: 'product, studio light' } });
    fireEvent.change(screen.getByLabelText('Reverse positive prompt'), { target: { value: 'Updated prompt' } });
    fireEvent.change(screen.getByLabelText('Reverse negative constraints'), { target: { value: 'No glare\nNo crop' } });
    fireEvent.change(screen.getByLabelText('Reverse execution checklist'), { target: { value: 'Review form\nLock camera' } });

    await waitFor(() => {
      const source = useAppStore.getState().project.nodes.find((candidate) => candidate.id === node.id);
      expect(source).toMatchObject({
        data: {
          config: {
            reverseAgentResult: {
              analysis: 'Updated analysis',
              keywords: ['product', 'studio light'],
              positivePrompt: 'Updated prompt',
              negativeConstraints: ['No glare', 'No crop'],
              executionChecklist: ['Review form', 'Lock camera'],
            },
          },
        },
      });
    });
  });

  it('renders detailed image and Seedance prompts as selectable result sections', () => {
    const node = createCanvasModuleNode('reverse-selectable-sections', 'reverse_agent', { x: 0, y: 0 });
    node.data.config = {
      modelRoute: 'reverse-route',
      reverseAgentResult: {
        sessionId: 'session-1', nonce: 'nonce-1', knowledgeSnapshotVersion: 'knowledge-1',
        analysis: '完整商业视觉分析', keywords: ['产品', '暖光'], positivePrompt: '基础生图提示词',
        negativeConstraints: ['不要改变产品结构'], executionChecklist: ['检查 Logo'],
        promptLogic: {
          subject: '唯一产品', action: '静止展示', environment: '暖色居家场景', cameraAndComposition: '45 度俯拍',
          lightingAndColor: '午后侧逆光', materialsAndTextures: '针织与玻璃', effectsOrFluids: '轻微热气',
          styleAndQuality: '高级电商摄影', rationale: ['主体到摄影参数'],
        },
        positivePromptZh: '可直接复制的中文生图提示词',
        seedance25: {
          taskType: 'video_edit', rationale: '存在唯一编辑母版。',
          assetBindings: [{ sourceId: '@视频1', target: '唯一编辑母版', adopt: ['运镜'], reject: ['原商品'] }],
          subjectContinuity: ['产品结构不变'],
          stages: [{ label: '阶段一', startState: '静止', mainEvent: '扫光', endState: '扫光离场', carryForward: ['机位连续'] }],
          shots: [{ label: '镜头一', shotSize: '中近景', camera: '固定', movement: '推进', action: '静止', lightingAndEffects: '扫光', transition: '无', audio: '环境声' }],
          audioPlan: ['保留环境声'], parameterLocks: ['保持比例'], promptZh: '编辑@视频1并保持商品不变。', promptEn: 'Edit @video1.',
          negativeConstraints: ['不要新增商品'], capabilityBoundaries: ['不承诺逐帧重合'],
        },
      },
    };
    const data = {
      ...node.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'reverse-route', displayName: 'Reverse', modelId: 'reverse-route', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    expect(screen.getByRole('article', { name: 'Selectable reverse result' })).toBeVisible();
    expect(screen.getByRole('region', { name: '中文生图提示词' })).toHaveTextContent('可直接复制的中文生图提示词');
    expect(screen.getByRole('region', { name: 'Seedance 中文提示词' })).toHaveTextContent('编辑@视频1');
  });

  it('copies the full reverse result document through the textarea fallback and reports success', async () => {
    const node = createCanvasModuleNode('reverse-copy-fallback', 'reverse_agent', { x: 0, y: 0 });
    node.data.config = {
      modelRoute: 'reverse-route',
      reverseAgentResult: {
        analysis: 'Centered composition',
        keywords: ['product', 'studio'],
        positivePrompt: 'Hero product image',
        negativeConstraints: ['No text'],
        executionChecklist: ['Confirm identity'],
      },
    };
    const data = {
      ...node.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'reverse-route', displayName: 'Reverse', modelId: 'reverse-route', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;
    const writeText = vi.fn(async () => { throw new Error('Clipboard denied'); });
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand');
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });

    try {
      render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
      fireEvent.click(screen.getByRole('button', { name: 'Copy reverse result' }));

      const documentText = '分析\nCentered composition\n\n关键词\nproduct · studio\n\n反推正向提示词\nHero product image\n\n负面约束\n- No text\n\n执行检查清单\n1. Confirm identity';
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(documentText));
      await waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'));
      expect(screen.getByRole('status')).toHaveTextContent('复制成功');
      expect(screen.getByRole('status')).toHaveClass('visually-hidden');
      expect(screen.getByRole('button', { name: 'Copy reverse result' })).toHaveTextContent('复制成功');
    } finally {
      if (originalExecCommand === undefined) delete (document as { execCommand?: unknown }).execCommand;
      else Object.defineProperty(document, 'execCommand', originalExecCommand);
    }
  });

  it('reports failure when neither reverse-result copy route succeeds', async () => {
    const node = createCanvasModuleNode('reverse-copy-failure', 'reverse_agent', { x: 0, y: 0 });
    node.data.config = { modelRoute: 'reverse-route', reverseAgentResult: { positivePrompt: 'Prompt to copy' } };
    const data = {
      ...node.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'reverse-route', displayName: 'Reverse', modelId: 'reverse-route', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;
    const writeText = vi.fn(async () => { throw new Error('Clipboard denied'); });
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand');
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => false) });

    try {
      render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
      fireEvent.click(screen.getByRole('button', { name: 'Copy reverse result' }));

      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('复制失败'));
    } finally {
      if (originalExecCommand === undefined) delete (document as { execCommand?: unknown }).execCommand;
      else Object.defineProperty(document, 'execCommand', originalExecCommand);
    }
  });

  it('trims persisted reverse constraints and checklist items before rendering', () => {
    const baseNode = createCanvasModuleNode('reverse-trimmed-result', 'reverse_agent', { x: 0, y: 0 });
    const node = {
      ...baseNode,
      data: {
        ...baseNode.data,
        config: {
          ...baseNode.data.config,
          modelRoute: 'reverse-route',
          role: '视觉分析师',
          task: '分析构图',
          reverseAgentRunState: 'completed',
          reverseAgentResult: {
            positivePrompt: 'Verified product prompt',
            negativeConstraints: ['  Do not change the logo  ', '   ', '\n'],
            executionChecklist: [' Check product identity ', '', '  '],
          },
        },
        reverseAgentRoutes: [{
          provider: 'comfly',
          modelRoute: 'reverse-route',
          displayName: 'Reverse',
          modelId: 'reverse-route',
          capabilities: ['reverse_prompt', 'gemini_native'],
        }],
      },
    };

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data as never} selected={false} /></ReactFlowProvider>);

    expect(screen.getByLabelText('Reverse negative constraints')).toHaveValue('Do not change the logo');
    expect(screen.getByLabelText('Reverse execution checklist')).toHaveValue('Check product identity');
  });

  it('renders persisted reverse errors beside failed task timing', () => {
    const baseNode = createCanvasModuleNode('reverse-failed-result', 'reverse_agent', { x: 0, y: 0 });
    const node = {
      ...baseNode,
      data: {
        ...baseNode.data,
        config: {
          ...baseNode.data.config,
          modelRoute: 'reverse-route',
          role: '视觉分析师',
          task: '分析构图',
          reverseAgentRunState: 'failed',
          reverseAgentStartedAt: '2026-08-17T08:00:00.000Z',
          reverseAgentCompletedAt: '2026-08-17T08:00:12.000Z',
          reverseAgentError: '反推请求超时，请稍后重试。',
        },
        reverseAgentRoutes: [{
          provider: 'comfly',
          modelRoute: 'reverse-route',
          displayName: 'Reverse',
          modelId: 'reverse-route',
          capabilities: ['reverse_prompt', 'gemini_native'],
        }],
      },
    };

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data as never} selected={false} /></ReactFlowProvider>);

    expect(screen.getByRole('alert')).toHaveTextContent('反推请求超时，请稍后重试。');
    expect(screen.getByLabelText('Reverse task timing')).toHaveTextContent('失败 · 12秒');
  });

  it('marks image, video, and reverse workflows with isolated Canvas surface contracts', () => {
    const image = createCanvasModuleNode('image-minimal', 'image_input', { x: 0, y: 0 });
    const generation = createCanvasModuleNode('generation-minimal', 'image_generation', { x: 0, y: 0 });
    const video = createCanvasModuleNode('video-minimal', 'video_generation', { x: 0, y: 0 });
    const reverse = createCanvasModuleNode('reverse-minimal', 'reverse_agent', { x: 0, y: 0 });
    const { rerender } = render(<ReactFlowProvider><ModuleNodeCard id={image.id} data={image.data} selected={false} /></ReactFlowProvider>);
    expect(screen.getByTestId('module-node-card')).toHaveClass('module-node--foundation');
    expect(screen.getByTestId('module-node-card')).not.toHaveClass('module-node--minimal-media');

    rerender(<ReactFlowProvider><ModuleNodeCard id={generation.id} data={generation.data} selected={false} /></ReactFlowProvider>);
    expect(screen.getByTestId('module-node-card')).toHaveClass('module-node--image-generation');
    expect(screen.getByTestId('module-node-card')).not.toHaveClass('module-node--workbench');
    expect(screen.getByTestId('module-node-card')).not.toHaveClass('module-node--minimal-generation');
    expect(screen.getByRole('button', { name: 'Open image generation editor' })).toBeVisible();
    expect(screen.queryByLabelText('Image generation prompt workspace')).not.toBeInTheDocument();

    rerender(<ReactFlowProvider><ModuleNodeCard id={video.id} data={video.data} selected={false} /></ReactFlowProvider>);
    expect(screen.getByTestId('module-node-card')).toHaveClass('module-node--video-generation');
    expect(screen.getByTestId('module-node-card')).not.toHaveClass('module-node--workbench');

    rerender(<ReactFlowProvider><ModuleNodeCard id={reverse.id} data={reverse.data} selected={false} /></ReactFlowProvider>);
    expect(screen.getByTestId('module-node-card')).toHaveClass('module-node--reverse');
    expect(screen.getByTestId('module-node-card')).not.toHaveClass('module-node--minimal-agent');
    expect(screen.getByLabelText('Agent task configuration')).toBeVisible();
  });

  it('offers an explicit reversible position lock control without coupling it to execution state', () => {
    const baseNode = createCanvasModuleNode('reverse', 'reverse_agent', { x: 0, y: 0 });
    const node = { ...baseNode, data: { ...baseNode.data, execution: { state: 'running' as const } } };
    const toggleNodeLock = vi.fn(async () => true);
    useAppStore.setState({ toggleNodeLock });

    const { rerender } = render(
      <ReactFlowProvider>
        <ModuleNodeCard id={node.id} data={{ ...node.data, locked: false }} selected={false} />
      </ReactFlowProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: '锁定位置 / Lock position' }));
    expect(toggleNodeLock).toHaveBeenCalledWith('reverse');

    rerender(
      <ReactFlowProvider>
        <ModuleNodeCard id={node.id} data={{ ...node.data, locked: true }} selected={false} />
      </ReactFlowProvider>,
    );
    expect(screen.getByRole('button', { name: '解锁位置 / Unlock position' })).toBeVisible();
    expect(screen.getByText('运行中')).toBeVisible();
  });

  it('renders stable typed handles from the registry', () => {
    const node = createCanvasModuleNode('generator', 'image_generation', { x: 0, y: 0 });

    const data = {
      ...node.data,
      imageGenerationRoutes: [{
        provider: 'comfly',
        modelRoute: 'image-gen',
        displayName: 'Image Gen',
        modelId: 'image-gen',
        capabilities: ['image_generation', 'image_edit'],
      }],
    } as typeof node.data;

    render(
      <ReactFlowProvider>
        <ModuleNodeCard id={node.id} data={data} selected={false} />
      </ReactFlowProvider>,
    );

    expect(screen.getAllByText('图片生成')[0]).toBeVisible();
    expect(screen.getByText('Image Generation')).toBeVisible();
    expect(document.querySelectorAll('[data-module-type="image_generation"] [data-port-direction="input"] .react-flow__handle')).toHaveLength(1);
    expect(document.querySelector('[data-port-id="references"][data-port-direction="input"]')).not.toBeNull();
    expect(document.querySelector('[data-port-id="prompt"][data-port-direction="input"]')).toBeNull();
    expect(document.querySelector('[data-port-id="result"][data-port-direction="output"]')).not.toBeNull();
    expect(screen.getByTitle('参考图 / References')).toBeVisible();
    expect(screen.queryByText('References')).not.toBeInTheDocument();
    expect(screen.getByTitle('参考图 / References')).toHaveTextContent('参考图');
    expect(screen.getByText('结果')).toBeVisible();
    expect(screen.getByText('空闲')).toBeVisible();
    expect(screen.queryByText('能力')).not.toBeInTheDocument();
    expect(document.querySelector('.module-node__summary')).not.toHaveStyle({ overflow: 'auto' });
    expect(document.querySelector('.module-node__icon')).toHaveAttribute('data-icon-category', 'generation');
    expect(document.querySelector('.module-node__icon svg')).toHaveAttribute('width', '18');
  });

  it('uses the Canvas two-endpoint contract for generation nodes', () => {
    const node = createCanvasModuleNode('generator-round-ports', 'image_generation', { x: 0, y: 0 });

    render(
      <ReactFlowProvider>
        <ModuleNodeCard id={node.id} data={node.data} selected={false} />
      </ReactFlowProvider>,
    );

    const handles = [...document.querySelectorAll('.react-flow__handle[data-port-id]')];
    expect(handles).toHaveLength(2);
    expect(handles.every((port) => port.getAttribute('data-port-shape') === 'circle')).toBe(true);
  });

  it('shows the Canvas video workflow as one visible media input and one visible result output', () => {
    const node = createCanvasModuleNode('video-single-flow', 'video_generation', { x: 0, y: 0 });

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    expect(document.querySelectorAll('[data-module-type="video_generation"] [data-port-direction="input"] .react-flow__handle')).toHaveLength(1);
    expect(document.querySelector('[data-module-type="video_generation"] [data-port-id="media"] .react-flow__handle')).not.toBeNull();
    expect(document.querySelectorAll('[data-module-type="video_generation"] [data-port-direction="output"] .react-flow__handle')).toHaveLength(1);
  });

  it('shows the Canvas reverse workflow as one visible media input and one visible analysis output', () => {
    const node = createCanvasModuleNode('reverse-single-flow', 'reverse_agent', { x: 0, y: 0 });

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    expect(document.querySelectorAll('[data-module-type="reverse_agent"] [data-port-direction="input"] .react-flow__handle')).toHaveLength(1);
    expect(document.querySelector('[data-module-type="reverse_agent"] [data-port-id="references"] .react-flow__handle')).not.toBeNull();
    expect(document.querySelectorAll('[data-module-type="reverse_agent"] [data-port-direction="output"] .react-flow__handle')).toHaveLength(1);
    expect(document.querySelector('[data-module-type="reverse_agent"] [data-port-id="analysis"] .react-flow__handle')).not.toBeNull();
  });

  it('keeps the Canvas reverse empty-media rail visible without presenting an unconnected image', () => {
    const node = createCanvasModuleNode('reverse-empty-media-rail', 'reverse_agent', { x: 0, y: 0 });

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    const rail = screen.getByLabelText('Reverse media workspace');
    expect(rail).toHaveClass('module-node__agent-media-empty-hint');
    expect(rail).toHaveTextContent('未连接素材');
    expect(rail.querySelector('img')).toBeNull();
    expect(within(rail).queryByRole('button', { name: '添加反推素材' })).not.toBeInTheDocument();
  });

  it('keeps the Canvas reverse empty-media rail visible until a durable input edge supplies content', () => {
    const node = createCanvasModuleNode('reverse-empty-media', 'reverse_agent', { x: 0, y: 0 });

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    expect(screen.queryByLabelText('Connected reverse media slots')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Reverse media workspace')).toHaveClass('module-node__agent-media-empty-hint');
    // Canvas 408:2 keeps an empty input rail visible while the actual media
    // tray remains absent until a durable edge supplies media.
    expect(screen.getByLabelText('Reverse media input')).toHaveClass('module-node__agent-media-label');
    expect(screen.getByLabelText('Reverse media input')).toHaveTextContent('0 / 20');
  });

  it('renders the reverse media tray from a connected image edge rather than legacy node presentation config', () => {
    const image = createCanvasModuleNode('reverse-edge-image', 'image_input', { x: 0, y: 0 });
    image.data.config = { assetId: projectImage.assetId };
    const reverse = createCanvasModuleNode('reverse-edge-target', 'reverse_agent', { x: 420, y: 0 });
    useAppStore.setState({
      project: {
        ...useAppStore.getState().project,
        nodes: [image, reverse],
        edges: [{ id: 'reverse-edge', source: image.id, sourcePortId: 'image', target: reverse.id, targetPortId: 'references', order: 0 }],
        assets: [{
          assetId: projectImage.assetId,
          sha256: projectImage.sha256,
          byteSize: projectImage.byteSize,
          extension: projectImage.extension,
          height: projectImage.height,
          label: projectImage.label,
          mediaType: projectImage.mediaType,
          origin: projectImage.origin,
          width: projectImage.width,
        }],
      },
      projectImages: [projectImage],
    });
    const data = {
      ...reverse.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'reverse-gemini', displayName: 'Reverse Gemini', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof reverse.data;

    render(<ReactFlowProvider><ModuleNodeCard id={reverse.id} data={data} selected={false} /></ReactFlowProvider>);

    expect(screen.getByLabelText('Reverse media workspace')).toContainElement(screen.getByLabelText('Connected reverse media slots'));
    expect(screen.getByRole('img', { name: projectImage.label })).toBeVisible();
    expect(screen.getByLabelText('Reverse media input')).toHaveTextContent('1 / 20');
    expect(screen.getByLabelText('Reverse media input')).toHaveTextContent('素材输入');
  });

  it('reorders mixed reverse Agent image and video slots by their durable edge ids', () => {
    const image = createCanvasModuleNode('reverse-reorder-image', 'image_input', { x: 0, y: 0 });
    image.data.config = { assetId: projectImage.assetId };
    const firstVideo = createCanvasModuleNode('reverse-reorder-video-a', 'video_input', { x: 0, y: 120 });
    firstVideo.data.config = { assetId: projectVideo.assetId };
    const secondVideoAsset = {
      ...projectVideo,
      assetId: 'aaaaaaaaaaaaaaaa',
      sha256: 'a'.repeat(64),
      displayUrl: 'novus-asset://project/session/aaaaaaaaaaaaaaaa',
      label: 'Second product turntable',
      durationMs: 3200,
      height: 1080,
      width: 1920,
    };
    const firstVideoAsset = { ...projectVideo, durationMs: 2400, height: 1080, width: 1920 };
    const secondVideo = createCanvasModuleNode('reverse-reorder-video-b', 'video_input', { x: 0, y: 240 });
    secondVideo.data.config = { assetId: secondVideoAsset.assetId };
    const reverse = createCanvasModuleNode('reverse-reorder-target', 'reverse_agent', { x: 420, y: 0 });
    const reorderModuleInput = vi.fn(async () => true);
    useAppStore.setState({
      project: {
        ...useAppStore.getState().project,
        nodes: [image, firstVideo, secondVideo, reverse],
        edges: [
          { id: 'edge-image', source: image.id, sourcePortId: 'image', target: reverse.id, targetPortId: 'references', order: 0 },
          { id: 'edge-video-a', source: firstVideo.id, sourcePortId: 'video', target: reverse.id, targetPortId: 'references', order: 1 },
          { id: 'edge-video-b', source: secondVideo.id, sourcePortId: 'video', target: reverse.id, targetPortId: 'references', order: 2 },
        ],
      },
      projectImages: [projectImage],
      projectVideos: [firstVideoAsset, secondVideoAsset],
      reorderModuleInput,
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={reverse.id} data={reverse.data} selected={false} /></ReactFlowProvider>);

    expect(screen.getByText('3 / 20')).toBeVisible();
    expect(screen.getByLabelText('Product turntable 视频封面')).toBeVisible();
    fireEvent.dragStart(screen.getByLabelText('Agent media slot 3'));
    fireEvent.dragOver(screen.getByLabelText('Agent media slot 1'));
    fireEvent.drop(screen.getByLabelText('Agent media slot 1'));

    expect(reorderModuleInput).toHaveBeenCalledWith(reverse.id, 'references', [
      'edge-video-b',
      'edge-image',
      'edge-video-a',
    ]);
  });

  it('reloads a conflicted durable project and retries the requested slot order once', async () => {
    const image = createCanvasModuleNode('conflict-reorder-image', 'image_input', { x: 0, y: 0 });
    image.data.config = { assetId: projectImage.assetId };
    const video = createCanvasModuleNode('conflict-reorder-video', 'video_input', { x: 0, y: 120 });
    video.data.config = { assetId: projectVideo.assetId };
    const reverse = createCanvasModuleNode('conflict-reorder-target', 'reverse_agent', { x: 420, y: 0 });
    const reorderModuleInput = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const reloadDurableProject = vi.fn(async () => true);
    useAppStore.setState({
      project: {
        ...useAppStore.getState().project,
        nodes: [image, video, reverse],
        edges: [
          { id: 'conflict-edge-image', source: image.id, sourcePortId: 'image', target: reverse.id, targetPortId: 'references', order: 0 },
          { id: 'conflict-edge-video', source: video.id, sourcePortId: 'video', target: reverse.id, targetPortId: 'references', order: 1 },
        ],
      },
      projectImages: [projectImage],
      projectVideos: [{ ...projectVideo, durationMs: 2400, height: 1080, width: 1920 }],
      canReloadDurableProject: true,
      reorderModuleInput,
      reloadDurableProject,
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={reverse.id} data={reverse.data} selected={false} /></ReactFlowProvider>);
    fireEvent.dragStart(screen.getByLabelText('Agent media slot 2'));
    fireEvent.drop(screen.getByLabelText('Agent media slot 1'));

    await waitFor(() => expect(reloadDurableProject).toHaveBeenCalledTimes(1));
    expect(reorderModuleInput).toHaveBeenNthCalledWith(1, reverse.id, 'references', [
      'conflict-edge-video',
      'conflict-edge-image',
    ]);
    expect(reorderModuleInput).toHaveBeenNthCalledWith(2, reverse.id, 'references', [
      'conflict-edge-video',
      'conflict-edge-image',
    ]);
  });
  it('keeps the image slot inside the expanded editor even before media is connected', () => {
    const node = createCanvasModuleNode('image-empty-media', 'image_generation', { x: 0, y: 0 });

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    expect(screen.queryByRole('button', { name: 'Reference slot 1 empty' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add image reference' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Image generation prompt workspace')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Image generation reference slots')).not.toBeInTheDocument();
    openImageGenerationEditor();
    expect(screen.getByLabelText('Image generation prompt workspace').closest('.module-node__summary')).toHaveClass('is-reference-empty');
    expect(screen.getByLabelText('Image generation reference slots')).toHaveTextContent('0 / 20');
    expect(screen.getByLabelText('Image generation reference slot pending')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate image' })).toHaveTextContent('生成');
  });

  it('hides the empty image slot again when the editor is collapsed', () => {
    const node = createCanvasModuleNode('image-empty-reference-summary', 'image_generation', { x: 0, y: 0 });

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    expect(screen.queryByLabelText('Image generation reference slots')).not.toBeInTheDocument();
    openImageGenerationEditor();
    expect(screen.getByLabelText('Image generation reference slots')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '折叠图片生成节点' }));
    expect(screen.queryByLabelText('Image generation reference slots')).not.toBeInTheDocument();
  });

  it('shows a video reference slot only when the media port has a managed image connection', () => {
    const image = createCanvasModuleNode('video-slot-image', 'image_input', { x: 0, y: 0 });
    image.data.config = { assetId: projectImage.assetId };
    const video = createCanvasModuleNode('video-slot-target', 'video_generation', { x: 420, y: 0 });
    useAppStore.setState({
      project: {
        ...useAppStore.getState().project,
        nodes: [image, video],
        edges: [{ id: 'video-slot-edge', source: image.id, sourcePortId: 'image', target: video.id, targetPortId: 'media', order: 0 }],
        assets: [{
          assetId: projectImage.assetId,
          sha256: projectImage.sha256,
          byteSize: projectImage.byteSize,
          extension: projectImage.extension,
          height: projectImage.height,
          label: projectImage.label,
          mediaType: projectImage.mediaType,
          origin: projectImage.origin,
          width: projectImage.width,
        }],
      },
      projectImages: [projectImage],
    });

    render(<ReactFlowProvider><ModuleNodeCard id={video.id} data={video.data} selected={false} /></ReactFlowProvider>);
    expect(within(screen.getByLabelText('Connected video media')).getByRole('img', { name: projectImage.label })).toHaveAttribute('src', projectImage.displayUrl);
    expect(screen.getByLabelText('Connected video media')).toHaveTextContent('素材输入');


    fireEvent.click(screen.getByRole('button', { name: 'Open video generation editor' }));
    expect(screen.getByLabelText('Connected video media editor')).toBeVisible();
    expect(within(screen.getByLabelText('Connected video media editor')).getByRole('img', { name: projectImage.label })).toHaveAttribute('src', projectImage.displayUrl);
    expect(screen.queryByRole('button', { name: 'Add image reference' })).not.toBeInTheDocument();
  });

  it('renders a connected video asset as the real video cover inside the video-generation slot', () => {
    const source = createCanvasModuleNode('video-slot-source', 'video_input', { x: 0, y: 0 });
    source.data.config = { assetId: projectVideo.assetId };
    const target = createCanvasModuleNode('video-slot-video-target', 'video_generation', { x: 420, y: 0 });
    useAppStore.setState({
      project: {
        ...useAppStore.getState().project,
        nodes: [source, target],
        edges: [{ id: 'video-slot-video-edge', source: source.id, sourcePortId: 'video', target: target.id, targetPortId: 'media', order: 0 }],
        assets: [{
          assetId: projectVideo.assetId,
          sha256: projectVideo.sha256,
          byteSize: projectVideo.byteSize,
          extension: projectVideo.extension,
          height: projectVideo.height,
          durationMs: projectVideo.durationMs,
          label: projectVideo.label,
          mediaType: projectVideo.mediaType,
          origin: projectVideo.origin,
          width: projectVideo.width,
        }],
      },
      projectVideos: [projectVideo],
    });

    render(<ReactFlowProvider><ModuleNodeCard id={target.id} data={target.data} selected={false} /></ReactFlowProvider>);
    const collapsedVideo = screen.getByLabelText('Connected video media').querySelector('video');
    expect(collapsedVideo).not.toBeNull();
    expect(collapsedVideo).toHaveAttribute('src', projectVideo.displayUrl);

    fireEvent.click(screen.getByRole('button', { name: 'Open video generation editor' }));
    const connectedVideo = screen.getByLabelText('Connected video media editor').querySelector('video');
    expect(connectedVideo).not.toBeNull();
    expect(connectedVideo).toHaveAttribute('src', projectVideo.displayUrl);
  });

  it('uses one universal ordered thumbnail tray for mixed image and video inputs on image generation', () => {
    const image = createCanvasModuleNode('universal-image-source', 'image_input', { x: 0, y: 0 });
    image.data.config = { assetId: projectImage.assetId };
    const video = createCanvasModuleNode('universal-video-source', 'video_input', { x: 0, y: 120 });
    video.data.config = { assetId: projectVideo.assetId };
    const generation = createCanvasModuleNode('universal-image-generation', 'image_generation', { x: 420, y: 0 });
    const reorderModuleInput = vi.fn(async () => true);
    useAppStore.setState({
      project: {
        ...useAppStore.getState().project,
        nodes: [image, video, generation],
        edges: [
          { id: 'universal-video-edge', source: video.id, sourcePortId: 'video', target: generation.id, targetPortId: 'references', order: 10 },
          { id: 'universal-image-edge', source: image.id, sourcePortId: 'image', target: generation.id, targetPortId: 'references', order: 20 },
        ],
      },
      projectImages: [projectImage],
      projectVideos: [projectVideo],
      reorderModuleInput,
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={generation.id} data={generation.data} selected={false} /></ReactFlowProvider>);

    expect(screen.queryByLabelText('Image generation reference slots')).toBeNull();

    openImageGenerationEditor();
    const expandedTray = screen.getByLabelText('Image generation reference slots');
    expect(expandedTray.querySelector('video')).toHaveAttribute('src', projectVideo.displayUrl);
    expect(within(expandedTray).getByRole('img', { name: projectImage.label })).toHaveAttribute('src', projectImage.displayUrl);
    expect(expandedTray).toHaveTextContent('2 / 20');
    expect(expandedTray).toHaveClass('connected-agent-media-slots');
    fireEvent.click(within(expandedTray).getByRole('button', { name: `Move ${projectImage.label} left` }));
    expect(reorderModuleInput).toHaveBeenCalledWith(generation.id, 'references', [
      'universal-image-edge',
      'universal-video-edge',
    ]);
    const prompt = screen.getByLabelText('Image generation prompt workspace');
    expect(expandedTray.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('places the expanded video universal media tray before its prompt workspace', () => {
    const source = createCanvasModuleNode('video-order-source', 'video_input', { x: 0, y: 0 });
    source.data.config = { assetId: projectVideo.assetId };
    const target = createCanvasModuleNode('video-order-target', 'video_generation', { x: 420, y: 0 });
    useAppStore.setState({
      project: {
        ...useAppStore.getState().project,
        nodes: [source, target],
        edges: [{ id: 'video-order-edge', source: source.id, sourcePortId: 'video', target: target.id, targetPortId: 'media', order: 0 }],
      },
      projectVideos: [projectVideo],
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={target.id} data={target.data} selected={false} /></ReactFlowProvider>);
    openVideoGenerationEditor();

    const tray = screen.getByLabelText('Connected video media editor');
    const prompt = screen.getByLabelText('Video preview prompt workspace');
    expect(tray.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('locks the expanded universal thumbnail row between preview and prompt for both generation nodes', () => {
    const css = [
      readFileSync('apps/renderer/src/styles/canvas-layout.css', 'utf8'),
      readFileSync('apps/renderer/src/styles/release-layout-contract.css', 'utf8'),
    ].join('\n');
    const finalLayout = css.slice(css.lastIndexOf('Final expanded universal media row layout'));

    expect(finalLayout).toMatch(/module-node__unified-media-slots[\s\S]*?top:\s*488px[\s\S]*?height:\s*54px/);
    expect(finalLayout).toMatch(/module-node__prompt-workspace[\s\S]*?top:\s*558px/);
    expect(finalLayout).toMatch(/module-node__(?:generation-control-bar|video-control-bar)[\s\S]*?bottom:\s*18px/);
    expect(finalLayout).toMatch(/Video preview duration'[\s\S]*?display:\s*flex !important[\s\S]*?grid-column:\s*4 !important/);
    expect(finalLayout).toMatch(/Video preview mode'[\s\S]*?display:\s*none !important/);
    expect(finalLayout).toMatch(/height:\s*830px[\s\S]*?min-height:\s*830px/);
    expect(finalLayout).toMatch(/generation-preview-gallery--3[\s\S]*?generation-preview-item:first-child[\s\S]*?grid-row:\s*span 2/);
    expect(finalLayout).toMatch(/generation-preview-gallery--2\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)[\s\S]*?grid-template-rows:\s*minmax\(0,\s*1fr\)/);
    expect(finalLayout).toMatch(/generation-preview-gallery--4\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)[\s\S]*?grid-template-rows:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    expect(finalLayout).toMatch(/generation-preview-gallery--collapsed[\s\S]*?generation-preview-item\s*>\s*:is\(img,\s*video\)[\s\S]*?object-fit:\s*cover/);
  });
  it.each([
    ['image_generation', 'Open image generation editor'],
    ['video_generation', 'Open video generation editor'],
  ] as const)('expands %s on preview click and collapses it from the node control', (moduleType, accessibleName) => {
    const node = createCanvasModuleNode(`generation-collapse-${moduleType}`, moduleType, { x: 0, y: 0 });
    const { container } = render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    const summary = container.querySelector<HTMLElement>('[data-editor-expanded]');
    const opener = screen.getByRole('button', { name: accessibleName });

    expect(summary).toHaveAttribute('data-editor-expanded', 'false');
    expect(opener).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText(moduleType === 'image_generation' ? 'Image generation prompt workspace' : 'Video preview prompt workspace')).not.toBeInTheDocument();

    fireEvent.click(opener);
    expect(summary).toHaveAttribute('data-editor-expanded', 'true');
    expect(screen.queryByRole('button', { name: accessibleName })).not.toBeInTheDocument();
    if (moduleType === 'image_generation') {
      expect(screen.getByLabelText('Image generation preview')).toBeVisible();
      expect(screen.getByText('图片生成 V2')).toBeVisible();
    } else {
      expect(screen.queryByLabelText('Video generation preview')).not.toBeInTheDocument();
    }
    expect(screen.getByLabelText(moduleType === 'image_generation' ? 'Image generation prompt workspace' : 'Video preview prompt workspace')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: moduleType === 'image_generation' ? '折叠图片生成节点' : '折叠视频生成节点' }));
    expect(summary).toHaveAttribute('data-editor-expanded', 'false');
    expect(opener).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText(moduleType === 'image_generation' ? 'Image generation prompt workspace' : 'Video preview prompt workspace')).not.toBeInTheDocument();
  });

  it.each([
    ['image_generation', 'Open image generation editor', 'Image generation prompt workspace'],
    ['video_generation', 'Open video generation editor', 'Video preview prompt workspace'],
  ] as const)('moves collapsed %s previews without treating the drag release as a click', (moduleType, accessibleName, workspaceLabel) => {
    const node = createCanvasModuleNode(`generation-drag-${moduleType}`, moduleType, { x: 0, y: 0 });
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    const opener = screen.getByRole('button', { name: accessibleName });

    fireEvent.pointerDown(opener, { clientX: 20, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 140, clientY: 90 });
    fireEvent.pointerUp(window, { clientX: 140, clientY: 90 });
    fireEvent.click(opener, { clientX: 140, clientY: 90, detail: 1 });

    expect(opener).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText(workspaceLabel)).not.toBeInTheDocument();
  });

  it.each([
    ['image_generation', 'Image generation prompt workspace'],
    ['video_generation', 'Video preview prompt workspace'],
  ] as const)('keeps collapsed %s card bodies available for direct dragging', (moduleType, workspaceLabel) => {
    const node = createCanvasModuleNode(`generation-card-click-${moduleType}`, moduleType, { x: 0, y: 0 });
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    fireEvent.click(screen.getByTestId('module-node-card'));

    expect(screen.queryByLabelText(workspaceLabel)).not.toBeInTheDocument();
  });

  it('does not expand a generation editor when its connection port is clicked', () => {
    const node = createCanvasModuleNode('generation-port-click', 'image_generation', { x: 0, y: 0 });
    const { container } = render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    const port = container.querySelector<HTMLElement>('.react-flow__handle');
    expect(port).not.toBeNull();

    fireEvent.click(port!);

    expect(screen.queryByLabelText('Image generation prompt workspace')).not.toBeInTheDocument();
  });
  it('uses the same collapsed preview shell for image and video generation nodes', () => {
    const image = createCanvasModuleNode('image-shell', 'image_generation', { x: 0, y: 0 });
    const video = createCanvasModuleNode('video-shell', 'video_generation', { x: 0, y: 0 });
    const { rerender } = render(<ReactFlowProvider><ModuleNodeCard id={image.id} data={image.data} selected={false} /></ReactFlowProvider>);

    expect(screen.getByLabelText('Image generation preview')).toHaveClass('module-node__generation-collapsed-shell');
    expect(screen.getByLabelText('Image generation preview')).not.toHaveClass('nodrag');
    expect(screen.getByRole('button', { name: 'Open image generation editor' })).not.toHaveClass('nodrag');
    expect(screen.getByRole('button', { name: 'Open image generation editor' }).closest('.module-node__generation-collapsed-shell')).toBe(screen.getByLabelText('Image generation preview'));

    rerender(<ReactFlowProvider><ModuleNodeCard id={video.id} data={video.data} selected={false} /></ReactFlowProvider>);

    expect(screen.getByLabelText('Video generation preview')).toHaveClass('module-node__generation-collapsed-shell');
    expect(screen.getByLabelText('Video generation preview')).not.toHaveClass('nodrag');
    expect(screen.getByRole('button', { name: 'Open video generation editor' })).not.toHaveClass('nodrag');
    expect(screen.getByRole('button', { name: 'Open video generation editor' }).closest('.module-node__generation-collapsed-shell')).toBe(screen.getByLabelText('Video generation preview'));
  });

  it('omits permanent status and quantity metadata from collapsed generation cards', () => {
    const image = createCanvasModuleNode('image-collapsed-clean', 'image_generation', { x: 0, y: 0 });
    const video = createCanvasModuleNode('video-collapsed-clean', 'video_generation', { x: 0, y: 0 });
    const { container, rerender } = render(
      <ReactFlowProvider><ModuleNodeCard id={image.id} data={image.data} selected={false} /></ReactFlowProvider>,
    );

    expect(container.querySelector('.module-node__generation-collapsed-status')).toBeNull();
    expect(container.querySelector('.module-node__generation-collapsed-count')).toBeNull();

    rerender(<ReactFlowProvider><ModuleNodeCard id={video.id} data={video.data} selected={false} /></ReactFlowProvider>);

    expect(container.querySelector('.module-node__generation-collapsed-status')).toBeNull();
    expect(container.querySelector('.module-node__generation-collapsed-count')).toBeNull();
  });

  it('opens the generated-image lightbox from the collapsed image preview on double click', () => {
    const node = createCanvasModuleNode('image-collapsed-lightbox', 'image_generation', { x: 0, y: 0 });
    node.data.config = { ...node.data.config, resultState: 'fresh' };
    useAppStore.setState({
      projectImages: [projectImage],
      modelJobs: [{ id: 'completed-collapsed-job', promptNodeId: node.id, status: 'completed', resultAssetId: projectImage.assetId }],
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Open image generation editor' }));

    expect(screen.getByRole('dialog', { name: 'Generated image preview' })).toBeVisible();
    expect(screen.getByRole('img', { name: 'Generated image 1 full preview' })).toHaveAttribute('src', projectImage.displayUrl);
  });

  it('shows exact dimensions and copies the image directly from the detail viewer', async () => {
    const node = createCanvasModuleNode('image-lightbox-copy', 'image_generation', { x: 0, y: 0 });
    node.data.config = { ...node.data.config, resultState: 'fresh', colorCorrection: ORIGINAL_IMAGE_COLOR_CORRECTION };
    const writeClipboardImage = vi.fn(async () => true);
    window.novusDesktop = {
      ...createPhotoshopDesktopBridge(vi.fn()),
      projectImages: {
        ...createPhotoshopDesktopBridge(vi.fn()).projectImages,
        writeClipboardImage,
      },
    } as never;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['image'], { type: 'image/png' }))));
    useAppStore.setState({
      projectImages: [projectImage],
      modelJobs: [{ id: 'completed-copy-job', promptNodeId: node.id, status: 'completed', resultAssetId: projectImage.assetId }],
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Open image generation editor' }));

    expect(screen.getByLabelText('图片尺寸')).toHaveTextContent('2 × 3 px');
    fireEvent.click(screen.getByRole('button', { name: '复制图片' }));
    await waitFor(() => expect(writeClipboardImage).toHaveBeenCalledOnce());
    expect(screen.getByText('图片已复制，可直接粘贴使用')).toBeVisible();
  });

  it('zooms the generated-image lightbox with the mouse wheel and resets the detail view', () => {
    const node = createCanvasModuleNode('image-lightbox-zoom', 'image_generation', { x: 0, y: 0 });
    node.data.config = { ...node.data.config, resultState: 'fresh' };
    useAppStore.setState({
      projectImages: [projectImage],
      modelJobs: [{ id: 'completed-zoom-job', promptNodeId: node.id, status: 'completed', resultAssetId: projectImage.assetId }],
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Open image generation editor' }));

    const viewer = screen.getByLabelText('Generated image detail viewer');
    const image = screen.getByRole('img', { name: 'Generated image 1 full preview' });
    expect(screen.getByLabelText('Generated image zoom level')).toHaveTextContent('100%');
    expect(viewer).toHaveAttribute('data-zoomed', 'false');

    fireEvent.wheel(viewer, { deltaY: -120, clientX: 0, clientY: 0 });

    expect(screen.getByLabelText('Generated image zoom level')).toHaveTextContent('125%');
    expect(viewer).toHaveAttribute('data-zoomed', 'true');
    expect(image).toHaveStyle({ transform: 'translate3d(0px, 0px, 0) scale(1.25)' });

    fireEvent.pointerDown(viewer, { button: 0, pointerId: 7, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(viewer, { pointerId: 7, clientX: 24, clientY: 18 });
    expect(image).toHaveStyle({ transform: 'translate3d(14px, 8px, 0) scale(1.25)' });
    fireEvent.pointerUp(viewer, { pointerId: 7, clientX: 24, clientY: 18 });

    fireEvent.click(screen.getByRole('button', { name: 'Reset generated image zoom' }));
    expect(screen.getByLabelText('Generated image zoom level')).toHaveTextContent('100%');
    expect(image).toHaveStyle({ transform: 'translate3d(0px, 0px, 0) scale(1)' });
  });

  it('uses a connected image-input edge as the image-generation reference slot and submit input', () => {
    const image = createCanvasModuleNode('image-slot-source', 'image_input', { x: 0, y: 0 });
    image.data.config = { assetId: projectImage.assetId };
    const generation = createCanvasModuleNode('image-slot-target', 'image_generation', { x: 420, y: 0 });
    const data = {
      ...generation.data,
      imageGenerationRoutes: [{
        provider: 'comfly',
        modelRoute: 'image-gen',
        displayName: 'Image Gen',
        modelId: 'image-gen',
        capabilities: ['image_generation', 'image_edit'],
      }],
    } as typeof generation.data;
    const runImageGenerationNode = vi.fn(async () => true);
    useAppStore.setState({
      project: {
        ...useAppStore.getState().project,
        nodes: [image, { ...generation, data }],
        edges: [{ id: 'image-slot-edge', source: image.id, sourcePortId: 'image', target: generation.id, targetPortId: 'references', order: 0 }],
        assets: [{
          assetId: projectImage.assetId,
          sha256: projectImage.sha256,
          byteSize: projectImage.byteSize,
          extension: projectImage.extension,
          height: projectImage.height,
          label: projectImage.label,
          mediaType: projectImage.mediaType,
          origin: projectImage.origin,
          width: projectImage.width,
        }],
      },
      projectImages: [projectImage],
      runImageGenerationNode,
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={generation.id} data={data} selected={false} /></ReactFlowProvider>);

    expect(screen.queryByLabelText('Image generation reference slots')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add image reference' })).not.toBeInTheDocument();
    openImageGenerationEditor();
    expect(within(screen.getByLabelText('Image generation reference slots')).getByRole('img', { name: projectImage.label })).toHaveAttribute('src', projectImage.displayUrl);
    fireEvent.change(screen.getByLabelText('Image generation prompt'), { target: { value: 'Connected reference product shot' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));
    expect(runImageGenerationNode).toHaveBeenCalledWith('image-slot-target', expect.objectContaining({
      referenceAssetIds: [projectImage.assetId],
    }));
    fireEvent.click(screen.getByRole('button', { name: '折叠图片生成节点' }));
    expect(screen.queryByLabelText('Image generation reference slots')).toBeNull();
  });

  it('does not submit a stale saved reference that is no longer connected or mentioned', () => {
    const staleImage = {
      ...projectImage,
      assetId: 'b'.repeat(16),
      displayUrl: 'novus-asset://desktop-session-1/bbbbbbbbbbbbbbbb',
      label: 'Stale reference',
      sha256: 'b'.repeat(64),
    };
    const image = createCanvasModuleNode('visible-reference-source', 'image_input', { x: 0, y: 0 });
    image.data.config = { assetId: projectImage.assetId };
    const generation = createCanvasModuleNode('stale-reference-target', 'image_generation', { x: 420, y: 0 });
    generation.data.config = {
      ...generation.data.config,
      prompt: 'Edit only the visible connected image',
      referenceAssetIds: [projectImage.assetId, staleImage.assetId],
    };
    const data = {
      ...generation.data,
      imageGenerationRoutes: [{
        provider: 'comfly',
        modelRoute: 'image-edit',
        displayName: 'Image Edit',
        modelId: 'image-edit',
        capabilities: ['image_generation', 'image_edit'],
      }],
    } as typeof generation.data;
    const runImageGenerationNode = vi.fn(async () => true);
    useAppStore.setState({
      project: {
        ...useAppStore.getState().project,
        nodes: [image, { ...generation, data }],
        edges: [{ id: 'visible-reference-edge', source: image.id, sourcePortId: 'image', target: generation.id, targetPortId: 'references', order: 0 }],
      },
      projectImages: [projectImage, staleImage],
      runImageGenerationNode,
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={generation.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));

    expect(runImageGenerationNode).toHaveBeenCalledWith(generation.id, expect.objectContaining({
      referenceAssetIds: [projectImage.assetId],
    }));
  });

  it('blocks RelayMe reference-image generation before queueing instead of silently dropping the reference', () => {
    const image = createCanvasModuleNode('relayme-retry-source', 'image_input', { x: 0, y: 0 });
    image.data.config = { assetId: projectImage.assetId };
    const generation = createCanvasModuleNode('relayme-retry-target', 'image_generation', { x: 420, y: 0 });
    const runImageGenerationNode = vi.fn(async () => true);
    const data = {
      ...generation.data,
      config: {
        ...generation.data.config,
        prompt: 'Keep the cocktail product centered',
        modelRoute: 'relayme-gemini-3-pro-image-preview',
      },
      onGenerateImage: runImageGenerationNode,
      imageGenerationRoutes: [{
        provider: 'relayme',
        modelRoute: 'relayme-gemini-3-pro-image-preview',
        displayName: 'Nano Banana Pro',
        modelId: 'gemini-3-pro-image-preview',
        capabilities: ['image_generation'],
      }],
    } as typeof generation.data;
    useAppStore.setState({
      project: {
        ...useAppStore.getState().project,
        nodes: [image, { ...generation, data }],
        edges: [{ id: 'relayme-retry-edge', source: image.id, sourcePortId: 'image', target: generation.id, targetPortId: 'references', order: 0 }],
      },
      projectImages: [projectImage],
      modelJobs: [],
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={generation.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));

    expect(runImageGenerationNode).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('RelayMe 当前不支持参考图生图，请选择 Comfly 模型或断开参考图。');
  });

  it('switches a connected reference-image request away from a text-only image route before submission', async () => {
    const image = createCanvasModuleNode('reference-capability-source', 'image_input', { x: 0, y: 0 });
    image.data.config = { assetId: projectImage.assetId };
    const generation = createCanvasModuleNode('reference-capability-target', 'image_generation', { x: 420, y: 0 });
    const runImageGenerationNode = vi.fn(async () => true);
    const data = {
      ...generation.data,
      config: {
        ...generation.data.config,
        prompt: 'Replace the face while preserving the scene',
        modelRoute: 'comfly-text-image',
      },
      onGenerateImage: runImageGenerationNode,
      imageGenerationRoutes: [
        {
          provider: 'comfly',
          modelRoute: 'comfly-text-image',
          displayName: 'Nano Banana 2',
          modelId: 'text-image',
          capabilities: ['image_generation'],
        },
        {
          provider: 'comfly',
          modelRoute: 'comfly-image-edit',
          displayName: 'Nano Banana Pro',
          modelId: 'image-edit',
          capabilities: ['image_generation', 'image_edit'],
        },
      ],
    } as typeof generation.data;
    useAppStore.setState({
      project: {
        ...useAppStore.getState().project,
        nodes: [image, { ...generation, data }],
        edges: [{ id: 'reference-capability-edge', source: image.id, sourcePortId: 'image', target: generation.id, targetPortId: 'references', order: 0 }],
      },
      projectImages: [projectImage],
      modelJobs: [],
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={generation.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    await waitFor(() => expect(screen.getByLabelText('Image generation model route')).toHaveValue('comfly-image-edit'));
    expect(within(screen.getByLabelText('Image generation model route')).queryByRole('option', { name: 'Nano Banana 2', hidden: true })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));
    expect(runImageGenerationNode).toHaveBeenCalledWith(generation.id, expect.objectContaining({
      modelRoute: 'comfly-image-edit',
      referenceAssetIds: [projectImage.assetId],
    }));
  });

  it('explains that a reference request needs an image-edit model before queueing', () => {
    const image = createCanvasModuleNode('reference-unsupported-source', 'image_input', { x: 0, y: 0 });
    image.data.config = { assetId: projectImage.assetId };
    const generation = createCanvasModuleNode('reference-unsupported-target', 'image_generation', { x: 420, y: 0 });
    const runImageGenerationNode = vi.fn(async () => true);
    const data = {
      ...generation.data,
      config: {
        ...generation.data.config,
        prompt: 'Use the connected reference',
        modelRoute: 'comfly-text-image',
      },
      onGenerateImage: runImageGenerationNode,
      imageGenerationRoutes: [{
        provider: 'comfly',
        modelRoute: 'comfly-text-image',
        displayName: 'Nano Banana 2',
        modelId: 'text-image',
        capabilities: ['image_generation'],
      }],
    } as typeof generation.data;
    useAppStore.setState({
      project: {
        ...useAppStore.getState().project,
        nodes: [image, { ...generation, data }],
        edges: [{ id: 'reference-unsupported-edge', source: image.id, sourcePortId: 'image', target: generation.id, targetPortId: 'references', order: 0 }],
      },
      projectImages: [projectImage],
      modelJobs: [],
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={generation.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));

    expect(runImageGenerationNode).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('当前参考图任务需要支持图片编辑的模型，请切换模型或断开参考图。');
  });

  it('keeps the connected video-media slot visible while an upstream upload is still unresolved', () => {
    const image = createCanvasModuleNode('video-slot-pending-image', 'image_input', { x: 0, y: 0 });
    const video = createCanvasModuleNode('video-slot-pending-target', 'video_generation', { x: 420, y: 0 });
    useAppStore.setState({
      project: {
        ...useAppStore.getState().project,
        nodes: [image, video],
        edges: [{ id: 'video-slot-pending-edge', source: image.id, sourcePortId: 'image', target: video.id, targetPortId: 'media', order: 0 }],
        assets: [],
      },
      projectImages: [],
    });

    render(<ReactFlowProvider><ModuleNodeCard id={video.id} data={video.data} selected={false} /></ReactFlowProvider>);

    expect(screen.getByLabelText('Connected video media')).toBeVisible();
    expect(within(screen.getByLabelText('Connected video media')).getByLabelText('Video preview reference slot pending')).toBeVisible();
    expect(screen.queryByText('Connected media pending')).not.toBeInTheDocument();
    expect(within(screen.getByLabelText('Connected video media')).queryByText('+')).not.toBeInTheDocument();
  });

  it('renders both endpoints as solid circular ports after a durable connection exists', () => {
    const node = createCanvasModuleNode('generator-connected-port', 'image_generation', { x: 0, y: 0 });

    render(
      <ReactFlowProvider>
        <ModuleNodeCard id={node.id} data={{ ...node.data, connectedPortIds: ['result'] } as never} selected={false} />
      </ReactFlowProvider>,
    );

    expect(document.querySelector('.react-flow__handle[data-port-id="result"]')).toHaveAttribute('data-port-connected', 'true');
  });

  it('fills only the connected direction when a result node reuses the analysis port id', () => {
    const node = createCanvasModuleNode('reverse-result-connected-input', 'reverse_result', { x: 0, y: 0 });

    render(
      <ReactFlowProvider>
        <ModuleNodeCard id={node.id} data={{ ...node.data, connectedPortKeys: ['input:analysis'] } as never} selected={false} />
      </ReactFlowProvider>,
    );

    expect(document.querySelector('[data-port-direction="input"] .react-flow__handle[data-port-id="analysis"]')).toHaveAttribute('data-port-connected', 'true');
    expect(document.querySelector('[data-port-direction="output"] .react-flow__handle[data-port-id="analysis"]')).not.toHaveAttribute('data-port-connected');
  });

  it('keeps selection visible without changing the module identity', () => {
    const node = createCanvasModuleNode('generator', 'image_generation', { x: 0, y: 0 });

    render(
      <ReactFlowProvider>
        <ModuleNodeCard id={node.id} data={node.data} selected />
      </ReactFlowProvider>,
    );

    expect(document.querySelector('.module-node')).toHaveClass('is-selected');
    expect(document.querySelector('[data-module-type="image_generation"]')).not.toBeNull();
  });

  it('lets an image-generation node submit its own prompt without requiring a text node', () => {
    const node = createCanvasModuleNode('generator-direct-run', 'image_generation', { x: 0, y: 0 });
    const data = {
      ...node.data,
      imageGenerationRoutes: [{
        provider: 'comfly',
        modelRoute: 'image-gen',
        displayName: 'Image Gen',
        modelId: 'image-gen',
        capabilities: ['image_generation'],
      }],
    } as typeof node.data;
    const runImageGenerationNode = vi.fn(async () => true);
    useAppStore.setState({ runImageGenerationNode } as never);

    render(
      <ReactFlowProvider>
        <ModuleNodeCard id={node.id} data={data} selected={false} />
      </ReactFlowProvider>,
    );

    openImageGenerationEditor();
    fireEvent.change(screen.getByLabelText('Image generation prompt'), {
      target: { value: 'A premium beverage product on a stone table' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));

    expect(runImageGenerationNode).toHaveBeenCalledWith('generator-direct-run', {
      modelRoute: 'image-gen',
      prompt: 'A premium beverage product on a stone table',
      aspectRatio: '1:1',
      resolution: '2K',
      outputCount: 1,
    });
  });

  it('repairs a saved legacy image route before an old canvas submits generation', async () => {
    const node = createCanvasModuleNode('legacy-route-image-run', 'image_generation', { x: 0, y: 0 });
    node.data.config = { ...node.data.config, modelRoute: 'retired-nano-banana-route' };
    const data = {
      ...node.data,
      imageGenerationRoutes: [{
        provider: 'relayme',
        modelRoute: 'relayme-nano-banana-pro-current',
        displayName: 'Nano Banana Pro',
        modelId: 'nano-banana-pro',
        capabilities: ['image_generation'],
      }],
    } as typeof node.data;
    const runImageGenerationNode = vi.fn(async () => true);
    const draftGenerationNodeConfig = vi.fn(async () => true);
    useAppStore.setState({ runImageGenerationNode, draftGenerationNodeConfig } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();
    fireEvent.change(screen.getByLabelText('Image generation prompt'), { target: { value: 'Generate from a saved canvas' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));

    await waitFor(() => expect(runImageGenerationNode).toHaveBeenCalledWith(node.id, expect.objectContaining({
      modelRoute: 'relayme-nano-banana-pro-current',
      prompt: 'Generate from a saved canvas',
    })));
    await waitFor(() => expect(draftGenerationNodeConfig).toHaveBeenCalledWith(node.id, expect.objectContaining({
      modelRoute: 'relayme-nano-banana-pro-current',
    })));
  });

  it('renders a highlighted media reference mention chip and sends the managed asset to image generation', () => {
    const node = createCanvasModuleNode('generator-at-mention', 'image_generation', { x: 0, y: 0 });
    const source = createCanvasModuleNode('generator-at-mention-source', 'image_input', { x: -320, y: 0 });
    source.data.config = { assetId: projectImage.assetId };
    const runImageGenerationNode = vi.fn(async () => true);
    useAppStore.setState({
      projectImages: [projectImage],
      project: { ...useAppStore.getState().project, nodes: [source, node], edges: [{ id: 'generator-at-mention-edge', source: source.id, sourcePortId: 'image', target: node.id, targetPortId: 'references', order: 0 }] },
      runImageGenerationNode,
    } as never);
    const data = {
      ...node.data,
      imageGenerationRoutes: [{ provider: 'comfly', modelRoute: 'image-gen', displayName: 'Image Gen', modelId: 'image-gen', capabilities: ['image_generation', 'image_edit'] }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    openImageGenerationEditor();
    fireEvent.change(screen.getByLabelText('Image generation prompt'), { target: { value: '@' } });

    const item = screen.getByRole('menuitem', { name: 'Product front' });
    const mentionMenu = screen.getByRole('menu', { name: 'Select reference image' });
    expect(mentionMenu).toBeVisible();
    expect(mentionMenu).toHaveClass('nowheel');
    expect(within(item).getByRole('img', { name: 'Product front' })).toHaveAttribute('src', projectImage.displayUrl);
    expect(item).toHaveTextContent('@图片1');
    expect(screen.queryByRole('button', { name: 'Reference image' })).not.toBeInTheDocument();
    fireEvent.click(item);
    expect(screen.getByLabelText('Image generation prompt')).toHaveValue('@图片1');
    expect(screen.queryByRole('menu', { name: 'Select reference image' })).not.toBeInTheDocument();
    const presentation = screen.getByRole('textbox', { name: /prompt/i });
    expect(within(presentation).getByText('图片1').closest('[data-token="@图片1"]')).toHaveAttribute('data-media-mention', 'image');
    expect(presentation).not.toHaveTextContent('@');
    fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));
    expect(runImageGenerationNode).toHaveBeenCalledWith(node.id, expect.objectContaining({ referenceAssetIds: [projectImage.assetId] }));
  });

  it('replaces the unresolved image mention at the real caret and preserves another @ plus surrounding prose', () => {
    const node = createCanvasModuleNode('generator-caret-mention', 'image_generation', { x: 0, y: 0 });
    const source = createCanvasModuleNode('generator-caret-mention-source', 'image_input', { x: -320, y: 0 });
    source.data.config = { assetId: projectImage.assetId };
    useAppStore.setState({
      projectImages: [projectImage],
      project: {
        ...useAppStore.getState().project,
        nodes: [source, node],
        edges: [{ id: 'generator-caret-mention-edge', source: source.id, sourcePortId: 'image', target: node.id, targetPortId: 'references', order: 0 }],
      },
    } as never);
    const data = {
      ...node.data,
      imageGenerationRoutes: [{ provider: 'comfly', modelRoute: 'image-gen', displayName: 'Image Gen', modelId: 'image-gen', capabilities: ['image_generation'] }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();
    const editor = screen.getByLabelText('Image generation prompt');
    const input = '开头 @当前候选 保留  @另一个候选  结尾';
    editor.textContent = input;
    const caretOffset = '开头 @当前候选'.length;
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(editor.firstChild!, caretOffset);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.input(editor);

    expect(screen.getByRole('menu', { name: 'Select reference image' })).toBeVisible();
    fireEvent.click(screen.getByRole('menuitem', { name: projectImage.label }));

    expect(editor).toHaveValue('开头 @图片1 保留  @另一个候选  结尾');
  });

  it('closes the image mention picker when the prompt editor loses focus', () => {
    const node = createCanvasModuleNode('generator-mention-blur', 'image_generation', { x: 0, y: 0 });
    const source = createCanvasModuleNode('generator-mention-blur-source', 'image_input', { x: -320, y: 0 });
    source.data.config = { assetId: projectImage.assetId };
    useAppStore.setState({
      projectImages: [projectImage],
      project: {
        ...useAppStore.getState().project,
        nodes: [source, node],
        edges: [{ id: 'generator-mention-blur-edge', source: source.id, sourcePortId: 'image', target: node.id, targetPortId: 'references', order: 0 }],
      },
    } as never);
    const data = {
      ...node.data,
      imageGenerationRoutes: [{ provider: 'comfly', modelRoute: 'image-gen', displayName: 'Image Gen', modelId: 'image-gen', capabilities: ['image_generation'] }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();
    const editor = screen.getByLabelText('Image generation prompt');
    fireEvent.change(editor, { target: { value: '@' } });
    expect(screen.getByRole('menu', { name: 'Select reference image' })).toBeVisible();

    fireEvent.blur(editor);

    expect(screen.queryByRole('menu', { name: 'Select reference image' })).not.toBeInTheDocument();

    fireEvent.change(editor, { target: { value: '@' } });
    expect(screen.queryByRole('menu', { name: 'Select reference image' })).not.toBeInTheDocument();

    fireEvent.change(editor, { target: { value: '@产' } });
    expect(screen.getByRole('menu', { name: 'Select reference image' })).toBeVisible();
  });

  it('does not reopen a dismissed mention picker for a delayed duplicate editor event', () => {
    const node = createCanvasModuleNode('generator-mention-delayed-change', 'image_generation', { x: 0, y: 0 });
    const source = createCanvasModuleNode('generator-mention-delayed-change-source', 'image_input', { x: -320, y: 0 });
    source.data.config = { assetId: projectImage.assetId };
    useAppStore.setState({
      projectImages: [projectImage],
      project: {
        ...useAppStore.getState().project,
        nodes: [source, node],
        edges: [{ id: 'generator-mention-delayed-change-edge', source: source.id, sourcePortId: 'image', target: node.id, targetPortId: 'references', order: 0 }],
      },
    } as never);
    const data = {
      ...node.data,
      imageGenerationRoutes: [{ provider: 'comfly', modelRoute: 'image-gen', displayName: 'Image Gen', modelId: 'image-gen', capabilities: ['image_generation'] }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();
    const editor = screen.getByLabelText('Image generation prompt');
    fireEvent.change(editor, { target: { value: '@稍后处理 @' } });
    fireEvent.click(screen.getByRole('menuitem', { name: projectImage.label }));
    const selectedValue = (editor as HTMLDivElement & { value?: string }).value;
    expect(selectedValue).toBe('@稍后处理 @图片1');
    expect(screen.queryByRole('menu', { name: 'Select reference image' })).not.toBeInTheDocument();

    fireEvent.change(editor, { target: { value: selectedValue } });

    expect(screen.queryByRole('menu', { name: 'Select reference image' })).not.toBeInTheDocument();
  });

  it('preserves existing prompt prose when the image picker opens from a stale text selection', () => {
    const node = createCanvasModuleNode('generator-stale-selection', 'image_generation', { x: 0, y: 0 });
    const source = createCanvasModuleNode('generator-stale-selection-source', 'image_input', { x: -320, y: 0 });
    source.data.config = { assetId: projectImage.assetId };
    useAppStore.setState({
      projectImages: [projectImage],
      project: {
        ...useAppStore.getState().project,
        nodes: [source, node],
        edges: [{ id: 'generator-stale-selection-edge', source: source.id, sourcePortId: 'image', target: node.id, targetPortId: 'references', order: 0 }],
      },
    } as never);
    const data = {
      ...node.data,
      imageGenerationRoutes: [{ provider: 'comfly', modelRoute: 'image-gen', displayName: 'Image Gen', modelId: 'image-gen', capabilities: ['image_generation'] }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();
    const editor = screen.getByLabelText('Image generation prompt');
    fireEvent.change(editor, { target: { value: '必须保留的完整文案' } });
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));

    fireEvent.keyDown(editor, { key: '@' });
    fireEvent.click(screen.getByRole('menuitem', { name: projectImage.label }));

    expect(editor).toHaveValue('必须保留的完整文案 @图片1');
  });

  it('keeps two distinct image citations in the prompt and sends both references', () => {
    const secondImage = {
      ...projectImage,
      assetId: 'fedcba0123456789',
      displayUrl: 'novus-asset://project/session/fedcba0123456789',
      label: 'Scene reference',
      sha256: 'fedcba0123456789fedcba0123456789fedcba0123456789fedcba0123456789',
    };
    const node = createCanvasModuleNode('generator-two-mentions', 'image_generation', { x: 0, y: 0 });
    const firstSource = createCanvasModuleNode('generator-two-mentions-first', 'image_input', { x: -320, y: 0 });
    firstSource.data.config = { assetId: projectImage.assetId };
    const secondSource = createCanvasModuleNode('generator-two-mentions-second', 'image_input', { x: -320, y: 380 });
    secondSource.data.config = { assetId: secondImage.assetId };
    const runImageGenerationNode = vi.fn(async () => true);
    useAppStore.setState({
      projectImages: [projectImage, secondImage],
      project: {
        ...useAppStore.getState().project,
        nodes: [firstSource, secondSource, node],
        edges: [
          { id: 'generator-two-mentions-edge-1', source: firstSource.id, sourcePortId: 'image', target: node.id, targetPortId: 'references', order: 0 },
          { id: 'generator-two-mentions-edge-2', source: secondSource.id, sourcePortId: 'image', target: node.id, targetPortId: 'references', order: 1 },
        ],
      },
      runImageGenerationNode,
    } as never);
    const data = {
      ...node.data,
      imageGenerationRoutes: [{ provider: 'comfly', modelRoute: 'image-gen', displayName: 'Image Gen', modelId: 'image-gen', capabilities: ['image_generation', 'image_edit'] }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();
    const editor = screen.getByLabelText('Image generation prompt');
    fireEvent.change(editor, { target: { value: '@' } });
    fireEvent.click(screen.getByRole('menuitem', { name: projectImage.label }));

    editor.append(document.createTextNode('，继续参考 @'));
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.input(editor);
    fireEvent.click(screen.getByRole('menuitem', { name: secondImage.label }));

    expect(editor).toHaveValue('@图片1，继续参考 @图片2');
    fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));
    expect(runImageGenerationNode).toHaveBeenCalledWith(node.id, expect.objectContaining({
      referenceAssetIds: [projectImage.assetId, secondImage.assetId],
    }));
  });

  it('replaces the whole unresolved token when the caret is inside its query', () => {
    const node = createCanvasModuleNode('generator-inner-query-caret', 'image_generation', { x: 0, y: 0 });
    const source = createCanvasModuleNode('generator-inner-query-caret-source', 'image_input', { x: -320, y: 0 });
    source.data.config = { assetId: projectImage.assetId };
    useAppStore.setState({
      projectImages: [projectImage],
      project: {
        ...useAppStore.getState().project,
        nodes: [source, node],
        edges: [{ id: 'generator-inner-query-edge', source: source.id, sourcePortId: 'image', target: node.id, targetPortId: 'references', order: 0 }],
      },
    } as never);
    const data = {
      ...node.data,
      imageGenerationRoutes: [{ provider: 'comfly', modelRoute: 'image-gen', displayName: 'Image Gen', modelId: 'image-gen', capabilities: ['image_generation'] }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();
    const editor = screen.getByLabelText('Image generation prompt');
    const input = '开头 @当前候选 保留';
    editor.textContent = input;
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(editor.firstChild!, '开头 @当'.length);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.input(editor);
    expect(screen.getByRole('menu', { name: 'Select reference image' })).toBeVisible();
    fireEvent.click(screen.getByRole('menuitem', { name: projectImage.label }));

    expect(editor).toHaveValue('开头 @图片1 保留');
  });

  it('recognizes a canonical image token when it touches Chinese prose', () => {
    expect(promptContainsImageMention('产品@图片1，保持结构', '@图片1')).toBe(true);
    expect(promptContainsImageMention('保持@图片10结构', '@图片1')).toBe(false);
  });

  it('hides the image mention picker when an existing reference leaves no matching candidates', () => {
    const node = createCanvasModuleNode('generator-no-empty-mention-picker', 'image_generation', { x: 0, y: 0 });
    useAppStore.setState({ projectImages: [projectImage] } as never);
    const data = {
      ...node.data,
      imageGenerationRoutes: [{ provider: 'comfly', modelRoute: 'image-gen', displayName: 'Image Gen', modelId: 'image-gen', capabilities: ['image_generation'] }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    openImageGenerationEditor();
    fireEvent.change(screen.getByLabelText('Image generation prompt'), {
      target: { value: '帮我把@图片1的产品换成新产品，其他不要改变' },
    });

    expect(screen.queryByRole('menu', { name: 'Select reference image' })).not.toBeInTheDocument();
    expect(screen.queryByText('暂无可引用图片')).not.toBeInTheDocument();
  });

  it('does not offer unconnected project images to video generation mentions', () => {
    const node = createCanvasModuleNode('video-at-mention', 'video_generation', { x: 0, y: 0 });
    const runVideoPreviewNode = vi.fn(async () => true);
    useAppStore.setState({ projectImages: [projectImage], runVideoPreviewNode } as never);
    const data = {
      ...node.data,
      videoGenerationRoutes: [{ provider: 'comfly', modelRoute: 'video-gen', displayName: 'Video Gen', modelId: 'video-gen', capabilities: ['video_generation'] }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openVideoGenerationEditor();
    fireEvent.change(screen.getByLabelText('Video preview prompt'), { target: { value: '@' } });
    expect(screen.queryByRole('menu', { name: 'Select reference image' })).not.toBeInTheDocument();
    expect(runVideoPreviewNode).not.toHaveBeenCalled();
  });

  it('inserts a video-node image mention at the current caret without collapsing sentence spacing', () => {
    const node = createCanvasModuleNode('video-caret-mention', 'video_generation', { x: 0, y: 0 });
    const source = createCanvasModuleNode('video-caret-mention-source', 'image_input', { x: -320, y: 0 });
    source.data.config = { assetId: projectImage.assetId };
    useAppStore.setState({
      projectImages: [projectImage],
      project: {
        ...useAppStore.getState().project,
        nodes: [source, node],
        edges: [{ id: 'video-caret-mention-edge', source: source.id, sourcePortId: 'image', target: node.id, targetPortId: 'media', order: 0 }],
      },
    } as never);
    const data = {
      ...node.data,
      videoGenerationRoutes: [{ provider: 'comfly', modelRoute: 'video-gen', displayName: 'Video Gen', modelId: 'video-gen', capabilities: ['video_generation'] }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openVideoGenerationEditor();
    const editor = screen.getByLabelText('Video preview prompt');
    const input = '镜头从  @这里  推进，末尾保留 @另一个';
    editor.textContent = input;
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(editor.firstChild!, '镜头从  @这里'.length);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.input(editor);
    fireEvent.click(screen.getByRole('menuitem', { name: projectImage.label }));

    expect(editor).toHaveValue('镜头从  @图片1  推进，末尾保留 @另一个');
    expect(screen.queryByRole('menu', { name: 'Select reference image' })).not.toBeInTheDocument();
  });

  it('removes an @ image mention from the generation prompt without crashing the renderer', () => {
    const node = createCanvasModuleNode('generator-remove-at-mention', 'image_generation', { x: 0, y: 0 });
    const source = createCanvasModuleNode('generator-remove-at-mention-source', 'image_input', { x: -320, y: 0 });
    source.data.config = { assetId: projectImage.assetId };
    useAppStore.setState({
      projectImages: [projectImage],
      project: { ...useAppStore.getState().project, nodes: [source, node], edges: [{ id: 'generator-remove-at-mention-edge', source: source.id, sourcePortId: 'image', target: node.id, targetPortId: 'references', order: 0 }] },
    } as never);
    const data = {
      ...node.data,
      imageGenerationRoutes: [{ provider: 'comfly', modelRoute: 'image-gen', displayName: 'Image Gen', modelId: 'image-gen', capabilities: ['image_generation'] }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();
    const prompt = screen.getByLabelText('Image generation prompt');
    fireEvent.change(prompt, { target: { value: '@' } });
    fireEvent.click(screen.getByRole('menuitem', { name: projectImage.label }));
    expect(prompt).toHaveValue('@图片1');

    fireEvent.change(prompt, { target: { value: '' } });

    expect(prompt).toHaveValue('');
    expect(screen.queryByRole('menu', { name: 'Select reference image' })).not.toBeInTheDocument();
  });

  it('separates image generation into prompt, connected-reference, parameter, and result workbench regions', () => {
    const node = createCanvasModuleNode('generator-workbench-regions', 'image_generation', { x: 0, y: 0 });
    const data = {
      ...node.data,
      config: { referenceAssetIds: [projectImage.assetId] },
      imageGenerationRoutes: [{
        provider: 'comfly',
        modelRoute: 'image-gen',
        displayName: 'Image Gen',
        modelId: 'image-gen',
        capabilities: ['image_generation'],
      }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    openImageGenerationEditor();
    expect(screen.getByLabelText('Image generation prompt workspace')).toContainElement(screen.getByLabelText('Image generation prompt'));
    expect(screen.getByLabelText('Image generation reference slots')).toHaveTextContent('0 / 20');
    expect(screen.queryByLabelText('Image generation connected references')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Reference slot \d+$/u })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add image reference' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Image generation control bar')).toBeVisible();
    expect(screen.getByLabelText('Image generation preview')).toBeVisible();
    expect(screen.getByText('图片生成 V2')).toBeVisible();
    expect(screen.queryByRole('button', { name: '引用图片' })).not.toBeInTheDocument();

    expect(screen.queryByLabelText('图片生成 节点结果')).not.toBeInTheDocument();
    const configuration = screen.getByLabelText('图片生成 节点配置');
    const run = screen.getByRole('button', { name: 'Generate image' });
    expect(configuration.compareDocumentPosition(run) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('does not expose an inline image-reference picker before a real canvas edge exists', () => {
    const node = createCanvasModuleNode('generator-inline-reference', 'image_generation', { x: 0, y: 0 });
    useAppStore.setState({ projectImages: [projectImage] } as never);
    const data = {
      ...node.data,
      imageGenerationRoutes: [{ provider: 'comfly', modelRoute: 'image-gen', displayName: 'Image Gen', modelId: 'image-gen', capabilities: ['image_generation'] }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    expect(screen.queryByRole('button', { name: 'Add image reference' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Image generation reference slots')).not.toBeInTheDocument();
  });

  it('keeps image model and output specifications in one bottom control bar', () => {
    const node = createCanvasModuleNode('generator-output-spec', 'image_generation', { x: 0, y: 0 });
    const data = {
      ...node.data,
      imageGenerationRoutes: [{
        provider: 'comfly',
        modelRoute: 'image-gen',
        displayName: 'Image Gen',
        modelId: 'image-gen',
        capabilities: ['image_generation'],
      }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    openImageGenerationEditor();
    const controlBar = screen.getByLabelText('Image generation control bar');
    expect(controlBar).toContainElement(screen.getByLabelText('Image generation model route'));
    expect(screen.queryByRole('group', { name: 'Image generation aspect ratio presets' })).toBeNull();
    expect(controlBar).toContainElement(screen.getByLabelText('Image generation aspect ratio'));
    expect(screen.queryByRole('button', { name: 'Aspect ratio 1:1' })).toBeNull();
    const ratioTrigger = screen.getByRole('button', { name: 'Image generation aspect ratio' });
    expect(ratioTrigger.closest('.generation-parameter-popover')).toHaveClass('generation-parameter-popover--ratio-grid');
    expect(ratioTrigger.querySelector('svg')).not.toBeNull();
    const resolution = screen.getByRole('button', { name: 'Image generation resolution' });
    expect(controlBar).toContainElement(resolution);
    expect(resolution).toHaveValue('2K');
    expect(screen.queryByText('????')).not.toBeInTheDocument();
    expect(controlBar).toContainElement(screen.getByLabelText('Image generation quantity'));
    expect(screen.getByLabelText('Image generation quantity')).toHaveTextContent('1');
    expect(screen.getByLabelText('Image generation quantity')).toHaveTextContent('2');
    expect(screen.getByLabelText('Image generation quantity')).toHaveTextContent('3');
    expect(screen.getByLabelText('Image generation quantity')).toHaveTextContent('4');
    expect(controlBar).toContainElement(screen.getByRole('button', { name: 'Generate image' }));
  });

  it('explains when the active provider account has no image generation model', () => {
    const node = createCanvasModuleNode('image-no-active-capability', 'image_generation', { x: 0, y: 0 });
    const data = { ...node.data, imageGenerationRoutes: [] } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    expect(screen.getByRole('note')).toHaveTextContent('该账号没有此类模型，请先在设置中切换供应商。');
    expect(screen.getByRole('button', { name: 'Generate image' })).toBeDisabled();
  });

  it('explains when the active provider account has no video generation model', () => {
    const node = createCanvasModuleNode('video-no-active-capability', 'video_generation', { x: 0, y: 0 });
    const data = { ...node.data, videoGenerationRoutes: [] } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openVideoGenerationEditor();

    expect(screen.getByRole('note')).toHaveTextContent('该账号没有此类模型，请先在设置中切换供应商。');
    expect(screen.getByRole('button', { name: '生成视频' })).toBeDisabled();
  });

  it('limits image controls to the selected provider model constraints', () => {
    const node = createCanvasModuleNode('generator-constrained', 'image_generation', { x: 0, y: 0 });
    const data = {
      ...node.data,
      imageGenerationRoutes: [{
        provider: 'relayme', modelRoute: 'relay-image', displayName: 'Relay Image', modelId: 'relay-image',
        capabilities: ['image_generation'],
        constraints: { image: { aspectRatios: ['1:1', '16:9'], resolutions: ['480p', '720p', '1080p'], outputCounts: [1, 2] } },
      }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    expect(readGenerationParameterOptions('Image generation aspect ratio')).toEqual(['AUTO', '1:1', '16:9']);
    expect(readGenerationParameterOptions('Image generation resolution')).toEqual(['1K', '2K', '4K']);
    expect(screen.getByRole('menuitemradio', { name: '2K' })).toBeEnabled();
    expect(screen.getByRole('menuitemradio', { name: '4K' })).toBeEnabled();
    expect(within(screen.getByLabelText('Image generation quantity')).getAllByRole('option').map((item) => item.getAttribute('value'))).toEqual(['1', '2']);
  });

  it('keeps clarity visible and disables unverified tiers when a complete provider profile omits a resolution contract', () => {
    const node = createCanvasModuleNode('image-provider-defaults', 'image_generation', { x: 0, y: 0 });
    const runImageGenerationNode = vi.fn(async () => true);
    useAppStore.setState({ runImageGenerationNode } as never);
    const data = {
      ...node.data,
      imageGenerationRoutes: [{
        provider: 'comfly', modelRoute: 'dall-e-3', displayName: 'DALL-E 3', modelId: 'dall-e-3',
        capabilities: ['image_generation'], capabilityStatus: 'complete',
        constraints: { image: { outputCounts: [1] } },
      }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    expect(readGenerationParameterOptions('Image generation aspect ratio')).toEqual(['AUTO', '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']);
    expect(readGenerationParameterOptions('Image generation resolution')).toEqual(['1K', '2K', '4K']);
    expect(screen.getByRole('menuitemradio', { name: '2K' })).toBeEnabled();
    expect(screen.getByRole('menuitemradio', { name: '4K' })).toBeDisabled();
    expect(within(screen.getByLabelText('Image generation quantity')).getAllByRole('option').map((item) => item.getAttribute('value'))).toEqual(['1']);
    chooseGenerationParameterOption('Image generation aspect ratio', 'AUTO');
    fireEvent.change(screen.getByLabelText('Image generation prompt'), { target: { value: 'Use image defaults' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));
    expect(runImageGenerationNode).toHaveBeenCalledWith(node.id, expect.objectContaining({ outputCount: 1 }));
    expect(runImageGenerationNode).toHaveBeenCalledWith(node.id, expect.objectContaining({ resolution: '2K' }));
    expect(runImageGenerationNode).toHaveBeenCalledWith(node.id, expect.not.objectContaining({ aspectRatio: expect.anything() }));
  });
  it('recalibrates controls when refreshed constraints change on the same model route', async () => {
    const node = createCanvasModuleNode('generator-refreshed-constraints', 'image_generation', { x: 0, y: 0 });
    const runImageGenerationNode = vi.fn(async () => true);
    useAppStore.setState({ runImageGenerationNode } as never);
    const data = {
      ...node.data,
      imageGenerationRoutes: [{
        provider: 'relayme', modelRoute: 'relay-image-stable', displayName: 'Relay Image Stable', modelId: 'relay-image-stable',
        capabilities: ['image_generation'], constraints: { image: { resolutions: ['2K', '4K'] } },
      }],
    } as typeof node.data;
    const { rerender } = render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();
    chooseGenerationParameterOption('Image generation resolution', '4K');

    const refreshed = {
      ...data,
      imageGenerationRoutes: [{
        provider: 'relayme', modelRoute: 'relay-image-stable', displayName: 'Relay Image Stable', modelId: 'relay-image-stable',
        capabilities: ['image_generation'], constraints: { image: { resolutions: ['1K'] } },
      }],
    } as typeof node.data;
    rerender(<ReactFlowProvider><ModuleNodeCard id={node.id} data={refreshed} selected={false} /></ReactFlowProvider>);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Image generation resolution' })).toHaveValue('1K'));
    expect(readGenerationParameterOptions('Image generation resolution')).toEqual(['1K', '2K', '4K']);
    expect(screen.getByRole('menuitemradio', { name: '2K' })).toBeDisabled();
    expect(screen.getByRole('menuitemradio', { name: '4K' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Image generation prompt'), { target: { value: 'Use refreshed constraints' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));
    expect(runImageGenerationNode).toHaveBeenCalledWith(node.id, expect.objectContaining({ resolution: '1K' }));
  });
  it('derives AUTO video ratio from the first connected media dimensions', () => {
    expect(resolveAutomaticVideoAspectRatio(
      [{ kind: 'image', assetId: projectImage.assetId, label: projectImage.label, ranges: [] }],
      [projectImage],
      [projectVideo],
    )).toBe('2:3');
    expect(resolveAutomaticVideoAspectRatio([], [projectImage], [projectVideo])).toBeUndefined();
  });
  it('limits video controls to the selected provider model constraints', () => {
    const node = createCanvasModuleNode('video-constrained', 'video_generation', { x: 0, y: 0 });
    const data = {
      ...node.data,
      videoGenerationRoutes: [{
        provider: 'relayme', modelRoute: 'relay-video', displayName: 'Relay Video', modelId: 'relay-video',
        capabilities: ['video_generation'],
        constraints: { video: { aspectRatios: ['16:9', '9:16'], resolutions: ['480p', '720p', '1080p'], duration: { mode: 'options', options: [4, 6, 8] }, outputCounts: [1, 2] } },
      }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openVideoGenerationEditor();

    expect(readGenerationParameterOptions('Video preview aspect ratio')).toEqual(['AUTO', '16:9', '9:16']);
    const videoSettingsTrigger = screen.getByRole('button', { name: '打开视频参数设置' });
    expect(videoSettingsTrigger).toHaveAttribute('aria-expanded', 'true');
    expect(readGenerationParameterOptions('Video preview resolution')).toEqual(['480P', '720P', '1080P']);
    expect(within(screen.getByLabelText('Video preview duration')).getAllByRole('option').map((item) => item.textContent)).toEqual(['4秒', '6秒', '8秒']);
    expect(within(screen.getByLabelText('Video preview quantity')).getAllByRole('option').map((item) => item.getAttribute('value'))).toEqual(['1', '2']);
  });
  it('keeps Julun video controls inside the audited transport contract and disables unsupported audio', async () => {
    const node = createCanvasModuleNode('julun-video-constraints', 'video_generation', { x: 0, y: 0 });
    node.data.config = {
      ...node.data.config,
      modelRoute: 'julun-sora-2',
      aspectRatio: '9:16',
      resolution: '4K',
      durationSeconds: 15,
      outputCount: 4,
      audioEnabled: true,
    };
    const runVideoPreviewNode = vi.fn(async () => true);
    useAppStore.setState({ runVideoPreviewNode } as never);
    const data = {
      ...node.data,
      videoGenerationRoutes: [{
        provider: 'julun', modelRoute: 'julun-sora-2', displayName: 'Sora 2', modelId: 'sora-2',
        capabilities: ['video_generation', 'async_tasks'], capabilityStatus: 'complete',
        constraints: { video: {
          aspectRatios: ['16:9'], resolutions: ['720p'],
          duration: { mode: 'options', defaultValue: 10, options: [5, 10] }, outputCounts: [1],
        } },
      }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openVideoGenerationEditor();

    await waitFor(() => expect(screen.getByLabelText('Video preview aspect ratio')).toHaveValue('16:9'));
    expect(readGenerationParameterOptions('Video preview aspect ratio')).toEqual(['16:9']);
    expect(readGenerationParameterOptions('Video preview resolution')).toEqual(['720P']);
    expect(within(screen.getByLabelText('Video preview duration')).getAllByRole('option').map((item) => item.textContent)).toEqual(['5秒', '10秒']);
    expect(screen.getByLabelText('Video preview duration')).toHaveValue('10');
    expect(screen.queryByLabelText('Video preview audio')).toBeNull();
    const settings = screen.getByRole('dialog', { name: '视频生成参数' });
    expect(within(settings).queryByLabelText('生成音频')).toBeNull();
    expect(within(settings).queryByRole('slider')).toBeNull();
    expect(within(settings).getByRole('menuitemradio', { name: '5秒' })).toBeVisible();
    expect(within(settings).getByRole('menuitemradio', { name: '10秒' })).toBeVisible();

    fireEvent.change(screen.getByLabelText('Video preview duration'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Video preview prompt'), { target: { value: 'Julun audited video' } });
    fireEvent.click(screen.getByRole('button', { name: '生成视频' }));

    expect(runVideoPreviewNode).toHaveBeenCalledWith(node.id, expect.objectContaining({
      aspectRatio: '16:9', resolution: '720p', durationSeconds: 5, outputCount: 1, audioEnabled: false,
    }));
  });
  it('uses the product duration fallback when a complete provider profile omits duration metadata', () => {
    const node = createCanvasModuleNode('video-provider-defaults', 'video_generation', { x: 0, y: 0 });
    const runVideoPreviewNode = vi.fn(async () => true);
    useAppStore.setState({ runVideoPreviewNode } as never);
    const data = {
      ...node.data,
      videoGenerationRoutes: [{
        provider: 'comfly', modelRoute: 'kling-duration-only', displayName: 'Kling duration only', modelId: 'kling-duration-only',
        capabilities: ['video_generation'], capabilityStatus: 'complete',
        constraints: { video: { duration: { mode: 'options', options: [5, 10] }, outputCounts: [1] } },
      }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openVideoGenerationEditor();

    expect(readGenerationParameterOptions('Video preview aspect ratio')).toEqual(['AUTO', '1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9']);
    expect(readGenerationParameterOptions('Video preview resolution')).toEqual(['360P', '480P', '512P', '540P', '720P', '768P', '1080P', '2K', '4K']);
    expect(within(screen.getByLabelText('Video preview quantity')).getAllByRole('option').map((item) => item.getAttribute('value'))).toEqual(['1']);
    chooseGenerationParameterOption('Video preview aspect ratio', 'AUTO');
    fireEvent.change(screen.getByLabelText('Video preview prompt'), { target: { value: 'Use provider defaults' } });
    fireEvent.click(screen.getByRole('button', { name: '生成视频' }));
    expect(runVideoPreviewNode).toHaveBeenCalledWith(node.id, expect.objectContaining({
      aspectRatio: 'Auto', resolution: '1080p', durationSeconds: 5, outputCount: 1,
    }));
  });
  it('uses the 4, 8 and 12 second product duration fallback without provider duration metadata', () => {
    const node = createCanvasModuleNode('video-duration-fallback', 'video_generation', { x: 0, y: 0 });
    const data = { ...node.data, videoGenerationRoutes: [{
      provider: 'comfly', modelRoute: 'video-no-duration', displayName: 'Video no duration', modelId: 'video-no-duration',
      capabilities: ['video_generation'], capabilityStatus: 'complete', constraints: { video: { outputCounts: [1] } },
    }] } as typeof node.data;
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openVideoGenerationEditor();
    expect(within(screen.getByLabelText('Video preview duration')).getAllByRole('option').map((item) => item.textContent)).toEqual(['4秒', '8秒', '12秒']);
  });
  it('exposes a 1-15 second video duration slider and persists its value', () => {
    const node = createCanvasModuleNode('video-duration-slider', 'video_generation', { x: 0, y: 0 });
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    openVideoGenerationEditor();
    fireEvent.click(screen.getByRole('button', { name: '打开视频参数设置' }));
    const slider = screen.getByRole('dialog', { name: '视频生成参数' });
    expect(slider).toBeVisible();
    const input = within(slider).getByRole('slider');
    expect(input).toHaveAttribute('min', '1');
    expect(input).toHaveAttribute('max', '15');
    fireEvent.change(input, { target: { value: '15' } });
    expect(within(slider).getByText('15s')).toBeVisible();
  });
  it('runs an offline video preview from the prompt and leaves media resolution to the connected port', () => {
    const node = createCanvasModuleNode('video-preview', 'video_generation' as never, { x: 0, y: 0 });
    const runVideoPreviewNode = vi.fn(async () => true);
    useAppStore.setState({ projectImages: [projectImage], runVideoPreviewNode } as never);
    const data = {
      ...node.data,
      videoGenerationRoutes: [{
        provider: 'comfly', modelRoute: 'seedance-1.5-pro', displayName: 'Seedance', modelId: 'doubao-seedance-2.5', capabilities: ['video_generation'],
      }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    openVideoGenerationEditor();
    fireEvent.change(screen.getByLabelText('Video preview prompt'), { target: { value: 'A quiet product reveal' } });
    fireEvent.change(screen.getByLabelText('Video preview duration'), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: '生成视频' }));

    expect(runVideoPreviewNode).toHaveBeenCalledWith('video-preview', {
      prompt: 'A quiet product reveal',
      referenceAssetIds: [],
      modelRoute: 'seedance-1.5-pro',
      aspectRatio: '16:9',
      keyframe: 'auto',
      durationSeconds: 8,
      resolution: '1080p',
      audioEnabled: true,
      outputCount: 1,
    });
  });

  it('passes connected image media into the video generation action', () => {
    const image = createCanvasModuleNode('video-action-image', 'image_input', { x: -420, y: 0 });
    image.data.config = { assetId: projectImage.assetId };
    const video = createCanvasModuleNode('video-action-target', 'video_generation' as never, { x: 0, y: 0 });
    const runVideoPreviewNode = vi.fn(async () => true);
    const data = {
      ...video.data,
      videoGenerationRoutes: [{
        provider: 'comfly', modelRoute: 'seedance-1.5-pro', displayName: 'Seedance', modelId: 'doubao-seedance-2.5', capabilities: ['video_generation'],
      }],
    } as typeof video.data;
    useAppStore.setState({
      project: {
        ...useAppStore.getState().project,
        nodes: [image, { ...video, data }],
        edges: [{ id: 'video-action-edge', source: image.id, sourcePortId: 'image', target: video.id, targetPortId: 'media', order: 0 }],
        assets: [projectImage],
      },
      projectImages: [projectImage],
      runVideoPreviewNode,
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={video.id} data={data} selected={false} /></ReactFlowProvider>);
    openVideoGenerationEditor();
    fireEvent.change(screen.getByLabelText('Video preview prompt'), { target: { value: 'A connected product reveal' } });
    fireEvent.click(screen.getByRole('button', { name: '生成视频' }));

    expect(runVideoPreviewNode).toHaveBeenCalledWith('video-action-target', {
      prompt: 'A connected product reveal',
      referenceAssetIds: [projectImage.assetId],
      modelRoute: 'seedance-1.5-pro',
      aspectRatio: '16:9',
      keyframe: 'auto',
      durationSeconds: 4,
      resolution: '1080p',
      audioEnabled: true,
      outputCount: 1,
    });
  });

  it('groups the Canvas video prompt, connected-media tray, controls, and centered action in one composer layer', () => {
    const node = createCanvasModuleNode('video-canvas-composer', 'video_generation' as never, { x: 0, y: 0 });

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    openVideoGenerationEditor();
    const composer = screen.getByLabelText('Video generation composer');
    expect(composer).toHaveClass('module-node__video-composer');
    expect(composer).toContainElement(screen.getByLabelText('Video preview prompt workspace'));
    expect(composer).toContainElement(screen.getByLabelText('Video preview parameter controls'));
    expect(composer).toContainElement(screen.getByRole('button', { name: '生成视频' }));
  });

  it('uses the Canvas model and media-mode chips ahead of its video controls', () => {
    const node = createCanvasModuleNode('video-canvas-parameters', 'video_generation' as never, { x: 0, y: 0 });

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    openVideoGenerationEditor();
    expect(screen.getByLabelText('Video preview model')).toHaveTextContent('模型');
    expect(screen.getByLabelText('Video preview mode')).toHaveTextContent('图生视频');
    expect(screen.getByLabelText('Video preview duration')).toHaveValue('4');
    expect(screen.getByLabelText('Video preview resolution')).toHaveValue('1080p');
  });

  it('orders the video controls exactly as the Canvas 332:2 parameter rail', () => {
    const node = createCanvasModuleNode('video-canvas-control-order', 'video_generation' as never, { x: 0, y: 0 });

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    openVideoGenerationEditor();
    const parameterLabels = Array.from(screen.getByLabelText('Video preview parameter controls').children)
      .map((element) => element.getAttribute('aria-label') ?? element.querySelector('[aria-label]')?.getAttribute('aria-label'));

    expect(parameterLabels).toEqual([
      'Video preview model',
      'Video preview mode',
      '打开视频参数设置',
      'Video preview aspect ratio',
      'Video preview resolution',
      'Video preview duration',
      'Video preview audio',
      'Video preview quantity',
      '生成视频',
    ]);
    expect(screen.queryByLabelText('视频脚本')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('翻译提示词')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('视频高级设置')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Video generation reference tools')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '特效' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '运镜' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '角色库' })).not.toBeInTheDocument();
  });

  it('marks compatibility-only video controls so they cannot participate in the visible rail', () => {
    const node = createCanvasModuleNode('video-hidden-compat-controls', 'video_generation' as never, { x: 0, y: 0 });

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    openVideoGenerationEditor();
    const controls = screen.getByLabelText('Video preview parameter controls');
    expect(controls.querySelector("select[aria-label='Video preview audio']")).toHaveClass('module-node__video-fallback-control');
    expect(controls.querySelector("select[aria-label='Video preview quantity']")).toHaveClass('module-node__video-fallback-control');
  });

  it('keeps mock video prompt, parameters, and mock result in separate regions without a second media picker', () => {
    const node = createCanvasModuleNode('video-preview-regions', 'video_generation' as never, { x: 0, y: 0 });
    useAppStore.setState({ projectImages: [projectImage] } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    openVideoGenerationEditor();
    expect(screen.getByLabelText('Video preview prompt workspace')).toContainElement(screen.getByLabelText('Video preview prompt'));
    expect(screen.queryByLabelText('Video preview reference slots')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add image reference' })).not.toBeInTheDocument();
    const videoControls = screen.getByLabelText('Video preview parameter controls');
    expect(videoControls).toBeVisible();
    const runVideo = screen.getByRole('button', { name: '生成视频' });
    expect(screen.getByLabelText('Video generation composer')).toContainElement(runVideo);
    expect(runVideo).toHaveTextContent('生成视频');
    expect(runVideo.querySelector('svg')).toBeNull();
    expect(screen.queryByLabelText('Video preview result workspace')).not.toBeInTheDocument();
  });

  it('does not expose a second video image-reference action inside the prompt workspace', () => {
    const node = createCanvasModuleNode('video-preview-inline-reference', 'video_generation' as never, { x: 0, y: 0 });
    useAppStore.setState({ projectImages: [projectImage] } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    openVideoGenerationEditor();
    expect(screen.getByLabelText('Video preview prompt workspace')).not.toContainElement(screen.queryByRole('button', { name: 'Add image reference' }));
  });

  it('does not render a separate empty result preview before video generation completes', () => {
    const node = createCanvasModuleNode('video-preview-empty', 'video_generation' as never, { x: 0, y: 0 });

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    openVideoGenerationEditor();
    expect(screen.queryByLabelText('Video preview result workspace')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Video preview prompt workspace')).toBeVisible();
  });

  it('renders only real completed video results instead of duplicating the requested quantity', () => {
    const baseNode = createCanvasModuleNode('video-real-result-count', 'video_generation' as never, { x: 0, y: 0 });
    const node = {
      ...baseNode,
      data: {
        ...baseNode.data,
        config: {
          ...baseNode.data.config,
          outputCount: 4,
          resultState: 'fresh',
          videoResults: [{
            assetId: 'video-result-one',
            mediaType: 'video/mp4',
            durationMs: 5000,
            posterUrl: projectImage.displayUrl,
          }],
        },
      },
    };

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    expect(screen.getAllByLabelText(/Generated video preview \d/u)).toHaveLength(1);
    expect(screen.getByRole('img', { name: 'Generated video preview 1' })).toHaveAttribute('src', projectImage.displayUrl);
  });

  it('renders the latest completed video-job batch as the real 1-4 result grid', () => {
    const node = createCanvasModuleNode('video-live-result-grid', 'video_generation' as never, { x: 0, y: 0 });
    const videos = Array.from({ length: 3 }, (_, index) => ({
      ...projectVideo,
      assetId: `${index + 1}`.padStart(16, 'a'),
      displayUrl: `novus-asset://project/session/${`${index + 1}`.padStart(16, 'a')}`,
      label: `Generated video ${index + 1}`,
      durationMs: 5000,
      height: 1080,
      width: 1920,
    }));
    useAppStore.setState({
      projectVideos: videos,
      modelJobs: videos.map((video, index) => ({
        id: `video-live-job-${index + 1}`,
        kind: 'video',
        promptNodeId: node.id,
        status: 'completed',
        resultAssetId: video.assetId,
        confirmedAt: '2026-08-09T06:00:00.000Z',
        queueIndex: index,
      })),
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    expect(screen.getByLabelText('Video generation preview').querySelectorAll('.module-node__generation-preview-item')).toHaveLength(3);
    openVideoGenerationEditor();
    expect(screen.getByLabelText('Completed video results').querySelectorAll('.module-node__generation-preview-item')).toHaveLength(3);
    expect(screen.getByLabelText('Completed video results').querySelectorAll('video')).toHaveLength(3);
  });

  it('restores a durable generated video from node config when model jobs are unavailable', () => {
    const baseNode = createCanvasModuleNode('video-durable-result', 'video_generation' as never, { x: 0, y: 0 });
    const node = {
      ...baseNode,
      data: {
        ...baseNode.data,
        config: {
          ...baseNode.data.config,
          resultState: 'fresh',
          videoResults: [{
            assetId: projectVideo.assetId,
            mediaType: projectVideo.mediaType,
            durationMs: projectVideo.durationMs ?? 5000,
          }],
        },
        execution: { state: 'completed' as const },
      },
    };
    useAppStore.setState({ projectVideos: [projectVideo], modelJobs: [] } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    expect(screen.getByLabelText('Generated video preview 1 video')).toHaveAttribute('src', projectVideo.displayUrl);
    openVideoGenerationEditor();
    expect(screen.getByLabelText('Completed video result 1 video')).toHaveAttribute('src', projectVideo.displayUrl);
  });

  it('refreshes project media when a durable video result arrives before its asset summary', async () => {
    const baseNode = createCanvasModuleNode('video-result-refresh-race', 'video_generation' as never, { x: 0, y: 0 });
    const node = {
      ...baseNode,
      data: {
        ...baseNode.data,
        config: {
          ...baseNode.data.config,
          resultState: 'fresh',
          videoResults: [{
            assetId: projectVideo.assetId,
            mediaType: projectVideo.mediaType,
            durationMs: projectVideo.durationMs ?? 5_000,
          }],
        },
        execution: { state: 'completed' as const },
      },
    };
    const refreshProjectImages = vi.fn(async () => {
      useAppStore.setState({ projectVideos: [projectVideo] } as never);
    });
    useAppStore.setState({ projectVideos: [], modelJobs: [], refreshProjectImages } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    await waitFor(() => expect(refreshProjectImages).toHaveBeenCalledOnce());
    expect(screen.getByLabelText('Generated video preview 1 video')).toHaveAttribute('src', projectVideo.displayUrl);
    openVideoGenerationEditor();
    expect(screen.getByLabelText('Completed video result 1 video')).toHaveAttribute('src', projectVideo.displayUrl);
  });

  it('bounds missing video result refreshes and lets the user reload without regenerating', async () => {
    vi.useFakeTimers();
    const baseNode = createCanvasModuleNode('video-result-refresh-bounded', 'video_generation' as never, { x: 0, y: 0 });
    const node = {
      ...baseNode,
      data: {
        ...baseNode.data,
        config: {
          ...baseNode.data.config,
          resultState: 'fresh',
          videoResults: [{
            assetId: projectVideo.assetId,
            mediaType: projectVideo.mediaType,
            durationMs: projectVideo.durationMs ?? 5_000,
          }],
        },
        execution: { state: 'completed' as const },
      },
    };
    const refreshProjectImages = vi.fn(async () => undefined);
    const runVideoPreviewNode = vi.fn(async () => true);
    useAppStore.setState({
      projectVideos: [],
      modelJobs: [],
      refreshProjectImages,
      runVideoPreviewNode,
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    await act(async () => vi.runAllTimersAsync());

    expect(refreshProjectImages).toHaveBeenCalledTimes(4);
    expect(screen.queryByLabelText('Generated video preview 1 video')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveClass('module-node__generation-error--collapsed-result-refresh');
    openVideoGenerationEditor();
    expect(screen.getByLabelText('视频生成 节点状态')).toHaveTextContent('返回视频加载失败');
    expect(screen.getByRole('alert')).toHaveTextContent('返回视频加载失败，请重新加载；不会重复提交生成任务。');

    refreshProjectImages.mockImplementation(async () => {
      useAppStore.setState({ projectVideos: [projectVideo] } as never);
    });
    fireEvent.click(screen.getByRole('button', { name: '重新加载返回视频' }));
    await act(async () => vi.runAllTimersAsync());

    expect(refreshProjectImages).toHaveBeenCalledTimes(5);
    expect(screen.queryByText('返回视频加载失败，请重新加载；不会重复提交生成任务。')).not.toBeInTheDocument();
    expect(screen.getByLabelText('视频生成 节点状态')).toHaveTextContent('视频结果已就绪');
    expect(screen.getByLabelText('Completed video result 1 video')).toHaveAttribute('src', projectVideo.displayUrl);
    expect(runVideoPreviewNode).not.toHaveBeenCalled();
  });

  it('shows only the newest completed image-job batch in the generation grid', () => {
    const node = createCanvasModuleNode('image-latest-result-grid', 'image_generation', { x: 0, y: 0 });
    const oldImage = { ...projectImage, assetId: 'bbbbbbbbbbbbbbbb', displayUrl: 'novus-asset://project/session/bbbbbbbbbbbbbbbb', label: 'Old image' };
    const newImages = [
      { ...projectImage, assetId: 'cccccccccccccccc', displayUrl: 'novus-asset://project/session/cccccccccccccccc', label: 'New image A' },
      { ...projectImage, assetId: 'dddddddddddddddd', displayUrl: 'novus-asset://project/session/dddddddddddddddd', label: 'New image B' },
    ];
    useAppStore.setState({
      projectImages: [oldImage, ...newImages],
      modelJobs: [
        { id: 'old-image-job', kind: 'image', promptNodeId: node.id, status: 'completed', resultAssetId: oldImage.assetId, confirmedAt: '2026-08-09T05:00:00.000Z', queueIndex: 0 },
        ...newImages.map((image, index) => ({ id: `new-image-job-${index}`, kind: 'image' as const, promptNodeId: node.id, status: 'completed' as const, resultAssetId: image.assetId, confirmedAt: '2026-08-09T06:00:00.000Z', queueIndex: index })),
      ],
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    expect(screen.getAllByLabelText(/Generated image preview \d/u)).toHaveLength(2);
    expect(screen.queryByRole('img', { name: 'Old image' })).not.toBeInTheDocument();
  });

  it('does not report a completed image as ready when no durable or completed-job result id exists', async () => {
    const baseNode = createCanvasModuleNode('image-completed-without-result-id', 'image_generation', { x: 0, y: 0 });
    const node = {
      ...baseNode,
      data: {
        ...baseNode.data,
        config: { ...baseNode.data.config, resultState: 'fresh' },
        execution: { state: 'completed' as const },
      },
    };
    const refreshProjectImages = vi.fn(async () => undefined);
    useAppStore.setState({ projectImages: [], modelJobs: [], refreshProjectImages } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    expect(screen.getByLabelText('图片生成 节点状态')).toHaveTextContent('返图加载失败');
    expect(screen.getByLabelText('图片生成 节点状态')).not.toHaveTextContent('结果已就绪');
    expect(screen.getByRole('alert')).toHaveTextContent('返图记录缺失');
    fireEvent.click(screen.getByRole('button', { name: '重新加载返图' }));
    await waitFor(() => expect(refreshProjectImages).toHaveBeenCalledOnce());
  });

  it('reloads durable jobs before retrying a completed image with no local result record', async () => {
    const baseNode = createCanvasModuleNode('image-reload-missing-result-record', 'image_generation', { x: 0, y: 0 });
    const node = {
      ...baseNode,
      data: {
        ...baseNode.data,
        config: { ...baseNode.data.config, resultState: 'fresh' },
        execution: { state: 'completed' as const },
      },
    };
    const refreshModelJobs = vi.fn(async () => {
      useAppStore.setState({
        modelJobs: [{
          id: 'reloaded-completed-image-job',
          kind: 'image',
          modelId: 'image-model',
          promptNodeId: node.id,
          resultAssetId: projectImage.assetId,
          referenceAssetIds: [],
          retryCount: 0,
          status: 'completed',
        }],
      } as never);
    });
    const refreshProjectImages = vi.fn(async () => {
      if (useAppStore.getState().modelJobs.length > 0) {
        useAppStore.setState({ projectImages: [projectImage] } as never);
      }
    });
    useAppStore.setState({ projectImages: [], modelJobs: [], refreshModelJobs, refreshProjectImages } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();
    fireEvent.click(screen.getByRole('button', { name: '重新加载返图' }));

    await waitFor(() => expect(refreshModelJobs).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('img', { name: 'Generated image 1' })).toBeVisible());
    expect(screen.queryByText('返图记录缺失，请重新加载；不会重复提交生成任务。')).not.toBeInTheDocument();
  });

  it('recovers an image summary from a matching completed job when durable result ids are missing', async () => {
    const baseNode = createCanvasModuleNode('image-completed-job-result-repair', 'image_generation', { x: 0, y: 0 });
    const node = {
      ...baseNode,
      data: {
        ...baseNode.data,
        config: { ...baseNode.data.config, resultState: 'fresh' },
        execution: { state: 'completed' as const },
      },
    };
    const refreshProjectImages = vi.fn(async () => {
      useAppStore.setState({ projectImages: [projectImage] } as never);
    });
    useAppStore.setState({
      projectImages: [],
      modelJobs: [{
        id: 'completed-job-result-repair',
        kind: 'image',
        modelId: 'image-model',
        promptNodeId: node.id,
        resultAssetId: projectImage.assetId,
        referenceAssetIds: [],
        retryCount: 0,
        status: 'completed',
      }],
      refreshProjectImages,
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    await waitFor(() => expect(refreshProjectImages).toHaveBeenCalledOnce());
    expect(await screen.findByLabelText('Generated image preview 1')).toBeVisible();
  });

  it('restores generated images from durable resultAssetIds when model jobs are unavailable', () => {
    const baseNode = createCanvasModuleNode('image-durable-result-grid', 'image_generation', { x: 0, y: 0 });
    const generatedAssets = [projectImage, {
      ...projectImage,
      assetId: 'eeeeeeeeeeeeeeee',
      displayUrl: 'novus-asset://project/session/eeeeeeeeeeeeeeee',
      label: 'Durable generated image 2',
    }];
    const node = {
      ...baseNode,
      data: {
        ...baseNode.data,
        config: {
          ...baseNode.data.config,
          resultAssetIds: generatedAssets.map((asset) => asset.assetId),
          resultState: 'fresh',
        },
        execution: { state: 'completed' as const },
      },
    };
    useAppStore.setState({ projectImages: generatedAssets, modelJobs: [] } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    expect(screen.getAllByLabelText(/Generated image preview \d/u)).toHaveLength(2);
    openImageGenerationEditor();
    expect(screen.getAllByRole('button', { name: /Generated image \d; double click to preview/u })).toHaveLength(2);
  });

  it('refreshes project images when a completed result is durable before its asset summary arrives', async () => {
    const baseNode = createCanvasModuleNode('image-result-refresh-race', 'image_generation', { x: 0, y: 0 });
    const node = {
      ...baseNode,
      data: {
        ...baseNode.data,
        config: {
          ...baseNode.data.config,
          resultAssetIds: [projectImage.assetId],
          resultState: 'fresh',
        },
        execution: { state: 'completed' as const },
      },
    };
    const refreshProjectImages = vi.fn(async () => {
      useAppStore.setState({ projectImages: [projectImage] } as never);
    });
    useAppStore.setState({
      projectImages: [],
      modelJobs: [],
      refreshProjectImages,
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    await waitFor(() => expect(refreshProjectImages).toHaveBeenCalledOnce());
    expect(await screen.findAllByLabelText(/Generated image preview 1/u)).toHaveLength(1);
  });

  it('ignores a completed image job owned by another project session even when its node id matches', async () => {
    window.novusDesktop = createPhotoshopDesktopBridge(vi.fn()) as never;
    const persistence = createProjectPersistenceClient();
    await persistence.openProject?.();
    const node = createCanvasModuleNode('shared-image-node-id', 'image_generation', { x: 0, y: 0 });
    const refreshProjectImages = vi.fn(async () => undefined);
    useAppStore.setState({
      project: { ...useAppStore.getState().project, nodes: [node], edges: [] },
      persistenceMode: 'desktop',
      projectImages: [],
      modelJobs: [{
        id: 'foreign-completed-image-job',
        kind: 'image',
        modelId: 'foreign-image-model',
        promptNodeId: node.id,
        projectSessionId: 'another-project-session',
        referenceAssetIds: [],
        resultAssetId: projectImage.assetId,
        retryCount: 0,
        status: 'completed',
      }],
      refreshProjectImages,
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    await act(async () => Promise.resolve());

    expect(refreshProjectImages).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/Generated image preview 1/u)).not.toBeInTheDocument();
  });

  it('accepts a completed image job from the current desktop project session', async () => {
    window.novusDesktop = createPhotoshopDesktopBridge(vi.fn()) as never;
    const persistence = createProjectPersistenceClient();
    await persistence.openProject?.();
    const activeSessionId = persistence.getSessionId?.();
    const node = createCanvasModuleNode('current-session-image-node', 'image_generation', { x: 0, y: 0 });
    useAppStore.setState({
      project: { ...useAppStore.getState().project, nodes: [node], edges: [] },
      persistenceMode: 'desktop',
      projectImages: [projectImage],
      modelJobs: [{
        id: 'current-session-completed-image-job',
        kind: 'image',
        modelId: 'current-image-model',
        promptNodeId: node.id,
        projectSessionId: activeSessionId,
        referenceAssetIds: [],
        resultAssetId: projectImage.assetId,
        retryCount: 0,
        status: 'completed',
      }],
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    expect(await screen.findAllByLabelText(/Generated image preview 1/u)).toHaveLength(1);
  });

  it('accepts an old-session completed job when the durable node owns its result', async () => {
    window.novusDesktop = createPhotoshopDesktopBridge(vi.fn()) as never;
    const persistence = createProjectPersistenceClient();
    await persistence.openProject?.();
    const baseNode = createCanvasModuleNode('old-session-owned-image-node', 'image_generation', { x: 0, y: 0 });
    const jobId = 'old-session-owned-image-job';
    const node = {
      ...baseNode,
      data: {
        ...baseNode.data,
        config: {
          ...baseNode.data.config,
          lastResultJobId: jobId,
          resultAssetIds: [projectImage.assetId],
          resultState: 'fresh',
        },
        execution: { state: 'completed' as const },
      },
    };
    useAppStore.setState({
      project: { ...useAppStore.getState().project, nodes: [node], edges: [] },
      persistenceMode: 'desktop',
      projectImages: [projectImage],
      modelJobs: [{
        id: jobId,
        kind: 'image',
        modelId: 'old-session-image-model',
        promptNodeId: node.id,
        projectSessionId: 'retired-project-session',
        referenceAssetIds: [],
        resultAssetId: projectImage.assetId,
        retryCount: 0,
        status: 'completed',
      }],
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    expect(await screen.findAllByLabelText(/Generated image preview 1/u)).toHaveLength(1);
  });

  it.each(['empty', 'error'] as const)('retries project image refresh after the first completed-result refresh returns %s', async (firstAttempt) => {
    const baseNode = createCanvasModuleNode(`image-result-refresh-${firstAttempt}`, 'image_generation', { x: 0, y: 0 });
    const node = {
      ...baseNode,
      data: {
        ...baseNode.data,
        config: {
          ...baseNode.data.config,
          resultAssetIds: [projectImage.assetId],
          resultState: 'fresh',
        },
        execution: { state: 'completed' as const },
      },
    };
    const refreshProjectImages = vi.fn(async () => {
      if (refreshProjectImages.mock.calls.length === 1) {
        if (firstAttempt === 'error') throw new Error('transient asset summary failure');
        return;
      }
      useAppStore.setState({ projectImages: [projectImage] } as never);
    });
    useAppStore.setState({
      projectImages: [],
      modelJobs: [],
      refreshProjectImages,
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    await waitFor(() => expect(refreshProjectImages).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect(await screen.findAllByLabelText(/Generated image preview 1/u)).toHaveLength(1);
  });

  it('shows that the returned image is loading while its durable summary refresh is pending', () => {
    vi.useFakeTimers();
    const baseNode = createCanvasModuleNode('image-result-refresh-loading', 'image_generation', { x: 0, y: 0 });
    const node = {
      ...baseNode,
      data: {
        ...baseNode.data,
        config: { ...baseNode.data.config, resultAssetIds: [projectImage.assetId], resultState: 'fresh' },
        execution: { state: 'completed' as const },
      },
    };
    const refreshProjectImages = vi.fn(async () => undefined);
    useAppStore.setState({ projectImages: [], modelJobs: [], refreshProjectImages } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    expect(refreshProjectImages).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('图片生成 节点状态')).toHaveTextContent('正在加载返回图片');
    expect(screen.getByLabelText('图片生成 节点状态')).not.toHaveTextContent('结果已就绪');
  });

  it('refreshes and reports failure when a returned-image summary has no renderable URL', async () => {
    vi.useFakeTimers();
    const baseNode = createCanvasModuleNode('image-result-invalid-display-url', 'image_generation', { x: 0, y: 0 });
    const node = {
      ...baseNode,
      data: {
        ...baseNode.data,
        config: { ...baseNode.data.config, resultAssetIds: [projectImage.assetId], resultState: 'fresh' },
        execution: { state: 'completed' as const },
      },
    };
    const refreshProjectImages = vi.fn(async () => undefined);
    useAppStore.setState({
      projectImages: [{ ...projectImage, displayUrl: 'https://example.invalid/returned-image.png' }],
      modelJobs: [],
      refreshProjectImages,
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    await act(async () => vi.runAllTimersAsync());

    expect(refreshProjectImages).toHaveBeenCalledTimes(4);
    expect(screen.queryByLabelText(/Generated image preview 1/u)).not.toBeInTheDocument();
    openImageGenerationEditor();
    expect(screen.getByLabelText('图片生成 节点状态')).toHaveTextContent('返图加载失败');
    expect(screen.getByRole('alert')).toHaveTextContent('返图加载失败，请重新加载；不会重复提交生成任务。');
  });

  it('bounds completed-result refresh retries when an asset summary stays unavailable', async () => {
    vi.useFakeTimers();
    const baseNode = createCanvasModuleNode('image-result-refresh-bounded', 'image_generation', { x: 0, y: 0 });
    const node = {
      ...baseNode,
      data: {
        ...baseNode.data,
        config: { ...baseNode.data.config, resultAssetIds: [projectImage.assetId], resultState: 'fresh' },
        execution: { state: 'completed' as const },
      },
    };
    const refreshProjectImages = vi.fn(async () => undefined);
    useAppStore.setState({ projectImages: [], modelJobs: [], refreshProjectImages } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    await act(async () => vi.runAllTimersAsync());

    expect(refreshProjectImages).toHaveBeenCalledTimes(4);
    expect(screen.queryByLabelText(/Generated image preview 1/u)).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveClass('module-node__generation-error--collapsed-result-refresh');
    openImageGenerationEditor();
    expect(screen.getByLabelText('图片生成 节点状态')).toHaveTextContent('返图加载失败');
    expect(screen.getByRole('alert')).toHaveTextContent('返图加载失败，请重新加载；不会重复提交生成任务。');

    refreshProjectImages.mockImplementation(async () => {
      useAppStore.setState({ projectImages: [projectImage] } as never);
    });
    fireEvent.click(screen.getByRole('button', { name: '重新加载返图' }));
    await act(async () => vi.runAllTimersAsync());

    expect(refreshProjectImages).toHaveBeenCalledTimes(5);
    expect(screen.queryByText('返图加载失败，请重新加载；不会重复提交生成任务。')).not.toBeInTheDocument();
    expect(screen.getByLabelText('图片生成 节点状态')).toHaveTextContent('结果已就绪');
    expect(screen.getByRole('button', { name: 'Generated image 1; double click to preview' })).toBeInTheDocument();
  });

  it('renders a square empty image stage without inventing result tiles', () => {
    const node = createCanvasModuleNode('image-preview-empty', 'image_generation', { x: 0, y: 0 });

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    openImageGenerationEditor();
    expect(screen.getByLabelText('Image generation preview')).toHaveClass('module-node__generation-editor-preview--empty');
    expect(document.querySelector('.module-node__generation-preview-gallery')).toBeNull();
    expect(screen.getByText('图片生成 V2')).toBeVisible();
    expect(screen.getByLabelText('Image generation prompt workspace')).toBeVisible();
  });

  it('keeps a returned image but warns when its durable pixel size is below the requested 4K tier', () => {
    const node = createCanvasModuleNode('image-resolution-mismatch', 'image_generation', { x: 0, y: 0 });
    node.data.config = {
      ...node.data.config,
      requestedResolution: '4K',
      resultAssetIds: [projectImage.assetId],
      resultState: 'fresh',
    };
    const returnedImage = { ...projectImage, origin: 'generated' as const, width: 1696, height: 2528 };
    useAppStore.setState({ projectImages: [returnedImage], modelJobs: [] } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    expect(screen.getByText('请求 4K · 实际 1696×2528，供应商返回尺寸低于所选清晰度。')).toBeVisible();
    expect(screen.getByRole('img', { name: 'Generated image 1' })).toBeVisible();
  });

  it('accepts the provider maximum-pixel square size as a 4K result', () => {
    const node = createCanvasModuleNode('image-resolution-square-4k', 'image_generation', { x: 0, y: 0 });
    node.data.config = {
      ...node.data.config,
      requestedResolution: '4K',
      resultAssetIds: [projectImage.assetId],
      resultState: 'fresh',
    };
    const returnedImage = { ...projectImage, origin: 'generated' as const, width: 2880, height: 2880 };
    useAppStore.setState({ projectImages: [returnedImage], modelJobs: [] } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    expect(screen.queryByText(/供应商返回尺寸低于所选清晰度/u)).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Generated image 1' })).toBeVisible();
  });

  it('uses a true one-cell gallery only after one completed image exists', () => {
    const node = createCanvasModuleNode('image-one-result-grid', 'image_generation', { x: 0, y: 0 });
    useAppStore.setState({
      projectImages: [projectImage],
      modelJobs: [{ id: 'single-completed-image-job', kind: 'image', promptNodeId: node.id, status: 'completed', resultAssetId: projectImage.assetId }],
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    openImageGenerationEditor();
    const gallery = screen.getByLabelText('Image generation preview').querySelector('.module-node__generation-preview-gallery');
    expect(gallery).toHaveClass('module-node__generation-preview-gallery--1');
    expect(gallery?.querySelectorAll('.module-node__generation-preview-item')).toHaveLength(1);
  });

  it('uses only a completed video result poster and never promotes a connected reference into results', () => {
    const baseNode = createCanvasModuleNode('video-preview-poster', 'video_generation' as never, { x: 0, y: 0 });
    const generatedPoster = {
      ...projectImage,
      assetId: 'abcdef0123456789',
      displayUrl: 'novus-asset://project/session/abcdef0123456789',
      label: 'Generated video poster',
    };
    const node = {
      ...baseNode,
      data: {
        ...baseNode.data,
        config: {
          ...baseNode.data.config,
          referenceAssetIds: [projectImage.assetId],
          resultState: 'fresh',
          videoResults: [{
            assetId: 'video-result-poster',
            mediaType: 'video/mp4',
            durationMs: 5000,
            posterUrl: generatedPoster.displayUrl,
          }],
        },
      },
    };
    useAppStore.setState({ projectImages: [projectImage, generatedPoster] } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    openVideoGenerationEditor();
    const poster = screen.getByRole('img', { name: 'Completed video result 1' });
    expect(screen.getByLabelText('Video preview result workspace')).toContainElement(poster);
    expect(poster).toHaveAttribute('src', generatedPoster.displayUrl);
    expect(poster).not.toHaveAttribute('src', projectImage.displayUrl);
    expect(screen.queryByRole('img', { name: 'Play completed video 1' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Expand completed video 1' })).not.toBeInTheDocument();
    const stage = screen.getByLabelText('Completed video result 1');
    expect(stage).toHaveClass('module-node__video-result-stage');
    expect(stage).toHaveAttribute('data-aspect-ratio', '16:9');
  });

  it.each([6, 7, 20, 21, 25])('keeps %i connected reverse thumbnails visible even above the execution limit', (count) => {
    const images = Array.from({ length: count }, (_, index) => ({
      ...projectImage,
      assetId: `${String(index + 1).padStart(16, '0')}`,
      label: `Reverse reference ${index + 1}`,
      displayUrl: `novus-asset://project/session/reverse-${index + 1}`,
      sha256: `${String(index + 1).padStart(16, '0')}${'a'.repeat(48)}`,
    }));
    const imageNodes = images.map((asset, index) => {
      const image = createCanvasModuleNode(`reverse-twenty-image-${index + 1}`, 'image_input', { x: 0, y: index * 80 });
      image.data.config = { assetId: asset.assetId };
      return image;
    });
    const reverse = createCanvasModuleNode('reverse-twenty-target', 'reverse_agent', { x: 420, y: 0 });
    useAppStore.setState({
      project: {
        ...useAppStore.getState().project,
        nodes: [...imageNodes, reverse],
        edges: imageNodes.map((image, index) => ({
          id: `reverse-twenty-edge-${index + 1}`,
          source: image.id,
          sourcePortId: 'image',
          target: reverse.id,
          targetPortId: 'references',
          order: index,
        })),
        assets: images,
      },
      projectImages: images,
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={reverse.id} data={reverse.data} selected={false} /></ReactFlowProvider>);

    const tray = screen.getByLabelText('Connected reverse media slots');
    expect(screen.getByLabelText('Reverse media input')).toHaveTextContent(`${count} / 20`);
    expect(within(tray).getAllByLabelText(/Agent media slot \d+$/u)).toHaveLength(count);
    expect(within(tray).getByLabelText(`Agent media slot ${count}`)).toHaveTextContent(String(count));
    if (count > 10) expect(tray.querySelector('[data-overflow="true"]')).not.toBeNull();
    if (count > 20) expect(screen.getByText(/Agent 反推最多连接 20/)).toBeVisible();
  });

  it('keeps video controls in flow and reverse media in a scoped scrollable rail', () => {
    const css = readFileSync('apps/renderer/src/styles/app.css', 'utf8');
    const finalContract = css.slice(css.lastIndexOf('FINAL SCOPED MEDIA-NODE CONTRACT'));
    expect(finalContract).toMatch(/video_generation[\s\S]*?\.module-node__video-control-bar \{[\s\S]*?position: static !important;/u);
    expect(finalContract).toMatch(/reverse_agent[\s\S]*?\.module-node__agent-media-slot-row \{[\s\S]*?overflow-x: auto !important;/u);
    expect(finalContract).toContain('.module-node__agent-media-slots::before');
    expect(finalContract).toContain('content: none !important');
  });

  it('keeps video reference slots absent until media is connected', () => {
    const node = createCanvasModuleNode('video-preview-slots', 'video_generation' as never, { x: 0, y: 0 });
    useAppStore.setState({ projectImages: [projectImage] } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    expect(screen.queryByLabelText('Video preview reference slots')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add image reference' })).not.toBeInTheDocument();
  });

  it('runs a storyboard script only from a configured chat route and shows selectable persisted shots', async () => {
    const node = createCanvasModuleNode('storyboard-run', 'storyboard_sheet', { x: 0, y: 0 });
    const generateStoryboardNode = vi.fn(async () => true);
    useAppStore.setState({ generateStoryboardNode } as never);
    const data = {
      ...node.data,
      storyboardRoutes: [{ provider: 'comfly', modelRoute: 'scene-chat', displayName: 'Scene Chat', capabilities: ['chat'] }],
    } as typeof node.data;
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'Open storyboard composer' }));
    fireEvent.change(screen.getByLabelText('Storyboard script'), { target: { value: 'A quiet studio product reveal.' } });
    fireEvent.change(screen.getByLabelText('Storyboard shot count'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate storyboard' }));
    expect(generateStoryboardNode).toHaveBeenCalledWith('storyboard-run', {
      modelRoute: 'scene-chat', script: 'A quiet studio product reveal.', shotCount: 2, referenceAssetIds: [],
    });

    const completedData = {
      ...data,
      config: {
        script: 'A quiet studio product reveal.', modelRoute: 'scene-chat', shotCount: 1,
        shots: [{ id: 'shot-1', order: 1, title: 'Opening', composition: 'Wide studio view', durationSeconds: 4, referenceAssetIds: [] }],
      },
    };
    const { rerender } = render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={completedData} selected={false} /></ReactFlowProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Select storyboard shot Opening' }));
    expect(screen.getByLabelText('Shot composition')).toHaveValue('Wide studio view');
    rerender(<ReactFlowProvider><ModuleNodeCard id={node.id} data={completedData} selected={false} /></ReactFlowProvider>);
  });

  it('uses the shared node workbench shell for storyboard configuration and results', () => {
    const node = createCanvasModuleNode('storyboard-shell', 'storyboard_sheet', { x: 0, y: 0 });
    const data = {
      ...node.data,
      storyboardRoutes: [{ provider: 'comfly', modelRoute: 'scene-chat', displayName: 'Scene Chat', capabilities: ['chat'] }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    expect(screen.getByLabelText('分镜表 节点状态')).toBeVisible();
    expect(screen.getByLabelText('分镜表 节点配置')).toContainElement(screen.getByRole('button', { name: 'Open storyboard composer' }));
    expect(screen.getByLabelText('分镜表 节点结果')).toBeVisible();
  });

  it('routes one selected storyboard shot to an existing image-generation node with managed references', () => {
    const storyboard = createCanvasModuleNode('storyboard-shot-run', 'storyboard_sheet', { x: 0, y: 0 });
    const imageGeneration = createCanvasModuleNode('shot-image-target', 'image_generation', { x: 260, y: 0 });
    const runImageGenerationNode = vi.fn(async () => true);
    useAppStore.setState({
      project: { ...useAppStore.getState().project, nodes: [storyboard, imageGeneration] },
      projectImages: [projectImage],
      runImageGenerationNode,
    } as never);
    const data = {
      ...storyboard.data,
      config: {
        shots: [{
          id: 'shot-1', order: 1, title: 'Opening', composition: 'Wide studio view', durationSeconds: 4,
          referenceAssetIds: [projectImage.assetId],
        }],
      },
    } as typeof storyboard.data;

    render(<ReactFlowProvider><ModuleNodeCard id={storyboard.id} data={data} selected={false} /></ReactFlowProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'Select storyboard shot Opening' }));
    fireEvent.change(screen.getByLabelText('Target image-generation node'), { target: { value: imageGeneration.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Run selected storyboard shot' }));

    expect(runImageGenerationNode).toHaveBeenCalledWith(imageGeneration.id, {
      prompt: 'Wide studio view',
      aspectRatio: '16:9',
      resolution: '1024x1024',
      outputCount: 1,
      referenceAssetIds: [projectImage.assetId],
    });
  });

  it('persists edited storyboard-shot composition, parameters, and managed references', () => {
    const node = createCanvasModuleNode('storyboard-shot-save', 'storyboard_sheet', { x: 0, y: 0 });
    const updateStoryboardShot = vi.fn(async () => true);
    useAppStore.setState({ projectImages: [projectImage], updateStoryboardShot } as never);
    const data = {
      ...node.data,
      config: {
        shots: [{
          id: 'shot-1', order: 1, title: 'Opening', composition: 'Wide studio view', durationSeconds: 4,
          referenceAssetIds: [],
        }],
      },
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'Select storyboard shot Opening' }));
    fireEvent.change(screen.getByLabelText('Shot composition'), { target: { value: 'Close product reveal' } });
    fireEvent.change(screen.getByLabelText('Shot aspect ratio'), { target: { value: '9:16' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use Product front for shot' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save storyboard shot' }));

    expect(updateStoryboardShot).toHaveBeenCalledWith(node.id, 'shot-1', {
      composition: 'Close product reveal',
      aspectRatio: '9:16',
      resolution: '1024x1024',
      outputCount: 1,
      referenceAssetIds: [projectImage.assetId],
    });
  });

  it('limits storyboard shot references to twenty managed images in the editor', () => {
    const node = createCanvasModuleNode('storyboard-shot-reference-limit', 'storyboard_sheet', { x: 0, y: 0 });
    const images = Array.from({ length: 21 }, (_, index) => ({
      ...projectImage,
      assetId: (index + 1).toString(16).padStart(16, '0'),
      label: `Reference ${index + 1}`,
    }));
    useAppStore.setState({ projectImages: images } as never);
    const data = {
      ...node.data,
      config: {
        shots: [{
          id: 'shot-1', order: 1, title: 'Opening', composition: 'Wide studio view', durationSeconds: 4,
          referenceAssetIds: images.slice(0, 20).map((image) => image.assetId),
        }],
      },
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'Select storyboard shot Opening' }));

    expect(screen.getByRole('checkbox', { name: 'Use Reference 20 for shot' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Use Reference 21 for shot' })).toBeDisabled();
  });

  it('shows a controlled storyboard error after a failed generation request', async () => {
    const node = createCanvasModuleNode('storyboard-run-failure', 'storyboard_sheet', { x: 0, y: 0 });
    const generateStoryboardNode = vi.fn(async () => false);
    useAppStore.setState({ generateStoryboardNode } as never);
    const data = {
      ...node.data,
      storyboardRoutes: [{ provider: 'comfly', modelRoute: 'scene-chat', displayName: 'Scene Chat', capabilities: ['chat'] }],
    } as typeof node.data;
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'Open storyboard composer' }));
    fireEvent.change(screen.getByLabelText('Storyboard script'), { target: { value: 'A quiet product reveal.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate storyboard' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Storyboard generation could not be completed'));
  });

  it('submits the selected image controls with its direct prompt', () => {
    const node = createCanvasModuleNode('generator-parameters', 'image_generation', { x: 0, y: 0 });
    const data = {
      ...node.data,
      imageGenerationRoutes: [{
        provider: 'comfly',
        modelRoute: 'image-gen',
        displayName: 'Image Gen',
        modelId: 'image-gen',
        capabilities: ['image_generation'],
      }],
    } as typeof node.data;
    const runImageGenerationNode = vi.fn(async () => true);
    useAppStore.setState({ runImageGenerationNode } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    openImageGenerationEditor();
    fireEvent.change(screen.getByLabelText('Image generation prompt'), { target: { value: 'A framed product scene' } });
    chooseGenerationParameterOption('Image generation aspect ratio', '16:9');
    chooseGenerationParameterOption('Image generation resolution', '4K');
    fireEvent.change(screen.getByLabelText('Image generation quantity'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));

    expect(runImageGenerationNode).toHaveBeenCalledWith('generator-parameters', {
      modelRoute: 'image-gen',
      prompt: 'A framed product scene',
      aspectRatio: '16:9',
      resolution: '4K',
      outputCount: 2,
    });
  });

  it('opens a full-size generated-image preview on double click and exposes the right-click image menu', () => {
    const node = createCanvasModuleNode('generator-preview-actions', 'image_generation', { x: 0, y: 0 });
    useAppStore.setState({
      projectImages: [projectImage],
      modelJobs: [{ id: 'completed-preview-job', promptNodeId: node.id, status: 'completed', resultAssetId: projectImage.assetId }],
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    openImageGenerationEditor();
    const generatedImage = screen.getByRole('button', { name: 'Generated image 1; double click to preview' });
    fireEvent.doubleClick(generatedImage);
    expect(screen.getByRole('dialog', { name: 'Generated image preview' })).toBeVisible();
    expect(screen.getByRole('img', { name: 'Generated image 1 full preview' })).toHaveAttribute('src', projectImage.displayUrl);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Generated image preview' })).toBeNull();

    fireEvent.contextMenu(generatedImage, { clientX: 120, clientY: 80 });
    expect(screen.getByRole('menu', { name: 'Generated image actions' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: '发送到 AI 对话' })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: '发送到画布' })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: '复制图片' })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: '下载图片' })).toBeEnabled();
  });

  it.each(['jpg', 'webp'] as const)('downloads generated %s images using their actual format extension', (extension) => {
    const node = createCanvasModuleNode('generated-download-format', 'image_generation', { x: 0, y: 0 });
    node.data.config = { ...node.data.config, colorCorrection: ORIGINAL_IMAGE_COLOR_CORRECTION };
    const asset = { ...projectImage, extension, mediaType: extension === 'jpg' ? 'image/jpeg' : 'image/webp' };
    useAppStore.setState({ projectImages: [asset], modelJobs: [{ id: 'download-format-job', promptNodeId: node.id, status: 'completed', resultAssetId: asset.assetId }] } as never);
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} /></ReactFlowProvider>);
    openImageGenerationEditor();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Generated image 1; double click to preview' }));
    let filename = '';
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { filename = this.download; });
    try {
      fireEvent.click(screen.getByRole('menuitem', { name: '下载图片' }));
      expect(filename).toBe(`${asset.label}.${extension}`);
    } finally { click.mockRestore(); }
  });

  it('opens Agent before sending a generated image reference from the right-click menu', async () => {
    const node = createCanvasModuleNode('generator-send-agent', 'image_generation', { x: 0, y: 0 });
    useAppStore.setState({
      projectImages: [projectImage],
      modelJobs: [{ id: 'send-agent-job', promptNodeId: node.id, status: 'completed', resultAssetId: projectImage.assetId }],
    } as never);
    const openAgent = vi.fn();
    const sendToAgent = vi.fn();
    window.addEventListener('novus:open-agent', openAgent);
    window.addEventListener('novus:generated-image-to-agent', sendToAgent);
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    openImageGenerationEditor();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Generated image 1; double click to preview' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '发送到 AI 对话' }));

    await waitFor(() => expect(openAgent).toHaveBeenCalledOnce());
    await waitFor(() => expect(sendToAgent).toHaveBeenCalledWith(expect.objectContaining({ detail: { assetId: projectImage.assetId } })));
    window.removeEventListener('novus:open-agent', openAgent);
    window.removeEventListener('novus:generated-image-to-agent', sendToAgent);
  });

  it('dispatches the managed asset when sending a generated image to canvas', () => {
    const node = createCanvasModuleNode('generator-send-canvas', 'image_generation', { x: 0, y: 0 });
    useAppStore.setState({ projectImages: [projectImage], modelJobs: [{ id: 'send-canvas-job', promptNodeId: node.id, status: 'completed', resultAssetId: projectImage.assetId }] } as never);
    const listener = vi.fn();
    window.addEventListener('novus:generated-image-to-canvas', listener);
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Generated image 1; double click to preview' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '发送到画布' }));
    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0]![0] as CustomEvent).detail).toEqual({ assetId: projectImage.assetId });
    window.removeEventListener('novus:generated-image-to-canvas', listener);
  });

  it('keeps the generated-image action menu available from the collapsed preview', () => {
    const node = createCanvasModuleNode('generator-collapsed-preview-actions', 'image_generation', { x: 0, y: 0 });
    useAppStore.setState({
      projectImages: [projectImage],
      modelJobs: [{ id: 'completed-collapsed-preview-job', promptNodeId: node.id, status: 'completed', resultAssetId: projectImage.assetId }],
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    const collapsedPreview = screen.getByRole('button', { name: 'Open image generation editor' });
    fireEvent.contextMenu(collapsedPreview, { clientX: 240, clientY: 160 });

    expect(screen.getByRole('menu', { name: 'Generated image actions' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: '发送到 AI 对话' })).toBeEnabled();
  });

  it('imports the selected generated original to Photoshop once', async () => {
    let resolveImport!: (result: { ok: true; layerName: string }) => void;
    const importToPhotoshop = vi.fn(() => new Promise<{ ok: true; layerName: string }>((resolve) => {
      resolveImport = resolve;
    }));
    const bridge = createPhotoshopDesktopBridge(importToPhotoshop);
    window.novusDesktop = bridge as never;
    const persistence = createProjectPersistenceClient();
    await persistence.openProject?.();

    const node = createCanvasModuleNode('generator-photoshop-action', 'image_generation', { x: 0, y: 0 });
    const generatedAsset = { ...projectImage, origin: 'generated' as const };
    useAppStore.setState({
      projectImages: [generatedAsset],
      modelJobs: [{ id: 'completed-photoshop-job', promptNodeId: node.id, status: 'completed', resultAssetId: generatedAsset.assetId }],
    } as never);
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    openImageGenerationEditor();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Generated image 1; double click to preview' }));
    const action = screen.getByRole('menuitem', { name: '导入 Photoshop（智能对象）' });
    fireEvent.click(action);
    fireEvent.click(action);

    expect(importToPhotoshop).toHaveBeenCalledTimes(1);
    expect(importToPhotoshop).toHaveBeenCalledWith({ assetId: generatedAsset.assetId, sessionId: 'photoshop-session' });
    expect(action).toBeDisabled();
    expect(action).toHaveTextContent('正在导入…');

    resolveImport({ ok: true, layerName: generatedAsset.label });
    expect(await screen.findByRole('status')).toHaveTextContent('已导入当前 Photoshop 文档');
  });

  it('imports the selected image from a RelayMe multi-image result to Photoshop', async () => {
    const importToPhotoshop = vi.fn().mockResolvedValue({ ok: true, layerName: 'Generated image 2' });
    const bridge = createPhotoshopDesktopBridge(importToPhotoshop);
    window.novusDesktop = bridge as never;
    const persistence = createProjectPersistenceClient();
    await persistence.openProject?.();

    const node = createCanvasModuleNode('generator-multi-image-photoshop', 'image_generation', { x: 0, y: 0 });
    const firstAsset = { ...projectImage, origin: 'generated' as const };
    const secondAsset = {
      ...projectImage,
      assetId: '2222222222222222',
      label: 'Generated image 2',
      displayUrl: 'novus-asset://project/photoshop-session/2222222222222222',
      origin: 'generated' as const,
    };
    node.data.config = {
      ...node.data.config,
      resultAssetIds: [firstAsset.assetId, secondAsset.assetId],
      resultState: 'fresh',
    };
    useAppStore.setState({ projectImages: [firstAsset, secondAsset] } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    openImageGenerationEditor();
    expect(screen.getAllByRole('button', { name: /Generated image \d; double click to preview/u })).toHaveLength(2);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Generated image 2; double click to preview' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '导入 Photoshop（智能对象）' }));

    expect(importToPhotoshop).toHaveBeenCalledOnce();
    expect(importToPhotoshop).toHaveBeenCalledWith({ assetId: secondAsset.assetId, sessionId: 'photoshop-session' });
    expect(await screen.findByRole('status')).toHaveTextContent('已导入当前 Photoshop 文档');
  });

  it('shows the fixed Photoshop failure message', async () => {
    const importToPhotoshop = vi.fn().mockResolvedValue({ ok: false, code: 'no_active_document' });
    const bridge = createPhotoshopDesktopBridge(importToPhotoshop);
    window.novusDesktop = bridge as never;
    const persistence = createProjectPersistenceClient();
    await persistence.openProject?.();

    const node = createCanvasModuleNode('generator-photoshop-error', 'image_generation', { x: 0, y: 0 });
    const generatedAsset = { ...projectImage, origin: 'generated' as const };
    useAppStore.setState({
      projectImages: [generatedAsset],
      modelJobs: [{ id: 'failed-photoshop-job', promptNodeId: node.id, status: 'completed', resultAssetId: generatedAsset.assetId }],
    } as never);
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    openImageGenerationEditor();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Generated image 1; double click to preview' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '导入 Photoshop（智能对象）' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('请先在 Photoshop 中打开 PSD 或 PSB 文档');
  });

  it('turns the video primary action into stop generation for the active node job', () => {
    const node = createCanvasModuleNode('video-generator-cancel', 'video_generation', { x: 0, y: 0 });
    const cancelModelJob = vi.fn(async () => {});
    const runVideoPreviewNode = vi.fn(async () => true);
    useAppStore.setState({
      cancelModelJob,
      runVideoPreviewNode,
      modelJobs: [
        { id: 'other-video-job', promptNodeId: 'other-node', status: 'running' },
        { id: 'node-video-job', promptNodeId: node.id, status: 'running' },
      ],
    } as never);

    render(
      <ReactFlowProvider>
        <ModuleNodeCard id={node.id} data={node.data} selected={false} />
      </ReactFlowProvider>,
    );

    openVideoGenerationEditor();
    fireEvent.click(screen.getByRole('button', { name: '停止生成' }));

    expect(cancelModelJob).toHaveBeenCalledWith('node-video-job');
    expect(cancelModelJob).not.toHaveBeenCalledWith('other-video-job');
    expect(runVideoPreviewNode).not.toHaveBeenCalled();
  });
  it('shows a visible error when image generation cannot be started', async () => {
    const node = createCanvasModuleNode('generator-start-failure', 'image_generation', { x: 0, y: 0 });
    const runImageGenerationNode = vi.fn(async () => false);
    const data = {
      ...node.data,
      imageGenerationRoutes: [{ provider: 'comfly', modelRoute: 'image-gen', displayName: 'GPT Image 2', modelId: 'gpt-image-2', capabilities: ['image_generation'] }],
    } as typeof node.data;
    useAppStore.setState({ runImageGenerationNode } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();
    fireEvent.change(screen.getByLabelText('Image generation prompt'), { target: { value: 'A product image' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('生成未启动'));
    fireEvent.click(screen.getByRole('button', { name: '重新尝试生成' }));
    await waitFor(() => expect(runImageGenerationNode).toHaveBeenCalledTimes(2));
  });

  it('shows the real safe reason when the selected image model route is unavailable', async () => {
    const node = createCanvasModuleNode('generator-route-failure', 'image_generation', { x: 0, y: 0 });
    const runImageGenerationNode = vi.fn(async () => {
      throw Object.assign(new Error('Selected provider route is unavailable'), { code: 'MODEL_ROUTE_UNAVAILABLE' });
    });
    const data = {
      ...node.data,
      imageGenerationRoutes: [{ provider: 'comfly', modelRoute: 'image-gen', displayName: 'Nano Banana Pro', modelId: 'nano-banana-pro', capabilities: ['image_generation'] }],
    } as typeof node.data;
    useAppStore.setState({ runImageGenerationNode } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();
    fireEvent.change(screen.getByLabelText('Image generation prompt'), { target: { value: 'A product image' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('当前选择的模型已失效'));
    expect(screen.getByRole('alert')).not.toHaveTextContent('API 密钥');
  });

  it('identifies a RelayMe submission failure instead of showing a generic configuration error', async () => {
    const node = createCanvasModuleNode('relayme-submit-failure', 'image_generation', { x: 0, y: 0 });
    const runImageGenerationNode = vi.fn(async () => {
      throw Object.assign(new Error('RelayMe 生图任务提交失败'), { code: 'PROVIDER_ERROR' });
    });
    const data = {
      ...node.data,
      imageGenerationRoutes: [{ provider: 'relayme', modelRoute: 'relayme-gpt-image-2', displayName: 'GPT Image 2', modelId: 'gpt-image-2', capabilities: ['image_generation'] }],
    } as typeof node.data;
    useAppStore.setState({ runImageGenerationNode } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();
    fireEvent.change(screen.getByLabelText('Image generation prompt'), { target: { value: 'A product image' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('RelayMe 生图请求失败'));
  });

  it('explains that a recovery preview must be restored before generation', async () => {
    const node = createCanvasModuleNode('generator-recovery-failure', 'image_generation', { x: 0, y: 0 });
    const runImageGenerationNode = vi.fn(async () => {
      throw Object.assign(new Error('Recovery preview is protected'), { code: 'RECOVERY_REQUIRED' });
    });
    const data = {
      ...node.data,
      imageGenerationRoutes: [{ provider: 'comfly', modelRoute: 'image-gen', displayName: 'Nano Banana 2', modelId: 'nano-banana-2', capabilities: ['image_generation'] }],
    } as typeof node.data;
    useAppStore.setState({ runImageGenerationNode } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();
    fireEvent.change(screen.getByLabelText('Image generation prompt'), { target: { value: 'A product image' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('先恢复并继续当前项目'));
    expect(screen.getByRole('alert')).not.toHaveTextContent('API 密钥');
  });

  it('shows the failed provider job on the image generation node', () => {
    const node = createCanvasModuleNode('generator-provider-failure', 'image_generation', { x: 0, y: 0 });
    const data = {
      ...node.data,
      imageGenerationRoutes: [{ provider: 'relayme', modelRoute: 'relay-image', displayName: 'NanoBanana Pro', modelId: 'nano-banana-pro', capabilities: ['image_generation'] }],
    } as typeof node.data;
    useAppStore.setState({
      modelJobs: [{
        id: 'failed-image-job',
        kind: 'image',
        promptNodeId: node.id,
        status: 'failed',
        error: 'Provider authentication failed with status 401',
        updatedAt: '2026-08-12T00:00:00.000Z',
      }],
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    expect(screen.getByRole('alert')).toHaveTextContent('API 密钥认证失败');
  });

  it('reports a Comfly 503 as temporary model service unavailability instead of an API configuration error', () => {
    const node = createCanvasModuleNode('generator-comfly-503', 'image_generation', { x: 0, y: 0 });
    const data = {
      ...node.data,
      imageGenerationRoutes: [{
        provider: 'comfly',
        modelRoute: 'comfly-gpt-image-2-5-sunburst-2k',
        displayName: 'GPT Image 2.5 Sunburst 2K',
        modelId: 'gpt-image-2.5-sunburst-2k',
        capabilities: ['image_generation'],
      }],
    } as typeof node.data;
    useAppStore.setState({
      modelJobs: [{
        id: 'failed-comfly-503-image-job',
        kind: 'image',
        provider: 'comfly',
        modelRoute: 'comfly-gpt-image-2-5-sunburst-2k',
        promptNodeId: node.id,
        status: 'failed',
        error: 'Comfly request failed with status 503 for [redacted] [model=gpt-image-2.5-sunburst-2k]',
        updatedAt: '2026-09-10T05:49:50.626Z',
      }],
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    expect(screen.getByRole('alert')).toHaveTextContent('Comfly 模型服务暂时不可用（503）');
    expect(screen.getByRole('alert')).toHaveTextContent('稍后重试或切换其他生图模型');
    expect(screen.getByRole('alert')).not.toHaveTextContent('检查模型与 API 配置');
  });

  it('hides a failed image job after the node prompt has been edited', () => {
    const node = createCanvasModuleNode('generator-edited-after-failure', 'image_generation', { x: 0, y: 0 });
    node.data.config = {
      ...node.data.config,
      prompt: 'Edited prompt for the next generation',
      modelRoute: 'image-route',
    };
    const data = {
      ...node.data,
      imageGenerationRoutes: [{ provider: 'comfly', modelRoute: 'image-route', displayName: 'Image route', modelId: 'image-route', capabilities: ['image_generation'] }],
    } as typeof node.data;
    useAppStore.setState({
      modelJobs: [{
        id: 'failed-before-prompt-edit',
        kind: 'image',
        modelRoute: 'image-route',
        promptNodeId: node.id,
        prompt: 'Original failed prompt',
        status: 'failed',
        error: 'Provider authentication failed with status 401',
        startedAt: '2026-09-09T00:59:55.000Z',
        completedAt: '2026-09-09T01:00:00.000Z',
        updatedAt: '2026-09-09T01:00:00.000Z',
      }],
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Image generation task timing')).not.toBeInTheDocument();
  });

  it('shows the real RelayMe route failure instead of a generic API configuration message', () => {
    const node = createCanvasModuleNode('generator-relayme-route-failure', 'image_generation', { x: 0, y: 0 });
    const data = {
      ...node.data,
      imageGenerationRoutes: [{ provider: 'relayme', modelRoute: 'relayme-rena2', displayName: 'RENA2', modelId: 'RENA2', capabilities: ['image_generation'] }],
    } as typeof node.data;
    useAppStore.setState({
      modelJobs: [{
        id: 'failed-relayme-route-job',
        kind: 'image',
        modelRoute: 'relayme-rena2',
        promptNodeId: node.id,
        status: 'failed',
        error: '所选 RelayMe 模型不可用或能力不匹配',
        updatedAt: '2026-08-30T06:00:00.000Z',
      }],
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    expect(screen.getByRole('alert')).toHaveTextContent('当前 RelayMe 模型路线不可用');
    expect(screen.getByRole('alert')).not.toHaveTextContent('检查模型与 API 配置');
  });

  it('shows the actual RelayMe balance failure instead of blaming API configuration', () => {
    const node = createCanvasModuleNode('generator-relayme-balance-failure', 'image_generation', { x: 0, y: 0 });
    node.data.config = { ...node.data.config, modelRoute: 'relayme-rena2' };
    const data = {
      ...node.data,
      imageGenerationRoutes: [{ provider: 'relayme', modelRoute: 'relayme-rena2', displayName: 'RENA2', modelId: 'RENA2', capabilities: ['image_generation'] }],
    } as typeof node.data;
    useAppStore.setState({ modelJobs: [{
      id: 'failed-relayme-balance-job', kind: 'image', provider: 'relayme', modelRoute: 'relayme-rena2',
      promptNodeId: node.id, status: 'failed', error: 'Insufficient balance. Please recharge and try again.',
      updatedAt: '2026-09-10T23:58:36.403Z',
    }] } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    expect(screen.getByRole('alert')).toHaveTextContent('RelayMe 账户余额不足');
    expect(screen.getByRole('alert')).toHaveTextContent('充值或切换其他供应商模型');
    expect(screen.getByRole('alert')).not.toHaveTextContent('检查模型与 API 配置');
  });

  it('reports a Comfly 502 as an upstream service failure instead of an API configuration error', () => {
    const node = createCanvasModuleNode('generator-comfly-502', 'image_generation', { x: 0, y: 0 });
    const data = {
      ...node.data,
      imageGenerationRoutes: [{
        provider: 'comfly',
        modelRoute: 'comfly-gpt-image-2-5-flare',
        displayName: 'GPT Image 2.5 Flare',
        modelId: 'gpt-image-2.5-flare',
        capabilities: ['image_generation'],
      }],
    } as typeof node.data;
    useAppStore.setState({
      modelJobs: [{
        id: 'failed-comfly-502-image-job',
        kind: 'image',
        provider: 'comfly',
        modelRoute: 'comfly-gpt-image-2-5-flare',
        promptNodeId: node.id,
        status: 'failed',
        error: 'Comfly request failed with status 502 for [redacted] [model=gpt-image-2.5-flare]: Upstream service error',
        updatedAt: '2026-09-12T01:28:44.714Z',
      }],
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    expect(screen.getByRole('alert')).toHaveTextContent('Comfly 上游服务暂时异常（502）');
    expect(screen.getByRole('alert')).toHaveTextContent('稍后重试或切换其他生图模型');
    expect(screen.getByRole('alert')).not.toHaveTextContent('检查模型与 API 配置');
  });

  it('identifies a Comfly route mismatch without blaming RelayMe', () => {
    const node = createCanvasModuleNode('generator-comfly-route-failure', 'image_generation', { x: 0, y: 0 });
    const data = {
      ...node.data,
      imageGenerationRoutes: [{ provider: 'comfly', modelRoute: 'comfly-image', displayName: 'Comfly Image', modelId: 'comfly-image', capabilities: ['image_generation'] }],
    } as typeof node.data;
    useAppStore.setState({
      modelJobs: [{
        id: 'failed-comfly-route-job',
        kind: 'image',
        modelId: 'comfly-image',
        modelRoute: 'comfly-image',
        provider: 'comfly',
        promptNodeId: node.id,
        status: 'failed',
        referenceAssetIds: [],
        retryCount: 0,
        error: '所选模型不可用或能力不匹配',
        updatedAt: '2026-09-07T06:00:00.000Z',
      }],
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    expect(screen.getByRole('alert')).toHaveTextContent('当前 Comfly 模型路线不可用');
    expect(screen.getByRole('alert')).not.toHaveTextContent('RelayMe');
  });

  it('shows an actionable local-state reason when the provider task ledger is unavailable', () => {
    const node = createCanvasModuleNode('generator-task-ledger-failure', 'image_generation', { x: 0, y: 0 });
    const data = {
      ...node.data,
      imageGenerationRoutes: [{ provider: 'relayme', modelRoute: 'relay-image', displayName: 'Nano Banana Pro', modelId: 'nano-banana-pro', capabilities: ['image_generation'] }],
    } as typeof node.data;
    useAppStore.setState({
      modelJobs: [{
        id: 'failed-task-ledger-job',
        kind: 'image',
        promptNodeId: node.id,
        status: 'failed',
        error: 'Provider task mapping is unavailable',
        updatedAt: '2026-08-28T08:28:24.941Z',
      }],
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    expect(screen.getByRole('alert')).toHaveTextContent('本地模型任务状态不可用');
    expect(screen.getByRole('alert')).toHaveTextContent('重启应用');
  });

  it.each(['completed', 'running', 'cancelled'] as const)('does not resurrect an old model error after a newer %s job on another route', (status) => {
    const node = createCanvasModuleNode('image-error-history', 'image_generation', { x: 0, y: 0 });
    node.data.config = { prompt: 'Product image', modelRoute: 'image-old', aspectRatio: '1:1', resolution: '2K', outputCount: 1 };
    const data = { ...node.data, imageGenerationRoutes: [
      { provider: 'comfly', modelRoute: 'image-old', displayName: 'Old image model', capabilities: ['image_generation'] },
      { provider: 'comfly', modelRoute: 'image-new', displayName: 'New image model', capabilities: ['image_generation'] },
    ] } as typeof node.data;
    useAppStore.setState({ modelJobs: [
      { id: 'old-failure', kind: 'image', promptNodeId: node.id, modelRoute: 'image-old', status: 'failed', error: '所选 Comfly 模型不可用或能力不匹配', updatedAt: '2026-09-09T00:00:00.000Z' },
      { id: 'new-attempt', kind: 'image', promptNodeId: node.id, modelRoute: 'image-new', status, updatedAt: '2026-09-09T00:01:00.000Z' },
    ] } as never);
    const view = render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} /></ReactFlowProvider>);
    openImageGenerationEditor();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    view.rerender(<ReactFlowProvider><ModuleNodeCard id={node.id} data={{ ...data }} /></ReactFlowProvider>);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    view.unmount();
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={JSON.parse(JSON.stringify(data))} /></ReactFlowProvider>);
    openImageGenerationEditor();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the exact saved image variant when same-name catalog entries change order', () => {
    const node = createCanvasModuleNode('image-saved-variant', 'image_generation', { x: 0, y: 0 });
    node.data.config = { prompt: 'Product image', modelRoute: 'image-4k', aspectRatio: '1:1', resolution: '4K', outputCount: 1 };
    const routes = [
      { provider: 'comfly', modelRoute: 'image-base', displayName: 'Nano Banana 2', capabilities: ['image_generation', 'image_edit'] },
      { provider: 'comfly', modelRoute: 'image-4k', displayName: 'Nano Banana 2', capabilities: ['image_generation', 'image_edit'] },
    ];
    useAppStore.setState({ project: { ...useAppStore.getState().project, nodes: [node], edges: [] } });
    const view = render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={{ ...node.data, imageGenerationRoutes: routes }} /></ReactFlowProvider>);
    openImageGenerationEditor();
    expect(screen.getByLabelText('Image generation model route')).toHaveValue('image-4k');
    view.rerender(<ReactFlowProvider><ModuleNodeCard id={node.id} data={{ ...node.data, imageGenerationRoutes: [...routes].reverse() }} /></ReactFlowProvider>);
    expect(screen.getByLabelText('Image generation model route')).toHaveValue('image-4k');
    expect((useAppStore.getState().project.nodes[0] as typeof node | undefined)?.data.config).toEqual(node.data.config);
  });

  it('hydrates a saved image variant that arrives after the catalog default without writing the default back', async () => {
    const node = createCanvasModuleNode('image-late-saved-variant', 'image_generation', { x: 0, y: 0 });
    node.data.config = { prompt: 'Product image', aspectRatio: '1:1', resolution: '2K', outputCount: 1 };
    const initialRoutes = [
      { provider: 'comfly', modelRoute: 'image-default', displayName: 'Nano Banana 2', capabilities: ['image_generation', 'image_edit'] },
    ];
    const routes = [
      ...initialRoutes,
      { provider: 'comfly', modelRoute: 'image-4k', displayName: 'Nano Banana 2', capabilities: ['image_generation', 'image_edit'] },
    ];
    useAppStore.setState({ project: { ...useAppStore.getState().project, nodes: [node], edges: [] } });
    const view = render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={{ ...node.data, imageGenerationRoutes: initialRoutes }} /></ReactFlowProvider>);
    openImageGenerationEditor();
    await waitFor(() => expect(screen.getByLabelText('Image generation model route')).toHaveValue('image-default'));

    const savedNode = {
      ...node,
      data: {
        ...node.data,
        config: { ...node.data.config, modelRoute: 'image-4k', modelDisplayName: 'Nano Banana 2', resolution: '4K', resultState: 'fresh' },
      },
    };
    useAppStore.setState({ project: { ...useAppStore.getState().project, nodes: [savedNode] } });
    view.rerender(<ReactFlowProvider><ModuleNodeCard id={node.id} data={{ ...savedNode.data, imageGenerationRoutes: routes }} /></ReactFlowProvider>);

    await waitFor(() => expect(screen.getByLabelText('Image generation model route')).toHaveValue('image-4k'));
    expect((useAppStore.getState().project.nodes[0] as typeof savedNode | undefined)?.data.config.modelRoute).toBe('image-4k');
  });

  it('does not show a failed job from a previously selected image model', () => {
    const node = createCanvasModuleNode('generator-stale-model-failure', 'image_generation', { x: 0, y: 0 });
    node.data.config = { ...node.data.config, modelRoute: 'nano-banana-2-route' };
    const data = {
      ...node.data,
      imageGenerationRoutes: [
        { provider: 'comfly', modelRoute: 'nano-banana-2-route', displayName: 'Nano Banana 2', modelId: 'nano-banana-2', capabilities: ['image_generation'] },
        { provider: 'comfly', modelRoute: 'gemini-lite-route', displayName: 'Gemini Lite Image', modelId: 'gemini-lite-image', capabilities: ['image_generation'] },
      ],
    } as typeof node.data;
    useAppStore.setState({
      modelJobs: [{
        id: 'failed-old-model-job',
        kind: 'image',
        promptNodeId: node.id,
        modelRoute: 'gemini-lite-route',
        status: 'failed',
        error: 'Generated result was invalid',
        updatedAt: '2026-08-14T05:32:38.593Z',
      }],
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('explains an invalid provider image result without blaming the API key', () => {
    const node = createCanvasModuleNode('generator-invalid-result', 'image_generation', { x: 0, y: 0 });
    node.data.config = { ...node.data.config, modelRoute: 'nano-banana-2-route' };
    const data = {
      ...node.data,
      imageGenerationRoutes: [{ provider: 'comfly', modelRoute: 'nano-banana-2-route', displayName: 'Nano Banana 2', modelId: 'nano-banana-2', capabilities: ['image_generation'] }],
    } as typeof node.data;
    useAppStore.setState({
      modelJobs: [{
        id: 'failed-invalid-result-job',
        kind: 'image',
        promptNodeId: node.id,
        modelRoute: 'nano-banana-2-route',
        status: 'failed',
        error: 'Generated result was invalid',
        updatedAt: '2026-08-14T05:32:38.593Z',
      }],
    } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    expect(screen.getByRole('alert')).toHaveTextContent('模型返回的图片格式无法解析');
    expect(screen.getByRole('alert')).not.toHaveTextContent('API 密钥');
  });

  it('shows a visible error when video generation cannot be started', async () => {
    const node = createCanvasModuleNode('video-start-failure', 'video_generation', { x: 0, y: 0 });
    const runVideoPreviewNode = vi.fn(async () => false);
    const data = {
      ...node.data,
      videoGenerationRoutes: [{ provider: 'comfly', modelRoute: 'video-gen', displayName: 'Seedance 2.0 Pro', modelId: 'seedance-2.0-pro', capabilities: ['video_generation'] }],
    } as typeof node.data;
    useAppStore.setState({ runVideoPreviewNode } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openVideoGenerationEditor();
    fireEvent.change(screen.getByLabelText('Video preview prompt'), { target: { value: 'A product video' } });
    fireEvent.click(screen.getByRole('button', { name: '生成视频' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('视频生成未启动'));
  });

  it('explains that RelayMe video media references are unsupported before submission', async () => {
    const node = createCanvasModuleNode('relayme-video-reference-failure', 'video_generation', { x: 0, y: 0 });
    const runVideoPreviewNode = vi.fn(async () => {
      throw Object.assign(
        new Error('RelayMe video generation does not support verified media references'),
        { code: 'CAPABILITY_UNSUPPORTED' },
      );
    });
    const data = {
      ...node.data,
      videoGenerationRoutes: [{ provider: 'relayme', modelRoute: 'relayme-video', displayName: 'RelayMe Video', modelId: 'relayme-video', capabilities: ['video_generation'] }],
    } as typeof node.data;
    useAppStore.setState({ runVideoPreviewNode } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openVideoGenerationEditor();
    fireEvent.change(screen.getByLabelText('Video preview prompt'), { target: { value: 'Animate this image' } });
    fireEvent.click(screen.getByRole('button', { name: '生成视频' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('RelayMe 当前视频接口不支持参考图片或视频'));
  });

  it('explains when a Comfly video model has no verified submission contract', async () => {
    const node = createCanvasModuleNode('comfly-unverified-video-model', 'video_generation', { x: 0, y: 0 });
    const runVideoPreviewNode = vi.fn(async () => {
      throw Object.assign(
        new Error('The selected Comfly video model has no verified submission contract'),
        { code: 'CAPABILITY_UNSUPPORTED' },
      );
    });
    const data = {
      ...node.data,
      videoGenerationRoutes: [{ provider: 'comfly', modelRoute: 'comfly-grok-video', displayName: 'Grok Video', modelId: 'grok-imagine-video-1.5', capabilities: ['video_generation'] }],
    } as typeof node.data;
    useAppStore.setState({ runVideoPreviewNode } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openVideoGenerationEditor();
    fireEvent.change(screen.getByLabelText('Video preview prompt'), { target: { value: 'Animate this product' } });
    fireEvent.click(screen.getByRole('button', { name: '生成视频' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('该 Comfly 视频模型尚未验证提交格式，请选择 Wan、Seedance 或 Veo 模型'));
  });

  it('explains that a connected source video cannot be submitted as an image reference', async () => {
    const node = createCanvasModuleNode('source-video-reference-failure', 'video_generation', { x: 0, y: 0 });
    const runVideoPreviewNode = vi.fn(async () => {
      throw Object.assign(
        new Error('Video-to-video input is not supported by the selected provider route'),
        { code: 'CAPABILITY_UNSUPPORTED' },
      );
    });
    const data = {
      ...node.data,
      videoGenerationRoutes: [{ provider: 'comfly', modelRoute: 'comfly-video', displayName: 'Comfly Video', modelId: 'comfly-video', capabilities: ['video_generation'] }],
    } as typeof node.data;
    useAppStore.setState({ runVideoPreviewNode } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    openVideoGenerationEditor();
    fireEvent.change(screen.getByLabelText('Video preview prompt'), { target: { value: 'Transform this source video' } });
    fireEvent.click(screen.getByRole('button', { name: '生成视频' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('当前供应商不支持把视频作为生成输入'));
  });

  it('turns the image primary action into stop generation for the active node job', () => {
    const node = createCanvasModuleNode('generator-cancel', 'image_generation', { x: 0, y: 0 });
    const cancelModelJob = vi.fn(async () => {});
    useAppStore.setState({
      cancelModelJob,
      modelJobs: [
        { id: 'other-job', promptNodeId: 'other-node', status: 'running' },
        { id: 'node-job', promptNodeId: node.id, status: 'running' },
      ],
    } as never);

    render(
      <ReactFlowProvider>
        <ModuleNodeCard id={node.id} data={node.data} selected={false} />
      </ReactFlowProvider>,
    );

    openImageGenerationEditor();
    expect(screen.getByLabelText('生成摘要 / Generation summary')).toHaveClass('is-generating');
    expect(screen.getByText('正在生成')).toBeVisible();
    expect(document.querySelector('.module-node__generation-empty-stage[data-generation-state="running"] .lucide-loader-circle')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '停止生成' }));

    expect(cancelModelJob).toHaveBeenCalledWith('node-job');
    expect(cancelModelJob).not.toHaveBeenCalledWith('other-job');
  });

  it('renders managed preview metadata and opens only the confined desktop import action', () => {
    window.novusDesktop = {} as typeof window.novusDesktop;
    const node = createCanvasModuleNode('image-input', 'image_input', { x: 0, y: 0 });
    node.data.config = { assetId: projectImage.assetId };
    const importImageForModule = vi.fn(async () => true);
    useAppStore.setState({ projectImages: [projectImage], importImageForModule });

    render(
      <ReactFlowProvider>
        <ModuleNodeCard id={node.id} data={node.data} selected={false} />
      </ReactFlowProvider>,
    );

    const media = screen.getByRole('img', { name: 'Product front' });
    expect(media).toHaveAttribute('src', projectImage.displayUrl);
    expect(media.closest('.module-node__media-frame')).toHaveStyle({ aspectRatio: '2 / 3' });
    expect(screen.getByTestId('module-node-card')).toHaveClass('module-node--has-media');
    expect(screen.getByTestId('module-node-card')).toHaveStyle({ '--media-node-width': '188px' });
    expect(screen.getAllByText('Product front')).toHaveLength(2);
    expect(screen.getByText('2 × 3')).toBeVisible();
    expect(document.querySelector('.module-node__asset-preview')).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '更换图像 / Replace image' }));
    expect(importImageForModule).toHaveBeenCalledWith('image-input');
  });

  it('opens an image-input material in the shared detail viewer on double click', () => {
    const node = createCanvasModuleNode('image-input-preview', 'image_input', { x: 0, y: 0 });
    node.data.config = { assetId: projectImage.assetId };
    useAppStore.setState({ projectImages: [projectImage] } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    fireEvent.doubleClick(screen.getByRole('img', { name: projectImage.label }));

    expect(screen.getByRole('dialog', { name: 'Generated image preview' })).toBeVisible();
    expect(screen.getByLabelText('图片尺寸')).toHaveTextContent('2 × 3 px');
  });

  it('opens a real browser image picker in manual acceptance mode even when the desktop bridge is mocked', () => {
    window.novusDesktop = {} as typeof window.novusDesktop;
    window.__NOVUS_MANUAL_ACCEPTANCE__ = true;
    const node = createCanvasModuleNode('manual-image-input', 'image_input', { x: 0, y: 0 });
    const importImageForModule = vi.fn(async () => true);
    useAppStore.setState({ importImageForModule } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    fireEvent.click(screen.getByRole('button', { name: '导入图像 / Import image' }));

    const picker = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(picker).not.toBeNull();
    expect(picker).toHaveAttribute('accept', 'image/png,image/jpeg,image/webp,image/gif');
    const file = new File(['png'], 'manual-reference.png', { type: 'image/png' });
    Object.defineProperty(picker!, 'files', { configurable: true, value: [file] });
    fireEvent.change(picker!);

    expect(importImageForModule).toHaveBeenCalledWith(node.id, file);
    expect(importImageForModule).not.toHaveBeenCalledWith(node.id);
    expect(document.querySelector('input[type="file"]')).toBeNull();
    delete window.__NOVUS_MANUAL_ACCEPTANCE__;
  });

  it('replaces an image input asset when an image is pasted into its material surface', () => {
    const node = createCanvasModuleNode('paste-image-input', 'image_input', { x: 0, y: 0 });
    node.data.config = { assetId: projectImage.assetId };
    const importImageForModule = vi.fn(async () => true);
    useAppStore.setState({ projectImages: [projectImage], importImageForModule } as never);
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    const pasted = new File(['replacement'], 'replacement.png', { type: 'image/png' });
    fireEvent.paste(document.querySelector('.module-node__image-control')!, {
      clipboardData: { files: [pasted], items: [] },
    });

    expect(importImageForModule).toHaveBeenCalledWith(node.id, pasted);
  });

  it('opens a real browser video picker in manual acceptance mode without calling native import', () => {
    window.novusDesktop = {} as typeof window.novusDesktop;
    window.__NOVUS_MANUAL_ACCEPTANCE__ = true;
    const node = createCanvasModuleNode('manual-video-input', 'video_input', { x: 0, y: 0 });
    const importVideoForModule = vi.fn(async () => true);
    useAppStore.setState({ importVideoForModule } as never);

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    fireEvent.click(screen.getByRole('button', { name: '导入视频 / Import video' }));

    const picker = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(picker).not.toBeNull();
    expect(picker).toHaveAttribute('accept', 'video/mp4,video/*');
    const file = new File(['mp4'], 'manual-reference.mp4', { type: 'video/mp4' });
    Object.defineProperty(picker!, 'files', { configurable: true, value: [file] });
    fireEvent.change(picker!);

    expect(importVideoForModule).toHaveBeenCalledWith(node.id, file);
    expect(importVideoForModule).not.toHaveBeenCalledWith(node.id);
    expect(document.querySelector('input[type="file"]')).toBeNull();
    delete window.__NOVUS_MANUAL_ACCEPTANCE__;
  });
  it('uses a compact media-first empty state instead of a text-heavy image card', () => {
    const node = createCanvasModuleNode('image-input', 'image_input', { x: 0, y: 0 });

    render(
      <ReactFlowProvider>
        <ModuleNodeCard id={node.id} data={node.data} selected={false} />
      </ReactFlowProvider>,
    );

    const preview = document.querySelector('.module-node__media-empty');
    expect(preview).toHaveTextContent('添加图片素材');
    expect(preview).toHaveTextContent('上传');
    expect(preview).not.toHaveTextContent('暂无受管图像');
    expect(preview?.querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('button', { name: '导入图像 / Import image' })).toBeVisible();
  });

  it.each(['image_input', 'video_input', 'canvas_library', 'result_output', 'video_result', 'reverse_result'] as const)('marks %s as a shared foundation node surface', (moduleType) => {
    const node = createCanvasModuleNode(`foundation-${moduleType}`, moduleType, { x: 0, y: 0 });

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    expect(screen.getByTestId('module-node-card')).toHaveClass('module-node--foundation');
  });

  it('opens Canvas output actions from the preview surface without a visible action button', () => {
    const node = createCanvasModuleNode('result-preview', 'result_output', { x: 0, y: 0 });

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    const preview = screen.getByLabelText('Generated image preview');
    expect(preview).toHaveTextContent('生成图片预览');
    expect(preview).toHaveTextContent('右键查看更多操作');
    expect(preview).toHaveAttribute('aria-haspopup', 'menu');
    expect(preview).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: '打开生成图片操作' })).toBeNull();

    fireEvent.contextMenu(preview);
    expect(screen.getByRole('menu', { name: '生成图片操作' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: '发送到 AI 对话' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: '发送到画布' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: '导入 Photoshop' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: '复制图片' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: '下载图片' })).toBeDisabled();
    fireEvent.keyDown(preview, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: '生成图片操作' })).toBeNull();

    fireEvent.keyDown(preview, { key: 'ContextMenu' });
    expect(screen.getByRole('menu', { name: '生成图片操作' })).toBeVisible();
  });

  it('renders a dedicated video result as the same foundation output surface', () => {
    const node = createCanvasModuleNode('video-result-preview', 'video_result', { x: 0, y: 0 });

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    expect(screen.getByTestId('module-node-card')).toHaveClass('module-node--foundation');
    expect(screen.getByLabelText('Generated video preview')).toBeVisible();
    expect(screen.getByText('生成视频结果')).toBeVisible();

    const css = readFileSync('apps/renderer/src/styles/canvas-layout.css', 'utf8');
    const rules = [...css.matchAll(/\.workspace--canvas-layout \.module-node--foundation\[data-module-type='video_result'\] \.module-node__video-output-preview\s*\{([^}]*)\}/gu)];
    const finalRule = rules[rules.length - 1]?.[1] ?? '';
    expect(finalRule).toContain('position: absolute !important');
    expect(finalRule).toContain('inset: 0 !important');
    expect(finalRule).toContain('width: 100% !important');
    expect(finalRule).toContain('height: 100% !important');
  });

  it('renders the connected video result as an actual MP4 playback stage with its managed poster', () => {
    const input = createCanvasModuleNode('video-result-input', 'image_input', { x: -360, y: 0 });
    input.data.config = { assetId: projectImage.assetId };
    const source = createCanvasModuleNode('video-result-source', 'video_generation', { x: 0, y: 0 });
    source.data.config = {
      resultState: 'fresh',
      videoResults: [{
        assetId: 'generated-video-result-1',
        mediaType: 'video/mp4',
        durationMs: 5000,
        posterAssetId: projectImage.assetId,
      }],
    };
    const result = createCanvasModuleNode('video-result-target', 'video_result', { x: 520, y: 0 });
    useAppStore.setState({
      project: {
        ...useAppStore.getState().project,
        nodes: [input, source, result],
        edges: [
          { id: 'video-result-input-edge', source: input.id, sourcePortId: 'image', target: source.id, targetPortId: 'media', order: 0 },
          { id: 'video-result-edge', source: source.id, sourcePortId: 'result', target: result.id, targetPortId: 'video', order: 1 },
        ],
        assets: [{
          assetId: projectImage.assetId,
          sha256: projectImage.sha256,
          byteSize: projectImage.byteSize,
          extension: projectImage.extension,
          height: projectImage.height,
          label: projectImage.label,
          mediaType: projectImage.mediaType,
          origin: projectImage.origin,
          width: projectImage.width,
        }],
      },
      projectImages: [projectImage],
      projectVideos: [{
        ...projectVideo,
        assetId: 'generated-video-result-1',
        displayUrl: 'novus-asset://project/session/generated-video-result-1',
        durationMs: 5000,
      }],
    });

    render(<ReactFlowProvider><ModuleNodeCard id={result.id} data={result.data} selected={false} /></ReactFlowProvider>);

    expect(screen.getByLabelText('Generated video playback')).toBeVisible();
    const playback = screen.getByLabelText('Generated video playback video');
    expect(playback).toHaveAttribute('src', 'novus-asset://project/session/generated-video-result-1');
    expect(playback).toHaveAttribute('poster', projectImage.displayUrl);
    expect(playback).toHaveAttribute('controls');
    expect(screen.getByText('生成结果')).toBeVisible();
    expect(screen.getByText('已完成')).toBeVisible();
    expect(screen.getByLabelText('Generated video playback')).toHaveTextContent('00:00 / 00:05 · 1080p');
  });

  it('renders a dedicated reverse result as the same foundation output surface', () => {
    const reverse = createCanvasModuleNode('reverse-source', 'reverse_agent', { x: 0, y: 0 });
    reverse.data.config = { reverseAgentResult: {
      analysis: 'The product is centered with soft directional light.',
      keywords: ['product', 'studio light'],
      positivePrompt: 'Structured reverse analysis',
      negativeConstraints: ['Do not change the logo'],
      executionChecklist: ['Verify product identity'],
    } };
    const node = createCanvasModuleNode('reverse-result-preview', 'reverse_result', { x: 0, y: 0 });
    const project = useAppStore.getState().project;
    useAppStore.setState({
      project: {
        ...project,
        nodes: [reverse, node],
        edges: [{ id: 'reverse-analysis-result', source: reverse.id, sourcePortId: 'analysis', target: node.id, targetPortId: 'analysis' }],
      },
    });

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    expect(screen.getByTestId('module-node-card')).toHaveClass('module-node--foundation');
    expect(screen.getByLabelText('Reverse analysis result')).toBeVisible();
    expect(screen.getByLabelText('Reverse analysis result')).toHaveTextContent('The product is centered with soft directional light.');
    expect(screen.getByLabelText('Reverse analysis result')).toHaveTextContent('product · studio light');
    expect(screen.getByLabelText('Reverse analysis result')).toHaveTextContent('Structured reverse analysis');
    expect(document.querySelector('[data-module-type="reverse_result"] [data-port-id="analysis"][data-port-direction="output"] .react-flow__handle')).not.toBeNull();
  });

  it('keeps the dedicated reverse result free of duplicate image-generation controls', () => {
    const reverse = createCanvasModuleNode('reverse-source-for-image', 'reverse_agent', { x: 0, y: 0 });
    reverse.data.config = { reverseAgentResult: { positivePrompt: 'Structured prompt for product image generation' } };
    const result = createCanvasModuleNode('reverse-result-to-image', 'reverse_result', { x: 0, y: 0 });
    const imageGeneration = createCanvasModuleNode('target-image-generation', 'image_generation', { x: 500, y: 0 });
    const project = useAppStore.getState().project;
    useAppStore.setState({
      project: {
        ...project,
        nodes: [reverse, result, imageGeneration],
        edges: [{ id: 'reverse-analysis-result', source: reverse.id, sourcePortId: 'analysis', target: result.id, targetPortId: 'analysis' }],
      },
    });

    render(<ReactFlowProvider><ModuleNodeCard id={result.id} data={result.data} selected={false} /></ReactFlowProvider>);

    expect(screen.getByLabelText('Reverse analysis result')).toHaveTextContent('Structured prompt for product image generation');
    expect(screen.queryByText('生图模型')).not.toBeInTheDocument();
    expect(screen.queryByText('生图节点')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate image from reverse result' })).not.toBeInTheDocument();
  });
  it('keeps the reverse workbench available when its completed analysis is connected to a dedicated result node', () => {
    const reverse = createCanvasModuleNode('reverse-workbench-source', 'reverse_agent', { x: 0, y: 0 });
    reverse.data.config = {
      modelRoute: 'reverse-default',
      role: 'Commercial visual analyst',
      task: 'Analyze the connected reference.',
      knowledgeBaseIds: [],
      reverseAgentResult: { positivePrompt: 'Structured reverse analysis' },
    };
    const result = createCanvasModuleNode('reverse-workbench-result', 'reverse_result', { x: 620, y: 0 });
    const project = useAppStore.getState().project;
    useAppStore.setState({
      project: {
        ...project,
        nodes: [reverse, result],
        edges: [{ id: 'reverse-workbench-output', source: reverse.id, sourcePortId: 'analysis', target: result.id, targetPortId: 'analysis' }],
      },
    });

    render(<ReactFlowProvider><ModuleNodeCard id={reverse.id} data={reverse.data} selected={false} /></ReactFlowProvider>);

    expect(screen.getByRole('textbox', { name: 'Role positioning' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Analysis task' })).toBeVisible();
    expect(screen.queryByLabelText('AI analysis output')).toBeNull();
  });

  it('offers a confined MP4 import action for an empty video input', () => {
    window.novusDesktop = {} as typeof window.novusDesktop;
    const node = createCanvasModuleNode('video-input', 'video_input', { x: 0, y: 0 });
    const importVideoForModule = vi.fn(async () => true);
    useAppStore.setState({ importVideoForModule });

    render(
      <ReactFlowProvider>
        <ModuleNodeCard id={node.id} data={node.data} selected={false} />
      </ReactFlowProvider>,
    );

    expect(document.querySelector('.module-node__video-control')).not.toBeNull();
    expect(screen.getByText('导入 MP4')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '导入视频 / Import video' }));
    expect(importVideoForModule).toHaveBeenCalledWith('video-input');
    expect(screen.queryByText('待配置')).not.toBeInTheDocument();
  });

  it('bounds extreme image dimensions and renders a managed video preview', () => {
    const imageNode = createCanvasModuleNode('extreme-image', 'image_input', { x: 0, y: 0 });
    imageNode.data.config = { assetId: projectImage.assetId };
    const videoNode = createCanvasModuleNode('legacy-video', 'video_input', { x: 0, y: 0 });
    videoNode.data.config = { assetId: projectVideo.assetId };
    useAppStore.setState({
      projectImages: [{ ...projectImage, height: 8192, width: 1 }],
      projectVideos: [projectVideo],
    });

    const { rerender } = render(
      <ReactFlowProvider>
        <ModuleNodeCard id={imageNode.id} data={imageNode.data} selected={false} />
      </ReactFlowProvider>,
    );

    expect(document.querySelector('.module-node__media-frame')).toHaveStyle({ aspectRatio: '9 / 16' });

    rerender(
      <ReactFlowProvider>
        <ModuleNodeCard id={videoNode.id} data={videoNode.data} selected={false} />
      </ReactFlowProvider>,
    );
    const video = screen.getByLabelText('Product turntable');
    expect(video).toHaveAttribute('src', projectVideo.displayUrl);
    expect(video).toHaveAttribute('controls');
    expect(screen.getByText('Product turntable')).toBeVisible();
    expect(screen.getByText('2 KB')).toBeVisible();
  });

  it('starts a restored managed video when its preview is clicked', async () => {
    const videoNode = createCanvasModuleNode('clickable-video-input', 'video_input', { x: 0, y: 0 });
    videoNode.data.config = { assetId: projectVideo.assetId };
    useAppStore.setState({ projectVideos: [projectVideo] });
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);

    render(<ReactFlowProvider><ModuleNodeCard id={videoNode.id} data={videoNode.data} selected={false} /></ReactFlowProvider>);

    fireEvent.pointerDown(screen.getByLabelText('Product turntable'));
    expect(play).toHaveBeenCalledOnce();
    play.mockRestore();
  });

  it('renders an ordered canvas-library selection with stable move controls', () => {
    const node = createCanvasModuleNode('library', 'canvas_library', { x: 0, y: 0 });
    node.data.config = { assetIds: [projectImage.assetId] };
    useAppStore.setState({ projectImages: [projectImage] });

    render(
      <ReactFlowProvider>
        <ModuleNodeCard id={node.id} data={node.data} selected={false} />
      </ReactFlowProvider>,
    );

    expect(screen.getByRole('checkbox', { name: '选择 Product front / Select Product front' })).toBeChecked();
    expect(screen.getByText('参考 1 / Reference 1')).toBeVisible();
    expect(screen.getByRole('button', { name: '上移 Product front / Move Product front up' })).toBeDisabled();
  });

  it('allows an Agent task to use no knowledge base or any number of distinct ready knowledge bases', async () => {
    const node = createCanvasModuleNode('reverse-config', 'reverse_agent', { x: 0, y: 0 });
    const applyReverseAgentConfig = vi.fn(async () => true);
    useAppStore.setState({
      applyReverseAgentConfig,
      knowledgeBases: [
        { schemaVersion: 1, knowledgeBaseId: 'brand-rules', displayName: 'Brand rules', activeVersion: 2, activeContentHash: 'a'.repeat(64), status: 'active', versionCount: 2, versions: [], stateRevision: 1, lastFailure: null, lastRollbackAt: null },
        { schemaVersion: 1, knowledgeBaseId: 'scene-skill', displayName: 'Scene skill', activeVersion: 3, activeContentHash: 'b'.repeat(64), status: 'active', versionCount: 3, versions: [], stateRevision: 1, lastFailure: null, lastRollbackAt: null },
        { schemaVersion: 1, knowledgeBaseId: 'product-detail', displayName: 'Product detail', activeVersion: 1, activeContentHash: 'c'.repeat(64), status: 'active', versionCount: 1, versions: [], stateRevision: 1, lastFailure: null, lastRollbackAt: null },
      ],
    });

    const data = {
      ...node.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'gemini-video', displayName: 'Gemini Video', modelId: 'gemini-video', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    fireEvent.change(screen.getByLabelText('Agent model route'), { target: { value: 'gemini-video' } });
    fireEvent.change(screen.getByLabelText('Role positioning'), { target: { value: 'Video director' } });
    fireEvent.change(screen.getByLabelText('Analysis task'), { target: { value: 'Analyze the original MP4' } });

    expect(screen.getByRole('button', { name: 'Start reverse analysis' })).toBeEnabled();
    expect(screen.getByRole('group', { name: '反推强度' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '深度反推' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start reverse analysis' }));
    expect(applyReverseAgentConfig).toHaveBeenLastCalledWith('reverse-config', {
      modelRoute: 'gemini-video',
      role: 'Video director',
      task: 'Analyze the original MP4',
      analysisDepth: 'deep',
      knowledgeBaseIds: [],
    });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Start reverse analysis' })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: 'Knowledge bases' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use Brand rules' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use 场景 Skill' }));
    expect(screen.getByRole('checkbox', { name: 'Use Product detail' })).toBeEnabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use Product detail' }));

    fireEvent.click(screen.getByRole('button', { name: 'Start reverse analysis' }));
    expect(applyReverseAgentConfig).toHaveBeenLastCalledWith('reverse-config', {
      modelRoute: 'gemini-video',
      role: 'Video director',
      task: 'Analyze the original MP4',
      analysisDepth: 'deep',
      knowledgeBaseIds: ['brand-rules', 'scene-skill', 'product-detail'],
    });
  });

  it('locks reverse intensity while a run is active and shows which intensity is running', async () => {
    const node = createCanvasModuleNode('reverse-depth-running', 'reverse_agent', { x: 0, y: 0 });
    node.data.config = { ...node.data.config, modelRoute: 'gemini-video', role: 'Visual analyst', task: 'Analyze the managed reference.' };
    const runReverseAgentNode = vi.fn(() => new Promise<never>(() => undefined));
    useAppStore.setState({ runReverseAgentNode } as never);
    const data = {
      ...node.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'gemini-video', displayName: 'Gemini Video', modelId: 'gemini-video', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    fireEvent.click(screen.getByRole('button', { name: '深度反推' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start reverse analysis' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Start reverse analysis' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop reverse analysis' })).toBeVisible());
    expect(screen.getByRole('button', { name: '深度反推' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '快速反推' })).toBeDisabled();
    expect(screen.getByRole('status', { name: '当前反推强度' })).toHaveTextContent('深度反推');
  });

  it('sends edited reverse fields to the autosave draft before Start is pressed', async () => {
    const node = createCanvasModuleNode('reverse-draft-ui', 'reverse_agent', { x: 0, y: 0 });
    const draftReverseAgentConfig = vi.fn(async () => true);
    useAppStore.setState({
      draftReverseAgentConfig,
      project: { ...useAppStore.getState().project, nodes: [node], edges: [] },
    });
    const data = {
      ...node.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'gemini-reverse', displayName: 'Gemini Reverse', modelId: 'gemini-reverse', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    fireEvent.change(screen.getByLabelText('Role positioning'), { target: { value: 'Product scene analyst' } });
    fireEvent.change(screen.getByLabelText('Analysis task'), { target: { value: 'Preserve this draft without running.' } });

    await waitFor(() => expect(draftReverseAgentConfig).toHaveBeenLastCalledWith(node.id, {
      modelRoute: 'gemini-reverse',
      role: 'Product scene analyst',
      task: 'Preserve this draft without running.',
      analysisDepth: 'standard',
      knowledgeBaseIds: [],
      referenceAssetIds: [],
    }));
  });

  it('serializes rapid reverse draft writes and keeps the latest role and task together', async () => {
    const node = createCanvasModuleNode('reverse-draft-serialized', 'reverse_agent', { x: 0, y: 0 });
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    const draftReverseAgentConfig = vi.fn(async () => {
      activeWrites += 1;
      maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
      await new Promise((resolve) => setTimeout(resolve, 15));
      activeWrites -= 1;
      return true;
    });
    useAppStore.setState({
      draftReverseAgentConfig,
      project: { ...useAppStore.getState().project, nodes: [node], edges: [] },
    });
    const data = {
      ...node.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'gemini-reverse', displayName: 'Gemini Reverse', modelId: 'gemini-reverse', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    fireEvent.change(screen.getByLabelText('Role positioning'), { target: { value: 'Latest analyst role' } });
    fireEvent.change(screen.getByLabelText('Analysis task'), { target: { value: 'Latest analysis task' } });

    await waitFor(() => expect(draftReverseAgentConfig).toHaveBeenLastCalledWith(node.id, {
      modelRoute: 'gemini-reverse',
      role: 'Latest analyst role',
      task: 'Latest analysis task',
      analysisDepth: 'standard',
      knowledgeBaseIds: [],
      referenceAssetIds: [],
    }));
    await waitFor(() => expect(activeWrites).toBe(0));
    expect(maximumActiveWrites).toBe(1);
  });

  it('writes reverse text through the real app-store draft action', async () => {
    const node = createCanvasModuleNode('reverse-real-draft', 'reverse_agent', { x: 0, y: 0 });
    useAppStore.setState({
      project: { ...useAppStore.getState().project, nodes: [node], edges: [] },
      recoveryRequired: false,
      saveStatus: 'saved',
    } as never);
    const data = {
      ...node.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'gemini-reverse', displayName: 'Gemini Reverse', modelId: 'gemini-reverse', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    fireEvent.change(screen.getByLabelText('Role positioning'), { target: { value: 'Durable analyst role' } });
    fireEvent.change(screen.getByLabelText('Analysis task'), { target: { value: 'Durable analysis task' } });

    await waitFor(() => expect(useAppStore.getState().project.nodes.find((candidate) => candidate.id === node.id)).toMatchObject({
      data: { config: { role: 'Durable analyst role', task: 'Durable analysis task' } },
    }));
  });

  it('saves a shortened image prompt through the real app-store draft action', async () => {
    const node = createCanvasModuleNode('image-real-backspace-draft', 'image_generation', { x: 0, y: 0 });
    node.data.config = { ...node.data.config, prompt: 'Product lighting' };
    useAppStore.setState({
      project: { ...useAppStore.getState().project, nodes: [node], edges: [] },
      recoveryRequired: false,
      saveStatus: 'saved',
    } as never);
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    fireEvent.change(screen.getByLabelText('Image generation prompt'), { target: { value: 'Product lightin' } });

    await waitFor(() => expect(useAppStore.getState().project.nodes.find((candidate) => candidate.id === node.id)).toMatchObject({
      data: { config: { prompt: 'Product lightin' } },
    }));
    expect(useAppStore.getState().project.nodes).toHaveLength(1);
  });

  it('retries the latest reverse draft once after an untitled project is promoted', async () => {
    const node = createCanvasModuleNode('reverse-draft-promotion-retry', 'reverse_agent', { x: 0, y: 0 });
    let targetAttempts = 0;
    const draftReverseAgentConfig = vi.fn(async (_nodeId: string, config: { role: string }) => {
      if (config.role !== 'Role entered during save') return true;
      targetAttempts += 1;
      return targetAttempts > 1;
    });
    useAppStore.setState({ draftReverseAgentConfig } as never);
    const data = {
      ...node.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'gemini-reverse', displayName: 'Gemini Reverse', modelId: 'gemini-reverse', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    fireEvent.change(screen.getByLabelText('Role positioning'), { target: { value: 'Role entered during save' } });

    await waitFor(() => expect(targetAttempts).toBe(2));
  });

  it('retries the latest generation draft once after an untitled project is promoted', async () => {
    const node = createCanvasModuleNode('image-draft-promotion-retry', 'image_generation', { x: 0, y: 0 });
    let targetAttempts = 0;
    const draftGenerationNodeConfig = vi.fn(async (_nodeId: string, config: { prompt: string }) => {
      if (config.prompt !== 'Prompt entered during save') return true;
      targetAttempts += 1;
      return targetAttempts > 1;
    });
    useAppStore.setState({ draftGenerationNodeConfig } as never);
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();

    fireEvent.change(screen.getByLabelText('Image generation prompt'), { target: { value: 'Prompt entered during save' } });

    await waitFor(() => expect(targetAttempts).toBe(2));
  });

  it('hydrates saved reverse text into an already mounted node instead of overwriting it with blank local state', async () => {
    const node = createCanvasModuleNode('reverse-hydrated-text', 'reverse_agent', { x: 0, y: 0 });
    const data = {
      ...node.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'gemini-reverse', displayName: 'Gemini Reverse', modelId: 'gemini-reverse', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;
    const view = render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    view.rerender(<ReactFlowProvider><ModuleNodeCard id={node.id} data={{
      ...data,
      config: { ...data.config, modelRoute: 'gemini-reverse', role: 'Saved product analyst', task: 'Saved reverse instructions' },
    }} selected={false} /></ReactFlowProvider>);

    await waitFor(() => expect(screen.getByLabelText('Role positioning')).toHaveValue('Saved product analyst'));
    await waitFor(() => expect(screen.getByLabelText('Analysis task')).toHaveValue('Saved reverse instructions'));
  });

  it('does not overwrite newer reverse text when an older draft config arrives asynchronously', async () => {
    const node = createCanvasModuleNode('reverse-stale-draft', 'reverse_agent', { x: 0, y: 0 });
    const data = {
      ...node.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'gemini-reverse', displayName: 'Gemini Reverse', modelId: 'gemini-reverse', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;
    const view = render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    fireEvent.change(screen.getByLabelText('Role positioning'), { target: { value: 'Current analyst role' } });
    fireEvent.change(screen.getByLabelText('Analysis task'), { target: { value: 'Current analysis task' } });
    view.rerender(<ReactFlowProvider><ModuleNodeCard id={node.id} data={{
      ...data,
      config: { ...data.config, modelRoute: 'gemini-reverse', role: '', task: '' },
    }} selected={false} /></ReactFlowProvider>);

    await waitFor(() => expect(screen.getByLabelText('Role positioning')).toHaveValue('Current analyst role'));
    expect(screen.getByLabelText('Analysis task')).toHaveValue('Current analysis task');
  });

  it.each([
    ['image_generation', 'Open image generation editor', 'Image generation prompt'],
    ['video_generation', 'Open video generation editor', 'Video preview prompt'],
  ] as const)('does not overwrite newer %s text when an older blank draft arrives', async (moduleType, openLabel, promptLabel) => {
    const node = createCanvasModuleNode(`stale-${moduleType}`, moduleType, { x: 0, y: 0 });
    const view = render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    fireEvent.click(screen.getByRole('button', { name: openLabel }));
    fireEvent.change(screen.getByLabelText(promptLabel), { target: { value: 'Current generation prompt' } });

    view.rerender(<ReactFlowProvider><ModuleNodeCard id={node.id} data={{
      ...node.data,
      config: { ...node.data.config, prompt: '' },
    }} selected={false} /></ReactFlowProvider>);

    await waitFor(() => expect(screen.getByLabelText(promptLabel)).toHaveValue('Current generation prompt'));
  });

  it.each([
    ['image_generation', 'Open image generation editor', 'Image generation prompt', 'Saved image prompt'],
    ['video_generation', 'Open video generation editor', 'Video preview prompt', 'Saved video prompt'],
  ] as const)('hydrates saved %s text into an already mounted generation editor', async (moduleType, openLabel, promptLabel, savedPrompt) => {
    const node = createCanvasModuleNode(`hydrated-${moduleType}`, moduleType, { x: 0, y: 0 });
    const view = render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    fireEvent.click(screen.getByRole('button', { name: openLabel }));

    view.rerender(<ReactFlowProvider><ModuleNodeCard id={node.id} data={{
      ...node.data,
      config: { ...node.data.config, prompt: savedPrompt },
    }} selected={false} /></ReactFlowProvider>);

    await waitFor(() => expect(screen.getByLabelText(promptLabel)).toHaveValue(savedPrompt));
  });

  it('defaults an empty Agent route to the first compatible route and applies it without exposing a new control', async () => {
    const node = createCanvasModuleNode('reverse-default-route', 'reverse_agent', { x: 0, y: 0 });
    node.data.config = { modelRoute: '' };
    const runReverseAgentNode = vi.fn(async () => ({ positivePrompt: 'Reverse result' }));
    useAppStore.setState({ runReverseAgentNode } as never);
    const data = {
      ...node.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'e2e-reverse', displayName: 'E2E Reverse Analysis', modelId: 'e2e-reverse', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    fireEvent.change(screen.getByLabelText('Role positioning'), { target: { value: 'Commercial visual analyst' } });
    fireEvent.change(screen.getByLabelText('Analysis task'), { target: { value: 'Analyze the connected reference.' } });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Start reverse analysis' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Start reverse analysis' }));
    expect(runReverseAgentNode).toHaveBeenCalledWith('reverse-default-route', {
      modelRoute: 'e2e-reverse',
      role: 'Commercial visual analyst',
      task: 'Analyze the connected reference.',
      analysisDepth: 'standard',
      knowledgeBaseIds: [],
    });
    expect(screen.getByLabelText('Reverse model workspace')).toHaveClass('module-node__agent-route-region');
  });

  it('prefers the Canvas image model when an empty generation node has multiple routes', () => {
    const node = createCanvasModuleNode('image-default-canvas-route', 'image_generation', { x: 0, y: 0 });
    const data = {
      ...node.data,
      imageGenerationRoutes: [
        { provider: 'comfly', modelRoute: 'image-generation', displayName: 'GPT Image', modelId: 'gpt-image-1', capabilities: ['image_generation', 'async_tasks'] },
        { provider: 'comfly', modelRoute: 'nano-banana-pro-actual-route', displayName: 'Nano Banana Pro', modelId: 'nano-banana-pro', capabilities: ['image_generation', 'async_tasks'] },
      ],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    openImageGenerationEditor();
    expect(screen.getByLabelText('Image generation model route')).toHaveValue('nano-banana-pro-actual-route');
  });

  it('uses the saved provider image default in a new Canvas generation node', () => {
    const node = createCanvasModuleNode('saved-image-default-canvas-route', 'image_generation', { x: 0, y: 0 });
    const data = {
      ...node.data,
      imageGenerationRoutes: [
        { provider: 'comfly', modelRoute: 'comfly-studio-image', displayName: 'Studio Image', modelId: 'studio-image', capabilities: ['image_generation'] },
        { provider: 'comfly', modelRoute: 'nano-banana-pro-actual-route', displayName: 'Nano Banana Pro', modelId: 'nano-banana-pro', capabilities: ['image_generation'] },
      ],
    } as typeof node.data;
    localStorage.removeItem(PROVIDER_MODEL_DEFAULTS_STORAGE_KEY);
    writeProviderModelDefaults('comfly', { image_generation: 'comfly-studio-image' });
    try {
      render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

      openImageGenerationEditor();
      expect(screen.getByLabelText('Image generation model route')).toHaveValue('comfly-studio-image');
    } finally {
      localStorage.removeItem(PROVIDER_MODEL_DEFAULTS_STORAGE_KEY);
    }
  });

  it('prefers the Canvas reverse model when an empty Agent node has multiple routes', () => {
    const node = createCanvasModuleNode('reverse-default-canvas-route', 'reverse_agent', { x: 0, y: 0 });
    const data = {
      ...node.data,
      reverseAgentRoutes: [
        { provider: 'comfly', modelRoute: 'reverse/e2e-gemini-native', displayName: 'E2E Reverse Analysis', modelId: 'e2e-reverse-gemini-native', capabilities: ['reverse_prompt', 'gemini_native'] },
        { provider: 'comfly', modelRoute: 'reverse-gemini-3.1-pro', displayName: 'Gemini 3.1 Pro', modelId: 'gemini-3.1-pro', capabilities: ['reverse_prompt', 'gemini_native'] },
      ],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    expect(screen.getByLabelText('Agent model route')).toHaveValue('reverse-gemini-3.1-pro');
  });

  it('restores the preferred Agent route when a later empty durable config refresh clears the automatic selection', async () => {
    const node = createCanvasModuleNode('reverse-route-refresh', 'reverse_agent', { x: 0, y: 0 });
    const reverseAgentRoutes = [
      { provider: 'comfly' as const, modelRoute: 'reverse/e2e-gemini-native', displayName: 'E2E Reverse Analysis', modelId: 'e2e-reverse-gemini-native', capabilities: ['reverse_prompt' as const, 'gemini_native' as const] },
      { provider: 'comfly' as const, modelRoute: 'reverse-gemini-3.1-pro', displayName: 'Gemini 3.1 Pro', modelId: 'gemini-3.1-pro', capabilities: ['reverse_prompt' as const, 'gemini_native' as const] },
    ];
    const data = { ...node.data, reverseAgentRoutes } as typeof node.data;
    const view = render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    const route = screen.getByLabelText('Agent model route');
    await waitFor(() => expect(route).toHaveValue('reverse-gemini-3.1-pro'));

    view.rerender(<ReactFlowProvider><ModuleNodeCard id={node.id} data={{
      ...data,
      config: { ...data.config, modelRoute: '' },
    }} selected={false} /></ReactFlowProvider>);

    await waitFor(() => expect(route).toHaveValue('reverse-gemini-3.1-pro'));
  });

  it('preserves a valid saved Agent route when other compatible routes are available', async () => {
    const node = createCanvasModuleNode('reverse-saved-route', 'reverse_agent', { x: 0, y: 0 });
    node.data.config = {
      modelRoute: 'saved-reverse',
      role: 'Commercial visual analyst',
      task: 'Analyze the connected reference.',
    };
    const runReverseAgentNode = vi.fn(async () => ({ positivePrompt: 'Reverse result' }));
    useAppStore.setState({ runReverseAgentNode } as never);
    const data = {
      ...node.data,
      reverseAgentRoutes: [
        { provider: 'comfly', modelRoute: 'saved-reverse', displayName: 'Saved Reverse Analysis', modelId: 'saved-reverse', capabilities: ['reverse_prompt', 'gemini_native'] },
        { provider: 'comfly', modelRoute: 'fallback-reverse', displayName: 'Fallback Reverse Analysis', modelId: 'fallback-reverse', capabilities: ['reverse_prompt', 'gemini_native'] },
      ],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Start reverse analysis' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Start reverse analysis' }));
    expect(runReverseAgentNode).toHaveBeenCalledWith('reverse-saved-route', {
      modelRoute: 'saved-reverse',
      role: 'Commercial visual analyst',
      task: 'Analyze the connected reference.',
      analysisDepth: 'standard',
      knowledgeBaseIds: [],
    });
  });

  it('does not offer unconnected project images to reverse analysis mentions', async () => {
    const node = createCanvasModuleNode('reverse-at-mention', 'reverse_agent', { x: 0, y: 0 });
    node.data.config = {
      modelRoute: 'reverse-gemini',
      role: 'Commercial visual analyst',
      task: 'Analyze the reference.',
      knowledgeBaseIds: [],
    };
    const runReverseAgentNode = vi.fn(async () => ({ positivePrompt: 'Reverse result' }));
    useAppStore.setState({ projectImages: [projectImage], runReverseAgentNode } as never);
    const data = {
      ...node.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'reverse-gemini', displayName: 'Reverse Gemini', modelId: 'reverse-gemini', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    fireEvent.change(screen.getByLabelText('Analysis task'), { target: { value: '@' } });
    expect(screen.queryByRole('menu', { name: 'Select reference image' })).not.toBeInTheDocument();
    expect(runReverseAgentNode).not.toHaveBeenCalled();
  });

  it('opens the reverse reference picker for connected media when typing @', () => {
    const image = createCanvasModuleNode('reverse-mention-source', 'image_input', { x: 0, y: 0 });
    image.data.config = { assetId: projectImage.assetId };
    const node = createCanvasModuleNode('reverse-mention-connected', 'reverse_agent', { x: 420, y: 0 });
    useAppStore.setState({
      project: {
        ...useAppStore.getState().project,
        nodes: [image, node],
        edges: [{ id: 'reverse-mention-edge', source: image.id, sourcePortId: 'image', target: node.id, targetPortId: 'references', order: 0 }],
      },
      projectImages: [projectImage],
    });
    const data = {
      ...node.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'reverse-gemini', displayName: 'Reverse Gemini', modelId: 'reverse-gemini', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    const editor = screen.getByLabelText('Analysis task');
    const inputAtCaret = (value: string, caretOffset: number) => {
      editor.textContent = value;
      editor.focus();
      // Replacing textContent does not move the DOM caret as browser typing does.
      const range = document.createRange();
      range.setStart(editor.firstChild!, caretOffset);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      fireEvent.input(editor, { inputType: 'insertText' });
    };
    fireEvent.keyDown(editor, { key: '@' });
    expect(screen.getByRole('menu', { name: 'Select reference image' })).toBeVisible();
    inputAtCaret('@', 1);

    expect(screen.getByRole('menu', { name: 'Select reference image' })).toBeVisible();
    const firstItem = screen.getByRole('menuitem', { name: projectImage.label });
    expect(fireEvent.pointerDown(firstItem)).toBe(false);
    fireEvent.click(firstItem);
    expect(editor).toHaveTextContent('图片1');
    expect((editor as HTMLDivElement & { value?: string }).value).toBe('@图片1');
    expect(screen.queryByRole('menu', { name: 'Select reference image' })).not.toBeInTheDocument();

    inputAtCaret('前文@，后文', '前文@'.length);
    expect(screen.getByRole('menu', { name: 'Select reference image' })).toBeVisible();
    fireEvent.click(screen.getByRole('menuitem', { name: projectImage.label }));
    expect((editor as HTMLDivElement & { value?: string }).value).toBe('前文@图片1，后文');

    inputAtCaret('前文@摄像机焦距还有后文', '前文@摄像机焦距'.length);
    expect(screen.getByRole('menu', { name: 'Select reference image' })).toBeVisible();
    fireEvent.click(screen.getByRole('menuitem', { name: projectImage.label }));
    expect((editor as HTMLDivElement & { value?: string }).value).toBe('前文@图片1还有后文');

    inputAtCaret('Use @, keep lighting', 'Use @'.length);
    expect(screen.getByRole('menu', { name: 'Select reference image' })).toBeVisible();
    fireEvent.click(screen.getByRole('menuitem', { name: projectImage.label }));
    expect((editor as HTMLDivElement & { value?: string }).value).toBe('Use @图片1, keep lighting');
    expect(screen.queryByRole('menu', { name: 'Select reference image' })).not.toBeInTheDocument();

    inputAtCaret('在已有引用前新增@，后面保留@图片1', '在已有引用前新增@'.length);
    expect(screen.getByRole('menu', { name: 'Select reference image' })).toBeVisible();

    fireEvent.blur(editor);
    expect(screen.queryByRole('menu', { name: 'Select reference image' })).not.toBeInTheDocument();
  });

  it('inserts a reverse-node reference at its real caret and leaves later unresolved mentions intact', () => {
    const image = createCanvasModuleNode('reverse-caret-source', 'image_input', { x: 0, y: 0 });
    image.data.config = { assetId: projectImage.assetId };
    const node = createCanvasModuleNode('reverse-caret-target', 'reverse_agent', { x: 420, y: 0 });
    node.data.config = {
      modelRoute: 'reverse-gemini',
      role: 'Commercial visual analyst',
      task: '',
      knowledgeBaseIds: [],
    };
    useAppStore.setState({
      project: {
        ...useAppStore.getState().project,
        nodes: [image, node],
        edges: [{ id: 'reverse-caret-edge', source: image.id, sourcePortId: 'image', target: node.id, targetPortId: 'references', order: 0 }],
      },
      projectImages: [projectImage],
    } as never);
    const data = {
      ...node.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'reverse-gemini', displayName: 'Reverse Gemini', modelId: 'reverse-gemini', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    const editor = screen.getByLabelText('Analysis task');
    const input = '先分析@当前，再比较  @后一个  保持结尾';
    editor.textContent = input;
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(editor.firstChild!, '先分析@当前'.length);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.input(editor);
    fireEvent.click(screen.getByRole('menuitem', { name: projectImage.label }));

    expect(editor).toHaveValue('先分析@图片1，再比较  @后一个  保持结尾');
  });
  it('deletes ordinary text beside a legacy reverse mention without entering an update loop', async () => {
    const image = createCanvasModuleNode('reverse-legacy-delete-source', 'image_input', { x: 0, y: 0 });
    image.data.config = { assetId: projectImage.assetId };
    const node = createCanvasModuleNode('reverse-legacy-delete-target', 'reverse_agent', { x: 420, y: 0 });
    node.data.config = {
      modelRoute: 'reverse-gemini',
      role: 'Commercial visual analyst',
      task: '保留@图片1旁边的普通文字',
      knowledgeBaseIds: [],
      referenceAssetIds: [],
    };
    useAppStore.setState({
      project: {
        ...useAppStore.getState().project,
        nodes: [image, node],
        edges: [{ id: 'reverse-legacy-delete-edge', source: image.id, sourcePortId: 'image', target: node.id, targetPortId: 'references', order: 0 }],
      },
      projectImages: [projectImage],
      recoveryRequired: false,
      saveStatus: 'saved',
    } as never);
    const data = {
      ...node.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'reverse-gemini', displayName: 'Reverse Gemini', modelId: 'reverse-gemini', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;
    const view = render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    const editor = screen.getByLabelText('Analysis task');
    const trailingText = Array.from(editor.childNodes).reverse().find((child: ChildNode) => child.nodeType === Node.TEXT_NODE);
    expect(trailingText).toBeDefined();
    trailingText!.textContent = (trailingText!.textContent ?? '').slice(0, -1);

    fireEvent.input(editor, { inputType: 'deleteContentBackward' });

    await waitFor(() => expect(useAppStore.getState().project.nodes.find((candidate) => candidate.id === node.id)).toMatchObject({
      data: { config: { task: '保留@图片1旁边的普通文' } },
    }));
    expect((editor as HTMLDivElement & { value?: string }).value).toBe('保留@图片1旁边的普通文');
    for (let index = 0; index < 8; index += 1) {
      const currentNode = useAppStore.getState().project.nodes.find((candidate) => candidate.id === node.id) as typeof node;
      view.rerender(<ReactFlowProvider><ModuleNodeCard id={node.id} data={{
        ...currentNode.data,
        config: { ...currentNode.data.config, referenceAssetIds: [...((currentNode.data.config.referenceAssetIds as string[] | undefined) ?? [])] },
      }} selected={false} /></ReactFlowProvider>);
      const nextEditor = screen.getByLabelText('Analysis task');
      const lastText = Array.from(nextEditor.childNodes).reverse().find((child: ChildNode) => child.nodeType === Node.TEXT_NODE);
      if (lastText !== undefined) lastText.textContent = (lastText.textContent ?? '').slice(0, -1);
      fireEvent.input(nextEditor, { inputType: 'deleteContentBackward' });
    }
    expect(screen.queryByText(/Maximum update depth|界面启动失败/iu)).not.toBeInTheDocument();
  });
  it('deletes several legacy reference chips without entering an update loop', async () => {
    const images = ['image-1', 'image-2', 'image-3'].map((assetId, index) => ({
      ...projectImage,
      assetId,
      label: `Reference ${index + 1}`,
    }));
    const sources = images.map((asset, index) => {
      const source = createCanvasModuleNode(`reverse-chip-source-${index}`, 'image_input', { x: index * -320, y: 0 });
      source.data.config = { assetId: asset.assetId };
      return source;
    });
    const node = createCanvasModuleNode('reverse-chip-delete-target', 'reverse_agent', { x: 420, y: 0 });
    node.data.config = {
      modelRoute: 'reverse-gemini',
      role: 'Commercial visual analyst',
      task: '@图片1@图片2@图片3',
      knowledgeBaseIds: [],
      referenceAssetIds: images.map((image) => image.assetId),
    };
    useAppStore.setState({
      project: {
        ...useAppStore.getState().project,
        nodes: [...sources, node],
        edges: sources.map((source, index) => ({ id: `reverse-chip-edge-${index}`, source: source.id, sourcePortId: 'image', target: node.id, targetPortId: 'references', order: index })),
      },
      projectImages: images,
      recoveryRequired: false,
      saveStatus: 'saved',
    } as never);
    const data = {
      ...node.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'reverse-gemini', displayName: 'Reverse Gemini', modelId: 'reverse-gemini', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    const editor = screen.getByLabelText('Analysis task');
    for (let index = 3; index >= 1; index -= 1) {
      const chip = editor.querySelector(`[data-token="@图片${index}"]`);
      expect(chip).not.toBeNull();
      const range = document.createRange();
      range.setStartAfter(chip!);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      fireEvent.keyDown(editor, { key: 'Backspace' });
      await waitFor(() => expect(editor.querySelector(`[data-token="@图片${index}"]`)).toBeNull());
    }
    expect((editor as HTMLDivElement & { value?: string }).value).toBe('');
  });
  it('groups the reverse workbench into a roomy top bar, task editor, knowledge context, and two actions', () => {
    const node = createCanvasModuleNode('reverse-roomy-workbench', 'reverse_agent', { x: 0, y: 0 });
    const data = {
      ...node.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'reverse-gemini', displayName: 'Reverse Gemini', modelId: 'reverse-gemini', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    expect(screen.getByLabelText('Reverse media workspace')).toHaveClass('module-node__agent-media-empty-hint');
    expect(screen.getByLabelText('Reverse model workspace')).toBeVisible();
    expect(screen.getByLabelText('Reverse task editor')).toContainElement(screen.getByLabelText('Role positioning'));
    expect(screen.getByLabelText('Reverse task editor')).toContainElement(screen.getByLabelText('Analysis task'));
    expect(screen.getByLabelText('Reverse knowledge context')).toBeInTheDocument();
    expect(screen.getByLabelText('Reverse task actions')).toContainElement(screen.getByRole('button', { name: 'Copy reverse result' }));
    expect(screen.getByLabelText('Reverse task actions')).toContainElement(screen.getByRole('button', { name: 'Start reverse analysis' }));
    expect(screen.getByText('反推结果 / Reverse result')).toBeVisible();
    expect(screen.getByText('运行完成后，反推提示词与分析要点会保留在这里。')).toBeVisible();
  });

  it('uses the approved equal secondary and primary reverse action button contract', () => {
    const css = readFileSync('apps/renderer/src/styles/release-layout-contract.css', 'utf8');
    const contract = css.slice(css.lastIndexOf('/* FINAL REVERSE ACTION BUTTON CONTRACT */'));

    expect(contract).toContain('grid-template-columns: repeat(2, minmax(0, 1fr)) !important');
    expect(contract).toContain('gap: 10px !important');
    expect(contract).toContain('height: 34px !important');
    expect(contract).toContain('.module-node__apply-agent');
    expect(contract).toContain('.module-node__run-agent');
    expect(contract).toContain('opacity: .55 !important');
  });

  it('renders edge-backed reverse media as visual slots below the model controls', () => {
    const image = createCanvasModuleNode('reverse-media-source', 'image_input', { x: 0, y: 0 });
    image.data.config = { assetId: projectImage.assetId };
    const node = createCanvasModuleNode('reverse-media-slots', 'reverse_agent', { x: 420, y: 0 });
    useAppStore.setState({
      project: {
        ...useAppStore.getState().project,
        nodes: [image, node],
        edges: [{ id: 'reverse-media-edge', source: image.id, sourcePortId: 'image', target: node.id, targetPortId: 'references', order: 0 }],
        assets: [{
          assetId: projectImage.assetId,
          sha256: projectImage.sha256,
          byteSize: projectImage.byteSize,
          extension: projectImage.extension,
          height: projectImage.height,
          label: projectImage.label,
          mediaType: projectImage.mediaType,
          origin: projectImage.origin,
          width: projectImage.width,
        }],
      },
      projectImages: [projectImage],
    });
    const data = {
      ...node.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'reverse-gemini', displayName: 'Reverse Gemini', modelId: 'reverse-gemini', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    const media = screen.getByLabelText('Connected reverse media slots');
    expect(media).toContainElement(screen.getByRole('img', { name: projectImage.label }));
    expect(screen.getByLabelText('Agent model route').compareDocumentPosition(media) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('starts an already applied Agent reverse task from its own node and renders the returned prompt', async () => {
    const node = createCanvasModuleNode('reverse-run', 'reverse_agent', { x: 0, y: 0 });
    node.data.config = {
      modelRoute: 'gemini-video',
      role: 'Commercial visual analyst',
      task: 'Analyze the managed reference.',
      analysisDepth: 'standard',
      knowledgeBaseIds: [],
    };
    const runReverseAgentNode = vi.fn(async () => ({ positivePrompt: 'Cinematic product shot with a controlled soft key light.' }));
    useAppStore.setState({ runReverseAgentNode } as never);
    const data = {
      ...node.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'gemini-video', displayName: 'Gemini Video', modelId: 'gemini-video', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'Start reverse analysis' }));

    await waitFor(() => expect(runReverseAgentNode).toHaveBeenCalledWith(node.id, {
      modelRoute: 'gemini-video',
      role: 'Commercial visual analyst',
      task: 'Analyze the managed reference.',
      analysisDepth: 'standard',
      knowledgeBaseIds: [],
    }));
    expect(screen.getByText('Cinematic product shot with a controlled soft key light.')).toBeVisible();
  });

  it('keeps reverse analysis unavailable when the task draft differs from the applied configuration', () => {
    const node = createCanvasModuleNode('reverse-draft', 'reverse_agent', { x: 0, y: 0 });
    node.data.config = {
      modelRoute: 'gemini-video',
      role: 'Commercial visual analyst',
      task: 'Analyze the managed reference.',
      knowledgeBaseIds: [],
    };
    const data = {
      ...node.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'gemini-video', displayName: 'Gemini Video', modelId: 'gemini-video', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    expect(screen.getByRole('button', { name: 'Start reverse analysis' })).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Analysis task'), { target: { value: 'Analyze the updated connected reference.' } });
    expect(screen.getByRole('button', { name: 'Start reverse analysis' })).toBeEnabled();
  });

  it('keeps reverse analysis available when an applied task also has node presentation metadata', () => {
    const node = createCanvasModuleNode('reverse-metadata', 'reverse_agent', { x: 0, y: 0 });
    node.data.config = {
      modelRoute: 'gemini-video',
      role: 'Commercial visual analyst',
      task: 'Analyze the managed reference.',
      knowledgeBaseIds: [],
      mode: 'auto',
      orderedMedia: [],
      resultState: 'empty',
    };
    const data = {
      ...node.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'gemini-video', displayName: 'Gemini Video', modelId: 'gemini-video', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    expect(screen.getByRole('button', { name: 'Start reverse analysis' })).toBeEnabled();
  });

  it('keeps the reverse form after a successful run because analysis belongs to the dedicated result node', async () => {
    const node = createCanvasModuleNode('reverse-output', 'reverse_agent', { x: 0, y: 0 });
    node.data.config = {
      modelRoute: 'gemini-video',
      role: 'Commercial visual analyst',
      task: 'Analyze the managed reference.',
      knowledgeBaseIds: [],
    };
    const runReverseAgentNode = vi.fn(async () => ({
      positivePrompt: '### Analysis\nA long, readable visual analysis result for the connected canvas node.',
    }));
    useAppStore.setState({ runReverseAgentNode } as never);
    const data = {
      ...node.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'gemini-video', displayName: 'Gemini Video', modelId: 'gemini-video', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'Start reverse analysis' }));

    await waitFor(() => expect(runReverseAgentNode).toHaveBeenCalledWith(node.id, {
      modelRoute: 'gemini-video',
      role: 'Commercial visual analyst',
      task: 'Analyze the managed reference.',
      analysisDepth: 'standard',
      knowledgeBaseIds: [],
    }));
    expect(screen.queryByLabelText('AI analysis output')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Reverse task editor')).toBeVisible();
    const card = screen.getByTestId('module-node-card');
    expect(card.querySelector('[data-port-id="references"][data-port-direction="input"][data-port-type="media_asset"].react-flow__handle')).not.toBeNull();
    expect(card.querySelector('[data-port-id="analysis"][data-port-direction="output"][data-port-type="analysis_document"].react-flow__handle')).not.toBeNull();
  });

  it('keeps executable node status, configuration, and result regions available before a reverse run', () => {
    const node = createCanvasModuleNode('reverse-workbench-regions', 'reverse_agent', { x: 0, y: 0 });
    const data = {
      ...node.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'gemini-video', displayName: 'Gemini Video', modelId: 'gemini-video', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    expect(screen.getByLabelText('Agent 反推 节点状态')).toHaveTextContent('等待运行');
    expect(screen.getByLabelText('Agent 反推 节点配置')).toBeInTheDocument();
    expect(screen.getByLabelText('Agent 反推 节点结果')).toBeInTheDocument();
    expect(screen.getByTestId('module-node-card')).not.toHaveTextContent(/反推anget/iu);
  });

  it('presents reverse analysis as one compact node workbench instead of a stacked legacy form', () => {
    const node = createCanvasModuleNode('reverse-studio-layout', 'reverse_agent', { x: 0, y: 0 });
    const data = {
      ...node.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'gemini-video', displayName: 'Gemini Video', modelId: 'gemini-video', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    const workbench = screen.getByLabelText('Agent task configuration');
    expect(workbench).toHaveClass('module-node__summary--agent-studio');
    expect(workbench.querySelector('[data-agent-region="media"]')).toBeNull();
    expect(workbench.querySelector('[data-agent-region="route"]')).toHaveClass('module-node__agent-route-region');
    expect(workbench.querySelector('[data-agent-region="task"]')).not.toBeNull();
    expect(workbench.querySelector('[data-agent-region="knowledge"]')).toHaveClass('module-node__agent-knowledge');
    expect(workbench.querySelector('[data-agent-region="result"]')).not.toBeNull();
    expect(workbench.querySelector('[data-agent-region="actions"]')).not.toBeNull();
    const result = screen.getByLabelText('Agent 反推 节点结果');
    const actions = workbench.querySelector<HTMLElement>('[data-agent-region="actions"]')!;
    expect(result.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps connected media and the reverse language-model selector in one Canvas-style control strip', () => {
    const node = createCanvasModuleNode('reverse-model-strip', 'reverse_agent', { x: 0, y: 0 });
    const data = {
      ...node.data,
      reverseAgentRoutes: [
        { provider: 'comfly', modelRoute: 'reverse-gemini', displayName: 'Gemini 3.1 Pro', modelId: 'gemini-3.1-pro', capabilities: ['reverse_prompt', 'gemini_native'] },
      ],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    const strip = screen.getByLabelText('Reverse model control strip');
    expect(strip).toContainElement(screen.getByLabelText('Reverse media input'));
    expect(strip).toContainElement(screen.getByLabelText('Agent model route'));
    expect(screen.getByRole('option', { name: 'Gemini 3.1 Pro' })).toBeVisible();
    expect(screen.getByLabelText('Agent model route')).not.toHaveTextContent('Comfly');
  });

  it('uses the exact Canvas 408:2 labels for the reverse-agent configuration form', () => {
    const node = createCanvasModuleNode('reverse-canvas-labels', 'reverse_agent', { x: 0, y: 0 });
    const data = {
      ...node.data,
      reverseAgentRoutes: [
        { provider: 'comfly', modelRoute: 'reverse-gemini', displayName: 'Gemini 3.1 Pro', modelId: 'gemini-3.1-pro', capabilities: ['reverse_prompt', 'gemini_native'] },
      ],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    expect(screen.getByText('语言模型')).toBeVisible();
    expect(screen.getByText('角色')).toBeVisible();
    expect(screen.getByText('反推任务')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Knowledge bases' })).toHaveTextContent('知识库');
    expect(screen.queryByRole('button', { name: '引用图片' })).not.toBeInTheDocument();
  });

  it('isolates the reverse Agent card from the legacy workbench stylesheet', () => {
    const node = createCanvasModuleNode('reverse-canvas-shell', 'reverse_agent', { x: 0, y: 0 });
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);

    const card = screen.getByLabelText('Agent task configuration').closest('article');
    expect(card).toHaveClass('module-node--reverse');
    expect(card).not.toHaveClass('module-node--workbench');
  });

  it('limits the Agent model selector to configured reverse-capable routes', () => {
    const node = createCanvasModuleNode('reverse-routes', 'reverse_agent', { x: 0, y: 0 });
    const applyReverseAgentConfig = vi.fn(async () => true);
    useAppStore.setState({
      applyReverseAgentConfig,
      knowledgeBases: [
        { schemaVersion: 1, knowledgeBaseId: 'brand-rules', displayName: 'Brand rules', activeVersion: 2, activeContentHash: 'a'.repeat(64), status: 'active', versionCount: 2, versions: [], stateRevision: 1, lastFailure: null, lastRollbackAt: null },
        { schemaVersion: 1, knowledgeBaseId: 'scene-skill', displayName: 'Scene skill', activeVersion: 3, activeContentHash: 'b'.repeat(64), status: 'active', versionCount: 2, versions: [], stateRevision: 1, lastFailure: null, lastRollbackAt: null },
      ],
    });
    const data = {
      ...node.data,
      reverseAgentRoutes: [
        { provider: 'comfly', modelRoute: 'reverse-gemini', displayName: 'Reverse Gemini', modelId: 'reverse-gemini', capabilities: ['reverse_prompt', 'gemini_native'] },
        { provider: 'comfly', modelRoute: 'vision-chat-reverse', displayName: 'Vision Chat Reverse', modelId: 'vision-chat-reverse', capabilities: ['chat', 'vision', 'reverse_prompt'] },
        { provider: 'comfly', modelRoute: 'gemini-native', displayName: 'Gemini Native', modelId: 'gemini-native', capabilities: ['gemini_native'] },
        { provider: 'comfly', modelRoute: 'reverse-prompt', displayName: 'Reverse Prompt', modelId: 'reverse-prompt', capabilities: ['reverse_prompt'] },
        { provider: 'comfly', modelRoute: 'image-only', displayName: 'Image only', modelId: 'image-only', capabilities: ['image_generation'] },
      ],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    expect(screen.getByRole('combobox', { name: 'Agent model route' })).toBeVisible();
    expect(screen.getByRole('option', { name: 'Reverse Gemini' })).toBeVisible();
    expect(screen.getByRole('option', { name: 'Vision Chat Reverse' })).toBeVisible();
    expect(screen.queryByRole('option', { name: 'Gemini Native' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Reverse Prompt' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Image only' })).not.toBeInTheDocument();
  });

  it('uses the Canvas knowledge selector for reverse Agent', () => {
    const node = createCanvasModuleNode('reverse-canvas-knowledge', 'reverse_agent', { x: 0, y: 0 });
    useAppStore.setState({ knowledgeBases: [] } as never);
    const data = {
      ...node.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'reverse-gemini', displayName: 'Reverse Gemini', modelId: 'reverse-gemini', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    const trigger = screen.getByTestId('reverse-knowledge-trigger');
    expect(trigger).toBeVisible();
    fireEvent.click(trigger);
    const picker = screen.getByTestId('reverse-knowledge-picker');
    expect(picker).toHaveAttribute('role', 'dialog');
    expect(picker).toHaveAttribute('data-anchor', 'reverse-agent-footer');
    expect(within(picker).getByTestId('knowledge-picker-search')).toBeVisible();
    expect(within(picker).getAllByRole('button', { name: /knowledge-option-/ })).toHaveLength(2);
  });
  it('opens the knowledge-base picker from its own control and keeps each project base selectable', () => {
    const node = createCanvasModuleNode('reverse-knowledge-picker', 'reverse_agent', { x: 0, y: 0 });
    useAppStore.setState({
      knowledgeBases: [
        { schemaVersion: 1, knowledgeBaseId: 'brand-rules', displayName: 'Brand rules', activeVersion: 2, activeContentHash: 'a'.repeat(64), status: 'active', versionCount: 2, versions: [], stateRevision: 1, lastFailure: null, lastRollbackAt: null },
        { schemaVersion: 1, knowledgeBaseId: 'scene-skill', displayName: 'Scene skill', activeVersion: 3, activeContentHash: 'b'.repeat(64), status: 'active', versionCount: 2, versions: [], stateRevision: 1, lastFailure: null, lastRollbackAt: null },
      ],
    } as never);
    const data = {
      ...node.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'reverse-gemini', displayName: 'Reverse Gemini', modelId: 'reverse-gemini', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'Knowledge bases' }));

    expect(screen.getByRole('menu', { name: 'Agent knowledge bases' })).toBeVisible();
    expect(screen.getByLabelText('Use Brand rules')).toBeEnabled();
    fireEvent.click(screen.getByLabelText('Use Brand rules'));
    expect(screen.getByLabelText('Use Brand rules')).toBeChecked();
  });

  it('keeps the two required reverse knowledge bases visible for Comfly reverse and Skill-assisted image generation', () => {
    const node = createCanvasModuleNode('reverse-required-knowledge', 'reverse_agent', { x: 0, y: 0 });
    node.data.config = {
      ...node.data.config,
      knowledgeBaseIds: ['scene-skill', 'ecommerce-detail-knowledge'],
    };
    useAppStore.setState({ knowledgeBases: [] } as never);
    const data = {
      ...node.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'reverse-gemini', displayName: 'Reverse Gemini', modelId: 'reverse-gemini', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'Knowledge bases' }));

    expect(screen.getByLabelText('Use 场景 Skill')).toBeChecked();
    expect(screen.getByText('产品场景、构图、材质与灯光规则')).toBeVisible();
    expect(screen.getByLabelText('Use 电商详情页知识库')).toBeChecked();
    expect(screen.getByText('详情页结构、卖点表达与视觉规范')).toBeVisible();
  });

  it('replaces a stale saved Agent route with the active provider route', async () => {
    const node = createCanvasModuleNode('reverse-unavailable', 'reverse_agent', { x: 0, y: 0 });
    node.data.config = {
      modelRoute: 'removed-route',
      role: 'Video director',
      task: 'Analyze the original MP4',
      knowledgeBaseIds: ['brand-rules', 'scene-skill'],
    };
    const runReverseAgentNode = vi.fn(async () => ({ positivePrompt: 'Reverse result' }));
    useAppStore.setState({ runReverseAgentNode } as never);
    const data = {
      ...node.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'available-route', displayName: 'Available route', modelId: 'available-route', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    await waitFor(() => expect(screen.getByLabelText('Agent model route')).toHaveValue('available-route'));
    expect(screen.getByRole('button', { name: 'Start reverse analysis' })).toBeEnabled();
    expect(screen.queryByText('当前模型路线不可用，请先切换供应商或重新选择模型。')).not.toBeInTheDocument();
    expect(runReverseAgentNode).not.toHaveBeenCalled();
  });

  it.each([
    ['CREDENTIALS_LOCKED', 'The encrypted credential is locked.', 'API 密钥已锁定，请重新解锁后再反推。'],
    ['PROVIDER_UNAVAILABLE', 'Selected reverse route is unavailable.', '所选反推模型当前不可用，请重新选择模型。'],
    ['PROVIDER_INVALID_RESPONSE', 'The provider answered with an unexpected body.', '反推响应未通过格式校验，尚未取得可用结果。'],
    ['PROVIDER_INVALID_RESPONSE', 'opaque', '模型输出达到长度上限而被截断，请减少素材或缩短任务后重试。', 'TRUNCATED'],
    ['PROVIDER_INVALID_RESPONSE', 'opaque', '模型返回的内容不是有效 JSON，请重试或更换反推模型。', 'INVALID_JSON'],
    ['PROVIDER_INVALID_RESPONSE', 'opaque', '模型返回内容缺少反推必填字段，请重试或更换反推模型。', 'CORE_SCHEMA_INVALID'],
    ['PROVIDER_INVALID_RESPONSE', 'opaque', '模型返回结果不属于本次反推运行，已拒绝使用。', 'IDENTITY_MISMATCH'],
    ['PROVIDER_INVALID_RESPONSE', 'opaque', '模型没有完整说明每个素材的职责，请重试或减少素材。', 'MEDIA_RESPONSIBILITIES_INVALID'],
    ['PROVIDER_TIMEOUT', 'Provider request timed out after 120000ms.', '反推已等待 120 秒仍未返回，请减少素材、切换快速或标准反推，或更换模型后重试。'],
    ['PROVIDER_ERROR', 'Provider request failed with status 503', '反推模型上游返回 503，当前路线暂时异常，请稍后重试或切换模型。'],
    ['MISSING_ASSET', 'Managed media read failed.', '反推素材读取失败，请重新连接素材。'],
    ['PROJECT_CONFIG_SAVE_FAILED', 'Reverse configuration could not be saved.', '反推配置保存失败，请先确认画布可以保存后重试。'],
  ])('shows a safe reverse-analysis error for %s', async (...args) => {
    const [code, message, expected, reason] = args;
    const node = createCanvasModuleNode(`reverse-error-${code}`, 'reverse_agent', { x: 0, y: 0 });
    node.data.config = {
      modelRoute: 'reverse-gemini',
      role: 'Commercial visual analyst',
      task: 'Analyze the connected managed image.',
      knowledgeBaseIds: [],
    };
    useAppStore.setState({
      runReverseAgentNode: vi.fn(async () => {
        throw Object.assign(new Error(message), { code, ...(reason === undefined ? {} : { reason }) });
      }),
    } as never);
    const data = {
      ...node.data,
      reverseAgentRoutes: [{
        provider: 'comfly', modelRoute: 'reverse-gemini', displayName: 'Reverse Gemini', modelId: 'reverse-gemini',
        capabilities: ['reverse_prompt', 'gemini_native'],
      }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Start reverse analysis' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Start reverse analysis' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(expected));
    expect(screen.getByRole('alert')).not.toHaveTextContent(message);
  });

  it('localizes a persisted provider timeout after the node is reloaded', () => {
    const node = createCanvasModuleNode('reverse-persisted-timeout', 'reverse_agent', { x: 0, y: 0 });
    node.data.config = {
      modelRoute: 'reverse-gemini',
      role: 'Commercial visual analyst',
      task: 'Analyze the connected managed image.',
      knowledgeBaseIds: [],
      reverseAgentRunState: 'failed',
      reverseAgentError: 'Provider request timed out after 300000ms',
    };
    const data = {
      ...node.data,
      reverseAgentRoutes: [{
        provider: 'comfly', modelRoute: 'reverse-gemini', displayName: 'Reverse Gemini', modelId: 'reverse-gemini',
        capabilities: ['reverse_prompt', 'gemini_native'],
      }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    expect(screen.getByRole('alert')).toHaveTextContent('反推已等待 300 秒仍未返回');
    expect(screen.getByRole('alert')).not.toHaveTextContent('300000ms');
  });

  it('sanitizes fallback reverse errors containing provider response, base64, token, and path-shaped data', async () => {
    const node = createCanvasModuleNode('reverse-error-fallback-sanitizer', 'reverse_agent', { x: 0, y: 0 });
    node.data.config = {
      modelRoute: 'reverse-gemini',
      role: 'Commercial visual analyst',
      task: 'Analyze the connected managed image.',
      knowledgeBaseIds: [],
    };
    const responseBody = '{"error":{"message":"Authorization: Bearer sk-review-secret-token"}}';
    const base64Payload = 'data:image/png;base64,QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=';
    const tokenValue = 'token=review-token-value';
    const privatePath = 'C:\\Users\\Administrator\\Documents\\private\\source.png';
    const unsafeMessage = `Provider response body: ${responseBody} | ${base64Payload} | ${tokenValue} | ${privatePath}`;
    useAppStore.setState({
      runReverseAgentNode: vi.fn(async () => {
        throw new Error(unsafeMessage);
      }),
    } as never);
    const data = {
      ...node.data,
      reverseAgentRoutes: [{
        provider: 'comfly', modelRoute: 'reverse-gemini', displayName: 'Reverse Gemini', modelId: 'reverse-gemini',
        capabilities: ['reverse_prompt', 'gemini_native'],
      }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Start reverse analysis' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Start reverse analysis' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeVisible());
    const alertText = screen.getByRole('alert').textContent ?? '';
    expect(alertText).not.toContain('Authorization');
    expect(alertText).not.toContain('sk-review-secret-token');
    expect(alertText).not.toContain('data:image/png;base64');
    expect(alertText).not.toContain('review-token-value');
    expect(alertText).not.toContain('C:\\Users\\Administrator\\Documents\\private\\source.png');
  });

  it('treats a persisted reverse running flag without a local run as interrupted and retryable', async () => {
    const node = createCanvasModuleNode('reverse-stop-action', 'reverse_agent', { x: 0, y: 0 });
    node.data.config = {
      modelRoute: 'reverse-gemini',
      role: 'Commercial visual analyst',
      task: 'Analyze the connected managed image.',
      knowledgeBaseIds: [],
      reverseAgentRunState: 'running',
    };
    const data = {
      ...node.data,
      reverseAgentRoutes: [{
        provider: 'comfly', modelRoute: 'reverse-gemini', displayName: 'Reverse Gemini', modelId: 'reverse-gemini',
        capabilities: ['reverse_prompt', 'gemini_native'],
      }],
    } as typeof node.data;

    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);

    expect(screen.getByRole('button', { name: 'Start reverse analysis' })).toBeEnabled();
    expect(screen.getByText('上次反推已中断，可以重新执行。')).toBeVisible();
  });

  it('keeps Agent form pointer input from starting a canvas drag', () => {
    const node = createCanvasModuleNode('reverse-pointer-inputs', 'reverse_agent', { x: 0, y: 0 });
    const data = {
      ...node.data,
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'reverse-gemini', displayName: 'Reverse Gemini', modelId: 'reverse-gemini', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;
    const dragStart = vi.fn();

    render(<ReactFlowProvider><div onPointerDown={dragStart}><ModuleNodeCard id={node.id} data={data} selected={false} /></div></ReactFlowProvider>);

    fireEvent.pointerDown(screen.getByLabelText('Agent model route'));
    fireEvent.pointerDown(screen.getByLabelText('Role positioning'));
    fireEvent.pointerDown(screen.getByLabelText('Analysis task'));

    expect(dragStart).not.toHaveBeenCalled();
  });

  it.each(['music_generation', 'speech_generation'] as const)('ignores forged durable route availability for %s', (moduleType) => {
    const node = createCanvasModuleNode(`forged-${moduleType}`, moduleType, { x: 0, y: 0 });
    node.data.config = { routeAvailable: true, routeDisplayName: 'Forged durable route' };

    render(
      <ReactFlowProvider>
        <ModuleNodeCard id={node.id} data={node.data} selected={false} />
      </ReactFlowProvider>,
    );

    expect(screen.getByText('未配置模型')).toBeVisible();
  });
  it('shows only model names in image and video generation selectors', () => {
    const image = createCanvasModuleNode('plain-image-model-names', 'image_generation', { x: 0, y: 0 });
    const imageData = {
      ...image.data,
      imageGenerationRoutes: [
        { provider: 'comfly', modelRoute: 'comfly-image', displayName: 'GPT Image 2', modelId: 'gpt-image-2', capabilities: ['image_generation'] },
        { provider: 'relayme', modelRoute: 'relayme-image', displayName: 'Gemini Image', modelId: 'gemini-image', capabilities: ['image_generation'] },
      ],
    } as typeof image.data;
    const { rerender } = render(<ReactFlowProvider><ModuleNodeCard id={image.id} data={imageData} selected={false} /></ReactFlowProvider>);
    openImageGenerationEditor();
    const imageSelector = screen.getByLabelText('Image generation model route');
    expect(within(imageSelector).getByRole('option', { name: 'GPT Image 2', hidden: true })).toBeInTheDocument();
    expect(within(imageSelector).getByRole('option', { name: 'Gemini Image', hidden: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '折叠图片生成节点' }));
    expect(imageSelector).not.toHaveTextContent('Comfly ·');
    expect(imageSelector).not.toHaveTextContent('RelayMe ·');

    const video = createCanvasModuleNode('plain-video-model-names', 'video_generation', { x: 0, y: 0 });
    const videoData = {
      ...video.data,
      videoGenerationRoutes: [
        { provider: 'comfly', modelRoute: 'comfly-video', displayName: 'Veo 3.1 Fast', modelId: 'veo-3.1-fast', capabilities: ['video_generation'] },
        { provider: 'relayme', modelRoute: 'relayme-video', displayName: 'Kling 3', modelId: 'kling-3', capabilities: ['video_generation'] },
      ],
    } as typeof video.data;
    rerender(<ReactFlowProvider><ModuleNodeCard id={video.id} data={videoData} selected={false} /></ReactFlowProvider>);
    openVideoGenerationEditor();
    const videoSelector = screen.getByLabelText('Video preview model');
    expect(within(videoSelector).getByRole('option', { name: 'Veo 3.1 Fast', hidden: true })).toBeInTheDocument();
    expect(within(videoSelector).getByRole('option', { name: 'Kling 3', hidden: true })).toBeInTheDocument();
    expect(videoSelector).not.toHaveTextContent('Comfly ·');
    expect(videoSelector).not.toHaveTextContent('RelayMe ·');
  });
});
