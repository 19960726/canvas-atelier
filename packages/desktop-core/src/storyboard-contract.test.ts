import { describe, expect, it } from 'vitest';

import { parseProviderBridgeRequest, PROVIDER_BRIDGE_CHANNELS } from './provider-contracts.js';

describe('storyboard provider bridge contract', () => {
  it('accepts an opaque script request and rejects protected payloads', () => {
    expect(parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.generateStoryboard, {
      provider: 'comfly', modelRoute: 'scene-chat', script: 'A quiet reveal.', shotCount: 3, referenceAssetIds: ['0123456789abcdef'],
    })).toMatchObject({ shotCount: 3, referenceAssetIds: ['0123456789abcdef'] });
    expect(() => parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.generateStoryboard, {
      provider: 'comfly', modelRoute: 'scene-chat', script: 'file:///C:/secret', shotCount: 1, referenceAssetIds: [],
    })).toThrow(/protected payload/i);
  });
});
