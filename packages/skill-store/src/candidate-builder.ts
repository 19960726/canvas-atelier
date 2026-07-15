import {
  parseProjectMemoryEntry,
  selectActiveProjectMemoryEntries,
  skillPromotionCandidateSchema,
  type AgentKnowledgeCapability,
  type ProjectMemoryEntry,
  type SkillPromotionCandidate,
} from '@agent-canvas/domain';

type Feedback = SkillPromotionCandidate['evidence'];

export interface CandidateMetadata {
  candidateId: string;
  targetKnowledgeBaseId: string;
  targetSection: string;
  createdAt: string;
  affectedCapabilities?: AgentKnowledgeCapability[];
}

export type AggregatedSkillPromotionCandidate = SkillPromotionCandidate & {
  supportingEvidenceCount: number;
  contradictingEvidenceCount: number;
};

export function buildSkillPromotionCandidate(
  entries: ProjectMemoryEntry[],
  metadata: CandidateMetadata,
): AggregatedSkillPromotionCandidate {
  if (entries.length === 0) throw new Error('Skill promotion candidate requires feedback evidence');
  const parsed = entries.map(parseProjectMemoryEntry);
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (seen.has(entry.id)) throw new Error('Skill promotion candidate cannot contain duplicate source ids');
    seen.add(entry.id);
  }

  const sourceProjectId = parsed[0]!.projectId;
  if (parsed.some((entry) => entry.projectId !== sourceProjectId)) {
    throw new Error('Skill promotion candidate cannot mix projects');
  }

  const ordered = selectActiveProjectMemoryEntries(parsed).sort(compareEvidenceOrder);
  const supportingEvidenceCount = ordered.filter((entry) => entry.feedback.change.length > 0).length;
  const supportingChanges = new Set(ordered.flatMap((entry) => entry.feedback.change));
  const contradictingEvidenceCount = ordered.filter((entry) => entry.feedback.never.some((item) => supportingChanges.has(item))).length;
  const totalEvidence = supportingEvidenceCount + contradictingEvidenceCount;
  const first = ordered[0]!;
  const candidate = skillPromotionCandidateSchema.parse({
    schemaVersion: 1,
    id: metadata.candidateId,
    sourceProjectId,
    sourceProjectMemoryId: first.id,
    sourceProjectMemoryIds: ordered.map((entry) => entry.id),
    createdAt: metadata.createdAt,
    title: first.title,
    rationale: ordered.map((entry) => entry.rationale).join('\n'),
    rule: selectCandidateRule(ordered),
    targetKnowledgeBaseId: metadata.targetKnowledgeBaseId,
    targetKnowledgeSection: metadata.targetSection,
    counts: {
      supportingMemoryCount: Math.max(1, supportingEvidenceCount),
      referenceCount: countUnique(ordered.flatMap((entry) => entry.context.referenceAssetIds)),
      citationCount: countUnique(ordered.flatMap((entry) => entry.context.citations?.map((citation) => citation.assetId) ?? [])),
      observationCount: ordered.reduce((sum, entry) => sum + countObservations(entry), 0),
    },
    confidence: totalEvidence === 0 ? 0 : supportingEvidenceCount / totalEvidence,
    affectedCapabilities: metadata.affectedCapabilities,
    evidence: mergeFeedback(ordered),
    reviewStatus: 'pending_review',
  });

  return {
    ...candidate,
    supportingEvidenceCount,
    contradictingEvidenceCount,
  };
}

function compareEvidenceOrder(left: ProjectMemoryEntry, right: ProjectMemoryEntry): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function selectCandidateRule(entries: ProjectMemoryEntry[]): string {
  const changed = entries.find((entry) => entry.feedback.change.length > 0);
  return changed?.nextStep ?? entries[0]!.nextStep;
}

function mergeFeedback(entries: ProjectMemoryEntry[]): Feedback {
  const keep = unique(entries.flatMap((entry) => entry.feedback.keep));
  const change = unique(entries.flatMap((entry) => entry.feedback.change));
  const never = unique(entries.flatMap((entry) => entry.feedback.never));
  const scores = entries.map((entry) => entry.feedback.score).filter((score): score is number => score !== undefined);
  return {
    keep,
    change,
    never,
    score: scores.length === 0 ? undefined : Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length),
  };
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function countUnique(values: string[]): number {
  return new Set(values).size;
}

function countObservations(entry: ProjectMemoryEntry): number {
  return Object.values(entry.observations ?? {}).reduce((sum, values) => sum + values.length, 0);
}
