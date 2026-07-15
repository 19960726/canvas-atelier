import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommitAck } from '@agent-canvas/desktop-core';
import { buildProjectMemoryContext, createAgentKnowledgeLease } from '@agent-canvas/domain';
import type { OrderedReference, ProjectTransaction, SkillPromotionCandidate } from '@agent-canvas/domain';
import type { KnowledgeBaseStateSummary } from '@agent-canvas/skill-store';
import {
  createStarterProject,
  replaceKnowledgeClientForTests,
  replaceProjectPersistenceClientForTests,
  resetAppStoreForTests,
  useAppStore,
} from './app-store';
import type { KnowledgeClient } from './knowledge-client';
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

  it('initializes, configures, and reviews knowledge through the renderer client without root paths', async () => {
    const pendingCandidate = createSkillCandidate('candidate-1', 'pending_review');
    const approvedCandidate = createSkillCandidate('candidate-1', 'approved');
    const client = createMockKnowledgeClient({
      initialStates: [knowledgeState({ version: 1, hashPrefix: 'a' })],
      reviewResult: {
        projectId: 'local-project',
        currentRevision: 11,
        candidate: approvedCandidate,
        knowledgeState: knowledgeState({ version: 2, hashPrefix: 'b' }),
      },
    });
    replaceKnowledgeClientForTests(client);
    resetAppStoreForTests();
    useAppStore.setState((state) => ({
      project: {
        ...state.project,
        skillPromotionCandidates: [pendingCandidate],
      },
    }));

    await useAppStore.getState().initializeKnowledge();
    await useAppStore.getState().configureKnowledgeBase('scene-skill', 'Scene Skill');
    await useAppStore.getState().reviewSkillCandidate({
      projectId: 'local-project',
      candidateId: 'candidate-1',
      decision: 'approved',
    });

    expect(client.start).toHaveBeenCalledTimes(1);
    expect(client.configure).toHaveBeenCalledWith('scene-skill', 'Scene Skill');
    expect(JSON.stringify(client.configure.mock.calls)).not.toContain('root');
    expect(client.review).toHaveBeenCalledWith({
      projectId: 'local-project',
      candidateId: 'candidate-1',
      decision: 'approved',
    });
    expect(useAppStore.getState().knowledgeBases.map((state) => state.activeVersion)).toEqual([2]);
    expect(useAppStore.getState().project.skillPromotionCandidates).toMatchObject([{
      id: 'candidate-1',
      reviewStatus: 'approved',
    }]);
    expect(useAppStore.getState().desktopRevision).toBe(11);
    expect(JSON.stringify(useAppStore.getState().knowledgeBases)).not.toContain('E:\\');
  });

  it('commits one placement update while preserving fields and untouched object slots', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    resetAppStoreForTests();
    const project = createStarterProject();
    const placement = project.nodes.find((node) => node.type === 'placement_preview');
    if (!placement || placement.type !== 'placement_preview') throw new Error('Missing placement');
    const objects = [
      { ...placement.data.objects[0]!, id: 'starter-a', assetId: 'starter-a', name: 'Starter A' },
      { ...placement.data.objects[0]!, id: 'product', assetId: 'product', name: 'Product', locked: true, x: 0.2 },
      { ...placement.data.objects[0]!, id: 'starter-b', assetId: 'starter-b', name: 'Starter B' },
      { ...placement.data.objects[0]!, id: 'scene', assetId: 'scene', name: 'Scene', role: 'scene_composition' as const, y: 0.3 },
      { ...placement.data.objects[0]!, id: 'omitted', assetId: 'omitted', name: 'Omitted', role: 'prop_reference' as const },
    ];
    useAppStore.setState({
      project: {
        ...project,
        nodes: project.nodes.map((node) => node.id === placement.id
          ? { ...placement, data: { ...placement.data, objects } }
          : node),
      },
    });

    await useAppStore.getState().commitReferenceOrder(['scene', 'product']);

    expect(commit).toHaveBeenCalledTimes(1);
    const request = commit.mock.calls[0]![0];
    expect(request.transaction.operations).toHaveLength(1);
    expect(request.transaction.operations[0]).toMatchObject({
      kind: 'canvas',
      operation: { kind: 'update_node', node: { id: placement.id } },
    });
    const savedPlacement = request.nextProject.nodes.find((node) => node.id === placement.id);
    expect(savedPlacement?.type === 'placement_preview'
      ? savedPlacement.data.objects.map((object) => object.assetId)
      : []).toEqual(['starter-a', 'scene', 'starter-b', 'product', 'omitted']);
    expect(savedPlacement?.type === 'placement_preview'
      ? savedPlacement.data.objects.find((object) => object.assetId === 'product')
      : undefined).toMatchObject({ locked: true, x: 0.2, name: 'Product' });
  });

  it('serializes rapid reference reorder commits against acknowledged desktop revisions', async () => {
    const releases = [deferred<void>(), deferred<void>()];
    let durableProject = createStarterProject();
    let revision = 0;
    const commit = vi.fn(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => {
      const callIndex = commit.mock.calls.length - 1;
      const release = releases[callIndex];
      if (!release) throw new Error('Unexpected reference-order commit');
      await release.promise;
      if (request.baseRevision !== revision) {
        return { code: 'REVISION_CONFLICT', ok: false, project: durableProject, revision };
      }
      revision += 1;
      durableProject = request.nextProject;
      return { ok: true, project: durableProject, revision };
    });
    const hydrate = vi.fn(async () => ({
      availableSnapshotIds: [],
      mode: 'desktop' as const,
      project: durableProject,
      revision,
      saveStatus: 'saved' as const,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit, hydrate }));
    resetAppStoreForTests();
    const project = createStarterProject();
    const placement = project.nodes.find((node) => node.type === 'placement_preview');
    if (!placement || placement.type !== 'placement_preview') throw new Error('Missing placement');
    const objects = [
      { ...placement.data.objects[0]!, id: 'product', assetId: 'product', name: 'Product' },
      { ...placement.data.objects[0]!, id: 'scene', assetId: 'scene', name: 'Scene', role: 'scene_composition' as const },
      { ...placement.data.objects[0]!, id: 'prop', assetId: 'prop', name: 'Prop', role: 'prop_reference' as const },
    ];
    durableProject = {
      ...project,
      nodes: project.nodes.map((node) => node.id === placement.id
        ? { ...placement, data: { ...placement.data, objects } }
        : node),
    };
    useAppStore.setState({ desktopRevision: 0, persistenceMode: 'desktop', project: durableProject });

    const first = useAppStore.getState().commitReferenceOrder(['scene', 'product', 'prop']);
    const second = useAppStore.getState().commitReferenceOrder(['prop', 'scene', 'product']);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]![0].baseRevision).toBe(0);

    releases[0]!.resolve();
    await expect(first).resolves.toBe(true);
    await Promise.resolve();

    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls[1]![0].baseRevision).toBe(1);

    releases[1]!.resolve();
    await expect(second).resolves.toBe(true);

    expect(hydrate).not.toHaveBeenCalled();
    expect(useAppStore.getState().desktopRevision).toBe(2);
    const savedPlacement = useAppStore.getState().project.nodes.find((node) => node.id === placement.id);
    expect(savedPlacement?.type === 'placement_preview'
      ? savedPlacement.data.objects.map((object) => object.assetId)
      : []).toEqual(['prop', 'scene', 'product']);
  });

  it('resolves queued reference reorder callers when persistence becomes read only', async () => {
    const release = deferred<void>();
    const commit = vi.fn(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => {
      await release.promise;
      return {
        code: 'CONCURRENT_WRITER',
        ok: false,
        project: request.previousProject,
        revision: request.baseRevision,
      };
    });
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    resetAppStoreForTests();
    const project = createStarterProject();
    const placement = project.nodes.find((node) => node.type === 'placement_preview');
    if (!placement || placement.type !== 'placement_preview') throw new Error('Missing placement');
    const objects = [
      { ...placement.data.objects[0]!, id: 'product', assetId: 'product', name: 'Product' },
      { ...placement.data.objects[0]!, id: 'scene', assetId: 'scene', name: 'Scene', role: 'scene_composition' as const },
    ];
    useAppStore.setState({
      persistenceMode: 'desktop',
      project: {
        ...project,
        nodes: project.nodes.map((node) => node.id === placement.id
          ? { ...placement, data: { ...placement.data, objects } }
          : node),
      },
    });

    const first = useAppStore.getState().commitReferenceOrder(['scene', 'product']);
    const second = useAppStore.getState().commitReferenceOrder(['product', 'scene']);

    expect(commit).toHaveBeenCalledTimes(1);
    release.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().saveStatus).toBe('read_only');
  });

  it('hydrates a persisted reference order for reopening', async () => {
    const project = createStarterProject();
    const placement = project.nodes.find((node) => node.type === 'placement_preview');
    if (!placement || placement.type !== 'placement_preview') throw new Error('Missing placement');
    const durableProject = {
      ...project,
      nodes: project.nodes.map((node) => node.id === placement.id
        ? {
            ...placement,
            data: {
              ...placement.data,
              objects: [
                { ...placement.data.objects[0]!, id: 'scene', assetId: 'scene', role: 'scene_composition' as const },
                { ...placement.data.objects[0]!, id: 'product', assetId: 'product' },
              ],
            },
          }
        : node),
    };
    replaceProjectPersistenceClientForTests(createMockClient({
      hydrate: async () => ({
        availableSnapshotIds: [],
        mode: 'desktop',
        project: durableProject,
        revision: 5,
        saveStatus: 'saved',
      }),
    }));
    resetAppStoreForTests();

    await useAppStore.getState().hydratePersistence();

    const reopened = useAppStore.getState().project.nodes.find((node) => node.id === placement.id);
    expect(reopened?.type === 'placement_preview'
      ? reopened.data.objects.map((object) => object.assetId)
      : []).toEqual(['scene', 'product']);
  });

  it('records durable feedback with its lease and creates only a pending-review candidate', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 2,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    resetAppStoreForTests();
    const references: OrderedReference[] = [
      { assetId: 'scene', label: 'Scene', role: 'scene_composition', position: 0 },
    ];
    const citations = [{ assetId: 'scene', label: 'Scene' }];
    const lease = createAgentKnowledgeLease({
      runId: 'run-feedback',
      capability: 'reverse_prompt',
      snapshots: [],
      references,
      citations,
    }, {
      leaseId: 'lease-feedback',
      createdAt: '2026-07-15T08:00:00.000Z',
    });

    const saved = await useAppStore.getState().recordUserFeedback({
      title: 'Use a quieter scene',
      userRequest: 'Keep @Scene but simplify it',
      correction: 'Remove the extra props',
      knowledgeLease: lease,
      references,
      citations,
      feedback: { keep: ['product'], change: ['scene'], never: ['extra props'] },
    });

    expect(saved).toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().project.projectMemory[useAppStore.getState().project.projectMemory.length - 1]).toMatchObject({
      kind: 'user_feedback',
      context: { knowledgeLease: { leaseId: 'lease-feedback' }, references, citations },
    });
    expect(useAppStore.getState().project.skillPromotionCandidates[useAppStore.getState().project.skillPromotionCandidates.length - 1]).toMatchObject({
      reviewStatus: 'pending_review',
      sourceProjectMemoryId: useAppStore.getState().project.projectMemory[useAppStore.getState().project.projectMemory.length - 1]?.id,
    });
    expect(useAppStore.getState().project.skillPromotionCandidates.some((candidate) => candidate.reviewStatus === 'approved')).toBe(false);

    references[0]!.label = 'Edited later';
    citations[0]!.label = 'Edited later';
    const recordedMemory = useAppStore.getState().project.projectMemory[0];
    expect(recordedMemory?.context.references).toEqual([
      { assetId: 'scene', label: 'Scene', role: 'scene_composition', position: 0 },
    ]);
    expect(recordedMemory?.context.citations).toEqual([{ assetId: 'scene', label: 'Scene' }]);

    const rejected = await useAppStore.getState().recordUserFeedback({
      title: 'Unsafe feedback',
      userRequest: 'Authorization: Bearer secret-token-value',
      correction: 'data:image/png;base64,AAAAAAAAAAAAAAAA',
      knowledgeLease: lease,
      references,
      citations,
      feedback: { keep: [], change: ['scene'], never: [] },
    });
    useAppStore.getState().cancelAgentPlan();
    useAppStore.getState().draftAgentPlan('Use C:\\Users\\private\\image.png');

    expect(rejected).toBe(false);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().project.projectMemory).toHaveLength(1);
    expect(useAppStore.getState().agentPlan).toBeNull();
    expect(JSON.stringify(useAppStore.getState().project)).not.toMatch(/data:image|Bearer secret|C:\\\\Users/i);
  });

  it('rejects arbitrary Authorization schemes and single-segment POSIX paths without blocking slash prose', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    resetAppStoreForTests();
    const references: OrderedReference[] = [
      { assetId: 'scene', label: 'Scene', role: 'scene_composition', position: 0 },
    ];
    const citations = [{ assetId: 'scene', label: 'Scene' }];
    const lease = createAgentKnowledgeLease({
      runId: 'run-security-regression',
      capability: 'reverse_prompt',
      snapshots: [],
      references,
      citations,
    }, {
      leaseId: 'lease-security-regression',
      createdAt: '2026-07-15T08:00:00.000Z',
    });
    const feedbackInput = {
      title: 'Security regression',
      knowledgeLease: lease,
      references,
      citations,
      feedback: { keep: [] as string[], change: ['scene'], never: [] as string[] },
    };

    useAppStore.getState().draftAgentPlan('Authorization: ApiKey abcdefghijklmnop');
    expect(useAppStore.getState().agentPlan).toBeNull();
    useAppStore.getState().draftAgentPlan('Use /secret.key');
    expect(useAppStore.getState().agentPlan).toBeNull();
    useAppStore.getState().draftAgentPlan('Compare keep/change and 1 / 2');
    expect(useAppStore.getState().agentPlan).not.toBeNull();
    useAppStore.getState().cancelAgentPlan();

    const authorizationSaved = await useAppStore.getState().recordUserFeedback({
      ...feedbackInput,
      userRequest: 'Authorization: ApiKey abcdefghijklmnop',
      correction: 'Keep the scene',
    });
    const pathSaved = await useAppStore.getState().recordUserFeedback({
      ...feedbackInput,
      userRequest: 'Keep the scene',
      correction: 'Read /secret.key',
    });
    const slashProseSaved = await useAppStore.getState().recordUserFeedback({
      ...feedbackInput,
      userRequest: 'Compare keep/change',
      correction: 'Balance at 1 / 2 scale',
    });

    expect(authorizationSaved).toBe(false);
    expect(pathSaved).toBe(false);
    expect(slashProseSaved).toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().project.projectMemory).toHaveLength(1);
  });

  it('preserves feedback memory after candidate rejection and rollback review results', async () => {
    const references: OrderedReference[] = [
      { assetId: 'scene', label: 'Scene', role: 'scene_composition', position: 0 },
    ];
    const lease = createAgentKnowledgeLease({
      runId: 'run-review-memory',
      capability: 'reverse_prompt',
      snapshots: [],
      references,
      citations: [],
    }, {
      leaseId: 'lease-review-memory',
      createdAt: '2026-07-15T08:00:00.000Z',
    });
    replaceProjectPersistenceClientForTests(createMockClient({
      commit: vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
        ok: true,
        project: nextProject,
        revision: 1,
      })),
    }));
    resetAppStoreForTests();
    await useAppStore.getState().recordUserFeedback({
      title: 'Feedback survives review',
      userRequest: 'premium product visual',
      correction: 'Simplify the scene',
      knowledgeLease: lease,
      references,
      citations: [],
      feedback: { keep: ['product'], change: ['scene'], never: [] },
    });
    const memory = useAppStore.getState().project.projectMemory[0]!;
    const pendingCandidate = useAppStore.getState().project.skillPromotionCandidates[0]!;
    const rejectedCandidate = {
      ...pendingCandidate,
      reviewStatus: 'rejected' as const,
      reviewedAt: '2026-07-15T09:00:00.000Z',
    };
    const rolledBackCandidate = {
      ...pendingCandidate,
      reviewStatus: 'rolled_back' as const,
      reviewedAt: '2026-07-15T09:00:00.000Z',
      publishedKnowledgeVersion: 3,
      rolledBackAt: '2026-07-15T10:00:00.000Z',
    };
    const client = createMockKnowledgeClient({
      initialStates: [],
      reviewResult: {
        projectId: 'local-project',
        currentRevision: 2,
        candidate: rejectedCandidate,
        knowledgeState: null,
      },
    });
    replaceKnowledgeClientForTests(client);

    await useAppStore.getState().reviewSkillCandidate({
      projectId: 'local-project',
      candidateId: pendingCandidate.id,
      decision: 'rejected',
    });

    expect(useAppStore.getState().project.projectMemory).toEqual([memory]);
    expect(useAppStore.getState().project.skillPromotionCandidates[0]).toMatchObject({ reviewStatus: 'rejected' });

    client.review.mockResolvedValueOnce({
      projectId: 'local-project',
      currentRevision: 3,
      candidate: rolledBackCandidate,
      knowledgeState: knowledgeState({ version: 2, hashPrefix: 'b' }),
    });
    useAppStore.setState((state) => ({
      project: {
        ...state.project,
        skillPromotionCandidates: [{ ...pendingCandidate, reviewStatus: 'approved', reviewedAt: '2026-07-15T09:00:00.000Z', publishedKnowledgeVersion: 3 }],
      },
    }));

    await useAppStore.getState().reviewSkillCandidate({
      projectId: 'local-project',
      candidateId: pendingCandidate.id,
      decision: 'rolled_back',
      targetVersion: 2,
    });

    expect(useAppStore.getState().project.projectMemory).toEqual([memory]);
    expect(useAppStore.getState().project.skillPromotionCandidates[0]).toMatchObject({ reviewStatus: 'rolled_back' });
  });
  it('rejects broader POSIX absolute paths from conversation and feedback payloads', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    resetAppStoreForTests();
    const references: OrderedReference[] = [
      { assetId: 'scene', label: 'Scene', role: 'scene_composition', position: 0 },
    ];
    const citations = [{ assetId: 'scene', label: 'Scene' }];
    const lease = createAgentKnowledgeLease({
      runId: 'run-posix-path',
      capability: 'reverse_prompt',
      snapshots: [],
      references,
      citations,
    }, {
      leaseId: 'lease-posix-path',
      createdAt: '2026-07-15T08:00:00.000Z',
    });

    const saved = await useAppStore.getState().recordUserFeedback({
      title: 'Unsafe POSIX feedback',
      userRequest: 'Use the local render',
      correction: 'Read /var/lib/novus/private/render.png',
      knowledgeLease: lease,
      references,
      citations,
      feedback: { keep: [], change: ['scene'], never: [] },
    });
    useAppStore.getState().draftAgentPlan('Use /opt/novus/private/asset.png');

    expect(saved).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(useAppStore.getState().project.projectMemory).toEqual([]);
    expect(useAppStore.getState().agentPlan).toBeNull();
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

function createMockKnowledgeClient(options: {
  initialStates: KnowledgeBaseStateSummary[];
  reviewResult: Awaited<ReturnType<KnowledgeClient['review']>>;
}): KnowledgeClient & {
  configure: ReturnType<typeof vi.fn<KnowledgeClient['configure']>>;
  review: ReturnType<typeof vi.fn<KnowledgeClient['review']>>;
  start: ReturnType<typeof vi.fn<KnowledgeClient['start']>>;
} {
  let listener: ((states: KnowledgeBaseStateSummary[]) => void) | undefined;
  const client = {
    start: vi.fn(async (next: (states: KnowledgeBaseStateSummary[]) => void) => {
      listener = next;
      listener(options.initialStates);
    }),
    stop: vi.fn(),
    configure: vi.fn(async (_knowledgeBaseId: string, _displayName: string) => {
      listener?.(options.initialStates);
    }),
    review: vi.fn(async (_request) => {
      if (options.reviewResult.knowledgeState) {
        listener?.([options.reviewResult.knowledgeState]);
      }
      return options.reviewResult;
    }),
    getLease: vi.fn(),
  };
  return client;
}

function createSkillCandidate(
  id: string,
  reviewStatus: SkillPromotionCandidate['reviewStatus'],
): SkillPromotionCandidate {
  return {
    schemaVersion: 1,
    id,
    sourceProjectId: 'local-project',
    sourceProjectMemoryId: 'memory-1',
    createdAt: '2026-07-15T08:00:00.000Z',
    title: 'Reusable visual rule',
    rationale: 'Observed in a successful run',
    rule: 'Preserve product identity',
    evidence: { keep: [], change: [], never: [] },
    reviewStatus,
  };
}

function knowledgeState(options: {
  hashPrefix: string;
  version: number;
}): KnowledgeBaseStateSummary {
  return {
    schemaVersion: 1,
    knowledgeBaseId: 'scene-skill',
    displayName: 'Scene Skill',
    status: 'active',
    activeVersion: options.version,
    activeContentHash: options.hashPrefix.repeat(64),
    versionCount: options.version,
    versions: [{
      version: options.version,
      contentHash: options.hashPrefix.repeat(64),
      publishedAt: '2026-07-15T08:00:00.000Z',
      sourceDeviceId: 'device-1',
      displayName: 'Scene Skill',
    }],
    lastFailure: null,
    lastRollbackAt: null,
  };
}
