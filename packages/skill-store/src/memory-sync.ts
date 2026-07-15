import { z } from 'zod';
import {
  generationMemoryEventSchema,
  mergeGenerationMemoryEvents,
  parseGenerationMemoryEvent,
  type GenerationMemoryEvent,
} from './generation-memory';
import type { KnowledgeSnapshot } from './knowledge-registry';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const knowledgeSnapshotSyncSchema = z.object({
  schemaVersion: z.literal(1),
  knowledgeBaseId: z.string().min(1),
  displayName: z.string().min(1),
  contentHash: hashSchema,
  version: z.number().int().positive(),
  publishedAt: z.string().datetime(),
  sourceDeviceId: z.string().min(1),
  documents: z.array(z.object({
    relativePath: z.string().min(1),
    content: z.string(),
    sha256: hashSchema,
  }).strict()).min(1),
}).strict();

export const memorySyncBatchSchema = z.object({
  schemaVersion: z.literal(1),
  batchId: z.string().min(1),
  knowledgeBaseId: z.string().min(1),
  sourceDeviceId: z.string().min(1),
  createdAt: z.string().datetime(),
  events: z.array(generationMemoryEventSchema).min(1),
}).strict();

export type MemorySyncBatch = z.infer<typeof memorySyncBatchSchema>;

export const approvedSnapshotSyncEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  envelopeId: z.string().min(1),
  knowledgeBaseId: z.string().min(1),
  createdAt: z.string().datetime(),
  cursor: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).optional(),
  snapshot: knowledgeSnapshotSyncSchema,
}).strict().superRefine((envelope, context) => {
  if (envelope.snapshot.knowledgeBaseId !== envelope.knowledgeBaseId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['snapshot', 'knowledgeBaseId'],
      message: 'Approved snapshot envelope knowledge base mismatch',
    });
  }
});

export type KnowledgeSnapshotSyncEnvelope = z.infer<typeof approvedSnapshotSyncEnvelopeSchema>;

export function createMemorySyncBatch(
  events: GenerationMemoryEvent[],
  metadata: { batchId: string; createdAt: string },
): MemorySyncBatch {
  if (events.length === 0) throw new Error('memory sync batch requires events');
  const parsed = events.map(parseGenerationMemoryEvent);
  const knowledgeBaseId = parsed[0]!.knowledgeBaseId;
  const sourceDeviceId = parsed[0]!.sourceDeviceId;
  if (parsed.some((event) => event.knowledgeBaseId !== knowledgeBaseId)) {
    throw new Error('memory sync batch cannot mix knowledge bases');
  }
  if (parsed.some((event) => event.sourceDeviceId !== sourceDeviceId)) {
    throw new Error('memory sync batch cannot mix device sources');
  }
  return memorySyncBatchSchema.parse({
    schemaVersion: 1,
    batchId: metadata.batchId,
    knowledgeBaseId,
    sourceDeviceId,
    createdAt: metadata.createdAt,
    events: parsed,
  });
}

export function ingestMemorySyncBatch(
  local: GenerationMemoryEvent[],
  input: MemorySyncBatch,
  destinationKnowledgeBaseId: string,
) {
  const batch = memorySyncBatchSchema.parse(input);
  if (batch.knowledgeBaseId !== destinationKnowledgeBaseId) {
    throw new Error('memory sync batch destination knowledge base mismatch');
  }
  return mergeGenerationMemoryEvents(local, batch.events);
}

export function createApprovedSnapshotSyncEnvelope(
  snapshot: KnowledgeSnapshot,
  metadata: { envelopeId: string; createdAt: string; knowledgeBaseId?: string; cursor?: string; idempotencyKey?: string },
): KnowledgeSnapshotSyncEnvelope {
  const parsedSnapshot = knowledgeSnapshotSyncSchema.parse(snapshot);
  const knowledgeBaseId = metadata.knowledgeBaseId ?? parsedSnapshot.knowledgeBaseId;
  return approvedSnapshotSyncEnvelopeSchema.parse({
    schemaVersion: 1,
    envelopeId: metadata.envelopeId,
    knowledgeBaseId,
    createdAt: metadata.createdAt,
    cursor: metadata.cursor,
    idempotencyKey: metadata.idempotencyKey,
    snapshot: parsedSnapshot,
  });
}
