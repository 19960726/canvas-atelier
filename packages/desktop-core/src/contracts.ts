import type { CanvasProject, ProjectOperation, ProjectTransaction, SkillPromotionCandidate } from '@agent-canvas/domain';
import type { KnowledgeBaseStateSummary } from '@agent-canvas/skill-store';

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
  | 'PACKAGE_VALIDATION_FAILED'
  | 'INVALID_REQUEST'
  | 'INVALID_SESSION';

export interface PersistenceError extends Error {
  readonly code: PersistenceErrorCode;
  readonly retryable: boolean;
}

export interface BridgeSessionSummary {
  readonly sessionId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly mode: 'write' | 'read_only';
  readonly currentRevision: number;
  readonly stableSnapshotId: string | null;
  readonly stableSnapshotRevision: number;
  readonly project: CanvasProject;
}

export interface OpenProjectBridgeRequest {
  readonly mode: 'write' | 'read_only';
}

export interface OpenProjectBridgeResult extends BridgeSessionSummary {}

export interface CommitBridgeRequest extends CommitRequest {
  readonly sessionId: string;
}

export interface StablePointBridgeRequest {
  readonly sessionId: string;
}

export interface StablePointBridgeResult {
  readonly path: string;
  readonly reason: 'stable_point';
  readonly revision: number;
  readonly snapshotId: string;
}

export interface RecoveryCandidateBridgeSummary {
  readonly candidateId: string;
  readonly revision: number;
  readonly snapshotId: string;
  readonly tailStatus: 'complete' | 'partial_final_line';
}

export interface RecoveryPlanBridgeRequest {
  readonly sessionId: string;
}

export interface RecoveryPlanBridgeResult extends RecoveryPlan {
  readonly candidates: readonly RecoveryCandidateBridgeSummary[];
  readonly recoveredRevision: number | null;
}

export interface RestoreBridgeRequest {
  readonly sessionId: string;
  readonly candidateId?: string;
}

export interface RestoreBridgeResult extends BridgeSessionSummary {
  readonly restoredRevision: number;
}

export interface ExportPackBridgeRequest {
  readonly sessionId: string;
}

export interface ExportPackBridgeInventoryEntry {
  readonly byteSize: number;
  readonly path: string;
  readonly sha256: string;
}

export interface ExportPackBridgeResult {
  readonly inventory: readonly ExportPackBridgeInventoryEntry[];
  readonly packageName: string;
  readonly pinnedRevision: number;
}

export interface ImportPackBridgeRequest {
  readonly mode: 'write' | 'read_only';
}

export interface ImportPackBridgeResult extends BridgeSessionSummary {
  readonly importedRevision: number;
}

export interface CloseProjectBridgeRequest {
  readonly sessionId: string;
}

export interface ConfigureKnowledgeBaseBridgeRequest {
  readonly knowledgeBaseId: string;
  readonly displayName: string;
}

export interface KnowledgeStateBridgeResult {
  readonly states: readonly KnowledgeBaseStateSummary[];
}

export interface ReviewSkillCandidateBridgeRequest {
  readonly projectId: string;
  readonly candidateId: string;
  readonly decision: 'approved' | 'rejected' | 'superseded' | 'rolled_back';
  readonly targetVersion?: number;
}

export interface ReviewSkillCandidateBridgeResult {
  readonly projectId: string;
  readonly currentRevision: number;
  readonly candidate: SkillPromotionCandidate;
  readonly knowledgeState: KnowledgeBaseStateSummary | null;
}
