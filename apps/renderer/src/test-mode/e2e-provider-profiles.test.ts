import { describe, expect, it } from 'vitest';

import { hasVerifiedComflyVideoSubmissionContract } from '../../../../packages/desktop-core/src/comfly-video-jobs';
import { createE2EProviderProfiles } from './e2e-harness';

describe('E2E provider profile contract', () => {
  it('keeps Comfly, RelayMe, Julun video, and 4D image/vision fixtures isolated', () => {
    const profiles = createE2EProviderProfiles();

    expect(new Set(profiles.map((profile) => profile.provider))).toEqual(new Set([
      'comfly',
      'relayme',
      'julun',
      '4dai',
    ]));

    const julunProfiles = profiles.filter((profile) => profile.provider === 'julun');
    expect(julunProfiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        modelRoute: 'julun-seedance-2-0-fast-deal',
        capabilities: expect.arrayContaining(['video_generation', 'async_tasks']),
      }),
    ]));
    expect(julunProfiles.every((profile) => !profile.capabilities.includes('image_generation'))).toBe(true);

    const fourDProfiles = profiles.filter((profile) => profile.provider === '4dai');
    expect(fourDProfiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        modelRoute: '4dai-gpt-image-1-5',
        capabilities: expect.arrayContaining(['image_generation']),
      }),
      expect.objectContaining({
        modelRoute: '4dai-gemini-3-1-flash-image-preview',
        modelId: 'gemini-3.1-flash-image-preview',
        capabilities: expect.arrayContaining(['image_generation', 'image_edit']),
        constraints: { image: expect.objectContaining({ resolutions: ['1K', '2K', '4K'] }) },
      }),
      expect.objectContaining({
        modelRoute: '4dai-gemini-3-pro-image-preview',
        modelId: 'gemini-3-pro-image-preview',
        capabilities: expect.arrayContaining(['image_generation', 'image_edit']),
        constraints: { image: expect.objectContaining({ resolutions: ['1K', '2K', '4K'] }) },
      }),
      expect.objectContaining({
        modelRoute: '4dai-gpt-6-astra',
        capabilities: expect.arrayContaining(['vision', 'reverse_prompt']),
      }),
    ]));
    expect(fourDProfiles.every((profile) => !profile.capabilities.includes('video_generation'))).toBe(true);
  });

  it('does not let the audited fixture bypass production reference-image capability rules', () => {
    const comflyProfiles = createE2EProviderProfiles().filter((profile) => profile.provider === 'comfly');
    const liteImage = comflyProfiles.find((profile) => profile.modelId === 'gemini-3.1-flash-lite-image');
    const flashImage = comflyProfiles.find((profile) => profile.modelId === 'gemini-3.1-flash-image-preview-2k');

    expect(liteImage?.capabilities).not.toEqual(expect.arrayContaining(['image_generation', 'image_edit']));
    expect(flashImage?.capabilities).toEqual(expect.arrayContaining(['image_generation', 'image_edit']));
  });

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
