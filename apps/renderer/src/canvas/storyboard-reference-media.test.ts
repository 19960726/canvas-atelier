import { describe, expect, it } from 'vitest';
import { createCanvasModuleNode, type CanvasProject } from '@agent-canvas/domain';

import { resolveConnectedStoryboardReferences } from './storyboard-reference-media';

describe('resolveConnectedStoryboardReferences', () => {
  it('snapshots only managed image assets connected to the storyboard images port in edge order', () => {
    const first = createCanvasModuleNode('first', 'image_input', { x: 0, y: 0 });
    first.data.config = { assetId: 'asset-a' };
    const library = createCanvasModuleNode('library', 'canvas_library', { x: 0, y: 120 });
    library.data.config = { assetIds: ['asset-b', 'asset-c'] };
    const unrelated = createCanvasModuleNode('unrelated', 'image_input', { x: 0, y: 240 });
    unrelated.data.config = { assetId: 'asset-x' };
    const storyboard = createCanvasModuleNode('storyboard', 'storyboard_sheet', { x: 360, y: 0 });
    const project = {
      id: 'project-1',
      assets: [
        { assetId: 'asset-a', mediaType: 'image/png' },
        { assetId: 'asset-b', mediaType: 'image/jpeg' },
        { assetId: 'asset-c', mediaType: 'image/webp' },
        { assetId: 'asset-x', mediaType: 'image/png' },
      ],
      nodes: [first, library, unrelated, storyboard],
      edges: [
        { id: 'first-edge', source: first.id, sourcePortId: 'image', target: storyboard.id, targetPortId: 'images', order: 20 },
        { id: 'library-edge', source: library.id, sourcePortId: 'images', target: storyboard.id, targetPortId: 'images', order: 10 },
      ],
    } as unknown as CanvasProject;

    expect(resolveConnectedStoryboardReferences({ project, nodeId: storyboard.id })).toEqual({
      ok: true,
      assetIds: ['asset-b', 'asset-c', 'asset-a'],
    });
  });

  it('blocks an un-managed or incompatible connected source instead of forwarding its asset identifier', () => {
    const video = createCanvasModuleNode('video', 'video_input', { x: 0, y: 0 });
    video.data.config = { assetId: 'video-asset' };
    const storyboard = createCanvasModuleNode('storyboard', 'storyboard_sheet', { x: 360, y: 0 });
    const project = {
      id: 'project-1',
      assets: [{ assetId: 'video-asset', mediaType: 'video/mp4' }],
      nodes: [video, storyboard],
      edges: [{ id: 'bad-edge', source: video.id, sourcePortId: 'video', target: storyboard.id, targetPortId: 'images', order: 0 }],
    } as unknown as CanvasProject;

    expect(resolveConnectedStoryboardReferences({ project, nodeId: storyboard.id })).toMatchObject({ ok: false });
  });
});
