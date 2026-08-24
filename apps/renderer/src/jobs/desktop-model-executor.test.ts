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
      sessionId: 'desktop-session-1',
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

  it('routes RelayMe image jobs through the same provider bridge', async () => {
    const submitImageJob = vi.fn(async () => ({ providerTaskId: 'provider-job-relayme-public' }));
    vi.stubGlobal('window', {
      novusDesktop: {
        provider: {
          submitImageJob,
          pollImageJob: vi.fn(),
          cancelImageJob: vi.fn(),
          ackImageJobTerminal: vi.fn(),
        },
      },
    });

    await expect(createDesktopModelJobExecutor().submit(job({
      provider: 'relayme',
      modelRoute: 'relayme-gpt-image-2',
    }))).resolves.toEqual({ providerTaskId: 'provider-job-relayme-public' });
    expect(submitImageJob).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'relayme',
      modelRoute: 'relayme-gpt-image-2',
    }));
  });

  it('routes video jobs through the video bridge and preserves video controls', async () => {
    const submitVideoJob = vi.fn(async () => ({ providerTaskId: 'provider-job-relay-video' }));
    const pollVideoJob = vi.fn(async () => ({
      status: 'completed' as const,
      progress: 1,
      result: { assetId: 'fedcba9876543210', width: 1920, height: 1080, durationSeconds: 8 },
    }));
    const cancelVideoJob = vi.fn(async () => ({ status: 'cancelled' as const }));
    const ackVideoJobTerminal = vi.fn(async () => ({ acknowledged: true as const }));
    vi.stubGlobal('window', { novusDesktop: { provider: {
      submitVideoJob, pollVideoJob, cancelVideoJob, ackVideoJobTerminal,
      submitImageJob: vi.fn(), pollImageJob: vi.fn(), cancelImageJob: vi.fn(), ackImageJobTerminal: vi.fn(),
    } } });
    const executor = createDesktopModelJobExecutor();
    const videoJob = job({
      kind: 'video', provider: 'relayme', modelRoute: 'relayme-video', referenceAssetIds: [],
      aspectRatio: '16:9', videoResolution: '1080p', durationSeconds: 8, outputCount: 1, audioEnabled: true,
    });

    const submitted = await executor.submit(videoJob);
    await expect(executor.poll({ ...videoJob, status: 'running', providerTaskId: submitted.providerTaskId })).resolves.toEqual({
      status: 'completed', progress: 1,
      result: { assetId: 'fedcba9876543210', width: 1920, height: 1080, durationSeconds: 8 },
    });
    await executor.cancel?.({ ...videoJob, status: 'running', providerTaskId: submitted.providerTaskId });
    await executor.ackTerminal?.({ ...videoJob, status: 'completed', providerTaskId: submitted.providerTaskId });

    expect(submitVideoJob).toHaveBeenCalledWith({
      jobId: 'job-1', provider: 'relayme', modelRoute: 'relayme-video', prompt: 'draw a chair',
      conversationId: 'conversation-1', sessionId: 'desktop-session-1', referenceAssetIds: [],
      aspectRatio: '16:9', resolution: '1080p', durationSeconds: 8, outputCount: 1, audioEnabled: true,
    });
    expect(cancelVideoJob).toHaveBeenCalled();
    expect(ackVideoJobTerminal).toHaveBeenCalledWith({
      provider: 'relayme', providerTaskId: 'provider-job-relay-video', status: 'completed',
    });
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
    projectSessionId: 'desktop-session-1',
    referenceAssetIds: ['asset-reference'],
    prompt: 'draw a chair',
    createdAt: '2026-07-16T08:00:00.000Z',
    updatedAt: '2026-07-16T08:00:00.000Z',
    ...overrides,
    kind: overrides.kind ?? 'image',
  };
}
