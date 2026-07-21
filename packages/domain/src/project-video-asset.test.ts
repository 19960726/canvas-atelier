import { describe, expect, it } from 'vitest';

import {
  createCanvasModuleNode,
  parseCanvasProject,
  projectVideoAssetSchema,
  type CanvasProject,
  type ProjectVideoAsset,
} from './index';

describe('project video assets', () => {
  const video: ProjectVideoAsset = {
    assetId: '0123456789abcdef',
    byteSize: 1024,
    durationMs: null,
    extension: 'mp4',
    height: null,
    label: 'Product turntable',
    mediaType: 'video/mp4',
    origin: 'imported',
    sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    width: null,
  };

  it('accepts a sanitized MP4 asset and requires video nodes to reference the catalog', () => {
    const node = createCanvasModuleNode('video-1', 'video_input', { x: 10, y: 20 });
    node.data.config = { assetId: video.assetId };

    expect(parseCanvasProject({ ...emptyProject(), assets: [video], nodes: [node] }).assets).toEqual([video]);
    expect(() => parseCanvasProject({ ...emptyProject(), nodes: [node] })).toThrow(/catalog/u);
  });

  it('rejects mismatched media metadata and protected labels', () => {
    expect(() => projectVideoAssetSchema.parse({ ...video, mediaType: 'image/png' })).toThrow();
    expect(() => projectVideoAssetSchema.parse({ ...video, extension: 'mov' })).toThrow();
    expect(() => projectVideoAssetSchema.parse({ ...video, label: 'C:/Users/Private/source.mp4' })).toThrow(/protected/i);
  });
});

function emptyProject(): CanvasProject {
  return {
    version: 1,
    graphVersion: 2,
    id: 'video-project',
    name: 'Video Project',
    nodes: [],
    edges: [],
    projectMemory: [],
    skillPromotionCandidates: [],
  };
}
