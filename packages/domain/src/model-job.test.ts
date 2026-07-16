import { describe, expect, it } from 'vitest';
import {
  createConfirmedModelJob,
  getLegalModelJobTransitions,
  modelJobSchema,
  sanitizeModelJobError,
  transitionModelJob,
} from './model-job';

const confirmedAt = '2026-07-16T08:00:00.000Z';

describe('model job domain contract', () => {
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
  });

  it('stores compact public errors without secrets, base64, or private paths', () => {
    const sanitized = sanitizeModelJobError(
      'Authorization: Bearer sk-secret-token-value failed for C:\\Users\\private\\source.png data:image/png;base64,AAAAAAAAAAAAAAAAAAAA',
    );

    expect(sanitized).toContain('[redacted]');
    expect(sanitized).not.toMatch(/Authorization|sk-secret|C:\\Users|data:image|base64/i);
    expect(sanitized.length).toBeLessThanOrEqual(160);
  });
});
