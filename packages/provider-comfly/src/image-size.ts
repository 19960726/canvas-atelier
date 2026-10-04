import type { ComflyImageGenerationRequest } from './types';

type ComflyImageResolutionTier = '1K' | '2K' | '4K';
type ComflyProviderImageSize = NonNullable<ComflyImageGenerationRequest['size']>;
type ComflyImageAspectRatio = NonNullable<ComflyImageGenerationRequest['aspect_ratio']>;

/** Pure request-size contract shared by the real transport and layering preflight. */
export function mapComflyImageResolutionTier(
  tier: ComflyImageResolutionTier,
  aspectRatio: ComflyImageAspectRatio = '1:1',
): ComflyProviderImageSize {
  if (tier === '4K') {
    const error = new Error('Comfly image generation does not support native 4K output') as Error & {
      code: 'CAPABILITY_UNSUPPORTED'; retryable: boolean;
    };
    error.code = 'CAPABILITY_UNSUPPORTED';
    error.retryable = false;
    throw error;
  }
  if (tier === '1K') return '1024x1024';
  return aspectRatio === '3:4' || aspectRatio === '9:16' ? '1024x1536' : '1536x1024';
}

function roundTo16(value: number): number {
  return Math.max(16, Math.round(value / 16) * 16);
}

function floorTo16(value: number): number {
  return Math.max(16, Math.floor(value / 16) * 16);
}

export function mapComflyGptImageExactSize(
  tier: ComflyImageResolutionTier,
  aspectRatio: ComflyImageAspectRatio = '1:1',
): string {
  if (aspectRatio === '1:1') return tier === '1K' ? '1024x1024' : tier === '2K' ? '2048x2048' : '2880x2880';
  if (tier === '2K') {
    const [rw, rh] = aspectRatio.split(':').map(Number) as [number, number];
    const shortEdge = roundTo16(2048 * Math.min(rw, rh) / Math.max(rw, rh));
    return rw > rh ? `2048x${shortEdge}` : `${shortEdge}x2048`;
  }
  if (tier === '4K' && aspectRatio === '16:9') return '3840x2160';
  if (tier === '4K' && aspectRatio === '9:16') return '2160x3840';

  const [rw, rh] = aspectRatio.split(':').map(Number) as [number, number];
  const targetArea = tier === '1K' ? 1_048_576 : 8_294_400;
  let width = roundTo16(Math.sqrt(targetArea * rw / rh));
  let height = roundTo16(width * rh / rw);
  while (width > 3840 || height > 3840 || width * height > 8_294_400) {
    const scale = Math.min(3840 / width, 3840 / height, Math.sqrt(8_294_400 / (width * height)));
    width = floorTo16(width * scale);
    height = floorTo16(height * scale);
  }
  return `${width}x${height}`;
}

function isGptImageExactSizeModel(model: string): boolean {
  return /^gpt-image-2(?:-(?:all|2k|4k|vip)|\.5-(?:flare|sunburst)(?:-(?:2k|4k))?)?$/u
    .test(model.trim().toLocaleLowerCase());
}

export function isComflyGptImageModel(model: string): boolean {
  return isGptImageExactSizeModel(model)
    || /^gpt-image-1(?:\.5|-mini)?(?:-\d{4}-\d{2}-\d{2})?$/u.test(model.trim().toLocaleLowerCase());
}

export function mapComflyGptImageSize(
  model: string,
  tier: ComflyImageResolutionTier,
  aspectRatio: ComflyImageAspectRatio = '1:1',
): string {
  if (!isComflyGptImageModel(model)) {
    throw Object.assign(new Error('The selected model does not have a Comfly GPT image size contract'),
      { code: 'CAPABILITY_UNSUPPORTED', retryable: false });
  }
  if (model === 'gpt-image-2-all' && tier !== '1K') {
    throw Object.assign(new Error('GPT Image 2 All supports the 1K output tier only'),
      { code: 'CAPABILITY_UNSUPPORTED', retryable: false });
  }
  if (isGptImageExactSizeModel(model)) return mapComflyGptImageExactSize(tier, aspectRatio);
  if (tier === '4K') return mapComflyImageResolutionTier(tier, aspectRatio);
  const [width, height] = aspectRatio.split(':').map(Number);
  return width === height ? '1024x1024' : width! > height! ? '1536x1024' : '1024x1536';
}
