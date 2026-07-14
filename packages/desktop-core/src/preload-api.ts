import type {
  CloseProjectBridgeRequest,
  CommitAck,
  CommitBridgeRequest,
  ExportPackBridgeRequest,
  ExportPackBridgeResult,
  ImportPackBridgeRequest,
  ImportPackBridgeResult,
  OpenProjectBridgeRequest,
  OpenProjectBridgeResult,
  RecoveryPlanBridgeRequest,
  RecoveryPlanBridgeResult,
  RestoreBridgeRequest,
  RestoreBridgeResult,
  StablePointBridgeRequest,
  StablePointBridgeResult,
} from './contracts.js';

export const DESKTOP_BRIDGE_PRELOAD_KEY = 'novusDesktop';

export const BRIDGE_CHANNELS = {
  closeProject: 'novus-desktop:close-project',
  commit: 'novus-desktop:commit',
  createStablePoint: 'novus-desktop:create-stable-point',
  exportPack: 'novus-desktop:export-pack',
  getRecoveryPlan: 'novus-desktop:get-recovery-plan',
  importPack: 'novus-desktop:import-pack',
  openProject: 'novus-desktop:open-project',
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

export function createPreloadApi(invoke: DesktopBridgeInvoke): DesktopBridgeApi {
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
