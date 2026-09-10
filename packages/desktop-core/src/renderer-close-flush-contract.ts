import { z } from 'zod';

// A close flush can contain one bounded commit and one bounded stable point.
// Give both 15 second renderer persistence boundaries time to settle while
// still retaining a native watchdog for a renderer that stops responding.
export const CLOSE_FLUSH_TIMEOUT_MS = 32_000;

export interface CloseFlushRequest {
  readonly requestId: string;
}

export type CloseFlushAck = {
  readonly phase: 'decision_requested';
  readonly requestId: string;
} | {
  readonly phase: 'save_started';
  readonly requestId: string;
} | {
  readonly outcome: 'saved' | 'discarded' | 'cancelled' | 'failed';
  readonly phase: 'completed';
  readonly requestId: string;
  readonly errorCode?: string;
};

export type CloseFlushCompletionReason = 'saved' | 'discarded' | 'cancel' | 'failed' | 'timeout' | 'unavailable';

export interface CloseFlushAbort {
  readonly requestId: string;
  readonly reason: Exclude<CloseFlushCompletionReason, 'saved' | 'discarded'>;
}

const requestIdSchema = z.string()
  .min(8)
  .max(96)
  .regex(/^[A-Za-z0-9_-]+$/u);

const closeFlushRequestSchema = z.object({
  requestId: requestIdSchema,
}).strict();

const closeFlushAckSchema = z.discriminatedUnion('phase', [
  z.object({
    phase: z.literal('decision_requested'),
    requestId: requestIdSchema,
    errorCode: z.string().min(1).max(120).optional(),
  }).strict(),
  z.object({
    phase: z.literal('save_started'),
    requestId: requestIdSchema,
  }).strict(),
  z.object({
    outcome: z.enum(['saved', 'discarded', 'cancelled', 'failed']),
    phase: z.literal('completed'),
    requestId: requestIdSchema,
    errorCode: z.string().min(1).max(120).optional(),
  }).strict(),
]);

const closeFlushAbortSchema = z.object({
  requestId: requestIdSchema,
  reason: z.enum(['cancel', 'failed', 'timeout', 'unavailable']),
}).strict();

export function parseCloseFlushRequest(payload: unknown): CloseFlushRequest | null {
  const parsed = closeFlushRequestSchema.safeParse(payload);
  return parsed.success ? { requestId: parsed.data.requestId } : null;
}

export function parseCloseFlushAck(payload: unknown): CloseFlushAck | null {
  const parsed = closeFlushAckSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export function parseCloseFlushAbort(payload: unknown): CloseFlushAbort | null {
  const parsed = closeFlushAbortSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}
