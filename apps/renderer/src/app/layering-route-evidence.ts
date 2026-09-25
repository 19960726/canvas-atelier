import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import type { ImageResolutionTier } from '@agent-canvas/domain';

export interface LayeringRouteEvidence {
  readonly provider: ProviderBridgeProfile['provider'];
  readonly modelRoute: string;
  readonly modelId: string;
  readonly source: 'provider_doc' | 'live_alpha_qa';
  readonly verifiedAt: string;
  readonly transparentBackground: true;
  readonly outputFormat: 'png' | 'webp';
  readonly resolutions: readonly ImageResolutionTier[];
}

export interface LayeringRouteContract {
  readonly outputFormat: 'png' | 'webp';
  readonly resolutions: readonly ImageResolutionTier[];
  readonly verification: 'recorded' | 'validate_results';
}

/** Selection describes the request transport, never a promise about output quality.
 * Every returned layer still goes through validateLayerPixels before PSD export.
 * Comfly's GPT multipart edit adapter forwards PNG/background explicitly. Other
 * transports require exact-route evidence until they implement that contract.
 */
export function getLayeringRouteContract(profile: ProviderBridgeProfile, evidence: readonly LayeringRouteEvidence[]): LayeringRouteContract | null {
  if (profile.enabled === false || profile.capabilityStatus === 'incomplete'
    || !profile.modelRoute || !/^gpt[-_ ]?image(?:[-_ .]|$)/iu.test(profile.modelId ?? '')
    || !(['image_generation', 'image_edit', 'async_tasks'] as const).every(capability => profile.capabilities.includes(capability))) return null;
  const record = evidence.find(item => item.provider === profile.provider && item.modelRoute === profile.modelRoute
    && item.modelId === profile.modelId && item.transparentBackground === true
    && ['png', 'webp'].includes(item.outputFormat) && item.resolutions.length > 0
    && ['provider_doc', 'live_alpha_qa'].includes(item.source));
  if (!record && profile.provider !== 'comfly') return null;
  const suffix = profile.modelId?.match(/-(1k|2k|4k)$/iu)?.[1]?.toUpperCase() as ImageResolutionTier | undefined;
  const declared = profile.constraints?.image?.resolutions ?? (suffix ? [suffix] : ['1K', '2K'] as const);
  const resolutions = record ? record.resolutions.filter(tier => declared.includes(tier)) : declared;
  if (resolutions.length === 0) return null;
  return { outputFormat: record?.outputFormat ?? 'png', resolutions, verification: record ? 'recorded' : 'validate_results' };
}

export function eligibleForLayeringRoute(
  profile: ProviderBridgeProfile,
  evidence: readonly LayeringRouteEvidence[],
): boolean {
  return getLayeringRouteContract(profile, evidence) !== null;
}

export const PRODUCTION_LAYERING_ROUTE_EVIDENCE: readonly LayeringRouteEvidence[] = Object.freeze([]);
