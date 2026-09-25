import { describe, expect, it, vi } from 'vitest';
import { createProviderCatalogCache } from './provider-catalog-cache.js';

describe('provider catalog reads', () => {
  it('shares concurrent requests and retries a rejected request', async () => {
    const cache = createProviderCatalogCache<string[]>();
    const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(['image']);
    const failed = await Promise.allSettled([cache.read('account', load), cache.read('account', load)]);
    expect(failed.every((result) => result.status === 'rejected')).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await cache.read('account', load)).toEqual(['image']);
    expect(await cache.read('account', load)).toEqual(['image']);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('does not cache an old account response after credentials change', async () => {
    const cache = createProviderCatalogCache<string[]>();
    let finish!: (value: string[]) => void;
    const old = cache.read('old', () => new Promise<string[]>((resolve) => { finish = resolve; }));
    await Promise.resolve();
    cache.clear();
    await cache.read('new', async () => ['new']);
    finish(['old']);
    await old;
    expect(cache.peek()).toEqual(['new']);
  });
});
