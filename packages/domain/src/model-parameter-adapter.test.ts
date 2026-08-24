import { describe, expect, it } from 'vitest';
import { adaptGenerationParameters } from './model-parameter-adapter';

describe('model parameter adapter', () => {
  it('keeps an image request exact when every target is supported', () => {
    expect(adaptGenerationParameters({
      kind: 'image', aspectRatio: '16:9', resolution: '4K', outputCount: 4,
    }, {
      image: { aspectRatios: ['1:1', '16:9'], resolutions: ['1K', '2K', '4K'], outputCounts: [1, 2, 3, 4] },
    })).toEqual({
      status: 'exact',
      actual: { kind: 'image', aspectRatio: '16:9', resolution: '4K', outputCount: 4 },
      adjustments: [],
    });
  });

  it('selects the nearest supported image values and requires confirmation', () => {
    const result = adaptGenerationParameters({
      kind: 'image', aspectRatio: '9:16', resolution: '4K', outputCount: 4,
    }, {
      image: { aspectRatios: ['1:1', '16:9'], resolutions: ['1K', '2K'], outputCounts: [1, 2] },
    });

    expect(result).toMatchObject({
      status: 'requires_confirmation',
      actual: { kind: 'image', aspectRatio: '1:1', resolution: '2K', outputCount: 2 },
    });
    expect(result.adjustments).toEqual(expect.arrayContaining([
      expect.stringContaining('比例'), expect.stringContaining('清晰度'), expect.stringContaining('数量'),
    ]));
  });

  it('adapts video resolution, option duration, and output count together', () => {
    const result = adaptGenerationParameters({
      kind: 'video', aspectRatio: '16:9', resolution: '4K', durationSeconds: 7, outputCount: 4,
    }, {
      video: {
        aspectRatios: ['16:9'], resolutions: ['720p', '1080p'],
        duration: { mode: 'options', options: [4, 6, 8], defaultValue: 4 }, outputCounts: [1, 2],
      },
    });

    expect(result).toMatchObject({
      status: 'requires_confirmation',
      actual: { kind: 'video', aspectRatio: '16:9', resolution: '1080p', durationSeconds: 6, outputCount: 2 },
    });
    expect(result.adjustments).toEqual(expect.arrayContaining([
      expect.stringContaining('视频清晰度'), expect.stringContaining('视频时长'), expect.stringContaining('生成数量'),
    ]));
  });

  it('maps an unsupported standard video ratio to the nearest provider ratio and requires confirmation', () => {
    const result = adaptGenerationParameters({
      kind: 'video', aspectRatio: '3:4', resolution: '1080p', durationSeconds: 6, outputCount: 1,
    }, {
      video: {
        aspectRatios: ['1:1', '16:9'], resolutions: ['1080p'],
        duration: { mode: 'options', options: [6] }, outputCounts: [1],
      },
    });

    expect(result).toMatchObject({
      status: 'requires_confirmation',
      actual: { kind: 'video', aspectRatio: '1:1' },
    });
    expect(result.adjustments[0]).toContain('3:4');
    expect(result.adjustments[0]).toContain('1:1');
  });
  it('treats 2K as a first-class video resolution tier', () => {
    expect(adaptGenerationParameters({
      kind: 'video', aspectRatio: '16:9', resolution: '2K', durationSeconds: 10, outputCount: 1,
    }, {
      video: {
        resolutions: ['1080p', '2K', '4K'], duration: { mode: 'options', options: [10] }, outputCounts: [1],
      },
    })).toMatchObject({ status: 'exact', actual: { resolution: '2K' } });
  });
  it('orders nonstandard video tiers by their real vertical resolution', () => {
    expect(adaptGenerationParameters({
      kind: 'video', aspectRatio: '16:9', resolution: '540p', durationSeconds: 6, outputCount: 1,
    }, {
      video: { resolutions: ['360p', '512p', '768p'], duration: { mode: 'options', options: [6] }, outputCounts: [1] },
    })).toMatchObject({ status: 'requires_confirmation', actual: { resolution: '512p' } });
  });
  it('adapts a range-based video duration', () => {
    expect(adaptGenerationParameters({
      kind: 'video', aspectRatio: '16:9', resolution: '1080p', durationSeconds: 16, outputCount: 1,
    }, {
      video: {
        aspectRatios: ['16:9'], resolutions: ['1080p'],
        duration: { mode: 'range', min: 3, max: 15, step: 1, defaultValue: 5 }, outputCounts: [1],
      },
    })).toMatchObject({ status: 'requires_confirmation', actual: { durationSeconds: 15 } });
  });

  it('fails closed when the selected model has no constraints for the requested media kind', () => {
    expect(adaptGenerationParameters({
      kind: 'video', aspectRatio: '16:9', resolution: '1080p', durationSeconds: 6, outputCount: 1,
    }, {})).toEqual({
      status: 'unsupported', actual: null, adjustments: ['模型参数能力未完整返回，无法安全提交视频生成。'],
    });
  });
});