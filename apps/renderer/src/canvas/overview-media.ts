import { retainedImagePreviewIds, retainedVideoPreviews } from '../app/generation-previous-results';
import { isRenderableManagedImageUrl, isRenderableManagedVideoUrl } from '../app/managed-image-url';

export type OverviewMediaModuleType =
  | 'canvas_library'
  | 'image_generation'
  | 'image_input'
  | 'image_layer'
  | 'image_layering'
  | 'result_output'
  | 'upload_image'
  | 'video_generation'
  | 'video_input'
  | 'video_result';

export interface OverviewMediaAssetRecord {
  readonly assetId: string;
  readonly mediaType: string;
}

export interface OverviewMediaSummary {
  readonly assetId: string;
  readonly displayUrl: string;
}

export interface OverviewMediaNodeRecord {
  readonly id: string;
  readonly type?: string;
  readonly data?: unknown;
}

interface OverviewMediaSourceNode extends OverviewMediaNodeRecord {
  readonly data: { readonly moduleType?: string; readonly config: Record<string, unknown> };
}

export interface OverviewMediaEdgeRecord {
  readonly source: string;
  readonly target: string;
  readonly sourcePortId?: string;
  readonly targetPortId?: string;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

function ownedAssetId(
  assetId: unknown,
  assets: readonly OverviewMediaAssetRecord[],
  mediaPrefix: 'image/' | 'video/',
): string | undefined {
  if (typeof assetId !== 'string' || assetId.length === 0) return undefined;
  return assets.some((asset) => asset.assetId === assetId && asset.mediaType.startsWith(mediaPrefix)) ? assetId : undefined;
}

function renderableImageAssetId(
  assetId: unknown,
  assets: readonly OverviewMediaAssetRecord[],
  images: readonly OverviewMediaSummary[],
): string | undefined {
  const ownedId = ownedAssetId(assetId, assets, 'image/');
  return ownedId !== undefined && images.some(image => image.assetId === ownedId && isRenderableManagedImageUrl(image.displayUrl, image.assetId))
    ? ownedId : undefined;
}

function hasRenderableVideoPreview(
  result: { readonly assetId: string; readonly posterAssetId?: string },
  assets: readonly OverviewMediaAssetRecord[],
  images: readonly OverviewMediaSummary[],
  videos: readonly OverviewMediaSummary[],
): boolean {
  return ownedAssetId(result.assetId, assets, 'video/') !== undefined
    && (videos.some(video => video.assetId === result.assetId && isRenderableManagedVideoUrl(video.displayUrl, video.assetId))
      || renderableImageAssetId(result.posterAssetId, assets, images) !== undefined);
}

function upstreamModule(
  nodeId: string,
  targetPortId: string,
  sourcePortId: string,
  nodes: readonly OverviewMediaNodeRecord[],
  edges: readonly OverviewMediaEdgeRecord[],
): OverviewMediaSourceNode | undefined {
  const incoming = edges.filter((edge) => edge.target === nodeId && edge.targetPortId === targetPortId);
  if (incoming.length !== 1 || incoming[0]!.sourcePortId !== sourcePortId) return undefined;
  const source = nodes.find((node) => node.id === incoming[0]!.source);
  if (source?.type !== 'module' || source.data === null || typeof source.data !== 'object') return undefined;
  const data = source.data as { config?: unknown };
  return data.config !== null && typeof data.config === 'object' && !Array.isArray(data.config)
    ? source as OverviewMediaSourceNode : undefined;
}

export function resolveOverviewMediaAssetId(
  moduleType: OverviewMediaModuleType,
  nodeId: string,
  config: Record<string, unknown>,
  nodes: readonly OverviewMediaNodeRecord[],
  edges: readonly OverviewMediaEdgeRecord[],
  assets: readonly OverviewMediaAssetRecord[],
  images: readonly OverviewMediaSummary[],
  videos: readonly OverviewMediaSummary[],
): string | undefined {
  if (moduleType === 'image_input' || moduleType === 'upload_image' || moduleType === 'image_layer') {
    return renderableImageAssetId(moduleType === 'image_layer' ? config.resultAssetId : config.assetId, assets, images);
  }
  if (moduleType === 'image_layering') return renderableImageAssetId(config.sourceAssetId, assets, images);
  if (moduleType === 'video_input') {
    const videoId = ownedAssetId(config.assetId, assets, 'video/');
    return videoId !== undefined && videos.some(video => video.assetId === videoId && isRenderableManagedVideoUrl(video.displayUrl, video.assetId))
      ? videoId : undefined;
  }
  if (moduleType === 'canvas_library') return stringArray(config.assetIds).find(id => renderableImageAssetId(id, assets, images) !== undefined);
  if (moduleType === 'image_generation') return retainedImagePreviewIds({ assets }, config).find(id => renderableImageAssetId(id, assets, images) !== undefined);
  if (moduleType === 'video_generation') return retainedVideoPreviews({ assets }, config, images)
    .find(result => hasRenderableVideoPreview(result, assets, images, videos))?.assetId;
  if (moduleType === 'result_output') {
    const source = upstreamModule(nodeId, 'result', 'result', nodes, edges);
    return source?.data?.moduleType === 'image_generation'
      ? resolveOverviewMediaAssetId('image_generation', source.id, { resultAssetIds: source.data.config.resultAssetIds }, nodes, edges, assets, images, videos)
      : undefined;
  }
  if (moduleType === 'video_result') {
    const source = upstreamModule(nodeId, 'video', 'result', nodes, edges);
    return source?.data?.moduleType === 'video_generation'
      ? resolveOverviewMediaAssetId('video_generation', source.id, { videoResults: source.data.config.videoResults }, nodes, edges, assets, images, videos)
      : undefined;
  }
  return undefined;
}

export function resolveOverviewMediaPosterAssetId(
  moduleType: OverviewMediaModuleType,
  nodeId: string,
  config: Record<string, unknown>,
  nodes: readonly OverviewMediaNodeRecord[],
  edges: readonly OverviewMediaEdgeRecord[],
  assets: readonly OverviewMediaAssetRecord[],
  images: readonly OverviewMediaSummary[],
  videos: readonly OverviewMediaSummary[],
): string | undefined {
  const source = moduleType === 'video_result' ? upstreamModule(nodeId, 'video', 'result', nodes, edges) : undefined;
  const sourceConfig = source?.data?.moduleType === 'video_generation' ? { videoResults: source.data.config.videoResults } : moduleType === 'video_generation' ? config : undefined;
  if (sourceConfig === undefined) return undefined;
  const previewId = resolveOverviewMediaAssetId('video_generation', source?.id ?? nodeId, sourceConfig, nodes, edges, assets, images, videos);
  if (previewId === undefined) return undefined;
  const record = retainedVideoPreviews({ assets }, sourceConfig, images).find(item => item.assetId === previewId);
  return renderableImageAssetId(record?.posterAssetId, assets, images);
}

export function resolveOverviewMediaResultCount(
  moduleType: OverviewMediaModuleType,
  config: Record<string, unknown>,
  assets: readonly OverviewMediaAssetRecord[],
  images: readonly OverviewMediaSummary[],
  videos: readonly OverviewMediaSummary[],
): number {
  if (moduleType === 'image_generation') return retainedImagePreviewIds({ assets }, config)
    .filter(id => renderableImageAssetId(id, assets, images) !== undefined).length;
  if (moduleType === 'video_generation') return retainedVideoPreviews({ assets }, config, images)
    .filter(result => hasRenderableVideoPreview(result, assets, images, videos)).length;
  return 0;
}
