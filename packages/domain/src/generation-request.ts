import { z } from 'zod';
import { MAX_GENERATION_REFERENCES, referenceRoleSchema } from './project-schema';

export const generationReferenceSchema = z.object({
  assetId: z.string().min(1),
  role: referenceRoleSchema,
}).strict();

export const generationRequestSchema = z.object({
  projectId: z.string().min(1),
  prompt: z.string().min(1),
  references: z.array(generationReferenceSchema).max(MAX_GENERATION_REFERENCES, '参考图最多 20 张'),
}).strict().superRefine((request, context) => {
  const assetIds = new Set<string>();
  for (const reference of request.references) {
    if (assetIds.has(reference.assetId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['references'],
        message: '参考图不能重复',
      });
      return;
    }
    assetIds.add(reference.assetId);
  }
});

export type GenerationReference = z.infer<typeof generationReferenceSchema>;
export type GenerationRequest = z.infer<typeof generationRequestSchema>;

export function parseGenerationRequest(input: unknown): GenerationRequest {
  return generationRequestSchema.parse(input);
}

export { MAX_GENERATION_REFERENCES };