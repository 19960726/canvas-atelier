import type { ProjectImageAssetSummary } from '@agent-canvas/desktop-core';

export interface LayeredImageRecord {
  readonly layerId: string;
  readonly kind: 'background' | 'transparent';
  readonly name: string;
  readonly assetId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly visible: boolean;
  readonly opacity: number;
}

export interface LayeredImageConfig {
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly layers: readonly { readonly record: LayeredImageRecord; readonly asset: Pick<ProjectImageAssetSummary, 'assetId' | 'mediaType' | 'displayUrl'> }[];
}

export function parseLayeredImageConfig(
  config: Readonly<Record<string, unknown>>,
  assets: readonly Pick<ProjectImageAssetSummary, 'assetId' | 'mediaType' | 'displayUrl'>[],
): LayeredImageConfig | null {
  const rawLayers = config.layers;
  if (!Array.isArray(rawLayers) || rawLayers.length === 0) return null;
  if (rawLayers.length < 2 || rawLayers.length > 17
    || !validSide(config.canvasWidth) || !validSide(config.canvasHeight)) {
    throw new Error('Layered image dimensions or layer count are invalid');
  }
  const width = config.canvasWidth as number;
  const height = config.canvasHeight as number;
  const assetById = new Map(assets.map(asset => [asset.assetId, asset]));
  const seenLayers = new Set<string>();
  const seenAssets = new Set<string>();
  const layers = rawLayers.map((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Layered image record is invalid');
    const value = raw as Record<string, unknown>;
    if ('url' in value || 'displayUrl' in value) throw new Error('Layered image config cannot save temporary URLs');
    if (typeof value.layerId !== 'string' || !value.layerId || typeof value.assetId !== 'string'
      || typeof value.name !== 'string' || !value.name.trim()
      || value.kind !== (index === 0 ? 'background' : 'transparent')
      || typeof value.visible !== 'boolean' || typeof value.opacity !== 'number'
      || !Number.isFinite(value.opacity) || value.opacity < 0 || value.opacity > 1) {
      throw new Error('Layered image record is invalid');
    }
    if (seenLayers.has(value.layerId) || seenAssets.has(value.assetId)) throw new Error('Layered image has duplicate layers or assets');
    seenLayers.add(value.layerId);
    seenAssets.add(value.assetId);
    if (!validSide(value.width) || !validSide(value.height) || !Number.isInteger(value.x) || !Number.isInteger(value.y)
      || (value.x as number) < 0 || (value.y as number) < 0
      || (value.x as number) + (value.width as number) > width
      || (value.y as number) + (value.height as number) > height) {
      throw new Error('Layered image layer is outside canvas bounds');
    }
    const asset = assetById.get(value.assetId);
    if (!asset || !asset.mediaType.startsWith('image/') || !asset.displayUrl) {
      throw new Error('Layered image managed asset is unavailable');
    }
    const record: LayeredImageRecord = {
      layerId: value.layerId,
      kind: index === 0 ? 'background' : 'transparent',
      name: value.name,
      assetId: value.assetId,
      x: value.x as number,
      y: value.y as number,
      width: value.width as number,
      height: value.height as number,
      visible: value.visible,
      opacity: value.opacity,
    };
    return { record, asset };
  });
  return { canvasWidth: width, canvasHeight: height, layers };
}

function validSide(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 8_192;
}
