export type ImageColorCorrectionMode = 'original' | 'auto' | 'custom';

export interface ImageColorCorrection {
  readonly mode: ImageColorCorrectionMode;
  readonly temperature: number;
  readonly tint: number;
  readonly saturation: number;
  readonly contrast: number;
  readonly brightness: number;
}

export const DEFAULT_IMAGE_COLOR_CORRECTION: ImageColorCorrection = {
  mode: 'original',
  temperature: 0,
  tint: 0,
  saturation: 100,
  contrast: 100,
  brightness: 100,
};

export const AUTO_IMAGE_COLOR_CORRECTION: ImageColorCorrection = {
  mode: 'auto',
  // Keep the default subtle: cool the image and bias it away from magenta.
  temperature: -6,
  tint: -10,
  saturation: 96,
  contrast: 102,
  brightness: 100,
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
  const mode: ImageColorCorrectionMode = input.mode === 'auto' || input.mode === 'custom' ? input.mode : 'original';
  const defaults = mode === 'auto' ? AUTO_IMAGE_COLOR_CORRECTION : DEFAULT_IMAGE_COLOR_CORRECTION;
  return {
    mode,
    temperature: boundedNumber(input.temperature, defaults.temperature, -30, 30),
    tint: boundedNumber(input.tint, defaults.tint, -30, 30),
    saturation: boundedNumber(input.saturation, defaults.saturation, 70, 130),
    contrast: boundedNumber(input.contrast, defaults.contrast, 85, 120),
    brightness: boundedNumber(input.brightness, defaults.brightness, 85, 120),
  };
}

export function imageColorCorrectionMatrix(value: ImageColorCorrection): string {
  const correction = normalizeImageColorCorrection(value);
  const [red, green, blue] = imageColorCorrectionChannelGains(correction);
  return `${red.toFixed(3)} 0 0 0 0 0 ${green.toFixed(3)} 0 0 0 0 0 ${blue.toFixed(3)} 0 0 0 0 1 0`;
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
  if (correction.mode === 'original') return 'none';
  return [
    ...(svgFilterId === undefined ? [] : [`url("#${svgFilterId}")`]),
    `saturate(${(correction.saturation / 100).toFixed(2)})`,
    `contrast(${(correction.contrast / 100).toFixed(2)})`,
    `brightness(${(correction.brightness / 100).toFixed(2)})`,
  ].join(' ');
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
  const correction = normalizeImageColorCorrection(value);
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error('Generated image could not be loaded for color correction');
  const source = await response.blob();
  if (correction.mode === 'original') return source;
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
