import { describe, expect, it } from 'vitest';

import { resolveImageResolutionRoute } from './image-resolution-routing';

describe('resolveImageResolutionRoute', () => {
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
