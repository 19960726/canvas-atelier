import type { ProjectVideoAssetSummary } from '@agent-canvas/desktop-core';
import { isRenderableManagedVideoUrl } from './managed-image-url';

type VideoMetadata = Pick<ProjectVideoAssetSummary, 'width' | 'height' | 'durationMs'>;
const positive = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const complete = (value: VideoMetadata) => positive(value.width) && positive(value.height) && positive(value.durationMs);

/** Native imports can have verified bytes but no decoded dimensions/duration. */
export function createManagedVideoMetadataReader() {
  const cache = new Map<string, Promise<VideoMetadata | null>>();
  async function enrich(asset: ProjectVideoAssetSummary): Promise<ProjectVideoAssetSummary> {
    if (complete(asset) || !isRenderableManagedVideoUrl(asset.displayUrl, asset.assetId)) return asset;
    const key = `${asset.displayUrl}\0${asset.sha256}\0${asset.byteSize}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = readManagedVideoMetadata(asset.displayUrl);
      if (cache.size >= 128) cache.delete(cache.keys().next().value!);
      cache.set(key, pending);
    }
    const decoded = await pending;
    if (!decoded) { if (cache.get(key) === pending) cache.delete(key); return asset; }
    return { ...asset, width: positive(asset.width) ? asset.width : decoded.width,
      height: positive(asset.height) ? asset.height : decoded.height,
      durationMs: positive(asset.durationMs) ? asset.durationMs : decoded.durationMs };
  }
  return { enrich, async enrichList(assets: ProjectVideoAssetSummary[]) {
    const results: ProjectVideoAssetSummary[] = [];
    // Bound simultaneous decoders when a large existing project is reopened.
    for (let start = 0; start < assets.length; start += 4) results.push(...await Promise.all(assets.slice(start, start + 4).map(enrich)));
    return results;
  } };
}

function readManagedVideoMetadata(url: string): Promise<VideoMetadata | null> {
  if (typeof document === 'undefined') return Promise.resolve(null);
  return new Promise(resolve => {
    const video = document.createElement('video');
    let finished = false;
    const finish = (metadata: VideoMetadata | null) => {
      if (finished) return;
      finished = true; clearTimeout(timeout);
      video.onloadedmetadata = null; video.onerror = null;
      video.removeAttribute('src');
      try { video.load(); } catch { /* Release the decoder even after a source error. */ }
      resolve(metadata);
    };
    const timeout = setTimeout(() => finish(null), 5000);
    video.onloadedmetadata = () => {
      const metadata = { width: video.videoWidth, height: video.videoHeight, durationMs: Math.round(video.duration * 1000) };
      finish(complete(metadata) ? metadata : null);
    };
    video.onerror = () => finish(null);
    video.preload = 'metadata'; video.muted = true;
    try { video.src = url; } catch { finish(null); }
  });
}
