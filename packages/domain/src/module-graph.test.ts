import { describe, expect, it } from 'vitest';
import { createCanvasModuleNode, listCanvasModuleDefinitions } from './canvas-module';
import {
  migrateCanvasProjectGraph,
  canConnectCanvasPorts,
  reorderCanvasInputEdges,
  validateCanvasModuleExecutionReadiness,
  validateCanvasModuleGraph,
} from './module-graph';
import { parseCanvasProject, type CanvasEdge, type CanvasModuleNode, type CanvasNode, type CanvasProject } from './project-schema';
import type { RuntimeProfileId } from './runtime-profile';

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
    const generator = createCanvasModuleNode('generator', 'image_generation', { x: 320, y: 0 });

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
    const generator = createCanvasModuleNode('generator', 'image_generation', { x: 320, y: 0 });

    expect(canConnectCanvasPorts(prompt, 'missing', generator, 'prompt')).toMatchObject({
      ok: false,
      code: 'MISSING_PORT',
    });
    expect(canConnectCanvasPorts(generator, 'prompt', prompt, 'prompt')).toMatchObject({
      ok: false,
      code: 'DIRECTION',
    });
  });

  it('resolves duplicate editor port ids by direction', () => {
    const editorA = createCanvasModuleNode('editor-a', 'image_editor', { x: 0, y: 0 });
    const editorB = createCanvasModuleNode('editor-b', 'image_editor', { x: 320, y: 0 });
    const generator = createCanvasModuleNode('generator', 'image_generation', { x: 640, y: 0 });
    const prompt = createCanvasModuleNode('prompt', 'text_prompt', { x: 960, y: 0 });

    expect(canConnectCanvasPorts(editorA, 'image', editorB, 'image')).toEqual({ ok: true });
    expect(canConnectCanvasPorts(generator, 'prompt', editorB, 'image')).toMatchObject({ ok: false, code: 'DIRECTION' });
    expect(canConnectCanvasPorts(editorA, 'image', prompt, 'prompt')).toMatchObject({ ok: false, code: 'DIRECTION' });
  });
});

describe('validateCanvasModuleGraph', () => {
  it('rejects duplicate single-input bindings', () => {
    const project = moduleProject([
      createCanvasModuleNode('a', 'text_prompt', { x: 0, y: 0 }),
      createCanvasModuleNode('b', 'image_generation', { x: 320, y: 0 }),
    ], [
      moduleEdge('edge-1', 'a', 'prompt', 'b', 'prompt', 0),
      moduleEdge('edge-2', 'a', 'prompt', 'b', 'prompt', 1),
    ]);

    expect(validateCanvasModuleGraph(project).map((issue) => issue.code)).toContain('INPUT_CARDINALITY');
  });

  it('reports malformed edges instead of throwing', () => {
    const project = moduleProject([
      createCanvasModuleNode('prompt', 'text_prompt', { x: 0, y: 0 }),
      createCanvasModuleNode('generator', 'image_generation', { x: 320, y: 0 }),
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

  it('reports missing port metadata for the correct endpoint', () => {
    const project = moduleProject([
      createCanvasModuleNode('source', 'text_prompt', { x: 0, y: 0 }),
      createCanvasModuleNode('target', 'image_generation', { x: 320, y: 0 }),
    ], [
      moduleEdge('bad-source-port', 'source', 'missing', 'target', 'prompt', 0),
      moduleEdge('bad-target-port', 'source', 'prompt', 'target', 'missing', 0),
    ]);

    expect(validateCanvasModuleGraph(project).filter((issue) => issue.code === 'MISSING_PORT')).toMatchObject([
      { edgeId: 'bad-source-port', nodeId: 'source', portId: 'missing' },
      { edgeId: 'bad-target-port', nodeId: 'target', portId: 'missing' },
    ]);
  });

  it('reports unsupported runtime profiles for module nodes', () => {
    const project = moduleProject([
      createCanvasModuleNode('prompt', 'text_prompt', { x: 0, y: 0 }),
    ], []);

    expect(validateCanvasModuleGraph(project, 'unsupported' as RuntimeProfileId)).toMatchObject([
      { code: 'RUNTIME_UNSUPPORTED', nodeId: 'prompt' },
    ]);
  });

  it('keeps legacy-only edges compatible while validating mixed module edges', () => {
    const project = moduleProject([
      legacyNode('legacy-source'),
      legacyNode('legacy-target'),
      createCanvasModuleNode('module', 'image_editor', { x: 320, y: 0 }),
    ], [
      { id: 'legacy-only', source: 'legacy-source', target: 'legacy-target' },
      { id: 'legacy-to-module-missing', source: 'legacy-source', target: 'module' },
      { id: 'module-to-legacy-missing', source: 'module', target: 'legacy-target' },
      { id: 'legacy-to-module-valid', source: 'legacy-source', target: 'module', targetPortId: 'image', order: 0 },
      { id: 'module-to-legacy-valid', source: 'module', sourcePortId: 'image', target: 'legacy-target', order: 0 },
    ]);

    expect(validateCanvasModuleGraph(project).map((issue) => [issue.edgeId, issue.code])).toEqual([
      ['legacy-to-module-missing', 'MISSING_PORT'],
      ['legacy-to-module-missing', 'MISSING_PORT'],
      ['module-to-legacy-missing', 'MISSING_PORT'],
      ['module-to-legacy-missing', 'MISSING_PORT'],
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

describe('validateCanvasModuleExecutionReadiness', () => {
  it('keeps empty nodes parseable while reporting every required input only at execution time', () => {
    const definitions = listCanvasModuleDefinitions();
    for (const definition of definitions) {
      const requiredPortIds = definition.ports
        .filter((port) => port.direction === 'input' && port.required)
        .map((port) => port.id);
      if (requiredPortIds.length === 0) continue;
      const node = createCanvasModuleNode(`node-${definition.type}`, definition.type, { x: 0, y: 0 });
      const project = moduleProject([node], []);

      expect(project.nodes).toHaveLength(1);
      expect(validateCanvasModuleExecutionReadiness(project, node.id).filter((issue) => issue.code === 'REQUIRED_INPUT').map((issue) => issue.portId))
        .toEqual(requiredPortIds);
    }
  });

  it.each([
    ['image_editor', 'image', 'references'],
    ['video_input', 'video', 'video'],
    ['text_prompt', 'prompt', 'task'],
    ['image_editor', 'image', 'line_art'],
  ] as const)('accepts a Reverse Agent with one analyzable %s input', (sourceType, sourcePortId, targetPortId) => {
    const source = createCanvasModuleNode('source', sourceType, { x: 0, y: 0 });
    source.data.config = sourceType === 'video_input'
      ? { assetId: 'managed-video-1' }
      : sourceType === 'text_prompt'
        ? { prompt: 'analyze this input' }
        : {};
    const reverse = createCanvasModuleNode('reverse', 'reverse_agent', { x: 320, y: 0 });
    const project = moduleProject([source, reverse], [
      moduleEdge('input', source.id, sourcePortId, reverse.id, targetPortId, 0),
    ]);

    expect(validateCanvasModuleExecutionReadiness(project, reverse.id)).toEqual([]);
  });

  it('rejects an empty Reverse Agent without making node creation invalid', () => {
    const reverse = createCanvasModuleNode('reverse', 'reverse_agent', { x: 0, y: 0 });
    const project = moduleProject([reverse], []);

    expect(validateCanvasModuleExecutionReadiness(project, reverse.id)).toEqual([expect.objectContaining({
      code: 'ANALYZABLE_INPUT',
      nodeId: 'reverse',
    })]);
  });

  it('enforces the two-image comparison boundary', () => {
    const imageA = createCanvasModuleNode('image-a', 'image_editor', { x: 0, y: 0 });
    const imageB = createCanvasModuleNode('image-b', 'image_editor', { x: 0, y: 220 });
    const compare = createCanvasModuleNode('compare', 'image_compare', { x: 320, y: 0 });
    const oneImage = moduleProject([imageA, imageB, compare], [
      moduleEdge('image-a', imageA.id, 'image', compare.id, 'images', 0),
    ]);
    const twoImages = moduleProject([imageA, imageB, compare], [
      ...oneImage.edges,
      moduleEdge('image-b', imageB.id, 'image', compare.id, 'images', 1),
    ]);

    expect(validateCanvasModuleExecutionReadiness(oneImage, compare.id)).toEqual([expect.objectContaining({
      code: 'MINIMUM_INPUTS',
      nodeId: 'compare',
      portId: 'images',
    })]);
    expect(validateCanvasModuleExecutionReadiness(twoImages, compare.id)).toEqual([]);
  });

  it('accepts required ports after compatible edges are connected', () => {
    const prompt = createCanvasModuleNode('prompt', 'text_prompt', { x: 0, y: 0 });
    prompt.data.config = { prompt: 'studio light' };
    const generation = createCanvasModuleNode('generation', 'image_generation', { x: 320, y: 0 });
    const project = moduleProject([prompt, generation], [
      moduleEdge('prompt', prompt.id, 'prompt', generation.id, 'prompt', 0),
    ]);

    expect(validateCanvasModuleExecutionReadiness(project, generation.id)).toEqual([]);
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

  it('rejects duplicate matching edge ids before assigning requested order', () => {
    const edges = [
      moduleEdge('duplicate', 'image-a', 'image', 'reverse', 'references', 0),
      moduleEdge('duplicate', 'image-b', 'image', 'reverse', 'references', 1),
    ];

    expect(() => reorderCanvasInputEdges(edges, 'reverse', 'references', ['duplicate', 'duplicate']))
      .toThrow(/exact permutation/i);
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

function moduleProject(nodes: CanvasNode[], edges: CanvasEdge[]): CanvasProject {
  return parseCanvasProject({
    version: 1,
    graphVersion: 2,
    id: 'module-project',
    name: 'module project',
    nodes,
    edges,
  });
}

function legacyNode(id: string): CanvasNode {
  return {
    id,
    type: 'reference',
    position: { x: 0, y: 0 },
    data: { assetId: `asset-${id}`, role: 'product_identity' },
  };
}
