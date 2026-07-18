const assetIdPattern = /^[a-f0-9]{16}$/u;
const sessionIdPattern = /^[a-zA-Z0-9._:-]{1,160}$/u;
const e2eAssetPathPattern = /^\/__novus_e2e_asset\/[a-f0-9]{16}\.svg$/u;

export function isRenderableManagedImageUrl(value: string | undefined): value is string {
  if (value === undefined || value.length === 0) return false;
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
  if (parsed.protocol === 'novus-asset:') {
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parsed.hostname !== 'project' || parsed.port !== '' || parts.length !== 2 || !assetIdPattern.test(parts[1]!)) return false;
    try {
      return sessionIdPattern.test(decodeURIComponent(parts[0]!));
    } catch {
      return false;
    }
  }
  return (baseUrl.protocol === 'http:' || baseUrl.protocol === 'https:')
    && parsed.origin === baseUrl.origin
    && e2eAssetPathPattern.test(parsed.pathname);
}
