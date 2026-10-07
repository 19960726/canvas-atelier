import { z } from 'zod';
import type { ModelJobProvider } from '@agent-canvas/domain';
import { boxSchema, layeringSelectionSchema, type LayeringBox, type LayeringSelection } from './layering-selection';

const MAX_CANVAS_SIDE = 8_192;
const MAX_CANVAS_BYTES = 256 * 1024 * 1024;
export const foregroundOutputContractSchema = z.enum(['source-alpha-matte-v1', 'source-independent-rgba-v2']);
export type ForegroundOutputContract = z.infer<typeof foregroundOutputContractSchema>;
const elementKindSchema = z.enum(['object', 'shadow', 'optical', 'text']);
export const layeringPlanElementSchema = z.object({
  elementId: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/u),
  name: z.string().trim().min(1).max(80),
  layerId: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/u),
  kind: elementKindSchema,
  sourceBounds: boxSchema.optional(),
  carrierElementId: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/u).optional(),
}).strict();
export type LayeringPlanElement = z.infer<typeof layeringPlanElementSchema>;
const layerSchema = z.object({
  layerId: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/u),
  kind: z.enum(['background', 'transparent']),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(1_000),
  included: z.boolean(),
  sourceBounds: boxSchema.optional(),
  elementIds: z.array(z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/u)).max(150).optional(),
}).strict();

const planSchema = z.object({
  sourceAssetId: z.string().min(1).max(256),
  canvasWidth: z.number().int().positive().max(MAX_CANVAS_SIDE),
  canvasHeight: z.number().int().positive().max(MAX_CANVAS_SIDE),
  selection: layeringSelectionSchema.optional(),
  pixelMode: z.literal('source').optional(),
  foregroundOutputContract: foregroundOutputContractSchema.optional(),
  layers: z.array(layerSchema).min(2).max(12),
  elements: z.array(layeringPlanElementSchema).min(1).max(150).optional(),
}).strict().superRefine((plan, context) => {
  if (plan.foregroundOutputContract !== undefined && plan.pixelMode !== 'source') {
    context.addIssue({ code: 'custom', path: ['foregroundOutputContract'], message: 'An explicit foreground output contract requires source coordinates and validation.' });
  }
  if (plan.canvasWidth * plan.canvasHeight * 4 > MAX_CANVAS_BYTES) {
    context.addIssue({ code: 'custom', path: ['canvasWidth'], message: 'The layering canvas exceeds the pixel budget.' });
  }
  const ids = new Set<string>();
  for (const [index, layer] of plan.layers.entries()) {
    if (ids.has(layer.layerId)) context.addIssue({ code: 'custom', path: ['layers', index, 'layerId'], message: 'Layer identifiers must be unique.' });
    ids.add(layer.layerId);
  }
  const backgrounds = plan.layers.filter((layer) => layer.kind === 'background');
  if (backgrounds.length !== 1 || plan.layers[0]?.kind !== 'background' || backgrounds[0]?.included !== true) {
    context.addIssue({ code: 'custom', path: ['layers'], message: 'A single included background must be the bottom layer.' });
  }
  if (plan.layers.filter((layer) => layer.kind === 'transparent').length > 11) {
    context.addIssue({ code: 'custom', path: ['layers'], message: 'At most eleven transparent layers are supported.' });
  }
  if (!plan.layers.some((layer) => layer.kind === 'transparent' && layer.included)) {
    context.addIssue({ code: 'custom', path: ['layers'], message: 'Include at least one transparent foreground layer.' });
  }
  if (plan.elements !== undefined) {
    const layerIds = new Set(plan.layers.map((layer) => layer.layerId));
    const elementIds = new Set<string>();
    const ownedIds = new Set<string>();
    for (const [index, element] of plan.elements.entries()) {
      if (elementIds.has(element.elementId)) context.addIssue({ code: 'custom', path: ['elements', index, 'elementId'], message: 'Element identifiers must be unique.' });
      elementIds.add(element.elementId);
      if (!layerIds.has(element.layerId)) context.addIssue({ code: 'custom', path: ['elements', index, 'layerId'], message: 'Every element must belong to a declared layer.' });
      if (element.carrierElementId !== undefined && element.carrierElementId === element.elementId) {
        context.addIssue({ code: 'custom', path: ['elements', index, 'carrierElementId'], message: 'An optical element cannot carry itself.' });
      }
      if (element.carrierElementId !== undefined && element.kind !== 'optical' && element.kind !== 'shadow') {
        context.addIssue({ code: 'custom', path: ['elements', index, 'carrierElementId'], message: 'Only optical and shadow elements may name a carrier.' });
      }
    }
    for (const [index, layer] of plan.layers.entries()) {
      if (layer.elementIds === undefined) {
        context.addIssue({ code: 'custom', path: ['layers', index, 'elementIds'], message: 'Every layer in an element inventory must list its owned elements.' });
        continue;
      }
      if (layer.included && layer.elementIds.length === 0) {
        context.addIssue({ code: 'custom', path: ['layers', index, 'elementIds'], message: 'Each included layer must own at least one inventory element.' });
      }
      const layerOwned = new Set<string>();
      for (const [elementIndex, elementId] of layer.elementIds.entries()) {
        if (layerOwned.has(elementId)) context.addIssue({ code: 'custom', path: ['layers', index, 'elementIds', elementIndex], message: 'A layer cannot list an element twice.' });
        layerOwned.add(elementId);
        if (!elementIds.has(elementId)) context.addIssue({ code: 'custom', path: ['layers', index, 'elementIds', elementIndex], message: 'Layer ownership references an unknown element.' });
        else {
          const element = plan.elements.find(candidate => candidate.elementId === elementId);
          if (element?.layerId !== layer.layerId) context.addIssue({ code: 'custom', path: ['layers', index, 'elementIds', elementIndex], message: 'Layer ownership does not match the element owner.' });
        }
        if (ownedIds.has(elementId)) context.addIssue({ code: 'custom', path: ['layers', index, 'elementIds', elementIndex], message: 'Each element must have exactly one owner layer.' });
        ownedIds.add(elementId);
      }
    }
    for (const element of plan.elements) {
      if (!ownedIds.has(element.elementId)) context.addIssue({ code: 'custom', path: ['elements'], message: `Element ${element.elementId} is missing from its owner layer.` });
      if (element.carrierElementId !== undefined) {
        const carrier = plan.elements.find(candidate => candidate.elementId === element.carrierElementId);
        if (carrier === undefined) context.addIssue({ code: 'custom', path: ['elements'], message: `Element ${element.elementId} references an unknown carrier.` });
        else if (carrier.kind !== 'object' && carrier.kind !== 'text') context.addIssue({ code: 'custom', path: ['elements'], message: `Element ${element.elementId} carrier must be an object or text element.` });
      }
    }
  }
});

const analysisReplySchema = z.object({ layers: z.array(layerSchema).min(2).max(12), elements: z.array(layeringPlanElementSchema).min(1).max(150).optional() }).strict();
const resolutionSchema = z.enum(['1K', '2K', '4K']);

export interface LayeringPlanLayer {
  readonly sourceBounds?: LayeringBox;
  readonly layerId: string;
  readonly kind: 'background' | 'transparent';
  readonly name: string;
  readonly description: string;
  readonly included: boolean;
  readonly elementIds?: readonly string[];
}

export interface LayeringPlan {
  readonly pixelMode?: 'source';
  readonly foregroundOutputContract?: ForegroundOutputContract;
  readonly selection?: LayeringSelection;
  readonly sourceAssetId: string;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly layers: readonly LayeringPlanLayer[];
  readonly elements?: readonly LayeringPlanElement[];
}

export interface LayeringConfirmation {
  readonly sourceAssetId: string;
  readonly provider: ModelJobProvider;
  readonly modelRoute: string;
  readonly resolution: '1K' | '2K' | '4K';
  readonly layerIds: readonly string[];
  readonly digest: string;
  readonly confirmedAt: string;
}

export function normalizeLayeringPlan(value: unknown): LayeringPlan {
  return planSchema.parse(value);
}

export function parseLayeringAnalysis(
  message: string,
  sourceAssetId: string,
  width: number,
  height: number,
  options: { readonly requireElementInventory?: boolean } = {},
): LayeringPlan {
  if (!isNonEmptyString(sourceAssetId)) throw new Error('A managed source asset is required for image layering.');
  let raw: unknown;
  try {
    raw = JSON.parse(message) as unknown;
  } catch {
    throw new Error('The visual analysis did not return a valid JSON layer plan.');
  }
  const reply = analysisReplySchema.parse(raw);
  if (options.requireElementInventory === true && reply.elements === undefined) {
    throw new Error('The visual analysis must return an explicit element ownership inventory before layer jobs can be created.');
  }
  return planSchema.parse({
    sourceAssetId,
    canvasWidth: width,
    canvasHeight: height,
    layers: reply.layers,
    ...(reply.elements ? { elements: reply.elements } : {}),
  });
}

export async function confirmLayeringPlan(
  plan: LayeringPlan,
  provider: ModelJobProvider,
  modelRoute: string,
  resolution: '1K' | '2K' | '4K',
  confirmedAt: string,
): Promise<LayeringConfirmation> {
  const normalizedPlan = planSchema.parse(plan);
  const normalizedProvider = z.enum(['comfly', 'relayme', 'julun', '4dai']).parse(provider);
  const normalizedRoute = z.string().trim().min(1).max(256).parse(modelRoute);
  const normalizedResolution = resolutionSchema.parse(resolution);
  const timestamp = z.string().datetime().parse(confirmedAt);
  const digest = await digestConfirmation(normalizedPlan, normalizedProvider, normalizedRoute, normalizedResolution);
  return Object.freeze({
    sourceAssetId: normalizedPlan.sourceAssetId,
    provider: normalizedProvider,
    modelRoute: normalizedRoute,
    resolution: normalizedResolution,
    layerIds: Object.freeze(normalizedPlan.layers.filter((layer) => layer.included).map((layer) => layer.layerId)),
    digest,
    confirmedAt: timestamp,
  });
}

export async function matchesLayeringConfirmation(
  confirmation: LayeringConfirmation,
  plan: LayeringPlan,
  provider: ModelJobProvider,
  modelRoute: string,
  resolution: '1K' | '2K' | '4K',
): Promise<boolean> {
  try {
    const normalizedPlan = planSchema.parse(plan);
    const normalizedProvider = z.enum(['comfly', 'relayme', 'julun', '4dai']).parse(provider);
    const normalizedRoute = z.string().trim().min(1).max(256).parse(modelRoute);
    const normalizedResolution = resolutionSchema.parse(resolution);
    if (confirmation.sourceAssetId !== normalizedPlan.sourceAssetId
      || confirmation.provider !== normalizedProvider
      || confirmation.modelRoute !== normalizedRoute
      || confirmation.resolution !== normalizedResolution
      || confirmation.layerIds.length !== normalizedPlan.layers.filter((layer) => layer.included).length) return false;
    const layerIds = normalizedPlan.layers.filter((layer) => layer.included).map((layer) => layer.layerId);
    if (!layerIds.every((id, index) => confirmation.layerIds[index] === id)) return false;
    return confirmation.digest === await digestConfirmation(normalizedPlan, normalizedProvider, normalizedRoute, normalizedResolution);
  } catch {
    return false;
  }
}

async function digestConfirmation(
  plan: LayeringPlan,
  provider: ModelJobProvider,
  modelRoute: string,
  resolution: '1K' | '2K' | '4K',
): Promise<string> {
  const canonical = JSON.stringify({
    sourceAssetId: plan.sourceAssetId,
    canvasWidth: plan.canvasWidth,
    canvasHeight: plan.canvasHeight,
    ...(plan.selection ? { selection: plan.selection } : {}),
    ...(plan.pixelMode ? { pixelMode: plan.pixelMode } : {}),
    ...(plan.foregroundOutputContract ? { foregroundOutputContract: plan.foregroundOutputContract } : {}),
    layers: plan.layers.map((layer) => ({
      layerId: layer.layerId,
      kind: layer.kind,
      name: layer.name.trim(),
      description: layer.description.trim(),
      included: layer.included,
      ...(layer.sourceBounds ? { sourceBounds: layer.sourceBounds } : {}),
      ...(layer.elementIds ? { elementIds: layer.elementIds } : {}),
    })),
    ...(plan.elements ? { elements: plan.elements } : {}),
    provider,
    modelRoute,
    resolution,
  });
  const cryptoProvider = globalThis.crypto;
  if (!cryptoProvider?.subtle) throw new Error('Secure confirmation hashing is unavailable in this runtime.');
  const bytes = new TextEncoder().encode(canonical);
  const digest = await cryptoProvider.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
