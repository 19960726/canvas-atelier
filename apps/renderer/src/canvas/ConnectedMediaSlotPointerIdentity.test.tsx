import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectedAgentMediaSlots, type ConnectedAgentMediaSlotItem } from './ConnectedAgentMediaSlots';

afterEach(cleanup);

const media: ConnectedAgentMediaSlotItem[] = ['A', 'B', 'C'].map(label => ({
  edgeId: `edge-${label}`, kind: 'image', assetId: `asset-${label}`, label,
}));
const slot = (index: number) => screen.getByLabelText(`Agent media slot ${index}`, { exact: true });

function identityEvent(type: string, pointerId: number | undefined) {
  const event = new PointerEvent(type, { button: 0, pointerId, bubbles: true });
  if (pointerId === undefined) Object.defineProperty(event, 'pointerId', { value: undefined });
  return event;
}

describe('connected media pointer identity', () => {
  it('does not commit a drag when a different pointer is released inside the tray', () => {
    const onReorder = vi.fn();
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onReorder={onReorder} />);
    fireEvent.pointerDown(slot(2), { button: 0, pointerId: 7 });
    fireEvent.pointerUp(slot(1), { button: 0, pointerId: 8 });

    expect(onReorder).not.toHaveBeenCalled();
    fireEvent.pointerUp(slot(1), { button: 0, pointerId: 7 });
    expect(onReorder).toHaveBeenCalledOnce();
    expect(onReorder).toHaveBeenCalledWith([media[1], media[0], media[2]]);
  });

  it.each(['pointerup', 'pointercancel'] as const)('retains the active drag after another pointer receives %s outside the tray', eventType => {
    const onReorder = vi.fn();
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onReorder={onReorder} />);
    fireEvent.pointerDown(slot(2), { button: 0, pointerId: 7 });
    fireEvent(window, new PointerEvent(eventType, { button: 0, pointerId: 8, bubbles: true }));
    fireEvent.pointerUp(slot(1), { button: 0, pointerId: 7 });

    expect(onReorder).toHaveBeenCalledOnce();
    expect(onReorder).toHaveBeenCalledWith([media[1], media[0], media[2]]);
  });

  it('does not replace the active source when a second pointer presses another slot', () => {
    const onReorder = vi.fn();
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onReorder={onReorder} />);
    fireEvent.pointerDown(slot(2), { button: 0, pointerId: 7 });
    fireEvent.pointerDown(slot(3), { button: 0, pointerId: 8 });
    fireEvent.pointerUp(slot(1), { button: 0, pointerId: 7 });

    expect(onReorder).toHaveBeenCalledOnce();
    expect(onReorder).toHaveBeenCalledWith([media[1], media[0], media[2]]);
  });

  it('does not let a pointer press steal an active native drag', () => {
    const onReorder = vi.fn();
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onReorder={onReorder} />);
    fireEvent.dragStart(slot(2));
    fireEvent.pointerDown(slot(3), { button: 0, pointerId: 8 });
    fireEvent.pointerUp(slot(1), { button: 0, pointerId: 8 });

    expect(onReorder).not.toHaveBeenCalled();
    fireEvent.dragEnd(slot(2));
  });

  it('preserves the original native source through an unrelated pointer press', () => {
    const onReorder = vi.fn();
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onReorder={onReorder} />);
    fireEvent.dragStart(slot(2));
    fireEvent.pointerDown(slot(3), { button: 0, pointerId: 8 });
    fireEvent.drop(slot(1));
    expect(onReorder).toHaveBeenCalledOnce();
    expect(onReorder).toHaveBeenCalledWith([media[1], media[0], media[2]]);
  });

  it('accepts a new pointer gesture after a native drop without a dragend event', () => {
    const onReorder = vi.fn();
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onReorder={onReorder} />);
    fireEvent.dragStart(slot(2));
    fireEvent.drop(slot(1));
    fireEvent.pointerDown(slot(3), { button: 0, pointerId: 8 });
    fireEvent.pointerUp(slot(1), { button: 0, pointerId: 8 });
    expect(onReorder).toHaveBeenNthCalledWith(1, [media[1], media[0], media[2]]);
    expect(onReorder).toHaveBeenNthCalledWith(2, [media[2], media[1], media[0]]);
  });

  it('accepts a new pointer gesture after losing focus during a native drag', () => {
    const onReorder = vi.fn();
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onReorder={onReorder} />);
    fireEvent.dragStart(slot(2));
    fireEvent.blur(window);
    fireEvent.pointerDown(slot(3), { button: 0, pointerId: 8 });
    fireEvent.pointerUp(slot(1), { button: 0, pointerId: 8 });
    expect(onReorder).toHaveBeenCalledOnce();
    expect(onReorder).toHaveBeenCalledWith([media[2], media[0], media[1]]);
  });

  it('does not mark an unrelated pointer hover as the active drop target', () => {
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onReorder={vi.fn()} />);
    fireEvent.pointerDown(slot(2), { button: 0, pointerId: 7 });
    fireEvent.pointerEnter(slot(1), { pointerId: 8 });
    expect(slot(1)).not.toHaveClass('is-drop-target');
    fireEvent.pointerEnter(slot(3), { pointerId: 7 });
    expect(slot(3)).toHaveClass('is-drop-target');
  });

  it('retains the active source and drop target when another pointer is cancelled inside the tray', () => {
    const onReorder = vi.fn();
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onReorder={onReorder} />);
    fireEvent.pointerDown(slot(2), { button: 0, pointerId: 7 });
    fireEvent.pointerEnter(slot(3), { pointerId: 7 });
    fireEvent.pointerCancel(slot(3), { pointerId: 8 });
    expect(slot(3)).toHaveClass('is-drop-target');
    fireEvent.pointerUp(slot(1), { button: 0, pointerId: 7 });
    expect(onReorder).toHaveBeenCalledWith([media[1], media[0], media[2]]);
  });

  it('isolates slot pointer cancellation from the ReactFlow pane handler', () => {
    const paneCancel = vi.fn();
    const onReorder = vi.fn();
    render(<div className="react-flow__pane" onPointerCancel={paneCancel}>
      <ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onReorder={onReorder} />
    </div>);
    fireEvent.pointerDown(slot(2), { button: 0, pointerId: 71 });
    fireEvent.pointerEnter(slot(1), { pointerId: 71 });
    fireEvent.pointerCancel(slot(1), { button: 0, pointerId: 72 });

    expect(paneCancel).not.toHaveBeenCalled();
    expect(slot(1)).toHaveClass('is-drop-target');
    fireEvent.pointerUp(slot(1), { button: 0, pointerId: 71 });
    expect(onReorder).toHaveBeenCalledOnce();
    expect(onReorder).toHaveBeenCalledWith([media[1], media[0], media[2]]);
  });

  it('cancels the matching slot pointer without notifying the pane', () => {
    const paneCancel = vi.fn();
    const onReorder = vi.fn();
    render(<div className="react-flow__pane" onPointerCancel={paneCancel}>
      <ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onReorder={onReorder} />
    </div>);
    fireEvent.pointerDown(slot(2), { button: 0, pointerId: 71 });
    fireEvent.pointerEnter(slot(1), { pointerId: 71 });
    fireEvent.pointerCancel(slot(1), { button: 0, pointerId: 71 });
    expect(paneCancel).not.toHaveBeenCalled();
    expect(slot(1)).not.toHaveClass('is-drop-target');
    fireEvent.pointerUp(slot(1), { button: 0, pointerId: 71 });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('isolates an empty slot pointer cancellation from the ReactFlow pane handler', () => {
    const paneCancel = vi.fn();
    render(<div className="react-flow__pane" onPointerCancel={paneCancel}>
      <ConnectedAgentMediaSlots ariaLabel="Inputs" media={[]} emptySlotKind="image" />
    </div>);
    fireEvent.pointerCancel(screen.getByLabelText('Media reference slot pending'), { pointerId: 73 });
    expect(paneCancel).not.toHaveBeenCalled();
  });

  it('isolates a control button pointer cancellation from the ReactFlow pane handler', () => {
    const paneCancel = vi.fn();
    render(<div className="react-flow__pane" onPointerCancel={paneCancel}>
      <ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onReorder={vi.fn()} />
    </div>);
    fireEvent.pointerCancel(screen.getByRole('button', { name: 'Move B left' }), { pointerId: 74 });
    expect(paneCancel).not.toHaveBeenCalled();
  });

  it('clears an active source and drop target when the window loses focus', () => {
    const onReorder = vi.fn();
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onReorder={onReorder} />);
    fireEvent.pointerDown(slot(2), { button: 0, pointerId: 7 });
    fireEvent.pointerEnter(slot(3), { pointerId: 7 });
    fireEvent.blur(window);
    expect(slot(3)).not.toHaveClass('is-drop-target');
    fireEvent.pointerUp(slot(1), { button: 0, pointerId: 7 });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it.each(['pointerup', 'pointercancel'] as const)('cancels the matching pointer after %s outside the tray', eventType => {
    const onReorder = vi.fn();
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onReorder={onReorder} />);
    fireEvent.pointerDown(slot(2), { button: 0, pointerId: 7 });
    fireEvent(window, new PointerEvent(eventType, { button: 0, pointerId: 7, bubbles: true }));
    fireEvent.pointerUp(slot(1), { button: 0, pointerId: 7 });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['default', 0],
  ] as const)('does not accept a %s pointer identity as a numbered source release', (_label, pointerId) => {
    const onReorder = vi.fn();
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onReorder={onReorder} />);
    fireEvent.pointerDown(slot(2), { button: 0, pointerId: 7 });
    fireEvent(slot(1), identityEvent('pointerup', pointerId));
    expect(onReorder).not.toHaveBeenCalled();
    fireEvent.pointerUp(slot(1), { button: 0, pointerId: 7 });
    expect(onReorder).toHaveBeenCalledWith([media[1], media[0], media[2]]);
  });

  it.each([
    ['missing', undefined],
    ['default', 0],
  ] as const)('does not accept a %s pointer identity as a numbered source hover', (_label, pointerId) => {
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onReorder={vi.fn()} />);
    fireEvent.pointerDown(slot(2), { button: 0, pointerId: 7 });
    fireEvent(slot(1), identityEvent('pointerover', pointerId));
    expect(slot(1)).not.toHaveClass('is-drop-target');
    fireEvent.pointerEnter(slot(3), { pointerId: 7 });
    expect(slot(3)).toHaveClass('is-drop-target');
  });

  it.each([
    ['missing', undefined],
    ['default', 0],
  ] as const)('does not accept a %s pointer identity as a numbered source cancellation', (_label, pointerId) => {
    const onReorder = vi.fn();
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onReorder={onReorder} />);
    fireEvent.pointerDown(slot(2), { button: 0, pointerId: 7 });
    fireEvent.pointerEnter(slot(3), { pointerId: 7 });
    fireEvent(slot(3), identityEvent('pointercancel', pointerId));
    expect(slot(3)).toHaveClass('is-drop-target');
    fireEvent.pointerUp(slot(1), { button: 0, pointerId: 7 });
    expect(onReorder).toHaveBeenCalledWith([media[1], media[0], media[2]]);
  });

  it('preserves legacy pointer events when both identities are actually undefined', () => {
    const onReorder = vi.fn();
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onReorder={onReorder} />);
    fireEvent(slot(2), identityEvent('pointerdown', undefined));
    fireEvent(slot(1), identityEvent('pointerover', undefined));
    expect(slot(1)).toHaveClass('is-drop-target');
    fireEvent(slot(1), identityEvent('pointerup', undefined));
    expect(onReorder).toHaveBeenCalledOnce();
    expect(onReorder).toHaveBeenCalledWith([media[1], media[0], media[2]]);
  });
});
