import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommitAck } from '@agent-canvas/desktop-core';
import { buildProjectMemoryContext, createAgentKnowledgeLease, createCanvasModuleNode, createSkillPromotionCandidateFingerprint, parseCanvasProject } from '@agent-canvas/domain';
import type { CanvasProject, ModelJob, OrderedReference, ProjectTransaction, SkillPromotionCandidate } from '@agent-canvas/domain';
import type { KnowledgeBaseStateSummary } from '@agent-canvas/skill-store';
import {
  createStarterProject,
  replaceKnowledgeClientForTests,
  replaceModelJobExecutorForTests,
  replaceModelJobStorageForTests,
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
    replaceModelJobStorageForTests(createTestModelJobStorage());
    resetAppStoreForTests();
  });

  it('starts every normal renderer session as a unique clean untitled canvas without browser-local restoration', () => {
    localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify({
      current: { ...createStarterProject(), name: '不应自动恢复的浏览器项目' },
      schemaVersion: 2,
      snapshots: [],
    }));

    resetAppStoreForTests({ project: 'empty' });
    const first = useAppStore.getState();
    resetAppStoreForTests({ project: 'empty' });
    const second = useAppStore.getState();

    expect(first.project).toMatchObject({ name: '未命名画布', nodes: [], edges: [], projectMemory: [], skillPromotionCandidates: [] });
    expect(first.confirmedModelJobs).toBe(0);
    expect(first.modelJobs).toEqual([]);
    expect(first.saveStatus).toBe('pending');
    expect(first.project.id).not.toBe(second.project.id);
    expect(first.project.name).not.toBe('不应自动恢复的浏览器项目');
  });

  it('keeps untitled edits pending in memory and switches lifecycle identity only after explicit open', async () => {
    const durableProject = { ...createStarterProject(), name: '未命名画布' };
    const openProject = vi.fn(async () => ({
      availableSnapshotIds: [],
      lifecycle: 'durable' as const,
      mode: 'desktop' as const,
      project: durableProject,
      revision: 6,
      saveStatus: 'saved' as const,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ openProject }));
    resetAppStoreForTests({ project: 'empty' });

    expect(useAppStore.getState().projectLifecycle).toBe('untitled');
    expect(await useAppStore.getState().addModuleNode('text_prompt', { x: 120, y: 120 })).toBe(true);
    expect(useAppStore.getState().saveStatus).toBe('pending');

    expect(await useAppStore.getState().openProject()).toBe(true);
    expect(openProject).toHaveBeenCalledOnce();
    expect(useAppStore.getState()).toMatchObject({
      projectLifecycle: 'durable',
      project: { name: '未命名画布' },
      saveStatus: 'saved',
    });
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

  it('keeps a typed missing-asset error visible after hydration and clears it only after a successful retry', async () => {
    const missingAssetError = Object.assign(new Error('Managed asset is unavailable'), {
      code: 'MISSING_ASSET',
      retryable: true,
    });
    const listProjectImages = vi.fn()
      .mockRejectedValueOnce(missingAssetError)
      .mockResolvedValueOnce([]);
    replaceProjectPersistenceClientForTests(createMockClient({
      hydrate: vi.fn(async () => ({
        availableSnapshotIds: [],
        lifecycle: 'durable' as const,
        mode: 'desktop' as const,
        project: createStarterProject(),
        revision: 4,
        saveStatus: 'saved' as const,
      })),
      listProjectImages,
    }));
    resetAppStoreForTests();

    await useAppStore.getState().hydratePersistence();

    expect(useAppStore.getState().project.id).toBe('local-project');
    expect(useAppStore.getState().projectImages).toEqual([]);
    expect(useAppStore.getState().projectImageError).toBe('MISSING_ASSET');

    await useAppStore.getState().refreshProjectImages();
    expect(listProjectImages).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().projectImageError).toBeNull();
  });

  it('uses one durable transaction to create a module node', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 4,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    resetAppStoreForTests();

    const saved = await useAppStore.getState().addModuleNode('text_prompt', { x: 240, y: 180 });

    expect(saved).toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);
    const nodes = useAppStore.getState().project.nodes;
    expect(nodes[nodes.length - 1]).toMatchObject({ type: 'module', data: { moduleType: 'text_prompt' } });
    expect(useAppStore.getState().saveStatus).toBe('saved');
  });

  it('serializes rapid module creation until each desktop ACK advances the revision', async () => {
    const firstAck = deferred<CommitAck>();
    const secondAck = deferred<CommitAck>();
    const commit = vi.fn()
      .mockReturnValueOnce(firstAck.promise)
      .mockReturnValueOnce(secondAck.promise);
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    resetAppStoreForTests();

    const first = useAppStore.getState().addModuleNode('text_prompt', { x: 120, y: 120 });
    const second = useAppStore.getState().addModuleNode('openpose', { x: 420, y: 120 });

    expect(commit).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().saveStatus).toBe('saving');

    firstAck.resolve({
      committedAt: '2026-07-17T10:00:00.000Z',
      projectId: 'local-project',
      revision: 4,
      sequence: 4,
      transactionId: commit.mock.calls[0]![0].transaction.id,
    });

    await waitForStore(() => commit.mock.calls.length === 2);
    expect(commit.mock.calls[1]![0].baseRevision).toBe(4);
    expect(commit.mock.calls[1]![0].previousProject.nodes.some((node: { type: string; data?: { moduleType?: string } }) => node.data?.moduleType === 'text_prompt')).toBe(true);

    secondAck.resolve({
      committedAt: '2026-07-17T10:00:01.000Z',
      projectId: 'local-project',
      revision: 5,
      sequence: 5,
      transactionId: commit.mock.calls[1]![0].transaction.id,
    });

    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(useAppStore.getState().desktopRevision).toBe(5);
    expect(useAppStore.getState().saveStatus).toBe('saved');
    expect(useAppStore.getState().project.nodes.filter((node) => node.type === 'module')).toHaveLength(2);
  });

  it('blocks later module commits until the failed durable transaction is retried', async () => {
    const commit = vi.fn()
      .mockImplementationOnce(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
        code: 'DISK_FULL',
        ok: false,
        project: request.previousProject,
        revision: request.baseRevision,
      }))
      .mockImplementationOnce(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
        ok: true,
        project: request.nextProject,
        revision: request.baseRevision + 1,
      }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    resetAppStoreForTests();

    const first = useAppStore.getState().addModuleNode('text_prompt', { x: 120, y: 120 });
    const second = useAppStore.getState().addModuleNode('openpose', { x: 420, y: 120 });

    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().project.nodes.filter((node) => node.type === 'module')).toMatchObject([
      { data: { moduleType: 'text_prompt' } },
    ]);

    expect(await useAppStore.getState().retryFailedProjectCommit()).toBe(true);
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls[1]![0]).toEqual(commit.mock.calls[0]![0]);
    expect(useAppStore.getState().saveStatus).toBe('saved');
  });

  it('hydrates the last durable desktop state on REVISION_CONFLICT', async () => {
    const durableAsset = {
      assetId: '0123456789abcdef',
      byteSize: 42,
      extension: 'png' as const,
      height: 3,
      label: 'Authoritative image',
      mediaType: 'image/png' as const,
      origin: 'imported' as const,
      sha256: `0123456789abcdef${'0'.repeat(48)}`,
      width: 2,
    };
    const durableProject = { ...createStarterProject(), assets: [durableAsset] };
    const durableImage = {
      ...durableAsset,
      displayUrl: 'novus-asset://project/session/0123456789abcdef',
      usageCount: 0,
    };
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
        lifecycle: 'durable',
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
      listProjectImages: vi.fn(async () => [durableImage]),
    }));
    resetAppStoreForTests();

    useAppStore.setState({
      project: conflictingProject,
      projectImages: [],
      desktopRevision: 2,
      saveStatus: 'pending',
    });

    await useAppStore.getState().commitProjectTransaction(transaction, { kind: 'canvas' });

    expect(useAppStore.getState().project).toMatchObject({ id: durableProject.id, name: durableProject.name });
    expect(useAppStore.getState().projectImages).toEqual([durableImage]);
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
      lifecycle: 'durable' as const,
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

  it('streams model job submit and progress transitions into app state', async () => {
    replaceModelJobExecutorForTests({
      submit: vi.fn(async (job) => ({ providerTaskId: `task-${job.id}` })),
      poll: vi.fn()
        .mockResolvedValueOnce({ status: 'running' as const, progress: 0.35 })
        .mockResolvedValueOnce({ status: 'completed' as const, result: { assetId: 'asset-live-job' } }),
      cancel: vi.fn(async () => {}),
    });
    installProviderProfilesForModelJobTests();
    resetAppStoreForTests();

    useAppStore.getState().draftAgentPlan('生成并实时更新任务状态');
    await useAppStore.getState().confirmAgentPlan({ models: true, deleteNodes: false, skillWriteback: false });
    await waitForStore(() => useAppStore.getState().modelJobs[0]?.status === 'running');
    await waitForStore(() => useAppStore.getState().modelJobs[0]?.progress === 0.35);
    await waitForStore(() => useAppStore.getState().modelJobs[0]?.status === 'completed');

    expect(useAppStore.getState().modelJobs[0]).toMatchObject({
      resultAssetId: 'asset-live-job',
      status: 'completed',
    });
  });

  it('uses the desktop provider bridge executor for confirmed model plans without exposing tokens', async () => {
    const submitImageJob = vi.fn(async () => ({ providerTaskId: 'provider-task-app-store' }));
    const pollImageJob = vi.fn(async () => ({ status: 'running' as const, progress: 0.42 }));
    const cancelImageJob = vi.fn(async () => {});
    const listProfiles = vi.fn(async () => [{
      provider: 'comfly',
      modelRoute: 'gpt-image',
      displayName: 'GPT Image',
      capabilities: ['image_generation', 'async_tasks'],
    }]);
    window.novusDesktop = {
      provider: {
        submitImageJob,
        pollImageJob,
        cancelImageJob,
        getStatus: vi.fn(),
        configure: vi.fn(),
        unlock: vi.fn(),
        listProfiles,
      },
    } as unknown as typeof window.novusDesktop;
    resetAppStoreForTests();

    useAppStore.getState().draftAgentPlan('Generate through the desktop provider bridge');
    await useAppStore.getState().confirmAgentPlan({ models: true, deleteNodes: false, skillWriteback: false });
    await waitForStore(() => submitImageJob.mock.calls.length === 1);

    expect(submitImageJob).toHaveBeenCalledWith({
      jobId: expect.stringMatching(/^model-job-/),
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'Generate through the desktop provider bridge',
      conversationId: 'agent-conversation-shared',
      referenceAssetIds: ['starter-product'],
    });
    expect(JSON.stringify(submitImageJob.mock.calls)).not.toMatch(/Authorization|Bearer|token|apiKey|secret/i);
    expect(pollImageJob).toHaveBeenCalledWith({
      provider: 'comfly',
      providerTaskId: 'provider-task-app-store',
    });
    expect(cancelImageJob).not.toHaveBeenCalled();
  });

  it('resolves dynamic provider profiles for model plans without resetting conversation context', async () => {
    const submitImageJob = vi.fn(async () => ({ providerTaskId: 'provider-task-nano' }));
    const listProfiles = vi.fn(async () => [{
      provider: 'comfly',
      modelRoute: 'nano-banana-2-actual-route',
      displayName: 'Nano Banana 2',
      modelId: 'nano-banana-2',
      capabilities: ['image_generation', 'async_tasks'],
    }]);
    window.novusDesktop = {
      provider: {
        submitImageJob,
        pollImageJob: vi.fn(async () => ({ status: 'running' as const, progress: 0.2 })),
        cancelImageJob: vi.fn(),
        getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' })),
        configure: vi.fn(),
        unlock: vi.fn(),
        listProfiles,
      },
    } as unknown as typeof window.novusDesktop;
    resetAppStoreForTests();

    useAppStore.getState().draftAgentPlan('Generate through Nano Banana 2 while keeping references', {
      modelRoute: 'nano-banana-2-actual-route',
    });
    await useAppStore.getState().confirmAgentPlan({ models: true, deleteNodes: false, skillWriteback: false });
    await waitForStore(() => submitImageJob.mock.calls.length === 1);

    expect(listProfiles).toHaveBeenCalledTimes(1);
    expect(submitImageJob).toHaveBeenCalledWith({
      jobId: expect.stringMatching(/^model-job-/),
      provider: 'comfly',
      modelRoute: 'nano-banana-2-actual-route',
      prompt: 'Generate through Nano Banana 2 while keeping references',
      conversationId: 'agent-conversation-shared',
      referenceAssetIds: ['starter-product'],
    });
    expect(useAppStore.getState().modelJobs[0]).toMatchObject({
      provider: 'comfly',
      modelRoute: 'nano-banana-2-actual-route',
      displayName: 'Nano Banana 2',
      modelId: 'nano-banana-2',
      conversationId: 'agent-conversation-shared',
      referenceAssetIds: ['starter-product'],
    });
  });

  it('validates the selected provider profile before committing an Agent model transaction', async () => {
    const events: string[] = [];
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => {
      events.push('commit');
      return {
        ok: true,
        project: nextProject,
        revision: 1,
      };
    });
    const submitImageJob = vi.fn(async () => {
      events.push('submit');
      return { providerTaskId: 'provider-task-gpt-image' };
    });
    const listProfiles = vi.fn(async () => {
      events.push('profiles');
      return [{
        provider: 'comfly',
        modelRoute: 'image-generation',
        displayName: 'GPT Image',
        modelId: 'gpt-image-1',
        capabilities: ['image_generation', 'image_edit', 'async_tasks'],
      }];
    });
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    window.novusDesktop = {
      provider: {
        submitImageJob,
        pollImageJob: vi.fn(async () => ({ status: 'running' as const, progress: 0.2 })),
        cancelImageJob: vi.fn(),
        getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' })),
        configure: vi.fn(),
        unlock: vi.fn(),
        listProfiles,
      },
    } as unknown as typeof window.novusDesktop;
    resetAppStoreForTests();

    useAppStore.getState().draftAgentPlan('Generate through GPT Image profile', {
      modelRoute: 'image-generation',
    });
    expect(useAppStore.getState().agentPlan?.modelRoute).toBe('image-generation');

    await useAppStore.getState().confirmAgentPlan({ models: true, deleteNodes: false, skillWriteback: false });
    await waitForStore(() => submitImageJob.mock.calls.length === 1);

    expect(events.slice(0, 2)).toEqual(['profiles', 'commit']);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(listProfiles).toHaveBeenCalledTimes(1);
    expect(submitImageJob).toHaveBeenCalledWith({
      jobId: expect.stringMatching(/^model-job-/),
      provider: 'comfly',
      modelRoute: 'image-generation',
      prompt: 'Generate through GPT Image profile',
      conversationId: 'agent-conversation-shared',
      referenceAssetIds: ['starter-product'],
    });
    expect(useAppStore.getState().modelJobs[0]).toMatchObject({
      conversationId: 'agent-conversation-shared',
      displayName: 'GPT Image',
      modelId: 'gpt-image-1',
      modelRoute: 'image-generation',
      provider: 'comfly',
    });
  });

  it('leaves project, undo, and jobs unchanged when the selected provider profile disappears', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    const submitImageJob = vi.fn(async () => ({ providerTaskId: 'provider-task-should-not-start' }));
    const listProfiles = vi.fn(async () => [{
      provider: 'comfly',
      modelRoute: 'nano-banana-2-actual-route',
      displayName: 'Nano Banana 2',
      modelId: 'nano-banana-2',
      capabilities: ['image_generation', 'async_tasks'],
    }]);
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    window.novusDesktop = {
      provider: {
        submitImageJob,
        pollImageJob: vi.fn(async () => ({ status: 'running' as const, progress: 0.2 })),
        cancelImageJob: vi.fn(),
        getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' })),
        configure: vi.fn(),
        unlock: vi.fn(),
        listProfiles,
      },
    } as unknown as typeof window.novusDesktop;
    resetAppStoreForTests();

    useAppStore.getState().draftAgentPlan('Do not mutate on stale GPT Image profile', {
      modelRoute: 'image-generation',
    });
    const beforeProject = cloneProjectForExpectation(useAppStore.getState().project);

    await expect(useAppStore.getState().confirmAgentPlan({
      models: true,
      deleteNodes: false,
      skillWriteback: false,
    })).resolves.toBeUndefined();

    expect(listProfiles).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect(submitImageJob).not.toHaveBeenCalled();
    expect(useAppStore.getState().project).toEqual(beforeProject);
    expect(useAppStore.getState().project.projectMemory).toEqual([]);
    expect(useAppStore.getState().undoStack).toEqual([]);
    expect(useAppStore.getState().modelJobs).toEqual([]);
    expect(useAppStore.getState().agentPlan).toMatchObject({
      modelRoute: 'image-generation',
      state: 'waiting_for_confirmation',
    });
    expect(useAppStore.getState().agentPlan?.conflicts.join(' ')).toMatch(/model profile/i);
  });

  it('ignores delayed model confirmation after the Agent plan is cancelled', async () => {
    const profileResolution = deferred<Array<{
      provider: string;
      modelRoute: string;
      displayName: string;
      modelId: string;
      capabilities: string[];
    }>>();
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    const submitImageJob = vi.fn(async () => ({ providerTaskId: 'provider-task-stale-cancel' }));
    const listProfiles = vi.fn(() => profileResolution.promise);
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    window.novusDesktop = {
      provider: {
        submitImageJob,
        pollImageJob: vi.fn(async () => ({ status: 'running' as const, progress: 0.2 })),
        cancelImageJob: vi.fn(),
        getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' })),
        configure: vi.fn(),
        unlock: vi.fn(),
        listProfiles,
      },
    } as unknown as typeof window.novusDesktop;
    resetAppStoreForTests();

    useAppStore.getState().draftAgentPlan('Cancel while provider profiles are loading', {
      modelRoute: 'image-generation',
    });
    const confirmation = useAppStore.getState().confirmAgentPlan({ models: true, deleteNodes: false, skillWriteback: false });
    await waitForStore(() => listProfiles.mock.calls.length === 1);

    useAppStore.getState().cancelAgentPlan();
    expect(useAppStore.getState().agentPlan).toMatchObject({ state: 'confirming' });
    profileResolution.resolve([{
      provider: 'comfly',
      modelRoute: 'image-generation',
      displayName: 'GPT Image',
      modelId: 'gpt-image-1',
      capabilities: ['image_generation', 'async_tasks'],
    }]);
    await confirmation;
    await waitForStore(() => submitImageJob.mock.calls.length === 1);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(submitImageJob).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().project.projectMemory).toHaveLength(1);
    expect(useAppStore.getState().undoStack).toHaveLength(1);
    expect(useAppStore.getState().modelJobs).toHaveLength(1);
    expect(useAppStore.getState().agentPlan).toMatchObject({ state: 'reviewing_results' });
  });

  it('ignores delayed model confirmation after the Agent plan is replaced', async () => {
    const profileResolution = deferred<Array<{
      provider: string;
      modelRoute: string;
      displayName: string;
      modelId: string;
      capabilities: string[];
    }>>();
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    const submitImageJob = vi.fn(async () => ({ providerTaskId: 'provider-task-stale-replace' }));
    const listProfiles = vi.fn(() => profileResolution.promise);
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    window.novusDesktop = {
      provider: {
        submitImageJob,
        pollImageJob: vi.fn(async () => ({ status: 'running' as const, progress: 0.2 })),
        cancelImageJob: vi.fn(),
        getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' })),
        configure: vi.fn(),
        unlock: vi.fn(),
        listProfiles,
      },
    } as unknown as typeof window.novusDesktop;
    resetAppStoreForTests();

    useAppStore.getState().draftAgentPlan('Old plan waiting on provider profiles', {
      modelRoute: 'image-generation',
    });
    const originalPlanId = useAppStore.getState().agentPlan?.id;
    const confirmation = useAppStore.getState().confirmAgentPlan({ models: true, deleteNodes: false, skillWriteback: false });
    await waitForStore(() => listProfiles.mock.calls.length === 1);

    useAppStore.getState().draftAgentPlan('Replacement plan must stay waiting', {
      modelRoute: 'nano-banana-2-actual-route',
    });
    expect(useAppStore.getState().agentPlan).toMatchObject({
      id: originalPlanId,
      modelRoute: 'image-generation',
      state: 'confirming',
    });
    profileResolution.resolve([{
      provider: 'comfly',
      modelRoute: 'image-generation',
      displayName: 'GPT Image',
      modelId: 'gpt-image-1',
      capabilities: ['image_generation', 'async_tasks'],
    }]);
    await confirmation;
    await waitForStore(() => submitImageJob.mock.calls.length === 1);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(submitImageJob).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().project.projectMemory).toHaveLength(1);
    expect(useAppStore.getState().undoStack).toHaveLength(1);
    expect(useAppStore.getState().modelJobs).toHaveLength(1);
    expect(useAppStore.getState().agentPlan).toMatchObject({
      id: originalPlanId,
      modelRoute: 'image-generation',
      state: 'reviewing_results',
    });
  });

  it('ignores delayed model confirmation after the project revision fingerprint changes', async () => {
    const profileResolution = deferred<Array<{
      provider: string;
      modelRoute: string;
      displayName: string;
      modelId: string;
      capabilities: string[];
    }>>();
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    const submitImageJob = vi.fn(async () => ({ providerTaskId: 'provider-task-stale-project' }));
    const listProfiles = vi.fn(() => profileResolution.promise);
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    window.novusDesktop = {
      provider: {
        submitImageJob,
        pollImageJob: vi.fn(async () => ({ status: 'running' as const, progress: 0.2 })),
        cancelImageJob: vi.fn(),
        getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' })),
        configure: vi.fn(),
        unlock: vi.fn(),
        listProfiles,
      },
    } as unknown as typeof window.novusDesktop;
    resetAppStoreForTests();

    useAppStore.getState().draftAgentPlan('Project changes while profiles are loading', {
      modelRoute: 'image-generation',
    });
    const confirmation = useAppStore.getState().confirmAgentPlan({ models: true, deleteNodes: false, skillWriteback: false });
    await waitForStore(() => listProfiles.mock.calls.length === 1);

    useAppStore.getState().setProject({
      ...useAppStore.getState().project,
      name: 'changed while validating model profile',
    }, { schedulePersist: false });
    profileResolution.resolve([{
      provider: 'comfly',
      modelRoute: 'image-generation',
      displayName: 'GPT Image',
      modelId: 'gpt-image-1',
      capabilities: ['image_generation', 'async_tasks'],
    }]);
    await confirmation;

    expect(commit).not.toHaveBeenCalled();
    expect(submitImageJob).not.toHaveBeenCalled();
    expect(useAppStore.getState().project.name).toBe('changed while validating model profile');
    expect(useAppStore.getState().project.projectMemory).toEqual([]);
    expect(useAppStore.getState().undoStack).toEqual([]);
    expect(useAppStore.getState().modelJobs).toEqual([]);
    expect(useAppStore.getState().agentPlan).toMatchObject({
      modelRoute: 'image-generation',
      state: 'waiting_for_confirmation',
    });
  });

  it('commits and queues only once when the same Agent plan is confirmed twice during profile loading', async () => {
    const profileResolution = deferred<Array<{
      provider: string;
      modelRoute: string;
      displayName: string;
      modelId: string;
      capabilities: string[];
    }>>();
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    const submitImageJob = vi.fn(async () => ({ providerTaskId: 'provider-task-single-commit' }));
    const listProfiles = vi.fn(() => profileResolution.promise);
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    window.novusDesktop = {
      provider: {
        submitImageJob,
        pollImageJob: vi.fn(async () => ({ status: 'running' as const, progress: 0.2 })),
        cancelImageJob: vi.fn(),
        getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' })),
        configure: vi.fn(),
        unlock: vi.fn(),
        listProfiles,
      },
    } as unknown as typeof window.novusDesktop;
    resetAppStoreForTests();

    useAppStore.getState().draftAgentPlan('Double click confirm must be idempotent', {
      modelRoute: 'image-generation',
    });
    const firstConfirmation = useAppStore.getState().confirmAgentPlan({ models: true, deleteNodes: false, skillWriteback: false });
    await waitForStore(() => listProfiles.mock.calls.length === 1);
    const secondConfirmation = useAppStore.getState().confirmAgentPlan({ models: true, deleteNodes: false, skillWriteback: false });

    profileResolution.resolve([{
      provider: 'comfly',
      modelRoute: 'image-generation',
      displayName: 'GPT Image',
      modelId: 'gpt-image-1',
      capabilities: ['image_generation', 'async_tasks'],
    }]);
    await Promise.all([firstConfirmation, secondConfirmation]);
    await waitForStore(() => useAppStore.getState().modelJobs.length === 1);
    await waitForStore(() => submitImageJob.mock.calls.length === 1);

    expect(listProfiles).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(submitImageJob).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().project.projectMemory).toHaveLength(1);
    expect(useAppStore.getState().undoStack).toHaveLength(1);
    expect(useAppStore.getState().modelJobs).toHaveLength(1);
  });

  it('rejects cancel after profiles resolve while the Agent commit is still pending', async () => {
    const profileResolution = deferred<Array<{
      provider: string;
      modelRoute: string;
      displayName: string;
      modelId: string;
      capabilities: string[];
    }>>();
    const commitResolution = deferred<void>();
    const commit = vi.fn(({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => (
      commitResolution.promise.then(() => ({ ok: true, project: nextProject, revision: 1 }))
    ));
    const submitImageJob = vi.fn(async () => ({ providerTaskId: 'provider-task-commit-cancel' }));
    const listProfiles = vi.fn(() => profileResolution.promise);
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    window.novusDesktop = {
      provider: {
        submitImageJob,
        pollImageJob: vi.fn(async () => ({ status: 'running' as const, progress: 0.2 })),
        cancelImageJob: vi.fn(),
        getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' })),
        configure: vi.fn(),
        unlock: vi.fn(),
        listProfiles,
      },
    } as unknown as typeof window.novusDesktop;
    resetAppStoreForTests();

    useAppStore.getState().draftAgentPlan('Cancel while commit is pending', {
      modelRoute: 'image-generation',
    });
    const confirmation = useAppStore.getState().confirmAgentPlan({ models: true, deleteNodes: false, skillWriteback: false });
    await waitForStore(() => listProfiles.mock.calls.length === 1);
    profileResolution.resolve([{
      provider: 'comfly',
      modelRoute: 'image-generation',
      displayName: 'GPT Image',
      modelId: 'gpt-image-1',
      capabilities: ['image_generation', 'async_tasks'],
    }]);
    await waitForStore(() => commit.mock.calls.length === 1);

    useAppStore.getState().cancelAgentPlan();

    expect(useAppStore.getState().agentPlan).toMatchObject({ state: 'committing' });
    commitResolution.resolve();
    await confirmation;
    await waitForStore(() => useAppStore.getState().modelJobs.length === 1);
    await waitForStore(() => submitImageJob.mock.calls.length === 1);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(submitImageJob).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().project.projectMemory).toHaveLength(1);
    expect(useAppStore.getState().undoStack).toHaveLength(1);
    expect(useAppStore.getState().agentPlan).toMatchObject({ state: 'reviewing_results' });
  });

  it('rejects replacement after profiles resolve while the Agent commit is still pending', async () => {
    const profileResolution = deferred<Array<{
      provider: string;
      modelRoute: string;
      displayName: string;
      modelId: string;
      capabilities: string[];
    }>>();
    const commitResolution = deferred<void>();
    const commit = vi.fn(({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => (
      commitResolution.promise.then(() => ({ ok: true, project: nextProject, revision: 1 }))
    ));
    const submitImageJob = vi.fn(async () => ({ providerTaskId: 'provider-task-commit-replace' }));
    const listProfiles = vi.fn(() => profileResolution.promise);
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    window.novusDesktop = {
      provider: {
        submitImageJob,
        pollImageJob: vi.fn(async () => ({ status: 'running' as const, progress: 0.2 })),
        cancelImageJob: vi.fn(),
        getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' })),
        configure: vi.fn(),
        unlock: vi.fn(),
        listProfiles,
      },
    } as unknown as typeof window.novusDesktop;
    resetAppStoreForTests();

    useAppStore.getState().draftAgentPlan('Commit should reject replacement', {
      modelRoute: 'image-generation',
    });
    const originalPlanId = useAppStore.getState().agentPlan?.id;
    const confirmation = useAppStore.getState().confirmAgentPlan({ models: true, deleteNodes: false, skillWriteback: false });
    await waitForStore(() => listProfiles.mock.calls.length === 1);
    profileResolution.resolve([{
      provider: 'comfly',
      modelRoute: 'image-generation',
      displayName: 'GPT Image',
      modelId: 'gpt-image-1',
      capabilities: ['image_generation', 'async_tasks'],
    }]);
    await waitForStore(() => commit.mock.calls.length === 1);

    useAppStore.getState().draftAgentPlan('Replacement must not overwrite committed plan', {
      modelRoute: 'nano-banana-2-actual-route',
    });

    expect(useAppStore.getState().agentPlan).toMatchObject({
      id: originalPlanId,
      modelRoute: 'image-generation',
      state: 'committing',
    });
    commitResolution.resolve();
    await confirmation;
    await waitForStore(() => useAppStore.getState().modelJobs.length === 1);
    await waitForStore(() => submitImageJob.mock.calls.length === 1);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(submitImageJob).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().project.projectMemory).toHaveLength(1);
    expect(useAppStore.getState().undoStack).toHaveLength(1);
    expect(useAppStore.getState().agentPlan).toMatchObject({
      id: originalPlanId,
      state: 'reviewing_results',
    });
  });

  it('rejects cancel after commit ack while model jobs are still enqueueing', async () => {
    const enqueueResolution = deferred<void>();
    const queuedJobs: ModelJob[] = [];
    const bulkPut = vi.fn(async (jobs) => {
      await enqueueResolution.promise;
      queuedJobs.splice(0, queuedJobs.length, ...jobs);
    });
    replaceModelJobStorageForTests({
      get: async (id) => queuedJobs.find((job) => job.id === id),
      list: async () => queuedJobs,
      put: async (job) => {
        const index = queuedJobs.findIndex((item) => item.id === job.id);
        if (index >= 0) queuedJobs[index] = job;
        else queuedJobs.push(job);
      },
      bulkPut,
    });
    installProviderProfilesForModelJobTests();
    replaceProjectPersistenceClientForTests(createMockClient({
      commit: vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
        ok: true,
        project: nextProject,
        revision: 1,
      })),
    }));
    resetAppStoreForTests();

    useAppStore.getState().draftAgentPlan('Cancel during model queue enqueue', {
      modelRoute: 'image-generation',
    });
    const confirmation = useAppStore.getState().confirmAgentPlan({ models: true, deleteNodes: false, skillWriteback: false });
    await waitForStore(() => bulkPut.mock.calls.length === 1);

    useAppStore.getState().cancelAgentPlan();

    expect(useAppStore.getState().agentPlan).toMatchObject({ state: 'committing' });
    enqueueResolution.resolve();
    await confirmation;
    await waitForStore(() => useAppStore.getState().modelJobs.length === 1);
    expect(useAppStore.getState().project.projectMemory).toHaveLength(1);
    expect(useAppStore.getState().undoStack).toHaveLength(1);
    expect(useAppStore.getState().agentPlan).toMatchObject({ state: 'reviewing_results' });
  });

  it('keeps a committed Agent plan retryable when queueing model jobs fails', async () => {
    replaceModelJobStorageForTests({
      get: vi.fn(),
      list: vi.fn(async () => []),
      put: vi.fn(),
      bulkPut: vi.fn(async () => {
        throw new Error('queue storage unavailable');
      }),
    });
    installProviderProfilesForModelJobTests();
    replaceProjectPersistenceClientForTests(createMockClient({
      commit: vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
        ok: true,
        project: nextProject,
        revision: 1,
      })),
    }));
    resetAppStoreForTests();

    useAppStore.getState().draftAgentPlan('Queue failure should not look cancelled', {
      modelRoute: 'image-generation',
    });

    await expect(
      useAppStore.getState().confirmAgentPlan({ models: true, deleteNodes: false, skillWriteback: false }),
    ).resolves.toBeUndefined();

    expect(useAppStore.getState().project.projectMemory).toHaveLength(1);
    expect(useAppStore.getState().undoStack).toHaveLength(1);
    expect(useAppStore.getState().modelJobs).toEqual([]);
    expect(useAppStore.getState().agentPlan).toMatchObject({
      modelRoute: 'image-generation',
      modelRouteDisplayName: 'GPT Image',
      state: 'waiting_for_job_retry',
    });
    expect(useAppStore.getState().agentPlan?.conflicts.join(' ')).toMatch(/queue|model/i);
  });

  it('retries model job enqueue after a committed Agent plan without duplicating canvas, undo, or memory', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    const submit = vi.fn(async (job: ModelJob) => ({ providerTaskId: `provider-${job.id}` }));
    const storedJobs: ModelJob[] = [];
    const bulkPut = vi.fn(async (jobs: ModelJob[]) => {
      if (bulkPut.mock.calls.length === 1) throw new Error('first enqueue unavailable');
      storedJobs.splice(0, storedJobs.length, ...jobs);
    });
    replaceModelJobExecutorForTests({
      submit,
      poll: vi.fn(async () => ({ status: 'running' as const, progress: 0.2 })),
      cancel: vi.fn(),
    });
    replaceModelJobStorageForTests(createMutableModelJobStorage(storedJobs, bulkPut));
    installProviderProfilesForModelJobTests();
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    resetAppStoreForTests();

    useAppStore.getState().draftAgentPlan('Retry just the model queue after commit', {
      modelRoute: 'image-generation',
    });
    await useAppStore.getState().confirmAgentPlan({ models: true, deleteNodes: false, skillWriteback: false });

    const committedProject = cloneProjectForExpectation(useAppStore.getState().project);
    const memoryIds = useAppStore.getState().project.projectMemory.map((memory) => memory.id);
    expect(useAppStore.getState().agentPlan).toMatchObject({ state: 'waiting_for_job_retry' });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(bulkPut).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().undoStack).toHaveLength(1);
    expect(memoryIds).toHaveLength(1);

    await useAppStore.getState().retryAgentPlanJobs();
    await waitForStore(() => useAppStore.getState().modelJobs.length === 1);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(bulkPut).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().project).toEqual(committedProject);
    expect(useAppStore.getState().project.projectMemory.map((memory) => memory.id)).toEqual(memoryIds);
    expect(useAppStore.getState().undoStack).toHaveLength(1);
    expect(useAppStore.getState().modelJobs).toHaveLength(1);
    expect(useAppStore.getState().modelJobs[0]).toMatchObject({
      conversationId: 'agent-conversation-shared',
      modelRoute: 'image-generation',
      provider: 'comfly',
    });
    expect(useAppStore.getState().agentPlan).toMatchObject({ state: 'reviewing_results' });
  });

  it('dedupes concurrent Agent job retries so they cannot double-enqueue', async () => {
    const enqueueRetry = deferred<void>();
    const storedJobs: ModelJob[] = [];
    const bulkPut = vi.fn(async (jobs: ModelJob[]) => {
      if (bulkPut.mock.calls.length === 1) throw new Error('first enqueue unavailable');
      await enqueueRetry.promise;
      storedJobs.splice(0, storedJobs.length, ...jobs);
    });
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    replaceModelJobExecutorForTests({
      submit: vi.fn(async (job: ModelJob) => ({ providerTaskId: `provider-${job.id}` })),
      poll: vi.fn(async () => ({ status: 'running' as const, progress: 0.2 })),
      cancel: vi.fn(),
    });
    replaceModelJobStorageForTests(createMutableModelJobStorage(storedJobs, bulkPut));
    installProviderProfilesForModelJobTests();
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    resetAppStoreForTests();

    useAppStore.getState().draftAgentPlan('Deduplicate retry clicks', {
      modelRoute: 'image-generation',
    });
    await useAppStore.getState().confirmAgentPlan({ models: true, deleteNodes: false, skillWriteback: false });
    expect(useAppStore.getState().agentPlan).toMatchObject({ state: 'waiting_for_job_retry' });

    const firstRetry = useAppStore.getState().retryAgentPlanJobs();
    await waitForStore(() => bulkPut.mock.calls.length === 2);
    const secondRetry = useAppStore.getState().retryAgentPlanJobs();

    expect(bulkPut).toHaveBeenCalledTimes(2);
    enqueueRetry.resolve();
    await Promise.all([firstRetry, secondRetry]);
    await waitForStore(() => useAppStore.getState().modelJobs.length === 1);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(bulkPut).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().project.projectMemory).toHaveLength(1);
    expect(useAppStore.getState().undoStack).toHaveLength(1);
  });

  it('keeps Agent job retry visible and retryable when the retry enqueue also fails', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    const bulkPut = vi.fn(async () => {
      throw new Error('enqueue still unavailable');
    });
    replaceModelJobStorageForTests(createMutableModelJobStorage([], bulkPut));
    installProviderProfilesForModelJobTests();
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    resetAppStoreForTests();

    useAppStore.getState().draftAgentPlan('Retry failure remains visible', {
      modelRoute: 'image-generation',
    });
    await useAppStore.getState().confirmAgentPlan({ models: true, deleteNodes: false, skillWriteback: false });
    await useAppStore.getState().retryAgentPlanJobs();

    expect(commit).toHaveBeenCalledTimes(1);
    expect(bulkPut).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().project.projectMemory).toHaveLength(1);
    expect(useAppStore.getState().undoStack).toHaveLength(1);
    expect(useAppStore.getState().modelJobs).toEqual([]);
    expect(useAppStore.getState().agentPlan).toMatchObject({ state: 'waiting_for_job_retry' });
    expect(useAppStore.getState().agentPlan?.conflicts.join(' ')).toMatch(/retry|queue|model/i);
  });

  it('does not select or confirm edit-only provider profiles for image generation plans', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    const submitImageJob = vi.fn(async () => ({ providerTaskId: 'provider-task-edit-only' }));
    const listProfiles = vi.fn(async () => [{
      provider: 'comfly',
      modelRoute: 'image-edit-only-route',
      displayName: 'Image Edit Only',
      modelId: 'edit-only-model',
      capabilities: ['image_edit', 'async_tasks'],
    }]);
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    window.novusDesktop = {
      provider: {
        submitImageJob,
        pollImageJob: vi.fn(async () => ({ status: 'running' as const, progress: 0.2 })),
        cancelImageJob: vi.fn(),
        getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' })),
        configure: vi.fn(),
        unlock: vi.fn(),
        listProfiles,
      },
    } as unknown as typeof window.novusDesktop;
    resetAppStoreForTests();

    useAppStore.getState().draftAgentPlan('Edit-only profile must not run generation', {
      modelRoute: 'image-edit-only-route',
    });
    await useAppStore.getState().confirmAgentPlan({ models: true, deleteNodes: false, skillWriteback: false });

    expect(listProfiles).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect(submitImageJob).not.toHaveBeenCalled();
    expect(useAppStore.getState().project.projectMemory).toEqual([]);
    expect(useAppStore.getState().undoStack).toEqual([]);
    expect(useAppStore.getState().modelJobs).toEqual([]);
    expect(useAppStore.getState().agentPlan?.conflicts.join(' ')).toMatch(/model profile/i);
  });

  it('does not invent desktop provider defaults when the bridge reports no configured profiles', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    const submitImageJob = vi.fn(async () => ({ providerTaskId: 'provider-task-missing-profile' }));
    const listProfiles = vi.fn(async () => []);
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    window.novusDesktop = {
      provider: {
        submitImageJob,
        pollImageJob: vi.fn(async () => ({ status: 'running' as const, progress: 0.2 })),
        cancelImageJob: vi.fn(),
        getStatus: vi.fn(async () => ({ configured: false, locked: true, encryption: 'safeStorage' })),
        configure: vi.fn(),
        unlock: vi.fn(),
        listProfiles,
      },
    } as unknown as typeof window.novusDesktop;
    resetAppStoreForTests();

    useAppStore.getState().draftAgentPlan('Do not fabricate GPT Image defaults');

    await expect(
      useAppStore.getState().confirmAgentPlan({ models: true, deleteNodes: false, skillWriteback: false }),
    ).resolves.toBeUndefined();
    expect(listProfiles).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect(submitImageJob).not.toHaveBeenCalled();
    expect(useAppStore.getState().modelJobs).toEqual([]);
    expect(useAppStore.getState().agentPlan?.conflicts.join(' ')).toMatch(/model profile/i);
  });

  it('hydrates durable project before deferred model job recovery finishes', async () => {
    const finalPoll = deferred<{ status: 'completed'; result: { assetId: string } }>();
    replaceModelJobExecutorForTests({
      submit: vi.fn(async (job) => ({ providerTaskId: `task-${job.id}` })),
      poll: vi.fn()
        .mockResolvedValueOnce({ status: 'running' as const, progress: 0.2 })
        .mockReturnValue(finalPoll.promise),
      cancel: vi.fn(async () => {}),
    });
    installProviderProfilesForModelJobTests();
    resetAppStoreForTests();
    useAppStore.getState().draftAgentPlan('start deferred recovery job');
    await useAppStore.getState().confirmAgentPlan({ models: true, deleteNodes: false, skillWriteback: false });
    await waitForStore(() => useAppStore.getState().modelJobs[0]?.status === 'running');

    const durableProject = { ...createStarterProject(), name: 'hydrated-before-recovery-finishes' };
    replaceProjectPersistenceClientForTests(createMockClient({
      hydrate: async () => ({
        availableSnapshotIds: ['snapshot-hydrated'],
        lifecycle: 'durable',
        mode: 'desktop',
        project: durableProject,
        revision: 12,
        saveStatus: 'saved',
      }),
    }));

    const hydration = useAppStore.getState().hydratePersistence();
    try {
      const resolvedBeforeProvider = await Promise.race([
        hydration.then(() => true),
        delay(20).then(() => false),
      ]);

      expect(resolvedBeforeProvider).toBe(true);
      expect(useAppStore.getState().project.name).toBe('hydrated-before-recovery-finishes');
      expect(useAppStore.getState().desktopRevision).toBe(12);
      expect(useAppStore.getState().modelJobs[0]?.status).toBe('running');
    } finally {
      finalPoll.resolve({ status: 'completed', result: { assetId: 'asset-after-hydrate' } });
      await Promise.race([hydration.catch(() => undefined), delay(100)]);
    }
  });

  it('keeps desktop provider jobs running while credentials are locked and completes after unlock', async () => {
    let unlocked = false;
    const submitImageJob = vi.fn(async () => ({ providerTaskId: 'provider-job-app-locked' }));
    const pollImageJob = vi.fn(async () => {
      if (!unlocked) {
        throw { code: 'CREDENTIALS_LOCKED', message: 'locked', retryable: true };
      }
      return {
        status: 'completed' as const,
        progress: 1,
        result: { assetId: 'provider:comfly:provider-job-app-locked:0' },
      };
    });
    const unlock = vi.fn(async () => {
      unlocked = true;
      return { configured: true, locked: false, encryption: 'passphrase' as const };
    });
    window.novusDesktop = {
      provider: {
        ackImageJobTerminal: vi.fn(async () => ({ acknowledged: true as const })),
        cancelImageJob: vi.fn(),
        configure: vi.fn(),
        getStatus: vi.fn(async () => ({ configured: true, locked: !unlocked, encryption: 'passphrase' as const })),
        listProfiles: vi.fn(async () => [{
          provider: 'comfly',
          modelRoute: 'gpt-image',
          displayName: 'GPT Image',
          capabilities: ['image_generation', 'async_tasks'],
        }]),
        pollImageJob,
        submitImageJob,
        unlock,
      },
    } as unknown as typeof window.novusDesktop;
    resetAppStoreForTests();

    useAppStore.getState().draftAgentPlan('resume after credentials unlock');
    await useAppStore.getState().confirmAgentPlan({ models: true, deleteNodes: false, skillWriteback: false });
    await waitForStore(() => pollImageJob.mock.calls.length > 0);
    await delay(20);

    expect(useAppStore.getState().modelJobs[0]).toMatchObject({
      providerTaskId: 'provider-job-app-locked',
      status: 'running',
    });

    await window.novusDesktop!.provider.unlock({ passphrase: 'correct horse battery staple' });
    await waitForStore(() => useAppStore.getState().modelJobs[0]?.status === 'completed');

    expect(useAppStore.getState().modelJobs[0]).toMatchObject({
      resultAssetId: 'provider:comfly:provider-job-app-locked:0',
      status: 'completed',
    });
    expect(window.novusDesktop!.provider.ackImageJobTerminal).toHaveBeenCalledWith({
      provider: 'comfly',
      providerTaskId: 'provider-job-app-locked',
      status: 'completed',
    });
  });

  it('commits recovered model result against hydrated project revision', async () => {
    const finalPoll = deferred<{ status: 'completed'; result: { assetId: string } }>();
    const commit = vi.fn(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: request.nextProject,
      revision: request.baseRevision + 1,
    }));
    replaceModelJobExecutorForTests({
      submit: vi.fn(async (job) => ({ providerTaskId: `task-${job.id}` })),
      poll: vi.fn()
        .mockResolvedValueOnce({ status: 'running' as const, progress: 0.25 })
        .mockReturnValue(finalPoll.promise),
      cancel: vi.fn(async () => {}),
    });
    installProviderProfilesForModelJobTests();
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    resetAppStoreForTests();
    useAppStore.getState().draftAgentPlan('start recoverable job');
    await useAppStore.getState().confirmAgentPlan({ models: true, deleteNodes: false, skillWriteback: false });
    await waitForStore(() => useAppStore.getState().modelJobs[0]?.status === 'running');

    const durableProject = { ...createStarterProject(), name: 'hydrated-result-target' };
    replaceProjectPersistenceClientForTests(createMockClient({
      commit,
      hydrate: async () => ({
        availableSnapshotIds: [],
        lifecycle: 'durable',
        mode: 'desktop',
        project: durableProject,
        revision: 41,
        saveStatus: 'saved',
      }),
    }));

    const hydration = useAppStore.getState().hydratePersistence();
    try {
      await waitForStore(() => useAppStore.getState().project.name === 'hydrated-result-target');
      finalPoll.resolve({ status: 'completed', result: { assetId: 'asset-hydrated-result' } });
      await hydration;
      await waitForStore(() => useAppStore.getState().modelJobs[0]?.status === 'completed');

      const resultCommit = commit.mock.calls
        .map(([request]) => request)
        .find((request) => request.transaction.id.startsWith('model-job-result-'));
      expect(resultCommit?.baseRevision).toBe(41);
      expect(resultCommit?.previousProject.name).toBe('hydrated-result-target');
    } finally {
      finalPoll.resolve({ status: 'completed', result: { assetId: 'asset-hydrated-result' } });
      await Promise.race([hydration.catch(() => undefined), delay(100)]);
    }
  });

  it('streams recovered model job progress and terminal updates after hydration', async () => {
    const finalPoll = deferred<{ status: 'completed'; progress: number; result: { assetId: string } }>();
    replaceModelJobExecutorForTests({
      submit: vi.fn(async (job) => ({ providerTaskId: `task-${job.id}` })),
      poll: vi.fn()
        .mockResolvedValueOnce({ status: 'running' as const, progress: 0.1 })
        .mockResolvedValueOnce({ status: 'running' as const, progress: 0.65 })
        .mockReturnValue(finalPoll.promise),
      cancel: vi.fn(async () => {}),
    });
    installProviderProfilesForModelJobTests();
    resetAppStoreForTests();
    useAppStore.getState().draftAgentPlan('recover with live progress');
    await useAppStore.getState().confirmAgentPlan({ models: true, deleteNodes: false, skillWriteback: false });
    await waitForStore(() => useAppStore.getState().modelJobs[0]?.status === 'running');

    const durableProject = { ...createStarterProject(), name: 'hydrated-live-progress' };
    replaceProjectPersistenceClientForTests(createMockClient({
      hydrate: async () => ({
        availableSnapshotIds: [],
        lifecycle: 'durable',
        mode: 'desktop',
        project: durableProject,
        revision: 7,
        saveStatus: 'saved',
      }),
    }));

    const hydration = useAppStore.getState().hydratePersistence();
    try {
      await hydration;
      expect(useAppStore.getState().modelJobs[0]?.status).toBe('running');
      await waitForStore(() => useAppStore.getState().modelJobs[0]?.progress === 0.65);

      finalPoll.resolve({ status: 'completed', progress: 1, result: { assetId: 'asset-live-recovered' } });
      await waitForStore(() => useAppStore.getState().modelJobs[0]?.status === 'completed');

      expect(useAppStore.getState().modelJobs[0]).toMatchObject({
        resultAssetId: 'asset-live-recovered',
        status: 'completed',
      });
    } finally {
      finalPoll.resolve({ status: 'completed', progress: 1, result: { assetId: 'asset-live-recovered' } });
      await Promise.race([hydration.catch(() => undefined), delay(100)]);
    }
  });

  it('keeps cancel action errors sanitized in model job state', async () => {
    const cancel = vi.fn(async () => {
      throw new Error('Authorization: Bearer secret-token from C:\\Users\\private\\image.png');
    });
    replaceModelJobExecutorForTests({
      submit: vi.fn(async (job) => ({ providerTaskId: `task-${job.id}` })),
      poll: vi.fn(async () => ({ status: 'running' as const, progress: 0.2 })),
      cancel,
    });
    installProviderProfilesForModelJobTests();
    resetAppStoreForTests();

    useAppStore.getState().draftAgentPlan('生成后取消并显示安全错误');
    await useAppStore.getState().confirmAgentPlan({ models: true, deleteNodes: false, skillWriteback: false });
    await waitForStore(() => useAppStore.getState().modelJobs[0]?.status === 'running');

    await expect(useAppStore.getState().cancelModelJob(useAppStore.getState().modelJobs[0]!.id)).resolves.toBeUndefined();

    expect(useAppStore.getState().modelJobs[0]?.error).toContain('[redacted]');
    expect(JSON.stringify(useAppStore.getState().modelJobs)).not.toMatch(/Authorization|secret-token|C:\\\\Users/i);
  });

  it('keeps provider-completed cancel results as the first terminal state', async () => {
    const providerTaskId = 'provider-job-app-cancel-completed';
    const ackImageJobTerminal = vi.fn(async () => ({ acknowledged: true as const }));
    window.novusDesktop = createDesktopProviderBridgeForCancel({
      ackImageJobTerminal,
      cancelImageJob: vi.fn(async () => ({
        status: 'completed' as const,
        progress: 1,
        result: { assetId: 'provider:comfly:provider-job-app-cancel-completed:0' },
      })),
      pollImageJob: vi.fn(async () => ({ status: 'running' as const, progress: 0.2 })),
      providerTaskId,
    });
    resetAppStoreForTests();

    useAppStore.getState().draftAgentPlan('cancel should keep the completed provider terminal');
    await useAppStore.getState().confirmAgentPlan({ models: true, deleteNodes: false, skillWriteback: false });
    await waitForStore(() => useAppStore.getState().modelJobs[0]?.status === 'running');

    await useAppStore.getState().cancelModelJob(useAppStore.getState().modelJobs[0]!.id);
    await waitForStore(() => useAppStore.getState().modelJobs[0]?.status === 'completed');

    expect(useAppStore.getState().modelJobs[0]).toMatchObject({
      providerTaskId,
      resultAssetId: 'provider:comfly:provider-job-app-cancel-completed:0',
      status: 'completed',
    });
    expect(ackImageJobTerminal).toHaveBeenCalledWith({
      provider: 'comfly',
      providerTaskId,
      status: 'completed',
    });
  });

  it('keeps provider-failed cancel results as the first terminal state', async () => {
    const providerTaskId = 'provider-job-app-cancel-failed';
    const ackImageJobTerminal = vi.fn(async () => ({ acknowledged: true as const }));
    window.novusDesktop = createDesktopProviderBridgeForCancel({
      ackImageJobTerminal,
      cancelImageJob: vi.fn(async () => ({
        status: 'failed' as const,
        error: { code: 'PROVIDER_ERROR' as const, message: 'remote cancel failed terminal', retryable: false },
      })),
      pollImageJob: vi.fn(async () => ({ status: 'running' as const, progress: 0.2 })),
      providerTaskId,
    });
    resetAppStoreForTests();

    useAppStore.getState().draftAgentPlan('cancel should keep the failed provider terminal');
    await useAppStore.getState().confirmAgentPlan({ models: true, deleteNodes: false, skillWriteback: false });
    await waitForStore(() => useAppStore.getState().modelJobs[0]?.status === 'running');

    await useAppStore.getState().cancelModelJob(useAppStore.getState().modelJobs[0]!.id);
    await waitForStore(() => useAppStore.getState().modelJobs[0]?.status === 'failed');

    expect(useAppStore.getState().modelJobs[0]).toMatchObject({
      providerTaskId,
      status: 'failed',
    });
    expect(useAppStore.getState().modelJobs[0]?.error).toBeTruthy();
    expect(ackImageJobTerminal).toHaveBeenCalledWith({
      provider: 'comfly',
      providerTaskId,
      status: 'failed',
    });
  });

  it('allows provider-cancelled cancel results to stay cancelled', async () => {
    const providerTaskId = 'provider-job-app-cancel-cancelled';
    const ackImageJobTerminal = vi.fn(async () => ({ acknowledged: true as const }));
    window.novusDesktop = createDesktopProviderBridgeForCancel({
      ackImageJobTerminal,
      cancelImageJob: vi.fn(async () => ({ status: 'cancelled' as const })),
      pollImageJob: vi.fn(async () => ({ status: 'running' as const, progress: 0.2 })),
      providerTaskId,
    });
    resetAppStoreForTests();

    useAppStore.getState().draftAgentPlan('cancel should keep the cancelled provider terminal');
    await useAppStore.getState().confirmAgentPlan({ models: true, deleteNodes: false, skillWriteback: false });
    await waitForStore(() => useAppStore.getState().modelJobs[0]?.status === 'running');

    await useAppStore.getState().cancelModelJob(useAppStore.getState().modelJobs[0]!.id);
    await waitForStore(() => useAppStore.getState().modelJobs[0]?.status === 'cancelled');

    expect(useAppStore.getState().modelJobs[0]).toMatchObject({
      providerTaskId,
      status: 'cancelled',
    });
    expect(ackImageJobTerminal).toHaveBeenCalledWith({
      provider: 'comfly',
      providerTaskId,
      status: 'cancelled',
    });
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

  it('enriches promoted project memory through the knowledge bridge before rendering review', async () => {
    const prepareSkillCandidateReview = vi.fn(async ({ candidateId }: { candidateId: string }) => {
      const candidate = useAppStore.getState().project.skillPromotionCandidates.find((item) => item.id === candidateId);
      if (candidate === undefined) throw new Error('missing candidate');
      const reviewable = {
        ...candidate,
        sourceRule: 'Source memory rule body: lock the product logo before changing props.',
        managedRule: 'Managed rule body: keep the current scene skill wording.',
        diffHunks: [
          '- Managed rule body: keep the current scene skill wording.',
          '+ Source memory rule body: lock the product logo before changing props.',
        ],
      };
      return {
        projectId: 'local-project',
        currentRevision: 2,
        candidate: reviewable,
        candidates: [reviewable],
        knowledgeState: null,
      };
    });
    replaceKnowledgeClientForTests({
      configure: vi.fn(),
      getLease: vi.fn(),
      prepareSkillCandidateReview,
      review: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    } as unknown as KnowledgeClient);
    useAppStore.getState().draftAgentPlan('Promote with prepared review text');
    await useAppStore.getState().confirmAgentPlan({ models: false, deleteNodes: false, skillWriteback: false });
    const memoryId = useAppStore.getState().project.projectMemory[0]!.id;

    await useAppStore.getState().promoteProjectMemory(memoryId);

    expect(prepareSkillCandidateReview).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'local-project',
      candidateId: expect.stringMatching(/^skill-candidate-/),
    }));
    expect(useAppStore.getState().project.skillPromotionCandidates).toMatchObject([{
      sourceProjectMemoryId: memoryId,
      reviewStatus: 'pending_review',
      sourceRule: expect.stringContaining('Source memory rule body'),
      managedRule: expect.stringContaining('Managed rule body'),
      diffHunks: expect.arrayContaining([
        expect.stringContaining('- Managed rule body'),
        expect.stringContaining('+ Source memory rule body'),
      ]),
    }]);
  });

  it('sends the current persisted candidate revision and fingerprint when preparing Skill review text', async () => {
    let revision = 0;
    replaceProjectPersistenceClientForTests(createMockClient({
      commit: vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
        ok: true,
        project: nextProject,
        revision: ++revision,
      })),
    }));
    const prepareSkillCandidateReview = vi.fn(async (request: Parameters<KnowledgeClient['prepareSkillCandidateReview']>[0]) => {
      const candidate = useAppStore.getState().project.skillPromotionCandidates.find((item) => item.id === request.candidateId);
      if (candidate === undefined) throw new Error('missing candidate');
      expect(request.baseRevision).toBe(2);
      expect(request.candidateFingerprint).toBe(createSkillPromotionCandidateFingerprint(candidate));
      expect(candidate.reviewPreparationStatus).toBe('preparing');
      const reviewable = {
        ...candidate,
        reviewPreparationStatus: 'ready' as const,
        sourceRule: 'Source memory rule body: lock the product logo before changing props.',
        managedRule: 'Managed rule body: keep the current scene skill wording.',
        diffHunks: [
          '- Managed rule body: keep the current scene skill wording.',
          '+ Source memory rule body: lock the product logo before changing props.',
        ],
      };
      return {
        projectId: 'local-project',
        currentRevision: 3,
        candidate: reviewable,
        candidates: [reviewable],
        knowledgeState: null,
      };
    });
    replaceKnowledgeClientForTests({
      configure: vi.fn(),
      getLease: vi.fn(),
      prepareSkillCandidateReview,
      review: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    } as unknown as KnowledgeClient);
    useAppStore.getState().draftAgentPlan('Promote with a guarded prepare request');
    await useAppStore.getState().confirmAgentPlan({ models: false, deleteNodes: false, skillWriteback: false });
    const memoryId = useAppStore.getState().project.projectMemory[0]!.id;

    await useAppStore.getState().promoteProjectMemory(memoryId);

    expect(prepareSkillCandidateReview).toHaveBeenCalledOnce();
    expect(useAppStore.getState().project.skillPromotionCandidates[0]).toMatchObject({
      reviewPreparationStatus: 'ready',
      sourceRule: expect.stringContaining('Source memory rule body'),
      managedRule: expect.stringContaining('Managed rule body'),
    });
  });

  it('does not revive a candidate rejected while Skill review preparation is still in flight', async () => {
    const prepared = deferred<Awaited<ReturnType<KnowledgeClient['prepareSkillCandidateReview']>>>();
    const prepareSkillCandidateReview = vi.fn(() => prepared.promise);
    const review = vi.fn(async ({ candidateId }: { candidateId: string }) => {
      const candidate = useAppStore.getState().project.skillPromotionCandidates.find((item) => item.id === candidateId);
      if (candidate === undefined) throw new Error('missing candidate');
      const rejected = {
        ...candidate,
        reviewPreparationStatus: 'ready' as const,
        reviewStatus: 'rejected' as const,
        reviewedAt: '2026-07-16T05:01:00.000Z',
        reviewTransactionId: 'review-skill-rejected',
      };
      return {
        projectId: 'local-project',
        currentRevision: 3,
        candidate: rejected,
        candidates: [rejected],
        knowledgeState: null,
      };
    });
    replaceKnowledgeClientForTests({
      configure: vi.fn(),
      getLease: vi.fn(),
      prepareSkillCandidateReview,
      review,
      start: vi.fn(),
      stop: vi.fn(),
    } as unknown as KnowledgeClient);
    useAppStore.getState().draftAgentPlan('Promote then reject during prepare');
    await useAppStore.getState().confirmAgentPlan({ models: false, deleteNodes: false, skillWriteback: false });
    const memoryId = useAppStore.getState().project.projectMemory[0]!.id;

    const promotion = useAppStore.getState().promoteProjectMemory(memoryId);
    await waitForStore(() => prepareSkillCandidateReview.mock.calls.length === 1);
    const candidate = useAppStore.getState().project.skillPromotionCandidates[0]!;

    await useAppStore.getState().reviewSkillCandidate({
      projectId: 'local-project',
      candidateId: candidate.id,
      decision: 'rejected',
    });
    prepared.resolve({
      projectId: 'local-project',
      currentRevision: 4,
      candidate: {
        ...candidate,
        reviewPreparationStatus: 'ready',
        sourceRule: 'Stale source rule must not revive the candidate.',
        managedRule: 'Stale managed rule must not revive the candidate.',
        diffHunks: ['- old', '+ stale'],
      } as SkillPromotionCandidate,
      candidates: [{
        ...candidate,
        reviewPreparationStatus: 'ready',
        sourceRule: 'Stale source rule must not revive the candidate.',
        managedRule: 'Stale managed rule must not revive the candidate.',
        diffHunks: ['- old', '+ stale'],
      } as SkillPromotionCandidate],
      knowledgeState: null,
    });
    await promotion;

    expect(useAppStore.getState().project.skillPromotionCandidates[0]).toMatchObject({
      id: candidate.id,
      reviewStatus: 'rejected',
      reviewedAt: '2026-07-16T05:01:00.000Z',
    });
    expect(useAppStore.getState().project.skillPromotionCandidates[0]?.sourceRule).toBeUndefined();
  });

  it('does not revive a candidate superseded while Skill review preparation is still in flight', async () => {
    const prepared = deferred<Awaited<ReturnType<KnowledgeClient['prepareSkillCandidateReview']>>>();
    const prepareSkillCandidateReview = vi.fn(() => prepared.promise);
    const review = vi.fn(async ({ candidateId }: { candidateId: string }) => {
      const candidate = useAppStore.getState().project.skillPromotionCandidates.find((item) => item.id === candidateId);
      if (candidate === undefined) throw new Error('missing candidate');
      const superseded = {
        ...candidate,
        reviewStatus: 'superseded' as const,
        reviewedAt: '2026-07-16T05:02:00.000Z',
        reviewTransactionId: 'review-skill-superseded',
      };
      return {
        projectId: 'local-project',
        currentRevision: 3,
        candidate: superseded,
        candidates: [superseded],
        knowledgeState: null,
      };
    });
    replaceKnowledgeClientForTests({
      configure: vi.fn(),
      getLease: vi.fn(),
      prepareSkillCandidateReview,
      review,
      start: vi.fn(),
      stop: vi.fn(),
    } as unknown as KnowledgeClient);
    useAppStore.getState().draftAgentPlan('Promote then supersede during prepare');
    await useAppStore.getState().confirmAgentPlan({ models: false, deleteNodes: false, skillWriteback: false });
    const memoryId = useAppStore.getState().project.projectMemory[0]!.id;

    const promotion = useAppStore.getState().promoteProjectMemory(memoryId);
    await waitForStore(() => prepareSkillCandidateReview.mock.calls.length === 1);
    const candidate = useAppStore.getState().project.skillPromotionCandidates[0]!;

    await useAppStore.getState().reviewSkillCandidate({
      projectId: 'local-project',
      candidateId: candidate.id,
      decision: 'superseded',
    });
    prepared.resolve({
      projectId: 'local-project',
      currentRevision: 4,
      candidate: {
        ...candidate,
        reviewPreparationStatus: 'ready',
        sourceRule: 'Stale source rule must not revive superseded candidate.',
        managedRule: 'Stale managed rule must not revive superseded candidate.',
        diffHunks: ['- old', '+ stale'],
      } as SkillPromotionCandidate,
      candidates: [{
        ...candidate,
        reviewPreparationStatus: 'ready',
        sourceRule: 'Stale source rule must not revive superseded candidate.',
        managedRule: 'Stale managed rule must not revive superseded candidate.',
        diffHunks: ['- old', '+ stale'],
      } as SkillPromotionCandidate],
      knowledgeState: null,
    });
    await promotion;

    expect(useAppStore.getState().project.skillPromotionCandidates[0]).toMatchObject({
      id: candidate.id,
      reviewStatus: 'superseded',
      reviewedAt: '2026-07-16T05:02:00.000Z',
    });
    expect(useAppStore.getState().project.skillPromotionCandidates[0]?.sourceRule).toBeUndefined();
  });

  it('discards stale Skill review preparation after the project revision changes', async () => {
    const prepared = deferred<Awaited<ReturnType<KnowledgeClient['prepareSkillCandidateReview']>>>();
    const prepareSkillCandidateReview = vi.fn(() => prepared.promise);
    replaceKnowledgeClientForTests({
      configure: vi.fn(),
      getLease: vi.fn(),
      prepareSkillCandidateReview,
      review: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    } as unknown as KnowledgeClient);
    useAppStore.getState().draftAgentPlan('Promote then move the project revision');
    await useAppStore.getState().confirmAgentPlan({ models: false, deleteNodes: false, skillWriteback: false });
    const memoryId = useAppStore.getState().project.projectMemory[0]!.id;

    const promotion = useAppStore.getState().promoteProjectMemory(memoryId);
    await waitForStore(() => prepareSkillCandidateReview.mock.calls.length === 1);
    const candidate = useAppStore.getState().project.skillPromotionCandidates[0]!;
    useAppStore.setState((state) => ({
      desktopRevision: state.desktopRevision + 1,
      project: {
        ...state.project,
        name: 'revision changed before prepare returned',
      },
    }));
    const revisionAfterLocalChange = useAppStore.getState().desktopRevision;

    prepared.resolve({
      projectId: 'local-project',
      currentRevision: 99,
      candidate: {
        ...candidate,
        reviewPreparationStatus: 'ready',
        sourceRule: 'Stale source rule from old project revision.',
        managedRule: 'Stale managed rule from old project revision.',
        diffHunks: ['- old', '+ stale'],
      } as SkillPromotionCandidate,
      candidates: [{
        ...candidate,
        reviewPreparationStatus: 'ready',
        sourceRule: 'Stale source rule from old project revision.',
        managedRule: 'Stale managed rule from old project revision.',
        diffHunks: ['- old', '+ stale'],
      } as SkillPromotionCandidate],
      knowledgeState: null,
    });
    await promotion;

    expect(useAppStore.getState().desktopRevision).toBe(revisionAfterLocalChange);
    expect(useAppStore.getState().project.name).toBe('revision changed before prepare returned');
    expect(useAppStore.getState().project.skillPromotionCandidates[0]).toMatchObject({
      id: candidate.id,
      reviewPreparationStatus: 'preparing',
    });
    expect(useAppStore.getState().project.skillPromotionCandidates[0]?.sourceRule).toBeUndefined();
  });

  it('keeps failed Skill review preparation visible and non-reviewable', async () => {
    replaceKnowledgeClientForTests({
      configure: vi.fn(),
      getLease: vi.fn(),
      prepareSkillCandidateReview: vi.fn(async () => {
        throw new Error('Active knowledge snapshot is unavailable');
      }),
      review: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    } as unknown as KnowledgeClient);
    useAppStore.getState().draftAgentPlan('Promote with missing managed knowledge');
    await useAppStore.getState().confirmAgentPlan({ models: false, deleteNodes: false, skillWriteback: false });
    const memoryId = useAppStore.getState().project.projectMemory[0]!.id;

    await useAppStore.getState().promoteProjectMemory(memoryId);

    expect(useAppStore.getState().project.skillPromotionCandidates[0]).toMatchObject({
      reviewStatus: 'pending_review',
      reviewPreparationStatus: 'failed',
      reviewPreparationError: expect.stringContaining('Active knowledge snapshot is unavailable'),
    });
    expect(useAppStore.getState().project.skillPromotionCandidates[0]?.sourceRule).toBeUndefined();
    expect(useAppStore.getState().project.skillPromotionCandidates[0]?.managedRule).toBeUndefined();
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

  it('binds Skill approval to the ready preview metadata the user saw', async () => {
    const preview = {
      knowledgeBaseId: 'scene-skill',
      version: 1,
      contentHash: 'a'.repeat(64),
    };
    const readyCandidate = {
      ...createSkillCandidate('candidate-ready-preview', 'pending_review'),
      targetKnowledgeBaseId: 'scene-skill',
      reviewPreparationStatus: 'ready',
      sourceRule: 'Source rule shown in the preview.',
      managedRule: 'Managed rule shown in the preview.',
      diffHunks: ['- Managed rule shown in the preview.', '+ Source rule shown in the preview.'],
      preparedManagedSnapshot: preview,
    } as SkillPromotionCandidate;
    const approvedCandidate = {
      ...readyCandidate,
      reviewStatus: 'approved' as const,
      reviewedAt: '2026-07-16T05:30:00.000Z',
      publishedKnowledgeVersion: 2,
    };
    const client = createMockKnowledgeClient({
      initialStates: [knowledgeState({ version: 1, hashPrefix: 'a' })],
      reviewResult: {
        projectId: 'local-project',
        currentRevision: 8,
        candidate: approvedCandidate,
        knowledgeState: knowledgeState({ version: 2, hashPrefix: 'b' }),
      },
    });
    replaceKnowledgeClientForTests(client);
    resetAppStoreForTests();
    useAppStore.setState((state) => ({
      desktopRevision: 7,
      project: {
        ...state.project,
        skillPromotionCandidates: [readyCandidate],
      },
    }));

    await useAppStore.getState().reviewSkillCandidate({
      projectId: 'local-project',
      candidateId: 'candidate-ready-preview',
      decision: 'approved',
    });

    expect(client.review).toHaveBeenCalledWith({
      projectId: 'local-project',
      candidateId: 'candidate-ready-preview',
      decision: 'approved',
      baseRevision: 7,
      candidateFingerprint: expect.any(String),
      preparedManagedSnapshot: preview,
    });
  });

  it('stores sync lifecycle separately and replaces conflict with updated for the same knowledge base', async () => {
    const client = createMockKnowledgeClient({
      initialStates: [knowledgeState({ version: 2, hashPrefix: 'a' })],
      reviewResult: {
        projectId: 'local-project',
        currentRevision: 2,
        candidate: createSkillCandidate('candidate-sync', 'approved'),
        knowledgeState: null,
      },
    });
    client.start.mockImplementationOnce(async (stateListener, syncListener) => {
      stateListener([knowledgeState({ version: 2, hashPrefix: 'a' })]);
      syncListener?.({
        schemaVersion: 1,
        knowledgeBaseId: 'scene-skill',
        status: 'conflict',
        changedAt: '2026-07-16T04:00:00.000Z',
        lastFailure: { reason: 'Version conflict', failedAt: '2026-07-16T04:00:00.000Z' },
      });
      syncListener?.({
        schemaVersion: 1,
        knowledgeBaseId: 'scene-skill',
        status: 'updated',
        changedAt: '2026-07-16T04:01:00.000Z',
        lastFailure: null,
      });
    });
    replaceKnowledgeClientForTests(client);
    resetAppStoreForTests();

    await useAppStore.getState().initializeKnowledge();

    expect(useAppStore.getState().knowledgeBases).toEqual([
      expect.objectContaining({ activeVersion: 2, status: 'active' }),
    ]);
    expect(useAppStore.getState().knowledgeSyncStatuses).toEqual([
      expect.objectContaining({ knowledgeBaseId: 'scene-skill', status: 'updated', lastFailure: null }),
    ]);
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
      lifecycle: 'durable' as const,
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
        lifecycle: 'durable',
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
      observations: {
        composition: ['Keep the product centered'],
        liquid: ['Use calmer liquid arcs'],
      },
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
      targetKnowledgeBaseId: 'scene-skill',
      targetKnowledgeSection: 'reverse-prompt/feedback',
      affectedCapabilities: ['reverse_prompt'],
      counts: {
        supportingMemoryCount: 1,
        referenceCount: 1,
        citationCount: 1,
        observationCount: 2,
      },
      confidence: 1,
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
      candidates: [rolledBackCandidate],
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

  it('replaces the skill candidate collection atomically when rollback updates multiple candidates', async () => {
    const candidateV3 = {
      ...createSkillCandidate('candidate-v3', 'approved'),
      targetKnowledgeBaseId: 'scene-skill',
      publishedKnowledgeVersion: 3,
      reviewedAt: '2026-07-15T09:00:00.000Z',
    };
    const selectedV4 = {
      ...createSkillCandidate('candidate-v4', 'approved'),
      targetKnowledgeBaseId: 'scene-skill',
      publishedKnowledgeVersion: 4,
      reviewedAt: '2026-07-15T09:05:00.000Z',
    };
    const retainedV2 = {
      ...createSkillCandidate('candidate-v2', 'approved'),
      targetKnowledgeBaseId: 'scene-skill',
      publishedKnowledgeVersion: 2,
      reviewedAt: '2026-07-15T08:55:00.000Z',
    };
    const rolledBackV3 = {
      ...candidateV3,
      reviewStatus: 'rolled_back' as const,
      rolledBackAt: '2026-07-15T10:00:00.000Z',
    };
    const rolledBackV4 = {
      ...selectedV4,
      reviewStatus: 'rolled_back' as const,
      rolledBackAt: '2026-07-15T10:00:00.000Z',
    };
    const client = createMockKnowledgeClient({
      initialStates: [],
      reviewResult: {
        projectId: 'local-project',
        currentRevision: 7,
        candidate: rolledBackV4,
        candidates: [retainedV2, rolledBackV3, rolledBackV4],
        knowledgeState: knowledgeState({ version: 2, hashPrefix: 'b' }),
      },
    });
    replaceKnowledgeClientForTests(client);
    resetAppStoreForTests();
    useAppStore.setState((state) => ({
      project: {
        ...state.project,
        skillPromotionCandidates: [retainedV2, candidateV3, selectedV4],
      },
    }));

    await useAppStore.getState().reviewSkillCandidate({
      projectId: 'local-project',
      candidateId: selectedV4.id,
      decision: 'rolled_back',
      targetVersion: 2,
    });

    expect(useAppStore.getState().project.skillPromotionCandidates.map((candidate) => [candidate.id, candidate.reviewStatus])).toEqual([
      ['candidate-v2', 'approved'],
      ['candidate-v3', 'rolled_back'],
      ['candidate-v4', 'rolled_back'],
    ]);
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

describe('stable module graph commits', () => {
  beforeEach(() => {
    delete window.novusDesktop;
    replaceProjectPersistenceClientForTests(createImmediateBrowserClient());
    resetAppStoreForTests();
  });

  it('connects compatible module ports once and rejects invalid handles before persistence', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    const project = moduleGraphProject();
    useAppStore.setState({ project, saveStatus: 'saved' });

    const valid = await useAppStore.getState().connectModulePorts({
      source: 'prompt', sourceHandle: 'prompt', target: 'generator', targetHandle: 'prompt',
    });
    const invalid = await useAppStore.getState().connectModulePorts({
      source: 'prompt', sourceHandle: 'missing', target: 'generator', targetHandle: 'prompt',
    });

    expect(valid).toBe(true);
    expect(invalid).toBe(false);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]![0].transaction.operations).toEqual([{
      kind: 'canvas',
      operation: expect.objectContaining({ kind: 'create_edge' }),
    }]);
    expect(useAppStore.getState().project.edges.filter((edge) => edge.source === 'prompt' && edge.target === 'generator')).toHaveLength(1);
  });

  it('allows one many-input connection, rejects its exact duplicate, and allows a distinct source', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    useAppStore.setState({ project: moduleGraphProjectWithEmptyReferences(), saveStatus: 'saved' });
    const connection = { source: 'image-a', sourceHandle: 'image', target: 'reverse', targetHandle: 'references' } as const;

    expect(await useAppStore.getState().connectModulePorts(connection)).toBe(true);
    expect(useAppStore.getState().saveStatus).toBe('saved');
    expect(await useAppStore.getState().connectModulePorts(connection)).toBe(false);
    expect(useAppStore.getState().saveStatus).toBe('saved');
    expect(await useAppStore.getState().connectModulePorts({
      source: 'image-b', sourceHandle: 'image', target: 'reverse', targetHandle: 'references',
    })).toBe(true);

    expect(commit).toHaveBeenCalledTimes(2);
  });

  it('treats missing, ghost, non-module, and incompatible endpoints as synchronous invalid connections', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    useAppStore.setState({ project: moduleGraphProject(), saveStatus: 'saved' });

    const requests = [
      { source: 'missing', sourceHandle: 'prompt', target: 'generator', targetHandle: 'prompt' },
      { source: 'prompt', sourceHandle: null, target: 'generator', targetHandle: 'prompt' },
      { source: 'prompt', sourceHandle: 'prompt', target: 'prompt-start', targetHandle: 'prompt' },
      { source: 'prompt', sourceHandle: 'prompt', target: 'generator', targetHandle: 'references' },
    ] as const;

    for (const request of requests) {
      expect(await useAppStore.getState().connectModulePorts(request)).toBe(false);
    }

    expect(commit).not.toHaveBeenCalled();
    expect(useAppStore.getState().saveStatus).toBe('saved');
  });

  it('keeps a failed node position dirty and retries the same durable transaction explicitly', async () => {
    const commit = vi.fn()
      .mockImplementationOnce(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
        code: 'DISK_FULL',
        ok: false,
        project: request.previousProject,
        revision: request.baseRevision,
      }))
      .mockImplementationOnce(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
        ok: true,
        project: request.nextProject,
        revision: request.baseRevision + 1,
      }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    const project = moduleGraphProject();
    useAppStore.setState({ project, saveStatus: 'saved' });

    expect(await useAppStore.getState().commitNodePosition('prompt', { x: 0, y: 0 })).toBe(true);
    expect(commit).not.toHaveBeenCalled();

    expect(await useAppStore.getState().commitNodePosition('prompt', { x: 20, y: 30 })).toBe(false);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().project.nodes.find((node) => node.id === 'prompt')?.position).toEqual({ x: 20, y: 30 });
    expect(useAppStore.getState().saveStatus).toBe('error');
    expect(useAppStore.getState().canRetryProjectCommit).toBe(true);

    expect(await useAppStore.getState().retryFailedProjectCommit()).toBe(true);
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls[1]![0].transaction).toEqual(commit.mock.calls[0]![0].transaction);
    expect(commit.mock.calls[1]![0].nextProject.nodes.find((node: { id: string }) => node.id === 'prompt')?.position)
      .toEqual({ x: 20, y: 30 });
    expect(useAppStore.getState().saveStatus).toBe('saved');
    expect(useAppStore.getState().canRetryProjectCommit).toBe(false);
  });

  it('does not let a delayed failed-commit retry replace a newly opened project', async () => {
    const retryAck = deferred<ProjectCommitResult>();
    const openedProject = { ...moduleGraphProject(), name: 'Opened while retrying' };
    const commit = vi.fn()
      .mockImplementationOnce(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
        code: 'DISK_FULL',
        ok: false,
        project: request.previousProject,
        revision: request.baseRevision,
      }))
      .mockReturnValueOnce(retryAck.promise);
    replaceProjectPersistenceClientForTests(createMockClient({
      commit,
      openProject: async () => ({
        availableSnapshotIds: [],
        lifecycle: 'durable',
        mode: 'desktop',
        project: openedProject,
        revision: 9,
        saveStatus: 'saved',
      }),
    }));
    useAppStore.setState({ project: moduleGraphProject(), saveStatus: 'saved' });

    expect(await useAppStore.getState().commitNodePosition('prompt', { x: 20, y: 30 })).toBe(false);
    const retry = useAppStore.getState().retryFailedProjectCommit();
    expect(await useAppStore.getState().openProject()).toBe(true);

    retryAck.resolve({ ok: true, project: commit.mock.calls[1]![0].nextProject, revision: 1 });
    expect(await retry).toBe(false);
    expect(useAppStore.getState()).toMatchObject({
      canRetryProjectCommit: false,
      desktopRevision: 9,
      project: { name: 'Opened while retrying' },
      saveStatus: 'saved',
    });
  });

  it('serializes rapid stable graph operations against the latest acknowledged revision and continues after failure', async () => {
    const firstAck = deferred<CommitAck>();
    const commit = vi.fn()
      .mockReturnValueOnce(firstAck.promise)
      .mockImplementation(async (request: ProjectCommitRequest) => ({
        ok: true,
        project: request.nextProject,
        revision: request.baseRevision + 1,
      } satisfies ProjectCommitResult));
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    useAppStore.setState({ project: moduleGraphProject(), saveStatus: 'saved' });

    const first = useAppStore.getState().commitNodePosition('prompt', { x: 20, y: 30 });
    const second = useAppStore.getState().commitNodePosition('generator', { x: 420, y: 30 });
    expect(commit).toHaveBeenCalledTimes(1);

    firstAck.resolve({
      committedAt: '2026-07-17T10:00:00.000Z',
      projectId: 'local-project',
      revision: 4,
      sequence: 4,
      transactionId: commit.mock.calls[0]![0].transaction.id,
    });

    await waitForStore(() => commit.mock.calls.length === 2);
    expect(commit.mock.calls[1]![0].baseRevision).toBe(4);
    expect(commit.mock.calls[1]![0].previousProject.nodes.find((node: { id: string }) => node.id === 'prompt')?.position).toEqual({ x: 20, y: 30 });
    expect(await first).toBe(true);
    expect(await second).toBe(true);
  });

  it('reorders a many-input module port and rejects non-permutations without persistence', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    useAppStore.setState({ project: moduleGraphProjectWithReferences(), saveStatus: 'saved' });

    expect(await useAppStore.getState().reorderModuleInput('reverse', 'references', ['edge-b', 'edge-a'])).toBe(true);
    expect(await useAppStore.getState().reorderModuleInput('reverse', 'references', ['edge-a'])).toBe(false);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().project.edges.filter((edge) => edge.target === 'reverse').map((edge) => [edge.id, edge.order])).toEqual([
      ['edge-a', 1],
      ['edge-b', 0],
    ]);
  });

  it('treats an already ordered many-input request as a saved no-op', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    useAppStore.setState({ project: moduleGraphProjectWithReferences(), saveStatus: 'saved' });

    expect(await useAppStore.getState().reorderModuleInput('reverse', 'references', ['edge-a', 'edge-b'])).toBe(true);
    expect(commit).not.toHaveBeenCalled();
    expect(useAppStore.getState().saveStatus).toBe('saved');
  });

  it('rejects self and multi-node cycles before persistence', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    useAppStore.setState({ project: moduleGraphProjectWithCycle(), saveStatus: 'saved' });

    expect(await useAppStore.getState().connectModulePorts({
      source: 'editor-a', sourceHandle: 'image', target: 'editor-a', targetHandle: 'image',
    })).toBe(false);
    expect(await useAppStore.getState().connectModulePorts({
      source: 'editor-c', sourceHandle: 'image', target: 'editor-a', targetHandle: 'image',
    })).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(useAppStore.getState().saveStatus).toBe('saved');
  });
});

function moduleGraphProject(): CanvasProject {
  const starter = createStarterProject();
  return parseCanvasProject({
    ...starter,
    nodes: [
      ...starter.nodes,
      createCanvasModuleNode('prompt', 'text_prompt', { x: 0, y: 0 }),
      createCanvasModuleNode('generator', 'image_generation', { x: 320, y: 0 }),
    ],
  });
}

function moduleGraphProjectWithReferences(): CanvasProject {
  return parseCanvasProject({
    ...moduleGraphProject(),
    nodes: [
      ...moduleGraphProject().nodes,
      createCanvasModuleNode('image-a', 'image_input', { x: 0, y: 240 }),
      createCanvasModuleNode('image-b', 'image_input', { x: 0, y: 400 }),
      createCanvasModuleNode('reverse', 'reverse_agent', { x: 360, y: 320 }),
    ],
    edges: [
      ...moduleGraphProject().edges,
      { id: 'edge-a', source: 'image-a', sourcePortId: 'image', target: 'reverse', targetPortId: 'references', order: 0 },
      { id: 'edge-b', source: 'image-b', sourcePortId: 'image', target: 'reverse', targetPortId: 'references', order: 1 },
    ],
  });
}

function moduleGraphProjectWithEmptyReferences(): CanvasProject {
  const project = moduleGraphProject();
  return parseCanvasProject({
    ...project,
    nodes: [
      ...project.nodes,
      createCanvasModuleNode('image-a', 'image_input', { x: 0, y: 240 }),
      createCanvasModuleNode('image-b', 'image_input', { x: 0, y: 400 }),
      createCanvasModuleNode('reverse', 'reverse_agent', { x: 360, y: 320 }),
    ],
  });
}

function moduleGraphProjectWithCycle(): CanvasProject {
  const starter = createStarterProject();
  return parseCanvasProject({
    ...starter,
    nodes: [
      ...starter.nodes,
      createCanvasModuleNode('editor-a', 'image_editor', { x: 0, y: 240 }),
      createCanvasModuleNode('editor-b', 'image_editor', { x: 320, y: 240 }),
      createCanvasModuleNode('editor-c', 'image_editor', { x: 640, y: 240 }),
    ],
    edges: [
      ...starter.edges,
      { id: 'cycle-a-b', source: 'editor-a', sourcePortId: 'image', target: 'editor-b', targetPortId: 'image', order: 0 },
      { id: 'cycle-b-c', source: 'editor-b', sourcePortId: 'image', target: 'editor-c', targetPortId: 'image', order: 0 },
    ],
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function waitForStore(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1000) {
      throw new Error('Timed out waiting for app store state');
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cloneProjectForExpectation<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createTestModelJobStorage(seed: ModelJob[] = []) {
  const jobs = new Map(seed.map((job) => [job.id, { ...job, referenceAssetIds: [...job.referenceAssetIds] }]));
  return {
    get: async (id: string) => {
      const job = jobs.get(id);
      return job === undefined ? undefined : { ...job, referenceAssetIds: [...job.referenceAssetIds] };
    },
    list: async () => [...jobs.values()].map((job) => ({ ...job, referenceAssetIds: [...job.referenceAssetIds] })),
    put: async (job: ModelJob) => {
      jobs.set(job.id, { ...job, referenceAssetIds: [...job.referenceAssetIds] });
    },
    bulkPut: async (nextJobs: ModelJob[]) => {
      for (const job of nextJobs) {
        jobs.set(job.id, { ...job, referenceAssetIds: [...job.referenceAssetIds] });
      }
    },
  };
}

function createMutableModelJobStorage(
  jobs: ModelJob[],
  bulkPut: (jobs: ModelJob[]) => Promise<void>,
) {
  return {
    get: async (id: string) => {
      const job = jobs.find((item) => item.id === id);
      return job === undefined ? undefined : { ...job, referenceAssetIds: [...job.referenceAssetIds] };
    },
    list: async () => jobs.map((job) => ({ ...job, referenceAssetIds: [...job.referenceAssetIds] })),
    put: async (job: ModelJob) => {
      const index = jobs.findIndex((item) => item.id === job.id);
      if (index >= 0) jobs[index] = { ...job, referenceAssetIds: [...job.referenceAssetIds] };
      else jobs.push({ ...job, referenceAssetIds: [...job.referenceAssetIds] });
    },
    bulkPut,
  };
}

function installProviderProfilesForModelJobTests(profiles = [{
  provider: 'comfly',
  modelRoute: 'image-generation',
  displayName: 'GPT Image',
  modelId: 'gpt-image-1',
  capabilities: ['image_generation', 'async_tasks'],
}]): void {
  window.novusDesktop = {
    provider: {
      ackImageJobTerminal: vi.fn(),
      cancelImageJob: vi.fn(),
      configure: vi.fn(),
      getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const })),
      listProfiles: vi.fn(async () => profiles),
      pollImageJob: vi.fn(),
      submitImageJob: vi.fn(),
      unlock: vi.fn(),
    },
  } as unknown as typeof window.novusDesktop;
}

function createDesktopProviderBridgeForCancel(options: {
  ackImageJobTerminal: NonNullable<NonNullable<typeof window.novusDesktop>['provider']>['ackImageJobTerminal'];
  cancelImageJob: NonNullable<NonNullable<typeof window.novusDesktop>['provider']>['cancelImageJob'];
  pollImageJob: NonNullable<NonNullable<typeof window.novusDesktop>['provider']>['pollImageJob'];
  providerTaskId: string;
}): typeof window.novusDesktop {
  return {
    provider: {
      ackImageJobTerminal: options.ackImageJobTerminal,
      cancelImageJob: options.cancelImageJob,
      configure: vi.fn(),
      getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const })),
      listProfiles: vi.fn(async () => [{
        provider: 'comfly',
        modelRoute: 'gpt-image',
        displayName: 'GPT Image',
        capabilities: ['image_generation', 'async_tasks'],
      }]),
      pollImageJob: options.pollImageJob,
      submitImageJob: vi.fn(async () => ({ providerTaskId: options.providerTaskId })),
      unlock: vi.fn(),
    },
  } as unknown as typeof window.novusDesktop;
}

function createImmediateBrowserClient(): ProjectPersistenceClient {
  return createBrowserPersistenceClient();
}

function createMockClient(overrides: Partial<ProjectPersistenceClient>): ProjectPersistenceClient {
  const hydrate = overrides.hydrate ?? (async () => ({
    availableSnapshotIds: [],
    lifecycle: 'durable' as const,
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
    openProject: overrides.openProject,
    importProjectImage: overrides.importProjectImage ?? (async () => null),
    listProjectImages: overrides.listProjectImages ?? (async () => []),
    restore: overrides.restore ?? (async () => {
      const result = await hydrate();
      return {
        availableSnapshotIds: result.availableSnapshotIds,
        lifecycle: result.lifecycle,
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
  reviewResult: Omit<Awaited<ReturnType<KnowledgeClient['review']>>, 'candidates'> & {
    candidates?: Awaited<ReturnType<KnowledgeClient['review']>>['candidates'];
  };
}): KnowledgeClient & {
  configure: ReturnType<typeof vi.fn<KnowledgeClient['configure']>>;
  prepareSkillCandidateReview: ReturnType<typeof vi.fn<KnowledgeClient['prepareSkillCandidateReview']>>;
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
    prepareSkillCandidateReview: vi.fn(async (_request) => {
      return {
        ...options.reviewResult,
        candidates: options.reviewResult.candidates ?? [options.reviewResult.candidate],
      };
    }),
    review: vi.fn(async (_request) => {
      if (options.reviewResult.knowledgeState) {
        listener?.([options.reviewResult.knowledgeState]);
      }
      return {
        ...options.reviewResult,
        candidates: options.reviewResult.candidates ?? [options.reviewResult.candidate],
      };
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
