import {
  UNCONFIGURED_KNOWLEDGE_VERSION_KEY,
  agentKnowledgeCapabilitySchema,
  agentKnowledgeLeaseSchema,
  computeAgentKnowledgeVersionKey,
  imageCitationSchema,
  knowledgeSnapshotPinSchema,
  orderedReferenceListSchema,
  orderedReferenceSchema,
  referenceRoleSchema,
  type AgentKnowledgeCapability,
  type AgentKnowledgeLease,
  type ImageCitation,
  type KnowledgeSnapshotPin,
  type OrderedReference,
} from './agent-knowledge-contract';

export {
  UNCONFIGURED_KNOWLEDGE_VERSION_KEY,
  agentKnowledgeCapabilitySchema,
  agentKnowledgeLeaseSchema,
  imageCitationSchema,
  knowledgeSnapshotPinSchema,
  orderedReferenceListSchema,
  orderedReferenceSchema,
  referenceRoleSchema,
};
export type {
  AgentKnowledgeCapability,
  AgentKnowledgeLease,
  ImageCitation,
  KnowledgeSnapshotPin,
  OrderedReference,
};

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
    versionKey: computeAgentKnowledgeVersionKey(snapshots),
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
