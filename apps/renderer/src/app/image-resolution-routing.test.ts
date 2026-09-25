import { describe, expect, it } from 'vitest';

import { imageResolutionFamilyKey, resolveImageResolutionRoute } from './image-resolution-routing';

describe('resolveImageResolutionRoute', () => {
  it('keeps the canonical and all-route GPT Image 2 entries in one visible family', () => {
    const base = { provider: 'comfly', modelRoute: 'comfly-gpt-image-2', modelId: 'gpt-image-2', displayName: 'GPT Image 2', constraints: { image: { resolutions: ['2K', '4K'] as ('1K' | '2K' | '4K')[] } } };
    const all = { provider: 'comfly', modelRoute: 'comfly-gpt-image-2-all', modelId: 'gpt-image-2-all', displayName: 'GPT Image 2', constraints: { image: { resolutions: ['2K', '4K'] as ('1K' | '2K' | '4K')[] } } };
    expect(imageResolutionFamilyKey(all)).toBe(imageResolutionFamilyKey(base));
    expect(resolveImageResolutionRoute([all, base], base, '4K')?.modelRoute).toBe(base.modelRoute);
  });
  it.each([
    ['nano-banana-2', 'gemini-3.1-flash-image-preview', 'Nano Banana 2'],
    ['nano-banana-pro', 'gemini-3-pro-image-preview', 'Nano Banana Pro'],
    ['seedream-v5-pro', 'doubao-seedream-5-0-260128', 'Seedream 5 Pro'],
  ])('groups known %s aliases presented as one model series', (canonicalId, aliasId, displayName) => {
    const base = { provider: 'comfly', modelRoute: canonicalId, modelId: canonicalId, displayName };
    const alias = { provider: 'comfly', modelRoute: aliasId, modelId: aliasId, displayName };
    expect(imageResolutionFamilyKey(alias)).toBe(imageResolutionFamilyKey(base));
  });
  it('returns to an implicit 1K base route from a selected 4K variant', () => {
    const routes = [
      { provider: 'comfly', modelRoute: 'flare', modelId: 'gpt-image-2.5-flare', displayName: 'GPT Image 2.5 Flare', capabilityStatus: 'complete' as const },
      { provider: 'comfly', modelRoute: 'flare-2k', modelId: 'gpt-image-2.5-flare-2k', displayName: 'GPT Image 2.5 Flare 2K', capabilityStatus: 'complete' as const, constraints: { image: { resolutions: ['2K'] as ('1K' | '2K' | '4K')[] } } },
      { provider: 'comfly', modelRoute: 'flare-4k', modelId: 'gpt-image-2.5-flare-4k', displayName: 'GPT Image 2.5 Flare 4K', capabilityStatus: 'complete' as const, constraints: { image: { resolutions: ['4K'] as ('1K' | '2K' | '4K')[] } } },
    ];
    expect(resolveImageResolutionRoute(routes, routes[2]!, '1K')?.modelRoute).toBe('flare');
  });
  it('selects the hidden GPT Image 2.5 model variant when the live catalog omits constraints', () => {
    const routes = ['', '-2k', '-4k'].map((suffix) => ({
      provider: 'comfly',
      modelRoute: `comfly-gpt-image-2-5-flare${suffix}`,
      displayName: `GPT Image 2.5 Flare${suffix ? ` ${suffix.slice(1).toLocaleUpperCase()}` : ''}`,
      modelId: `gpt-image-2.5-flare${suffix}`,
      capabilityStatus: 'complete' as const,
    }));

    expect(resolveImageResolutionRoute(routes, routes[0]!, '4K')).toMatchObject({
      modelId: 'gpt-image-2.5-flare-4k',
      modelRoute: 'comfly-gpt-image-2-5-flare-4k',
    });
  });
});
