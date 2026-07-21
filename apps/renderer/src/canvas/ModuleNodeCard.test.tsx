import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReactFlowProvider } from '@xyflow/react';
import { createCanvasModuleNode } from '@agent-canvas/domain';
import { ModuleNodeCard } from './ModuleNodeCard';
import { resetAppStoreForTests, useAppStore } from '../app/app-store';

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
});

describe('ModuleNodeCard', () => {
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

    render(
      <ReactFlowProvider>
        <ModuleNodeCard id={node.id} data={node.data} selected={false} />
      </ReactFlowProvider>,
    );

    expect(screen.getAllByText('图片生成')[0]).toBeVisible();
    expect(screen.getByText('Image Generation')).toBeVisible();
    expect(document.querySelector('[data-port-id="prompt"][data-port-direction="input"]')).not.toBeNull();
    expect(document.querySelector('[data-port-id="result"][data-port-direction="output"]')).not.toBeNull();
    expect(screen.getByTitle('提示词 / Prompt')).toBeVisible();
    expect(screen.queryByText('Prompt')).not.toBeInTheDocument();
    expect(screen.getByTitle('提示词 / Prompt')).toHaveTextContent('提示词');
    expect(screen.getByText('结果')).toBeVisible();
    expect(screen.getByText('空闲')).toBeVisible();
    expect(screen.queryByText('能力')).not.toBeInTheDocument();
    expect(document.querySelector('.module-node__summary')).not.toHaveStyle({ overflow: 'auto' });
    expect(document.querySelector('.module-node__icon')).toHaveAttribute('data-icon-category', 'generation');
    expect(document.querySelector('.module-node__icon svg')).toHaveAttribute('width', '18');
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

  it('renders managed preview metadata and opens only the confined desktop import action', () => {
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
    expect(screen.getAllByText('Product front')).toHaveLength(2);
    expect(screen.getByText('2 × 3')).toBeVisible();
    expect(document.querySelector('.module-node__asset-preview')).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '更换图像 / Replace image' }));
    expect(importImageForModule).toHaveBeenCalledWith('image-input');
  });

  it('uses a compact media-first empty state instead of a text-heavy image card', () => {
    const node = createCanvasModuleNode('image-input', 'image_input', { x: 0, y: 0 });

    render(
      <ReactFlowProvider>
        <ModuleNodeCard id={node.id} data={node.data} selected={false} />
      </ReactFlowProvider>,
    );

    const preview = document.querySelector('.module-node__media-empty');
    expect(preview).toHaveTextContent('导入图片');
    expect(preview).not.toHaveTextContent('暂无受管图像');
    expect(preview?.querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('button', { name: '导入图像 / Import image' })).toBeVisible();
  });

  it('offers a confined MP4 import action for an empty video input', () => {
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
});
