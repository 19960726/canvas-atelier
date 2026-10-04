import type { NewApiModelProfile, NewApiProviderId } from './newapi-model-catalog.js';
import { getJulunVideoModelSpec } from './julun-video-model-spec.js';

const incompleteVideo = (modelId: string, modelRoute: string): NewApiModelProfile => {
  const spec = getJulunVideoModelSpec(modelId);
  return {
    provider: 'julun', modelRoute, displayName: modelId, modelId,
    capabilities: ['video_generation', 'async_tasks'], capabilityStatus: 'incomplete',
    ...(spec === undefined ? {} : { constraints: { video: spec.constraints } }),
  };
};
const incompleteImage = (modelId: string, modelRoute: string): NewApiModelProfile => ({
  provider: '4dai', modelRoute, displayName: modelId, modelId,
  capabilities: ['image_generation'], capabilityStatus: 'incomplete',
});
const incompleteVision = (modelId: string, modelRoute: string): NewApiModelProfile => ({
  provider: '4dai', modelRoute, displayName: modelId, modelId,
  capabilities: ['chat', 'vision', 'reverse_prompt'], capabilityStatus: 'incomplete',
});

export const NEW_API_PROVIDER_SEEDS: Readonly<Record<NewApiProviderId, readonly NewApiModelProfile[]>> = {
  julun: [
    incompleteVideo('seedance-2.0-fast-deal', 'julun-seedance-2-0-fast-deal'),
    incompleteVideo('grok-imagine-video-1.5-preview', 'julun-grok-imagine-video-1-5-preview'),
    incompleteVideo('grok-imagine-video-1.5（按次）', 'julun-grok-imagine-video-1-5'),
    incompleteVideo('Minimax-H3-768p-933-10s-15s', 'julun-minimax-h3-768p-933-10s-15s'),
    incompleteVideo('minimax-h3 768p', 'julun-minimax-h3-768p'),
    incompleteVideo('minimax-h3 2k', 'julun-minimax-h3-2k'),
    incompleteVideo('sd2.0-720', 'julun-sd2-0-720'),
    incompleteVideo('sd2-mini', 'julun-sd2-mini'),
    incompleteVideo('minimax_h3', 'julun-minimax-h3'),
    incompleteVideo('sd2.5', 'julun-sd2-5'),
    incompleteVideo('seedance-2.0-deal', 'julun-seedance-2-0-deal'),
    incompleteVideo('seedance-2.5-720p', 'julun-seedance-2-5-720p'),
    incompleteVideo('seedance-2.5-pro-480', 'julun-seedance-2-5-pro-480'),
    incompleteVideo('seedance-2.5-pro-720', 'julun-seedance-2-5-pro-720'),
    incompleteVideo('Q10-SD2.5 全参', 'julun-q10-sd2-5-full'),
    incompleteVideo('wan-3.0-c2', 'julun-wan-3-0-c2'),
    incompleteVideo('video-editing', 'julun-video-editing'),
    incompleteVideo('MINIMAX-H3-768p-933', 'julun-minimax-h3-768p-933'),
    incompleteVideo('MINIMAX-H3-2.0采样-933', 'julun-minimax-h3-2-0-sampling-933'),
    incompleteVideo('sd2.5_30', 'julun-sd2-5-30'),
    incompleteVideo('SD 2.5', 'julun-sd-2-5-alias'),
    incompleteVideo('SD 2.0', 'julun-sd-2-0'),
    incompleteVideo('SD 2.0-933', 'julun-sd-2-0-933'),
    incompleteVideo('sd2.0-933-720p-fast-x5-15s', 'julun-sd2-0-933-720p-fast-x5-15s'),
    incompleteVideo('seedance-2.0-c2', 'julun-seedance-2-0-c2'),
    incompleteVideo('seedance-2.0-fast-c2', 'julun-seedance-2-0-fast-c2'),
    incompleteVideo('seedance-2.0-fast-15s', 'julun-seedance-2-0-fast-15s'),
    incompleteVideo('Seedance-933', 'julun-seedance-933'),
  ],
  '4dai': [
    incompleteImage('gpt-image-1', '4dai-gpt-image-1'),
    incompleteImage('gpt-image-1.5', '4dai-gpt-image-1-5'),
    incompleteImage('gpt-image-2', '4dai-gpt-image-2'),
    incompleteImage('gpt-image-2-2k', '4dai-gpt-image-2-2k'),
    incompleteImage('gpt-image-2-4k', '4dai-gpt-image-2-4k'),
    incompleteImage('gpt-image-2.5', '4dai-gpt-image-2-5'),
    incompleteImage('gpt-image-2.5-flare', '4dai-gpt-image-2-5-flare'),
    incompleteImage('gpt-image-2.5-sunburst', '4dai-gpt-image-2-5-sunburst'),
    incompleteImage('grok-imagine-image-2.0', '4dai-grok-imagine-image-2-0'),
    incompleteImage('grok-imagine-image-quality', '4dai-grok-imagine-image-quality'),
    incompleteImage('gemini-3-pro-image-preview', '4dai-gemini-3-pro-image-preview'),
    incompleteImage('gemini-3-pro-image-preview-4k', '4dai-gemini-3-pro-image-preview-4k'),
    incompleteImage('gemini-3-pro-image-special-4k', '4dai-gemini-3-pro-image-special-4k'),
    incompleteImage('gemini-3.1-flash-image-preview', '4dai-gemini-3-1-flash-image-preview'),
    incompleteVision('gpt-6-astra', '4dai-gpt-6-astra'),
    incompleteVision('claude-fable-5', '4dai-claude-fable-5'),
    incompleteVision('claude-opus-5', '4dai-claude-opus-5'),
    incompleteVision('grok-4.6', '4dai-grok-4-6'),
  ],
};

// These routes were already stored before the 2026-10-03 public additions.
// Newly seeded IDs preserve any previously stored dynamic route first.
export const JULUN_HISTORICAL_SEED_MODEL_IDS: ReadonlySet<string> = new Set(NEW_API_PROVIDER_SEEDS.julun.slice(0, 11).map(profile => profile.modelId));
