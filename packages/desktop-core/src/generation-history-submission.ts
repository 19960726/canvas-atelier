import type { GenerationHistoryRecord } from '@agent-canvas/domain';

import type { ProviderBridgeProfile, ProviderBridgeProvider } from './provider-contracts.js';

export function buildImageGenerationHistorySubmission(
  profile: Pick<ProviderBridgeProfile, 'displayName' | 'modelId' | 'modelRoute' | 'provider'>,
  parameters: Pick<GenerationHistoryRecord['parameters'], 'aspectRatio' | 'resolution' | 'outputCount'>,
): {
  readonly modelDisplayName: string;
  readonly modelId: string;
  readonly modelRoute: string;
  readonly parameters: GenerationHistoryRecord['parameters'];
  readonly provider: ProviderBridgeProvider;
} {
  const { aspectRatio, resolution, outputCount } = parameters;
  return {
    modelDisplayName: profile.displayName,
    modelId: profile.modelId ?? profile.modelRoute,
    modelRoute: profile.modelRoute,
    parameters: Object.fromEntries(Object.entries({ aspectRatio, resolution, outputCount }).filter(([, value]) => value !== undefined)) as GenerationHistoryRecord['parameters'],
    provider: profile.provider,
  };
}
