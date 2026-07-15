import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrderedReference } from '@agent-canvas/domain';
import { ReferenceOrderList } from './ReferenceOrderList';

afterEach(() => cleanup());

const references: OrderedReference[] = [
  { assetId: 'product', label: 'Product', role: 'product_identity', position: 0 },
  { assetId: 'scene', label: 'Scene', role: 'scene_composition', position: 1 },
  { assetId: 'prop', label: 'Prop', role: 'prop_reference', position: 2 },
];

describe('ReferenceOrderList', () => {
  it('previews during drag without committing and commits once at drop', () => {
    const onPreviewOrder = vi.fn();
    const onCommitOrder = vi.fn();
    render(<ReferenceOrderList references={references} onPreviewOrder={onPreviewOrder} onCommitOrder={onCommitOrder} />);

    fireEvent.dragStart(screen.getByText('Scene'));
    fireEvent.dragOver(screen.getByText('Product'));

    expect(onPreviewOrder).toHaveBeenLastCalledWith(['scene', 'product', 'prop']);
    expect(onCommitOrder).not.toHaveBeenCalled();

    fireEvent.drop(screen.getByText('Product'));

    expect(onCommitOrder).toHaveBeenCalledTimes(1);
    expect(onCommitOrder).toHaveBeenCalledWith(['scene', 'product', 'prop']);
  });

  it('restores persisted order when a drag ends outside a valid drop target', () => {
    const onPreviewOrder = vi.fn();
    const onCommitOrder = vi.fn();
    render(<ReferenceOrderList references={references} onPreviewOrder={onPreviewOrder} onCommitOrder={onCommitOrder} />);

    fireEvent.dragStart(screen.getByText('Scene'));
    fireEvent.dragOver(screen.getByText('Product'));
    expect(onPreviewOrder).toHaveBeenLastCalledWith(['scene', 'product', 'prop']);

    fireEvent.dragEnd(screen.getByText('Scene'));

    expect(onPreviewOrder).toHaveBeenLastCalledWith(['product', 'scene', 'prop']);
    expect(onCommitOrder).not.toHaveBeenCalled();
  });

  it('restores persisted order when Escape cancels an active drag', () => {
    const onPreviewOrder = vi.fn();
    const onCommitOrder = vi.fn();
    render(<ReferenceOrderList references={references} onPreviewOrder={onPreviewOrder} onCommitOrder={onCommitOrder} />);

    fireEvent.dragStart(screen.getByText('Product'));
    fireEvent.dragOver(screen.getByLabelText('Drop reference at end'));
    expect(onPreviewOrder).toHaveBeenLastCalledWith(['scene', 'prop', 'product']);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onPreviewOrder).toHaveBeenLastCalledWith(['product', 'scene', 'prop']);
    expect(onCommitOrder).not.toHaveBeenCalled();
  });
  it('moves the first reference to the end without persisting before drop', () => {
    const onPreviewOrder = vi.fn();
    const onCommitOrder = vi.fn();
    render(<ReferenceOrderList references={references} onPreviewOrder={onPreviewOrder} onCommitOrder={onCommitOrder} />);

    fireEvent.dragStart(screen.getByText('Product'));
    fireEvent.dragOver(screen.getByLabelText('Drop reference at end'));

    expect(onPreviewOrder).toHaveBeenLastCalledWith(['scene', 'prop', 'product']);
    expect(onCommitOrder).not.toHaveBeenCalled();

    fireEvent.drop(screen.getByLabelText('Drop reference at end'));

    expect(onCommitOrder).toHaveBeenCalledTimes(1);
    expect(onCommitOrder).toHaveBeenCalledWith(['scene', 'prop', 'product']);
  });
  it('previews and commits exactly once for a keyboard reorder command', () => {
    const onPreviewOrder = vi.fn();
    const onCommitOrder = vi.fn();
    render(<ReferenceOrderList references={references} onPreviewOrder={onPreviewOrder} onCommitOrder={onCommitOrder} />);

    fireEvent.click(screen.getByRole('button', { name: 'Move Scene up' }));

    expect(onPreviewOrder).toHaveBeenCalledTimes(1);
    expect(onPreviewOrder).toHaveBeenCalledWith(['scene', 'product', 'prop']);
    expect(onCommitOrder).toHaveBeenCalledTimes(1);
    expect(onCommitOrder).toHaveBeenCalledWith(['scene', 'product', 'prop']);
    expect(screen.getByRole('button', { name: 'Move Scene up' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Move Scene down' }));

    expect(onPreviewOrder).toHaveBeenLastCalledWith(['product', 'scene', 'prop']);
    expect(onCommitOrder).toHaveBeenCalledTimes(2);
    expect(onCommitOrder).toHaveBeenLastCalledWith(['product', 'scene', 'prop']);
  });
});