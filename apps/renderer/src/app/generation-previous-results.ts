import type { CanvasProject } from '@agent-canvas/domain';
import { readVideoGenerationResults } from '../canvas/video-generation-results';
import { isRenderableManagedImageUrl } from './managed-image-url';

/** Previous previews are project-owned history, never the current task's result. */
export function retainedImagePreviewIds(project: CanvasProject, config: Record<string, unknown>): string[] {
  const owned = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter((id): id is string =>
    typeof id === 'string' && project.assets?.some(asset => asset.assetId === id && asset.mediaType.startsWith('image/')) === true))].slice(-9) : [];
  const current = owned(config.resultAssetIds);
  return current.length > 0 ? current : owned(config.previousResultAssetIds);
}

export function retainedVideoPreviews(project: CanvasProject, config: Record<string, unknown>, images: readonly { assetId: string; displayUrl: string }[] = []) {
  const owned = (value: unknown) => readVideoGenerationResults({ videoResults: value })
    .filter(result => project.assets?.some(asset => asset.assetId === result.assetId && asset.mediaType.startsWith('video/')) === true)
    .map(result => {
      const posterImage = isRenderableManagedImageUrl(result.posterUrl) ? images.find(image =>
        image.displayUrl === result.posterUrl && project.assets?.some(asset => asset.assetId === image.assetId && asset.mediaType.startsWith('image/')))
        : undefined;
      const posterAssetId = project.assets?.some(asset => asset.assetId === result.posterAssetId && asset.mediaType.startsWith('image/')) ? result.posterAssetId : posterImage?.assetId;
      return { assetId: result.assetId, durationMs: result.durationMs, mediaType: result.mediaType,
        ...(posterAssetId ? { posterAssetId } : {}) };
    });
  const current = owned(config.videoResults);
  return current.length > 0 ? current : owned(config.previousVideoResults);
}
