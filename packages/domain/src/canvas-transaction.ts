import {
  canvasEdgeSchema,
  canvasNodeSchema,
  parseCanvasProject,
  type CanvasProject,
} from './project-schema';
import { z } from 'zod';

const createNodeOperationSchema = z.object({ kind: z.literal('create_node'), node: canvasNodeSchema }).strict();
const updateNodeOperationSchema = z.object({ kind: z.literal('update_node'), node: canvasNodeSchema }).strict();
const deleteNodeOperationSchema = z.object({ kind: z.literal('delete_node'), nodeId: z.string().min(1) }).strict();
const createEdgeOperationSchema = z.object({ kind: z.literal('create_edge'), edge: canvasEdgeSchema }).strict();
const deleteEdgeOperationSchema = z.object({ kind: z.literal('delete_edge'), edgeId: z.string().min(1) }).strict();

export const canvasOperationSchema = z.discriminatedUnion('kind', [
  createNodeOperationSchema,
  updateNodeOperationSchema,
  deleteNodeOperationSchema,
  createEdgeOperationSchema,
  deleteEdgeOperationSchema,
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

export function applyTransaction(
  project: CanvasProject,
  transaction: CanvasTransaction,
): AppliedCanvasTransaction {
  const draft = parseCanvasProject(project);
  const inverseOperations: CanvasOperation[] = [];

  for (const operation of transaction.operations) {
    switch (operation.kind) {
      case 'create_node': {
        const node = canvasNodeSchema.parse(operation.node);
        if (draft.nodes.some((candidate) => candidate.id === node.id)) {
          throw new Error(`node id already exists: ${node.id}`);
        }
        draft.nodes.push(node);
        inverseOperations.unshift({ kind: 'delete_node', nodeId: node.id });
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
        inverseOperations.unshift({ kind: 'update_node', node: previous });
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
        inverseOperations.unshift({ kind: 'create_node', node: previous });
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
        draft.edges.push(edge);
        inverseOperations.unshift({ kind: 'delete_edge', edgeId: edge.id });
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
        draft.edges.splice(index, 1);
        inverseOperations.unshift({ kind: 'create_edge', edge: previous });
        break;
      }

      default: {
        const unknownOperation = operation as { kind?: unknown };
        throw new Error(`unsupported operation kind: ${String(unknownOperation.kind)}`);
      }
    }
  }

  return {
    project: draft,
    inverse: {
      id: `undo:${transaction.id}`,
      label: `Undo ${transaction.label}`,
      operations: inverseOperations,
    },
  };
}

export function revertTransaction(
  project: CanvasProject,
  inverse: CanvasTransaction,
): CanvasProject {
  return applyTransaction(project, inverse).project;
}
