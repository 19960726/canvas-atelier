import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { skillPromotionCandidateSchema, type SkillPromotionCandidate } from '@agent-canvas/domain';
import type { KnowledgeBaseStateSummary } from '@agent-canvas/skill-store';
import { SkillCandidateReview } from './SkillCandidateReview';

afterEach(() => cleanup());

describe('SkillCandidateReview', () => {
  it('approves and rejects pending candidates through the review bridge only when clicked', async () => {
    const onReview = vi.fn(async () => undefined);
    render(<SkillCandidateReview
      candidates={[candidate({
        reviewStatus: 'pending_review',
        reviewPreparationStatus: 'ready',
        preparedManagedSnapshot: preparedManagedSnapshot(),
      })]}
      knowledgeBases={[knowledgeState()]}
      onReview={onReview}
      projectId="project-1"
    />);

    expect(screen.getByLabelText('Skill candidate review')).toBeVisible();
    expect(screen.getByText('Source rule')).toBeVisible();
    expect(screen.getByText('Managed rule')).toBeVisible();
    expect(screen.getByText('Proposed rule')).toBeVisible();
    expect(onReview).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Approve candidate-1' }));
    expect(screen.getByTestId('skill-sync-confirmation')).toBeVisible();
    expect(onReview).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '确认同步' }));
    await waitFor(() => expect(onReview).toHaveBeenCalledWith({
      candidateId: 'candidate-1',
      decision: 'approved',
      projectId: 'project-1',
    }));

    fireEvent.click(screen.getByRole('button', { name: 'Reject candidate-1' }));
    await waitFor(() => expect(onReview).toHaveBeenCalledWith({
      candidateId: 'candidate-1',
      decision: 'rejected',
      projectId: 'project-1',
    }));
  });

  it('rolls back approved candidates to the newest valid older knowledge version', async () => {
    const onReview = vi.fn(async () => undefined);
    render(<SkillCandidateReview
      candidates={[candidate({
        reviewStatus: 'approved',
        reviewedAt: '2026-07-15T09:00:00.000Z',
        publishedKnowledgeVersion: 3,
      })]}
      knowledgeBases={[knowledgeState()]}
      onReview={onReview}
      projectId="project-1"
    />);

    fireEvent.click(screen.getByRole('button', { name: 'Roll back candidate-1 to version 2' }));

    await waitFor(() => expect(onReview).toHaveBeenCalledWith({
      candidateId: 'candidate-1',
      decision: 'rolled_back',
      projectId: 'project-1',
      targetVersion: 2,
    }));
  });

  it('labels persisted observation counts honestly without inventing contradiction evidence', () => {
    const persisted = skillPromotionCandidateSchema.parse(candidate());

    render(<SkillCandidateReview
      candidates={[persisted]}
      knowledgeBases={[knowledgeState()]}
      onReview={async () => undefined}
      projectId="project-1"
    />);

    expect(screen.getByText('supporting 2 / observations 1 / refs 1 / citations 1')).toBeVisible();
    expect(screen.queryByText(/contradicting/i)).not.toBeInTheDocument();
  });

  it('renders source, managed, and proposed rule bodies from review state, not version labels', () => {
    const reviewable = {
      ...candidate({
        beforeRule: 'legacy summary should not replace the source body',
        rule: 'Proposed rule body: keep the product centered with calmer liquid arcs.',
      }),
      managedRule: 'Managed rule body: preserve the current cool background lighting.',
      sourceRule: 'Source rule body: lock the product logo before changing props.',
    } as SkillPromotionCandidate;

    render(<SkillCandidateReview
      candidates={[reviewable]}
      knowledgeBases={[knowledgeState()]}
      onReview={async () => undefined}
      projectId="project-1"
    />);

    expect(screen.getByTestId('skill-sync-source')).toHaveTextContent('Source rule body: lock the product logo before changing props.');
    expect(screen.getByTestId('skill-sync-managed')).toHaveTextContent('Managed rule body: preserve the current cool background lighting.');
    expect(screen.getByTestId('skill-sync-proposed')).toHaveTextContent('Proposed rule body: keep the product centered with calmer liquid arcs.');
    expect(screen.getByTestId('skill-sync-managed')).not.toHaveTextContent(/Scene Skill v3|cccccccc/);
  });

  it('keeps pending candidates non-reviewable when source or managed rule text is missing', () => {
    render(<SkillCandidateReview
      candidates={[candidate({
        sourceRule: undefined,
        managedRule: undefined,
        reviewPreparationStatus: 'ready',
        preparedManagedSnapshot: preparedManagedSnapshot(),
      })]}
      knowledgeBases={[knowledgeState()]}
      onReview={async () => undefined}
      projectId="project-1"
    />);

    expect(screen.getByRole('button', { name: 'Approve candidate-1' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject candidate-1' })).toBeDisabled();
    expect(screen.getByTestId('skill-review-unavailable')).toHaveTextContent(/source, managed, and diff rule text/i);
    expect(screen.queryByTestId('skill-sync-confirmation')).not.toBeInTheDocument();
  });

  it('disables approve and reject while the review preview is preparing', () => {
    const onReview = vi.fn(async () => undefined);
    const preparing = {
      ...candidate({ sourceRule: undefined, managedRule: undefined }),
      reviewPreparationStatus: 'preparing',
      reviewPreparationStartedAt: '2026-07-16T05:00:00.000Z',
    } as SkillPromotionCandidate;

    render(<SkillCandidateReview
      candidates={[preparing]}
      knowledgeBases={[knowledgeState()]}
      onReview={onReview}
      projectId="project-1"
    />);

    expect(screen.getByRole('button', { name: 'Approve candidate-1' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject candidate-1' })).toBeDisabled();
    expect(screen.getByTestId('skill-review-unavailable')).toHaveTextContent(/preparing/i);
    fireEvent.click(screen.getByRole('button', { name: 'Reject candidate-1' }));
    expect(onReview).not.toHaveBeenCalled();
  });

  it('enables decisions only for a ready preview with bound managed snapshot metadata', () => {
    render(<SkillCandidateReview
      candidates={[
        candidate({
          id: 'candidate-missing-status',
          preparedManagedSnapshot: preparedManagedSnapshot(),
        }),
        candidate({
          id: 'candidate-non-ready',
          reviewPreparationStatus: 'preparing',
          preparedManagedSnapshot: preparedManagedSnapshot(),
        }),
        candidate({
          id: 'candidate-missing-snapshot',
          reviewPreparationStatus: 'ready',
        }),
        candidate({
          id: 'candidate-ready',
          reviewPreparationStatus: 'ready',
          preparedManagedSnapshot: preparedManagedSnapshot(),
        }),
      ]}
      knowledgeBases={[knowledgeState()]}
      onReview={async () => undefined}
      projectId="project-1"
    />);

    expect(screen.getByRole('button', { name: 'Approve candidate-missing-status' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject candidate-missing-status' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Approve candidate-non-ready' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject candidate-non-ready' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Approve candidate-missing-snapshot' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject candidate-missing-snapshot' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Approve candidate-ready' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Reject candidate-ready' })).toBeEnabled();
  });

  it('omits evidence counts that are not present in the persisted candidate', () => {
    const persisted = skillPromotionCandidateSchema.parse(candidate({
      counts: { observationCount: 3 },
    }));

    render(<SkillCandidateReview
      candidates={[persisted]}
      knowledgeBases={[knowledgeState()]}
      onReview={async () => undefined}
      projectId="project-1"
    />);

    expect(screen.getByText('observations 3')).toBeVisible();
    expect(screen.queryByText(/supporting/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/contradicting/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/refs/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/citations/i)).not.toBeInTheDocument();
  });

  it('keeps rejected and rolled-back candidates visible for audit', () => {
    render(<SkillCandidateReview
      candidates={[
        candidate({ id: 'candidate-rejected', reviewStatus: 'rejected', reviewedAt: '2026-07-15T09:00:00.000Z' }),
        candidate({
          id: 'candidate-rolled-back',
          reviewStatus: 'rolled_back',
          reviewedAt: '2026-07-15T09:00:00.000Z',
          publishedKnowledgeVersion: 3,
          rolledBackAt: '2026-07-15T10:00:00.000Z',
        }),
      ]}
      knowledgeBases={[knowledgeState()]}
      onReview={async () => undefined}
      projectId="project-1"
    />);

    expect(screen.getByText('candidate-rejected')).toBeVisible();
    expect(screen.getByText('candidate-rolled-back')).toBeVisible();
    expect(screen.getByText('rejected')).toBeVisible();
    expect(screen.getByText('rolled_back')).toBeVisible();
  });
});

function candidate(overrides: Partial<SkillPromotionCandidate> = {}): SkillPromotionCandidate {
  return {
    schemaVersion: 1,
    id: 'candidate-1',
    sourceProjectId: 'project-1',
    sourceProjectMemoryId: 'memory-1',
    sourceProjectMemoryIds: ['memory-1'],
    createdAt: '2026-07-15T08:00:00.000Z',
    title: 'Quieter liquid motion',
    rationale: 'Feedback asks for calmer liquid arcs.',
    beforeRule: 'Use energetic splashes.',
    sourceRule: 'Source rule body: keep product identity from the local memory.',
    managedRule: 'Managed rule body: keep the current scene skill wording.',
    diffHunks: [
      '- Managed rule body: keep the current scene skill wording.',
      '+ Use slower, heavier liquid arcs around the product.',
    ],
    rule: 'Use slower, heavier liquid arcs around the product.',
    targetKnowledgeBaseId: 'scene-skill',
    targetKnowledgeSection: 'reverse-prompt/liquid',
    counts: {
      supportingMemoryCount: 2,
      referenceCount: 1,
      citationCount: 1,
      observationCount: 1,
    },
    confidence: 0.82,
    affectedCapabilities: ['reverse_prompt'],
    evidence: { keep: ['product'], change: ['liquid'], never: [] },
    reviewStatus: 'pending_review',
    ...overrides,
  };
}

function preparedManagedSnapshot(): NonNullable<SkillPromotionCandidate['preparedManagedSnapshot']> {
  return {
    knowledgeBaseId: 'scene-skill',
    version: 3,
    contentHash: 'c'.repeat(64),
  };
}

function knowledgeState(): KnowledgeBaseStateSummary {
  return {
    schemaVersion: 1,
    knowledgeBaseId: 'scene-skill',
    displayName: 'Scene Skill',
    status: 'active',
    activeVersion: 3,
    activeContentHash: 'c'.repeat(64),
    versionCount: 3,
    versions: [
      { version: 1, contentHash: 'a'.repeat(64), publishedAt: '2026-07-15T07:00:00.000Z', sourceDeviceId: 'device-a', displayName: 'Scene Skill' },
      { version: 2, contentHash: 'b'.repeat(64), publishedAt: '2026-07-15T08:00:00.000Z', sourceDeviceId: 'device-a', displayName: 'Scene Skill' },
      { version: 3, contentHash: 'c'.repeat(64), publishedAt: '2026-07-15T09:00:00.000Z', sourceDeviceId: 'device-a', displayName: 'Scene Skill' },
    ],
    lastFailure: null,
    lastRollbackAt: null,
  };
}
