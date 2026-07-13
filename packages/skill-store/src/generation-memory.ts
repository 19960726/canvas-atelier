import { z } from 'zod';

const referenceRoleSchema = z.enum(['product_identity', 'scene_composition', 'prop_reference', 'material_lighting', 'placement_preview']);
const stringList = z.array(z.string().min(1));

export const generationMemoryEventSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  knowledgeBaseId: z.string().min(1),
  projectId: z.string().min(1),
  sourceDeviceId: z.string().min(1),
  createdAt: z.string().datetime(),
  skill: z.object({ id: z.string().min(1), version: z.string().min(1) }).strict(),
  prompt: z.object({
    userRequest: z.string().min(1),
    reversePrompt: z.string().min(1),
    negativePrompt: z.string().optional(),
  }).strict(),
  references: z.array(referenceRoleSchema),
  model: z.object({
    provider: z.string().min(1),
    modelId: z.string().min(1),
    parameters: z.object({
      aspectRatio: z.string().optional(),
      seed: z.number().int().optional(),
      steps: z.number().int().positive().optional(),
      guidance: z.number().nonnegative().optional(),
      quality: z.string().optional(),
    }).strict(),
  }).strict(),
  outcome: z.object({
    assetIds: stringList,
    rating: z.number().int().min(1).max(5).optional(),
    keep: stringList,
    change: stringList,
    never: stringList,
  }).strict(),
  lesson: z.object({
    category: z.enum(['产品锁定', '场景结构', '构图透视', '材质纹理', '道具摆放', '光线色调', '风格跑偏', 'Flow/素材操作']),
    rootCause: z.string().min(1),
    preventionRule: z.string().min(1),
    keywords: stringList,
  }).strict(),
  reviewStatus: z.enum(['pending_review', 'approved', 'rejected', 'conflict']),
}).strict();

export type GenerationMemoryEvent = z.infer<typeof generationMemoryEventSchema>;

export function parseGenerationMemoryEvent(input: unknown): GenerationMemoryEvent {
  return generationMemoryEventSchema.parse(input);
}

export function renderGenerationMemoryMarkdown(input: GenerationMemoryEvent): string {
  const event = parseGenerationMemoryEvent(input);
  return [
    `## ${event.createdAt} / ${event.id}`,
    '',
    `- 来源设备：${event.sourceDeviceId}`,
    `- 项目：${event.projectId}`,
    `- Skill：${event.skill.id}@${event.skill.version}`,
    `- 用户要求：${event.prompt.userRequest}`,
    `- 反推词：${event.prompt.reversePrompt}`,
    `- 问题分类：${event.lesson.category}`,
    `- 原因复盘：${event.lesson.rootCause}`,
    `- 下次预防：${event.lesson.preventionRule}`,
    `- 新关键词：${event.lesson.keywords.join('、')}`,
    `- KEEP：${event.outcome.keep.join('；')}`,
    `- CHANGE：${event.outcome.change.join('；')}`,
    `- NEVER：${event.outcome.never.join('；')}`,
    `- 审核状态：${event.reviewStatus}`,
    '',
  ].join('\n');
}

export function mergeGenerationMemoryEvents(local: GenerationMemoryEvent[], incoming: GenerationMemoryEvent[]) {
  const existing = new Map(local.map((event) => [event.id, parseGenerationMemoryEvent(event)]));
  const accepted: GenerationMemoryEvent[] = [];
  const duplicateIds: string[] = [];
  const conflictIds: string[] = [];

  for (const rawEvent of incoming) {
    const event = parseGenerationMemoryEvent(rawEvent);
    const current = existing.get(event.id);
    if (!current) {
      const pending = { ...event, reviewStatus: 'pending_review' as const };
      accepted.push(pending);
      existing.set(event.id, pending);
      continue;
    }
    if (canonicalJson(current) === canonicalJson(event)) duplicateIds.push(event.id);
    else conflictIds.push(event.id);
  }

  return { accepted, duplicateIds, conflictIds };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}