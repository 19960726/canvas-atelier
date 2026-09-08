import { describe, expect, it } from 'vitest';

import { hasVerifiedComflyVideoSubmissionContract } from '../../../../packages/desktop-core/src/comfly-video-jobs';
import { createE2EProviderProfiles } from './e2e-harness';

describe('E2E provider profile contract', () => {
  it('advertises only Comfly video models with a production submission contract', () => {
    const videoProfiles = createE2EProviderProfiles().filter((profile) => (
      profile.provider === 'comfly' && profile.capabilities.includes('video_generation')
    ));

    expect(videoProfiles.length).toBeGreaterThan(0);
    expect(videoProfiles.filter((profile) => !hasVerifiedComflyVideoSubmissionContract(
      profile.modelId ?? profile.modelRoute,
    ))).toEqual([]);
    expect(new Set(videoProfiles.map((profile) => {
      const modelId = (profile.modelId ?? profile.modelRoute).toLocaleLowerCase();
      if (modelId.startsWith('wan')) return 'wan';
      if (modelId.includes('seedance')) return 'seedance';
      if (modelId.startsWith('veo')) return 'veo';
      return 'unknown';
    }))).toEqual(new Set(['wan', 'seedance', 'veo']));
  });

  it('keeps RelayMe reverse fixtures image-only like the production service', () => {
    const relayReverseProfiles = createE2EProviderProfiles().filter((profile) => (
      profile.provider === 'relayme' && profile.capabilities.includes('reverse_prompt')
    ));

    expect(relayReverseProfiles.length).toBeGreaterThan(0);
    expect(relayReverseProfiles.every((profile) => profile.capabilities.includes('vision'))).toBe(true);
    expect(relayReverseProfiles.every((profile) => !profile.capabilities.includes('video_understanding'))).toBe(true);
  });
});
