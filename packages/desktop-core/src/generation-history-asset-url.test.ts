import { describe, expect, it } from 'vitest';

import { createGenerationHistoryAssetUrl, parseGenerationHistoryAssetUrl } from './generation-history-asset-url';

describe('generation history asset URL', () => {
  it('round-trips one opaque history asset identity', () => {
    const url = createGenerationHistoryAssetUrl('history_asset_0123456789abcdef');
    expect(url).toBe('novus-history://asset/history_asset_0123456789abcdef');
    expect(parseGenerationHistoryAssetUrl(url)).toEqual({ historyAssetId: 'history_asset_0123456789abcdef' });
  });

  it.each([
    'novus-history://asset/../private',
    'novus-history://asset/history_asset_0123456789abcdef?path=private',
    'novus-history://user:pass@asset/history_asset_0123456789abcdef',
    'https://asset/history_asset_0123456789abcdef',
    'novus-history://asset/history_asset_0123456789abcdef/extra',
  ])('rejects unsafe URL %s', (value) => {
    expect(parseGenerationHistoryAssetUrl(value)).toBeNull();
  });
});
