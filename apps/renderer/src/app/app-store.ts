import { create } from 'zustand';
import type { Connection } from '@xyflow/react';
import type {
  KnowledgeSyncStatusSummary,
  ProjectImageAssetSummary,
  ProjectImageImportTarget,
  ProviderBridgeProfile,
} from '@agent-canvas/desktop-core';
import {
  appendProjectMemoryEntry,
  applyProjectTransaction,
  canConnectCanvasPorts,
  createSkillPromotionCandidateFingerprint,
  createSkillPromotionCandidate,
  createCanvasModuleNode,
  getCanvasModuleDefinition,
  MAX_GENERATION_REFERENCES,
  reorderCanvasInputEdges,
  createUserFeedbackMemory,
  confirmAgentPlan as confirmDomainPlan,
  revertTransaction,
  selectActiveProjectMemoryEntries,
  skillPromotionCandidateSchema,
  type AgentCanvasPlan,
  type AgentKnowledgeLease,
  type AgentPlanApprovalSelection,
  type CanvasOperation,
  type CanvasModuleNode,
  type CanvasModuleType,
  type CanvasProject,
  type CanvasTransaction,
  type FeedbackObservations,
  type ImageCitation,
  type ModelJob,
  type OrderedReference,
  type ProjectOperation,
  type ProjectMemoryEntry,
  type ProjectTransaction,
  type ReferenceRole,
  type SkillPromotionCandidate,
} from '@agent-canvas/domain';
import {
  createProjectPersistenceClient,
  type ProjectCommitRequest,
  type ProjectCommitResult,
  type ProjectLifecycle,
  type ProjectPersistenceClient,
  type ProjectSaveStatus,
} from './desktop-persistence';
import { createUntitledProject } from './project-factory';
import {
  AUTOSAVE_IDLE_MS,
  createAutosaveController,
  type AutosaveFlushReason,
} from './autosave';
import {
  createKnowledgeClient,
  type KnowledgeBaseStateSummary,
  type KnowledgeClient,
} from './knowledge-client';
import { loadPersistedProjectBundle } from './project-persistence';
import { createExecutionReferenceSnapshot } from './execution-reference-snapshot';
import {
  createInMemoryModelJobStorage,
  createModelJobStore,
  type ModelJobExecutor,
  type ModelJobRequest,
  type ModelJobStorage,
  type ModelJobStore,
} from '../jobs/job-store';
import { createDesktopModelJobExecutor } from '../jobs/desktop-model-executor';
import { createModelJobRunId } from '../jobs/model-job-identity';
import { runtimeProfile } from './runtime-profile';

let planSequence = 0;
let stableProjectCommitTail: Promise<void> | null = null;
let pendingFailedProjectCommit: ProjectCommitRequest | null = null;
let activeProjectCommitToken: ProjectCommitToken | null = null;
let projectPersistenceGeneration = 0;
let projectPersistenceClient = createProjectPersistenceClient();
let knowledgeClient = createKnowledgeClient();
let modelJobExecutorOverride: ModelJobExecutor | null = null;
let pendingModelJobExecutorOverride: ModelJobExecutor | null = null;
let modelJobStorageOverride: ModelJobStorage | null = null;
let modelJobStore: ModelJobStore | null = null;
let modelJobUnsubscribe: (() => void) | null = null;
let modelJobStoreGeneration = 0;
let modelJobRecoveryGeneration = 0;
let pendingAgentConfirmation: PendingAgentConfirmation | null = null;
let pendingAgentJobRetry: Promise<void> | null = null;
const AGENT_MODEL_CONVERSATION_ID = 'agent-conversation-shared';
const projectAutosave = createAutosaveController<CanvasProject>({
  commit: async (draft) => enqueueStableProjectOperation(
    (partial) => useAppStore.setState(partial),
    () => useAppStore.getState(),
    async (commitNow) => {
      const project = draft.project;
      return commitNow(createIdleSyncTransaction(project), { kind: 'system', nextProject: project });
    },
  ),
  delayMs: AUTOSAVE_IDLE_MS,
  isReadOnly: () => {
    const state = useAppStore.getState();
    return state.saveStatus === 'read_only' || state.recoveryRequired;
  },
});
let pendingProjectFlushBoundary: Promise<boolean> | null = null;

interface UndoEntry {
  transaction: CanvasTransaction;
  memoryId: string;
}

interface PendingAgentConfirmation {
  fingerprint: string;
  planId: string;
  token: string;
  transactionId: string;
}

interface ProjectCommitToken {
  readonly generation: number;
  readonly projectId: string;
  readonly request: ProjectCommitRequest;
}

interface SetProjectOptions {
  schedulePersist?: boolean;
}

interface CommitProjectTransactionOptions {
  kind?: ProjectCommitRequest['kind'];
  nextProject?: CanvasProject;
}

interface CommitProjectTransactionNowOptions extends CommitProjectTransactionOptions {
  retryRequest?: ProjectCommitRequest;
}

type CommitProjectTransactionNow = (
  transaction: ProjectTransaction,
  options?: CommitProjectTransactionNowOptions,
) => Promise<boolean>;

type StableProjectOperation = (commitNow: CommitProjectTransactionNow) => boolean | Promise<boolean>;

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
  projectLifecycle: ProjectLifecycle;
  projectImages: ProjectImageAssetSummary[];
  projectImageError: string | null;
  projectImageImportingNodeId: string | null;
  persistenceMode: 'browser' | 'desktop';
  desktopRevision: number;
  availableSnapshotIds: string[];
  canReloadDurableProject: boolean;
  canRetryProjectCommit: boolean;
  projectCommitConflictCode: 'REVISION_CONFLICT' | 'CONCURRENT_WRITER' | null;
  recoveryRequired: boolean;
  knowledgeBases: KnowledgeBaseStateSummary[];
  knowledgeSyncStatuses: KnowledgeSyncStatusSummary[];
  saveStatus: ProjectSaveStatus;
  saveErrorCode: string | null;
  agentPanelCollapsed: boolean;
  activeTool: 'select' | 'hand' | 'upload' | 'image' | 'prompt' | 'placement';
  agentPlan: AgentCanvasPlan | null;
  undoStack: UndoEntry[];
  confirmedModelJobs: number;
  modelJobs: ModelJob[];
  cancelModelJob: (jobId: string) => Promise<void>;
  closePersistence: () => Promise<boolean>;
  discardPersistence: () => Promise<boolean>;
  commitProjectTransaction: (transaction: ProjectTransaction, options?: CommitProjectTransactionOptions) => Promise<boolean>;
  retryFailedProjectCommit: () => Promise<boolean>;
  addModuleNode: (moduleType: CanvasModuleType, position: { x: number; y: number }) => Promise<boolean>;
  connectModulePorts: (connection: Connection) => Promise<boolean>;
  commitNodePosition: (nodeId: string, position: { x: number; y: number }) => Promise<boolean>;
  toggleNodeLock: (nodeId: string) => Promise<boolean>;
  reorderModuleInput: (targetNodeId: string, targetPortId: string, edgeIds: string[]) => Promise<boolean>;
  commitReferenceOrder: (assetIds: string[]) => Promise<boolean>;
  configureKnowledgeBase: (knowledgeBaseId: string, displayName: string) => Promise<void>;
  getKnowledgeLease: KnowledgeClient['getLease'];
  hydratePersistence: () => Promise<void>;
  openProject: () => Promise<boolean>;
  reloadDurableProject: () => Promise<boolean>;
  newWorkflow: () => Promise<void>;
  importImageForModule: (nodeId: string) => Promise<boolean>;
  importPlacementReference: (
    nodeId: string,
    role: Exclude<ReferenceRole, 'placement_preview'>,
  ) => Promise<boolean>;
  refreshProjectImages: () => Promise<void>;
  initializeKnowledge: () => Promise<void>;
  flushProjectSave: (reason: Exclude<AutosaveFlushReason, 'idle'>) => Promise<boolean>;
  refreshModelJobs: () => Promise<void>;
  retryModelJob: (jobId: string) => Promise<void>;
  retryAgentPlanJobs: () => Promise<void>;
  reviewSkillCandidate: KnowledgeClient['review'];
  setActiveTool: (tool: AppState['activeTool']) => void;
  toggleAgentPanel: () => void;
  setProject: (project: CanvasProject, options?: SetProjectOptions) => void;
  selectProjectImageForModule: (nodeId: string, assetId: string) => Promise<boolean>;
  setCanvasLibrarySelection: (nodeId: string, assetIds: string[]) => Promise<boolean>;
  draftAgentPlan: (message: string, options?: { modelRoute?: string; modelRouteDisplayName?: string }) => void;
  confirmAgentPlan: (approvals: AgentPlanApprovalSelection) => Promise<void>;
  cancelAgentPlan: () => void;
  undo: () => Promise<void>;
  prepareSkillCandidateReview: (candidateId: string) => Promise<void>;
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
  cancelModelJob: async (jobId) => {
    await getModelJobStore().cancelQueuedJob(jobId);
    const modelJobs = await getModelJobStore().listJobs();
    set({ confirmedModelJobs: countConfirmedModelJobs(modelJobs), modelJobs });
  },
  addModuleNode: (moduleType, position) => enqueueStableProjectOperation(set, get, async (commitNow) => {
    const suffix = `${Date.now()}-${planSequence++}`;
    const node = createCanvasModuleNode(`module-${moduleType}-${suffix}`, moduleType, position);
    return commitNow({
      id: `add-module-${suffix}`,
      label: `Add ${getCanvasModuleDefinition(moduleType).displayName}`,
      operations: [{ kind: 'canvas', operation: { kind: 'create_node', node } }],
    });
  }),
  connectModulePorts: (connection) => enqueueStableProjectOperation(set, get, async (commitNow) => {
    const state = get();
    const sourceId = connection?.source;
    const targetId = connection?.target;
    const sourcePortId = connection?.sourceHandle;
    const targetPortId = connection?.targetHandle;
    if (!isNonEmptyString(sourceId) || !isNonEmptyString(targetId)
      || !isNonEmptyString(sourcePortId) || !isNonEmptyString(targetPortId)) return false;

    const sourceNode = getModuleNode(state.project.nodes, sourceId);
    const targetNode = getModuleNode(state.project.nodes, targetId);
    if (!sourceNode || !targetNode) return false;
    if (hasExactModuleEdge(state.project.edges, sourceId, sourcePortId, targetId, targetPortId)) return false;
    if (wouldCreateModuleCycle(state.project.nodes, state.project.edges, sourceId, targetId)) return false;
    const validation = canConnectCanvasPorts(sourceNode, sourcePortId, targetNode, targetPortId);
    if (!validation.ok) return false;
    const targetPort = getCanvasModuleDefinition(targetNode.data.moduleType).ports.find((port) => (
      port.id === targetPortId && port.direction === 'input'
    ));
    if (!targetPort) return false;

    const incoming = state.project.edges.filter((edge) => (
      edge.target === targetId && edge.targetPortId === targetPortId
    ));
    if (targetPort.cardinality === 'one' && incoming.length > 0) return false;
    const nextOrder = incoming.length === 0
      ? 0
      : Math.max(...incoming.map((edge, index) => edge.order ?? index)) + 1;
    const edgeId = createModuleEdgeId(state.project.edges.map((edge) => edge.id), {
      sourceId,
      sourcePortId,
      targetId,
      targetPortId,
      order: nextOrder,
    });
    const transaction: ProjectTransaction = {
      id: `connect-module-${edgeId}`,
      label: 'Connect module ports',
      operations: [{
        kind: 'canvas',
        operation: {
          kind: 'create_edge',
          edge: { id: edgeId, source: sourceId, sourcePortId, target: targetId, targetPortId, order: nextOrder },
        },
      }],
    };
    try {
      const nextProject = applyProjectTransaction(state.project, transaction);
      return commitNow(transaction, { nextProject });
    } catch {
      return false;
    }
  }),
  commitNodePosition: (nodeId, position) => enqueueStableProjectOperation(set, get, async (commitNow) => {
    const state = get();
    if (!isNonEmptyString(nodeId) || !isFinitePosition(position)) return false;
    const node = state.project.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return false;
    if (node.locked === true) return false;
    if (node.position.x === position.x && node.position.y === position.y) return true;

    const nextNode = { ...node, position };
    const transaction: ProjectTransaction = {
      id: `move-node-${nodeId}-${position.x}-${position.y}`,
      label: 'Move canvas node',
      operations: [{ kind: 'canvas', operation: { kind: 'update_node', node: nextNode } }],
    };
    try {
      const nextProject = applyProjectTransaction(state.project, transaction);
      return commitNow(transaction, { nextProject });
    } catch {
      return false;
    }
  }),
  toggleNodeLock: (nodeId) => enqueueStableProjectOperation(set, get, async (commitNow) => {
    const state = get();
    if (!isNonEmptyString(nodeId)) return false;
    const node = state.project.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return false;
    const nextNode = { ...node, locked: node.locked !== true };
    const suffix = `${Date.now()}-${planSequence++}`;
    const transaction: ProjectTransaction = {
      id: `toggle-node-lock-${nodeId}-${suffix}`,
      label: nextNode.locked ? 'Lock canvas node position' : 'Unlock canvas node position',
      operations: [{ kind: 'canvas', operation: { kind: 'update_node', node: nextNode } }],
    };
    const nextProject = applyProjectTransaction(state.project, transaction);
    return commitNow(transaction, { nextProject });
  }),
  reorderModuleInput: (targetNodeId, targetPortId, edgeIds) => enqueueStableProjectOperation(set, get, async (commitNow) => {
    const state = get();
    if (!isNonEmptyString(targetNodeId) || !isNonEmptyString(targetPortId)
      || !edgeIds.every(isNonEmptyString)) return false;
    const targetNode = getModuleNode(state.project.nodes, targetNodeId);
    if (!targetNode) return false;
    const targetPort = getCanvasModuleDefinition(targetNode.data.moduleType).ports.find((port) => (
      port.id === targetPortId && port.direction === 'input'
    ));
    if (!targetPort || targetPort.cardinality !== 'many') return false;
    const matching = state.project.edges.filter((edge) => (
      edge.target === targetNodeId && edge.targetPortId === targetPortId
    ));
    if (matching.length === 0) return false;
    for (const edge of matching) {
      const sourceNode = getModuleNode(state.project.nodes, edge.source);
      if (!sourceNode || !edge.sourcePortId || !canConnectCanvasPorts(sourceNode, edge.sourcePortId, targetNode, targetPortId).ok) {
        return false;
      }
    }
    try {
      reorderCanvasInputEdges(state.project.edges, targetNodeId, targetPortId, edgeIds);
    } catch {
      return false;
    }
    const currentOrder = matching
      .map((edge, index) => ({ edge, index }))
      .sort((left, right) => (
        (left.edge.order ?? left.index) - (right.edge.order ?? right.index)
        || left.index - right.index
      ))
      .map(({ edge }) => edge.id);
    if (sameStringList(currentOrder, edgeIds)) return true;

    const transaction: ProjectTransaction = {
      id: `reorder-module-${targetNodeId}-${targetPortId}`,
      label: 'Reorder module input',
      operations: [{ kind: 'canvas', operation: { kind: 'reorder_input_edges', targetNodeId, targetPortId, edgeIds: [...edgeIds] } }],
    };
    try {
      const nextProject = applyProjectTransaction(state.project, transaction);
      return commitNow(transaction, { nextProject });
    } catch {
      return false;
    }
  }),
  selectProjectImageForModule: (nodeId, assetId) => enqueueStableProjectOperation(set, get, async (commitNow) => {
    const state = get();
    const node = getModuleNode(state.project.nodes, nodeId);
    const asset = (state.project.assets ?? []).find((candidate) => candidate.assetId === assetId);
    if (!node || !asset || (node.data.moduleType !== 'image_input' && node.data.moduleType !== 'upload_image')) {
      return false;
    }
    if (node.data.config.assetId === assetId) return true;
    const nextNode = { ...node, data: { ...node.data, config: { ...node.data.config, assetId } } };
    const suffix = `${Date.now()}-${planSequence++}`;
    const transaction: ProjectTransaction = {
      id: `select-project-image-${suffix}`,
      label: 'Select managed project image',
      operations: [{ kind: 'canvas', operation: { kind: 'update_node', node: nextNode } }],
    };
    const nextProject = applyProjectTransaction(state.project, transaction);
    return commitNow(transaction, { nextProject });
  }),
  setCanvasLibrarySelection: (nodeId, assetIds) => enqueueStableProjectOperation(set, get, async (commitNow) => {
    const state = get();
    const node = getModuleNode(state.project.nodes, nodeId);
    if (!node || node.data.moduleType !== 'canvas_library') return false;
    const uniqueAssetIds = [...new Set(assetIds)];
    if (uniqueAssetIds.length !== assetIds.length || uniqueAssetIds.length > MAX_GENERATION_REFERENCES) return false;
    const catalogAssetIds = new Set((state.project.assets ?? []).map((asset) => asset.assetId));
    if (uniqueAssetIds.some((assetId) => !catalogAssetIds.has(assetId))) return false;
    const currentAssetIds = Array.isArray(node.data.config.assetIds)
      ? node.data.config.assetIds.filter(isNonEmptyString)
      : [];
    if (sameStringList(currentAssetIds, uniqueAssetIds)) return true;
    const nextNode = {
      ...node,
      data: { ...node.data, config: { ...node.data.config, assetIds: uniqueAssetIds } },
    };
    const suffix = `${Date.now()}-${planSequence++}`;
    const transaction: ProjectTransaction = {
      id: `update-canvas-library-${suffix}`,
      label: 'Update canvas image library',
      operations: [{ kind: 'canvas', operation: { kind: 'update_node', node: nextNode } }],
    };
    const nextProject = applyProjectTransaction(state.project, transaction);
    return commitNow(transaction, { nextProject });
  }),
  closePersistence: async () => {
    if (get().projectLifecycle === 'untitled') return false;
    if (get().recoveryRequired) return false;
    const activeRequest = invalidateActiveProjectCommit();
    if (activeRequest !== null) {
      pendingFailedProjectCommit = activeRequest;
      set({
        canReloadDurableProject: false,
        canRetryProjectCommit: true,
        project: activeRequest.nextProject,
        projectCommitConflictCode: null,
        saveErrorCode: 'DURABLE_WRITE_FAILED',
        saveStatus: 'error',
      });
      return false;
    }
    const flushed = await flushPendingProjectSave(get, set, 'close');
    if (!flushed) return false;
    invalidateModelJobStoreGeneration();
    modelJobStore?.stop();
    modelJobUnsubscribe?.();
    modelJobUnsubscribe = null;
    knowledgeClient.stop();
    try {
      await projectPersistenceClient.close();
      return true;
    } catch {
      return false;
    }
  },
  discardPersistence: async () => {
    invalidateProjectPersistenceBoundary();
    cancelPendingProjectSave();
    clearPendingFailedProjectCommit();
    set({
      canReloadDurableProject: false,
      canRetryProjectCommit: false,
      projectCommitConflictCode: null,
    });
    invalidateModelJobStoreGeneration();
    modelJobStore?.stop();
    modelJobUnsubscribe?.();
    modelJobUnsubscribe = null;
    knowledgeClient.stop();
    try {
      await projectPersistenceClient.close();
      set({
        recoveryRequired: false,
        saveErrorCode: null,
        saveStatus: 'pending',
      });
      return true;
    } catch {
      return false;
    }
  },
  commitProjectTransaction: (transaction, options = {}) => enqueueStableProjectOperation(
    set,
    get,
    (commitNow) => commitNow(transaction, options),
  ),
  retryFailedProjectCommit: () => enqueueStableProjectOperation(
    set,
    get,
    async (commitNow) => {
      const request = pendingFailedProjectCommit;
      if (request === null || !get().canRetryProjectCommit || get().saveStatus === 'read_only' || get().recoveryRequired) return false;
      return commitNow(request.transaction, { retryRequest: request });
    },
    { allowPendingFailure: true },
  ),
  commitReferenceOrder: (assetIds) => {
    const requestedAssetIds = [...assetIds];
    return enqueueStableProjectOperation(set, get, async (commitNow) => {
      const state = get();
      const placementNode = state.project.nodes.find((node) => node.type === 'placement_preview');
      if (!placementNode || placementNode.type !== 'placement_preview') return false;

      const byAssetId = new Map(placementNode.data.objects.map((object) => [object.assetId, object]));
      const orderedObjects = [...new Set(requestedAssetIds)]
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
      return commitNow(transaction, { kind: 'canvas', nextProject });
    });
  },
  configureKnowledgeBase: async (knowledgeBaseId, displayName) => {
    await knowledgeClient.configure(knowledgeBaseId, displayName);
  },
  getKnowledgeLease: (runId, capability, references, citations) => (
    knowledgeClient.getLease(runId, capability, references, citations)
  ),
  hydratePersistence: async () => {
    const jobStore = getModelJobStore();
    const hydrated = await projectPersistenceClient.hydrate();
    const imageState = await readProjectImagesForHydration();
    const modelJobs = await jobStore.listJobs();
    invalidateProjectPersistenceBoundary();
    cancelPendingProjectSave();
    clearPendingFailedProjectCommit();
    set({
      availableSnapshotIds: hydrated.availableSnapshotIds,
      canReloadDurableProject: false,
      canRetryProjectCommit: false,
      desktopRevision: hydrated.revision,
      persistenceMode: hydrated.mode,
      project: hydrated.project,
      projectLifecycle: hydrated.lifecycle,
      projectCommitConflictCode: null,
      recoveryRequired: hydrated.recoveryRequired === true,
      ...imageState,
      confirmedModelJobs: countConfirmedModelJobs(modelJobs),
      modelJobs,
      saveErrorCode: hydrated.recoveryRequired === true ? 'RECOVERY_REQUIRED' : null,
      saveStatus: hydrated.saveStatus,
    });
    recoverModelJobsInBackground(jobStore);
  },
  openProject: async () => {
    if (get().recoveryRequired) return false;
    const openProject = projectPersistenceClient.openProject;
    if (openProject === undefined) return false;
    const opened = await openProject();
    if (opened === null) return false;
    const imageState = await readProjectImagesForHydration();
    invalidateProjectPersistenceBoundary();
    cancelPendingProjectSave();
    clearPendingFailedProjectCommit();
    set({
      availableSnapshotIds: opened.availableSnapshotIds,
      canReloadDurableProject: false,
      canRetryProjectCommit: false,
      desktopRevision: opened.revision,
      persistenceMode: opened.mode,
      project: opened.project,
      projectLifecycle: opened.lifecycle,
      projectCommitConflictCode: null,
      recoveryRequired: opened.recoveryRequired === true,
      ...imageState,
      projectImageImportingNodeId: null,
      saveErrorCode: opened.recoveryRequired === true ? 'RECOVERY_REQUIRED' : null,
      saveStatus: opened.saveStatus,
      undoStack: [],
    });
    return true;
  },
  reloadDurableProject: async () => {
    if (!get().canReloadDurableProject) return false;
    const reloadDurableProject = projectPersistenceClient.reloadDurableProject;
    if (reloadDurableProject === undefined) return false;
    let opened;
    try {
      opened = await reloadDurableProject();
    } catch {
      return false;
    }
    if (opened === null || opened.recoveryRequired === true || opened.saveStatus !== 'saved') return false;
    const imageState = await readProjectImagesForHydration();
    invalidateProjectPersistenceBoundary();
    cancelPendingProjectSave();
    clearPendingFailedProjectCommit();
    set({
      availableSnapshotIds: opened.availableSnapshotIds,
      canReloadDurableProject: false,
      canRetryProjectCommit: false,
      desktopRevision: opened.revision,
      persistenceMode: opened.mode,
      project: opened.project,
      projectLifecycle: opened.lifecycle,
      projectCommitConflictCode: null,
      recoveryRequired: false,
      ...imageState,
      projectImageImportingNodeId: null,
      saveErrorCode: null,
      saveStatus: 'saved',
      undoStack: [],
    });
    return true;
  },
  newWorkflow: async () => {
    if (get().recoveryRequired) return;
    invalidateProjectPersistenceBoundary();
    cancelPendingProjectSave();
    await projectPersistenceClient.close().catch(() => undefined);
    clearPendingFailedProjectCommit();
    set({
      availableSnapshotIds: [],
      canReloadDurableProject: false,
      canRetryProjectCommit: false,
      desktopRevision: 0,
      project: createUntitledProject(),
      projectLifecycle: 'untitled',
      projectCommitConflictCode: null,
      recoveryRequired: false,
      projectImages: [],
      projectImageError: null,
      projectImageImportingNodeId: null,
      saveErrorCode: null,
      saveStatus: 'pending',
      undoStack: [],
    });
  },
  importImageForModule: (nodeId) => importProjectImageWithTarget({ kind: 'module', nodeId }),
  importPlacementReference: (nodeId, role) => importProjectImageWithTarget({
    kind: 'placement_reference',
    nodeId,
    role,
  }),
  refreshProjectImages: async () => {
    try {
      const projectImages = await projectPersistenceClient.listProjectImages();
      set({ projectImages, projectImageError: null });
    } catch (error) {
      set({ projectImageError: readErrorCode(error) });
    }
  },
  initializeKnowledge: async () => {
    await knowledgeClient.start(
      (knowledgeBases) => set({ knowledgeBases }),
      (syncStatus) => set((state) => ({
        knowledgeSyncStatuses: upsertKnowledgeSyncStatus(state.knowledgeSyncStatuses, syncStatus),
      })),
    );
  },
  flushProjectSave: (reason) => flushPendingProjectSave(get, set, reason),
  refreshModelJobs: async () => {
    const modelJobs = await getModelJobStore().listJobs();
    set({ confirmedModelJobs: countConfirmedModelJobs(modelJobs), modelJobs });
  },
  reviewSkillCandidate: async (request) => {
    const result = await knowledgeClient.review(bindSkillCandidateReviewRequest(get(), request));
    set((state) => ({
      desktopRevision: result.currentRevision,
      knowledgeBases: result.knowledgeState
        ? upsertKnowledgeSummary(state.knowledgeBases, result.knowledgeState)
        : state.knowledgeBases,
      project: {
        ...state.project,
        skillPromotionCandidates: result.candidates
          ? [...result.candidates]
          : state.project.skillPromotionCandidates.map((candidate) => (
            candidate.id === result.candidate.id ? result.candidate : candidate
          )),
      },
    }));
    return result;
  },
  setActiveTool: (activeTool) => set({ activeTool }),
  toggleAgentPanel: () => set((state) => ({ agentPanelCollapsed: !state.agentPanelCollapsed })),
  setProject: (project, options = {}) => {
    if (pendingFailedProjectCommit !== null || get().recoveryRequired) return;
    invalidateProjectPersistenceBoundary();
    set((state) => ({
      canReloadDurableProject: false,
      project,
      projectCommitConflictCode: null,
      saveErrorCode: null,
      saveStatus: state.saveStatus === 'read_only' ? 'read_only' : 'pending',
    }));
    if (options.schedulePersist !== false) {
      scheduleProjectSave(get);
    }
  },
  draftAgentPlan: (message, options = {}) => {
    if (isAgentPlanBusy(get().agentPlan)) {
      rejectAgentPlanMutationDuringProcessing(set);
      return;
    }
    clearPendingAgentConfirmation();
    set((state) => {
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
        modelRoute: options.modelRoute,
        modelRouteDisplayName: options.modelRouteDisplayName,
        jobCount: 1,
      } };
    });
  },
  confirmAgentPlan: async (approvals) => {
    const state = get();
    if (!state.agentPlan || state.agentPlan.state !== 'waiting_for_confirmation') return;
    if (pendingAgentConfirmation !== null) return;

    const initialPlan = state.agentPlan;
    const confirmation: PendingAgentConfirmation = {
      fingerprint: createAgentConfirmationFingerprint(state, initialPlan),
      planId: initialPlan.id,
      token: `agent-confirm-${Date.now()}-${planSequence++}`,
      transactionId: initialPlan.transaction.id,
    };
    pendingAgentConfirmation = confirmation;

    const now = new Date().toISOString();
    const requestedPlan = {
      ...initialPlan,
      state: 'confirming' as const,
      referenceSnapshot: createExecutionReferenceSnapshot(
        collectExecutionReferences(state.project),
        state.desktopRevision,
      ),
      confirmations: {
        ...initialPlan.confirmations,
        canvas: now,
        models: approvals.models ? now : undefined,
        deleteNodes: approvals.deleteNodes ? now : undefined,
        skillWriteback: approvals.skillWriteback ? now : undefined,
      },
    };
    set((current) => (
      current.agentPlan?.id === confirmation.planId && current.agentPlan.state === 'waiting_for_confirmation'
        ? { agentPlan: requestedPlan }
        : current
    ));
    try {
      let modelProfile: ResolvedModelJobProfile | null = null;
      if (shouldExecuteModels(requestedPlan)) {
        try {
          modelProfile = await resolveModelJobProfile(requestedPlan);
        } catch (error) {
          if (isActiveAgentConfirmation(get(), confirmation, ['confirming'])) {
            set((current) => {
              if (!current.agentPlan || current.agentPlan.id !== confirmation.planId) return current;
              return {
                agentPlan: {
                  ...current.agentPlan,
                  state: 'waiting_for_confirmation',
                  conflicts: upsertAgentConflict(current.agentPlan.conflicts, modelProfileConflictMessage(error)),
                },
              };
            });
          }
          return;
        }
      }
      if (!isActiveAgentConfirmation(get(), confirmation, ['confirming'])) {
        restoreWaitingPlanAfterStaleConfirmation(set, confirmation, requestedPlan);
        return;
      }

      const confirmedPlan = modelProfile
        ? {
            ...requestedPlan,
            conflicts: requestedPlan.conflicts.filter((conflict) => !isModelProfileConflict(conflict)),
            modelProvider: modelProfile.provider,
            modelRoute: modelProfile.modelRoute,
            modelRouteDisplayName: modelProfile.displayName,
            modelId: modelProfile.modelId,
            modelConversationId: AGENT_MODEL_CONVERSATION_ID,
          }
        : requestedPlan;
      const committingPlan = {
        ...confirmedPlan,
        state: 'committing' as const,
      };
      set((current) => (
        current.agentPlan?.id === confirmation.planId && current.agentPlan.state === 'confirming'
          ? { agentPlan: committingPlan }
          : current
      ));
      if (!isActiveAgentConfirmation(get(), confirmation, ['committing'])) return;
      const committed: { value: {
          memoryEntry: ProjectMemoryEntry;
          project: CanvasProject;
          result: ReturnType<typeof confirmDomainPlan>;
        } | null } = { value: null };
      const saved = await enqueueStableProjectOperation(set, get, async (commitNow) => {
        if (!isActiveAgentConfirmation(get(), confirmation, ['committing'])) return false;
        const latestState = get();
        const result = confirmDomainPlan(latestState.project, {
          ...committingPlan,
        });
        const memoryEntry = createOptimizationMemory(latestState.project, result.project, committingPlan, now);
        const project = {
          ...result.project,
          projectMemory: appendProjectMemoryEntry(result.project.projectMemory, memoryEntry),
        };
        const transaction = buildProjectTransaction({
          canvasTransaction: committingPlan.transaction,
          label: committingPlan.transaction.label,
          memoryEntry,
          transactionId: committingPlan.transaction.id,
        });
        const persisted = await commitNow(transaction, { kind: 'agent', nextProject: project });
        if (persisted) committed.value = { memoryEntry, project, result };
        return persisted;
      });
      if (!saved || committed.value === null) {
        restoreWaitingPlanAfterCommitFailure(set, confirmation, committingPlan);
        return;
      }
      const { memoryEntry, project, result } = committed.value;
      if (!isActiveCommittedAgentConfirmation(get(), confirmation, committingPlan, project)) return;

      let modelJobs = get().modelJobs;
      if (result.executeModels) {
        try {
          modelJobs = await getModelJobStore().enqueueConfirmedJobs({
            conversationId: committingPlan.modelConversationId ?? AGENT_MODEL_CONVERSATION_ID,
            confirmedAt: now,
            requests: buildModelJobRequests(project, committingPlan, modelProfile!),
          });
        } catch {
          if (isActiveCommittedAgentConfirmation(get(), confirmation, committingPlan, project)) {
            set((current) => ({
              agentPlan: {
                ...committingPlan,
                state: 'waiting_for_job_retry',
                conflicts: upsertAgentConflict(committingPlan.conflicts, modelQueueConflictMessage()),
              },
              undoStack: appendUndoEntry(current.undoStack, { transaction: result.inverse, memoryId: memoryEntry.id }),
            }));
          }
          return;
        }
        if (!isActiveCommittedAgentConfirmation(get(), confirmation, committingPlan, project)) return;
        void getModelJobStore().run();
      }

      set((current) => ({
        agentPlan: result.plan,
        confirmedModelJobs: countConfirmedModelJobs(modelJobs),
        modelJobs,
        undoStack: appendUndoEntry(current.undoStack, { transaction: result.inverse, memoryId: memoryEntry.id }),
      }));
    } finally {
      if (pendingAgentConfirmation?.token === confirmation.token) pendingAgentConfirmation = null;
    }
  },
  cancelAgentPlan: () => {
    if (isAgentPlanBusy(get().agentPlan)) {
      rejectAgentPlanMutationDuringProcessing(set);
      return;
    }
    clearPendingAgentConfirmation();
    set({ agentPlan: null });
  },
  prepareSkillCandidateReview: async (candidateId) => {
    await prepareSkillCandidateReviewForStore(get, set, candidateId, { markPreparing: true });
  },
  promoteProjectMemory: async (memoryId) => {
    let candidateId: string | null = null;
    const committed = await enqueueStableProjectOperation(set, get, async (commitNow) => {
      const state = get();
      if (state.project.skillPromotionCandidates.some((candidate) => candidate.sourceProjectMemoryId === memoryId)) return false;
      const memory = state.project.projectMemory.find((entry) => entry.id === memoryId);
      if (!memory || !isPromotableMemory(state.project.projectMemory, memory)) return false;

      const candidate = markSkillCandidatePreparing(withPromotionKnowledgeTarget(createSkillPromotionCandidate(memory, {
        candidateId: `skill-candidate-${Date.now()}-${planSequence++}`,
        createdAt: new Date().toISOString(),
      }), state.knowledgeBases), new Date().toISOString());
      candidateId = candidate.id;
      const candidates = [...state.project.skillPromotionCandidates, candidate];
      const project = { ...state.project, skillPromotionCandidates: candidates };
      const transaction: ProjectTransaction = {
        id: `skill-promotion-${candidate.id}`,
        label: 'Promote project memory candidate',
        operations: [{ kind: 'set_skill_candidates', candidates }],
      };
      return commitNow(transaction, { kind: 'system', nextProject: project });
    });
    if (!committed || candidateId === null) return;
    await prepareSkillCandidateReviewForStore(get, set, candidateId, { markPreparing: false });
  },
  retryModelJob: async (jobId) => {
    await getModelJobStore().retryJob(jobId);
    const modelJobs = await getModelJobStore().listJobs();
    set({ confirmedModelJobs: countConfirmedModelJobs(modelJobs), modelJobs });
    void getModelJobStore().run();
  },
  retryAgentPlanJobs: async () => {
    if (pendingAgentJobRetry !== null) return pendingAgentJobRetry;
    const retry = retryCommittedAgentPlanJobs(get, set);
    pendingAgentJobRetry = retry.finally(() => {
      if (pendingAgentJobRetry === retry) pendingAgentJobRetry = null;
    });
    return pendingAgentJobRetry;
  },
  recordUserFeedback: (input) => enqueueStableProjectOperation(set, get, async (commitNow) => {
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
    const candidate = createFeedbackSkillPromotionCandidate(memoryEntry, input, {
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
    return commitNow(transaction, { kind: 'agent', nextProject: project });
  }),
  restoreProjectSnapshot: async (snapshotId) => {
    const state = get();
    if (state.persistenceMode === 'desktop') {
      await enqueueStableProjectOperation(set, get, async () => {
        if (get().persistenceMode !== 'desktop') return false;
        const restored = await projectPersistenceClient.restore(snapshotId);
        const imageState = await readProjectImagesForHydration();
        invalidateProjectPersistenceBoundary();
        cancelPendingProjectSave();
        clearPendingFailedProjectCommit();
        set({
          availableSnapshotIds: restored.availableSnapshotIds,
          canReloadDurableProject: false,
          canRetryProjectCommit: false,
          desktopRevision: restored.revision,
          project: restored.project,
          projectLifecycle: restored.lifecycle,
          projectCommitConflictCode: null,
          recoveryRequired: restored.recoveryRequired === true,
          ...imageState,
          saveErrorCode: restored.recoveryRequired === true ? 'RECOVERY_REQUIRED' : null,
          saveStatus: restored.saveStatus,
        });
        return true;
      }, { allowRecovery: true });
      return;
    }

    const candidateBundle = loadPersistedProjectBundle();
    const candidateSnapshot = candidateBundle?.snapshots.find((entry) => entry.id === snapshotId);
    if (!candidateSnapshot || candidateSnapshot.project.id !== state.project.id) return;
    await enqueueStableProjectOperation(set, get, async (commitNow) => {
      const browserState = get();
      const bundle = loadPersistedProjectBundle();
      const snapshot = bundle?.snapshots.find((entry) => entry.id === snapshotId);
      if (!snapshot || snapshot.project.id !== browserState.project.id) return false;

      const currentProject = sanitizeProjectSkillPromotionCandidates(browserState.project);
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
      const saved = await commitNow(transaction, { kind: 'system', nextProject: project });
      if (saved) set({ agentPlan: null, undoStack: [] });
      return saved;
    });
  },
  undo: async () => {
    await enqueueStableProjectOperation(set, get, async (commitNow) => {
      const state = get();
      const undoEntry = state.undoStack[state.undoStack.length - 1];
      if (!undoEntry) return false;

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
      const saved = await commitNow(transaction, { kind: 'system', nextProject: project });
      if (saved) {
        set((current) => ({
          agentPlan: null,
          undoStack: current.undoStack.slice(0, -1),
        }));
      }
      return saved;
    });
  },
}));

async function importProjectImageWithTarget(target: ProjectImageImportTarget): Promise<boolean> {
  return enqueueStableProjectOperation(
    (partial) => useAppStore.setState(partial),
    () => useAppStore.getState(),
    async () => {
      const generation = projectPersistenceGeneration;
      const before = useAppStore.getState();
      if (
        before.projectImageImportingNodeId !== null
        || before.saveStatus === 'read_only'
        || before.canRetryProjectCommit
        || before.recoveryRequired
      ) return false;
      const node = before.project.nodes.find((candidate) => candidate.id === target.nodeId);
      if (node === undefined) return false;
      if (target.kind === 'module' && (
        node.type !== 'module'
        || (node.data.moduleType !== 'image_input' && node.data.moduleType !== 'upload_image')
      )) return false;
      if (target.kind === 'placement_reference' && node.type !== 'placement_preview') return false;

      const previousSaveStatus = before.saveStatus;
      useAppStore.setState({
        projectImageError: null,
        projectImageImportingNodeId: target.nodeId,
        saveErrorCode: null,
        saveStatus: 'saving',
      });
      try {
        const result = await projectPersistenceClient.importProjectImage(target);
        if (generation !== projectPersistenceGeneration || useAppStore.getState().project.id !== before.project.id) return false;
        if (result === null) {
          useAppStore.setState({
            projectImageImportingNodeId: null,
            saveStatus: previousSaveStatus,
          });
          return false;
        }
        const current = useAppStore.getState();
        useAppStore.setState({
          desktopRevision: result.revision,
          project: result.project,
          projectImages: upsertProjectImageSummary(current.projectImages, result.asset),
          projectImageError: null,
          projectImageImportingNodeId: null,
          saveErrorCode: null,
          saveStatus: 'saved',
        });
        return true;
      } catch (error) {
        const code = readErrorCode(error);
        if (code === 'REVISION_CONFLICT') {
          const hydrated = await projectPersistenceClient.hydrate().catch(() => null);
          if (generation !== projectPersistenceGeneration || useAppStore.getState().project.id !== before.project.id) return false;
          if (hydrated !== null) {
            const projectImages = await projectPersistenceClient.listProjectImages().catch(() => []);
            useAppStore.setState({
              availableSnapshotIds: hydrated.availableSnapshotIds,
              desktopRevision: hydrated.revision,
              persistenceMode: hydrated.mode,
              project: hydrated.project,
              projectLifecycle: hydrated.lifecycle,
              projectImages,
              projectImageError: code,
              projectImageImportingNodeId: null,
              saveErrorCode: code,
              saveStatus: 'error',
            });
            return false;
          }
        }
        if (generation !== projectPersistenceGeneration || useAppStore.getState().project.id !== before.project.id) return false;
        useAppStore.setState({
          projectImageError: code,
          projectImageImportingNodeId: null,
          saveErrorCode: code,
          saveStatus: 'error',
        });
        return false;
      }
    },
  );
}

function upsertProjectImageSummary(
  assets: readonly ProjectImageAssetSummary[],
  asset: ProjectImageAssetSummary,
): ProjectImageAssetSummary[] {
  return assets.some((candidate) => candidate.assetId === asset.assetId)
    ? assets.map((candidate) => candidate.assetId === asset.assetId ? asset : candidate)
    : [...assets, asset];
}

type CompatibleProjectPersistenceClient = Omit<
  ProjectPersistenceClient,
  'importProjectImage' | 'listProjectImages'
> & Partial<Pick<ProjectPersistenceClient, 'importProjectImage' | 'listProjectImages'>>;

export function replaceProjectPersistenceClientForTests(client: CompatibleProjectPersistenceClient): void {
  projectPersistenceClient = withProjectImagePersistenceDefaults(client);
}

function withProjectImagePersistenceDefaults(client: CompatibleProjectPersistenceClient): ProjectPersistenceClient {
  return {
    ...client,
    importProjectImage: client.importProjectImage ?? (async () => null),
    listProjectImages: client.listProjectImages ?? (async () => []),
  };
}

export function replaceKnowledgeClientForTests(client: KnowledgeClient): void {
  knowledgeClient.stop();
  knowledgeClient = client;
}

export function replaceModelJobExecutorForTests(executor: ModelJobExecutor): void {
  invalidateModelJobStoreGeneration();
  modelJobStore?.stop();
  modelJobExecutorOverride = executor;
  pendingModelJobExecutorOverride = executor;
  modelJobUnsubscribe?.();
  modelJobUnsubscribe = null;
  modelJobStore = null;
}

export function replaceModelJobStorageForTests(storage: ModelJobStorage): void {
  invalidateModelJobStoreGeneration();
  modelJobStore?.stop();
  modelJobStorageOverride = storage;
  modelJobUnsubscribe?.();
  modelJobUnsubscribe = null;
  modelJobStore = null;
}

function enqueueStableProjectOperation(
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
  operation: StableProjectOperation,
  options: { allowPendingFailure?: boolean; allowRecovery?: boolean } = {},
): Promise<boolean> {
  const generation = projectPersistenceGeneration;
  const run = async (): Promise<boolean> => {
    if (generation !== projectPersistenceGeneration) return false;
    if (!options.allowPendingFailure && pendingFailedProjectCommit !== null) return false;
    if (get().projectCommitConflictCode !== null || (!options.allowRecovery && get().recoveryRequired)) return false;
    return operation((transaction, commitOptions = {}) => (
      commitProjectTransactionNow(transaction, commitOptions, set, get)
    ));
  };
  const result = stableProjectCommitTail === null
    ? run()
    : stableProjectCommitTail.then(run);
  let tail: Promise<void>;
  const settled = result.finally(() => {
    if (stableProjectCommitTail === tail) stableProjectCommitTail = null;
  });
  tail = settled.then(() => undefined, () => undefined);
  stableProjectCommitTail = tail;
  return settled;
}

async function commitProjectTransactionNow(
  transaction: ProjectTransaction,
  options: CommitProjectTransactionNowOptions,
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
): Promise<boolean> {
  cancelPendingProjectSave();
  if (options.retryRequest !== undefined) {
    const request = options.retryRequest;
    if (
      pendingFailedProjectCommit !== request
      || !get().canRetryProjectCommit
      || get().saveStatus === 'read_only'
      || get().recoveryRequired
    ) return false;
    set({ canRetryProjectCommit: false, saveErrorCode: null, saveStatus: 'saving' });
    return executeProjectCommit(request, set, get, true);
  }
  if (pendingFailedProjectCommit !== null) return false;
  if (get().projectCommitConflictCode !== null || get().recoveryRequired) return false;
  const before = get().project;
  const nextProject = options.nextProject ?? applyProjectTransaction(before, transaction);
  const kind = options.kind ?? 'canvas';
  if (get().saveStatus === 'read_only') {
    set({ project: before, saveErrorCode: 'CONCURRENT_WRITER', saveStatus: 'read_only' });
    return false;
  }

  const request: ProjectCommitRequest = {
    baseRevision: get().desktopRevision,
    kind,
    nextProject,
    previousProject: before,
    projectId: before.id,
    transaction,
  };
  set({
    canReloadDurableProject: false,
    canRetryProjectCommit: false,
    project: nextProject,
    projectCommitConflictCode: null,
    saveErrorCode: null,
    saveStatus: 'saving',
  });
  return executeProjectCommit(request, set, get);
}

export function resetAppStoreForTests(options: { project?: 'empty' | 'starter' } = { project: 'starter' }): void {
  invalidateProjectPersistenceBoundary();
  cancelPendingProjectSave();
  clearPendingFailedProjectCommit();
  pendingProjectFlushBoundary = null;
  clearPendingAgentConfirmation();
  pendingAgentJobRetry = null;
  stableProjectCommitTail = null;
  invalidateModelJobStoreGeneration();
  modelJobStore?.stop();
  modelJobUnsubscribe?.();
  modelJobUnsubscribe = null;
  modelJobStore = null;
  modelJobExecutorOverride = pendingModelJobExecutorOverride;
  pendingModelJobExecutorOverride = null;
  knowledgeClient.stop();
  const state = createInitialState();
  useAppStore.setState(options.project === 'empty'
    ? state
    : { ...state, project: createStarterProject(), projectLifecycle: 'durable', saveStatus: 'pending' });
}

function getModuleNode(nodes: readonly CanvasProject['nodes'][number][], nodeId: string): CanvasModuleNode | undefined {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  return node?.type === 'module' ? node : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFinitePosition(value: { x: number; y: number }): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y);
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasExactModuleEdge(
  edges: readonly CanvasProject['edges'][number][],
  sourceId: string,
  sourcePortId: string,
  targetId: string,
  targetPortId: string,
): boolean {
  return edges.some((edge) => (
    edge.source === sourceId
    && edge.sourcePortId === sourcePortId
    && edge.target === targetId
    && edge.targetPortId === targetPortId
  ));
}

function wouldCreateModuleCycle(
  nodes: readonly CanvasProject['nodes'][number][],
  edges: readonly CanvasProject['edges'][number][],
  sourceId: string,
  targetId: string,
): boolean {
  if (sourceId === targetId) return true;
  const moduleIds = new Set(nodes.filter((node) => node.type === 'module').map((node) => node.id));
  const adjacency = new Map<string, string[]>();
  for (const nodeId of moduleIds) adjacency.set(nodeId, []);
  for (const edge of edges) {
    if (!moduleIds.has(edge.source) || !moduleIds.has(edge.target)) continue;
    adjacency.get(edge.source)?.push(edge.target);
  }

  const visited = new Set<string>();
  const pending = [targetId];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === sourceId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) pending.push(next);
  }
  return false;
}

function createModuleEdgeId(
  existingIds: readonly string[],
  input: { sourceId: string; sourcePortId: string; targetId: string; targetPortId: string; order: number },
): string {
  const existing = new Set(existingIds);
  const base = `module-edge-${input.sourceId}-${input.sourcePortId}-${input.targetId}-${input.targetPortId}-${input.order}`;
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

async function executeProjectCommit(
  request: ProjectCommitRequest,
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
  retryRequest = false,
): Promise<boolean> {
  const token = beginProjectCommit(request);
  try {
    const result = await projectPersistenceClient.commit(request);
    if (!isActiveProjectCommit(token, get)) return false;
    if (retryRequest
      ? pendingFailedProjectCommit !== request
      : pendingFailedProjectCommit !== null && pendingFailedProjectCommit !== request) return false;
    if (!result.ok && (result.code === 'REVISION_CONFLICT' || result.code === 'CONCURRENT_WRITER')) {
      clearPendingFailedProjectCommit();
      set({
        canReloadDurableProject: true,
        canRetryProjectCommit: false,
        desktopRevision: result.revision,
        project: request.nextProject,
        projectCommitConflictCode: result.code,
        saveErrorCode: result.code,
        saveStatus: 'error',
      });
      return false;
    }
    return applyCommitResult(set, get, result, request);
  } finally {
    if (activeProjectCommitToken === token) activeProjectCommitToken = null;
  }
}

function applyCommitResult(
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
  result: ProjectCommitResult,
  request: ProjectCommitRequest,
): boolean {
  const availableSnapshotIds = get().persistenceMode === 'browser'
    ? readAvailableSnapshotIds()
    : get().availableSnapshotIds;
  if (result.ok) {
    clearPendingFailedProjectCommit();
    set({
      availableSnapshotIds,
      canReloadDurableProject: false,
      canRetryProjectCommit: false,
      desktopRevision: result.revision,
      project: result.project,
      projectCommitConflictCode: null,
      saveErrorCode: null,
      saveStatus: get().projectLifecycle === 'untitled' ? 'pending' : 'saved',
    });
    return true;
  }

  pendingFailedProjectCommit = request;
  set({
    availableSnapshotIds,
    canReloadDurableProject: false,
    canRetryProjectCommit: true,
    desktopRevision: result.revision,
    project: request.nextProject,
    projectCommitConflictCode: null,
    saveErrorCode: result.code,
    saveStatus: 'error',
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
  projectAutosave.cancel();
}

function clearPendingFailedProjectCommit(): void {
  pendingFailedProjectCommit = null;
}

function beginProjectCommit(request: ProjectCommitRequest): ProjectCommitToken {
  const token = {
    generation: projectPersistenceGeneration,
    projectId: request.projectId,
    request,
  };
  activeProjectCommitToken = token;
  return token;
}

function isActiveProjectCommit(token: ProjectCommitToken, get: () => AppState): boolean {
  return activeProjectCommitToken === token
    && token.generation === projectPersistenceGeneration
    && token.request.projectId === token.projectId
    && get().project === token.request.nextProject;
}

function invalidateActiveProjectCommit(): ProjectCommitRequest | null {
  const request = activeProjectCommitToken?.request ?? null;
  invalidateProjectPersistenceBoundary();
  return request;
}

function invalidateProjectPersistenceBoundary(): void {
  projectPersistenceGeneration += 1;
  activeProjectCommitToken = null;
  stableProjectCommitTail = null;
}

async function readProjectImagesForHydration(): Promise<Pick<AppState, 'projectImages' | 'projectImageError'>> {
  try {
    return {
      projectImages: await projectPersistenceClient.listProjectImages(),
      projectImageError: null,
    };
  } catch (error) {
    return {
      projectImages: [],
      projectImageError: readErrorCode(error),
    };
  }
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

function createInitialState(): Pick<AppState, 'project' | 'projectLifecycle' | 'projectImages' | 'projectImageError' | 'projectImageImportingNodeId' | 'persistenceMode' | 'desktopRevision' | 'availableSnapshotIds' | 'canReloadDurableProject' | 'canRetryProjectCommit' | 'projectCommitConflictCode' | 'recoveryRequired' | 'knowledgeBases' | 'knowledgeSyncStatuses' | 'saveStatus' | 'saveErrorCode' | 'agentPanelCollapsed' | 'activeTool' | 'agentPlan' | 'undoStack' | 'confirmedModelJobs' | 'modelJobs'> {
  const desktopMode = isDesktopBridgeAvailable();
  return {
    activeTool: 'select',
    agentPanelCollapsed: false,
    agentPlan: null,
    availableSnapshotIds: [],
    canReloadDurableProject: false,
    canRetryProjectCommit: false,
    confirmedModelJobs: 0,
    desktopRevision: 0,
    knowledgeBases: [],
    knowledgeSyncStatuses: [],
    modelJobs: [],
    persistenceMode: desktopMode ? 'desktop' : 'browser',
    project: createUntitledProject(),
    projectCommitConflictCode: null,
    recoveryRequired: false,
    projectLifecycle: 'untitled',
    projectImages: [],
    projectImageError: null,
    projectImageImportingNodeId: null,
    saveErrorCode: null,
    saveStatus: 'pending',
    undoStack: [],
  };
}

function countConfirmedModelJobs(jobs: ModelJob[]): number {
  return jobs.filter((job) => job.status === 'queued' || job.status === 'submitting' || job.status === 'running').length;
}

function getModelJobStore(): ModelJobStore {
  if (!modelJobStore) {
    const generation = modelJobStoreGeneration;
    modelJobStore = createModelJobStore({
      decodeConcurrency: runtimeProfile.imageDecodeConcurrency,
      storage: modelJobStorageOverride ?? (isIndexedDbAvailable() ? undefined : createInMemoryModelJobStorage()),
      executor: modelJobExecutorOverride ?? createDefaultModelJobExecutor(),
      commitProjectTransaction: (transaction) => {
        if (generation !== modelJobStoreGeneration) return Promise.resolve(false);
        return useAppStore.getState().commitProjectTransaction(transaction, { kind: 'agent' });
      },
      getProject: () => useAppStore.getState().project,
      pollConcurrency: runtimeProfile.providerPollConcurrency,
      pollIntervalMs: isIndexedDbAvailable() ? undefined : 0,
    });
    modelJobUnsubscribe = modelJobStore.subscribe((modelJobs) => {
      if (generation !== modelJobStoreGeneration) return;
      useAppStore.setState({
        confirmedModelJobs: countConfirmedModelJobs(modelJobs),
        modelJobs,
      });
    });
  }
  return modelJobStore;
}

function recoverModelJobsInBackground(jobStore: ModelJobStore): void {
  const generation = ++modelJobRecoveryGeneration;
  void jobStore.recover()
    .then(async () => {
      if (generation !== modelJobRecoveryGeneration || jobStore !== modelJobStore) return;
      const modelJobs = await jobStore.listJobs();
      if (generation !== modelJobRecoveryGeneration || jobStore !== modelJobStore) return;
      useAppStore.setState({
        confirmedModelJobs: countConfirmedModelJobs(modelJobs),
        modelJobs,
      });
    })
    .catch(() => {
      // Recovery is retried on the next hydrate/run; job-level failures are persisted by the job store.
    });
}

function invalidateModelJobStoreGeneration(): void {
  modelJobStoreGeneration += 1;
  modelJobRecoveryGeneration += 1;
}

function createUnavailableModelJobExecutor(): ModelJobExecutor {
  return {
    submit: async () => {
      throw new Error('模型执行桥尚未连接');
    },
    poll: async () => ({ status: 'failed', error: '模型执行桥尚未连接' }),
    cancel: async () => {},
  };
}

function createDefaultModelJobExecutor(): ModelJobExecutor {
  return {
    submit: async (job) => selectProductionModelJobExecutor().submit(job),
    poll: async (job) => selectProductionModelJobExecutor().poll(job),
    cancel: async (job) => await selectProductionModelJobExecutor().cancel?.(job),
    ackTerminal: async (job) => {
      await selectProductionModelJobExecutor().ackTerminal?.(job);
    },
  };
}

function selectProductionModelJobExecutor(): ModelJobExecutor {
  return isDesktopProviderBridgeAvailable()
    ? createDesktopModelJobExecutor()
    : createUnavailableModelJobExecutor();
}

interface ResolvedModelJobProfile {
  provider: string;
  modelRoute: string;
  displayName: string;
  modelId?: string;
}

function buildModelJobRequests(
  project: CanvasProject,
  plan: AgentCanvasPlan,
  profile: ResolvedModelJobProfile,
): ModelJobRequest[] {
  const promptNode = project.nodes.find((node) => node.type === 'prompt');
  const prompt = promptNode?.type === 'prompt' ? promptNode.data.prompt : plan.transaction.label;
  const referenceSnapshot = plan.referenceSnapshot
    ?? createExecutionReferenceSnapshot(collectExecutionReferences(project), 0);
  return Array.from({ length: Math.max(0, plan.jobCount) }, () => ({
    id: createModelJobRunId(),
    promptNodeId: promptNode?.id ?? 'prompt-start',
    prompt,
    provider: profile.provider,
    modelRoute: profile.modelRoute,
    displayName: profile.displayName,
    modelId: profile.modelId ?? profile.modelRoute,
    referenceAssetIds: referenceSnapshot.references.map((reference) => reference.assetId),
    referenceSnapshotRevision: referenceSnapshot.projectRevision,
    referenceSnapshotFingerprint: referenceSnapshot.fingerprint,
  }));
}

async function resolveModelJobProfile(plan: AgentCanvasPlan): Promise<ResolvedModelJobProfile> {
  const bridge = globalThis.window?.novusDesktop?.provider;
  if (bridge === undefined) {
    throw new Error('Provider image model profile is unavailable');
  }
  const profiles = await bridge.listProfiles();
  const imageProfiles = filterImageModelProfiles(profiles);
  const requestedRoute = normalizeLegacyPlanModelRoute(plan.modelRoute);
  const selected = requestedRoute === undefined
    ? imageProfiles[0]
    : imageProfiles.find((profile) => profile.modelRoute === requestedRoute || profile.modelId === requestedRoute);
  if (selected === undefined) {
    throw new Error('Provider image model profile is unconfigured');
  }
  return {
    provider: selected.provider,
    modelRoute: selected.modelRoute,
    displayName: selected.displayName,
    modelId: selected.modelId,
  };
}

function filterImageModelProfiles(profiles: ProviderBridgeProfile[]): ProviderBridgeProfile[] {
  return profiles.filter((profile) => (
    profile.capabilities.includes('image_generation')
  ));
}

function shouldExecuteModels(plan: AgentCanvasPlan): boolean {
  return plan.requestedCapabilities.includes('model_execution') && Boolean(plan.confirmations.models);
}

function modelProfileConflictMessage(_error: unknown): string {
  return 'model profile unavailable: selected provider profile is unavailable or changed';
}

function modelQueueConflictMessage(): string {
  return 'model queue unavailable: retry model enqueue after the current commit settles';
}

function modelQueueRetryConflictMessage(): string {
  return 'model queue retry unavailable: retry model tasks again';
}

function isModelProfileConflict(conflict: string): boolean {
  return /^model profile unavailable:/i.test(conflict);
}

function isModelQueueConflict(conflict: string): boolean {
  return /^model queue (?:retry )?unavailable:/i.test(conflict);
}

function upsertAgentConflict(conflicts: string[], nextConflict: string): string[] {
  return [
    ...conflicts.filter((conflict) => {
      if (isModelProfileConflict(nextConflict)) return !isModelProfileConflict(conflict);
      if (isModelQueueConflict(nextConflict)) return !isModelQueueConflict(conflict);
      return conflict !== nextConflict;
    }),
    nextConflict,
  ];
}

function normalizeLegacyPlanModelRoute(route: string | undefined): string | undefined {
  if (route === undefined || route === 'desktop-bridge' || route.startsWith('Comfly ')) return undefined;
  return route;
}

async function retryCommittedAgentPlanJobs(
  get: () => AppState,
  set: (partial: Partial<AppState> | ((state: AppState) => Partial<AppState> | AppState)) => void,
): Promise<void> {
  const state = get();
  const plan = state.agentPlan;
  if (plan === null || plan.state !== 'waiting_for_job_retry') return;
  const profile = resolveCommittedModelJobProfile(plan);
  if (profile === null) {
    set((current) => (
      current.agentPlan?.id === plan.id && current.agentPlan.state === 'waiting_for_job_retry'
        ? {
            agentPlan: {
              ...current.agentPlan,
              conflicts: upsertAgentConflict(current.agentPlan.conflicts, modelProfileConflictMessage(null)),
            },
          }
        : current
    ));
    return;
  }

  try {
    const modelJobs = await getModelJobStore().enqueueConfirmedJobs({
      conversationId: plan.modelConversationId ?? AGENT_MODEL_CONVERSATION_ID,
      confirmedAt: plan.confirmations.models ?? plan.confirmations.canvas ?? new Date().toISOString(),
      requests: buildModelJobRequests(state.project, plan, profile),
    });
    const latest = get();
    if (latest.agentPlan?.id !== plan.id || latest.agentPlan.state !== 'waiting_for_job_retry') return;
    set({
      agentPlan: {
        ...latest.agentPlan,
        state: 'reviewing_results',
        conflicts: latest.agentPlan.conflicts.filter((conflict) => !isModelQueueConflict(conflict)),
      },
      confirmedModelJobs: countConfirmedModelJobs(modelJobs),
      modelJobs,
    });
    void getModelJobStore().run();
  } catch {
    set((current) => (
      current.agentPlan?.id === plan.id && current.agentPlan.state === 'waiting_for_job_retry'
        ? {
            agentPlan: {
              ...current.agentPlan,
              conflicts: upsertAgentConflict(current.agentPlan.conflicts, modelQueueRetryConflictMessage()),
            },
          }
        : current
    ));
  }
}

function bindSkillCandidateReviewRequest(
  state: AppState,
  request: Parameters<KnowledgeClient['review']>[0],
): Parameters<KnowledgeClient['review']>[0] {
  const candidate = state.project.skillPromotionCandidates.find((item) => item.id === request.candidateId);
  if (
    candidate === undefined ||
    candidate.reviewStatus !== 'pending_review' ||
    candidate.reviewPreparationStatus !== 'ready' ||
    candidate.sourceRule === undefined ||
    candidate.managedRule === undefined ||
    candidate.diffHunks === undefined ||
    candidate.diffHunks.length === 0 ||
    candidate.preparedManagedSnapshot === undefined
  ) {
    return request;
  }
  return {
    ...request,
    baseRevision: state.desktopRevision,
    candidateFingerprint: createSkillPromotionCandidateFingerprint(candidate),
    preparedManagedSnapshot: candidate.preparedManagedSnapshot,
  };
}

async function prepareSkillCandidateReviewForStore(
  get: () => AppState,
  set: (partial: Partial<AppState> | ((state: AppState) => Partial<AppState> | AppState)) => void,
  candidateId: string,
  options: { markPreparing: boolean },
): Promise<void> {
  if (options.markPreparing) {
    const committed = await enqueueStableProjectOperation(set, get, async (commitNow) => {
      const state = get();
      const candidate = findPreparingCandidate(state.project.skillPromotionCandidates, candidateId);
      if (candidate === null) return false;
      const preparing = markSkillCandidatePreparing(candidate, new Date().toISOString());
      const candidates = replaceSkillCandidate(state.project.skillPromotionCandidates, preparing);
      const project = { ...state.project, skillPromotionCandidates: candidates };
      return commitNow({
        id: `prepare-skill-preview-${candidateId}-${Date.now()}`,
        label: 'Prepare skill candidate preview',
        operations: [{ kind: 'set_skill_candidates', candidates }],
      }, { kind: 'system', nextProject: project });
    });
    if (!committed) return;
  }

  const state = get();
  const candidate = findPreparingCandidate(state.project.skillPromotionCandidates, candidateId);
  if (candidate === null) return;
  const baseRevision = state.desktopRevision;
  const candidateFingerprint = createSkillPromotionCandidateFingerprint(candidate);

  try {
    const prepared = await knowledgeClient.prepareSkillCandidateReview({
      baseRevision,
      candidateFingerprint,
      projectId: state.project.id,
      candidateId,
    });
    set((current) => {
      if (!canApplyPreparedSkillCandidate(current, candidateId, baseRevision, candidateFingerprint)) return {};
      const currentCandidate = current.project.skillPromotionCandidates.find((item) => item.id === candidateId);
      const preparedCandidate = prepared.candidates.find((item) => item.id === candidateId) ?? prepared.candidate;
      if (
        currentCandidate === undefined ||
        prepared.projectId !== current.project.id ||
        preparedCandidate.id !== candidateId ||
        preparedCandidate.reviewStatus !== 'pending_review' ||
        preparedCandidate.reviewedAt !== undefined ||
        preparedCandidate.reviewTransactionId !== undefined ||
        !preparedCandidate.sourceRule ||
        !preparedCandidate.managedRule ||
        !preparedCandidate.diffHunks ||
        preparedCandidate.diffHunks.length === 0
      ) {
        return {};
      }
      const ready = markSkillCandidateReady(preparedCandidate, currentCandidate);
      return {
        desktopRevision: prepared.currentRevision,
        knowledgeBases: prepared.knowledgeState
          ? upsertKnowledgeSummary(current.knowledgeBases, prepared.knowledgeState)
          : current.knowledgeBases,
        project: {
          ...current.project,
          skillPromotionCandidates: replaceSkillCandidate(current.project.skillPromotionCandidates, ready),
        },
      };
    });
  } catch (error) {
    if (isStaleSkillPreparationError(error)) return;
    await persistSkillCandidatePreparationFailure(
      get,
      set,
      candidateId,
      baseRevision,
      candidateFingerprint,
      sanitizeSkillPreparationError(error),
    );
  }
}

async function persistSkillCandidatePreparationFailure(
  get: () => AppState,
  set: (partial: Partial<AppState> | ((state: AppState) => Partial<AppState> | AppState)) => void,
  candidateId: string,
  baseRevision: number,
  candidateFingerprint: string,
  error: string,
): Promise<void> {
  await enqueueStableProjectOperation(set, get, async (commitNow) => {
    const state = get();
    if (!canApplyPreparedSkillCandidate(state, candidateId, baseRevision, candidateFingerprint)) return false;
    const candidate = state.project.skillPromotionCandidates.find((item) => item.id === candidateId);
    if (candidate === undefined) return false;
    const failed = markSkillCandidatePreparationFailed(candidate, error);
    const candidates = replaceSkillCandidate(state.project.skillPromotionCandidates, failed);
    const project = { ...state.project, skillPromotionCandidates: candidates };
    return commitNow({
      id: `prepare-skill-preview-failed-${candidateId}-${Date.now()}`,
      label: 'Record skill candidate preview failure',
      operations: [{ kind: 'set_skill_candidates', candidates }],
    }, { kind: 'system', nextProject: project });
  });
}

function findPreparingCandidate(candidates: SkillPromotionCandidate[], candidateId: string): SkillPromotionCandidate | null {
  const candidate = candidates.find((item) => item.id === candidateId);
  if (
    candidate === undefined ||
    candidate.reviewStatus !== 'pending_review' ||
    candidate.reviewedAt !== undefined ||
    candidate.reviewTransactionId !== undefined
  ) {
    return null;
  }
  return candidate;
}

function canApplyPreparedSkillCandidate(
  state: AppState,
  candidateId: string,
  baseRevision: number,
  candidateFingerprint: string,
): boolean {
  if (state.desktopRevision !== baseRevision) return false;
  const candidate = findPreparingCandidate(state.project.skillPromotionCandidates, candidateId);
  return candidate !== null && createSkillPromotionCandidateFingerprint(candidate) === candidateFingerprint;
}

function markSkillCandidatePreparing(candidate: SkillPromotionCandidate, startedAt: string): SkillPromotionCandidate {
  const {
    diffHunks: _diffHunks,
    managedRule: _managedRule,
    reviewPreparationError: _reviewPreparationError,
    sourceRule: _sourceRule,
    ...rest
  } = candidate;
  return skillPromotionCandidateSchema.parse({
    ...rest,
    reviewPreparationStatus: 'preparing',
    reviewPreparationStartedAt: startedAt,
  });
}

function markSkillCandidateReady(
  prepared: SkillPromotionCandidate,
  current: SkillPromotionCandidate,
): SkillPromotionCandidate {
  const { reviewPreparationError: _reviewPreparationError, ...rest } = prepared;
  return skillPromotionCandidateSchema.parse({
    ...rest,
    reviewPreparationStatus: 'ready',
    reviewPreparationStartedAt: current.reviewPreparationStartedAt ?? prepared.reviewPreparationStartedAt,
  });
}

function markSkillCandidatePreparationFailed(candidate: SkillPromotionCandidate, error: string): SkillPromotionCandidate {
  const {
    diffHunks: _diffHunks,
    managedRule: _managedRule,
    sourceRule: _sourceRule,
    ...rest
  } = candidate;
  return skillPromotionCandidateSchema.parse({
    ...rest,
    reviewPreparationStatus: 'failed',
    reviewPreparationError: error,
  });
}

function replaceSkillCandidate(
  candidates: SkillPromotionCandidate[],
  nextCandidate: SkillPromotionCandidate,
): SkillPromotionCandidate[] {
  return candidates.map((candidate) => candidate.id === nextCandidate.id ? nextCandidate : candidate);
}

function isStaleSkillPreparationError(error: unknown): boolean {
  return isRecord(error) && (error.code === 'REVISION_CONFLICT' || error.code === 'CONCURRENT_WRITER');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function readErrorCode(error: unknown): string {
  if (isRecord(error) && typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(error.code)) {
    return error.code;
  }
  return 'PROJECT_IMAGE_UNAVAILABLE';
}

function sanitizeSkillPreparationError(error: unknown): string {
  const message = error instanceof Error && error.message.trim().length > 0
    ? error.message
    : 'Skill review preview is unavailable';
  if (containsProtectedRendererPayload(message)) {
    return 'Skill review preview is unavailable';
  }
  return message.slice(0, 500);
}

function resolveCommittedModelJobProfile(plan: AgentCanvasPlan): ResolvedModelJobProfile | null {
  if (plan.modelProvider === undefined || plan.modelRoute === undefined) return null;
  return {
    provider: plan.modelProvider,
    modelRoute: plan.modelRoute,
    displayName: plan.modelRouteDisplayName ?? plan.modelRoute,
    modelId: plan.modelId ?? plan.modelRoute,
  };
}

function clearPendingAgentConfirmation(): void {
  pendingAgentConfirmation = null;
}

function isAgentPlanBusy(plan: AgentCanvasPlan | null): boolean {
  return plan?.state === 'confirming' || plan?.state === 'committing';
}

function rejectAgentPlanMutationDuringProcessing(set: (partial: Partial<AppState> | ((state: AppState) => Partial<AppState> | AppState)) => void): void {
  set((state) => {
    const plan = state.agentPlan;
    if (!isAgentPlanBusy(plan) || plan === null) return state;
    return {
      agentPlan: {
        ...plan,
        conflicts: upsertAgentConflict(plan.conflicts, 'agent plan is already processing'),
      },
    };
  });
}

function restoreWaitingPlanAfterCommitFailure(
  set: (partial: Partial<AppState> | ((state: AppState) => Partial<AppState> | AppState)) => void,
  confirmation: PendingAgentConfirmation,
  plan: AgentCanvasPlan,
): void {
  set((state) => {
    if (pendingAgentConfirmation?.token !== confirmation.token || state.agentPlan?.id !== confirmation.planId) return state;
    return {
      agentPlan: {
        ...plan,
        state: 'waiting_for_confirmation',
        conflicts: upsertAgentConflict(plan.conflicts, 'agent commit unavailable: retry confirmation'),
      },
    };
  });
}

function restoreWaitingPlanAfterStaleConfirmation(
  set: (partial: Partial<AppState> | ((state: AppState) => Partial<AppState> | AppState)) => void,
  confirmation: PendingAgentConfirmation,
  plan: AgentCanvasPlan,
): void {
  set((state) => {
    if (pendingAgentConfirmation?.token !== confirmation.token || state.agentPlan?.id !== confirmation.planId) return state;
    if (state.agentPlan.state !== 'confirming') return state;
    return {
      agentPlan: {
        ...plan,
        state: 'waiting_for_confirmation',
        conflicts: upsertAgentConflict(plan.conflicts, 'agent confirmation is stale: refresh and retry'),
      },
    };
  });
}

function isActiveAgentConfirmation(
  state: AppState,
  confirmation: PendingAgentConfirmation,
  allowedStates: AgentCanvasPlan['state'][],
): boolean {
  const plan = state.agentPlan;
  return pendingAgentConfirmation?.token === confirmation.token
    && plan !== null
    && allowedStates.includes(plan.state)
    && plan.id === confirmation.planId
    && plan.transaction.id === confirmation.transactionId
    && createAgentConfirmationFingerprint(state, plan) === confirmation.fingerprint;
}

function isActiveCommittedAgentConfirmation(
  state: AppState,
  confirmation: PendingAgentConfirmation,
  plan: AgentCanvasPlan,
  expectedProject: CanvasProject,
): boolean {
  const activePlan = state.agentPlan;
  return pendingAgentConfirmation?.token === confirmation.token
    && activePlan !== null
    && activePlan.state === 'committing'
    && activePlan.id === confirmation.planId
    && activePlan.transaction.id === confirmation.transactionId
    && createAgentCommittedFingerprint(state.project, activePlan) === createAgentCommittedFingerprint(expectedProject, plan);
}

function createAgentConfirmationFingerprint(state: AppState, plan: AgentCanvasPlan): string {
  return JSON.stringify({
    project: createExecutionSemanticProjectIdentity(state.project),
    transactionId: plan.transaction.id,
  });
}

function createAgentCommittedFingerprint(project: CanvasProject, plan: AgentCanvasPlan): string {
  return JSON.stringify({
    project: createExecutionSemanticProjectIdentity(project),
    transactionId: plan.transaction.id,
  });
}

function createExecutionSemanticProjectIdentity(project: CanvasProject): unknown {
  return {
    ...project,
    nodes: project.nodes.map((node) => {
      const { position: _position, locked: _locked, ...semanticNode } = node;
      if (semanticNode.type !== 'placement_preview') return semanticNode;
      return {
        ...semanticNode,
        data: {
          ...semanticNode.data,
          objects: [...semanticNode.data.objects].sort((left, right) => left.id.localeCompare(right.id)),
        },
      };
    }),
    edges: [...project.edges].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function appendUndoEntry(undoStack: UndoEntry[], entry: UndoEntry): UndoEntry[] {
  if (undoStack.some((item) => item.transaction.id === entry.transaction.id && item.memoryId === entry.memoryId)) {
    return undoStack;
  }
  return [...undoStack, entry];
}

function isIndexedDbAvailable(): boolean {
  return typeof globalThis.indexedDB !== 'undefined';
}

function isDesktopBridgeAvailable(): boolean {
  return globalThis.window?.novusDesktop !== undefined;
}

function isDesktopProviderBridgeAvailable(): boolean {
  return globalThis.window?.novusDesktop?.provider !== undefined;
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

function collectExecutionReferences(project: CanvasProject): OrderedReference[] {
  const placement = project.nodes.find((node) => node.type === 'placement_preview');
  const placementReferences = placement?.type === 'placement_preview'
    ? placement.data.objects
      .filter((object) => !object.assetId.startsWith('starter-'))
      .map((object, position) => ({
        assetId: object.assetId,
        label: object.name?.trim() || object.assetId,
        role: object.role,
        position,
      }))
    : [];
  if (placementReferences.length > 0) return placementReferences;
  return project.nodes.flatMap((node) => node.type === 'reference'
    ? [{
        assetId: node.data.assetId,
        label: node.data.assetId,
        role: node.data.role,
        position: 0,
      }]
    : []).map((reference, position) => ({ ...reference, position }));
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

function createFeedbackSkillPromotionCandidate(
  memory: ProjectMemoryEntry,
  input: RecordUserFeedbackInput,
  metadata: { candidateId: string; createdAt: string },
): SkillPromotionCandidate {
  const target = resolveFeedbackKnowledgeTarget(input.knowledgeLease);
  return skillPromotionCandidateSchema.parse({
    ...createSkillPromotionCandidate(memory, metadata),
    targetKnowledgeBaseId: target.knowledgeBaseId,
    targetKnowledgeSection: target.section,
    counts: {
      supportingMemoryCount: 1,
      referenceCount: new Set(input.references.map((reference) => reference.assetId)).size,
      citationCount: new Set(input.citations.map((citation) => citation.assetId)).size,
      observationCount: Object.values(input.observations ?? {}).reduce((sum, observations) => sum + observations.length, 0),
    },
    confidence: 1,
    affectedCapabilities: [input.knowledgeLease.capability],
  });
}

function withPromotionKnowledgeTarget(
  candidate: SkillPromotionCandidate,
  knowledgeBases: KnowledgeBaseStateSummary[],
): SkillPromotionCandidate {
  if (candidate.targetKnowledgeBaseId !== undefined) return candidate;
  const target = knowledgeBases.find((state) => state.status === 'active' && state.activeVersion !== null)
    ?? knowledgeBases.find((state) => state.status !== 'empty');
  if (target === undefined) return candidate;
  return skillPromotionCandidateSchema.parse({
    ...candidate,
    targetKnowledgeBaseId: target.knowledgeBaseId,
    targetKnowledgeSection: 'composition/placement',
  });
}

function resolveFeedbackKnowledgeTarget(lease: AgentKnowledgeLease): {
  knowledgeBaseId: string;
  section: string;
} {
  if (lease.capability === 'reverse_prompt') {
    return { knowledgeBaseId: 'scene-skill', section: 'reverse-prompt/feedback' };
  }
  const capabilitySlug = lease.capability.replace(/_/g, '-');
  return {
    knowledgeBaseId: lease.snapshots[0]?.knowledgeBaseId ?? `${capabilitySlug}-skill`,
    section: `${capabilitySlug}/feedback`,
  };
}

function containsProtectedRendererPayload(value: unknown): boolean {
  if (typeof value === 'string') {
    return /data:image\/[^;]+;base64,/i.test(value)
      || /base64,[a-z0-9+/=]{16,}/i.test(value)
      || /authorization\s*:\s*\S+/i.test(value)
      || /(?:api[_ -]?key|token|secret|password)\s*[:=]\s*\S{8,}/i.test(value)
      || /\bsk-[a-z0-9_-]{8,}\b/i.test(value)
      || /[a-zA-Z]:[\\/]/.test(value)
      || /\\\\[^\\\s]+\\/.test(value)
      || /file:\/\//i.test(value)
      || /(?:^|\s)\/(?:Users|home)\//.test(value)
      || /(?:^|[\s"'(])\/(?!\/|\s)(?:[^/\s]+(?:\/[^/\s]*)*)/.test(value)
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

function upsertKnowledgeSyncStatus(
  statuses: KnowledgeSyncStatusSummary[],
  nextStatus: KnowledgeSyncStatusSummary,
): KnowledgeSyncStatusSummary[] {
  return [
    ...statuses.filter((status) => status.knowledgeBaseId !== nextStatus.knowledgeBaseId),
    { ...nextStatus, lastFailure: nextStatus.lastFailure === null ? null : { ...nextStatus.lastFailure } },
  ].sort((left, right) => left.knowledgeBaseId.localeCompare(right.knowledgeBaseId));
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
  const state = get();
  projectAutosave.schedule({
    project: state.project,
    revision: state.desktopRevision,
  });
}

async function flushPendingProjectSave(
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
  reason: Exclude<AutosaveFlushReason, 'idle'>,
): Promise<boolean> {
  if (get().recoveryRequired) return false;
  if (pendingFailedProjectCommit !== null) return false;
  if (pendingProjectFlushBoundary !== null) return pendingProjectFlushBoundary;

  const hadDraft = projectAutosave.hasPending() || projectAutosave.hasInFlight();
  const flushBoundary = (async () => {
    const saved = hadDraft ? await projectAutosave.flush(reason) : false;
    if (get().saveStatus === 'read_only') return saved;
    if (hadDraft && !saved) return false;

    return enqueueStableProjectOperation(set, get, async () => {
      const generation = projectPersistenceGeneration;
      const projectId = get().project.id;
      const stablePoint = await projectPersistenceClient.stablePoint();
      if (generation !== projectPersistenceGeneration || get().project.id !== projectId) return false;
      const state = get();
      set({
        availableSnapshotIds: stablePoint.availableSnapshotIds,
        desktopRevision: stablePoint.revision,
        project: saved ? stablePoint.project : state.project,
        saveErrorCode: null,
        saveStatus: state.projectLifecycle === 'untitled'
          ? 'pending'
          : saved || state.saveStatus === 'saved' ? 'saved' : state.saveStatus,
      });
      return true;
    });
  })();
  const trackedFlushBoundary = flushBoundary.finally(() => {
    if (pendingProjectFlushBoundary === trackedFlushBoundary) pendingProjectFlushBoundary = null;
  });
  pendingProjectFlushBoundary = trackedFlushBoundary;
  return trackedFlushBoundary;
}
