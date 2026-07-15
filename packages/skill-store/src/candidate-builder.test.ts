import { describe, expect, it } from 'vitest';
import type { ProjectMemoryEntry } from '@agent-canvas/domain';
import { buildSkillPromotionCandidate } from './candidate-builder';

const now = '2026-07-15T10:00:00.000Z';

describe('buildSkillPromotionCandidate', () => {
  it('aggregates evidence without auto-approval', () => {
    const candidate = buildSkillPromotionCandidate([
      feedback('feedback-b', { createdAt: '2026-07-15T09:02:00.000Z', change: ['add heavy liquid'] }),
      feedback('feedback-a', { createdAt: '2026-07-15T09:01:00.000Z', change: ['keep bottle upright'] }),
      feedback('feedback-c', { createdAt: '2026-07-15T09:03:00.000Z', never: ['add heavy liquid'] }),
    ], {
      candidateId: 'candidate-1',
      targetKnowledgeBaseId: 'scene-skill',
      targetSection: 'reverse-prompt/liquid',
      createdAt: now,
      affectedCapabilities: ['reverse_prompt', 'image_generation'],
    });

    expect(candidate).toMatchObject({
      id: 'candidate-1',
      reviewStatus: 'pending_review',
      targetKnowledgeBaseId: 'scene-skill',
      targetKnowledgeSection: 'reverse-prompt/liquid',
      supportingEvidenceCount: 2,
      contradictingEvidenceCount: 1,
      counts: {
        supportingMemoryCount: 2,
      },
      confidence: 2 / 3,
      affectedCapabilities: ['reverse_prompt', 'image_generation'],
    });
    expect(candidate.sourceProjectMemoryIds).toEqual(['feedback-a', 'feedback-b', 'feedback-c']);
    expect(candidate.evidence.change).toEqual(['keep bottle upright', 'add heavy liquid']);
    expect(candidate.evidence.never).toEqual(['add heavy liquid']);
    expect(candidate).not.toHaveProperty('reviewedAt');
    expect(candidate).not.toHaveProperty('publishedKnowledgeVersion');
  });

  it('rejects invalid or unsafe aggregation inputs through domain parsing', () => {
    const supportA = feedback('feedback-a', { change: ['add heavy liquid'] });
    const superseded = feedback('feedback-b', { supersedesMemoryId: supportA.id, change: ['replace older evidence'] });

    expect(() => buildSkillPromotionCandidate([], metadata())).toThrow(/requires feedback/i);
    expect(() => buildSkillPromotionCandidate([supportA, { ...supportA }], metadata())).toThrow(/duplicate/i);
    expect(() => buildSkillPromotionCandidate([supportA, { ...supportA, id: 'other', projectId: 'project-2' }], metadata())).toThrow(/project/i);
    expect(() => buildSkillPromotionCandidate([supportA, superseded], metadata())).toThrow(/inactive|superseded/i);
    expect(() => buildSkillPromotionCandidate([{ ...supportA, nextStep: 'Read C:\\private\\notes.md' }], metadata())).toThrow(/private path/i);
  });
});

function metadata() {
  return {
    candidateId: 'candidate-1',
    targetKnowledgeBaseId: 'scene-skill',
    targetSection: 'reverse-prompt/liquid',
    createdAt: now,
  };
}

function feedback(id: string, patch: Partial<ProjectMemoryEntry> & { change?: string[]; never?: string[] } = {}): ProjectMemoryEntry {
  return {
    schemaVersion: 1,
    id,
    projectId: patch.projectId ?? 'project-1',
    projectRevision: patch.projectRevision ?? Number(id.replace(/\D/g, '') || 1),
    createdAt: patch.createdAt ?? '2026-07-15T09:00:00.000Z',
    kind: 'user_feedback',
    actor: 'user',
    title: patch.title ?? `Feedback ${id}`,
    changeSummary: patch.changeSummary ?? 'Tune scene generation.',
    rationale: patch.rationale ?? 'The generated image needs a more reliable scene rule.',
    snapshots: patch.snapshots ?? { beforeId: `${id}-before`, afterId: `${id}-after` },
    context: patch.context ?? {
      prompt: 'generate liquid product scene',
      referenceAssetIds: [],
      resultAssetIds: [],
    },
    feedback: patch.feedback ?? {
      keep: ['product identity'],
      change: patch.change ?? [],
      never: patch.never ?? [],
      score: 4,
    },
    observations: patch.observations,
    nextStep: patch.nextStep ?? (patch.change?.[0] ?? 'Preserve product identity while improving the liquid.'),
    supersedesMemoryId: patch.supersedesMemoryId,
    supersedesMemoryIds: patch.supersedesMemoryIds,
  };
}
