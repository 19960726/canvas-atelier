import { describe, expect, it } from 'vitest';
import type { CanvasProject } from './project-schema';
import type { AgentCanvasPlan } from './agent-plan';
import { cancelAgentPlan, confirmAgentPlan, validateAgentPlan } from './agent-plan';

const project: CanvasProject = {
  version: 1,
  id: 'p1',
  name: 'Agent project',
  nodes: [],
  edges: [],
  projectMemory: [],
  skillPromotionCandidates: [],
};

function createPlan(overrides: Partial<AgentCanvasPlan> = {}): AgentCanvasPlan {
  return {
    id: 'plan-1',
    state: 'waiting_for_confirmation',
    transaction: {
      id: 'tx-plan-1',
      label: 'Agent 创建方案',
      operations: [{
        kind: 'create_node',
        node: {
          id: 'review-1',
          type: 'review',
          position: { x: 320, y: 220 },
          data: { keep: ['产品身份'], change: ['场景'], never: [] },
        },
      }],
    },
    requestedCapabilities: ['model_execution'],
    confirmations: {},
    conflicts: [],
    modelRoute: 'comfly/image',
    jobCount: 1,
    ...overrides,
  };
}

describe('validateAgentPlan', () => {
  it('allows preview but blocks transaction and models before confirmation', () => {
    expect(validateAgentPlan(createPlan())).toMatchObject({
      canPreview: true,
      canApplyTransaction: false,
      canExecuteModels: false,
    });
  });

  it('allows transaction and models after their explicit confirmations', () => {
    expect(validateAgentPlan(createPlan({
      confirmations: {
        canvas: '2026-07-13T10:00:00.000Z',
        models: '2026-07-13T10:00:00.000Z',
      },
    }))).toMatchObject({
      canApplyTransaction: true,
      canExecuteModels: true,
      blockedCapabilities: [],
    });
  });

  it('blocks deletion without separate confirmation', () => {
    const guardedPlan = createPlan({
      transaction: {
        id: 'tx-delete',
        label: '删除节点',
        operations: [{ kind: 'delete_node', nodeId: 'node-1' }],
      },
      requestedCapabilities: ['delete_nodes'],
      confirmations: { canvas: '2026-07-13T10:00:00.000Z' },
    });

    expect(validateAgentPlan(guardedPlan)).toMatchObject({
      canApplyTransaction: false,
      blockedCapabilities: ['delete_nodes'],
    });
  });
  it('allows canvas application while keeping Skill writeback separately blocked', () => {
    const guardedPlan = createPlan({
      requestedCapabilities: ['skill_writeback'],
      confirmations: { canvas: '2026-07-13T10:00:00.000Z' },
    });

    expect(validateAgentPlan(guardedPlan)).toMatchObject({
      canApplyTransaction: true,
      canWritebackSkill: false,
      blockedCapabilities: ['skill_writeback'],
    });
  });
  it('requires deletion approval for delete_edge operations', () => {
    const guardedPlan = createPlan({
      transaction: { id: 'tx-edge-delete', label: '删除连线', operations: [{ kind: 'delete_edge', edgeId: 'edge-1' }] },
      requestedCapabilities: [],
      confirmations: { canvas: '2026-07-13T10:00:00.000Z' },
    });
    expect(validateAgentPlan(guardedPlan)).toMatchObject({ canApplyTransaction: false, blockedCapabilities: ['delete_nodes'] });
  });
});

describe('confirmAgentPlan', () => {
  it('applies one transaction, returns one inverse, and cannot be confirmed twice', () => {
    const confirmed = createPlan({
      confirmations: { canvas: '2026-07-13T10:00:00.000Z' },
    });
    const result = confirmAgentPlan(project, confirmed);

    expect(result.project.nodes).toHaveLength(1);
    expect(result.inverse.operations).toHaveLength(1);
    expect(result.plan.state).toBe('reviewing_results');
    expect(() => confirmAgentPlan(result.project, result.plan)).toThrow(/waiting_for_confirmation/);
  });

  it('cancels back to idle without applying operations', () => {
    expect(cancelAgentPlan(createPlan())).toMatchObject({ state: 'idle', confirmations: {} });
  });
  it('records model approval without claiming models are already running', () => {
    const confirmed = createPlan({
      confirmations: {
        canvas: '2026-07-13T10:00:00.000Z',
        models: '2026-07-13T10:00:00.000Z',
      },
    });
    const result = confirmAgentPlan(project, confirmed);

    expect(result.executeModels).toBe(true);
    expect(result.plan.state).toBe('reviewing_results');
  });
});