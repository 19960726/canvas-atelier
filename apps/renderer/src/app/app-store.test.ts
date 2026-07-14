import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommitAck } from '@agent-canvas/desktop-core';
import { buildProjectMemoryContext } from '@agent-canvas/domain';
import type { ProjectTransaction } from '@agent-canvas/domain';
import {
  createStarterProject,
  replaceProjectPersistenceClientForTests,
  resetAppStoreForTests,
  useAppStore,
} from './app-store';
import { createBrowserPersistenceClient } from './desktop-persistence';
import type {
  ProjectCommitRequest,
  ProjectCommitResult,
  ProjectPersistenceClient,
} from './desktop-persistence';
import { PROJECT_STORAGE_KEY, loadPersistedProjectBundle } from './project-persistence';

describe('project optimization memory', () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    delete window.novusDesktop;
    localStorage.clear();
    replaceProjectPersistenceClientForTests(createImmediateBrowserClient());
    resetAppStoreForTests();
  });

  it('shows saved only after desktop acknowledgement', async () => {
    const transaction: ProjectTransaction = {
      id: 'tx-await-ack',
      label: 'Update prompt after desktop ack',
      operations: [{
        kind: 'canvas',
        operation: {
          kind: 'update_node',
          node: {
            ...createStarterProject().nodes.find((node) => node.type === 'prompt')!,
            data: { prompt: 'ACK gated prompt', requirementIds: [] },
          },
        },
      }],
    };
    const ack = deferred<CommitAck>();
    replaceProjectPersistenceClientForTests(createMockClient({
      commit: vi.fn().mockReturnValue(ack.promise),
    }));
    resetAppStoreForTests();

    const pending = useAppStore.getState().commitProjectTransaction(transaction, { kind: 'canvas' });

    expect(useAppStore.getState().saveStatus).toBe('saving');

    ack.resolve({
      committedAt: '2026-07-14T03:00:00.000Z',
      projectId: 'local-project',
      revision: 4,
      sequence: 4,
      transactionId: transaction.id,
    });

    await pending;

    expect(useAppStore.getState().saveStatus).toBe('saved');
    expect(useAppStore.getState().desktopRevision).toBe(4);
  });

  it('hydrates the last durable desktop state on REVISION_CONFLICT', async () => {
    const durableProject = createStarterProject();
    const conflictingProject = { ...createStarterProject(), name: 'stale-local-draft' };
    const transaction: ProjectTransaction = {
      id: 'tx-conflict',
      label: 'conflict',
      operations: [{
        kind: 'replace_canvas_state',
        nodes: conflictingProject.nodes,
        edges: conflictingProject.edges,
      }],
    };
    replaceProjectPersistenceClientForTests(createMockClient({
      hydrate: async () => ({
        availableSnapshotIds: [],
        mode: 'desktop',
        project: durableProject,
        revision: 3,
        saveStatus: 'saved',
      }),
      commit: vi.fn(async (): Promise<ProjectCommitResult> => ({
        code: 'REVISION_CONFLICT',
        ok: false,
        project: durableProject,
        revision: 3,
      })),
    }));
    resetAppStoreForTests();

    useAppStore.setState({ project: conflictingProject, desktopRevision: 2, saveStatus: 'pending' });

    await useAppStore.getState().commitProjectTransaction(transaction, { kind: 'canvas' });

    expect(useAppStore.getState().project).toMatchObject({ id: durableProject.id, name: durableProject.name });
    expect(useAppStore.getState().desktopRevision).toBe(3);
    expect(useAppStore.getState().saveStatus).toBe('error');
    expect(useAppStore.getState().saveErrorCode).toBe('REVISION_CONFLICT');
  });

  it('does not hydrate desktop initial state from browser localStorage', () => {
    const browserProject = { ...createStarterProject(), name: 'browser-only-draft' };
    localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify({
      current: browserProject,
      schemaVersion: 2,
      snapshots: [],
    }));
    window.novusDesktop = {} as typeof window.novusDesktop;

    resetAppStoreForTests();

    expect(useAppStore.getState().persistenceMode).toBe('desktop');
    expect(useAppStore.getState().project.name).not.toBe('browser-only-draft');
  });

  it('restores desktop snapshots through the persistence client instead of localStorage', async () => {
    const restoredProject = { ...createStarterProject(), name: 'desktop-restored' };
    const restore = vi.fn(async () => ({
      availableSnapshotIds: ['desktop-snapshot-after'],
      project: restoredProject,
      revision: 9,
      saveStatus: 'saved' as const,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({
      restore,
    }));
    resetAppStoreForTests();
    useAppStore.setState({
      availableSnapshotIds: ['desktop-snapshot-after'],
      persistenceMode: 'desktop',
      saveStatus: 'saved',
    });

    await useAppStore.getState().restoreProjectSnapshot('desktop-snapshot-after');

    expect(restore).toHaveBeenCalledWith('desktop-snapshot-after');
    expect(useAppStore.getState().project.name).toBe('desktop-restored');
    expect(useAppStore.getState().desktopRevision).toBe(9);
  });

  it('records a durable project-memory entry when an Agent canvas optimization is confirmed', async () => {
    useAppStore.getState().draftAgentPlan('放大产品并保留顶部文案安全区');
    await useAppStore.getState().confirmAgentPlan({ models: false, deleteNodes: false, skillWriteback: false });

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

  it('persists the confirmed project and real before/after snapshots for reopening', async () => {
    useAppStore.getState().draftAgentPlan('建立可恢复的项目记忆');
    await useAppStore.getState().confirmAgentPlan({ models: false, deleteNodes: false, skillWriteback: false });

    const persisted = loadPersistedProjectBundle();
    const memory = persisted?.current.projectMemory[0];
    expect(persisted?.current.projectMemory).toHaveLength(1);
    expect(persisted?.snapshots.map((snapshot) => snapshot.id)).toEqual(expect.arrayContaining([
      memory?.snapshots.beforeId,
      memory?.snapshots.afterId,
    ]));
  });

  it('records undo as a superseding decision and excludes the reverted optimization from Agent context', async () => {
    useAppStore.getState().draftAgentPlan('稍后撤销这次优化');
    await useAppStore.getState().confirmAgentPlan({ models: false, deleteNodes: false, skillWriteback: false });
    const optimizationId = useAppStore.getState().project.projectMemory[0]!.id;

    await useAppStore.getState().undo();

    const timeline = useAppStore.getState().project.projectMemory;
    expect(timeline).toHaveLength(2);
    expect(timeline[1]).toMatchObject({ kind: 'decision', supersedesMemoryId: optimizationId });
    expect(buildProjectMemoryContext(timeline).map((entry) => entry.id)).toEqual([timeline[1]!.id]);
  });

  it('cancels a stale delayed save before persisting a confirmed Agent transition', async () => {
    vi.useFakeTimers();
    const edited = { ...createStarterProject(), name: '延迟保存旧状态' };
    useAppStore.getState().setProject(edited);
    useAppStore.getState().draftAgentPlan('确认后的新状态不能被旧定时器覆盖');
    await useAppStore.getState().confirmAgentPlan({ models: false, deleteNodes: false, skillWriteback: false });

    vi.advanceTimersByTime(600);

    expect(loadPersistedProjectBundle()?.current.projectMemory).toHaveLength(1);
  });

  it('persists a project-memory promotion as pending review without writing Skill knowledge', async () => {
    useAppStore.getState().draftAgentPlan('沉淀一条可复用经验');
    await useAppStore.getState().confirmAgentPlan({ models: false, deleteNodes: false, skillWriteback: false });
    const memoryId = useAppStore.getState().project.projectMemory[0]!.id;

    await useAppStore.getState().promoteProjectMemory(memoryId);

    expect(useAppStore.getState().project.skillPromotionCandidates).toMatchObject([{
      sourceProjectMemoryId: memoryId,
      reviewStatus: 'pending_review',
    }]);
    expect(loadPersistedProjectBundle()?.current.skillPromotionCandidates).toHaveLength(1);
  });

  it('restores a durable snapshot while retaining the audit timeline', async () => {
    useAppStore.getState().draftAgentPlan('这次改动稍后从快照恢复');
    await useAppStore.getState().confirmAgentPlan({ models: false, deleteNodes: false, skillWriteback: false });
    const optimization = useAppStore.getState().project.projectMemory[0]!;
    await useAppStore.getState().promoteProjectMemory(optimization.id);

    await useAppStore.getState().restoreProjectSnapshot(optimization.snapshots.beforeId);

    const project = useAppStore.getState().project;
    const prompt = project.nodes.find((node) => node.type === 'prompt');
    expect(prompt?.type === 'prompt' ? prompt.data.prompt : '').toBe('等待确认后执行模型任务');
    expect(project.projectMemory).toHaveLength(2);
    expect(project.projectMemory[1]).toMatchObject({ kind: 'decision', title: '恢复项目快照' });
    expect(project.skillPromotionCandidates).toEqual([]);
    expect(loadPersistedProjectBundle()?.current.projectMemory).toHaveLength(2);
  });

  it('does not promote a superseded optimization or a decision into Skill knowledge', async () => {
    useAppStore.getState().draftAgentPlan('这条优化随后会撤销');
    await useAppStore.getState().confirmAgentPlan({ models: false, deleteNodes: false, skillWriteback: false });
    const optimizationId = useAppStore.getState().project.projectMemory[0]!.id;
    await useAppStore.getState().undo();
    const decisionId = useAppStore.getState().project.projectMemory[1]!.id;

    await useAppStore.getState().promoteProjectMemory(optimizationId);
    await useAppStore.getState().promoteProjectMemory(decisionId);

    expect(useAppStore.getState().project.skillPromotionCandidates).toEqual([]);
  });

  it('removes a pending Skill candidate when its source optimization is undone', async () => {
    useAppStore.getState().draftAgentPlan('先提升再撤销');
    await useAppStore.getState().confirmAgentPlan({ models: false, deleteNodes: false, skillWriteback: false });
    const optimizationId = useAppStore.getState().project.projectMemory[0]!.id;
    await useAppStore.getState().promoteProjectMemory(optimizationId);

    await useAppStore.getState().undo();

    expect(useAppStore.getState().project.skillPromotionCandidates).toEqual([]);
    expect(loadPersistedProjectBundle()?.current.skillPromotionCandidates).toEqual([]);
  });
  it('removes a pending Skill candidate whose active source is not promotable', async () => {
    useAppStore.getState().draftAgentPlan('创建一条随后撤销的优化');
    await useAppStore.getState().confirmAgentPlan({ models: false, deleteNodes: false, skillWriteback: false });
    await useAppStore.getState().undo();
    useAppStore.getState().draftAgentPlan('触发下一次可撤销优化');
    await useAppStore.getState().confirmAgentPlan({ models: false, deleteNodes: false, skillWriteback: false });
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

    await useAppStore.getState().undo();

    expect(useAppStore.getState().project.skillPromotionCandidates).toEqual([]);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createImmediateBrowserClient(): ProjectPersistenceClient {
  return createBrowserPersistenceClient();
}

function createMockClient(overrides: Partial<ProjectPersistenceClient>): ProjectPersistenceClient {
  const hydrate = overrides.hydrate ?? (async () => ({
    availableSnapshotIds: [],
    mode: 'desktop',
    project: createStarterProject(),
    revision: 0,
    saveStatus: 'pending',
  }));
  return {
    close: overrides.close ?? (async () => {}),
    commit: async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => {
      const response = overrides.commit === undefined
        ? { ok: true, project: request.nextProject, revision: 1 }
        : await overrides.commit(request);
      if (typeof response === 'object' && response !== null && 'ok' in response) {
        return response as ProjectCommitResult;
      }
      if (typeof response === 'object' && response !== null && 'revision' in response) {
        return {
          ok: true,
          project: request.nextProject,
          revision: (response as CommitAck).revision,
        };
      }
      return {
        code: 'INVALID_REQUEST',
        ok: false,
        project: request.previousProject,
        revision: 0,
      };
    },
    hydrate,
    restore: overrides.restore ?? (async () => {
      const result = await hydrate();
      return {
        availableSnapshotIds: result.availableSnapshotIds,
        project: result.project,
        revision: result.revision,
        saveStatus: result.saveStatus === 'read_only' ? 'read_only' : 'saved',
      };
    }),
    stablePoint: overrides.stablePoint ?? (async () => {
      const result = await hydrate();
      return {
        availableSnapshotIds: result.availableSnapshotIds,
        project: result.project,
        revision: result.revision,
      };
    }),
  };
}
