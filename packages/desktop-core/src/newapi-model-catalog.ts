import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { ComflyModelCapability } from '@agent-canvas/provider-comfly';
import { NEW_API_PROVIDER_SEEDS } from './newapi-provider-seeds.js';
import type { ProviderBridgeProfile } from './provider-contracts.js';

export type NewApiProviderId = 'julun' | '4dai';

export interface NewApiPricingEntry {
  readonly modelName: string;
  readonly description?: string;
  readonly pricingVersion?: string;
  readonly imageRatio?: number | null;
  readonly supportedEndpointTypes: readonly string[];
  readonly enableGroups?: readonly string[];
}

export interface NewApiModelProfile {
  readonly provider: NewApiProviderId;
  readonly modelRoute: string;
  readonly displayName: string;
  readonly modelId: string;
  readonly capabilities: ComflyModelCapability[];
  readonly capabilityStatus: 'complete' | 'incomplete';
  readonly constraints?: ProviderBridgeProfile['constraints'];
}

const PricingEnvelopeSchema = z.object({
  data: z.array(z.object({
    model_name: z.string().min(1).max(200),
    description: z.string().max(2_000).nullish().transform((value) => value ?? undefined),
    pricing_version: z.string().max(100).nullish().transform((value) => value ?? undefined),
    image_ratio: z.number().finite().nonnegative().nullable().optional(),
    supported_endpoint_types: z.array(z.string().min(1).max(100)).min(1),
    enable_groups: z.array(z.string().min(1).max(200)).max(100).nullish().transform((value) => value ?? []),
  }).passthrough()).max(10_000),
}).passthrough();

export function parseNewApiPricing(value: unknown): NewApiPricingEntry[] {
  const parsed = PricingEnvelopeSchema.safeParse(value);
  if (!parsed.success) throw new Error('New API pricing response is invalid');
  return parsed.data.data.map((entry) => ({
    modelName: entry.model_name,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    ...(entry.pricing_version === undefined ? {} : { pricingVersion: entry.pricing_version }),
    ...(entry.image_ratio === undefined ? {} : { imageRatio: entry.image_ratio }),
    supportedEndpointTypes: [...entry.supported_endpoint_types],
    ...(entry.enable_groups.length === 0 ? {} : { enableGroups: [...entry.enable_groups] }),
  }));
}

export function buildAuthenticatedNewApiCatalog(options: {
  readonly provider: NewApiProviderId;
  readonly accessibleModelIds: readonly string[];
  readonly pricing: readonly NewApiPricingEntry[];
  readonly verifiedVisionModelIds?: readonly string[];
  readonly persistedProfiles?: readonly Pick<NewApiModelProfile, 'provider' | 'modelId' | 'modelRoute'>[];
}): NewApiModelProfile[] {
  const accessible = new Set(options.accessibleModelIds);
  const verifiedVision = new Set(options.verifiedVisionModelIds ?? []);
  const profiles: Array<Omit<NewApiModelProfile, 'modelRoute'>> = [];
  const seen = new Set<string>();
  for (const entry of options.pricing) {
    if (!accessible.has(entry.modelName) || seen.has(entry.modelName)) continue;
    const endpoints = new Set(entry.supportedEndpointTypes);
    let capabilities: readonly ComflyModelCapability[] = [];
    let capabilityStatus: NewApiModelProfile['capabilityStatus'] = 'complete';
    if (options.provider === 'julun' && endpoints.has('openai-video')) {
      capabilities = ['video_generation', 'async_tasks'];
    } else if (
      options.provider === '4dai'
      && isAudited4daiGeminiImageModel(entry.modelName)
      && (endpoints.has('gemini') || endpoints.has('image-generation'))
    ) {
      capabilities = endpoints.has('gemini')
        ? ['image_generation', 'image_edit']
        : ['image_generation'];
      if (!endpoints.has('gemini')) capabilityStatus = 'incomplete';
    } else if (options.provider === '4dai' && endpoints.has('image-generation')) {
      capabilities = ['image_generation'];
    } else if (options.provider === '4dai' && endpoints.has('openai') && isAudited4daiGptImage25Entry(entry)) {
      capabilities = ['image_generation'];
    } else if (options.provider === '4dai' && endpoints.has('openai') && isNamed4daiImageCandidate(entry.modelName)) {
      capabilities = ['image_generation'];
      capabilityStatus = 'incomplete';
    } else if (
      options.provider === '4dai'
      && endpoints.has('openai')
      && (verifiedVision.has(entry.modelName) || (entry.imageRatio !== null && entry.imageRatio !== undefined && entry.imageRatio > 0))
    ) {
      capabilities = ['chat', 'vision', 'reverse_prompt'];
    }
    if (capabilities.length === 0) continue;
    seen.add(entry.modelName);
    profiles.push({
      provider: options.provider,
      displayName: entry.modelName,
      modelId: entry.modelName,
      capabilities: [...capabilities],
      capabilityStatus,
      ...constraintsFor(options.provider, entry.modelName, capabilities, capabilityStatus),
    });
  }
  return assignStableModelRoutes(options.provider, profiles, options.persistedProfiles ?? []);
}

function isNamed4daiImageCandidate(modelId: string): boolean {
  return /^(?:gpt-image-2(?:-(?:2k|4k)|\.5-(?:flare|sunburst))?|grok-imagine-image-(?:2\.0|quality)|gemini-3-pro-image-[a-z0-9._-]+|gemini-3\.1-flash-image-[a-z0-9._-]+)$/iu.test(modelId);
}

const AUDITED_4DAI_GPT_IMAGE_25_MODELS = new Set([
  'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst',
]);

const AUDITED_4DAI_GEMINI_IMAGE_MODELS = new Set([
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image-preview',
]);

export function isAudited4daiGeminiImageModel(modelId: string): boolean {
  return AUDITED_4DAI_GEMINI_IMAGE_MODELS.has(modelId);
}

function isAudited4daiGptImage25Entry(entry: NewApiPricingEntry): boolean {
  return AUDITED_4DAI_GPT_IMAGE_25_MODELS.has(entry.modelName)
    && entry.enableGroups?.some((group) => /^GPT原生4K(?:\s|$)/u.test(group.trim())) === true;
}

function constraintsFor(
  provider: NewApiProviderId,
  modelId: string,
  capabilities: readonly ComflyModelCapability[],
  capabilityStatus: NewApiModelProfile['capabilityStatus'],
): Pick<NewApiModelProfile, 'constraints'> | Record<string, never> {
  if (provider === 'julun' && capabilities.includes('video_generation') && capabilityStatus === 'complete') {
    return { constraints: { video: {
      aspectRatios: ['16:9'],
      resolutions: ['720p'],
      duration: { mode: 'options', defaultValue: 10, options: [5, 10] },
      outputCounts: [1],
    } } };
  }
  if (provider !== '4dai' || !capabilities.includes('image_generation')) return {};
  if (capabilityStatus === 'incomplete') {
    return { constraints: { image: { outputCounts: [1] } } };
  }
  if (/^gpt-image-1(?:\.5)?$/iu.test(modelId)) {
    return {
      constraints: {
        image: {
          aspectRatios: ['1:1', '3:2', '2:3'],
          resolutions: ['1K'],
          sizes: ['1024x1024', '1536x1024', '1024x1536'],
          outputCounts: [1],
        },
      },
    };
  }
  if (/^gpt-image-2-(?:2k|4k)$/iu.test(modelId)) {
    const fixedResolution = /-4k$/iu.test(modelId) ? '4K' : '2K';
    return {
      constraints: { image: {
        aspectRatios: ['1:1', '2:3', '3:2', '4:3', '3:4', '16:9', '9:16'],
        resolutions: [fixedResolution],
        outputCounts: [1],
      } },
    };
  }
  if (/^gpt-image-2$/iu.test(modelId)) {
    return {
      constraints: { image: {
        aspectRatios: ['1:1', '2:3', '3:2', '4:3', '3:4', '16:9', '9:16'],
        resolutions: ['1K', '2K', '4K'],
        outputCounts: [1],
      } },
    };
  }
  if (AUDITED_4DAI_GPT_IMAGE_25_MODELS.has(modelId)) {
    return {
      constraints: { image: {
        aspectRatios: ['1:1'],
        resolutions: ['4K'],
        outputCounts: [1],
      } },
    };
  }
  if (AUDITED_4DAI_GEMINI_IMAGE_MODELS.has(modelId)) {
    return {
      constraints: { image: {
        aspectRatios: ['1:1', '2:3', '3:2', '4:3', '3:4', '16:9', '9:16'],
        resolutions: ['1K', '2K', '4K'],
        outputCounts: [1],
      } },
    };
  }
  return {
    constraints: { image: {
      aspectRatios: ['1:1'],
      resolutions: ['1K'],
      sizes: ['1024x1024'],
      outputCounts: [1],
    } },
  };
}

function routeSlug(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 120) || 'model';
}

const MAX_MODEL_ROUTE_LENGTH = 160;

function dynamicModelRoute(provider: NewApiProviderId, modelId: string): string {
  const prefix = `${provider}-model@`;
  const encoded = Buffer.from(modelId, 'utf8').toString('base64url');
  const route = `${prefix}${encoded}`;
  if (route.length <= MAX_MODEL_ROUTE_LENGTH) return route;
  const digest = createHash('sha256').update(modelId, 'utf8').digest('base64url');
  const digestSuffix = `@${digest}`;
  return `${prefix}${encoded.slice(0, MAX_MODEL_ROUTE_LENGTH - prefix.length - digestSuffix.length)}${digestSuffix}`;
}

const builtInRoutesByModel = new Map(
  Object.values(NEW_API_PROVIDER_SEEDS).flatMap((profiles) => profiles.map((profile) => [
    `${profile.provider}:${profile.modelId}`,
    profile.modelRoute,
  ] as const)),
);

function assignStableModelRoutes(
  provider: NewApiProviderId,
  profiles: readonly Omit<NewApiModelProfile, 'modelRoute'>[],
  persistedProfiles: readonly Pick<NewApiModelProfile, 'provider' | 'modelId' | 'modelRoute'>[],
): NewApiModelProfile[] {
  const routesByModel = new Map<string, string>();
  const usedRoutes = new Set<string>();
  const candidatesByModel = new Set(profiles.map((profile) => profile.modelId));
  const claim = (modelId: string, modelRoute: string): void => {
    if (modelRoute.length > MAX_MODEL_ROUTE_LENGTH || routesByModel.has(modelId) || usedRoutes.has(modelRoute)) return;
    routesByModel.set(modelId, modelRoute);
    usedRoutes.add(modelRoute);
  };

  for (const profile of profiles) {
    const builtInRoute = builtInRoutesByModel.get(`${provider}:${profile.modelId}`);
    if (builtInRoute !== undefined) claim(profile.modelId, builtInRoute);
  }
  // Preserve a previously stored opaque route for its exact upstream model.
  // When an old catalog stored a colliding route twice, the first profile is
  // also the model the prior runtime would execute through Array.find.
  for (const profile of persistedProfiles) {
    if (profile.provider !== provider || !candidatesByModel.has(profile.modelId)) continue;
    claim(profile.modelId, profile.modelRoute);
  }
  for (const profile of profiles) {
    if (profile.modelId === routeSlug(profile.modelId)) {
      claim(profile.modelId, `${provider}-${profile.modelId}`);
    }
  }
  for (const profile of [...profiles].sort((left, right) => left.modelId.localeCompare(right.modelId, 'en'))) {
    if (routesByModel.has(profile.modelId)) continue;
    const routeBase = dynamicModelRoute(provider, profile.modelId);
    let route = routeBase;
    let suffix = 2;
    while (usedRoutes.has(route)) {
      const marker = `@${suffix++}`;
      route = `${routeBase.slice(0, MAX_MODEL_ROUTE_LENGTH - marker.length)}${marker}`;
    }
    claim(profile.modelId, route);
  }

  return profiles.map((profile) => ({ ...profile, modelRoute: routesByModel.get(profile.modelId)! }));
}
