import type { ProjectOperation, ProjectTransaction } from '@agent-canvas/domain';

export const PROJECT_FORMAT_VERSION = 1;
export const JOURNAL_SCHEMA_VERSION = 1;
export const SNAPSHOT_SCHEMA_VERSION = 1;
export const PROJECT_LOCK_SCHEMA_VERSION = 1;
export const LOCK_HEARTBEAT_MS = 5_000;
export const STALE_LOCK_MS = 15_000;
export const SNAPSHOT_TRANSACTION_LIMIT = 200;
export const SNAPSHOT_BYTE_LIMIT = 4 * 1024 * 1024;

interface ProjectState {
  readonly [key: string]: unknown;
}

export type PersistenceChannel = 'legacy' | 'modern';

export type JournalTransactionKind = 'canvas' | 'agent' | 'system';

export interface ProjectManifest {
  readonly projectId: string;
  readonly projectName: string;
  readonly formatVersion: typeof PROJECT_FORMAT_VERSION;
  readonly stableSnapshotId: string | null;
  readonly stableSnapshotPath: string | null;
  readonly stableSnapshotRevision: number;
  readonly activeJournalSegment: string;
  readonly nextSequence: number;
  readonly assetInventory: {
    readonly assetCount: number;
    readonly totalBytes: number;
  };
  readonly cleanClose: boolean;
  readonly minimumCompatibleWriterVersion: number;
}

export interface JournalRecord {
  readonly schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  readonly projectId: string;
  readonly sequence: number;
  readonly revision: number;
  readonly transactionId: string;
  readonly committedAt: string;
  readonly kind: JournalTransactionKind;
  readonly label: string;
  readonly operations: readonly ProjectOperation[];
  readonly payloadSha256: string;
}

export interface SnapshotEnvelope {
  readonly schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  readonly projectId: string;
  readonly snapshotId: string;
  readonly previousSnapshotId: string | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly project: ProjectState;
  readonly projectSha256: string;
}

export interface ProjectLock {
  readonly schemaVersion: typeof PROJECT_LOCK_SCHEMA_VERSION;
  readonly projectId: string;
  readonly deviceId: string;
  readonly processId: number;
  readonly channel: PersistenceChannel;
  readonly sessionId: string;
  readonly openedAt: string;
  readonly heartbeatAt: string;
}

export interface CommitRequest {
  readonly projectId: string;
  readonly baseRevision: number;
  readonly kind: JournalTransactionKind;
  readonly transaction: ProjectTransaction;
}

export interface CommitAck {
  readonly projectId: string;
  readonly revision: number;
  readonly sequence: number;
  readonly transactionId: string;
  readonly committedAt: string;
}

export type RecoveryAction =
  | 'auto_recover'
  | 'choose_recovery'
  | 'read_only'
  | 'unsupported_version';

export interface RecoveryPlan {
  readonly action: RecoveryAction;
  readonly projectId: string;
  readonly targetRevision: number | null;
  readonly stableSnapshotId: string | null;
  readonly issues: readonly string[];
}

export type PersistenceErrorCode =
  | 'DISK_FULL'
  | 'PERMISSION_DENIED'
  | 'READ_ONLY_VOLUME'
  | 'REVISION_CONFLICT'
  | 'CONCURRENT_WRITER'
  | 'MISSING_ASSET'
  | 'CORRUPT_SNAPSHOT'
  | 'CORRUPT_JOURNAL'
  | 'UNSUPPORTED_PROJECT_VERSION'
  | 'PACKAGE_VALIDATION_FAILED';

export interface PersistenceError extends Error {
  readonly code: PersistenceErrorCode;
  readonly retryable: boolean;
}
