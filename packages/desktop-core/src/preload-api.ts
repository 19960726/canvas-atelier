import type {
  CloseProjectBridgeRequest,
  CommitAck,
  CommitBridgeRequest,
  ConfigureKnowledgeBaseBridgeRequest,
  CreateProjectBridgeRequest,
  CreateProjectBridgeResult,
  ExportPackBridgeRequest,
  ExportPackBridgeResult,
  ImportPackBridgeRequest,
  ImportPackBridgeResult,
  ImportDroppedProjectMediaBridgeRequest,
  ImportDroppedProjectMediaBridgeResult,
  ImportProjectImageBridgeRequest,
  ImportProjectImageBridgeResult,
  ImportProjectVideoBridgeRequest,
  ImportProjectVideoBridgeResult,
  PasteProjectClipboardImageBridgeRequest,
  PasteProjectClipboardImageBridgeResult,
  PasteProjectClipboardVideoBridgeRequest,
  PasteProjectClipboardVideoBridgeResult,
  KnowledgeStateBridgeResult,
  KnowledgeSyncStatusSummary,
  ListProjectImagesBridgeRequest,
  ListProjectVideosBridgeRequest,
  OpenProjectBridgeRequest,
  OpenProjectBridgeResult,
  OpenRecentProjectBridgeRequest,
  RecentProjectRequest,
  RecentProjectSummary,
  PrepareSkillCandidateReviewBridgeRequest,
  PrepareSkillCandidateReviewBridgeResult,
  RecoveryPlanBridgeRequest,
  RecoveryPlanBridgeResult,
  RefreshProjectBridgeRequest,
  ReviewSkillCandidateBridgeRequest,
  ReviewSkillCandidateBridgeResult,
  RestoreBridgeRequest,
  RestoreBridgeResult,
  StablePointBridgeRequest,
  StablePointBridgeResult,
  ProjectImageAssetSummary,
  ProjectVideoAssetSummary,
  AddGenerationHistoryProjectReferencesBridgeRequest,
  CompareGenerationHistoryBridgeRequest,
  CopyGenerationHistoryToProjectBridgeRequest,
  CopyGenerationHistoryToProjectBridgeResult,
  ExportGenerationHistoryBridgeRequest,
  ExportGenerationHistoryBridgeResult,
  GenerationHistoryBatchBridgeRequest,
  GenerationHistoryCapacityBridgeResult,
  GenerationHistoryComparisonBridgeResult,
  GenerationHistoryMutationBridgeResult,
  GenerationHistoryPurgeBridgeRequest,
  GenerationHistoryPurgeBridgeResult,
  GenerationHistoryRecordBridgeRequest,
  GenerationHistoryReusableBridgeResult,
  ListGenerationHistoryBridgeRequest,
  ListGenerationHistoryBridgeResult,
  SetGenerationHistoryFavoriteBridgeRequest,
  McpRuntimePublicStatus,
  McpRuntimeRendererRequest,
  McpRuntimeRendererResponse,
  PhotoshopImportRequest,
  PhotoshopImportResult,
} from './contracts.js';
import { CanvasMcpRequestSchema, CanvasMcpResponseSchema } from '@agent-canvas/domain';
import type { KnowledgeBaseStateSummary } from '@agent-canvas/skill-store';
import {
  parseCloseFlushAck,
  parseCloseFlushRequest,
  type CloseFlushAck,
  type CloseFlushRequest,
} from './renderer-close-flush-contract.js';
import {
  parseCloseChoiceDecision,
  parseCloseChoiceRequest,
  type CloseChoiceDecision,
  type CloseChoiceRequest,
} from './close-choice-contract.js';
import {
  PROVIDER_BRIDGE_CHANNELS,
  normalizeProviderBridgeError,
  parseProviderBridgeEnvelope,
  type AckImageJobTerminalBridgeRequest,
  type AckImageJobTerminalBridgeResult,
  type AckVideoJobTerminalBridgeRequest,
  type AckVideoJobTerminalBridgeResult,
  type AnalyzeReversePromptBridgeRequest,
  type AnalyzeReversePromptBridgeResult,
  type ChatSkillBridgeRequest,
  type ChatSkillBridgeResult,
  type GenerateStoryboardBridgeRequest,
  type GenerateStoryboardBridgeResult,
  type CancelImageJobBridgeRequest,
  type CancelVideoJobBridgeRequest,
  type CancelVideoJobBridgeResult,
  type ConfigureProviderBridgeRequest,
  type UpdateProviderProfilesBridgeRequest,
  type PollImageJobBridgeRequest,
  type PollImageJobBridgeResult,
  type PollVideoJobBridgeRequest,
  type PollVideoJobBridgeResult,
  type ProviderBridgeProfile,
  type ProviderActiveState,
  type ProviderConfigurationStatus,
  type ProviderConnectionCheckResult,
  type RevealProviderCredentialBridgeResult,
  type SetActiveProviderBridgeRequest,
  type LoginRelayMeBridgeRequest,
  type ProviderSelectionBridgeRequest,
  type SubmitImageJobBridgeRequest,
  type SubmitImageJobBridgeResult,
  type SubmitVideoJobBridgeRequest,
  type SubmitVideoJobBridgeResult,
  type UnlockProviderBridgeRequest,
  type CancelImageJobBridgeResult,
} from './provider-contracts.js';
import type { CacheDirectoryState } from './cache-directory-service.js';
import type { McpClientId, McpClientStatus } from './mcp-client-config.js';
import type { UpdateCheckResult, UpdateRestartResult, UpdateState } from './update-client.js';

export const DESKTOP_BRIDGE_PRELOAD_KEY = 'novusDesktop';

export const BRIDGE_CHANNELS = {
  closeChoice: 'novus-desktop:close-choice',
  closeRequest: 'novus-desktop:close-request',
  closeFlushAck: 'novus-desktop:close-flush-ack',
  closeFlushRequest: 'novus-desktop:close-flush-request',
  closeProject: 'novus-desktop:close-project',
  createProject: 'novus-desktop:create-project',
  commit: 'novus-desktop:commit',
  configureKnowledgeBase: 'novus-desktop:configure-knowledge-base',
  createStablePoint: 'novus-desktop:create-stable-point',
  exportPack: 'novus-desktop:export-pack',
  getKnowledgeState: 'novus-desktop:get-knowledge-state',
  getRecoveryPlan: 'novus-desktop:get-recovery-plan',
  importPack: 'novus-desktop:import-pack',
  importDroppedProjectMedia: 'novus-desktop:import-dropped-project-media',
  importProjectImage: 'novus-desktop:import-project-image',
  importProjectImageToPhotoshop: 'novus-desktop:import-project-image-to-photoshop',
  importProjectVideo: 'novus-desktop:import-project-video',
  pasteProjectClipboardImage: 'novus-desktop:paste-project-clipboard-image',
  pasteProjectClipboardVideo: 'novus-desktop:paste-project-clipboard-video',
  knowledgeStateChanged: 'novus-desktop:knowledge-state-changed',
  knowledgeSyncStatusChanged: 'novus-desktop:knowledge-sync-status-changed',
  listProjectImages: 'novus-desktop:list-project-images',
  listProjectVideos: 'novus-desktop:list-project-videos',
  openLatestRecoveryPreview: 'novus-desktop:open-latest-recovery-preview',
  openProject: 'novus-desktop:open-project',
  refreshProject: 'novus-desktop:refresh-project',
  recentProjects: {
    list: 'novus-desktop:recent-projects:list',
    open: 'novus-desktop:recent-projects:open',
    remove: 'novus-desktop:recent-projects:remove',
    relocate: 'novus-desktop:recent-projects:relocate',
  },
  prepareSkillCandidateReview: 'novus-desktop:prepare-skill-candidate-review',
  reviewSkillCandidate: 'novus-desktop:review-skill-candidate',
  restore: 'novus-desktop:restore',
  history: {
    list: 'novus-desktop:history:list',
    capacity: 'novus-desktop:history:capacity',
    setFavorite: 'novus-desktop:history:set-favorite',
    reuse: 'novus-desktop:history:reuse',
    compare: 'novus-desktop:history:compare',
    copyToProject: 'novus-desktop:history:copy-to-project',
    addProjectReferences: 'novus-desktop:history:add-project-references',
    exportSelected: 'novus-desktop:history:export-selected',
    trash: 'novus-desktop:history:trash',
    restore: 'novus-desktop:history:restore',
    permanentlyDelete: 'novus-desktop:history:permanently-delete',
    purgeExpired: 'novus-desktop:history:purge-expired',
  },
  storage: {
    getCacheDirectory: 'novus-desktop:storage:get-cache-directory',
    chooseCacheDirectory: 'novus-desktop:storage:choose-cache-directory',
    resetCacheDirectory: 'novus-desktop:storage:reset-cache-directory',
    openCacheDirectory: 'novus-desktop:storage:open-cache-directory',
  },
  updates: {
    getState: 'novus-desktop:updates:get-state',
    stateChanged: 'novus-desktop:updates:state-changed',
    check: 'novus-desktop:updates:check',
    download: 'novus-desktop:updates:download',
    defer: 'novus-desktop:updates:defer',
    retry: 'novus-desktop:updates:retry',
    restart: 'novus-desktop:updates:restart',
  },
  mcpRuntime: {
    status: 'novus-desktop:mcp-runtime:status',
    request: 'novus-desktop:mcp-runtime:request',
    response: 'novus-desktop:mcp-runtime:response',
  },
  mcpIntegration: {
    status: 'novus-desktop:mcp-integration:status',
    connect: 'novus-desktop:mcp-integration:connect',
    copyConfig: 'novus-desktop:mcp-integration:copy-config',
    test: 'novus-desktop:mcp-integration:test',
    disconnect: 'novus-desktop:mcp-integration:disconnect',
  },
  provider: PROVIDER_BRIDGE_CHANNELS,
} as const;

const SAFE_MODE_BRIDGE_CHANNELS = {
  getRecoveryPlan: 'novus-desktop:get-recovery-plan',
  openProject: 'novus-desktop:open-project',
  recentProjects: {
    list: 'novus-desktop:recent-projects:list',
    open: 'novus-desktop:recent-projects:open',
    remove: 'novus-desktop:recent-projects:remove',
    relocate: 'novus-desktop:recent-projects:relocate',
  },
  restore: 'novus-desktop:restore',
} as const;

export interface DesktopBridgeApi {
  openLatestRecoveryPreview(): Promise<OpenProjectBridgeResult | null>;
  openProject(request: OpenProjectBridgeRequest): Promise<OpenProjectBridgeResult | null>;
  refreshProject(request: RefreshProjectBridgeRequest): Promise<OpenProjectBridgeResult>;
  createProject(request: CreateProjectBridgeRequest): Promise<CreateProjectBridgeResult | null>;
  commit(request: CommitBridgeRequest): Promise<CommitAck>;
  createStablePoint(request: StablePointBridgeRequest): Promise<StablePointBridgeResult>;
  restore(request: RestoreBridgeRequest): Promise<RestoreBridgeResult>;
  exportPack(request: ExportPackBridgeRequest): Promise<ExportPackBridgeResult | null>;
  importPack(request: ImportPackBridgeRequest): Promise<ImportPackBridgeResult | null>;
  closeProject(request: CloseProjectBridgeRequest): Promise<void>;
  getRecoveryPlan(request: RecoveryPlanBridgeRequest): Promise<RecoveryPlanBridgeResult>;
  configureKnowledgeBase(request: ConfigureKnowledgeBaseBridgeRequest): Promise<KnowledgeBaseStateSummary | null>;
  getKnowledgeState(): Promise<KnowledgeStateBridgeResult>;
  prepareSkillCandidateReview(request: PrepareSkillCandidateReviewBridgeRequest): Promise<PrepareSkillCandidateReviewBridgeResult>;
  reviewSkillCandidate(request: ReviewSkillCandidateBridgeRequest): Promise<ReviewSkillCandidateBridgeResult>;
  subscribeKnowledgeState(listener: (state: KnowledgeBaseStateSummary) => void): () => void;
  subscribeKnowledgeSyncStatus(listener: (status: KnowledgeSyncStatusSummary) => void): () => void;
  lifecycle: DesktopLifecycleBridgeApi;
  mcpRuntime: DesktopMcpRuntimeBridgeApi;
  mcpIntegration: DesktopMcpIntegrationBridgeApi;
  provider: DesktopProviderBridgeApi;
  projectImages: DesktopProjectImageBridgeApi;
  projectVideos: DesktopProjectVideoBridgeApi;
  recentProjects: DesktopRecentProjectBridgeApi;
  history: DesktopGenerationHistoryBridgeApi;
  storage: DesktopStorageBridgeApi;
  updates: DesktopUpdateBridgeApi;
}

export interface DesktopRecentProjectBridgeApi {
  list(): Promise<readonly RecentProjectSummary[]>;
  open(request: OpenRecentProjectBridgeRequest): Promise<OpenProjectBridgeResult | null>;
  remove(request: RecentProjectRequest): Promise<readonly RecentProjectSummary[]>;
  relocate(request: RecentProjectRequest): Promise<RecentProjectSummary | null>;
}
export interface DesktopMcpIntegrationBridgeApi {
  getStatus(): Promise<readonly McpClientStatus[]>;
  connect(client: McpClientId): Promise<McpClientStatus>;
  copyConfig(client: McpClientId): Promise<{ readonly client: McpClientId; readonly config: string }>;
  test(client: McpClientId): Promise<McpClientStatus>;
  disconnect(client: McpClientId): Promise<McpClientStatus>;
}
export interface DesktopMcpRuntimeBridgeApi {
  getStatus(): Promise<McpRuntimePublicStatus>;
  onRequest(listener: (request: McpRuntimeRendererRequest) => void | Promise<void>): () => void;
  respond(response: McpRuntimeRendererResponse): boolean;
}

export interface DesktopStorageBridgeApi {
  getCacheDirectory(): Promise<CacheDirectoryState>;
  chooseCacheDirectory(): Promise<CacheDirectoryState | null>;
  resetCacheDirectory(): Promise<CacheDirectoryState>;
  openCacheDirectory(): Promise<{ opened: boolean }>;
}

export interface DesktopUpdateBridgeApi {
  getState(): Promise<UpdateState>;
  subscribeState(listener: (state: UpdateState) => void): () => void;
  check(): Promise<UpdateCheckResult>;
  download(): Promise<UpdateCheckResult>;
  defer(): Promise<UpdateCheckResult>;
  retry(): Promise<UpdateCheckResult>;
  restart(): Promise<UpdateRestartResult>;
}

export interface DesktopProjectVideoBridgeApi {
  importVideo(request: ImportProjectVideoBridgeRequest): Promise<ImportProjectVideoBridgeResult | null>;
  list(request: ListProjectVideosBridgeRequest): Promise<ProjectVideoAssetSummary[]>;
  pasteClipboardVideo(request: PasteProjectClipboardVideoBridgeRequest): Promise<PasteProjectClipboardVideoBridgeResult | null>;
}

export interface DesktopGenerationHistoryBridgeApi {
  list(request: ListGenerationHistoryBridgeRequest): Promise<ListGenerationHistoryBridgeResult>;
  getCapacity(): Promise<GenerationHistoryCapacityBridgeResult>;
  setFavorite(request: SetGenerationHistoryFavoriteBridgeRequest): Promise<GenerationHistoryMutationBridgeResult>;
  getReusableSummary(request: GenerationHistoryRecordBridgeRequest): Promise<GenerationHistoryReusableBridgeResult>;
  compare(request: CompareGenerationHistoryBridgeRequest): Promise<GenerationHistoryComparisonBridgeResult>;
  copyToProject(request: CopyGenerationHistoryToProjectBridgeRequest): Promise<CopyGenerationHistoryToProjectBridgeResult>;
  addProjectReferences(request: AddGenerationHistoryProjectReferencesBridgeRequest): Promise<GenerationHistoryMutationBridgeResult[]>;
  exportSelected(request: ExportGenerationHistoryBridgeRequest): Promise<ExportGenerationHistoryBridgeResult>;
  trash(request: GenerationHistoryBatchBridgeRequest): Promise<GenerationHistoryMutationBridgeResult>;
  restore(request: GenerationHistoryBatchBridgeRequest): Promise<GenerationHistoryMutationBridgeResult>;
  permanentlyDelete(request: GenerationHistoryBatchBridgeRequest): Promise<GenerationHistoryPurgeBridgeResult>;
  purgeExpired(request: GenerationHistoryPurgeBridgeRequest): Promise<GenerationHistoryPurgeBridgeResult>;
}

export interface DesktopProjectImageBridgeApi {
  importImage(request: ImportProjectImageBridgeRequest): Promise<ImportProjectImageBridgeResult | null>;
  importToPhotoshop(request: PhotoshopImportRequest): Promise<PhotoshopImportResult>;
  importDroppedMedia(request: ImportDroppedProjectMediaBridgeRequest, file: unknown): Promise<ImportDroppedProjectMediaBridgeResult | null>;
  list(request: ListProjectImagesBridgeRequest): Promise<ProjectImageAssetSummary[]>;
  pasteClipboardImage(request: PasteProjectClipboardImageBridgeRequest): Promise<PasteProjectClipboardImageBridgeResult | null>;
}

export interface DesktopLifecycleBridgeApi {
  requestClose(): Promise<void>;
  ackCloseFlush(ack: CloseFlushAck): boolean;
  chooseCloseDecision(request: CloseChoiceRequest): Promise<CloseChoiceDecision>;
  subscribeCloseFlushRequest(listener: (request: CloseFlushRequest) => void | Promise<void>): () => void;
}

export interface DesktopProviderBridgeApi {
  getActiveProvider(): Promise<ProviderActiveState>;
  setActiveProvider(request: SetActiveProviderBridgeRequest): Promise<ProviderActiveState>;
  loginRelayMe(request: LoginRelayMeBridgeRequest): Promise<ProviderActiveState>;
  logoutRelayMe(): Promise<ProviderActiveState>;
  getStatus(request?: ProviderSelectionBridgeRequest): Promise<ProviderConfigurationStatus>;
  revealCredential(request?: ProviderSelectionBridgeRequest): Promise<RevealProviderCredentialBridgeResult>;
  checkConnection(request?: ProviderSelectionBridgeRequest): Promise<ProviderConnectionCheckResult>;
  configure(request: ConfigureProviderBridgeRequest): Promise<ProviderConfigurationStatus>;
  updateProfiles(request: UpdateProviderProfilesBridgeRequest): Promise<ProviderConfigurationStatus>;
  unlock(request: UnlockProviderBridgeRequest): Promise<ProviderConfigurationStatus>;
  listAvailableModelIds(request?: ProviderSelectionBridgeRequest): Promise<string[]>;
  listProfiles(request?: ProviderSelectionBridgeRequest): Promise<ProviderBridgeProfile[]>;
  submitImageJob(request: SubmitImageJobBridgeRequest): Promise<SubmitImageJobBridgeResult>;
  pollImageJob(request: PollImageJobBridgeRequest): Promise<PollImageJobBridgeResult>;
  cancelImageJob(request: CancelImageJobBridgeRequest): Promise<CancelImageJobBridgeResult>;
  ackImageJobTerminal(request: AckImageJobTerminalBridgeRequest): Promise<AckImageJobTerminalBridgeResult>;
  submitVideoJob(request: SubmitVideoJobBridgeRequest): Promise<SubmitVideoJobBridgeResult>;
  pollVideoJob(request: PollVideoJobBridgeRequest): Promise<PollVideoJobBridgeResult>;
  cancelVideoJob(request: CancelVideoJobBridgeRequest): Promise<CancelVideoJobBridgeResult>;
  ackVideoJobTerminal(request: AckVideoJobTerminalBridgeRequest): Promise<AckVideoJobTerminalBridgeResult>;
  analyzeReversePrompt(request: AnalyzeReversePromptBridgeRequest): Promise<AnalyzeReversePromptBridgeResult>;
  chat(request: ChatSkillBridgeRequest): Promise<ChatSkillBridgeResult>;
  generateStoryboard(request: GenerateStoryboardBridgeRequest): Promise<GenerateStoryboardBridgeResult>;
}

export interface SafeModeBridgeApi {
  openProject(request: OpenProjectBridgeRequest): Promise<OpenProjectBridgeResult | null>;
  restore(request: RestoreBridgeRequest): Promise<RestoreBridgeResult>;
  getRecoveryPlan(request: RecoveryPlanBridgeRequest): Promise<RecoveryPlanBridgeResult>;
}

export type DesktopBridgeInvoke = <TResponse>(
  channel: string,
  payload?: unknown,
) => Promise<TResponse>;

export type DesktopBridgeSubscribe = (
  channel: string,
  listener: (payload: unknown) => void,
) => () => void;

export type DesktopBridgeSend = (
  channel: string,
  payload?: unknown,
) => void;

export function createPreloadApi(
  invoke: DesktopBridgeInvoke,
  subscribe: DesktopBridgeSubscribe = () => () => undefined,
  send: DesktopBridgeSend = () => undefined,
): DesktopBridgeApi {
  return {
    mcpIntegration: {
      async getStatus() {
        return parseMcpClientStatusList(await invoke<unknown>(BRIDGE_CHANNELS.mcpIntegration.status));
      },
      async connect(client) {
        return parseMcpClientStatus(await invoke<unknown>(BRIDGE_CHANNELS.mcpIntegration.connect, { client: parseMcpClientId(client) }));
      },
      async copyConfig(client) {
        return parseMcpClientConfigCopy(await invoke<unknown>(BRIDGE_CHANNELS.mcpIntegration.copyConfig, { client: parseMcpClientId(client) }));
      },
      async test(client) {
        return parseMcpClientStatus(await invoke<unknown>(BRIDGE_CHANNELS.mcpIntegration.test, { client: parseMcpClientId(client) }));
      },
      async disconnect(client) {
        return parseMcpClientStatus(await invoke<unknown>(BRIDGE_CHANNELS.mcpIntegration.disconnect, { client: parseMcpClientId(client) }));
      },
    },
    mcpRuntime: {
      async getStatus() {
        return parseMcpRuntimePublicStatus(await invoke<unknown>(BRIDGE_CHANNELS.mcpRuntime.status));
      },
      onRequest(listener) {
        return subscribe(BRIDGE_CHANNELS.mcpRuntime.request, (payload) => {
          const parsed = parseMcpRuntimeRendererRequest(payload);
          if (parsed === null) return;
          void listener(parsed);
        });
      },
      respond(payload) {
        const parsed = parseMcpRuntimeRendererResponse(payload);
        if (parsed === null) return false;
        send(BRIDGE_CHANNELS.mcpRuntime.response, parsed);
        return true;
      },
    },
    recentProjects: {
      list() {
        return invoke<readonly RecentProjectSummary[]>(BRIDGE_CHANNELS.recentProjects.list);
      },
      open(request) {
        return invoke<OpenProjectBridgeResult | null>(BRIDGE_CHANNELS.recentProjects.open, request);
      },
      remove(request) {
        return invoke<readonly RecentProjectSummary[]>(BRIDGE_CHANNELS.recentProjects.remove, request);
      },
      relocate(request) {
        return invoke<RecentProjectSummary | null>(BRIDGE_CHANNELS.recentProjects.relocate, request);
      },
    },
    openLatestRecoveryPreview() {
      return invoke<OpenProjectBridgeResult | null>(BRIDGE_CHANNELS.openLatestRecoveryPreview);
    },
    openProject(request) {
      return invoke<OpenProjectBridgeResult | null>(BRIDGE_CHANNELS.openProject, request);
    },
    refreshProject(request) {
      return invoke<OpenProjectBridgeResult>(BRIDGE_CHANNELS.refreshProject, request);
    },
    createProject(request) {
      return invoke<CreateProjectBridgeResult | null>(BRIDGE_CHANNELS.createProject, request);
    },
    commit(request) {
      return invoke<CommitAck>(BRIDGE_CHANNELS.commit, request);
    },
    createStablePoint(request) {
      return invoke<StablePointBridgeResult>(BRIDGE_CHANNELS.createStablePoint, request);
    },
    restore(request) {
      return invoke<RestoreBridgeResult>(BRIDGE_CHANNELS.restore, request);
    },
    exportPack(request) {
      return invoke<ExportPackBridgeResult | null>(BRIDGE_CHANNELS.exportPack, request);
    },
    importPack(request) {
      return invoke<ImportPackBridgeResult | null>(BRIDGE_CHANNELS.importPack, request);
    },
    closeProject(request) {
      return invoke<void>(BRIDGE_CHANNELS.closeProject, request);
    },
    getRecoveryPlan(request) {
      return invoke<RecoveryPlanBridgeResult>(BRIDGE_CHANNELS.getRecoveryPlan, request);
    },
    configureKnowledgeBase(request) {
      return invoke<KnowledgeBaseStateSummary | null>(BRIDGE_CHANNELS.configureKnowledgeBase, request);
    },
    getKnowledgeState() {
      return invoke<KnowledgeStateBridgeResult>(BRIDGE_CHANNELS.getKnowledgeState);
    },
    prepareSkillCandidateReview(request) {
      return invoke<PrepareSkillCandidateReviewBridgeResult>(BRIDGE_CHANNELS.prepareSkillCandidateReview, request);
    },
    reviewSkillCandidate(request) {
      return invoke<ReviewSkillCandidateBridgeResult>(BRIDGE_CHANNELS.reviewSkillCandidate, request);
    },
    subscribeKnowledgeState(listener) {
      return subscribe(BRIDGE_CHANNELS.knowledgeStateChanged, (state) => {
        listener(state as KnowledgeBaseStateSummary);
      });
    },
    subscribeKnowledgeSyncStatus(listener) {
      return subscribe(BRIDGE_CHANNELS.knowledgeSyncStatusChanged, (status) => {
        if (isKnowledgeSyncStatusSummary(status)) {
          listener(cloneKnowledgeSyncStatus(status));
        }
      });
    },
    projectImages: {
      importImage(request) {
        return invoke<ImportProjectImageBridgeResult | null>(BRIDGE_CHANNELS.importProjectImage, request);
      },
      importToPhotoshop(request) {
        return invoke<PhotoshopImportResult>(BRIDGE_CHANNELS.importProjectImageToPhotoshop, request);
      },
      async importDroppedMedia() {
        // A native preload replaces this method after resolving the dropped
        // File to a private path. Generic/browser bridges must never accept paths.
        return null;
      },
      list(request) {
        return invoke<ProjectImageAssetSummary[]>(BRIDGE_CHANNELS.listProjectImages, request);
      },
      pasteClipboardImage(request) {
        return invoke<PasteProjectClipboardImageBridgeResult | null>(BRIDGE_CHANNELS.pasteProjectClipboardImage, request);
      },
    },
    projectVideos: {
      importVideo(request) {
        return invoke<ImportProjectVideoBridgeResult | null>(BRIDGE_CHANNELS.importProjectVideo, request);
      },
      list(request) {
        return invoke<ProjectVideoAssetSummary[]>(BRIDGE_CHANNELS.listProjectVideos, request);
      },
      pasteClipboardVideo(request) {
        return invoke<PasteProjectClipboardVideoBridgeResult | null>(BRIDGE_CHANNELS.pasteProjectClipboardVideo, request);
      },
    },
    history: {
      list(request) {
        return invoke<ListGenerationHistoryBridgeResult>(BRIDGE_CHANNELS.history.list, request);
      },
      getCapacity() {
        return invoke<GenerationHistoryCapacityBridgeResult>(BRIDGE_CHANNELS.history.capacity);
      },
      setFavorite(request) {
        return invoke<GenerationHistoryMutationBridgeResult>(BRIDGE_CHANNELS.history.setFavorite, request);
      },
      getReusableSummary(request) {
        return invoke<GenerationHistoryReusableBridgeResult>(BRIDGE_CHANNELS.history.reuse, request);
      },
      compare(request) {
        return invoke<GenerationHistoryComparisonBridgeResult>(BRIDGE_CHANNELS.history.compare, request);
      },
      copyToProject(request) {
        return invoke<CopyGenerationHistoryToProjectBridgeResult>(BRIDGE_CHANNELS.history.copyToProject, request);
      },
      addProjectReferences(request) {
        return invoke<GenerationHistoryMutationBridgeResult[]>(BRIDGE_CHANNELS.history.addProjectReferences, request);
      },
      exportSelected(request) {
        return invoke<ExportGenerationHistoryBridgeResult>(BRIDGE_CHANNELS.history.exportSelected, request);
      },
      trash(request) {
        return invoke<GenerationHistoryMutationBridgeResult>(BRIDGE_CHANNELS.history.trash, request);
      },
      restore(request) {
        return invoke<GenerationHistoryMutationBridgeResult>(BRIDGE_CHANNELS.history.restore, request);
      },
      permanentlyDelete(request) {
        return invoke<GenerationHistoryPurgeBridgeResult>(BRIDGE_CHANNELS.history.permanentlyDelete, request);
      },
      purgeExpired(request) {
        return invoke<GenerationHistoryPurgeBridgeResult>(BRIDGE_CHANNELS.history.purgeExpired, request);
      },
    },
    storage: {
      async getCacheDirectory() {
        return cloneCacheDirectoryState(await invoke<CacheDirectoryState>(BRIDGE_CHANNELS.storage.getCacheDirectory));
      },
      async chooseCacheDirectory() {
        const state = await invoke<CacheDirectoryState | null>(BRIDGE_CHANNELS.storage.chooseCacheDirectory);
        return state === null ? null : cloneCacheDirectoryState(state);
      },
      async resetCacheDirectory() {
        return cloneCacheDirectoryState(await invoke<CacheDirectoryState>(BRIDGE_CHANNELS.storage.resetCacheDirectory));
      },
      async openCacheDirectory() {
        const result = await invoke<{ opened: boolean }>(BRIDGE_CHANNELS.storage.openCacheDirectory);
        return { opened: result.opened === true };
      },
    },
    updates: {
      getState() { return invoke<UpdateState>(BRIDGE_CHANNELS.updates.getState); },
      subscribeState(listener) {
        return subscribe(BRIDGE_CHANNELS.updates.stateChanged, (payload) => {
          if (isUpdateState(payload)) listener(payload);
        });
      },
      check() { return invoke<UpdateCheckResult>(BRIDGE_CHANNELS.updates.check); },
      download() { return invoke<UpdateCheckResult>(BRIDGE_CHANNELS.updates.download); },
      defer() { return invoke<UpdateCheckResult>(BRIDGE_CHANNELS.updates.defer); },
      retry() { return invoke<UpdateCheckResult>(BRIDGE_CHANNELS.updates.retry); },
      restart() { return invoke<UpdateRestartResult>(BRIDGE_CHANNELS.updates.restart); },
    },
    lifecycle: {
      requestClose() {
        return invoke<void>(BRIDGE_CHANNELS.closeRequest);
      },
      ackCloseFlush(ack) {
        const parsed = parseCloseFlushAck(ack);
        if (parsed === null) return false;
        send(BRIDGE_CHANNELS.closeFlushAck, parsed);
        return true;
      },
      async chooseCloseDecision(request) {
        const parsedRequest = parseCloseChoiceRequest(request);
        if (parsedRequest === null) return 'cancel';
        const decision = parseCloseChoiceDecision(await invoke<unknown>(BRIDGE_CHANNELS.closeChoice, parsedRequest));
        return decision ?? 'cancel';
      },
      subscribeCloseFlushRequest(listener) {
        return subscribe(BRIDGE_CHANNELS.closeFlushRequest, (payload) => {
          const request = parseCloseFlushRequest(payload);
          if (request === null) return;
          void listener(request);
        });
      },
    },
    provider: {
      getActiveProvider() {
        return invokeProvider(invoke, PROVIDER_BRIDGE_CHANNELS.getActiveProvider);
      },
      setActiveProvider(request) {
        return invokeProvider(invoke, PROVIDER_BRIDGE_CHANNELS.setActiveProvider, request);
      },
      loginRelayMe(request) {
        return invokeProvider(invoke, PROVIDER_BRIDGE_CHANNELS.loginRelayMe, request);
      },
      logoutRelayMe() {
        return invokeProvider(invoke, PROVIDER_BRIDGE_CHANNELS.logoutRelayMe);
      },
      getStatus(request) {
        return invokeProvider(invoke, PROVIDER_BRIDGE_CHANNELS.getStatus, request);
      },
      revealCredential(request) {
        return invokeProvider(invoke, PROVIDER_BRIDGE_CHANNELS.revealCredential, request);
      },
      checkConnection(request) {
        return invokeProvider(invoke, PROVIDER_BRIDGE_CHANNELS.checkConnection, request);
      },
      configure(request) {
        return invokeProvider(invoke, PROVIDER_BRIDGE_CHANNELS.configure, request);
      },
      updateProfiles(request) {
        return invokeProvider(invoke, PROVIDER_BRIDGE_CHANNELS.updateProfiles, request);
      },
      unlock(request) {
        return invokeProvider(invoke, PROVIDER_BRIDGE_CHANNELS.unlock, request);
      },
      listAvailableModelIds(request) {
        return invokeProvider(invoke, PROVIDER_BRIDGE_CHANNELS.listAvailableModelIds, request);
      },
      listProfiles(request) {
        return invokeProvider(invoke, PROVIDER_BRIDGE_CHANNELS.listProfiles, request);
      },
      submitImageJob(request) {
        return invokeProvider(invoke, PROVIDER_BRIDGE_CHANNELS.submitImageJob, request);
      },
      pollImageJob(request) {
        return invokeProvider(invoke, PROVIDER_BRIDGE_CHANNELS.pollImageJob, request);
      },
      cancelImageJob(request) {
        return invokeProvider(invoke, PROVIDER_BRIDGE_CHANNELS.cancelImageJob, request);
      },
      ackImageJobTerminal(request) {
        return invokeProvider(invoke, PROVIDER_BRIDGE_CHANNELS.ackImageJobTerminal, request);
      },
      submitVideoJob(request) {
        return invokeProvider(invoke, PROVIDER_BRIDGE_CHANNELS.submitVideoJob, request);
      },
      pollVideoJob(request) {
        return invokeProvider(invoke, PROVIDER_BRIDGE_CHANNELS.pollVideoJob, request);
      },
      cancelVideoJob(request) {
        return invokeProvider(invoke, PROVIDER_BRIDGE_CHANNELS.cancelVideoJob, request);
      },
      ackVideoJobTerminal(request) {
        return invokeProvider(invoke, PROVIDER_BRIDGE_CHANNELS.ackVideoJobTerminal, request);
      },
      analyzeReversePrompt(request) {
        return invokeProvider(invoke, PROVIDER_BRIDGE_CHANNELS.analyzeReversePrompt, request);
      },
      chat(request) {
        return invokeProvider(invoke, PROVIDER_BRIDGE_CHANNELS.chat, request);
      },
      generateStoryboard(request) {
        return invokeProvider(invoke, PROVIDER_BRIDGE_CHANNELS.generateStoryboard, request);
      },
    },
  };
}

function isUpdateState(value: unknown): value is UpdateState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (!['idle', 'checking', 'available', 'downloading', 'ready_to_restart', 'error'].includes(String(state.status))) return false;
  if (state.version !== undefined && typeof state.version !== 'string') return false;
  if (state.notes !== undefined && typeof state.notes !== 'string') return false;
  if (state.message !== undefined && typeof state.message !== 'string') return false;
  return state.progress === undefined || (typeof state.progress === 'number' && Number.isFinite(state.progress) && state.progress >= 0 && state.progress <= 1);
}

async function invokeProvider<TResponse>(
  invoke: DesktopBridgeInvoke,
  channel: string,
  payload?: unknown,
): Promise<TResponse> {
  try {
    return parseProviderBridgeEnvelope<TResponse>(channel, await invoke<unknown>(channel, payload));
  } catch (error) {
    throw normalizeProviderBridgeError(error);
  }
}

function cloneCacheDirectoryState(state: CacheDirectoryState): CacheDirectoryState {
  return {
    path: state.path,
    isDefault: state.isDefault,
    available: state.available,
    busy: state.busy,
    error: state.error,
  };
}
export function createSafeModePreloadApi(invoke: DesktopBridgeInvoke): SafeModeBridgeApi {
  return {
    openProject(request) {

      return invoke<OpenProjectBridgeResult | null>(SAFE_MODE_BRIDGE_CHANNELS.openProject, request);
    },
    restore(request) {
      return invoke<RestoreBridgeResult>(SAFE_MODE_BRIDGE_CHANNELS.restore, request);
    },
    getRecoveryPlan(request) {
      return invoke<RecoveryPlanBridgeResult>(SAFE_MODE_BRIDGE_CHANNELS.getRecoveryPlan, request);
    },
  };
}

export function redactBridgeDiagnostics(input: string): string {
  return input
    .replace(/Authorization:\s*[^\s]+(?:\s+[^\s]+)?/gi, 'Authorization: [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted-key]')
    .replace(/file:\/\/\/?[^\r\n"'<>]*/gi, '[redacted-path]')
    .replace(/[A-Za-z]:\\[^\r\n"'<>]*/g, '[redacted-path]')
    .replace(/\\\\[^\r\n"'<>]*/g, '[redacted-path]')
    .replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, '[redacted-image]');
}

function parseMcpClientId(value: unknown): McpClientId {
  if (value === 'codex' || value === 'workbuddy') return value;
  throw new Error('MCP_CLIENT_INVALID_REQUEST');
}

function parseMcpClientStatus(value: unknown): McpClientStatus {
  if (
    !isPlainBridgeRecord(value)
    || !hasOnlyKeys(value, ['client', 'state', 'toolCount', 'lastError'])
    || (value.client !== 'codex' && value.client !== 'workbuddy')
    || !['unconfigured', 'configured', 'connected', 'connection_failed'].includes(String(value.state))
    || (value.toolCount !== 0 && value.toolCount !== 14)
    || !(value.lastError === null || (typeof value.lastError === 'string' && value.lastError.length <= 160))
  ) throw new Error('MCP_CLIENT_INVALID_RESPONSE');
  return value as unknown as McpClientStatus;
}

function parseMcpClientStatusList(value: unknown): readonly McpClientStatus[] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error('MCP_CLIENT_INVALID_RESPONSE');
  const statuses = value.map(parseMcpClientStatus);
  if (new Set(statuses.map((status) => status.client)).size !== 2) throw new Error('MCP_CLIENT_INVALID_RESPONSE');
  return statuses;
}

function parseMcpClientConfigCopy(value: unknown): { readonly client: McpClientId; readonly config: string } {
  if (
    !isPlainBridgeRecord(value)
    || !hasOnlyKeys(value, ['client', 'config'])
    || (value.client !== 'codex' && value.client !== 'workbuddy')
    || typeof value.config !== 'string'
    || value.config.length === 0
    || value.config.length > 65_536
    || /authToken|pipeName|apiKey|authorization/iu.test(value.config)
  ) throw new Error('MCP_CLIENT_INVALID_RESPONSE');
  return { client: value.client, config: value.config };
}
function parseMcpRuntimeRendererRequest(value: unknown): McpRuntimeRendererRequest | null {
  if (!isPlainBridgeRecord(value) || !hasOnlyKeys(value, ['requestId', 'request']) || !isMcpRequestId(value.requestId)) return null;
  const request = CanvasMcpRequestSchema.safeParse(value.request);
  return request.success ? { requestId: value.requestId, request: request.data } : null;
}

function parseMcpRuntimeRendererResponse(value: unknown): McpRuntimeRendererResponse | null {
  if (!isPlainBridgeRecord(value) || !hasOnlyKeys(value, ['requestId', 'response']) || !isMcpRequestId(value.requestId)) return null;
  const response = CanvasMcpResponseSchema.safeParse(value.response);
  return response.success ? { requestId: value.requestId, response: response.data } : null;
}

function parseMcpRuntimePublicStatus(value: unknown): McpRuntimePublicStatus {
  if (
    !isPlainBridgeRecord(value)
    || !hasOnlyKeys(value, ['state', 'rendererConnected', 'serverVersion', 'toolCount', 'lastError'])
    || !['stopped', 'waiting_for_canvas', 'running', 'error'].includes(String(value.state))
    || typeof value.rendererConnected !== 'boolean'
    || typeof value.serverVersion !== 'string'
    || value.serverVersion.length < 1
    || value.serverVersion.length > 80
    || value.toolCount !== 14
    || !(value.lastError === null || (typeof value.lastError === 'string' && value.lastError.length <= 160 && !containsProtectedSyncValue(value.lastError)))
  ) {
    throw new Error('MCP_RUNTIME_INVALID_STATUS');
  }
  return {
    state: value.state as McpRuntimePublicStatus['state'],
    rendererConnected: value.rendererConnected,
    serverVersion: value.serverVersion,
    toolCount: 14,
    lastError: value.lastError as string | null,
  };
}

function isPlainBridgeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isMcpRequestId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160;
}
function isKnowledgeSyncStatusSummary(value: unknown): value is KnowledgeSyncStatusSummary {
  if (typeof value !== 'object' || value === null) return false;
  if (!hasOnlyKeys(value, ['schemaVersion', 'knowledgeBaseId', 'status', 'changedAt', 'lastFailure'])) return false;
  const status = value as Partial<KnowledgeSyncStatusSummary>;
  if (
    status.schemaVersion !== 1 ||
    typeof status.knowledgeBaseId !== 'string' ||
    status.knowledgeBaseId.length === 0 ||
    status.knowledgeBaseId.length > 160 ||
    containsProtectedSyncValue(status.knowledgeBaseId) ||
    !['syncing', 'updated', 'offline', 'conflict'].includes(String(status.status)) ||
    typeof status.changedAt !== 'string' ||
    !Number.isFinite(Date.parse(status.changedAt))
  ) {
    return false;
  }
  if (status.lastFailure === null) return true;
  return typeof status.lastFailure === 'object'
    && status.lastFailure !== null
    && hasOnlyKeys(status.lastFailure, ['reason', 'failedAt'])
    && typeof status.lastFailure.reason === 'string'
    && status.lastFailure.reason.length > 0
    && status.lastFailure.reason.length <= 160
    && !containsProtectedSyncValue(status.lastFailure.reason)
    && typeof status.lastFailure.failedAt === 'string'
    && Number.isFinite(Date.parse(status.lastFailure.failedAt));
}

function hasOnlyKeys(value: object, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function containsProtectedSyncValue(value: string): boolean {
  return /authorization\s*:/iu.test(value)
    || /\bbearer\s+\S+/iu.test(value)
    || /\b(?:api[_ -]?key|token|secret|password)\s*[:=]\s*\S+/iu.test(value)
    || /data:[^,\s;]+(?:;[^,\s;]+)*;base64,/iu.test(value)
    || /[A-Za-z]:\\/u.test(value)
    || /\\\\[^\\\s]+\\/u.test(value)
    || /(?:^|\s)\/(?:Users|home|var|etc|opt|tmp)\//u.test(value);
}
function cloneKnowledgeSyncStatus(status: KnowledgeSyncStatusSummary): KnowledgeSyncStatusSummary {
  return {
    schemaVersion: 1,
    knowledgeBaseId: status.knowledgeBaseId,
    status: status.status,
    changedAt: status.changedAt,
    lastFailure: status.lastFailure === null ? null : {
      reason: status.lastFailure.reason,
      failedAt: status.lastFailure.failedAt,
    },
  };
}
