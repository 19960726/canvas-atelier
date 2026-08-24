import { describe, expect, it } from 'vitest';

import { ProviderBridgeProfileSchema } from './provider-contracts';

describe('video preview provider contract', () => {
  it('recognizes video_generation only as a declared capability', () => {
    expect(ProviderBridgeProfileSchema.parse({
      provider: 'comfly',
      modelRoute: 'offline-preview',
      displayName: 'Offline preview',
      capabilities: ['video_generation'],
    }).capabilities).toEqual(['video_generation']);
  });
});
