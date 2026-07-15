import type { DesktopBridgeApi } from '@agent-canvas/desktop-core';
import type { ProjectPersistenceClient } from '../app/desktop-persistence';

type ProjectPersistenceBridgeApi = Pick<
  DesktopBridgeApi,
  | 'closeProject'
  | 'commit'
  | 'createStablePoint'
  | 'exportPack'
  | 'getRecoveryPlan'
  | 'importPack'
  | 'openProject'
  | 'restore'
>;

declare global {
  interface Window {
    novusDesktop?: DesktopBridgeApi;
  }
}

declare module '../app/desktop-persistence' {
  export function createDesktopPersistenceClient(bridge: ProjectPersistenceBridgeApi): ProjectPersistenceClient;
}

export {};
