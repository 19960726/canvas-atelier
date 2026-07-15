import { z } from 'zod';
import {
  type AgentKnowledgeLease,
  agentKnowledgeLeaseSchema,
  orderedReferenceSchema,
  orderedReferencesMatch,
} from './knowledge-context';
import { MAX_GENERATION_REFERENCES } from './project-schema';

export const reversePromptPersonaIdSchema = z.enum([
  'commercial_visual_director',
  'ecommerce_key_visual',
  'brand_poster',
  'composition_director',
  'material_lighting_director',
]);

export const reversePromptPersonaSchema = z.object({
  id: reversePromptPersonaIdSchema,
  label: z.string().min(1),
}).strict();

export const REVERSE_PROMPT_PERSONAS = [
  { id: 'commercial_visual_director', label: '高级商业视觉设计师 + 产品摄影指导 + 提示词工程师' },
  { id: 'ecommerce_key_visual', label: '电商主视觉设计总监' },
  { id: 'brand_poster', label: '品牌海报创意总监' },
  { id: 'composition_director', label: '商业构图与镜头指导' },
  { id: 'material_lighting_director', label: '材质与灯光视觉指导' },
] as const;

export const DEFAULT_REVERSE_PROMPT_PERSONA = REVERSE_PROMPT_PERSONAS[0];

export const approvedMemorySnapshotSchema = z.object({
  version: z.string().min(1),
  approvedAt: z.string().datetime(),
  approvedMemoryIds: z.array(z.string().min(1)),
}).strict();

const reversePromptReferenceSchema = z.array(orderedReferenceSchema)
  .max(MAX_GENERATION_REFERENCES, '参考图最多 20 张')
  .superRefine((references, context) => {
    const assetIds = new Set<string>();
    for (const [index, reference] of references.entries()) {
      if (assetIds.has(reference.assetId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'assetId'],
          message: '参考图不能重复',
        });
      }
      assetIds.add(reference.assetId);
    }
  });

const reversePromptReferenceAssetIdsSchema = z.array(z.string().min(1))
  .max(MAX_GENERATION_REFERENCES, '参考图最多 20 张')
  .superRefine((assetIds, context) => {
    if (new Set(assetIds).size !== assetIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: '参考图不能重复' });
    }
  });

export const reversePromptRunSchema = z.object({
  sessionId: z.string().min(1),
  nonce: z.string().min(1),
  createdAt: z.string().datetime(),
  projectId: z.string().min(1),
  skill: z.object({ id: z.string().min(1), version: z.string().min(1) }).strict(),
  persona: reversePromptPersonaSchema,
  knowledgeLease: agentKnowledgeLeaseSchema,
  approvedMemorySnapshot: approvedMemorySnapshotSchema,
  projectMemoryIds: z.array(z.string().min(1)).default([]),
  references: reversePromptReferenceSchema,
  referenceAssetIds: reversePromptReferenceAssetIdsSchema,
}).strict().superRefine((run, context) => {
  if (run.sessionId !== run.knowledgeLease.runId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sessionId'],
      message: 'Reverse-prompt sessionId must match knowledge lease runId',
    });
  }
  if (!orderedReferencesMatch(run.references, run.knowledgeLease.references)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['knowledgeLease', 'references'],
      message: 'Knowledge lease references must match reverse-prompt references',
    });
  }

  const referenceAssetIds = run.references.map((reference) => reference.assetId);
  if (
    referenceAssetIds.length !== run.referenceAssetIds.length
    || referenceAssetIds.some((assetId, index) => assetId !== run.referenceAssetIds[index])
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['referenceAssetIds'],
      message: 'Reference asset ids must match ordered references',
    });
  }
});

export const reversePromptResultSchema = z.object({
  sessionId: z.string().min(1),
  nonce: z.string().min(1),
  knowledgeSnapshotVersion: z.string().min(1),
  analysis: z.string().min(1),
  keywords: z.array(z.string().min(1)).min(1),
  positivePrompt: z.string().min(1),
  negativeConstraints: z.array(z.string().min(1)).min(1),
  executionChecklist: z.array(z.string().min(1)).min(1),
}).strict();

export type ReversePromptPersona = z.infer<typeof reversePromptPersonaSchema>;
export type ApprovedMemorySnapshot = z.infer<typeof approvedMemorySnapshotSchema>;
export type ReversePromptRun = z.infer<typeof reversePromptRunSchema>;
export type ReversePromptResult = z.infer<typeof reversePromptResultSchema>;

interface RunDeps {
  createNonce?: () => string;
  now?: () => string;
}

interface CreateReversePromptRunInput {
  projectId: string;
  skill: { id: string; version: string };
  persona?: ReversePromptPersona;
  knowledgeLease: AgentKnowledgeLease;
  approvedMemorySnapshot: ApprovedMemorySnapshot;
  projectMemoryIds?: string[];
  references: ReversePromptRun['references'];
}

export function createReversePromptRun(
  input: CreateReversePromptRunInput,
  deps: RunDeps = {},
): ReversePromptRun {
  const normalizedReferences = input.references.map((reference, index) => ({ ...reference, position: index }));
  return reversePromptRunSchema.parse({
    sessionId: input.knowledgeLease?.runId ?? '',
    nonce: (deps.createNonce ?? createUniqueValue)(),
    createdAt: (deps.now ?? (() => new Date().toISOString()))(),
    projectId: input.projectId,
    skill: input.skill,
    persona: input.persona ?? DEFAULT_REVERSE_PROMPT_PERSONA,
    knowledgeLease: input.knowledgeLease,
    approvedMemorySnapshot: input.approvedMemorySnapshot,
    projectMemoryIds: input.projectMemoryIds ?? [],
    references: normalizedReferences,
    referenceAssetIds: normalizedReferences.map((reference) => reference.assetId),
  });
}

export function parseReversePromptResult(input: unknown, run: ReversePromptRun): ReversePromptResult {
  const result = reversePromptResultSchema.parse(input);
  if (
    result.sessionId !== run.sessionId
    || result.nonce !== run.nonce
    || result.knowledgeSnapshotVersion !== run.knowledgeLease.versionKey
  ) {
    throw new Error('反推结果运行身份不匹配');
  }
  return result;
}

function createUniqueValue(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
