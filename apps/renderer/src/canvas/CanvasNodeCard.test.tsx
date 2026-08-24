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
    expect(node).toHaveClass('canvas-node--compact');
    expect(node).toHaveClass('is-selected');
    expect(screen.getByText('Agent plan')).toBeVisible();
    expect(node.querySelector('.canvas-node__body .canvas-node__meta')).toHaveTextContent('3 references');
    const footerSubtitle = node.querySelector('.canvas-node__footer > span');
    expect(footerSubtitle).not.toBeNull();
    expect(footerSubtitle).toHaveTextContent('3 references');
    expect(footerSubtitle?.querySelector('span')).toBeNull();
    expect(screen.getByText('Ready')).toBeVisible();
    expect(node.querySelector('.canvas-node__type-icon')).not.toBeNull();
  });

  it('marks both generic-card endpoints with the shared directional connector contract', () => {
    render(
      <ReactFlowProvider>
        <CanvasNodeCard
          kind="reference"
          tone="teal"
          eyebrow="Reference"
          title="Product reference"
          subtitle="starter-product"
          status="Reference"
        />
      </ReactFlowProvider>,
    );

    const handles = screen.getByTestId('canvas-node-card').querySelectorAll('.react-flow__handle');
    expect(handles).toHaveLength(2);
    expect(handles[0]).toHaveAttribute('data-port-direction', 'input');
    expect(handles[1]).toHaveAttribute('data-port-direction', 'output');
  });

  it('does not render the removed legacy colour rail', () => {
    render(
      <ReactFlowProvider>
        <CanvasNodeCard
          kind="placement_preview"
          tone="blue"
          eyebrow="Placement"
          title="Placement preview"
          subtitle="16:9 / 2 objects"
          status="2 layers"
        />
      </ReactFlowProvider>,
    );

    const node = screen.getByTestId('canvas-node-card');
    expect(node.querySelector('.canvas-node__rail')).toBeNull();
  });
});
