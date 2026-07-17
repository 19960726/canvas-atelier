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
