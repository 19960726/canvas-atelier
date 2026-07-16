import { getRuntimeProfile, type RuntimeProfile } from '@agent-canvas/domain';

export function resolveRuntimeProfile(): RuntimeProfile {
  const candidate = globalThis.window?.agentCanvasRuntimeProfile;
  if (candidate?.id === 'legacy-win7') {
    return getRuntimeProfile('legacy-win7');
  }
  if (candidate?.id === 'modern') {
    return getRuntimeProfile('modern');
  }
  return getRuntimeProfile('modern');
}

export const runtimeProfile = resolveRuntimeProfile();
