import { describe, expect, it } from 'vitest';
import {
  createConfirmedModelJob,
  getLegalModelJobTransitions,
  mapImageResolutionTier,
  modelJobSchema,
  normalizeImageResolutionTier,
  sanitizeModelJobError,
  transitionModelJob,
} from './model-job';

const confirmedAt = '2026-07-16T08:00:00.000Z';

describe('model job domain contract', () => {
  it.each([
    ['1K', '1K'],
    ['2K', '2K'],
    ['4K', '4K'],
    ['1024x1024', '1K'],
    ['1536x1024', '2K'],
    ['1024x1536', '2K'],
    [undefined, '1K'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeImageResolutionTier(input)).toBe(expected);
  });

  it('maps tiers to stable landscape and portrait dimensions', () => {
    expect(mapImageResolutionTier('4K', '16:9')).toEqual({ width: 3840, height: 2160 });
    expect(mapImageResolutionTier('4K', '9:16')).toEqual({ width: 2160, height: 3840 });
    expect(mapImageResolutionTier('2K', '9:16')).toEqual({ width: 1152, height: 2048 });
    expect(mapImageResolutionTier('2K', '16:9')).toEqual({ width: 2048, height: 1152 });
    expect(mapImageResolutionTier('2K', '2:3')).toEqual({ width: 1365, height: 2048 });
    expect(mapImageResolutionTier('2K', '3:2')).toEqual({ width: 2048, height: 1365 });
  });

  it('hydrates legacy raw dimensions while storing new requests as tiers', () => {
    expect(modelJobSchema.parse({
      id: 'legacy-resolution-job', modelId: 'legacy-model', status: 'queued', promptNodeId: 'prompt-1', retryCount: 0,
      resolution: '1024x1536',
    }).resolution).toBe('2K');

    expect(createConfirmedModelJob({
      id: 'tier-job', promptNodeId: 'prompt-1', confirmedAt, provider: 'comfly', modelRoute: 'gpt-image',
      displayName: 'GPT image', modelId: 'dynamic-gpt-image-id', conversationId: 'agent-conversation-shared',
      referenceAssetIds: [], resolution: '4K',
    }).resolution).toBe('4K');
  });

  it('hydrates legacy jobs as image jobs and preserves explicit video controls', () => {
    expect(modelJobSchema.parse({
      id: 'legacy-image-job', modelId: 'legacy-model', status: 'queued', promptNodeId: 'prompt-1', retryCount: 0,
    }).kind).toBe('image');

    expect(createConfirmedModelJob({
      id: 'video-job', promptNodeId: 'video-node', confirmedAt, kind: 'video', provider: 'relayme',
      modelRoute: 'relayme-video', displayName: 'Relay video', modelId: 'relay-video', conversationId: 'video-conversation',
      referenceAssetIds: [], aspectRatio: '16:9', videoResolution: '2K', durationSeconds: 8, outputCount: 1,
      audioEnabled: true, prompt: 'Cinematic reveal',
    })).toMatchObject({
      kind: 'video', videoResolution: '2K', durationSeconds: 8, audioEnabled: true,
    });
  });

  it.each(['360p', '512p', '540p', '768p'] as const)('preserves the explicit %s video tier', (videoResolution) => {
    expect(createConfirmedModelJob({
      id: `video-${videoResolution}`, promptNodeId: 'video-node', confirmedAt, kind: 'video', provider: 'comfly',
      modelRoute: 'dynamic-video', displayName: 'Dynamic video', modelId: 'dynamic-video', conversationId: 'video-conversation',
      referenceAssetIds: [], aspectRatio: '16:9', videoResolution, durationSeconds: 6, outputCount: 1,
    }).videoResolution).toBe(videoResolution);
  });
  it('allows only legal lifecycle transitions', () => {
    const job = createConfirmedModelJob({
      id: 'job-1',
      promptNodeId: 'prompt-1',
      confirmedAt,
      provider: 'comfly',
      modelRoute: 'gpt-image',
      displayName: 'GPT image',
      modelId: 'dynamic-gpt-image-id',
      conversationId: 'agent-conversation-shared',
      referenceAssetIds: ['asset-product'],
    });

    const submitting = transitionModelJob(job, 'submitting');
    const running = transitionModelJob(submitting, 'running', { providerTaskId: 'task-1' });
    const completed = transitionModelJob(running, 'completed');
    const failed = transitionModelJob(running, 'failed', { error: 'provider timeout' });
    const retried = transitionModelJob(failed, 'queued');

    expect(completed.status).toBe('completed');
    expect(retried).toMatchObject({ status: 'queued', retryCount: 1 });
    expect(() => transitionModelJob(job, 'completed')).toThrow(/illegal model job transition/i);
    expect(() => transitionModelJob(completed, 'failed')).toThrow(/illegal model job transition/i);
    expect(getLegalModelJobTransitions('queued')).toEqual(['submitting', 'cancelled']);
  });

  it('rejects enqueue metadata without a confirmation timestamp', () => {
    expect(() => createConfirmedModelJob({
      id: 'job-2',
      promptNodeId: 'prompt-1',
      provider: 'comfly',
      modelRoute: 'nano-banana-2',
      displayName: 'Nano Banana 2',
      modelId: 'inventory-model-id',
      conversationId: 'agent-conversation-shared',
      referenceAssetIds: [],
    })).toThrow(/confirmedAt/i);
  });

  it('keeps routing provenance dynamic and backward-compatible with old fixtures', () => {
    expect(modelJobSchema.parse({
      id: 'legacy-job',
      modelId: 'legacy-model',
      status: 'queued',
      promptNodeId: 'prompt-1',
      retryCount: 0,
    })).toMatchObject({
      id: 'legacy-job',
      modelId: 'legacy-model',
      status: 'queued',
    });

    expect(createConfirmedModelJob({
      id: 'job-3',
      promptNodeId: 'prompt-1',
      confirmedAt,
      provider: 'comfly',
      modelRoute: 'route-from-inventory',
      displayName: 'Inventory display name',
      modelId: 'inventory-model-id',
      conversationId: 'agent-conversation-shared',
      referenceAssetIds: ['asset-a', 'asset-b'],
    })).toMatchObject({
      provider: 'comfly',
      modelRoute: 'route-from-inventory',
      displayName: 'Inventory display name',
      modelId: 'inventory-model-id',
      conversationId: 'agent-conversation-shared',
    });

    expect(createConfirmedModelJob({
      id: 'relayme-job',
      promptNodeId: 'prompt-1',
      confirmedAt,
      provider: 'relayme',
      modelRoute: 'relayme-image-default',
      displayName: 'RelayMe Image',
      modelId: 'relayme-image-model',
      conversationId: 'agent-conversation-shared',
      referenceAssetIds: [],
    })).toMatchObject({ provider: 'relayme' });

    expect(() => createConfirmedModelJob({
      id: 'unknown-provider-job',
      promptNodeId: 'prompt-1',
      confirmedAt,
      provider: 'unknown-provider' as never,
      modelRoute: 'unknown-route',
      displayName: 'Unknown',
      modelId: 'unknown-model',
      conversationId: 'agent-conversation-shared',
      referenceAssetIds: [],
    })).toThrow();
  });

  it('persists provider terminal ACK state for crash recovery', () => {
    expect(modelJobSchema.parse({
      id: 'terminal-job',
      modelId: 'dynamic-model',
      status: 'completed',
      promptNodeId: 'prompt-1',
      providerTaskId: 'provider-job-terminal',
      retryCount: 0,
      providerAckPending: true,
      terminalStatus: 'completed',
    })).toMatchObject({
      providerAckPending: true,
      terminalStatus: 'completed',
    });
  });

  it('stores compact public errors without secrets, base64, or private paths', () => {
    const sanitized = sanitizeModelJobError(
      'Authorization: Bearer sk-secret-token-value failed for C:\\Users\\private\\source.png data:image/png;base64,AAAAAAAAAAAAAAAAAAAA',
    );

    expect(sanitized).toContain('[redacted]');
    expect(sanitized).not.toMatch(/Authorization|sk-secret|C:\\Users|data:image|base64/i);
    expect(sanitized.length).toBeLessThanOrEqual(160);
  });

  it('uses the readable message from a structured provider error', () => {
    const sanitized = sanitizeModelJobError({
      code: 'PROVIDER_UNAVAILABLE',
      message: '当前项目会话不可用',
      retryable: true,
    });

    expect(sanitized).toBe('当前项目会话不可用');
    expect(sanitized).not.toContain('[object Object]');
  });
});
