import { describe, expect, it } from 'vitest';
import * as publicApi from './index';
import { parseCanvasProject } from './project-schema';

describe('parseCanvasProject', () => {
  it('rejects a reference node without a role', () => {
    expect(() => parseCanvasProject({
      version: 1,
      id: 'p1',
      name: 'test project',
      nodes: [{ id: 'r1', type: 'reference', position: { x: 0, y: 0 }, data: { assetId: 'asset-1' } }],
      edges: []
    })).toThrow(/role/);
  });

  it('rejects provider secrets in reference data', () => {
    expect(() => parseCanvasProject({
      version: 1,
      id: 'p1',
      name: 'test project',
      nodes: [{
        id: 'r1',
        type: 'reference',
        position: { x: 0, y: 0 },
        data: { assetId: 'asset-1', role: 'product_identity', apiKey: 'secret' }
      }],
      edges: []
    })).toThrow(/Unrecognized key/);
  });

  it('rejects extra image metadata in reference data', () => {
    expect(() => parseCanvasProject({
      version: 1,
      id: 'p1',
      name: 'test project',
      nodes: [{
        id: 'r1',
        type: 'reference',
        position: { x: 0, y: 0 },
        data: { assetId: 'asset-1', role: 'product_identity', mimeType: 'image/png' }
      }],
      edges: []
    })).toThrow(/Unrecognized key/);
  });

  it('accepts placement board metadata and objects as siblings', () => {
    const project = parseCanvasProject({
      version: 1,
      id: 'p1',
      name: 'test project',
      nodes: [{
        id: 'placement-1',
        type: 'placement_preview',
        position: { x: 0, y: 0 },
        data: {
          board: {
            id: 'board-1',
            aspectRatio: '4:5',
            width: 1080,
            height: 1350,
            safeAreas: []
          },
          objects: [{
            id: 'product-1',
            assetId: 'asset-1',
            role: 'product_identity',
            x: 0.34,
            y: 0.42,
            w: 0.32,
            h: 0.38,
            rotation: 0,
            zIndex: 20,
            locked: false,
            visible: true,
            flipX: false,
            flipY: false,
            semanticLayer: 'hero_product'
          }]
        }
      }],
      edges: []
    });

    expect(project.nodes[0]?.type).toBe('placement_preview');
  });
});

describe('public domain API', () => {
  it('exposes only the approved runtime functions', () => {
    expect(Object.keys(publicApi).sort()).toEqual([
      'applyTransaction',
      'parseCanvasProject',
      'revertTransaction',
    ]);
  });
});
