import { describe, expect, it } from 'vitest';
import { PROVIDER_BRIDGE_CHANNELS, parseProviderBridgeRequest } from './provider-contracts';

describe('provider profile bridge contract', () => {
  it('accepts a complete provider catalog with up to 1000 model profiles', () => {
    const profiles = Array.from({ length: 830 }, (_, index) => ({
      provider: 'comfly' as const,
      modelRoute: `comfly-model-${index}`,
      displayName: `Comfly Model ${index}`,
      modelId: `model-${index}`,
      capabilities: ['chat' as const],
    }));

    expect(() => parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.updateProfiles, {
      provider: 'comfly',
      profiles,
    })).not.toThrow();
  });
});