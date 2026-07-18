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
  it('renders stable typed handles from the registry', () => {
    const node = createCanvasModuleNode('generator', 'image_generation_v2', { x: 0, y: 0 });

    render(
      <ReactFlowProvider>
        <ModuleNodeCard id={node.id} data={node.data} selected={false} />
      </ReactFlowProvider>,
    );

    expect(screen.getByText('Image Generation v2')).toBeVisible();
    expect(document.querySelector('[data-port-id="prompt"][data-port-direction="input"]')).not.toBeNull();
    expect(document.querySelector('[data-port-id="result"][data-port-direction="output"]')).not.toBeNull();
    expect(screen.getByText('Prompt')).toBeVisible();
    expect(screen.getByText('Result')).toBeVisible();
    expect(screen.getByText('Idle')).toBeVisible();
    expect(document.querySelector('.module-node__icon')).toHaveAttribute('data-icon-category', 'generation');
    expect(document.querySelector('.module-node__icon svg')).toHaveAttribute('width', '18');
  });

  it('keeps selection visible without changing the module identity', () => {
    const node = createCanvasModuleNode('generator', 'image_generation_v2', { x: 0, y: 0 });

    render(
      <ReactFlowProvider>
        <ModuleNodeCard id={node.id} data={node.data} selected />
      </ReactFlowProvider>,
    );

    expect(document.querySelector('.module-node')).toHaveClass('is-selected');
    expect(document.querySelector('[data-module-type="image_generation_v2"]')).not.toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: 'Replace image' }));
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

    expect(screen.getByRole('checkbox', { name: 'Select Product front' })).toBeChecked();
    expect(screen.getByText('Reference 1')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Move Product front up' })).toBeDisabled();
  });
});
