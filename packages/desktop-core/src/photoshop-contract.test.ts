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

  it.each([
    { sessionId: 'session-1', assetId: '0123456789abcdef', path: 'C:/secret.png' },
    { sessionId: 'session-1', assetId: '0123456789abcdef', script: 'app.activeDocument.save()' },
    { sessionId: '', assetId: '0123456789abcdef' },
    { sessionId: 'session-1', assetId: '../outside' },
  ])('rejects unsafe input %#', (input) => {
    expect(() => parsePhotoshopImportRequest(input)).toThrow();
  });
});
