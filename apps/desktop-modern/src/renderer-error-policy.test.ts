import { describe, expect, it } from 'vitest';

import { isBenignRendererError } from './renderer-error-policy';

describe('renderer error policy', () => {
  it.each([
    'ResizeObserver loop completed with undelivered notifications.',
    'ResizeObserver loop limit exceeded',
  ])('ignores the known Chromium ResizeObserver warning: %s', (message) => {
    expect(isBenignRendererError(message)).toBe(true);
    expect(isBenignRendererError(new Error(message))).toBe(true);
  });

  it.each([
    new Error('Canvas renderer crashed'),
    'Unexpected renderer failure',
    { message: 'ResizeObserver loop completed with undelivered notifications.' },
  ])('keeps genuine renderer failures reportable', (value) => {
    expect(isBenignRendererError(value)).toBe(false);
  });
});
