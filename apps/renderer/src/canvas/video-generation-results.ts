export interface VideoGenerationResultItem {
  readonly assetId: string;
  readonly mediaType: string;
  readonly durationMs: number;
  readonly posterAssetId?: string;
  readonly posterUrl?: string;
}

export function readVideoGenerationResults(config: Record<string, unknown>): VideoGenerationResultItem[] {
  if (!Array.isArray(config.videoResults)) return [];
  const seen = new Set<string>();
  const results: VideoGenerationResultItem[] = [];
  for (const candidate of config.videoResults) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    const assetId = typeof record.assetId === 'string' ? record.assetId.trim() : '';
    const mediaType = typeof record.mediaType === 'string' ? record.mediaType.trim() : '';
    const durationMs = typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) && record.durationMs > 0
      ? Math.round(record.durationMs)
      : 0;
    if (assetId.length === 0 || seen.has(assetId) || !mediaType.startsWith('video/') || durationMs === 0) continue;
    const posterAssetId = typeof record.posterAssetId === 'string' && record.posterAssetId.trim().length > 0 ? record.posterAssetId.trim() : undefined;
    const posterUrl = typeof record.posterUrl === 'string' && record.posterUrl.length > 0 ? record.posterUrl : undefined;
    seen.add(assetId);
    results.push({ assetId, mediaType, durationMs, ...(posterAssetId ? { posterAssetId } : {}), ...(posterUrl ? { posterUrl } : {}) });
    if (results.length === 4) break;
  }
  return results;
}