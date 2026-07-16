import { describe, expect, it, vi } from 'vitest';

import type { ModelJob } from '@agent-canvas/domain';
import { createDesktopModelJobExecutor } from './desktop-model-executor';

describe('desktop model job executor', () => {
  it('uses only the narrow window.novusDesktop provider bridge', async () => {
    const submitImageJob = vi.fn(async () => ({ providerTaskId: 'task-bridge' }));
    const pollImageJob = vi.fn(async () => ({
      status: 'completed' as const,
      progress: 1,
      result: { assetId: 'provider:comfly:task-bridge:0', url: 'https://assets.example/result.png' },
    }));
    const cancelImageJob = vi.fn(async () => {});
    vi.stubGlobal('window', {
      novusDesktop: {
        provider: {
          submitImageJob,
          pollImageJob,
          cancelImageJob,
        },
      },
    });
    vi.stubGlobal('fetch', vi.fn(() => {
      throw new Error('renderer fetch must not be used');
    }));

    const executor = createDesktopModelJobExecutor();
    const submitted = await executor.submit(job());
    const polled = await executor.poll({ ...job(), providerTaskId: submitted.providerTaskId });
    await executor.cancel?.({ ...job(), providerTaskId: submitted.providerTaskId });

    expect(submitted).toEqual({ providerTaskId: 'task-bridge' });
    expect(polled).toEqual({
      status: 'completed',
      progress: 1,
      result: { assetId: 'provider:comfly:task-bridge:0' },
    });
    expect(submitImageJob).toHaveBeenCalledWith({
      jobId: 'job-1',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'draw a chair',
      conversationId: 'conversation-1',
      referenceAssetIds: ['asset-reference'],
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify({ submitted, polled })).not.toMatch(/Authorization|Bearer|token|base64/i);
  });

  it('keeps browser mode unavailable with sanitized failures', async () => {
    vi.stubGlobal('window', {});
    const executor = createDesktopModelJobExecutor();

    await expect(executor.submit(job())).rejects.toThrow(/provider bridge unavailable/i);
    await expect(executor.submit(job())).rejects.not.toThrow(/token|Authorization|Bearer|base64/i);
  });
});

function job(overrides: Partial<ModelJob> = {}): ModelJob {
  return {
    id: 'job-1',
    modelId: 'dynamic-model-id',
    status: 'queued',
    promptNodeId: 'prompt-start',
    confirmedAt: '2026-07-16T08:00:00.000Z',
    retryCount: 0,
    provider: 'comfly',
    modelRoute: 'gpt-image',
    displayName: 'GPT Image',
    conversationId: 'conversation-1',
    referenceAssetIds: ['asset-reference'],
    prompt: 'draw a chair',
    createdAt: '2026-07-16T08:00:00.000Z',
    updatedAt: '2026-07-16T08:00:00.000Z',
    ...overrides,
  };
}
