import { describe, expect, it } from 'vitest';

import {
  createGenerationHistoryAssetUrl,
  createGenerationHistoryPreviewUrl,
  parseGenerationHistoryAssetUrl,
} from './generation-history-asset-url';

describe('generation history asset URL', () => {
  it('round-trips one opaque history asset identity', () => {
    const url = createGenerationHistoryAssetUrl('history_asset_0123456789abcdef');
    expect(url).toBe('novus-history://asset/history_asset_0123456789abcdef');
    expect(parseGenerationHistoryAssetUrl(url)).toEqual({ historyAssetId: 'history_asset_0123456789abcdef' });
  });

  it('round-trips one derived preview identity without aliasing the original', () => {
    const url = createGenerationHistoryPreviewUrl('history_asset_0123456789abcdef');
    expect(url).toBe('novus-history://preview/history_asset_0123456789abcdef');
    expect(parseGenerationHistoryAssetUrl(url)).toEqual({
      historyAssetId: 'history_asset_0123456789abcdef',
      variant: 'preview',
    });
  });

  it.each([
    'novus-history://asset/../private',
    'novus-history://asset/history_asset_0123456789abcdef?path=private',
    'novus-history://user:pass@asset/history_asset_0123456789abcdef',
    'https://asset/history_asset_0123456789abcdef',
    'novus-history://asset/history_asset_0123456789abcdef/extra',
    'novus-history://preview/../private',
    'novus-history://unknown/history_asset_0123456789abcdef',
  ])('rejects unsafe URL %s', (value) => {
    expect(parseGenerationHistoryAssetUrl(value)).toBeNull();
  });
});
