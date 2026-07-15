import { z } from 'zod';

export const MAX_GENERATION_REFERENCES = 20;
export const UNCONFIGURED_KNOWLEDGE_VERSION_KEY = 'no-snapshots-configured';

export const referenceRoleSchema = z.enum([
  'product_identity',
  'scene_composition',
  'prop_reference',
  'material_lighting',
  'placement_preview',
]);

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

export const orderedReferenceListSchema = z.array(orderedReferenceSchema)
  .max(MAX_GENERATION_REFERENCES, 'References cannot exceed 20 items')
  .superRefine((references, context) => {
    const assetIds = new Set<string>();
    const positions = new Set<number>();
    for (const [index, reference] of references.entries()) {
      if (assetIds.has(reference.assetId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'assetId'],
          message: 'Reference asset ids must be unique',
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

export const imageCitationListSchema = z.array(imageCitationSchema);

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
  citations: imageCitationListSchema.default([]),
  versionKey: z.string().min(1),
}).strict().superRefine((lease, context) => {
  const referencesByAssetId = new Map(lease.references.map((reference) => [reference.assetId, reference]));
  const citedAssetIds = new Set<string>();
  for (const [index, citation] of lease.citations.entries()) {
    const reference = referencesByAssetId.get(citation.assetId);
    if (reference === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['citations', index, 'assetId'],
        message: 'Citations must reference a known asset',
      });
      continue;
    }
    if (reference.label !== citation.label) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['citations', index, 'label'],
        message: 'Citation label must match its ordered reference',
      });
    }
    if (citedAssetIds.has(citation.assetId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['citations', index, 'assetId'],
        message: 'Duplicate asset citations are not allowed',
      });
    }
    citedAssetIds.add(citation.assetId);
  }

  if (lease.versionKey !== computeAgentKnowledgeVersionKey(lease.snapshots)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['versionKey'],
      message: 'Knowledge lease version key does not match pinned snapshots',
    });
  }
});

export type AgentKnowledgeCapability = z.infer<typeof agentKnowledgeCapabilitySchema>;
export type OrderedReference = z.infer<typeof orderedReferenceSchema>;
export type ImageCitation = z.infer<typeof imageCitationSchema>;
export type KnowledgeSnapshotPin = z.infer<typeof knowledgeSnapshotPinSchema>;
export type AgentKnowledgeLease = z.infer<typeof agentKnowledgeLeaseSchema>;

export function computeAgentKnowledgeVersionKey(snapshots: readonly KnowledgeSnapshotPin[]): string {
  const sorted = [...snapshots].sort((left, right) => compareStrings(left.knowledgeBaseId, right.knowledgeBaseId));
  return sorted.length === 0
    ? UNCONFIGURED_KNOWLEDGE_VERSION_KEY
    : sorted.map((item) => `${item.knowledgeBaseId}@${item.version}:${item.contentHash.slice(0, 12)}`).join('|');
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
