import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';

export const IMAGE_RESOLUTION_TIERS = ['1K', '2K', '4K'] as const;
export type ImageResolutionTier = typeof IMAGE_RESOLUTION_TIERS[number];

interface ImageResolutionRoute {
  readonly provider: string;
  readonly modelRoute: string;
  readonly displayName: string;
  readonly modelId?: string;
  readonly capabilityStatus?: ProviderBridgeProfile['capabilityStatus'];
  readonly constraints?: ProviderBridgeProfile['constraints'];
}

export function listImageResolutionTiers(
  routes: readonly ImageResolutionRoute[],
  selected: ImageResolutionRoute | undefined,
): ImageResolutionTier[] {
  if (selected === undefined) return [...IMAGE_RESOLUTION_TIERS];
  const declared = new Set(resolutionFamilyRoutes(routes, selected).flatMap((route) => declaredResolutionTiers(route)));
  if (declared.size > 0) return IMAGE_RESOLUTION_TIERS.filter((tier) => declared.has(tier));
  return implicitResolutionTiers(selected);
}

export function resolveImageResolutionRoute<T extends ImageResolutionRoute>(
  routes: readonly T[],
  selected: T,
  resolution: ImageResolutionTier,
): T | undefined {
  const family = resolutionFamilyRoutes(routes, selected);
  const exactVariant = family.find((route) => {
    const declared = declaredResolutionTiers(route);
    return declared.length === 1 && declared[0] === resolution;
  });
  if (exactVariant !== undefined) return exactVariant;
  const declaredMatch = family.find((route) => declaredResolutionTiers(route).includes(resolution));
  if (declaredMatch !== undefined) return declaredMatch;
  return declaredResolutionTiers(selected).length === 0 && implicitResolutionTiers(selected).includes(resolution)
    ? selected
    : undefined;
}

function resolutionFamilyRoutes<T extends ImageResolutionRoute>(routes: readonly T[], selected: T): T[] {
  const selectedKey = imageResolutionFamilyKey(selected);
  return routes.filter((route) => route.provider === selected.provider && imageResolutionFamilyKey(route) === selectedKey);
}

function imageResolutionFamilyKey(route: ImageResolutionRoute): string {
  const identity = route.modelId ?? route.displayName ?? route.modelRoute;
  return identity.trim().toLocaleLowerCase()
    .replace(/[._/\s]+/gu, '-')
    .replace(/-(?:512px|1k|2k|4k)$/u, '');
}

function declaredResolutionTiers(route: ImageResolutionRoute): ImageResolutionTier[] {
  const resolutions = route.constraints?.image?.resolutions ?? [];
  return IMAGE_RESOLUTION_TIERS.filter((tier) => resolutions.includes(tier));
}

function implicitResolutionTiers(route: ImageResolutionRoute): ImageResolutionTier[] {
  const identity = `${route.modelId ?? ''} ${route.displayName} ${route.modelRoute}`.trim().toLocaleLowerCase();
  if (route.capabilityStatus !== 'complete') return [...IMAGE_RESOLUTION_TIERS];
  if (route.provider === 'comfly') {
    if (/(?:nano[-\s]?banana|gemini-3\.1-flash-image-preview|gpt[-\s]?image[-\s]?2)/u.test(identity)) {
      return [...IMAGE_RESOLUTION_TIERS];
    }
    return ['1K', '2K'];
  }
  if (route.provider === 'relayme') return [...IMAGE_RESOLUTION_TIERS];
  if (route.provider === '4dai' && /gpt[-\s]?image[-\s]?2/u.test(identity)) return [...IMAGE_RESOLUTION_TIERS];
  return ['1K'];
}
