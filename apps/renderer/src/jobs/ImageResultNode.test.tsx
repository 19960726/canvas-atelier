import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { ReactFlowProvider } from '@xyflow/react';
import { ImageResultNode } from './ImageResultNode';
import { resetAppStoreForTests, useAppStore } from '../app/app-store';

afterEach(() => {
  cleanup();
  resetAppStoreForTests();
});

describe('ImageResultNode', () => {
  it('uses the managed project image as the visual body without exposing the durable asset id', () => {
    useAppStore.setState({
      projectImages: [{
        assetId: '0123456789abcdef',
        byteSize: 42,
        displayUrl: 'novus-asset://project/session/0123456789abcdef',
        extension: 'png',
        height: 900,
        label: 'Hero result',
        mediaType: 'image/png',
        origin: 'generated',
        sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        usageCount: 1,
        width: 1600,
      }],
    });

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
            resultAssetId: '0123456789abcdef',
          }}
        />
      </ReactFlowProvider>,
    );

    const node = screen.getByTestId('canvas-node-card');
    expect(node).toHaveAttribute('data-node-kind', 'image_result');
    expect(screen.getByText('Image result')).toBeVisible();
    expect(screen.getByText('Result')).toBeVisible();
    expect(screen.getByRole('img', { name: 'Hero result' })).toHaveAttribute(
      'src',
      'novus-asset://project/session/0123456789abcdef',
    );
    expect(document.querySelector('.image-result-node__media')).toHaveStyle({ aspectRatio: '1600 / 900' });
    expect(screen.getByText('1600 × 900')).toBeVisible();
    expect(screen.queryByText('0123456789abcdef')).not.toBeInTheDocument();
    expect(node.querySelector('.canvas-node__type-icon')).not.toBeNull();
  });

  it('bounds an extreme result ratio instead of creating an unbounded node', () => {
    useAppStore.setState({
      projectImages: [{
        assetId: '0123456789abcdef',
        byteSize: 42,
        displayUrl: 'novus-asset://project/session/0123456789abcdef',
        extension: 'png',
        height: 8192,
        label: 'Tall result',
        mediaType: 'image/png',
        origin: 'generated',
        sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        usageCount: 1,
        width: 1,
      }],
    });

    render(
      <ReactFlowProvider>
        <ImageResultNode
          id="image-result-extreme"
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
            title: 'Tall result',
            subtitle: 'Model',
            status: 'Result',
            resultAssetId: '0123456789abcdef',
          }}
        />
      </ReactFlowProvider>,
    );

    expect(document.querySelector('.image-result-node__media')).toHaveStyle({ aspectRatio: '9 / 16' });
  });
});
