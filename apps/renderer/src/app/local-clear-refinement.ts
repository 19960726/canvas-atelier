import { z } from 'zod';
import { sourceMattingBoxPixels, type MattingRegion } from '@agent-canvas/desktop-core/preload-api';
import { boxSchema } from './layering-selection';
import { getLayerPixelRepresentation, type LayerPixelAsset } from './layer-pixel-representation';
import { readImageSourceBlob } from './image-source-blob';
import { decodeLayerPng } from './layer-png-codec';

const regionSchema = z.object({ mode: z.enum(['keep', 'clear', 'glass']), box: boxSchema }).strict();
const regionsSchema = z.array(regionSchema).max(64);
const assetSchema = z.object({ assetId: z.string().regex(/^[a-f0-9]{16}$/u), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192), mediaType: z.literal('image/png') }).strict()
  .refine(asset => asset.sha256.startsWith(asset.assetId) && asset.width * asset.height <= 12_000_000);
const localClearSchema = z.object({ kind: z.literal('clear-regions'), version: z.literal(1), baseline: assetSchema,
  sourceAssetId: z.string(), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  baselineRegions: regionsSchema, clearRegions: regionsSchema.refine(regions => regions.every(region => region.mode === 'clear')) }).strict();
export type LocalClearHistory = z.infer<typeof localClearSchema>;
export interface LocalClearPlan { history: LocalClearHistory; regions: MattingRegion[]; previousClearRegions: MattingRegion[]; unchanged: boolean }
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Existing direct foregrounds can be cleared without re-segmenting source RGB.
 * The original recipe stays immutable; only newly added clears are reversible. */
export function planLocalClearRefinement(config: Readonly<Record<string, unknown>>, source: LayerPixelAsset | undefined,
  result: LayerPixelAsset | undefined, requested: readonly MattingRegion[]): LocalClearPlan | null {
  const next = regionsSchema.parse(requested), current = regionsSchema.parse(config.mattingRegions ?? []);
  const representation = getLayerPixelRepresentation(config, source, result);
  const provenance = config.foregroundProvenance;
  const historyValue = provenance && typeof provenance === 'object' && !Array.isArray(provenance)
    ? (provenance as Record<string, unknown>).localClear : undefined;
  if (!representation.independentRgbaCandidate && !representation.preparedRgb && historyValue === undefined) return null;
  if (representation.error) throw new Error(representation.error);
  // Only added clears opt a legacy prepared foreground into this path. Its
  // initial keep/glass recipe continues through existing native matting.
  if (historyValue === undefined && !representation.independentRgbaCandidate) {
    const added = next.slice(current.length);
    if (!equal(next.slice(0, current.length), current) || !added.length || added.some(region => region.mode !== 'clear')) return null;
  }
  const owned = assetSchema.safeParse(result && { assetId: result.assetId, sha256: result.sha256,
    width: result.width, height: result.height, mediaType: result.mediaType });
  if (!owned.success || !source?.sha256 || !source.width || !source.height || config.layerKind !== 'transparent'
    || result?.assetId !== config.resultAssetId || source.assetId !== config.sourceAssetId
    || owned.data.width !== source.width || owned.data.height !== source.height
    || config.canvasWidth !== source.width || config.canvasHeight !== source.height
    || config.maskSpace !== 'source') throw new Error('局部清除需要原坐标完整尺寸的独立 RGBA 图层，素材归属或尺寸已变更');
  let history: LocalClearHistory;
  if (historyValue !== undefined) {
    const parsed = localClearSchema.safeParse(historyValue);
    if (!parsed.success) throw new Error('局部清除基线记录无效，请重新导入已审核的 RGBA 图层');
    history = parsed.data;
    if (history.sourceAssetId !== source.assetId || history.sourceSha256 !== source.sha256
      || history.baseline.width !== source.width || history.baseline.height !== source.height
      || !equal(current, [...history.baselineRegions, ...history.clearRegions])) {
      throw new Error('局部清除基线或区域归属已变更');
    }
  } else {
    history = { kind: 'clear-regions', version: 1, baseline: owned.data, sourceAssetId: source.assetId,
      sourceSha256: source.sha256, baselineRegions: current, clearRegions: [] };
  }
  const prefix = next.slice(0, history.baselineRegions.length), clears = next.slice(history.baselineRegions.length);
  if (!equal(prefix, history.baselineRegions) || clears.some(region => region.mode !== 'clear')) {
    // Legacy initial matting still owns its keep/glass workflow. Independent
    // RGBA and applied local clears must never be overwritten with source RGB.
    if (historyValue === undefined && !representation.independentRgbaCandidate) return null;
    throw new Error('已有独立 RGBA 只能局部清除；原有抠图标记不能在这里撤销或改成保留/玻璃');
  }
  return { history: { ...history, clearRegions: clears }, regions: next, previousClearRegions: history.clearRegions, unchanged: equal(next, current) };
}

export function applyLocalClearRegions(baseline: Uint8Array, width: number, height: number,
  regions: readonly MattingRegion[]): Uint8Array {
  if (baseline.length !== width * height * 4) throw new Error('局部清除基线像素尺寸无效');
  const clears = regionsSchema.parse(regions);
  if (clears.some(region => region.mode !== 'clear')) throw new Error('局部清除只接受明确的清除区域');
  const result = baseline.slice();
  for (const region of clears) {
    const pixels = sourceMattingBoxPixels(width, height, region.box);
    for (let y = pixels.top; y < pixels.bottom; y++) result.fill(0, (y * width + pixels.left) * 4, (y * width + pixels.right) * 4);
  }
  return result;
}

/** Check stored straight PNG bytes, with no resizing, Canvas or color recovery. */
export async function readLocalClearBaseline(asset: LocalClearHistory['baseline'] & { displayUrl: string }, assertCurrent: () => void) {
  const abort = new AbortController(), timeout = globalThis.setTimeout(() => abort.abort(), 30_000);
  try {
    assertCurrent();
    const blob = await readImageSourceBlob(asset.displayUrl, abort.signal); assertCurrent();
    if (blob.size > 40 * 1024 * 1024) throw new Error('局部清除基线 PNG 超出 40 MiB');
    const bytes = new Uint8Array(await blob.arrayBuffer()); assertCurrent();
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes); assertCurrent();
    const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    if (hash !== asset.sha256) throw new Error('局部清除基线素材摘要已变更');
    const decoded = decodeLayerPng(bytes);
    if (!decoded || decoded.width !== asset.width || decoded.height !== asset.height) throw new Error('局部清除基线必须是原尺寸 8 位 PNG');
    return decoded.rgba;
  } finally { globalThis.clearTimeout(timeout); abort.abort(); }
}
