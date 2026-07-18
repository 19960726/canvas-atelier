import { z } from 'zod';

export type CloseChoiceDecision = 'save' | 'discard' | 'cancel';

export interface CloseChoiceRequest {
  readonly dirty: boolean;
  readonly projectName: string;
  readonly untitled: boolean;
}

const closeChoiceRequestSchema = z.object({
  dirty: z.boolean(),
  projectName: z.string().min(1).max(160).refine((value) => (
    !/authorization\s*:/iu.test(value)
    && !/[A-Za-z]:\\/u.test(value)
    && !/\\\\[^\\\s]+\\/u.test(value)
    && !/[\u0000-\u001f\u007f]/u.test(value)
  )),
  untitled: z.boolean(),
}).strict();

const closeChoiceDecisionSchema = z.enum(['save', 'discard', 'cancel']);

export function parseCloseChoiceRequest(payload: unknown): CloseChoiceRequest | null {
  const parsed = closeChoiceRequestSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export function parseCloseChoiceDecision(payload: unknown): CloseChoiceDecision | null {
  const parsed = closeChoiceDecisionSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}
