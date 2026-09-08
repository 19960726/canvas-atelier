import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import { supportsVerifiedComflyVideoInputMode } from '@agent-canvas/domain';

export type GenerationKind = 'image' | 'video';
export interface GenerationParameters {
  aspectRatio?: string;
  resolution?: string;
  outputCount?: number;
  durationSeconds?: number;
}
export interface GenerationPreference {
  mode: 'auto' | 'fixed';
  modelRoute?: string;
  parameters: GenerationParameters;
}
export interface GenerationPreferences {
  kind: GenerationKind;
  image: GenerationPreference;
  video: GenerationPreference;
}
export function defaultGenerationPreferences(): GenerationPreferences {
  return { kind: 'image', image: { mode: 'auto', parameters: {} }, video: { mode: 'auto', parameters: {} } };
}
export function generationProfiles(
  profiles: readonly ProviderBridgeProfile[],
  kind: GenerationKind,
  referenceCount = 0,
): ProviderBridgeProfile[] {
  return profiles.filter((profile) => profile.capabilityStatus !== 'incomplete'
    && profile.capabilities.includes(`${kind}_generation`)
    && supportsGenerationReferences(profile, kind, referenceCount));
}

/** Reference images must go through an image-edit/native Gemini route. */
export function supportsImageReferences(profile: ProviderBridgeProfile): boolean {
  return profile.capabilities.includes('image_edit') || profile.capabilities.includes('gemini_native');
}

/** Canvas has a verified reference-image transport for Comfly video jobs.
 * RelayMe's direct video request has no reference field, so it must fail closed. */
export function supportsGenerationReferences(profile: ProviderBridgeProfile, kind: GenerationKind, referenceCount: number): boolean {
  if (referenceCount < 1) {
    return kind === 'image'
      || profile.provider === 'relayme'
      || supportsVerifiedComflyVideoInputMode(profile.modelId ?? profile.modelRoute, 0);
  }
  return kind === 'image'
    ? supportsImageReferences(profile)
    : profile.provider === 'comfly'
      && supportsVerifiedComflyVideoInputMode(profile.modelId ?? profile.modelRoute, referenceCount);
}
export function resolveGenerationPreference(
  kind: GenerationKind,
  preferences: GenerationPreferences,
  profiles: readonly ProviderBridgeProfile[],
  suggestedRoute?: string,
  referenceCount = 0,
) {
  const preference = preferences[kind];
  const candidates = generationProfiles(profiles, kind, referenceCount);
  const fixedProfile = preference.mode === 'fixed'
    ? candidates.find((item) => item.modelRoute === preference.modelRoute)
    : undefined;
  const suggestedProfile = candidates.find((item) => item.modelRoute === suggestedRoute);
  // A fixed image route may be a text-only/image-create route saved before the
  // user attached references. Keep the preference strict for ordinary jobs,
  // but safely fall back to a compatible route for this request so the action
  // can still be reviewed and the user can choose another compatible model.
  const canRecoverFixedSelection = referenceCount > 0 || preference.modelRoute === undefined;
  const profile = preference.mode === 'fixed'
    ? fixedProfile
      ?? (canRecoverFixedSelection
        ? suggestedProfile ?? candidates[0]
        : undefined)
    : suggestedProfile ?? candidates[0];
  if (!profile) {
    throw new Error(referenceCount > 0
      ? kind === 'image'
        ? '当前参考图需要支持图像编辑的生成模型，请在生成偏好中重新选择。'
        : '当前参考素材需要支持参考图输入的视频生成模型，请在生成偏好中重新选择。'
      : '生成模型不可用，请在生成偏好中重新选择。');
  }
  const usedReferenceFallback = preference.mode === 'fixed' && fixedProfile === undefined;
  const parameters = preference.mode === 'fixed' && !usedReferenceFallback ? { ...preference.parameters } : {};
  const constraints = profile.constraints?.[kind];
  for (const [key, values] of [['aspectRatio', constraints?.aspectRatios], ['resolution', constraints?.resolutions], ['outputCount', constraints?.outputCounts]] as const) {
    const value = parameters[key];
    if (value !== undefined && (!values || !(values as readonly unknown[]).includes(value))) throw new Error('固定生成参数不受当前模型支持，请重新选择。');
  }
  if (parameters.durationSeconds !== undefined) {
    const duration = profile.constraints?.video?.duration;
    const value = parameters.durationSeconds;
    if (kind !== 'video' || !duration || (duration.mode === 'options' ? !duration.options.includes(value)
      : value < duration.min || value > duration.max || Math.abs((value - duration.min) / duration.step - Math.round((value - duration.min) / duration.step)) > 0.00001)) {
      throw new Error('固定视频时长不受当前模型支持，请重新选择。');
    }
  }
  return { profile, parameters };
}
const storageKey = (projectId: string) => `agent-canvas:generation-preferences:v1:${projectId}`;
export function readGenerationPreferences(projectId: string): GenerationPreferences {
  const fallback = defaultGenerationPreferences();
  try {
    const source = JSON.parse(localStorage.getItem(storageKey(projectId)) ?? 'null');
    if (!source || !['image', 'video'].includes(source.kind)) return fallback;
    for (const kind of ['image', 'video'] as const) {
      const value = source[kind];
      if (!value || !['auto', 'fixed'].includes(value.mode)) return fallback;
      const parameters: GenerationParameters = {};
      for (const key of ['aspectRatio', 'resolution'] as const) {
        if (typeof value.parameters?.[key] === 'string' && value.parameters[key].length < 40) parameters[key] = value.parameters[key];
      }
      for (const key of ['outputCount', 'durationSeconds'] as const) {
        if (Number.isFinite(value.parameters?.[key]) && value.parameters[key] > 0 && value.parameters[key] <= 60) parameters[key] = value.parameters[key];
      }
      fallback[kind] = { mode: value.mode, parameters, ...(typeof value.modelRoute === 'string' && value.modelRoute.length < 200 ? { modelRoute: value.modelRoute } : {}) };
    }
    return { ...fallback, kind: source.kind };
  } catch { return fallback; }
}
export function writeGenerationPreferences(projectId: string, preferences: GenerationPreferences): void {
  try { localStorage.setItem(storageKey(projectId), JSON.stringify(preferences)); } catch { /* Private browsing must not block a conversation. */ }
}
