export type ImageColorCorrectionMode = 'original' | 'auto' | 'custom';

export interface ImageColorCorrection {
  /** Distinguishes an explicit original choice from the old untouched default. */
  readonly version?: 1;
  readonly mode: ImageColorCorrectionMode;
  readonly temperature: number;
  readonly tint: number;
  readonly saturation: number;
  readonly contrast: number;
  readonly brightness: number;
}

export const AUTO_IMAGE_COLOR_CORRECTION: ImageColorCorrection = {
  version: 1,
  mode: 'auto',
  temperature: 0,
  tint: 0,
  saturation: 100,
  contrast: 100,
  brightness: 100,
};

export const DEFAULT_IMAGE_COLOR_CORRECTION = AUTO_IMAGE_COLOR_CORRECTION;

export const ORIGINAL_IMAGE_COLOR_CORRECTION: ImageColorCorrection = {
  ...AUTO_IMAGE_COLOR_CORRECTION,
  mode: 'original',
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? clamp(Math.round(value), minimum, maximum)
    : fallback;
}

export function normalizeImageColorCorrection(value: unknown): ImageColorCorrection {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_IMAGE_COLOR_CORRECTION;
  const input = value as Record<string, unknown>;
  const untouchedLegacyOriginal = input.mode === 'original' && input.version !== 1
    && (input.temperature === undefined || input.temperature === 0)
    && (input.tint === undefined || input.tint === 0)
    && (input.saturation === undefined || input.saturation === 100)
    && (input.contrast === undefined || input.contrast === 100)
    && (input.brightness === undefined || input.brightness === 100);
  const mode: ImageColorCorrectionMode = input.mode === 'custom' ? 'custom'
    : input.mode === 'original' && !untouchedLegacyOriginal ? 'original' : 'auto';
  const defaults = AUTO_IMAGE_COLOR_CORRECTION;
  return {
    version: 1,
    mode,
    temperature: boundedNumber(input.temperature, defaults.temperature, -30, 30),
    tint: boundedNumber(input.tint, defaults.tint, -30, 30),
    saturation: boundedNumber(input.saturation, defaults.saturation, 70, 130),
    contrast: boundedNumber(input.contrast, defaults.contrast, 85, 120),
    brightness: boundedNumber(input.brightness, defaults.brightness, 85, 120),
  };
}

/** Estimate a widespread cast from likely neutral, unclipped opaque pixels.
 * Saturated subjects, warm skin/wood and existing neutral anchors must not
 * become white-balance references. Ambiguous images remain unchanged.
 */
export function analyzeImageColorCorrection(pixels: Uint8ClampedArray): ImageColorCorrection {
  const redRatios: number[] = [];
  const blueRatios: number[] = [];
  let opaquePixels = 0;
  let neutralAnchors = 0;
  let castPixels = 0;
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    if (pixels[index + 3]! < 230) continue;
    opaquePixels += 1;
    const red = pixels[index]!;
    const green = pixels[index + 1]!;
    const blue = pixels[index + 2]!;
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    // Clipped white cannot estimate channel gains, but it is still evidence
    // against treating a pale colored product as a global color cast.
    if (minimum >= 64 && (maximum - minimum) / maximum < 0.025) neutralAnchors += 1;
    if (minimum < 64 || maximum > 248 || (maximum - minimum) / maximum > 0.22) continue;
    const redRatio = red / green;
    const blueRatio = blue / green;
    redRatios.push(redRatio);
    blueRatios.push(blueRatio);
    // A blue deficit is usually warm material/light rather than magenta.
    if (redRatio > 1.035 && blueRatio >= 0.98) castPixels += 1;
  }
  const count = redRatios.length;
  if (count < 16 || count < opaquePixels * 0.12 || neutralAnchors > count * 0.2 || castPixels < count * 0.7) {
    return AUTO_IMAGE_COLOR_CORRECTION;
  }
  redRatios.sort((a, b) => a - b);
  blueRatios.sort((a, b) => a - b);
  const greenOverRed = 1 / redRatios[Math.floor(count / 2)]!;
  const greenOverBlue = 1 / blueRatios[Math.floor(count / 2)]!;
  // Solve r * redGain = g * greenGain = b * blueGain for the existing
  // temperature/tint transform; retain 20% of the cast to avoid overcorrection.
  const tint = (greenOverRed + greenOverBlue - 2) / (0.004 * (1 + greenOverRed + greenOverBlue));
  const temperature = (greenOverRed - 1 - (0.002 + 0.004 * greenOverRed) * tint) / 0.004;
  return normalizeImageColorCorrection({ ...AUTO_IMAGE_COLOR_CORRECTION, temperature: temperature * 0.8, tint: tint * 0.8 });
}

const analysisCache = new Map<string, Promise<ImageColorCorrection>>();
const MAX_ANALYSIS_CACHE_ENTRIES = 128;
const ANALYSIS_EDGE = 96;

function sampleImageColorCorrection(sourceUrl: string): Promise<ImageColorCorrection> {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    const finish = (value: ImageColorCorrection) => {
      image.onload = null;
      image.onerror = null;
      resolve(value);
    };
    image.onerror = () => finish(AUTO_IMAGE_COLOR_CORRECTION);
    image.onload = () => {
      try {
        const scale = Math.min(1, ANALYSIS_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (context === null) return finish(AUTO_IMAGE_COLOR_CORRECTION);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        finish(analyzeImageColorCorrection(context.getImageData(0, 0, canvas.width, canvas.height).data));
      } catch {
        finish(AUTO_IMAGE_COLOR_CORRECTION);
      }
    };
    image.src = sourceUrl;
  });
}

/** Only the small derived parameters are cached, never a full-size bitmap. */
export function resolveImageColorCorrection(sourceUrl: string, value: ImageColorCorrection): Promise<ImageColorCorrection> {
  const correction = normalizeImageColorCorrection(value);
  if (correction.mode !== 'auto') return Promise.resolve(correction);
  const cached = analysisCache.get(sourceUrl);
  if (cached !== undefined) {
    analysisCache.delete(sourceUrl);
    analysisCache.set(sourceUrl, cached);
    return cached;
  }
  const analysis = sampleImageColorCorrection(sourceUrl).catch(() => AUTO_IMAGE_COLOR_CORRECTION);
  analysisCache.set(sourceUrl, analysis);
  if (analysisCache.size > MAX_ANALYSIS_CACHE_ENTRIES) analysisCache.delete(analysisCache.keys().next().value!);
  return analysis;
}

export function imageColorCorrectionMatrix(value: ImageColorCorrection): string {
  const correction = normalizeImageColorCorrection(value);
  const [red, green, blue] = imageColorCorrectionChannelGains(correction);
  return `${red.toFixed(3)} 0 0 0 0 0 ${green.toFixed(3)} 0 0 0 0 0 ${blue.toFixed(3)} 0 0 0 0 0 1 0`;
}

function imageColorCorrectionChannelGains(correction: ImageColorCorrection): readonly [number, number, number] {
  const temperature = correction.temperature * 0.004;
  const tint = correction.tint * 0.002;
  const red = clamp(1 + temperature + tint, 0.82, 1.18);
  const green = clamp(1 - (correction.tint * 0.004), 0.82, 1.18);
  const blue = clamp(1 - temperature + tint, 0.82, 1.18);
  return [red, green, blue];
}

export function imageColorCorrectionFilter(value: ImageColorCorrection, svgFilterId?: string): string {
  const correction = normalizeImageColorCorrection(value);
  if (!hasImageColorCorrection(correction)) return 'none';
  return [
    ...(svgFilterId === undefined ? [] : [`url("#${svgFilterId}")`]),
    `saturate(${(correction.saturation / 100).toFixed(2)})`,
    `contrast(${(correction.contrast / 100).toFixed(2)})`,
    `brightness(${(correction.brightness / 100).toFixed(2)})`,
  ].join(' ');
}

function hasImageColorCorrection(correction: ImageColorCorrection): boolean {
  return correction.mode !== 'original' && (correction.temperature !== 0 || correction.tint !== 0
    || correction.saturation !== 100 || correction.contrast !== 100 || correction.brightness !== 100);
}

export function imageColorCorrectionLabel(value: ImageColorCorrection): string {
  const correction = normalizeImageColorCorrection(value);
  if (correction.mode === 'auto') return '自动中和';
  if (correction.mode === 'custom') return '自定义';
  return '原图';
}

export function applyImageColorCorrectionToPixels(
  pixels: Uint8ClampedArray,
  value: ImageColorCorrection,
): Uint8ClampedArray {
  const correction = normalizeImageColorCorrection(value);
  if (correction.mode === 'original') return new Uint8ClampedArray(pixels);
  const [redGain, greenGain, blueGain] = imageColorCorrectionChannelGains(correction);
  const saturation = correction.saturation / 100;
  const contrast = correction.contrast / 100;
  const brightness = correction.brightness / 100;
  const output = new Uint8ClampedArray(pixels);
  for (let index = 0; index < output.length; index += 4) {
    let red = (output[index] ?? 0) * redGain;
    let green = (output[index + 1] ?? 0) * greenGain;
    let blue = (output[index + 2] ?? 0) * blueGain;
    const luminance = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
    red = luminance + ((red - luminance) * saturation);
    green = luminance + ((green - luminance) * saturation);
    blue = luminance + ((blue - luminance) * saturation);
    output[index] = clamp(((red - 128) * contrast + 128) * brightness, 0, 255);
    output[index + 1] = clamp(((green - 128) * contrast + 128) * brightness, 0, 255);
    output[index + 2] = clamp(((blue - 128) * contrast + 128) * brightness, 0, 255);
  }
  return output;
}

export async function renderImageColorCorrectionBlob(
  sourceUrl: string,
  value: ImageColorCorrection,
): Promise<Blob> {
  const correction = await resolveImageColorCorrection(sourceUrl, value);
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error('Generated image could not be loaded for color correction');
  const source = await response.blob();
  if (correction.mode === 'original' || (!hasImageColorCorrection(correction) && source.type === 'image/png')) return source;
  const bitmap = await createImageBitmap(source);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) throw new Error('Image color correction canvas is unavailable');
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    image.data.set(applyImageColorCorrectionToPixels(image.data, correction));
    context.putImageData(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => {
      if (blob === null) reject(new Error('Corrected image could not be encoded'));
      else resolve(blob);
    }, 'image/png'));
  } finally {
    bitmap.close();
  }
}
