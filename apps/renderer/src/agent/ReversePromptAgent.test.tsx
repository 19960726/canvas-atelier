import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  UNCONFIGURED_KNOWLEDGE_VERSION_KEY,
  type ApprovedMemorySnapshot,
  type ReversePromptRun,
  type ReversePromptResult,
} from '@agent-canvas/domain';
import { ReversePromptAgent } from './ReversePromptAgent';

afterEach(() => cleanup());

const approvedMemorySnapshot: ApprovedMemorySnapshot = {
  version: 'approved-memory-v3',
  approvedAt: '2026-07-13T12:00:00.000Z',
  approvedMemoryIds: ['memory-1'],
};

function resultFor(run: ReversePromptRun): ReversePromptResult {
  return {
    sessionId: run.sessionId,
    nonce: run.nonce,
    knowledgeSnapshotVersion: run.knowledgeLease.versionKey,
    analysis: `本次分析 ${run.nonce}`,
    keywords: [`新关键词-${run.nonce}`],
    positivePrompt: '高端产品主视觉，严格保持产品身份。',
    negativeConstraints: ['禁止修改 Logo'],
    executionChecklist: ['核对产品身份'],
  };
}

function renderAgent(overrides: Partial<React.ComponentProps<typeof ReversePromptAgent>> = {}) {
  return render(<ReversePromptAgent
    projectId="project-1"
    referenceAssetIds={['asset-1']}
    getApprovedMemorySnapshot={() => approvedMemorySnapshot}
    analyze={async (run) => resultFor(run)}
    {...overrides}
  />);
}

describe('ReversePromptAgent', () => {
  it('renders honest dedicated Skill and persona controls', () => {
    renderAgent({ analysisMode: 'local_draft' });
    expect(screen.getByLabelText('反推 Agent')).toBeVisible();
    expect(screen.getByText('场景 Skill')).toBeVisible();
    expect(screen.getByLabelText('反推角色')).toHaveDisplayValue('高级商业视觉设计师 + 产品摄影指导 + 提示词工程师');
    expect(screen.getByLabelText('编辑 Skill')).toBeDisabled();
    expect(screen.getByLabelText('更多操作')).toBeDisabled();
    expect(screen.getByText('本地草稿，未调用模型')).toBeVisible();
    expect(screen.getByRole('button', { name: '开始反推' })).toBeEnabled();
    expect(screen.getByText('1 / 20')).toBeVisible();
  });

  it('reads the newest approved snapshot and creates fresh run identity on every start', async () => {
    const snapshots = [
      approvedMemorySnapshot,
      { ...approvedMemorySnapshot, version: 'approved-memory-v4', approvedAt: '2026-07-13T13:00:00.000Z' },
    ];
    const getApprovedMemorySnapshot = vi.fn(() => snapshots.shift()!);
    const analyze = vi.fn(async (run: ReversePromptRun) => resultFor(run));
    renderAgent({ getApprovedMemorySnapshot, analyze });

    fireEvent.click(screen.getByRole('button', { name: '开始反推' }));
    await waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '开始反推' }));
    await waitFor(() => expect(analyze).toHaveBeenCalledTimes(2));

    const first = analyze.mock.calls[0]![0];
    const second = analyze.mock.calls[1]![0];
    expect(getApprovedMemorySnapshot).toHaveBeenCalledTimes(2);
    expect(first.approvedMemorySnapshot.version).toBe('approved-memory-v3');
    expect(second.approvedMemorySnapshot.version).toBe('approved-memory-v4');
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(first.sessionId).toBe(first.knowledgeLease.runId);
    expect(second.sessionId).toBe(second.knowledgeLease.runId);
    expect(first.knowledgeLease.versionKey).toBe(UNCONFIGURED_KNOWLEDGE_VERSION_KEY);
    expect(second.nonce).not.toBe(first.nonce);
    expect(screen.getAllByText('本次新生成')).toHaveLength(2);
    expect(screen.getByText(`新关键词-${second.nonce}`)).toBeVisible();
  });

  it('blocks concurrent starts before the running state rerenders', async () => {
    let finish: ((value: ReversePromptResult) => void) | undefined;
    const analyze = vi.fn((run: ReversePromptRun) => new Promise<ReversePromptResult>((resolve) => {
      finish = (value) => resolve(value);
    }));
    renderAgent({ analyze });
    const start = screen.getByRole('button', { name: '开始反推' });

    start.click();
    start.click();
    expect(analyze).toHaveBeenCalledTimes(1);

    const run = analyze.mock.calls[0]![0];
    finish?.(resultFor(run));
    await waitFor(() => expect(screen.getByText('分析')).toBeVisible());
  });

  it('shows every structured reverse-prompt section', async () => {
    renderAgent();
    fireEvent.click(screen.getByRole('button', { name: '开始反推' }));
    await waitFor(() => expect(screen.getByText('分析')).toBeVisible());
    expect(screen.getByText('新关键词')).toBeVisible();
    expect(screen.getByText('反推正向提示词')).toBeVisible();
    expect(screen.getByText('负面约束')).toBeVisible();
    expect(screen.getByText('执行检查清单')).toBeVisible();
    expect(screen.getByText(UNCONFIGURED_KNOWLEDGE_VERSION_KEY)).toBeVisible();
  });
});
