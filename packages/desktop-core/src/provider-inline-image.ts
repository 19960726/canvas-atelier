import { createProviderBridgeError } from './provider-contracts.js';

/** Decode an upstream inline image only inside the main process. */
export function decodeProviderInlineImage(value: unknown): Uint8Array | undefined {
  if (typeof value !== 'string') return undefined;
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value) || value.length % 4 !== 0) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image result');
  }
  const bytes = Uint8Array.from(Buffer.from(value, 'base64'));
  if (bytes.byteLength === 0) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image result');
  }
  return bytes;
}
