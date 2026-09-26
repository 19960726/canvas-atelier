import { z } from 'zod';

const boxSchema = z.object({
  x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1),
  width: z.number().finite().positive().max(1), height: z.number().finite().positive().max(1),
}).strict().refine(box => box.x + box.width <= 1.000001 && box.y + box.height <= 1.000001, '选区必须在原图范围内');
export const layeringSelectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('whole'), target: z.string().trim().max(500).optional() }).strict(),
  z.object({ mode: z.enum(['objects', 'region']), box: boxSchema, target: z.string().trim().max(500).optional() }).strict(),
]);
export type LayeringSelection = z.infer<typeof layeringSelectionSchema>;
export type LayeringBox = z.infer<typeof boxSchema>;

export function readLayeringSelection(value: unknown): LayeringSelection {
  return value === undefined ? { mode: 'whole' } : layeringSelectionSchema.parse(value);
}

export function selectionInstruction(selection: LayeringSelection, width: number, height: number): string {
  const target = selection.target ? `用户指定的提取内容：${JSON.stringify(selection.target)}。` : '';
  if (selection.mode === 'whole') return `分层范围：整图。分析整张图片。${target}`;
  const { x, y, width: w, height: h } = selection.box;
  return [
    selection.mode === 'objects' ? '分层范围：框选物品。只提取框内用户指定的物品，背景补全被提取物品遮住的区域。' : '分层范围：框选区域。只拆分选区内的内容。',
    `原图左上角为坐标原点，选区左上角为 (${Math.round(x * width)},${Math.round(y * height)})，右下角为 (${Math.round((x + w) * width)},${Math.round((y + h) * height)}) 像素。`,
    `选区相对原图比例为 x=${x}, y=${y}, width=${w}, height=${h}；输出分辨率变化时按相同比例定位。`,
    '每层仍使用完整原图画幅，不裁剪、不放大或居中物品。框外不拆分：背景框外保留原图，前景框外完全透明。只分析框内内容；背景补全时保留未选中的其他物品。', target,
  ].filter(Boolean).join('\n');
}

export function layerSelectionClip(selection: LayeringSelection): string | undefined {
  if (selection.mode === 'whole') return undefined;
  const { x, y, width, height } = selection.box;
  return `inset(${y * 100}% ${(1 - x - width) * 100}% ${(1 - y - height) * 100}% ${x * 100}%)`;
}

/** Keep normalized positions across provider resolution tiers (including integer size rounding). */
export function compatibleLayerDimensions(width: number, height: number, expectedWidth: number, expectedHeight: number): boolean {
  return [width, height, expectedWidth, expectedHeight].every(value => Number.isInteger(value) && value > 0 && value <= 8192)
    && Math.abs(Math.log((width / height) / (expectedWidth / expectedHeight))) <= .01;
}

/** Apply the saved scope locally, so a model cannot alter pixels outside the user's box. */
export function applyLayerSelection(rgba: Uint8Array, width: number, height: number, selection: LayeringSelection,
  background?: Uint8Array): Uint8Array {
  if (rgba.length !== width * height * 4 || (background && background.length !== rgba.length)) throw new Error('选区像素尺寸不符');
  if (selection.mode === 'whole') return rgba;
  const result = rgba.slice();
  const { x, y, width: w, height: h } = selection.box;
  const left = Math.floor(x * width), top = Math.floor(y * height);
  const right = Math.ceil((x + w) * width), bottom = Math.ceil((y + h) * height);
  for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
    if (px >= left && px < right && py >= top && py < bottom) continue;
    const i = (py * width + px) * 4;
    if (background) result.set(background.subarray(i, i + 4), i);
    else result.fill(0, i, i + 4);
  }
  return result;
}
