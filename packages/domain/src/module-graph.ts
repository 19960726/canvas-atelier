import { z } from 'zod';
import { MAX_GENERATION_REFERENCES } from './agent-knowledge-contract';
import type { CanvasModulePortDefinition, CanvasModuleType, LegacyCanvasModuleType } from './canvas-module';
import { getCanvasModuleDefinition } from './canvas-module';
import type { CanvasEdge, CanvasModuleNode, CanvasNode, CanvasProject } from './project-schema';
import type { RuntimeProfileId } from './runtime-profile';

const idSchema = z.string().min(1);
const positionSchema = z.object({ x: z.number(), y: z.number() }).strict();

const moduleExecutionStateSchema = z.enum([
  'idle',
  'invalid',
  'ready',
  'waiting_confirmation',
  'queued',
  'running',
  'blocked',
  'completed',
  'failed',
  'cancelled',
]);

export const moduleExecutionSummarySchema = z.object({
  state: moduleExecutionStateSchema,
  latestExecutionId: idSchema.optional(),
}).strict();

const canvasModuleTypeSchema = z.custom<CanvasModuleType>((value) => {
  if (typeof value !== 'string') return false;
  try {
    getCanvasModuleDefinition(value as CanvasModuleType);
    return true;
  } catch {
    return false;
  }
}, {
  message: 'Unknown canvas module type',
});

function protectedModuleRecordSchema(label: 'config' | 'job' | 'result') {
  return z.record(z.unknown()).superRefine((payload, context) => {
    if (!containsProtectedModuleConfig(payload)) return;
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Module ${label} contains protected payload`,
    });
  });
}

const moduleConfigSchema = protectedModuleRecordSchema('config');
function isManagedProjectAssetId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{16}$/u.test(value);
}

const managedProjectAssetIdSchema = z.string().refine(isManagedProjectAssetId, {
  message: 'Module results require managed project asset ids',
});

const publicSummaryStringSchema = z.string().min(1).max(256);

const strictModuleJobSchema = z.object({
  id: idSchema,
  executionId: idSchema.optional(),
  status: moduleExecutionStateSchema.optional(),
  provider: publicSummaryStringSchema.optional(),
  route: publicSummaryStringSchema.optional(),
  progress: z.number().min(0).max(1).optional(),
}).strict();

const strictModuleResultSchema = z.object({
  id: idSchema,
  assetId: managedProjectAssetIdSchema.optional(),
  assetIds: z.array(managedProjectAssetIdSchema).max(MAX_GENERATION_REFERENCES).optional(),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'audio/mpeg', 'audio/wav']).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationMs: z.number().int().nonnegative().optional(),
}).strict();

const moduleJobSchema = protectedModuleRecordSchema('job').pipe(strictModuleJobSchema);
const moduleResultSchema = protectedModuleRecordSchema('result').pipe(strictModuleResultSchema);

const moduleNodeDataSchema = z.object({
  moduleType: canvasModuleTypeSchema,
  moduleVersion: z.literal(1),
  config: moduleConfigSchema,
  execution: moduleExecutionSummarySchema,
  job: moduleJobSchema.optional(),
  result: moduleResultSchema.optional(),
}).strict().superRefine(({ config, moduleType }, context) => {
  if (moduleType === 'image_input' || moduleType === 'upload_image') {
    if (config.assetId !== undefined && !isManagedProjectAssetId(config.assetId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Managed image modules require a content-addressed project asset id',
        path: ['config', 'assetId'],
      });
    }
    return;
  }
  if (moduleType === 'video_generation') {
    const referenceAssetIds = config.referenceAssetIds;
    if (referenceAssetIds !== undefined) {
      if (!Array.isArray(referenceAssetIds) || referenceAssetIds.length > MAX_GENERATION_REFERENCES) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Video preview references are limited to ${MAX_GENERATION_REFERENCES} managed images`,
          path: ['config', 'referenceAssetIds'],
        });
      } else {
        const seen = new Set<string>();
        referenceAssetIds.forEach((assetId, index) => {
          if (typeof assetId !== 'string' || !isManagedProjectAssetId(assetId) || seen.has(assetId)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'Video preview references require unique content-addressed project image asset ids',
              path: ['config', 'referenceAssetIds', index],
            });
          }
          if (typeof assetId === 'string') seen.add(assetId);
        });
      }
    }
    for (const key of ['firstFrameAssetId', 'lastFrameAssetId', 'sourceVideoAssetId'] as const) {
      if (config[key] !== undefined && !isManagedProjectAssetId(config[key])) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Video preview media requires content-addressed project asset ids',
          path: ['config', key],
        });
      }
    }
    return;
  }
  if (moduleType !== 'canvas_library' || config.assetIds === undefined) return;
  if (!Array.isArray(config.assetIds)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Canvas library asset ids must be an ordered array',
      path: ['config', 'assetIds'],
    });
    return;
  }
  if (config.assetIds.length > MAX_GENERATION_REFERENCES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Canvas library is limited to ${MAX_GENERATION_REFERENCES} project images`,
      path: ['config', 'assetIds'],
    });
  }
  const seen = new Set<string>();
  config.assetIds.forEach((assetId, index) => {
    if (!isManagedProjectAssetId(assetId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Canvas library entries require content-addressed project asset ids',
        path: ['config', 'assetIds', index],
      });
      return;
    }
    if (seen.has(assetId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Canvas library asset ids must be unique',
        path: ['config', 'assetIds', index],
      });
    }
    seen.add(assetId);
  });
});

export const moduleNodeSchema = z.object({
  id: idSchema,
  position: positionSchema,
  locked: z.boolean().optional(),
  type: z.literal('module'),
  data: moduleNodeDataSchema,
}).strict();

export const canvasEdgeSchema = z.object({
  id: idSchema,
  source: idSchema,
  target: idSchema,
  sourcePortId: idSchema.optional(),
  targetPortId: idSchema.optional(),
  order: z.number().int().nonnegative().optional(),
  label: z.string().optional(),
}).strict();

export function migrateCanvasProjectGraph(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return input;
  }

  const project = input as Record<string, unknown>;
  const hasOwnGraphVersion = Object.prototype.hasOwnProperty.call(project, 'graphVersion');
  if (hasOwnGraphVersion && project.graphVersion !== undefined && project.graphVersion !== 2) {
    throw new Error(`Unsupported graphVersion: ${String(project.graphVersion)}`);
  }

  const nodes = Array.isArray(project.nodes) ? project.nodes : null;
  const legacyNodeTypes = new Map<string, LegacyCanvasModuleType>();
  let hasLegacyNodes = false;
  if (nodes) {
    for (const candidate of nodes) {
      const legacyType = readLegacyModuleType(candidate);
      const id = readNodeId(candidate);
      if (!legacyType || !id) continue;
      legacyNodeTypes.set(id, legacyType);
      hasLegacyNodes = true;
    }
  }

  if (hasOwnGraphVersion && project.graphVersion === 2 && !hasLegacyNodes) return project;

  return {
    ...project,
    graphVersion: 2,
    ...(nodes ? { nodes: nodes.map(migrateModuleNode) } : {}),
    ...(Array.isArray(project.edges)
      ? { edges: project.edges.map((edge) => migrateLegacyEdge(edge, legacyNodeTypes)) }
      : {}),
  };
}

const LEGACY_MODULE_MIGRATIONS: Readonly<Record<LegacyCanvasModuleType, CanvasModuleType>> = Object.freeze({
  image_generation_v1: 'image_generation',
  image_generation_v2: 'image_generation',
  video_analysis: 'reverse_agent',
});

function readLegacyModuleType(value: unknown): LegacyCanvasModuleType | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = (value as Record<string, unknown>).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const moduleType = (data as Record<string, unknown>).moduleType;
  return moduleType === 'image_generation_v1' || moduleType === 'image_generation_v2' || moduleType === 'video_analysis'
    ? moduleType
    : null;
}

function readNodeId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === 'string' ? id : null;
}

function migrateModuleNode(value: unknown): unknown {
  const legacyType = readLegacyModuleType(value);
  if (!legacyType || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const node = value as Record<string, unknown>;
  const data = node.data as Record<string, unknown>;
  return {
    ...node,
    data: {
      ...data,
      moduleType: LEGACY_MODULE_MIGRATIONS[legacyType],
      config: migrateLegacyModuleConfig(legacyType, data.config),
      execution: cloneRecord(data.execution),
      ...(data.job === undefined ? {} : { job: cloneRecord(data.job) }),
      ...(data.result === undefined ? {} : { result: cloneRecord(data.result) }),
    },
  };
}

function migrateLegacyModuleConfig(legacyType: LegacyCanvasModuleType, value: unknown): unknown {
  const cloned = cloneRecord(value);
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) return cloned;
  const config = cloned as Record<string, unknown>;
  if (legacyType === 'image_generation_v1' || legacyType === 'image_generation_v2') {
    const enabledInputCapabilities: string[] = [];
    if (Array.isArray(config.referenceAssetIds) && config.referenceAssetIds.some((assetId) => typeof assetId === 'string' && assetId.length > 0)) {
      enabledInputCapabilities.push('references');
    }
    if (legacyType === 'image_generation_v2' && typeof config.maskAssetId === 'string' && config.maskAssetId.length > 0) {
      enabledInputCapabilities.push('mask');
    }
    if (legacyType === 'image_generation_v2' && typeof config.poseId === 'string' && config.poseId.length > 0) {
      enabledInputCapabilities.push('pose');
    }
    return { ...config, enabledInputCapabilities };
  }
  if (typeof config.assetId !== 'string' || config.assetId.length === 0) return config;
  return {
    ...config,
    orderedMedia: [{
      kind: 'video',
      assetId: config.assetId,
      label: typeof config.label === 'string' && config.label.length > 0 ? config.label : '迁移视频',
      ranges: normalizeLegacyVideoRanges(config.ranges),
    }],
  };
}

function normalizeLegacyVideoRanges(value: unknown): Array<{ startMs: number; endMs: number }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const startMs = (candidate as Record<string, unknown>).startMs;
    const endMs = (candidate as Record<string, unknown>).endMs;
    return typeof startMs === 'number' && typeof endMs === 'number' && startMs >= 0 && endMs > startMs
      ? [{ startMs, endMs }]
      : [];
  });
}

function cloneRecord(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneRecord);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, cloneRecord(entry)]));
}

function migrateLegacyEdge(value: unknown, legacyNodeTypes: ReadonlyMap<string, LegacyCanvasModuleType>): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const edge = value as Record<string, unknown>;
  const sourceType = typeof edge.source === 'string' ? legacyNodeTypes.get(edge.source) : undefined;
  if (sourceType !== 'video_analysis' || edge.sourcePortId !== 'camera') return edge;
  return { ...edge, sourcePortId: 'timeline' };
}

export interface GraphValidationIssue {
  code: 'MISSING_NODE' | 'MISSING_PORT' | 'DIRECTION' | 'TYPE_MISMATCH'
    | 'INPUT_CARDINALITY' | 'CYCLE' | 'RUNTIME_UNSUPPORTED';
  edgeId?: string;
  nodeId?: string;
  portId?: string;
  message: string;
}

export function canConnectCanvasPorts(
  sourceNode: CanvasModuleNode,
  sourcePortId: string,
  targetNode: CanvasModuleNode,
  targetPortId: string,
): { ok: true } | { ok: false; code: GraphValidationIssue['code']; message: string } {
  const source = getPort(sourceNode, sourcePortId, 'output');
  if (!source) {
    return { ok: false, code: 'MISSING_PORT', message: `Unknown source port: ${sourcePortId}` };
  }
  const target = getPort(targetNode, targetPortId, 'input');
  if (!target) {
    return { ok: false, code: 'MISSING_PORT', message: `Unknown target port: ${targetPortId}` };
  }
  if (source.direction !== 'output' || target.direction !== 'input') {
    return { ok: false, code: 'DIRECTION', message: 'Connections require output to input' };
  }
  if (
    source.dataType !== target.dataType
    && !(source.dataType === 'image_asset' && target.dataType === 'image_list')
    && !(source.dataType === 'video_asset' && target.dataType === 'video_ranges')
    && !(target.dataType === 'media_asset' && (source.dataType === 'image_asset' || source.dataType === 'video_asset'))
  ) {
    return { ok: false, code: 'TYPE_MISMATCH', message: `${source.dataType} cannot connect to ${target.dataType}` };
  }
  return { ok: true };
}

export function validateCanvasModuleGraph(
  project: CanvasProject,
  runtimeProfileId: RuntimeProfileId = 'modern',
): GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = [];
  const nodesById = new Map(project.nodes.map((node) => [node.id, node]));
  const moduleNodesById = new Map(
    project.nodes
      .filter(isCanvasModuleNode)
      .map((node) => [node.id, node]),
  );
  const incomingByPort = new Map<string, CanvasEdge[]>();
  const adjacency = new Map<string, Array<{ nodeId: string; edgeId: string }>>();

  for (const node of moduleNodesById.values()) {
    adjacency.set(node.id, []);
    const definition = getCanvasModuleDefinition(node.data.moduleType);
    if (!definition.runtimeProfiles.includes(runtimeProfileId)) {
      issues.push({
        code: 'RUNTIME_UNSUPPORTED',
        nodeId: node.id,
        message: `${node.data.moduleType} is not supported by runtime ${runtimeProfileId}`,
      });
    }
  }

  for (const edge of project.edges) {
    const sourceNode = nodesById.get(edge.source);
    const targetNode = nodesById.get(edge.target);
    if (!sourceNode) {
      issues.push({
        code: 'MISSING_NODE',
        edgeId: edge.id,
        nodeId: edge.source,
        message: `Unknown source node: ${edge.source}`,
      });
    }
    if (!targetNode) {
      issues.push({
        code: 'MISSING_NODE',
        edgeId: edge.id,
        nodeId: edge.target,
        message: `Unknown target node: ${edge.target}`,
      });
    }
    if (!sourceNode || !targetNode) continue;

    const sourceModuleNode = moduleNodesById.get(edge.source);
    const targetModuleNode = moduleNodesById.get(edge.target);
    if (!sourceModuleNode && !targetModuleNode) continue;

    if (sourceModuleNode && targetModuleNode) {
      adjacency.get(sourceModuleNode.id)?.push({ nodeId: targetModuleNode.id, edgeId: edge.id });
    }

    let hasMalformedModulePort = false;
    const sourcePort = sourceModuleNode && edge.sourcePortId
      ? getPort(sourceModuleNode, edge.sourcePortId, 'output')
      : undefined;
    const targetPort = targetModuleNode && edge.targetPortId
      ? getPort(targetModuleNode, edge.targetPortId, 'input')
      : undefined;
    if (sourceModuleNode && !edge.sourcePortId) {
      issues.push({
        code: 'MISSING_PORT',
        edgeId: edge.id,
        nodeId: sourceModuleNode.id,
        message: `Edge ${edge.id} is missing a source port`,
      });
      hasMalformedModulePort = true;
    } else if (sourceModuleNode && !sourcePort) {
      issues.push({
        code: 'MISSING_PORT',
        edgeId: edge.id,
        nodeId: sourceModuleNode.id,
        portId: edge.sourcePortId,
        message: `Unknown source port: ${edge.sourcePortId}`,
      });
      hasMalformedModulePort = true;
    }
    if (targetModuleNode && !edge.targetPortId) {
      issues.push({
        code: 'MISSING_PORT',
        edgeId: edge.id,
        nodeId: targetModuleNode.id,
        message: `Edge ${edge.id} is missing a target port`,
      });
      hasMalformedModulePort = true;
    } else if (targetModuleNode && !targetPort) {
      issues.push({
        code: 'MISSING_PORT',
        edgeId: edge.id,
        nodeId: targetModuleNode.id,
        portId: edge.targetPortId,
        message: `Unknown target port: ${edge.targetPortId}`,
      });
      hasMalformedModulePort = true;
    }
    if (edge.order === undefined) {
      issues.push({
        code: 'MISSING_PORT',
        edgeId: edge.id,
        message: `Edge ${edge.id} is missing input order`,
      });
    }
    if (hasMalformedModulePort) continue;

    if (!sourceModuleNode || !targetModuleNode) {
      const modulePort = sourcePort ?? targetPort;
      if (modulePort?.direction === (sourceModuleNode ? 'input' : 'output')) {
        issues.push({
          code: 'DIRECTION',
          edgeId: edge.id,
          nodeId: sourceModuleNode?.id ?? targetModuleNode?.id,
          portId: sourceModuleNode ? edge.sourcePortId : edge.targetPortId,
          message: 'Connections require output to input',
        });
      }
      continue;
    }

    const sourcePortId = edge.sourcePortId;
    const targetPortId = edge.targetPortId;
    if (!sourcePortId || !targetPortId) continue;

    const connection = canConnectCanvasPorts(
      sourceModuleNode,
      sourcePortId,
      targetModuleNode,
      targetPortId,
    );
    if (!connection.ok) {
      issues.push({
        code: connection.code,
        edgeId: edge.id,
        message: connection.message,
      });
      continue;
    }

    if (targetPort?.cardinality === 'one') {
      const key = `${targetModuleNode.id}:${targetPort.id}`;
      const incoming = incomingByPort.get(key) ?? [];
      incoming.push(edge);
      incomingByPort.set(key, incoming);
    }
  }

  for (const [key, incoming] of incomingByPort.entries()) {
    if (incoming.length <= 1) continue;
    const duplicate = incoming[1];
    if (!duplicate) continue;
    const separator = key.indexOf(':');
    const nodeId = key.slice(0, separator);
    const portId = key.slice(separator + 1);
    issues.push({
      code: 'INPUT_CARDINALITY',
      edgeId: duplicate.id,
      nodeId,
      portId,
      message: `Input ${nodeId}.${portId} accepts one edge but received ${incoming.length}`,
    });
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const edge of adjacency.get(nodeId) ?? []) {
      if (visiting.has(edge.nodeId)) {
        issues.push({ code: 'CYCLE', edgeId: edge.edgeId, nodeId: edge.nodeId, message: `Cycle detected at node ${edge.nodeId}` });
        continue;
      }
      visit(edge.nodeId);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const node of moduleNodesById.values()) visit(node.id);

  return issues;
}

export interface ModuleExecutionReadinessIssue {
  code: 'NODE_NOT_FOUND' | 'REQUIRED_INPUT' | 'ANALYZABLE_INPUT' | 'MINIMUM_INPUTS';
  nodeId: string;
  portId?: string;
  message: string;
}

export function validateCanvasModuleExecutionReadiness(
  project: CanvasProject,
  nodeId: string,
): ModuleExecutionReadinessIssue[] {
  const targetNode = project.nodes.find((node): node is CanvasModuleNode => node.id === nodeId && isCanvasModuleNode(node));
  if (!targetNode) {
    return [{ code: 'NODE_NOT_FOUND', nodeId, message: `Unknown module node: ${nodeId}` }];
  }

  const definition = getCanvasModuleDefinition(targetNode.data.moduleType);
  const inputCounts = new Map<string, number>();
  for (const port of definition.ports) {
    if (port.direction !== 'input') continue;
    inputCounts.set(port.id, countConfiguredModuleInput(targetNode, port.id));
  }

  const moduleNodesById = new Map(
    project.nodes.filter(isCanvasModuleNode).map((node) => [node.id, node]),
  );
  for (const edge of project.edges) {
    if (edge.target !== targetNode.id || !edge.sourcePortId || !edge.targetPortId) continue;
    const sourceNode = moduleNodesById.get(edge.source);
    if (!sourceNode || !canConnectCanvasPorts(sourceNode, edge.sourcePortId, targetNode, edge.targetPortId).ok) continue;
    inputCounts.set(
      edge.targetPortId,
      (inputCounts.get(edge.targetPortId) ?? 0) + countModuleEdgeItems(sourceNode, edge.sourcePortId),
    );
  }

  const issues: ModuleExecutionReadinessIssue[] = [];
  for (const port of definition.ports) {
    if (port.direction !== 'input' || !port.required || (inputCounts.get(port.id) ?? 0) > 0) continue;
    issues.push({
      code: 'REQUIRED_INPUT',
      nodeId: targetNode.id,
      portId: port.id,
      message: `Required input ${targetNode.id}.${port.id} is not configured or connected`,
    });
  }

  if (targetNode.data.moduleType === 'reverse_agent') {
    const analyzableInputCount = ['references', 'video', 'task', 'line_art']
      .reduce((total, portId) => total + (inputCounts.get(portId) ?? 0), 0);
    if (analyzableInputCount === 0) {
      issues.push({
        code: 'ANALYZABLE_INPUT',
        nodeId: targetNode.id,
        message: 'Reverse Agent requires at least one analyzable image, video, text, or line-art input',
      });
    }
  }

  if (targetNode.data.moduleType === 'image_compare' && (inputCounts.get('images') ?? 0) < 2) {
    issues.push({
      code: 'MINIMUM_INPUTS',
      nodeId: targetNode.id,
      portId: 'images',
      message: 'Image comparison requires at least two managed images',
    });
  }

  return issues;
}

function countModuleEdgeItems(sourceNode: CanvasModuleNode, sourcePortId: string): number {
  const sourcePort = getPort(sourceNode, sourcePortId, 'output');
  if (!sourcePort) return 0;
  if (sourceNode.data.moduleType === 'canvas_library' && sourcePort.dataType === 'image_list') {
    return readStringList(sourceNode.data.config.assetIds).length;
  }
  if ((sourceNode.data.moduleType === 'image_input' || sourceNode.data.moduleType === 'upload_image') && sourcePort.dataType === 'image_asset') {
    return isManagedProjectAssetId(sourceNode.data.config.assetId) ? 1 : 0;
  }
  if (sourceNode.data.moduleType === 'video_input' && sourcePort.dataType === 'video_asset') {
    return hasNonEmptyString(sourceNode.data.config.assetId) ? 1 : 0;
  }
  if (sourceNode.data.moduleType === 'text_prompt' && sourcePort.dataType === 'text_prompt') {
    return hasNonEmptyString(sourceNode.data.config.prompt) ? 1 : 0;
  }
  return 1;
}

function countConfiguredModuleInput(node: CanvasModuleNode, portId: string): number {
  const config = node.data.config;
  if (portId === 'references' || portId === 'images') {
    const explicitIds = [
      ...readStringList(config.referenceAssetIds),
      ...readStringList(config.assetIds),
      ...readOrderedMediaKinds(config.orderedMedia, 'image'),
    ];
    return new Set(explicitIds).size;
  }
  if (portId === 'video') {
    const orderedVideoCount = readOrderedMediaKinds(config.orderedMedia, 'video').length;
    return orderedVideoCount > 0 ? orderedVideoCount : hasNonEmptyString(config.assetId) ? 1 : 0;
  }
  if (portId === 'prompt') return hasNonEmptyString(config.prompt) ? 1 : 0;
  if (portId === 'task') return hasNonEmptyString(config.task) || hasNonEmptyString(config.prompt) ? 1 : 0;
  if (portId === 'line_art') return hasNonEmptyString(config.lineArtAssetId) ? 1 : 0;
  if (portId === 'mask') return hasNonEmptyString(config.maskAssetId) ? 1 : 0;
  if (portId === 'pose') return hasNonEmptyString(config.poseId) ? 1 : 0;
  if (portId === 'voice') return hasNonEmptyString(config.voiceProfileId) ? 1 : 0;
  if (hasMeaningfulModuleInput(config[portId])) return 1;
  if (hasMeaningfulModuleInput(config[`${portId}Id`])) return 1;
  if (hasMeaningfulModuleInput(config[`${portId}AssetId`])) return 1;
  return 0;
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => hasNonEmptyString(entry))
    : [];
}

function readOrderedMediaKinds(value: unknown, kind: 'image' | 'video'): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    return record.kind === kind && hasNonEmptyString(record.assetId) ? [record.assetId] : [];
  });
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasMeaningfulModuleInput(value: unknown): boolean {
  if (hasNonEmptyString(value)) return true;
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && typeof value === 'object';
}

export function reorderCanvasInputEdges(
  edges: readonly CanvasEdge[],
  targetNodeId: string,
  targetPortId: string,
  edgeIds: readonly string[],
): CanvasEdge[] {
  const matching = edges.filter((edge) => edge.target === targetNodeId && edge.targetPortId === targetPortId);
  if (!hasExactPermutation(matching.map((edge) => edge.id), edgeIds)) {
    throw new Error('edgeIds must be an exact permutation of matching input edge ids');
  }

  const orderById = new Map(edgeIds.map((edgeId, index) => [edgeId, index]));
  return edges.map((edge) => {
    if (edge.target !== targetNodeId || edge.targetPortId !== targetPortId) return edge;
    return { ...edge, order: orderById.get(edge.id) as number };
  });
}

function getPort(
  node: CanvasModuleNode,
  portId: string,
  direction: CanvasModulePortDefinition['direction'],
): CanvasModulePortDefinition | undefined {
  const ports = getCanvasModuleDefinition(node.data.moduleType).ports.filter((port) => port.id === portId);
  return ports.find((port) => port.direction === direction) ?? ports[0];
}

function isCanvasModuleNode(node: CanvasNode): node is CanvasModuleNode {
  return node.type === 'module';
}

function hasExactPermutation(expected: readonly string[], actual: readonly string[]): boolean {
  if (expected.length !== actual.length) return false;
  if (!hasUniqueIds(expected) || !hasUniqueIds(actual)) return false;
  const expectedCounts = countIds(expected);
  const actualCounts = countIds(actual);
  if (expectedCounts.size !== actualCounts.size) return false;
  for (const [id, count] of expectedCounts) {
    if (actualCounts.get(id) !== count) return false;
  }
  return true;
}

function hasUniqueIds(ids: readonly string[]): boolean {
  return new Set(ids).size === ids.length;
}

function countIds(ids: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

function containsProtectedModuleConfig(value: unknown, keyPath: string[] = []): boolean {
  if (typeof value === 'string') {
    return containsProtectedString(value, keyPath[keyPath.length - 1]);
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (containsProtectedModuleConfig(value[index], keyPath)) return true;
    }
    return false;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (isProtectedKeyName(key) && child !== undefined && child !== null && child !== '') {
        return true;
      }
      if (containsProtectedModuleConfig(child, keyPath.concat(key))) {
        return true;
      }
    }
  }
  return false;
}

function containsProtectedString(value: string, key?: string): boolean {
  return (key !== undefined && isProtectedKeyName(key) && value.trim().length > 0)
    || /authorization\s*:\s*(?:basic|bearer|token)?\s*\S+/i.test(value)
    || /\bbearer\s+[a-z0-9._~+/=\-]{8,}\b/i.test(value)
    || /\bsk-[a-z0-9_-]{8,}\b/i.test(value)
    || /\bAIza[0-9a-z_-]{20,}\b/i.test(value)
    || /\bAKIA[0-9A-Z]{16}\b/.test(value)
    || /\bgh[pousr]_[a-z0-9]{20,}\b/i.test(value)
    || /\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/i.test(value)
    || /data:[^,\s]+;base64,[a-z0-9+/=]+/i.test(value)
    || /base64,[a-z0-9+/=]{16,}/i.test(value)
    || /blob:[^\s"'`]+/i.test(value)
    || /file:\/\/[^\s"'`]+/i.test(value)
    || /(?:^|[\s([{"'])(?:[a-zA-Z]:[\\/])/.test(value)
    || /\\\\[^\\\s]+\\[^\s"'`]+/.test(value)
    || /(?:^|[\s([{"'])\/(?:Users|home|var|opt|tmp|private|etc|root|proc)\/[^\s"'`)\]}]+/.test(value)
    || /%(?:USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|HOMEDRIVE|HOMEPATH)%[\\/]/i.test(value);
}

function isProtectedKeyName(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
  return /(?:^|_)(?:api_?key|authorization|token|secret|password)(?:$|_)/.test(normalized);
}
