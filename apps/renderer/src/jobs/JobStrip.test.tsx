import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelJob } from '@agent-canvas/domain';
import { JobStrip } from './JobStrip';

afterEach(cleanup);

describe('JobStrip', () => {
  it.each(['julun', '4dai'] as const)('does not offer an unsafe retry for an uncertain $provider submission', (provider) => {
    render(
      <JobStrip
        jobs={[{
          id: `uncertain-${provider}`,
          kind: provider === 'julun' ? 'video' : 'image',
          modelId: `${provider}-model`,
          promptNodeId: `${provider}-node`,
          provider,
          retryCount: 0,
          status: 'cancelled',
          displayName: `${provider} uncertain`,
          referenceAssetIds: [],
          error: '提交状态不确定：供应商可能已接收任务，为避免重复扣费，请先检查供应商任务记录。',
        }]}
        saveState="saved"
        saveLabel="Saved"
        onRetrySave={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText('提交状态不确定', { exact: true })).toBeVisible();
    expect(screen.queryByTestId('job-retry')).not.toBeInTheDocument();
  });

  it('describes Julun and 4D local cancellation as stopping wait and tracking', () => {
    const jobs: ModelJob[] = [
      {
        id: '4d-running',
        kind: 'image',
        modelId: 'gpt-image-2',
        promptNodeId: '4d-image-node',
        provider: '4dai',
        retryCount: 0,
        status: 'running',
        displayName: '4D Image',
        referenceAssetIds: [],
      },
      {
        id: 'julun-stopped',
        kind: 'video',
        modelId: 'seedance-2.0-fast',
        promptNodeId: 'julun-video-node',
        provider: 'julun',
        retryCount: 0,
        status: 'cancelled',
        displayName: 'Julun Video',
        referenceAssetIds: [],
      },
    ];

    render(
      <JobStrip
        jobs={jobs}
        saveState="saved"
        saveLabel="Saved"
        onRetrySave={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '停止等待 4D Image' })).toHaveAttribute('title', '停止等待');
    expect(screen.getByText('已停止跟踪')).toBeVisible();
    expect(screen.queryByRole('button', { name: '取消 4D Image' })).not.toBeInTheDocument();
    expect(screen.queryByText('已取消')).not.toBeInTheDocument();
  });

  it('keeps an active job visible ahead of four older failed or cancelled jobs', () => {
    const terminalJobs: ModelJob[] = Array.from({ length: 4 }, (_, index) => ({
      id: `old-terminal-${index}`,
      kind: 'image',
      modelId: `old-model-${index}`,
      promptNodeId: `old-node-${index}`,
      retryCount: 0,
      status: index % 2 === 0 ? 'failed' : 'cancelled',
      displayName: `Old terminal ${index}`,
      referenceAssetIds: [],
    }));
    const activeJob: ModelJob = {
      id: 'current-running',
      kind: 'image',
      modelId: 'current-model',
      promptNodeId: 'current-node',
      retryCount: 0,
      status: 'running',
      displayName: 'Current running',
      referenceAssetIds: [],
    };

    render(
      <JobStrip
        jobs={[...terminalJobs, activeJob]}
        saveState="saved"
        saveLabel="Saved"
        onRetrySave={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const visibleJobIds = screen.getAllByTestId('job-chip').map((chip) => chip.getAttribute('data-job-id'));
    expect(visibleJobIds[0]).toBe(activeJob.id);
    expect(visibleJobIds).toContain(activeJob.id);
    expect(screen.getByText('Current running')).toBeVisible();
  });

  it('exposes active-job and durable save-state presentation hooks', () => {
    const jobs: ModelJob[] = [{
      id: 'job-running',
      kind: 'image',
      modelId: 'gpt-image-1',
      promptNodeId: 'prompt-1',
      retryCount: 0,
      status: 'running',
      displayName: 'GPT Image',
      referenceAssetIds: [],
    }];

    render(
      <JobStrip
        jobs={jobs}
        saveState="saved"
        saveLabel="Saved after ACK"
        onRetrySave={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByTestId('job-strip')).toHaveAttribute('data-has-active-jobs', 'true');
    expect(screen.getByTestId('save-state')).toHaveAttribute('data-save-state', 'saved');
  });

  it('offers an explicit retry when a durable project commit failed', () => {
    const onRetrySave = vi.fn();
    render(
      <JobStrip
        jobs={[]}
        saveState="error"
        saveLabel="Local save failed"
        onRetrySave={onRetrySave}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('save-retry'));
    expect(onRetrySave).toHaveBeenCalledOnce();
  });

  it('offers durable reload instead of retry for an unresolved writer conflict', () => {
    const onReloadSave = vi.fn();
    render(
      <JobStrip
        canReloadSave
        canRetrySave={false}
        jobs={[]}
        saveState="error"
        saveLabel="Local work conflicts with disk"
        onReloadSave={onReloadSave}
        onRetrySave={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('save-retry')).not.toBeInTheDocument();
    expect(screen.getByTestId('save-reload')).toHaveTextContent('重新载入项目');
    fireEvent.click(screen.getByTestId('save-reload'));
    expect(onReloadSave).toHaveBeenCalledOnce();
  });
});
