import { describe, expect, it } from 'vitest';
import {
  appendProjectMemoryEntry,
  buildProjectMemoryContext,
  createUserFeedbackMemory,
  createSkillPromotionCandidate,
  parseProjectMemoryEntry,
  reviewSkillPromotionCandidate,
  rollbackSkillPromotionCandidate,
  type ProjectMemoryEntry,
} from './project-memory';
import { createAgentKnowledgeLease, type OrderedReference } from './knowledge-context';

const feedbackReferences: OrderedReference[] = [{
  assetId: 'scene',
  label: 'Scene',
  role: 'scene_composition',
  position: 0,
}];

const feedbackLease = createAgentKnowledgeLease({
  runId: 'run-1',
  capability: 'image_generation',
  snapshots: [{
    knowledgeBaseId: 'kb-style',
    version: 4,
    contentHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  }],
  references: feedbackReferences,
  citations: [{ assetId: 'scene', label: 'Scene' }],
}, {
  leaseId: 'lease-1',
  createdAt: '2026-07-15T10:00:00.000Z',
});

const feedbackSnapshots = {
  beforeId: 'snapshot-feedback-before',
  afterId: 'snapshot-feedback-after',
};

const optimization: ProjectMemoryEntry = {
  schemaVersion: 1,
  id: 'memory-optimization-1',
  projectId: 'project-1',
  projectRevision: 12,
  createdAt: '2026-07-13T13:00:00.000Z',
  kind: 'optimization',
  actor: 'agent',
  title: 'Adjust product composition',
  changeSummary: 'Scale the product up and reduce background contrast.',
  rationale: 'Keep the hero product legible without crowding the copy-safe area.',
  snapshots: { beforeId: 'snapshot-11', afterId: 'snapshot-12' },
  context: {
    modelId: 'vision-model',
    prompt: 'premium ecommerce hero shot',
    referenceAssetIds: ['product-ref', 'scene-ref'],
    resultAssetIds: ['result-12'],
  },
  feedback: {
    keep: ['package proportions'],
    change: ['background brightness'],
    never: ['change the logo'],
    score: 4,
  },
  nextStep: 'Lower the highlight intensity and generate again.',
};

describe('project memory', () => {
  it('appends optimization memory without mutating the previous timeline', () => {
    const timeline: ProjectMemoryEntry[] = [];
    const next = appendProjectMemoryEntry(timeline, optimization);

    expect(timeline).toEqual([]);
    expect(next).toEqual([optimization]);
  });

  it('rejects duplicate ids and a revision that moves backwards', () => {
    expect(() => appendProjectMemoryEntry([optimization], optimization)).toThrow(/unique/i);
    expect(() => appendProjectMemoryEntry([optimization], {
      ...optimization,
      id: 'memory-optimization-2',
      projectRevision: 11,
    })).toThrow(/backwards/i);
  });

  it('rejects secrets, private paths, and raw images from project memory', () => {
    expect(() => parseProjectMemoryEntry({ ...optimization, apiKey: 'secret' })).toThrow();
    expect(() => parseProjectMemoryEntry({
      ...optimization,
      context: { ...optimization.context, prompt: 'D:\\private\\asset.png' },
    })).toThrow(/private path/i);
    expect(() => parseProjectMemoryEntry({
      ...optimization,
      context: { ...optimization.context, rawImageBase64: 'AAAA' },
    })).toThrow();
    expect(() => parseProjectMemoryEntry({
      ...optimization,
      context: { ...optimization.context, prompt: 'asset lives at D:\\private\\asset.png' },
    })).toThrow(/private path/i);
    expect(() => parseProjectMemoryEntry({
      ...optimization,
      context: { ...optimization.context, prompt: 'Authorization: Bearer secret-token-value' },
    })).toThrow(/sensitive credential/i);
    expect(() => parseProjectMemoryEntry({
      ...optimization,
      context: { ...optimization.context, prompt: 'provider key sk-project-secret1234' },
    })).toThrow(/sensitive credential/i);
    expect(() => parseProjectMemoryEntry({
      ...optimization,
      context: { ...optimization.context, prompt: 'asset lives at C:/Users/name/key.txt' },
    })).toThrow(/private path/i);
    expect(() => parseProjectMemoryEntry({
      ...optimization,
      context: { ...optimization.context, prompt: '%USERPROFILE%\\private\\key.txt' },
    })).toThrow(/private path/i);
    expect(() => parseProjectMemoryEntry({
      ...optimization,
      context: { ...optimization.context, prompt: 'Authorization: Basic Zm9vOmJhcg==' },
    })).toThrow(/sensitive credential/i);
    expect(() => parseProjectMemoryEntry({
      ...optimization,
      context: { ...optimization.context, prompt: 'token=ghp_1234567890abcdefghijklmnop' },
    })).toThrow(/sensitive credential/i);
  });

  it('builds a bounded newest-first context for the Agent', () => {
    const second = {
      ...optimization,
      id: 'memory-optimization-2',
      projectRevision: 13,
      createdAt: '2026-07-13T14:00:00.000Z',
      title: 'Second optimization',
    };

    expect(buildProjectMemoryContext([optimization, second], 1)).toEqual([second]);
  });

  it('excludes a superseded optimization from future Agent context', () => {
    const revertDecision: ProjectMemoryEntry = {
      ...optimization,
      id: 'memory-revert-1',
      projectRevision: 13,
      createdAt: '2026-07-13T14:00:00.000Z',
      kind: 'decision',
      actor: 'user',
      title: 'Undo optimization',
      changeSummary: 'Undo the previously approved canvas change.',
      rationale: 'The user explicitly rolled the change back.',
      snapshots: { beforeId: 'snapshot-12', afterId: 'snapshot-13' },
      supersedesMemoryId: optimization.id,
      nextStep: 'Continue from the reverted canvas state.',
    };

    expect(buildProjectMemoryContext([optimization, revertDecision])).toEqual([revertDecision]);
  });

  it('reactivates memory when a later restore supersedes the earlier restore decision', () => {
    const second = { ...optimization, id: 'memory-2', projectRevision: 13, createdAt: '2026-07-13T14:00:00.000Z', title: 'Second optimization' };
    const firstRestore: ProjectMemoryEntry = {
      ...optimization,
      id: 'restore-1',
      projectRevision: 14,
      createdAt: '2026-07-13T15:00:00.000Z',
      kind: 'decision',
      actor: 'user',
      title: 'Restore the first optimization',
      supersedesMemoryIds: [second.id],
    };
    const secondRestore: ProjectMemoryEntry = {
      ...firstRestore,
      id: 'restore-2',
      projectRevision: 15,
      createdAt: '2026-07-13T16:00:00.000Z',
      title: 'Restore the second optimization',
      supersedesMemoryIds: [firstRestore.id],
    };

    expect(buildProjectMemoryContext([optimization, second, firstRestore, secondRestore]).map((entry) => entry.id)).toEqual([
      secondRestore.id,
      second.id,
      optimization.id,
    ]);
  });

  it('promotes project experience only as a pending Skill candidate', () => {
    expect(createSkillPromotionCandidate(optimization, {
      candidateId: 'skill-candidate-1',
      createdAt: '2026-07-13T15:00:00.000Z',
    })).toMatchObject({
      id: 'skill-candidate-1',
      sourceProjectMemoryId: optimization.id,
      reviewStatus: 'pending_review',
      rule: optimization.nextStep,
    });
  });

  it('records feedback with lease and visual observations', () => {
    const memory = createUserFeedbackMemory({
      projectId: 'project-1',
      projectRevision: 4,
      title: 'Make liquid heavier',
      userRequest: 'Use thicker transparent liquid',
      correction: 'Reduce droplets',
      knowledgeLease: feedbackLease,
      references: feedbackReferences,
      citations: [{ assetId: 'scene', label: 'Scene' }],
      observations: {
        liquid: ['high viscosity'],
        vfx: ['small rim particles'],
      },
      feedback: {
        keep: ['camera'],
        change: ['liquid'],
        never: ['fast splash'],
      },
    }, {
      memoryId: 'feedback-1',
      createdAt: '2026-07-15T10:01:00.000Z',
      snapshots: feedbackSnapshots,
    });

    expect(memory.kind).toBe('user_feedback');
    expect(memory.snapshots).toEqual(feedbackSnapshots);
    expect(memory.context.knowledgeLease?.leaseId).toBe('lease-1');
    expect(memory.context.references).toEqual(feedbackReferences);
    expect(memory.context.citations).toEqual([{ assetId: 'scene', label: 'Scene' }]);
    expect(memory.context.referenceAssetIds).toEqual(['scene']);
    expect(memory.observations).toEqual({
      liquid: ['high viscosity'],
      vfx: ['small rim particles'],
    });
  });

  it('sanitizes feedback observations through project-memory validation', () => {
    expect(() => createUserFeedbackMemory({
      projectId: 'project-1',
      projectRevision: 4,
      title: 'Unsafe feedback',
      userRequest: 'Keep the scene',
      correction: 'Remove secrets',
      knowledgeLease: feedbackLease,
      references: feedbackReferences,
      citations: [{ assetId: 'scene', label: 'Scene' }],
      observations: {
        liquid: ['C:\\private\\asset.png'],
      },
      feedback: {
        keep: ['camera'],
        change: ['liquid'],
        never: ['fast splash'],
      },
    }, {
      memoryId: 'feedback-secret',
      createdAt: '2026-07-15T10:02:00.000Z',
      snapshots: feedbackSnapshots,
    })).toThrow(/private path/i);
  });

  it('approves and rolls back without losing provenance', () => {
    const candidate = createSkillPromotionCandidate(optimization, {
      candidateId: 'skill-candidate-2',
      createdAt: '2026-07-15T10:03:00.000Z',
    });
    const reviewedAt = '2026-07-15T10:04:00.000Z';
    const rolledBackAt = '2026-07-15T10:05:00.000Z';

    const approved = reviewSkillPromotionCandidate(candidate, {
      decision: 'approved',
      reviewedAt,
      publishedKnowledgeVersion: 5,
      transactionId: 'review-transaction-1',
    });

    expect(approved.reviewStatus).toBe('approved');
    expect(approved.reviewedAt).toBe(reviewedAt);
    expect(approved.publishedKnowledgeVersion).toBe(5);
    expect(approved.reviewTransactionId).toBe('review-transaction-1');

    const rolledBack = rollbackSkillPromotionCandidate(approved, rolledBackAt, {
      transactionId: 'rollback-transaction-1',
    });

    expect(rolledBack.reviewStatus).toBe('rolled_back');
    expect(rolledBack.reviewedAt).toBe(reviewedAt);
    expect(rolledBack.publishedKnowledgeVersion).toBe(5);
    expect(rolledBack.rolledBackAt).toBe(rolledBackAt);
    expect(rolledBack.reviewTransactionId).toBe('rollback-transaction-1');
    expect(() => rollbackSkillPromotionCandidate(candidate, rolledBackAt)).toThrow(/approved/i);
  });
});
