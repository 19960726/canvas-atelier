import { z } from 'zod';

import { containsProtectedPublicText } from './protected-public-text';

export const GENERATION_HISTORY_SCHEMA_VERSION = 1 as const;
export const GENERATION_HISTORY_TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_GENERATION_HISTORY_TAGS = 20;
export const MAX_GENERATION_HISTORY_PROJECT_REFERENCES = 50;
export const MAX_GENERATION_HISTORY_PAGE_SIZE = 100;

const opaqueIdSchema = z.string()
  .min(8)
  .max(96)
  .regex(/^[a-z][a-z0-9_-]+$/u, 'History identities must be opaque public ids');
const timestampSchema = z.string().datetime({ offset: true });
const safeTextSchema = (maximum: number) => z.string().trim().min(1).max(maximum);
const safeOptionalTextSchema = (maximum: number) => safeTextSchema(maximum).optional();

export const generationHistoryStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);

export const generationHistoryAvailabilitySchema = z.enum([
  'available',
  'missing',
  'corrupt',
]);

export const generationHistoryParameterSchema = z.object({
  aspectRatio: safeOptionalTextSchema(24),
  background: z.enum(['opaque', 'transparent']).optional(),
  guidanceScale: z.number().finite().min(0).max(100).optional(),
  negativePromptSummary: safeOptionalTextSchema(240),
  outputCount: z.number().int().min(1).max(8).optional(),
  quality: z.enum(['standard', 'high']).optional(),
  seed: z.number().int().nonnegative().max(0x7fffffff).optional(),
  steps: z.number().int().min(1).max(200).optional(),
  stylePreset: safeOptionalTextSchema(80),
}).strict();

const projectIdentitySchema = z.object({
  projectId: opaqueIdSchema,
  displayLabel: safeTextSchema(120),
}).strict();

const jobIdentitySchema = z.object({
  jobId: opaqueIdSchema,
  resultId: opaqueIdSchema.optional(),
}).strict();

const providerIdentitySchema = z.object({
  displayName: safeTextSchema(80),
  modelDisplayName: safeTextSchema(120),
  capabilityRevision: safeTextSchema(80),
}).strict();

const historyOutputSchema = z.object({
  width: z.number().int().positive().max(32_768),
  height: z.number().int().positive().max(32_768),
  format: z.enum(['gif', 'jpg', 'png', 'webp']),
  mediaType: z.enum(['image/gif', 'image/jpeg', 'image/png', 'image/webp']),
  byteSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  availability: generationHistoryAvailabilitySchema,
  historyAssetId: opaqueIdSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/u, 'History asset hash must be SHA-256'),
}).strict().superRefine((output, context) => {
  const expectedMediaType = output.format === 'jpg' ? 'image/jpeg' : `image/${output.format}`;
  if (output.mediaType !== expectedMediaType) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['mediaType'],
      message: 'History media type must match format',
    });
  }
});

const projectReferenceSchema = z.object({
  referenceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  projectDisplayLabel: safeTextSchema(120),
  independentProjectAssetId: opaqueIdSchema.optional(),
}).strict();

const trashSchema = z.object({
  deletedAt: timestampSchema,
  retentionDeadline: timestampSchema,
}).strict().superRefine((trash, context) => {
  if (Date.parse(trash.retentionDeadline) - Date.parse(trash.deletedAt) !== GENERATION_HISTORY_TRASH_RETENTION_MS) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['retentionDeadline'],
      message: 'History trash retention must be exactly seven days',
    });
  }
});

const terminationMessages = {
  provider_failed: 'Generation failed',
  provider_unavailable: 'Provider unavailable',
  invalid_result: 'Generated result was invalid',
  cancelled_by_user: 'Generation cancelled',
  cancelled_by_system: 'Generation cancelled',
} as const;

const terminationCodeSchema = z.enum([
  'provider_failed',
  'provider_unavailable',
  'invalid_result',
  'cancelled_by_user',
  'cancelled_by_system',
]);

const terminationSchema = z.object({
  code: terminationCodeSchema,
  message: z.enum([
    'Generation failed',
    'Provider unavailable',
    'Generated result was invalid',
    'Generation cancelled',
  ]),
}).strict().superRefine((termination, context) => {
  if (termination.message !== terminationMessages[termination.code]) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['message'],
      message: 'History termination summary is not allowlisted for its code',
    });
  }
});

export const generationHistoryRecordSchema = z.object({
  schemaVersion: z.literal(GENERATION_HISTORY_SCHEMA_VERSION),
  id: opaqueIdSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  completedAt: timestampSchema.nullable(),
  project: projectIdentitySchema.nullable(),
  job: jobIdentitySchema,
  status: generationHistoryStatusSchema,
  provider: providerIdentitySchema,
  promptSummary: safeTextSchema(500),
  parameters: generationHistoryParameterSchema,
  output: historyOutputSchema.nullable(),
  favorite: z.boolean(),
  tags: z.array(safeTextSchema(40)).max(MAX_GENERATION_HISTORY_TAGS),
  projectReferenceCount: z.number().int().nonnegative().max(MAX_GENERATION_HISTORY_PROJECT_REFERENCES),
  projectReferences: z.array(projectReferenceSchema).max(MAX_GENERATION_HISTORY_PROJECT_REFERENCES),
  trash: trashSchema.nullable(),
  termination: terminationSchema.nullable(),
}).strict().superRefine((record, context) => {
  const createdAt = Date.parse(record.createdAt);
  const updatedAt = Date.parse(record.updatedAt);
  if (updatedAt < createdAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['updatedAt'], message: 'updatedAt precedes createdAt' });
  }

  const terminal = record.status === 'succeeded' || record.status === 'failed' || record.status === 'cancelled';
  if (terminal !== (record.completedAt !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['completedAt'],
      message: 'Terminal history status requires a completion timestamp',
    });
  }
  if (record.completedAt !== null) {
    const completedAt = Date.parse(record.completedAt);
    if (completedAt < createdAt || completedAt > updatedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completedAt'],
        message: 'History completion timestamp is outside the record lifetime',
      });
    }
  }

  if (record.status === 'succeeded' && record.output === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['output'], message: 'Succeeded history requires an output' });
  }
  if (record.status !== 'succeeded' && record.output !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['output'], message: 'Only succeeded history can have an output' });
  }

  const failure = record.status === 'failed';
  const cancellation = record.status === 'cancelled';
  if ((failure || cancellation) !== (record.termination !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['termination'],
      message: 'Failed or cancelled history requires an allowlisted termination summary',
    });
  }
  if (failure && record.termination?.code.startsWith('cancelled_')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['termination', 'code'], message: 'Failure code is invalid' });
  }
  if (cancellation && !record.termination?.code.startsWith('cancelled_')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['termination', 'code'], message: 'Cancellation code is invalid' });
  }

  if (record.projectReferenceCount !== record.projectReferences.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['projectReferenceCount'],
      message: 'Project reference count does not match identities',
    });
  }
  if (new Set(record.tags).size !== record.tags.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['tags'], message: 'History tags must be unique' });
  }
  if (containsProtectedHistoryValue(record)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'History record contains protected content' });
  }
});

export const generationHistoryListRequestSchema = z.object({
  cursor: z.string()
    .min(24)
    .max(2_080)
    .regex(/^histcur_[A-Za-z0-9_-]+$/u, 'History cursor is invalid')
    .optional(),
  pageSize: z.number().int().min(1).max(MAX_GENERATION_HISTORY_PAGE_SIZE).default(50),
  sort: z.enum(['newest', 'oldest']).default('newest'),
  filters: z.object({
    createdFrom: timestampSchema.optional(),
    createdTo: timestampSchema.optional(),
    availability: z.enum(['all', 'available', 'missing', 'corrupt']).default('all'),
    favorite: z.boolean().optional(),
    modelDisplayName: safeOptionalTextSchema(120),
    projectId: opaqueIdSchema.optional(),
    providerDisplayName: safeOptionalTextSchema(80),
    referenceState: z.enum(['all', 'used', 'unreferenced']).default('all'),
    statuses: z.array(generationHistoryStatusSchema).max(5).optional(),
    text: safeOptionalTextSchema(120),
    trashState: z.enum(['active', 'trashed', 'all']).default('active'),
  }).strict().default({}).superRefine((filters, context) => {
    if (
      filters.createdFrom !== undefined
      && filters.createdTo !== undefined
      && Date.parse(filters.createdFrom) > Date.parse(filters.createdTo)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['createdTo'],
        message: 'History date range is invalid',
      });
    }
    if (filters.statuses !== undefined && new Set(filters.statuses).size !== filters.statuses.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['statuses'], message: 'History statuses must be unique' });
    }
    if (containsProtectedHistoryValue(filters)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'History filters contain protected content' });
    }
  }),
}).strict();

type MutableGenerationHistoryRecord = z.infer<typeof generationHistoryRecordSchema>;
type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export type GenerationHistoryRecord = DeepReadonly<MutableGenerationHistoryRecord>;
export type GenerationHistoryStatus = z.infer<typeof generationHistoryStatusSchema>;
export type GenerationHistoryAvailability = z.infer<typeof generationHistoryAvailabilitySchema>;
export type GenerationHistoryParameterSummary = DeepReadonly<z.infer<typeof generationHistoryParameterSchema>>;
export type GenerationHistoryListRequest = DeepReadonly<z.infer<typeof generationHistoryListRequestSchema>>;

export function parseGenerationHistoryRecord(input: unknown): GenerationHistoryRecord {
  return deepFreeze(generationHistoryRecordSchema.parse(input)) as GenerationHistoryRecord;
}

export function parseGenerationHistoryListRequest(input: unknown): GenerationHistoryListRequest {
  return deepFreeze(generationHistoryListRequestSchema.parse(input)) as GenerationHistoryListRequest;
}

export function filterAndSortGenerationHistory(
  records: readonly GenerationHistoryRecord[],
  request: unknown,
): GenerationHistoryRecord[] {
  const parsed = parseGenerationHistoryListRequest(request);
  const filters = parsed.filters;
  const text = filters.text?.toLocaleLowerCase();
  return records
    .filter((record) => {
      const createdAt = Date.parse(record.createdAt);
      if (filters.createdFrom !== undefined && createdAt < Date.parse(filters.createdFrom)) return false;
      if (filters.createdTo !== undefined && createdAt > Date.parse(filters.createdTo)) return false;
      if (filters.favorite !== undefined && record.favorite !== filters.favorite) return false;
      if (filters.referenceState === 'used' && record.projectReferenceCount === 0) return false;
      if (filters.referenceState === 'unreferenced' && record.projectReferenceCount > 0) return false;
      if (filters.availability !== 'all' && record.output?.availability !== filters.availability) return false;
      if (filters.projectId !== undefined && record.project?.projectId !== filters.projectId) return false;
      if (filters.providerDisplayName !== undefined && record.provider.displayName !== filters.providerDisplayName) return false;
      if (filters.modelDisplayName !== undefined && record.provider.modelDisplayName !== filters.modelDisplayName) return false;
      if (filters.statuses !== undefined && !filters.statuses.includes(record.status)) return false;
      if (filters.trashState === 'active' && record.trash !== null) return false;
      if (filters.trashState === 'trashed' && record.trash === null) return false;
      if (text !== undefined) {
        const searchable = [
          record.promptSummary,
          record.project?.displayLabel ?? '',
          record.provider.displayName,
          record.provider.modelDisplayName,
          ...record.tags,
        ].join(' ').toLocaleLowerCase();
        if (!searchable.includes(text)) return false;
      }
      return true;
    })
    .sort((left, right) => {
      const timestampDifference = Date.parse(left.createdAt) - Date.parse(right.createdAt);
      if (timestampDifference !== 0) {
        return parsed.sort === 'oldest' ? timestampDifference : -timestampDifference;
      }
      return left.id.localeCompare(right.id);
    });
}

export function containsProtectedHistoryValue(value: unknown): boolean {
  if (typeof value === 'string') {
    return containsProtectedPublicText(value)
      || /https?:\/\//iu.test(value);
  }
  if (Array.isArray(value)) return value.some(containsProtectedHistoryValue);
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(containsProtectedHistoryValue);
  }
  return false;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
