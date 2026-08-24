import type { PhotoshopImportRequest, PhotoshopImportResult } from './photoshop-contract.js';

export interface PhotoshopManagedAsset {
  readonly absolutePath: string;
  readonly label: string;
  readonly mediaType: string;
}

export interface PhotoshopManagedAssetResolver {
  resolve(request: PhotoshopImportRequest): Promise<PhotoshopManagedAsset | null>;
}

export interface PhotoshopSmartObjectAdapter {
  place(input: {
    readonly absolutePath: string;
    readonly layerName: string;
  }): Promise<PhotoshopImportResult>;
}

export class PhotoshopSmartObjectService {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly assets: PhotoshopManagedAssetResolver,
    private readonly adapter: PhotoshopSmartObjectAdapter,
  ) {}

  async import(request: PhotoshopImportRequest): Promise<PhotoshopImportResult> {
    const key = `${request.sessionId}:${request.assetId}`;
    if (this.inFlight.has(key)) return { ok: false, code: 'import_busy' };
    this.inFlight.add(key);

    try {
      const asset = await this.assets.resolve(request);
      if (asset === null) return { ok: false, code: 'asset_not_found' };
      if (!asset.mediaType.startsWith('image/')) return { ok: false, code: 'unsupported_media' };
      return await this.adapter.place({
        absolutePath: asset.absolutePath,
        layerName: sanitizeLayerName(asset.label),
      });
    } catch {
      return { ok: false, code: 'placement_failed' };
    } finally {
      this.inFlight.delete(key);
    }
  }
}

function sanitizeLayerName(value: string): string {
  const sanitized = value
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 120);
  return sanitized.length > 0 ? sanitized : '生成图片';
}
