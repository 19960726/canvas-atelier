import { describe, expect, it } from 'vitest';
import type { CanvasNode, CanvasProject } from './project-schema';
import type { ProjectMemoryEntry, SkillPromotionCandidate } from './project-memory';
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
    })).toThrow(/当前项目/);

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
        } as CanvasNode],
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
});
