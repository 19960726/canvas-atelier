import { z } from 'zod';

import { containsProtectedPublicText } from './protected-public-text';

const idSchema = z.string().min(1);
export const modelJobProviderSchema = z.enum(['comfly', 'relayme']);
export type ModelJobProvider = z.infer<typeof modelJobProviderSchema>;
export const modelJobKindSchema = z.enum(['image', 'video']);
export type ModelJobKind = z.infer<typeof modelJobKindSchema>;
export const imageAspectRatioSchema = z.enum(['1:1', '2:3', '3:2', '4:3', '3:4', '16:9', '9:16']);
export const imageResolutionTierSchema = z.enum(['1K', '2K', '4K']);
export const videoResolutionTierSchema = z.enum(['360p', '480p', '512p', '540p', '720p', '768p', '1080p', '2K', '4K']);
export type ImageAspectRatio = z.infer<typeof imageAspectRatioSchema>;
export type ImageResolutionTier = z.infer<typeof imageResolutionTierSchema>;
export type VideoResolutionTier = z.infer<typeof videoResolutionTierSchema>;

export function normalizeImageResolutionTier(value: unknown): ImageResolutionTier {
  if (value === '2K' || value === '1536x1024' || value === '1024x1536') return '2K';
  if (value === '4K') return '4K';
  return '1K';
}

export function mapImageResolutionTier(
  tier: ImageResolutionTier,
  aspectRatio: ImageAspectRatio,
): { width: number; height: number } {
  const dimensions: Record<ImageResolutionTier, Record<ImageAspectRatio, readonly [number, number]>> = {
    '1K': {
      '1:1': [1024, 1024],
      '2:3': [683, 1024],
      '3:2': [1024, 683],
      '4:3': [1024, 768],
      '3:4': [768, 1024],
      '16:9': [1024, 576],
      '9:16': [576, 1024],
    },
    '2K': {
      '1:1': [2048, 2048],
      '2:3': [1365, 2048],
      '3:2': [2048, 1365],
      '4:3': [2048, 1536],
      '3:4': [1536, 2048],
      '16:9': [2048, 1152],
      '9:16': [1152, 2048],
    },
    '4K': {
      '1:1': [4096, 4096],
      '2:3': [2731, 4096],
      '3:2': [4096, 2731],
      '4:3': [4096, 3072],
      '3:4': [3072, 4096],
      '16:9': [3840, 2160],
      '9:16': [2160, 3840],
    },
  };
  const [width, height] = dimensions[tier][aspectRatio];
  return { width, height };
}

const hydratedImageResolutionTierSchema = z.preprocess(
  (value) => value === undefined ? undefined : normalizeImageResolutionTier(value),
  imageResolutionTierSchema.optional(),
);
const imageOutputCountSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);

export const modelJobStatusSchema = z.enum(['queued', 'submitting', 'running', 'completed', 'failed', 'cancelled']);
export const modelJobTerminalStatusSchema = z.enum(['completed', 'failed', 'cancelled']);

export const modelJobSchema = z.object({
  id: idSchema,
  kind: modelJobKindSchema.default('image'),
  modelId: idSchema,
  status: modelJobStatusSchema,
  promptNodeId: idSchema,
  providerTaskId: idSchema.optional(),
  confirmedAt: z.string().datetime().optional(),
  retryCount: z.number().int().nonnegative().default(0),
  provider: modelJobProviderSchema.optional(),
  modelRoute: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  projectSessionId: z.string().min(1).optional(),
  referenceAssetIds: z.array(idSchema).default([]),
  referenceSnapshotRevision: z.number().int().nonnegative().optional(),
  referenceSnapshotFingerprint: z.string().regex(/^[a-f0-9]{16}$/u).optional(),
  aspectRatio: imageAspectRatioSchema.optional(),
  resolution: hydratedImageResolutionTierSchema,
  videoResolution: videoResolutionTierSchema.optional(),
  durationSeconds: z.number().int().min(1).max(60).optional(),
  audioEnabled: z.boolean().optional(),
  outputCount: imageOutputCountSchema.optional(),
  prompt: z.string().optional(),
  progress: z.number().min(0).max(1).optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  queueIndex: z.number().int().nonnegative().optional(),
  error: z.string().max(160).optional(),
  resultNodeId: idSchema.optional(),
  resultAssetId: idSchema.optional(),
  resultAssetIds: z.array(idSchema).min(1).max(4).optional(),
  providerAckPending: z.boolean().optional(),
  terminalStatus: modelJobTerminalStatusSchema.optional(),
}).strict();

export type ModelJobStatus = z.infer<typeof modelJobStatusSchema>;
export type ModelJob = z.infer<typeof modelJobSchema>;

export interface ConfirmedModelJobInput {
  id: string;
  kind?: ModelJobKind;
  promptNodeId: string;
  confirmedAt?: string;
  provider: ModelJobProvider;
  modelRoute: string;
  displayName: string;
  modelId: string;
  conversationId: string;
  projectSessionId?: string;
  referenceAssetIds: string[];
  referenceSnapshotRevision?: number;
  referenceSnapshotFingerprint?: string;
  aspectRatio?: ImageAspectRatio;
  resolution?: ImageResolutionTier;
  videoResolution?: VideoResolutionTier;
  durationSeconds?: number;
  audioEnabled?: boolean;
  outputCount?: 1 | 2 | 3 | 4;
  prompt?: string;
  createdAt?: string;
  queueIndex?: number;
}

const legalTransitions: Record<ModelJobStatus, readonly ModelJobStatus[]> = {
  queued: ['submitting', 'cancelled'],
  submitting: ['running', 'failed', 'cancelled'],
  running: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: ['queued'],
  cancelled: ['queued'],
};

export function createConfirmedModelJob(input: ConfirmedModelJobInput): ModelJob {
  if (!input.confirmedAt) {
    throw new Error('confirmedAt is required before enqueueing a model job');
  }
  assertPublicModelJobPayload(input);
  return modelJobSchema.parse({
    ...input,
    status: 'queued',
    retryCount: 0,
    createdAt: input.createdAt ?? input.confirmedAt,
    updatedAt: input.createdAt ?? input.confirmedAt,
  });
}

export function getLegalModelJobTransitions(status: ModelJobStatus): ModelJobStatus[] {
  return [...legalTransitions[status]];
}

export function transitionModelJob(
  job: ModelJob,
  nextStatus: ModelJobStatus,
  patch: Partial<ModelJob> = {},
): ModelJob {
  if (!legalTransitions[job.status].includes(nextStatus)) {
    throw new Error(`illegal model job transition: ${job.status} -> ${nextStatus}`);
  }
  const retryCount = job.status === 'failed' && nextStatus === 'queued'
    ? (job.retryCount ?? 0) + 1
    : (job.retryCount ?? 0);
  const error = nextStatus === 'queued' ? undefined : patch.error === undefined ? job.error : sanitizeModelJobError(patch.error);
  return modelJobSchema.parse({
    ...job,
    ...patch,
    status: nextStatus,
    retryCount,
    error,
    ...(nextStatus === 'queued' ? { providerAckPending: undefined, terminalStatus: undefined } : {}),
  });
}

export function sanitizeModelJobError(error: unknown): string {
  const structuredMessage = error && typeof error === 'object' && 'message' in error
    ? Reflect.get(error, 'message')
    : undefined;
  const structuredCode = error && typeof error === 'object' && 'code' in error
    ? Reflect.get(error, 'code')
    : undefined;
  const raw = error instanceof Error
    ? error.message
    : typeof structuredMessage === 'string' && structuredMessage.trim()
      ? structuredMessage
      : typeof structuredCode === 'string' && structuredCode.trim()
        ? structuredCode
        : String(error ?? 'Unknown model job error');
  const sanitized = raw
    .replace(/authorization\s*:\s*\S+(?:\s+\S+)?/gi, '[redacted]')
    .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, '[redacted]')
    .replace(/\b(?:api[_ -]?key|token|secret|password)\s*[:=]\s*\S{4,}/gi, '[redacted]')
    .replace(/data:image\/[^;]+;base64,[a-z0-9+/=]+/gi, '[redacted]')
    .replace(/[a-zA-Z]:[\\/][^\s"'`]+/g, '[redacted]')
    .replace(/\\\\[^\\\s]+\\[^\s"'`]+/g, '[redacted]')
    .replace(/file:\/\/[^\s"'`]+/gi, '[redacted]')
    .replace(/(?:^|\s)\/(?:Users|home|var|opt|tmp|private)\/[^\s"'`]+/g, ' [redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return (sanitized || 'Model job failed').slice(0, 160);
}

export function assertPublicModelJobPayload(value: unknown): void {
  if (containsProtectedRendererPayload(value)) {
    throw new Error('model job contains protected payload');
  }
}

export function containsProtectedRendererPayload(value: unknown): boolean {
  if (typeof value === 'string') {
    return containsProtectedPublicText(value);
  }
  if (Array.isArray(value)) return value.some(containsProtectedRendererPayload);
  if (value && typeof value === 'object') return Object.values(value).some(containsProtectedRendererPayload);
  return false;
}
