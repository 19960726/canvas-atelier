import { Check, RotateCcw, X } from 'lucide-react';
import type { SkillPromotionCandidate } from '@agent-canvas/domain';
import type { KnowledgeBaseStateSummary } from '@agent-canvas/skill-store';
import type { SkillCandidateReviewRequest } from '../app/knowledge-client';

interface SkillCandidateReviewProps {
  candidates: SkillPromotionCandidate[];
  knowledgeBases: KnowledgeBaseStateSummary[];
  onReview: (request: SkillCandidateReviewRequest) => Promise<unknown>;
  projectId: string;
}

export function SkillCandidateReview({
  candidates,
  knowledgeBases,
  onReview,
  projectId,
}: SkillCandidateReviewProps) {
  if (candidates.length === 0) return null;

  return (
    <section className="skill-candidate-review" aria-label="Skill candidate review">
      <header className="skill-candidate-review__header">
        <strong>Skill Review</strong>
        <span>{candidates.length} candidates</span>
      </header>
      <div className="skill-candidate-review__list">
        {candidates.map((candidate) => {
          const state = candidate.targetKnowledgeBaseId
            ? knowledgeBases.find((item) => item.knowledgeBaseId === candidate.targetKnowledgeBaseId)
            : undefined;
          const rollbackTarget = findRollbackTarget(candidate, state);
          return (
            <article className="skill-candidate" key={candidate.id}>
              <header>
                <strong>{candidate.id}</strong>
                <span className={`skill-candidate__status is-${candidate.reviewStatus}`}>{candidate.reviewStatus}</span>
              </header>
              <dl>
                <div><dt>Current rule</dt><dd>{candidate.beforeRule ?? 'No published rule shown'}</dd></div>
                <div><dt>Proposed rule</dt><dd>{candidate.rule}</dd></div>
                <div><dt>Source memory</dt><dd>{[candidate.sourceProjectMemoryId, ...(candidate.sourceProjectMemoryIds ?? [])].filter(unique).join(', ')}</dd></div>
                <div><dt>Evidence</dt><dd>{formatEvidence(candidate)}</dd></div>
                <div><dt>Confidence</dt><dd>{candidate.confidence === undefined ? 'n/a' : `${Math.round(candidate.confidence * 100)}%`}</dd></div>
                <div><dt>Capabilities</dt><dd>{candidate.affectedCapabilities?.join(', ') ?? 'n/a'}</dd></div>
                <div><dt>Target</dt><dd>{candidate.targetKnowledgeBaseId ?? 'n/a'}{candidate.targetKnowledgeSection ? ` / ${candidate.targetKnowledgeSection}` : ''}</dd></div>
                <div><dt>Published</dt><dd>{candidate.publishedKnowledgeVersion ?? 'n/a'}</dd></div>
                <div><dt>Active</dt><dd>{state?.activeVersion ?? 'n/a'}{state?.status ? ` / ${state.status}` : ''}</dd></div>
              </dl>
              <div className="skill-candidate__actions">
                {candidate.reviewStatus === 'pending_review' && (
                  <>
                    <button type="button" aria-label={`Approve ${candidate.id}`} onClick={() => void onReview({ projectId, candidateId: candidate.id, decision: 'approved' })}>
                      <Check size={14} />Approve
                    </button>
                    <button type="button" aria-label={`Reject ${candidate.id}`} onClick={() => void onReview({ projectId, candidateId: candidate.id, decision: 'rejected' })}>
                      <X size={14} />Reject
                    </button>
                  </>
                )}
                {candidate.reviewStatus === 'approved' && (
                  <button
                    type="button"
                    aria-label={rollbackTarget ? `Roll back ${candidate.id} to version ${rollbackTarget}` : `No rollback target for ${candidate.id}`}
                    disabled={!rollbackTarget}
                    onClick={() => rollbackTarget && void onReview({
                      projectId,
                      candidateId: candidate.id,
                      decision: 'rolled_back',
                      targetVersion: rollbackTarget,
                    })}
                  >
                    <RotateCcw size={14} />Roll back
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function unique(value: string, index: number, values: string[]): boolean {
  return values.indexOf(value) === index;
}

function formatEvidence(candidate: SkillPromotionCandidate): string {
  const counts = candidate.counts;
  if (!counts) return 'n/a';
  const evidence: string[] = [];
  if (counts.supportingMemoryCount !== undefined) evidence.push(`supporting ${counts.supportingMemoryCount}`);
  if (counts.observationCount !== undefined) evidence.push(`observations ${counts.observationCount}`);
  if (counts.referenceCount !== undefined) evidence.push(`refs ${counts.referenceCount}`);
  if (counts.citationCount !== undefined) evidence.push(`citations ${counts.citationCount}`);
  return evidence.length === 0 ? 'n/a' : evidence.join(' / ');
}

function findRollbackTarget(
  candidate: SkillPromotionCandidate,
  state: KnowledgeBaseStateSummary | undefined,
): number | null {
  if (
    candidate.reviewStatus !== 'approved' ||
    candidate.publishedKnowledgeVersion === undefined ||
    state === undefined
  ) {
    return null;
  }
  return state.versions
    .map((version) => version.version)
    .filter((version) => version < candidate.publishedKnowledgeVersion!)
    .sort((left, right) => right - left)[0] ?? null;
}
