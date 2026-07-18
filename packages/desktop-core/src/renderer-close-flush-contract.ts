import { z } from 'zod';

export const CLOSE_FLUSH_TIMEOUT_MS = 2_000;

export interface CloseFlushRequest {
  readonly requestId: string;
}

export type CloseFlushAck = {
  readonly phase: 'save_started';
  readonly requestId: string;
} | {
  readonly outcome: 'saved' | 'discarded' | 'cancelled' | 'failed';
  readonly phase: 'completed';
  readonly requestId: string;
};

export type CloseFlushCompletionReason = 'saved' | 'discarded' | 'cancel' | 'failed' | 'timeout' | 'unavailable';

const requestIdSchema = z.string()
  .min(8)
  .max(96)
  .regex(/^[A-Za-z0-9_-]+$/u);

const closeFlushRequestSchema = z.object({
  requestId: requestIdSchema,
}).strict();

const closeFlushAckSchema = z.discriminatedUnion('phase', [
  z.object({
    phase: z.literal('save_started'),
    requestId: requestIdSchema,
  }).strict(),
  z.object({
    outcome: z.enum(['saved', 'discarded', 'cancelled', 'failed']),
    phase: z.literal('completed'),
    requestId: requestIdSchema,
  }).strict(),
]);

export function parseCloseFlushRequest(payload: unknown): CloseFlushRequest | null {
  const parsed = closeFlushRequestSchema.safeParse(payload);
  return parsed.success ? { requestId: parsed.data.requestId } : null;
}

export function parseCloseFlushAck(payload: unknown): CloseFlushAck | null {
  const parsed = closeFlushAckSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}
