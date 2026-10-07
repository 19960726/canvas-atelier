import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectedAgentMediaSlots, type ConnectedAgentMediaSlotItem } from './ConnectedAgentMediaSlots';

afterEach(cleanup);

const image = (assetId: string, edgeId = `edge-${assetId}`): ConnectedAgentMediaSlotItem => ({
  edgeId, kind: 'image', assetId, label: assetId, previewUrl: `novus-asset://current/${assetId}`,
});
const slot = (index: number) => screen.getByLabelText(`Agent media slot ${index}`, { exact: true });

describe('connected material interaction ownership', () => {
  it('cancels a pointer reorder when reconnecting changes the asset at its old index', () => {
    const onReorder = vi.fn();
    const media = [image('A'), image('B'), image('C')];
    const { rerender } = render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onReorder={onReorder} />);
    fireEvent.pointerDown(slot(2), { button: 0, pointerId: 7 });
    rerender(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={[media[0]!, image('replacement', 'edge-B'), media[2]!]} onReorder={onReorder} />);
    fireEvent.pointerUp(slot(3), { button: 0, pointerId: 7 });
    expect(onReorder).not.toHaveBeenCalled();
    expect(slot(2)).toHaveAttribute('title', '2. replacement');
  });

  it('cancels a native reorder when its source asset is removed during the drag', () => {
    const onReorder = vi.fn();
    const media = [image('A'), image('B'), image('C')];
    const { rerender } = render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onReorder={onReorder} />);
    fireEvent.dragStart(slot(2));
    rerender(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={[media[0]!, media[2]!]} onReorder={onReorder} />);
    fireEvent.drop(slot(1));
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('cancels a pointer reorder when the external connection order changes', () => {
    const onReorder = vi.fn();
    const media = [image('A'), image('B'), image('C')];
    const { rerender } = render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onReorder={onReorder} />);
    fireEvent.pointerDown(slot(2), { button: 0, pointerId: 7 });
    rerender(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={[media[1]!, media[0]!, media[2]!]} onReorder={onReorder} />);
    fireEvent.pointerUp(slot(3), { button: 0, pointerId: 7 });
    expect(onReorder).not.toHaveBeenCalled();
    expect(slot(1)).toHaveAttribute('title', '1. B');
  });

  it('cancels a native reorder when the source edge receives a replacement asset', () => {
    const onReorder = vi.fn();
    const media = [image('A'), image('B'), image('C')];
    const { rerender } = render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onReorder={onReorder} />);
    fireEvent.dragStart(slot(2));
    rerender(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={[media[0]!, image('replacement', 'edge-B'), media[2]!]} onReorder={onReorder} />);
    fireEvent.drop(slot(1));
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('moves all result assets belonging to one connection when dragging its second member', () => {
    const onReorder = vi.fn();
    const media = [image('before'), image('result-1', 'result-edge'), image('result-2', 'result-edge'), image('after')];
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onReorder={onReorder} />);
    fireEvent.dragStart(slot(3));
    fireEvent.drop(slot(4));
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith([media[0], media[3], media[1], media[2]]);
    expect(slot(3)).toHaveAttribute('title', '3. result-1');
    expect(slot(4)).toHaveAttribute('title', '4. result-2');
  });

  it('keeps the original result order when dropping inside the same connection group', () => {
    const onReorder = vi.fn();
    const media = [image('result-1', 'result-edge'), image('result-2', 'result-edge'), image('after')];
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onReorder={onReorder} />);
    fireEvent.dragStart(slot(2));
    fireEvent.drop(slot(1));
    expect(onReorder).not.toHaveBeenCalled();
    expect(slot(1)).toHaveAttribute('title', '1. result-1');
  });

  it('moves a connection group past its next neighbor using an arrow on its first member', () => {
    const onReorder = vi.fn();
    const media = [image('result-1', 'result-edge'), image('result-2', 'result-edge'), image('after')];
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onReorder={onReorder} />);
    fireEvent.click(screen.getByRole('button', { name: 'Move result-1 right' }));
    expect(onReorder).toHaveBeenCalledWith([media[2], media[0], media[1]]);
    expect(screen.getByRole('button', { name: 'Move result-1 right' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move result-2 right' })).toBeDisabled();
  });

  it('moves a whole connection past a neighboring result group with either arrow direction', () => {
    const onReorder = vi.fn();
    const media = [image('first-1', 'first-edge'), image('first-2', 'first-edge'), image('second-1', 'second-edge'), image('second-2', 'second-edge')];
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onReorder={onReorder} />);
    fireEvent.click(screen.getByRole('button', { name: 'Move first-1 right' }));
    expect(onReorder).toHaveBeenNthCalledWith(1, [media[2], media[3], media[0], media[1]]);
    fireEvent.click(screen.getByRole('button', { name: 'Move first-2 left' }));
    expect(onReorder).toHaveBeenNthCalledWith(2, media);
    expect(screen.getByRole('button', { name: 'Move first-2 left' })).toBeDisabled();
  });

  it('moves a complete result group with the Electron pointer fallback', () => {
    const onReorder = vi.fn();
    const media = [image('before'), image('result-1', 'result-edge'), image('result-2', 'result-edge'), image('after')];
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onReorder={onReorder} />);
    fireEvent.pointerDown(slot(3), { button: 0, pointerId: 5 });
    fireEvent.pointerEnter(slot(1), { pointerId: 5 });
    fireEvent.pointerUp(slot(1), { button: 0, pointerId: 5 });
    expect(onReorder).toHaveBeenCalledOnce();
    expect(onReorder).toHaveBeenCalledWith([media[1], media[2], media[0], media[3]]);
  });

  it('hydrates each result by asset identity while retaining a pending connection group reorder', () => {
    const onReorder = vi.fn();
    const media = [image('before'), image('result-1', 'result-edge'), image('result-2', 'result-edge')];
    const { rerender } = render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onReorder={onReorder} />);
    fireEvent.dragStart(slot(3));
    fireEvent.drop(slot(1));
    rerender(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media.map(item => ({ ...item, label: `${item.label} hydrated`, width: item.assetId === 'result-2' ? 1200 : 900, height: 900 }))} onReorder={onReorder} />);
    expect(slot(1)).toHaveAttribute('title', '1. result-1 hydrated');
    expect(slot(2)).toHaveAttribute('title', '2. result-2 hydrated');
    expect(slot(1).querySelector('img')).toHaveAttribute('src', media[1]!.previewUrl);
    expect(slot(2).querySelector('img')).toHaveAttribute('src', media[2]!.previewUrl);
  });

  it('does not lose a pointer source when only its presentation metadata arrives', () => {
    const onReorder = vi.fn();
    const media = [image('A'), image('B')];
    const { rerender } = render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onReorder={onReorder} />);
    fireEvent.pointerDown(slot(2), { button: 0, pointerId: 11 });
    const hydrated = media.map(item => ({ ...item, width: 900, height: 900 }));
    rerender(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={hydrated} onReorder={onReorder} />);
    fireEvent.pointerUp(slot(1), { button: 0, pointerId: 11 });
    expect(onReorder).toHaveBeenCalledWith([hydrated[1], hydrated[0]]);
  });

  it('opens an image reference with Enter or Space without bubbling to the canvas', () => {
    const onPreview = vi.fn();
    const onCanvasKey = vi.fn();
    const media = [image('A'), { edgeId: 'video-edge', kind: 'video' as const, assetId: 'video', label: 'Video' }];
    render(<div onKeyDown={onCanvasKey}><ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onPreview={onPreview} /></div>);
    expect(slot(1)).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(slot(1), { key: 'Enter' });
    fireEvent.keyDown(slot(1), { key: ' ' });
    expect(onPreview).toHaveBeenCalledTimes(2);
    expect(onPreview).toHaveBeenLastCalledWith(media[0], 0);
    expect(onCanvasKey).not.toHaveBeenCalled();
    fireEvent.keyDown(slot(2), { key: 'Enter' });
    expect(onPreview).toHaveBeenCalledTimes(2);
  });

  it('names unfamiliar reorder tools with hover titles', () => {
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={[image('A'), image('B')]} onReorder={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Move B left' })).toHaveAttribute('title');
    expect(screen.getByRole('button', { name: 'Move A right' })).toHaveAttribute('title');
  });
});
