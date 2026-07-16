import { describe, expect, it } from 'vitest';
import { resolveRuntimeProfile } from './runtime-profile';

describe('resolveRuntimeProfile', () => {
  it('uses the preload-provided static window profile when present', () => {
    window.agentCanvasRuntimeProfile = {
      id: 'legacy-win7',
      thumbnailEdge: 72,
      disableShadowsWhileInteracting: true,
      providerPollConcurrency: 2,
      imageDecodeConcurrency: 1,
      targetFps: 30,
    };

    expect(resolveRuntimeProfile()).toMatchObject({
      id: 'legacy-win7',
      thumbnailEdge: 72,
      disableShadowsWhileInteracting: true,
      providerPollConcurrency: 2,
      imageDecodeConcurrency: 1,
      targetFps: 30,
    });
  });

  it('falls back to the modern browser profile when no static window profile exists', () => {
    Reflect.deleteProperty(window, 'agentCanvasRuntimeProfile');

    expect(resolveRuntimeProfile()).toMatchObject({
      id: 'modern',
      thumbnailEdge: 96,
      disableShadowsWhileInteracting: false,
      providerPollConcurrency: 4,
      imageDecodeConcurrency: 2,
      targetFps: 60,
    });
  });
});
