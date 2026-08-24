import { describe, expect, it } from 'vitest';
import { reduceTransientPopover, type TransientPopoverState } from './transient-popover';

describe('reduceTransientPopover', () => {
  it('replaces the current popover when another one opens', () => {
    expect(reduceTransientPopover('knowledge', { type: 'open', id: 'model' })).toBe('model');
  });

  it('toggles the requested popover without leaving another surface open', () => {
    expect(reduceTransientPopover('knowledge', { type: 'toggle', id: 'model' })).toBe('model');
    expect(reduceTransientPopover('model', { type: 'toggle', id: 'model' })).toBeNull();
  });

  it('closes on external interaction but remains stable for internal interaction', () => {
    const state: TransientPopoverState = 'reference';
    expect(reduceTransientPopover(state, { type: 'close-external' })).toBeNull();
    expect(reduceTransientPopover(state, { type: 'internal-interaction' })).toBe('reference');
  });
});
