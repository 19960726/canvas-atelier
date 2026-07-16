import { z } from 'zod';
import {
  agentKnowledgeCapabilitySchema,
  agentKnowledgeLeaseSchema,
  imageCitationListSchema,
  orderedReferenceListSchema,
  type AgentKnowledgeLease,
  type ImageCitation,
  type OrderedReference,
} from './agent-knowledge-contract';

const idSchema = z.string().min(1);
const stringListSchema = z.array(z.string().min(1));

const feedbackSchema = z.object({
  keep: stringListSchema,
  change: stringListSchema,
  never: stringListSchema,
  score: z.number().int().min(1).max(5).optional(),
}).strict();

export const feedbackObservationsSchema = z.object({
  sceneStructure: stringListSchema.optional(),
  composition: stringListSchema.optional(),
  material: stringListSchema.optional(),
  texture: stringListSchema.optional(),
  floor: stringListSchema.optional(),
  wall: stringListSchema.optional(),
  color: stringListSchema.optional(),
  lighting: stringListSchema.optional(),
  liquid: stringListSchema.optional(),
  vfx: stringListSchema.optional(),
  video: stringListSchema.optional(),
  cameraMotion: stringListSchema.optional(),
}).strict();

const projectMemoryContextSchema = z.object({
  provider: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  negativePrompt: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  nonce: z.string().min(1).optional(),
  referenceAssetIds: stringListSchema,
  resultAssetIds: stringListSchema,
  knowledgeLease: agentKnowledgeLeaseSchema.optional(),
  references: orderedReferenceListSchema.optional(),
  citations: imageCitationListSchema.optional(),
}).strict().superRefine((contextValue, refinement) => {
  if (contextValue.references && !matchReferenceAssetIds(contextValue.references, contextValue.referenceAssetIds)) {
    refinement.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['referenceAssetIds'],
      message: 'Reference asset ids must match ordered references',
    });
  }

  if (contextValue.knowledgeLease) {
    if (contextValue.references && !orderedReferencesMatch(contextValue.references, contextValue.knowledgeLease.references)) {
      refinement.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['references'],
        message: 'References must match the knowledge lease',
      });
    }
    if (contextValue.citations && !imageCitationsMatch(contextValue.citations, contextValue.knowledgeLease.citations)) {
      refinement.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['citations'],
        message: 'Citations must match the knowledge lease',
      });
    }
  }
});

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
  context: projectMemoryContextSchema,
  feedback: feedbackSchema,
  observations: feedbackObservationsSchema.optional(),
  nextStep: z.string().min(1),
  supersedesMemoryId: idSchema.optional(),
  supersedesMemoryIds: z.array(idSchema).optional(),
}).strict().superRefine((entry, context) => {
  if (
    entry.kind === 'user_feedback' &&
    (
      entry.context.knowledgeLease === undefined ||
      entry.context.references === undefined ||
      entry.context.citations === undefined
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['context'],
      message: 'User feedback requires canonical knowledge provenance',
    });
  }

  for (const text of collectStrings(entry)) {
    if (containsPrivatePath(text)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Project memory cannot contain private paths',
      });
      return;
    }
    if (containsSensitiveCredential(text)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Project memory cannot contain sensitive credentials',
      });
      return;
    }
  }
});

export const skillCandidateReviewStatusSchema = z.enum([
  'pending_review',
  'approved',
  'rejected',
  'superseded',
  'rolled_back',
]);

export const skillCandidateReviewPreparationStatusSchema = z.enum([
  'preparing',
  'ready',
  'failed',
]);

export const skillCandidatePreparedManagedSnapshotSchema = z.object({
  knowledgeBaseId: idSchema,
  version: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/i),
}).strict();

const skillCandidateCountsSchema = z.object({
  supportingMemoryCount: z.number().int().positive().optional(),
  referenceCount: z.number().int().nonnegative().optional(),
  citationCount: z.number().int().nonnegative().optional(),
  observationCount: z.number().int().nonnegative().optional(),
}).strict();

export const skillPromotionCandidateSchema = z.object({
  schemaVersion: z.literal(1),
  id: idSchema,
  sourceProjectId: idSchema,
  sourceProjectMemoryId: idSchema,
  sourceProjectMemoryIds: z.array(idSchema).optional(),
  createdAt: z.string().datetime(),
  title: z.string().min(1),
  rationale: z.string().min(1),
  rule: z.string().min(1),
  beforeRule: z.string().min(1).optional(),
  sourceRule: z.string().min(1).optional(),
  managedRule: z.string().min(1).optional(),
  diffHunks: z.array(z.string().min(1)).optional(),
  reviewPreparationStatus: skillCandidateReviewPreparationStatusSchema.optional(),
  reviewPreparationStartedAt: z.string().datetime().optional(),
  reviewPreparationError: z.string().min(1).max(500).optional(),
  preparedManagedSnapshot: skillCandidatePreparedManagedSnapshotSchema.optional(),
  targetKnowledgeBaseId: idSchema.optional(),
  targetKnowledgeSection: z.string().min(1).optional(),
  counts: skillCandidateCountsSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  affectedCapabilities: z.array(agentKnowledgeCapabilitySchema).optional(),
  evidence: feedbackSchema,
  reviewStatus: skillCandidateReviewStatusSchema,
  reviewedAt: z.string().datetime().optional(),
  reviewTransactionId: idSchema.optional(),
  publishedKnowledgeVersion: z.number().int().positive().optional(),
  rolledBackAt: z.string().datetime().optional(),
}).strict().superRefine((candidate, context) => {
  if (candidate.sourceProjectMemoryIds && candidate.sourceProjectMemoryIds.length > 0) {
    const seen = new Set<string>();
    for (const sourceId of candidate.sourceProjectMemoryIds) {
      if (seen.has(sourceId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sourceProjectMemoryIds'],
          message: 'Source project memory ids must be unique',
        });
        break;
      }
      seen.add(sourceId);
    }
  }

  if (candidate.reviewStatus === 'pending_review') {
    if (candidate.reviewedAt || candidate.reviewTransactionId || candidate.publishedKnowledgeVersion || candidate.rolledBackAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewStatus'],
        message: 'Pending review candidates cannot include review lifecycle metadata',
      });
    }
    if (
      candidate.reviewPreparationStatus === 'ready' &&
      (!candidate.sourceRule || !candidate.managedRule || !candidate.diffHunks || candidate.diffHunks.length === 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewPreparationStatus'],
        message: 'Ready review preparation requires source, managed, and diff rule text',
      });
    }
    if (candidate.reviewPreparationStatus === 'failed' && !candidate.reviewPreparationError) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewPreparationError'],
        message: 'Failed review preparation requires an error reason',
      });
    }
    if (candidate.reviewPreparationStatus !== 'failed' && candidate.reviewPreparationError) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewPreparationError'],
        message: 'Only failed review preparation can include an error reason',
      });
    }
    return;
  }

  if (!candidate.reviewedAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reviewedAt'],
      message: 'Reviewed candidates must include reviewedAt',
    });
  }

  if (candidate.reviewStatus === 'approved') {
    if (!candidate.publishedKnowledgeVersion) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['publishedKnowledgeVersion'],
        message: 'Approved candidates must include publishedKnowledgeVersion',
      });
    }
    if (candidate.rolledBackAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rolledBackAt'],
        message: 'Approved candidates cannot include rolledBackAt',
      });
    }
    return;
  }

  if (candidate.reviewStatus === 'rolled_back') {
    if (!candidate.publishedKnowledgeVersion) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['publishedKnowledgeVersion'],
        message: 'Rolled back candidates must preserve publishedKnowledgeVersion',
      });
    }
    if (!candidate.rolledBackAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rolledBackAt'],
        message: 'Rolled back candidates must include rolledBackAt',
      });
    }
    return;
  }

  if (candidate.publishedKnowledgeVersion || candidate.rolledBackAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reviewStatus'],
      message: 'Only approved or rolled back candidates can include published lifecycle metadata',
    });
  }
});

export type FeedbackObservations = z.infer<typeof feedbackObservationsSchema>;
export type ProjectMemoryEntry = z.infer<typeof projectMemoryEntrySchema>;
export type SkillCandidatePreparedManagedSnapshot = z.infer<typeof skillCandidatePreparedManagedSnapshotSchema>;
export type SkillCandidateReviewPreparationStatus = z.infer<typeof skillCandidateReviewPreparationStatusSchema>;
export type SkillCandidateReviewStatus = z.infer<typeof skillCandidateReviewStatusSchema>;
export type SkillPromotionCandidate = z.infer<typeof skillPromotionCandidateSchema>;

interface CreateUserFeedbackMemoryInput {
  projectId: string;
  projectRevision: number;
  title: string;
  userRequest: string;
  correction: string;
  knowledgeLease: AgentKnowledgeLease;
  references: OrderedReference[];
  citations: ImageCitation[];
  observations?: FeedbackObservations;
  feedback: z.infer<typeof feedbackSchema>;
}

interface CreateUserFeedbackMemoryMetadata {
  memoryId: string;
  createdAt: string;
  snapshots: {
    beforeId: string;
    afterId: string;
  };
}

interface ReviewSkillPromotionCandidateInput {
  decision: Extract<SkillCandidateReviewStatus, 'approved' | 'rejected' | 'superseded'>;
  reviewedAt: string;
  publishedKnowledgeVersion?: number;
  transactionId?: string;
}

export function parseProjectMemoryEntry(input: unknown): ProjectMemoryEntry {
  return stripUndefinedProperties(projectMemoryEntrySchema.parse(input));
}

export function appendProjectMemoryEntry(
  timeline: ProjectMemoryEntry[],
  input: ProjectMemoryEntry,
): ProjectMemoryEntry[] {
  const current = timeline.map(parseProjectMemoryEntry);
  const entry = parseProjectMemoryEntry(input);
  if (current.some((item) => item.id === entry.id)) {
    throw new Error('Project memory id must be unique');
  }
  const latest = current[current.length - 1];
  if (latest && entry.projectId !== latest.projectId) {
    throw new Error('Project memory cannot cross projects');
  }
  if (latest && entry.projectRevision < latest.projectRevision) {
    throw new Error('Project memory revision cannot move backwards');
  }
  return [...current, entry];
}

export function buildProjectMemoryContext(
  timeline: ProjectMemoryEntry[],
  limit = 20,
): ProjectMemoryEntry[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error('Project memory context limit must be between 1 and 50');
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
  return parseSkillPromotionCandidate({
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

export function createUserFeedbackMemory(
  input: CreateUserFeedbackMemoryInput,
  metadata: CreateUserFeedbackMemoryMetadata,
): ProjectMemoryEntry {
  return parseProjectMemoryEntry({
    schemaVersion: 1,
    id: metadata.memoryId,
    projectId: input.projectId,
    projectRevision: input.projectRevision,
    createdAt: metadata.createdAt,
    kind: 'user_feedback',
    actor: 'user',
    title: input.title,
    changeSummary: input.correction,
    rationale: input.userRequest,
    snapshots: metadata.snapshots,
    context: {
      prompt: input.userRequest,
      negativePrompt: input.correction,
      sessionId: input.knowledgeLease.runId,
      referenceAssetIds: input.references.map((reference) => reference.assetId),
      resultAssetIds: [],
      knowledgeLease: input.knowledgeLease,
      references: input.references,
      citations: input.citations,
    },
    feedback: input.feedback,
    observations: input.observations,
    nextStep: input.correction,
  });
}

export function reviewSkillPromotionCandidate(
  candidate: SkillPromotionCandidate,
  input: ReviewSkillPromotionCandidateInput,
): SkillPromotionCandidate {
  const current = parseSkillPromotionCandidate(candidate);
  if (current.reviewStatus !== 'pending_review') {
    throw new Error('Only pending_review candidates can be reviewed');
  }
  if (input.decision === 'approved' && input.publishedKnowledgeVersion === undefined) {
    throw new Error('Approved candidates require publishedKnowledgeVersion');
  }
  if (input.decision !== 'approved' && input.publishedKnowledgeVersion !== undefined) {
    throw new Error('Only approved candidates can include publishedKnowledgeVersion');
  }

  return parseSkillPromotionCandidate({
    ...current,
    reviewStatus: input.decision,
    reviewedAt: input.reviewedAt,
    ...(input.transactionId === undefined ? {} : { reviewTransactionId: input.transactionId }),
    ...(input.decision === 'approved' ? { publishedKnowledgeVersion: input.publishedKnowledgeVersion } : {}),
  });
}

export function createSkillPromotionCandidateFingerprint(candidate: SkillPromotionCandidate): string {
  return JSON.stringify(sortFingerprintValue(parseSkillPromotionCandidate(candidate)));
}

export function rollbackSkillPromotionCandidate(
  candidate: SkillPromotionCandidate,
  rolledBackAt: string,
  metadata: { transactionId?: string } = {},
): SkillPromotionCandidate {
  const current = parseSkillPromotionCandidate(candidate);
  if (current.reviewStatus !== 'approved') {
    throw new Error('Only approved candidates can be rolled back');
  }

  const reviewTransactionId = metadata.transactionId ?? current.reviewTransactionId;
  return parseSkillPromotionCandidate({
    ...current,
    reviewStatus: 'rolled_back',
    ...(reviewTransactionId === undefined ? {} : { reviewTransactionId }),
    rolledBackAt,
  });
}

function parseSkillPromotionCandidate(input: unknown): SkillPromotionCandidate {
  return stripUndefinedProperties(skillPromotionCandidateSchema.parse(input));
}

function stripUndefinedProperties<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefinedProperties(item)) as T;
  }
  if (value !== null && typeof value === 'object') {
    const compact: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined) {
        compact[key] = stripUndefinedProperties(child);
      }
    }
    return compact as T;
  }
  return value;
}

function sortFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortFingerprintValue);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortFingerprintValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function orderedReferencesMatch(left: OrderedReference[], right: OrderedReference[]): boolean {
  return left.length === right.length && left.every((reference, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && reference.assetId === candidate.assetId
      && reference.label === candidate.label
      && reference.role === candidate.role
      && reference.position === candidate.position
      && reference.weight === candidate.weight;
  });
}

function imageCitationsMatch(left: ImageCitation[], right: ImageCitation[]): boolean {
  return left.length === right.length && left.every((citation, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && citation.assetId === candidate.assetId
      && citation.label === candidate.label;
  });
}

function matchReferenceAssetIds(references: OrderedReference[], referenceAssetIds: string[]): boolean {
  return references.length === referenceAssetIds.length
    && references.every((reference, index) => reference.assetId === referenceAssetIds[index]);
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
