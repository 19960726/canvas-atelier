import { describe, expect, it } from 'vitest';

import { createStoryboardService } from './storyboard-service.js';

describe('createStoryboardService', () => {
  it('normalizes a structured shot response for a configured chat route', async () => {
    const service = createStoryboardService({
      listProfiles: async () => [{ provider: 'comfly', modelRoute: 'scene-chat', displayName: 'Scene chat', capabilities: ['chat'] }],
      runStructuredChat: async () => JSON.stringify({
        shots: [{ id: 'shot-1', order: 1, title: 'Opening', composition: 'Wide view of the studio', durationSeconds: 4, referenceAssetIds: ['asset-1'] }],
      }),
    });

    await expect(service.generate({
      provider: 'comfly', modelRoute: 'scene-chat', script: 'A product enters a quiet studio.', shotCount: 1, referenceAssetIds: ['asset-1'],
    })).resolves.toEqual({
      modelRoute: 'scene-chat',
      shots: [{ id: 'shot-1', order: 1, title: 'Opening', composition: 'Wide view of the studio', durationSeconds: 4, referenceAssetIds: ['asset-1'] }],
    });
  });

  it('rejects a route without chat or vision capability before calling the model', async () => {
    const service = createStoryboardService({
      listProfiles: async () => [{ provider: 'comfly', modelRoute: 'image-only', displayName: 'Image only', capabilities: ['image_generation'] }],
      runStructuredChat: async () => '{"shots":[]}',
    });

    await expect(service.generate({ provider: 'comfly', modelRoute: 'image-only', script: 'Scene', shotCount: 1, referenceAssetIds: [] }))
      .rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('rejects unsafe provider output rather than exposing it to the renderer', async () => {
    const service = createStoryboardService({
      listProfiles: async () => [{ provider: 'comfly', modelRoute: 'scene-chat', displayName: 'Scene chat', capabilities: ['vision'] }],
      runStructuredChat: async () => JSON.stringify({
        shots: [{ id: 'shot-1', order: 1, title: 'Opening', composition: 'file:///C:/secret.txt', durationSeconds: 4, referenceAssetIds: [] }],
      }),
    });

    await expect(service.generate({ provider: 'comfly', modelRoute: 'scene-chat', script: 'Scene', shotCount: 1, referenceAssetIds: [] }))
      .rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
  });
});
