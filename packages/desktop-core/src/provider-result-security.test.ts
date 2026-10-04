import { describe, expect, it, vi } from 'vitest';

import { downloadSafeProviderResult } from './provider-result-security';

const resultUrl = 'https://assets.example/generated-result';
const publicAddress = '93.184.216.34';
const resultBytes = Uint8Array.from([1, 2, 3, 4]);
const completedResponse = {
  ok: true,
  status: 200,
  json: async () => ({}),
  arrayBuffer: async () => resultBytes.buffer as ArrayBuffer,
};

describe('safe provider result downloads', () => {
  it.each(['image', 'video'] as const)('keeps a %s result recoverable after the desktop fetch times out', async (kind) => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error('Provider network request timed out'))
      .mockResolvedValueOnce(completedResponse);
    const resolveResultHost = vi.fn(async () => [publicAddress]);

    await expect(downloadSafeProviderResult(resultUrl, kind, fetch, resolveResultHost))
      .rejects.toMatchObject({ code: 'PROVIDER_ERROR', retryable: true });
    await expect(downloadSafeProviderResult(resultUrl, kind, fetch, resolveResultHost))
      .resolves.toEqual(resultBytes);
  });

  it.each(['image', 'video'] as const)('keeps a %s result recoverable after temporary DNS failure', async (kind) => {
    const fetch = vi.fn(async () => completedResponse);
    const dnsError = Object.assign(new Error('getaddrinfo EAI_AGAIN assets.example'), { code: 'EAI_AGAIN' });
    const resolveResultHost = vi.fn()
      .mockRejectedValueOnce(dnsError)
      .mockResolvedValueOnce([publicAddress]);

    await expect(downloadSafeProviderResult(resultUrl, kind, fetch, resolveResultHost))
      .rejects.toMatchObject({ code: 'PROVIDER_ERROR', retryable: true });
    await expect(downloadSafeProviderResult(resultUrl, kind, fetch, resolveResultHost))
      .resolves.toEqual(resultBytes);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    'Provider network redirect was blocked',
    'Provider network response was too large',
  ])('keeps the result policy rejection terminal: %s', async (message) => {
    const fetch = vi.fn(async () => { throw new Error(message); });

    await expect(downloadSafeProviderResult(resultUrl, 'image', fetch, async () => [publicAddress]))
      .rejects.not.toMatchObject({ retryable: true });
  });

  it('never fetches a result whose DNS answer includes a private address', async () => {
    const fetch = vi.fn(async () => completedResponse);

    await expect(downloadSafeProviderResult(resultUrl, 'image', fetch, async () => [publicAddress, '127.0.0.1']))
      .rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE', retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });
});
