export const GENERATION_HISTORY_ASSET_SCHEME = 'novus-history';

export interface GenerationHistoryAssetUrlIdentity {
  readonly historyAssetId: string;
}

export function createGenerationHistoryAssetUrl(historyAssetId: string): string {
  if (!isOpaqueHistoryAssetId(historyAssetId)) throw new Error('Generation history asset URL identity is invalid');
  return `${GENERATION_HISTORY_ASSET_SCHEME}://asset/${historyAssetId}`;
}

export function parseGenerationHistoryAssetUrl(value: string): GenerationHistoryAssetUrlIdentity | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== `${GENERATION_HISTORY_ASSET_SCHEME}:`
    || parsed.hostname !== 'asset'
    || parsed.port !== ''
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
  ) return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length !== 1 || !isOpaqueHistoryAssetId(parts[0]!)) return null;
  return { historyAssetId: parts[0]! };
}

function isOpaqueHistoryAssetId(value: string): boolean {
  return /^[a-z][a-z0-9_-]{7,95}$/u.test(value);
}
