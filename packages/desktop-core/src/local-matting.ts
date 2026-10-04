import { z } from 'zod';

const boxSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  width: z.number().positive().max(1), height: z.number().positive().max(1) })
  .refine(box => box.x + box.width <= 1.000001 && box.y + box.height <= 1.000001);
const regionSchema = z.object({ mode: z.enum(['keep', 'clear', 'glass']), box: boxSchema });
export type MattingRegion = z.infer<typeof regionSchema>;
export interface LocalMattingRequest {
  width: number; height: number; rgba: Uint8Array;
  bounds: z.infer<typeof boxSchema>; regions: MattingRegion[];
}
export interface LocalMattingResult { width: number; height: number; rgba: Uint8Array; }

/** Preserve integer source edges after normalization without rounding genuinely
 * fractional selections inward. Division and multiplication can differ by a
 * few floating-point ULPs even for an exact source-pixel rectangle. */
export function sourceMattingBoxPixels(width: number, height: number, candidate: LocalMattingRequest['bounds']) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 12_000_000)
    throw new Error('精修标记尺寸无效');
  const box = boxSchema.parse(candidate);
  const snap = (value: number) => {
    const nearest = Math.round(value);
    return Math.abs(value - nearest) <= Number.EPSILON * Math.max(1, Math.abs(value)) * 8 ? nearest : value;
  };
  return {
    left: Math.floor(snap(box.x * width)), top: Math.floor(snap(box.y * height)),
    right: Math.min(width, Math.ceil(snap((box.x + box.width) * width))),
    bottom: Math.min(height, Math.ceil(snap((box.y + box.height) * height))),
  };
}

export function parseLocalMattingRequest(value: unknown): LocalMattingRequest {
  const result = z.object({ width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192),
    rgba: z.instanceof(Uint8Array), bounds: boxSchema, regions: z.array(regionSchema).max(64) }).parse(value);
  if (result.width * result.height > 12_000_000 || result.rgba.length !== result.width * result.height * 4)
    throw new Error('本地精修的原图像素尺寸无效或超过 1200 万像素');
  return result;
}

/** Feed deliberate user corrections into the local segmentation model itself.
 * The same regions still constrain the trimap after segmentation. */
export function createLocalMattingPrompts(width: number, height: number, bounds: LocalMattingRequest['bounds'],
  regions: readonly MattingRegion[]): { points: number[][]; labels: number[] } {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('精修提示点尺寸无效');
  const validBounds = boxSchema.parse(bounds);
  const validRegions = regions.map(region => regionSchema.parse(region));
  const center = (box: LocalMattingRequest['bounds']): number[] => [
    Math.min(width - 1, Math.round((box.x + box.width / 2) * width)),
    Math.min(height - 1, Math.round((box.y + box.height / 2) * height)),
  ];
  const positives = validRegions.filter(region => region.mode !== 'clear').map(region => center(region.box));
  const negatives = validRegions.filter(region => region.mode === 'clear').map(region => center(region.box));
  const foreground = positives.length ? positives : [center(validBounds)];
  return { points: [...foreground, ...negatives], labels: [...foreground.map(() => 1), ...negatives.map(() => 0)] };
}

/** Build a trimap at source coordinates; regions are ordered user corrections. */
export function createSourceTrimap(mask: Uint8Array, width: number, height: number, radius: number, regions: readonly MattingRegion[]): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 12_000_000
    || mask.length !== width * height || !Number.isInteger(radius) || radius < 1 || radius > 128) throw new Error('精修蒙版尺寸无效');
  const integral = new Uint32Array((width + 1) * (height + 1)), stride = width + 1;
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = 0; x < width; x++) {
      sum += mask[y * width + x]! > 127 ? 1 : 0;
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1]! + sum;
    }
  }
  const result = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const x0 = Math.max(0, x - radius), x1 = Math.min(width, x + radius + 1);
    const y0 = Math.max(0, y - radius), y1 = Math.min(height, y + radius + 1);
    const sum = integral[y1 * stride + x1]! - integral[y0 * stride + x1]! - integral[y1 * stride + x0]! + integral[y0 * stride + x0]!;
    result[y * width + x] = sum === 0 ? 0 : sum === (x1 - x0) * (y1 - y0) ? 255 : 128;
  }
  for (const candidate of regions) {
    const { mode, box } = regionSchema.parse(candidate), value = mode === 'keep' ? 255 : mode === 'clear' ? 0 : 128;
    const pixels = sourceMattingBoxPixels(width, height, box);
    for (let y = pixels.top; y < pixels.bottom; y++)
      for (let x = pixels.left; x < pixels.right; x++) result[y * width + x] = value;
  }
  return result;
}
