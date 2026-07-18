import {
  canvasEdgeSchema,
  canvasNodeSchema,
  parseCanvasProject,
  type CanvasEdge,
  type CanvasProject,
} from './project-schema';
import { reorderCanvasInputEdges, validateCanvasModuleGraph, type GraphValidationIssue } from './module-graph';
import { z } from 'zod';

const createNodeOperationSchema = z.object({ kind: z.literal('create_node'), node: canvasNodeSchema }).strict();
const updateNodeOperationSchema = z.object({ kind: z.literal('update_node'), node: canvasNodeSchema }).strict();
const deleteNodeOperationSchema = z.object({ kind: z.literal('delete_node'), nodeId: z.string().min(1) }).strict();
const createEdgeOperationSchema = z.object({ kind: z.literal('create_edge'), edge: canvasEdgeSchema }).strict();
const deleteEdgeOperationSchema = z.object({ kind: z.literal('delete_edge'), edgeId: z.string().min(1) }).strict();
const reorderInputEdgesOperationSchema = z.object({
  kind: z.literal('reorder_input_edges'),
  targetNodeId: z.string().min(1),
  targetPortId: z.string().min(1),
  edgeIds: z.array(z.string().min(1)).min(1),
}).strict();

export const canvasOperationSchema = z.discriminatedUnion('kind', [
  createNodeOperationSchema,
  updateNodeOperationSchema,
  deleteNodeOperationSchema,
  createEdgeOperationSchema,
  deleteEdgeOperationSchema,
  reorderInputEdgesOperationSchema,
]);

export type CanvasOperation = z.infer<typeof canvasOperationSchema>;

export interface CanvasTransaction {
  id: string;
  label: string;
  operations: CanvasOperation[];
}

export interface AppliedCanvasTransaction {
  project: CanvasProject;
  inverse: CanvasTransaction;
}

type InternalInverseOperation = {
  kind: 'restore_edge_snapshot';
  edges: CanvasEdge[];
};

const inverseRestorations = new WeakMap<CanvasTransaction, Array<InternalInverseOperation | undefined>>();

export function applyTransaction(
  project: CanvasProject,
  transaction: CanvasTransaction,
): AppliedCanvasTransaction {
  const draft = parseCanvasProject(project);
  const inverseOperations: CanvasOperation[] = [];
  const inverseRestorationOperations: Array<InternalInverseOperation | undefined> = [];

  for (const operation of transaction.operations) {
    switch (operation.kind) {
      case 'create_node': {
        const node = canvasNodeSchema.parse(operation.node);
        if (draft.nodes.some((candidate) => candidate.id === node.id)) {
          throw new Error(`node id already exists: ${node.id}`);
        }
        draft.nodes.push(node);
        prependInverse(inverseOperations, inverseRestorationOperations, { kind: 'delete_node', nodeId: node.id });
        break;
      }

      case 'update_node': {
        const node = canvasNodeSchema.parse(operation.node);
        const index = draft.nodes.findIndex((candidate) => candidate.id === node.id);
        if (index < 0) {
          throw new Error(`node does not exist: ${node.id}`);
        }
        const previous = draft.nodes[index];
        if (!previous) {
          throw new Error(`node does not exist: ${node.id}`);
        }
        draft.nodes[index] = node;
        prependInverse(inverseOperations, inverseRestorationOperations, { kind: 'update_node', node: previous });
        break;
      }

      case 'delete_node': {
        const index = draft.nodes.findIndex((candidate) => candidate.id === operation.nodeId);
        if (index < 0) {
          throw new Error(`node does not exist: ${operation.nodeId}`);
        }
        if (draft.edges.some((edge) => edge.source === operation.nodeId || edge.target === operation.nodeId)) {
          throw new Error(`node has a connected edge: ${operation.nodeId}`);
        }
        const previous = draft.nodes[index];
        if (!previous) {
          throw new Error(`node does not exist: ${operation.nodeId}`);
        }
        draft.nodes.splice(index, 1);
        prependInverse(inverseOperations, inverseRestorationOperations, { kind: 'create_node', node: previous });
        break;
      }

      case 'create_edge': {
        const edge = canvasEdgeSchema.parse(operation.edge);
        if (draft.edges.some((candidate) => candidate.id === edge.id)) {
          throw new Error(`edge id already exists: ${edge.id}`);
        }
        if (!draft.nodes.some((node) => node.id === edge.source)) {
          throw new Error(`source node does not exist: ${edge.source}`);
        }
        if (!draft.nodes.some((node) => node.id === edge.target)) {
          throw new Error(`target node does not exist: ${edge.target}`);
        }
        if ((edge.sourcePortId !== undefined || edge.targetPortId !== undefined) && draft.edges.some((candidate) => (
          candidate.source === edge.source
          && candidate.sourcePortId === edge.sourcePortId
          && candidate.target === edge.target
          && candidate.targetPortId === edge.targetPortId
        ))) {
          throw new Error(`duplicate edge binding: ${edge.source}:${edge.sourcePortId ?? ''} -> ${edge.target}:${edge.targetPortId ?? ''}`);
        }
        const previousIssues = validateCanvasModuleGraph(draft);
        draft.edges.push(edge);
        rejectNewGraphIssues(previousIssues, validateCanvasModuleGraph(draft), edge.id);
        prependInverse(inverseOperations, inverseRestorationOperations, { kind: 'delete_edge', edgeId: edge.id });
        break;
      }

      case 'delete_edge': {
        const index = draft.edges.findIndex((candidate) => candidate.id === operation.edgeId);
        if (index < 0) {
          throw new Error(`edge does not exist: ${operation.edgeId}`);
        }
        const previous = draft.edges[index];
        if (!previous) {
          throw new Error(`edge does not exist: ${operation.edgeId}`);
        }
        const previousEdges = cloneEdges(draft.edges);
        draft.edges.splice(index, 1);
        prependInverse(
          inverseOperations,
          inverseRestorationOperations,
          { kind: 'create_edge', edge: previous },
          { kind: 'restore_edge_snapshot', edges: previousEdges },
        );
        break;
      }

      case 'reorder_input_edges': {
        const previousEdges = cloneEdges(draft.edges);
        const matching = draft.edges
          .map((edge, index) => ({ edge, index }))
          .filter(({ edge }) => edge.target === operation.targetNodeId && edge.targetPortId === operation.targetPortId)
          .sort((left, right) => {
            const leftOrder = left.edge.order ?? left.index;
            const rightOrder = right.edge.order ?? right.index;
            return leftOrder - rightOrder || left.index - right.index;
          });
        const previousEdgeIds = matching.map(({ edge }) => edge.id);
        draft.edges = reorderCanvasInputEdges(
          draft.edges,
          operation.targetNodeId,
          operation.targetPortId,
          operation.edgeIds,
        );
        prependInverse(
          inverseOperations,
          inverseRestorationOperations,
          {
            kind: 'reorder_input_edges',
            targetNodeId: operation.targetNodeId,
            targetPortId: operation.targetPortId,
            edgeIds: previousEdgeIds,
          },
          { kind: 'restore_edge_snapshot', edges: previousEdges },
        );
        break;
      }

      default: {
        const unknownOperation = operation as { kind?: unknown };
        throw new Error(`unsupported operation kind: ${String(unknownOperation.kind)}`);
      }
    }
  }

  const inverse = {
    id: `undo:${transaction.id}`,
    label: `Undo ${transaction.label}`,
    operations: inverseOperations,
  } satisfies CanvasTransaction;
  if (inverseRestorationOperations.some((operation) => operation !== undefined)) {
    inverseRestorations.set(inverse, inverseRestorationOperations);
  }

  return {
    project: draft,
    inverse,
  };
}

export function revertTransaction(
  project: CanvasProject,
  inverse: CanvasTransaction,
): CanvasProject {
  const restorations = inverseRestorations.get(inverse);
  if (restorations === undefined) {
    return applyTransaction(project, inverse).project;
  }

  let draft = parseCanvasProject(project);
  for (const [index, operation] of inverse.operations.entries()) {
    const restoration = restorations[index];
    if (restoration !== undefined) {
      draft = parseCanvasProject({ ...draft, edges: cloneEdges(restoration.edges) });
      continue;
    }
    if (operation === undefined) {
      throw new Error('inverse operation is missing');
    }
    draft = applyTransaction(draft, {
      id: inverse.id,
      label: inverse.label,
      operations: [operation],
    }).project;
  }
  return draft;
}

function prependInverse(
  inverseOperations: CanvasOperation[],
  inverseRestorationOperations: Array<InternalInverseOperation | undefined>,
  operation: CanvasOperation,
  restoration?: InternalInverseOperation,
): void {
  inverseOperations.unshift(operation);
  inverseRestorationOperations.unshift(restoration);
}

function cloneEdges(edges: readonly CanvasEdge[]): CanvasEdge[] {
  return edges.map((edge) => ({ ...edge }));
}

function rejectNewGraphIssues(
  previousIssues: readonly GraphValidationIssue[],
  currentIssues: readonly GraphValidationIssue[],
  edgeId: string,
): void {
  const previousIssueCounts = new Map<string, number>();
  for (const issue of previousIssues) {
    const key = graphIssueKey(issue);
    previousIssueCounts.set(key, (previousIssueCounts.get(key) ?? 0) + 1);
  }

  for (const issue of currentIssues) {
    const key = graphIssueKey(issue);
    const previousCount = previousIssueCounts.get(key) ?? 0;
    if (previousCount > 0) {
      previousIssueCounts.set(key, previousCount - 1);
      continue;
    }
    if (isConnectIssue(issue)) {
      throw new Error(`cannot connect edge ${edgeId}`);
    }
  }
}

function graphIssueKey(issue: GraphValidationIssue): string {
  return JSON.stringify([
    issue.code,
    issue.edgeId ?? null,
    issue.nodeId ?? null,
    issue.portId ?? null,
    issue.message,
  ]);
}

function isConnectIssue(issue: GraphValidationIssue): boolean {
  return issue.code === 'TYPE_MISMATCH'
    || issue.code === 'DIRECTION'
    || issue.code === 'INPUT_CARDINALITY'
    || issue.code === 'MISSING_PORT'
    || issue.code === 'CYCLE';
}
