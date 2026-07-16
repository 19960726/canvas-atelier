import { Check, RotateCcw, X } from 'lucide-react';
import { useState } from 'react';
import type { SkillPromotionCandidate } from '@agent-canvas/domain';
import type { KnowledgeBaseStateSummary } from '@agent-canvas/skill-store';
import type { SkillCandidateReviewRequest } from '../app/knowledge-client';

interface SkillCandidateReviewProps {
  candidates: SkillPromotionCandidate[];
  knowledgeBases: KnowledgeBaseStateSummary[];
  onReview: (request: SkillCandidateReviewRequest) => Promise<unknown>;
  onPrepareReview?: (candidateId: string) => Promise<unknown>;
  projectId: string;
}

export function SkillCandidateReview({
  candidates,
  knowledgeBases,
  onReview,
  onPrepareReview,
  projectId,
}: SkillCandidateReviewProps) {
  const [confirmingCandidateId, setConfirmingCandidateId] = useState<string | null>(null);

  if (candidates.length === 0) return null;

  return (
    <section className="skill-candidate-review" aria-label="Skill candidate review" data-testid="skill-candidate-review">
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
          const reviewability = getReviewability(candidate);
          return (
            <article className="skill-candidate" key={candidate.id}>
              <header>
                <strong>{candidate.id}</strong>
                <span data-testid="skill-candidate-status" className={`skill-candidate__status is-${candidate.reviewStatus}`}>{candidate.reviewStatus}</span>
              </header>
              <dl>
                <div><dt>Source rule</dt><dd data-testid="skill-sync-source">{candidate.sourceRule ?? 'Source rule unavailable'}</dd></div>
                <div><dt>Managed rule</dt><dd data-testid="skill-sync-managed">{candidate.managedRule ?? 'Managed rule unavailable'}</dd></div>
                <div><dt>Proposed rule</dt><dd data-testid="skill-sync-proposed">{candidate.rule}</dd></div>
                {candidate.diffHunks && candidate.diffHunks.length > 0 && (
                  <div><dt>Diff hunks</dt><dd data-testid="skill-sync-diff-hunks">{candidate.diffHunks.join('\n')}</dd></div>
                )}
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
                    <button
                      data-testid="skill-approve"
                      type="button"
                      aria-label={`Approve ${candidate.id}`}
                      disabled={!reviewability.canReview}
                      onClick={() => {
                        if (reviewability.canReview) setConfirmingCandidateId(candidate.id);
                      }}
                    >
                      <Check size={14} />Approve
                    </button>
                    <button
                      type="button"
                      aria-label={`Reject ${candidate.id}`}
                      disabled={!reviewability.canReview}
                      onClick={() => {
                        if (reviewability.canReview) void onReview({ projectId, candidateId: candidate.id, decision: 'rejected' });
                      }}
                    >
                      <X size={14} />Reject
                    </button>
                    {candidate.reviewPreparationStatus === 'failed' && onPrepareReview !== undefined && (
                      <button type="button" aria-label={`Prepare ${candidate.id}`} onClick={() => void onPrepareReview(candidate.id)}>
                        <RotateCcw size={14} />Prepare
                      </button>
                    )}
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
              {candidate.reviewStatus === 'pending_review' && !reviewability.canReview && (
                <p data-testid="skill-review-unavailable" className="skill-candidate__unavailable">{reviewability.reason}</p>
              )}
              {candidate.reviewStatus === 'pending_review' && reviewability.canReview && confirmingCandidateId === candidate.id && (
                <div className="skill-sync-confirmation" data-testid="skill-sync-confirmation" role="group" aria-label="Skill 同步确认">
                  <strong>Skill 同步确认</strong>
                  <p>{candidate.targetKnowledgeBaseId ?? 'local-skill'} / {candidate.targetKnowledgeSection ?? 'default'}</p>
                  <div className="skill-sync-confirmation__actions">
                    <button type="button" onClick={() => setConfirmingCandidateId(null)}>取消</button>
                    <button
                      data-testid="skill-confirm-sync"
                      type="button"
                      onClick={() => {
                        setConfirmingCandidateId(null);
                        void onReview({ projectId, candidateId: candidate.id, decision: 'approved' });
                      }}
                    >
                      确认同步
                    </button>
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function getReviewability(candidate: SkillPromotionCandidate): { canReview: boolean; reason: string } {
  if (candidate.reviewPreparationStatus === 'preparing') {
    return {
      canReview: false,
      reason: 'Review preview is preparing.',
    };
  }
  if (candidate.reviewPreparationStatus === 'failed') {
    return {
      canReview: false,
      reason: candidate.reviewPreparationError
        ? `Review preview is unavailable: ${candidate.reviewPreparationError}`
        : 'Review preview is unavailable.',
    };
  }
  if (candidate.sourceRule && candidate.managedRule && candidate.diffHunks && candidate.diffHunks.length > 0) {
    return { canReview: true, reason: '' };
  }
  return {
    canReview: false,
    reason: 'Cannot review until source, managed, and diff rule text are available.',
  };
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
