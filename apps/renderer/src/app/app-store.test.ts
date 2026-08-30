import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommitAck, ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import { buildProjectMemoryContext, createAgentKnowledgeLease, createCanvasModuleNode, createSkillPromotionCandidateFingerprint, parseCanvasProject } from '@agent-canvas/domain';
import type { CanvasNode, CanvasProject, ModelJob, OrderedReference, ProjectTransaction, ReversePromptResult, SkillPromotionCandidate } from '@agent-canvas/domain';
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
import { createKnowledgeClient, type KnowledgeClient } from './knowledge-client';
import { createBrowserPersistenceClient } from './desktop-persistence';
import type {
  ProjectCommitRequest,
  ProjectCommitResult,
  ProjectHydrationResult,
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

  it('starts an explicit empty test canvas without browser-local restoration', () => {
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

  it('creates a true blank canvas when starting a new workflow', async () => {
    await useAppStore.getState().newWorkflow();

    expect(useAppStore.getState().project.nodes).toEqual([]);
    expect(useAppStore.getState().project.edges).toEqual([]);
  });
  it('keeps the Agent workspace collapsed for an initial and fresh canvas', async () => {
    expect(useAppStore.getState().agentPanelCollapsed).toBe(true);

    await useAppStore.getState().newWorkflow();

    expect(useAppStore.getState().agentPanelCollapsed).toBe(true);
  });

  it('migrates only the legacy starter canvas into the reversible Figma workbench', async () => {
    const stablePoint = vi.fn(async () => ({
      availableSnapshotIds: ['legacy-before-ui-gate'],
      project: createStarterProject(),
      revision: 4,
    }));
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 5,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit, stablePoint }));
    useAppStore.setState({
      desktopRevision: 4,
      persistenceMode: 'desktop',
      project: createStarterProject(),
      projectLifecycle: 'durable',
      saveStatus: 'saved',
    });

    await expect(useAppStore.getState().migrateLegacyStarterProjectToFigmaWorkbench()).resolves.toBe(true);

    expect(stablePoint).toHaveBeenCalledOnce();
    expect(useAppStore.getState().project.nodes.map((node) => node.type)).toEqual(['module', 'module', 'module', 'module', 'module', 'module', 'module']);
    expect(useAppStore.getState().project.nodes.map((node) => (
      node.type === 'module' ? node.data.moduleType : node.type
    ))).toEqual(['image_input', 'image_generation', 'result_output', 'video_generation', 'reverse_agent', 'reverse_result', 'video_result']);
    expect(useAppStore.getState().project.nodes.map((node) => node.position)).toEqual([
      { x: 20, y: 197 },
      { x: 340, y: 132 },
      { x: 820, y: 282 },
      { x: 1174, y: 146 },
      { x: 340, y: 1062 },
      { x: 1010, y: 1062 },
      { x: 1860, y: 732 },
    ]);
    expect(useAppStore.getState().project.edges).toEqual([
      expect.objectContaining({ source: 'figma-image-input', sourcePortId: 'image', target: 'figma-image-generation', targetPortId: 'references', order: 0 }),
      expect.objectContaining({ source: 'figma-image-generation', sourcePortId: 'result', target: 'figma-image-result', targetPortId: 'result', order: 0 }),
      expect.objectContaining({ source: 'figma-image-input', sourcePortId: 'image', target: 'figma-video-generation', targetPortId: 'media', order: 0 }),
      expect.objectContaining({ source: 'figma-image-input', sourcePortId: 'image', target: 'figma-reverse-agent', targetPortId: 'references', order: 0 }),
      expect.objectContaining({ source: 'figma-reverse-agent', sourcePortId: 'analysis', target: 'figma-reverse-result', targetPortId: 'analysis', order: 0 }),
      expect.objectContaining({ source: 'figma-video-generation', sourcePortId: 'result', target: 'figma-video-result', targetPortId: 'video', order: 0 }),
    ]);
    expect(useAppStore.getState().project.nodes[1]).toMatchObject({
      type: 'module',
      data: {
        config: {
          outputCount: 4,
          resultState: 'fresh',
        },
      },
    });
    expect(useAppStore.getState().project.nodes[4]).toMatchObject({
      type: 'module',
      id: 'figma-reverse-agent',
      data: {
        moduleType: 'reverse_agent',
        config: {
          knowledgeBaseIds: ['scene-skill', 'ecommerce-detail-knowledge'],
        },
      },
    });
    const migrationMemory = useAppStore.getState().project.projectMemory[
      useAppStore.getState().project.projectMemory.length - 1
    ];
    expect(migrationMemory).toMatchObject({
      kind: 'decision',
      title: '迁移到 Figma 画布工作台',
      snapshots: expect.objectContaining({ beforeId: expect.stringContaining('figma-ui-gate') }),
    });
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
      transaction: expect.objectContaining({
        label: 'Migrate legacy starter canvas to Figma workbench',
        operations: expect.arrayContaining([
          expect.objectContaining({ kind: 'replace_canvas_state' }),
          expect.objectContaining({ kind: 'append_project_memory' }),
        ]),
      }),
    }));
  });

  it('migrates the retired topology even when starter metadata is persisted', async () => {
    const stablePoint = vi.fn(async () => ({
      availableSnapshotIds: [],
      project: createStarterProject(),
      revision: 4,
    }));
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 5,
    }));
    const legacyWithStarterMetadata = {
      ...createStarterProject(),
      assets: [{ assetId: 'starter-product' }],
    } as never;
    replaceProjectPersistenceClientForTests(createMockClient({ commit, stablePoint }));
    useAppStore.setState({
      desktopRevision: 4,
      persistenceMode: 'desktop',
      project: legacyWithStarterMetadata,
      projectLifecycle: 'durable',
      saveStatus: 'saved',
    });

    await expect(useAppStore.getState().migrateLegacyStarterProjectToFigmaWorkbench()).resolves.toBe(true);

    expect(stablePoint).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    expect(useAppStore.getState().project.nodes.map((node) => node.type === 'module' ? node.data.moduleType : node.type)).toEqual([
      'image_input',
      'image_generation',
      'result_output',
      'video_generation',
      'reverse_agent',
      'reverse_result',
      'video_result',
    ]);
    expect(useAppStore.getState().project.projectMemory).toHaveLength(1);
  });

  it('migrates the retired Reference → Placement → Agent plan starter variant during hydration', async () => {
    const starter = createStarterProject();
    const agentPlanStarter = {
      ...starter,
      nodes: starter.nodes.map((node) => node.type === 'prompt'
        ? {
            id: 'agent-plan-start',
            type: 'agent_plan',
            position: node.position,
            data: {
              plan: {
                id: 'starter-agent-plan',
                state: 'waiting_for_confirmation',
                proposedOperationIds: [],
                requiresModelConfirmation: false,
              },
            },
          }
        : node),
      edges: starter.edges.map((edge) => edge.target === 'prompt-start'
        ? { ...edge, target: 'agent-plan-start' }
        : edge),
    } as never;
    const stablePoint = vi.fn(async () => ({
      availableSnapshotIds: ['legacy-agent-plan-before-ui-gate'],
      project: agentPlanStarter,
      revision: 4,
    }));
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 5,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({
      commit,
      hydrate: async () => ({
        availableSnapshotIds: [],
        lifecycle: 'durable' as const,
        mode: 'desktop' as const,
        project: agentPlanStarter,
        revision: 4,
        saveStatus: 'saved' as const,
      }),
      stablePoint,
    }));
    resetAppStoreForTests({ project: 'empty' });

    await useAppStore.getState().hydratePersistence();

    expect(stablePoint).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    expect(useAppStore.getState().project.nodes.map((node) => node.type === 'module' ? node.data.moduleType : node.type)).toEqual([
      'image_input',
      'image_generation',
      'result_output',
      'video_generation',
      'reverse_agent',
      'reverse_result',
      'video_result',
    ]);
  });

  it('automatically migrates an exact legacy starter during durable hydration', async () => {
    const stablePoint = vi.fn(async () => ({
      availableSnapshotIds: ['legacy-before-ui-gate'],
      project: createStarterProject(),
      revision: 4,
    }));
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 5,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({
      commit,
      hydrate: async () => ({
        availableSnapshotIds: [],
        lifecycle: 'durable' as const,
        mode: 'desktop' as const,
        project: createStarterProject(),
        revision: 4,
        saveStatus: 'saved' as const,
      }),
      stablePoint,
    }));
    resetAppStoreForTests({ project: 'empty' });

    await useAppStore.getState().hydratePersistence();

    expect(stablePoint).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    expect(useAppStore.getState().project.nodes.map((node) => node.type === 'module' ? node.data.moduleType : node.type)).toEqual([
      'image_input',
      'image_generation',
      'result_output',
      'video_generation',
      'reverse_agent',
      'reverse_result',
      'video_result',
    ]);
  });

  it('automatically migrates a legacy starter restored from browser persistence', async () => {
    const stablePoint = vi.fn(async () => ({
      availableSnapshotIds: [],
      project: createStarterProject(),
      revision: 4,
    }));
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 5,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({
      commit,
      hydrate: async () => ({
        availableSnapshotIds: [],
        lifecycle: 'durable' as const,
        mode: 'browser' as const,
        project: createStarterProject(),
        revision: 4,
        saveStatus: 'saved' as const,
      }),
      stablePoint,
    }));
    resetAppStoreForTests({ project: 'empty' });

    await useAppStore.getState().hydratePersistence();

    expect(stablePoint).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    expect(useAppStore.getState().project.nodes.map((node) => node.type === 'module' ? node.data.moduleType : node.type)).toEqual([
      'image_input',
      'image_generation',
      'result_output',
      'video_generation',
      'reverse_agent',
      'reverse_result',
      'video_result',
    ]);
  });

  it('automatically migrates a legacy starter normalized with unlocked node metadata', async () => {
    const normalizedStarter = {
      ...createStarterProject(),
      graphVersion: 2 as const,
      nodes: createStarterProject().nodes.map((node) => ({ ...node, locked: false })),
    };
    const stablePoint = vi.fn(async () => ({
      availableSnapshotIds: ['legacy-before-ui-gate'],
      project: normalizedStarter,
      revision: 4,
    }));
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 5,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({
      commit,
      hydrate: async () => ({
        availableSnapshotIds: [],
        lifecycle: 'durable' as const,
        mode: 'desktop' as const,
        project: normalizedStarter,
        revision: 4,
        saveStatus: 'saved' as const,
      }),
      stablePoint,
    }));
    resetAppStoreForTests({ project: 'empty' });

    await useAppStore.getState().hydratePersistence();

    expect(stablePoint).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    expect(useAppStore.getState().project.nodes.map((node) => node.type === 'module' ? node.data.moduleType : node.type)).toEqual([
      'image_input',
      'image_generation',
      'result_output',
      'video_generation',
      'reverse_agent',
      'reverse_result',
      'video_result',
    ]);
  });

  it('migrates the retired starter during hydration even when historical model jobs remain', async () => {
    const legacyProject = createStarterProject();
    const stablePoint = vi.fn(async () => ({
      availableSnapshotIds: ['legacy-before-ui-gate'],
      project: legacyProject,
      revision: 4,
    }));
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 5,
    }));
    replaceModelJobStorageForTests(createTestModelJobStorage([{
      id: 'historic-legacy-job',
      kind: 'image',
      modelId: 'historic-model',
      status: 'queued',
      promptNodeId: 'prompt-start',
      confirmedAt: '2026-07-29T00:00:00.000Z',
      retryCount: 0,
      provider: 'comfly',
      modelRoute: 'historic-route',
      displayName: 'Historic model',
      conversationId: legacyProject.id,
      referenceAssetIds: [],
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z',
    }]));
    replaceProjectPersistenceClientForTests(createMockClient({
      commit,
      hydrate: async () => ({
        availableSnapshotIds: [],
        lifecycle: 'durable' as const,
        mode: 'desktop' as const,
        project: legacyProject,
        revision: 4,
        saveStatus: 'saved' as const,
      }),
      stablePoint,
    }));
    resetAppStoreForTests({ project: 'empty' });

    await useAppStore.getState().hydratePersistence();

    expect(stablePoint).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    expect(useAppStore.getState().project.nodes.map((node) => node.type === 'module' ? node.data.moduleType : node.type)).toEqual([
      'image_input',
      'image_generation',
      'result_output',
      'video_generation',
      'reverse_agent',
      'reverse_result',
      'video_result',
    ]);
  });

  it('does not replace a user project during durable hydration', async () => {
    const stablePoint = vi.fn();
    const userProject = {
      ...createStarterProject(),
      nodes: [createCanvasModuleNode('user-prompt', 'text_prompt', { x: 240, y: 160 })],
      edges: [],
      name: '用户画布',
    };
    replaceProjectPersistenceClientForTests(createMockClient({
      hydrate: async () => ({
        availableSnapshotIds: [],
        lifecycle: 'durable' as const,
        mode: 'desktop' as const,
        project: userProject,
        revision: 4,
        saveStatus: 'saved' as const,
      }),
      stablePoint,
    }));
    resetAppStoreForTests({ project: 'empty' });

    await useAppStore.getState().hydratePersistence();

    expect(stablePoint).not.toHaveBeenCalled();
    expect(useAppStore.getState().project).toMatchObject({
      id: userProject.id,
      name: '用户画布',
      nodes: [expect.objectContaining({ id: 'user-prompt' })],
    });
  });

  it('replaces a renamed and repositioned retired canvas during durable hydration so old nodes cannot reappear', async () => {
    const stablePoint = vi.fn();
    const userProject = {
      ...createStarterProject(),
      graphVersion: 2 as const,
      name: '已命名的用户项目',
      nodes: createStarterProject().nodes.map((node, index) => ({
        ...node,
        locked: false,
        position: { x: node.position.x + (index + 1) * 24, y: node.position.y + 18 },
      })),
    };
    replaceProjectPersistenceClientForTests(createMockClient({
      hydrate: async () => ({
        availableSnapshotIds: [],
        lifecycle: 'durable' as const,
        mode: 'desktop' as const,
        project: userProject,
        revision: 4,
        saveStatus: 'saved' as const,
      }),
      stablePoint,
    }));
    resetAppStoreForTests({ project: 'empty' });

    await useAppStore.getState().hydratePersistence();

    expect(stablePoint).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().project.name).toBe('已命名的用户项目');
    expect(useAppStore.getState().project.nodes.map((node) => node.type)).toEqual([
      'module',
      'module',
      'module',
      'module',
      'module',
      'module',
      'module',
    ]);
  });

  it('replaces a legacy starter variant when persisted metadata or copy drifted', async () => {
    const starter = createStarterProject();
    const driftedLegacy = {
      ...starter,
      // Older durable snapshots used a bumped graph version and a generated
      // project id, while keeping the retired Reference -> Placement -> Prompt
      // topology.  Those snapshots must not keep rendering the old cards.
      id: starter.id,
      version: starter.version,
      name: 'Canvas draft',
      nodes: starter.nodes.map((node, index) => ({
        ...node,
        position: { x: node.position.x + index * 12, y: node.position.y + 8 },
        data: node.data,
      })),
      edges: starter.edges.map((edge) => ({ ...edge, label: edge.label === 'agent-plan' ? 'plan' : edge.label })),
    } as unknown as CanvasProject;
    const stablePoint = vi.fn();
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 5,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({
      commit,
      hydrate: async () => ({
        availableSnapshotIds: [],
        lifecycle: 'durable' as const,
        mode: 'desktop' as const,
        project: driftedLegacy,
        revision: 4,
        saveStatus: 'saved' as const,
      }),
      stablePoint,
    }));
    resetAppStoreForTests({ project: 'empty' });

    await useAppStore.getState().hydratePersistence();

    expect(stablePoint).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    expect(useAppStore.getState().project.nodes.map((node) => node.type === 'module' ? node.data.moduleType : node.type)).toEqual([
      'image_input',
      'image_generation',
      'result_output',
      'video_generation',
      'reverse_agent',
      'reverse_result',
      'video_result',
    ]);
  });

  it('replaces a retired canvas immediately after it is opened', async () => {
    const retiredProject = { ...createStarterProject(), name: '从磁盘打开的旧画布' };
    const stablePoint = vi.fn(async () => ({
      availableSnapshotIds: ['legacy-before-ui-gate'],
      project: retiredProject,
      revision: 6,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({
      openProject: async () => ({
        availableSnapshotIds: [],
        lifecycle: 'durable' as const,
        mode: 'desktop' as const,
        project: retiredProject,
        revision: 6,
        saveStatus: 'saved' as const,
      }),
      stablePoint,
    }));
    resetAppStoreForTests({ project: 'empty' });

    await expect(useAppStore.getState().openProject()).resolves.toBe(true);

    expect(stablePoint).toHaveBeenCalledOnce();
    expect(useAppStore.getState().project.nodes).toHaveLength(7);
    expect(useAppStore.getState().project.nodes.every((node) => node.type === 'module')).toBe(true);
  });

  it('replaces a retired canvas opened with historical model jobs so old cards cannot return', async () => {
    const retiredProject = { ...createStarterProject(), name: 'Opened legacy canvas with historical jobs' };
    const stablePoint = vi.fn(async () => ({
      availableSnapshotIds: ['legacy-before-ui-gate'],
      project: retiredProject,
      revision: 6,
    }));
    replaceModelJobStorageForTests(createTestModelJobStorage([{
      id: 'opened-legacy-job',
      kind: 'image',
      modelId: 'historic-model',
      status: 'queued',
      promptNodeId: 'prompt-start',
      confirmedAt: '2026-07-29T00:00:00.000Z',
      retryCount: 0,
      provider: 'comfly',
      modelRoute: 'historic-route',
      displayName: 'Historic model',
      conversationId: retiredProject.id,
      referenceAssetIds: [],
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z',
    }]));
    replaceProjectPersistenceClientForTests(createMockClient({
      openProject: async () => ({
        availableSnapshotIds: [],
        lifecycle: 'durable' as const,
        mode: 'desktop' as const,
        project: retiredProject,
        revision: 6,
        saveStatus: 'saved' as const,
      }),
      stablePoint,
    }));
    resetAppStoreForTests({ project: 'empty' });

    await expect(useAppStore.getState().openProject()).resolves.toBe(true);

    expect(stablePoint).toHaveBeenCalledOnce();
    expect(useAppStore.getState().project.nodes.every((node) => node.type === 'module')).toBe(true);
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

  it('forwards an opaque recent project id through the store open boundary', async () => {
    const durableProject = { ...createStarterProject(), name: 'Recent project opened by id' };
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

    await expect(useAppStore.getState().openProject('recent_0123456789abcdef01234567')).resolves.toBe(true);

    expect(openProject).toHaveBeenCalledWith('recent_0123456789abcdef01234567');
    expect(useAppStore.getState().project.name).toBe('Recent project opened by id');
  });
  it('deletes selected canvas nodes together with their connected edges in one durable transaction', async () => {
    const first = createCanvasModuleNode('delete-first', 'text_prompt', { x: 80, y: 120 });
    const second = createCanvasModuleNode('delete-second', 'image_generation', { x: 360, y: 120 });
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    useAppStore.setState({
      project: {
        version: 1,
        id: 'delete-selection-project',
        name: 'Delete selection',
        nodes: [first, second],
        edges: [{ id: 'delete-selection-edge', source: first.id, target: second.id }],
        projectMemory: [],
        skillPromotionCandidates: [],
      },
      saveStatus: 'saved',
    });

    await expect(useAppStore.getState().deleteCanvasNodes([first.id])).resolves.toBe(true);

    expect(useAppStore.getState().project.nodes.map((node) => node.id)).toEqual([second.id]);
    expect(useAppStore.getState().project.edges).toEqual([]);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('restores deleted canvas nodes and their connected edges through the undo stack', async () => {
    const first = createCanvasModuleNode('undo-delete-first', 'text_prompt', { x: 80, y: 120 });
    const second = createCanvasModuleNode('undo-delete-second', 'image_generation', { x: 360, y: 120 });
    let revision = 0;
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: ++revision,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    useAppStore.setState({
      project: {
        version: 1,
        id: 'undo-delete-selection-project',
        name: 'Undo delete selection',
        nodes: [first, second],
        edges: [{ id: 'undo-delete-edge', source: first.id, target: second.id }],
        projectMemory: [],
        skillPromotionCandidates: [],
      },
      saveStatus: 'saved',
      undoStack: [],
    });

    await expect(useAppStore.getState().deleteCanvasNodes([first.id])).resolves.toBe(true);
    expect(useAppStore.getState().undoStack).toHaveLength(1);

    await useAppStore.getState().undo();

    expect(useAppStore.getState().project.nodes.map((node) => node.id)).toEqual([second.id, first.id]);
    expect(useAppStore.getState().project.edges).toEqual([
      { id: 'undo-delete-edge', source: first.id, target: second.id },
    ]);
    expect(useAppStore.getState().undoStack).toEqual([]);
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it('undoes a newly created canvas node through the same stack', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    useAppStore.setState({ project: { ...createStarterProject(), nodes: [], edges: [] }, saveStatus: 'saved', undoStack: [] });

    await expect(useAppStore.getState().addModuleNode('text_prompt', { x: 120, y: 240 })).resolves.toBe(true);
    const createdId = useAppStore.getState().project.nodes[0]?.id;
    expect(createdId).toBeDefined();
    expect(useAppStore.getState().undoStack).toHaveLength(1);

    await useAppStore.getState().undo();

    expect(useAppStore.getState().project.nodes).toEqual([]);
    expect(useAppStore.getState().undoStack).toEqual([]);
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it('undoes a batch node move as one canvas change', async () => {
    const first = createCanvasModuleNode('undo-move-first', 'text_prompt', { x: 10, y: 20 });
    const second = createCanvasModuleNode('undo-move-second', 'image_generation', { x: 100, y: 120 });
    let revision = 0;
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({ ok: true, project: nextProject, revision: ++revision }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    useAppStore.setState({
      project: { ...createStarterProject(), nodes: [first, second], edges: [] },
      saveStatus: 'saved',
      undoStack: [],
    });
    await expect(useAppStore.getState().commitNodePositions([
      { nodeId: first.id, position: { x: 40, y: 60 } },
      { nodeId: second.id, position: { x: 180, y: 220 } },
    ])).resolves.toBe(true);
    expect(useAppStore.getState().undoStack).toHaveLength(1);

    await useAppStore.getState().undo();

    expect(useAppStore.getState().project.nodes.map((node) => [node.id, node.position])).toEqual([
      [first.id, { x: 10, y: 20 }],
      [second.id, { x: 100, y: 120 }],
    ]);
    expect(useAppStore.getState().undoStack).toEqual([]);
  });

  it('preserves locked nodes when deleting a mixed canvas selection', async () => {
    const unlocked = createCanvasModuleNode('delete-unlocked', 'text_prompt', { x: 80, y: 120 });
    const locked = { ...createCanvasModuleNode('delete-locked', 'image_generation', { x: 360, y: 120 }), locked: true };
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    useAppStore.setState({
      project: {
        version: 1,
        id: 'delete-mixed-selection-project',
        name: 'Delete mixed selection',
        nodes: [unlocked, locked],
        edges: [{ id: 'delete-mixed-edge', source: unlocked.id, target: locked.id }],
        projectMemory: [],
        skillPromotionCandidates: [],
      },
      saveStatus: 'saved',
    });

    await expect(useAppStore.getState().deleteCanvasNodes([unlocked.id, locked.id])).resolves.toBe(true);

    expect(useAppStore.getState().project.nodes.map((node) => node.id)).toEqual([locked.id]);
    expect(useAppStore.getState().project.edges).toEqual([]);
    expect(commit).toHaveBeenCalledTimes(1);
  });
  it('moves selected unlocked nodes in one durable transaction and ignores locked nodes', async () => {
    const first = createCanvasModuleNode('move-first', 'text_prompt', { x: 10, y: 20 });
    const second = createCanvasModuleNode('move-second', 'image_generation', { x: 100, y: 120 });
    const locked = { ...createCanvasModuleNode('move-locked', 'video_generation', { x: 300, y: 320 }), locked: true };
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    useAppStore.setState({
      project: {
        version: 1,
        id: 'move-selection-project',
        name: 'Move selection',
        nodes: [first, second, locked],
        edges: [],
        projectMemory: [],
        skillPromotionCandidates: [],
      },
      saveStatus: 'saved',
    });

    const state = useAppStore.getState() as typeof useAppStore extends { getState(): infer T }
      ? T & { commitNodePositions?: (updates: readonly { nodeId: string; position: { x: number; y: number } }[]) => Promise<boolean> }
      : never;
    expect(state.commitNodePositions).toBeTypeOf('function');
    await expect(state.commitNodePositions!([
      { nodeId: first.id, position: { x: 40, y: 60 } },
      { nodeId: second.id, position: { x: 180, y: 220 } },
      { nodeId: locked.id, position: { x: 900, y: 920 } },
    ])).resolves.toBe(true);

    expect(useAppStore.getState().project.nodes.map((node) => [node.id, node.position])).toEqual([
      [first.id, { x: 40, y: 60 }],
      [second.id, { x: 180, y: 220 }],
      [locked.id, { x: 300, y: 320 }],
    ]);
    expect(commit).toHaveBeenCalledTimes(1);
  });
  it('cancels one canvas edge through a durable delete transaction', async () => {
    const source = createCanvasModuleNode('cancel-source', 'text_prompt', { x: 80, y: 120 });
    const target = createCanvasModuleNode('cancel-target', 'image_generation', { x: 360, y: 120 });
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    useAppStore.setState({
      project: {
        version: 1,
        id: 'cancel-edge-project',
        name: 'Cancel edge',
        nodes: [source, target],
        edges: [{ id: 'cancel-edge', source: source.id, target: target.id }],
        projectMemory: [],
        skillPromotionCandidates: [],
      },
      saveStatus: 'saved',
    });

    await expect(useAppStore.getState().deleteCanvasEdge('cancel-edge')).resolves.toBe(true);

    expect(useAppStore.getState().project.edges).toEqual([]);
    expect(commit).toHaveBeenCalledTimes(1);
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

  it('does not let delayed startup hydration overwrite edits made while the app is opening', async () => {
    const hydration = deferred<Awaited<ReturnType<ProjectPersistenceClient['hydrate']>>>();
    replaceProjectPersistenceClientForTests(createMockClient({ hydrate: vi.fn(() => hydration.promise) }));
    resetAppStoreForTests();
    const initialProject = useAppStore.getState().project;
    const reverse = createCanvasModuleNode('edited-during-hydration', 'reverse_agent', { x: 40, y: 60 });
    const editedProject = parseCanvasProject({
      ...initialProject,
      nodes: [{
        ...reverse,
        data: { ...reverse.data, config: { ...reverse.data.config, role: 'Startup edit', task: 'Keep this text' } },
      }],
      edges: [],
    });

    const pendingHydration = useAppStore.getState().hydratePersistence();
    useAppStore.getState().setProject(editedProject, { schedulePersist: false });
    hydration.resolve({
      availableSnapshotIds: [],
      lifecycle: 'durable',
      mode: 'desktop',
      project: initialProject,
      revision: 7,
      saveStatus: 'saved',
    });
    await pendingHydration;

    expect(useAppStore.getState().project).toEqual(editedProject);
    expect(useAppStore.getState().project.nodes[0]).toMatchObject({
      data: { config: { role: 'Startup edit', task: 'Keep this text' } },
    });
  });

  it('keeps nodes created while startup hydration is still pending', async () => {
    const hydration = deferred<Awaited<ReturnType<ProjectPersistenceClient['hydrate']>>>();
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 0,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({
      hydrate: vi.fn(() => hydration.promise),
      commit,
    }));
    resetAppStoreForTests({ project: 'empty' });
    const initialProject = useAppStore.getState().project;
    const pendingHydration = useAppStore.getState().hydratePersistence();

    expect(await useAppStore.getState().addModuleNode('reverse_agent', { x: 80, y: 120 })).toBe(true);
    hydration.resolve({
      availableSnapshotIds: [],
      lifecycle: 'untitled',
      mode: 'desktop',
      project: initialProject,
      revision: 0,
      saveStatus: 'pending',
    });
    await pendingHydration;

    expect(useAppStore.getState().project.nodes).toHaveLength(1);
    expect(commit).toHaveBeenCalledOnce();
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

  it('enqueues one real video job per requested output using a video-capable profile', async () => {
    const preview = createCanvasModuleNode('video-real-jobs', 'video_generation' as never, { x: 120, y: 120 });
    const submit = vi.fn(async (job: ModelJob) => ({ providerTaskId: `provider-${job.id}` }));
    replaceModelJobExecutorForTests({
      submit,
      poll: vi.fn(async () => ({ status: 'running' as const, progress: 0.2 })),
      cancel: vi.fn(async () => {}),
    });
    installProviderProfilesForModelJobTests([{
      provider: 'relayme',
      modelRoute: 'relayme-video-pro',
      displayName: 'Relay Video Pro',
      modelId: 'video-pro',
      capabilities: ['video_generation', 'async_tasks'],
    }]);
    resetAppStoreForTests();
    useAppStore.setState({
      project: {
        ...createStarterProject(),
        nodes: [preview],
        edges: [],
        assets: [{
          assetId: '0123456789abcdef',
          sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          byteSize: 1024,
          extension: 'png',
          height: 720,
          label: 'Managed frame',
          mediaType: 'image/png',
          origin: 'imported',
          width: 1280,
        }],
      },
    });

    await expect(useAppStore.getState().runVideoPreviewNode(preview.id, {
      prompt: 'A product rotates slowly',
      modelRoute: 'relayme-video-pro',
      referenceAssetIds: ['0123456789abcdef'],
      aspectRatio: '16:9',
      keyframe: 'auto',
      durationSeconds: 8,
      resolution: '1080p',
      outputCount: 4,
      audioEnabled: true,
    })).resolves.toBe(true);

    await waitForStore(() => useAppStore.getState().modelJobs.length === 4);
    expect(useAppStore.getState().modelJobs).toHaveLength(4);
    expect(useAppStore.getState().modelJobs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'video',
        provider: 'relayme',
        modelRoute: 'relayme-video-pro',
        videoResolution: '1080p',
        durationSeconds: 8,
        audioEnabled: true,
        outputCount: 1,
        referenceAssetIds: ['0123456789abcdef'],
      }),
    ]));
    const saved = useAppStore.getState().project.nodes[0] as typeof preview;
    expect(saved.data).toMatchObject({
      execution: { state: 'queued' },
      config: {
        modelRoute: 'relayme-video-pro',
        referenceAssetIds: ['0123456789abcdef'],
        outputCount: 4,
        resultState: 'pending',
      },
    });
    expect(saved.data.config).not.toHaveProperty('mode', 'mock');
    expect(saved.data.config).not.toHaveProperty('videoResults');
  });

  it('establishes a desktop project session before enqueueing video jobs', async () => {
    installVideoProviderForModelJobTests();
    const ensureModelExecutionSession = vi.fn(async () => 'desktop-session-video');
    replaceProjectPersistenceClientForTests(Object.assign(createMockClient({}), {
      ensureModelExecutionSession,
    }));
    resetAppStoreForTests();
    const preview = createCanvasModuleNode('session-video-node', 'video_generation' as never, { x: 120, y: 120 });
    useAppStore.setState({ project: { ...createStarterProject(), nodes: [preview], edges: [], assets: [] } });

    await expect(useAppStore.getState().runVideoPreviewNode(preview.id, {
      prompt: 'Create video inside a durable project session',
      modelRoute: 'relayme-video-pro',
      referenceAssetIds: [],
      aspectRatio: '16:9',
      keyframe: 'auto',
      durationSeconds: 4,
      resolution: '720p',
      outputCount: 1,
      audioEnabled: true,
    })).resolves.toBe(true);

    expect(ensureModelExecutionSession).toHaveBeenCalledOnce();
    expect(useAppStore.getState().modelJobs[0]?.projectSessionId).toBe('desktop-session-video');
  });

  it('rejects unmanaged video references before enqueueing provider jobs', async () => {
    const preview = createCanvasModuleNode('video-invalid-reference', 'video_generation' as never, { x: 120, y: 120 });
    installVideoProviderForModelJobTests();
    useAppStore.setState({ project: { ...createStarterProject(), nodes: [preview], edges: [], assets: [] } });

    await expect(useAppStore.getState().runVideoPreviewNode(preview.id, {
      prompt: 'Never read an external frame',
      referenceAssetIds: ['outside-project'],
      aspectRatio: '16:9',
      keyframe: 'auto',
      durationSeconds: 4,
      resolution: '720p',
      outputCount: 1,
      audioEnabled: true,
    })).resolves.toBe(false);
    expect(useAppStore.getState().modelJobs).toEqual([]);
  });
  it('uses the managed image connected to the video media port when running a preview', async () => {
    installVideoProviderForModelJobTests();
    const image = createCanvasModuleNode('video-connected-image', 'image_input', { x: 20, y: 20 });
    image.data.config = { assetId: '0123456789abcdef' };
    const preview = createCanvasModuleNode('video-connected-preview', 'video_generation', { x: 420, y: 20 });
    useAppStore.setState({
      project: {
        ...createStarterProject(),
        nodes: [image, preview],
        edges: [{
          id: 'image-to-video-media',
          source: image.id,
          sourcePortId: 'image',
          target: preview.id,
          targetPortId: 'media',
          order: 0,
        }],
        assets: [{
          assetId: '0123456789abcdef',
          sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          byteSize: 1024,
          extension: 'png',
          height: 720,
          label: 'Connected frame',
          mediaType: 'image/png',
          origin: 'imported',
          width: 1280,
        }],
      },
    });

    expect(await useAppStore.getState().runVideoPreviewNode(preview.id, {
      prompt: 'A product rotates slowly',
      referenceAssetIds: [],
      aspectRatio: '16:9',
      keyframe: 'auto',
      durationSeconds: 4,
      resolution: '720p',
      outputCount: 1,
      audioEnabled: true,
    })).toBe(true);

    expect((useAppStore.getState().project.nodes[1] as typeof preview).data.config).toMatchObject({
      referenceAssetIds: ['0123456789abcdef'],
      firstFrameAssetId: '0123456789abcdef',
    });
  });

  it('records a managed video connected to the video media port without treating it as an image frame', async () => {
    installVideoProviderForModelJobTests();
    const video = createCanvasModuleNode('video-connected-source', 'video_input', { x: 20, y: 20 });
    video.data.config = { assetId: 'fedcba9876543210' };
    const preview = createCanvasModuleNode('video-connected-preview', 'video_generation', { x: 420, y: 20 });
    useAppStore.setState({
      project: {
        ...createStarterProject(),
        nodes: [video, preview],
        edges: [{
          id: 'video-to-video-media',
          source: video.id,
          sourcePortId: 'video',
          target: preview.id,
          targetPortId: 'media',
          order: 0,
        }],
        assets: [{
          assetId: 'fedcba9876543210',
          sha256: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
          byteSize: 2048,
          durationMs: 4_000,
          extension: 'mp4',
          height: 720,
          label: 'Connected video',
          mediaType: 'video/mp4',
          origin: 'imported',
          width: 1280,
        }],
      },
    });

    expect(await useAppStore.getState().runVideoPreviewNode(preview.id, {
      prompt: 'A product rotates slowly',
      referenceAssetIds: [],
      aspectRatio: '16:9',
      keyframe: 'auto',
      durationSeconds: 4,
      resolution: '720p',
      outputCount: 1,
      audioEnabled: true,
    })).toBe(true);

    expect((useAppStore.getState().project.nodes[1] as typeof preview).data.config).toMatchObject({
      referenceAssetIds: [],
      sourceVideoAssetId: 'fedcba9876543210',
    });
  });

  it('snapshots only managed images connected to a storyboard before calling the bridge', async () => {
    const image = createCanvasModuleNode('storyboard-image', 'image_input', { x: 20, y: 40 });
    image.data.config = { assetId: '0123456789abcdef' };
    const storyboard = createCanvasModuleNode('storyboard-target', 'storyboard_sheet', { x: 420, y: 40 });
    const generateStoryboard = vi.fn(async () => ({
      modelRoute: 'scene-chat',
      shots: [{
        id: 'shot-1', order: 1, title: 'Opening', composition: 'A calm opening frame.', durationSeconds: 4,
        referenceAssetIds: ['0123456789abcdef'],
      }],
    }));
    window.novusDesktop = {
      provider: {
        listProfiles: vi.fn(async () => [{ provider: 'comfly', modelRoute: 'scene-chat', displayName: 'Scene Chat', modelId: 'scene-chat', capabilities: ['chat'] }]),
        generateStoryboard,
      },
    } as unknown as typeof window.novusDesktop;
    useAppStore.setState({
      project: {
        ...createStarterProject(),
        nodes: [image, storyboard],
        edges: [{ id: 'storyboard-image-edge', source: image.id, sourcePortId: 'image', target: storyboard.id, targetPortId: 'images', order: 0 }],
        assets: [{
          assetId: '0123456789abcdef', sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          byteSize: 1024, extension: 'png', height: 720, label: 'Storyboard image', mediaType: 'image/png', origin: 'imported', width: 1280,
        }],
      },
    });
    const canvasBefore = useAppStore.getState().project;

    expect(await useAppStore.getState().generateStoryboardNode(storyboard.id, {
      modelRoute: 'scene-chat', script: 'A quiet studio reveal.', shotCount: 1, referenceAssetIds: ['untrusted-renderer-id'],
    })).toBe(true);

    expect(generateStoryboard).toHaveBeenCalledWith(expect.objectContaining({ referenceAssetIds: ['0123456789abcdef'] }));
    expect(useAppStore.getState().project.nodes.find((node) => node.id === storyboard.id)).toMatchObject({
      data: { config: { referenceAssetIds: ['0123456789abcdef'] } },
    });
    expect(useAppStore.getState().project.nodes.find((node) => node.id === image.id)?.position).toEqual(canvasBefore.nodes[0]?.position);
    expect(useAppStore.getState().project.edges).toEqual(canvasBefore.edges);
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

  it('keeps local work dirty on REVISION_CONFLICT until explicit durable reload', async () => {
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
    const reloadDurableProject = vi.fn(async () => ({
        availableSnapshotIds: [],
        lifecycle: 'durable' as const,
        mode: 'desktop' as const,
        project: durableProject,
        revision: 3,
        saveStatus: 'saved' as const,
      }));
    const commit = vi.fn(async (): Promise<ProjectCommitResult> => ({
      code: 'REVISION_CONFLICT',
      ok: false,
      project: durableProject,
      revision: 3,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({
      commit,
      listProjectImages: vi.fn(async () => [durableImage]),
      reloadDurableProject,
    }));
    resetAppStoreForTests();

    useAppStore.setState({
      project: conflictingProject,
      projectImages: [],
      desktopRevision: 2,
      saveStatus: 'pending',
    });

    await useAppStore.getState().commitProjectTransaction(transaction, { kind: 'canvas' });

    expect(useAppStore.getState().project).toMatchObject({ id: conflictingProject.id, name: 'stale-local-draft' });
    expect(useAppStore.getState().projectImages).toEqual([]);
    expect(useAppStore.getState().desktopRevision).toBe(3);
    expect(useAppStore.getState().saveStatus).toBe('error');
    expect(useAppStore.getState().saveErrorCode).toBe('REVISION_CONFLICT');
    expect(useAppStore.getState().projectCommitConflictCode).toBe('REVISION_CONFLICT');
    expect(useAppStore.getState().canReloadDurableProject).toBe(true);
    expect(useAppStore.getState().canRetryProjectCommit).toBe(false);
    expect(await useAppStore.getState().addModuleNode('text_prompt', { x: 20, y: 20 })).toBe(false);
    expect(commit).toHaveBeenCalledOnce();

    expect(await useAppStore.getState().reloadDurableProject()).toBe(true);
    expect(reloadDurableProject).toHaveBeenCalledOnce();
    expect(useAppStore.getState()).toMatchObject({
      canReloadDurableProject: false,
      desktopRevision: 3,
      project: { name: durableProject.name },
      projectCommitConflictCode: null,
      projectImages: [durableImage],
      saveStatus: 'saved',
    });
  });

  it('rebuilds a generated result against the latest durable revision before completing the job', async () => {
    const generation = createCanvasModuleNode('revision-image-node', 'image_generation', { x: 0, y: 0 });
    const generatedAsset = {
      assetId: 'dddddddddddddddd', byteSize: 128, extension: 'png' as const, height: 512,
      label: 'Generated image', mediaType: 'image/png' as const, origin: 'generated' as const,
      sha256: 'd'.repeat(64), width: 512,
    };
    let durableProject: CanvasProject | undefined;
    let resultCommitAttempts = 0;
    const commit = vi.fn(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => {
      if (request.transaction.id.startsWith('run-image-generation-')) {
        durableProject = {
          ...request.nextProject,
          assets: [generatedAsset],
          nodes: request.nextProject.nodes.map((node) => (
            node.id === generation.id && node.type === 'module'
              ? { ...node, data: { ...node.data, config: { ...node.data.config, prompt: 'old durable prompt' } } }
              : node
          )),
        };
        return { ok: true, project: request.nextProject, revision: 1 };
      }
      if (request.transaction.id.startsWith('model-job-inline-result-')) {
        resultCommitAttempts += 1;
        return resultCommitAttempts === 1
          ? { ok: false, code: 'REVISION_CONFLICT', project: durableProject!, revision: 2 }
          : { ok: true, project: request.nextProject, revision: 3 };
      }
      return { ok: true, project: request.nextProject, revision: request.baseRevision + 1 };
    });
    const reloadDurableProject = vi.fn(async () => ({
      availableSnapshotIds: [],
      lifecycle: 'durable' as const,
      mode: 'desktop' as const,
      project: durableProject!,
      revision: 2,
      saveStatus: 'saved' as const,
    }));
    const listProjectImages = vi.fn(async () => []);
    const listProjectVideos = vi.fn(async () => []);
    replaceModelJobExecutorForTests({
      submit: vi.fn(async (job) => ({ providerTaskId: `task-${job.id}` })),
      poll: vi.fn(async () => ({
        status: 'completed' as const,
        result: { assetId: generatedAsset.assetId, width: 512, height: 512 },
      })),
      cancel: vi.fn(async () => {}),
    });
    installProviderProfilesForModelJobTests();
    replaceProjectPersistenceClientForTests(createMockClient({
      commit,
      listProjectImages,
      listProjectVideos,
      reloadDurableProject,
    }));
    resetAppStoreForTests();
    useAppStore.setState({
      project: { ...createStarterProject(), nodes: [generation], edges: [], assets: [] },
      desktopRevision: 0,
      persistenceMode: 'desktop',
      projectLifecycle: 'durable',
      saveStatus: 'saved',
    });

    await expect(useAppStore.getState().runImageGenerationNode(generation.id, {
      modelRoute: 'image-generation',
      prompt: 'new local prompt',
      outputCount: 1,
    })).resolves.toBe(true);
    await waitForStore(() => useAppStore.getState().modelJobs[0]?.status === 'completed');

    expect(reloadDurableProject).toHaveBeenCalledOnce();
    expect(resultCommitAttempts).toBe(2);
    const resultCommitCalls = commit.mock.calls.filter(([request]) => (
      request.transaction.id.startsWith('model-job-inline-result-')
    ));
    expect(resultCommitCalls[resultCommitCalls.length - 1]?.[0]).toMatchObject({
      baseRevision: 2,
      previousProject: { assets: [generatedAsset] },
      nextProject: { assets: [generatedAsset] },
    });
    expect(useAppStore.getState().project.assets).toEqual([generatedAsset]);
    expect(useAppStore.getState().project.nodes.find((node) => node.id === generation.id)).toMatchObject({
      type: 'module',
      data: { config: { prompt: 'new local prompt', resultAssetIds: [generatedAsset.assetId] } },
    });
    expect(useAppStore.getState()).toMatchObject({
      canReloadDurableProject: false,
      desktopRevision: 3,
      projectCommitConflictCode: null,
      saveStatus: 'saved',
    });
    expect(listProjectImages).toHaveBeenCalledOnce();
    expect(listProjectVideos).toHaveBeenCalledOnce();
  });

  it('does not adopt or retry a generated result when the model-job-store generation changes during reload', async () => {
      const generation = createCanvasModuleNode('guard-generation-node', 'image_generation', { x: 0, y: 0 });
      const generatedAsset = {
        assetId: 'eeeeeeeeeeeeeeee',
        byteSize: 128, extension: 'png' as const, height: 512,
        label: 'Generated image', mediaType: 'image/png' as const, origin: 'generated' as const,
        sha256: 'e'.repeat(64), width: 512,
      };
      const reload = deferred<ProjectHydrationResult>();
      const storage = createTestModelJobStorage();
      let durableProject: CanvasProject | undefined;
      let resultCommitAttempts = 0;
      const commit = vi.fn(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => {
        if (request.transaction.id.startsWith('run-image-generation-')) {
          durableProject = { ...request.nextProject, assets: [generatedAsset] };
          return { ok: true, project: request.nextProject, revision: 1 };
        }
        if (request.transaction.id.startsWith('model-job-inline-result-')) {
          resultCommitAttempts += 1;
          return resultCommitAttempts === 1
            ? { ok: false, code: 'REVISION_CONFLICT', project: durableProject!, revision: 2 }
            : { ok: true, project: request.nextProject, revision: 3 };
        }
        return { ok: true, project: request.nextProject, revision: request.baseRevision + 1 };
      });
      const reloadDurableProject = vi.fn(() => reload.promise);
      replaceModelJobExecutorForTests({
        submit: vi.fn(async (job) => ({ providerTaskId: `task-${job.id}` })),
        poll: vi.fn(async () => ({ status: 'completed' as const, result: { assetId: generatedAsset.assetId } })),
        cancel: vi.fn(async () => {}),
      });
      replaceModelJobStorageForTests(storage);
      installProviderProfilesForModelJobTests();
      replaceProjectPersistenceClientForTests(Object.assign(createMockClient({ commit, reloadDurableProject }), {
        ensureModelExecutionSession: vi.fn(async () => 'desktop-session-a'),
        getSessionId: () => 'desktop-session-a',
      }));
      resetAppStoreForTests();
      useAppStore.setState({
        project: { ...createStarterProject(), nodes: [generation], edges: [], assets: [] },
        desktopRevision: 0,
        persistenceMode: 'desktop',
        projectLifecycle: 'durable',
        saveStatus: 'saved',
      });

      await useAppStore.getState().runImageGenerationNode(generation.id, {
        modelRoute: 'image-generation', prompt: 'guarded prompt', outputCount: 1,
      });
      await vi.waitFor(() => expect(reloadDurableProject).toHaveBeenCalledOnce());
      replaceModelJobStorageForTests(createTestModelJobStorage());
      reload.resolve({
        availableSnapshotIds: [], lifecycle: 'durable', mode: 'desktop',
        project: durableProject!, revision: 2, saveStatus: 'saved',
      });
      await delay(20);

      expect(resultCommitAttempts).toBe(1);
      expect(useAppStore.getState().project.assets).toEqual([]);
      expect((await storage.list())[0]).toMatchObject({ status: 'running' });
      expect((await storage.list())[0]).not.toHaveProperty('resultAssetId');
  });

  it('retries a generated result after reload rotates the session while the source node still owns the job', async () => {
    const generation = createCanvasModuleNode('guard-session-owner-node', 'image_generation', { x: 0, y: 0 });
    const generatedAsset = {
      assetId: 'ffffffffffffffff', byteSize: 128, extension: 'png' as const, height: 512,
      label: 'Generated image', mediaType: 'image/png' as const, origin: 'generated' as const,
      sha256: 'f'.repeat(64), width: 512,
    };
    const reload = deferred<ProjectHydrationResult>();
    const storage = createTestModelJobStorage();
    let currentSession = 'desktop-session-a';
    let durableProject: CanvasProject | undefined;
    let resultCommitAttempts = 0;
    const commit = vi.fn(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => {
      if (request.transaction.id.startsWith('run-image-generation-')) {
        durableProject = { ...request.nextProject, assets: [generatedAsset] };
        return { ok: true, project: request.nextProject, revision: 1 };
      }
      if (request.transaction.id.startsWith('model-job-inline-result-')) {
        resultCommitAttempts += 1;
        return resultCommitAttempts === 1
          ? { ok: false, code: 'REVISION_CONFLICT', project: durableProject!, revision: 2 }
          : { ok: true, project: request.nextProject, revision: 3 };
      }
      return { ok: true, project: request.nextProject, revision: request.baseRevision + 1 };
    });
    const reloadDurableProject = vi.fn(() => reload.promise);
    replaceModelJobExecutorForTests({
      submit: vi.fn(async (job) => ({ providerTaskId: `task-${job.id}` })),
      poll: vi.fn(async () => ({ status: 'completed' as const, result: { assetId: generatedAsset.assetId } })),
      cancel: vi.fn(async () => {}),
    });
    replaceModelJobStorageForTests(storage);
    installProviderProfilesForModelJobTests();
    replaceProjectPersistenceClientForTests(Object.assign(createMockClient({ commit, reloadDurableProject }), {
      ensureModelExecutionSession: vi.fn(async () => 'desktop-session-a'),
      getSessionId: () => currentSession,
    }));
    resetAppStoreForTests();
    useAppStore.setState({
      project: { ...createStarterProject(), nodes: [generation], edges: [], assets: [] },
      desktopRevision: 0,
      persistenceMode: 'desktop',
      projectLifecycle: 'durable',
      saveStatus: 'saved',
    });

    await useAppStore.getState().runImageGenerationNode(generation.id, {
      modelRoute: 'image-generation', prompt: 'owned session recovery', outputCount: 1,
    });
    await vi.waitFor(() => expect(reloadDurableProject).toHaveBeenCalledOnce());
    currentSession = 'desktop-session-b';
    reload.resolve({
      availableSnapshotIds: [], lifecycle: 'durable', mode: 'desktop',
      project: durableProject!, revision: 2, saveStatus: 'saved',
    });
    await waitForStore(() => useAppStore.getState().modelJobs[0]?.status === 'completed');

    expect(resultCommitAttempts).toBe(2);
    expect((await storage.list())[0]).toMatchObject({
      status: 'completed',
      resultAssetId: generatedAsset.assetId,
    });
    expect(useAppStore.getState().project.nodes.find((node) => node.id === generation.id)).toMatchObject({
      type: 'module',
      data: {
        config: { resultAssetIds: [generatedAsset.assetId], resultState: 'fresh' },
        execution: { state: 'completed' },
      },
    });
  });

  it('does not retry a generated result after session rotation when the source node owns a newer job', async () => {
    const generation = createCanvasModuleNode('guard-session-stale-node', 'image_generation', { x: 0, y: 0 });
    const generatedAsset = {
      assetId: 'abababababababab', byteSize: 128, extension: 'png' as const, height: 512,
      label: 'Generated image', mediaType: 'image/png' as const, origin: 'generated' as const,
      sha256: 'a'.repeat(64), width: 512,
    };
    const reload = deferred<ProjectHydrationResult>();
    const storage = createTestModelJobStorage();
    let currentSession = 'desktop-session-a';
    let durableProject: CanvasProject | undefined;
    let resultCommitAttempts = 0;
    const commit = vi.fn(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => {
      if (request.transaction.id.startsWith('run-image-generation-')) {
        durableProject = { ...request.nextProject, assets: [generatedAsset] };
        return { ok: true, project: request.nextProject, revision: 1 };
      }
      if (request.transaction.id.startsWith('model-job-inline-result-')) {
        resultCommitAttempts += 1;
        return { ok: false, code: 'REVISION_CONFLICT', project: durableProject!, revision: 2 };
      }
      return { ok: true, project: request.nextProject, revision: request.baseRevision + 1 };
    });
    const reloadDurableProject = vi.fn(() => reload.promise);
    replaceModelJobExecutorForTests({
      submit: vi.fn(async (job) => ({ providerTaskId: `task-${job.id}` })),
      poll: vi.fn(async () => ({ status: 'completed' as const, result: { assetId: generatedAsset.assetId } })),
      cancel: vi.fn(async () => {}),
    });
    replaceModelJobStorageForTests(storage);
    installProviderProfilesForModelJobTests();
    replaceProjectPersistenceClientForTests(Object.assign(createMockClient({ commit, reloadDurableProject }), {
      ensureModelExecutionSession: vi.fn(async () => 'desktop-session-a'),
      getSessionId: () => currentSession,
    }));
    resetAppStoreForTests();
    useAppStore.setState({
      project: { ...createStarterProject(), nodes: [generation], edges: [], assets: [] },
      desktopRevision: 0,
      persistenceMode: 'desktop',
      projectLifecycle: 'durable',
      saveStatus: 'saved',
    });

    await useAppStore.getState().runImageGenerationNode(generation.id, {
      modelRoute: 'image-generation', prompt: 'stale session recovery', outputCount: 1,
    });
    await vi.waitFor(() => expect(reloadDurableProject).toHaveBeenCalledOnce());
    currentSession = 'desktop-session-b';
    useAppStore.setState((state) => ({
      project: {
        ...state.project,
        nodes: state.project.nodes.map((node) => node.id === generation.id && node.type === 'module'
          ? { ...node, data: { ...node.data, config: { ...node.data.config, lastResultJobId: 'newer-model-job' } } }
          : node),
      },
    }));
    reload.resolve({
      availableSnapshotIds: [], lifecycle: 'durable', mode: 'desktop',
      project: durableProject!, revision: 2, saveStatus: 'saved',
    });
    await delay(20);

    expect(resultCommitAttempts).toBe(1);
    expect((await storage.list())[0]).toMatchObject({ status: 'running' });
    expect(commit.mock.calls.filter(([request]) => (
      request.transaction.id.startsWith('model-job-inline-result-')
    ))).toHaveLength(1);
  });

  it('blocks normal persistence boundaries until a recovery preview is restored or discarded', async () => {
    const recoveryGenerationNode = createCanvasModuleNode('recovery-generation', 'image_generation', { x: 20, y: 20 });
    const previewProject = {
      ...createStarterProject(),
      name: 'Recovery preview',
      nodes: [...createStarterProject().nodes, recoveryGenerationNode],
    };
    const restoredProject = { ...previewProject, name: 'Recovered project' };
    const close = vi.fn(async () => undefined);
    const commit = vi.fn(async (): Promise<ProjectCommitResult> => ({
      ok: true,
      project: previewProject,
      revision: 4,
    }));
    const stablePoint = vi.fn(async () => ({
      availableSnapshotIds: ['snapshot-recovery'],
      project: previewProject,
      revision: 3,
    }));
    const restore = vi.fn(async () => ({
      availableSnapshotIds: [],
      lifecycle: 'durable' as const,
      project: restoredProject,
      recoveryRequired: false,
      revision: 3,
      saveStatus: 'saved' as const,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({
      close,
      commit,
      openProject: async () => ({
        availableSnapshotIds: ['snapshot-recovery'],
        lifecycle: 'durable',
        mode: 'desktop',
        project: previewProject,
        recoveryRequired: true,
        revision: 3,
        saveStatus: 'error',
      }),
      restore,
      stablePoint,
    }));
    resetAppStoreForTests({ project: 'empty' });

    expect(await useAppStore.getState().openProject()).toBe(true);
    expect(useAppStore.getState()).toMatchObject({
      recoveryRequired: true,
      saveErrorCode: 'RECOVERY_REQUIRED',
      saveStatus: 'error',
    });
    expect(await useAppStore.getState().addModuleNode('text_prompt', { x: 10, y: 10 })).toBe(false);
    await expect(useAppStore.getState().runImageGenerationNode(recoveryGenerationNode.id, {
      modelRoute: 'image-generation',
      outputCount: 1,
      prompt: 'recovery preview must explain why generation is blocked',
    })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(await useAppStore.getState().flushProjectSave('blur')).toBe(false);
    expect(await useAppStore.getState().closePersistence()).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(stablePoint).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();

    await useAppStore.getState().restoreProjectSnapshot('snapshot-recovery');
    expect(restore).toHaveBeenCalledOnce();
    expect(useAppStore.getState()).toMatchObject({
      project: { name: 'Recovered project' },
      recoveryRequired: false,
      saveErrorCode: null,
      saveStatus: 'saved',
    });
  });

  it('closes a read-only desktop session without attempting a writable save boundary', async () => {
    const close = vi.fn(async () => undefined);
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 4,
    }));
    const stablePoint = vi.fn(async () => ({
      availableSnapshotIds: [],
      project: createStarterProject(),
      revision: 3,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({
      close,
      commit,
      hydrate: async () => ({
        availableSnapshotIds: [],
        lifecycle: 'durable',
        mode: 'desktop',
        project: createStarterProject(),
        revision: 3,
        saveStatus: 'read_only',
      }),
      stablePoint,
    }));
    resetAppStoreForTests({ project: 'empty' });

    await useAppStore.getState().hydratePersistence();
    expect(useAppStore.getState().canReloadDurableProject).toBe(true);
    close.mockClear();
    commit.mockClear();
    stablePoint.mockClear();

    await expect(useAppStore.getState().closePersistence()).resolves.toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(stablePoint).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('marks an opened read-only project as eligible for durable reload', async () => {
    replaceProjectPersistenceClientForTests(createMockClient({
      openProject: async () => ({
        availableSnapshotIds: [],
        lifecycle: 'durable',
        mode: 'desktop',
        project: { ...createStarterProject(), name: 'Read-only project' },
        revision: 5,
        saveStatus: 'read_only',
      }),
    }));
    resetAppStoreForTests({ project: 'empty' });

    await expect(useAppStore.getState().openProject()).resolves.toBe(true);
    expect(useAppStore.getState()).toMatchObject({
      canReloadDurableProject: true,
      saveStatus: 'read_only',
    });
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
      id: expect.stringMatching(/^model-job-v2-/u),
      resultAssetId: 'asset-live-job',
      status: 'completed',
    });
  });

  it('adapts an unsupported Comfly 4K tier to the documented 2K bridge request', async () => {
    const generation = createCanvasModuleNode('tier-image-node', 'image_generation', { x: 0, y: 0 });
    const submitImageJob = vi.fn(async () => ({ providerTaskId: 'provider-job-tier' }));
    window.novusDesktop = {
      provider: {
        ackImageJobTerminal: vi.fn(),
        cancelImageJob: vi.fn(),
        configure: vi.fn(),
        getStatus: vi.fn(),
        listProfiles: vi.fn(async () => [{
          provider: 'comfly' as const,
          modelRoute: 'gpt-image',
          displayName: 'GPT Image',
          capabilities: ['image_generation' as const, 'async_tasks' as const],
          constraints: { image: { aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'], resolutions: ['1K', '2K'], outputCounts: [1, 2, 3, 4] } },
        }]),
        pollImageJob: vi.fn(async () => ({ status: 'running' as const })),
        submitImageJob,
        unlock: vi.fn(),
      },
    } as unknown as typeof window.novusDesktop;
    useAppStore.setState({
      project: { ...createStarterProject(), nodes: [generation], edges: [] },
    });

    await expect(useAppStore.getState().runImageGenerationNode(generation.id, {
      modelRoute: 'gpt-image',
      prompt: 'A native 4K product image',
      aspectRatio: '16:9',
      resolution: '4K',
      outputCount: 1,
    })).resolves.toBe(true);
    await waitForStore(() => submitImageJob.mock.calls.length === 1);

    expect(useAppStore.getState().modelJobs[0]?.resolution).toBe('2K');
    expect(submitImageJob).toHaveBeenCalledWith(expect.objectContaining({
      aspectRatio: '16:9',
      resolution: '2K',
    }));
  });

  it('accepts a complete image model that declares 1K output', async () => {
    const generation = createCanvasModuleNode('one-k-only-image-node', 'image_generation', { x: 0, y: 0 });
    const submitImageJob = vi.fn(async () => ({ providerTaskId: 'provider-job-one-k' }));
    window.novusDesktop = {
      provider: {
        listProfiles: vi.fn(async () => [{
          provider: 'comfly' as const,
          modelRoute: 'one-k-image',
          displayName: 'One K Image',
          capabilities: ['image_generation' as const],
          capabilityStatus: 'complete' as const,
          constraints: { image: { aspectRatios: ['1:1'], resolutions: ['1K'], outputCounts: [1] } },
        }]),
        submitImageJob,
      },
    } as unknown as typeof window.novusDesktop;
    useAppStore.setState({ project: { ...createStarterProject(), nodes: [generation], edges: [] } });

    await expect(useAppStore.getState().runImageGenerationNode(generation.id, {
      modelRoute: 'one-k-image', prompt: 'Generate at 1K', aspectRatio: '1:1', resolution: '2K', outputCount: 1,
    })).resolves.toBe(true);
    await waitForStore(() => submitImageJob.mock.calls.length === 1);
    expect(submitImageJob).toHaveBeenCalledWith(expect.objectContaining({ resolution: '1K' }));
  });
  it('reports an unavailable selected image route instead of silently returning false', async () => {
    const generation = createCanvasModuleNode('missing-route-image-node', 'image_generation', { x: 0, y: 0 });
    installProviderProfilesForModelJobTests([{
      provider: 'comfly', modelRoute: 'different-image-route', displayName: 'Different image route', modelId: 'different-image-route',
      capabilities: ['image_generation'],
    }]);
    resetAppStoreForTests();
    useAppStore.setState({ project: { ...createStarterProject(), nodes: [generation], edges: [] } });

    await expect(useAppStore.getState().runImageGenerationNode(generation.id, {
      modelRoute: 'stale-image-route', prompt: 'Generate with the selected route', aspectRatio: '1:1', resolution: '2K', outputCount: 1,
    })).rejects.toMatchObject({ code: 'MODEL_ROUTE_UNAVAILABLE' });
  });
  it('repairs a mixed RelayMe image node to its canonical same-provider route before enqueue', async () => {
    const generation = createCanvasModuleNode('mixed-relayme-image-node', 'image_generation', { x: 0, y: 0 });
    generation.data.config = {
      ...generation.data.config,
      modelDisplayName: 'Nano Banana Pro',
      modelRoute: 'comfly-nano-banana-pro-2k',
      providerDisplayName: 'relayme',
    };
    installProviderProfilesForModelJobTests([{
      provider: 'relayme',
      modelRoute: 'relayme-gemini-3-pro-image-preview',
      displayName: 'Nano Banana Pro',
      modelId: 'gemini-3-pro-image-preview',
      capabilities: ['image_generation', 'async_tasks'],
    }]);
    resetAppStoreForTests();
    useAppStore.setState({ project: { ...createStarterProject(), nodes: [generation], edges: [] } });

    await expect(useAppStore.getState().runImageGenerationNode(generation.id, {
      modelRoute: 'comfly-nano-banana-pro-2k',
      prompt: 'Repair the RelayMe model identity',
      aspectRatio: '1:1',
      resolution: '2K',
      outputCount: 1,
    })).resolves.toBe(true);

    expect(useAppStore.getState().modelJobs[0]).toMatchObject({
      provider: 'relayme',
      modelRoute: 'relayme-gemini-3-pro-image-preview',
      modelId: 'gemini-3-pro-image-preview',
    });
    expect(useAppStore.getState().project.nodes[0]).toMatchObject({
      data: { config: {
        providerDisplayName: 'relayme',
        modelRoute: 'relayme-gemini-3-pro-image-preview',
        modelDisplayName: 'Nano Banana Pro',
      } },
    });
  });

  it('rejects ambiguous same-provider RelayMe image repair before enqueue', async () => {
    const generation = createCanvasModuleNode('ambiguous-relayme-image-node', 'image_generation', { x: 0, y: 0 });
    generation.data.config = {
      ...generation.data.config,
      modelDisplayName: 'Nano Banana Pro',
      modelRoute: 'comfly-nano-banana-pro-2k',
      providerDisplayName: 'relayme',
    };
    const submitImageJob = vi.fn();
    window.novusDesktop = { provider: {
      getActiveProvider: vi.fn(async () => ({ activeProvider: 'relayme' as const })),
      listProfiles: vi.fn(async () => [{
        provider: 'relayme' as const,
        modelRoute: 'relayme-nano-banana-pro-a',
        displayName: 'Nano Banana Pro',
        modelId: 'nano-banana-pro-a',
        capabilities: ['image_generation' as const],
      }, {
        provider: 'relayme' as const,
        modelRoute: 'relayme-nano-banana-pro-b',
        displayName: 'Nano Banana Pro',
        modelId: 'nano-banana-pro-b',
        capabilities: ['image_generation' as const],
      }]),
      submitImageJob,
    } } as unknown as typeof window.novusDesktop;
    resetAppStoreForTests();
    useAppStore.setState({ project: { ...createStarterProject(), nodes: [generation], edges: [] } });

    await expect(useAppStore.getState().runImageGenerationNode(generation.id, {
      modelRoute: 'comfly-nano-banana-pro-2k',
      prompt: 'Do not guess an ambiguous RelayMe model',
      aspectRatio: '1:1', resolution: '2K', outputCount: 1,
    })).rejects.toMatchObject({ code: 'MODEL_ROUTE_UNAVAILABLE' });
    expect(useAppStore.getState().modelJobs).toEqual([]);
    expect(submitImageJob).not.toHaveBeenCalled();
  });
  it('adapts an image-node request to the selected model constraints before enqueueing', async () => {
    replaceModelJobExecutorForTests({
      submit: vi.fn(async (job: ModelJob) => ({ providerTaskId: 'provider-' + job.id })),
      poll: vi.fn(async () => ({ status: 'running' as const, progress: 0.2 })),
      cancel: vi.fn(async () => {}),
    });
    installProviderProfilesForModelJobTests([{
      provider: 'relayme', modelRoute: 'relay-image-constrained', displayName: 'Relay Image Constrained', modelId: 'relay-image-constrained',
      capabilities: ['image_generation', 'async_tasks'],
      constraints: { image: { aspectRatios: ['1:1'], resolutions: ['2K'], outputCounts: [1] } },
    }]);
    resetAppStoreForTests();
    const generation = createCanvasModuleNode('adapted-image-node', 'image_generation', { x: 0, y: 0 });
    useAppStore.setState({ project: { ...createStarterProject(), nodes: [generation], edges: [] } });

    await expect(useAppStore.getState().runImageGenerationNode(generation.id, {
      modelRoute: 'relay-image-constrained', prompt: 'Adapt this image request',
      aspectRatio: '16:9', resolution: '4K', outputCount: 4,
    })).resolves.toBe(true);

    expect(useAppStore.getState().modelJobs).toHaveLength(4);
    expect(useAppStore.getState().modelJobs.every((job) => job.outputCount === 1)).toBe(true);
    expect(useAppStore.getState().modelJobs[0]).toMatchObject({
      aspectRatio: '1:1', resolution: '2K', outputCount: 1,
    });
  });

  it('creates one image job per requested output so every result can materialize into the 1-4 grid', async () => {
    replaceModelJobExecutorForTests({
      submit: vi.fn(async (job: ModelJob) => ({ providerTaskId: 'provider-' + job.id })),
      poll: vi.fn(async () => ({ status: 'running' as const, progress: 0.2 })),
      cancel: vi.fn(async () => {}),
    });
    installProviderProfilesForModelJobTests([{
      provider: 'comfly', modelRoute: 'four-up-image', displayName: 'Four Up Image', modelId: 'four-up-image',
      capabilities: ['image_generation', 'async_tasks'],
      constraints: { image: { aspectRatios: ['1:1'], resolutions: ['2K'], outputCounts: [1, 2, 3, 4] } },
    }]);
    resetAppStoreForTests();
    const generation = createCanvasModuleNode('multi-image-node', 'image_generation', { x: 0, y: 0 });
    useAppStore.setState({ project: { ...createStarterProject(), nodes: [generation], edges: [] } });

    await expect(useAppStore.getState().runImageGenerationNode(generation.id, {
      modelRoute: 'four-up-image', prompt: 'Generate a three-image product study',
      aspectRatio: '1:1', resolution: '2K', outputCount: 3,
    })).resolves.toBe(true);

    const jobs = useAppStore.getState().modelJobs;
    expect(jobs).toHaveLength(3);
    expect(jobs.every((job) => job.promptNodeId === generation.id && job.kind === 'image' && job.outputCount === 1)).toBe(true);
    expect(new Set(jobs.map((job) => job.confirmedAt)).size).toBe(1);
    expect(useAppStore.getState().project.nodes.find((node) => node.id === generation.id)).toMatchObject({
      data: { config: { lastResultJobId: jobs[0]?.id, resultState: 'pending' } },
    });
  });

  it('establishes a desktop project session before enqueueing image jobs', async () => {
    replaceModelJobExecutorForTests({
      submit: vi.fn(async (job: ModelJob) => ({ providerTaskId: `provider-${job.id}` })),
      poll: vi.fn(async () => ({ status: 'running' as const, progress: 0.2 })),
      cancel: vi.fn(async () => {}),
    });
    installProviderProfilesForModelJobTests([{
      provider: 'relayme', modelRoute: 'session-image', displayName: 'Session Image', modelId: 'session-image',
      capabilities: ['image_generation'],
    }]);
    const ensureModelExecutionSession = vi.fn(async () => 'desktop-session-image');
    replaceProjectPersistenceClientForTests(Object.assign(createMockClient({}), {
      ensureModelExecutionSession,
    }));
    resetAppStoreForTests();
    const generation = createCanvasModuleNode('session-image-node', 'image_generation', { x: 0, y: 0 });
    useAppStore.setState({ project: { ...createStarterProject(), nodes: [generation], edges: [], assets: [] } });

    await expect(useAppStore.getState().runImageGenerationNode(generation.id, {
      modelRoute: 'session-image', prompt: 'Create inside a durable project session',
      aspectRatio: '1:1', resolution: '1K', outputCount: 1,
    })).resolves.toBe(true);

    expect(ensureModelExecutionSession).toHaveBeenCalledOnce();
    expect(useAppStore.getState().modelJobs[0]?.projectSessionId).toBe('desktop-session-image');
  });

  it('omits image parameters that a complete provider profile does not declare', async () => {
    replaceModelJobExecutorForTests({
      submit: vi.fn(async (job: ModelJob) => ({ providerTaskId: 'provider-' + job.id })),
      poll: vi.fn(async () => ({ status: 'running' as const, progress: 0.2 })),
      cancel: vi.fn(async () => {}),
    });
    installProviderProfilesForModelJobTests([{
      provider: 'comfly', modelRoute: 'dall-e-3', displayName: 'DALL-E 3', modelId: 'dall-e-3',
      capabilities: ['image_generation', 'async_tasks'], capabilityStatus: 'complete',
      constraints: { image: { outputCounts: [1] } },
    }]);
    resetAppStoreForTests();
    const generation = createCanvasModuleNode('provider-default-image-node', 'image_generation', { x: 0, y: 0 });
    useAppStore.setState({ project: { ...createStarterProject(), nodes: [generation], edges: [], assets: [] } });

    await expect(useAppStore.getState().runImageGenerationNode(generation.id, {
      modelRoute: 'dall-e-3', prompt: 'Use model defaults', aspectRatio: '自由比例', resolution: 'Auto', outputCount: 1,
    })).resolves.toBe(true);

    expect(useAppStore.getState().modelJobs[0]?.outputCount).toBe(1);
    expect(useAppStore.getState().modelJobs[0]?.aspectRatio).toBeUndefined();
    expect(useAppStore.getState().modelJobs[0]?.resolution).toBeUndefined();
  });
  it('adapts a video-node request to the selected model constraints before enqueueing', async () => {
    replaceModelJobExecutorForTests({
      submit: vi.fn(async (job: ModelJob) => ({ providerTaskId: 'provider-' + job.id })),
      poll: vi.fn(async () => ({ status: 'running' as const, progress: 0.2 })),
      cancel: vi.fn(async () => {}),
    });
    installProviderProfilesForModelJobTests([{
      provider: 'relayme', modelRoute: 'relay-video-constrained', displayName: 'Relay Video Constrained', modelId: 'relay-video-constrained',
      capabilities: ['video_generation', 'async_tasks'],
      constraints: { video: { aspectRatios: ['9:16'], resolutions: ['720p'], duration: { mode: 'options', options: [4, 6] }, outputCounts: [1] } },
    }]);
    resetAppStoreForTests();
    const generation = createCanvasModuleNode('adapted-video-node', 'video_generation', { x: 0, y: 0 });
    useAppStore.setState({ project: { ...createStarterProject(), nodes: [generation], edges: [], assets: [] } });

    await expect(useAppStore.getState().runVideoPreviewNode(generation.id, {
      modelRoute: 'relay-video-constrained', prompt: 'Adapt this video request', referenceAssetIds: [], keyframe: 'auto',
      aspectRatio: '16:9', resolution: '4K', durationSeconds: 8, outputCount: 4, audioEnabled: true,
    })).resolves.toBe(true);

    expect(useAppStore.getState().modelJobs).toHaveLength(4);
    expect(useAppStore.getState().modelJobs.every((job) => job.outputCount === 1)).toBe(true);
    expect(useAppStore.getState().modelJobs[0]).toMatchObject({
      aspectRatio: '9:16', videoResolution: '720p', durationSeconds: 6, outputCount: 1,
    });
  });
  it('repairs a mixed RelayMe video node to its canonical same-provider route before enqueue', async () => {
    const generation = createCanvasModuleNode('mixed-relayme-video-node', 'video_generation', { x: 0, y: 0 });
    generation.data.config = {
      ...generation.data.config,
      modelDisplayName: 'Relay Video Pro',
      modelRoute: 'comfly-relay-video-pro',
      providerDisplayName: 'relayme',
    };
    installProviderProfilesForModelJobTests([{
      provider: 'relayme',
      modelRoute: 'relayme-video-pro',
      displayName: 'Relay Video Pro',
      modelId: 'video-pro',
      capabilities: ['video_generation', 'async_tasks'],
    }]);
    resetAppStoreForTests();
    useAppStore.setState({ project: { ...createStarterProject(), nodes: [generation], edges: [], assets: [] } });

    await expect(useAppStore.getState().runVideoPreviewNode(generation.id, {
      modelRoute: 'comfly-relay-video-pro',
      prompt: 'Repair the RelayMe video identity',
      referenceAssetIds: [],
      keyframe: 'auto', aspectRatio: '16:9', resolution: '1080p', durationSeconds: 8,
      outputCount: 1, audioEnabled: true,
    })).resolves.toBe(true);

    expect(useAppStore.getState().modelJobs[0]).toMatchObject({
      provider: 'relayme',
      modelRoute: 'relayme-video-pro',
      modelId: 'video-pro',
    });
    expect(useAppStore.getState().project.nodes[0]).toMatchObject({
      data: { config: { providerDisplayName: 'relayme', modelRoute: 'relayme-video-pro' } },
    });
  });
  it('omits video parameters that a complete provider profile does not declare', async () => {
    replaceModelJobExecutorForTests({
      submit: vi.fn(async (job: ModelJob) => ({ providerTaskId: 'provider-' + job.id })),
      poll: vi.fn(async () => ({ status: 'running' as const, progress: 0.2 })),
      cancel: vi.fn(async () => {}),
    });
    installProviderProfilesForModelJobTests([{
      provider: 'comfly', modelRoute: 'kling-duration-only', displayName: 'Kling duration only', modelId: 'kling-duration-only',
      capabilities: ['video_generation', 'async_tasks'], capabilityStatus: 'complete',
      constraints: { video: { duration: { mode: 'options', options: [5, 10] }, outputCounts: [1] } },
    }]);
    resetAppStoreForTests();
    const generation = createCanvasModuleNode('provider-default-video-node', 'video_generation', { x: 0, y: 0 });
    useAppStore.setState({ project: { ...createStarterProject(), nodes: [generation], edges: [], assets: [] } });

    await expect(useAppStore.getState().runVideoPreviewNode(generation.id, {
      modelRoute: 'kling-duration-only', prompt: 'Use model defaults', referenceAssetIds: [], keyframe: 'auto',
      aspectRatio: 'Auto', resolution: 'Auto', durationSeconds: 5, outputCount: 1, audioEnabled: true,
    })).resolves.toBe(true);

    expect(useAppStore.getState().modelJobs[0]).toMatchObject({ durationSeconds: 5, outputCount: 1 });
    expect(useAppStore.getState().modelJobs[0]?.aspectRatio).toBeUndefined();
    expect(useAppStore.getState().modelJobs[0]?.videoResolution).toBeUndefined();
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

    expect(listProfiles).toHaveBeenCalledTimes(2);
    expect(listProfiles).toHaveBeenNthCalledWith(1, { provider: 'comfly' });
    expect(listProfiles).toHaveBeenNthCalledWith(2, { provider: 'relayme' });
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

    expect(events.slice(0, 3)).toEqual(['profiles', 'profiles', 'commit']);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(listProfiles).toHaveBeenCalledTimes(2);
    expect(listProfiles).toHaveBeenNthCalledWith(1, { provider: 'comfly' });
    expect(listProfiles).toHaveBeenNthCalledWith(2, { provider: 'relayme' });
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

    expect(listProfiles).toHaveBeenCalledTimes(2);
    expect(listProfiles).toHaveBeenNthCalledWith(1, { provider: 'comfly' });
    expect(listProfiles).toHaveBeenNthCalledWith(2, { provider: 'relayme' });
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
    await waitForStore(() => listProfiles.mock.calls.length === 2);

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
    await waitForStore(() => listProfiles.mock.calls.length === 2);

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
    await waitForStore(() => listProfiles.mock.calls.length === 2);

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
    await waitForStore(() => listProfiles.mock.calls.length === 2);
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

    expect(listProfiles).toHaveBeenCalledTimes(2);
    expect(listProfiles).toHaveBeenNthCalledWith(1, { provider: 'comfly' });
    expect(listProfiles).toHaveBeenNthCalledWith(2, { provider: 'relayme' });
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
    await waitForStore(() => listProfiles.mock.calls.length === 2);
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
    await waitForStore(() => listProfiles.mock.calls.length === 2);
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

    expect(listProfiles).toHaveBeenCalledTimes(2);
    expect(listProfiles).toHaveBeenNthCalledWith(1, { provider: 'comfly' });
    expect(listProfiles).toHaveBeenNthCalledWith(2, { provider: 'relayme' });
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
    expect(listProfiles).toHaveBeenCalledTimes(2);
    expect(listProfiles).toHaveBeenNthCalledWith(1, { provider: 'comfly' });
    expect(listProfiles).toHaveBeenNthCalledWith(2, { provider: 'relayme' });
    expect(commit).not.toHaveBeenCalled();
    expect(submitImageJob).not.toHaveBeenCalled();
    expect(useAppStore.getState().modelJobs).toEqual([]);
    expect(useAppStore.getState().agentPlan?.conflicts.join(' ')).toMatch(/model profile/i);
  });

  it('hydrates the durable project and stops an interrupted model job without waiting for its provider', async () => {
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

    const durableProject = {
      ...createStarterProject(),
      id: 'hydrated-recovery-before-finish',
      name: 'hydrated-before-recovery-finishes',
    };
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
      expect(useAppStore.getState().modelJobs[0]?.status).toBe('cancelled');
    } finally {
      finalPoll.resolve({ status: 'completed', result: { assetId: 'asset-after-hydrate' } });
      await Promise.race([hydration.catch(() => undefined), delay(100)]);
    }
  });

  it('hydrates and resumes a persisted running image job when its source node still owns the result', async () => {
    const jobId = 'persisted-owned-image-job';
    const persistedAt = new Date(Date.now() - 60_000).toISOString();
    const source: Extract<CanvasNode, { type: 'module' }> = createCanvasModuleNode('persisted-owned-image-node', 'image_generation', { x: 0, y: 0 });
    source.data.config = {
      ...source.data.config,
      lastResultJobId: jobId,
      resultAssetIds: [],
      resultState: 'pending',
    };
    source.data.execution = { ...source.data.execution, state: 'queued' };
    const generatedAsset = {
      assetId: 'cccccccccccccccc', byteSize: 128, extension: 'png' as const, height: 512,
      label: 'Generated image', mediaType: 'image/png' as const, origin: 'generated' as const,
      sha256: 'c'.repeat(64), width: 512,
    };
    const durableProject = {
      ...createStarterProject(),
      id: 'persisted-owned-image-project',
      nodes: [source],
      edges: [],
      assets: [generatedAsset],
    };
    const storage = createTestModelJobStorage([{
      id: jobId,
      kind: 'image',
      modelId: 'gpt-image-1',
      status: 'running',
      promptNodeId: source.id,
      providerTaskId: 'provider-persisted-owned-image-job',
      confirmedAt: persistedAt,
      retryCount: 0,
      provider: 'comfly',
      modelRoute: 'image-generation',
      displayName: 'GPT Image',
      conversationId: `image-node-${source.id}`,
      projectSessionId: 'old-session',
      referenceAssetIds: [],
      createdAt: persistedAt,
      updatedAt: persistedAt,
    }]);
    const poll = vi.fn(async () => ({
      status: 'completed' as const,
      result: { assetId: generatedAsset.assetId, width: 512, height: 512 },
    }));
    const commit = vi.fn(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: request.nextProject,
      revision: request.baseRevision + 1,
    }));
    replaceModelJobStorageForTests(storage);
    replaceModelJobExecutorForTests({
      submit: vi.fn(async () => ({ providerTaskId: 'unused-submit' })),
      poll,
      cancel: vi.fn(async () => {}),
    });
    replaceProjectPersistenceClientForTests(Object.assign(createMockClient({
      commit,
      hydrate: async () => ({
        availableSnapshotIds: [],
        lifecycle: 'durable',
        mode: 'desktop',
        project: durableProject,
        revision: 5,
        saveStatus: 'saved',
      }),
    }), {
      getSessionId: () => 'new-session',
    }));
    resetAppStoreForTests({ project: 'empty' });

    await useAppStore.getState().hydratePersistence();
    await vi.waitFor(() => {
      expect(useAppStore.getState().modelJobs[0]?.status).toBe('completed');
    }, { timeout: 2_000 });

    expect(poll).toHaveBeenCalledWith(expect.objectContaining({ id: jobId, status: 'running' }));
    expect(useAppStore.getState().project.nodes.find((node) => node.id === source.id)).toMatchObject({
      type: 'module',
      data: {
        config: { resultAssetIds: [generatedAsset.assetId], resultState: 'fresh' },
        execution: { state: 'completed' },
      },
    });
  });

  it('waits for durable recovery before resuming the exact owned running image job', async () => {
    const jobId = 'recovery-owned-image-job';
    const persistedAt = new Date(Date.now() - 60_000).toISOString();
    const source: Extract<CanvasNode, { type: 'module' }> = createCanvasModuleNode('recovery-owned-image-node', 'image_generation', { x: 0, y: 0 });
    source.data.config = {
      ...source.data.config,
      lastResultJobId: jobId,
      resultAssetIds: [],
      resultState: 'pending',
    };
    source.data.execution = { ...source.data.execution, state: 'queued' };
    const generatedAsset = {
      assetId: 'dddddddddddddddd', byteSize: 128, extension: 'png' as const, height: 512,
      label: 'Recovered generated image', mediaType: 'image/png' as const, origin: 'generated' as const,
      sha256: 'd'.repeat(64), width: 512,
    };
    const recoveryProject = {
      ...createStarterProject(),
      id: 'recovery-owned-image-project',
      nodes: [source],
      edges: [],
      assets: [generatedAsset],
    };
    const storage = createTestModelJobStorage([{
      id: jobId,
      kind: 'image',
      modelId: 'gpt-image-1',
      status: 'running',
      promptNodeId: source.id,
      providerTaskId: 'provider-recovery-owned-image-job',
      confirmedAt: persistedAt,
      retryCount: 0,
      provider: 'comfly',
      modelRoute: 'image-generation',
      displayName: 'GPT Image',
      conversationId: `image-node-${source.id}`,
      projectSessionId: 'old-session',
      referenceAssetIds: [],
      createdAt: persistedAt,
      updatedAt: persistedAt,
    }]);
    const poll = vi.fn(async () => ({
      status: 'completed' as const,
      result: { assetId: generatedAsset.assetId, width: 512, height: 512 },
    }));
    const commit = vi.fn(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: request.nextProject,
      revision: request.baseRevision + 1,
    }));
    replaceModelJobStorageForTests(storage);
    replaceModelJobExecutorForTests({
      submit: vi.fn(async () => ({ providerTaskId: 'unused-submit' })),
      poll,
      cancel: vi.fn(async () => {}),
    });
    replaceProjectPersistenceClientForTests(Object.assign(createMockClient({
      commit,
      hydrate: async () => ({
        availableSnapshotIds: ['snapshot-recovery'],
        lifecycle: 'durable',
        mode: 'desktop',
        project: recoveryProject,
        recoveryRequired: true,
        revision: 5,
        saveStatus: 'error',
      }),
      restore: async () => ({
        availableSnapshotIds: [],
        lifecycle: 'durable',
        project: recoveryProject,
        recoveryRequired: false,
        revision: 5,
        saveStatus: 'saved',
      }),
    }), {
      getSessionId: () => 'recovered-session',
    }));
    resetAppStoreForTests({ project: 'empty' });

    await useAppStore.getState().hydratePersistence();
    await delay(20);
    expect(poll).not.toHaveBeenCalled();

    await useAppStore.getState().restoreProjectSnapshot('snapshot-recovery');
    await vi.waitFor(() => {
      expect(useAppStore.getState().modelJobs[0]?.status).toBe('completed');
    }, { timeout: 2_000 });

    expect(poll).toHaveBeenCalledWith(expect.objectContaining({ id: jobId, status: 'running' }));
    expect(useAppStore.getState().project.nodes.find((node) => node.id === source.id)).toMatchObject({
      type: 'module',
      data: {
        config: { resultAssetIds: [generatedAsset.assetId], resultState: 'fresh' },
        execution: { state: 'completed' },
      },
    });
  });

  it('marks a persisted running reverse task cancelled during hydration', async () => {
    const reverse = createCanvasModuleNode('reverse-interrupted-on-startup', 'reverse_agent', { x: 0, y: 0 });
    reverse.data.config = {
      modelRoute: 'gemini-reverse',
      role: 'Analyst',
      task: 'Analyze the image',
      knowledgeBaseIds: [],
      reverseAgentRunId: 'stale-reverse-run',
      reverseAgentRunState: 'running',
      reverseAgentStartedAt: '2026-08-19T01:00:00.000Z',
    };
    const durableProject = parseCanvasProject({ ...createStarterProject(), nodes: [reverse], edges: [] });
    const commit = vi.fn(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: request.nextProject,
      revision: request.baseRevision + 1,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({
      commit,
      hydrate: async () => ({
        availableSnapshotIds: [],
        lifecycle: 'durable',
        mode: 'desktop',
        project: durableProject,
        revision: 9,
        saveStatus: 'saved',
      }),
    }));

    await useAppStore.getState().hydratePersistence();

    expect(useAppStore.getState().project.nodes.find((node) => node.id === reverse.id)).toMatchObject({
      data: { config: {
        reverseAgentRunState: 'cancelled',
        reverseAgentCompletedAt: expect.any(String),
        reverseAgentError: null,
      } },
    });
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
      transaction: expect.objectContaining({ label: 'Stop interrupted reverse Agent runs' }),
    }));
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

  it('ignores a late provider result from a model job stopped during hydration', async () => {
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

    const durableProject = {
      ...createStarterProject(),
      id: 'hydrated-recovery-result-target',
      name: 'hydrated-result-target',
    };
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
      await delay(20);

      expect(useAppStore.getState().modelJobs[0]?.status).toBe('cancelled');
      expect(commit.mock.calls.map(([request]) => request).some((request) => request.transaction.id.startsWith('model-job-result-'))).toBe(false);
    } finally {
      finalPoll.resolve({ status: 'completed', result: { assetId: 'asset-hydrated-result' } });
      await Promise.race([hydration.catch(() => undefined), delay(100)]);
    }
  });

  it('does not stream progress or terminal updates from an interrupted job after hydration', async () => {
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

    const durableProject = {
      ...createStarterProject(),
      id: 'hydrated-recovery-live-progress',
      name: 'hydrated-live-progress',
    };
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
      expect(useAppStore.getState().modelJobs[0]?.status).toBe('cancelled');
      expect(useAppStore.getState().modelJobs[0]?.progress).not.toBe(0.65);

      finalPoll.resolve({ status: 'completed', progress: 1, result: { assetId: 'asset-live-recovered' } });
      await delay(20);

      expect(useAppStore.getState().modelJobs[0]).toMatchObject({
        status: 'cancelled',
      });
      expect(useAppStore.getState().modelJobs[0]).not.toHaveProperty('resultAssetId');
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
    expect(useAppStore.getState()).toMatchObject({
      canReloadDurableProject: true,
      canRetryProjectCommit: false,
      projectCommitConflictCode: 'CONCURRENT_WRITER',
      saveErrorCode: 'CONCURRENT_WRITER',
      saveStatus: 'error',
    });
    const dirtyPlacement = useAppStore.getState().project.nodes.find((node) => node.id === placement.id);
    expect(dirtyPlacement?.type === 'placement_preview'
      ? dirtyPlacement.data.objects.map((object) => object.assetId)
      : []).toEqual(['scene', 'product']);
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

  it.each(['success', 'failure'] as const)(
    'keeps the active commit boundary intact after an open cancel and applies the delayed %s acknowledgement',
    async (resultKind) => {
      const commitResult = deferred<ProjectCommitResult>();
      const commit = vi.fn().mockReturnValue(commitResult.promise);
      replaceProjectPersistenceClientForTests(createMockClient({
        commit,
        openProject: async () => null,
      }));
      const initialProject = moduleGraphProject();
      useAppStore.setState({
        desktopRevision: 0,
        persistenceMode: 'desktop',
        project: initialProject,
        projectLifecycle: 'durable',
        saveStatus: 'saved',
      });

      const pending = useAppStore.getState().commitNodePosition('prompt', { x: 20, y: 30 });
      expect(await useAppStore.getState().openProject()).toBe(false);
      const request = commit.mock.calls[0]![0] as ProjectCommitRequest;
      commitResult.resolve(resultKind === 'success'
        ? { ok: true, project: request.nextProject, revision: 1 }
        : { code: 'DISK_FULL', ok: false, project: request.previousProject, revision: 0 });

      expect(await pending).toBe(resultKind === 'success');
      expect(useAppStore.getState().project.nodes.find((node) => node.id === 'prompt')?.position).toEqual({ x: 20, y: 30 });
      expect(useAppStore.getState()).toMatchObject(resultKind === 'success'
        ? { canRetryProjectCommit: false, desktopRevision: 1, saveStatus: 'saved' }
        : { canRetryProjectCommit: true, desktopRevision: 0, saveErrorCode: 'DISK_FULL', saveStatus: 'error' });
    },
  );

  it('keeps the active commit boundary intact after an open rejection', async () => {
    const commitResult = deferred<ProjectCommitResult>();
    const commit = vi.fn().mockReturnValue(commitResult.promise);
    replaceProjectPersistenceClientForTests(createMockClient({
      commit,
      openProject: async () => { throw new Error('open rejected'); },
    }));
    useAppStore.setState({ project: moduleGraphProject(), saveStatus: 'saved' });

    const pending = useAppStore.getState().commitNodePosition('prompt', { x: 20, y: 30 });
    await expect(useAppStore.getState().openProject()).rejects.toThrow('open rejected');
    const request = commit.mock.calls[0]![0] as ProjectCommitRequest;
    commitResult.resolve({ ok: true, project: request.nextProject, revision: 1 });

    await expect(pending).resolves.toBe(true);
    expect(useAppStore.getState()).toMatchObject({ desktopRevision: 1, saveStatus: 'saved' });
  });

  it('keeps the active commit boundary intact after a hydrate rejection', async () => {
    const commitResult = deferred<ProjectCommitResult>();
    const commit = vi.fn().mockReturnValue(commitResult.promise);
    replaceProjectPersistenceClientForTests(createMockClient({
      commit,
      hydrate: async () => { throw new Error('hydrate rejected'); },
    }));
    useAppStore.setState({ project: moduleGraphProject(), saveStatus: 'saved' });

    const pending = useAppStore.getState().commitNodePosition('prompt', { x: 20, y: 30 });
    await expect(useAppStore.getState().hydratePersistence()).rejects.toThrow('hydrate rejected');
    const request = commit.mock.calls[0]![0] as ProjectCommitRequest;
    commitResult.resolve({ ok: true, project: request.nextProject, revision: 1 });

    await expect(pending).resolves.toBe(true);
    expect(useAppStore.getState()).toMatchObject({ desktopRevision: 1, saveStatus: 'saved' });
  });

  it('keeps the active commit boundary intact after a stale browser restore request', async () => {
    const commitResult = deferred<ProjectCommitResult>();
    const commit = vi.fn().mockReturnValue(commitResult.promise);
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    localStorage.clear();
    useAppStore.setState({
      persistenceMode: 'browser',
      project: moduleGraphProject(),
      projectLifecycle: 'durable',
      saveStatus: 'saved',
    });

    const pending = useAppStore.getState().commitNodePosition('prompt', { x: 20, y: 30 });
    await useAppStore.getState().restoreProjectSnapshot('missing-browser-snapshot');
    const request = commit.mock.calls[0]![0] as ProjectCommitRequest;
    commitResult.resolve({ ok: true, project: request.nextProject, revision: 1 });

    await expect(pending).resolves.toBe(true);
    expect(useAppStore.getState()).toMatchObject({ desktopRevision: 1, saveStatus: 'saved' });
  });

  it('keeps the active commit boundary intact after a desktop restore rejection', async () => {
    const commitResult = deferred<ProjectCommitResult>();
    const commit = vi.fn().mockReturnValue(commitResult.promise);
    replaceProjectPersistenceClientForTests(createMockClient({
      commit,
      restore: async () => { throw new Error('restore rejected'); },
    }));
    useAppStore.setState({
      persistenceMode: 'desktop',
      project: moduleGraphProject(),
      projectLifecycle: 'durable',
      saveStatus: 'saved',
    });

    const pending = useAppStore.getState().commitNodePosition('prompt', { x: 20, y: 30 });
    const restore = useAppStore.getState().restoreProjectSnapshot('snapshot-rejected');
    const request = commit.mock.calls[0]![0] as ProjectCommitRequest;
    commitResult.resolve({ ok: true, project: request.nextProject, revision: 1 });

    await expect(pending).resolves.toBe(true);
    await expect(restore).rejects.toThrow('restore rejected');
    expect(useAppStore.getState()).toMatchObject({ desktopRevision: 1, saveStatus: 'saved' });
  });

  it('serializes desktop snapshot restore after an active durable commit succeeds', async () => {
    const commitResult = deferred<ProjectCommitResult>();
    const initialProject = moduleGraphProject();
    const restoredProject = { ...initialProject, name: 'Restored after active commit' };
    const events: string[] = [];
    const commit = vi.fn((request: ProjectCommitRequest) => {
      events.push('commit');
      return commitResult.promise.then((result) => {
        events.push('commit-settled');
        return result;
      });
    });
    const restore = vi.fn(async () => {
      events.push('restore');
      return {
        availableSnapshotIds: ['snapshot-after'],
        lifecycle: 'durable' as const,
        project: restoredProject,
        revision: 7,
        saveStatus: 'saved' as const,
      };
    });
    replaceProjectPersistenceClientForTests(createMockClient({ commit, restore }));
    useAppStore.setState({
      desktopRevision: 0,
      persistenceMode: 'desktop',
      project: initialProject,
      projectLifecycle: 'durable',
      saveStatus: 'saved',
    });

    const pendingCommit = useAppStore.getState().commitNodePosition('prompt', { x: 20, y: 30 });
    const pendingRestore = useAppStore.getState().restoreProjectSnapshot('snapshot-after');
    expect(restore).not.toHaveBeenCalled();
    const request = commit.mock.calls[0]![0];
    commitResult.resolve({ ok: true, project: request.nextProject, revision: 1 });

    await expect(pendingCommit).resolves.toBe(true);
    await pendingRestore;
    expect(events).toEqual(['commit', 'commit-settled', 'restore']);
    expect(useAppStore.getState()).toMatchObject({
      canRetryProjectCommit: false,
      desktopRevision: 7,
      project: { name: 'Restored after active commit' },
      saveStatus: 'saved',
    });
  });

  it('blocks desktop snapshot restore after an active durable commit fails', async () => {
    const commitResult = deferred<ProjectCommitResult>();
    const initialProject = moduleGraphProject();
    const restore = vi.fn(async () => ({
      availableSnapshotIds: ['snapshot-after'],
      lifecycle: 'durable' as const,
      project: { ...initialProject, name: 'Must not restore' },
      revision: 7,
      saveStatus: 'saved' as const,
    }));
    const commit = vi.fn().mockReturnValue(commitResult.promise);
    replaceProjectPersistenceClientForTests(createMockClient({ commit, restore }));
    useAppStore.setState({
      desktopRevision: 0,
      persistenceMode: 'desktop',
      project: initialProject,
      projectLifecycle: 'durable',
      saveStatus: 'saved',
    });

    const pendingCommit = useAppStore.getState().commitNodePosition('prompt', { x: 20, y: 30 });
    const pendingRestore = useAppStore.getState().restoreProjectSnapshot('snapshot-after');
    expect(restore).not.toHaveBeenCalled();
    const request = commit.mock.calls[0]![0] as ProjectCommitRequest;
    commitResult.resolve({
      code: 'DISK_FULL',
      ok: false,
      project: request.previousProject,
      revision: request.baseRevision,
    });

    await expect(pendingCommit).resolves.toBe(false);
    await pendingRestore;
    expect(restore).not.toHaveBeenCalled();
    expect(useAppStore.getState()).toMatchObject({
      canRetryProjectCommit: true,
      desktopRevision: 0,
      saveErrorCode: 'DISK_FULL',
      saveStatus: 'error',
    });
    expect(useAppStore.getState().project.nodes.find((node) => node.id === 'prompt')?.position).toEqual({ x: 20, y: 30 });
  });

  it('keeps a delayed reverse draft valid across same-project layout synchronization', async () => {
    const commitResult = deferred<ProjectCommitResult>();
    const commit = vi.fn().mockReturnValue(commitResult.promise);
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    const reverse = createCanvasModuleNode('same-project-reverse-draft', 'reverse_agent', { x: 0, y: 0 });
    useAppStore.setState({
      desktopRevision: 0,
      persistenceMode: 'desktop',
      project: { ...createStarterProject(), nodes: [reverse], edges: [] },
      projectLifecycle: 'durable',
      saveStatus: 'saved',
    });

    const pendingPosition = useAppStore.getState().commitNodePosition(reverse.id, { x: 20, y: 30 });
    const pendingDraft = useAppStore.getState().draftReverseAgentConfig(reverse.id, {
      modelRoute: 'gemini-reverse',
      role: 'Latest analyst role',
      task: 'Latest analysis task',
      knowledgeBaseIds: [],
      referenceAssetIds: [],
    });
    useAppStore.getState().setProject({
      ...useAppStore.getState().project,
      name: 'Same project layout synchronization',
    }, { schedulePersist: false });

    const request = commit.mock.calls[0]![0] as ProjectCommitRequest;
    commitResult.resolve({ ok: true, project: request.nextProject, revision: 1 });

    await expect(pendingPosition).resolves.toBe(true);
    await expect(pendingDraft).resolves.toBe(true);
    expect(useAppStore.getState().project.nodes[0]).toMatchObject({
      data: { config: { role: 'Latest analyst role', task: 'Latest analysis task' } },
      position: { x: 20, y: 30 },
    });
  });

  it.each(
    (['success', 'failure'] as const).flatMap((resultKind) => (
      ['open', 'hydrate', 'new', 'reset', 'discard', 'set_project'] as const
    ).map((boundary) => ({ boundary, resultKind }))),
  )('ignores a delayed $resultKind commit result after the $boundary project boundary', async ({ boundary, resultKind }) => {
    const commitResult = deferred<ProjectCommitResult>();
    const initialProject = moduleGraphProject();
    const boundaryProject = {
      ...moduleGraphProject(),
      ...(boundary === 'set_project' ? { id: 'replacement-project-boundary' } : {}),
      name: `Boundary ${boundary}`,
    };
    const close = vi.fn(async () => undefined);
    const durableResult = {
      availableSnapshotIds: [],
      lifecycle: 'durable' as const,
      mode: 'desktop' as const,
      project: boundaryProject,
      revision: 9,
      saveStatus: 'saved' as const,
    };
    replaceProjectPersistenceClientForTests(createMockClient({
      close,
      commit: vi.fn().mockReturnValue(commitResult.promise),
      hydrate: async () => durableResult,
      openProject: async () => durableResult,
      restore: async () => ({
        availableSnapshotIds: [],
        lifecycle: 'durable',
        project: boundaryProject,
        revision: 9,
        saveStatus: 'saved',
      }),
      stablePoint: async () => ({ availableSnapshotIds: [], project: initialProject, revision: 0 }),
    }));
    useAppStore.setState({
      desktopRevision: 0,
      persistenceMode: 'desktop',
      project: initialProject,
      projectLifecycle: 'durable',
      saveStatus: 'saved',
    });

    const pending = useAppStore.getState().commitNodePosition('prompt', { x: 20, y: 30 });
    expect(useAppStore.getState().saveStatus).toBe('saving');

    switch (boundary) {
      case 'open':
        expect(await useAppStore.getState().openProject()).toBe(true);
        break;
      case 'hydrate':
        await useAppStore.getState().hydratePersistence();
        break;
      case 'new':
        await useAppStore.getState().newWorkflow();
        break;
      case 'reset':
        resetAppStoreForTests({ project: 'empty' });
        break;
      case 'discard':
        expect(await useAppStore.getState().discardPersistence()).toBe(true);
        break;
      case 'set_project':
        useAppStore.getState().setProject(boundaryProject, { schedulePersist: false });
        break;
    }

    const request = (useAppStore.getState().saveStatus === 'saving' ? initialProject : boundaryProject);
    commitResult.resolve(resultKind === 'success'
      ? { ok: true, project: { ...request, name: 'Late ACK project' }, revision: 1 }
      : { code: 'DISK_FULL', ok: false, project: initialProject, revision: 0 });

    expect(await pending).toBe(false);
    expect(useAppStore.getState().desktopRevision).not.toBe(1);
    expect(useAppStore.getState().project.name).not.toBe('Late ACK project');
    if (boundary === 'open' || boundary === 'hydrate' || boundary === 'set_project') {
      expect(useAppStore.getState().project.name).toBe(`Boundary ${boundary}`);
    }
    if (boundary === 'new' || boundary === 'reset') {
      expect(useAppStore.getState().projectLifecycle).toBe('untitled');
    }
  });

  it('waits for an active project commit before creating the close stable point and closing persistence', async () => {
    const commitResult = deferred<ProjectCommitResult>();
    const initialProject = moduleGraphProject();
    const close = vi.fn(async () => undefined);
    const stablePoint = vi.fn(async () => ({
      availableSnapshotIds: ['close-after-active-commit'],
      lifecycle: 'durable' as const,
      project: useAppStore.getState().project,
      revision: 1,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({
      close,
      commit: vi.fn().mockReturnValue(commitResult.promise),
      stablePoint,
    }));
    useAppStore.setState({
      desktopRevision: 0,
      persistenceMode: 'desktop',
      project: initialProject,
      projectLifecycle: 'durable',
      saveStatus: 'saved',
    });

    const pendingCommit = useAppStore.getState().commitNodePosition('prompt', { x: 20, y: 30 });
    const closing = useAppStore.getState().closePersistence();

    await expect(Promise.race([closing, Promise.resolve('still-pending')])).resolves.toBe('still-pending');
    expect(stablePoint).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();

    const request = (useAppStore.getState().saveStatus === 'saving'
      ? (useAppStore.getState().project)
      : initialProject);
    commitResult.resolve({ ok: true, project: request, revision: 1 });

    await expect(pendingCommit).resolves.toBe(true);
    await expect(closing).resolves.toBe(true);
    expect(stablePoint).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(useAppStore.getState()).toMatchObject({
      availableSnapshotIds: ['close-after-active-commit'],
      saveErrorCode: null,
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

  it('serializes a module edit and reference reorder through one stable project operation queue', async () => {
    const firstAck = deferred<ProjectCommitResult>();
    const commit = vi.fn()
      .mockReturnValueOnce(firstAck.promise)
      .mockImplementation(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
        ok: true,
        project: request.nextProject,
        revision: request.baseRevision + 1,
      }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    useAppStore.setState({ project: moduleGraphProjectWithPlacementReferences(), saveStatus: 'saved' });

    const move = useAppStore.getState().commitNodePosition('prompt', { x: 20, y: 30 });
    const reorder = useAppStore.getState().commitReferenceOrder(['scene', 'product']);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(readPlacementAssetIds(useAppStore.getState().project)).toEqual(['product', 'scene']);

    const firstRequest = commit.mock.calls[0]![0] as ProjectCommitRequest;
    firstAck.resolve({ ok: true, project: firstRequest.nextProject, revision: 1 });
    await waitForStore(() => commit.mock.calls.length === 2);

    const secondRequest = commit.mock.calls[1]![0] as ProjectCommitRequest;
    expect(secondRequest.baseRevision).toBe(1);
    expect(secondRequest.previousProject.nodes.find((node) => node.id === 'prompt')?.position).toEqual({ x: 20, y: 30 });
    expect(readPlacementAssetIds(secondRequest.nextProject)).toEqual(['scene', 'product']);
    await expect(Promise.all([move, reorder])).resolves.toEqual([true, true]);
  });

  it('serializes two direct durable callers and rebuilds the second project from the first acknowledgement', async () => {
    const firstAck = deferred<ProjectCommitResult>();
    const commit = vi.fn()
      .mockReturnValueOnce(firstAck.promise)
      .mockImplementation(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
        ok: true,
        project: request.nextProject,
        revision: request.baseRevision + 1,
      }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    const project = moduleGraphProject();
    useAppStore.setState({ project, saveStatus: 'saved' });
    const prompt = project.nodes.find((node) => node.id === 'prompt')!;
    const generator = project.nodes.find((node) => node.id === 'generator')!;
    const firstTransaction: ProjectTransaction = {
      id: 'direct-a',
      label: 'Move prompt directly',
      operations: [{ kind: 'canvas', operation: { kind: 'update_node', node: { ...prompt, position: { x: 20, y: 30 } } } }],
    };
    const secondTransaction: ProjectTransaction = {
      id: 'direct-b',
      label: 'Move generator directly',
      operations: [{ kind: 'canvas', operation: { kind: 'update_node', node: { ...generator, position: { x: 420, y: 30 } } } }],
    };

    const first = useAppStore.getState().commitProjectTransaction(firstTransaction);
    const second = useAppStore.getState().commitProjectTransaction(secondTransaction);
    expect(commit).toHaveBeenCalledTimes(1);

    const firstRequest = commit.mock.calls[0]![0] as ProjectCommitRequest;
    firstAck.resolve({ ok: true, project: firstRequest.nextProject, revision: 1 });
    await waitForStore(() => commit.mock.calls.length === 2);

    const secondRequest = commit.mock.calls[1]![0] as ProjectCommitRequest;
    expect(secondRequest.baseRevision).toBe(1);
    expect(secondRequest.previousProject.nodes.find((node) => node.id === 'prompt')?.position).toEqual({ x: 20, y: 30 });
    expect(secondRequest.nextProject.nodes.find((node) => node.id === 'generator')?.position).toEqual({ x: 420, y: 30 });
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });

  it('does not execute queued durable builders after the first stable operation fails', async () => {
    const firstResult = deferred<ProjectCommitResult>();
    const commit = vi.fn().mockReturnValue(firstResult.promise);
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    const project = moduleGraphProjectWithPlacementReferences();
    useAppStore.setState({ project, saveStatus: 'saved' });
    const generator = project.nodes.find((node) => node.id === 'generator')!;
    const directTransaction: ProjectTransaction = {
      id: 'queued-direct-c',
      label: 'Queued direct generator move',
      operations: [{ kind: 'canvas', operation: { kind: 'update_node', node: { ...generator, position: { x: 520, y: 60 } } } }],
    };

    const first = useAppStore.getState().commitNodePosition('prompt', { x: 20, y: 30 });
    const second = useAppStore.getState().commitReferenceOrder(['scene', 'product']);
    const third = useAppStore.getState().commitProjectTransaction(directTransaction);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(readPlacementAssetIds(useAppStore.getState().project)).toEqual(['product', 'scene']);
    expect(useAppStore.getState().project.nodes.find((node) => node.id === 'generator')?.position).toEqual({ x: 320, y: 0 });

    const failedRequest = commit.mock.calls[0]![0] as ProjectCommitRequest;
    firstResult.resolve({
      code: 'DISK_FULL',
      ok: false,
      project: failedRequest.previousProject,
      revision: failedRequest.baseRevision,
    });

    await expect(Promise.all([first, second, third])).resolves.toEqual([false, false, false]);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState()).toMatchObject({
      canRetryProjectCommit: true,
      saveErrorCode: 'DISK_FULL',
      saveStatus: 'error',
    });
    expect(useAppStore.getState().project.nodes.find((node) => node.id === 'prompt')?.position).toEqual({ x: 20, y: 30 });
    expect(readPlacementAssetIds(useAppStore.getState().project)).toEqual(['product', 'scene']);
    expect(useAppStore.getState().project.nodes.find((node) => node.id === 'generator')?.position).toEqual({ x: 320, y: 0 });
  });

  it('retries writable reload after close failure and preserves conflict work until replacement succeeds', async () => {
    const durableProject = { ...moduleGraphProject(), name: 'Reloaded durable project' };
    const reloadDurableProject = vi.fn<() => Promise<ProjectHydrationResult | null>>()
      .mockRejectedValueOnce(new Error('close failed after partial cleanup'))
      .mockResolvedValueOnce({
        availableSnapshotIds: [],
        lifecycle: 'durable',
        mode: 'desktop',
        project: durableProject,
        revision: 7,
        saveStatus: 'saved',
      });
    const openProject = vi.fn(async () => null);
    const commit = vi.fn(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: request.nextProject,
      revision: request.baseRevision + 1,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit, openProject, reloadDurableProject }));
    const localConflictProject = {
      ...moduleGraphProject(),
      nodes: moduleGraphProject().nodes.map((node) => node.id === 'prompt'
        ? { ...node, position: { x: 20, y: 30 } }
        : node),
    };
    useAppStore.setState({
      canReloadDurableProject: true,
      desktopRevision: 4,
      persistenceMode: 'desktop',
      project: localConflictProject,
      projectCommitConflictCode: 'REVISION_CONFLICT',
      saveErrorCode: 'REVISION_CONFLICT',
      saveStatus: 'error',
    });

    expect(await useAppStore.getState().reloadDurableProject()).toBe(false);
    expect(useAppStore.getState()).toMatchObject({
      canReloadDurableProject: true,
      projectCommitConflictCode: 'REVISION_CONFLICT',
      saveStatus: 'error',
    });
    expect(useAppStore.getState().project.nodes.find((node) => node.id === 'prompt')?.position).toEqual({ x: 20, y: 30 });

    expect(await useAppStore.getState().reloadDurableProject()).toBe(true);
    expect(reloadDurableProject).toHaveBeenCalledTimes(2);
    expect(openProject).not.toHaveBeenCalled();
    expect(useAppStore.getState()).toMatchObject({
      canReloadDurableProject: false,
      desktopRevision: 7,
      project: { name: 'Reloaded durable project' },
      projectCommitConflictCode: null,
      saveStatus: 'saved',
    });
    expect(await useAppStore.getState().commitNodePosition('prompt', { x: 60, y: 70 })).toBe(true);
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ baseRevision: 7 }));
    expect(useAppStore.getState()).toMatchObject({ desktopRevision: 8, saveStatus: 'saved' });
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

  it('atomically reorders mixed image and video edges connected to an Agent media input', async () => {
    const imageInput = createCanvasModuleNode('mixed-reorder-image', 'image_input', { x: 0, y: 0 });
    imageInput.data.config = { assetId: '1111111111111111' };
    const firstVideo = createCanvasModuleNode('mixed-reorder-video-a', 'video_input', { x: 0, y: 100 });
    firstVideo.data.config = { assetId: '2222222222222222' };
    const secondVideo = createCanvasModuleNode('mixed-reorder-video-b', 'video_input', { x: 0, y: 200 });
    secondVideo.data.config = { assetId: '3333333333333333' };
    const reverse = createCanvasModuleNode('mixed-reorder-agent', 'reverse_agent', { x: 400, y: 0 });
    const project = parseCanvasProject({
      ...createStarterProject(),
      nodes: [imageInput, firstVideo, secondVideo, reverse],
      edges: [
        { id: 'mixed-image-edge', source: imageInput.id, sourcePortId: 'image', target: reverse.id, targetPortId: 'references', order: 0 },
        { id: 'mixed-video-a-edge', source: firstVideo.id, sourcePortId: 'video', target: reverse.id, targetPortId: 'references', order: 1 },
        { id: 'mixed-video-b-edge', source: secondVideo.id, sourcePortId: 'video', target: reverse.id, targetPortId: 'references', order: 2 },
      ],
      assets: [
        { assetId: '1111111111111111', byteSize: 42, extension: 'png', height: 100, label: 'Image', mediaType: 'image/png', origin: 'imported', sha256: '1'.repeat(64), width: 100 },
        { assetId: '2222222222222222', byteSize: 1_024, durationMs: 4_000, extension: 'mp4', height: 720, label: 'Video A', mediaType: 'video/mp4', origin: 'imported', sha256: '2'.repeat(64), width: 1280 },
        { assetId: '3333333333333333', byteSize: 2_048, durationMs: 5_000, extension: 'mp4', height: 720, label: 'Video B', mediaType: 'video/mp4', origin: 'imported', sha256: '3'.repeat(64), width: 1280 },
      ],
    });
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true, project: nextProject, revision: 9,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    useAppStore.setState({ project, desktopRevision: 8, saveStatus: 'saved' });

    expect(await useAppStore.getState().reorderModuleInput(reverse.id, 'references', [
      'mixed-video-b-edge', 'mixed-image-edge', 'mixed-video-a-edge',
    ])).toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().project.edges
      .filter((edge) => edge.target === reverse.id)
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
      .map((edge) => edge.id)).toEqual(['mixed-video-b-edge', 'mixed-image-edge', 'mixed-video-a-edge']);
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

  it('copies a history image and creates one asset-bound image node with a stable transaction', async () => {
    const asset = {
      assetId: '0123456789abcdef', byteSize: 42, extension: 'png' as const, height: 50,
      label: 'History image', mediaType: 'image/png' as const, origin: 'generated' as const,
      sha256: `0123456789abcdef${'0'.repeat(48)}`, width: 25,
    };
    const copiedProject = parseCanvasProject({ ...createStarterProject(), assets: [asset] });
    const copyHistoryToProject = vi.fn(async () => ({
      project: copiedProject,
      projectAssetId: asset.assetId,
      revision: 4,
    }));
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 5,
    }));
    const listProjectImages = vi.fn(async () => [{ ...asset, displayUrl: `novus-asset://project/session/${asset.assetId}`, usageCount: 1 }]);
    replaceProjectPersistenceClientForTests(createMockClient({ commit, copyHistoryToProject, listProjectImages }));
    useAppStore.setState({ desktopRevision: 3, project: createStarterProject(), saveStatus: 'saved' });

    expect(await useAppStore.getState().addHistoryImageToCanvas(
      'history_0123456789abcdef',
      'operation_history_canvas_01234567',
      { x: 420, y: 260 },
    )).toBe(true);

    expect(copyHistoryToProject).toHaveBeenCalledWith({
      historyId: 'history_0123456789abcdef',
      operationId: 'operation_history_canvas_01234567',
    });
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
      baseRevision: 4,
      transaction: expect.objectContaining({ id: 'history-canvas-operation_history_canvas_01234567' }),
    }));
    const node = useAppStore.getState().project.nodes.find((candidate) => candidate.id === 'history-node-operation_history_canvas_01234567');
    expect(node).toMatchObject({
      position: { x: 420, y: 260 },
      data: { moduleType: 'image_input', config: { assetId: asset.assetId } },
    });
    expect(useAppStore.getState()).toMatchObject({ desktopRevision: 5, projectImages: [{ assetId: asset.assetId }] });
  });

  it('reuses a safe history summary as one configured image generation node', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 6,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    useAppStore.setState({ desktopRevision: 5, project: createStarterProject(), saveStatus: 'saved' });
    const summary = {
      historyId: 'history_0123456789abcdef',
      parameters: { aspectRatio: '4:5', outputCount: 2, quality: 'high' as const, seed: 42 },
      promptSummary: 'Clean studio product scene',
      provider: { displayName: 'Novus Compatible', modelDisplayName: 'Image Studio', capabilityRevision: '2026-07' },
    };

    expect(await useAppStore.getState().reuseHistoryParameters(
      summary,
      'operation_history_reuse_01234567',
      { x: 360, y: 220 },
    )).toBe(true);

    const node = useAppStore.getState().project.nodes.find((candidate) => candidate.id === 'history-reuse-node-operation_history_reuse_01234567');
    expect(node).toMatchObject({
      position: { x: 360, y: 220 },
      data: {
        moduleType: 'image_generation',
        config: {
          aspectRatio: '4:5',
          modelDisplayName: 'Image Studio',
          outputCount: 2,
          prompt: 'Clean studio product scene',
          quality: 'high',
          seed: 42,
        },
      },
    });
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
      transaction: expect.objectContaining({ id: 'history-reuse-operation_history_reuse_01234567' }),
    }));
  });

  it('runs an applied reverse Agent node only with its connected managed media and selected knowledge snapshots', async () => {
    const reverse = createCanvasModuleNode('reverse-direct-run', 'reverse_agent', { x: 360, y: 0 });
    reverse.data.config = {
      modelRoute: 'gemini-reverse',
      role: 'Commercial visual analyst',
      task: 'Return a concise image-generation prompt.',
      knowledgeBaseIds: [],
      mode: 'auto',
      orderedMedia: [],
      resultState: 'empty',
    };
    const imageInput = createCanvasModuleNode('reverse-image', 'image_input', { x: 0, y: 0 });
    imageInput.data.config = { assetId: 'aaaaaaaaaaaaaaaa' };
    const project = parseCanvasProject({
      ...createStarterProject(),
      assets: [{
        assetId: 'aaaaaaaaaaaaaaaa', byteSize: 42, extension: 'png', height: 100,
        label: 'Managed product', mediaType: 'image/png', origin: 'imported', sha256: 'a'.repeat(64), width: 100,
      }],
      nodes: [imageInput, reverse],
      edges: [{ id: 'reverse-image-edge', source: imageInput.id, sourcePortId: 'image', target: reverse.id, targetPortId: 'references', order: 0 }],
    });
    const analyzeReversePrompt = vi.fn(async (input: NonNullable<ProjectPersistenceClient['analyzeReversePrompt']> extends (value: infer T) => Promise<unknown> ? T : never) => ({
      sessionId: input.run.sessionId,
      nonce: input.run.nonce,
      knowledgeSnapshotVersion: input.run.knowledgeLease.versionKey,
      analysis: 'A centered product with soft studio light.',
      keywords: ['product', 'studio'],
      positivePrompt: 'Centered product hero shot with soft studio light.',
      negativeConstraints: ['Do not alter the logo'],
      executionChecklist: ['Verify product identity'],
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ analyzeReversePrompt }));
    replaceKnowledgeClientForTests(createKnowledgeClient());
    useAppStore.setState({
      project,
      projectImages: [{
        assetId: 'aaaaaaaaaaaaaaaa', byteSize: 42, displayUrl: 'novus-asset://project/session/aaaaaaaaaaaaaaaa', extension: 'png', height: 100,
        label: 'Managed product', mediaType: 'image/png', origin: 'imported', sha256: 'a'.repeat(64), usageCount: 1, width: 100,
      }],
    });

    const result = await useAppStore.getState().runReverseAgentNode(reverse.id);

    expect(result?.positivePrompt).toBe('Centered product hero shot with soft studio light.');
    expect(analyzeReversePrompt).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'comfly',
      media: [{ kind: 'image', assetId: 'aaaaaaaaaaaaaaaa', byteSize: 42, mediaType: 'image/png', sha256: 'a'.repeat(64) }],
      run: expect.objectContaining({ agentConfig: {
        modelRoute: 'gemini-reverse',
        role: 'Commercial visual analyst',
        task: 'Return a concise image-generation prompt.',
        knowledgeBaseIds: [],
      } }),
    }));
    expect(useAppStore.getState().project.nodes.find((node) => node.id === reverse.id)).toMatchObject({
      data: {
        config: {
          reverseAgentResult: {
            positivePrompt: 'Centered product hero shot with soft studio light.',
          },
          reverseAgentRunState: 'completed',
        },
      },
    });
    const reverseResult = useAppStore.getState().project.nodes.find((node) => (
      node.type === 'module' && node.data.moduleType === 'reverse_result'
    ));
    expect(reverseResult).toMatchObject({
      position: { x: reverse.position.x + 680, y: reverse.position.y },
    });
    expect(useAppStore.getState().project.edges).toContainEqual(expect.objectContaining({
      source: reverse.id,
      sourcePortId: 'analysis',
      target: reverseResult?.id,
      targetPortId: 'analysis',
    }));
  });

  it('durably updates an edited reverse result without dropping its run identity', async () => {
    const reverse = createCanvasModuleNode('reverse-edit-durable', 'reverse_agent', { x: 360, y: 0 });
    reverse.data.config = {
      reverseAgentResult: {
        sessionId: 'reverse-session-edit',
        nonce: 'reverse-nonce-edit',
        knowledgeSnapshotVersion: 'knowledge-version-edit',
        analysis: 'Original analysis',
        keywords: ['original'],
        positivePrompt: 'Original prompt',
        negativeConstraints: ['Original constraint'],
        executionChecklist: ['Original check'],
      },
    };
    const project = parseCanvasProject({ ...createStarterProject(), nodes: [reverse], edges: [] });
    const commit = vi.fn(async (request: ProjectCommitRequest) => ({
      ok: true as const,
      project: request.nextProject,
      revision: request.baseRevision + 1,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    useAppStore.setState({ desktopRevision: 4, persistenceMode: 'desktop', project, projectLifecycle: 'durable', saveStatus: 'saved' });
    const update = (useAppStore.getState() as unknown as {
      updateReverseAgentResult?: (nodeId: string, result: Record<string, unknown>) => Promise<boolean>;
    }).updateReverseAgentResult;

    expect(typeof update).toBe('function');
    await expect(update!(reverse.id, {
      analysis: 'Edited analysis',
      keywords: ['edited'],
      positivePrompt: 'Edited prompt',
      negativeConstraints: ['Edited constraint'],
      executionChecklist: ['Edited check'],
    })).resolves.toBe(true);

    expect(commit).toHaveBeenCalledOnce();
    expect(useAppStore.getState().project.nodes.find((node) => node.id === reverse.id)).toMatchObject({
      data: { config: { reverseAgentResult: {
        sessionId: 'reverse-session-edit',
        nonce: 'reverse-nonce-edit',
        knowledgeSnapshotVersion: 'knowledge-version-edit',
        analysis: 'Edited analysis',
        positivePrompt: 'Edited prompt',
      } } },
    });
  });

  it('terminates a reverse Agent request that never returns and persists a visible timeout failure', async () => {
    vi.useFakeTimers();
    try {
      const reverse = createCanvasModuleNode('reverse-timeout-run', 'reverse_agent', { x: 360, y: 0 });
      reverse.data.config = {
        modelRoute: 'gemini-reverse', role: 'Analyst', task: 'Analyze the cited image.',
        knowledgeBaseIds: [], referenceAssetIds: ['cccccccccccccccc'],
      };
      const project = parseCanvasProject({
        ...createStarterProject(),
        assets: [{
          assetId: 'cccccccccccccccc', byteSize: 64, extension: 'png', height: 120,
          label: 'Timeout product', mediaType: 'image/png', origin: 'imported', sha256: 'c'.repeat(64), width: 160,
        }],
        nodes: [reverse],
        edges: [],
      });
      replaceProjectPersistenceClientForTests(createMockClient({
        analyzeReversePrompt: vi.fn(() => new Promise<ReversePromptResult>(() => undefined)),
      }));
      replaceKnowledgeClientForTests(createKnowledgeClient());
      useAppStore.setState({
        project,
        projectImages: [{
          assetId: 'cccccccccccccccc', byteSize: 64, displayUrl: 'novus-asset://project/session/cccccccccccccccc', extension: 'png', height: 120,
          label: 'Timeout product', mediaType: 'image/png', origin: 'imported', sha256: 'c'.repeat(64), usageCount: 0, width: 160,
        }],
      });

      let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
      void useAppStore.getState().runReverseAgentNode(reverse.id).then(
        () => { outcome = 'resolved'; },
        () => { outcome = 'rejected'; },
      );
      await vi.advanceTimersByTimeAsync(300_000);
      await Promise.resolve();

      expect(outcome).toBe('pending');

      await vi.advanceTimersByTimeAsync(15_000);
      await Promise.resolve();

      expect(outcome).toBe('rejected');
      expect(useAppStore.getState().project.nodes.find((node) => node.id === reverse.id)).toMatchObject({
        data: { config: {
          reverseAgentRunState: 'failed',
          reverseAgentCompletedAt: expect.any(String),
          reverseAgentError: expect.stringMatching(/timeout|timed out|超时/iu),
        } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a running reverse request locally and ignores its late provider result', async () => {
    const reverse = createCanvasModuleNode('reverse-local-cancel', 'reverse_agent', { x: 360, y: 0 });
    reverse.data.config = {
      modelRoute: 'gemini-reverse', role: 'Analyst', task: 'Analyze the cited image.',
      knowledgeBaseIds: [], referenceAssetIds: ['dddddddddddddddd'],
    };
    const project = parseCanvasProject({
      ...createStarterProject(),
      assets: [{
        assetId: 'dddddddddddddddd', byteSize: 64, extension: 'png', height: 120,
        label: 'Cancelable product', mediaType: 'image/png', origin: 'imported', sha256: 'd'.repeat(64), width: 160,
      }],
      nodes: [reverse],
      edges: [],
    });
    const providerResult = deferred<ReversePromptResult>();
    let startedRun: Parameters<NonNullable<ProjectPersistenceClient['analyzeReversePrompt']>>[0]['run'] | undefined;
    replaceProjectPersistenceClientForTests(createMockClient({
      analyzeReversePrompt: vi.fn((input) => {
        startedRun = input.run;
        return providerResult.promise;
      }),
    }));
    replaceKnowledgeClientForTests(createKnowledgeClient());
    useAppStore.setState({
      project,
      projectImages: [{
        assetId: 'dddddddddddddddd', byteSize: 64, displayUrl: 'novus-asset://project/session/dddddddddddddddd', extension: 'png', height: 120,
        label: 'Cancelable product', mediaType: 'image/png', origin: 'imported', sha256: 'd'.repeat(64), usageCount: 0, width: 160,
      }],
    });

    const running = useAppStore.getState().runReverseAgentNode(reverse.id);
    await waitForStore(() => useAppStore.getState().project.nodes.some((node) => (
      node.id === reverse.id && node.type === 'module' && node.data.config.reverseAgentRunState === 'running'
    )));
    await expect(useAppStore.getState().cancelReverseAgentNode(reverse.id)).resolves.toBe(true);
    expect(useAppStore.getState().project.nodes.find((node) => node.id === reverse.id)).toMatchObject({
      data: { config: { reverseAgentRunState: 'cancelled', reverseAgentError: null } },
    });

    providerResult.resolve({
      sessionId: startedRun!.sessionId,
      nonce: startedRun!.nonce,
      knowledgeSnapshotVersion: startedRun!.knowledgeLease.versionKey,
      analysis: 'Late analysis must be ignored.',
      keywords: ['late'],
      positivePrompt: 'Late reverse prompt must be ignored.',
      negativeConstraints: [],
      executionChecklist: [],
    });

    await expect(running).rejects.toMatchObject({ code: 'REVERSE_RUN_CANCELLED' });
    expect(useAppStore.getState().project.nodes.find((node) => node.id === reverse.id)).toMatchObject({
      data: { config: { reverseAgentRunState: 'cancelled' } },
    });
    expect(useAppStore.getState().project.nodes.find((node) => node.id === reverse.id)).not.toMatchObject({
      data: { config: { reverseAgentResult: { positivePrompt: 'Late reverse prompt must be ignored.' } } },
    });
  });

  it('applies and runs a reverse Agent task as one durable store operation with terminal timing', async () => {
    const reverse = createCanvasModuleNode('reverse-configured-run', 'reverse_agent', { x: 360, y: 0 });
    const imageInput = createCanvasModuleNode('reverse-configured-image', 'image_input', { x: 0, y: 0 });
    imageInput.data.config = { assetId: 'aaaaaaaaaaaaaaaa' };
    const project = parseCanvasProject({
      ...createStarterProject(),
      assets: [{
        assetId: 'aaaaaaaaaaaaaaaa', byteSize: 42, extension: 'png', height: 100,
        label: 'Managed product', mediaType: 'image/png', origin: 'imported', sha256: 'a'.repeat(64), width: 100,
      }],
      nodes: [imageInput, reverse],
      edges: [{ id: 'reverse-configured-edge', source: imageInput.id, sourcePortId: 'image', target: reverse.id, targetPortId: 'references', order: 0 }],
    });
    const analyzeReversePrompt = vi.fn(async (input: NonNullable<ProjectPersistenceClient['analyzeReversePrompt']> extends (value: infer T) => Promise<unknown> ? T : never) => ({
      sessionId: input.run.sessionId,
      nonce: input.run.nonce,
      knowledgeSnapshotVersion: input.run.knowledgeLease.versionKey,
      analysis: 'Configured run analysis.',
      keywords: ['configured'],
      positivePrompt: 'Configured reverse prompt.',
      negativeConstraints: ['No identity changes'],
      executionChecklist: ['Review the result'],
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ analyzeReversePrompt }));
    replaceKnowledgeClientForTests(createKnowledgeClient());
    useAppStore.setState({
      project,
      projectImages: [{
        assetId: 'aaaaaaaaaaaaaaaa', byteSize: 42, displayUrl: 'novus-asset://project/session/aaaaaaaaaaaaaaaa', extension: 'png', height: 100,
        label: 'Managed product', mediaType: 'image/png', origin: 'imported', sha256: 'a'.repeat(64), usageCount: 1, width: 100,
      }],
    });

    const result = await useAppStore.getState().runReverseAgentNode(reverse.id, {
      modelRoute: 'gemini-reverse',
      role: 'Commercial visual analyst',
      task: 'Analyze the connected managed image.',
      knowledgeBaseIds: [],
    });

    expect(result.positivePrompt).toBe('Configured reverse prompt.');
    expect(analyzeReversePrompt).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().project.nodes.find((node) => node.id === reverse.id)).toMatchObject({
      data: { config: {
        modelRoute: 'gemini-reverse',
        reverseAgentRunState: 'completed',
        reverseAgentResult: { positivePrompt: 'Configured reverse prompt.' },
        reverseAgentStartedAt: expect.any(String),
        reverseAgentCompletedAt: expect.any(String),
        reverseAgentError: null,
      } },
    });
  });

  it('autosaves reverse Agent draft fields before the task is run', async () => {
    const reverse = createCanvasModuleNode('reverse-draft-autosave', 'reverse_agent', { x: 360, y: 0 });
    const project = parseCanvasProject({ ...createStarterProject(), nodes: [reverse], edges: [] });
    let durableProject = project;
    let revision = 8;
    const commit = vi.fn(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => {
      durableProject = request.nextProject;
      revision += 1;
      return { ok: true, project: durableProject, revision };
    });
    replaceProjectPersistenceClientForTests(createMockClient({
      commit,
      stablePoint: async () => ({ availableSnapshotIds: [], project: durableProject, revision }),
    }));
    useAppStore.setState({
      desktopRevision: revision,
      persistenceMode: 'desktop',
      project,
      projectLifecycle: 'durable',
      saveStatus: 'saved',
    });

    await expect(useAppStore.getState().draftReverseAgentConfig(reverse.id, {
      modelRoute: 'gemini-reverse',
      role: 'Commercial visual analyst',
      task: 'Analyze @image1 before the user presses Start.',
      knowledgeBaseIds: [],
      referenceAssetIds: ['aaaaaaaaaaaaaaaa'],
    })).resolves.toBe(true);
    expect(useAppStore.getState().saveStatus).toBe('pending');
    await expect(useAppStore.getState().flushProjectSave('blur')).resolves.toBe(true);

    expect(commit).toHaveBeenCalledOnce();
    expect(durableProject.nodes.find((node) => node.id === reverse.id)).toMatchObject({
      data: { config: {
        modelRoute: 'gemini-reverse',
        role: 'Commercial visual analyst',
        task: 'Analyze @image1 before the user presses Start.',
        knowledgeBaseIds: [],
        referenceAssetIds: ['aaaaaaaaaaaaaaaa'],
      } },
    });
  });

  it('autosaves image-generation draft text and controls before the task is run', async () => {
    const generation = createCanvasModuleNode('image-draft-autosave', 'image_generation', { x: 360, y: 0 });
    const project = parseCanvasProject({ ...createStarterProject(), nodes: [generation], edges: [] });
    let durableProject = project;
    let revision = 8;
    const commit = vi.fn(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => {
      durableProject = request.nextProject;
      revision += 1;
      return { ok: true, project: durableProject, revision };
    });
    replaceProjectPersistenceClientForTests(createMockClient({
      commit,
      stablePoint: async () => ({ availableSnapshotIds: [], project: durableProject, revision }),
    }));
    useAppStore.setState({ desktopRevision: revision, persistenceMode: 'desktop', project, projectLifecycle: 'durable', saveStatus: 'saved' });

    await expect(useAppStore.getState().draftGenerationNodeConfig(generation.id, {
      prompt: 'Durable image prompt', modelRoute: 'image-route', aspectRatio: '4:5', resolution: '2K', outputCount: 2,
    })).resolves.toBe(true);
    await expect(useAppStore.getState().flushProjectSave('blur')).resolves.toBe(true);

    expect(commit).toHaveBeenCalledOnce();
    expect(durableProject.nodes.find((node) => node.id === generation.id)).toMatchObject({
      data: { config: { prompt: 'Durable image prompt', modelRoute: 'image-route', aspectRatio: '4:5', resolution: '2K', outputCount: 2 } },
    });
  });

  it('serializes a newer reverse draft behind an in-flight autosave revision', async () => {
    vi.useFakeTimers();
    const reverse = createCanvasModuleNode('reverse-draft-race', 'reverse_agent', { x: 360, y: 0 });
    const project = parseCanvasProject({ ...createStarterProject(), nodes: [reverse], edges: [] });
    const firstAck = deferred<ProjectCommitResult>();
    let durableProject = project;
    let revision = 8;
    const commit = vi.fn(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => {
      if (commit.mock.calls.length === 1) {
        const result = await firstAck.promise;
        if (result.ok) {
          durableProject = result.project;
          revision = result.revision;
        }
        return result;
      }
      if (request.baseRevision !== revision) {
        return { code: 'REVISION_CONFLICT', ok: false, project: durableProject, revision };
      }
      durableProject = request.nextProject;
      revision += 1;
      return { ok: true, project: durableProject, revision };
    });
    replaceProjectPersistenceClientForTests(createMockClient({
      commit,
      stablePoint: async () => ({ availableSnapshotIds: [], project: durableProject, revision }),
    }));
    useAppStore.setState({ desktopRevision: revision, persistenceMode: 'desktop', project, projectLifecycle: 'durable', saveStatus: 'saved' });

    await useAppStore.getState().draftReverseAgentConfig(reverse.id, {
      modelRoute: 'gemini-reverse', role: 'First role', task: 'First task', knowledgeBaseIds: [], referenceAssetIds: [],
    });
    vi.advanceTimersByTime(750);
    await Promise.resolve();
    expect(commit).toHaveBeenCalledOnce();
    const firstRequest = commit.mock.calls[0]![0];

    const newerDraft = useAppStore.getState().draftReverseAgentConfig(reverse.id, {
      modelRoute: 'gemini-reverse', role: 'Latest role', task: 'Latest task', knowledgeBaseIds: ['scene-skill'], referenceAssetIds: ['aaaaaaaaaaaaaaaa'],
    });
    let newerDraftResolved = false;
    void newerDraft.then(() => { newerDraftResolved = true; });
    await Promise.resolve();
    expect(newerDraftResolved).toBe(true);
    expect(useAppStore.getState().project.nodes.find((node) => node.id === reverse.id)).toMatchObject({
      data: { config: { role: 'Latest role', task: 'Latest task' } },
    });
    firstAck.resolve({ ok: true, project: firstRequest.nextProject, revision: 9 });
    await expect(newerDraft).resolves.toBe(true);
    await expect(useAppStore.getState().flushProjectSave('blur')).resolves.toBe(true);

    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls[1]![0].baseRevision).toBe(9);
    expect(durableProject.nodes.find((node) => node.id === reverse.id)).toMatchObject({
      data: { config: { role: 'Latest role', task: 'Latest task', knowledgeBaseIds: ['scene-skill'], referenceAssetIds: ['aaaaaaaaaaaaaaaa'] } },
    });
    expect(useAppStore.getState().projectCommitConflictCode).toBeNull();
  });

  it('starts with the latest reverse draft while an earlier autosave is still in flight', async () => {
    vi.useFakeTimers();
    const reverse = createCanvasModuleNode('reverse-draft-start-race', 'reverse_agent', { x: 360, y: 0 });
    const asset = { assetId: 'aaaaaaaaaaaaaaaa', byteSize: 42, extension: 'png' as const, height: 100, label: 'Managed product', mediaType: 'image/png' as const, origin: 'imported' as const, sha256: 'a'.repeat(64), width: 100 };
    const project = parseCanvasProject({ ...createStarterProject(), assets: [asset], nodes: [reverse], edges: [] });
    const firstAck = deferred<ProjectCommitResult>();
    let durableProject = project;
    let revision = 12;
    const commit = vi.fn(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => {
      if (commit.mock.calls.length === 1) {
        const result = await firstAck.promise;
        if (result.ok) { durableProject = result.project; revision = result.revision; }
        return result;
      }
      if (request.baseRevision !== revision) return { code: 'REVISION_CONFLICT', ok: false, project: durableProject, revision };
      durableProject = request.nextProject;
      revision += 1;
      return { ok: true, project: durableProject, revision };
    });
    const analyzeReversePrompt = vi.fn(async (input: NonNullable<ProjectPersistenceClient['analyzeReversePrompt']> extends (value: infer T) => Promise<unknown> ? T : never) => ({
      sessionId: input.run.sessionId, nonce: input.run.nonce, knowledgeSnapshotVersion: input.run.knowledgeLease.versionKey,
      analysis: 'Latest draft analysis.', keywords: ['latest'], positivePrompt: 'Latest draft prompt.',
      negativeConstraints: ['No distortion'], executionChecklist: ['Verify identity'],
    }));
    replaceProjectPersistenceClientForTests(createMockClient({
      analyzeReversePrompt,
      commit,
      stablePoint: async () => ({ availableSnapshotIds: [], project: durableProject, revision }),
    }));
    replaceKnowledgeClientForTests(createKnowledgeClient());
    useAppStore.setState({
      desktopRevision: revision, persistenceMode: 'desktop', project, projectLifecycle: 'durable', saveStatus: 'saved',
      projectImages: [{ ...asset, displayUrl: 'novus-asset://project/session/aaaaaaaaaaaaaaaa', usageCount: 0 }],
    });
    const firstConfig = { modelRoute: 'gemini-reverse', role: 'First role', task: 'First task', knowledgeBaseIds: [], referenceAssetIds: [asset.assetId] };
    const latestConfig = { ...firstConfig, role: 'Latest role', task: 'Latest task' };

    await useAppStore.getState().draftReverseAgentConfig(reverse.id, firstConfig);
    vi.advanceTimersByTime(750);
    await Promise.resolve();
    const firstRequest = commit.mock.calls[0]![0];
    const newerDraft = useAppStore.getState().draftReverseAgentConfig(reverse.id, latestConfig);
    const running = useAppStore.getState().runReverseAgentNode(reverse.id, latestConfig);
    firstAck.resolve({ ok: true, project: firstRequest.nextProject, revision: 13 });

    await expect(newerDraft).resolves.toBe(true);
    await expect(running).resolves.toMatchObject({ positivePrompt: 'Latest draft prompt.' });
    expect(analyzeReversePrompt).toHaveBeenCalledOnce();
    expect(durableProject.nodes.find((node) => node.id === reverse.id)).toMatchObject({ data: { config: { role: 'Latest role', task: 'Latest task' } } });
    expect(useAppStore.getState().projectCommitConflictCode).toBeNull();
  });

  it('retries one prior save failure before starting an already-configured reverse task', async () => {
    const reverse = createCanvasModuleNode('reverse-run-after-save-retry', 'reverse_agent', { x: 360, y: 0 });
    reverse.data.config = {
      modelRoute: 'gemini-reverse', role: 'Analyst', task: 'Analyze the cited image.', knowledgeBaseIds: [], referenceAssetIds: ['aaaaaaaaaaaaaaaa'],
    };
    const project = parseCanvasProject({
      ...createStarterProject(),
      assets: [{ assetId: 'aaaaaaaaaaaaaaaa', byteSize: 42, extension: 'png', height: 100, label: 'Managed product', mediaType: 'image/png', origin: 'imported', sha256: 'a'.repeat(64), width: 100 }],
      nodes: [reverse], edges: [],
    });
    let revision = 4;
    const commit = vi.fn(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => {
      if (commit.mock.calls.length === 1) return { code: 'INVALID_REQUEST', ok: false, project: request.previousProject, revision };
      revision += 1;
      return { ok: true, project: request.nextProject, revision };
    });
    const analyzeReversePrompt = vi.fn(async (input: NonNullable<ProjectPersistenceClient['analyzeReversePrompt']> extends (value: infer T) => Promise<unknown> ? T : never) => ({
      sessionId: input.run.sessionId,
      nonce: input.run.nonce,
      knowledgeSnapshotVersion: input.run.knowledgeLease.versionKey,
      analysis: 'Recovered analysis.',
      keywords: ['recovered'],
      positivePrompt: 'Recovered reverse prompt.',
      negativeConstraints: ['No distortion'],
      executionChecklist: ['Verify product identity'],
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ analyzeReversePrompt, commit }));
    replaceKnowledgeClientForTests(createKnowledgeClient());
    useAppStore.setState({
      desktopRevision: revision,
      persistenceMode: 'desktop',
      project,
      projectLifecycle: 'durable',
      projectImages: [{ assetId: 'aaaaaaaaaaaaaaaa', byteSize: 42, displayUrl: 'novus-asset://project/session/aaaaaaaaaaaaaaaa', extension: 'png', height: 100, label: 'Managed product', mediaType: 'image/png', origin: 'imported', sha256: 'a'.repeat(64), usageCount: 0, width: 100 }],
      saveStatus: 'saved',
    });

    await expect(useAppStore.getState().commitNodePosition(reverse.id, { x: 400, y: 20 })).resolves.toBe(false);
    expect(useAppStore.getState().canRetryProjectCommit).toBe(true);

    await expect(useAppStore.getState().runReverseAgentNode(reverse.id)).resolves.toMatchObject({ positivePrompt: 'Recovered reverse prompt.' });
    expect(analyzeReversePrompt).toHaveBeenCalledOnce();
    expect(useAppStore.getState().canRetryProjectCommit).toBe(false);
  });

  it('refreshes one durable revision conflict and starts reverse analysis on the first click', async () => {
    const reverse = createCanvasModuleNode('reverse-run-after-conflict', 'reverse_agent', { x: 360, y: 0 });
    reverse.data.config = {
      modelRoute: 'gemini-reverse', role: 'Analyst', task: 'Analyze the cited image.', knowledgeBaseIds: [], referenceAssetIds: ['eeeeeeeeeeeeeeee'],
    };
    const asset = {
      assetId: 'eeeeeeeeeeeeeeee', byteSize: 42, extension: 'png' as const, height: 100, label: 'Managed product',
      mediaType: 'image/png' as const, origin: 'imported' as const, sha256: 'e'.repeat(64), width: 100,
    };
    const project = parseCanvasProject({ ...createStarterProject(), assets: [asset], nodes: [reverse], edges: [] });
    const summary = { ...asset, displayUrl: 'novus-asset://project/session/eeeeeeeeeeeeeeee', usageCount: 0 };
    const reloadDurableProject = vi.fn(async () => ({
      availableSnapshotIds: [], lifecycle: 'durable' as const, mode: 'desktop' as const, project, revision: 9, saveStatus: 'saved' as const,
    }));
    const analyzeReversePrompt = vi.fn(async (input: NonNullable<ProjectPersistenceClient['analyzeReversePrompt']> extends (value: infer T) => Promise<unknown> ? T : never) => ({
      sessionId: input.run.sessionId, nonce: input.run.nonce, knowledgeSnapshotVersion: input.run.knowledgeLease.versionKey,
      analysis: 'Recovered conflict analysis.', keywords: ['recovered'], positivePrompt: 'Recovered conflict prompt.',
      negativeConstraints: ['No distortion'], executionChecklist: ['Verify product identity'],
    }));
    replaceProjectPersistenceClientForTests(createMockClient({
      analyzeReversePrompt,
      listProjectImages: async () => [summary],
      reloadDurableProject,
    }));
    replaceKnowledgeClientForTests(createKnowledgeClient());
    useAppStore.setState({
      canReloadDurableProject: true,
      canRetryProjectCommit: false,
      desktopRevision: 8,
      persistenceMode: 'desktop',
      project,
      projectCommitConflictCode: 'REVISION_CONFLICT',
      projectImages: [summary],
      projectLifecycle: 'durable',
      saveErrorCode: 'REVISION_CONFLICT',
      saveStatus: 'error',
    });

    await expect(useAppStore.getState().runReverseAgentNode(reverse.id)).resolves.toMatchObject({ positivePrompt: 'Recovered conflict prompt.' });
    expect(reloadDurableProject).toHaveBeenCalledOnce();
    expect(analyzeReversePrompt).toHaveBeenCalledOnce();
    expect(useAppStore.getState().projectCommitConflictCode).toBeNull();
  });

  it('persists a display-safe reverse Agent failure instead of returning to a blank idle node', async () => {
    const reverse = createCanvasModuleNode('reverse-failed-run', 'reverse_agent', { x: 360, y: 0 });
    reverse.data.config = {
      modelRoute: 'gemini-reverse', role: 'Analyst', task: 'Analyze the cited image.',
      knowledgeBaseIds: [], referenceAssetIds: ['bbbbbbbbbbbbbbbb'],
    };
    const project = parseCanvasProject({
      ...createStarterProject(),
      assets: [{
        assetId: 'bbbbbbbbbbbbbbbb', byteSize: 64, extension: 'png', height: 120,
        label: 'Cited product', mediaType: 'image/png', origin: 'imported', sha256: 'b'.repeat(64), width: 160,
      }],
      nodes: [reverse],
      edges: [],
    });
    replaceProjectPersistenceClientForTests(createMockClient({
      analyzeReversePrompt: vi.fn(async () => {
        throw Object.assign(new Error('Provider timeout at C:\\private\\request.json Authorization: Bearer secret'), { code: 'PROVIDER_TIMEOUT' });
      }),
    }));
    replaceKnowledgeClientForTests(createKnowledgeClient());
    useAppStore.setState({
      project,
      projectImages: [{
        assetId: 'bbbbbbbbbbbbbbbb', byteSize: 64, displayUrl: 'novus-asset://project/session/bbbbbbbbbbbbbbbb', extension: 'png', height: 120,
        label: 'Cited product', mediaType: 'image/png', origin: 'imported', sha256: 'b'.repeat(64), usageCount: 0, width: 160,
      }],
    });

    await expect(useAppStore.getState().runReverseAgentNode(reverse.id)).rejects.toThrow();

    const failed = useAppStore.getState().project.nodes.find((node) => node.id === reverse.id);
    expect(failed).toMatchObject({ data: { config: {
      reverseAgentRunState: 'failed',
      reverseAgentCompletedAt: expect.any(String),
      reverseAgentError: expect.stringContaining('Provider timeout'),
    } } });
    expect(JSON.stringify(failed)).not.toMatch(/Authorization|Bearer|secret|C:\\private/iu);
  });

  it('sends a reverse Agent cited managed image to analysis without requiring a graph edge', async () => {
    const reverse = createCanvasModuleNode('reverse-cited-run', 'reverse_agent', { x: 360, y: 0 });
    reverse.data.config = {
      modelRoute: 'gemini-reverse',
      role: 'Commercial visual analyst',
      task: 'Analyze @1.',
      knowledgeBaseIds: [],
      referenceAssetIds: ['bbbbbbbbbbbbbbbb'],
    };
    const project = parseCanvasProject({
      ...createStarterProject(),
      assets: [{
        assetId: 'bbbbbbbbbbbbbbbb', byteSize: 64, extension: 'png', height: 120,
        label: 'Cited product', mediaType: 'image/png', origin: 'imported', sha256: 'b'.repeat(64), width: 160,
      }],
      nodes: [reverse],
      edges: [],
    });
    const analyzeReversePrompt = vi.fn(async (input: NonNullable<ProjectPersistenceClient['analyzeReversePrompt']> extends (value: infer T) => Promise<unknown> ? T : never) => ({
      sessionId: input.run.sessionId,
      nonce: input.run.nonce,
      knowledgeSnapshotVersion: input.run.knowledgeLease.versionKey,
      analysis: 'A cited product reference.',
      keywords: ['product'],
      positivePrompt: 'Cited product hero shot.',
      negativeConstraints: ['No distortion'],
      executionChecklist: ['Preserve product identity'],
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ analyzeReversePrompt }));
    replaceKnowledgeClientForTests(createKnowledgeClient());
    useAppStore.setState({
      project,
      projectImages: [{
        assetId: 'bbbbbbbbbbbbbbbb', byteSize: 64, displayUrl: 'novus-asset://project/session/bbbbbbbbbbbbbbbb', extension: 'png', height: 120,
        label: 'Cited product', mediaType: 'image/png', origin: 'imported', sha256: 'b'.repeat(64), usageCount: 0, width: 160,
      }],
    });

    await useAppStore.getState().runReverseAgentNode(reverse.id);

    expect(analyzeReversePrompt).toHaveBeenCalledWith(expect.objectContaining({
      media: [{ kind: 'image', assetId: 'bbbbbbbbbbbbbbbb', byteSize: 64, mediaType: 'image/png', sha256: 'b'.repeat(64) }],
      run: expect.objectContaining({
        references: [{ assetId: 'bbbbbbbbbbbbbbbb', label: 'Cited product', position: 0, role: 'scene_composition' }],
        orderedMedia: [expect.objectContaining({ kind: 'image', assetId: 'bbbbbbbbbbbbbbbb', order: 0 })],
      }),
    }));
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

function moduleGraphProjectWithPlacementReferences(): CanvasProject {
  const project = moduleGraphProject();
  const placement = project.nodes.find((node) => node.type === 'placement_preview');
  if (!placement || placement.type !== 'placement_preview') throw new Error('Missing placement preview');
  const template = placement.data.objects[0]!;
  return parseCanvasProject({
    ...project,
    nodes: project.nodes.map((node) => node.id === placement.id
      ? {
          ...placement,
          data: {
            ...placement.data,
            objects: [
              { ...template, id: 'product', assetId: 'product', name: 'Product' },
              { ...template, id: 'scene', assetId: 'scene', name: 'Scene', role: 'scene_composition' as const },
            ],
          },
        }
      : node),
  });
}

function readPlacementAssetIds(project: CanvasProject): string[] {
  const placement = project.nodes.find((node) => node.type === 'placement_preview');
  return placement?.type === 'placement_preview'
    ? placement.data.objects.map((object) => object.assetId)
    : [];
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

function installProviderProfilesForModelJobTests(profiles: ProviderBridgeProfile[] = [{
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

function installVideoProviderForModelJobTests(): void {
  replaceModelJobExecutorForTests({
    submit: vi.fn(async (job: ModelJob) => ({ providerTaskId: `provider-${job.id}` })),
    poll: vi.fn(async () => ({ status: 'running' as const, progress: 0.2 })),
    cancel: vi.fn(async () => {}),
  });
  installProviderProfilesForModelJobTests([{
    provider: 'relayme',
    modelRoute: 'relayme-video-pro',
    displayName: 'Relay Video Pro',
    modelId: 'video-pro',
    capabilities: ['video_generation', 'async_tasks'],
  }]);
  resetAppStoreForTests();
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

type ReloadableTestProjectPersistenceClient = ProjectPersistenceClient & {
  reloadDurableProject?: () => Promise<ProjectHydrationResult | null>;
};

function createMockClient(overrides: Partial<ReloadableTestProjectPersistenceClient>): ReloadableTestProjectPersistenceClient {
  const hydrate = overrides.hydrate ?? (async () => ({
    availableSnapshotIds: [],
    lifecycle: 'durable' as const,
    mode: 'desktop',
    project: createStarterProject(),
    revision: 0,
    saveStatus: 'pending',
  }));
  return {
    analyzeReversePrompt: overrides.analyzeReversePrompt,
    close: overrides.close ?? (async () => {}),
    copyHistoryToProject: overrides.copyHistoryToProject,
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
    reloadDurableProject: overrides.reloadDurableProject,
    importProjectImage: overrides.importProjectImage ?? (async () => null),
    listProjectImages: overrides.listProjectImages ?? (async () => []),
    listProjectVideos: overrides.listProjectVideos ?? (async () => []),
    pasteClipboardImage: overrides.pasteClipboardImage ?? (async () => null),
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
  it('advances the project revision atomically for an Agent reference before the next stable operation', async () => {
    const importedAsset = {
      assetId: 'a'.repeat(16), byteSize: 16, displayUrl: 'novus-asset://imported', extension: 'png' as const,
      height: 10, label: 'reference.png', mediaType: 'image/png' as const, origin: 'imported' as const,
      sha256: 'a'.repeat(64), usageCount: 0, width: 10,
    };
    const { displayUrl: _displayUrl, usageCount: _usageCount, ...projectAsset } = importedAsset;
    const resultProject = { ...createStarterProject(), assets: [projectAsset] };
    const importProjectImage = vi.fn(async () => ({ asset: importedAsset, project: resultProject, revision: 3 }));
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 4,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ commit, importProjectImage }));
    resetAppStoreForTests();

    await expect(useAppStore.getState().importAgentReferenceImage()).resolves.toEqual(importedAsset);

    expect(useAppStore.getState()).toMatchObject({ desktopRevision: 3, project: resultProject, projectImages: [importedAsset] });
    await expect(useAppStore.getState().addModuleNode('text_prompt', { x: 24, y: 48 })).resolves.toBe(true);
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
      baseRevision: 3,
      previousProject: expect.objectContaining({ assets: [projectAsset] }),
      nextProject: expect.objectContaining({ assets: [projectAsset] }),
    }));
    expect(useAppStore.getState().project.assets).toEqual([projectAsset]);
    expect(useAppStore.getState().desktopRevision).toBe(4);
  });

  it('keeps project and revision unchanged when an Agent reference import is cancelled', async () => {
    const project = createStarterProject();
    replaceProjectPersistenceClientForTests(createMockClient({ importProjectImage: async () => null }));
    resetAppStoreForTests();
    useAppStore.setState({ desktopRevision: 7, project, projectImages: [], saveStatus: 'saved' });

    await expect(useAppStore.getState().importAgentReferenceImage()).resolves.toBeNull();

    expect(useAppStore.getState()).toMatchObject({
      desktopRevision: 7,
      project,
      projectImageError: null,
      projectImageImportingNodeId: null,
      projectImages: [],
      saveStatus: 'saved',
    });
  });

  it('does not partially apply project state when an Agent reference import fails', async () => {
    const project = createStarterProject();
    replaceProjectPersistenceClientForTests(createMockClient({
      importProjectImage: async () => Promise.reject({ code: 'DURABLE_WRITE_FAILED' }),
    }));
    resetAppStoreForTests();
    useAppStore.setState({ desktopRevision: 7, project, projectImages: [], saveStatus: 'saved' });

    await expect(useAppStore.getState().importAgentReferenceImage()).resolves.toBeNull();

    expect(useAppStore.getState()).toMatchObject({
      desktopRevision: 7,
      project,
      projectImageError: 'DURABLE_WRITE_FAILED',
      projectImageImportingNodeId: null,
      projectImages: [],
      saveErrorCode: 'DURABLE_WRITE_FAILED',
      saveStatus: 'error',
    });
  });

describe('explicit project save', () => {
  it('creates a durable project even when an empty untitled canvas has no pending autosave draft', async () => {
    const project = { ...createStarterProject(), nodes: [], edges: [] };
    const stablePoint = vi.fn(async () => ({
      availableSnapshotIds: ['manual-save-1'],
      lifecycle: 'durable' as const,
      project,
      revision: 1,
    }));
    replaceProjectPersistenceClientForTests(createMockClient({ stablePoint }));
    resetAppStoreForTests({ project: 'empty' });
    useAppStore.setState({ project, projectLifecycle: 'untitled', saveStatus: 'saved' });

    await expect(useAppStore.getState().saveProjectExplicitly()).resolves.toBe(true);

    expect(stablePoint).toHaveBeenCalledOnce();
    expect(useAppStore.getState()).toMatchObject({
      availableSnapshotIds: ['manual-save-1'],
      desktopRevision: 1,
      projectLifecycle: 'durable',
      saveStatus: 'saved',
    });
  });

  it('does not leave an explicit save stuck in saving when the stable point never settles', async () => {
    vi.useFakeTimers();
    const project = { ...createStarterProject(), nodes: [], edges: [] };
    const stablePoint = vi.fn(() => new Promise<never>(() => {}));
    replaceProjectPersistenceClientForTests(createMockClient({ stablePoint }));
    resetAppStoreForTests({ project: 'empty' });
    useAppStore.setState({ project, projectLifecycle: 'untitled', saveStatus: 'pending' });

    const saving = useAppStore.getState().saveProjectExplicitly();
    expect(useAppStore.getState().saveStatus).toBe('saving');

    await vi.advanceTimersByTimeAsync(15_001);

    await expect(saving).resolves.toBe(false);
    expect(useAppStore.getState()).toMatchObject({
      saveErrorCode: 'SAVE_TIMEOUT',
      saveStatus: 'error',
    });
  });

  it('does not leave an idle autosave stuck in saving when commit never settles', async () => {
    vi.useFakeTimers();
    const project = { ...createStarterProject(), nodes: [], edges: [] };
    const commit = vi.fn(() => new Promise<never>(() => {}));
    replaceProjectPersistenceClientForTests(createMockClient({ commit }));
    resetAppStoreForTests({ project: 'empty' });
    useAppStore.setState({ project, projectLifecycle: 'durable', saveStatus: 'saved' });

    useAppStore.getState().setProject({ ...project, name: '自动保存超时测试' });
    await vi.advanceTimersByTimeAsync(750);
    expect(commit).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(15_001);

    expect(useAppStore.getState()).toMatchObject({
      saveErrorCode: 'SAVE_TIMEOUT',
      saveStatus: 'error',
    });
  });
});
