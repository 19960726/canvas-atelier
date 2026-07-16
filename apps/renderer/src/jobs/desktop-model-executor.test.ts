import { describe, expect, it, vi } from 'vitest';

import type { ModelJob } from '@agent-canvas/domain';
import { createDesktopModelJobExecutor } from './desktop-model-executor';

describe('desktop model job executor', () => {
  it('uses only the narrow window.novusDesktop provider bridge', async () => {
    const submitImageJob = vi.fn(async () => ({ providerTaskId: 'provider-job-public-bridge' }));
    const pollImageJob = vi.fn(async () => ({
      status: 'completed' as const,
      progress: 1,
      result: { assetId: 'provider:comfly:provider-job-public-bridge:0', url: 'https://assets.example/result.png' },
    }));
    const cancelImageJob = vi.fn(async () => ({ status: 'cancelled' as const }));
    const ackImageJobTerminal = vi.fn(async () => ({ acknowledged: true as const }));
    vi.stubGlobal('window', {
      novusDesktop: {
        provider: {
          ackImageJobTerminal,
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
    await (executor as unknown as { ackTerminal(job: ModelJob): Promise<void> }).ackTerminal({
      ...job({ status: 'completed' }),
      providerTaskId: submitted.providerTaskId,
    });

    expect(submitted).toEqual({ providerTaskId: 'provider-job-public-bridge' });
    expect(polled).toEqual({
      status: 'completed',
      progress: 1,
      result: { assetId: 'provider:comfly:provider-job-public-bridge:0' },
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
    expect(ackImageJobTerminal).toHaveBeenCalledWith({
      provider: 'comfly',
      providerTaskId: 'provider-job-public-bridge',
      status: 'completed',
    });
    expect(JSON.stringify({ submitted, polled })).not.toMatch(/Authorization|Bearer|token|base64/i);
  });

  it('passes through cancelled provider terminals from poll and cancel', async () => {
    const pollImageJob = vi.fn(async () => ({ status: 'cancelled' as const }));
    const cancelImageJob = vi.fn(async () => ({ status: 'cancelled' as const }));
    vi.stubGlobal('window', {
      novusDesktop: {
        provider: {
          submitImageJob: vi.fn(),
          pollImageJob,
          cancelImageJob,
          ackImageJobTerminal: vi.fn(),
        },
      },
    });
    const executor = createDesktopModelJobExecutor();

    await expect(executor.poll({ ...job({ status: 'running' }), providerTaskId: 'provider-job-cancelled' })).resolves.toEqual({
      status: 'cancelled',
    });
    await expect(executor.cancel?.({ ...job({ status: 'running' }), providerTaskId: 'provider-job-cancelled' })).resolves.toEqual({
      status: 'cancelled',
    });
  });

  it('turns locked credentials into a retryable running poll state', async () => {
    const pollImageJob = vi.fn(async () => {
      throw { code: 'CREDENTIALS_LOCKED', message: 'locked', retryable: true };
    });
    vi.stubGlobal('window', {
      novusDesktop: {
        provider: {
          submitImageJob: vi.fn(),
          pollImageJob,
          cancelImageJob: vi.fn(),
          ackImageJobTerminal: vi.fn(),
        },
      },
    });

    const executor = createDesktopModelJobExecutor();

    await expect(executor.poll({ ...job({ status: 'running' }), providerTaskId: 'provider-job-locked' })).resolves.toEqual({
      status: 'running',
      blockedReason: 'credentials_locked',
      progress: undefined,
    });
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
