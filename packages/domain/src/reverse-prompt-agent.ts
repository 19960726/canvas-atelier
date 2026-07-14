import { z } from 'zod';
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

export const reversePromptRunSchema = z.object({
  sessionId: z.string().min(1),
  nonce: z.string().min(1),
  createdAt: z.string().datetime(),
  projectId: z.string().min(1),
  skill: z.object({ id: z.string().min(1), version: z.string().min(1) }).strict(),
  persona: reversePromptPersonaSchema,
  approvedMemorySnapshot: approvedMemorySnapshotSchema,
  projectMemoryIds: z.array(z.string().min(1)).default([]),
  referenceAssetIds: z.array(z.string().min(1)).max(MAX_GENERATION_REFERENCES, '参考图最多 20 张'),
}).strict().superRefine((run, context) => {
  if (new Set(run.referenceAssetIds).size !== run.referenceAssetIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['referenceAssetIds'], message: '参考图不能重复' });
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
  createId?: () => string;
  createNonce?: () => string;
  now?: () => string;
}

export function createReversePromptRun(
  input: {
    projectId: string;
    skill: { id: string; version: string };
    persona?: ReversePromptPersona;
    approvedMemorySnapshot: ApprovedMemorySnapshot;
    projectMemoryIds?: string[];
    referenceAssetIds: string[];
  },
  deps: RunDeps = {},
): ReversePromptRun {
  return reversePromptRunSchema.parse({
    sessionId: (deps.createId ?? createUniqueValue)(),
    nonce: (deps.createNonce ?? createUniqueValue)(),
    createdAt: (deps.now ?? (() => new Date().toISOString()))(),
    projectId: input.projectId,
    skill: input.skill,
    persona: input.persona ?? DEFAULT_REVERSE_PROMPT_PERSONA,
    approvedMemorySnapshot: input.approvedMemorySnapshot,
    projectMemoryIds: input.projectMemoryIds ?? [],
    referenceAssetIds: input.referenceAssetIds,
  });
}

export function parseReversePromptResult(input: unknown, run: ReversePromptRun): ReversePromptResult {
  const result = reversePromptResultSchema.parse(input);
  if (
    result.sessionId !== run.sessionId
    || result.nonce !== run.nonce
    || result.knowledgeSnapshotVersion !== run.approvedMemorySnapshot.version
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