import { create } from 'zustand';
import {
  appendProjectMemoryEntry,
  createSkillPromotionCandidate,
  confirmAgentPlan as confirmDomainPlan,
  revertTransaction,
  selectActiveProjectMemoryEntries,
  type AgentCanvasPlan,
  type AgentPlanApprovalSelection,
  type CanvasProject,
  type CanvasTransaction,
  type ProjectMemoryEntry,
  type SkillPromotionCandidate,
} from '@agent-canvas/domain';
import {
  loadPersistedProjectBundle,
  persistCurrentProject,
  persistProjectTransition,
} from './project-persistence';

let planSequence = 0;
let pendingSave: ReturnType<typeof setTimeout> | undefined;

interface UndoEntry {
  transaction: CanvasTransaction;
  memoryId: string;
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

interface AppState {
  project: CanvasProject;
  saveStatus: 'pending' | 'saved' | 'error';
  agentPanelCollapsed: boolean;
  activeTool: 'select' | 'hand' | 'upload' | 'image' | 'prompt' | 'placement';
  agentPlan: AgentCanvasPlan | null;
  undoStack: UndoEntry[];
  confirmedModelJobs: number;
  setActiveTool: (tool: AppState['activeTool']) => void;
  toggleAgentPanel: () => void;
  setProject: (project: CanvasProject) => void;
  draftAgentPlan: (message: string) => void;
  confirmAgentPlan: (approvals: AgentPlanApprovalSelection) => void;
  cancelAgentPlan: () => void;
  undo: () => void;
  promoteProjectMemory: (memoryId: string) => void;
  restoreProjectSnapshot: (snapshotId: string) => void;
}

const restoredProject = loadPersistedProjectBundle()?.current;

export const useAppStore = create<AppState>((set) => ({
  project: restoredProject ?? createStarterProject(),
  saveStatus: restoredProject ? 'saved' : 'pending',
  agentPanelCollapsed: false,
  activeTool: 'select',
  agentPlan: null,
  undoStack: [],
  confirmedModelJobs: 0,
  setActiveTool: (activeTool) => set({ activeTool }),
  toggleAgentPanel: () => set((state) => ({ agentPanelCollapsed: !state.agentPanelCollapsed })),
  setProject: (project) => {
    set({ project, saveStatus: 'pending' });
    scheduleProjectSave(project);
  },
  draftAgentPlan: (message) => set((state) => {
    const promptNode = state.project.nodes.find((node) => node.type === 'prompt');
    if (!promptNode || promptNode.type !== 'prompt' || message.trim().length === 0) return state;
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
  confirmAgentPlan: (approvals) => set((state) => {
    if (!state.agentPlan) return state;
    cancelPendingProjectSave();
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
    const saved = persistProjectTransition(state.project, project, memoryEntry.snapshots);
    return {
      project,
      saveStatus: saved ? 'saved' : 'error',
      agentPlan: result.plan,
      undoStack: [...state.undoStack, { transaction: result.inverse, memoryId: memoryEntry.id }],
      confirmedModelJobs: state.confirmedModelJobs + (result.executeModels ? state.agentPlan.jobCount : 0),
    };
  }),
  cancelAgentPlan: () => set({ agentPlan: null }),
  promoteProjectMemory: (memoryId) => set((state) => {
    if (state.project.skillPromotionCandidates.some((candidate) => candidate.sourceProjectMemoryId === memoryId)) return state;
    const memory = state.project.projectMemory.find((entry) => entry.id === memoryId);
    if (!memory || !isPromotableMemory(state.project.projectMemory, memory)) return state;
    cancelPendingProjectSave();
    const candidate = createSkillPromotionCandidate(memory, {
      candidateId: `skill-candidate-${Date.now()}-${planSequence++}`,
      createdAt: new Date().toISOString(),
    });
    const project = {
      ...state.project,
      skillPromotionCandidates: [...state.project.skillPromotionCandidates, candidate],
    };
    const saved = persistCurrentProject(project);
    return { project, saveStatus: saved ? 'saved' : 'error' };
  }),
  restoreProjectSnapshot: (snapshotId) => set((state) => {
    const bundle = loadPersistedProjectBundle();
    const snapshot = bundle?.snapshots.find((entry) => entry.id === snapshotId);
    if (!snapshot || snapshot.project.id !== state.project.id) return state;
    cancelPendingProjectSave();
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
    const saved = persistProjectTransition(currentProject, project, memoryEntry.snapshots);
    return { project, saveStatus: saved ? 'saved' : 'error', agentPlan: null, undoStack: [] };
  }),
  undo: () => set((state) => {
    const undoEntry = state.undoStack[state.undoStack.length - 1];
    if (!undoEntry) return state;
    cancelPendingProjectSave();
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
    const saved = persistProjectTransition(currentProject, project, memoryEntry.snapshots);
    return {
      project,
      saveStatus: saved ? 'saved' : 'error',
      undoStack: state.undoStack.slice(0, -1),
      agentPlan: null,
    };
  }),
}));

function cancelPendingProjectSave(): void {
  if (!pendingSave) return;
  clearTimeout(pendingSave);
  pendingSave = undefined;
}
function scheduleProjectSave(project: CanvasProject): void {
  if (pendingSave) clearTimeout(pendingSave);
  pendingSave = setTimeout(() => {
    const saved = persistCurrentProject(project);
    useAppStore.setState({ saveStatus: saved ? 'saved' : 'error' });
    pendingSave = undefined;
  }, 500);
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

function isPromotableMemory(timeline: ProjectMemoryEntry[], memory: ProjectMemoryEntry): boolean {
  if (!['optimization', 'generation', 'reverse_prompt'].includes(memory.kind)) return false;
  return selectActiveProjectMemoryEntries(timeline).some((entry) => entry.id === memory.id);
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
      && ['optimization', 'generation', 'reverse_prompt'].includes(sourceMemory.kind);
  });
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