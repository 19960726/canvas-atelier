import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';

export const PROVIDER_MODEL_DEFAULTS_STORAGE_KEY = 'novus-atelier:provider-model-defaults:v1';

export type ProviderModelDefaultCapability =
  | 'image_generation'
  | 'video_generation'
  | 'chat'
  | 'reverse_prompt'
  | 'vision'
  | 'video_understanding';

export type ProviderModelDefaultRoutes = Partial<Record<ProviderModelDefaultCapability, string>>;

type ProviderId = ProviderBridgeProfile['provider'];
type ProviderModelDefaultProfile = {
  readonly provider: string;
  readonly modelRoute: string;
  readonly capabilities: readonly string[];
  readonly enabled?: boolean;
  readonly capabilityStatus?: string;
};
type PersistedProviderModelDefaults = {
  readonly version: 1;
  readonly providers: Partial<Record<ProviderId, ProviderModelDefaultRoutes>>;
};

const PROVIDERS = ['comfly', 'relayme', 'julun', '4dai'] as const satisfies readonly ProviderId[];
const CAPABILITIES = [
  'image_generation',
  'video_generation',
  'chat',
  'reverse_prompt',
  'vision',
  'video_understanding',
] as const satisfies readonly ProviderModelDefaultCapability[];
const providerSet = new Set<string>(PROVIDERS);
const capabilitySet = new Set<string>(CAPABILITIES);
let volatileDefaults: PersistedProviderModelDefaults | null = null;

export function readProviderModelDefaults(provider: ProviderId): ProviderModelDefaultRoutes {
  const persisted = readPersistedDefaults();
  return { ...(persisted.providers[provider] ?? {}) };
}

export function writeProviderModelDefaults(
  provider: ProviderId,
  defaults: ProviderModelDefaultRoutes,
): ProviderModelDefaultRoutes {
  const sanitized = sanitizeDefaultRoutes(defaults);
  const current = readPersistedDefaults();
  const next: PersistedProviderModelDefaults = {
    version: 1,
    providers: {
      ...current.providers,
      [provider]: sanitized,
    },
  };
  const storage = resolveLocalStorage();
  if (storage === null) {
    volatileDefaults = next;
    return { ...sanitized };
  }
  try {
    storage.setItem(PROVIDER_MODEL_DEFAULTS_STORAGE_KEY, JSON.stringify(next));
    volatileDefaults = null;
  } catch {
    volatileDefaults = next;
  }
  return { ...sanitized };
}

export function selectSavedProviderModelDefault<Profile extends ProviderModelDefaultProfile>(
  profiles: readonly Profile[],
  capability: ProviderModelDefaultCapability,
): Profile | undefined {
  const firstProvider = profiles.find((profile) => profile.capabilities.includes(capability))?.provider;
  if (firstProvider === undefined || !isProviderId(firstProvider)) return undefined;
  const savedRoute = readProviderModelDefaults(firstProvider)[capability];
  if (savedRoute === undefined) return undefined;
  return profiles.find((profile) => (
    profile.provider === firstProvider
    && profile.modelRoute === savedRoute
    && isRunnableDefaultProfile(profile, capability)
  ));
}

export function orderProviderProfilesBySavedDefault<Profile extends ProviderModelDefaultProfile>(
  profiles: readonly Profile[],
  capability: ProviderModelDefaultCapability,
): Profile[] {
  const providerRanks = new Map<string, number>();
  const savedRoutes = new Map<string, string>();
  const originalRanks = new Map<Profile, number>();
  profiles.forEach((profile, index) => {
    originalRanks.set(profile, index);
    if (!providerRanks.has(profile.provider)) providerRanks.set(profile.provider, providerRanks.size);
  });
  for (const provider of providerRanks.keys()) {
    if (!isProviderId(provider)) continue;
    const savedRoute = readProviderModelDefaults(provider)[capability];
    if (savedRoute !== undefined && profiles.some((profile) => (
      profile.provider === provider
      && profile.modelRoute === savedRoute
      && isRunnableDefaultProfile(profile, capability)
    ))) {
      savedRoutes.set(provider, savedRoute);
    }
  }
  return [...profiles].sort((left, right) => (
    (providerRanks.get(left.provider) ?? Number.MAX_SAFE_INTEGER)
    - (providerRanks.get(right.provider) ?? Number.MAX_SAFE_INTEGER)
    || Number(right.modelRoute === savedRoutes.get(right.provider))
    - Number(left.modelRoute === savedRoutes.get(left.provider))
    || (originalRanks.get(left) ?? Number.MAX_SAFE_INTEGER)
    - (originalRanks.get(right) ?? Number.MAX_SAFE_INTEGER)
  ));
}

function readPersistedDefaults(): PersistedProviderModelDefaults {
  const storage = resolveLocalStorage();
  if (storage === null) return volatileDefaults ?? emptyDefaults();
  try {
    const raw = storage.getItem(PROVIDER_MODEL_DEFAULTS_STORAGE_KEY);
    if (raw === null) return volatileDefaults ?? emptyDefaults();
    return parsePersistedDefaults(JSON.parse(raw)) ?? emptyDefaults();
  } catch {
    return volatileDefaults ?? emptyDefaults();
  }
}

function isRunnableDefaultProfile(
  profile: ProviderModelDefaultProfile,
  capability: ProviderModelDefaultCapability,
): boolean {
  return profile.enabled !== false
    && profile.capabilityStatus !== 'incomplete'
    && profile.capabilities.includes(capability);
}

function isProviderId(value: string): value is ProviderId {
  return providerSet.has(value);
}

function parsePersistedDefaults(value: unknown): PersistedProviderModelDefaults | null {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.providers)) return null;
  if (Object.keys(value.providers).some((provider) => !providerSet.has(provider))) return null;
  const providers: Partial<Record<ProviderId, ProviderModelDefaultRoutes>> = {};
  for (const provider of PROVIDERS) {
    const candidate = value.providers[provider];
    if (candidate === undefined) continue;
    if (!isRecord(candidate) || Object.keys(candidate).some((capability) => !capabilitySet.has(capability))) return null;
    providers[provider] = sanitizeDefaultRoutes(candidate);
  }
  return { version: 1, providers };
}

function sanitizeDefaultRoutes(value: Record<string, unknown>): ProviderModelDefaultRoutes {
  const defaults: ProviderModelDefaultRoutes = {};
  for (const capability of CAPABILITIES) {
    const route = value[capability];
    if (typeof route !== 'string') continue;
    const normalized = route.trim();
    if (normalized.length === 0 || normalized.length > 512 || /[\u0000-\u001f\u007f]/u.test(normalized)) continue;
    defaults[capability] = normalized;
  }
  return defaults;
}

function resolveLocalStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function emptyDefaults(): PersistedProviderModelDefaults {
  return { version: 1, providers: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
