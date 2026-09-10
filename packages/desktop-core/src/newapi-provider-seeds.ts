import type { NewApiModelProfile, NewApiProviderId } from './newapi-model-catalog.js';

const incompleteVideo = (modelId: string, modelRoute: string): NewApiModelProfile => ({
  provider: 'julun', modelRoute, displayName: modelId, modelId,
  capabilities: ['video_generation', 'async_tasks'], capabilityStatus: 'incomplete',
});
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
  ],
  '4dai': [
    incompleteImage('gpt-image-1', '4dai-gpt-image-1'),
    incompleteImage('gpt-image-1.5', '4dai-gpt-image-1-5'),
    incompleteImage('gpt-image-2', '4dai-gpt-image-2'),
    incompleteImage('gpt-image-2-2k', '4dai-gpt-image-2-2k'),
    incompleteImage('gpt-image-2-4k', '4dai-gpt-image-2-4k'),
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
