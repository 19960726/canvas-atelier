export {
  JOURNAL_SCHEMA_VERSION,
  LOCK_HEARTBEAT_MS,
  PROJECT_LOCK_SCHEMA_VERSION,
  PROJECT_FORMAT_VERSION,
  SNAPSHOT_BYTE_LIMIT,
  SNAPSHOT_SCHEMA_VERSION,
  SNAPSHOT_TRANSACTION_LIMIT,
  STALE_LOCK_MS,
} from './contracts.js';
export type {
  BridgeSessionSummary,
  CloseProjectBridgeRequest,
  CommitAck,
  CommitBridgeRequest,
  CommitRequest,
  ConfigureKnowledgeBaseBridgeRequest,
  CreateProjectBridgeRequest,
  CreateProjectBridgeResult,
  ExportPackBridgeRequest,
  ExportPackBridgeResult,
  JournalRecord,
  JournalTransactionKind,
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
  KnowledgeSyncStatus,
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
  PersistenceChannel,
  PersistenceError,
  PersistenceErrorCode,
  ProjectLock,
  ProjectManifest,
  ProjectImageAssetSummary,
  ProjectVideoAssetSummary,
  ProjectClipboardImageTarget,
  ProjectClipboardVideoTarget,
  ProjectImageImportTarget,
  RecoveryCandidateBridgeSummary,
  RecoveryPlanBridgeRequest,
  RecoveryPlanBridgeResult,
  RefreshProjectBridgeRequest,
  RecoveryAction,
  RecoveryPlan,
  ReviewSkillCandidateBridgeRequest,
  ReviewSkillCandidateBridgeResult,
  RestoreBridgeRequest,
  RestoreBridgeResult,
  SkillCandidatePreparedManagedSnapshot,
  SnapshotEnvelope,
  StablePointBridgeRequest,
  StablePointBridgeResult,
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
} from './contracts.js';

export {
  PHOTOSHOP_IMPORT_ERROR_CODES,
  parsePhotoshopImportRequest,
} from './photoshop-contract.js';
export { PhotoshopSmartObjectService } from './photoshop-smart-object-service.js';
export type {
  PhotoshopManagedAsset,
  PhotoshopManagedAssetResolver,
  PhotoshopSmartObjectAdapter,
} from './photoshop-smart-object-service.js';
export { createPhotoshopPlacementPayload } from './photoshop-script.js';
export type { PhotoshopPlacementPayloadInput } from './photoshop-script.js';
export {
  createNodeWindowsPhotoshopSmartObjectAdapter,
  createWindowsPhotoshopSmartObjectAdapter,
} from './photoshop-windows-adapter.js';
export type {
  PhotoshopInstallation,
  PhotoshopRunningInstance,
  PhotoshopTemporaryFiles,
  PhotoshopWindowsExecutionResult,
  WindowsPhotoshopAdapterDependencies,
  NodeWindowsPhotoshopAdapterOptions,
} from './photoshop-windows-adapter.js';
export type {
  PhotoshopCapability,
  PhotoshopImportErrorCode,
  PhotoshopImportRequest,
  PhotoshopImportResult,
} from './photoshop-contract.js';

export { canonicalJson, sha256Canonical } from './canonical-json.js';
export { AssetStore, MAX_MANAGED_MP4_BYTES, verifyAssetFile } from './asset-store.js';
export type { AssetCatalogMetadata, AssetMetadata, StageAssetOptions } from './asset-store.js';
export { createElectronClipboardImageAdapter } from './electron-clipboard-image.js';
export type { ClipboardImageAdapter, TrustedClipboardImage } from './electron-clipboard-image.js';
export { createElectronClipboardVideoAdapter } from './electron-clipboard-video.js';
export type { ClipboardVideoAdapter, TrustedClipboardVideoPath } from './electron-clipboard-video.js';
export {
  PROJECT_ASSET_SCHEME,
  createProjectAssetDisplayUrl,
  parseProjectAssetDisplayUrl,
} from './project-asset-url.js';
export type { ProjectAssetUrlIdentity } from './project-asset-url.js';
export {
  ApprovedSnapshotOutbox,
  createApprovedSnapshotSyncClientFromEnv,
  startApprovedSnapshotOutboxDrain,
} from './approved-snapshot-outbox.js';
export type {
  ApprovedSnapshotOutboxDrainHandle,
  ApprovedSnapshotOutboxDrainOptions,
  ApprovedSnapshotOutboxOptions,
  ApprovedSnapshotReadableStore,
  ApprovedSnapshotSyncEnvironment,
  ApprovedSnapshotSyncClient,
  ApprovedSnapshotUploadClient,
  ApprovedSnapshotUploadResult,
} from './approved-snapshot-outbox.js';
export { ApprovedSnapshotPullCoordinator } from './approved-snapshot-pull.js';
export type {
  ApprovedSnapshotPullClient,
  ApprovedSnapshotPullCoordinatorOptions,
  ApprovedSnapshotPullStore,
} from './approved-snapshot-pull.js';
export { NodeFileSystem, writeAtomic } from './file-system.js';
export { GenerationHistoryStore } from './generation-history-store.js';
export {
  GENERATION_HISTORY_ASSET_SCHEME,
  createGenerationHistoryAssetUrl,
  parseGenerationHistoryAssetUrl,
} from './generation-history-asset-url.js';
export type { GenerationHistoryAssetUrlIdentity } from './generation-history-asset-url.js';
export type {
  GenerationHistoryListResult,
  GenerationHistoryAvailableAsset,
  GenerationHistoryCapacity,
  GenerationHistoryMutationResult,
  GenerationHistoryProjectReferenceInput,
  GenerationHistoryPurgeResult,
  GenerationHistoryStoreError,
  GenerationHistoryStoreErrorCode,
  GenerationHistoryStoreOptions,
  IngestGenerationHistoryInput,
} from './generation-history-store.js';
export { GenerationHistoryService } from './generation-history-service.js';
export type {
  GenerationHistoryComparisonDescriptor,
  GenerationHistoryExportFileSummary,
  GenerationHistoryExportResult,
  GenerationHistoryProjectCopyResult,
  GenerationHistoryReusableSummary,
  GenerationHistoryServiceOptions,
} from './generation-history-service.js';
export { GenerationHistoryProviderSink, createElectronTrustedImageDecoder } from './generation-history-provider-sink.js';
export type {
  ElectronNativeImageLike,
  GenerationHistoryDurableTerminal,
  GenerationHistoryFailureCode,
  GenerationHistoryProviderSinkContract,
  TrustedImageDecoder,
} from './generation-history-provider-sink.js';
export { isHistoryNetworkPath } from './history-network-path.js';
export {
  FRAME_ANCESTORS_POLICY,
  installRendererSecurityHeaders,
} from './renderer-security-headers.js';
export type { HistoryNetworkPathOptions } from './history-network-path.js';
export { shutdownDesktopServices } from './desktop-shutdown.js';
export type { DesktopShutdownServices } from './desktop-shutdown.js';
export {
  CLOSE_FLUSH_TIMEOUT_MS,
  createCloseFlushRequestId,
  createRendererCloseFlushCoordinator,
  parseCloseFlushAck,
  parseCloseFlushRequest,
} from './renderer-close-flush.js';
export type {
  CloseAttemptEvent,
  CloseFlushAck,
  CloseFlushCompletionReason,
  CloseFlushRequest,
  RendererCloseFlushCoordinator,
  RendererCloseFlushCoordinatorOptions,
} from './renderer-close-flush.js';
export { ManagedKnowledgeStore } from './managed-knowledge-store.js';
export type {
  ConfigureKnowledgeRoot,
  ConfiguredKnowledgeBase,
  InternalKnowledgeConfiguration,
  ManagedKnowledgeStoreOptions,
  StageApprovedSnapshotMetadata,
  StageRollbackMetadata,
  StagedKnowledgeTransitionKind,
  StagedKnowledgeTransitionPhase,
  StagedKnowledgeTransitionSummary,
} from './managed-knowledge-store.js';
export { KnowledgeRefreshService } from './knowledge-refresh-service.js';
export { startConfiguredKnowledgeRefresh } from './knowledge-startup.js';
export type {
  KnowledgeRefreshClock,
  KnowledgeRefreshServiceOptions,
  KnowledgeWatchAdapter,
  KnowledgeWatchEvent,
  KnowledgeWatchHandle,
} from './knowledge-refresh-service.js';
export {
  JournalWriter,
  createPersistenceError,
  readValidJournal,
  releaseJournalState,
  replayJournal,
} from './journal-writer.js';
export type {
  JournalCommitOptions,
  JournalReadOptions,
  JournalReadResult,
  JournalSyncGate,
  JournalWriterOpenOptions,
  JournalWriterSessionOptions,
} from './journal-writer.js';
export {
  SnapshotScheduler,
  isValidSnapshotEnvelope,
  readSnapshotEnvelope,
} from './snapshot-scheduler.js';
export type {
  SnapshotConsiderEvent,
  SnapshotFlushRequest,
  SnapshotFlushResult,
  SnapshotReason,
  SnapshotSchedulerOptions,
} from './snapshot-scheduler.js';
export { buildSnapshotProject } from './snapshot-worker.js';
export type { SnapshotWorkerInput, SnapshotWorkerOutput } from './snapshot-worker.js';
export { RecoveryScanner } from './recovery-scanner.js';
export type {
  RecoveryCandidate,
  RecoveryScanResult,
  RecoveryScannerOptions,
} from './recovery-scanner.js';
export { MAX_WIN7_PROJECT_ROOT_PATH_LENGTH, ProjectRepository } from './project-repository.js';
export type {
  CreateProjectOptions,
  OpenedProjectSession,
  OpenProjectOptions,
  ProjectRepositoryOptions,
} from './project-repository.js';
export {
  BRIDGE_CHANNELS,
  DESKTOP_BRIDGE_PRELOAD_KEY,
  createPreloadApi,
  createSafeModePreloadApi,
  redactBridgeDiagnostics,
} from './preload-api.js';
export {
  CODEX_ASTRA_MODEL_ID,
  CODEX_ASTRA_MODEL_ROUTE,
  CODEX_ASTRA_PROFILE,
  CODEX_CLI_CHANNELS,
  CodexCliBridgeException,
  parseCodexCliChatRequest,
  parseCodexCliChatResult,
  parseCodexCliProfiles,
  unwrapCodexCliEnvelope,
} from './codex-cli-contract.js';
export type {
  CodexCliBridgeEnvelope,
  CodexCliBridgeError,
  CodexCliChatRequest,
  CodexCliChatResult,
  CodexCliErrorCode,
  CodexCliProfile,
  CodexReasoningEffort,
} from './codex-cli-contract.js';
export {
  buildCodexCliArgs,
  buildCodexCliProcessEnvironment,
  createCodexCliService,
  createNodeCodexCliProcessRunner,
  normalizeCodexCliError,
  resolveCodexCliExecutablePath,
} from './codex-cli-service.js';
export type {
  CodexCliKnowledgeContext,
  CodexCliMcpServer,
  CodexCliProcessInvocation,
  CodexCliProcessResult,
  CodexCliProcessRunner,
  CodexCliProjectMemoryContext,
  CodexCliService,
  CreateCodexCliServiceOptions,
} from './codex-cli-service.js';
export { registerCodexCliIpc } from './codex-cli-ipc.js';
export {
  DEFAULT_PROVIDER_PROFILES,
  PROVIDER_BRIDGE_CHANNELS,
  createComflyProviderService,
  createElectronNetComflyFetch,
  createProviderBridgeError,
  createProviderBridgeHandlers,
  createSecureProviderCredentialStore,
  normalizeProviderBridgeError,
  parseProviderBridgeRequest,
  parseProviderBridgeResponse,
  registerProviderBridgeHandlers,
} from './provider-bridge.js';
export type {
  AckImageJobTerminalBridgeRequest,
  AckImageJobTerminalBridgeResult,
  AnalyzeReversePromptBridgeRequest,
  AnalyzeReversePromptBridgeResult,
  ChatSkillBridgeRequest,
  ChatSkillBridgeResult,
  ComflyFetch,
  CancelImageJobBridgeRequest,
  CancelImageJobBridgeResult,
  ConfigureProviderBridgeRequest,
  PollImageJobBridgeRequest,
  PollImageJobBridgeResult,
  ProviderBridgeBlockedReason,
  ProviderBridgeError,
  ProviderBridgeException,
  ProviderBridgeHandlers,
  ProviderBridgeProfile,
  ProviderConfigurationStatus,
  ProviderConnectionCheckResult,
  ProviderCredentialStore,
  ProviderImageJobResult,
  ManagedReversePromptMediaIdentity,
  ProviderService,
  SafeStorageAdapter,
  SubmitImageJobBridgeRequest,
  SubmitImageJobBridgeResult,
  UnlockProviderBridgeRequest,
} from './provider-bridge.js';
export { createRelayMeProviderService } from './relayme-provider-service.js';
export { ProviderActiveStore, createProviderActiveStore } from './provider-active-store.js';
export type { ActiveProvider, ProviderActiveState as PersistedProviderActiveState } from './provider-active-store.js';
export {
  SEEDANCE_25_REVERSE_SKILL_ID,
  SEEDANCE_25_REVERSE_SKILL_VERSION,
  getSeedance25ReverseSkill,
} from './seedance-25-reverse-skill.js';
export type { Seedance25ReverseSkill, Seedance25TaskType } from './seedance-25-reverse-skill.js';
export { createProviderRegistry } from './provider-registry.js';
export type { ProviderRegistry } from './provider-registry.js';
export type { RelayMeFetch } from '@agent-canvas/provider-relayme';
export type {
  DesktopBridgeApi,
  DesktopBridgeInvoke,
  DesktopBridgeSend,
  DesktopBridgeSubscribe,
  DesktopGenerationHistoryBridgeApi,
  DesktopMcpIntegrationBridgeApi,
  DesktopMcpRuntimeBridgeApi,
  DesktopCodexCliBridgeApi,
  DesktopProviderBridgeApi,
  DesktopProjectImageBridgeApi,
  DesktopRecentProjectBridgeApi,
  DesktopStorageBridgeApi,
  DesktopUpdateBridgeApi,
  SafeModeBridgeApi,
} from './preload-api.js';
export { MockReleaseFeed, UpdateClient } from './update-client.js';
export {
  createCacheDirectoryService,
  createNodeCacheDirectoryServiceAdapters,
} from './cache-directory-service.js';
export type {
  CacheDirectoryService,
  CacheDirectoryServiceAdapters,
  CacheDirectoryState,
  NodeCacheDirectoryAdaptersOptions,
} from './cache-directory-service.js';
export type { MockRelease, UpdateCheckResult, UpdateDriver, UpdateDriverEvent, UpdateFeed, UpdateRestartResult, UpdateState, UpdateStatus } from './update-client.js';
export { createDesktopBridgeHandlers, registerDesktopBridgeHandlers } from './bridge-handlers.js';
export type {
  BridgeDialogAdapter,
  DesktopBridgeHandlerDependencies,
  DesktopBridgeHandlers,
  DesktopIpcMainLike,
} from './bridge-handlers.js';
export {
  NovusPackExporter,
  NovusPackImporter,
  redactNovusPackDiagnostics,
} from './novus-pack.js';
export type {
  NovusPackExportResult,
  NovusPackExporterOptions,
  NovusPackImportResult,
  NovusPackImporterOptions,
  NovusPackInventoryEntry,
  NovusPackLimits,
} from './novus-pack.js';
export {
  parseCloseChoiceDecision,
  parseCloseChoiceRequest,
  type CloseChoiceDecision,
  type CloseChoiceRequest,
} from './close-choice-contract.js';

export { MCP_RUNTIME_PROTOCOL, MCP_RUNTIME_TTL_MS, createMcpRuntimeDescriptor, deleteMcpRuntimeFile, parseMcpRuntimeFile, readMcpRuntimeFile, writeMcpRuntimeFile } from './mcp-runtime-file.js';
export type { CanvasMcpRuntimeDescriptor, CreateMcpRuntimeDescriptorOptions, ParseMcpRuntimeFileOptions } from './mcp-runtime-file.js';
export { createMcpRendererBridge } from './mcp-renderer-bridge.js';
export type { McpIpcMainLike, McpRendererBridge, McpRendererBridgeOptions, McpRendererEndpoint } from './mcp-renderer-bridge.js';
export { registerMcpClientConfigIpc } from './mcp-client-ipc.js';
export type { McpClientConfigIpcMainLike, McpClientConfigIpcRegistration } from './mcp-client-ipc.js';
export { createMcpClientConfigManager } from './mcp-client-config.js';
export type { McpClientConfigManager, McpClientConfigManagerOptions, McpClientHealthResult, McpClientId, McpClientStatus } from './mcp-client-config.js';
export { createMcpRuntimeService, presentMcpRuntimeStatus } from './mcp-runtime-service.js';
export type { McpPipeRequestEnvelope, McpPipeResponseEnvelope, McpRuntimeService, McpRuntimeServiceOptions, McpRuntimeServiceStatus } from './mcp-runtime-service.js';

export { createMcpStdioHealthCheck } from './mcp-stdio-health';
export type { McpStdioLaunchSpec } from './mcp-stdio-health';

export { RecentProjectStore, createRecentProjectId } from './recent-project-store.js';
export type { RecentProjectEntryInput, RecentProjectStoreOptions } from './recent-project-store.js';
export {
  migrateLegacyProviderData,
  migrateLegacyUserData,
  resolveLegacyUserDataRoots,
  resolveStableUserDataRoot,
} from './user-data-migration.js';
