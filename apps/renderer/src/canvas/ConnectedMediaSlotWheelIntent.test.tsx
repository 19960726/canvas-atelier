import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectedAgentMediaSlots, type ConnectedAgentMediaSlotItem } from './ConnectedAgentMediaSlots';

afterEach(cleanup);

const media: ConnectedAgentMediaSlotItem[] = Array.from({ length: 12 }, (_, index) => ({
  edgeId: `edge-${index}`, kind: 'image', assetId: `asset-${index}`, label: `Image ${index + 1}`,
}));

function setup(overflow = true) {
  const canvasWheel = vi.fn();
  render(<div onWheel={canvasWheel}><ConnectedAgentMediaSlots ariaLabel="Inputs" slotRowAriaLabel="Material scroll lane" media={media} /></div>);
  const row = screen.getByLabelText('Material scroll lane');
  Object.defineProperties(row, {
    clientWidth: { configurable: true, value: 294 },
    scrollWidth: { configurable: true, value: overflow ? 714 : 294 },
    scrollLeft: { configurable: true, writable: true, value: 0 },
  });
  return { row, canvasWheel };
}

describe('connected material wheel intent', () => {
  it.each(['ctrlKey', 'metaKey'] as const)('does not translate %s zoom intent into a material scroll', modifier => {
    const { row, canvasWheel } = setup();
    const wheel = new WheelEvent('wheel', { [modifier]: true, deltaY: 96, bubbles: true, cancelable: true });
    fireEvent(row, wheel);

    expect(row.scrollLeft).toBe(0);
    expect(wheel.defaultPrevented).toBe(true);
    expect(canvasWheel).not.toHaveBeenCalled();
    expect(row).toHaveClass('nowheel');
  });

  it('retains the local zoom boundary even when the material lane does not overflow', () => {
    const { row, canvasWheel } = setup(false);
    const wheel = new WheelEvent('wheel', { ctrlKey: true, deltaY: -96, bubbles: true, cancelable: true });
    fireEvent(row, wheel);

    expect(row.scrollLeft).toBe(0);
    expect(wheel.defaultPrevented).toBe(true);
    expect(canvasWheel).not.toHaveBeenCalled();
  });

  it.each([
    ['pixels', 0, 96, 96],
    ['lines', 1, 3, 48],
    ['pages', 2, 1, 294],
  ] as const)('preserves unmodified vertical %s wheel navigation', (_unit, deltaMode, deltaY, expectedScrollLeft) => {
    const { row, canvasWheel } = setup();
    const wheel = new WheelEvent('wheel', { deltaMode, deltaY, bubbles: true, cancelable: true });
    fireEvent(row, wheel);

    expect(row.scrollLeft).toBe(expectedScrollLeft);
    expect(wheel.defaultPrevented).toBe(true);
    expect(canvasWheel).not.toHaveBeenCalled();
  });

  it('leaves a horizontal trackpad wheel for native lane scrolling', () => {
    const { row } = setup();
    const wheel = new WheelEvent('wheel', { deltaX: 96, deltaY: 12, bubbles: true, cancelable: true });
    fireEvent(row, wheel);
    expect(row.scrollLeft).toBe(0);
    expect(wheel.defaultPrevented).toBe(false);
    expect(row).toHaveClass('nowheel');
  });

  it('does not cancel a plain wheel on a lane without overflow', () => {
    const { row } = setup(false);
    const wheel = new WheelEvent('wheel', { deltaY: 96, bubbles: true, cancelable: true });
    fireEvent(row, wheel);
    expect(row.scrollLeft).toBe(0);
    expect(wheel.defaultPrevented).toBe(false);
  });
});
