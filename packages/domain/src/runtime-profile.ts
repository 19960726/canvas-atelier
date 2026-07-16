export type RuntimeProfileId = 'modern' | 'legacy-win7';

export interface RuntimeProfile {
  readonly id: RuntimeProfileId;
  readonly thumbnailEdge: number;
  readonly disableShadowsWhileInteracting: boolean;
  readonly providerPollConcurrency: number;
  readonly imageDecodeConcurrency: number;
  readonly targetFps: number;
}

export const RUNTIME_PROFILES = Object.freeze({
  'legacy-win7': freezeProfile({
    id: 'legacy-win7',
    thumbnailEdge: 72,
    disableShadowsWhileInteracting: true,
    providerPollConcurrency: 2,
    imageDecodeConcurrency: 1,
    targetFps: 30,
  }),
  modern: freezeProfile({
    id: 'modern',
    thumbnailEdge: 96,
    disableShadowsWhileInteracting: false,
    providerPollConcurrency: 4,
    imageDecodeConcurrency: 2,
    targetFps: 60,
  }),
} satisfies Record<RuntimeProfileId, RuntimeProfile>);

export function getRuntimeProfile(id: RuntimeProfileId): RuntimeProfile {
  return RUNTIME_PROFILES[id];
}

function freezeProfile(profile: RuntimeProfile): RuntimeProfile {
  return Object.freeze({ ...profile });
}
