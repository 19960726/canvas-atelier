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
  PrepareSkillCandidateReviewBridgeRequest,
  PrepareSkillCandidateReviewBridgeResult,
  RecoveryPlanBridgeRequest,
  RecoveryPlanBridgeResult,
  ReviewSkillCandidateBridgeRequest,
  ReviewSkillCandidateBridgeResult,
  RestoreBridgeRequest,
  RestoreBridgeResult,
  StablePointBridgeRequest,
  StablePointBridgeResult,
  ConfigureProviderBridgeRequest,
  ProviderBridgeProfile,
  ProviderConfigurationStatus,
  SubmitImageJobBridgeRequest,
  SubmitImageJobBridgeResult,
  PollImageJobBridgeRequest,
  PollImageJobBridgeResult,
  CancelImageJobBridgeRequest,
  CancelImageJobBridgeResult,
  AckImageJobTerminalBridgeRequest,
  AckImageJobTerminalBridgeResult,
  UnlockProviderBridgeRequest,
  DesktopGenerationHistoryBridgeApi,
  PasteProjectClipboardImageBridgeRequest,
  PasteProjectClipboardImageBridgeResult,
} from '@agent-canvas/desktop-core';
import type { KnowledgeBaseStateSummary } from '@agent-canvas/skill-store';

export interface AgentCanvasApi {
  readonly history: DesktopGenerationHistoryBridgeApi;
  readonly project: {
    open(request: OpenProjectBridgeRequest): Promise<OpenProjectBridgeResult | null>;
    commit(request: CommitBridgeRequest): Promise<CommitAck>;
    stable(request: StablePointBridgeRequest): Promise<StablePointBridgeResult>;
    restore(request: RestoreBridgeRequest): Promise<RestoreBridgeResult>;
    close(request: CloseProjectBridgeRequest): Promise<void>;
    recovery(request: RecoveryPlanBridgeRequest): Promise<RecoveryPlanBridgeResult>;
  };
  readonly assets: {
    importPack(request: ImportPackBridgeRequest): Promise<ImportPackBridgeResult | null>;
    exportPack(request: ExportPackBridgeRequest): Promise<ExportPackBridgeResult | null>;
  };
  readonly clipboard: {
    pasteImage(request: PasteProjectClipboardImageBridgeRequest): Promise<PasteProjectClipboardImageBridgeResult | null>;
  };
  readonly provider: {
    listProfiles(): Promise<ProviderBridgeProfile[]>;
    submitImageJob(request: SubmitImageJobBridgeRequest): Promise<SubmitImageJobBridgeResult>;
    pollImageJob(request: PollImageJobBridgeRequest): Promise<PollImageJobBridgeResult>;
    cancelImageJob(request: CancelImageJobBridgeRequest): Promise<CancelImageJobBridgeResult>;
    ackImageJobTerminal(request: AckImageJobTerminalBridgeRequest): Promise<AckImageJobTerminalBridgeResult>;
  };
  readonly skill: {
    getKnowledgeState(): Promise<KnowledgeStateBridgeResult>;
    configureKnowledgeBase(request: ConfigureKnowledgeBaseBridgeRequest): Promise<KnowledgeBaseStateSummary | null>;
    prepareSkillCandidateReview(request: PrepareSkillCandidateReviewBridgeRequest): Promise<PrepareSkillCandidateReviewBridgeResult>;
    reviewSkillCandidate(request: ReviewSkillCandidateBridgeRequest): Promise<ReviewSkillCandidateBridgeResult>;
    subscribeKnowledgeState(listener: (state: KnowledgeBaseStateSummary) => void): () => void;
    subscribeKnowledgeSyncStatus(listener: (status: KnowledgeSyncStatusSummary) => void): () => void;
  };
  readonly secrets: {
    getProviderStatus(): Promise<ProviderConfigurationStatus>;
    configureProvider(request: ConfigureProviderBridgeRequest): Promise<ProviderConfigurationStatus>;
    unlockProvider(request: UnlockProviderBridgeRequest): Promise<ProviderConfigurationStatus>;
  };
}

export type {
  CancelImageJobBridgeRequest,
  CancelImageJobBridgeResult,
  AckImageJobTerminalBridgeRequest,
  AckImageJobTerminalBridgeResult,
  ConfigureProviderBridgeRequest,
  PollImageJobBridgeRequest,
  PollImageJobBridgeResult,
  ProviderBridgeProfile,
  ProviderConfigurationStatus,
  SubmitImageJobBridgeRequest,
  SubmitImageJobBridgeResult,
  UnlockProviderBridgeRequest,
};
