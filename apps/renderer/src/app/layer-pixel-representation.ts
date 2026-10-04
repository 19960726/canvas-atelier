export interface LayerPixelAsset {
  assetId: string; sha256?: string; width?: number | null; height?: number | null; mediaType?: string;
}
export interface LayerPixelRepresentation {
  preparedRgb: boolean;
  independentRgbaCandidate: boolean;
  rgbaCandidateOrigin?: 'provider-v2' | 'local-rgba-import';
  error?: string;
}

/** Physical import binding describes bytes, never semantic acceptance. */
export function getLayerPixelRepresentation(
  config: Readonly<Record<string, unknown>>,
  source?: LayerPixelAsset,
  result?: LayerPixelAsset,
): LayerPixelRepresentation {
  const provenance = config.foregroundProvenance;
  if (provenance && typeof provenance === 'object' && !Array.isArray(provenance)
    && (provenance as Record<string, unknown>).kind === 'local-rgba-import') {
    const p = provenance as Record<string, unknown>;
    const hash = /^[a-f0-9]{64}$/u;
    const valid = p.version === 1 && source && result && p.assetId === result.assetId && p.assetId === config.resultAssetId
      && p.sourceAssetId === source.assetId && p.sourceAssetId === config.sourceAssetId
      && typeof p.sha256 === 'string' && hash.test(p.sha256) && p.sha256 === result.sha256
      && typeof p.sourceSha256 === 'string' && hash.test(p.sourceSha256) && p.sourceSha256 === source.sha256
      && Number.isInteger(p.width) && Number.isInteger(p.height) && Number(p.width) > 0 && Number(p.height) > 0
      && p.width === source.width && p.height === source.height && p.width === result.width && p.height === result.height
      && p.width === config.canvasWidth && p.height === config.canvasHeight && result.mediaType === 'image/png';
    return { preparedRgb: false, independentRgbaCandidate: true, rgbaCandidateOrigin: 'local-rgba-import',
      ...(!valid ? { error: '本地 RGBA 素材归属已过期，请重新导入并检查图层' } : {}) };
  }
  const independentRgbaCandidate = config.layeringOutputContract === 'source-independent-rgba-v2'
    && config.resultRepresentation === 'independent-rgba-candidate';
  return { preparedRgb: config.pixelColorSpace === 'foreground', independentRgbaCandidate,
    ...(independentRgbaCandidate ? { rgbaCandidateOrigin: 'provider-v2' as const } : {}) };
}

