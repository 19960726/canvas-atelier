import { describe, expect, it } from 'vitest';
import { decodeProviderInlineImage } from './provider-inline-image.js';

describe('provider inline image decoder', () => {
  it('decodes valid base64 bytes without returning the protected string', () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    expect(decodeProviderInlineImage(Buffer.from(bytes).toString('base64'))).toEqual(bytes);
  });

  it('rejects malformed and empty inline results with a sanitized error', () => {
    for (const value of ['%%%not-base64%%%', '']) {
      expect(() => decodeProviderInlineImage(value)).toThrowError(expect.objectContaining({
        code: 'PROVIDER_INVALID_RESPONSE',
        message: expect.not.stringMatching(/not-base64/iu),
      }));
    }
  });
});
