import { cleanup, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentKnowledgeLease, type AgentKnowledgeLease } from '@agent-canvas/domain';
import type { KnowledgeBaseStateSummary } from '@agent-canvas/skill-store';
import { KnowledgeStatus } from './KnowledgeStatus';

afterEach(() => cleanup());

describe('KnowledgeStatus', () => {
  it.each([
    ['syncing', [], /同步中/],
    ['updated', [knowledgeState({ status: 'active', version: 4 })], /已更新/],
    ['pending_review', [knowledgeState({ status: 'active', version: 4 })], /待审核/ , 1],
    ['fallback', [knowledgeState({ status: 'fallback', version: 3, failure: 'Disk unavailable' })], /回退/],
  ])('renders %s status', (_name, knowledgeBases, expected, pendingReviewCount = 0) => {
    render(<KnowledgeStatus
      knowledgeBases={knowledgeBases}
      pendingReviewCount={pendingReviewCount}
      syncStatuses={[]}
    />);

    expect(screen.getByRole('status')).toHaveTextContent(expected);
  });

  it.each(['offline', 'conflict', 'updated'] as const)('renders %s sync lifecycle without replacing active snapshot state', (status) => {
    render(<KnowledgeStatus
      knowledgeBases={[knowledgeState({ status: 'active', version: 2 })]}
      syncStatuses={[{
        schemaVersion: 1,
        knowledgeBaseId: 'scene-skill',
        status,
        changedAt: '2026-07-16T04:00:00.000Z',
        lastFailure: status === 'updated' ? null : {
          reason: status === 'offline' ? 'Network unavailable' : 'Version conflict',
          failedAt: '2026-07-16T04:00:00.000Z',
        },
      }]}
    />);

    expect(screen.getByRole('status')).toHaveTextContent(status === 'offline' ? '离线' : status === 'conflict' ? '冲突' : '已更新');
    expect(screen.getByText(/scene-skill@2/)).toBeVisible();
  });
  it('separates the status label from active knowledge detail with a stable status attribute', () => {
    render(<KnowledgeStatus
      knowledgeBases={[]}
      pendingReviewCount={0}
      syncStatuses={[{
        schemaVersion: 1,
        knowledgeBaseId: 'scene-skill',
        status: 'syncing',
        changedAt: '2026-07-16T04:00:00.000Z',
        lastFailure: null,
      }]}
    />);

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('data-knowledge-status', 'syncing');
    expect(within(status).getByTestId('knowledge-status-label')).toHaveTextContent(/同步中/);
    expect(within(status).getByTestId('knowledge-status-detail')).toHaveTextContent(/暂无已启用知识/);
  });
  it('prioritizes conflict over offline when different knowledge bases report both', () => {
    render(<KnowledgeStatus
      knowledgeBases={[knowledgeState({ status: 'active', version: 2 })]}
      syncStatuses={[
        {
          schemaVersion: 1,
          knowledgeBaseId: 'scene-skill',
          status: 'offline',
          changedAt: '2026-07-16T04:00:00.000Z',
          lastFailure: { reason: 'Network unavailable', failedAt: '2026-07-16T04:00:00.000Z' },
        },
        {
          schemaVersion: 1,
          knowledgeBaseId: 'brand-rules',
          status: 'conflict',
          changedAt: '2026-07-16T04:01:00.000Z',
          lastFailure: { reason: 'Version conflict', failedAt: '2026-07-16T04:01:00.000Z' },
        },
      ]}
    />);

    expect(screen.getByRole('status')).toHaveTextContent(/冲突/);
  });
  it('shows active version, update time, and the pinned run version', () => {
    render(<KnowledgeStatus
      knowledgeBases={[knowledgeState({ status: 'active', version: 9 })]}
      pinnedLease={lease('run-1', 7)}
    />);

    expect(screen.getByText(/scene-skill@9/)).toBeVisible();
    expect(screen.getByText(/2026-07-15/)).toBeVisible();
    expect(screen.getByText(/固定版本/)).toHaveTextContent(`scene-skill@7:${'b'.repeat(12)}`);
  });
});

function knowledgeState(options: {
  failure?: string;
  status: KnowledgeBaseStateSummary['status'] | 'offline' | 'conflict';
  version: number | null;
}): KnowledgeBaseStateSummary {
  return {
    schemaVersion: 1,
    knowledgeBaseId: 'scene-skill',
    displayName: 'Scene Skill',
    status: options.status as KnowledgeBaseStateSummary['status'],
    activeVersion: options.version,
    activeContentHash: options.version === null ? null : 'a'.repeat(64),
    versionCount: options.version ?? 0,
    versions: options.version === null ? [] : [{
      version: options.version,
      contentHash: 'a'.repeat(64),
      publishedAt: '2026-07-15T08:00:00.000Z',
      sourceDeviceId: 'device-1',
      displayName: 'Scene Skill',
    }],
    lastFailure: options.failure ? {
      reason: options.failure,
      failedAt: '2026-07-15T08:05:00.000Z',
    } : null,
    lastRollbackAt: null,
  };
}

function lease(runId: string, version: number): AgentKnowledgeLease {
  return createAgentKnowledgeLease({
    runId,
    capability: 'reverse_prompt',
    snapshots: [{
      knowledgeBaseId: 'scene-skill',
      version,
      contentHash: 'b'.repeat(64),
    }],
    references: [{
      assetId: 'asset-1',
      label: 'Hero product',
      role: 'product_identity',
      position: 0,
    }],
    citations: [],
  }, {
    leaseId: `lease-${runId}`,
    createdAt: '2026-07-15T08:00:00.000Z',
  });
}
