import { describe, expect, it } from 'vitest';

import {
  applyProjectTransaction,
  createCanvasModuleNode,
  parseCanvasProject,
  projectImageAssetSchema,
  type CanvasProject,
  type ProjectImageAsset,
} from './index';

describe('project image assets', () => {
  const assetA: ProjectImageAsset = {
    assetId: '0123456789abcdef',
    byteSize: 128,
    extension: 'png',
    height: 1,
    label: 'Product front',
    mediaType: 'image/png',
    origin: 'imported',
    sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    width: 1,
  };

  it('keeps a unique sanitized asset catalog in project state', () => {
    const parsed = parseCanvasProject({
      ...emptyProject(),
      assets: [assetA],
    });

    expect(parsed.assets).toEqual([assetA]);
    expect(() => parseCanvasProject({
      ...emptyProject(),
      assets: [assetA, { ...assetA, label: 'Duplicate' }],
    })).toThrow(/asset id/i);
    const protectedLabel = ['file:', '', '', 'C:', 'Users', 'Private', 'product.png'].join('/');
    expect(() => projectImageAssetSchema.parse({
      ...assetA,
      label: protectedLabel,
    })).toThrow(/protected/i);
  });

  it('atomically replaces the durable asset catalog through a project transaction', () => {
    const project = emptyProject();
    const next = applyProjectTransaction(project, {
      id: 'asset-catalog-1',
      label: 'Import project image',
      operations: [{ kind: 'set_project_assets', assets: [assetA] }],
    });

    expect(next.assets).toEqual([assetA]);
    expect(project.assets).toBeUndefined();
  });

  it('caps ordered library references and requires managed module ids to exist in the project catalog', () => {
    const library = createCanvasModuleNode('library', 'canvas_library', { x: 0, y: 0 });
    const assetIds = Array.from({ length: 21 }, (_, index) => index.toString(16).padStart(16, '0'));
    library.data.config = { assetIds };
    const assets = assetIds.map((assetId, index) => ({
      ...assetA,
      assetId,
      label: `Asset ${index + 1}`,
      sha256: assetId.repeat(4),
    }));

    expect(() => parseCanvasProject({ ...emptyProject(), assets, nodes: [library] })).toThrow(/20/u);

    const input = createCanvasModuleNode('input', 'image_input', { x: 0, y: 0 });
    input.data.config = { assetId: assetA.assetId };
    expect(() => parseCanvasProject({ ...emptyProject(), nodes: [input] })).toThrow(/catalog/u);
  });
});

function emptyProject(): CanvasProject {
  return {
    version: 1,
    graphVersion: 2,
    id: 'asset-project',
    name: 'Asset Project',
    nodes: [],
    edges: [],
    projectMemory: [],
    skillPromotionCandidates: [],
  };
}
