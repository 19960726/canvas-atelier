import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProjectMemoryContext } from '@agent-canvas/domain';
import { createStarterProject, useAppStore } from './app-store';
import { loadPersistedProjectBundle } from './project-persistence';

describe('project optimization memory', () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({
      project: createStarterProject(),
      agentPlan: null,
      undoStack: [],
      confirmedModelJobs: 0,
    });
  });

  it('records a durable project-memory entry when an Agent canvas optimization is confirmed', () => {
    useAppStore.getState().draftAgentPlan('放大产品并保留顶部文案安全区');
    useAppStore.getState().confirmAgentPlan({ models: false, deleteNodes: false, skillWriteback: false });

    const memory = useAppStore.getState().project.projectMemory;
    expect(memory).toHaveLength(1);
    expect(memory[0]).toMatchObject({
      kind: 'optimization',
      actor: 'agent',
      projectId: 'local-project',
      title: 'Agent 画布优化',
      context: {
        prompt: '放大产品并保留顶部文案安全区',
      },
      feedback: {
        keep: ['产品身份与 Logo'],
        change: ['场景、光线与道具'],
        never: ['未经确认执行模型'],
      },
    });
    expect(memory[0]?.snapshots.beforeId).not.toBe(memory[0]?.snapshots.afterId);
  });

  it('persists the confirmed project and real before/after snapshots for reopening', () => {
    useAppStore.getState().draftAgentPlan('建立可恢复的项目记忆');
    useAppStore.getState().confirmAgentPlan({ models: false, deleteNodes: false, skillWriteback: false });

    const persisted = loadPersistedProjectBundle();
    const memory = persisted?.current.projectMemory[0];
    expect(persisted?.current.projectMemory).toHaveLength(1);
    expect(persisted?.snapshots.map((snapshot) => snapshot.id)).toEqual(expect.arrayContaining([
      memory?.snapshots.beforeId,
      memory?.snapshots.afterId,
    ]));
  });

  it('records undo as a superseding decision and excludes the reverted optimization from Agent context', () => {
    useAppStore.getState().draftAgentPlan('稍后撤销这次优化');
    useAppStore.getState().confirmAgentPlan({ models: false, deleteNodes: false, skillWriteback: false });
    const optimizationId = useAppStore.getState().project.projectMemory[0]!.id;

    useAppStore.getState().undo();

    const timeline = useAppStore.getState().project.projectMemory;
    expect(timeline).toHaveLength(2);
    expect(timeline[1]).toMatchObject({ kind: 'decision', supersedesMemoryId: optimizationId });
    expect(buildProjectMemoryContext(timeline).map((entry) => entry.id)).toEqual([timeline[1]!.id]);
  });

  it('cancels a stale delayed save before persisting a confirmed Agent transition', () => {
    vi.useFakeTimers();
    const edited = { ...createStarterProject(), name: '延迟保存旧状态' };
    useAppStore.getState().setProject(edited);
    useAppStore.getState().draftAgentPlan('确认后的新状态不能被旧定时器覆盖');
    useAppStore.getState().confirmAgentPlan({ models: false, deleteNodes: false, skillWriteback: false });

    vi.advanceTimersByTime(600);

    expect(loadPersistedProjectBundle()?.current.projectMemory).toHaveLength(1);
  });

  it('persists a project-memory promotion as pending review without writing Skill knowledge', () => {
    useAppStore.getState().draftAgentPlan('沉淀一条可复用经验');
    useAppStore.getState().confirmAgentPlan({ models: false, deleteNodes: false, skillWriteback: false });
    const memoryId = useAppStore.getState().project.projectMemory[0]!.id;

    useAppStore.getState().promoteProjectMemory(memoryId);

    expect(useAppStore.getState().project.skillPromotionCandidates).toMatchObject([{
      sourceProjectMemoryId: memoryId,
      reviewStatus: 'pending_review',
    }]);
    expect(loadPersistedProjectBundle()?.current.skillPromotionCandidates).toHaveLength(1);
  });

  it('restores a durable snapshot while retaining the audit timeline', () => {
    useAppStore.getState().draftAgentPlan('这次改动稍后从快照恢复');
    useAppStore.getState().confirmAgentPlan({ models: false, deleteNodes: false, skillWriteback: false });
    const optimization = useAppStore.getState().project.projectMemory[0]!;
    useAppStore.getState().promoteProjectMemory(optimization.id);

    useAppStore.getState().restoreProjectSnapshot(optimization.snapshots.beforeId);

    const project = useAppStore.getState().project;
    const prompt = project.nodes.find((node) => node.type === 'prompt');
    expect(prompt?.type === 'prompt' ? prompt.data.prompt : '').toBe('等待确认后执行模型任务');
    expect(project.projectMemory).toHaveLength(2);
    expect(project.projectMemory[1]).toMatchObject({ kind: 'decision', title: '恢复项目快照' });
    expect(project.skillPromotionCandidates).toEqual([]);
    expect(loadPersistedProjectBundle()?.current.projectMemory).toHaveLength(2);
  });

  it('does not promote a superseded optimization or a decision into Skill knowledge', () => {
    useAppStore.getState().draftAgentPlan('这条优化随后会撤销');
    useAppStore.getState().confirmAgentPlan({ models: false, deleteNodes: false, skillWriteback: false });
    const optimizationId = useAppStore.getState().project.projectMemory[0]!.id;
    useAppStore.getState().undo();
    const decisionId = useAppStore.getState().project.projectMemory[1]!.id;

    useAppStore.getState().promoteProjectMemory(optimizationId);
    useAppStore.getState().promoteProjectMemory(decisionId);

    expect(useAppStore.getState().project.skillPromotionCandidates).toEqual([]);
  });

  it('removes a pending Skill candidate when its source optimization is undone', () => {
    useAppStore.getState().draftAgentPlan('先提升再撤销');
    useAppStore.getState().confirmAgentPlan({ models: false, deleteNodes: false, skillWriteback: false });
    const optimizationId = useAppStore.getState().project.projectMemory[0]!.id;
    useAppStore.getState().promoteProjectMemory(optimizationId);

    useAppStore.getState().undo();

    expect(useAppStore.getState().project.skillPromotionCandidates).toEqual([]);
    expect(loadPersistedProjectBundle()?.current.skillPromotionCandidates).toEqual([]);
  });
  it('removes a pending Skill candidate whose active source is not promotable', () => {
    useAppStore.getState().draftAgentPlan('创建一条随后撤销的优化');
    useAppStore.getState().confirmAgentPlan({ models: false, deleteNodes: false, skillWriteback: false });
    useAppStore.getState().undo();
    useAppStore.getState().draftAgentPlan('触发下一次可撤销优化');
    useAppStore.getState().confirmAgentPlan({ models: false, deleteNodes: false, skillWriteback: false });
    const project = useAppStore.getState().project;
    const decision = project.projectMemory[1]!;
    useAppStore.getState().setProject({
      ...project,
      skillPromotionCandidates: [{
        schemaVersion: 1,
        id: 'candidate-from-decision',
        sourceProjectId: project.id,
        sourceProjectMemoryId: decision.id,
        createdAt: '2026-07-14T03:00:00.000Z',
        title: decision.title,
        rationale: decision.rationale,
        rule: decision.nextStep,
        evidence: decision.feedback,
        reviewStatus: 'pending_review',
      }],
    });

    useAppStore.getState().undo();

    expect(useAppStore.getState().project.skillPromotionCandidates).toEqual([]);
  });
});
