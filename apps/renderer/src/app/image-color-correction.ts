import { readImageSourceBlob } from './image-source-blob';

export type ImageColorCorrectionMode = 'original' | 'auto' | 'custom';

export interface ImageColorCorrection {
  /** Version 2 distinguishes a user-selected correction from the old automatic default. */
  readonly version?: 1 | 2;
  readonly mode: ImageColorCorrectionMode;
  readonly profile?: 'nano-banana';
  readonly strength?: number;
  readonly temperature: number;
  readonly tint: number;
  readonly saturation: number;
  readonly contrast: number;
  readonly brightness: number;
}

export const AUTO_IMAGE_COLOR_CORRECTION: ImageColorCorrection = {
  version: 2,
  mode: 'auto',
  temperature: 0,
  tint: 0,
  saturation: 100,
  contrast: 100,
  brightness: 100,
};

export const ORIGINAL_IMAGE_COLOR_CORRECTION: ImageColorCorrection = {
  ...AUTO_IMAGE_COLOR_CORRECTION,
  mode: 'original',
};

export const NANO_BANANA_IMAGE_COLOR_CORRECTION: ImageColorCorrection = {
  ...AUTO_IMAGE_COLOR_CORRECTION, profile: 'nano-banana', strength: 60,
};

export const DEFAULT_IMAGE_COLOR_CORRECTION = ORIGINAL_IMAGE_COLOR_CORRECTION;

/** Asset identity, never grid position, owns a result's non-destructive adjustments. */
export function normalizeImageColorCorrections(value: unknown, legacy: unknown, resultIds: unknown): Record<string, ImageColorCorrection> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).map(([id, correction]) => [id, normalizeImageColorCorrection(correction)]));
  }
  const firstId = Array.isArray(resultIds) ? resultIds[0] : undefined;
  const correction = normalizeImageColorCorrection(legacy);
  return typeof firstId === 'string' && correction.mode !== 'original' ? { [firstId]: correction } : {};
}

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
  const mode: ImageColorCorrectionMode = input.mode === 'custom' ? 'custom'
    : input.mode === 'auto' && input.version === 2 ? 'auto' : 'original';
  const defaults = AUTO_IMAGE_COLOR_CORRECTION;
  return {
    version: 2,
    mode,
    ...(input.profile === 'nano-banana' ? { profile: 'nano-banana' as const, strength: boundedNumber(input.strength, 60, 0, 100) } : {}),
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
export function analyzeImageColorCorrection(pixels: Uint8ClampedArray, profile?: 'nano-banana'): ImageColorCorrection {
  const redRatios: number[] = [];
  const blueRatios: number[] = [];
  const highlights: Array<readonly [number, number]> = [];
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
    // Bright, low-chroma surfaces can also reveal yellow, blue or green casts.
    // Do not use darker skin/wood as a substitute for a neutral highlight.
    if (minimum >= 160 && (red * 0.2126 + green * 0.7152 + blue * 0.0722) >= 205) {
      highlights.push([redRatio, blueRatio]);
    }
    // A blue deficit is usually warm material/light rather than magenta.
    if (redRatio > 1.035 && blueRatio >= 0.98) castPixels += 1;
  }
  let count = redRatios.length;
  let highlightOnly = false;
  if (profile === 'nano-banana') {
    // Opt-in red/magenta/yellow correction. Require agreement across low-chroma
    // surfaces, not just the brightest warm wall. Mixed light and existing
    // neutrals are evidence against a global cast. This is not a gray card.
    if (count < 16 || count < opaquePixels * 0.25 || neutralAnchors > count * 0.2) return AUTO_IMAGE_COLOR_CORRECTION;
    const medianRed = [...redRatios].sort((a, b) => a - b)[Math.floor(count / 2)]!;
    const medianBlue = [...blueRatios].sort((a, b) => a - b)[Math.floor(count / 2)]!;
    const consistent = redRatios.filter((red, i) => Math.abs(red - medianRed) < 0.035 && Math.abs(blueRatios[i]! - medianBlue) < 0.035).length;
    const redOrMagentaCast = medianRed >= 1.035;
    const yellowCast = medianRed >= 0.99 && medianBlue <= 0.965;
    if (consistent < count * 0.8 || (!redOrMagentaCast && !yellowCast)) return AUTO_IMAGE_COLOR_CORRECTION;
  } else if (count < 16 || count < opaquePixels * 0.12 || neutralAnchors > count * 0.2 || castPixels < count * 0.7) {
    highlightOnly = true;
    count = highlights.length;
    if (count < 16 || count < opaquePixels * 0.08 || neutralAnchors > count * 0.2) return AUTO_IMAGE_COLOR_CORRECTION;
    const medianRed = highlights.map(([red]) => red).sort((a, b) => a - b)[Math.floor(count / 2)]!;
    const medianBlue = highlights.map(([, blue]) => blue).sort((a, b) => a - b)[Math.floor(count / 2)]!;
    const consistent = highlights.filter(([red, blue]) => Math.abs(red - medianRed) < 0.04 && Math.abs(blue - medianBlue) < 0.04);
    if (consistent.length < count * 0.7 || Math.max(Math.abs(medianRed - 1), Math.abs(medianBlue - 1)) < 0.035) return AUTO_IMAGE_COLOR_CORRECTION;
    redRatios.splice(0, redRatios.length, ...consistent.map(([red]) => red));
    blueRatios.splice(0, blueRatios.length, ...consistent.map(([, blue]) => blue));
    count = consistent.length;
  }
  redRatios.sort((a, b) => a - b);
  blueRatios.sort((a, b) => a - b);
  const greenOverRed = 1 / redRatios[Math.floor(count / 2)]!;
  const greenOverBlue = 1 / blueRatios[Math.floor(count / 2)]!;
  // Solve r * redGain = g * greenGain = b * blueGain for the existing transform.
  const tint = (greenOverRed + greenOverBlue - 2) / (0.004 * (1 + greenOverRed + greenOverBlue));
  const temperature = (greenOverRed - 1 - (0.002 + 0.004 * greenOverRed) * tint) / 0.004;
  // Pale walls/materials under warm or cool lighting are not a known gray card.
  // A highlight-only estimate must preserve the scene's lighting: remove at
  // most 20% of its cast and bound channel changes to ~2% including rounding.
  const largestGainChange = Math.max(Math.abs(temperature * 0.004 + tint * 0.002), Math.abs(tint * 0.004), Math.abs(-temperature * 0.004 + tint * 0.002));
  const strength = profile === 'nano-banana'
    ? Math.min(0.6, 0.04 / Math.max(largestGainChange, 0.04))
    : highlightOnly ? Math.min(0.2, 0.016 / Math.max(largestGainChange, 0.016)) : 0.8;
  return normalizeImageColorCorrection({ ...AUTO_IMAGE_COLOR_CORRECTION, temperature: temperature * strength, tint: tint * strength });
}

export type ImageColorAnalysis = { correction: ImageColorCorrection; status: 'applied' | 'unchanged' | 'unavailable' };
const analysisCache = new Map<string, Promise<ImageColorAnalysis>>();
const MAX_ANALYSIS_CACHE_ENTRIES = 128;
const ANALYSIS_EDGE = 96;

function sampleImageColorCorrection(sourceUrl: string, profile?: 'nano-banana'): Promise<ImageColorAnalysis> {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    const unavailable: ImageColorAnalysis = { correction: AUTO_IMAGE_COLOR_CORRECTION, status: 'unavailable' };
    const timeout = setTimeout(() => finish(unavailable), 8_000);
    const finish = (value: ImageColorAnalysis) => {
      clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
      resolve(value);
    };
    image.onerror = () => finish(unavailable);
    image.onload = () => {
      try {
        const scale = Math.min(1, ANALYSIS_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (context === null) return finish(unavailable);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const correction = analyzeImageColorCorrection(context.getImageData(0, 0, canvas.width, canvas.height).data, profile);
        finish({ correction, status: hasImageColorCorrection(correction) ? 'applied' : 'unchanged' });
      } catch {
        finish(unavailable);
      }
    };
    image.src = sourceUrl;
  });
}

/** Only the small derived parameters are cached, never a full-size bitmap. */
export function resolveImageColorCorrection(sourceUrl: string, value: ImageColorCorrection): Promise<ImageColorCorrection> {
  const correction = normalizeImageColorCorrection(value);
  if (correction.mode !== 'auto') return Promise.resolve(correction);
  return resolveImageColorAnalysis(sourceUrl, correction).then((result) => result.correction);
}

export function resolveImageColorAnalysis(sourceUrl: string, value: ImageColorCorrection = AUTO_IMAGE_COLOR_CORRECTION): Promise<ImageColorAnalysis> {
  const request = normalizeImageColorCorrection(value);
  return resolveBaseImageColorAnalysis(sourceUrl, request.profile).then((result) => {
    if (request.profile !== 'nano-banana') return result;
    const strength = (request.strength ?? 60) / 100;
    const correction = normalizeImageColorCorrection({ ...result.correction, profile: request.profile, strength: request.strength,
      temperature: result.correction.temperature * strength, tint: result.correction.tint * strength });
    return { correction, status: result.status === 'unavailable' ? 'unavailable' : hasImageColorCorrection(correction) ? 'applied' : 'unchanged' };
  });
}

function resolveBaseImageColorAnalysis(sourceUrl: string, profile?: 'nano-banana'): Promise<ImageColorAnalysis> {
  const key = JSON.stringify([sourceUrl, profile ?? 'generic']);
  const cached = analysisCache.get(key);
  if (cached !== undefined) {
    analysisCache.delete(key);
    analysisCache.set(key, cached);
    return cached;
  }
  const analysis = sampleImageColorCorrection(sourceUrl, profile)
    .catch((): ImageColorAnalysis => ({ correction: AUTO_IMAGE_COLOR_CORRECTION, status: 'unavailable' }))
    .then((result) => {
      if (result.status === 'unavailable' && analysisCache.get(key) === analysis) analysisCache.delete(key);
      return result;
    });
  analysisCache.set(key, analysis);
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
  if (correction.mode === 'auto') return correction.profile === 'nano-banana' ? 'Nano Banana 去偏色' : '自动中和';
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
  const source = await readImageSourceBlob(sourceUrl);
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
