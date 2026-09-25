import { z } from 'zod';
import type { ModelJobProvider } from '@agent-canvas/domain';

const MAX_CANVAS_SIDE = 8_192;
const MAX_CANVAS_BYTES = 256 * 1024 * 1024;
const layerSchema = z.object({
  layerId: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/u),
  kind: z.enum(['background', 'transparent']),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(1_000),
  included: z.boolean(),
}).strict();

const planSchema = z.object({
  sourceAssetId: z.string().min(1).max(256),
  canvasWidth: z.number().int().positive().max(MAX_CANVAS_SIDE),
  canvasHeight: z.number().int().positive().max(MAX_CANVAS_SIDE),
  layers: z.array(layerSchema).min(2).max(12),
}).strict().superRefine((plan, context) => {
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
});

const analysisReplySchema = z.object({ layers: z.array(layerSchema).min(2).max(12) }).strict();
const resolutionSchema = z.enum(['1K', '2K', '4K']);

export interface LayeringPlanLayer {
  readonly layerId: string;
  readonly kind: 'background' | 'transparent';
  readonly name: string;
  readonly description: string;
  readonly included: boolean;
}

export interface LayeringPlan {
  readonly sourceAssetId: string;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly layers: readonly LayeringPlanLayer[];
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

export function parseLayeringAnalysis(
  message: string,
  sourceAssetId: string,
  width: number,
  height: number,
): LayeringPlan {
  if (!isNonEmptyString(sourceAssetId)) throw new Error('A managed source asset is required for image layering.');
  let raw: unknown;
  try {
    raw = JSON.parse(message) as unknown;
  } catch {
    throw new Error('The visual analysis did not return a valid JSON layer plan.');
  }
  const reply = analysisReplySchema.parse(raw);
  return planSchema.parse({
    sourceAssetId,
    canvasWidth: width,
    canvasHeight: height,
    layers: reply.layers,
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
    layers: plan.layers.map((layer) => ({
      layerId: layer.layerId,
      kind: layer.kind,
      name: layer.name.trim(),
      description: layer.description.trim(),
      included: layer.included,
    })),
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
