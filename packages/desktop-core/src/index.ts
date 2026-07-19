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
  ExportPackBridgeRequest,
  ExportPackBridgeResult,
  JournalRecord,
  JournalTransactionKind,
  ImportPackBridgeRequest,
  ImportPackBridgeResult,
  ImportProjectImageBridgeRequest,
  ImportProjectImageBridgeResult,
  KnowledgeStateBridgeResult,
  KnowledgeSyncStatus,
  KnowledgeSyncStatusSummary,
  ListProjectImagesBridgeRequest,
  OpenProjectBridgeRequest,
  OpenProjectBridgeResult,
  PrepareSkillCandidateReviewBridgeRequest,
  PrepareSkillCandidateReviewBridgeResult,
  PersistenceChannel,
  PersistenceError,
  PersistenceErrorCode,
  ProjectLock,
  ProjectManifest,
  ProjectImageAssetSummary,
  ProjectImageImportTarget,
  RecoveryCandidateBridgeSummary,
  RecoveryPlanBridgeRequest,
  RecoveryPlanBridgeResult,
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

export { canonicalJson, sha256Canonical } from './canonical-json.js';
export { AssetStore } from './asset-store.js';
export type { AssetMetadata, StageAssetOptions } from './asset-store.js';
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
  DEFAULT_PROVIDER_PROFILES,
  PROVIDER_BRIDGE_CHANNELS,
  createComflyProviderService,
  createElectronNetComflyFetch,
  createProviderBridgeError,
  createProviderBridgeHandlers,
  createSecureProviderCredentialStore,
  normalizeProviderBridgeError,
  parseProviderBridgeRequest,
  registerProviderBridgeHandlers,
} from './provider-bridge.js';
export type {
  AckImageJobTerminalBridgeRequest,
  AckImageJobTerminalBridgeResult,
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
  ProviderCredentialStore,
  ProviderImageJobResult,
  ProviderService,
  SafeStorageAdapter,
  SubmitImageJobBridgeRequest,
  SubmitImageJobBridgeResult,
  UnlockProviderBridgeRequest,
} from './provider-bridge.js';
export type {
  DesktopBridgeApi,
  DesktopBridgeInvoke,
  DesktopBridgeSend,
  DesktopBridgeSubscribe,
  DesktopGenerationHistoryBridgeApi,
  DesktopProjectImageBridgeApi,
  SafeModeBridgeApi,
} from './preload-api.js';
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
