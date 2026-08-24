import { createProviderBridgeError } from './provider-contracts.js';
import { decodeProviderInlineImage } from './provider-inline-image.js';

export function parseDirectProviderImageResponse(value: unknown): { readonly inlineBytes?: Uint8Array; readonly resultUrl?: string } | undefined {
  const first = findFirstProviderImageResult(value);
  if (first === undefined) return undefined;
  const inlineBytes = decodeProviderInlineImage(first.b64_json);
  if (inlineBytes === undefined && typeof first.url !== 'string') return undefined;
  return {
    ...(inlineBytes === undefined ? {} : { inlineBytes }),
    ...(typeof first.url === 'string' ? { resultUrl: first.url } : {}),
  };
}

export function findFirstProviderImageResult(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findFirstProviderImageResult(item);
      if (result !== undefined) return result;
    }
    return undefined;
  }
  if (!isPlainRecord(value)) return undefined;
  if (typeof value.url === 'string' || typeof value.b64_json === 'string' || (value.width !== undefined && value.height !== undefined)) return value;
  for (const key of ['images', 'output', 'outputs', 'result', 'results', 'data'] as const) {
    const result = findFirstProviderImageResult(value[key]);
    if (result !== undefined) return result;
  }
  return undefined;
}

export function detectGeneratedImageMediaType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' {
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 16));
  if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (header.subarray(0, 6).toString('ascii') === 'GIF87a' || header.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an unsupported image result format');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
