import { z } from 'zod';
import { MAX_GENERATION_REFERENCES } from './agent-knowledge-contract';
import type { CanvasModulePortDefinition, CanvasModuleType } from './canvas-module';
import { getCanvasModuleDefinition } from './canvas-module';
import type { CanvasEdge, CanvasModuleNode, CanvasNode, CanvasProject } from './project-schema';
import type { RuntimeProfileId } from './runtime-profile';

const idSchema = z.string().min(1);
const positionSchema = z.object({ x: z.number(), y: z.number() }).strict();

export const moduleExecutionSummarySchema = z.object({
  state: z.enum([
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
  ]),
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

const moduleConfigSchema = z.record(z.unknown()).superRefine((config, context) => {
  if (containsProtectedModuleConfig(config)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Module config contains protected payload',
    });
  }
});

function isManagedProjectAssetId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{16}$/u.test(value);
}

const moduleNodeDataSchema = z.object({
  moduleType: canvasModuleTypeSchema,
  moduleVersion: z.literal(1),
  config: moduleConfigSchema,
  execution: moduleExecutionSummarySchema,
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
  if (!hasOwnGraphVersion || project.graphVersion === undefined) {
    return {
      ...project,
      graphVersion: 2,
    };
  }
  if (project.graphVersion !== 2) {
    throw new Error(`Unsupported graphVersion: ${String(project.graphVersion)}`);
  }
  return project;
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
  if (source.dataType !== target.dataType && !(source.dataType === 'image_asset' && target.dataType === 'image_list')) {
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
