import { describe, expect, it } from 'vitest';
import { NEW_API_PROVIDER_SEEDS } from './newapi-provider-seeds';
import { buildAuthenticatedNewApiCatalog } from './newapi-model-catalog';

const historical = [
  ['seedance-2.0-fast-deal', 'julun-seedance-2-0-fast-deal'],
  ['grok-imagine-video-1.5-preview', 'julun-grok-imagine-video-1-5-preview'],
  ['grok-imagine-video-1.5（按次）', 'julun-grok-imagine-video-1-5'],
  ['Minimax-H3-768p-933-10s-15s', 'julun-minimax-h3-768p-933-10s-15s'],
  ['minimax-h3 768p', 'julun-minimax-h3-768p'],
  ['minimax-h3 2k', 'julun-minimax-h3-2k'],
  ['sd2.0-720', 'julun-sd2-0-720'], ['sd2-mini', 'julun-sd2-mini'],
  ['minimax_h3', 'julun-minimax-h3'], ['sd2.5', 'julun-sd2-5'], ['seedance-2.0-deal', 'julun-seedance-2-0-deal'],
] as const;
// Exact public IDs captured from GET /api/pricing on 2026-10-03. Case, spaces,
// periods, underscores and Unicode identify upstream channels, not new families.
const newlyListed = [
  'seedance-2.5-720p', 'seedance-2.5-pro-480', 'seedance-2.5-pro-720', 'Q10-SD2.5 全参', 'wan-3.0-c2',
  'video-editing', 'MINIMAX-H3-768p-933', 'MINIMAX-H3-2.0采样-933', 'sd2.5_30', 'SD 2.5', 'SD 2.0',
  'SD 2.0-933', 'sd2.0-933-720p-fast-x5-15s', 'seedance-2.0-c2', 'seedance-2.0-fast-c2',
  'seedance-2.0-fast-15s', 'Seedance-933',
] as const;

describe('Julun public catalog seed additions', () => {
  it('preserves all eleven historical exact IDs and routes while adding seventeen public IDs', () => {
    expect(NEW_API_PROVIDER_SEEDS.julun.slice(0, historical.length).map(profile => [profile.modelId, profile.modelRoute])).toEqual(historical);
    expect(NEW_API_PROVIDER_SEEDS.julun).toHaveLength(28);
    expect(new Set(NEW_API_PROVIDER_SEEDS.julun.map(profile => profile.modelId)).size).toBe(28);
    expect(new Set(NEW_API_PROVIDER_SEEDS.julun.map(profile => profile.modelRoute)).size).toBe(28);
  });
  it.each(newlyListed)('previews the exact upstream ID %s without declaring account access or protocol completion', modelId => {
    expect(NEW_API_PROVIDER_SEEDS.julun.find(profile => profile.modelId === modelId)).toMatchObject({
      provider: 'julun', modelId, capabilities: ['video_generation', 'async_tasks'], capabilityStatus: 'incomplete',
    });
  });
  it('keeps the SD 2.5 alias separate from the existing sd2.5 route', () => {
    const aliases = buildAuthenticatedNewApiCatalog({ provider: 'julun', accessibleModelIds: ['sd2.5', 'SD 2.5'],
      pricing: ['sd2.5', 'SD 2.5'].map(modelName => ({ modelName, supportedEndpointTypes: ['openai-video'] })) });
    expect(aliases.find(profile => profile.modelId === 'sd2.5')?.modelRoute).toBe('julun-sd2-5');
    expect(aliases.find(profile => profile.modelId === 'SD 2.5')?.modelRoute).not.toBe('julun-sd2-5');
  });
  it('preserves an existing stored opaque route for a newly seeded exact model', () => {
    const profiles = buildAuthenticatedNewApiCatalog({ provider: 'julun', accessibleModelIds: ['SD 2.5'],
      pricing: [{ modelName: 'SD 2.5', supportedEndpointTypes: ['openai-video'] }],
      persistedProfiles: [{ provider: 'julun', modelId: 'SD 2.5', modelRoute: 'julun-model@U0QgMi41' }] });
    expect(profiles[0]?.modelRoute).toBe('julun-model@U0QgMi41');
  });
  it('does not hijack a persisted route when a new seed would otherwise claim the same route', () => {
    const profiles = buildAuthenticatedNewApiCatalog({ provider: 'julun', accessibleModelIds: ['vendor-channel', 'seedance-2.5-720p'],
      pricing: ['vendor-channel', 'seedance-2.5-720p'].map(modelName => ({ modelName, supportedEndpointTypes: ['openai-video'] })),
      persistedProfiles: [{ provider: 'julun', modelId: 'vendor-channel', modelRoute: 'julun-seedance-2-5-720p' }] });
    expect(profiles.find(profile => profile.modelId === 'vendor-channel')?.modelRoute).toBe('julun-seedance-2-5-720p');
    expect(profiles.find(profile => profile.modelId === 'seedance-2.5-720p')?.modelRoute).not.toBe('julun-seedance-2-5-720p');
  });
  it('shows public parameter evidence in incomplete previews without inventing unknown parameters', () => {
    expect(NEW_API_PROVIDER_SEEDS.julun.find(profile => profile.modelId === 'Q10-SD2.5 全参')).toMatchObject({
      capabilityStatus: 'incomplete', constraints: { video: { aspectRatios: ['16:9', '9:16'], resolutions: ['480p'],
        duration: { mode: 'range', min: 4, max: 30 } } },
    });
    expect(NEW_API_PROVIDER_SEEDS.julun.find(profile => profile.modelId === 'seedance-2.0-fast-15s')).toMatchObject({
      capabilityStatus: 'incomplete', constraints: { video: { resolutions: ['720p'], duration: { mode: 'options', options: [15] } } },
    });
    expect(NEW_API_PROVIDER_SEEDS.julun.find(profile => profile.modelId === 'wan-3.0-c2')?.constraints?.video?.aspectRatios).toBeUndefined();
  });
});
