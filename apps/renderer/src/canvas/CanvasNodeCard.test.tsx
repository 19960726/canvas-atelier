import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { ReactFlowProvider } from '@xyflow/react';
import { CanvasNodeCard } from './CanvasNodeCard';

afterEach(() => {
  cleanup();
});

describe('CanvasNodeCard', () => {
  it('renders semantic presentation fields with shared node anatomy', () => {
    render(
      <ReactFlowProvider>
        <CanvasNodeCard
          kind="prompt"
          tone="teal"
          eyebrow="Agent plan"
          title="Hero product composition"
          subtitle="3 references"
          status="Ready"
          selected
        />
      </ReactFlowProvider>,
    );

    const node = screen.getByTestId('canvas-node-card');
    expect(node).toHaveAttribute('data-node-kind', 'prompt');
    expect(node).toHaveAttribute('data-tone', 'teal');
    expect(node).toHaveClass('is-selected');
    expect(screen.getByText('Agent plan')).toBeVisible();
    expect(node.querySelector('.canvas-node__body .canvas-node__meta')).toHaveTextContent('3 references');
    expect(screen.getByText('Ready')).toBeVisible();
    expect(node.querySelector('.canvas-node__type-icon')).not.toBeNull();
  });
});
