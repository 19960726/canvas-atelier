import { z } from 'zod';
import {
  agentKnowledgeLeaseSchema,
  imageCitationSchema,
  imageCitationsMatch,
  orderedReferenceSchema,
  orderedReferencesMatch,
} from './knowledge-context';
import { MAX_GENERATION_REFERENCES } from './project-schema';

export const generationReferenceSchema = orderedReferenceSchema;

export const generationRequestSchema = z.object({
  projectId: z.string().min(1),
  prompt: z.string().min(1),
  references: z.array(generationReferenceSchema).max(MAX_GENERATION_REFERENCES, '参考图最多 20 张'),
  citations: z.array(imageCitationSchema).default([]),
  knowledgeLease: agentKnowledgeLeaseSchema,
}).strict().superRefine((request, context) => {
  const assetIds = new Set<string>();
  for (const [index, reference] of request.references.entries()) {
    if (assetIds.has(reference.assetId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['references', index, 'assetId'],
        message: '参考图不能重复',
      });
      return;
    }
    assetIds.add(reference.assetId);
  }

  if (!orderedReferencesMatch(request.references, request.knowledgeLease.references)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['knowledgeLease', 'references'],
      message: 'Knowledge lease references must match request references',
    });
  }
  if (!imageCitationsMatch(request.citations, request.knowledgeLease.citations)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['knowledgeLease', 'citations'],
      message: 'Knowledge lease citations must match request citations',
    });
  }
  for (const [index, citation] of request.citations.entries()) {
    if (!assetIds.has(citation.assetId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['citations', index, 'assetId'],
        message: 'Citations must reference a known asset',
      });
    }
  }
});

export type GenerationReference = z.infer<typeof generationReferenceSchema>;
export type GenerationRequest = z.infer<typeof generationRequestSchema>;

export function parseGenerationRequest(input: unknown): GenerationRequest {
  return generationRequestSchema.parse(input);
}

export { MAX_GENERATION_REFERENCES };
