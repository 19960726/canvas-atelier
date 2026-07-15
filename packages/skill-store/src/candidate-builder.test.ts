import { describe, expect, it } from 'vitest';
import { createAgentKnowledgeLease, parseCanvasProject, type ProjectMemoryEntry } from '@agent-canvas/domain';
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

  it('persists the builder inclusive aggregate source list through the project schema', () => {
    const first = feedback('feedback-a', { projectRevision: 1, change: ['add heavy liquid'] });
    const second = feedback('feedback-b', { projectRevision: 2, change: ['keep camera locked'] });
    const candidate = buildSkillPromotionCandidate([first, second], metadata());

    const project = parseCanvasProject({
      version: 1,
      id: 'project-1',
      name: 'Aggregated feedback project',
      nodes: [],
      edges: [],
      projectMemory: [first, second],
      skillPromotionCandidates: [candidate],
    });

    expect(project.skillPromotionCandidates[0]?.sourceProjectMemoryId).toBe(first.id);
    expect(project.skillPromotionCandidates[0]?.sourceProjectMemoryIds).toEqual([first.id, second.id]);
  });

  it('rejects true duplicates inside an aggregate source list', () => {
    const first = feedback('feedback-a', { projectRevision: 1, change: ['add heavy liquid'] });
    const second = feedback('feedback-b', { projectRevision: 2, change: ['keep camera locked'] });
    const candidate = buildSkillPromotionCandidate([first, second], metadata());

    expect(() => parseCanvasProject({
      version: 1,
      id: 'project-1',
      name: 'Duplicate aggregate feedback project',
      nodes: [],
      edges: [],
      projectMemory: [first, second],
      skillPromotionCandidates: [{
        ...candidate,
        sourceProjectMemoryIds: [first.id, second.id, second.id],
      }],
    })).toThrow(/unique/i);
  });

  it('rejects invalid or unsafe aggregation inputs through domain parsing', () => {
    const supportA = feedback('feedback-a', { change: ['add heavy liquid'] });

    expect(() => buildSkillPromotionCandidate([], metadata())).toThrow(/requires feedback/i);
    expect(() => buildSkillPromotionCandidate([supportA, { ...supportA }], metadata())).toThrow(/duplicate/i);
    expect(() => buildSkillPromotionCandidate([supportA, { ...supportA, id: 'other', projectId: 'project-2' }], metadata())).toThrow(/project/i);
    expect(() => buildSkillPromotionCandidate([{ ...supportA, nextStep: 'Read C:\\private\\notes.md' }], metadata())).toThrow(/private path/i);
  });

  it('selects active timeline evidence before deterministic output sorting', () => {
    const oldFeedback = feedback('feedback-old', {
      projectRevision: 3,
      createdAt: '2026-07-15T09:10:00.000Z',
      change: ['old thin splash rule'],
    });
    const replacement = feedback('feedback-replacement', {
      projectRevision: 4,
      createdAt: '2026-07-15T09:00:00.000Z',
      change: ['new heavy liquid rule'],
      supersedesMemoryId: oldFeedback.id,
    });
    const stable = feedback('feedback-stable', {
      projectRevision: 5,
      createdAt: '2026-07-15T09:05:00.000Z',
      change: ['keep camera locked'],
    });

    const candidate = buildSkillPromotionCandidate([oldFeedback, replacement, stable], metadata());

    expect(candidate.sourceProjectMemoryIds).toEqual(['feedback-replacement', 'feedback-stable']);
    expect(candidate.evidence.change).toEqual(['new heavy liquid rule', 'keep camera locked']);
    expect(candidate.counts?.supportingMemoryCount).toBe(2);
  });

  it('canonicalizes unordered evidence before selecting active timeline entries', () => {
    const oldFeedback = feedback('feedback-old', {
      projectRevision: 3,
      createdAt: '2026-07-15T09:10:00.000Z',
      change: ['old thin splash rule'],
    });
    const replacement = feedback('feedback-replacement', {
      projectRevision: 4,
      createdAt: '2026-07-15T09:00:00.000Z',
      change: ['new heavy liquid rule'],
      supersedesMemoryId: oldFeedback.id,
    });

    const candidate = buildSkillPromotionCandidate([replacement, oldFeedback], metadata());

    expect(candidate.sourceProjectMemoryIds).toEqual(['feedback-replacement']);
    expect(candidate.evidence.change).toEqual(['new heavy liquid rule']);
    expect(candidate.counts?.supportingMemoryCount).toBe(1);
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
      knowledgeLease: createAgentKnowledgeLease({
        runId: `run-${id}`,
        capability: 'skill_conversation',
        snapshots: [],
        references: [],
        citations: [],
      }, {
        leaseId: `lease-${id}`,
        createdAt: patch.createdAt ?? '2026-07-15T09:00:00.000Z',
      }),
      references: [],
      citations: [],
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
