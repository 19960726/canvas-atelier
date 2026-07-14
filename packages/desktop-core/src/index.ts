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
  CommitAck,
  CommitRequest,
  JournalRecord,
  JournalTransactionKind,
  PersistenceChannel,
  PersistenceError,
  PersistenceErrorCode,
  ProjectLock,
  ProjectManifest,
  RecoveryAction,
  RecoveryPlan,
  SnapshotEnvelope,
} from './contracts.js';

export { canonicalJson, sha256Canonical } from './canonical-json.js';
export { NodeFileSystem, writeAtomic } from './file-system.js';
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
export { MAX_WIN7_PROJECT_ROOT_PATH_LENGTH, ProjectRepository } from './project-repository.js';
export type {
  CreateProjectOptions,
  OpenedProjectSession,
  OpenProjectOptions,
  ProjectRepositoryOptions,
} from './project-repository.js';
