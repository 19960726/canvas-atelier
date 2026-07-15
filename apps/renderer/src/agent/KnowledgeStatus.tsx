import type { AgentKnowledgeLease } from '@agent-canvas/domain';
import type { KnowledgeSyncStatusSummary } from '@agent-canvas/desktop-core';
import type { KnowledgeBaseStateSummary } from '@agent-canvas/skill-store';

interface KnowledgeStatusProps {
  knowledgeBases: KnowledgeBaseStateSummary[];
  syncStatuses?: KnowledgeSyncStatusSummary[];
  pendingReviewCount?: number;
  pinnedLease?: AgentKnowledgeLease | null;
}

type DisplayStatus = 'syncing' | 'updated' | 'pending_review' | 'fallback' | 'offline' | 'conflict';

export function KnowledgeStatus({
  knowledgeBases,
  syncStatuses = [],
  pendingReviewCount = 0,
  pinnedLease = null,
}: KnowledgeStatusProps) {
  const displayStatus = selectDisplayStatus(knowledgeBases, syncStatuses, pendingReviewCount);
  const active = selectActiveVersion(knowledgeBases);

  return (
    <aside className="knowledge-status" role="status" aria-live="polite">
      <span className="knowledge-status__state">{formatStatus(displayStatus)}</span>
      <span className="knowledge-status__active">
        {active ? `${active.knowledgeBaseId}@${active.version} updated ${active.publishedAt}` : 'No active knowledge'}
      </span>
      {pinnedLease && (
        <span className="knowledge-status__pinned">Pinned {pinnedLease.versionKey}</span>
      )}
    </aside>
  );
}

function selectDisplayStatus(
  knowledgeBases: KnowledgeBaseStateSummary[],
  syncStatuses: KnowledgeSyncStatusSummary[],
  pendingReviewCount: number,
): DisplayStatus {
  if (syncStatuses.some((state) => state.status === 'offline')) return 'offline';
  if (syncStatuses.some((state) => state.status === 'conflict')) return 'conflict';
  if (syncStatuses.some((state) => state.status === 'syncing')) return 'syncing';
  if (pendingReviewCount > 0) return 'pending_review';
  if (knowledgeBases.some((state) => state.status === 'fallback')) return 'fallback';
  if (syncStatuses.some((state) => state.status === 'updated')) return 'updated';
  if (knowledgeBases.some((state) => state.activeVersion !== null)) return 'updated';
  return 'syncing';
}

function selectActiveVersion(knowledgeBases: KnowledgeBaseStateSummary[]): {
  knowledgeBaseId: string;
  publishedAt: string;
  version: number;
} | null {
  const candidates = knowledgeBases.flatMap((state) => {
    const activeVersion = state.activeVersion;
    if (activeVersion === null) return [];
    const version = state.versions.find((entry) => entry.version === activeVersion);
    if (!version) return [];
    return [{
      knowledgeBaseId: state.knowledgeBaseId,
      publishedAt: version.publishedAt,
      version: activeVersion,
    }];
  });

  return candidates.sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))[0] ?? null;
}

function formatStatus(status: DisplayStatus): string {
  return status === 'pending_review' ? 'pending review' : status;
}
