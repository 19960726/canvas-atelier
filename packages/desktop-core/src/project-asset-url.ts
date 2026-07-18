export const PROJECT_ASSET_SCHEME = 'novus-asset';

export interface ProjectAssetUrlIdentity {
  readonly assetId: string;
  readonly sessionId: string;
}

export function createProjectAssetDisplayUrl(sessionId: string, assetId: string): string {
  if (!isSafeSessionId(sessionId) || !isContentAddressedAssetId(assetId)) {
    throw new Error('Project asset URL identity is invalid');
  }
  return `${PROJECT_ASSET_SCHEME}://project/${encodeURIComponent(sessionId)}/${assetId}`;
}

export function parseProjectAssetDisplayUrl(value: string): ProjectAssetUrlIdentity | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== `${PROJECT_ASSET_SCHEME}:`
    || parsed.hostname !== 'project'
    || parsed.port !== ''
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
  ) {
    return null;
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(parts[0]!);
  } catch {
    return null;
  }
  const assetId = parts[1]!;
  return isSafeSessionId(sessionId) && isContentAddressedAssetId(assetId)
    ? { assetId, sessionId }
    : null;
}

function isSafeSessionId(value: string): boolean {
  return /^[a-zA-Z0-9._:-]{1,160}$/u.test(value);
}

function isContentAddressedAssetId(value: string): boolean {
  return /^[a-f0-9]{16}$/u.test(value);
}
