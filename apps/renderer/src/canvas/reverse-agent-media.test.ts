import { describe, expect, it } from 'vitest';
import { createCanvasModuleNode, type CanvasProject } from '@agent-canvas/domain';
import { mergeReverseCitationImages, resolveConnectedReverseMedia } from './reverse-agent-media';

const image = {
  assetId: '0123456789abcdef',
  sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  byteSize: 42,
  mediaType: 'image/png' as const,
};

const unrelatedImage = {
  assetId: 'fedcba9876543210',
  sha256: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
  byteSize: 43,
  mediaType: 'image/png' as const,
};

describe('mergeReverseCitationImages', () => {
  it('appends cited managed images after graph media and ignores duplicate asset ids', () => {
    const connected = {
      ok: true as const,
      references: [{ assetId: image.assetId, label: 'Connected', position: 0, role: 'scene_composition' as const }],
      media: [{ kind: 'image' as const, assetId: image.assetId, sha256: image.sha256, byteSize: image.byteSize, mediaType: image.mediaType }],
      orderedMedia: [{ kind: 'image' as const, assetId: image.assetId, sha256: image.sha256, byteSize: image.byteSize, label: 'Connected', mediaType: image.mediaType, order: 0, role: 'scene_composition' as const }],
      edgeIds: ['edge-connected'],
    };

    expect(mergeReverseCitationImages(connected, [image.assetId, unrelatedImage.assetId], [
      { ...image, label: 'Connected' },
      { ...unrelatedImage, label: 'Cited image' },
    ])).toMatchObject({
      ok: true,
      references: [
        { assetId: image.assetId, position: 0 },
        { assetId: unrelatedImage.assetId, label: 'Cited image', position: 1 },
      ],
      media: [
        { assetId: image.assetId },
        { assetId: unrelatedImage.assetId },
      ],
      orderedMedia: [
        { assetId: image.assetId, order: 0 },
        { assetId: unrelatedImage.assetId, order: 1 },
      ],
      edgeIds: ['edge-connected'],
    });
  });

  it('rejects cited image ids that are not managed by the project', () => {
    const connected = {
      ok: true as const,
      references: [],
      media: [],
      orderedMedia: [],
      edgeIds: [],
    };

    expect(mergeReverseCitationImages(connected, ['missing-image'], [])).toMatchObject({ ok: false });
  });

  it('rejects citation merges above the shared 20-item media limit', () => {
    const connected = {
      ok: true as const,
      references: [],
      media: [],
      orderedMedia: [],
      edgeIds: [],
    };
    const citedImages = Array.from({ length: 21 }, (_, index) => ({
      assetId: `asset-${index}`,
      sha256: index.toString(16).padStart(64, '0'),
      byteSize: 42,
      mediaType: 'image/png' as const,
      label: `Image ${index + 1}`,
    }));

    expect(mergeReverseCitationImages(connected, citedImages.map((asset) => asset.assetId), citedImages)).toMatchObject({ ok: false });
  });
});
describe('resolveConnectedReverseMedia', () => {
  it.each([
    ['no inbound media', [], [], []],
    ['unavailable image', [{ id: 'missing', source: 'missing-image', sourcePortId: 'image', target: 'reverse', targetPortId: 'references', order: 0 }], [], []],

  ])('blocks %s without producing a run identity', (_name, edges, imageAssets, videoIds) => {
    const reverse = createCanvasModuleNode('reverse', 'reverse_agent', { x: 300, y: 0 });
    const videoNodes = (videoIds as string[]).map((assetId, index) => {
      const node = createCanvasModuleNode(assetId, 'video_input', { x: 0, y: index * 100 });
      node.data.config = { assetId };
      return node;
    });
    const videos = (videoIds as string[]).map((assetId) => ({
      assetId,
      sha256: `${assetId.slice(-1)} `.trim().repeat(64),
      byteSize: 1_024,
      durationMs: 4_800,
      extension: 'mp4' as const,
      height: 1_080,
      label: assetId,
      mediaType: 'video/mp4',
      origin: 'imported' as const,
      width: 1_920,
    }));
    const project = { id: 'project-1', nodes: [...videoNodes, reverse], edges } as unknown as CanvasProject;

    expect(resolveConnectedReverseMedia({ project, nodeId: reverse.id, images: imageAssets, videos })).toMatchObject({ ok: false });
  });

  it('builds an ordered run identity only from the selected Agent inbound assets', () => {
    const first = { ...image, assetId: '1111111111111111', label: 'First' };
    const second = { ...unrelatedImage, assetId: '2222222222222222', label: 'Second' };
    const video = {
      assetId: '3333333333333333',
      sha256: '3'.repeat(64),
      byteSize: 1_024,
      durationMs: 4_800,
      extension: 'mp4' as const,
      height: 1_080,
      label: 'Launch film',
      mediaType: 'video/mp4',
      origin: 'imported' as const,
      width: 1_920,
    };
    const firstInput = createCanvasModuleNode('first-input', 'image_input', { x: 0, y: 0 });
    firstInput.data.config = { assetId: first.assetId };
    const secondInput = createCanvasModuleNode('second-input', 'image_input', { x: 0, y: 100 });
    secondInput.data.config = { assetId: second.assetId };
    const videoInput = createCanvasModuleNode('video-input', 'video_input', { x: 0, y: 200 });
    videoInput.data.config = { assetId: video.assetId };
    const unrelated = createCanvasModuleNode('unrelated', 'image_input', { x: 0, y: 300 });
    unrelated.data.config = { assetId: image.assetId };
    const reverse = createCanvasModuleNode('reverse', 'reverse_agent', { x: 300, y: 0 });
    const project = {
      id: 'project-1',
      nodes: [firstInput, secondInput, videoInput, unrelated, reverse],
      edges: [
        { id: 'second', source: secondInput.id, sourcePortId: 'image', target: reverse.id, targetPortId: 'references', order: 20 },
        { id: 'video', source: videoInput.id, sourcePortId: 'video', target: reverse.id, targetPortId: 'references', order: 30 },
        { id: 'first', source: firstInput.id, sourcePortId: 'image', target: reverse.id, targetPortId: 'references', order: 10 },
      ],
    } as unknown as CanvasProject;

    expect(resolveConnectedReverseMedia({ project, nodeId: reverse.id, images: [first, second, image], videos: [video] })).toEqual({
      ok: true,
      references: [
        { assetId: first.assetId, label: 'First', position: 0, role: 'scene_composition' },
        { assetId: second.assetId, label: 'Second', position: 1, role: 'scene_composition' },
      ],
      media: [
        { kind: 'image', assetId: first.assetId, sha256: first.sha256, byteSize: first.byteSize, mediaType: 'image/png' },
        { kind: 'image', assetId: second.assetId, sha256: second.sha256, byteSize: second.byteSize, mediaType: 'image/png' },
        { kind: 'video', assetId: video.assetId, sha256: video.sha256, byteSize: video.byteSize, mediaType: 'video/mp4' },
      ],
      edgeIds: ['first', 'second', 'video'],
      orderedMedia: [
        { kind: 'image', assetId: first.assetId, sha256: first.sha256, byteSize: first.byteSize, label: 'First', mediaType: 'image/png', order: 0, role: 'scene_composition' },
        { kind: 'image', assetId: second.assetId, sha256: second.sha256, byteSize: second.byteSize, label: 'Second', mediaType: 'image/png', order: 1, role: 'scene_composition' },
        { kind: 'video', ...video, order: 2 },
      ],
    });
  });

  it('accepts multiple MP4 videos mixed with images and preserves the inbound edge order', () => {
    const firstVideo = {
      assetId: '3333333333333333', sha256: '3'.repeat(64), byteSize: 1_024, durationMs: 4_800,
      extension: 'mp4' as const, height: 1_080, label: 'First video', mediaType: 'video/mp4', origin: 'imported' as const, width: 1_920,
    };
    const secondVideo = {
      assetId: '4444444444444444', sha256: '4'.repeat(64), byteSize: 2_048, durationMs: 6_200,
      extension: 'mp4' as const, height: 1_080, label: 'Second video', mediaType: 'video/mp4', origin: 'imported' as const, width: 1_920,
    };
    const imageInput = createCanvasModuleNode('mixed-image', 'image_input', { x: 0, y: 100 });
    imageInput.data.config = { assetId: image.assetId };
    const firstVideoInput = createCanvasModuleNode('first-video', 'video_input', { x: 0, y: 0 });
    firstVideoInput.data.config = { assetId: firstVideo.assetId };
    const secondVideoInput = createCanvasModuleNode('second-video', 'video_input', { x: 0, y: 200 });
    secondVideoInput.data.config = { assetId: secondVideo.assetId };
    const reverse = createCanvasModuleNode('reverse', 'reverse_agent', { x: 300, y: 0 });
    const project = {
      id: 'project-1',
      nodes: [imageInput, firstVideoInput, secondVideoInput, reverse],
      edges: [
        { id: 'image-edge', source: imageInput.id, sourcePortId: 'image', target: reverse.id, targetPortId: 'references', order: 20 },
        { id: 'second-video-edge', source: secondVideoInput.id, sourcePortId: 'video', target: reverse.id, targetPortId: 'references', order: 30 },
        { id: 'first-video-edge', source: firstVideoInput.id, sourcePortId: 'video', target: reverse.id, targetPortId: 'references', order: 10 },
      ],
    } as unknown as CanvasProject;

    const result = resolveConnectedReverseMedia({ project, nodeId: reverse.id, images: [image], videos: [firstVideo, secondVideo] });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.reason);
    expect(result.orderedMedia.map((item) => `${item.kind}:${item.assetId}`)).toEqual([
      `video:${firstVideo.assetId}`,
      `image:${image.assetId}`,
      `video:${secondVideo.assetId}`,
    ]);
    expect(result.media.map((item) => `${item.kind}:${item.assetId}`)).toEqual([
      `video:${firstVideo.assetId}`,
      `image:${image.assetId}`,
      `video:${secondVideo.assetId}`,
    ]);
    expect(result.edgeIds).toEqual(['first-video-edge', 'image-edge', 'second-video-edge']);
  });
  it('uses only managed media connected to the selected reverse Agent in edge order', () => {
    const imageInput = createCanvasModuleNode('image-input', 'image_input', { x: 0, y: 0 });
    imageInput.data.config = { assetId: image.assetId };
    const reverse = createCanvasModuleNode('reverse', 'reverse_agent', { x: 300, y: 0 });
    const unrelated = createCanvasModuleNode('unrelated', 'image_input', { x: 0, y: 300 });
    unrelated.data.config = { assetId: unrelatedImage.assetId };
    const project = {
      id: 'project-1',
      nodes: [imageInput, reverse, unrelated],
      edges: [{
        id: 'image-to-reverse',
        source: imageInput.id,
        sourcePortId: 'image',
        target: reverse.id,
        targetPortId: 'references',
        order: 0,
      }],
    } as unknown as CanvasProject;

    expect(resolveConnectedReverseMedia({ project, nodeId: reverse.id, images: [image, unrelatedImage], videos: [] })).toEqual({
      ok: true,
      references: [{ assetId: image.assetId, label: image.assetId, position: 0, role: 'scene_composition' }],
      media: [{ kind: 'image', assetId: image.assetId, sha256: image.sha256, byteSize: image.byteSize, mediaType: 'image/png' }],
      edgeIds: ['image-to-reverse'],
      orderedMedia: [{ kind: 'image', assetId: image.assetId, sha256: image.sha256, byteSize: image.byteSize, label: image.assetId, mediaType: 'image/png', order: 0, role: 'scene_composition' }],
    });
  });

  it('rejects a media edge whose source module or port does not match its media kind', () => {
    const imageAsVideo = createCanvasModuleNode('image-as-video', 'image_input', { x: 0, y: 0 });
    imageAsVideo.data.config = { assetId: '3333333333333333' };
    const videoAsImage = createCanvasModuleNode('video-as-image', 'video_input', { x: 0, y: 100 });
    videoAsImage.data.config = { assetId: image.assetId };
    const reverse = createCanvasModuleNode('reverse', 'reverse_agent', { x: 300, y: 0 });
    const video = {
      assetId: '3333333333333333',
      sha256: '3'.repeat(64),
      byteSize: 1_024,
      durationMs: 4_800,
      extension: 'mp4' as const,
      height: 1_080,
      label: 'Launch film',
      mediaType: 'video/mp4',
      origin: 'imported' as const,
      width: 1_920,
    };
    const project = {
      id: 'project-1',
      nodes: [imageAsVideo, videoAsImage, reverse],
      edges: [
        { id: 'malformed-video', source: imageAsVideo.id, sourcePortId: 'video', target: reverse.id, targetPortId: 'video', order: 0 },
        { id: 'malformed-image', source: videoAsImage.id, sourcePortId: 'image', target: reverse.id, targetPortId: 'references', order: 1 },
      ],
    } as unknown as CanvasProject;

    expect(resolveConnectedReverseMedia({ project, nodeId: reverse.id, images: [image], videos: [video] })).toMatchObject({ ok: false });
  });
});
