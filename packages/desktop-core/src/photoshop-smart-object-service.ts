import type {
  PhotoshopColorCorrection,
  PhotoshopImportRequest,
  PhotoshopImportResult,
} from './photoshop-contract.js';

export interface PhotoshopManagedAsset {
  readonly absolutePath: string;
  readonly label: string;
  readonly mediaType: string;
}

export interface PhotoshopManagedAssetResolver {
  resolve(request: Pick<PhotoshopImportRequest, 'sessionId' | 'assetId'>): Promise<PhotoshopManagedAsset | null>;
}

export interface PhotoshopSmartObjectPlacementInput {
  readonly absolutePath: string;
  readonly layerName: string;
  readonly mediaType?: string;
  readonly colorCorrection?: PhotoshopColorCorrection;
}

export interface PhotoshopSmartObjectAdapter {
  place(input: PhotoshopSmartObjectPlacementInput): Promise<PhotoshopImportResult>;
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
      const asset = await this.assets.resolve({ sessionId: request.sessionId, assetId: request.assetId });
      if (asset === null) return { ok: false, code: 'asset_not_found' };
      if (!asset.mediaType.startsWith('image/')) return { ok: false, code: 'unsupported_media' };
      return await this.adapter.place({
        absolutePath: asset.absolutePath,
        layerName: sanitizeLayerName(asset.label),
        mediaType: asset.mediaType,
        ...(request.colorCorrection === undefined ? {} : { colorCorrection: request.colorCorrection }),
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
