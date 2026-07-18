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
  const activeLabel = active ? `${active.knowledgeBaseId}@${active.version} · 更新于 ${active.publishedAt}` : '暂无已启用知识 / No active knowledge';

  return (
    <aside className={`knowledge-status is-${displayStatus}`} data-knowledge-status={displayStatus} role="status" aria-live="polite">
      <span className="knowledge-status__indicator" aria-hidden="true" />
      <span className="knowledge-status__copy">
        <strong data-testid="knowledge-status-label">{formatStatus(displayStatus)}</strong>
        <span data-testid="knowledge-status-detail">{activeLabel}</span>
      </span>
      {pinnedLease && (
        <span className="knowledge-status__pinned">固定版本 / Pinned {pinnedLease.versionKey}</span>
      )}
    </aside>
  );
}

function selectDisplayStatus(
  knowledgeBases: KnowledgeBaseStateSummary[],
  syncStatuses: KnowledgeSyncStatusSummary[],
  pendingReviewCount: number,
): DisplayStatus {
  if (syncStatuses.some((state) => state.status === 'conflict')) return 'conflict';
  if (syncStatuses.some((state) => state.status === 'offline')) return 'offline';
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
  const labels: Record<DisplayStatus, string> = {
    syncing: '同步中 / Syncing',
    updated: '已更新 / Updated',
    pending_review: '待审核 / Pending review',
    fallback: '回退状态 / Fallback',
    offline: '离线 / Offline',
    conflict: '冲突 / Conflict',
  };
  return labels[status];
}
