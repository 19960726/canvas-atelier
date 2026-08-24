import { describe, expect, it } from 'vitest';
import { resolveMediaImportMode } from './media-import-capability';

describe('resolveMediaImportMode', () => {
  it('uses a real browser picker for the manual acceptance page even when a desktop bridge is present', () => {
    expect(resolveMediaImportMode({ desktopBridge: {}, manualAcceptance: true }))
      .toBe('browser-picker');
  });

  it('keeps native managed import for the real desktop renderer', () => {
    expect(resolveMediaImportMode({ desktopBridge: {}, manualAcceptance: false }))
      .toBe('desktop-managed');
  });

  it('uses a browser picker when no desktop bridge exists', () => {
    expect(resolveMediaImportMode({ desktopBridge: undefined, manualAcceptance: false }))
      .toBe('browser-picker');
  });
});