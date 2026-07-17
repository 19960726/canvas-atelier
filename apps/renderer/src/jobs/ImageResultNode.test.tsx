import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { ReactFlowProvider } from '@xyflow/react';
import { ImageResultNode } from './ImageResultNode';

afterEach(() => {
  cleanup();
});

describe('ImageResultNode', () => {
  it('uses the shared card anatomy and shows the durable asset label', () => {
    render(
      <ReactFlowProvider>
        <ImageResultNode
          id="image-result-1"
          type="image_result"
          positionAbsoluteX={0}
          positionAbsoluteY={0}
          selected={false}
          draggable
          dragging={false}
          selectable
          deletable
          isConnectable
          zIndex={1}
          data={{
            kind: 'image_result',
            tone: 'teal',
            eyebrow: 'Image result',
            title: 'Hero result',
            subtitle: 'GPT Image',
            status: 'Result',
            resultAssetId: 'asset-final-hero',
          }}
        />
      </ReactFlowProvider>,
    );

    const node = screen.getByTestId('canvas-node-card');
    expect(node).toHaveAttribute('data-node-kind', 'image_result');
    expect(screen.getByText('Image result')).toBeVisible();
    expect(screen.getByText('Result')).toBeVisible();
    expect(screen.getByText('asset-final-hero')).toBeVisible();
    expect(node.querySelector('.canvas-node__type-icon')).not.toBeNull();
  });
});
