import { z } from 'zod';

export const CLOSE_FLUSH_TIMEOUT_MS = 2_000;

export interface CloseFlushRequest {
  readonly requestId: string;
}

export interface CloseFlushAck {
  readonly ok: boolean;
  readonly cancelled?: boolean;
  readonly requestId: string;
}

export type CloseFlushCompletionReason = 'ack' | 'cancel' | 'nack' | 'timeout' | 'unavailable';

const requestIdSchema = z.string()
  .min(8)
  .max(96)
  .regex(/^[A-Za-z0-9_-]+$/u);

const closeFlushRequestSchema = z.object({
  requestId: requestIdSchema,
}).strict();

const closeFlushAckSchema = z.object({
  cancelled: z.boolean().optional(),
  ok: z.boolean(),
  requestId: requestIdSchema,
}).strict().superRefine((value, context) => {
  if (value.cancelled === true && value.ok) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Cancelled close cannot be acknowledged as successful' });
  }
});

export function parseCloseFlushRequest(payload: unknown): CloseFlushRequest | null {
  const parsed = closeFlushRequestSchema.safeParse(payload);
  return parsed.success ? { requestId: parsed.data.requestId } : null;
}

export function parseCloseFlushAck(payload: unknown): CloseFlushAck | null {
  const parsed = closeFlushAckSchema.safeParse(payload);
  if (!parsed.success) return null;
  return parsed.data.cancelled === true
    ? { cancelled: true, ok: parsed.data.ok, requestId: parsed.data.requestId }
    : { ok: parsed.data.ok, requestId: parsed.data.requestId };
}
