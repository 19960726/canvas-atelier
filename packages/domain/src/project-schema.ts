import { z } from 'zod';

const idSchema = z.string().min(1);
const normalizedSchema = z.number().min(0).max(1);

export const referenceRoleSchema = z.enum([
  'product_identity',
  'scene_composition',
  'prop_reference',
  'material_lighting',
  'placement_preview',
]);

export const placementSafeAreaSchema = z.object({
  id: idSchema,
  x: normalizedSchema,
  y: normalizedSchema,
  w: normalizedSchema,
  h: normalizedSchema,
  purpose: z.enum(['copy_safe', 'product_safe', 'custom']),
}).strict();

export const placementObjectSchema = z.object({
  id: idSchema,
  assetId: idSchema,
  role: referenceRoleSchema,
  x: normalizedSchema,
  y: normalizedSchema,
  w: normalizedSchema,
  h: normalizedSchema,
  rotation: z.number().min(-180).max(180).default(0),
  zIndex: z.number().int(),
  locked: z.boolean().default(false),
  visible: z.boolean().default(true),
  flipX: z.boolean().default(false),
  flipY: z.boolean().default(false),
  semanticLayer: z.enum([
    'foreground',
    'midground',
    'background',
    'hero_product',
    'optional_prop',
  ]),
  name: z.string().min(1).optional(),
}).strict();

const placementBoardMetaSchema = z.object({
  id: idSchema,
  aspectRatio: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  safeAreas: z.array(placementSafeAreaSchema).default([]),
}).strict();

export const placementBoardSchema = z.object({
  board: placementBoardMetaSchema,
  objects: z.array(placementObjectSchema).default([]),
}).strict();

export const modelJobSchema = z.object({
  id: idSchema,
  modelId: idSchema,
  status: z.enum(['queued', 'submitting', 'running', 'completed', 'failed', 'cancelled']),
  promptNodeId: idSchema,
  providerTaskId: idSchema.optional(),
  confirmedAt: z.string().datetime().optional(),
  retryCount: z.number().int().nonnegative().default(0),
}).strict();

export const agentPlanSchema = z.object({
  id: idSchema,
  state: z.enum([
    'idle',
    'reading_canvas',
    'drafting_plan',
    'waiting_for_confirmation',
    'applying_transaction',
    'running_models',
    'reviewing_results',
    'waiting_for_memory_sync',
    'error_needs_user',
  ]),
  proposedOperationIds: z.array(idSchema).default([]),
  requiresModelConfirmation: z.boolean().default(false),
  confirmedAt: z.string().datetime().optional(),
}).strict();

const positionSchema = z.object({ x: z.number(), y: z.number() }).strict();
const nodeBase = { id: idSchema, position: positionSchema };

const referenceNodeSchema = z.object({
  ...nodeBase,
  type: z.literal('reference'),
  data: z.object({
    assetId: idSchema,
    role: referenceRoleSchema,
  }).strict(),
}).strict();

const placementNodeSchema = z.object({
  ...nodeBase,
  type: z.literal('placement_preview'),
  data: placementBoardSchema,
}).strict();

const promptNodeSchema = z.object({
  ...nodeBase,
  type: z.literal('prompt'),
  data: z.object({
    prompt: z.string(),
    negativePrompt: z.string().optional(),
    requirementIds: z.array(idSchema).default([]),
  }).strict(),
}).strict();

const modelJobNodeSchema = z.object({
  ...nodeBase,
  type: z.literal('model_job'),
  data: z.object({ job: modelJobSchema }).strict(),
}).strict();

const imageResultNodeSchema = z.object({
  ...nodeBase,
  type: z.literal('image_result'),
  data: z.object({
    assetId: idSchema,
    modelId: idSchema,
    providerTaskId: idSchema.optional(),
    parentNodeIds: z.array(idSchema).default([]),
  }).strict(),
}).strict();

const reviewNodeSchema = z.object({
  ...nodeBase,
  type: z.literal('review'),
  data: z.object({
    keep: z.array(z.string()).default([]),
    change: z.array(z.string()).default([]),
    never: z.array(z.string()).default([]),
  }).strict(),
}).strict();

const memoryDiffNodeSchema = z.object({
  ...nodeBase,
  type: z.literal('memory_diff'),
  data: z.object({
    diffId: idSchema,
    status: z.enum(['pending_review', 'approved', 'synced', 'conflict']),
  }).strict(),
}).strict();

const agentPlanNodeSchema = z.object({
  ...nodeBase,
  type: z.literal('agent_plan'),
  data: z.object({ plan: agentPlanSchema }).strict(),
}).strict();

export const canvasNodeSchema = z.discriminatedUnion('type', [
  referenceNodeSchema,
  placementNodeSchema,
  promptNodeSchema,
  modelJobNodeSchema,
  imageResultNodeSchema,
  reviewNodeSchema,
  memoryDiffNodeSchema,
  agentPlanNodeSchema,
]);

export const canvasEdgeSchema = z.object({
  id: idSchema,
  source: idSchema,
  target: idSchema,
  label: z.string().optional(),
}).strict();

export const canvasProjectSchema = z.object({
  version: z.literal(1),
  id: idSchema,
  name: z.string().min(1),
  nodes: z.array(canvasNodeSchema),
  edges: z.array(canvasEdgeSchema),
}).strict();

export type ReferenceRole = z.infer<typeof referenceRoleSchema>;
export type PlacementObject = z.infer<typeof placementObjectSchema>;
export type PlacementBoard = z.infer<typeof placementBoardSchema>;
export type AgentPlan = z.infer<typeof agentPlanSchema>;
export type ModelJob = z.infer<typeof modelJobSchema>;
export type CanvasNode = z.infer<typeof canvasNodeSchema>;
export type CanvasEdge = z.infer<typeof canvasEdgeSchema>;
export type CanvasProject = z.infer<typeof canvasProjectSchema>;

export function parseCanvasProject(input: unknown): CanvasProject {
  return canvasProjectSchema.parse(input);
}
