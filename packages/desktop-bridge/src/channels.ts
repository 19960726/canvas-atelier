import { BRIDGE_CHANNELS } from '@agent-canvas/desktop-core/preload-api';

export const AGENT_CANVAS_CHANNELS = {
  project: {
    open: BRIDGE_CHANNELS.openProject,
    commit: BRIDGE_CHANNELS.commit,
    stable: BRIDGE_CHANNELS.createStablePoint,
    restore: BRIDGE_CHANNELS.restore,
    close: BRIDGE_CHANNELS.closeProject,
    recovery: BRIDGE_CHANNELS.getRecoveryPlan,
  },
  assets: {
    importPack: BRIDGE_CHANNELS.importPack,
    exportPack: BRIDGE_CHANNELS.exportPack,
  },
  provider: {
    listProfiles: BRIDGE_CHANNELS.provider.listProfiles,
    submitImageJob: BRIDGE_CHANNELS.provider.submitImageJob,
    pollImageJob: BRIDGE_CHANNELS.provider.pollImageJob,
    cancelImageJob: BRIDGE_CHANNELS.provider.cancelImageJob,
    ackImageJobTerminal: BRIDGE_CHANNELS.provider.ackImageJobTerminal,
  },
  history: BRIDGE_CHANNELS.history,
  skill: {
    configureKnowledgeBase: BRIDGE_CHANNELS.configureKnowledgeBase,
    getKnowledgeState: BRIDGE_CHANNELS.getKnowledgeState,
    prepareSkillCandidateReview: BRIDGE_CHANNELS.prepareSkillCandidateReview,
    reviewSkillCandidate: BRIDGE_CHANNELS.reviewSkillCandidate,
    knowledgeStateChanged: BRIDGE_CHANNELS.knowledgeStateChanged,
    knowledgeSyncStatusChanged: BRIDGE_CHANNELS.knowledgeSyncStatusChanged,
  },
  secrets: {
    getProviderStatus: BRIDGE_CHANNELS.provider.getStatus,
    configureProvider: BRIDGE_CHANNELS.provider.configure,
    unlockProvider: BRIDGE_CHANNELS.provider.unlock,
  },
} as const;
