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
});
