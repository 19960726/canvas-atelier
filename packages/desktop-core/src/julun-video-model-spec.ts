import type { ImageAspectRatio, VideoResolutionTier } from '@agent-canvas/domain';
import type { ProviderBridgeProfile } from './provider-contracts.js';

type VideoConstraints = NonNullable<NonNullable<ProviderBridgeProfile['constraints']>['video']>;
export interface JulunVideoModelSpec {
  readonly modelId: string;
  readonly source: 'public-pricing-20261003';
  readonly kind: 'generation' | 'editing';
  readonly constraints: VideoConstraints;
  readonly parameterEvidenceComplete: boolean;
  readonly aliasOf?: string;
  readonly references: {
    readonly imagesMax?: number;
    readonly videosMax?: number;
    readonly audiosMax?: number;
    readonly requiredImages?: number;
    readonly requiredVideos?: number;
  };
  readonly inputVideoDurationMax?: number;
  readonly durationMaxByResolution?: Readonly<Partial<Record<VideoResolutionTier, number>>>;
  readonly dimensionGrid?: readonly {
    readonly resolution: VideoResolutionTier;
    readonly aspectRatio: ImageAspectRatio;
    readonly width: number;
    readonly height: number;
  }[];
}

// Source: the provider's GET /api/pricing snapshot captured on 2026-10-03.
// Missing ratios are deliberately absent. Channel names are never parsed as
// generic family aliases or used to invent the missing parameter contract.
const specification = (
  modelId: string, resolutions: readonly VideoResolutionTier[] | undefined,
  seconds: readonly [number, number] | undefined, references: JulunVideoModelSpec['references'] = {},
  ratios?: readonly ImageAspectRatio[],
): JulunVideoModelSpec => ({
  modelId, source: 'public-pricing-20261003', kind: 'generation', references,
  parameterEvidenceComplete: !!resolutions?.length && !!seconds && !!ratios?.length,
  constraints: {
    ...(resolutions ? { resolutions: [...resolutions] } : {}),
    ...(ratios ? { aspectRatios: [...ratios] } : {}),
    ...(seconds ? { duration: seconds[0] === seconds[1]
      ? { mode: 'options' as const, defaultValue: seconds[0], options: [seconds[0]] }
      : { mode: 'range' as const, defaultValue: Math.max(seconds[0], Math.min(10, seconds[1])), min: seconds[0], max: seconds[1], step: 1 } } : {}),
    outputCounts: [1],
  },
});
const common933Ratios: readonly ImageAspectRatio[] = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '3:2', '2:3'];
const h3 = {
  ...specification('minimax_h3', ['480p', '768p'], [5, 15], { imagesMax: 8, videosMax: 0, audiosMax: 3 }, ['16:9', '9:16']),
  dimensionGrid: [
    { resolution: '768p' as const, aspectRatio: '16:9' as const, width: 1365, height: 768 },
    { resolution: '768p' as const, aspectRatio: '9:16' as const, width: 768, height: 1365 },
    { resolution: '480p' as const, aspectRatio: '16:9' as const, width: 854, height: 480 },
    { resolution: '480p' as const, aspectRatio: '9:16' as const, width: 480, height: 854 },
  ],
};
const h3_933 = {
  ...specification('Minimax-H3-768p-933-10s-15s', ['768p'], [10, 15], { imagesMax: 9, videosMax: 3, audiosMax: 3 }, common933Ratios),
  dimensionGrid: [
    { resolution: '768p' as const, aspectRatio: '16:9' as const, width: 1365, height: 768 },
    { resolution: '768p' as const, aspectRatio: '9:16' as const, width: 768, height: 1365 },
    { resolution: '768p' as const, aspectRatio: '1:1' as const, width: 768, height: 768 },
    { resolution: '768p' as const, aspectRatio: '4:3' as const, width: 1024, height: 768 },
    { resolution: '768p' as const, aspectRatio: '3:4' as const, width: 768, height: 1024 },
    { resolution: '768p' as const, aspectRatio: '21:9' as const, width: 1792, height: 768 },
    { resolution: '768p' as const, aspectRatio: '3:2' as const, width: 1152, height: 768 },
    { resolution: '768p' as const, aspectRatio: '2:3' as const, width: 768, height: 1152 },
  ],
};
const sd25 = specification('sd2.5', ['720p'], [4, 30]);
const specs: readonly JulunVideoModelSpec[] = [
  specification('sd2.5_30', ['720p'], [4, 30], { imagesMax: 30, videosMax: 0, audiosMax: 10 },
    ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']),
  specification('SD 2.0-933', ['720p'], [4, 30], { imagesMax: 9, audiosMax: 3 }),
  sd25,
  specification('MINIMAX-H3-2.0采样-933', ['2K'], [4, 15], { imagesMax: 9, videosMax: 3, audiosMax: 3 }),
  specification('wan-3.0-c2', undefined, undefined),
  specification('seedance-2.5-pro-480', ['480p'], [4, 30], { imagesMax: 30, videosMax: 10, audiosMax: 10 }),
  specification('seedance-2.0-fast-15s', ['720p'], [15, 15]),
  specification('seedance-2.0-c2', undefined, undefined),
  specification('seedance-2.0-fast-c2', undefined, undefined),
  specification('minimax-h3 768p', ['768p'], [10, 15], { imagesMax: 6 }),
  { modelId: 'video-editing', source: 'public-pricing-20261003', kind: 'editing', parameterEvidenceComplete: false,
    constraints: { outputCounts: [1] }, references: { imagesMax: 1, videosMax: 1, requiredImages: 1, requiredVideos: 1 }, inputVideoDurationMax: 30 },
  specification('Seedance-933', ['720p'], [4, 15], { imagesMax: 9, videosMax: 0, audiosMax: 3 }),
  specification('MINIMAX-H3-768p-933', ['768p'], [4, 15], { imagesMax: 9, videosMax: 3, audiosMax: 3 }),
  specification('SD 2.0', ['720p'], [4, 15]),
  specification('seedance-2.5-720p', ['720p'], [4, 30], { imagesMax: 30, videosMax: 10, audiosMax: 10 }),
  specification('sd2.0-933-720p-fast-x5-15s', ['720p'], [5, 15], { imagesMax: 9, videosMax: 3, audiosMax: 3 }),
  specification('seedance-2.5-pro-720', ['720p'], [4, 30], { imagesMax: 30, videosMax: 10, audiosMax: 10 }),
  specification('minimax-h3 2k', ['2K'], [10, 15], { imagesMax: 6 }),
  specification('grok-imagine-video-1.5（按次）', ['480p', '720p'], [6, 15], { imagesMax: 7, videosMax: 0, audiosMax: 0 }, ['16:9', '9:16', '1:1']),
  h3,
  { ...specification('sd2-mini', ['480p', '720p'], [5, 12], { imagesMax: 9, videosMax: 0, audiosMax: 3 }),
    // The shared profile schema cannot express a resolution-dependent duration.
    // Expose the common safe interval while retaining the provider's exact maxima.
    durationMaxByResolution: { '480p': 15, '720p': 12 } },
  { ...sd25, modelId: 'SD 2.5', aliasOf: 'sd2.5' },
  specification('Q10-SD2.5 全参', ['480p'], [4, 30], { imagesMax: 30, videosMax: 10, audiosMax: 10 }, ['16:9', '9:16']),
  h3_933,
];
const byId = new Map(specs.map(spec => [spec.modelId, spec]));
export function getJulunVideoModelSpec(modelId: string): JulunVideoModelSpec | undefined {
  const spec = byId.get(modelId);
  return spec === undefined ? undefined : structuredClone(spec);
}
