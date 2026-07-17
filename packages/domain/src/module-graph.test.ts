import { describe, expect, it } from 'vitest';
import { migrateCanvasProjectGraph } from './module-graph';

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
