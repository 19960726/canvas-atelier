import { z } from 'zod';
import type { CanvasNode } from '@agent-canvas/domain';
import { foregroundOutputContractSchema, layeringPlanElementSchema, type LayeringPlan } from './layering-plan';
import { boxSchema, layeringSelectionSchema } from './layering-selection';

// Drafts may contain unfinished text; validate structure before rendering it.
const draftPlanSchema = z.object({
  sourceAssetId: z.string(), canvasWidth: z.number().int().positive().max(8192), canvasHeight: z.number().int().positive().max(8192),
  pixelMode: z.literal('source').optional(), selection: layeringSelectionSchema.optional(),
  foregroundOutputContract: foregroundOutputContractSchema.optional(),
  layers: z.array(z.object({ layerId: z.string(), kind: z.enum(['background', 'transparent']), name: z.string(),
    description: z.string(), included: z.boolean(), sourceBounds: boxSchema.optional(),
    elementIds: z.array(z.string()).max(150).optional() })).max(12),
  elements: z.array(layeringPlanElementSchema).max(150).optional(),
});

const draftSchema = z.object({
  sourceAssetId: z.string(), plan: draftPlanSchema.nullable(),
  analysisRoute: z.string(), generationRoute: z.string(), resolution: z.enum(['1K', '2K', '4K']),
  layerCountMode: z.enum(['auto', 'custom']), targetLayerCount: z.number().int().min(2).max(12),
  selection: layeringSelectionSchema, step: z.enum(['analyze', 'edit', 'review']),
  scopeDraft: z.object({ mode: z.enum(['whole', 'objects', 'region']), box: boxSchema.nullable(), target: z.string().max(500) }).optional(),
  createdGroupId: z.string().nullable(), started: z.boolean(),
});
export type LayeringDraft = Omit<z.infer<typeof draftSchema>, 'plan'> & { plan: LayeringPlan | null };

export function restoreLayeringDraft(sourceAssetId: string, sourceConfig: Readonly<Record<string, unknown>>, nodes: readonly CanvasNode[]): LayeringDraft | null {
  const saved = sourceConfig.layeringDrafts;
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    const parsed = draftSchema.safeParse((saved as Record<string, unknown>)[sourceAssetId]);
    if (parsed.success && parsed.data.sourceAssetId === sourceAssetId
      && (!parsed.data.plan || (parsed.data.plan.sourceAssetId === sourceAssetId && Array.isArray(parsed.data.plan.layers)))) return parsed.data;
  }
  const group = [...nodes].reverse().find(node => node.type === 'module' && node.data.moduleType === 'image_layering'
    && node.data.config.sourceAssetId === sourceAssetId && Array.isArray(node.data.config.planLayers));
  if (group?.type !== 'module') return null;
  const config = group.data.config;
  if (typeof config.canvasWidth !== 'number' || typeof config.canvasHeight !== 'number') return null;
  const ownershipLayers = Array.isArray(config.planOwnershipLayers) ? config.planOwnershipLayers : config.planLayers as unknown[];
  const layers = ownershipLayers.map(layer => typeof layer === 'object' && layer !== null
    ? { ...layer, included: Array.isArray(config.planOwnershipLayers) ? (layer as Record<string, unknown>).included === true : true }
    : layer);
  if (!layers.length) return null;
  const selection = layeringSelectionSchema.safeParse(config.layerSelection ?? { mode: 'whole' });
  if (!selection.success) return null;
  const plan = draftPlanSchema.safeParse({ sourceAssetId, canvasWidth: config.canvasWidth, canvasHeight: config.canvasHeight, layers,
    ...(Array.isArray(config.planElements) ? { elements: config.planElements } : {}),
    selection: selection.data, ...(config.pixelMode === 'source' ? { pixelMode: 'source' } : {}),
    ...(config.foregroundOutputContract !== undefined ? { foregroundOutputContract: config.foregroundOutputContract } : {}) });
  if (!plan.success) return null;
  return { sourceAssetId, plan: plan.data,
    selection: selection.data, analysisRoute: '', generationRoute: '', resolution: '4K', layerCountMode: 'auto', targetLayerCount: 5,
    step: 'edit', createdGroupId: typeof config.groupId === 'string' ? config.groupId : null, started: config.status !== 'planned' };
}
