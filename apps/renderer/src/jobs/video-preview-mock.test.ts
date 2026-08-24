import { describe, expect, it } from 'vitest';

import {
  advanceOfflineVideoPreview,
  cancelOfflineVideoPreview,
  createOfflineVideoPreview,
} from './video-preview-mock';

describe('offline video preview mock', () => {
  it('advances a safe local-only preview from queued through progress to an MP4-shaped result', () => {
    const queued = createOfflineVideoPreview({
      taskId: 'video-preview-1',
      prompt: 'A gentle product turntable',
      referenceAssetIds: ['0123456789abcdef', 'fedcba9876543210'],
      durationSeconds: 4,
    });

    const running = advanceOfflineVideoPreview(queued);
    const completed = advanceOfflineVideoPreview(running);

    expect(running).toMatchObject({ status: 'running', progress: 0.5 });
    expect(completed).toMatchObject({
      status: 'completed',
      progress: 1,
      result: { mediaType: 'video/mp4', durationMs: 4000 },
    });
    expect(completed.result?.assetId).toMatch(/^[a-f0-9]{16}$/u);
    expect(JSON.stringify(completed)).not.toMatch(/https?:|base64|[A-Z]:\\|file:\/\//iu);
  });

  it('cancels a queued or running preview and keeps terminal tasks unchanged', () => {
    const queued = createOfflineVideoPreview({
      taskId: 'video-preview-2',
      prompt: 'A safe mock clip',
      referenceAssetIds: [],
      durationSeconds: 8,
    });
    const cancelled = cancelOfflineVideoPreview(queued);

    expect(cancelled).toMatchObject({ status: 'cancelled', progress: 0 });
    expect(cancelOfflineVideoPreview(cancelled)).toEqual(cancelled);
  });

  it('fails only for the explicit test-only failure outcome without a provider call', () => {
    const failed = advanceOfflineVideoPreview(createOfflineVideoPreview({
      taskId: 'video-preview-failure',
      prompt: 'Mock failure coverage',
      referenceAssetIds: [],
      durationSeconds: 4,
      outcome: 'fail',
    }));

    expect(failed).toMatchObject({ status: 'failed', progress: 0, error: '模拟预览失败' });
  });
});
