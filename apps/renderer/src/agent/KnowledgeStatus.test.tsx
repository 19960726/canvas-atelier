import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentKnowledgeLease, type AgentKnowledgeLease } from '@agent-canvas/domain';
import type { KnowledgeBaseStateSummary } from '@agent-canvas/skill-store';
import { KnowledgeStatus } from './KnowledgeStatus';

afterEach(() => cleanup());

describe('KnowledgeStatus', () => {
  it.each([
    ['syncing', [], /syncing/i],
    ['updated', [knowledgeState({ status: 'active', version: 4 })], /updated/i],
    ['pending_review', [knowledgeState({ status: 'active', version: 4 })], /pending review/i, 1],
    ['fallback', [knowledgeState({ status: 'fallback', version: 3, failure: 'Disk unavailable' })], /fallback/i],
    ['offline', [knowledgeState({ status: 'offline', version: null })], /offline/i],
    ['conflict', [knowledgeState({ status: 'conflict', version: 2, failure: 'Version conflict' })], /conflict/i],
  ])('renders %s status', (_name, knowledgeBases, expected, pendingReviewCount = 0) => {
    render(<KnowledgeStatus
      knowledgeBases={knowledgeBases}
      pendingReviewCount={pendingReviewCount}
    />);

    expect(screen.getByRole('status')).toHaveTextContent(expected);
  });

  it('shows active version, update time, and the pinned run version', () => {
    render(<KnowledgeStatus
      knowledgeBases={[knowledgeState({ status: 'active', version: 9 })]}
      pinnedLease={lease('run-1', 7)}
    />);

    expect(screen.getByText(/scene-skill@9/)).toBeVisible();
    expect(screen.getByText(/2026-07-15/)).toBeVisible();
    expect(screen.getByText(/Pinned/)).toHaveTextContent(`scene-skill@7:${'b'.repeat(12)}`);
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
