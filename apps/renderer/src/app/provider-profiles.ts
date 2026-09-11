import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import {
  orderProviderProfilesBySavedDefault,
  selectSavedProviderModelDefault,
  type ProviderModelDefaultCapability,
} from '../settings/provider-model-defaults';

export type ActiveProvider = ProviderBridgeProfile['provider'] | null;

type ProviderProfileBridge = {
  listProfiles(request?: { readonly provider?: ProviderBridgeProfile['provider'] }): Promise<ProviderBridgeProfile[]>;
  getStatus?(request?: { readonly provider?: ProviderBridgeProfile['provider'] }): Promise<{ readonly configured: boolean; readonly locked: boolean }>;
  getActiveProvider?(): Promise<{ readonly activeProvider: ProviderBridgeProfile['provider'] | null }>;
};

const providerProfileRouteAliases = new Map<string, string>();
const providerCatalogProviders = ['comfly', 'relayme', 'julun', '4dai'] as const;

export async function listRunnableProviderProfiles(
  bridge: ProviderProfileBridge,
  options: { readonly includeLocked?: boolean; readonly activeProviderOnly?: boolean } = {},
): Promise<ProviderBridgeProfile[]> {
  const loaded = await loadAllProviderProfiles(bridge, { preserveImageRoutes: true });
  const profiles = loaded.profiles.filter((profile) => isRunnableProfile(profile)
    && !loaded.unconfiguredProviders.has(profile.provider)
    && (options.includeLocked === true || !loaded.lockedProviders.has(profile.provider)));
  let activeProvider: ProviderBridgeProfile['provider'] | null | undefined;
  try {
    activeProvider = (await bridge.getActiveProvider?.())?.activeProvider;
  } catch {
    // The active provider only affects ordering. Keep the usable catalog when
    // the local preference cannot be read during refresh or startup.
    return profiles;
  }
  if (activeProvider === undefined || activeProvider === null) return profiles;
  if (options.activeProviderOnly === true) {
    return profiles.filter((profile) => profile.provider === activeProvider);
  }
  return [...profiles].sort((left, right) => (
    Number(right.provider === activeProvider) - Number(left.provider === activeProvider)
  ));
}

function isRunnableProfile(profile: ProviderBridgeProfile): boolean {
  return profile.enabled !== false && profile.capabilityStatus !== 'incomplete';
}

export async function listAllProviderProfiles(
  bridge: ProviderProfileBridge,
  options: { readonly preserveImageRoutes?: boolean } = {},
): Promise<ProviderBridgeProfile[]> {
  return (await loadAllProviderProfiles(bridge, options)).profiles;
}

async function loadAllProviderProfiles(
  bridge: ProviderProfileBridge,
  options: { readonly preserveImageRoutes?: boolean } = {},
): Promise<{
  readonly profiles: ProviderBridgeProfile[];
  readonly configuredProviders: ReadonlySet<ProviderBridgeProfile['provider']> | null;
  readonly lockedProviders: ReadonlySet<ProviderBridgeProfile['provider']>;
  readonly unconfiguredProviders: ReadonlySet<ProviderBridgeProfile['provider']>;
}> {
  providerProfileRouteAliases.clear();
  const [results, statusResults] = await Promise.all([
    Promise.allSettled(providerCatalogProviders.map((provider) => bridge.listProfiles({ provider }))),
    bridge.getStatus === undefined
      ? Promise.resolve([])
      : Promise.allSettled(providerCatalogProviders.map((provider) => bridge.getStatus!({ provider }))),
  ]);
  const configuredProviders = new Set<ProviderBridgeProfile['provider']>();
  const lockedProviders = new Set<ProviderBridgeProfile['provider']>();
  const unconfiguredProviders = new Set<ProviderBridgeProfile['provider']>();
  statusResults.forEach((result, index) => {
    if (result.status !== 'fulfilled' || result.value === undefined) return;
    const provider = providerCatalogProviders[index];
    if (provider === undefined) return;
    if (!result.value.configured) {
      unconfiguredProviders.add(provider);
    } else if (result.value.locked) {
      lockedProviders.add(provider);
    } else {
      configuredProviders.add(provider);
    }
  });
  const profiles = results.flatMap((result) => result.status === 'fulfilled' && Array.isArray(result.value) ? result.value : []);
  const unique = new Map<string, ProviderBridgeProfile>();
  for (const profile of profiles) {
    if (!shouldExposeProviderProfile(profile)) continue;
    const presentation = normalizeProviderProfilePresentation(profile);
    const key = providerProfileDisplayKey(presentation);
    const current = unique.get(key);
    if (current === undefined) {
      unique.set(key, presentation);
      continue;
    }
    if (compareProviderProfilePreference(presentation, current, configuredProviders) < 0) {
      recordProfileAlias(current, presentation);
      unique.set(key, presentation);
    } else {
      recordProfileAlias(presentation, current);
    }
  }
  const selected = [...unique.values()];
  // Canvas nodes persist exact routes. Keep image variants available for
  // resolving saved selections even when their menu labels are identical.
  if (options.preserveImageRoutes) {
    for (const profile of profiles) {
      if (!profile.capabilities.includes('image_generation') || !shouldExposeProviderProfile(profile)) continue;
      if (!selected.some((candidate) => candidate.provider === profile.provider && candidate.modelRoute === profile.modelRoute)) {
        selected.push(normalizeProviderProfilePresentation(profile));
      }
    }
  }
  return {
    profiles: selected.sort(compareProviderProfiles),
    configuredProviders: bridge.getStatus === undefined ? null : configuredProviders,
    lockedProviders,
    unconfiguredProviders,
  };
}

export function listActiveProviderProfiles(
  profiles: readonly ProviderBridgeProfile[],
  activeProvider: ActiveProvider,
): ProviderBridgeProfile[] {
  if (activeProvider === null) return [];
  return profiles.filter((profile) => profile.provider === activeProvider);
}

export function selectFirstProfileForCapability(
  profiles: readonly ProviderBridgeProfile[],
  capability: ProviderBridgeProfile['capabilities'][number],
): ProviderBridgeProfile | undefined {
  return profiles.find((profile) => profile.capabilities.includes(capability));
}

export function listAgentChatProfiles(
  profiles: readonly ProviderBridgeProfile[],
): ProviderBridgeProfile[] {
  const chatProfiles = profiles.filter((profile) => (
    (profile.capabilities.includes('chat') || profile.capabilities.includes('responses'))
    && !profile.capabilities.includes('image_generation')
    && !profile.capabilities.includes('image_edit')
    && !profile.capabilities.includes('video_generation')
    && !isMediaOutputProfile(profile)
  ));
  // Codex exposes model families/variants under distinct routes (for example
  // low/medium/high reasoning). Do not collapse those into one visible name;
  // the Agent chat picker must be able to switch between every Codex route.
  const unique = new Map<string, ProviderBridgeProfile>();
  for (const profile of chatProfiles) {
    const identity = `${profile.modelRoute} ${profile.modelId ?? ''} ${profile.displayName}`.toLocaleLowerCase();
    const key = identity.includes('codex')
      ? `codex:${profile.provider}:${profile.modelRoute}:${profile.modelId ?? ''}`
      : `visible:${normalizedProviderDisplayName(profile)}`;
    if (!unique.has(key)) unique.set(key, profile);
  }
  return orderProviderProfilesBySavedDefault([...unique.values()], 'chat');
}

export function listCodexAgentProfiles(
  profiles: readonly ProviderBridgeProfile[],
): ProviderBridgeProfile[] {
  return listAgentChatProfiles(profiles).filter((profile) => {
    // Codex mode is reserved for the local/Comfly Codex routes. RelayMe's
    // authenticated chat route belongs to the ordinary provider chat mode.
    if (profile.provider === 'relayme') return false;
    const identity = `${profile.modelRoute} ${profile.modelId ?? ''} ${profile.displayName}`.toLocaleLowerCase();
    return /(?:^|[\s/_-])codex(?:$|[\s/_-])/u.test(identity)
      || /(?:^|[\s/_-])gpt-5\.6-(?:sol|terra|luna)(?:$|[\s/_-])/u.test(identity);
  });
}

export function dedupeProviderProfilesByVisibleName(
  profiles: readonly ProviderBridgeProfile[],
): ProviderBridgeProfile[] {
  const unique = new Map<string, ProviderBridgeProfile>();
  for (const profile of profiles) {
    const key = `${profile.provider}::${normalizedProviderDisplayName(profile)}`;
    if (!unique.has(key)) unique.set(key, profile);
  }
  return [...unique.values()];
}

const CATALOG_CAPABILITIES = new Set<ProviderBridgeProfile['capabilities'][number]>([
  'image_generation',
  'video_generation',
  'chat',
  'responses',
  'reverse_prompt',
  'vision',
  'video_understanding',
]);

export function filterProviderCatalogProfiles(
  profiles: readonly ProviderBridgeProfile[],
): ProviderBridgeProfile[] {
  const unique = new Map<string, ProviderBridgeProfile>();
  for (const profile of profiles) {
    if (!profile.capabilities.some((capability) => CATALOG_CAPABILITIES.has(capability))) continue;
    if (isProviderActionRoute(profile)) continue;
    if (!shouldExposeProviderProfile(profile)) continue;
    const presentation = normalizeProviderProfilePresentation(profile);
    const key = catalogProfileFamilyKey(presentation);
    const current = unique.get(key);
    if (current === undefined || compareCatalogProfileVariants(presentation, current) < 0) {
      unique.set(key, presentation);
    }
  }
  return [...unique.values()].sort(compareProviderProfiles);
}

export function buildCanvasProviderRouteSets(
  profiles: readonly ProviderBridgeProfile[],
  reverseProfiles: readonly ProviderBridgeProfile[] = profiles,
  savedImageRoutes: readonly string[] = [],
): {
  readonly imageGeneration: ProviderBridgeProfile[];
  readonly videoGeneration: ProviderBridgeProfile[];
  readonly reversePrompt: ProviderBridgeProfile[];
  readonly storyboard: ProviderBridgeProfile[];
} {
  const catalog = orderProfilesByProviderPriority(filterProviderCatalogProfiles(
    profiles.filter((profile) => profile.enabled !== false && profile.capabilityStatus !== 'incomplete'),
  ), profiles);
  const reverseCatalog = orderProfilesByProviderPriority(filterProviderCatalogProfiles(
    reverseProfiles.filter((profile) => profile.enabled !== false && profile.capabilityStatus !== 'incomplete'),
  ), reverseProfiles);
  const imageGeneration = dedupeProviderProfilesByVisibleName(catalog.filter((profile) => profile.capabilities.includes('image_generation')));
  for (const profile of profiles) {
    if (!savedImageRoutes.includes(profile.modelRoute)
      || profile.enabled === false
      || profile.capabilityStatus === 'incomplete'
      || !profile.capabilities.includes('image_generation')
      || isProviderActionRoute(profile)
      || !shouldExposeProviderProfile(profile)) continue;
    if (!imageGeneration.some((candidate) => candidate.provider === profile.provider && candidate.modelRoute === profile.modelRoute)) {
      imageGeneration.push(normalizeProviderProfilePresentation(profile));
    }
  }
  return {
    imageGeneration: orderProviderProfilesBySavedDefault(
      orderProfilesByProviderPriority(imageGeneration, profiles),
      'image_generation',
    ),
    videoGeneration: orderProviderProfilesBySavedDefault(
      dedupeProviderProfilesByVisibleName(catalog.filter((profile) => profile.capabilities.includes('video_generation'))),
      'video_generation',
    ),
    // Reverse analysis uses the provider's executable dialogue endpoint. RelayMe's
    // catalog can omit vision metadata for a dialogue deployment, so the
    // reverse route is keyed by the explicit reverse_prompt capability rather
    // than requiring a separate vision flag.
    reversePrompt: orderProviderProfilesBySavedDefault(dedupeProviderProfilesByVisibleName(
      reverseCatalog.filter(isReverseCapableProviderProfile),
    ), 'reverse_prompt'),
    storyboard: listAgentChatProfiles(catalog),
  };
}

function orderProfilesByProviderPriority(
  profiles: readonly ProviderBridgeProfile[],
  orderedSource: readonly ProviderBridgeProfile[],
): ProviderBridgeProfile[] {
  const providerRanks = new Map<ProviderBridgeProfile['provider'], number>();
  for (const profile of orderedSource) {
    if (!providerRanks.has(profile.provider)) providerRanks.set(profile.provider, providerRanks.size);
  }
  return [...profiles].sort((left, right) => (
    (providerRanks.get(left.provider) ?? Number.MAX_SAFE_INTEGER)
    - (providerRanks.get(right.provider) ?? Number.MAX_SAFE_INTEGER)
    || compareProviderProfiles(left, right)
  ));
}

function isProviderActionRoute(profile: ProviderBridgeProfile): boolean {
  const identity = `${profile.modelRoute} ${profile.modelId ?? ''} ${profile.displayName}`.toLocaleLowerCase();
  const isMidjourneyActionRoute = /(?:^|[\s/_-])(?:mid[-_ ]?journey|mj)(?:$|[\s/_-])/u.test(identity);
  return /(?:^|[\s/_-])(?:upload|modal|pan|zoom|reroll|vary|variation|extend|element|elements|identify|presets?|custom-voices|voices-list|models-list|list-models|tts|speech|audio)(?:$|[\s/_-])/u.test(identity)
    || /(?:create|update|delete|get|list)[\s/_-]+(?:element|voice|preset)/u.test(identity)
    || (isMidjourneyActionRoute
      && /(?:^|[\s/_-])(?:blend|describe|edits?|imagine|inpaint|outpaint|shorten|upscale(?:[-_]?\d+x)?|ric[-_]?reader|ricreader[-_]?retry)(?:$|[\s/_-])/u.test(identity));
}

function catalogProfileFamilyKey(profile: ProviderBridgeProfile): string {
  const popularFamily = popularImageFamily(profile);
  if (popularFamily === 'gpt-image-2.5-flare' || popularFamily === 'gpt-image-2.5-sunburst') {
    return `${profile.provider}:popular-image:${providerProfileIdentity(profile)}`;
  }
  if (popularFamily !== null) return `${profile.provider}:popular-image:${popularFamily}`;
  return `${profile.provider}:${providerProfileIdentity(profile)
    .replace(/-20\d{2}-\d{2}-\d{2}$/u, '')
    .replace(/-(?:thinking(?:-(?:high|medium|low|minimal|all|\*))?|nothinking)$/u, '')
    .replace(/-(?:high|medium|low|minimal)$/u, '')}`;
}

function catalogProfileVariantScore(profile: ProviderBridgeProfile): number {
  const identity = providerProfileIdentity(profile);
  let score = 0;
  if (/-20\d{2}-\d{2}-\d{2}$/u.test(identity)) score += 20;
  if (/(?:thinking|nothinking|high|medium|low|minimal|customtools|preview-all)/u.test(identity)) score += 10;
  if (profile.capabilityStatus === 'complete') score -= 2;
  return score;
}

function compareCatalogProfileVariants(left: ProviderBridgeProfile, right: ProviderBridgeProfile): number {
  return catalogProfileVariantScore(left) - catalogProfileVariantScore(right)
    || catalogProfileCanonicalPenalty(left) - catalogProfileCanonicalPenalty(right)
    || catalogProfileContractBreadth(right) - catalogProfileContractBreadth(left)
    || profileLexicalKey(left).localeCompare(profileLexicalKey(right), 'en', { numeric: true, sensitivity: 'base' });
}

function catalogProfileCanonicalPenalty(profile: ProviderBridgeProfile): number {
  const family = popularImageFamily(profile);
  if (family === null) return 0;
  const identity = providerProfileIdentity(profile);
  if (identity === family) return 0;
  if (identity === `${family}-all`) return 1;
  return 2;
}

function catalogProfileContractBreadth(profile: ProviderBridgeProfile): number {
  const image = profile.constraints?.image;
  const video = profile.constraints?.video;
  return (image?.resolutions?.length ?? 0) * 1_000
    + (video?.resolutions?.length ?? 0) * 1_000
    + (image?.aspectRatios?.length ?? 0) * 100
    + (video?.aspectRatios?.length ?? 0) * 100
    + (image?.outputCounts?.length ?? 0) * 10
    + (video?.outputCounts?.length ?? 0) * 10
    + profile.capabilities.length;
}

function normalizeProviderProfilePresentation(profile: ProviderBridgeProfile): ProviderBridgeProfile {
  const family = popularImageFamily(profile);
  if (family === 'gpt-image-2') return { ...profile, displayName: 'GPT Image 2' };
  if (family === 'gpt-image-2.5-flare' || family === 'gpt-image-2.5-sunburst') {
    const resolution = providerProfileIdentity(profile).match(/-(2k|4k)$/u)?.[1]?.toLocaleUpperCase();
    const variant = family === 'gpt-image-2.5-flare' ? 'Flare' : 'Sunburst';
    return { ...profile, displayName: `GPT Image 2.5 ${variant}${resolution === undefined ? '' : ` ${resolution}`}` };
  }
  if (family === 'nano-banana-2') return { ...profile, displayName: 'Nano Banana 2' };
  if (family === 'nano-banana-pro') return { ...profile, displayName: 'Nano Banana Pro' };
  const identity = providerProfileIdentity(profile);
  if (/seedream-(?:v?5(?:[.-]?0)?)(?:-pro)?/u.test(identity) || /doubao-seedream-5/u.test(identity)) {
    return { ...profile, displayName: 'Seedream 5 Pro' };
  }
  if (/veo-?3[.-]?1-fast/u.test(identity)) return { ...profile, displayName: 'Veo 3.1 Fast' };
  if (/kling-(?:video-)?v?3(?:[.-]?0)?$/u.test(identity)) return { ...profile, displayName: 'Kling 3' };
  if (/gemini-3[.-]?1-pro(?:-preview)?$/u.test(identity)) return { ...profile, displayName: 'Gemini 3.1 Pro' };
  return profile;
}

function shouldExposeProviderProfile(profile: ProviderBridgeProfile): boolean {
  if (!profile.capabilities.includes('image_generation')) return true;
  const identity = providerProfileIdentity(profile);
  if (!isGoogleImageIdentity(identity)) return true;
  return popularImageFamily(profile) === 'nano-banana-2'
    || popularImageFamily(profile) === 'nano-banana-pro';
}

function providerProfileDisplayKey(profile: ProviderBridgeProfile): string {
  return [
    profile.provider,
    providerCapabilityGroups(profile).join(','),
    normalizedProviderDisplayName(profile),
  ].join('::');
}

function normalizedProviderDisplayName(profile: ProviderBridgeProfile): string {
  return normalizeProviderProfilePresentation(profile).displayName
    .trim()
    .toLocaleLowerCase()
    .replace(/^(?:comfly|relayme|julun|4dai)[\s:/_-]+/u, '')
    .replace(/[\s_-]+/gu, ' ');
}

function providerCapabilityGroups(profile: ProviderBridgeProfile): string[] {
  return [
    profile.capabilities.includes('image_generation') ? 'image' : null,
    profile.capabilities.includes('video_generation') ? 'video' : null,
    profile.capabilities.includes('reverse_prompt') ? 'reverse' : null,
    profile.capabilities.includes('chat') || profile.capabilities.includes('responses') ? 'chat' : null,
  ].filter((value): value is string => value !== null).sort();
}

function providerCapabilityGroupKey(profile: ProviderBridgeProfile): string {
  return providerCapabilityGroups(profile).join(',');
}

function providerCapabilityGroupForCapability(
  capability: ProviderBridgeProfile['capabilities'][number],
): string {
  if (capability === 'image_generation') return 'image';
  if (capability === 'video_generation') return 'video';
  if (capability === 'reverse_prompt') return 'reverse';
  if (capability === 'chat' || capability === 'responses') return 'chat';
  return capability;
}

function providerProfileIdentity(profile: ProviderBridgeProfile): string {
  return (profile.modelId ?? profile.displayName ?? profile.modelRoute)
    .trim()
    .toLocaleLowerCase()
    .replace(/^(?:comfly|relayme|julun|4dai)[\s:/_-]+/u, '')
    .replace(/[\s_]+/gu, '-');
}

type PopularImageFamily = 'gpt-image-2' | 'gpt-image-2.5-flare' | 'gpt-image-2.5-sunburst' | 'nano-banana-2' | 'nano-banana-pro';

function popularImageFamily(profile: ProviderBridgeProfile): PopularImageFamily | null {
  if (!profile.capabilities.includes('image_generation')) return null;
  const profileIdentity = providerProfileIdentity(profile);
  if (/^gpt-image-2(?:[.-]?5)-flare(?:-(?:2k|4k))?$/u.test(profileIdentity)) return 'gpt-image-2.5-flare';
  if (/^gpt-image-2(?:[.-]?5)-sunburst(?:-(?:2k|4k))?$/u.test(profileIdentity)) return 'gpt-image-2.5-sunburst';
  if (/^gpt-image-2(?:-(?:all|2k|4k|vip))?$/u.test(profileIdentity)) return 'gpt-image-2';
  const identity = `${profileIdentity} ${profile.modelRoute.toLocaleLowerCase()} ${profile.displayName.toLocaleLowerCase()}`;
  if (/nano[-\s_]?banana[-\s_]?pro/u.test(identity) || /gemini[-\s_]?3[-\s_]?pro[-\s_]?.*image/u.test(identity)) return 'nano-banana-pro';
  if (/nano[-\s_]?banana[-\s_]?2/u.test(identity) || /gemini[-\s_]?3(?:[.\s_-]?1)?[-\s_]?.*image/u.test(identity)) return 'nano-banana-2';
  return null;
}

function isGoogleImageIdentity(identity: string): boolean {
  return /(?:^|[-_/])(nano[-_]?banana|gemini|imagen)(?:$|[-_/])/u.test(identity);
}

const MEDIA_OUTPUT_IDENTITY_PATTERNS = [
  /(?:^|-)gemini-\d+(?:-\d+)?-(?:[a-z0-9]+-)*image(?:-|$)/u,
  /(?:^|-)gpt-4o-image(?:-|$)/u,
  /(?:^|-)qwen-(?:image(?:-edit)?|mt-image)(?:-|$)/u,
  /(?:^|-)seedream-\d+(?:-\d+)?(?:-|$)/u,
  /(?:^|-)dall(?:e|-e)(?:-|$)/u,
  /(?:^|-)grok-imagine-video(?:-|$)/u,
  /(?:^|-)hailuo-video(?:-|$)/u,
  /(?:^|-)kling-(?:advanced-lip-sync|meta-human)(?:-|$)/u,
  /(?:^|-)pixverse-video(?:-|$)/u,
  /(?:^|-)sora-2(?:-|$)/u,
  /(?:^|-)veo3(?:-\d+)?-(?:fast-4k|components)(?:-|$)/u,
  /(?:^|-)video-style-transform(?:-|$)/u,
  /(?:^|-)videoretalk(?:-|$)/u,
] as const;

function isMediaOutputProfile(profile: ProviderBridgeProfile): boolean {
  return [profile.modelRoute, profile.modelId, profile.displayName].some((identity) => {
    if (identity === undefined) return false;
    const normalized = identity.trim().toLocaleLowerCase().replace(/[._/\s]+/gu, '-');
    return MEDIA_OUTPUT_IDENTITY_PATTERNS.some((pattern) => pattern.test(normalized));
  });
}

function providerProfilePreference(profile: ProviderBridgeProfile, configuredProviders: ReadonlySet<ProviderBridgeProfile['provider']>): number {
  const routeIdentity = profileRouteIdentity(profile);
  let score = 0;
  if (configuredProviders.has(profile.provider)) score -= 1_000_000;
  if (profile.capabilityStatus === 'complete') score -= 100_000;
  if (!/(?:^|[\s/_-])preview(?:$|[\s/_-])/u.test(routeIdentity)) score -= 1_000;
  if (!/(?:^|[\s/_-])minimal(?:$|[\s/_-])/u.test(routeIdentity)) score -= 100;
  return score;
}

function compareProviderProfilePreference(
  left: ProviderBridgeProfile,
  right: ProviderBridgeProfile,
  configuredProviders: ReadonlySet<ProviderBridgeProfile['provider']>,
): number {
  return providerProfilePreference(left, configuredProviders) - providerProfilePreference(right, configuredProviders)
    || profileLexicalKey(left).localeCompare(profileLexicalKey(right), 'en', { numeric: true, sensitivity: 'base' });
}

function profileRouteIdentity(profile: ProviderBridgeProfile): string {
  return profile.modelRoute.toLocaleLowerCase();
}

function profileLexicalKey(profile: ProviderBridgeProfile): string {
  return `${profile.modelRoute}\u0000${profile.modelId ?? ''}\u0000${profile.displayName}`;
}

function recordProfileAlias(discarded: ProviderBridgeProfile, selected: ProviderBridgeProfile): void {
  const providerPrefix = `${discarded.provider}::${providerCapabilityGroupKey(discarded)}::`;
  const selectedRoute = selected.modelRoute;
  providerProfileRouteAliases.set(`${providerPrefix}${discarded.modelRoute}`, selectedRoute);
  if (discarded.modelId) {
    providerProfileRouteAliases.set(`${providerPrefix}${discarded.modelId}`, selectedRoute);
  }
  for (const [key, route] of providerProfileRouteAliases) {
    if (key.startsWith(providerPrefix) && route === discarded.modelRoute) {
      providerProfileRouteAliases.set(key, selectedRoute);
    }
  }
}

function compareProviderProfiles(left: ProviderBridgeProfile, right: ProviderBridgeProfile): number {
  const priority = (profile: ProviderBridgeProfile): number => {
    const family = popularImageFamily(profile);
    if (family?.startsWith('gpt-image-2')) return 0;
    if (family === 'nano-banana-2') return 1;
    if (family === 'nano-banana-pro') return 2;
    const identity = providerProfileIdentity(profile);
    if (profile.capabilities.includes('video_generation') && /seedance-2(?:[.-]?0)?-pro/u.test(identity)) return 3;
    if (profile.capabilities.includes('video_generation') && /seedance-2(?:[.-]?0)?(?:-fast)?$/u.test(identity)) return 4;
    if (profile.capabilities.includes('video_generation') && /seedance-2[.-]?5/u.test(identity)) return 5;
    return 10;
  };
  return priority(left) - priority(right)
    || left.displayName.localeCompare(right.displayName, 'zh-CN', { numeric: true, sensitivity: 'base' });
}
export function selectProviderProfile(
  profiles: readonly ProviderBridgeProfile[],
  requestedRoute: string | undefined,
  capability: ProviderBridgeProfile['capabilities'][number],
): ProviderBridgeProfile | undefined {
  const capable = profiles.filter((profile) => profile.capabilities.includes(capability));
  if (requestedRoute === undefined || requestedRoute.trim().length === 0) {
    const defaultCapability = toProviderModelDefaultCapability(capability);
    return (defaultCapability === undefined
      ? undefined
      : selectSavedProviderModelDefault(capable, defaultCapability)) ?? capable[0];
  }
  const exact = capable.find((profile) => profile.modelRoute === requestedRoute || profile.modelId === requestedRoute);
  if (exact) return exact;
  const requestedGroup = providerCapabilityGroupForCapability(capability);
  const aliasCandidates = new Map<string, ProviderBridgeProfile>();
  for (const profile of capable) {
    const group = providerCapabilityGroupKey(profile);
    const providerGroup = `${profile.provider}::${group}`;
    const alias = providerProfileRouteAliases.get(`${providerGroup}::${requestedRoute}`);
    if (alias === undefined) continue;
    const selected = capable.find((candidate) => candidate.provider === profile.provider
      && providerCapabilityGroupKey(candidate) === group
      && candidate.modelRoute === alias);
    if (selected) aliasCandidates.set(providerGroup, selected);
  }
  return [...aliasCandidates.entries()]
    .sort(([leftGroup], [rightGroup]) => {
      const [leftProvider = '', leftCapabilities = ''] = leftGroup.split('::', 2);
      const [rightProvider = '', rightCapabilities = ''] = rightGroup.split('::', 2);
      return (leftCapabilities === requestedGroup ? 0 : 1) - (rightCapabilities === requestedGroup ? 0 : 1)
        || (leftCapabilities?.split(',').length ?? 0) - (rightCapabilities?.split(',').length ?? 0)
        || leftCapabilities.localeCompare(rightCapabilities)
        || leftProvider.localeCompare(rightProvider);
    })
    .map(([, profile]) => profile)[0];
}

export interface ReverseProfileRequest {
  readonly provider?: ProviderBridgeProfile['provider'];
  readonly modelRoute?: string;
}

export function selectReverseProviderProfile(
  profiles: readonly ProviderBridgeProfile[],
  request: ReverseProfileRequest,
): ProviderBridgeProfile | undefined {
  const capable = profiles.filter(isReverseCapableProviderProfile);
  const requestedRoute = request.modelRoute?.trim();
  if (requestedRoute) {
    const exactRoute = profiles.filter((profile) => profile.modelRoute === requestedRoute);
    if (exactRoute.length > 0) {
      return selectExecutableExactReverseProfile(exactRoute, request.provider);
    }
    const exactModel = profiles.filter((profile) => profile.modelId === requestedRoute);
    if (exactModel.length > 0) {
      return selectExecutableExactReverseProfile(exactModel, request.provider);
    }
  }

  const preferredProvider = request.provider ?? capable[0]?.provider;
  const owned = preferredProvider === undefined
    ? capable
    : capable.filter((profile) => profile.provider === preferredProvider);
  return selectProviderProfile(owned, requestedRoute, 'reverse_prompt') ?? owned[0];
}

function selectExecutableExactReverseProfile(
  profiles: readonly ProviderBridgeProfile[],
  requestedProvider: ProviderBridgeProfile['provider'] | undefined,
): ProviderBridgeProfile | undefined {
  const providerMatches = requestedProvider === undefined
    ? []
    : profiles.filter((profile) => profile.provider === requestedProvider);
  const scoped = providerMatches.length > 0
    ? providerMatches
    : profiles.length === 1 ? profiles : [];
  const executable = scoped.filter(isReverseCapableProviderProfile);
  return executable.length === 1 ? executable[0] : undefined;
}

export function isReverseCapableProviderProfile(profile: ProviderBridgeProfile): boolean {
  const hasDialogueReverse = profile.capabilities.includes('reverse_prompt')
    && profile.capabilities.includes('chat');
  const hasVisionDialogue = profile.capabilities.includes('vision')
    && profile.capabilities.includes('chat');
  const hasGeminiNativeReverse = profile.capabilities.includes('gemini_native')
    && profile.capabilities.includes('reverse_prompt');
  return hasDialogueReverse || hasVisionDialogue || hasGeminiNativeReverse;
}

function toProviderModelDefaultCapability(
  capability: ProviderBridgeProfile['capabilities'][number],
): ProviderModelDefaultCapability | undefined {
  switch (capability) {
    case 'image_generation':
    case 'video_generation':
    case 'chat':
    case 'reverse_prompt':
    case 'vision':
    case 'video_understanding':
      return capability;
    default:
      return undefined;
  }
}

export interface GenerationProfileRequest {
  readonly provider?: ProviderBridgeProfile['provider'];
  readonly modelRoute?: string;
  readonly modelDisplayName?: string;
}

export function selectGenerationProviderProfile(
  profiles: readonly ProviderBridgeProfile[],
  request: GenerationProfileRequest,
  capability: 'image_generation' | 'video_generation',
): ProviderBridgeProfile | undefined {
  const capable = profiles.filter((profile) => (
    profile.capabilities.includes(capability)
    && (request.provider === undefined || profile.provider === request.provider)
  ));
  const requestedRoute = request.modelRoute?.trim();
  if (requestedRoute) {
    const exact = capable.find((profile) => (
      profile.modelRoute === requestedRoute || profile.modelId === requestedRoute
    ));
    if (exact !== undefined) return exact;
  }

  const requestedDisplayName = request.modelDisplayName?.trim();
  if (requestedDisplayName) {
    const normalizedRequestName = requestedDisplayName
      .toLocaleLowerCase()
      .replace(/^(?:comfly|relayme|julun|4dai)[\s:/_-]+/u, '')
      .replace(/[\s_-]+/gu, ' ');
    const visibleMatches = capable.filter((profile) => (
      normalizedProviderDisplayName(profile) === normalizedRequestName
    ));
    return visibleMatches.length === 1 ? visibleMatches[0] : undefined;
  }

  return requestedRoute
    ? undefined
    : selectSavedProviderModelDefault(capable, capability) ?? capable[0];
}
