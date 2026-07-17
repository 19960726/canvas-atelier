import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { ReactFlowProvider } from '@xyflow/react';
import { createCanvasModuleNode } from '@agent-canvas/domain';
import { ModuleNodeCard } from './ModuleNodeCard';

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
});
