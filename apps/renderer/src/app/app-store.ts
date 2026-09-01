import { create } from 'zustand';
import type { Connection } from '@xyflow/react';
import type {
  KnowledgeSyncStatusSummary,
  GenerationHistoryReusableBridgeResult,
  ProjectImageAssetSummary,
  ProjectImageImportTarget,
  ProjectVideoAssetSummary,
  ChatSkillBridgeResult,
  ProviderBridgeProfile,
} from '@agent-canvas/desktop-core';
import {
  adaptGenerationParameters,
  applyTransaction,
  appendProjectMemoryEntry,
  applyProjectTransaction,
  buildProjectMemoryContext,
  canConnectCanvasPorts,
  createSkillPromotionCandidateFingerprint,
  createSkillPromotionCandidate,
  createCanvasModuleNode,
  createReversePromptRun,
  getCanvasModuleDefinition,
  MAX_GENERATION_REFERENCES,
  DEFAULT_REVERSE_PROMPT_PERSONA,
  parseReversePromptResult,
  reverseAgentNodeConfigSchema,
  reorderCanvasInputEdges,
  sanitizeModelJobError,
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
  type ModelJobProvider,
  type OrderedReference,
  type ProjectOperation,
  type ProjectMemoryEntry,
  type ProjectTransaction,
  type ReferenceRole,
  type ReverseAgentNodeConfig,
  type ReversePromptResult,
  type ReversePromptRun,
  type SkillPromotionCandidate,
} from '@agent-canvas/domain';
import {
  createProjectPersistenceClient,
  registerActiveProjectPersistenceClient,
  type ProjectCommitRequest,
  type ProjectCommitResult,
  type ProjectLifecycle,
  type ProjectPersistenceClient,
  type ProjectSaveStatus,
  type ManagedReversePromptMediaIdentity,
  type SkillChatRequest,
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
import { mergeReverseCitationImages, resolveConnectedReverseMedia } from '../canvas/reverse-agent-media';
import { resolveConnectedStoryboardReferences } from '../canvas/storyboard-reference-media';
import { loadPersistedProjectBundle } from './project-persistence';
import { createExecutionReferenceSnapshot } from './execution-reference-snapshot';
import { commitGeneratedResultWithRefresh } from './model-result-commit';
import {
  createInMemoryModelJobStorage,
  createModelJobStore,
  type ModelJobExecutor,
  type ModelJobRequest,
  type ModelJobStorage,
  type ModelJobStore,
} from '../jobs/job-store';
import { createDesktopModelJobExecutor } from '../jobs/desktop-model-executor';
import { withProviderOperationTimeout } from '../settings/provider-operation-timeout';

const REVERSE_AGENT_OPERATION_TIMEOUT_MS = 315_000;
const PROJECT_PERSISTENCE_OPERATION_TIMEOUT_MS = 15_000;
import { createModelJobRunId } from '../jobs/model-job-identity';
import { advanceOfflineVideoPreview, createOfflineVideoPreview } from '../jobs/video-preview-mock';
import { runtimeProfile } from './runtime-profile';
import { listRunnableProviderProfiles, selectGenerationProviderProfile, selectProviderProfile } from './provider-profiles';
import { buildReverseAgentCanvasPlan } from '../agent/reverse-workflow-proposal';
import type { ReverseAnalysisResult } from '../agent/reverse-workflow-contract';

let planSequence = 0;
let stableProjectCommitTail: Promise<void> | null = null;
let pendingFailedProjectCommit: ProjectCommitRequest | null = null;
let activeProjectCommitToken: ProjectCommitToken | null = null;
let projectPersistenceGeneration = 0;
let projectPersistenceClient = createProjectPersistenceClient();
const PENDING_CLIPBOARD_MEDIA_STORAGE_KEY = 'novus.pending-clipboard-media.v1';
const PENDING_CLIPBOARD_MEDIA_MAX_AGE_MS = 24 * 60 * 60 * 1000;
let knowledgeClient = createKnowledgeClient();
let modelJobExecutorOverride: ModelJobExecutor | null = null;
let pendingModelJobExecutorOverride: ModelJobExecutor | null = null;
let modelJobStorageOverride: ModelJobStorage | null = null;
let modelJobStore: ModelJobStore | null = null;
let modelJobUnsubscribe: (() => void) | null = null;
let modelJobStoreGeneration = 0;
let modelJobRecoveryGeneration = 0;
const activeReverseAgentRuns = new Map<string, string>();
let pendingAgentConfirmation: PendingAgentConfirmation | null = null;
let pendingAgentJobRetry: Promise<void> | null = null;
const AGENT_MODEL_CONVERSATION_ID = 'agent-conversation-shared';
const projectAutosave = createAutosaveController<CanvasProject>({
  commit: async (draft) => enqueueStableProjectOperation(
    (partial) => useAppStore.setState(partial),
    () => useAppStore.getState(),
    async (commitNow) => {
      const project = draft.project;
      return commitNow(createIdleSyncTransaction(project), {
        kind: 'system',
        nextProject: project,
        preservePendingAutosave: true,
      });
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
  memoryId?: string;
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
  preservePendingAutosave?: boolean;
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
interface ImageGenerationNodeInput {
  readonly prompt: string;
  readonly modelRoute?: string;
  readonly aspectRatio?: string;
  readonly resolution?: string;
  readonly outputCount?: number;
  readonly referenceAssetIds?: readonly string[];
}

interface EditableReverseAgentResult {
  readonly analysis?: string;
  readonly keywords?: readonly string[];
  readonly positivePrompt: string;
  readonly negativeConstraints?: readonly string[];
  readonly executionChecklist?: readonly string[];
}
interface VideoPreviewNodeInput {
  readonly prompt: string;
  readonly referenceAssetIds: readonly string[];
  readonly modelRoute?: string;
  readonly aspectRatio: string;
  readonly keyframe: string;
  readonly durationSeconds: number;
  readonly resolution: string;
  readonly outputCount: 1 | 2 | 3 | 4;
  readonly audioEnabled: boolean;
}
type GenerationNodeDraftConfig = Pick<ImageGenerationNodeInput, 'prompt' | 'modelRoute' | 'aspectRatio' | 'resolution' | 'outputCount'>
  & Partial<Pick<VideoPreviewNodeInput, 'keyframe' | 'durationSeconds' | 'audioEnabled'>>;
interface StoryboardNodeInput {
  readonly modelRoute: string;
  readonly script: string;
  readonly shotCount: number;
  readonly referenceAssetIds: readonly string[];
}
interface StoryboardShotUpdateInput {
  readonly composition: string;
  readonly aspectRatio: string;
  readonly resolution: string;
  readonly outputCount: number;
  readonly referenceAssetIds: readonly string[];
}
interface AppState {
  project: CanvasProject;
  projectLifecycle: ProjectLifecycle;
  projectImages: ProjectImageAssetSummary[];
  projectVideos: ProjectVideoAssetSummary[];
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
  addHistoryImageToCanvas: (
    historyId: string,
    operationId: string,
    position: { readonly x: number; readonly y: number },
  ) => Promise<boolean>;
  reuseHistoryParameters: (
    summary: GenerationHistoryReusableBridgeResult,
    operationId: string,
    position: { readonly x: number; readonly y: number },
  ) => Promise<boolean>;
  addModuleNode: (moduleType: CanvasModuleType, position: { x: number; y: number }) => Promise<boolean>;
  addProjectImageInput: (assetId: string, position: { x: number; y: number }) => Promise<boolean>;
  connectModulePorts: (connection: Connection) => Promise<boolean>;
  commitNodePosition: (nodeId: string, position: { x: number; y: number }) => Promise<boolean>;
  commitNodePositions: (updates: readonly { readonly nodeId: string; readonly position: { readonly x: number; readonly y: number } }[]) => Promise<boolean>;
  deleteCanvasNodes: (nodeIds: readonly string[]) => Promise<boolean>;
  deleteCanvasEdge: (edgeId: string) => Promise<boolean>;
  toggleNodeLock: (nodeId: string) => Promise<boolean>;
  reorderModuleInput: (targetNodeId: string, targetPortId: string, edgeIds: string[]) => Promise<boolean>;
  commitReferenceOrder: (assetIds: string[]) => Promise<boolean>;
  configureKnowledgeBase: (knowledgeBaseId: string, displayName: string) => Promise<void>;
  getKnowledgeLease: KnowledgeClient['getLease'];
  analyzeReversePrompt: (input: {
    readonly provider: ProviderBridgeProfile['provider'];
    readonly run: ReversePromptRun;
    readonly media: readonly ManagedReversePromptMediaIdentity[];
  }) => Promise<ReversePromptResult>;
  chatSkill: (input: SkillChatRequest) => Promise<ChatSkillBridgeResult>;
  hydratePersistence: () => Promise<void>;
  openProject: (recentProjectId?: string) => Promise<boolean>;
  reloadDurableProject: () => Promise<boolean>;
  migrateLegacyStarterProjectToFigmaWorkbench: () => Promise<boolean>;
  newWorkflow: () => Promise<void>;
  importImageForModule: (nodeId: string, file?: File) => Promise<boolean>;
  importAgentReferenceImage: (file?: File) => Promise<ProjectImageAssetSummary | null>;
  importAgentReferenceVideo: (file?: File) => Promise<ProjectVideoAssetSummary | null>;
  importVideoForModule: (nodeId: string, file?: File) => Promise<boolean>;
  runImageGenerationNode: (nodeId: string, input: ImageGenerationNodeInput) => Promise<boolean>;
  runVideoPreviewNode: (nodeId: string, input: VideoPreviewNodeInput) => Promise<boolean>;
  generateStoryboardNode: (nodeId: string, input: StoryboardNodeInput) => Promise<boolean>;
  updateStoryboardShot: (nodeId: string, shotId: string, input: StoryboardShotUpdateInput) => Promise<boolean>;
  runReverseAgentNode: (nodeId: string, config?: ReverseAgentNodeConfig) => Promise<ReversePromptResult>;
  cancelReverseAgentNode: (nodeId: string) => Promise<boolean>;
  pasteClipboardImage: (position: { readonly x: number; readonly y: number }) => Promise<boolean>;
  pasteClipboardMedia: (position: { readonly x: number; readonly y: number }) => Promise<boolean>;
  importDroppedMedia: (file: File, position: { readonly x: number; readonly y: number }) => Promise<boolean>;
  importPlacementReference: (
    nodeId: string,
    role: Exclude<ReferenceRole, 'placement_preview'>,
  ) => Promise<boolean>;
  refreshProjectImages: () => Promise<void>;
  initializeKnowledge: () => Promise<void>;
  flushProjectSave: (reason: Exclude<AutosaveFlushReason, 'idle'>) => Promise<boolean>;
  saveProjectExplicitly: () => Promise<boolean>;
  refreshModelJobs: () => Promise<void>;
  retryModelJob: (jobId: string) => Promise<void>;
  retryAgentPlanJobs: () => Promise<void>;
  reviewSkillCandidate: KnowledgeClient['review'];
  setActiveTool: (tool: AppState['activeTool']) => void;
  toggleAgentPanel: () => void;
  setProject: (project: CanvasProject, options?: SetProjectOptions) => void;
  selectProjectImageForModule: (nodeId: string, assetId: string) => Promise<boolean>;
  setCanvasLibrarySelection: (nodeId: string, assetIds: string[]) => Promise<boolean>;
  draftGenerationNodeConfig: (nodeId: string, config: GenerationNodeDraftConfig) => Promise<boolean>;
  draftReverseAgentConfig: (nodeId: string, config: ReverseAgentNodeConfig) => Promise<boolean>;
  applyReverseAgentConfig: (nodeId: string, config: ReverseAgentNodeConfig) => Promise<boolean>;
  updateReverseAgentResult: (nodeId: string, result: EditableReverseAgentResult) => Promise<boolean>;
  draftAgentPlan: (message: string, options?: { modelRoute?: string; modelRouteDisplayName?: string }) => void;
  draftReverseWorkflowPlan: (input: {
    analysis: ReverseAnalysisResult;
    references: readonly { assetId: string; label: string; mention: string }[];
    modelRoute: string;
    modelRouteDisplayName?: string;
    knowledgeBaseIds?: readonly string[];
  }) => void;
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
  cancelReverseAgentNode: async (nodeId) => {
    const node = getModuleNode(get().project.nodes, nodeId);
    if (!node || node.data.moduleType !== 'reverse_agent' || node.data.config.reverseAgentRunState !== 'running') return false;
    activeReverseAgentRuns.delete(nodeId);
    return persistReverseAgentRunPatch(set, get, nodeId, {
      reverseAgentCompletedAt: new Date().toISOString(),
      reverseAgentError: null,
      reverseAgentRunState: 'cancelled',
    }, 'Cancel reverse Agent run');
  },
  runImageGenerationNode: async (nodeId, input) => {
    if (get().canRetryProjectCommit && get().projectCommitConflictCode === null) {
      await get().retryFailedProjectCommit();
    }
    if (!await ensureModelRunSaveBoundary(get)) {
      throw createGenerationStartError('PROJECT_COMMIT_FAILED', 'Project must be saved before image generation starts');
    }
    return enqueueStableProjectOperation(set, get, async (commitNow) => {
    const state = get();
    const node = getModuleNode(state.project.nodes, nodeId);
    const prompt = input.prompt.trim();
    if (!node || node.data.moduleType !== 'image_generation' || prompt.length === 0 || containsProtectedRendererPayload(prompt)) return false;
    if (state.modelJobs.some((job) => job.promptNodeId === nodeId && ['queued', 'submitting', 'running'].includes(job.status))) return false;

    const bridge = globalThis.window?.novusDesktop?.provider;
    if (bridge === undefined) throw createGenerationStartError('PROVIDER_BRIDGE_UNAVAILABLE', 'Provider bridge is unavailable');
    const profiles = await listRunnableProviderProfiles(bridge);
    const profile = selectGenerationProviderProfile(profiles, {
      provider: readGenerationProvider(node.data.config.providerDisplayName),
      modelRoute: input.modelRoute,
      modelDisplayName: readGenerationDisplayName(node.data.config),
    }, 'image_generation');
    if (profile === undefined) throw createGenerationStartError('MODEL_ROUTE_UNAVAILABLE', 'Selected image model route is unavailable; reselect the model');
    const requestedImageAspectRatio = normalizeImageAspectRatio(input.aspectRatio);
    const requestedImageResolution = normalizeImageResolution(input.resolution);
    const requestedImageOutputCount = normalizeImageOutputCount(input.outputCount);
    const imageConstraints = profile.constraints?.image;
    const supportedImageResolutions = imageConstraints?.resolutions?.filter((value): value is '1K' | '2K' | '4K' => value === '1K' || value === '2K' || value === '4K');
    const usesVerifiedProviderDefaults = profile.capabilityStatus === 'complete';
    if (usesVerifiedProviderDefaults && imageConstraints?.resolutions !== undefined && supportedImageResolutions?.length === 0) {
      throw createGenerationStartError('GENERATION_PARAMETERS_UNSUPPORTED', 'Image resolution constraints are unsupported');
    }
    let imageAspectRatio = requestedImageAspectRatio;
    let imageResolution = requestedImageResolution;
    const imageOutputCount = requestedImageOutputCount ?? 1;
    if (usesVerifiedProviderDefaults) {
      const adaptation = adaptGenerationParameters({
        kind: 'image',
        aspectRatio: requestedImageAspectRatio ?? imageConstraints?.aspectRatios?.[0] ?? '1:1',
        resolution: requestedImageResolution ?? supportedImageResolutions?.[0] ?? '2K',
        outputCount: 1,
      }, {
        image: {
          aspectRatios: imageConstraints?.aspectRatios ?? [requestedImageAspectRatio ?? '1:1'],
          resolutions: supportedImageResolutions ?? [requestedImageResolution ?? '2K'],
          outputCounts: imageConstraints?.outputCounts ?? [1],
        },
      });
      if (adaptation.status === 'unsupported' || adaptation.actual?.kind !== 'image') {
        throw createGenerationStartError('GENERATION_PARAMETERS_UNSUPPORTED', 'Selected image parameters are unsupported');
      }
      imageAspectRatio = imageConstraints?.aspectRatios?.length ? adaptation.actual.aspectRatio : undefined;
      imageResolution = supportedImageResolutions?.length ? adaptation.actual.resolution : undefined;
    } else {
      const adaptedImageParameters = imageConstraints === undefined
        ? null
        : adaptGenerationParameters({
          kind: 'image',
          aspectRatio: requestedImageAspectRatio ?? imageConstraints.aspectRatios?.[0] ?? '1:1',
          resolution: requestedImageResolution ?? supportedImageResolutions?.[0] ?? '2K',
          outputCount: 1,
        }, { ...profile.constraints, image: imageConstraints === undefined ? undefined : { ...imageConstraints, resolutions: supportedImageResolutions } });
      if (adaptedImageParameters?.status === 'unsupported' || adaptedImageParameters?.actual?.kind === 'video') {
        throw createGenerationStartError('GENERATION_PARAMETERS_UNSUPPORTED', 'Selected image parameters are unsupported');
      }
      imageAspectRatio = adaptedImageParameters?.actual.aspectRatio ?? requestedImageAspectRatio;
      imageResolution = adaptedImageParameters?.actual.resolution ?? requestedImageResolution;
    }    const referenceAssetIds = resolveImageGenerationReferenceAssetIds(state.project, nodeId, input.referenceAssetIds);
    if (referenceAssetIds === null) return false;

    const timestamp = new Date().toISOString();
    const requests = Array.from({ length: imageOutputCount }, () => ({
      id: createModelJobRunId(),
      kind: 'image' as const,
      promptNodeId: nodeId,
      prompt,
      provider: profile.provider,
      modelRoute: profile.modelRoute,
      displayName: profile.displayName,
      modelId: profile.modelId ?? profile.modelRoute,
      referenceAssetIds,
      referenceSnapshotRevision: state.desktopRevision,
      aspectRatio: imageAspectRatio,
      resolution: imageResolution,
      outputCount: 1 as const,
    }));

    const nextNode = {
      ...node,
      data: {
        ...node.data,
        config: {
          ...node.data.config,
          modelRoute: profile.modelRoute,
          modelDisplayName: profile.displayName,
          prompt,
          ...(imageAspectRatio === undefined ? {} : { aspectRatio: imageAspectRatio }),
          ...(imageResolution === undefined ? {} : { resolution: imageResolution }),
          outputCount: imageOutputCount,
          providerDisplayName: profile.provider,
          referenceAssetIds,
          lastResultJobId: requests[0]?.id,
          resultAssetIds: [],
          resultState: 'pending',
          routeDisplayName: profile.displayName,
        },
        execution: { state: 'queued' as const },
      },
    };
    const transaction: ProjectTransaction = {
      id: `run-image-generation-${nodeId}-${Date.now()}-${planSequence++}`,
      label: 'Run image generation node',
      operations: [{ kind: 'canvas', operation: { kind: 'update_node', node: nextNode } }],
    };
    let nextProject: CanvasProject;
    try {
      nextProject = applyProjectTransaction(state.project, transaction);
    } catch {
      return false;
    }
    if (!await commitNow(transaction, { kind: 'agent', nextProject })) {
      throw createGenerationStartError('PROJECT_COMMIT_FAILED', 'Project must be saved before image generation starts');
    }

    const jobStore = getModelJobStore();
    try {
      const projectSessionId = await resolveModelExecutionSessionId();
      const modelJobs = await jobStore.enqueueConfirmedJobs({
        conversationId: `image-node-${nodeId}`,
        projectSessionId,
        confirmedAt: timestamp,
        requests,
      });
      set({ confirmedModelJobs: countConfirmedModelJobs(modelJobs), modelJobs });
      void jobStore.run();
      return true;
    } catch (error) {
      if (isGenerationStartError(error)) throw error;
      throw createGenerationStartError('MODEL_SESSION_FAILED', 'Model execution session could not be established');
    }
  }, { throwOnRecovery: true });
  },
  runVideoPreviewNode: async (nodeId, input) => {
    if (get().canRetryProjectCommit && get().projectCommitConflictCode === null) {
      await get().retryFailedProjectCommit();
    }
    if (!await ensureModelRunSaveBoundary(get)) {
      throw createGenerationStartError('PROJECT_COMMIT_FAILED', 'Project must be saved before video generation starts');
    }
    return enqueueStableProjectOperation(set, get, async (commitNow) => {
    const state = get();
    const node = getModuleNode(state.project.nodes, nodeId);
    const prompt = input.prompt.trim();
    if (!node || node.data.moduleType !== 'video_generation' || prompt.length === 0 || containsProtectedRendererPayload(prompt)) return false;
    if (state.modelJobs.some((job) => job.promptNodeId === nodeId && ['queued', 'submitting', 'running'].includes(job.status))) return false;
    if (!Number.isInteger(input.durationSeconds) || input.durationSeconds < 0 || input.durationSeconds > 60) return false;
    if (!Number.isInteger(input.outputCount) || input.outputCount < 1 || input.outputCount > 4 || typeof input.audioEnabled !== 'boolean') return false;
    const requestedAspectRatio = input.aspectRatio === 'Auto' ? undefined : normalizeImageAspectRatio(input.aspectRatio);
    const requestedVideoResolution = input.resolution === 'Auto' ? undefined : normalizeVideoResolution(input.resolution);
    if (input.aspectRatio !== 'Auto' && requestedAspectRatio === undefined) return false;
    if (input.resolution !== 'Auto' && requestedVideoResolution === undefined) return false;

    const bridge = globalThis.window?.novusDesktop?.provider;
    if (bridge === undefined) return false;
    const profiles = await listRunnableProviderProfiles(bridge);
    const profile = selectGenerationProviderProfile(profiles, {
      provider: readGenerationProvider(node.data.config.providerDisplayName),
      modelRoute: input.modelRoute,
      modelDisplayName: readGenerationDisplayName(node.data.config),
    }, 'video_generation');
    if (profile === undefined) throw createGenerationStartError('MODEL_ROUTE_UNAVAILABLE', 'Selected video model route is unavailable; reselect the model');

    const videoConstraints = profile.constraints?.video;
    const usesVerifiedProviderDefaults = profile.capabilityStatus === 'complete';
    let actualAspectRatio = requestedAspectRatio;
    let actualVideoResolution = requestedVideoResolution;
    let actualDurationSeconds = input.durationSeconds === 0 ? undefined : input.durationSeconds;
    const actualOutputCount = input.outputCount;
    if (usesVerifiedProviderDefaults) {
      const durationSeed = actualDurationSeconds
        ?? videoConstraints?.duration?.defaultValue
        ?? (videoConstraints?.duration?.mode === 'options' ? videoConstraints.duration.options[0] : videoConstraints?.duration?.min)
        ?? 5;
      const adaptation = adaptGenerationParameters({
        kind: 'video',
        aspectRatio: requestedAspectRatio ?? videoConstraints?.aspectRatios?.[0] ?? '1:1',
        resolution: requestedVideoResolution ?? videoConstraints?.resolutions?.[0] ?? '720p',
        durationSeconds: durationSeed,
        outputCount: 1,
      }, {
        video: {
          aspectRatios: videoConstraints?.aspectRatios ?? [requestedAspectRatio ?? '1:1'],
          resolutions: videoConstraints?.resolutions ?? [requestedVideoResolution ?? '720p'],
          duration: videoConstraints?.duration ?? { mode: 'options', options: [durationSeed] },
          outputCounts: videoConstraints?.outputCounts ?? [1],
        },
      });
      if (adaptation.status === 'unsupported' || adaptation.actual?.kind !== 'video') return false;
      actualAspectRatio = videoConstraints?.aspectRatios?.length ? adaptation.actual.aspectRatio : undefined;
      actualVideoResolution = videoConstraints?.resolutions?.length ? adaptation.actual.resolution : undefined;
      actualDurationSeconds = videoConstraints?.duration === undefined ? undefined : adaptation.actual.durationSeconds;
    } else {
      if (requestedAspectRatio === undefined || requestedVideoResolution === undefined || actualDurationSeconds === undefined) return false;
      const adaptedVideoParameters = videoConstraints === undefined
        ? null
        : adaptGenerationParameters({
          kind: 'video', aspectRatio: requestedAspectRatio, resolution: requestedVideoResolution,
          durationSeconds: actualDurationSeconds, outputCount: 1,
        }, profile.constraints ?? {});
      if (adaptedVideoParameters?.status === 'unsupported' || adaptedVideoParameters?.actual?.kind === 'image') return false;
      actualAspectRatio = adaptedVideoParameters?.actual.aspectRatio ?? requestedAspectRatio;
      actualVideoResolution = adaptedVideoParameters?.actual.resolution ?? requestedVideoResolution;
      actualDurationSeconds = adaptedVideoParameters?.actual.durationSeconds ?? actualDurationSeconds;
    }
    const connectedMedia = resolveConnectedVideoGenerationMedia(state.project, nodeId);
    if (connectedMedia === null) return false;
    const frameAssetIds = connectedMedia === undefined
      ? [...new Set(input.referenceAssetIds)]
      : connectedMedia.imageAssetIds;
    const sourceVideoAssetId = connectedMedia?.sourceVideoAssetId;
    if (frameAssetIds.length > MAX_GENERATION_REFERENCES || frameAssetIds.some((assetId) => !isNonEmptyString(assetId))) return false;
    const assets = new Map((state.project.assets ?? []).map((asset) => [asset.assetId, asset]));
    if (frameAssetIds.some((assetId) => !assets.get(assetId)?.mediaType.startsWith('image/'))) return false;
    if (sourceVideoAssetId !== undefined && assets.get(sourceVideoAssetId)?.mediaType !== 'video/mp4') return false;
    const jobReferenceAssetIds = sourceVideoAssetId === undefined
      ? frameAssetIds
      : [...frameAssetIds, sourceVideoAssetId];

    const { firstFrameAssetId: _previousFirstFrameAssetId, lastFrameAssetId: _previousLastFrameAssetId, sourceVideoAssetId: _previousSourceVideoAssetId, videoResults: _previousVideoResults, mode: _previousMode, ...previousConfig } = node.data.config;
    const nextNode = {
      ...node,
      data: {
        ...node.data,
        config: {
          ...previousConfig,
          prompt,
          modelRoute: profile.modelRoute,
          modelDisplayName: profile.displayName,
          providerDisplayName: profile.provider,
          referenceAssetIds: frameAssetIds,
          ...(frameAssetIds[0] ? { firstFrameAssetId: frameAssetIds[0] } : {}),
          ...(frameAssetIds.length > 1 ? { lastFrameAssetId: frameAssetIds[frameAssetIds.length - 1] } : {}),
          ...(sourceVideoAssetId ? { sourceVideoAssetId } : {}),
          ...(actualAspectRatio === undefined ? {} : { aspectRatio: actualAspectRatio }),
          keyframe: input.keyframe,
          ...(actualDurationSeconds === undefined ? {} : { durationSeconds: actualDurationSeconds }),
          ...(actualVideoResolution === undefined ? {} : { resolution: actualVideoResolution }),
          outputCount: actualOutputCount,
          audioEnabled: input.audioEnabled,
          resultState: 'pending',
          routeDisplayName: profile.displayName,
        },
        execution: { state: 'queued' as const },
      },
    };
    const transaction: ProjectTransaction = {
      id: `run-video-generation-${nodeId}-${Date.now()}-${planSequence++}`,
      label: 'Run video generation node',
      operations: [{ kind: 'canvas', operation: { kind: 'update_node', node: nextNode } }],
    };
    let nextProject: CanvasProject;
    try {
      nextProject = applyProjectTransaction(state.project, transaction);
    } catch {
      return false;
    }
    if (!await commitNow(transaction, { kind: 'agent', nextProject })) return false;

    const timestamp = new Date().toISOString();
    const jobStore = getModelJobStore();
    try {
      const projectSessionId = await resolveModelExecutionSessionId();
      const requests: ModelJobRequest[] = Array.from({ length: actualOutputCount }, () => ({
        id: createModelJobRunId(),
        kind: 'video',
        promptNodeId: nodeId,
        prompt,
        provider: profile.provider,
        modelRoute: profile.modelRoute,
        displayName: profile.displayName,
        modelId: profile.modelId ?? profile.modelRoute,
        referenceAssetIds: jobReferenceAssetIds,
        referenceSnapshotRevision: state.desktopRevision,
        aspectRatio: actualAspectRatio,
        videoResolution: actualVideoResolution,
        durationSeconds: actualDurationSeconds,
        audioEnabled: input.audioEnabled,
        outputCount: 1,
      }));
      const modelJobs = await jobStore.enqueueConfirmedJobs({
        conversationId: `video-node-${nodeId}`,
        projectSessionId,
        confirmedAt: timestamp,
        requests,
      });
      set({ confirmedModelJobs: countConfirmedModelJobs(modelJobs), modelJobs });
      void jobStore.run();
      return true;
    } catch {
      return false;
    }
    });
  },
  generateStoryboardNode: (nodeId, input) => enqueueStableProjectOperation(set, get, async (commitNow) => {
    const state = get();
    const node = getModuleNode(state.project.nodes, nodeId);
    const script = input.script.trim();
    if (!node || node.data.moduleType !== 'storyboard_sheet' || script.length === 0 || containsProtectedRendererPayload(script)) return false;
    const references = resolveConnectedStoryboardReferences({ project: state.project, nodeId });
    if (!references.ok) return false;
    const bridge = globalThis.window?.novusDesktop?.provider;
    if (bridge === undefined) return false;
    try {
      const profiles = await listRunnableProviderProfiles(bridge);
      const profile = selectProviderProfile(profiles, input.modelRoute, 'chat');
      if (!profile) return false;
      const result = await bridge.generateStoryboard({
        provider: profile.provider, modelRoute: profile.modelRoute, script, shotCount: input.shotCount, referenceAssetIds: [...references.assetIds],
      });
      const nextNode = {
        ...node,
        data: {
          ...node.data,
          config: { ...node.data.config, script, modelRoute: result.modelRoute, shotCount: input.shotCount, referenceAssetIds: [...references.assetIds], shots: result.shots, resultState: 'fresh' },
          execution: { state: 'completed' as const },
        },
      };
      const transaction: ProjectTransaction = {
        id: `generate-storyboard-${nodeId}-${Date.now()}-${planSequence++}`,
        label: 'Generate storyboard shots',
        operations: [{ kind: 'canvas', operation: { kind: 'update_node', node: nextNode } }],
      };
      return await commitNow(transaction, { kind: 'agent', nextProject: applyProjectTransaction(state.project, transaction) });
    } catch {
      return false;
    }
  }),
  updateStoryboardShot: (nodeId, shotId, input) => enqueueStableProjectOperation(set, get, async (commitNow) => {
    const state = get();
    const node = getModuleNode(state.project.nodes, nodeId);
    const currentShots = readStoryboardShotRecords(node?.data.config.shots);
    const currentShot = currentShots.find((shot) => shot.id === shotId);
    const references = resolveImageGenerationReferenceAssetIds(state.project, nodeId, input.referenceAssetIds);
    if (
      !node || node.data.moduleType !== 'storyboard_sheet' || currentShot === undefined || references === null
      || !isSafeStoryboardShotUpdate(input)
    ) return false;
    const nextNode = {
      ...node,
      data: {
        ...node.data,
        config: {
          ...node.data.config,
          shots: currentShots.map((shot) => shot.id === shotId ? {
            ...shot,
            composition: input.composition.trim(),
            aspectRatio: input.aspectRatio,
            resolution: input.resolution,
            outputCount: input.outputCount,
            referenceAssetIds: references,
          } : shot),
          resultState: 'fresh',
        },
      },
    };
    const transaction: ProjectTransaction = {
      id: `update-storyboard-shot-${nodeId}-${shotId}-${Date.now()}-${planSequence++}`,
      label: 'Update storyboard shot',
      operations: [{ kind: 'canvas', operation: { kind: 'update_node', node: nextNode } }],
    };
    try {
      return await commitNow(transaction, { kind: 'canvas', nextProject: applyProjectTransaction(state.project, transaction) });
    } catch {
      return false;
    }
  }),
  runReverseAgentNode: async (nodeId, requestedConfig) => {
    if (get().projectCommitConflictCode !== null && get().canReloadDurableProject) {
      const refreshed = await get().reloadDurableProject();
      if (!refreshed) throw createReverseConfigurationSaveError(get());
    }
    if (get().canRetryProjectCommit && get().projectCommitConflictCode === null) {
      await get().retryFailedProjectCommit();
    }
    const persistenceState = get();
    if (
      persistenceState.canRetryProjectCommit
      || persistenceState.projectCommitConflictCode !== null
      || persistenceState.recoveryRequired
      || persistenceState.saveStatus === 'read_only'
    ) throw createReverseConfigurationSaveError(persistenceState);
    if (requestedConfig !== undefined) {
      const applied = await get().applyReverseAgentConfig(nodeId, requestedConfig);
      if (!applied) throw createReverseConfigurationSaveError(get());
    }
    if (!await ensureModelRunSaveBoundary(get)) throw createReverseConfigurationSaveError(get());
    const state = get();
    const node = getModuleNode(state.project.nodes, nodeId);
    if (!node || node.data.moduleType !== 'reverse_agent') {
      throw new Error('Select an Agent reverse node before running analysis');
    }
    const parsedConfig = reverseAgentNodeConfigSchema.safeParse({
      modelRoute: node.data.config.modelRoute,
      role: node.data.config.role,
      task: node.data.config.task,
      knowledgeBaseIds: node.data.config.knowledgeBaseIds,
      referenceAssetIds: node.data.config.referenceAssetIds,
    });
    if (!parsedConfig.success) {
      throw new Error('Apply the Agent task before running analysis');
    }
    const connectedMedia = resolveConnectedReverseMedia({
      project: state.project,
      nodeId,
      images: state.projectImages,
      videos: state.projectVideos,
    });
    const citationAssetIds = parsedConfig.data.referenceAssetIds ?? [];
    const hasInboundMediaEdges = state.project.edges.some((edge) => (
      edge.target === nodeId && (edge.targetPortId === 'references' || edge.targetPortId === 'video')
    ));
    if (!connectedMedia.ok && (hasInboundMediaEdges || citationAssetIds.length === 0)) {
      throw new Error(connectedMedia.reason);
    }
    const baseMedia = connectedMedia.ok
      ? connectedMedia
      : { ok: true as const, references: [], media: [], orderedMedia: [], edgeIds: [] };
    const resolvedMedia = mergeReverseCitationImages(baseMedia, citationAssetIds, state.projectImages);
    if (!resolvedMedia.ok) throw new Error(resolvedMedia.reason);
    const analyzeReversePrompt = projectPersistenceClient.analyzeReversePrompt;
    if (analyzeReversePrompt === undefined) throw new Error('Reverse prompt analysis is unavailable');

    const startedAt = new Date().toISOString();
    const runId = `reverse-node-${createModelJobRunId()}`;
    activeReverseAgentRuns.set(nodeId, runId);
    const runningPersisted = await persistReverseAgentRunPatch(set, get, nodeId, {
      reverseAgentCompletedAt: null,
      reverseAgentError: null,
      reverseAgentRunId: runId,
      reverseAgentRunState: 'running',
      reverseAgentStartedAt: startedAt,
    }, 'Start reverse Agent run');
    if (!runningPersisted) {
      activeReverseAgentRuns.delete(nodeId);
      throw new Error('Reverse analysis state could not be saved');
    }

    const knowledgeLease = get().getKnowledgeLease(
      runId,
      'reverse_prompt',
      [...resolvedMedia.references],
      [],
      parsedConfig.data.knowledgeBaseIds,
    );
    const run = createReversePromptRun({
      projectId: state.project.id,
      skill: { id: 'scene-skill', version: 'managed-latest' },
      persona: DEFAULT_REVERSE_PROMPT_PERSONA,
      agentConfig: parsedConfig.data,
      knowledgeLease,
      approvedMemorySnapshot: {
        version: 'local-draft-no-approved-skill',
        approvedAt: new Date().toISOString(),
        approvedMemoryIds: [],
      },
      projectMemoryIds: buildProjectMemoryContext(state.project.projectMemory, 50).map((memory) => memory.id),
      references: [...resolvedMedia.references],
      orderedMedia: [...resolvedMedia.orderedMedia],
    });
    try {
      const providerBridge = globalThis.window?.novusDesktop?.provider;
      const reverseProfile = providerBridge?.listProfiles
        ? selectProviderProfile(await listRunnableProviderProfiles(providerBridge), parsedConfig.data.modelRoute, 'reverse_prompt')
        : undefined;
      if (providerBridge?.listProfiles && !reverseProfile) throw new Error('所选模型没有明确声明反推能力');
      // The renderer may retain a historical route alias after the provider
      // catalog has replaced it with the canonical route. The bridge validates
      // the route against its current catalog, so send that canonical value.
      // createReversePromptRun accepts an optional agent config for legacy
      // snapshots, while the provider analysis contract requires the complete
      // config. This run always originates from the validated node config, so
      // restore that invariant before applying the canonical route alias.
      const configuredAgentConfig = run.agentConfig;
      if (!configuredAgentConfig) throw new Error('反推配置缺少模型参数');
      const configuredRun: ReversePromptRun = run;
      const analysisRun: ReversePromptRun = reverseProfile === undefined
        ? configuredRun
        : {
          ...configuredRun,
          agentConfig: { ...configuredAgentConfig, modelRoute: reverseProfile.modelRoute },
        };
      const result = await withProviderOperationTimeout(
        analyzeReversePrompt({ provider: reverseProfile?.provider ?? 'comfly', run: analysisRun, media: resolvedMedia.media }),
        REVERSE_AGENT_OPERATION_TIMEOUT_MS,
      );
      const parsedResult = parseReversePromptResult(result, analysisRun);
      if (!isReverseAgentRunActive(get, nodeId, runId)) throw createReverseRunCancelledError();
      const persisted = await persistReverseAgentRunPatch(set, get, nodeId, {
        reverseAgentCompletedAt: new Date().toISOString(),
        reverseAgentError: null,
        reverseAgentResult: parsedResult,
        reverseAgentRunState: 'completed',
        reverseAgentStartedAt: startedAt,
      }, 'Store reverse Agent result');
      if (!persisted) throw new Error('Reverse analysis result could not be saved');
      return parsedResult;
    } catch (error) {
      if (!isReverseAgentRunActive(get, nodeId, runId)) throw createReverseRunCancelledError();
      await persistReverseAgentRunPatch(set, get, nodeId, {
        reverseAgentCompletedAt: new Date().toISOString(),
        reverseAgentError: sanitizeModelJobError(error),
        reverseAgentRunState: 'failed',
        reverseAgentStartedAt: startedAt,
      }, 'Store reverse Agent failure');
      throw error;
    } finally {
      if (activeReverseAgentRuns.get(nodeId) === runId) activeReverseAgentRuns.delete(nodeId);
    }
  },
  addHistoryImageToCanvas: (historyId, operationId, position) => enqueueStableProjectOperation(set, get, async (commitNow) => {
    const copyHistoryToProject = projectPersistenceClient.copyHistoryToProject;
    if (
      copyHistoryToProject === undefined
      || !isNonEmptyString(historyId)
      || !isNonEmptyString(operationId)
      || !isFinitePosition(position)
      || get().projectLifecycle !== 'durable'
    ) return false;
    const generation = projectPersistenceGeneration;
    const expectedProjectId = get().project.id;
    set({ saveErrorCode: null, saveStatus: 'saving' });
    let copied;
    try {
      copied = await copyHistoryToProject({ historyId, operationId });
    } catch (error) {
      if (generation === projectPersistenceGeneration && get().project.id === expectedProjectId) {
        set({ saveErrorCode: readErrorCode(error), saveStatus: 'error' });
      }
      return false;
    }
    if (
      copied === null
      || generation !== projectPersistenceGeneration
      || copied.project.id !== expectedProjectId
      || get().project.id !== expectedProjectId
    ) return false;
    const nodeId = `history-node-${operationId}`;
    const transactionId = `history-canvas-${operationId}`;
    const existingNode = copied.project.nodes.find((node) => node.id === nodeId);
    set({ desktopRevision: copied.revision, project: copied.project });
    if (existingNode !== undefined) {
      const projectImages = await projectPersistenceClient.listProjectImages().catch(() => get().projectImages);
      set({ projectImages, saveErrorCode: null, saveStatus: 'saved' });
      return true;
    }
    const baseNode = createCanvasModuleNode(nodeId, 'image_input', position);
    const node = {
      ...baseNode,
      data: { ...baseNode.data, config: { ...baseNode.data.config, assetId: copied.projectAssetId } },
    };
    const committed = await commitNow({
      id: transactionId,
      label: 'Add generation history image to canvas',
      operations: [{ kind: 'canvas', operation: { kind: 'create_node', node } }],
    });
    if (!committed) return false;
    const projectImages = await projectPersistenceClient.listProjectImages().catch(() => get().projectImages);
    set({ projectImages });
    return true;
  }),
  reuseHistoryParameters: (summary, operationId, position) => enqueueStableProjectOperation(set, get, async (commitNow) => {
    if (
      !isNonEmptyString(operationId)
      || !isFinitePosition(position)
      || containsProtectedRendererPayload(summary)
    ) return false;
    const nodeId = `history-reuse-node-${operationId}`;
    const existing = get().project.nodes.find((node) => node.id === nodeId);
    if (existing !== undefined) return existing.type === 'module' && existing.data.moduleType === 'image_generation';
    const baseNode = createCanvasModuleNode(nodeId, 'image_generation', position);
    const node = {
      ...baseNode,
      data: {
        ...baseNode.data,
        config: {
          ...baseNode.data.config,
          ...summary.parameters,
          modelDisplayName: summary.provider.modelDisplayName,
          prompt: summary.promptSummary,
          providerDisplayName: summary.provider.displayName,
          resultState: 'empty',
          routeDisplayName: summary.provider.modelDisplayName,
        },
      },
    };
    return commitNow({
      id: `history-reuse-${operationId}`,
      label: 'Reuse generation history parameters',
      operations: [{ kind: 'canvas', operation: { kind: 'create_node', node } }],
    });
  }),
  addModuleNode: (moduleType, position) => enqueueStableProjectOperation(set, get, async (commitNow) => {
    const suffix = `${Date.now()}-${planSequence++}`;
    const node = createCanvasModuleNode(`module-${moduleType}-${suffix}`, moduleType, position);
    return commitNow({
      id: `add-module-${suffix}`,
      label: `Add ${getCanvasModuleDefinition(moduleType).displayName}`,
      operations: [{ kind: 'canvas', operation: { kind: 'create_node', node } }],
    });
  }),
  addProjectImageInput: (assetId, position) => enqueueStableProjectOperation(set, get, async (commitNow) => {
    const state = get();
    const asset = (state.project.assets ?? []).find((candidate) => candidate.assetId === assetId);
    if (!asset || !asset.mediaType.startsWith('image/')) return false;
    const suffix = `${Date.now()}-${planSequence++}`;
    const baseNode = createCanvasModuleNode(`module-image_input-${suffix}`, 'image_input', position);
    const node = { ...baseNode, data: { ...baseNode.data, config: { ...baseNode.data.config, assetId } } };
    return commitNow({ id: `add-project-image-input-${suffix}`, label: 'Add generated image to canvas', operations: [{ kind: 'canvas', operation: { kind: 'create_node', node } }] });
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

    // Reverse Agent renders image and video references as one ordered tray.
    // Allocate one shared sequence for both input ports; otherwise the first
    // image and first video each receive order 0 and their display order falls
    // back to the persisted edge array instead of the user's connection order.
    const incoming = state.project.edges.filter((edge) => (
      edge.target === targetId
      && (targetNode.data.moduleType === 'reverse_agent'
        ? (edge.targetPortId === 'references' || edge.targetPortId === 'video')
        : edge.targetPortId === targetPortId)
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
  commitNodePosition: (nodeId, position) => get().commitNodePositions([{ nodeId, position }]),
  commitNodePositions: (updates) => enqueueStableProjectOperation(set, get, async (commitNow) => {
    const state = get();
    if (!Array.isArray(updates) || updates.length === 0) return false;
    const requestedById = new Map<string, { readonly x: number; readonly y: number }>();
    for (const update of updates) {
      if (!isNonEmptyString(update.nodeId) || !isFinitePosition(update.position)) return false;
      requestedById.set(update.nodeId, update.position);
    }
    const nodesById = new Map(state.project.nodes.map((node) => [node.id, node]));
    if ([...requestedById.keys()].some((nodeId) => !nodesById.has(nodeId))) return false;
    const movedNodes = [...requestedById].flatMap(([nodeId, position]) => {
      const node = nodesById.get(nodeId)!;
      if (node.locked === true) return [];
      if (node.position.x === position.x && node.position.y === position.y) return [];
      return [{ ...node, position }];
    });
    if (movedNodes.length === 0) {
      return [...requestedById.keys()].some((nodeId) => nodesById.get(nodeId)?.locked !== true);
    }

    const suffix = `${Date.now()}-${planSequence++}`;
    const transaction: ProjectTransaction = {
      id: `move-canvas-nodes-${suffix}`,
      label: `Move ${movedNodes.length} canvas node${movedNodes.length === 1 ? '' : 's'}`,
      operations: movedNodes.map((node) => ({ kind: 'canvas' as const, operation: { kind: 'update_node' as const, node } })),
    };
    try {
      const nextProject = applyProjectTransaction(state.project, transaction);
      return commitNow(transaction, { nextProject });
    } catch {
      return false;
    }
  }),
  deleteCanvasNodes: (nodeIds) => enqueueStableProjectOperation(set, get, async (commitNow) => {
    const state = get();
    const requestedNodeIds = [...new Set(nodeIds.filter(isNonEmptyString))];
    if (requestedNodeIds.length === 0) return false;
    const existingNodesById = new Map(state.project.nodes.map((node) => [node.id, node]));
    if (requestedNodeIds.some((nodeId) => !existingNodesById.has(nodeId))) return false;
    const selectedNodeIds = requestedNodeIds;
    const selectedIds = new Set(selectedNodeIds);
    const connectedEdges = state.project.edges.filter((edge) => selectedIds.has(edge.source) || selectedIds.has(edge.target));
    const suffix = `${Date.now()}-${planSequence++}`;
    const transaction: ProjectTransaction = {
      id: `delete-canvas-nodes-${suffix}`,
      label: `Delete ${selectedNodeIds.length} canvas node${selectedNodeIds.length === 1 ? '' : 's'}`,
      operations: [
        ...connectedEdges.map((edge) => ({ kind: 'canvas' as const, operation: { kind: 'delete_edge' as const, edgeId: edge.id } })),
        ...selectedNodeIds.map((nodeId) => ({ kind: 'canvas' as const, operation: { kind: 'delete_node' as const, nodeId } })),
      ],
    };
    try {
      const nextProject = applyProjectTransaction(state.project, transaction);
      return commitNow(transaction, { nextProject });
    } catch {
      return false;
    }
  }),
  deleteCanvasEdge: (edgeId) => enqueueStableProjectOperation(set, get, async (commitNow) => {
    const state = get();
    if (!isNonEmptyString(edgeId) || !state.project.edges.some((edge) => edge.id === edgeId)) return false;
    const transaction: ProjectTransaction = {
      id: `delete-canvas-edge-${edgeId}-${Date.now()}-${planSequence++}`,
      label: 'Cancel canvas connection',
      operations: [{ kind: 'canvas', operation: { kind: 'delete_edge', edgeId } }],
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
  draftGenerationNodeConfig: async (nodeId, config) => {
    const state = get();
    if (
      state.saveStatus === 'read_only'
      || state.recoveryRequired
      || state.projectCommitConflictCode !== null
      || pendingFailedProjectCommit !== null
    ) {
      return false;
    }
    const node = getModuleNode(state.project.nodes, nodeId);
    if (!node || (node.data.moduleType !== 'image_generation' && node.data.moduleType !== 'video_generation')) return false;
    const nextDraft = {
      prompt: config.prompt,
      modelRoute: config.modelRoute ?? '',
      aspectRatio: config.aspectRatio ?? (node.data.moduleType === 'video_generation' ? '16:9' : '1:1'),
      resolution: config.resolution ?? (node.data.moduleType === 'video_generation' ? '1080P' : '2K'),
      outputCount: normalizeImageOutputCount(config.outputCount) ?? 1,
      ...(node.data.moduleType === 'video_generation' ? {
        keyframe: config.keyframe ?? 'auto',
        durationSeconds: config.durationSeconds ?? 5,
        audioEnabled: config.audioEnabled !== false,
      } : {}),
    };
    const currentDraft = Object.fromEntries(Object.keys(nextDraft).map((key) => [key, node.data.config[key]]));
    if (JSON.stringify(currentDraft) === JSON.stringify(nextDraft)) return true;
    const nextNode = {
      ...node,
      data: { ...node.data, config: { ...node.data.config, ...nextDraft } },
    };
    const project = {
      ...state.project,
      nodes: state.project.nodes.map((candidate) => candidate.id === nodeId ? nextNode : candidate),
    };
    set({
      canReloadDurableProject: false,
      project,
      projectCommitConflictCode: null,
      saveErrorCode: null,
      saveStatus: 'pending',
    });
    scheduleProjectSave(get);
    return true;
  },
  draftReverseAgentConfig: async (nodeId, config) => {
    const state = get();
    if (
      state.saveStatus === 'read_only'
      || state.recoveryRequired
      || state.projectCommitConflictCode !== null
      || pendingFailedProjectCommit !== null
    ) return false;
    const node = getModuleNode(state.project.nodes, nodeId);
    if (!node || node.data.moduleType !== 'reverse_agent') return false;
    const nextDraft = {
      modelRoute: config.modelRoute,
      role: config.role,
      task: config.task,
      knowledgeBaseIds: [...config.knowledgeBaseIds],
      referenceAssetIds: [...(config.referenceAssetIds ?? [])],
    };
    const currentDraft = {
      modelRoute: typeof node.data.config.modelRoute === 'string' ? node.data.config.modelRoute : '',
      role: typeof node.data.config.role === 'string' ? node.data.config.role : '',
      task: typeof node.data.config.task === 'string' ? node.data.config.task : '',
      knowledgeBaseIds: Array.isArray(node.data.config.knowledgeBaseIds)
        ? node.data.config.knowledgeBaseIds.filter(isNonEmptyString)
        : [],
      referenceAssetIds: Array.isArray(node.data.config.referenceAssetIds)
        ? node.data.config.referenceAssetIds.filter(isNonEmptyString)
        : [],
    };
    if (JSON.stringify(currentDraft) === JSON.stringify(nextDraft)) return true;
    const nextNode = {
      ...node,
      data: { ...node.data, config: { ...node.data.config, ...nextDraft } },
    };
    const project = {
      ...state.project,
      nodes: state.project.nodes.map((candidate) => candidate.id === nodeId ? nextNode : candidate),
    };
    set({
      canReloadDurableProject: false,
      project,
      projectCommitConflictCode: null,
      saveErrorCode: null,
      saveStatus: 'pending',
    });
    scheduleProjectSave(get);
    return true;
  },
  applyReverseAgentConfig: (nodeId, config) => enqueueStableProjectOperation(set, get, async (commitNow) => {
    const state = get();
    const node = getModuleNode(state.project.nodes, nodeId);
    if (!node || node.data.moduleType !== 'reverse_agent') return false;
    const parsed = reverseAgentNodeConfigSchema.safeParse(config);
    if (!parsed.success) return false;
    const current = reverseAgentNodeConfigSchema.safeParse(node.data.config);
    if (current.success && JSON.stringify(current.data) === JSON.stringify(parsed.data)) return true;
    const nextNode = {
      ...node,
      data: { ...node.data, config: { ...node.data.config, ...parsed.data } },
    };
    const suffix = `${Date.now()}-${planSequence++}`;
    const transaction: ProjectTransaction = {
      id: `apply-reverse-agent-config-${suffix}`,
      label: 'Apply reverse Agent task',
      operations: [{ kind: 'canvas', operation: { kind: 'update_node', node: nextNode } }],
    };
    const nextProject = applyProjectTransaction(state.project, transaction);
    return commitNow(transaction, { nextProject });
  }),
  updateReverseAgentResult: (nodeId, result) => {
    const node = getModuleNode(get().project.nodes, nodeId);
    if (!node || node.data.moduleType !== 'reverse_agent') return Promise.resolve(false);
    const current = node.data.config.reverseAgentResult;
    const merged = {
      ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}),
      ...result,
    };
    return persistReverseAgentRunPatch(set, get, nodeId, { reverseAgentResult: merged }, 'Update reverse Agent result');
  },
  closePersistence: async () => {
    let state = get();
    if (state.recoveryRequired) return false;
    if (state.saveStatus !== 'read_only') {
      if (pendingFailedProjectCommit !== null) {
        const retried = await get().retryFailedProjectCommit();
        if (!retried) return false;
        state = get();
      }
      const hasPendingSave = projectAutosave.hasPending() || projectAutosave.hasInFlight();
      if (state.saveStatus !== 'saved' || hasPendingSave) {
        const flushed = await flushPendingProjectSave(get, set, 'close');
        if (!flushed) return false;
      }
    }
    invalidateModelJobStoreGeneration();
    modelJobStore?.stop();
    modelJobUnsubscribe?.();
    modelJobUnsubscribe = null;
    knowledgeClient.stop();
    try {
      await withProjectPersistenceTimeout(projectPersistenceClient.close());
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
      await withProjectPersistenceTimeout(projectPersistenceClient.close());
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
  getKnowledgeLease: (runId, capability, references, citations, selectedKnowledgeBaseIds) => (
    knowledgeClient.getLease(runId, capability, references, citations, selectedKnowledgeBaseIds)
  ),
  analyzeReversePrompt: async (input) => {
    const analyzeReversePrompt = projectPersistenceClient.analyzeReversePrompt;
    if (analyzeReversePrompt === undefined) throw new Error('Reverse prompt analysis is unavailable');
    return analyzeReversePrompt(input);
  },
  chatSkill: async (input) => {
    const chatSkill = projectPersistenceClient.chatSkill;
    if (chatSkill === undefined) throw new Error('Skill chat is unavailable');
    return chatSkill(input);
  },
  hydratePersistence: async () => {
    const hydrationGeneration = projectPersistenceGeneration;
    const hydrationProject = get().project;
    // The desktop bridge can update the project object while startup restore is
    // in flight. Keep a value snapshot as well as the reference so an in-place
    // edit cannot be mistaken for an untouched initial project.
    const hydrationProjectFingerprint = JSON.stringify(hydrationProject);
    const jobStore = getModelJobStore();
    const hydrated = await projectPersistenceClient.hydrate();
    const imageState = await readProjectImagesForHydration();
    const modelJobs = await jobStore.listJobs();
    const currentProject = get().project;
    if (
      hydrationGeneration !== projectPersistenceGeneration
      || currentProject !== hydrationProject
      || JSON.stringify(currentProject) !== hydrationProjectFingerprint
    ) return;
    invalidateProjectPersistenceBoundary();
    cancelPendingProjectSave();
    clearPendingFailedProjectCommit();
    set({
      availableSnapshotIds: hydrated.availableSnapshotIds,
      canReloadDurableProject: hydrated.saveStatus === 'read_only' && hydrated.recoveryRequired !== true,
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
    const interruptedReverseRuns = createInterruptedReverseRunsTransaction(hydrated.project);
    if (interruptedReverseRuns !== null && hydrated.recoveryRequired !== true) {
      await get().commitProjectTransaction(interruptedReverseRuns.transaction, {
        kind: 'agent',
        nextProject: interruptedReverseRuns.project,
      });
    }
    if (
      hydrated.recoveryRequired !== true
      && isRetiredStarterCanvasProject(hydrated.project)
    ) {
      await get().migrateLegacyStarterProjectToFigmaWorkbench();
    }
    if (hydrated.lifecycle === 'durable') await reconcilePendingClipboardMedia(get().project.id);
    if (hydrated.recoveryRequired !== true) {
      await recoverModelJobsInBackground(jobStore);
    }
  },
  openProject: async (recentProjectId) => {
    if (get().recoveryRequired) return false;
    const openProject = projectPersistenceClient.openProject;
    if (openProject === undefined) return false;
    const opened = await openProject(recentProjectId);
    if (opened === null) return false;
    const imageState = await readProjectImagesForHydration();
    invalidateProjectPersistenceBoundary();
    cancelPendingProjectSave();
    clearPendingFailedProjectCommit();
    set({
      availableSnapshotIds: opened.availableSnapshotIds,
      canReloadDurableProject: opened.saveStatus === 'read_only' && opened.recoveryRequired !== true,
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
    if (
      opened.lifecycle === 'durable'
      && opened.recoveryRequired !== true
      && get().modelJobs.length === 0
      && isRetiredStarterCanvasProject(opened.project)
    ) {
      await get().migrateLegacyStarterProjectToFigmaWorkbench();
    }
    await reconcilePendingClipboardMedia(opened.project.id);
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
    await withProjectPersistenceTimeout(projectPersistenceClient.close()).catch(() => undefined);
    clearPendingFailedProjectCommit();
    set({
      availableSnapshotIds: [],
      agentPanelCollapsed: true,
      canReloadDurableProject: false,
      canRetryProjectCommit: false,
      desktopRevision: 0,
      project: createUntitledProject(),
      projectLifecycle: 'untitled',
      projectCommitConflictCode: null,
      recoveryRequired: false,
      projectImages: [],
      projectVideos: [],
      projectImageError: null,
      projectImageImportingNodeId: null,
      saveErrorCode: null,
      saveStatus: 'pending',
      undoStack: [],
    });
  },
  migrateLegacyStarterProjectToFigmaWorkbench: () => enqueueStableProjectOperation(set, get, async (commitNow) => {
    const state = get();
    if (state.recoveryRequired || !isRetiredStarterCanvasProject(state.project)) return false;

    try {
      await projectPersistenceClient.stablePoint();
    } catch {
      return false;
    }

    const transactionId = `migrate-legacy-starter-to-figma-ui-gate-${Date.now()}-${planSequence++}`;
    const migratedCanvas = createFigmaHybridCanvasProject(state.project);
    const memoryEntry = createFigmaWorkbenchMigrationMemory(
      state.project,
      migratedCanvas,
      transactionId,
      new Date().toISOString(),
    );
    const nextProject: CanvasProject = {
      ...migratedCanvas,
      projectMemory: appendProjectMemoryEntry(migratedCanvas.projectMemory, memoryEntry),
    };
    const transaction: ProjectTransaction = {
      id: transactionId,
      label: 'Migrate legacy starter canvas to Figma workbench',
      operations: [
        { kind: 'replace_canvas_state', nodes: nextProject.nodes, edges: nextProject.edges },
        { kind: 'append_project_memory', entry: memoryEntry },
      ],
    };
    const saved = await commitNow(transaction, { kind: 'system', nextProject });
    if (saved) set({ agentPlan: null, undoStack: [] });
    return saved;
  }),
  importImageForModule: (nodeId, file) => importProjectImageWithTarget({ kind: 'module', nodeId }, file),
  importAgentReferenceImage: (file) => importAgentReferenceImageIntoProject(file),
  importAgentReferenceVideo: (file) => importAgentReferenceVideoIntoProject(file),
  importVideoForModule: (nodeId, file) => importProjectVideoForModule(nodeId, file),
  pasteClipboardImage: (position) => pasteClipboardImageAt(position),
  pasteClipboardMedia: (position) => pasteClipboardMediaAt(position),
  importDroppedMedia: (file, position) => importDroppedMediaAt(file, position),
  importPlacementReference: (nodeId, role) => importProjectImageWithTarget({
    kind: 'placement_reference',
    nodeId,
    role,
  }),
  refreshProjectImages: async () => {
    try {
      const [projectImages, projectVideos] = await Promise.all([
        projectPersistenceClient.listProjectImages(),
        projectPersistenceClient.listProjectVideos?.() ?? Promise.resolve([]),
      ]);
      set({ projectImages, projectVideos, projectImageError: null });
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
  saveProjectExplicitly: async () => {
    if (get().recoveryRequired || get().saveStatus === 'read_only') return false;
    // A failed durable commit keeps its exact request for retry. The top-bar
    // Save button and Ctrl/Cmd+S must retry that request instead of silently
    // returning false forever while the UI says “保存失败”.
    if (pendingFailedProjectCommit !== null) return get().retryFailedProjectCommit();
    set({ saveErrorCode: null, saveStatus: 'saving' });
    try {
      return await flushPendingProjectSave(get, set, 'stable-boundary');
    } catch (error) {
      set({ saveErrorCode: readErrorCode(error), saveStatus: 'error' });
      return false;
    }
  },
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
    if (project.id !== get().project.id) invalidateProjectPersistenceBoundary();
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
  draftReverseWorkflowPlan: (input) => {
    if (isAgentPlanBusy(get().agentPlan)) {
      rejectAgentPlanMutationDuringProcessing(set);
      return;
    }
    clearPendingAgentConfirmation();
    const state = get();
    if (
      !input.modelRoute.trim()
      || input.references.length === 0
      || !input.analysis.runnable
      || containsProtectedRendererPayload(input.analysis.prompts.zh)
    ) return;
    const plan = buildReverseAgentCanvasPlan({
      project: state.project,
      persistenceGeneration: projectPersistenceGeneration,
      modelRoute: input.modelRoute,
      modelRouteDisplayName: input.modelRouteDisplayName,
      knowledgeBaseIds: input.knowledgeBaseIds,
      references: input.references.map((reference) => ({ ...reference })),
      analysis: input.analysis,
    });
    set({ agentPlan: plan });
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
          const projectSessionId = await resolveModelExecutionSessionId();
          modelJobs = await getModelJobStore().enqueueConfirmedJobs({
            conversationId: committingPlan.modelConversationId ?? AGENT_MODEL_CONVERSATION_ID,
            projectSessionId,
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
        if (restored.recoveryRequired !== true) {
          await recoverModelJobsInBackground(getModelJobStore());
        }
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
      const memoryEntry = undoEntry.memoryId === undefined
        ? null
        : createUndoMemory(reverted, undoEntry.memoryId, undoEntry.transaction.id, now);
      const projectMemory = memoryEntry === null
        ? reverted.projectMemory
        : appendProjectMemoryEntry(reverted.projectMemory, memoryEntry);
      const project = memoryEntry === null
        ? reverted
        : {
          ...reverted,
          projectMemory,
          skillPromotionCandidates: filterValidSkillPromotionCandidates(
            reverted.id,
            projectMemory,
            reverted.skillPromotionCandidates,
          ),
        };
      const transaction = memoryEntry === null
        ? {
          id: `undo:${undoEntry.transaction.id}`,
          label: undoEntry.transaction.label,
          operations: undoEntry.transaction.operations.map((operation) => ({ kind: 'canvas' as const, operation })),
        }
        : buildProjectTransaction({
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

const pristineAppStoreState = useAppStore.getState();

async function importAgentReferenceImageIntoProject(file?: File): Promise<ProjectImageAssetSummary | null> {
  let importedAsset: ProjectImageAssetSummary | null = null;
  const completed = await enqueueStableProjectOperation(
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

      const previousSaveStatus = before.saveStatus;
      useAppStore.setState({
        projectImageError: null,
        projectImageImportingNodeId: 'agent_reference',
        saveErrorCode: null,
        saveStatus: 'saving',
      });
      try {
        const result = file === undefined
          ? await projectPersistenceClient.importProjectImage({ kind: 'agent_reference' } as unknown as ProjectImageImportTarget)
          : await projectPersistenceClient.importProjectImage({ kind: 'agent_reference' } as unknown as ProjectImageImportTarget, file);
        if (generation !== projectPersistenceGeneration || useAppStore.getState().project.id !== before.project.id) return false;
        if (result === null) {
          useAppStore.setState({
            projectImageImportingNodeId: null,
            saveStatus: previousSaveStatus,
          });
          return false;
        }
        const current = useAppStore.getState();
        importedAsset = result.asset;
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
        if (generation !== projectPersistenceGeneration || useAppStore.getState().project.id !== before.project.id) return false;
        const code = readErrorCode(error);
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
  return completed ? importedAsset : null;
}
async function importAgentReferenceVideoIntoProject(file?: File): Promise<ProjectVideoAssetSummary | null> {
  let importedAsset: ProjectVideoAssetSummary | null = null;
  const completed = await enqueueStableProjectOperation(
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

      const previousSaveStatus = before.saveStatus;
      useAppStore.setState({
        projectImageError: null,
        projectImageImportingNodeId: 'agent_reference_video',
        saveErrorCode: null,
        saveStatus: 'saving',
      });
      try {
        const result = file === undefined
          ? await projectPersistenceClient.importAgentReferenceVideo?.() ?? null
          : await projectPersistenceClient.importAgentReferenceVideo?.(file) ?? null;
        if (generation !== projectPersistenceGeneration || useAppStore.getState().project.id !== before.project.id) return false;
        if (result === null) {
          useAppStore.setState({ projectImageImportingNodeId: null, saveStatus: previousSaveStatus });
          return false;
        }
        const current = useAppStore.getState();
        importedAsset = result.asset;
        useAppStore.setState({
          desktopRevision: result.revision,
          project: result.project,
          projectVideos: upsertProjectVideoSummary(current.projectVideos, result.asset),
          projectImageError: null,
          projectImageImportingNodeId: null,
          saveErrorCode: null,
          saveStatus: 'saved',
        });
        return true;
      } catch (error) {
        if (generation !== projectPersistenceGeneration || useAppStore.getState().project.id !== before.project.id) return false;
        const code = readErrorCode(error);
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
  return completed ? importedAsset : null;
}
async function importProjectImageWithTarget(target: ProjectImageImportTarget, file?: File): Promise<boolean> {
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
      if (target.kind === 'agent_reference') return false;
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
        const result = file === undefined
          ? await projectPersistenceClient.importProjectImage(target)
          : await projectPersistenceClient.importProjectImage(target, file);
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
            const assetState = await readProjectImagesForHydration();
            useAppStore.setState({
              availableSnapshotIds: hydrated.availableSnapshotIds,
              desktopRevision: hydrated.revision,
              persistenceMode: hydrated.mode,
              project: hydrated.project,
              projectLifecycle: hydrated.lifecycle,
              ...assetState,
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

async function importProjectVideoForModule(nodeId: string, file?: File): Promise<boolean> {
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
      const node = before.project.nodes.find((candidate) => candidate.id === nodeId);
      if (node?.type !== 'module' || node.data.moduleType !== 'video_input') return false;
      const previousSaveStatus = before.saveStatus;
      useAppStore.setState({
        projectImageError: null,
        projectImageImportingNodeId: nodeId,
        saveErrorCode: null,
        saveStatus: 'saving',
      });
      try {
        const result = file === undefined
          ? await projectPersistenceClient.importProjectVideo?.(nodeId) ?? null
          : await projectPersistenceClient.importProjectVideo?.(nodeId, file) ?? null;
        if (generation !== projectPersistenceGeneration || useAppStore.getState().project.id !== before.project.id) return false;
        if (result === null) {
          useAppStore.setState({ projectImageImportingNodeId: null, saveStatus: previousSaveStatus });
          return false;
        }
        const current = useAppStore.getState();
        useAppStore.setState({
          desktopRevision: result.revision,
          project: result.project,
          projectVideos: upsertProjectVideoSummary(current.projectVideos, result.asset),
          projectImageError: null,
          projectImageImportingNodeId: null,
          saveErrorCode: null,
          saveStatus: 'saved',
        });
        return true;
      } catch (error) {
        if (generation !== projectPersistenceGeneration || useAppStore.getState().project.id !== before.project.id) return false;
        const code = readErrorCode(error);
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

async function pasteClipboardImageAt(position: { readonly x: number; readonly y: number }): Promise<boolean> {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return false;
  const operationId = createClipboardPasteOperationId();
  const videoOperationId = createClipboardVideoOperationId();
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
      const previousSaveStatus = before.saveStatus;
      useAppStore.setState({
        projectImageError: null,
        projectImageImportingNodeId: 'clipboard-image',
        saveErrorCode: null,
        saveStatus: 'saving',
      });
      if (!persistPendingClipboardMedia({
        version: 1,
        projectId: before.project.id,
        position,
        videoOperationId,
        imageOperationId: operationId,
        phase: 'image',
        createdAt: Date.now(),
      })) {
        useAppStore.setState({
          projectImageImportingNodeId: null,
          saveErrorCode: 'BROWSER_PERSIST_FAILED',
          saveStatus: 'error',
        });
        return false;
      }
      try {
        const result = await projectPersistenceClient.pasteClipboardImage({ operationId, position });
        if (generation !== projectPersistenceGeneration || useAppStore.getState().project.id !== before.project.id) return false;
        if (result === null) {
          useAppStore.setState({ projectImageImportingNodeId: null, saveStatus: previousSaveStatus });
          clearPendingClipboardMedia();
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
        clearPendingClipboardMedia();
        return true;
      } catch (error) {
        if (generation !== projectPersistenceGeneration || useAppStore.getState().project.id !== before.project.id) return false;
        const code = readErrorCode(error);
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

async function importDroppedMediaAt(file: File, position: { readonly x: number; readonly y: number }): Promise<boolean> {
  // The desktop preload verifies the native file identity. Renderer code must
  // not reject a context-isolated File proxy with a realm-specific instanceof.
  if (file === null || typeof file !== 'object' || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return false;
  const operationId = createDroppedMediaOperationId();
  return enqueueStableProjectOperation(
    (partial) => useAppStore.setState(partial),
    () => useAppStore.getState(),
    async () => {
      const generation = projectPersistenceGeneration;
      const before = useAppStore.getState();
      if (before.projectImageImportingNodeId !== null || before.saveStatus === 'read_only' || before.canRetryProjectCommit || before.recoveryRequired) {
        return false;
      }
      const previousSaveStatus = before.saveStatus;
      useAppStore.setState({
        projectImageError: null,
        projectImageImportingNodeId: 'dropped-media',
        saveErrorCode: null,
        saveStatus: 'saving',
      });
      try {
        const result = await projectPersistenceClient.importDroppedMedia?.({ file, operationId, position }) ?? null;
        if (generation !== projectPersistenceGeneration || useAppStore.getState().project.id !== before.project.id) return false;
        if (result === null) {
          useAppStore.setState({
            projectImageError: 'UNSUPPORTED_DROPPED_MEDIA',
            projectImageImportingNodeId: null,
            saveStatus: previousSaveStatus,
          });
          return false;
        }
        const current = useAppStore.getState();
        if (result.asset.mediaType === 'video/mp4') {
          useAppStore.setState({
            desktopRevision: result.revision,
            project: result.project,
            projectImageError: null,
            projectImageImportingNodeId: null,
            projectVideos: upsertProjectVideoSummary(current.projectVideos, result.asset),
            saveErrorCode: null,
            saveStatus: 'saved',
          });
        } else {
          useAppStore.setState({
            desktopRevision: result.revision,
            project: result.project,
            projectImages: upsertProjectImageSummary(current.projectImages, result.asset),
            projectImageError: null,
            projectImageImportingNodeId: null,
            saveErrorCode: null,
            saveStatus: 'saved',
          });
        }
        return true;
      } catch (error) {
        if (generation !== projectPersistenceGeneration || useAppStore.getState().project.id !== before.project.id) return false;
        const code = readErrorCode(error);
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

async function pasteClipboardMediaAt(position: { readonly x: number; readonly y: number }): Promise<boolean> {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return false;
  const videoOperationId = createClipboardVideoOperationId();
  const imageOperationId = createClipboardPasteOperationId();
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
      const previousSaveStatus = before.saveStatus;
      useAppStore.setState({
        projectImageError: null,
        projectImageImportingNodeId: 'clipboard-media',
        saveErrorCode: null,
        saveStatus: 'saving',
      });
      if (!persistPendingClipboardMedia({
        version: 1,
        projectId: before.project.id,
        position,
        videoOperationId,
        imageOperationId,
        phase: 'video',
        createdAt: Date.now(),
      })) {
        useAppStore.setState({
          projectImageImportingNodeId: null,
          saveErrorCode: 'BROWSER_PERSIST_FAILED',
          saveStatus: 'error',
        });
        return false;
      }
      try {
        const videoResult = await projectPersistenceClient.pasteClipboardVideo?.({
          operationId: videoOperationId,
          position,
        }) ?? null;
        if (generation !== projectPersistenceGeneration || useAppStore.getState().project.id !== before.project.id) return false;
        if (videoResult !== null) {
          const current = useAppStore.getState();
          useAppStore.setState({
            desktopRevision: videoResult.revision,
            project: videoResult.project,
            projectVideos: upsertProjectVideoSummary(current.projectVideos, videoResult.asset),
            projectImageError: null,
            projectImageImportingNodeId: null,
            saveErrorCode: null,
            saveStatus: 'saved',
          });
          clearPendingClipboardMedia();
          return true;
        }
        if (!persistPendingClipboardMedia({
          version: 1,
          projectId: before.project.id,
          position,
          videoOperationId,
          imageOperationId,
          phase: 'image',
          createdAt: Date.now(),
        })) {
          useAppStore.setState({
            projectImageImportingNodeId: null,
            saveErrorCode: 'BROWSER_PERSIST_FAILED',
            saveStatus: 'error',
          });
          return false;
        }
        const imageResult = await projectPersistenceClient.pasteClipboardImage({
          operationId: imageOperationId,
          position,
        });
        if (generation !== projectPersistenceGeneration || useAppStore.getState().project.id !== before.project.id) return false;
        if (imageResult === null) {
          useAppStore.setState({
            projectImageError: 'CLIPBOARD_MEDIA_UNAVAILABLE',
            projectImageImportingNodeId: null,
            saveStatus: previousSaveStatus,
          });
          clearPendingClipboardMedia();
          return false;
        }
        const current = useAppStore.getState();
        useAppStore.setState({
          desktopRevision: imageResult.revision,
          project: imageResult.project,
          projectImages: upsertProjectImageSummary(current.projectImages, imageResult.asset),
          projectImageError: null,
          projectImageImportingNodeId: null,
          saveErrorCode: null,
          saveStatus: 'saved',
        });
        clearPendingClipboardMedia();
        return true;
      } catch (error) {
        if (generation !== projectPersistenceGeneration || useAppStore.getState().project.id !== before.project.id) return false;
        const code = readErrorCode(error);
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

interface PendingClipboardMediaOperation {
  readonly createdAt: number;
  readonly imageOperationId: string;
  readonly phase: 'image' | 'video';
  readonly position: { readonly x: number; readonly y: number };
  readonly projectId: string;
  readonly version: 1;
  readonly videoOperationId: string;
}

async function reconcilePendingClipboardMedia(projectId: string): Promise<void> {
  const pending = readPendingClipboardMedia();
  if (pending === null) return;
  if (pending.projectId !== projectId) {
    clearPendingClipboardMedia();
    return;
  }
  try {
    if (pending.phase === 'video') {
      const videoResult = await projectPersistenceClient.pasteClipboardVideo?.({
        operationId: pending.videoOperationId,
        position: pending.position,
        reconcileOnly: true,
      }) ?? null;
      if (videoResult !== null) {
        const current = useAppStore.getState();
        useAppStore.setState({
          desktopRevision: videoResult.revision,
          project: videoResult.project,
          projectVideos: upsertProjectVideoSummary(current.projectVideos, videoResult.asset),
          projectImageError: null,
          projectImageImportingNodeId: null,
          saveErrorCode: null,
          saveStatus: 'saved',
        });
        clearPendingClipboardMedia();
        return;
      }
    }
    const imageResult = await projectPersistenceClient.pasteClipboardImage({
      operationId: pending.imageOperationId,
      position: pending.position,
      reconcileOnly: true,
    });
    if (imageResult !== null) {
      const current = useAppStore.getState();
      useAppStore.setState({
        desktopRevision: imageResult.revision,
        project: imageResult.project,
        projectImages: upsertProjectImageSummary(current.projectImages, imageResult.asset),
        projectImageError: null,
        projectImageImportingNodeId: null,
        saveErrorCode: null,
        saveStatus: 'saved',
      });
    }
    clearPendingClipboardMedia();
  } catch {
    // Retain only opaque operation identities so the next hydration can retry reconciliation.
  }
}

function persistPendingClipboardMedia(pending: PendingClipboardMediaOperation): boolean {
  try {
    globalThis.localStorage?.setItem(PENDING_CLIPBOARD_MEDIA_STORAGE_KEY, JSON.stringify(pending));
    return globalThis.localStorage?.getItem(PENDING_CLIPBOARD_MEDIA_STORAGE_KEY) === JSON.stringify(pending);
  } catch {
    return false;
  }
}

function clearPendingClipboardMedia(): void {
  try {
    globalThis.localStorage?.removeItem(PENDING_CLIPBOARD_MEDIA_STORAGE_KEY);
  } catch {
    // Ignore unavailable renderer session storage.
  }
}

function readPendingClipboardMedia(): PendingClipboardMediaOperation | null {
  let parsed: unknown;
  try {
    const raw = globalThis.localStorage?.getItem(PENDING_CLIPBOARD_MEDIA_STORAGE_KEY);
    if (raw === null || raw === undefined) return null;
    parsed = JSON.parse(raw);
  } catch {
    clearPendingClipboardMedia();
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    clearPendingClipboardMedia();
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const position = record.position;
  const now = Date.now();
  const valid = record.version === 1
    && typeof record.projectId === 'string'
    && typeof record.videoOperationId === 'string'
    && /^clipboard_video_[a-z0-9-]{4,72}$/u.test(record.videoOperationId)
    && typeof record.imageOperationId === 'string'
    && /^clipboard_paste_[a-z0-9-]{4,72}$/u.test(record.imageOperationId)
    && (record.phase === 'video' || record.phase === 'image')
    && typeof record.createdAt === 'number'
    && Number.isFinite(record.createdAt)
    && record.createdAt <= now
    && now - record.createdAt <= PENDING_CLIPBOARD_MEDIA_MAX_AGE_MS
    && typeof position === 'object'
    && position !== null
    && !Array.isArray(position)
    && Number.isFinite((position as Record<string, unknown>).x)
    && Number.isFinite((position as Record<string, unknown>).y);
  if (!valid) {
    clearPendingClipboardMedia();
    return null;
  }
  return parsed as PendingClipboardMediaOperation;
}

function createClipboardPasteOperationId(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === 'function') return `clipboard_paste_${crypto.randomUUID().toLocaleLowerCase()}`;
  if (typeof crypto?.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return `clipboard_paste_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }
  return `clipboard_paste_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function createClipboardVideoOperationId(): string {
  return `clipboard_video_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function createDroppedMediaOperationId(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === 'function') return `dropped_media_${crypto.randomUUID().toLocaleLowerCase()}`;
  return `dropped_media_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function upsertProjectImageSummary(
  assets: readonly ProjectImageAssetSummary[],
  asset: ProjectImageAssetSummary,
): ProjectImageAssetSummary[] {
  return assets.some((candidate) => candidate.assetId === asset.assetId)
    ? assets.map((candidate) => candidate.assetId === asset.assetId ? asset : candidate)
    : [...assets, asset];
}

function upsertProjectVideoSummary(
  assets: readonly ProjectVideoAssetSummary[],
  asset: ProjectVideoAssetSummary,
): ProjectVideoAssetSummary[] {
  return assets.some((candidate) => candidate.assetId === asset.assetId)
    ? assets.map((candidate) => candidate.assetId === asset.assetId ? asset : candidate)
    : [...assets, asset];
}

async function resolveModelExecutionSessionId(): Promise<string | undefined> {
  if (projectPersistenceClient.ensureModelExecutionSession !== undefined) {
    const sessionId = await projectPersistenceClient.ensureModelExecutionSession();
    if (sessionId === null) throw new Error('Project session is unavailable');
    return sessionId;
  }
  return projectPersistenceClient.getSessionId?.() ?? undefined;
}

type CompatibleProjectPersistenceClient = Omit<
  ProjectPersistenceClient,
  'chatSkill' | 'copyHistoryToProject' | 'importProjectImage' | 'importDroppedMedia' | 'importProjectVideo' | 'importAgentReferenceVideo' | 'listProjectImages' | 'listProjectVideos' | 'pasteClipboardImage' | 'pasteClipboardVideo'
> & Partial<Pick<ProjectPersistenceClient, 'chatSkill' | 'copyHistoryToProject' | 'importProjectImage' | 'importDroppedMedia' | 'importProjectVideo' | 'importAgentReferenceVideo' | 'listProjectImages' | 'listProjectVideos' | 'pasteClipboardImage' | 'pasteClipboardVideo'>>;

export function replaceProjectPersistenceClientForTests(client: CompatibleProjectPersistenceClient): void {
  projectPersistenceClient = withProjectImagePersistenceDefaults(client);
  registerActiveProjectPersistenceClient(projectPersistenceClient);
}

function withProjectImagePersistenceDefaults(client: CompatibleProjectPersistenceClient): ProjectPersistenceClient {
  return {
    ...client,
    chatSkill: client.chatSkill ?? (async () => { throw new Error('Skill chat is unavailable'); }),
    copyHistoryToProject: client.copyHistoryToProject ?? (async () => null),
    importProjectImage: client.importProjectImage ?? (async () => null),
    importDroppedMedia: client.importDroppedMedia ?? (async () => null),
    importProjectVideo: client.importProjectVideo ?? (async () => null),
    importAgentReferenceVideo: client.importAgentReferenceVideo ?? (async () => null),
    listProjectImages: client.listProjectImages ?? (async () => []),
    listProjectVideos: client.listProjectVideos ?? (async () => []),
    pasteClipboardImage: client.pasteClipboardImage ?? (async () => null),
    pasteClipboardVideo: client.pasteClipboardVideo ?? (async () => null),
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
  options: { allowPendingFailure?: boolean; allowRecovery?: boolean; throwOnRecovery?: boolean } = {},
): Promise<boolean> {
  const generation = projectPersistenceGeneration;
  const run = async (): Promise<boolean> => {
    if (generation !== projectPersistenceGeneration) return false;
    if (!options.allowPendingFailure && pendingFailedProjectCommit !== null) {
      markProjectSaveRetryRequired(set, get);
      return false;
    }
    if (get().projectCommitConflictCode !== null) {
      markProjectSaveConflict(set, get);
      return false;
    }
    if (!options.allowRecovery && get().recoveryRequired) {
      if (options.throwOnRecovery) {
        throw createGenerationStartError('RECOVERY_REQUIRED', 'Recovery preview must be restored before generation starts');
      }
      return false;
    }
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
  if (!options.preservePendingAutosave) cancelPendingProjectSave();
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
  const undoTransaction = kind === 'canvas' ? createCanvasInverseTransaction(before, transaction) : null;
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
  const saved = await executeProjectCommit(request, set, get);
  if (saved && undoTransaction !== null) {
    set({ undoStack: appendUndoEntry(get().undoStack, { transaction: undoTransaction }) });
  }
  return saved;
}

export function resetAppStoreForTests(options: { project?: 'empty' | 'starter' } = { project: 'starter' }): void {
  invalidateProjectPersistenceBoundary();
  cancelPendingProjectSave();
  clearPendingFailedProjectCommit();
  pendingProjectFlushBoundary = null;
  clearPendingAgentConfirmation();
  pendingAgentJobRetry = null;
  activeReverseAgentRuns.clear();
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
    ? { ...pristineAppStoreState, ...state, project: createUntitledProject() }
    : { ...pristineAppStoreState, ...state, project: createStarterProject(), projectLifecycle: 'durable', saveStatus: 'pending' }, true);
}

function getModuleNode(nodes: readonly CanvasProject['nodes'][number][], nodeId: string): CanvasModuleNode | undefined {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  return node?.type === 'module' ? node : undefined;
}

function createReverseConfigurationSaveError(state: AppState): Error & { code: string } {
  const code = state.projectCommitConflictCode
    ?? (state.recoveryRequired
      ? 'RECOVERY_REQUIRED'
      : state.saveStatus === 'read_only'
        ? 'PROJECT_READ_ONLY'
        : state.canRetryProjectCommit
          ? 'PROJECT_SAVE_RETRY_REQUIRED'
          : 'PROJECT_CONFIG_SAVE_FAILED');
  return Object.assign(new Error('Reverse configuration could not be saved.'), { code });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function readGenerationProvider(value: unknown): ModelJobProvider | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLocaleLowerCase();
  return normalized === 'comfly' || normalized === 'relayme' ? normalized : undefined;
}

function readGenerationDisplayName(config: CanvasModuleNode['data']['config']): string | undefined {
  return isNonEmptyString(config.modelDisplayName)
    ? config.modelDisplayName
    : isNonEmptyString(config.routeDisplayName)
      ? config.routeDisplayName
      : undefined;
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
    // Every commit path (manual, idle autosave, and retry) must have the same
    // upper bound. Otherwise a desktop bridge that never acknowledges leaves
    // the top-bar state in `saving` forever.
    const result = await withProjectPersistenceTimeout(projectPersistenceClient.commit(request));
    if (!isActiveProjectCommit(token, get)) {
      const state = get();
      const supersededByNewerDraft = result.ok
        && activeProjectCommitToken === token
        && token.generation === projectPersistenceGeneration
        && state.project.id === request.projectId;
      if (!supersededByNewerDraft) return false;
      set({
        desktopRevision: result.revision,
        saveErrorCode: null,
        saveStatus: 'pending',
      });
      return true;
    }
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
  } catch (error) {
    if (activeProjectCommitToken === token) {
      pendingFailedProjectCommit = request;
      set({
        canReloadDurableProject: false,
        canRetryProjectCommit: true,
        saveErrorCode: readErrorCode(error),
        saveStatus: 'error',
      });
    }
    return false;
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
    // The bridge rejected the transaction against its current durable
    // project. Keep the renderer on that acknowledged project instead of
    // repeatedly retrying the same stale edge/node operation.
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

async function readProjectImagesForHydration(): Promise<Pick<AppState, 'projectImages' | 'projectVideos' | 'projectImageError'>> {
  try {
    const [projectImages, projectVideos] = await Promise.all([
      projectPersistenceClient.listProjectImages(),
      projectPersistenceClient.listProjectVideos?.() ?? Promise.resolve([]),
    ]);
    return {
      projectImages,
      projectVideos,
      projectImageError: null,
    };
  } catch (error) {
    return {
      projectImages: [],
      projectVideos: [],
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

function createInitialState(): Pick<AppState, 'project' | 'projectLifecycle' | 'projectImages' | 'projectVideos' | 'projectImageError' | 'projectImageImportingNodeId' | 'persistenceMode' | 'desktopRevision' | 'availableSnapshotIds' | 'canReloadDurableProject' | 'canRetryProjectCommit' | 'projectCommitConflictCode' | 'recoveryRequired' | 'knowledgeBases' | 'knowledgeSyncStatuses' | 'saveStatus' | 'saveErrorCode' | 'agentPanelCollapsed' | 'activeTool' | 'agentPlan' | 'undoStack' | 'confirmedModelJobs' | 'modelJobs'> {
  const desktopMode = isDesktopBridgeAvailable();
  return {
    activeTool: 'select',
    agentPanelCollapsed: true,
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
    projectVideos: [],
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

function isReverseAgentRunActive(get: () => AppState, nodeId: string, runId: string): boolean {
  const node = getModuleNode(get().project.nodes, nodeId);
  return activeReverseAgentRuns.get(nodeId) === runId
    && node?.data.moduleType === 'reverse_agent'
    && node.data.config.reverseAgentRunId === runId
    && node.data.config.reverseAgentRunState === 'running';
}

function createReverseRunCancelledError(): Error & { readonly code: 'REVERSE_RUN_CANCELLED' } {
  return Object.assign(new Error('Reverse analysis was stopped'), { code: 'REVERSE_RUN_CANCELLED' as const });
}

function createInterruptedReverseRunsTransaction(project: CanvasProject): {
  readonly project: CanvasProject;
  readonly transaction: ProjectTransaction;
} | null {
  const interrupted = project.nodes.flatMap((node) => {
    if (node.type !== 'module' || node.data.moduleType !== 'reverse_agent' || node.data.config.reverseAgentRunState !== 'running') return [];
    return [{
      ...node,
      data: {
        ...node.data,
        config: {
          ...node.data.config,
          reverseAgentCompletedAt: new Date().toISOString(),
          reverseAgentError: null,
          reverseAgentRunState: 'cancelled',
        },
      },
    }];
  });
  if (interrupted.length === 0) return null;
  const transaction: ProjectTransaction = {
    id: `stop-interrupted-reverse-runs-${Date.now()}-${planSequence++}`,
    label: 'Stop interrupted reverse Agent runs',
    operations: interrupted.map((node) => ({ kind: 'canvas' as const, operation: { kind: 'update_node' as const, node } })),
  };
  return { project: applyProjectTransaction(project, transaction), transaction };
}

function persistReverseAgentRunPatch(
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
  nodeId: string,
  patch: Record<string, unknown>,
  label: string,
): Promise<boolean> {
  return enqueueStableProjectOperation(set, get, async (commitNow) => {
    const currentProject = get().project;
    const currentNode = getModuleNode(currentProject.nodes, nodeId);
    if (!currentNode || currentNode.data.moduleType !== 'reverse_agent') return false;
    const suffix = `${Date.now()}-${planSequence++}`;
    const nextNode = {
      ...currentNode,
      data: {
        ...currentNode.data,
        config: { ...currentNode.data.config, ...patch },
      },
    };
    const sourceTransaction: ProjectTransaction = {
      id: `reverse-agent-run-state-${suffix}`,
      label,
      operations: [{ kind: 'canvas', operation: { kind: 'update_node', node: nextNode } }],
    };
    const sourceCommitted = await commitNow(sourceTransaction, {
      kind: 'agent',
      nextProject: applyProjectTransaction(currentProject, sourceTransaction),
    });
    if (!sourceCommitted) return false;

    const completedResult = patch.reverseAgentRunState === 'completed' && patch.reverseAgentResult !== undefined;
    if (!completedResult) return true;

    const persistedProject = get().project;
    const persistedNode = getModuleNode(persistedProject.nodes, nodeId);
    if (!persistedNode || persistedNode.data.moduleType !== 'reverse_agent') return true;
    const existingResultEdge = persistedProject.edges.find((edge) => {
      if (edge.source !== nodeId || edge.sourcePortId !== 'analysis' || edge.targetPortId !== 'analysis') return false;
      const target = getModuleNode(persistedProject.nodes, edge.target);
      return target?.data.moduleType === 'reverse_result';
    });
    if (existingResultEdge !== undefined) return true;

    const existingIds = new Set(persistedProject.nodes.map((node) => node.id));
    const baseId = `reverse-result-${nodeId}`;
    let resultNodeId = baseId;
    let index = 2;
    while (existingIds.has(resultNodeId)) resultNodeId = `${baseId}-${index++}`;
    const resultNode = createCanvasModuleNode(resultNodeId, 'reverse_result', {
      x: persistedNode.position.x + 680,
      y: persistedNode.position.y,
    });
    const resultTransaction: ProjectTransaction = {
      id: `reverse-agent-result-node-${suffix}`,
      label: 'Create reverse Agent result node',
      operations: [
        { kind: 'canvas', operation: { kind: 'create_node', node: resultNode } },
        { kind: 'canvas', operation: { kind: 'create_edge', edge: {
          id: createModuleEdgeId(persistedProject.edges.map((edge) => edge.id), {
            sourceId: nodeId,
            sourcePortId: 'analysis',
            targetId: resultNodeId,
            targetPortId: 'analysis',
            order: 0,
          }),
          source: nodeId,
          sourcePortId: 'analysis',
          target: resultNodeId,
          targetPortId: 'analysis',
          order: 0,
        } } },
      ],
    };
    try {
      await commitNow(resultTransaction, {
        kind: 'agent',
        nextProject: applyProjectTransaction(persistedProject, resultTransaction),
      });
    } catch {
      // The durable source result is authoritative; the companion node is optional.
    }
    return true;
  });
}

function getModelJobStore(): ModelJobStore {
  if (!modelJobStore) {
    const generation = modelJobStoreGeneration;
    const canContinueResult = async (ownerJob: ModelJob, isOwnerRunning: () => Promise<boolean>) => {
      if (generation !== modelJobStoreGeneration) return false;
      const ownsActiveResult = () => (
        ownerJob.projectSessionId === undefined
        || projectPersistenceClient.getSessionId?.() === ownerJob.projectSessionId
        || projectOwnsModelResult(useAppStore.getState().project, ownerJob)
      );
      if (!ownsActiveResult()) return false;
      if (!await isOwnerRunning()) return false;
      return generation === modelJobStoreGeneration && ownsActiveResult();
    };
    modelJobStore = createModelJobStore({
      decodeConcurrency: runtimeProfile.imageDecodeConcurrency,
      storage: modelJobStorageOverride ?? (isIndexedDbAvailable() ? undefined : createInMemoryModelJobStorage()),
      executor: modelJobExecutorOverride ?? createDefaultModelJobExecutor(),
      canContinueResult,
      canRecoverRunningJob: async (ownerJob) => (
        generation === modelJobStoreGeneration
        && projectOwnsModelResult(useAppStore.getState().project, ownerJob)
      ),
      commitProjectTransaction: async (build, ownerJob, isOwnerRunning) => {
        const currentProject = useAppStore.getState().project;
        const rejected = { committed: false, resultNodeId: build(currentProject).resultNodeId };
        const canContinue = () => canContinueResult(ownerJob, isOwnerRunning);
        if (!await canContinue()) return rejected;
        const commit = await commitGeneratedResultWithRefresh({
          build,
          canContinue,
          commit: (transaction) => useAppStore.getState().commitProjectTransaction(transaction, { kind: 'agent' }),
          getLocalProject: () => useAppStore.getState().project,
          reloadDurableProject: async () => {
            const reload = projectPersistenceClient.reloadDurableProject;
            if (reload === undefined) return null;
            try {
              const refreshed = await reload();
              if (refreshed === null || refreshed.recoveryRequired === true || refreshed.saveStatus !== 'saved') return null;
              return { project: refreshed.project, revision: refreshed.revision };
            } catch {
              return null;
            }
          },
          adoptRefreshedProject: (project, revision) => {
            clearPendingFailedProjectCommit();
            useAppStore.setState({
              canReloadDurableProject: false,
              canRetryProjectCommit: false,
              desktopRevision: revision,
              project,
              projectCommitConflictCode: null,
              saveErrorCode: null,
              saveStatus: 'saved',
            });
          },
        });
        if (commit.committed) {
          await useAppStore.getState().refreshProjectImages();
          if (!await canContinue()) return rejected;
        }
        return commit;
      },
      repairCompletedProjectTransaction: async (build) => {
        const currentProject = useAppStore.getState().project;
        const materialization = build(currentProject);
        const sourceNode = getModuleNode(currentProject.nodes, materialization.resultNodeId);
        if (sourceNode === undefined || (
          sourceNode.data.moduleType !== 'image_generation'
          && sourceNode.data.moduleType !== 'video_generation'
        )) return { committed: false, resultNodeId: materialization.resultNodeId };
        const committed = await useAppStore.getState().commitProjectTransaction(materialization.transaction, { kind: 'agent' });
        if (committed) await useAppStore.getState().refreshProjectImages();
        return { committed, resultNodeId: materialization.resultNodeId };
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

async function recoverModelJobsInBackground(jobStore: ModelJobStore): Promise<void> {
  const generation = ++modelJobRecoveryGeneration;
  try {
    await jobStore.recover();
    if (generation !== modelJobRecoveryGeneration || jobStore !== modelJobStore) return;
    void jobStore.run();
    const modelJobs = await jobStore.listJobs();
    if (generation !== modelJobRecoveryGeneration || jobStore !== modelJobStore) return;
    useAppStore.setState({
      confirmedModelJobs: countConfirmedModelJobs(modelJobs),
      modelJobs,
    });
  } catch {
    // Recovery is retried on the next hydrate/run; job-level failures are persisted by the job store.
  }
}

function projectOwnsModelResult(project: CanvasProject, ownerJob: ModelJob): boolean {
  const sourceNode = project.nodes.find((node) => node.id === ownerJob.promptNodeId);
  if (sourceNode?.type !== 'module') return false;
  if (ownerJob.kind === 'video') {
    if (sourceNode.data.moduleType !== 'video_generation') return false;
  } else if (sourceNode.data.moduleType !== 'image_generation') {
    return false;
  }
  return sourceNode.data.config.lastResultJobId === ownerJob.id;
}

function invalidateModelJobStoreGeneration(): void {
  modelJobStoreGeneration += 1;
  modelJobRecoveryGeneration += 1;
}

function createGenerationStartError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}

function isGenerationStartError(error: unknown): error is Error & { readonly code: string } {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'string';
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
  provider: ModelJobProvider;
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
  const profiles = await listRunnableProviderProfiles(bridge);
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
    const projectSessionId = await resolveModelExecutionSessionId();
    const modelJobs = await getModelJobStore().enqueueConfirmedJobs({
      conversationId: plan.modelConversationId ?? AGENT_MODEL_CONVERSATION_ID,
      projectSessionId,
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
  if ((plan.modelProvider !== 'comfly' && plan.modelProvider !== 'relayme') || plan.modelRoute === undefined) return null;
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

function createCanvasInverseTransaction(
  project: CanvasProject,
  transaction: ProjectTransaction,
): CanvasTransaction | null {
  const canvasOperations = transaction.operations.filter((operation): operation is Extract<ProjectOperation, { kind: 'canvas' }> => operation.kind === 'canvas');
  if (canvasOperations.length !== transaction.operations.length) return null;
  const applied = applyTransaction(project, {
    id: transaction.id,
    label: transaction.label,
    operations: canvasOperations.map((operation) => operation.operation),
  });
  return applied.inverse;
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

export function isLegacyStarterCanvasProject(project: CanvasProject): boolean {
  const starter = createStarterProject();
  return project.version === starter.version
    && project.id === starter.id
    && project.name === starter.name
    && project.projectMemory.length === 0
    && project.skillPromotionCandidates.length === 0
    && (project.assets === undefined || project.assets.length === 0)
    && JSON.stringify(project.nodes.map(normalizeLegacyStarterNode)) === JSON.stringify(starter.nodes)
    && JSON.stringify(project.edges) === JSON.stringify(starter.edges);
}

/**
 * The original starter may have been renamed, but is otherwise still the
 * retired three-card canvas. It is safe to replace without discarding a
 * user-created module graph or a running workflow.
 */
function isRetiredStarterCanvasProject(project: CanvasProject): boolean {
  const starter = createStarterProject();
  const hasNonStarterAsset = project.assets?.some((asset) => !asset.assetId.startsWith('starter-')) ?? false;
  // The migration is intentionally limited to a pristine retired canvas.  A
  // user project that happens to contain one of the old node types must keep
  // its graph and memory; only the starter-shaped three-card canvas is safe to
  // replace.  Do not key this decision off project id/version: older durable
  // snapshots were renamed and had their graph metadata bumped while still
  // rendering the same obsolete UI.
  return project.version === starter.version
    && project.id === starter.id
    && !hasNonStarterAsset
    && project.projectMemory.length === 0
    && project.skillPromotionCandidates.length === 0
    && hasRetiredStarterTopology(project);
}

/**
 * Position, lock, edge-label and graph-version metadata is persisted
 * independently from the canvas content. Treating those harmless changes as a new workflow left
 * the retired Reference → Placement → Prompt screen visible after reopening.
 * We identify only that three-node topology and starter payload, and still
 * refuse migration as soon as it contains user assets or project memory.
 * One released starter used an Agent-plan terminal instead of the later
 * Prompt terminal; it is equally retired but was not previously recognized.
 */
function hasRetiredStarterTopology(project: CanvasProject): boolean {
  if (project.nodes.length !== 3 || project.edges.length !== 2) return false;

  const starter = createStarterProject();
  const nodeTypes = new Map(project.nodes.map((node) => [node.id, node.type]));
  const counts = project.nodes.reduce<Record<string, number>>((result, node) => {
    result[node.type] = (result[node.type] ?? 0) + 1;
    return result;
  }, {});
  if (counts.reference !== 1 || counts.placement_preview !== 1) return false;
  const hasPromptTerminal = counts.prompt === 1 && counts.agent_plan === undefined;
  const hasAgentPlanTerminal = counts.agent_plan === 1 && counts.prompt === undefined;
  if (!hasPromptTerminal && !hasAgentPlanTerminal) return false;

  if (hasAgentPlanTerminal) {
    // The caller has already verified this is the local, asset-free starter
    // project. The old Agent-plan terminal therefore contains no user-owned
    // workflow data and can be replaced with the formal UI Gate workflow.
    return project.edges.every((edge) => {
      const sourceType = nodeTypes.get(edge.source);
      const targetType = nodeTypes.get(edge.target);
      return (sourceType === 'reference' && targetType === 'placement_preview')
        || (sourceType === 'placement_preview' && targetType === 'agent_plan');
    });
  }

  // Keep user-edited canvas content safe.  Only persistence metadata may drift
  // between starter snapshots; the node payloads themselves must still match
  // the retired starter (including the placement board and prompt text).
  const projectPayloads = project.nodes
    .map((node) => ({ type: node.type, data: node.data }))
    .sort((left, right) => left.type.localeCompare(right.type));
  const starterPayloads = starter.nodes
    .map((node) => ({ type: node.type, data: node.data }))
    .sort((left, right) => left.type.localeCompare(right.type));
  if (JSON.stringify(projectPayloads) !== JSON.stringify(starterPayloads)) return false;

  // Compare only the semantic topology.  Positions, labels, copy, lock flags,
  // graph versions and generated ids are persistence metadata and have drifted
  // across released starter snapshots.
  return project.edges.every((edge) => {
    const sourceType = nodeTypes.get(edge.source);
    const targetType = nodeTypes.get(edge.target);
    return (sourceType === 'reference' && targetType === 'placement_preview')
      || (sourceType === 'placement_preview' && targetType === 'prompt');
  });
}

/**
 * `locked` was introduced after the original starter shipped. Persistence
 * normalizes an omitted lock to `false`; that metadata-only change must not
 * strand an otherwise untouched legacy canvas in the retired UI.
 */
function normalizeLegacyStarterNode(node: CanvasProject['nodes'][number]) {
  if (node.locked !== false) return node;
  const { locked: _locked, ...unlockedNode } = node;
  return unlockedNode;
}

function createFigmaHybridCanvasProject(project: CanvasProject): CanvasProject {
  const imageInput = createCanvasModuleNode('figma-image-input', 'image_input', { x: 20, y: 197 });
  const imageGeneration = createCanvasModuleNode('figma-image-generation', 'image_generation', { x: 340, y: 132 });
  imageGeneration.data.config = {
    ...imageGeneration.data.config,
    aspectRatio: '1:1',
    outputCount: 4,
    prompt: '产品视觉探索，保持参考图主体与材质一致。',
    resolution: '自动尺寸',
    resultState: 'fresh',
  };
  const imageResult = createCanvasModuleNode('figma-image-result', 'result_output', { x: 820, y: 282 });
  const videoGeneration = createCanvasModuleNode('figma-video-generation', 'video_generation', { x: 1174, y: 146 });
  videoGeneration.data.config = {
    ...videoGeneration.data.config,
    audioEnabled: false,
    durationSeconds: 5,
    modelRoute: 'seedance-1.5-pro',
    mode: 'mock',
    outputCount: 4,
    prompt: '按照参考画面生成产品动态镜头，保持颜色、主体和构图一致。',
    resolution: '1080p',
    resultState: 'fresh',
  };
  const reverseAgent = createCanvasModuleNode('figma-reverse-agent', 'reverse_agent', { x: 340, y: 1062 });
  reverseAgent.data.config = {
    ...reverseAgent.data.config,
    knowledgeBaseIds: ['scene-skill', 'ecommerce-detail-knowledge'],
    mode: 'auto',
    resultState: 'empty',
    role: '产品视觉分析师',
    task: '提取构图、材质、镜头、主体和可复用提示词。',
  };
  const reverseResult = createCanvasModuleNode('figma-reverse-result', 'reverse_result', { x: 1010, y: 1062 });
  const videoResult = createCanvasModuleNode('figma-video-result', 'video_result', { x: 1860, y: 732 });
  // The default delivery canvas is the Figma UI Gate image workflow. Other
  // workflows remain available from the module library instead of appearing
  // as unrelated legacy cards on a new canvas.
  return {
    ...project,
    nodes: [
      // Figma 411:2 uses one shared delivery coordinate system: the compact
      // upload card sits at (170, 344), the 404x420 generation workbench at
      // (340, 188), and the 404x230 result card at (820, 282).  Keeping the
      // persisted node origins identical to those anchors means the runtime
      // ports, Bézier edges and media trays all land on the same visual rails
      // in both themes instead of falling back to the retired starter layout.
      // React Flow's stage starts below the 56px application topbar, so keep
      // these as canvas-local coordinates while matching the Figma page rails.
      imageInput,
      imageGeneration,
      imageResult,
      videoGeneration,
      reverseAgent,
      reverseResult,
      videoResult,
    ],
    edges: [
      {
        id: 'figma-image-input-to-generation',
        source: 'figma-image-input',
        sourcePortId: 'image',
        target: 'figma-image-generation',
        targetPortId: 'references',
        order: 0,
      },
      {
        id: 'figma-image-generation-to-result',
        source: 'figma-image-generation',
        sourcePortId: 'result',
        target: 'figma-image-result',
        targetPortId: 'result',
        order: 0,
      },
      {
        id: 'figma-image-input-to-video',
        source: 'figma-image-input',
        sourcePortId: 'image',
        target: 'figma-video-generation',
        targetPortId: 'media',
        order: 0,
      },
      {
        id: 'figma-image-input-to-reverse-agent',
        source: 'figma-image-input',
        sourcePortId: 'image',
        target: 'figma-reverse-agent',
        targetPortId: 'references',
        order: 0,
      },
      {
        id: 'figma-reverse-agent-to-result',
        source: 'figma-reverse-agent',
        sourcePortId: 'analysis',
        target: 'figma-reverse-result',
        targetPortId: 'analysis',
        order: 0,
      },
      {
        id: 'figma-video-generation-to-result',
        source: 'figma-video-generation',
        sourcePortId: 'result',
        target: 'figma-video-result',
        targetPortId: 'video',
        order: 0,
      },
    ],
  };
}

function createFigmaWorkbenchMigrationMemory(
  before: CanvasProject,
  after: CanvasProject,
  transactionId: string,
  createdAt: string,
): ProjectMemoryEntry {
  const previousRevision = before.projectMemory[before.projectMemory.length - 1]?.projectRevision ?? 0;
  return {
    schemaVersion: 1,
    id: `project-memory-${transactionId}`,
    projectId: after.id,
    projectRevision: previousRevision + 1,
    createdAt,
    kind: 'decision',
    actor: 'user',
    title: '迁移到 Figma 画布工作台',
    changeSummary: '已将旧版 Reference、Placement 与 Agent plan 节点替换为 Figma UI Gate 模块工作台。',
    rationale: '用户确认保留旧画布稳定点后，迁移到正式模块画布。',
    snapshots: {
      beforeId: `${transactionId}:before`,
      afterId: `${transactionId}:after`,
    },
    context: {
      referenceAssetIds: collectReferenceAssetIds(before),
      resultAssetIds: before.nodes.flatMap((node) => node.type === 'image_result' ? [node.data.assetId] : []),
    },
    feedback: { keep: ['保留旧画布恢复点'], change: ['使用 Figma UI Gate 工作台'], never: ['删除原始项目文件'] },
    nextStep: '连接图片输入、反推或生图模块，继续在正式工作台完成任务。',
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

function normalizeImageAspectRatio(value: string | undefined): '1:1' | '2:3' | '3:2' | '4:3' | '3:4' | '16:9' | '9:16' | undefined {
  return value === '1:1' || value === '2:3' || value === '3:2' || value === '4:3' || value === '3:4' || value === '16:9' || value === '9:16'
    ? value
    : undefined;
}

function normalizeImageResolution(value: string | undefined): '1K' | '2K' | '4K' | undefined {
  if (value === '1K' || value === '2K' || value === '4K') return value;
  if (value === '1024x1024') return '1K';
  if (value === '1536x1024' || value === '1024x1536') return '2K';
  return undefined;
}

function normalizeVideoResolution(value: string | undefined): '360p' | '480p' | '512p' | '540p' | '720p' | '768p' | '1080p' | '2K' | '4K' | undefined {
  return value === '360p' || value === '480p' || value === '512p' || value === '540p' || value === '720p' || value === '768p' || value === '1080p' || value === '2K' || value === '4K' ? value : undefined;
}
function normalizeImageOutputCount(value: number | undefined): 1 | 2 | 3 | 4 | undefined {
  return value === 1 || value === 2 || value === 3 || value === 4 ? value : undefined;
}

function collectImageGenerationReferenceAssetIds(project: CanvasProject, targetNodeId: string): string[] {
  const orderedEdges = project.edges
    .filter((edge) => edge.target === targetNodeId && edge.targetPortId === 'references')
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
  const assetIds: string[] = [];
  for (const edge of orderedEdges) {
    const source = project.nodes.find((node) => node.id === edge.source);
    if (source?.type === 'image_result') {
      assetIds.push(source.data.assetId);
      continue;
    }
    if (source?.type !== 'module') continue;
    const assetId = source.data.config.assetId;
    if (typeof assetId === 'string' && assetId.trim().length > 0) assetIds.push(assetId);
    const assetIdList = source.data.config.assetIds;
    if (Array.isArray(assetIdList)) {
      assetIds.push(...assetIdList.filter((value): value is string => typeof value === 'string' && value.trim().length > 0));
    }
  }
  return [...new Set(assetIds)].slice(0, MAX_GENERATION_REFERENCES);
}

function resolveImageGenerationReferenceAssetIds(
  project: CanvasProject,
  targetNodeId: string,
  requestedAssetIds: readonly string[] | undefined,
): string[] | null {
  if (requestedAssetIds === undefined) return collectImageGenerationReferenceAssetIds(project, targetNodeId);
  const assetIds = [...new Set(requestedAssetIds)];
  if (assetIds.length > MAX_GENERATION_REFERENCES || assetIds.some((assetId) => !isNonEmptyString(assetId))) return null;
  const managedImageIds = new Set((project.assets ?? [])
    .filter((asset) => asset.mediaType.startsWith('image/'))
    .map((asset) => asset.assetId));
  return assetIds.every((assetId) => managedImageIds.has(assetId)) ? assetIds : null;
}

function resolveConnectedVideoGenerationMedia(
  project: CanvasProject,
  targetNodeId: string,
): { readonly imageAssetIds: string[]; readonly sourceVideoAssetId?: string } | undefined | null {
  const edges = project.edges
    .filter((edge) => edge.target === targetNodeId && edge.targetPortId === 'media')
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
  if (edges.length === 0) return undefined;
  if (edges.length > MAX_GENERATION_REFERENCES) return null;

  const images: string[] = [];
  let sourceVideoAssetId: string | undefined;
  const seenAssetIds = new Set<string>();
  for (const edge of edges) {
    const source = project.nodes.find((node) => node.id === edge.source);
    const assetId = source?.type === 'image_result'
      ? source.data.assetId
      : source?.type === 'module' && typeof source.data.config.assetId === 'string'
        ? source.data.config.assetId
        : undefined;
    const asset = assetId === undefined ? undefined : (project.assets ?? []).find((candidate) => candidate.assetId === assetId);
    if (asset === undefined || seenAssetIds.has(asset.assetId)) return null;
    seenAssetIds.add(asset.assetId);

    if (
      (source?.type === 'image_result' && edge.sourcePortId === 'image')
      || (source?.type === 'module'
        && (source.data.moduleType === 'image_input' || source.data.moduleType === 'upload_image')
        && edge.sourcePortId === 'image')
    ) {
      if (!asset.mediaType.startsWith('image/')) return null;
      images.push(asset.assetId);
      continue;
    }
    if (source?.type === 'module' && source.data.moduleType === 'video_input' && edge.sourcePortId === 'video') {
      if (asset.mediaType !== 'video/mp4' || sourceVideoAssetId !== undefined) return null;
      sourceVideoAssetId = asset.assetId;
      continue;
    }
    return null;
  }
  return { imageAssetIds: images, sourceVideoAssetId };
}

function readStoryboardShotRecords(value: unknown): Array<Record<string, unknown> & { id: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const id = (candidate as Record<string, unknown>).id;
    return isNonEmptyString(id) ? [{ ...(candidate as Record<string, unknown>), id }] : [];
  });
}

function isSafeStoryboardShotUpdate(input: StoryboardShotUpdateInput): boolean {
  return input.composition.trim().length > 0
    && input.composition.length <= 2_000
    && !containsProtectedRendererPayload(input.composition)
    && ['16:9', '1:1', '9:16'].includes(input.aspectRatio)
    && ['1024x1024', '1536x1024', '1024x1536'].includes(input.resolution)
    && Number.isInteger(input.outputCount)
    && input.outputCount >= 1
    && input.outputCount <= 4;
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
  if (pendingFailedProjectCommit !== null) {
    markProjectSaveRetryRequired(set, get);
    return false;
  }
  if (pendingProjectFlushBoundary !== null) return pendingProjectFlushBoundary;

  const hadDraft = projectAutosave.hasPending() || projectAutosave.hasInFlight();
  const flushBoundary = (async () => {
    const saved = hadDraft
      ? await withProjectPersistenceTimeout(projectAutosave.flush(reason))
      : false;
    if (get().saveStatus === 'read_only') return saved;
    if (hadDraft && !saved) return false;

    const persistStablePoint = async () => {
      const generation = projectPersistenceGeneration;
      const projectId = get().project.id;
      const stablePoint = await withProjectPersistenceTimeout(projectPersistenceClient.stablePoint());
      if (generation !== projectPersistenceGeneration || get().project.id !== projectId) return false;
      const state = get();
      const nextLifecycle = stablePoint.lifecycle ?? state.projectLifecycle;
      set({
        availableSnapshotIds: stablePoint.availableSnapshotIds,
        desktopRevision: stablePoint.revision,
        project: saved ? stablePoint.project : state.project,
        projectLifecycle: nextLifecycle,
        saveErrorCode: null,
        saveStatus: nextLifecycle === 'untitled' ? 'pending' : 'saved',
      });
      // A stable-point boundary completed successfully even when the current
      // workflow remains untitled.  The lifecycle controls the pending/saved
      // UI state above; the boolean reports whether this flush itself worked.
      return true;
    };
    return hadDraft || get().projectLifecycle !== 'untitled'
      ? enqueueStableProjectOperation(set, get, persistStablePoint)
      : persistStablePoint();
  })();
  const trackedFlushBoundary = flushBoundary.finally(() => {
    if (pendingProjectFlushBoundary === trackedFlushBoundary) pendingProjectFlushBoundary = null;
  });
  pendingProjectFlushBoundary = trackedFlushBoundary;
  return trackedFlushBoundary;
}

function markProjectSaveRetryRequired(
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
): void {
  if (get().saveStatus !== 'saving') return;
  set({
    canRetryProjectCommit: true,
    saveErrorCode: get().saveErrorCode ?? 'PROJECT_SAVE_RETRY_REQUIRED',
    saveStatus: 'error',
  });
}

function markProjectSaveConflict(
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
): void {
  if (get().saveStatus !== 'saving') return;
  set({
    saveErrorCode: get().projectCommitConflictCode ?? 'PROJECT_SAVE_CONFLICT',
    saveStatus: 'error',
  });
}

function withProjectPersistenceTimeout<T>(operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => {
      const error = new Error(`Project persistence timed out after ${PROJECT_PERSISTENCE_OPERATION_TIMEOUT_MS}ms`) as Error & { code: string };
      error.code = 'SAVE_TIMEOUT';
      reject(error);
    }, PROJECT_PERSISTENCE_OPERATION_TIMEOUT_MS);
    operation.then(
      (value) => {
        globalThis.clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

async function ensureModelRunSaveBoundary(get: () => AppState): Promise<boolean> {
  const state = get();
  // Let the stable operation produce its typed recovery/conflict error. The
  // preflight only establishes a save point for otherwise writable drafts.
  if (state.recoveryRequired || state.saveStatus === 'read_only' || pendingFailedProjectCommit !== null || state.projectCommitConflictCode !== null) return true;
  if (state.projectLifecycle === 'untitled' || state.saveStatus !== 'saved') {
    return state.saveProjectExplicitly();
  }
  return true;
}
