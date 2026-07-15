import type {
  CloseProjectBridgeRequest,
  CommitAck,
  CommitBridgeRequest,
  ConfigureKnowledgeBaseBridgeRequest,
  ExportPackBridgeRequest,
  ExportPackBridgeResult,
  ImportPackBridgeRequest,
  ImportPackBridgeResult,
  KnowledgeStateBridgeResult,
  KnowledgeSyncStatusSummary,
  OpenProjectBridgeRequest,
  OpenProjectBridgeResult,
  RecoveryPlanBridgeRequest,
  RecoveryPlanBridgeResult,
  ReviewSkillCandidateBridgeRequest,
  ReviewSkillCandidateBridgeResult,
  RestoreBridgeRequest,
  RestoreBridgeResult,
  StablePointBridgeRequest,
  StablePointBridgeResult,
} from './contracts.js';
import type { KnowledgeBaseStateSummary } from '@agent-canvas/skill-store';

export const DESKTOP_BRIDGE_PRELOAD_KEY = 'novusDesktop';

export const BRIDGE_CHANNELS = {
  closeProject: 'novus-desktop:close-project',
  commit: 'novus-desktop:commit',
  configureKnowledgeBase: 'novus-desktop:configure-knowledge-base',
  createStablePoint: 'novus-desktop:create-stable-point',
  exportPack: 'novus-desktop:export-pack',
  getKnowledgeState: 'novus-desktop:get-knowledge-state',
  getRecoveryPlan: 'novus-desktop:get-recovery-plan',
  importPack: 'novus-desktop:import-pack',
  knowledgeStateChanged: 'novus-desktop:knowledge-state-changed',
  knowledgeSyncStatusChanged: 'novus-desktop:knowledge-sync-status-changed',
  openProject: 'novus-desktop:open-project',
  reviewSkillCandidate: 'novus-desktop:review-skill-candidate',
  restore: 'novus-desktop:restore',
} as const;

const SAFE_MODE_BRIDGE_CHANNELS = {
  getRecoveryPlan: 'novus-desktop:get-recovery-plan',
  openProject: 'novus-desktop:open-project',
  restore: 'novus-desktop:restore',
} as const;

export interface DesktopBridgeApi {
  openProject(request: OpenProjectBridgeRequest): Promise<OpenProjectBridgeResult | null>;
  commit(request: CommitBridgeRequest): Promise<CommitAck>;
  createStablePoint(request: StablePointBridgeRequest): Promise<StablePointBridgeResult>;
  restore(request: RestoreBridgeRequest): Promise<RestoreBridgeResult>;
  exportPack(request: ExportPackBridgeRequest): Promise<ExportPackBridgeResult | null>;
  importPack(request: ImportPackBridgeRequest): Promise<ImportPackBridgeResult | null>;
  closeProject(request: CloseProjectBridgeRequest): Promise<void>;
  getRecoveryPlan(request: RecoveryPlanBridgeRequest): Promise<RecoveryPlanBridgeResult>;
  configureKnowledgeBase(request: ConfigureKnowledgeBaseBridgeRequest): Promise<KnowledgeBaseStateSummary | null>;
  getKnowledgeState(): Promise<KnowledgeStateBridgeResult>;
  reviewSkillCandidate(request: ReviewSkillCandidateBridgeRequest): Promise<ReviewSkillCandidateBridgeResult>;
  subscribeKnowledgeState(listener: (state: KnowledgeBaseStateSummary) => void): () => void;
  subscribeKnowledgeSyncStatus(listener: (status: KnowledgeSyncStatusSummary) => void): () => void;
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

export function createPreloadApi(
  invoke: DesktopBridgeInvoke,
  subscribe: DesktopBridgeSubscribe = () => () => undefined,
): DesktopBridgeApi {
  return {
    openProject(request) {
      return invoke<OpenProjectBridgeResult | null>(BRIDGE_CHANNELS.openProject, request);
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
