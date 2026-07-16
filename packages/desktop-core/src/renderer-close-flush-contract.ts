import { z } from 'zod';

export const CLOSE_FLUSH_TIMEOUT_MS = 2_000;

export interface CloseFlushRequest {
  readonly requestId: string;
}

export interface CloseFlushAck {
  readonly ok: boolean;
  readonly requestId: string;
}

export type CloseFlushCompletionReason = 'ack' | 'nack' | 'timeout' | 'unavailable';

const requestIdSchema = z.string()
  .min(8)
  .max(96)
  .regex(/^[A-Za-z0-9_-]+$/u);

const closeFlushRequestSchema = z.object({
  requestId: requestIdSchema,
}).strict();

const closeFlushAckSchema = z.object({
  ok: z.boolean(),
  requestId: requestIdSchema,
}).strict();

export function parseCloseFlushRequest(payload: unknown): CloseFlushRequest | null {
  const parsed = closeFlushRequestSchema.safeParse(payload);
  return parsed.success ? { requestId: parsed.data.requestId } : null;
}

export function parseCloseFlushAck(payload: unknown): CloseFlushAck | null {
  const parsed = closeFlushAckSchema.safeParse(payload);
  return parsed.success ? { ok: parsed.data.ok, requestId: parsed.data.requestId } : null;
}
