import { BlockList, isIP } from 'node:net';
import type { ComflyFetch } from '@agent-canvas/provider-comfly';
import { createProviderBridgeError } from './provider-contracts.js';

const PROVIDER_RESULT_DOWNLOAD_TIMEOUT_MS = 300_000;
const PROVIDER_IMAGE_RESULT_MAX_BYTES = 256 * 1024 * 1024;
const PROVIDER_VIDEO_RESULT_MAX_BYTES = 512 * 1024 * 1024;

export async function downloadSafeProviderResult(
  rawUrl: string | undefined,
  kind: 'image' | 'video',
  fetch: ComflyFetch,
  resolveResultHost: ((hostname: string) => Promise<readonly string[]>) | undefined,
): Promise<Uint8Array> {
  const url = parseSafeProviderResultUrl(rawUrl);
  if (resolveResultHost === undefined) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image result');
  }
  let addresses: readonly string[];
  try {
    addresses = await resolveResultHost(url.hostname);
  } catch {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image result');
  }
  if (addresses.length === 0 || addresses.some((address) => !isPublicProviderAddress(address))) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image result');
  }
  let response;
  try {
    response = await fetch(url.toString(), {
      maxResponseBytes: kind === 'image' ? PROVIDER_IMAGE_RESULT_MAX_BYTES : PROVIDER_VIDEO_RESULT_MAX_BYTES,
      timeoutMs: PROVIDER_RESULT_DOWNLOAD_TIMEOUT_MS,
      trustedResolvedAddress: addresses[0],
    });
  } catch (error) {
    if (error instanceof TypeError) throw createProviderBridgeError('PROVIDER_ERROR', 'Provider result download failed', true);
    throw error;
  }
  if (response.status === 429 || response.status >= 500) {
    throw createProviderBridgeError('PROVIDER_ERROR', 'Provider result download is temporarily unavailable', true);
  }
  if (!response.ok || response.arrayBuffer === undefined) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image result');
  }
  try {
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof TypeError) throw createProviderBridgeError('PROVIDER_ERROR', 'Provider result download failed', true);
    throw error;
  }
}

export function parseSafeProviderResultUrl(value: string | undefined): URL {
  if (value === undefined) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image result');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image result');
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '').replace(/^\[|\]$/gu, '');
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || isIP(hostname) !== 0
  ) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image result');
  }
  return url;
}

const providerResultAddressBlockList = createProviderResultAddressBlockList();

export function isPublicProviderAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 4) return isPublicIpv4Address(address);
  return !providerResultAddressBlockList.check(address, 'ipv6');
}

function createProviderResultAddressBlockList(): BlockList {
  const blockList = new BlockList();
  for (const [address, prefix] of [
    ['::', 96],
    ['::1', 128],
    ['::ffff:0:0', 96],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['fc00::', 7],
    ['fec0::', 10],
    ['fe80::', 10],
    ['ff00::', 8],
  ] as const) blockList.addSubnet(address, prefix, 'ipv6');
  return blockList;
}

function isPublicIpv4Address(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [first, second] = octets as [number, number, number, number];
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && (second === 0 || second === 168)) return false;
  if (first === 198 && (second === 18 || second === 19)) return false;
  return true;
}
