import { describe, expect, it } from 'vitest';
import { createCanvasModuleNode } from './canvas-module';
import type { CanvasEdge, CanvasNode, CanvasProject } from './project-schema';
import { parseCanvasProject } from './project-schema';
import { applyTransaction, canvasOperationSchema, revertTransaction } from './canvas-transaction';

const emptyProject: CanvasProject = {
  version: 1,
  id: 'project-1',
  name: 'test project',
  nodes: [],
  edges: [],
  projectMemory: [],
  skillPromotionCandidates: [],
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
    expect(revertTransaction(result.project, result.inverse)).toEqual(parseCanvasProject(emptyProject));
  });

  it('does not mutate the input project when a later operation is invalid', () => {
    const snapshot = JSON.parse(JSON.stringify(emptyProject)) as CanvasProject;

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
    expect(revertTransaction(result.project, result.inverse)).toEqual(parseCanvasProject(project));
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

  it('rejects an incompatible typed edge without mutating input', () => {
    const project = moduleProjectWithPromptAndGenerator();
    const snapshot = JSON.parse(JSON.stringify(project)) as CanvasProject;

    expect(() => applyTransaction(project, {
      id: 'bad-edge',
      label: 'bad edge',
      operations: [{
        kind: 'create_edge',
        edge: moduleEdge('bad', 'prompt', 'prompt', 'generator', 'references', 0),
      }],
    })).toThrow(/cannot connect/i);

    expect(project).toEqual(snapshot);
  });

  it('reorders many-input edges and creates an exact inverse', () => {
    const project = moduleProjectWithTwoReferences();
    const result = applyTransaction(project, {
      id: 'reorder',
      label: 'Reorder references',
      operations: [{
        kind: 'reorder_input_edges',
        targetNodeId: 'reverse',
        targetPortId: 'references',
        edgeIds: ['edge-b', 'edge-a'],
      }],
    });

    expect(result.project.edges
      .filter((edge) => edge.target === 'reverse')
      .map((edge) => [edge.id, edge.order]))
      .toEqual([['edge-a', 1], ['edge-b', 0]]);
    expect(revertTransaction(result.project, result.inverse)).toEqual(project);
  });

  it('restores exact edge snapshots after delete then reorder', () => {
    const project = moduleProjectWithMalformedReorderEdges();
    const result = applyTransaction(project, {
      id: 'delete-then-reorder',
      label: 'Delete then reorder references',
      operations: [
        { kind: 'delete_edge', edgeId: 'duplicate-edge' },
        {
          kind: 'reorder_input_edges',
          targetNodeId: 'reverse',
          targetPortId: 'references',
          edgeIds: ['edge-b', 'edge-a', 'edge-before'],
        },
      ],
    });

    expect(result.project.edges
      .filter((edge) => edge.target === 'reverse')
      .map((edge) => [edge.id, edge.order]))
      .toEqual([
        ['edge-before', 2],
        ['edge-a', 1],
        ['edge-b', 0],
      ]);
    expect(revertTransaction(result.project, result.inverse)).toEqual(project);
  });

  it('does not expose an internal inverse restoration operation through the public schema', () => {
    expect(() => canvasOperationSchema.parse({
      kind: 'restore_edge_snapshot',
      edges: [],
    })).toThrow();
  });
});

function moduleEdge(
  id: string,
  source: string,
  sourcePortId: string,
  target: string,
  targetPortId: string,
  order: number,
): CanvasEdge {
  return { id, source, sourcePortId, target, targetPortId, order };
}

function moduleProjectWithPromptAndGenerator(): CanvasProject {
  return parseCanvasProject({
    version: 1,
    graphVersion: 2,
    id: 'typed-edge-project',
    name: 'typed edge project',
    nodes: [
      createCanvasModuleNode('prompt', 'text_prompt', { x: 0, y: 0 }),
      createCanvasModuleNode('generator', 'image_generation_v1', { x: 320, y: 0 }),
    ],
    edges: [],
  });
}

function moduleProjectWithTwoReferences(): CanvasProject {
  return parseCanvasProject({
    version: 1,
    graphVersion: 2,
    id: 'reorder-project',
    name: 'reorder project',
    nodes: [
      createCanvasModuleNode('image-a', 'image_input', { x: 0, y: 0 }),
      createCanvasModuleNode('image-b', 'image_input', { x: 0, y: 160 }),
      createCanvasModuleNode('reverse', 'reverse_agent', { x: 360, y: 80 }),
    ],
    edges: [
      moduleEdge('edge-a', 'image-a', 'image', 'reverse', 'references', 0),
      moduleEdge('edge-b', 'image-b', 'image', 'reverse', 'references', 1),
    ],
  });
}

function moduleProjectWithMalformedReorderEdges(): CanvasProject {
  return parseCanvasProject({
    version: 1,
    graphVersion: 2,
    id: 'malformed-reorder-project',
    name: 'malformed reorder project',
    nodes: [
      createCanvasModuleNode('image-a', 'image_input', { x: 0, y: 0 }),
      createCanvasModuleNode('image-b', 'image_input', { x: 0, y: 160 }),
      createCanvasModuleNode('reverse', 'reverse_agent', { x: 360, y: 80 }),
      { id: 'legacy-source', type: 'reference', position: { x: 0, y: 320 }, data: { assetId: 'asset-legacy-source', role: 'product_identity' } },
      { id: 'legacy-target', type: 'prompt', position: { x: 360, y: 320 }, data: { prompt: 'legacy target', requirementIds: [] } },
    ],
    edges: [
      { id: 'edge-before', source: 'image-a', sourcePortId: 'image', target: 'reverse', targetPortId: 'references', order: 5, label: 'before' },
      { id: 'duplicate-edge', source: 'missing-source', sourcePortId: 'image', target: 'reverse', targetPortId: 'references', order: 10, label: 'dangling' },
      { id: 'edge-a', source: 'image-a', sourcePortId: 'image', target: 'reverse', targetPortId: 'references', order: 20, label: 'A' },
      { id: 'edge-b', source: 'image-b', sourcePortId: 'image', target: 'reverse', targetPortId: 'references', order: 30, label: 'B' },
      { id: 'duplicate-edge', source: 'legacy-source', target: 'legacy-target', label: 'duplicate id' },
    ],
  });
}
