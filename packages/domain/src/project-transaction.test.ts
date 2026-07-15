import { describe, expect, it } from 'vitest';
import { createAgentKnowledgeLease } from './knowledge-context';
import type { CanvasNode, CanvasProject } from './project-schema';
import { createSkillPromotionCandidate, createUserFeedbackMemory, reviewSkillPromotionCandidate, type ProjectMemoryEntry, type SkillPromotionCandidate } from './project-memory';
import { applyProjectTransaction } from './project-transaction';
import type { ProjectTransaction } from './project-transaction';

const project: CanvasProject = {
  version: 1,
  id: 'project-1',
  name: 'test project',
  nodes: [],
  edges: [],
  projectMemory: [],
  skillPromotionCandidates: [],
};

const updatedPrompt: CanvasNode = {
  id: 'prompt-1',
  type: 'prompt',
  position: { x: 320, y: 0 },
  data: { prompt: 'confirm agent plan', requirementIds: [] },
};

const optimizationMemory: ProjectMemoryEntry = {
  schemaVersion: 1,
  id: 'memory-1',
  projectId: 'project-1',
  projectRevision: 1,
  createdAt: '2026-07-14T02:00:00.000Z',
  kind: 'optimization',
  actor: 'agent',
  title: 'confirm agent plan',
  changeSummary: 'Updated the prompt to confirm the agent plan.',
  rationale: 'Keep the transaction atomic across project memory and canvas state.',
  snapshots: { beforeId: 'snapshot-before', afterId: 'snapshot-after' },
  context: { referenceAssetIds: [], resultAssetIds: [] },
  feedback: { keep: [], change: [], never: [] },
  nextStep: 'Review the saved project state.',
};

const candidate: SkillPromotionCandidate = {
  schemaVersion: 1,
  id: 'candidate-1',
  sourceProjectId: 'project-1',
  sourceProjectMemoryId: 'memory-1',
  createdAt: '2026-07-14T02:05:00.000Z',
  title: 'confirm agent plan',
  rationale: 'Keep the transaction atomic across project memory and canvas state.',
  rule: 'Review the saved project state.',
  evidence: { keep: [], change: [], never: [] },
  reviewStatus: 'pending_review',
};

function makeEmptyProject(): CanvasProject {
  return {
    version: 1,
    id: 'project-1',
    name: 'test project',
    nodes: [],
    edges: [],
    projectMemory: [],
    skillPromotionCandidates: [],
  };
}

describe('project transactions', () => {
  it('applies canvas, memory, and candidate changes atomically', () => {
    const transaction: ProjectTransaction = {
      id: 'tx-1',
      label: 'confirm agent plan',
      operations: [
        { kind: 'canvas', operation: { kind: 'update_node', node: updatedPrompt } },
        { kind: 'append_project_memory', entry: optimizationMemory },
        { kind: 'set_skill_candidates', candidates: [candidate] },
      ],
    };

    const result = applyProjectTransaction({
      ...project,
      nodes: [{ ...updatedPrompt, position: { x: 0, y: 0 } }],
    }, transaction);

    expect(result.nodes.find((node) => node.id === updatedPrompt.id)).toEqual(updatedPrompt);
    expect(result.projectMemory[result.projectMemory.length - 1]).toEqual(optimizationMemory);
    expect(result.skillPromotionCandidates).toEqual([candidate]);
  });

  it('applies feedback memory and reviewed candidate changes atomically', () => {
    const references = [{
      assetId: 'scene',
      label: 'Scene',
      role: 'scene_composition' as const,
      position: 0,
    }];
    const feedbackMemory = createUserFeedbackMemory({
      projectId: 'project-1',
      projectRevision: 2,
      title: 'Make liquid heavier',
      userRequest: 'Use thicker transparent liquid',
      correction: 'Reduce droplets',
      knowledgeLease: createAgentKnowledgeLease({
        runId: 'run-2',
        capability: 'image_generation',
        snapshots: [{
          knowledgeBaseId: 'kb-style',
          version: 4,
          contentHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        }],
        references,
        citations: [{ assetId: 'scene', label: 'Scene' }],
      }, {
        leaseId: 'lease-2',
        createdAt: '2026-07-15T10:00:00.000Z',
      }),
      references,
      citations: [{ assetId: 'scene', label: 'Scene' }],
      observations: {
        liquid: ['high viscosity'],
      },
      feedback: {
        keep: ['camera'],
        change: ['liquid'],
        never: ['fast splash'],
      },
    }, {
      memoryId: 'feedback-1',
      createdAt: '2026-07-15T10:01:00.000Z',
      snapshots: {
        beforeId: 'snapshot-feedback-before',
        afterId: 'snapshot-feedback-after',
      },
    });
    const reviewedCandidate = reviewSkillPromotionCandidate(createSkillPromotionCandidate(feedbackMemory, {
      candidateId: 'candidate-feedback-1',
      createdAt: '2026-07-15T10:02:00.000Z',
    }), {
      decision: 'approved',
      reviewedAt: '2026-07-15T10:03:00.000Z',
      publishedKnowledgeVersion: 7,
    });

    const result = applyProjectTransaction(makeEmptyProject(), {
      id: 'tx-feedback-review',
      label: 'append feedback memory',
      operations: [
        { kind: 'append_project_memory', entry: feedbackMemory },
        { kind: 'set_skill_candidates', candidates: [reviewedCandidate] },
      ],
    });

    expect(result.projectMemory).toEqual([feedbackMemory]);
    expect(result.skillPromotionCandidates[0]?.reviewStatus).toBe('approved');
    expect(result.skillPromotionCandidates[0]?.publishedKnowledgeVersion).toBe(7);
  });

  it('rejects a cross-project memory append on an empty timeline without changing the project', () => {
    const original = makeEmptyProject();
    const mismatchedEntry: ProjectMemoryEntry = {
      ...optimizationMemory,
      id: 'memory-cross-project',
      projectId: 'project-2',
    };

    expect(() => applyProjectTransaction(original, {
      id: 'tx-cross-project',
      label: 'cross project memory',
      operations: [{ kind: 'append_project_memory', entry: mismatchedEntry }],
    })).toThrow();

    expect(original).toEqual(makeEmptyProject());
  });

  it('rejects the whole transaction when one operation is invalid', () => {
    expect(() => applyProjectTransaction(project, {
      id: 'tx-invalid',
      label: 'invalid mixed change',
      operations: [
        { kind: 'append_project_memory', entry: optimizationMemory },
        { kind: 'canvas', operation: { kind: 'delete_node', nodeId: 'missing' } },
      ],
    })).toThrow(/does not exist/);

    expect(project.projectMemory).toEqual([]);
  });

  it('replaces canvas state while preserving project memory and skill candidates', () => {
    const original = {
      ...makeEmptyProject(),
      nodes: [updatedPrompt],
      projectMemory: [optimizationMemory],
      skillPromotionCandidates: [candidate],
    };

    const replacementNode: CanvasNode = {
      ...updatedPrompt,
      id: 'prompt-2',
      data: { ...updatedPrompt.data, prompt: 'replace canvas state' },
    };
    const replacementEdge = {
      id: 'edge-1',
      source: replacementNode.id,
      target: replacementNode.id,
    };

    const result = applyProjectTransaction(original, {
      id: 'tx-replace-canvas',
      label: 'replace canvas state',
      operations: [{
        kind: 'replace_canvas_state',
        nodes: [replacementNode],
        edges: [replacementEdge],
      }],
    });

    expect(result.nodes).toEqual([replacementNode]);
    expect(result.edges).toEqual([replacementEdge]);
    expect(result.projectMemory).toEqual([optimizationMemory]);
    expect(result.skillPromotionCandidates).toEqual([candidate]);
    expect(original).toEqual({
      ...makeEmptyProject(),
      nodes: [updatedPrompt],
      projectMemory: [optimizationMemory],
      skillPromotionCandidates: [candidate],
    });
  });

  it('rejects an invalid canvas replacement atomically', () => {
    const original = {
      ...makeEmptyProject(),
      nodes: [updatedPrompt],
      projectMemory: [optimizationMemory],
      skillPromotionCandidates: [candidate],
    };

    expect(() => applyProjectTransaction(original, {
      id: 'tx-replace-invalid',
      label: 'invalid replace canvas state',
      operations: [{
        kind: 'replace_canvas_state',
        nodes: [{
          id: 'broken-node',
          type: 'prompt',
          data: { prompt: 'replace canvas state', requirementIds: [] },
        } as unknown as CanvasNode],
        edges: [],
      }],
    })).toThrow();

    expect(original).toEqual({
      ...makeEmptyProject(),
      nodes: [updatedPrompt],
      projectMemory: [optimizationMemory],
      skillPromotionCandidates: [candidate],
    });
  });

  it('rejects a canvas replacement with a dangling edge atomically', () => {
    const original = {
      ...makeEmptyProject(),
      nodes: [updatedPrompt],
      projectMemory: [optimizationMemory],
      skillPromotionCandidates: [candidate],
    };

    expect(() => applyProjectTransaction(original, {
      id: 'tx-replace-dangling-edge',
      label: 'dangling edge replacement',
      operations: [{
        kind: 'replace_canvas_state',
        nodes: [updatedPrompt],
        edges: [{
          id: 'edge-dangling',
          source: updatedPrompt.id,
          target: 'missing-node',
        }],
      }],
    })).toThrow(/edge target does not exist/);

    expect(original).toEqual({
      ...makeEmptyProject(),
      nodes: [updatedPrompt],
      projectMemory: [optimizationMemory],
      skillPromotionCandidates: [candidate],
    });
  });

  it('rejects a canvas replacement with duplicate node ids atomically', () => {
    const original = {
      ...makeEmptyProject(),
      nodes: [updatedPrompt],
      projectMemory: [optimizationMemory],
      skillPromotionCandidates: [candidate],
    };

    expect(() => applyProjectTransaction(original, {
      id: 'tx-replace-duplicate-node',
      label: 'duplicate node replacement',
      operations: [{
        kind: 'replace_canvas_state',
        nodes: [
          updatedPrompt,
          {
            ...updatedPrompt,
            position: { x: 640, y: 0 },
          },
        ],
        edges: [],
      }],
    })).toThrow(/duplicate node id/);

    expect(original).toEqual({
      ...makeEmptyProject(),
      nodes: [updatedPrompt],
      projectMemory: [optimizationMemory],
      skillPromotionCandidates: [candidate],
    });
  });

  it('rejects a canvas replacement with duplicate edge ids atomically', () => {
    const secondPrompt: CanvasNode = {
      id: 'prompt-2',
      type: 'prompt',
      position: { x: 640, y: 0 },
      data: { prompt: 'replace canvas state', requirementIds: [] },
    };

    const original = {
      ...makeEmptyProject(),
      nodes: [updatedPrompt, secondPrompt],
      projectMemory: [optimizationMemory],
      skillPromotionCandidates: [candidate],
    };

    expect(() => applyProjectTransaction(original, {
      id: 'tx-replace-duplicate-edge',
      label: 'duplicate edge replacement',
      operations: [{
        kind: 'replace_canvas_state',
        nodes: original.nodes,
        edges: [
          {
            id: 'edge-duplicate',
            source: updatedPrompt.id,
            target: 'prompt-2',
          },
          {
            id: 'edge-duplicate',
            source: 'prompt-2',
            target: updatedPrompt.id,
          },
        ],
      }],
    })).toThrow(/duplicate edge id/);

    expect(original).toEqual({
      ...makeEmptyProject(),
      nodes: [updatedPrompt, secondPrompt],
      projectMemory: [optimizationMemory],
      skillPromotionCandidates: [candidate],
    });
  });
});
