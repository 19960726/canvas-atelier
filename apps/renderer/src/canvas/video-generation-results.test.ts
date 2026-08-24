import { describe, expect, it } from 'vitest';
import { readVideoGenerationResults } from './video-generation-results';

describe('readVideoGenerationResults', () => {
  it.each([0, 1, 2, 3, 4])('returns exactly %i real completed video results', (count) => {
    const videoResults = Array.from({ length: count }, (_, index) => ({
      assetId: `video-result-${index + 1}`,
      mediaType: 'video/mp4',
      durationMs: 5000,
      posterUrl: `/__novus_e2e_asset/${String(index + 1).padStart(16, '0')}.svg`,
    }));

    expect(readVideoGenerationResults({ outputCount: 4, videoResults })).toHaveLength(count);
  });

  it('does not convert requested quantity or reference assets into generated results', () => {
    expect(readVideoGenerationResults({
      outputCount: 4,
      referenceAssetIds: ['0123456789abcdef'],
      resultState: 'fresh',
    })).toEqual([]);
  });

  it('rejects malformed and duplicate result records', () => {
    expect(readVideoGenerationResults({
      videoResults: [
        { assetId: 'video-result-1', mediaType: 'video/mp4', durationMs: 5000 },
        { assetId: 'video-result-1', mediaType: 'video/mp4', durationMs: 5000 },
        { assetId: '', mediaType: 'video/mp4', durationMs: 5000 },
        { assetId: 'image-result', mediaType: 'image/png', durationMs: 5000 },
      ],
    })).toEqual([{ assetId: 'video-result-1', mediaType: 'video/mp4', durationMs: 5000 }]);
  });
});