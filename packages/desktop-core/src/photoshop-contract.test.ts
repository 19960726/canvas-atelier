import { describe, expect, it } from 'vitest';
import { parsePhotoshopImportRequest } from './photoshop-contract.js';

describe('parsePhotoshopImportRequest', () => {
  it('accepts only opaque session and managed asset identities', () => {
    expect(parsePhotoshopImportRequest({
      sessionId: 'session-1',
      assetId: '0123456789abcdef',
    })).toEqual({
      sessionId: 'session-1',
      assetId: '0123456789abcdef',
    });
  });

  it('accepts only bounded color-correction parameters', () => {
    const colorCorrection = {
      temperature: -30,
      tint: 30,
      saturation: 70,
      contrast: 120,
      brightness: 85,
    };
    expect(parsePhotoshopImportRequest({
      sessionId: 'session-1',
      assetId: '0123456789abcdef',
      colorCorrection,
    })).toEqual({
      sessionId: 'session-1',
      assetId: '0123456789abcdef',
      colorCorrection,
    });
  });

  it.each([
    { sessionId: 'session-1', assetId: '0123456789abcdef', path: 'C:/secret.png' },
    { sessionId: 'session-1', assetId: '0123456789abcdef', script: 'app.activeDocument.save()' },
    { sessionId: '', assetId: '0123456789abcdef' },
    { sessionId: 'session-1', assetId: '../outside' },
    { sessionId: 'session-1', assetId: '0123456789abcdef', correctedPngBytes: new Uint8Array([137, 80, 78, 71]) },
    { sessionId: 'session-1', assetId: '0123456789abcdef', colorCorrection: { temperature: -31, tint: 0, saturation: 100, contrast: 100, brightness: 100 } },
    { sessionId: 'session-1', assetId: '0123456789abcdef', colorCorrection: { temperature: 31, tint: 0, saturation: 100, contrast: 100, brightness: 100 } },
    { sessionId: 'session-1', assetId: '0123456789abcdef', colorCorrection: { temperature: 0, tint: -31, saturation: 100, contrast: 100, brightness: 100 } },
    { sessionId: 'session-1', assetId: '0123456789abcdef', colorCorrection: { temperature: 0, tint: 31, saturation: 100, contrast: 100, brightness: 100 } },
    { sessionId: 'session-1', assetId: '0123456789abcdef', colorCorrection: { temperature: 0, tint: 0, saturation: 69, contrast: 100, brightness: 100 } },
    { sessionId: 'session-1', assetId: '0123456789abcdef', colorCorrection: { temperature: 0, tint: 0, saturation: 131, contrast: 100, brightness: 100 } },
    { sessionId: 'session-1', assetId: '0123456789abcdef', colorCorrection: { temperature: 0, tint: 0, saturation: 100, contrast: 84, brightness: 100 } },
    { sessionId: 'session-1', assetId: '0123456789abcdef', colorCorrection: { temperature: 0, tint: 0, saturation: 100, contrast: 121, brightness: 100 } },
    { sessionId: 'session-1', assetId: '0123456789abcdef', colorCorrection: { temperature: 0, tint: 0, saturation: 100, contrast: 100, brightness: 84 } },
    { sessionId: 'session-1', assetId: '0123456789abcdef', colorCorrection: { temperature: 0, tint: 0, saturation: 100, contrast: 100, brightness: 121 } },
    { sessionId: 'session-1', assetId: '0123456789abcdef', colorCorrection: { temperature: 0.5, tint: 0, saturation: 100, contrast: 100, brightness: 100 } },
    { sessionId: 'session-1', assetId: '0123456789abcdef', colorCorrection: { mode: 'custom', temperature: 0, tint: 0, saturation: 100, contrast: 100, brightness: 100 } },
  ])('rejects unsafe input %#', (input) => {
    expect(() => parsePhotoshopImportRequest(input)).toThrow();
  });
});
