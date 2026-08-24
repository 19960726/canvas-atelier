import { z } from 'zod';

import { createProviderBridgeError, type ProviderBridgeProfile } from './provider-contracts.js';

function safeText(max: number) {
  return z.string().trim().min(1).max(max).superRefine((value, context) => {
    if (containsProtectedText(value)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Protected content is not allowed' });
  });
}

export const storyboardShotSchema = z.object({
  id: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/u),
  order: z.number().int().positive().max(60),
  title: safeText(160),
  composition: safeText(2_000),
  durationSeconds: z.number().int().min(1).max(60),
  referenceAssetIds: z.array(z.string().trim().min(1).max(160)).max(16),
}).strict();

export const storyboardResultSchema = z.object({
  modelRoute: z.string().trim().min(1).max(160),
  shots: z.array(storyboardShotSchema).min(1).max(60),
}).strict().superRefine((value, context) => {
  const orders = new Set<number>();
  const ids = new Set<string>();
  for (const shot of value.shots) {
    if (orders.has(shot.order) || ids.has(shot.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Storyboard shots must use unique ids and order values' });
      return;
    }
    orders.add(shot.order);
    ids.add(shot.id);
  }
});

export type StoryboardShot = z.infer<typeof storyboardShotSchema>;
export type StoryboardResult = z.infer<typeof storyboardResultSchema>;

export interface StoryboardGenerationRequest {
  readonly provider: string;
  readonly modelRoute: string;
  readonly script: string;
  readonly shotCount: number;
  readonly referenceAssetIds: readonly string[];
}

export interface StoryboardService {
  generate(request: StoryboardGenerationRequest): Promise<StoryboardResult>;
}

export function createStoryboardService(options: {
  readonly listProfiles: () => Promise<readonly ProviderBridgeProfile[]>;
  readonly runStructuredChat: (input: { readonly modelRoute: string; readonly script: string; readonly shotCount: number; readonly referenceAssetIds: readonly string[] }) => Promise<string>;
}): StoryboardService {
  return {
    async generate(request) {
      if (!isSafeRequest(request)) throw createProviderBridgeError('INVALID_REQUEST', 'Storyboard request is invalid');
      const profiles = await options.listProfiles();
      const profile = profiles.find((item) => item.provider === request.provider && item.modelRoute === request.modelRoute);
      if (profile === undefined || (!profile.capabilities.includes('chat') && !profile.capabilities.includes('vision'))) {
        throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Requested storyboard model profile is unavailable');
      }
      let raw: unknown;
      try {
        raw = JSON.parse(await options.runStructuredChat({
          modelRoute: request.modelRoute,
          script: request.script.trim(),
          shotCount: request.shotCount,
          referenceAssetIds: [...new Set(request.referenceAssetIds)],
        }));
      } catch {
        throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid storyboard response');
      }
      const parsed = storyboardResultSchema.safeParse({
        ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}),
        modelRoute: request.modelRoute,
      });
      if (!parsed.success || parsed.data.shots.length > request.shotCount || parsed.data.shots.some((shot) => shot.referenceAssetIds.some((id) => !request.referenceAssetIds.includes(id)))) {
        throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid storyboard response');
      }
      return parsed.data;
    },
  };
}

function isSafeRequest(value: StoryboardGenerationRequest): boolean {
  return value.provider === 'comfly'
    && value.modelRoute.trim().length > 0
    && value.modelRoute.length <= 160
    && value.script.trim().length > 0
    && value.script.length <= 12_000
    && !containsProtectedText(value.script)
    && Number.isInteger(value.shotCount)
    && value.shotCount >= 1
    && value.shotCount <= 60
    && value.referenceAssetIds.length <= 16
    && value.referenceAssetIds.every((id) => typeof id === 'string' && id.trim().length > 0 && id.length <= 160 && !containsProtectedText(id));
}

function containsProtectedText(value: string): boolean {
  return /\b(?:https?|file):\/\//iu.test(value)
    || /[A-Za-z]:\\/u.test(value)
    || /\\\\[^\\\s]+\\/u.test(value)
    || /(?:^|\s)\/(?:Users|home|var|etc|opt|tmp|private)\//u.test(value)
    || /data:[^,\s;]+(?:;[^,\s;]+)*;base64,/iu.test(value)
    || /\b(?:api[_ -]?key|token|secret|password)\s*[:=]/iu.test(value)
    || /\b(?:authorization|bearer)\b/iu.test(value);
}
