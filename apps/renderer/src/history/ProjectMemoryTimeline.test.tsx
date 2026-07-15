import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectMemoryEntry, SkillPromotionCandidate } from '@agent-canvas/domain';
import { ProjectMemoryTimeline } from './ProjectMemoryTimeline';

afterEach(() => cleanup());

const optimization: ProjectMemoryEntry = {
  schemaVersion: 1,
  id: 'memory-1',
  projectId: 'project-1',
  projectRevision: 1,
  createdAt: '2026-07-14T01:00:00.000Z',
  kind: 'optimization',
  actor: 'agent',
  title: '优化产品构图',
  changeSummary: '放大产品并保留顶部安全区。',
  rationale: '提高产品识别度。',
  snapshots: { beforeId: 'snapshot-before', afterId: 'snapshot-after' },
  context: { referenceAssetIds: ['asset-1'], resultAssetIds: [] },
  feedback: { keep: ['产品比例'], change: ['背景亮度'], never: ['修改 Logo'], score: 4 },
  nextStep: '降低背景亮度。',
};

const decision: ProjectMemoryEntry = {
  ...optimization,
  id: 'memory-2',
  projectRevision: 2,
  kind: 'decision',
  actor: 'user',
  title: '撤销画布优化',
  changeSummary: '撤销上一项优化。',
  rationale: '用户选择撤销。',
  snapshots: { beforeId: 'undo-before', afterId: 'undo-after' },
  supersedesMemoryId: optimization.id,
};

const candidate: SkillPromotionCandidate = {
  schemaVersion: 1,
  id: 'candidate-1',
  sourceProjectId: 'project-1',
  sourceProjectMemoryId: optimization.id,
  createdAt: '2026-07-14T02:00:00.000Z',
  title: optimization.title,
  rationale: optimization.rationale,
  rule: optimization.nextStep,
  evidence: optimization.feedback,
  reviewStatus: 'pending_review',
};

describe('ProjectMemoryTimeline', () => {
  it('filters the visible timeline by memory type', () => {
    render(<ProjectMemoryTimeline entries={[optimization, decision]} promotionCandidates={[]} availableSnapshotIds={['snapshot-after', 'undo-after']} onRestore={() => {}} onPromote={() => {}} />);
    expect(screen.getByLabelText('项目记忆时间线')).toBeVisible();
    expect(screen.getByText('优化产品构图')).toBeVisible();
    expect(screen.getByText('撤销画布优化')).toBeVisible();

    fireEvent.change(screen.getByLabelText('记忆类型筛选'), { target: { value: 'decision' } });

    expect(screen.queryByText('优化产品构图')).not.toBeInTheDocument();
    expect(screen.getByText('撤销画布优化')).toBeVisible();
    expect(screen.getByRole('button', { name: '撤销画布优化 不可提升' })).toBeDisabled();
  });

  it('restores the selected after snapshot and creates only a pending Skill candidate', () => {
    const onRestore = vi.fn();
    const onPromote = vi.fn();
    const { rerender } = render(<ProjectMemoryTimeline entries={[optimization]} promotionCandidates={[]} availableSnapshotIds={['snapshot-after']} onRestore={onRestore} onPromote={onPromote} />);

    fireEvent.click(screen.getByRole('button', { name: '恢复 优化产品构图' }));
    fireEvent.click(screen.getByRole('button', { name: '提升 优化产品构图 为 Skill' }));
    expect(onRestore).toHaveBeenCalledWith('snapshot-after');
    expect(onPromote).toHaveBeenCalledWith('memory-1');

    rerender(<ProjectMemoryTimeline entries={[optimization]} promotionCandidates={[candidate]} availableSnapshotIds={[]} onRestore={onRestore} onPromote={onPromote} />);
    expect(screen.getByRole('button', { name: '优化产品构图 快照不可用' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '优化产品构图 已进入 Skill 审批' })).toBeDisabled();
    expect(screen.getByText('待审批')).toBeVisible();
  });
  it('keeps timeline entries visible while candidate review status changes', () => {
    render(<ProjectMemoryTimeline
      entries={[optimization]}
      promotionCandidates={[{
        ...candidate,
        reviewStatus: 'rolled_back',
        reviewedAt: '2026-07-15T09:00:00.000Z',
        publishedKnowledgeVersion: 3,
        rolledBackAt: '2026-07-15T10:00:00.000Z',
        targetKnowledgeBaseId: 'scene-skill',
      }]}
      availableSnapshotIds={['snapshot-after']}
      knowledgeBases={[{
        schemaVersion: 1,
        knowledgeBaseId: 'scene-skill',
        displayName: 'Scene Skill',
        status: 'rolled_back',
        activeVersion: 2,
        activeContentHash: 'b'.repeat(64),
        versionCount: 3,
        versions: [
          { version: 1, contentHash: 'a'.repeat(64), publishedAt: '2026-07-15T07:00:00.000Z', sourceDeviceId: 'device-a', displayName: 'Scene Skill' },
          { version: 2, contentHash: 'b'.repeat(64), publishedAt: '2026-07-15T08:00:00.000Z', sourceDeviceId: 'device-a', displayName: 'Scene Skill' },
          { version: 3, contentHash: 'c'.repeat(64), publishedAt: '2026-07-15T09:00:00.000Z', sourceDeviceId: 'device-a', displayName: 'Scene Skill' },
        ],
        lastFailure: null,
        lastRollbackAt: '2026-07-15T10:00:00.000Z',
      }]}
      onPromote={() => {}}
      onRestore={() => {}}
      onReviewSkillCandidate={async () => undefined}
    />);

    expect(screen.getByText(/产品构图/)).toBeVisible();
    expect(screen.getByText('candidate-1')).toBeVisible();
    expect(screen.getByText('rolled_back')).toBeVisible();
  });
});
