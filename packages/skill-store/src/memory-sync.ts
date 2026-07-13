import { z } from 'zod';
import {
  generationMemoryEventSchema,
  mergeGenerationMemoryEvents,
  parseGenerationMemoryEvent,
  type GenerationMemoryEvent,
} from './generation-memory';

export const memorySyncBatchSchema = z.object({
  schemaVersion: z.literal(1),
  batchId: z.string().min(1),
  knowledgeBaseId: z.string().min(1),
  sourceDeviceId: z.string().min(1),
  createdAt: z.string().datetime(),
  events: z.array(generationMemoryEventSchema).min(1),
}).strict();

export type MemorySyncBatch = z.infer<typeof memorySyncBatchSchema>;

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