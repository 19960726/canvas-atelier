import { describe, expect, it } from 'vitest';
import type { CanvasNode, CanvasProject } from './project-schema';
import { applyTransaction, revertTransaction } from './canvas-transaction';

const emptyProject: CanvasProject = {
  version: 1,
  id: 'project-1',
  name: 'test project',
  nodes: [],
  edges: [],
  projectMemory: [],
};

const referenceNode: CanvasNode = {
  id: 'ref-1',
  type: 'reference',
  position: { x: 0, y: 0 },
  data: { assetId: 'asset-1', role: 'product_identity' },
};

const promptNode: CanvasNode = {
  id: 'prompt-1',
  type: 'prompt',
  position: { x: 320, y: 0 },
  data: { prompt: 'product poster', requirementIds: [] },
};

describe('canvas transactions', () => {
  it('applies all operations and creates an inverse transaction', () => {
    const result = applyTransaction(emptyProject, {
      id: 'tx-1',
      label: 'Agent create plan',
      operations: [
        { kind: 'create_node', node: referenceNode },
        { kind: 'create_node', node: promptNode },
        { kind: 'create_edge', edge: { id: 'edge-1', source: 'ref-1', target: 'prompt-1' } },
      ],
    });

    expect(result.project.nodes).toHaveLength(2);
    expect(result.project.edges).toHaveLength(1);
    expect(revertTransaction(result.project, result.inverse)).toEqual(emptyProject);
  });

  it('does not mutate the input project when a later operation is invalid', () => {
    const snapshot = structuredClone(emptyProject);

    expect(() => applyTransaction(emptyProject, {
      id: 'tx-invalid',
      label: 'invalid plan',
      operations: [
        { kind: 'create_node', node: referenceNode },
        { kind: 'create_edge', edge: { id: 'edge-1', source: 'ref-1', target: 'missing-node' } },
      ],
    })).toThrow(/target/);

    expect(emptyProject).toEqual(snapshot);
  });

  it('restores replaced nodes through the inverse transaction', () => {
    const project = { ...emptyProject, nodes: [referenceNode] };
    const movedNode = { ...referenceNode, position: { x: 50, y: 75 } };
    const result = applyTransaction(project, {
      id: 'tx-update',
      label: 'move node',
      operations: [{ kind: 'update_node', node: movedNode }],
    });

    expect(result.project.nodes[0]?.position).toEqual({ x: 50, y: 75 });
    expect(revertTransaction(result.project, result.inverse)).toEqual(project);
  });

  it('rejects unknown operation kinds from runtime input', () => {
    expect(() => applyTransaction(emptyProject, {
      id: 'tx-unknown',
      label: 'unknown operation',
      operations: [{ kind: 'unknown_operation' } as never],
    })).toThrow(/unsupported operation kind/);
  });

  it('requires connected edges to be deleted before their node', () => {
    const project = applyTransaction(emptyProject, {
      id: 'setup',
      label: 'setup',
      operations: [
        { kind: 'create_node', node: referenceNode },
        { kind: 'create_node', node: promptNode },
        { kind: 'create_edge', edge: { id: 'edge-1', source: 'ref-1', target: 'prompt-1' } },
      ],
    }).project;

    expect(() => applyTransaction(project, {
      id: 'delete-invalid',
      label: 'delete connected node',
      operations: [{ kind: 'delete_node', nodeId: 'ref-1' }],
    })).toThrow(/connected edge/);
  });
});
