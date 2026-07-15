import { create } from 'zustand';
import {
  appendProjectMemoryEntry,
  applyProjectTransaction,
  createSkillPromotionCandidate,
  createUserFeedbackMemory,
  confirmAgentPlan as confirmDomainPlan,
  revertTransaction,
  selectActiveProjectMemoryEntries,
  type AgentCanvasPlan,
  type AgentKnowledgeLease,
  type AgentPlanApprovalSelection,
  type CanvasOperation,
  type CanvasProject,
  type CanvasTransaction,
  type FeedbackObservations,
  type ImageCitation,
  type OrderedReference,
  type ProjectOperation,
  type ProjectMemoryEntry,
  type ProjectTransaction,
  type SkillPromotionCandidate,
} from '@agent-canvas/domain';
import {
  createProjectPersistenceClient,
  type ProjectCommitRequest,
  type ProjectCommitResult,
  type ProjectPersistenceClient,
  type ProjectSaveStatus,
} from './desktop-persistence';
import {
  createKnowledgeClient,
  type KnowledgeBaseStateSummary,
  type KnowledgeClient,
} from './knowledge-client';
import { loadPersistedProjectBundle } from './project-persistence';

let planSequence = 0;
let pendingSave: ReturnType<typeof setTimeout> | undefined;
let projectPersistenceClient = createProjectPersistenceClient();
let knowledgeClient = createKnowledgeClient();

interface UndoEntry {
  transaction: CanvasTransaction;
  memoryId: string;
}

interface SetProjectOptions {
  schedulePersist?: boolean;
}

interface CommitProjectTransactionOptions {
  kind?: ProjectCommitRequest['kind'];
  nextProject?: CanvasProject;
}

interface RecordUserFeedbackInput {
  title: string;
  userRequest: string;
  correction: string;
  knowledgeLease: AgentKnowledgeLease;
  references: OrderedReference[];
  citations: ImageCitation[];
  observations?: FeedbackObservations;
  feedback: {
    keep: string[];
    change: string[];
    never: string[];
    score?: number;
  };
}
interface AppState {
  project: CanvasProject;
  persistenceMode: 'browser' | 'desktop';
  desktopRevision: number;
  availableSnapshotIds: string[];
  knowledgeBases: KnowledgeBaseStateSummary[];
  saveStatus: ProjectSaveStatus;
  saveErrorCode: string | null;
  agentPanelCollapsed: boolean;
  activeTool: 'select' | 'hand' | 'upload' | 'image' | 'prompt' | 'placement';
  agentPlan: AgentCanvasPlan | null;
  undoStack: UndoEntry[];
  confirmedModelJobs: number;
  closePersistence: () => Promise<void>;
  commitProjectTransaction: (transaction: ProjectTransaction, options?: CommitProjectTransactionOptions) => Promise<boolean>;
  commitReferenceOrder: (assetIds: string[]) => Promise<boolean>;
  configureKnowledgeBase: (knowledgeBaseId: string, displayName: string) => Promise<void>;
  getKnowledgeLease: KnowledgeClient['getLease'];
  hydratePersistence: () => Promise<void>;
  initializeKnowledge: () => Promise<void>;
  reviewSkillCandidate: KnowledgeClient['review'];
  setActiveTool: (tool: AppState['activeTool']) => void;
  toggleAgentPanel: () => void;
  setProject: (project: CanvasProject, options?: SetProjectOptions) => void;
  draftAgentPlan: (message: string) => void;
  confirmAgentPlan: (approvals: AgentPlanApprovalSelection) => Promise<void>;
  cancelAgentPlan: () => void;
  undo: () => Promise<void>;
  promoteProjectMemory: (memoryId: string) => Promise<void>;
  recordUserFeedback: (input: RecordUserFeedbackInput) => Promise<boolean>;
  restoreProjectSnapshot: (snapshotId: string) => Promise<void>;
}

export function createStarterProject(): CanvasProject {
  return {
    version: 1,
    id: 'local-project',
    name: '未命名画布',
    nodes: [
      { id: 'reference-start', type: 'reference', position: { x: 120, y: 160 }, data: { assetId: 'starter-product', role: 'product_identity' } },
      { id: 'placement-start', type: 'placement_preview', position: { x: 460, y: 270 }, data: {
        board: { id: 'starter-board', aspectRatio: '4:5', width: 1080, height: 1350, safeAreas: [{ id: 'copy-top', x: 0.08, y: 0.06, w: 0.84, h: 0.16, purpose: 'copy_safe' }] },
        objects: [{ id: 'product-main', assetId: 'starter-product', role: 'product_identity', x: 0.34, y: 0.42, w: 0.32, h: 0.38, rotation: 0, zIndex: 20, locked: false, visible: true, flipX: false, flipY: false, semanticLayer: 'hero_product', name: '主产品' }],
      } },
      { id: 'prompt-start', type: 'prompt', position: { x: 800, y: 160 }, data: { prompt: '等待确认后执行模型任务', requirementIds: [] } },
    ],
    projectMemory: [],
    skillPromotionCandidates: [],
    edges: [
      { id: 'edge-reference-placement', source: 'reference-start', target: 'placement-start' },
      { id: 'edge-placement-prompt', source: 'placement-start', target: 'prompt-start', label: 'agent-plan' },
    ],
  };
}

const initialState = createInitialState();

export const useAppStore = create<AppState>((set, get) => ({
  ...initialState,
  closePersistence: async () => {
    cancelPendingProjectSave();
    knowledgeClient.stop();
    await projectPersistenceClient.close();
  },
  commitProjectTransaction: async (transaction, options = {}) => {
    cancelPendingProjectSave();
    const before = get().project;
    const nextProject = options.nextProject ?? applyProjectTransaction(before, transaction);
    const kind = options.kind ?? 'canvas';
    if (get().saveStatus === 'read_only') {
      set({ project: before, saveErrorCode: 'CONCURRENT_WRITER', saveStatus: 'read_only' });
      return false;
    }

    set({ project: nextProject, saveErrorCode: null, saveStatus: 'saving' });
    const result = await projectPersistenceClient.commit({
      baseRevision: get().desktopRevision,
      kind,
      nextProject,
      previousProject: before,
      projectId: before.id,
      transaction,
    });

    if (!result.ok && result.code === 'REVISION_CONFLICT') {
      const hydrated = await projectPersistenceClient.hydrate();
      set({
        availableSnapshotIds: hydrated.availableSnapshotIds,
        desktopRevision: hydrated.revision,
        persistenceMode: hydrated.mode,
        project: hydrated.project,
        saveErrorCode: result.code,
        saveStatus: 'error',
      });
      return false;
    }

    return applyCommitResult(set, get, result);
  },
  commitReferenceOrder: async (assetIds) => {
    const state = get();
    const placementNode = state.project.nodes.find((node) => node.type === 'placement_preview');
    if (!placementNode || placementNode.type !== 'placement_preview') return false;

    const byAssetId = new Map(placementNode.data.objects.map((object) => [object.assetId, object]));
    const orderedObjects = [...new Set(assetIds)]
      .filter((assetId) => !assetId.startsWith('starter-'))
      .map((assetId) => byAssetId.get(assetId))
      .filter((object): object is NonNullable<typeof object> => object !== undefined);
    if (orderedObjects.length === 0) return false;

    const targetAssetIds = new Set(orderedObjects.map((object) => object.assetId));
    const queue = [...orderedObjects];
    const objects = placementNode.data.objects.map((object) => (
      targetAssetIds.has(object.assetId) ? queue.shift() ?? object : object
    ));
    const nextNode = { ...placementNode, data: { ...placementNode.data, objects } };
    const nextProject = {
      ...state.project,
      nodes: state.project.nodes.map((node) => node.id === nextNode.id ? nextNode : node),
    };
    const suffix = `${Date.now()}-${planSequence++}`;
    const transaction: ProjectTransaction = {
      id: `reference-order-${suffix}`,
      label: 'Reorder Agent references',
      operations: [{ kind: 'canvas', operation: { kind: 'update_node', node: nextNode } }],
    };
    return get().commitProjectTransaction(transaction, { kind: 'canvas', nextProject });
  },
  configureKnowledgeBase: async (knowledgeBaseId, displayName) => {
    await knowledgeClient.configure(knowledgeBaseId, displayName);
  },
  getKnowledgeLease: (runId, capability, references, citations) => (
    knowledgeClient.getLease(runId, capability, references, citations)
  ),
  hydratePersistence: async () => {
    cancelPendingProjectSave();
    const hydrated = await projectPersistenceClient.hydrate();
    set({
      availableSnapshotIds: hydrated.availableSnapshotIds,
      desktopRevision: hydrated.revision,
      persistenceMode: hydrated.mode,
      project: hydrated.project,
      saveErrorCode: null,
      saveStatus: hydrated.saveStatus,
    });
  },
  initializeKnowledge: async () => {
    await knowledgeClient.start((knowledgeBases) => set({ knowledgeBases }));
  },
  reviewSkillCandidate: async (request) => {
    const result = await knowledgeClient.review(request);
    set((state) => ({
      desktopRevision: result.currentRevision,
      knowledgeBases: result.knowledgeState
        ? upsertKnowledgeSummary(state.knowledgeBases, result.knowledgeState)
        : state.knowledgeBases,
      project: {
        ...state.project,
        skillPromotionCandidates: state.project.skillPromotionCandidates.map((candidate) => (
          candidate.id === result.candidate.id ? result.candidate : candidate
        )),
      },
    }));
    return result;
  },
  setActiveTool: (activeTool) => set({ activeTool }),
  toggleAgentPanel: () => set((state) => ({ agentPanelCollapsed: !state.agentPanelCollapsed })),
  setProject: (project, options = {}) => {
    set((state) => ({
      project,
      saveErrorCode: null,
      saveStatus: state.saveStatus === 'read_only' ? 'read_only' : 'pending',
    }));
    if (options.schedulePersist !== false) {
      scheduleProjectSave(get);
    }
  },
  draftAgentPlan: (message) => set((state) => {
    const promptNode = state.project.nodes.find((node) => node.type === 'prompt');
    if (!promptNode || promptNode.type !== 'prompt' || message.trim().length === 0 || containsProtectedRendererPayload(message)) return state;
    const suffix = `${Date.now()}-${planSequence++}`;
    const reviewId = `agent-review-${suffix}`;
    return { agentPlan: {
      id: `agent-plan-${suffix}`,
      state: 'waiting_for_confirmation',
      transaction: {
        id: `agent-tx-${suffix}`,
        label: 'Agent 创建画布方案',
        operations: [
          { kind: 'update_node', node: { ...promptNode, data: { ...promptNode.data, prompt: message.trim() } } },
          { kind: 'create_node', node: { id: reviewId, type: 'review', position: { x: promptNode.position.x + 320, y: promptNode.position.y + 80 }, data: { keep: ['产品身份与 Logo'], change: ['场景、光线与道具'], never: ['未经确认执行模型'] } } },
          { kind: 'create_edge', edge: { id: `agent-edge-${suffix}`, source: promptNode.id, target: reviewId } },
        ],
      },
      requestedCapabilities: ['model_execution'],
      confirmations: {},
      conflicts: [],
      modelRoute: 'Comfly 图像生成',
      jobCount: 1,
    } };
  }),
  confirmAgentPlan: async (approvals) => {
    const state = get();
    if (!state.agentPlan) return;

    const now = new Date().toISOString();
    const result = confirmDomainPlan(state.project, {
      ...state.agentPlan,
      confirmations: {
        ...state.agentPlan.confirmations,
        canvas: now,
        models: approvals.models ? now : undefined,
        deleteNodes: approvals.deleteNodes ? now : undefined,
        skillWriteback: approvals.skillWriteback ? now : undefined,
      },
    });
    const memoryEntry = createOptimizationMemory(state.project, result.project, state.agentPlan, now);
    const project = {
      ...result.project,
      projectMemory: appendProjectMemoryEntry(result.project.projectMemory, memoryEntry),
    };
    const transaction = buildProjectTransaction({
      canvasTransaction: state.agentPlan.transaction,
      label: state.agentPlan.transaction.label,
      memoryEntry,
      transactionId: state.agentPlan.transaction.id,
    });
    const saved = await get().commitProjectTransaction(transaction, { kind: 'agent', nextProject: project });
    if (!saved) return;

    set((current) => ({
      agentPlan: result.plan,
      confirmedModelJobs: current.confirmedModelJobs + (result.executeModels ? state.agentPlan!.jobCount : 0),
      undoStack: [...current.undoStack, { transaction: result.inverse, memoryId: memoryEntry.id }],
    }));
  },
  cancelAgentPlan: () => set({ agentPlan: null }),
  promoteProjectMemory: async (memoryId) => {
    const state = get();
    if (state.project.skillPromotionCandidates.some((candidate) => candidate.sourceProjectMemoryId === memoryId)) return;
    const memory = state.project.projectMemory.find((entry) => entry.id === memoryId);
    if (!memory || !isPromotableMemory(state.project.projectMemory, memory)) return;

    const candidate = createSkillPromotionCandidate(memory, {
      candidateId: `skill-candidate-${Date.now()}-${planSequence++}`,
      createdAt: new Date().toISOString(),
    });
    const candidates = [...state.project.skillPromotionCandidates, candidate];
    const project = { ...state.project, skillPromotionCandidates: candidates };
    const transaction: ProjectTransaction = {
      id: `skill-promotion-${candidate.id}`,
      label: 'Promote project memory candidate',
      operations: [{ kind: 'set_skill_candidates', candidates }],
    };
    await get().commitProjectTransaction(transaction, { kind: 'system', nextProject: project });
  },
  recordUserFeedback: async (input) => {
    if (containsProtectedRendererPayload(input)) return false;
    const state = get();
    const previousRevision = state.project.projectMemory[state.project.projectMemory.length - 1]?.projectRevision ?? 0;
    const suffix = `${Date.now()}-${planSequence++}`;
    const memoryEntry = createUserFeedbackMemory({
      projectId: state.project.id,
      projectRevision: previousRevision + 1,
      title: input.title,
      userRequest: input.userRequest,
      correction: input.correction,
      knowledgeLease: input.knowledgeLease,
      references: input.references,
      citations: input.citations,
      observations: input.observations,
      feedback: input.feedback,
    }, {
      memoryId: `project-memory-feedback-${suffix}`,
      createdAt: new Date().toISOString(),
      snapshots: {
        beforeId: `feedback-${suffix}:before`,
        afterId: `feedback-${suffix}:after`,
      },
    });
    const candidate = createSkillPromotionCandidate(memoryEntry, {
      candidateId: `skill-candidate-feedback-${suffix}`,
      createdAt: memoryEntry.createdAt,
    });
    const projectMemory = appendProjectMemoryEntry(state.project.projectMemory, memoryEntry);
    const skillPromotionCandidates = [...state.project.skillPromotionCandidates, candidate];
    const project = { ...state.project, projectMemory, skillPromotionCandidates };
    const transaction: ProjectTransaction = {
      id: `user-feedback-${suffix}`,
      label: 'Record user feedback',
      operations: [
        { kind: 'append_project_memory', entry: memoryEntry },
        { kind: 'set_skill_candidates', candidates: skillPromotionCandidates },
      ],
    };
    return get().commitProjectTransaction(transaction, { kind: 'agent', nextProject: project });
  },
  restoreProjectSnapshot: async (snapshotId) => {
    const state = get();
    if (state.persistenceMode === 'desktop') {
      cancelPendingProjectSave();
      const restored = await projectPersistenceClient.restore(snapshotId);
      set({
        availableSnapshotIds: restored.availableSnapshotIds,
        desktopRevision: restored.revision,
        project: restored.project,
        saveErrorCode: null,
        saveStatus: restored.saveStatus,
      });
      return;
    }

    const bundle = loadPersistedProjectBundle();
    const snapshot = bundle?.snapshots.find((entry) => entry.id === snapshotId);
    if (!snapshot || snapshot.project.id !== state.project.id) return;

    const currentProject = sanitizeProjectSkillPromotionCandidates(state.project);
    const snapshotMemoryIds = new Set(snapshot.project.projectMemory.map((memory) => memory.id));
    const supersedesMemoryIds = currentProject.projectMemory
      .filter((memory) => !snapshotMemoryIds.has(memory.id))
      .map((memory) => memory.id);
    const restored = {
      ...snapshot.project,
      projectMemory: currentProject.projectMemory,
      skillPromotionCandidates: currentProject.skillPromotionCandidates,
    };
    const memoryEntry = createSnapshotRestoreMemory(restored, snapshotId, supersedesMemoryIds, new Date().toISOString());
    const projectMemory = appendProjectMemoryEntry(restored.projectMemory, memoryEntry);
    const project = {
      ...restored,
      projectMemory,
      skillPromotionCandidates: filterValidSkillPromotionCandidates(
        restored.id,
        projectMemory,
        restored.skillPromotionCandidates,
      ),
    };
    const transaction: ProjectTransaction = {
      id: `restore-${snapshotId}`,
      label: 'Restore project snapshot',
      operations: [
        { kind: 'replace_canvas_state', nodes: project.nodes, edges: project.edges },
        { kind: 'append_project_memory', entry: memoryEntry },
        { kind: 'set_skill_candidates', candidates: project.skillPromotionCandidates },
      ],
    };
    const saved = await get().commitProjectTransaction(transaction, { kind: 'system', nextProject: project });
    if (!saved) return;
    set({ agentPlan: null, undoStack: [] });
  },
  undo: async () => {
    const state = get();
    const undoEntry = state.undoStack[state.undoStack.length - 1];
    if (!undoEntry) return;

    const currentProject = sanitizeProjectSkillPromotionCandidates(state.project);
    const reverted = revertTransaction(currentProject, undoEntry.transaction);
    const now = new Date().toISOString();
    const memoryEntry = createUndoMemory(reverted, undoEntry.memoryId, undoEntry.transaction.id, now);
    const projectMemory = appendProjectMemoryEntry(reverted.projectMemory, memoryEntry);
    const project = {
      ...reverted,
      projectMemory,
      skillPromotionCandidates: filterValidSkillPromotionCandidates(
        reverted.id,
        projectMemory,
        reverted.skillPromotionCandidates,
      ),
    };
    const transaction = buildProjectTransaction({
      canvasTransaction: undoEntry.transaction,
      candidates: project.skillPromotionCandidates,
      label: undoEntry.transaction.label,
      memoryEntry,
      transactionId: undoEntry.transaction.id,
    });
    const saved = await get().commitProjectTransaction(transaction, { kind: 'system', nextProject: project });
    if (!saved) return;
    set((current) => ({
      agentPlan: null,
      undoStack: current.undoStack.slice(0, -1),
    }));
  },
}));

export function replaceProjectPersistenceClientForTests(client: ProjectPersistenceClient): void {
  projectPersistenceClient = client;
}

export function replaceKnowledgeClientForTests(client: KnowledgeClient): void {
  knowledgeClient.stop();
  knowledgeClient = client;
}

export function resetAppStoreForTests(): void {
  cancelPendingProjectSave();
  knowledgeClient.stop();
  useAppStore.setState(createInitialState());
}

function applyCommitResult(
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
  result: ProjectCommitResult,
): boolean {
  const availableSnapshotIds = get().persistenceMode === 'browser'
    ? readAvailableSnapshotIds()
    : get().availableSnapshotIds;
  if (result.ok) {
    set({
      availableSnapshotIds,
      desktopRevision: result.revision,
      project: result.project,
      saveErrorCode: null,
      saveStatus: 'saved',
    });
    return true;
  }

  set({
    availableSnapshotIds,
    desktopRevision: result.revision,
    project: result.project,
    saveErrorCode: result.code,
    saveStatus: result.code === 'CONCURRENT_WRITER' ? 'read_only' : 'error',
  });
  return false;
}

function buildProjectTransaction(options: {
  canvasTransaction?: CanvasTransaction;
  candidates?: SkillPromotionCandidate[];
  label: string;
  memoryEntry?: ProjectMemoryEntry;
  transactionId: string;
}): ProjectTransaction {
  const operations: ProjectOperation[] = [];
  if (options.canvasTransaction) {
    operations.push(...options.canvasTransaction.operations.map((operation) => ({ kind: 'canvas' as const, operation })));
  }
  if (options.memoryEntry) {
    operations.push({ kind: 'append_project_memory', entry: options.memoryEntry });
  }
  if (options.candidates) {
    operations.push({ kind: 'set_skill_candidates', candidates: options.candidates });
  }
  return {
    id: options.transactionId,
    label: options.label,
    operations,
  };
}

function cancelPendingProjectSave(): void {
  if (!pendingSave) return;
  clearTimeout(pendingSave);
  pendingSave = undefined;
}

function createIdleSyncTransaction(project: CanvasProject): ProjectTransaction {
  return {
    id: `idle-sync-${Date.now()}-${planSequence++}`,
    label: 'Persist current project draft',
    operations: [
      { kind: 'replace_canvas_state', nodes: project.nodes, edges: project.edges },
      { kind: 'set_skill_candidates', candidates: project.skillPromotionCandidates },
    ],
  };
}

function createInitialState(): Pick<AppState, 'project' | 'persistenceMode' | 'desktopRevision' | 'availableSnapshotIds' | 'knowledgeBases' | 'saveStatus' | 'saveErrorCode' | 'agentPanelCollapsed' | 'activeTool' | 'agentPlan' | 'undoStack' | 'confirmedModelJobs'> {
  const desktopMode = isDesktopBridgeAvailable();
  const restoredProject = desktopMode ? null : loadPersistedProjectBundle()?.current;
  return {
    activeTool: 'select',
    agentPanelCollapsed: false,
    agentPlan: null,
    availableSnapshotIds: desktopMode ? [] : readAvailableSnapshotIds(),
    confirmedModelJobs: 0,
    desktopRevision: 0,
    knowledgeBases: [],
    persistenceMode: desktopMode ? 'desktop' : 'browser',
    project: restoredProject ?? createStarterProject(),
    saveErrorCode: null,
    saveStatus: restoredProject ? 'saved' : 'pending',
    undoStack: [],
  };
}

function isDesktopBridgeAvailable(): boolean {
  return globalThis.window?.novusDesktop !== undefined;
}

function createOptimizationMemory(
  before: CanvasProject,
  after: CanvasProject,
  plan: AgentCanvasPlan,
  createdAt: string,
): ProjectMemoryEntry {
  const prompt = after.nodes.find((node) => node.type === 'prompt');
  const reviewNodes = plan.transaction.operations
    .flatMap((operation) => operation.kind === 'create_node' && operation.node.type === 'review' ? [operation.node] : []);
  const review = reviewNodes[reviewNodes.length - 1];
  const referenceAssetIds = collectReferenceAssetIds(after);
  const resultAssetIds = after.nodes.flatMap((node) => node.type === 'image_result' ? [node.data.assetId] : []);
  const previousRevision = before.projectMemory[before.projectMemory.length - 1]?.projectRevision ?? 0;

  return {
    schemaVersion: 1,
    id: `project-memory-${plan.id}`,
    projectId: after.id,
    projectRevision: previousRevision + 1,
    createdAt,
    kind: 'optimization',
    actor: 'agent',
    title: 'Agent 画布优化',
    changeSummary: `${plan.transaction.operations.length} 项画布操作：${plan.transaction.label}`,
    rationale: prompt?.type === 'prompt' ? prompt.data.prompt : plan.transaction.label,
    snapshots: {
      beforeId: `${plan.transaction.id}:before`,
      afterId: `${plan.transaction.id}:after`,
    },
    context: {
      modelId: plan.modelRoute,
      prompt: prompt?.type === 'prompt' ? prompt.data.prompt : undefined,
      referenceAssetIds,
      resultAssetIds: [...new Set(resultAssetIds)],
    },
    feedback: review?.type === 'review' ? review.data : { keep: [], change: [], never: [] },
    nextStep: '根据 KEEP / CHANGE / NEVER 反馈继续迭代，并在下一次生成后评分。',
  };
}

function createUndoMemory(
  project: CanvasProject,
  supersedesMemoryId: string,
  transactionId: string,
  createdAt: string,
): ProjectMemoryEntry {
  const previousRevision = project.projectMemory[project.projectMemory.length - 1]?.projectRevision ?? 0;
  const suffix = `${Date.now()}-${planSequence++}`;
  return {
    schemaVersion: 1,
    id: `project-memory-undo-${suffix}`,
    projectId: project.id,
    projectRevision: previousRevision + 1,
    createdAt,
    kind: 'decision',
    actor: 'user',
    title: '撤销画布优化',
    changeSummary: `撤销画布事务：${transactionId}`,
    rationale: '用户执行撤销，后续 Agent 不再把被撤销优化作为有效经验。',
    snapshots: {
      beforeId: `undo-${suffix}:before`,
      afterId: `undo-${suffix}:after`,
    },
    context: {
      referenceAssetIds: collectReferenceAssetIds(project),
      resultAssetIds: project.nodes.flatMap((node) => node.type === 'image_result' ? [node.data.assetId] : []),
    },
    feedback: { keep: [], change: [], never: [] },
    nextStep: '以撤销后的画布状态继续工作。',
    supersedesMemoryId,
  };
}

function createSnapshotRestoreMemory(
  project: CanvasProject,
  restoredSnapshotId: string,
  supersedesMemoryIds: string[],
  createdAt: string,
): ProjectMemoryEntry {
  const previousRevision = project.projectMemory[project.projectMemory.length - 1]?.projectRevision ?? 0;
  const suffix = `${Date.now()}-${planSequence++}`;
  return {
    schemaVersion: 1,
    id: `project-memory-restore-${suffix}`,
    projectId: project.id,
    projectRevision: previousRevision + 1,
    createdAt,
    kind: 'decision',
    actor: 'user',
    title: '恢复项目快照',
    changeSummary: `恢复稳定点：${restoredSnapshotId}`,
    rationale: '用户从项目记忆时间线恢复历史画布状态。',
    snapshots: {
      beforeId: `restore-${suffix}:before`,
      afterId: `restore-${suffix}:after`,
    },
    context: {
      referenceAssetIds: collectReferenceAssetIds(project),
      resultAssetIds: project.nodes.flatMap((node) => node.type === 'image_result' ? [node.data.assetId] : []),
    },
    feedback: { keep: [], change: [], never: [] },
    nextStep: '以恢复后的画布状态继续工作。',
    supersedesMemoryIds,
  };
}

function collectReferenceAssetIds(project: CanvasProject): string[] {
  const assetIds = project.nodes.flatMap((node) => {
    if (node.type === 'reference') return [node.data.assetId];
    if (node.type === 'placement_preview') return node.data.objects.map((object) => object.assetId);
    return [];
  });
  return [...new Set(assetIds)];
}

function filterValidSkillPromotionCandidates(
  projectId: string,
  timeline: ProjectMemoryEntry[],
  candidates: SkillPromotionCandidate[],
): SkillPromotionCandidate[] {
  const activeMemoryById = new Map(
    selectActiveProjectMemoryEntries(timeline).map((memory) => [memory.id, memory]),
  );
  return candidates.filter((candidate) => {
    const sourceMemory = activeMemoryById.get(candidate.sourceProjectMemoryId);
    return candidate.sourceProjectId === projectId
      && sourceMemory !== undefined
      && ['optimization', 'generation', 'reverse_prompt', 'user_feedback'].includes(sourceMemory.kind);
  });
}

function isPromotableMemory(timeline: ProjectMemoryEntry[], memory: ProjectMemoryEntry): boolean {
  if (!['optimization', 'generation', 'reverse_prompt', 'user_feedback'].includes(memory.kind)) return false;
  return selectActiveProjectMemoryEntries(timeline).some((entry) => entry.id === memory.id);
}

function containsProtectedRendererPayload(value: unknown): boolean {
  if (typeof value === 'string') {
    return /data:image\/[^;]+;base64,/i.test(value)
      || /base64,[a-z0-9+/=]{16,}/i.test(value)
      || /authorization\s*:\s*(?:basic|bearer|token)\s+\S+/i.test(value)
      || /(?:api[_ -]?key|token|secret|password)\s*[:=]\s*\S{8,}/i.test(value)
      || /\bsk-[a-z0-9_-]{8,}\b/i.test(value)
      || /[a-zA-Z]:[\\/]/.test(value)
      || /\\\\[^\\\s]+\\/.test(value)
      || /file:\/\//i.test(value)
      || /(?:^|\s)\/(?:Users|home)\//.test(value)
      || /%(?:USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|HOMEDRIVE|HOMEPATH)%[\\/]/i.test(value)
      || /\bAIza[0-9a-z_-]{20,}\b/i.test(value)
      || /\bAKIA[0-9A-Z]{16}\b/.test(value)
      || /\bgh[pousr]_[a-z0-9]{20,}\b/i.test(value)
      || /\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/i.test(value);
  }
  if (Array.isArray(value)) return value.some(containsProtectedRendererPayload);
  if (value && typeof value === 'object') return Object.values(value).some(containsProtectedRendererPayload);
  return false;
}

function readAvailableSnapshotIds(): string[] {
  return loadPersistedProjectBundle()?.snapshots.map((snapshot) => snapshot.id) ?? [];
}

function upsertKnowledgeSummary(
  states: KnowledgeBaseStateSummary[],
  nextState: KnowledgeBaseStateSummary,
): KnowledgeBaseStateSummary[] {
  return [
    ...states.filter((state) => state.knowledgeBaseId !== nextState.knowledgeBaseId),
    nextState,
  ].sort((left, right) => left.knowledgeBaseId.localeCompare(right.knowledgeBaseId));
}

function sanitizeProjectSkillPromotionCandidates(project: CanvasProject): CanvasProject {
  return {
    ...project,
    skillPromotionCandidates: filterValidSkillPromotionCandidates(
      project.id,
      project.projectMemory,
      project.skillPromotionCandidates,
    ),
  };
}

function scheduleProjectSave(get: () => AppState): void {
  cancelPendingProjectSave();
  pendingSave = setTimeout(() => {
    pendingSave = undefined;
    const state = get();
    if (state.saveStatus === 'read_only') return;
    void state.commitProjectTransaction(createIdleSyncTransaction(state.project), { kind: 'system', nextProject: state.project });
  }, 500);
}
