import { MAX_GENERATION_REFERENCES, referenceRoleSchema } from './agent-knowledge-contract';
import { modelJobSchema } from './model-job';
import { canvasEdgeSchema, migrateCanvasProjectGraph, moduleNodeSchema } from './module-graph';
import { projectMemoryEntrySchema, selectActiveProjectMemoryEntries, skillPromotionCandidateSchema } from './project-memory';
import { z } from 'zod';

const idSchema = z.string().min(1);
const normalizedSchema = z.number().min(0).max(1);
export { MAX_GENERATION_REFERENCES, referenceRoleSchema };
export { canvasEdgeSchema };

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
  objects: z.array(placementObjectSchema).default([]).superRefine((objects, context) => {
    const userReferenceCount = objects.filter((object) => !object.assetId.startsWith('starter-')).length;
    if (userReferenceCount > MAX_GENERATION_REFERENCES) {
      context.addIssue({ code: z.ZodIssueCode.too_big, type: 'array', maximum: MAX_GENERATION_REFERENCES, inclusive: true, message: '鍙傝€冨浘鏈€澶?20 寮?' });
    }
  }),
}).strict();

export const agentPlanSchema = z.object({
  id: idSchema,
  state: z.enum([
    'idle',
    'reading_canvas',
    'drafting_plan',
    'waiting_for_confirmation',
    'confirming',
    'committing',
    'waiting_for_job_retry',
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
    provider: z.string().min(1).optional(),
    modelRoute: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
    promptNodeId: idSchema.optional(),
    referenceAssetIds: z.array(idSchema).default([]),
    jobId: idSchema.optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
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
  moduleNodeSchema,
]);

export const canvasProjectSchema = z.object({
  version: z.literal(1),
  graphVersion: z.literal(2).optional(),
  id: idSchema,
  name: z.string().min(1),
  nodes: z.array(canvasNodeSchema),
  edges: z.array(canvasEdgeSchema),
  projectMemory: z.array(projectMemoryEntrySchema).default([]),
  skillPromotionCandidates: z.array(skillPromotionCandidateSchema).default([]),
}).strict().superRefine((project, context) => {
  const memoryIds = new Set<string>();
  let previousRevision = -1;
  for (const [index, memory] of project.projectMemory.entries()) {
    if (memoryIds.has(memory.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['projectMemory', index, 'id'], message: '椤圭洰璁板繂 id 閲嶅' });
    }
    if (memory.projectId !== project.id) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['projectMemory', index, 'projectId'], message: '椤圭洰璁板繂蹇呴』灞炰簬褰撳墠椤圭洰' });
    }
    if (memory.projectRevision < previousRevision) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['projectMemory', index, 'projectRevision'], message: '椤圭洰璁板繂鐗堟湰涓嶈兘鍊掗€€' });
    }
    const supersededIds = [
      ...(memory.supersedesMemoryId ? [memory.supersedesMemoryId] : []),
      ...(memory.supersedesMemoryIds ?? []),
    ];
    if (supersededIds.some((id) => !memoryIds.has(id))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['projectMemory', index], message: '鎭㈠鎴栨挙閿€璁板繂蹇呴』寮曠敤鏇存棭鐨勯」鐩蹇?' });
    }
    memoryIds.add(memory.id);
    previousRevision = memory.projectRevision;
  }

  const memoryById = new Map(project.projectMemory.map((memory) => [memory.id, memory]));
  const activeMemoryIds = new Set(selectActiveProjectMemoryEntries(project.projectMemory).map((memory) => memory.id));
  const promotedMemoryIds = new Set<string>();
  const candidateIds = new Set<string>();
  for (const [index, candidate] of project.skillPromotionCandidates.entries()) {
    if (candidateIds.has(candidate.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['skillPromotionCandidates', index, 'id'], message: 'Skill 鍊欓€?id 涓嶈兘閲嶅' });
    }
    if (candidate.sourceProjectId !== project.id || !memoryIds.has(candidate.sourceProjectMemoryId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['skillPromotionCandidates', index], message: 'Skill 鍊欓€夊繀椤诲紩鐢ㄥ綋鍓嶉」鐩蹇?' });
    }

    const aggregateSourceIds = candidate.sourceProjectMemoryIds ?? [];
    const uniqueAggregateSourceIds = new Set<string>();
    for (const sourceMemoryId of aggregateSourceIds) {
      if (uniqueAggregateSourceIds.has(sourceMemoryId)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['skillPromotionCandidates', index, 'sourceProjectMemoryIds'], message: 'Aggregate source project memory ids must be unique' });
        break;
      }
      uniqueAggregateSourceIds.add(sourceMemoryId);
    }
    const sourceMemoryIds = aggregateSourceIds.length === 0
      ? [candidate.sourceProjectMemoryId]
      : uniqueAggregateSourceIds.has(candidate.sourceProjectMemoryId)
        ? aggregateSourceIds
        : [candidate.sourceProjectMemoryId, ...aggregateSourceIds];
    const sourceMemories = sourceMemoryIds
      .map((memoryId) => memoryById.get(memoryId))
      .filter((memory): memory is NonNullable<typeof memory> => memory !== undefined);

    if (sourceMemories.length !== sourceMemoryIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['skillPromotionCandidates', index], message: 'Skill 鍊欓€夊繀椤诲紩鐢ㄥ綋鍓嶉」鐩蹇?' });
    }
    if (sourceMemories.some((memory) => !['optimization', 'generation', 'reverse_prompt', 'user_feedback'].includes(memory.kind))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['skillPromotionCandidates', index], message: 'Skill 鍊欓€夊繀椤诲紩鐢ㄥ彲鎻愬崌鐨勯」鐩蹇?' });
    }
    if (sourceMemories.some((memory) => !activeMemoryIds.has(memory.id))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['skillPromotionCandidates', index], message: 'Skill 鍊欓€夊繀椤诲紩鐢ㄤ粛鐒舵湁鏁堢殑椤圭洰璁板繂' });
    }
    if (promotedMemoryIds.has(candidate.sourceProjectMemoryId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['skillPromotionCandidates', index], message: '鍚屼竴椤圭洰璁板繂涓嶈兘閲嶅鎻愬崌' });
    }
    promotedMemoryIds.add(candidate.sourceProjectMemoryId);
    candidateIds.add(candidate.id);
  }
});

export type ReferenceRole = z.infer<typeof referenceRoleSchema>;
export type PlacementObject = z.infer<typeof placementObjectSchema>;
export type PlacementBoard = z.infer<typeof placementBoardSchema>;
export type AgentPlan = z.infer<typeof agentPlanSchema>;
export type ModelJob = z.infer<typeof modelJobSchema>;
export type CanvasNode = z.infer<typeof canvasNodeSchema>;
export type CanvasModuleNode = Extract<CanvasNode, { type: 'module' }>;
export type CanvasEdge = z.infer<typeof canvasEdgeSchema>;
export type CanvasProject = z.infer<typeof canvasProjectSchema>;

export function parseCanvasProject(input: unknown): CanvasProject {
  return canvasProjectSchema.parse(migrateCanvasProjectGraph(input));
}
