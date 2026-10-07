import { describe, expect, it } from 'vitest';
import { createCanvasModuleNode } from './canvas-module';
import { canConnectCanvasPorts, validateCanvasModuleGraph } from './module-graph';
import { parseCanvasProject } from './project-schema';

describe('shared library video media compatibility', () => {
  it('accepts the ordered image collection at the video-generation media input', () => {
    const library = createCanvasModuleNode('library', 'canvas_library', { x: 100, y: 100 });
    const target = createCanvasModuleNode('target', 'video_generation', { x: 700, y: 100 });
    expect(canConnectCanvasPorts(library, 'images', target, 'media')).toEqual({ ok: true });
  });

  it('validates a saved library group alongside an independent video-generation image edge', () => {
    const assets = Array.from({ length: 3 }, (_, index) => ({
      assetId: (index + 1).toString(16).padStart(16, '0'), sha256: (index + 1).toString(16).padStart(16, '0').repeat(4),
      byteSize: 42, extension: 'png', mediaType: 'image/png', origin: 'imported',
      width: 800, height: 600, label: `Owned reference ${index + 1}`,
    }));
    const library = createCanvasModuleNode('library', 'canvas_library', { x: 100, y: 100 });
    library.data.config.assetIds = assets.slice(0, 2).map(asset => asset.assetId);
    const image = createCanvasModuleNode('single', 'image_input', { x: 100, y: 500 });
    image.data.config.assetId = assets[2]!.assetId;
    const target = createCanvasModuleNode('target', 'video_generation', { x: 700, y: 100 });
    const project = parseCanvasProject({ version: 1, graphVersion: 2, id: 'library-video', name: 'Library video',
      nodes: [library, image, target], assets, edges: [
        { id: 'group', source: library.id, sourcePortId: 'images', target: target.id, targetPortId: 'media', order: 0 },
        { id: 'single', source: image.id, sourcePortId: 'image', target: target.id, targetPortId: 'media', order: 1 },
      ] });
    expect(validateCanvasModuleGraph(project)).toEqual([]);
    expect(parseCanvasProject(project)).toEqual(project);
    expect(library.data.config.assetIds).toEqual(assets.slice(0, 2).map(asset => asset.assetId));
  });

  it.each(['firstFrame', 'lastFrame', 'sourceVideo'] as const)
  ('keeps the library incompatible with the scalar video %s input', port => {
    const library = createCanvasModuleNode('library', 'canvas_library', { x: 100, y: 100 });
    const target = createCanvasModuleNode('target', 'video_generation', { x: 700, y: 100 });
    expect(canConnectCanvasPorts(library, 'images', target, port)).toMatchObject({ ok: false, code: 'TYPE_MISMATCH' });
  });

  it('keeps unsupported reverse library media connections rejected', () => {
    const library = createCanvasModuleNode('library', 'canvas_library', { x: 100, y: 100 });
    const target = createCanvasModuleNode('target', 'reverse_agent', { x: 700, y: 100 });
    expect(canConnectCanvasPorts(library, 'images', target, 'references')).toMatchObject({ ok: false, code: 'TYPE_MISMATCH' });
  });
});
