import type { ImageAspectRatio, ImageResolutionTier, VideoResolutionTier } from './model-job';

export type DurationConstraint =
  | { readonly mode: 'options'; readonly options: readonly number[]; readonly defaultValue?: number }
  | { readonly mode: 'range'; readonly min: number; readonly max: number; readonly step: number; readonly defaultValue?: number };

export interface GenerationParameterConstraints {
  readonly image?: {
    readonly aspectRatios?: readonly ImageAspectRatio[];
    readonly resolutions?: readonly ImageResolutionTier[];
    readonly outputCounts?: readonly (1 | 2 | 3 | 4)[];
  };
  readonly video?: {
    readonly aspectRatios?: readonly ImageAspectRatio[];
    readonly resolutions?: readonly VideoResolutionTier[];
    readonly duration?: DurationConstraint;
    readonly outputCounts?: readonly (1 | 2 | 3 | 4)[];
  };
}

export type GenerationParameterTarget =
  | { readonly kind: 'image'; readonly aspectRatio: ImageAspectRatio; readonly resolution: ImageResolutionTier; readonly outputCount: 1 | 2 | 3 | 4 }
  | { readonly kind: 'video'; readonly aspectRatio: ImageAspectRatio; readonly resolution: VideoResolutionTier; readonly durationSeconds: number; readonly outputCount: 1 | 2 | 3 | 4 };

export type AdaptedGenerationParameters =
  | { readonly status: 'exact' | 'requires_confirmation'; readonly actual: GenerationParameterTarget; readonly adjustments: readonly string[] }
  | { readonly status: 'unsupported'; readonly actual: null; readonly adjustments: readonly string[] };

export function adaptGenerationParameters(
  target: GenerationParameterTarget,
  constraints: GenerationParameterConstraints,
): AdaptedGenerationParameters {
  if (target.kind === 'image') {
    if (constraints.image === undefined) {
      return unsupported('模型参数能力未完整返回，无法安全提交图片生成。');
    }
    const actual: GenerationParameterTarget = {
      kind: 'image',
      aspectRatio: nearestAspectRatio(target.aspectRatio, constraints.image.aspectRatios),
      resolution: nearestImageResolution(target.resolution, constraints.image.resolutions),
      outputCount: nearestOutputCount(target.outputCount, constraints.image.outputCounts),
    };
    return result(target, actual);
  }
  if (constraints.video === undefined || constraints.video.duration === undefined) {
    return unsupported('模型参数能力未完整返回，无法安全提交视频生成。');
  }
  const actual: GenerationParameterTarget = {
    kind: 'video',
    aspectRatio: nearestAspectRatio(target.aspectRatio, constraints.video.aspectRatios),
    resolution: nearestVideoResolution(target.resolution, constraints.video.resolutions),
    durationSeconds: nearestDuration(target.durationSeconds, constraints.video.duration),
    outputCount: nearestOutputCount(target.outputCount, constraints.video.outputCounts),
  };
  return result(target, actual);
}

function result(target: GenerationParameterTarget, actual: GenerationParameterTarget): AdaptedGenerationParameters {
  const adjustments: string[] = [];
  if (target.aspectRatio !== actual.aspectRatio) adjustments.push(`比例将从 ${target.aspectRatio} 适配为 ${actual.aspectRatio}。`);
  if (target.kind === 'image' && actual.kind === 'image' && target.resolution !== actual.resolution) {
    adjustments.push(`清晰度将从 ${target.resolution} 适配为 ${actual.resolution}。`);
  }
  if (target.kind === 'video' && actual.kind === 'video') {
    if (target.resolution !== actual.resolution) adjustments.push(`视频清晰度将从 ${target.resolution} 适配为 ${actual.resolution}。`);
    if (target.durationSeconds !== actual.durationSeconds) adjustments.push(`视频时长将从 ${target.durationSeconds} 秒适配为 ${actual.durationSeconds} 秒。`);
  }
  if (target.outputCount !== actual.outputCount) adjustments.push(`生成数量将从 ${target.outputCount} 适配为 ${actual.outputCount}。`);
  return { status: adjustments.length === 0 ? 'exact' : 'requires_confirmation', actual, adjustments };
}

function unsupported(message: string): AdaptedGenerationParameters {
  return { status: 'unsupported', actual: null, adjustments: [message] };
}

function nearestAspectRatio(target: ImageAspectRatio, supported: readonly ImageAspectRatio[] | undefined): ImageAspectRatio {
  if (supported === undefined || supported.length === 0 || supported.includes(target)) return target;
  const targetValue = ratioValue(target);
  return [...supported].sort((left, right) => {
    const distance = Math.abs(Math.log(ratioValue(left) / targetValue)) - Math.abs(Math.log(ratioValue(right) / targetValue));
    return distance === 0 ? left.localeCompare(right) : distance;
  })[0]!;
}

function ratioValue(value: ImageAspectRatio): number {
  const [width, height] = value.split(':').map(Number) as [number, number];
  return width / height;
}

function nearestImageResolution(target: ImageResolutionTier, supported: readonly ImageResolutionTier[] | undefined): ImageResolutionTier {
  if (supported === undefined || supported.length === 0 || supported.includes(target)) return target;
  const rank: Record<ImageResolutionTier, number> = { '1K': 1, '2K': 2, '4K': 4 };
  return nearestRanked(target, supported, rank);
}

function nearestVideoResolution(target: VideoResolutionTier, supported: readonly VideoResolutionTier[] | undefined): VideoResolutionTier {
  if (supported === undefined || supported.length === 0 || supported.includes(target)) return target;
  const rank: Record<VideoResolutionTier, number> = { '360p': 360, '480p': 480, '512p': 512, '540p': 540, '720p': 720, '768p': 768, '1080p': 1080, '2K': 1440, '4K': 2160 };
  return nearestRanked(target, supported, rank);
}

function nearestRanked<T extends string>(target: T, supported: readonly T[], rank: Record<T, number>): T {
  return [...supported].sort((left, right) => (
    Math.abs(rank[left] - rank[target]) - Math.abs(rank[right] - rank[target]) || rank[right] - rank[left]
  ))[0]!;
}

function nearestOutputCount(target: 1 | 2 | 3 | 4, supported: readonly (1 | 2 | 3 | 4)[] | undefined): 1 | 2 | 3 | 4 {
  if (supported === undefined || supported.length === 0 || supported.includes(target)) return target;
  return [...supported].sort((left, right) => Math.abs(left - target) - Math.abs(right - target) || left - right)[0]!;
}

function nearestDuration(target: number, constraint: DurationConstraint): number {
  if (constraint.mode === 'options') {
    return [...constraint.options].sort((left, right) => Math.abs(left - target) - Math.abs(right - target) || left - right)[0] ?? constraint.defaultValue ?? target;
  }
  const clamped = Math.min(constraint.max, Math.max(constraint.min, target));
  const stepped = constraint.min + Math.round((clamped - constraint.min) / constraint.step) * constraint.step;
  return Math.min(constraint.max, Math.max(constraint.min, stepped));
}