const WAN_TEXT_TO_VIDEO_MODELS = new Set([
  'wan2.2-t2v-plus',
  'wanx2.1-t2v-turbo',
  'wanx2.1-t2v-plus',
]);
const WAN_IMAGE_TO_VIDEO_MODELS = new Set([
  'wan2.2-i2v-plus',
  'wan2.2-i2v-flash',
  'wanx2.1-i2v-turbo',
  'wanx2.1-i2v-plus',
]);
const WAN_KEYFRAME_VIDEO_MODELS = new Set(['wanx2.1-kf2v-plus']);

const SEEDANCE_VIDEO_MODELS = new Set([
  'doubao-seedance-2.5',
  'doubao-seedance-2-0-260128',
  'doubao-seedance-2-0-fast-260128',
  'doubao-seedance-2.0-mini',
  'doubao-seedance-1-0-pro-250528',
  'doubao-seedance-1-0-lite-t2v-250428',
  'doubao-seedance-1-0-lite-i2v-250428',
]);
const SEEDANCE_KEYFRAME_VIDEO_MODELS = new Set([
  'doubao-seedance-2.5',
  'doubao-seedance-2-0-260128',
  'doubao-seedance-2-0-fast-260128',
  'doubao-seedance-2.0-mini',
  'doubao-seedance-1-0-lite-i2v-250428',
]);

const VEO_TEXT_TO_VIDEO_MODELS = new Set([
  'veo3',
  'veo3-fast',
  'veo3-pro',
  'veo3-pro-frames',
  'veo2',
  'veo2-fast',
  'veo2-fast-frames',
  'veo2-fast-components',
  'veo2-pro',
  'veo3-fast-frames',
  'veo3.1',
  'veo3.1-pro',
]);
const VEO_IMAGE_TO_VIDEO_MODELS = new Set([
  'veo3-pro-frames',
  'veo3-fast-frames',
  'veo2-fast-frames',
  'veo2-fast-components',
  'veo3.1',
  'veo3.1-pro',
  'veo3.1-components',
]);
const VEO_DOCUMENTED_IMAGE_LIMITS = new Map<string, number>([
  ['veo3-pro-frames', 1],
  ['veo2-fast-frames', 2],
  ['veo2-fast-components', 3],
]);

export function hasVerifiedComflyVideoSubmissionContract(model: string): boolean {
  const normalizedModel = model.trim().toLocaleLowerCase();
  return WAN_TEXT_TO_VIDEO_MODELS.has(normalizedModel)
    || WAN_IMAGE_TO_VIDEO_MODELS.has(normalizedModel)
    || WAN_KEYFRAME_VIDEO_MODELS.has(normalizedModel)
    || SEEDANCE_VIDEO_MODELS.has(normalizedModel)
    || VEO_TEXT_TO_VIDEO_MODELS.has(normalizedModel)
    || VEO_IMAGE_TO_VIDEO_MODELS.has(normalizedModel);
}

/** Shared by provider submission and renderer selection so an incompatible
 * reference count is rejected before a paid job can be created. */
export function supportsVerifiedComflyVideoInputMode(model: string, referenceCount: number): boolean {
  if (!Number.isInteger(referenceCount) || referenceCount < 0) return false;
  const normalizedModel = model.trim().toLocaleLowerCase();
  if (normalizedModel.startsWith('wan')) {
    return (WAN_TEXT_TO_VIDEO_MODELS.has(normalizedModel) && referenceCount === 0)
      || (WAN_IMAGE_TO_VIDEO_MODELS.has(normalizedModel) && referenceCount === 1)
      || (WAN_KEYFRAME_VIDEO_MODELS.has(normalizedModel) && referenceCount === 2);
  }
  if (normalizedModel.includes('seedance')) {
    if (!SEEDANCE_VIDEO_MODELS.has(normalizedModel)) return false;
    return referenceCount === 0
      || referenceCount === 1
      || (referenceCount === 2 && SEEDANCE_KEYFRAME_VIDEO_MODELS.has(normalizedModel));
  }
  if (normalizedModel.startsWith('veo')) {
    if (referenceCount === 0) return VEO_TEXT_TO_VIDEO_MODELS.has(normalizedModel);
    if (!VEO_IMAGE_TO_VIDEO_MODELS.has(normalizedModel)) return false;
    return referenceCount <= (VEO_DOCUMENTED_IMAGE_LIMITS.get(normalizedModel) ?? 1);
  }
  return false;
}
