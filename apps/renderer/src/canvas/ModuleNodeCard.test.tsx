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
    expect(screen.getByText('提示词')).toBeVisible();
    expect(screen.getByText('Prompt')).toBeVisible();
    expect(screen.getByText('结果')).toBeVisible();
    expect(screen.getByText('空闲')).toBeVisible();
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

    expect(screen.getAllByText('Product front')).toHaveLength(2);
    expect(screen.getByText('2 × 3')).toBeVisible();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '更换图像 / Replace image' }));
    expect(importImageForModule).toHaveBeenCalledWith('image-input');
  });

  it('uses a real image icon instead of a text placeholder for an empty image input', () => {
    const node = createCanvasModuleNode('image-input', 'image_input', { x: 0, y: 0 });

    render(
      <ReactFlowProvider>
        <ModuleNodeCard id={node.id} data={node.data} selected={false} />
      </ReactFlowProvider>,
    );

    const preview = document.querySelector('.module-node__asset-preview');
    expect(preview).not.toHaveTextContent('IMG');
    expect(preview?.querySelector('svg')).not.toBeNull();
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

    expect(screen.getByText('需要配置兼容模型 / Compatible model required')).toBeVisible();
  });
});
