import { describe, expect, it } from 'vitest';
import { createCanvasModuleNode } from './canvas-module';
import { migrateCanvasProjectGraph, canConnectCanvasPorts, reorderCanvasInputEdges, validateCanvasModuleGraph } from './module-graph';
import { parseCanvasProject, type CanvasEdge, type CanvasModuleNode, type CanvasProject } from './project-schema';

describe('migrateCanvasProjectGraph', () => {
  it('adds graphVersion 2 to legacy projects', () => {
    expect(migrateCanvasProjectGraph({
      version: 1,
      id: 'p1',
      name: 'legacy graph',
      nodes: [],
      edges: [],
    })).toMatchObject({
      version: 1,
      graphVersion: 2,
      id: 'p1',
    });
  });

  it('treats prototype graphVersion as absent and returns an own graphVersion 2', () => {
    const legacyProject = Object.create({ graphVersion: 1 }) as {
      version: number;
      id: string;
      name: string;
      nodes: [];
      edges: [];
      graphVersion?: number;
    };
    legacyProject.version = 1;
    legacyProject.id = 'p1';
    legacyProject.name = 'prototype graph';
    legacyProject.nodes = [];
    legacyProject.edges = [];

    const migrated = migrateCanvasProjectGraph(legacyProject) as typeof legacyProject;

    expect(Object.prototype.hasOwnProperty.call(migrated, 'graphVersion')).toBe(true);
    expect(migrated.graphVersion).toBe(2);
  });

  it('preserves explicit graphVersion 2 without mutating graph data', () => {
    const project = {
      version: 1,
      graphVersion: 2 as const,
      id: 'p1',
      name: 'current graph',
      nodes: [{ id: 'n1' }],
      edges: [{ id: 'e1' }],
    };

    expect(migrateCanvasProjectGraph(project)).toEqual(project);
  });

  it('rejects unsupported explicit graph versions', () => {
    expect(() => migrateCanvasProjectGraph({
      version: 1,
      graphVersion: 1,
      id: 'p1',
      name: 'unsupported graph',
      nodes: [],
      edges: [],
    })).toThrow(/graphVersion/i);
  });
});

describe('canConnectCanvasPorts', () => {
  it('accepts prompt to generator and rejects prompt to references', () => {
    const prompt = createCanvasModuleNode('prompt', 'text_prompt', { x: 0, y: 0 });
    const generator = createCanvasModuleNode('generator', 'image_generation_v1', { x: 320, y: 0 });

    expect(canConnectCanvasPorts(prompt, 'prompt', generator, 'prompt')).toEqual({ ok: true });
    expect(canConnectCanvasPorts(prompt, 'prompt', generator, 'references')).toMatchObject({
      ok: false,
      code: 'TYPE_MISMATCH',
    });
  });

  it('accepts an image asset for an image list input', () => {
    const image = createCanvasModuleNode('image', 'image_input', { x: 0, y: 0 });
    const reverse = createCanvasModuleNode('reverse', 'reverse_agent', { x: 320, y: 0 });

    expect(canConnectCanvasPorts(image, 'image', reverse, 'references')).toEqual({ ok: true });
  });

  it('returns typed failures for missing ports and reversed direction', () => {
    const prompt = createCanvasModuleNode('prompt', 'text_prompt', { x: 0, y: 0 });
    const generator = createCanvasModuleNode('generator', 'image_generation_v1', { x: 320, y: 0 });

    expect(canConnectCanvasPorts(prompt, 'missing', generator, 'prompt')).toMatchObject({
      ok: false,
      code: 'MISSING_PORT',
    });
    expect(canConnectCanvasPorts(generator, 'prompt', prompt, 'prompt')).toMatchObject({
      ok: false,
      code: 'DIRECTION',
    });
  });
});

describe('validateCanvasModuleGraph', () => {
  it('rejects duplicate single-input bindings', () => {
    const project = moduleProject([
      createCanvasModuleNode('a', 'text_prompt', { x: 0, y: 0 }),
      createCanvasModuleNode('b', 'image_generation_v1', { x: 320, y: 0 }),
    ], [
      moduleEdge('edge-1', 'a', 'prompt', 'b', 'prompt', 0),
      moduleEdge('edge-2', 'a', 'prompt', 'b', 'prompt', 1),
    ]);

    expect(validateCanvasModuleGraph(project).map((issue) => issue.code)).toContain('INPUT_CARDINALITY');
  });

  it('reports malformed edges instead of throwing', () => {
    const project = moduleProject([
      createCanvasModuleNode('prompt', 'text_prompt', { x: 0, y: 0 }),
      createCanvasModuleNode('generator', 'image_generation_v1', { x: 320, y: 0 }),
    ], [
      moduleEdge('missing-node', 'missing', 'prompt', 'generator', 'prompt', 0),
      moduleEdge('missing-port', 'prompt', 'missing', 'generator', 'prompt', 1),
      { id: 'missing-handles', source: 'prompt', target: 'generator' },
    ]);

    expect(() => validateCanvasModuleGraph(project)).not.toThrow();
    expect(validateCanvasModuleGraph(project).map((issue) => issue.code)).toEqual([
      'MISSING_NODE',
      'MISSING_PORT',
      'MISSING_PORT',
      'MISSING_PORT',
      'MISSING_PORT',
    ]);
  });

  it('rejects a self-cycle', () => {
    const editor = createCanvasModuleNode('editor', 'image_editor', { x: 0, y: 0 });
    const project = moduleProject([editor], [
      moduleEdge('self-cycle', 'editor', 'image', 'editor', 'image', 0),
    ]);

    expect(validateCanvasModuleGraph(project).map((issue) => issue.code)).toContain('CYCLE');
  });

  it('rejects a directed cycle', () => {
    const nodes = [
      createCanvasModuleNode('editor-a', 'image_editor', { x: 0, y: 0 }),
      createCanvasModuleNode('editor-b', 'image_editor', { x: 320, y: 0 }),
    ];
    const project = moduleProject(nodes, [
      moduleEdge('edge-a', 'editor-a', 'image', 'editor-b', 'image', 0),
      moduleEdge('edge-b', 'editor-b', 'image', 'editor-a', 'image', 0),
    ]);

    expect(validateCanvasModuleGraph(project).map((issue) => issue.code)).toContain('CYCLE');
  });
});

describe('reorderCanvasInputEdges', () => {
  it('reorders a many-input list without changing unrelated edges', () => {
    const edges = [
      moduleEdge('a', 'image-a', 'image', 'reverse', 'references', 0),
      moduleEdge('b', 'image-b', 'image', 'reverse', 'references', 1),
      moduleEdge('prompt', 'text', 'prompt', 'generator', 'prompt', 0),
    ];

    const result = reorderCanvasInputEdges(edges, 'reverse', 'references', ['b', 'a']);

    expect(result.map((edge) => [edge.id, edge.order])).toEqual([['a', 1], ['b', 0], ['prompt', 0]]);
    expect(result[2]).toBe(edges[2]);
  });

  it('requires an exact permutation of matching edge ids', () => {
    const edges = [
      moduleEdge('a', 'image-a', 'image', 'reverse', 'references', 0),
      moduleEdge('b', 'image-b', 'image', 'reverse', 'references', 1),
    ];

    expect(() => reorderCanvasInputEdges(edges, 'reverse', 'references', ['b', 'b'])).toThrow(/exact permutation/i);
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

function moduleProject(nodes: CanvasModuleNode[], edges: CanvasEdge[]): CanvasProject {
  return parseCanvasProject({
    version: 1,
    graphVersion: 2,
    id: 'module-project',
    name: 'module project',
    nodes,
    edges,
  });
}
