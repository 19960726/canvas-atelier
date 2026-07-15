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
  KnowledgeStateBridgeResult,
  OpenProjectBridgeRequest,
  OpenProjectBridgeResult,
  PersistenceChannel,
  PersistenceError,
  PersistenceErrorCode,
  ProjectLock,
  ProjectManifest,
  RecoveryCandidateBridgeSummary,
  RecoveryPlanBridgeRequest,
  RecoveryPlanBridgeResult,
  RecoveryAction,
  RecoveryPlan,
  ReviewSkillCandidateBridgeRequest,
  ReviewSkillCandidateBridgeResult,
  RestoreBridgeRequest,
  RestoreBridgeResult,
  SnapshotEnvelope,
  StablePointBridgeRequest,
  StablePointBridgeResult,
} from './contracts.js';

export { canonicalJson, sha256Canonical } from './canonical-json.js';
export { AssetStore } from './asset-store.js';
export type { AssetMetadata, StageAssetOptions } from './asset-store.js';
export { NodeFileSystem, writeAtomic } from './file-system.js';
export { ManagedKnowledgeStore } from './managed-knowledge-store.js';
export type {
  ConfigureKnowledgeRoot,
  ConfiguredKnowledgeBase,
  InternalKnowledgeConfiguration,
  ManagedKnowledgeStoreOptions,
} from './managed-knowledge-store.js';
export { KnowledgeRefreshService } from './knowledge-refresh-service.js';
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
export type {
  DesktopBridgeApi,
  DesktopBridgeInvoke,
  DesktopBridgeSubscribe,
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
