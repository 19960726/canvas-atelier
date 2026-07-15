import {
  createAgentKnowledgeLease,
  type AgentKnowledgeCapability,
  type AgentKnowledgeLease,
  type ImageCitation,
  type OrderedReference,
  type SkillPromotionCandidate,
} from '@agent-canvas/domain';
import type {
  KnowledgeSyncStatusSummary,
  ReviewSkillCandidateBridgeRequest,
  ReviewSkillCandidateBridgeResult,
} from '@agent-canvas/desktop-core';
import type { KnowledgeBaseStateSummary as BridgeKnowledgeBaseStateSummary } from '@agent-canvas/skill-store';

export type KnowledgeBaseStateSummary = BridgeKnowledgeBaseStateSummary;
export type SkillCandidateReviewRequest = Omit<ReviewSkillCandidateBridgeRequest, 'decision'> & {
  decision: ReviewSkillCandidateBridgeRequest['decision'] | 'rolled_back';
  targetVersion?: number;
};
export type SkillCandidateReviewResult = ReviewSkillCandidateBridgeResult & {
  candidates: readonly SkillPromotionCandidate[];
};

export interface KnowledgeClient {
  start(
    listener: (states: KnowledgeBaseStateSummary[]) => void,
    syncListener?: (status: KnowledgeSyncStatusSummary) => void,
  ): Promise<void>;
  stop(): void;
  configure(knowledgeBaseId: string, displayName: string): Promise<void>;
  review(request: SkillCandidateReviewRequest): Promise<SkillCandidateReviewResult>;
  getLease(
    runId: string,
    capability: AgentKnowledgeCapability,
    references: OrderedReference[],
    citations: ImageCitation[],
  ): AgentKnowledgeLease;
}

export function createKnowledgeClient(): KnowledgeClient {
  let listener: ((states: KnowledgeBaseStateSummary[]) => void) | undefined;
  let syncListener: ((status: KnowledgeSyncStatusSummary) => void) | undefined;
  let unsubscribeState: (() => void) | undefined;
  let unsubscribeSync: (() => void) | undefined;
  let states: KnowledgeBaseStateSummary[] = [];
  let syncStatuses: KnowledgeSyncStatusSummary[] = [];
  let stopped = true;
  let runSequence = 0;
  let activeRun = 0;

  const publish = (nextStates: KnowledgeBaseStateSummary[]) => {
    states = sortStates(nextStates.map(cloneSummary));
    listener?.(states.map(cloneSummary));
  };
  const publishSync = (status: KnowledgeSyncStatusSummary) => {
    if (stopped) return;
    const existing = syncStatuses.find((item) => item.knowledgeBaseId === status.knowledgeBaseId);
    if (existing !== undefined && existing.changedAt >= status.changedAt) return;
    syncStatuses = [
      ...syncStatuses.filter((item) => item.knowledgeBaseId !== status.knowledgeBaseId),
      cloneSyncStatus(status),
    ];
    syncListener?.(cloneSyncStatus(status));
  };
  const upsert = (summary: KnowledgeBaseStateSummary | null) => {
    if (!summary || stopped) return;
    const next = states.filter((state) => state.knowledgeBaseId !== summary.knowledgeBaseId);
    publish([...next, summary]);
  };

  return {
    async start(nextListener, nextSyncListener) {
      this.stop();
      const run = ++runSequence;
      activeRun = run;
      stopped = false;
      listener = nextListener;
      syncListener = nextSyncListener;
      states = [];
      syncStatuses = [];
      const bridge = window.novusDesktop;
      if (!bridge) {
        publish([]);
        publishSync(createOfflineSyncStatus('desktop-bridge', 'Desktop knowledge bridge unavailable'));
        return;
      }

      const bufferedStates: KnowledgeBaseStateSummary[] = [];
      let hydrationPending = true;
      try {
        unsubscribeState = bridge.subscribeKnowledgeState((summary) => {
          if (stopped || activeRun !== run || summary === null) return;
          if (hydrationPending) {
            bufferedStates.push(cloneSummary(summary));
            return;
          }
          upsert(summary);
        });
        unsubscribeSync = bridge.subscribeKnowledgeSyncStatus((status) => {
          if (activeRun === run) publishSync(status);
        });
        const hydrated = await bridge.getKnowledgeState();
        if (stopped || activeRun !== run) return;
        publish([...hydrated.states]);
        for (const status of hydrated.syncStatuses ?? []) {
          publishSync(status);
        }
        hydrationPending = false;
        for (const summary of bufferedStates) {
          upsert(summary);
        }
      } catch {
        if (stopped || activeRun !== run) return;
        unsubscribeState?.();
        unsubscribeSync?.();
        unsubscribeState = undefined;
        unsubscribeSync = undefined;
        publish([]);
        publishSync(createOfflineSyncStatus('desktop-bridge', 'Desktop knowledge bridge unavailable'));
      }
    },
    stop() {
      stopped = true;
      activeRun = 0;
      unsubscribeState?.();
      unsubscribeSync?.();
      unsubscribeState = undefined;
      unsubscribeSync = undefined;
      listener = undefined;
      syncListener = undefined;
      syncStatuses = [];
    },
    async configure(knowledgeBaseId, displayName) {
      const bridge = window.novusDesktop;
      if (!bridge) return;
      upsert(await bridge.configureKnowledgeBase({ knowledgeBaseId, displayName }));
    },
    async review(request) {
      const bridge = window.novusDesktop;
      if (!bridge) throw new Error('Knowledge review is unavailable outside desktop mode');
      const result = await bridge.reviewSkillCandidate(request as ReviewSkillCandidateBridgeRequest) as SkillCandidateReviewResult;
      upsert(result.knowledgeState);
      return result;
    },
    getLease(runId, capability, references, citations) {
      const snapshots = states
        .filter(hasPinnableSnapshot)
        .map((state) => ({
          knowledgeBaseId: state.knowledgeBaseId,
          version: state.activeVersion!,
          contentHash: state.activeContentHash!,
        }));

      return createAgentKnowledgeLease({
        runId,
        capability,
        snapshots,
        references,
        citations,
      }, {
        leaseId: createClientUniqueValue(),
        createdAt: new Date().toISOString(),
      });
    },
  };
}

function hasPinnableSnapshot(state: KnowledgeBaseStateSummary): boolean {
  return state.activeVersion !== null
    && state.activeContentHash !== null
    && state.status !== 'empty';
}

function cloneSummary(summary: KnowledgeBaseStateSummary): KnowledgeBaseStateSummary {
  return {
    ...summary,
    versions: summary.versions.map((version) => ({ ...version })),
    lastFailure: summary.lastFailure ? { ...summary.lastFailure } : null,
  };
}

function cloneSyncStatus(status: KnowledgeSyncStatusSummary): KnowledgeSyncStatusSummary {
  return {
    ...status,
    lastFailure: status.lastFailure === null ? null : { ...status.lastFailure },
  };
}

function sortStates(input: KnowledgeBaseStateSummary[]): KnowledgeBaseStateSummary[] {
  return [...input].sort((left, right) => left.knowledgeBaseId.localeCompare(right.knowledgeBaseId));
}

function createOfflineSyncStatus(knowledgeBaseId: string, reason: string): KnowledgeSyncStatusSummary {
  const changedAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    knowledgeBaseId,
    status: 'offline',
    changedAt,
    lastFailure: { reason, failedAt: changedAt },
  };
}

function createClientUniqueValue(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
