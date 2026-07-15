import { z } from 'zod';
import { MAX_GENERATION_REFERENCES, referenceRoleSchema } from './project-schema';

export const agentKnowledgeCapabilitySchema = z.enum([
  'reverse_prompt',
  'image_generation',
  'ecommerce_detail',
  'video_analysis',
  'line_art',
  'skill_conversation',
]);

export const orderedReferenceSchema = z.object({
  assetId: z.string().min(1),
  label: z.string().min(1),
  role: referenceRoleSchema,
  position: z.number().int().nonnegative(),
  weight: z.number().min(0).max(1).optional(),
}).strict();

export const imageCitationSchema = z.object({
  assetId: z.string().min(1),
  label: z.string().min(1),
}).strict();

export const knowledgeSnapshotPinSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  version: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const orderedReferenceListSchema = z.array(orderedReferenceSchema)
  .max(MAX_GENERATION_REFERENCES, '参考图最多 20 张')
  .superRefine((references, context) => {
    const assetIds = new Set<string>();
    const positions = new Set<number>();
    for (const [index, reference] of references.entries()) {
      if (assetIds.has(reference.assetId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'assetId'],
          message: '参考图不能重复',
        });
      }
      if (positions.has(reference.position)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'position'],
          message: 'Reference positions must be unique',
        });
      }
      assetIds.add(reference.assetId);
      positions.add(reference.position);
    }
  });

export const agentKnowledgeLeaseSchema = z.object({
  schemaVersion: z.literal(1),
  leaseId: z.string().min(1),
  runId: z.string().min(1),
  createdAt: z.string().datetime(),
  capability: agentKnowledgeCapabilitySchema,
  snapshots: z.array(knowledgeSnapshotPinSchema).superRefine((snapshots, context) => {
    const knowledgeBaseIds = new Set<string>();
    for (const [index, snapshot] of snapshots.entries()) {
      if (knowledgeBaseIds.has(snapshot.knowledgeBaseId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'knowledgeBaseId'],
          message: 'Knowledge snapshots must be unique per knowledge base',
        });
      }
      knowledgeBaseIds.add(snapshot.knowledgeBaseId);
    }
  }),
  references: orderedReferenceListSchema,
  citations: z.array(imageCitationSchema).default([]),
  versionKey: z.string(),
}).strict().superRefine((lease, context) => {
  const referenceIds = new Set(lease.references.map((reference) => reference.assetId));
  for (const [index, citation] of lease.citations.entries()) {
    if (!referenceIds.has(citation.assetId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['citations', index, 'assetId'],
        message: 'Citations must reference a known asset',
      });
    }
  }
});

export type AgentKnowledgeCapability = z.infer<typeof agentKnowledgeCapabilitySchema>;
export type OrderedReference = z.infer<typeof orderedReferenceSchema>;
export type ImageCitation = z.infer<typeof imageCitationSchema>;
export type KnowledgeSnapshotPin = z.infer<typeof knowledgeSnapshotPinSchema>;
export type AgentKnowledgeLease = z.infer<typeof agentKnowledgeLeaseSchema>;

interface CreateAgentKnowledgeLeaseInput {
  runId: string;
  capability: AgentKnowledgeCapability;
  snapshots: KnowledgeSnapshotPin[];
  references: OrderedReference[];
  citations: ImageCitation[];
}

interface CreateAgentKnowledgeLeaseMetadata {
  leaseId: string;
  createdAt: string;
}

export function createAgentKnowledgeLease(
  input: CreateAgentKnowledgeLeaseInput,
  metadata: CreateAgentKnowledgeLeaseMetadata,
): AgentKnowledgeLease {
  const snapshots = [...input.snapshots].sort((left, right) => left.knowledgeBaseId.localeCompare(right.knowledgeBaseId));
  const references = normalizeReferencePositions(input.references);
  return agentKnowledgeLeaseSchema.parse({
    schemaVersion: 1,
    leaseId: metadata.leaseId,
    runId: input.runId,
    createdAt: metadata.createdAt,
    capability: input.capability,
    snapshots,
    references,
    citations: input.citations,
    versionKey: snapshots.map((item) => `${item.knowledgeBaseId}@${item.version}:${item.contentHash.slice(0, 12)}`).join('|'),
  });
}

export function reorderReferences(
  references: OrderedReference[],
  movingAssetId: string,
  beforeAssetId?: string,
): OrderedReference[] {
  const normalized = normalizeReferencePositions(references);
  if (beforeAssetId === movingAssetId) return normalized;
  const currentIndex = normalized.findIndex((reference) => reference.assetId === movingAssetId);
  if (currentIndex === -1) return normalized;

  const [movingReference] = normalized.splice(currentIndex, 1);
  if (!movingReference) return normalizeReferencePositions(normalized);

  if (!beforeAssetId) {
    return normalizeReferencePositions([...normalized, movingReference]);
  }

  const targetIndex = normalized.findIndex((reference) => reference.assetId === beforeAssetId);
  if (targetIndex === -1) {
    return normalizeReferencePositions([...normalized, movingReference]);
  }

  normalized.splice(targetIndex, 0, movingReference);
  return normalizeReferencePositions(normalized);
}

export function orderedReferencesMatch(left: OrderedReference[], right: OrderedReference[]): boolean {
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

export function imageCitationsMatch(left: ImageCitation[], right: ImageCitation[]): boolean {
  return left.length === right.length && left.every((citation, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && citation.assetId === candidate.assetId
      && citation.label === candidate.label;
  });
}
function normalizeReferencePositions(references: OrderedReference[]): OrderedReference[] {
  return references.map((reference, index) => ({ ...reference, position: index }));
}
