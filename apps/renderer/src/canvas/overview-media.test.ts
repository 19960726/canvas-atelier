import { describe, expect, it } from 'vitest';
import { resolveOverviewMediaAssetId, resolveOverviewMediaPosterAssetId, type OverviewMediaAssetRecord } from './overview-media';

const imageId = '1111111111111111';
const secondImageId = '2222222222222222';
const videoId = '3333333333333333';
const posterId = '4444444444444444';

const assets: OverviewMediaAssetRecord[] = [
  { assetId: imageId, mediaType: 'image/png' },
  { assetId: secondImageId, mediaType: 'image/jpeg' },
  { assetId: videoId, mediaType: 'video/mp4' },
  { assetId: posterId, mediaType: 'image/png' },
];
const images = [imageId, secondImageId, posterId].map(assetId => ({ assetId, displayUrl: `novus-asset://project/session/${assetId}` }));
const videos = [{ assetId: videoId, displayUrl: `novus-asset://project/session/${videoId}` }];

describe('overview media selection', () => {
  it.each([
    ['image_input', { assetId: imageId }, imageId],
    ['upload_image', { assetId: imageId }, imageId],
    ['image_layer', { resultAssetId: secondImageId }, secondImageId],
    ['canvas_library', { assetIds: ['missing', secondImageId] }, secondImageId],
    ['image_generation', { resultAssetIds: [imageId] }, imageId],
    ['video_input', { assetId: videoId }, videoId],
    ['video_generation', { videoResults: [{ assetId: videoId, posterAssetId: posterId, mediaType: 'video/mp4', durationMs: 7000 }] }, videoId],
  ] as const)('resolves the first owned preview for %s', (moduleType, config, expected) => {
    expect(resolveOverviewMediaAssetId(moduleType, 'node', config, [], [], assets, images, videos)).toBe(expected);
  });

  it('resolves owned output previews through the exact upstream result edge', () => {
    const nodes = [
      { id: 'generator', type: 'module', data: { moduleType: 'image_generation', config: { resultAssetIds: [imageId] } } },
      { id: 'output', type: 'module', data: { moduleType: 'result_output', config: {} } },
    ];
    const edges = [{ source: 'generator', target: 'output', sourcePortId: 'result', targetPortId: 'result' }];
    expect(resolveOverviewMediaAssetId('result_output', 'output', {}, nodes, edges, assets, images, videos)).toBe(imageId);
  });

  it('resolves video result poster without accepting foreign assets', () => {
    const nodes = [
      { id: 'generator', type: 'module', data: { moduleType: 'video_generation', config: { videoResults: [{ assetId: videoId, posterAssetId: posterId, mediaType: 'video/mp4', durationMs: 7000 }] } } },
      { id: 'output', type: 'module', data: { moduleType: 'video_result', config: {} } },
    ];
    const edges = [{ source: 'generator', target: 'output', sourcePortId: 'result', targetPortId: 'video' }];
    expect(resolveOverviewMediaPosterAssetId('video_result', 'output', {}, nodes, edges, assets, images, videos)).toBe(posterId);
    expect(resolveOverviewMediaPosterAssetId('video_generation', 'generator', { videoResults: [{ assetId: videoId, posterAssetId: 'foreign', mediaType: 'video/mp4', durationMs: 7000 }] }, nodes, edges, assets, images, videos)).toBeUndefined();
    expect(resolveOverviewMediaPosterAssetId('video_generation', 'generator', { videoResults: [{ assetId: 'foreign', posterAssetId: posterId, mediaType: 'video/mp4', durationMs: 7000 }] }, nodes, edges, assets, images, videos)).toBeUndefined();
  });

  it.each(['wrong port', 'duplicate input', 'foreign type'] as const)('rejects an output connected through %s', fault => {
    const nodes = [{ id: 'generator', type: 'module', data: { moduleType: fault === 'foreign type' ? 'image_input' : 'image_generation', config: { resultAssetIds: [imageId] } } }];
    const edge = { source: 'generator', target: 'output', sourcePortId: fault === 'wrong port' ? 'image' : 'result', targetPortId: 'result' };
    const edges = fault === 'duplicate input' ? [edge, { ...edge, sourcePortId: 'image' }] : [edge];
    expect(resolveOverviewMediaAssetId('result_output', 'output', { assetId: imageId }, nodes, edges, assets, images, videos)).toBeUndefined();
  });

  it('retains owned previous generation previews when current results are empty', () => {
    expect(resolveOverviewMediaAssetId('image_generation', 'node', { resultAssetIds: [], previousResultAssetIds: [imageId] }, [], [], assets, images, videos)).toBe(imageId);
    const config = { videoResults: [], previousVideoResults: [{ assetId: videoId, mediaType: 'video/mp4', durationMs: 7000, posterAssetId: posterId }] };
    expect(resolveOverviewMediaAssetId('video_generation', 'node', config, [], [], assets, images, videos)).toBe(videoId);
    expect(resolveOverviewMediaPosterAssetId('video_generation', 'node', config, [], [], assets, images, videos)).toBe(posterId);
  });

  it('recovers a legacy managed poster URL through the retained preview contract', () => {
    const config = { previousVideoResults: [{ assetId: videoId, mediaType: 'video/mp4', durationMs: 7000, posterUrl: images[2]!.displayUrl }] };
    expect(resolveOverviewMediaPosterAssetId('video_generation', 'node', config, [], [], assets, images, videos)).toBe(posterId);
  });

  it('does not let malformed video records precede a valid retained result', () => {
    const config = { videoResults: [
      { assetId: videoId, mediaType: 'video/mp4', durationMs: 0, posterAssetId: imageId },
      { assetId: videoId, mediaType: 'video/mp4', durationMs: 7000, posterAssetId: posterId },
    ] };
    expect(resolveOverviewMediaPosterAssetId('video_generation', 'node', config, [], [], assets, images, videos)).toBe(posterId);
  });

  it('keeps generation history separate from the current output result', () => {
    const nodes = [
      { id: 'image-generator', type: 'module', data: { moduleType: 'image_generation', config: { previousResultAssetIds: [imageId] } } },
      { id: 'video-generator', type: 'module', data: { moduleType: 'video_generation', config: { previousVideoResults: [{ assetId: videoId, mediaType: 'video/mp4', durationMs: 7000, posterAssetId: posterId }] } } },
    ];
    const edges = [
      { source: 'image-generator', target: 'image-output', sourcePortId: 'result', targetPortId: 'result' },
      { source: 'video-generator', target: 'video-output', sourcePortId: 'result', targetPortId: 'video' },
    ];
    expect(resolveOverviewMediaAssetId('result_output', 'image-output', {}, nodes, edges, assets, images, videos)).toBeUndefined();
    expect(resolveOverviewMediaAssetId('video_result', 'video-output', {}, nodes, edges, assets, images, videos)).toBeUndefined();
    expect(resolveOverviewMediaPosterAssetId('video_result', 'video-output', {}, nodes, edges, assets, images, videos)).toBeUndefined();
  });
});
