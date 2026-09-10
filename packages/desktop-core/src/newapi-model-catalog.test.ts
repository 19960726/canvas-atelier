import { describe, expect, it } from 'vitest';

import {
  buildAuthenticatedNewApiCatalog,
  parseNewApiPricing,
} from './newapi-model-catalog';
import { NEW_API_PROVIDER_SEEDS } from './newapi-provider-seeds';

describe('New API authenticated model catalog', () => {
  it('normalizes the public pricing payload and rejects malformed endpoint metadata', () => {
    expect(parseNewApiPricing({
      success: true,
      data: [{
        model_name: 'sora-2',
        description: 'video',
        pricing_version: '2026-09',
        supported_endpoint_types: ['openai-video'],
      }],
    })).toEqual([{
      modelName: 'sora-2',
      description: 'video',
      pricingVersion: '2026-09',
      supportedEndpointTypes: ['openai-video'],
    }]);
    expect(() => parseNewApiPricing({ success: true, data: [{ model_name: 'bad' }] }))
      .toThrow(/pricing/i);
  });

  it('accepts the nullable metadata returned by the live Julun and 4D pricing catalogs', () => {
    expect(parseNewApiPricing({
      success: true,
      data: [{
        model_name: 'seedance-2.0-fast-deal',
        description: null,
        pricing_version: null,
        image_ratio: null,
        supported_endpoint_types: ['openai-video'],
      }],
    })).toEqual([{
      modelName: 'seedance-2.0-fast-deal',
      imageRatio: null,
      supportedEndpointTypes: ['openai-video'],
    }]);
  });

  it('preserves the native 4K group evidence returned for 4D GPT Image 2.5', () => {
    expect(parseNewApiPricing({
      success: true,
      data: [{
        model_name: 'gpt-image-2.5-flare',
        supported_endpoint_types: ['openai'],
        enable_groups: ['GPT原生4K 0.12一张'],
      }],
    })).toEqual([{
      modelName: 'gpt-image-2.5-flare',
      supportedEndpointTypes: ['openai'],
      enableGroups: ['GPT原生4K 0.12一张'],
    }]);
  });

  it('publishes only the Julun account/pricing intersection and only as video', () => {
    const profiles = buildAuthenticatedNewApiCatalog({
      provider: 'julun',
      accessibleModelIds: ['sora-2', 'private-only'],
      pricing: [
        { modelName: 'sora-2', supportedEndpointTypes: ['openai-video'] },
        { modelName: 'public-only', supportedEndpointTypes: ['openai-video'] },
        { modelName: 'gpt-image-1', supportedEndpointTypes: ['image-generation'] },
      ],
    });

    expect(profiles).toEqual([expect.objectContaining({
      provider: 'julun',
      modelId: 'sora-2',
      capabilities: ['video_generation', 'async_tasks'],
      capabilityStatus: 'complete',
      constraints: { video: {
        aspectRatios: ['16:9'],
        resolutions: ['720p'],
        duration: { mode: 'options', defaultValue: 10, options: [5, 10] },
        outputCounts: [1],
      } },
    })]);
  });

  it('keeps openai-only image-named 4D models visible but incomplete and gates vision by allowlist', () => {
    const profiles = buildAuthenticatedNewApiCatalog({
      provider: '4dai',
      accessibleModelIds: ['gpt-image-1.5', 'gpt-image-2', 'gpt-4.1', 'sora-2'],
      pricing: [
        { modelName: 'gpt-image-1.5', supportedEndpointTypes: ['image-generation'] },
        { modelName: 'gpt-image-2', supportedEndpointTypes: ['openai'] },
        { modelName: 'gpt-4.1', supportedEndpointTypes: ['openai'] },
        { modelName: 'sora-2', supportedEndpointTypes: ['openai-video'] },
      ],
      verifiedVisionModelIds: ['gpt-4.1'],
    });

    expect(profiles).toEqual([
      expect.objectContaining({ modelId: 'gpt-image-1.5', capabilities: ['image_generation'], capabilityStatus: 'complete' }),
      expect.objectContaining({ modelId: 'gpt-image-2', capabilities: ['image_generation'], capabilityStatus: 'incomplete' }),
      expect.objectContaining({ modelId: 'gpt-4.1', capabilities: ['chat', 'vision', 'reverse_prompt'], capabilityStatus: 'complete' }),
    ]);
    expect(profiles.some((profile) => profile.capabilities.includes('video_generation'))).toBe(false);
  });

  it('shows the current authenticated 4D image-name families as incomplete without promoting unrelated openai routes', () => {
    const candidates = [
      'gpt-image-2',
      'gpt-image-2-2k',
      'gpt-image-2-4k',
      'gpt-image-2.5-flare',
      'gpt-image-2.5-sunburst',
      'grok-imagine-image-2.0',
      'grok-imagine-image-quality',
      'gemini-3-pro-image-preview',
      'gemini-3-pro-image-preview-4k',
      'gemini-3-pro-image-special-4k',
      'gemini-3.1-flash-image-preview',
    ];
    const profiles = buildAuthenticatedNewApiCatalog({
      provider: '4dai',
      accessibleModelIds: [...candidates, 'ordinary-openai-chat', 'sora-video'],
      pricing: [
        ...candidates.map((modelName) => ({ modelName, supportedEndpointTypes: ['openai'] })),
        { modelName: 'ordinary-openai-chat', supportedEndpointTypes: ['openai'] },
        { modelName: 'sora-video', supportedEndpointTypes: ['openai-video'] },
      ],
    });

    expect(profiles.map((profile) => profile.modelId)).toEqual(candidates);
    expect(profiles.every((profile) => profile.capabilityStatus === 'incomplete')).toBe(true);
    expect(profiles.every((profile) => profile.capabilities.join(',') === 'image_generation')).toBe(true);
  });

  it('promotes only the two audited 4D GPT Image 2.5 routes with native 4K group evidence', () => {
    const profiles = buildAuthenticatedNewApiCatalog({
      provider: '4dai',
      accessibleModelIds: [
        'gpt-image-2.5-flare',
        'gpt-image-2.5-sunburst',
        'ordinary-openai-chat',
      ],
      pricing: [
        {
          modelName: 'gpt-image-2.5-flare',
          supportedEndpointTypes: ['openai'],
          enableGroups: ['GPT原生4K 0.12一张'],
        },
        {
          modelName: 'gpt-image-2.5-sunburst',
          supportedEndpointTypes: ['openai'],
          enableGroups: ['GPT原生4K 0.12一张'],
        },
        {
          modelName: 'ordinary-openai-chat',
          supportedEndpointTypes: ['openai'],
          enableGroups: ['GPT原生4K 0.12一张'],
        },
      ],
    });

    expect(profiles).toEqual([
      expect.objectContaining({
        modelId: 'gpt-image-2.5-flare',
        capabilities: ['image_generation'],
        capabilityStatus: 'complete',
        constraints: { image: { aspectRatios: ['1:1'], resolutions: ['4K'], outputCounts: [1] } },
      }),
      expect.objectContaining({
        modelId: 'gpt-image-2.5-sunburst',
        capabilities: ['image_generation'],
        capabilityStatus: 'complete',
        constraints: { image: { aspectRatios: ['1:1'], resolutions: ['4K'], outputCounts: [1] } },
      }),
    ]);
  });

  it('publishes authenticated 4D Nano Banana 2 and Pro through their audited Gemini image routes', () => {
    const profiles = buildAuthenticatedNewApiCatalog({
      provider: '4dai',
      accessibleModelIds: [
        'gemini-3.1-flash-image-preview',
        'gemini-3-pro-image-preview',
        'gemini-3-pro-image-preview-4k',
      ],
      pricing: [
        {
          modelName: 'gemini-3.1-flash-image-preview',
          supportedEndpointTypes: ['openai', 'gemini'],
          enableGroups: ['香蕉测试   限时免费'],
        },
        {
          modelName: 'gemini-3-pro-image-preview',
          supportedEndpointTypes: ['openai', 'gemini'],
          enableGroups: ['Banana pro 4k 0.2一张'],
        },
        {
          modelName: 'gemini-3-pro-image-preview-4k',
          supportedEndpointTypes: ['openai'],
          enableGroups: ['Banana pro 4k 0.2一张'],
        },
      ],
    });

    expect(profiles).toEqual([
      expect.objectContaining({
        modelId: 'gemini-3.1-flash-image-preview',
        modelRoute: '4dai-gemini-3-1-flash-image-preview',
        capabilities: ['image_generation', 'image_edit'],
        capabilityStatus: 'complete',
        constraints: { image: {
          aspectRatios: ['1:1', '2:3', '3:2', '4:3', '3:4', '16:9', '9:16'],
          resolutions: ['1K', '2K', '4K'],
          outputCounts: [1],
        } },
      }),
      expect.objectContaining({
        modelId: 'gemini-3-pro-image-preview',
        modelRoute: '4dai-gemini-3-pro-image-preview',
        capabilities: ['image_generation', 'image_edit'],
        capabilityStatus: 'complete',
        constraints: { image: {
          aspectRatios: ['1:1', '2:3', '3:2', '4:3', '3:4', '16:9', '9:16'],
          resolutions: ['1K', '2K', '4K'],
          outputCounts: [1],
        } },
      }),
      expect.objectContaining({
        modelId: 'gemini-3-pro-image-preview-4k',
        capabilities: ['image_generation'],
        capabilityStatus: 'incomplete',
      }),
    ]);
  });

  it('keeps exact 4D Nano Banana 2 and Pro incomplete without Gemini endpoint evidence', () => {
    const profiles = buildAuthenticatedNewApiCatalog({
      provider: '4dai',
      accessibleModelIds: [
        'gemini-3.1-flash-image-preview',
        'gemini-3-pro-image-preview',
      ],
      pricing: [
        {
          modelName: 'gemini-3.1-flash-image-preview',
          supportedEndpointTypes: ['image-generation'],
        },
        {
          modelName: 'gemini-3-pro-image-preview',
          supportedEndpointTypes: ['image-generation'],
        },
      ],
    });

    expect(profiles).toEqual([
      expect.objectContaining({
        modelId: 'gemini-3.1-flash-image-preview',
        capabilities: ['image_generation'],
        capabilityStatus: 'incomplete',
        constraints: { image: { outputCounts: [1] } },
      }),
      expect.objectContaining({
        modelId: 'gemini-3-pro-image-preview',
        capabilities: ['image_generation'],
        capabilityStatus: 'incomplete',
        constraints: { image: { outputCounts: [1] } },
      }),
    ]);
  });

  it('promotes an image-named candidate only when pricing explicitly declares image-generation', () => {
    expect(buildAuthenticatedNewApiCatalog({
      provider: '4dai',
      accessibleModelIds: ['gpt-image-2'],
      pricing: [{ modelName: 'gpt-image-2', supportedEndpointTypes: ['openai', 'image-generation'] }],
    })).toEqual([expect.objectContaining({
      modelId: 'gpt-image-2', capabilities: ['image_generation'], capabilityStatus: 'complete',
    })]);
  });

  it('keeps 4D GPT Image 2 fixed-tier model ids bound to their exact 2K or 4K contract', () => {
    const profiles = buildAuthenticatedNewApiCatalog({
      provider: '4dai',
      accessibleModelIds: ['gpt-image-2-2k', 'gpt-image-2-4k'],
      pricing: [
        { modelName: 'gpt-image-2-2k', supportedEndpointTypes: ['image-generation'] },
        { modelName: 'gpt-image-2-4k', supportedEndpointTypes: ['image-generation'] },
      ],
    });

    expect(profiles.map((profile) => [profile.modelId, profile.constraints?.image?.resolutions])).toEqual([
      ['gpt-image-2-2k', ['2K']],
      ['gpt-image-2-4k', ['4K']],
    ]);
  });

  it('publishes only the three GPT Image 1 and 1.5 ratios the service maps exactly', () => {
    const profiles = buildAuthenticatedNewApiCatalog({
      provider: '4dai',
      accessibleModelIds: ['gpt-image-1', 'gpt-image-1.5'],
      pricing: [
        { modelName: 'gpt-image-1', supportedEndpointTypes: ['image-generation'] },
        { modelName: 'gpt-image-1.5', supportedEndpointTypes: ['image-generation'] },
      ],
    });

    expect(profiles).toEqual([
      expect.objectContaining({ modelId: 'gpt-image-1', constraints: { image: expect.objectContaining({
        aspectRatios: ['1:1', '3:2', '2:3'], resolutions: ['1K'], outputCounts: [1],
      }) } }),
      expect.objectContaining({ modelId: 'gpt-image-1.5', constraints: { image: expect.objectContaining({
        aspectRatios: ['1:1', '3:2', '2:3'], resolutions: ['1K'], outputCounts: [1],
      }) } }),
    ]);
  });

  it('limits every runnable 4D image route to the single result the durable task stores', () => {
    const profiles = buildAuthenticatedNewApiCatalog({
      provider: '4dai',
      accessibleModelIds: ['gpt-image-2', 'grok-imagine-image-2.0'],
      pricing: [
        { modelName: 'gpt-image-2', supportedEndpointTypes: ['image-generation'] },
        { modelName: 'grok-imagine-image-2.0', supportedEndpointTypes: ['image-generation'] },
      ],
    });

    expect(profiles).toHaveLength(2);
    expect(profiles.every((profile) => (
      profile.constraints?.image?.outputCounts?.join(',') === '1'
    ))).toBe(true);
  });

  it('publishes conservative square 1K constraints for unknown verified 4D image-generation models', () => {
    const [profile] = buildAuthenticatedNewApiCatalog({
      provider: '4dai',
      accessibleModelIds: ['vendor-image-v7'],
      pricing: [{ modelName: 'vendor-image-v7', supportedEndpointTypes: ['image-generation'] }],
    });

    expect(profile).toMatchObject({
      modelId: 'vendor-image-v7',
      capabilityStatus: 'complete',
      constraints: { image: {
        aspectRatios: ['1:1'],
        resolutions: ['1K'],
        sizes: ['1024x1024'],
        outputCounts: [1],
      } },
    });
  });

  it('does not advertise verified size or ratio constraints for openai-only image candidates', () => {
    const [profile] = buildAuthenticatedNewApiCatalog({
      provider: '4dai',
      accessibleModelIds: ['grok-imagine-image-quality'],
      pricing: [{ modelName: 'grok-imagine-image-quality', supportedEndpointTypes: ['openai'] }],
    });

    expect(profile).toMatchObject({ capabilityStatus: 'incomplete', constraints: { image: { outputCounts: [1] } } });
    expect(profile?.constraints?.image?.aspectRatios).toBeUndefined();
    expect(profile?.constraints?.image?.resolutions).toBeUndefined();
    expect(profile?.constraints?.image?.sizes).toBeUndefined();
  });

  it('treats positive public image_ratio as verified 4D vision evidence but ignores null thinking variants', () => {
    const pricing = parseNewApiPricing({
      success: true,
      data: [
        { model_name: 'gpt-6-astra', supported_endpoint_types: ['openai'], image_ratio: 0.5 },
        { model_name: 'gpt-6-astra-thinking', supported_endpoint_types: ['openai'], image_ratio: null },
      ],
    });

    expect(buildAuthenticatedNewApiCatalog({
      provider: '4dai',
      accessibleModelIds: ['gpt-6-astra', 'gpt-6-astra-thinking'],
      pricing,
    })).toEqual([expect.objectContaining({
      modelId: 'gpt-6-astra',
      capabilities: ['chat', 'vision', 'reverse_prompt'],
      capabilityStatus: 'complete',
    })]);
  });

  it('marks unauthenticated built-in seeds incomplete so they cannot be treated as runnable', () => {
    expect(NEW_API_PROVIDER_SEEDS.julun.length).toBeGreaterThan(0);
    expect(NEW_API_PROVIDER_SEEDS['4dai'].length).toBeGreaterThan(0);
    expect(Object.values(NEW_API_PROVIDER_SEEDS).flat().every((profile) => profile.capabilityStatus === 'incomplete')).toBe(true);
  });

  it('keeps the Julun seed preview aligned to the 11-name public pricing snapshot', () => {
    expect(NEW_API_PROVIDER_SEEDS.julun.map((profile) => profile.modelId)).toEqual([
      'seedance-2.0-fast-deal',
      'grok-imagine-video-1.5-preview',
      'grok-imagine-video-1.5（按次）',
      'Minimax-H3-768p-933-10s-15s',
      'minimax-h3 768p',
      'minimax-h3 2k',
      'sd2.0-720',
      'sd2-mini',
      'minimax_h3',
      'sd2.5',
      'seedance-2.0-deal',
    ]);
  });

  it('previews only publicly evidenced 4D image and visual capabilities as incomplete', () => {
    expect(NEW_API_PROVIDER_SEEDS['4dai']).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: 'gpt-image-1', capabilities: ['image_generation'], capabilityStatus: 'incomplete' }),
      expect.objectContaining({ modelId: 'gpt-image-1.5', capabilities: ['image_generation'], capabilityStatus: 'incomplete' }),
      expect.objectContaining({ modelId: 'gpt-6-astra', capabilities: ['chat', 'vision', 'reverse_prompt'], capabilityStatus: 'incomplete' }),
      expect.objectContaining({ modelId: 'claude-fable-5', capabilities: ['chat', 'vision', 'reverse_prompt'], capabilityStatus: 'incomplete' }),
      expect.objectContaining({ modelId: 'claude-opus-5', capabilities: ['chat', 'vision', 'reverse_prompt'], capabilityStatus: 'incomplete' }),
      expect.objectContaining({ modelId: 'gpt-image-2', capabilities: ['image_generation'], capabilityStatus: 'incomplete' }),
      expect.objectContaining({ modelId: 'gpt-image-2.5-sunburst', capabilities: ['image_generation'], capabilityStatus: 'incomplete' }),
      expect.objectContaining({ modelId: 'grok-imagine-image-quality', capabilities: ['image_generation'], capabilityStatus: 'incomplete' }),
      expect.objectContaining({ modelId: 'gemini-3.1-flash-image-preview', capabilities: ['image_generation'], capabilityStatus: 'incomplete' }),
    ]));
  });

  it('namespaces equal upstream model ids by provider so persisted routes never collide', () => {
    const julun = buildAuthenticatedNewApiCatalog({
      provider: 'julun', accessibleModelIds: ['shared-model'],
      pricing: [{ modelName: 'shared-model', supportedEndpointTypes: ['openai-video'] }],
    });
    const fourD = buildAuthenticatedNewApiCatalog({
      provider: '4dai', accessibleModelIds: ['shared-model'],
      pricing: [{ modelName: 'shared-model', supportedEndpointTypes: ['image-generation'] }],
    });
    expect(julun[0]).toMatchObject({ modelRoute: 'julun-shared-model', modelId: 'shared-model' });
    expect(fourD[0]).toMatchObject({ modelRoute: '4dai-shared-model', modelId: 'shared-model' });
  });

  it('builds distinct stable routes for model ids whose legacy slugs collide', () => {
    const modelIds = ['foo.bar', 'foo-bar', '图像 模型', '图像-模型'];
    const build = (ids: readonly string[]) => buildAuthenticatedNewApiCatalog({
      provider: '4dai',
      accessibleModelIds: modelIds,
      pricing: ids.map((modelName) => ({ modelName, supportedEndpointTypes: ['image-generation'] })),
    });
    const first = build(modelIds);
    const refreshed = build([...modelIds].reverse());
    const routesByModel = Object.fromEntries(first.map((profile) => [profile.modelId, profile.modelRoute]));
    const refreshedRoutesByModel = Object.fromEntries(refreshed.map((profile) => [profile.modelId, profile.modelRoute]));

    expect(first.map((profile) => profile.modelId)).toEqual(modelIds);
    expect(new Set(first.map((profile) => profile.modelRoute)).size).toBe(modelIds.length);
    expect(refreshedRoutesByModel).toEqual(routesByModel);
    expect(routesByModel).toMatchObject({
      'foo.bar': '4dai-model@Zm9vLmJhcg',
      'foo-bar': '4dai-foo-bar',
      '图像 模型': '4dai-model@5Zu-5YOPIOaooeWeiw',
      '图像-模型': '4dai-model@5Zu-5YOPLeaooeWeiw',
    });
  });

  it('builds distinct order-independent routes within 160 characters for long Unicode model ids', () => {
    const commonPrefix = '超长图像模型'.repeat(24);
    const modelIds = [`${commonPrefix}甲`, `${commonPrefix}乙`];
    const build = (ids: readonly string[]) => buildAuthenticatedNewApiCatalog({
      provider: '4dai',
      accessibleModelIds: ids,
      pricing: ids.map((modelName) => ({ modelName, supportedEndpointTypes: ['image-generation'] })),
    });

    const first = build(modelIds);
    const refreshed = build([...modelIds].reverse());
    const routesByModel = Object.fromEntries(first.map((profile) => [profile.modelId, profile.modelRoute]));

    expect(first.map((profile) => profile.modelId)).toEqual(modelIds);
    expect(first.every((profile) => profile.modelRoute.length <= 160)).toBe(true);
    expect(new Set(first.map((profile) => profile.modelRoute)).size).toBe(modelIds.length);
    expect(Object.fromEntries(refreshed.map((profile) => [profile.modelId, profile.modelRoute])))
      .toEqual(routesByModel);
  });

  it('keeps established seed routes compatible while preserving exact Unicode and spaced model ids', () => {
    const julun = buildAuthenticatedNewApiCatalog({
      provider: 'julun',
      accessibleModelIds: ['grok-imagine-video-1.5（按次）', 'minimax-h3 2k'],
      pricing: [
        { modelName: 'grok-imagine-video-1.5（按次）', supportedEndpointTypes: ['openai-video'] },
        { modelName: 'minimax-h3 2k', supportedEndpointTypes: ['openai-video'] },
      ],
    });
    const fourD = buildAuthenticatedNewApiCatalog({
      provider: '4dai',
      accessibleModelIds: ['gpt-image-1.5'],
      pricing: [{ modelName: 'gpt-image-1.5', supportedEndpointTypes: ['image-generation'] }],
    });

    expect(julun).toEqual([
      expect.objectContaining({ modelId: 'grok-imagine-video-1.5（按次）', modelRoute: 'julun-grok-imagine-video-1-5' }),
      expect.objectContaining({ modelId: 'minimax-h3 2k', modelRoute: 'julun-minimax-h3-2k' }),
    ]);
    expect(fourD[0]).toMatchObject({ modelId: 'gpt-image-1.5', modelRoute: '4dai-gpt-image-1-5' });
  });

  it('keeps an existing saved route bound to its exact model when a colliding model appears later', () => {
    const profiles = buildAuthenticatedNewApiCatalog({
      provider: '4dai',
      accessibleModelIds: ['foo.bar', 'foo-bar'],
      pricing: [
        { modelName: 'foo.bar', supportedEndpointTypes: ['image-generation'] },
        { modelName: 'foo-bar', supportedEndpointTypes: ['image-generation'] },
      ],
      persistedProfiles: [{ provider: '4dai', modelId: 'foo.bar', modelRoute: '4dai-foo-bar' }],
    });

    expect(profiles.find((profile) => profile.modelId === 'foo.bar')?.modelRoute).toBe('4dai-foo-bar');
    expect(profiles.find((profile) => profile.modelId === 'foo-bar')?.modelRoute).not.toBe('4dai-foo-bar');
  });
});
