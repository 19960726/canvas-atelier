import { describe, expect, it } from 'vitest';
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
});
