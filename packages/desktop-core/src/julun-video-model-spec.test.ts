import { describe, expect, it } from 'vitest';
import { getJulunVideoModelSpec } from './julun-video-model-spec';
import { buildAuthenticatedNewApiCatalog, parseNewApiPricing } from './newapi-model-catalog';
import { ProviderBridgeProfileSchema } from './provider-contracts';
import publicPricing from './test-fixtures/julun-public-video-pricing-20261003.json';

const publicIds = publicPricing.data.map(row => row.model_name);
const catalog = () => buildAuthenticatedNewApiCatalog({ provider: 'julun', accessibleModelIds: publicIds,
  pricing: parseNewApiPricing(publicPricing) });
const completeIds = ['sd2.5_30', 'Q10-SD2.5 全参', 'grok-imagine-video-1.5（按次）', 'minimax_h3', 'Minimax-H3-768p-933-10s-15s'];

describe('Julun parameters from the public 2026-10-03 source', () => {
  it('retains the source identity and exact 24 public IDs without reading an account or generating media', () => {
    expect(publicPricing.source_url).toBe('https://julun.cc/api/pricing');
    expect(publicPricing.captured_on).toBe('2026-10-03');
    expect(publicIds).toHaveLength(24);
    expect(new Set(publicIds).size).toBe(24);
    expect(catalog().map(profile => profile.modelId)).toEqual(publicIds);
    for (const profile of catalog()) expect(ProviderBridgeProfileSchema.safeParse(profile).success).toBe(true);
  });
  it.each(publicIds)('binds exact model %s to an evidenced parameter spec', modelId => {
    expect(getJulunVideoModelSpec(modelId)).toMatchObject({ modelId, source: 'public-pricing-20261003' });
  });
  it('uses the actual public video_api dimension grids instead of a rounded generic 720p grid', () => {
    for (const row of publicPricing.data) {
      if (!row.video_api) continue;
      const api = row.video_api;
      const spec = getJulunVideoModelSpec(row.model_name)!;
      expect(spec.constraints.resolutions).toEqual(api.sizes);
      expect(spec.constraints.aspectRatios).toEqual(api.ratios);
      expect(spec.constraints.duration).toMatchObject({ mode: 'range', min: api.seconds_min, max: api.seconds_max, step: 1 });
      expect(spec.references).toEqual({ imagesMax: api.images_max, videosMax: api.videos_max, audiosMax: api.audios_max });
      expect(spec.dimensionGrid).toEqual(api.resolutions.map(row => ({ resolution: row.size, aspectRatio: row.ratio, width: row.width, height: row.height })));
    }
  });
  it('only marks five parameter-complete routes runnable after account/public intersection', () => {
    const profiles = catalog();
    expect(profiles.filter(profile => profile.capabilityStatus === 'complete').map(profile => profile.modelId).sort()).toEqual([...completeIds].sort());
    for (const profile of profiles) {
      if (profile.capabilityStatus !== 'complete') continue;
      expect(profile.constraints?.video?.aspectRatios?.length).toBeGreaterThan(0);
      expect(profile.constraints?.video?.resolutions?.length).toBeGreaterThan(0);
      expect(profile.constraints?.video?.duration).toBeDefined();
    }
  });
  it('keeps unknown ratios and unknown C2/wan parameters absent rather than inventing 16:9 720p 5/10 seconds', () => {
    for (const modelId of ['wan-3.0-c2', 'seedance-2.0-c2', 'seedance-2.0-fast-c2']) {
      const spec = getJulunVideoModelSpec(modelId)!;
      expect(spec.constraints.aspectRatios).toBeUndefined();
      expect(spec.constraints.resolutions).toBeUndefined();
      expect(spec.constraints.duration).toBeUndefined();
      expect(spec.parameterEvidenceComplete).toBe(false);
    }
    for (const modelId of ['seedance-2.5-720p', 'seedance-2.5-pro-480', 'seedance-2.5-pro-720']) {
      expect(getJulunVideoModelSpec(modelId)?.constraints.aspectRatios).toBeUndefined();
      expect(catalog().find(profile => profile.modelId === modelId)?.capabilityStatus).toBe('incomplete');
    }
  });
  it('preserves the fixed 15-second route and the public 30-second ranges', () => {
    expect(getJulunVideoModelSpec('seedance-2.0-fast-15s')?.constraints.duration).toEqual({ mode: 'options', defaultValue: 15, options: [15] });
    for (const modelId of ['sd2.5_30', 'Q10-SD2.5 全参', 'seedance-2.5-720p', 'seedance-2.5-pro-480', 'seedance-2.5-pro-720', 'SD 2.0-933']) {
      expect(getJulunVideoModelSpec(modelId)?.constraints.duration).toMatchObject({ mode: 'range', min: 4, max: 30, step: 1 });
    }
  });
  it('keeps the resolution-dependent mini limits as a common safe profile range plus exact per-resolution maxima', () => {
    expect(getJulunVideoModelSpec('sd2-mini')).toMatchObject({ constraints: { resolutions: ['480p', '720p'],
      duration: { mode: 'range', min: 5, max: 12, step: 1 } }, durationMaxByResolution: { '480p': 15, '720p': 12 } });
  });
  it('treats same-description SD 2.5 as an upstream alias, preserving its distinct exact ID', () => {
    const old = publicPricing.data.find(row => row.model_name === 'sd2.5')!;
    const alias = publicPricing.data.find(row => row.model_name === 'SD 2.5')!;
    expect(alias.description).toBe(old.description);
    expect(getJulunVideoModelSpec('SD 2.5')?.aliasOf).toBe('sd2.5');
    expect(getJulunVideoModelSpec('SD 2.5')?.constraints).toEqual(getJulunVideoModelSpec('sd2.5')?.constraints);
  });
  it('keeps mandatory video-plus-image editing incomplete and does not invent a text generation duration', () => {
    expect(getJulunVideoModelSpec('video-editing')).toMatchObject({ kind: 'editing', parameterEvidenceComplete: false,
      references: { requiredImages: 1, requiredVideos: 1 }, inputVideoDurationMax: 30 });
    expect(getJulunVideoModelSpec('video-editing')?.constraints.duration).toBeUndefined();
    expect(catalog().find(profile => profile.modelId === 'video-editing')?.capabilityStatus).toBe('incomplete');
  });
  it('fails closed for unknown exact IDs and returns an independent copy of each specification', () => {
    expect(getJulunVideoModelSpec('MINIMAX_h3')).toBeUndefined();
    const first = getJulunVideoModelSpec('minimax_h3')!;
    first.constraints.resolutions!.push('4K');
    expect(getJulunVideoModelSpec('minimax_h3')?.constraints.resolutions).toEqual(['480p', '768p']);
  });
});
