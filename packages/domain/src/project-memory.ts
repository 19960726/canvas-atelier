import { z } from 'zod';

const idSchema = z.string().min(1);
const stringListSchema = z.array(z.string().min(1));

export const projectMemoryEntrySchema = z.object({
  schemaVersion: z.literal(1),
  id: idSchema,
  projectId: idSchema,
  projectRevision: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  kind: z.enum(['optimization', 'generation', 'reverse_prompt', 'user_feedback', 'decision']),
  actor: z.enum(['user', 'agent', 'system']),
  title: z.string().min(1),
  changeSummary: z.string().min(1),
  rationale: z.string().min(1),
  snapshots: z.object({
    beforeId: idSchema,
    afterId: idSchema,
  }).strict(),
  context: z.object({
    provider: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    negativePrompt: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    nonce: z.string().min(1).optional(),
    referenceAssetIds: stringListSchema,
    resultAssetIds: stringListSchema,
  }).strict(),
  feedback: z.object({
    keep: stringListSchema,
    change: stringListSchema,
    never: stringListSchema,
    score: z.number().int().min(1).max(5).optional(),
  }).strict(),
  nextStep: z.string().min(1),
  supersedesMemoryId: idSchema.optional(),
  supersedesMemoryIds: z.array(idSchema).optional(),
}).strict().superRefine((entry, context) => {
  for (const text of collectStrings(entry)) {
    if (containsPrivatePath(text)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '项目记忆不能包含私有路径',
      });
      return;
    }
    if (containsSensitiveCredential(text)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '项目记忆不能包含敏感凭据',
      });
      return;
    }
  }
});

export const skillPromotionCandidateSchema = z.object({
  schemaVersion: z.literal(1),
  id: idSchema,
  sourceProjectId: idSchema,
  sourceProjectMemoryId: idSchema,
  createdAt: z.string().datetime(),
  title: z.string().min(1),
  rationale: z.string().min(1),
  rule: z.string().min(1),
  evidence: z.object({
    keep: stringListSchema,
    change: stringListSchema,
    never: stringListSchema,
    score: z.number().int().min(1).max(5).optional(),
  }).strict(),
  reviewStatus: z.literal('pending_review'),
}).strict();

export type ProjectMemoryEntry = z.infer<typeof projectMemoryEntrySchema>;
export type SkillPromotionCandidate = z.infer<typeof skillPromotionCandidateSchema>;

export function parseProjectMemoryEntry(input: unknown): ProjectMemoryEntry {
  return projectMemoryEntrySchema.parse(input);
}

export function appendProjectMemoryEntry(
  timeline: ProjectMemoryEntry[],
  input: ProjectMemoryEntry,
): ProjectMemoryEntry[] {
  const current = timeline.map(parseProjectMemoryEntry);
  const entry = parseProjectMemoryEntry(input);
  if (current.some((item) => item.id === entry.id)) {
    throw new Error('项目记忆 id 重复');
  }
  const latest = current[current.length - 1];
  if (latest && entry.projectId !== latest.projectId) {
    throw new Error('项目记忆不能跨项目追加');
  }
  if (latest && entry.projectRevision < latest.projectRevision) {
    throw new Error('项目记忆版本不能倒退');
  }
  return [...current, entry];
}

export function buildProjectMemoryContext(
  timeline: ProjectMemoryEntry[],
  limit = 20,
): ProjectMemoryEntry[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error('项目记忆上下文数量必须在 1 到 50 之间');
  }
  return selectActiveProjectMemoryEntries(timeline)
    .sort((left, right) => right.projectRevision - left.projectRevision || right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit);
}

export function selectActiveProjectMemoryEntries(timeline: ProjectMemoryEntry[]): ProjectMemoryEntry[] {
  const parsed = timeline.map(parseProjectMemoryEntry);
  const inactiveIds = new Set<string>();
  const activeNewestFirst: ProjectMemoryEntry[] = [];
  for (let index = parsed.length - 1; index >= 0; index -= 1) {
    const entry = parsed[index]!;
    if (inactiveIds.has(entry.id)) continue;
    activeNewestFirst.push(entry);
    for (const id of [
      ...(entry.supersedesMemoryId ? [entry.supersedesMemoryId] : []),
      ...(entry.supersedesMemoryIds ?? []),
    ]) {
      inactiveIds.add(id);
    }
  }
  return activeNewestFirst.reverse();
}
export function createSkillPromotionCandidate(
  input: ProjectMemoryEntry,
  metadata: { candidateId: string; createdAt: string },
): SkillPromotionCandidate {
  const entry = parseProjectMemoryEntry(input);
  return skillPromotionCandidateSchema.parse({
    schemaVersion: 1,
    id: metadata.candidateId,
    sourceProjectId: entry.projectId,
    sourceProjectMemoryId: entry.id,
    createdAt: metadata.createdAt,
    title: entry.title,
    rationale: entry.rationale,
    rule: entry.nextStep,
    evidence: entry.feedback,
    reviewStatus: 'pending_review',
  });
}

function containsPrivatePath(value: string): boolean {
  return /[a-zA-Z]:[\\/]/.test(value)
    || /\\\\[^\\\s]+\\/.test(value)
    || /file:\/\//i.test(value)
    || /(?:^|\s)\/(?:Users|home)\//.test(value)
    || /%(?:USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|HOMEDRIVE|HOMEPATH)%[\\/]/i.test(value);
}

function containsSensitiveCredential(value: string): boolean {
  return /authorization\s*:\s*(?:basic|bearer|token)\s+\S+/i.test(value)
    || /bearer\s+[a-z0-9._~+/=\-]{8,}/i.test(value)
    || /\bsk-[a-z0-9_-]{8,}\b/i.test(value)
    || /\bAIza[0-9a-z_-]{20,}\b/i.test(value)
    || /\bAKIA[0-9A-Z]{16}\b/.test(value)
    || /\bgh[pousr]_[a-z0-9]{20,}\b/i.test(value)
    || /\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/i.test(value)
    || /(?:api[_ -]?key|token|secret|password)\s*[:=]\s*\S{8,}/i.test(value);
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(collectStrings);
  return [];
}