import { z } from 'zod';

import { CANVAS_MODULE_DEFINITIONS } from './canvas-module';

const MAX_PUBLIC_TEXT_LENGTH = 8_192;
const MAX_COLLECTION_SIZE = 500;
const SECRET_KEY_PATTERN = /(?:api[-_]?key|authorization|bearer|credential|password|passphrase|private[-_]?key|secret|token)/iu;
const ABSOLUTE_PATH_PATTERN = /^(?:[a-z]:[\\/]|\\\\|\/)/iu;
const FILE_URL_PATTERN = /^file:/iu;
const DATA_URL_PATTERN = /^data:/iu;
const BASE64_PAYLOAD_PATTERN = /^[A-Za-z0-9+/=]+$/u;

const idSchema = z.string().trim().min(1).max(160);
const publicTextSchema = z.string().max(MAX_PUBLIC_TEXT_LENGTH);
const revisionSchema = z.number().int().nonnegative();
const positionSchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const moduleTypeSchema = z.enum(CANVAS_MODULE_DEFINITIONS.map((definition) => definition.type) as [
  (typeof CANVAS_MODULE_DEFINITIONS)[number]['type'],
  ...(typeof CANVAS_MODULE_DEFINITIONS)[number]['type'][],
]);

export const CanvasMcpToolNameSchema = z.enum([
  'canvas_describe_nodes',
  'canvas_read_workflow',
  'canvas_get_selection',
  'canvas_get_job_status',
  'canvas_plan_workflow',
  'canvas_apply_workflow',
  'canvas_create_node',
  'canvas_update_node',
  'canvas_connect_nodes',
  'canvas_move_nodes',
  'canvas_delete_selection',
  'canvas_run_node',
  'canvas_cancel_job',
  'canvas_import_media',
]);

export type CanvasMcpToolName = z.infer<typeof CanvasMcpToolNameSchema>;

function assertSafeMcpValue(value: unknown, path: readonly (string | number)[] = []): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`MCP value at ${formatPath(path)} must be finite`);
    return;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_PUBLIC_TEXT_LENGTH) throw new Error(`MCP string at ${formatPath(path)} is too large`);
    if (ABSOLUTE_PATH_PATTERN.test(value) || FILE_URL_PATTERN.test(value)) throw new Error(`MCP value at ${formatPath(path)} contains an absolute path`);
    if (DATA_URL_PATTERN.test(value)) throw new Error(`MCP value at ${formatPath(path)} contains a data URL`);
    if (value.length >= 256 && BASE64_PAYLOAD_PATTERN.test(value.replace(/\s+/gu, ''))) throw new Error(`MCP value at ${formatPath(path)} contains a base64 payload`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_COLLECTION_SIZE) throw new Error(`MCP collection at ${formatPath(path)} is too large`);
    value.forEach((item, index) => assertSafeMcpValue(item, [...path, index]));
    return;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_COLLECTION_SIZE) throw new Error(`MCP object at ${formatPath(path)} is too large`);
    for (const [key, child] of entries) {
      if (SECRET_KEY_PATTERN.test(key)) throw new Error(`MCP value at ${formatPath([...path, key])} contains a protected key`);
      assertSafeMcpValue(child, [...path, key]);
    }
    return;
  }
  throw new Error(`MCP value at ${formatPath(path)} is not JSON-safe`);
}

function formatPath(path: readonly (string | number)[]): string {
  return path.length === 0 ? '<root>' : path.join('.');
}

export function redactMcpValue<T>(value: T): T {
  assertSafeMcpValue(value);
  return value;
}

const safePublicValueSchema = z.unknown().superRefine((value, context) => {
  try {
    assertSafeMcpValue(value);
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : 'MCP value is not safe',
    });
  }
});

const portSchema = z.object({
  id: idSchema,
  direction: z.enum(['input', 'output']),
  dataType: z.string().trim().min(1).max(80),
  cardinality: z.enum(['one', 'many']),
  required: z.boolean(),
}).strict();

const workflowNodeSchema = z.object({
  id: idSchema,
  moduleType: moduleTypeSchema,
  position: positionSchema,
  selected: z.boolean(),
  config: z.record(z.string(), safePublicValueSchema),
  executionState: z.string().trim().min(1).max(80),
  managedResultIds: z.array(idSchema).max(20),
  ports: z.array(portSchema).max(40),
}).strict();

const workflowEdgeSchema = z.object({
  id: idSchema,
  sourceNodeId: idSchema,
  sourcePortId: idSchema,
  targetNodeId: idSchema,
  targetPortId: idSchema,
  selected: z.boolean().optional(),
}).strict();

export const CanvasWorkflowSnapshotSchema = z.object({
  protocol: z.literal('canvasforge.mcp.snapshot.v1'),
  projectId: idSchema,
  revision: revisionSchema,
  nodes: z.array(workflowNodeSchema).max(MAX_COLLECTION_SIZE),
  edges: z.array(workflowEdgeSchema).max(MAX_COLLECTION_SIZE),
  selection: z.object({
    nodeIds: z.array(idSchema).max(MAX_COLLECTION_SIZE),
    edgeIds: z.array(idSchema).max(MAX_COLLECTION_SIZE),
  }).strict(),
}).strict();

const createNodeMutationSchema = z.object({
  kind: z.literal('create_node'),
  nodeId: idSchema,
  moduleType: moduleTypeSchema,
  position: positionSchema,
  config: z.record(z.string(), safePublicValueSchema).optional(),
}).strict();
const updateNodeMutationSchema = z.object({
  kind: z.literal('update_node'),
  nodeId: idSchema,
  config: z.record(z.string(), safePublicValueSchema),
}).strict();
const connectNodesMutationSchema = z.object({
  kind: z.literal('connect_nodes'),
  edgeId: idSchema,
  sourceNodeId: idSchema,
  sourcePortId: idSchema,
  targetNodeId: idSchema,
  targetPortId: idSchema,
}).strict();
const moveNodesMutationSchema = z.object({
  kind: z.literal('move_nodes'),
  positions: z.array(z.object({ nodeId: idSchema, x: z.number().finite(), y: z.number().finite() }).strict()).min(1).max(MAX_COLLECTION_SIZE),
}).strict();
const deleteNodesMutationSchema = z.object({
  kind: z.literal('delete_nodes'),
  nodeIds: z.array(idSchema).min(1).max(MAX_COLLECTION_SIZE),
}).strict();
const deleteEdgesMutationSchema = z.object({
  kind: z.literal('delete_edges'),
  edgeIds: z.array(idSchema).min(1).max(MAX_COLLECTION_SIZE),
}).strict();

export const CanvasWorkflowMutationSchema = z.discriminatedUnion('kind', [
  createNodeMutationSchema,
  updateNodeMutationSchema,
  connectNodesMutationSchema,
  moveNodesMutationSchema,
  deleteEdgesMutationSchema,
  deleteNodesMutationSchema,
]);

export const CanvasWorkflowPlanSchema = z.object({
  protocol: z.literal('canvasforge.mcp.plan.v1'),
  planId: idSchema,
  projectId: idSchema,
  expectedRevision: revisionSchema,
  summary: publicTextSchema,
  limitations: z.array(publicTextSchema).max(50),
  mutations: z.array(CanvasWorkflowMutationSchema).min(1).max(MAX_COLLECTION_SIZE),
  paidJobs: z.array(z.object({ nodeId: idSchema, jobKind: z.enum(['image', 'video', 'reverse']), modelRoute: idSchema }).strict()).max(100),
  confirmationRequired: z.literal(true),
}).strict();

export const CanvasConfirmationGrantSchema = z.object({
  kind: z.enum(['workflow', 'paid_job']),
  token: idSchema,
  subjectId: idSchema,
  projectId: idSchema,
  expectedRevision: revisionSchema,
  requestHash: idSchema,
  expiresAt: z.string().datetime(),
}).strict();

const describeNodesRequestSchema = z.object({ tool: z.literal('canvas_describe_nodes') }).strict();
const readWorkflowRequestSchema = z.object({ tool: z.literal('canvas_read_workflow') }).strict();
const getSelectionRequestSchema = z.object({ tool: z.literal('canvas_get_selection') }).strict();
const getJobStatusRequestSchema = z.object({ tool: z.literal('canvas_get_job_status'), jobId: idSchema }).strict();
const planWorkflowRequestSchema = z.object({
  tool: z.literal('canvas_plan_workflow'),
  expectedRevision: revisionSchema,
  workflowIntent: publicTextSchema,
  mutations: z.array(CanvasWorkflowMutationSchema).min(1).max(MAX_COLLECTION_SIZE),
}).strict();
const applyWorkflowRequestSchema = z.object({
  tool: z.literal('canvas_apply_workflow'),
  expectedRevision: revisionSchema,
  planId: idSchema,
  confirmationToken: idSchema,
}).strict();
const createNodeRequestSchema = z.object({
  tool: z.literal('canvas_create_node'),
  expectedRevision: revisionSchema,
  moduleType: moduleTypeSchema,
  position: positionSchema,
  config: z.record(z.string(), safePublicValueSchema).optional(),
}).strict();
const updateNodeRequestSchema = z.object({
  tool: z.literal('canvas_update_node'),
  expectedRevision: revisionSchema,
  nodeId: idSchema,
  config: z.record(z.string(), safePublicValueSchema),
}).strict();
const connectNodesRequestSchema = z.object({
  tool: z.literal('canvas_connect_nodes'),
  expectedRevision: revisionSchema,
  sourceNodeId: idSchema,
  sourcePortId: idSchema,
  targetNodeId: idSchema,
  targetPortId: idSchema,
}).strict();
const moveNodesRequestSchema = z.object({
  tool: z.literal('canvas_move_nodes'),
  expectedRevision: revisionSchema,
  positions: z.array(z.object({ nodeId: idSchema, x: z.number().finite(), y: z.number().finite() }).strict()).min(1).max(MAX_COLLECTION_SIZE),
}).strict();
const deleteSelectionRequestSchema = z.object({
  tool: z.literal('canvas_delete_selection'),
  expectedRevision: revisionSchema,
}).strict();
const runNodeRequestSchema = z.object({
  tool: z.literal('canvas_run_node'),
  expectedRevision: revisionSchema,
  nodeId: idSchema,
  confirmationToken: idSchema.optional(),
}).strict();
const cancelJobRequestSchema = z.object({ tool: z.literal('canvas_cancel_job'), jobId: idSchema }).strict();
const importMediaRequestSchema = z.object({
  tool: z.literal('canvas_import_media'),
  expectedRevision: revisionSchema,
  mediaKind: z.enum(['image', 'video']),
  position: positionSchema,
}).strict();

export const CanvasMcpRequestSchema = z.discriminatedUnion('tool', [
  describeNodesRequestSchema,
  readWorkflowRequestSchema,
  getSelectionRequestSchema,
  getJobStatusRequestSchema,
  planWorkflowRequestSchema,
  applyWorkflowRequestSchema,
  createNodeRequestSchema,
  updateNodeRequestSchema,
  connectNodesRequestSchema,
  moveNodesRequestSchema,
  deleteSelectionRequestSchema,
  runNodeRequestSchema,
  cancelJobRequestSchema,
  importMediaRequestSchema,
]);

const successResponseSchema = z.object({
  ok: z.literal(true),
  result: safePublicValueSchema,
}).strict();
const errorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string().trim().min(1).max(120),
    message: publicTextSchema,
    details: safePublicValueSchema.optional(),
  }).strict(),
}).strict();

export const CanvasMcpResponseSchema = z.discriminatedUnion('ok', [successResponseSchema, errorResponseSchema]);

export interface CanvasMcpToolDefinition {
  readonly name: CanvasMcpToolName;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodTypeAny;
  readonly requestSchema: z.ZodTypeAny;
}

function tool(
  name: CanvasMcpToolName,
  title: string,
  description: string,
  requestSchema: z.AnyZodObject,
): CanvasMcpToolDefinition {
  return Object.freeze({
    name,
    title,
    description,
    inputSchema: requestSchema.omit({ tool: true }),
    requestSchema,
  });
}

export const CANVAS_MCP_TOOL_DEFINITIONS: readonly CanvasMcpToolDefinition[] = Object.freeze([
  tool('canvas_describe_nodes', 'Describe canvas nodes', 'List supported node types, ports, and public capabilities.', describeNodesRequestSchema),
  tool('canvas_read_workflow', 'Read workflow', 'Read the current public workflow snapshot.', readWorkflowRequestSchema),
  tool('canvas_get_selection', 'Get selection', 'Read selected canvas node and edge identifiers.', getSelectionRequestSchema),
  tool('canvas_get_job_status', 'Get job status', 'Read a managed job status without provider secrets.', getJobStatusRequestSchema),
  tool('canvas_plan_workflow', 'Plan workflow', 'Validate and preview a workflow change without writing it.', planWorkflowRequestSchema),
  tool('canvas_apply_workflow', 'Apply workflow', 'Apply a confirmed one-time workflow plan.', applyWorkflowRequestSchema),
  tool('canvas_create_node', 'Create node', 'Create one supported canvas node at a position.', createNodeRequestSchema),
  tool('canvas_update_node', 'Update node', 'Update public configuration on one canvas node.', updateNodeRequestSchema),
  tool('canvas_connect_nodes', 'Connect nodes', 'Connect compatible source and target ports.', connectNodesRequestSchema),
  tool('canvas_move_nodes', 'Move nodes', 'Move one or more nodes in one transaction.', moveNodesRequestSchema),
  tool('canvas_delete_selection', 'Delete selection', 'Delete the current confirmed selection.', deleteSelectionRequestSchema),
  tool('canvas_run_node', 'Run node', 'Run one node after any paid-job confirmation.', runNodeRequestSchema),
  tool('canvas_cancel_job', 'Cancel job', 'Cancel one managed Canvas Atelier job.', cancelJobRequestSchema),
  tool('canvas_import_media', 'Import media', 'Ask Canvas Atelier to open its own image or video picker.', importMediaRequestSchema),
]);

export type CanvasWorkflowSnapshot = z.infer<typeof CanvasWorkflowSnapshotSchema>;
export type CanvasWorkflowPlan = z.infer<typeof CanvasWorkflowPlanSchema>;
export type CanvasWorkflowMutation = z.infer<typeof CanvasWorkflowMutationSchema>;
export type CanvasMcpRequest = z.infer<typeof CanvasMcpRequestSchema>;
export type CanvasMcpResponse = z.infer<typeof CanvasMcpResponseSchema>;
export type CanvasConfirmationGrant = z.infer<typeof CanvasConfirmationGrantSchema>;
