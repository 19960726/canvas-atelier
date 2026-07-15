import {
  createAgentKnowledgeLease,
  type AgentKnowledgeCapability,
  type AgentKnowledgeLease,
  type ImageCitation,
  type OrderedReference,
} from '@agent-canvas/domain';
import type {
  ReviewSkillCandidateBridgeRequest,
  ReviewSkillCandidateBridgeResult,
} from '@agent-canvas/desktop-core';
import type { KnowledgeBaseStateSummary as BridgeKnowledgeBaseStateSummary } from '@agent-canvas/skill-store';

export type KnowledgeBaseStateSummary = BridgeKnowledgeBaseStateSummary;
export type SkillCandidateReviewRequest = Omit<ReviewSkillCandidateBridgeRequest, 'decision'> & {
  decision: ReviewSkillCandidateBridgeRequest['decision'] | 'rolled_back';
  targetVersion?: number;
};

export interface KnowledgeClient {
  start(listener: (states: KnowledgeBaseStateSummary[]) => void): Promise<void>;
  stop(): void;
  configure(knowledgeBaseId: string, displayName: string): Promise<void>;
  review(request: SkillCandidateReviewRequest): Promise<ReviewSkillCandidateBridgeResult>;
  getLease(
    runId: string,
    capability: AgentKnowledgeCapability,
    references: OrderedReference[],
    citations: ImageCitation[],
  ): AgentKnowledgeLease;
}

export function createKnowledgeClient(): KnowledgeClient {
  let listener: ((states: KnowledgeBaseStateSummary[]) => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  let states: KnowledgeBaseStateSummary[] = [];
  let stopped = true;

  const publish = (nextStates: KnowledgeBaseStateSummary[]) => {
    states = sortStates(nextStates.map(cloneSummary));
    listener?.(states.map(cloneSummary));
  };

  const upsert = (summary: KnowledgeBaseStateSummary | null) => {
    if (!summary || stopped) return;
    const next = states.filter((state) => state.knowledgeBaseId !== summary.knowledgeBaseId);
    publish([...next, summary]);
  };

  return {
    async start(nextListener) {
      this.stop();
      stopped = false;
      listener = nextListener;
      const bridge = window.novusDesktop;
      if (!bridge) {
        publish([createOfflineSummary()]);
        return;
      }

      try {
        const hydrated = await bridge.getKnowledgeState();
        if (stopped) return;
        publish([...hydrated.states]);
        unsubscribe = bridge.subscribeKnowledgeState((summary) => upsert(summary));
      } catch {
        if (!stopped) publish([createOfflineSummary()]);
      }
    },
    stop() {
      stopped = true;
      unsubscribe?.();
      unsubscribe = undefined;
      listener = undefined;
    },
    async configure(knowledgeBaseId, displayName) {
      const bridge = window.novusDesktop;
      if (!bridge) return;
      upsert(await bridge.configureKnowledgeBase({ knowledgeBaseId, displayName }));
    },
    async review(request) {
      const bridge = window.novusDesktop;
      if (!bridge) throw new Error('Knowledge review is unavailable outside desktop mode');
      const result = await bridge.reviewSkillCandidate(request as ReviewSkillCandidateBridgeRequest);
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
    && state.status !== 'empty'
    && state.status !== ('offline' as KnowledgeBaseStateSummary['status'])
    && state.status !== ('conflict' as KnowledgeBaseStateSummary['status']);
}

function cloneSummary(summary: KnowledgeBaseStateSummary): KnowledgeBaseStateSummary {
  return {
    ...summary,
    versions: summary.versions.map((version) => ({ ...version })),
    lastFailure: summary.lastFailure ? { ...summary.lastFailure } : null,
  };
}

function sortStates(input: KnowledgeBaseStateSummary[]): KnowledgeBaseStateSummary[] {
  return [...input].sort((left, right) => left.knowledgeBaseId.localeCompare(right.knowledgeBaseId));
}

function createOfflineSummary(): KnowledgeBaseStateSummary {
  return {
    schemaVersion: 1,
    knowledgeBaseId: 'browser-offline',
    displayName: 'Browser fallback',
    status: 'offline' as KnowledgeBaseStateSummary['status'],
    activeVersion: null,
    activeContentHash: null,
    versionCount: 0,
    versions: [],
    lastFailure: {
      reason: 'Desktop knowledge bridge unavailable',
      failedAt: new Date().toISOString(),
    },
    lastRollbackAt: null,
  };
}

function createClientUniqueValue(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
