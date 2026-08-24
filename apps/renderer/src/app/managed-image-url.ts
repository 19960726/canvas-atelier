const assetIdPattern = /^[a-f0-9]{16}$/u;
const sessionIdPattern = /^[a-zA-Z0-9._:-]{1,160}$/u;
const e2eAssetPathPattern = /^\/__novus_e2e_asset\/([a-f0-9]{16})\.svg$/u;
const durableRasterDataUrlPattern = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/u;
const MAX_DURABLE_RASTER_DATA_URL_LENGTH = 12_000_000;

export function isRenderableManagedImageUrl(
  value: string | undefined,
  expectedAssetId?: string,
): value is string {
  if (value === undefined || value.length === 0) return false;
  if (value.startsWith('data:')) {
    return value.length <= MAX_DURABLE_RASTER_DATA_URL_LENGTH && durableRasterDataUrlPattern.test(value);
  }
  const baseUrl = new URL(globalThis.location?.href ?? 'http://localhost/');
  let parsed: URL;
  try {
    parsed = new URL(value, baseUrl);
  } catch {
    return false;
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    return false;
  }
  if (parsed.protocol === 'blob:') {
    try {
      const source = new URL(parsed.pathname);
      return (baseUrl.protocol === 'http:' || baseUrl.protocol === 'https:')
        && source.origin === baseUrl.origin;
    } catch {
      return false;
    }
  }
  if (parsed.protocol === 'novus-asset:') {
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parsed.hostname !== 'project' || parsed.port !== '' || parts.length !== 2 || !assetIdPattern.test(parts[1]!)) return false;
    if (expectedAssetId !== undefined && parts[1] !== expectedAssetId) return false;
    try {
      return sessionIdPattern.test(decodeURIComponent(parts[0]!));
    } catch {
      return false;
    }
  }
  const e2eMatch = e2eAssetPathPattern.exec(parsed.pathname);
  return (baseUrl.protocol === 'http:' || baseUrl.protocol === 'https:')
    && parsed.origin === baseUrl.origin
    && e2eMatch !== null
    && (expectedAssetId === undefined || e2eMatch[1] === expectedAssetId);
}
