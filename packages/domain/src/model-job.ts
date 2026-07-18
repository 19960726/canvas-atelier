import { z } from 'zod';

import { containsProtectedPublicText } from './protected-public-text';

const idSchema = z.string().min(1);

export const modelJobStatusSchema = z.enum(['queued', 'submitting', 'running', 'completed', 'failed', 'cancelled']);
export const modelJobTerminalStatusSchema = z.enum(['completed', 'failed', 'cancelled']);

export const modelJobSchema = z.object({
  id: idSchema,
  modelId: idSchema,
  status: modelJobStatusSchema,
  promptNodeId: idSchema,
  providerTaskId: idSchema.optional(),
  confirmedAt: z.string().datetime().optional(),
  retryCount: z.number().int().nonnegative().default(0),
  provider: z.string().min(1).optional(),
  modelRoute: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  referenceAssetIds: z.array(idSchema).default([]),
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
  providerAckPending: z.boolean().optional(),
  terminalStatus: modelJobTerminalStatusSchema.optional(),
}).strict();

export type ModelJobStatus = z.infer<typeof modelJobStatusSchema>;
export type ModelJob = z.infer<typeof modelJobSchema>;

export interface ConfirmedModelJobInput {
  id: string;
  promptNodeId: string;
  confirmedAt?: string;
  provider: string;
  modelRoute: string;
  displayName: string;
  modelId: string;
  conversationId: string;
  referenceAssetIds: string[];
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
    ? job.retryCount + 1
    : job.retryCount;
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
  const raw = error instanceof Error ? error.message : String(error ?? 'Unknown model job error');
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
