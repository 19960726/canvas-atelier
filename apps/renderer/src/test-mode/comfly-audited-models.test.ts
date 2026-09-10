import { describe, expect, it } from 'vitest';

import { auditedComflyCanvasProfiles } from './comfly-audited-models';

describe('audited Comfly offline catalog', () => {
  it('keeps the 2026-09-09 image additions available in controlled desktop tests', () => {
    const expected = [
      'gpt-image-2.5-flare',
      'gpt-image-2.5-flare-2k',
      'gpt-image-2.5-flare-4k',
      'gpt-image-2.5-sunburst',
      'gpt-image-2.5-sunburst-2k',
      'gpt-image-2.5-sunburst-4k',
      'grok-imagine-image-2.0',
      'nano-banana-2',
      'nano-banana-2-2k',
      'nano-banana-2-4k',
    ];
    const byId = new Map(auditedComflyCanvasProfiles.map((profile) => [profile.modelId, profile]));

    expect(expected.filter((modelId) => !byId.has(modelId))).toEqual([]);
    expect(byId.get('grok-imagine-image-2.0')).toMatchObject({
      capabilities: ['image_generation', 'image_edit'],
      constraints: { image: { resolutions: ['1K', '2K'] } },
    });
    expect(byId.get('gpt-image-2.5-flare-4k')?.constraints?.image?.resolutions).toEqual(['4K']);
    expect(byId.get('nano-banana-2-4k')?.constraints?.image?.resolutions).toEqual(['4K']);
  });
});
