import {
  DESKTOP_BRIDGE_PRELOAD_KEY,
  createPreloadApi,
  type DesktopBridgeApi,
  type DesktopBridgeInvoke,
  type DesktopBridgeSubscribe,
} from '@agent-canvas/desktop-core/preload-api';

import type { AgentCanvasApi } from './contracts.js';

export const AGENT_CANVAS_PRELOAD_KEY = 'agentCanvas';
export { DESKTOP_BRIDGE_PRELOAD_KEY };

export function createAgentCanvasApi(
  invoke: DesktopBridgeInvoke,
  subscribe?: DesktopBridgeSubscribe,
): AgentCanvasApi {
  const legacy = createPreloadApi(invoke, subscribe);
  return {
    project: {
      open: (request) => legacy.openProject(request),
      commit: (request) => legacy.commit(request),
      stable: (request) => legacy.createStablePoint(request),
      restore: (request) => legacy.restore(request),
      close: (request) => legacy.closeProject(request),
      recovery: (request) => legacy.getRecoveryPlan(request),
    },
    assets: {
      importPack: (request) => legacy.importPack(request),
      exportPack: (request) => legacy.exportPack(request),
    },
    provider: {
      listProfiles: () => legacy.provider.listProfiles(),
      submitImageJob: (request) => legacy.provider.submitImageJob(request),
      pollImageJob: (request) => legacy.provider.pollImageJob(request),
      cancelImageJob: (request) => legacy.provider.cancelImageJob(request),
      ackImageJobTerminal: (request) => legacy.provider.ackImageJobTerminal(request),
    },
    skill: {
      getKnowledgeState: () => legacy.getKnowledgeState(),
      configureKnowledgeBase: (request) => legacy.configureKnowledgeBase(request),
      reviewSkillCandidate: (request) => legacy.reviewSkillCandidate(request),
      subscribeKnowledgeState: (listener) => legacy.subscribeKnowledgeState(listener),
      subscribeKnowledgeSyncStatus: (listener) => legacy.subscribeKnowledgeSyncStatus(listener),
    },
    secrets: {
      getProviderStatus: () => legacy.provider.getStatus(),
      configureProvider: (request) => legacy.provider.configure(request),
      unlockProvider: (request) => legacy.provider.unlock(request),
    },
  };
}

export function createDesktopPreloadApis(
  invoke: DesktopBridgeInvoke,
  subscribe?: DesktopBridgeSubscribe,
): { readonly novusDesktop: DesktopBridgeApi; readonly agentCanvas: AgentCanvasApi } {
  return {
    novusDesktop: createPreloadApi(invoke, subscribe),
    agentCanvas: createAgentCanvasApi(invoke, subscribe),
  };
}
