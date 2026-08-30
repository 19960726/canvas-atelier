import { describe, expect, it } from 'vitest';
import { buildComflyModelProfiles, buildRelayMeModelProfiles, buildRelayMeWorkflowModelProfiles, mergeProviderModelProfiles } from './provider-model-catalog';
import type { ComflyAccessibleModelCatalog } from '@agent-canvas/provider-comfly';
import type { RelayMeModel } from '@agent-canvas/provider-relayme';

const relayModels: RelayMeModel[] = [
  {
    name: 'RENA2', deploymentName: 'gemini-3.1-flash-image-preview', capability: 'image', modelType: 'TEXT', endpoints: ['/api/ai-tools/v1/images/generations'],
    isDefault: false, offers: [{ id: '14', specialOffer: false, pricing: { image1k: '260', image2k: '260', image4k: '450' } }],
  },
  {
    name: 'RENAF', deploymentName: 'gemini-3.1-flash-lite', capability: 'text', modelType: 'TEXT', endpoints: ['/api/ai-tools/v1/chat/completions'],
    isDefault: false, offers: [{ id: '19', specialOffer: false }],
  },
  {
    name: 'Kling3', deploymentName: 'kling/kling-v3-video-generation', capability: 'video', modelType: 'VIDEO', endpoints: ['/api/ai-tools/v1/videos/generations'],
    isDefault: false, offers: [{ id: '15', specialOffer: false }],
    videoCapabilities: {
      resolutions: ['480p', '720p', '1080p'],
      aspectRatios: ['16:9', '9:16', '1:1'],
      duration: { mode: 'range', min: 3, max: 15, step: 1, defaultValue: 5 },
    },
  },
];

describe('provider model catalog', () => {
  it('filters blank, incomplete, and duplicate Comfly catalog entries', () => {
    const profiles = buildComflyModelProfiles({ version: 'filtering', models: [
      { key: 'same-model', name: 'Same Model', provider: 'OpenAI', tags: ['绘图'], apis: ['/v1/images/generations'], capabilityStatus: 'complete' },
      { key: 'same-model', name: 'Duplicate', provider: 'OpenAI', tags: ['绘图'], apis: ['/v1/images/generations'], capabilityStatus: 'complete' },
      { key: '   ', name: 'Blank key', provider: 'Other', tags: [], apis: [], capabilityStatus: 'incomplete' },
      { key: 'missing-name', name: '   ', provider: 'Other', tags: [], apis: [], capabilityStatus: 'incomplete' },
    ] });
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ modelId: 'same-model', displayName: 'Same Model' });
  });
  it('builds constrained profiles when structuredClone is unavailable in the packaged Node 16 runtime', () => {
    const previousStructuredClone = globalThis.structuredClone;
    Object.defineProperty(globalThis, 'structuredClone', { configurable: true, value: undefined });
    try {
      const profiles = buildComflyModelProfiles({
        version: 'node16-runtime',
        models: [{
          key: 'doubao-seedance-2.5',
          name: 'Seedance 2.5',
          provider: 'ByteDance',
          tags: ['视频'],
          apis: [],
          capabilityStatus: 'complete',
          parameterTable: { headers: ['Resolution'], rows: [['480p'], ['720p'], ['1080p']] },
        }],
      });
      expect(profiles[0]?.constraints?.video?.resolutions).toEqual(['480p', '720p', '1080p']);
    } finally {
      Object.defineProperty(globalThis, 'structuredClone', { configurable: true, value: previousStructuredClone });
    }
  });
  it('maps Comfly models only from official tags and endpoint metadata', () => {
    const catalog: ComflyAccessibleModelCatalog = {
      version: 'catalog-v1',
      models: [
        {
          key: 'gpt-image-2', name: 'GPT Image 2', provider: 'OpenAI', tags: ['绘图', '图像编辑'], apis: ['POST-/v1/images/generations-1', 'POST-/v1/images/edits-2'], capabilityStatus: 'complete',
          parameterTable: { headers: ['张数(N)'], rows: [['1']] },
        },
        {
          key: 'veo3.1-fast', name: 'Veo 3.1 Fast', provider: 'Google', tags: ['视频', '异步任务'], apis: ['POST-/v2/videos/generations-3'], capabilityStatus: 'complete',
          parameterTable: { headers: ['分辨率', '视频时长'], rows: [['720P', '5秒'], ['1080P', '10秒'], ['2k(720p upscale)', '15秒'], ['4k(720p upscale)', '15秒']] },
        },
        { key: 'vision-chat', name: 'Vision Chat', provider: 'Google', tags: ['对话', '识图', '多模态'], apis: ['POST-/v1/chat/completions-4'], capabilityStatus: 'complete' },
        { key: 'mystery-video-name', name: 'Video Looking Name', provider: 'Other', tags: [], apis: [], capabilityStatus: 'incomplete' },
      ],
    };

    const profiles = buildComflyModelProfiles(catalog);
    expect(profiles.find((item) => item.modelId === 'gpt-image-2')).toMatchObject({
      capabilities: ['image_generation', 'image_edit'],
      constraints: { image: { outputCounts: [1] } },
    });
    expect(profiles.find((item) => item.modelId === 'veo3.1-fast')).toMatchObject({ capabilities: ['video_generation', 'async_tasks'], constraints: { video: { resolutions: ['720p', '1080p', '2K', '4K'], duration: { mode: 'options', options: [5, 10, 15] }, outputCounts: [1] } } });
    expect(profiles.find((item) => item.modelId === 'vision-chat')).toMatchObject({ capabilities: ['chat', 'vision', 'reverse_prompt'] });
    expect(profiles.find((item) => item.modelId === 'mystery-video-name')).toMatchObject({ capabilities: [], capabilityStatus: 'incomplete' });
  });

  it('uses explicit Comfly image endpoints when a multimodal model is tagged as chat', () => {
    const profiles = buildComflyModelProfiles({
      version: 'catalog-nano-banana-2',
      models: [{
        key: 'nano-banana-2',
        name: 'nano-banana-2',
        provider: 'Google',
        tags: ['对话'],
        apis: [
          'POST-/v1/chat/completions-287782792',
          'POST-/v1/images/edits-341817449',
          'POST-/v1/images/generations-341817446',
        ],
        capabilityStatus: 'complete',
      }],
    });

    expect(profiles[0]).toMatchObject({
      modelId: 'nano-banana-2',
      capabilities: ['image_generation', 'image_edit', 'chat'],
    });
  });

  it('does not expose tag-only Comfly models through unsupported normalized endpoints', () => {
    const profiles = buildComflyModelProfiles({
      version: 'catalog-endpoint-gate',
      models: [
        {
          key: 'chat-only-image-label',
          name: 'Chat-only image label',
          provider: 'Google',
          tags: ['绘图', '对话'],
          apis: ['POST-/v1/chat/completions-1'],
          capabilityStatus: 'complete',
        },
        {
          key: 'custom-video-endpoint',
          name: 'Custom video endpoint',
          provider: 'Kling',
          tags: ['视频'],
          apis: ['POST-/kling/v1/videos/generations-2'],
          capabilityStatus: 'complete',
        },
      ],
    });

    expect(profiles.find((profile) => profile.modelId === 'chat-only-image-label')?.capabilities).toEqual(['chat']);
    expect(profiles.find((profile) => profile.modelId === 'custom-video-endpoint')?.capabilities).toEqual([]);
  });
  it('maps each Comfly video model from its own structured parameter table', () => {
    const profiles = buildComflyModelProfiles({
      version: 'catalog-v1',
      models: [
        {
          key: 'wan2.6-i2v', name: 'Wan 2.6 I2V', provider: 'Alibaba', tags: ['视频', '异步任务'], apis: [], capabilityStatus: 'complete',
          parameterTable: { headers: ['分辨率', '视频时长'], rows: [['720P', '5秒'], ['1080P', '5秒'], ['720P', '10秒'], ['1080P', '15秒']] },
        },
        {
          key: 'doubao-seedance-2.5', name: 'Seedance 2.5', provider: 'ByteDance', tags: ['视频', '异步任务'], apis: [], capabilityStatus: 'complete',
          parameterTable: { headers: ['With video input', 'Resolution'], rows: [['Yes', '480p'], ['Yes', '720p'], ['Yes', '1080p'], ['Yes', '2k(720p upscale)'], ['Yes', '4k(720p upscale)']] },
        },
      ],
    });

    expect(profiles.find((item) => item.modelId === 'wan2.6-i2v')?.constraints).toEqual({
      video: { resolutions: ['720p', '1080p'], duration: { mode: 'options', options: [5, 10, 15] }, outputCounts: [1] },
    });
    expect(profiles.find((item) => item.modelId === 'doubao-seedance-2.5')?.constraints).toEqual({
      video: { resolutions: ['480p', '720p', '1080p', '2K', '4K'], outputCounts: [1] },
    });
  });

  it('preserves every explicit Comfly video resolution tier instead of collapsing nonstandard models', () => {
    const profiles = buildComflyModelProfiles({
      version: 'catalog-v1',
      models: [
        {
          key: 'pixverse-video', name: 'PixVerse', provider: 'PixVerse', tags: ['视频'], apis: [], capabilityStatus: 'complete',
          parameterTable: { headers: ['质量', '时长'], rows: [['360p', '5s'], ['540p', '5s'], ['720p', '8s'], ['1080p', '8s']] },
        },
        {
          key: 'hailuo-video', name: 'Hailuo', provider: 'MiniMax', tags: ['视频'], apis: [], capabilityStatus: 'complete',
          parameterTable: { headers: ['分辨率', '时长(秒)'], rows: [['512P', '6'], ['768P', '6'], ['1080P', '10']] },
        },
        {
          key: 'wan-size-video', name: 'Wan Size', provider: 'Alibaba', tags: ['视频'], apis: [], capabilityStatus: 'complete',
          parameterTable: { headers: ['Size'], rows: [['832x480'], ['1920x1080']] },
        },
      ],
    });

    expect(profiles.find((item) => item.modelId === 'pixverse-video')?.constraints?.video?.resolutions)
      .toEqual(['360p', '540p', '720p', '1080p']);
    expect(profiles.find((item) => item.modelId === 'hailuo-video')?.constraints?.video?.resolutions)
      .toEqual(['512p', '768p', '1080p']);
    expect(profiles.find((item) => item.modelId === 'wan-size-video')?.constraints?.video?.resolutions)
      .toEqual(['480p', '1080p']);
  });
  it('preserves explicit Comfly image sizes and derives only matching ratios and tiers', () => {
    const profiles = buildComflyModelProfiles({
      version: 'catalog-v1',
      models: [{
        key: 'dall-e-3', name: 'DALL-E 3', provider: 'OpenAI', tags: ['绘图'], apis: [], capabilityStatus: 'complete',
        parameterTable: { headers: ['分辨率', '张数(N)'], rows: [['1024x1024', '1'], ['1024x1792', '1']] },
      }],
    });

    expect(profiles[0]?.constraints?.image).toEqual({
      aspectRatios: ['1:1', '9:16'],
      resolutions: ['1K', '2K'],
      sizes: ['1024x1024', '1024x1792'],
      outputCounts: [1],
    });
  });
  it('does not invent generation constraints when Comfly returns no structured parameter table', () => {
    const profiles = buildComflyModelProfiles({
      version: 'catalog-v1',
      models: [{ key: 'undocumented-image', name: 'Undocumented image', provider: 'Other', tags: ['绘图'], apis: [], capabilityStatus: 'complete' }],
    });

    expect(profiles[0]?.constraints).toBeUndefined();
  });
  it('does not treat a provider-wide endpoint list as model capability metadata', () => {
    const profiles = buildComflyModelProfiles({
      version: 'catalog-v1',
      models: [{
        key: 'mj_fast_blend',
        name: 'Midjourney Blend',
        provider: 'Mid-journey',
        tags: ['绘图', '异步任务'],
        apis: [
          'POST-/mj/submit/imagine-1',
          'POST-/mj/submit/describe-2',
          'POST-/mj/submit/video-3',
        ],
        capabilityStatus: 'complete',
      }],
    });

    expect(profiles[0]?.capabilities).toEqual(['async_tasks']);
  });

  it('exposes Response API models only through the normalized endpoint they actually declare', () => {
    const profiles = buildComflyModelProfiles({
      version: 'catalog-v1',
      models: [{
        key: 'gpt-5.5',
        name: 'GPT 5.5',
        provider: 'OpenAI',
        tags: ['对话', '多模态', 'ResponseAPI'],
        apis: ['POST-/v1/responses-1'],
        capabilityStatus: 'complete',
      }],
    });

    expect(profiles[0]?.capabilities).toEqual(['responses']);
  });
  it('maps the documented RelayMe capability field instead of guessing from names or legacy modelType', () => {
    const profiles = buildRelayMeModelProfiles(relayModels);

    expect(profiles.find((item) => item.modelId === 'gemini-3.1-flash-image-preview')).toMatchObject({
      provider: 'relayme', capabilities: ['image_generation', 'async_tasks'],
      constraints: { image: { resolutions: ['1K', '2K', '4K'] } },
    });
    expect(profiles.find((item) => item.modelId === 'gemini-3.1-flash-lite')).toMatchObject({
      capabilities: ['chat'], capabilityStatus: 'complete',
    });
    expect(profiles.find((item) => item.modelId === 'kling/kling-v3-video-generation')).toMatchObject({
      capabilities: ['video_generation', 'async_tasks'],
      constraints: { video: {
        resolutions: ['480p', '720p', '1080p'],
        aspectRatios: ['16:9', '9:16', '1:1'],
        duration: { mode: 'range', min: 3, max: 15, step: 1, defaultValue: 5 },
        outputCounts: [1],
      } },
    });
  });

  it('keeps RelayMe image and video models runnable when the model catalog omits redundant per-model endpoints', () => {
    const profiles = buildRelayMeModelProfiles([{
      name: 'Nano Banana Pro', deploymentName: 'gemini-3-pro-image-preview', capability: 'image', modelType: 'IMAGE',
      isDefault: false, offers: [{ id: '31', specialOffer: false, pricing: { image1k: '260' } }],
    }, {
      name: 'Veo 3.1 Fast', deploymentName: 'veo-3-1-fast', capability: 'video', modelType: 'VIDEO',
      isDefault: false, offers: [{ id: '32', specialOffer: false }],
    }]);

    expect(profiles).toEqual([
      expect.objectContaining({ modelId: 'gemini-3-pro-image-preview', capabilityStatus: 'complete' }),
      expect.objectContaining({ modelId: 'veo-3-1-fast', capabilityStatus: 'complete' }),
    ]);
  });

  it('discovers direct RelayMe model profiles from workflow model nodes without exposing workflow names', () => {
    const profiles = buildRelayMeWorkflowModelProfiles([
      { id: 'wf-image', name: '未命名工作流 20260829', data: { nodes: [{ id: 'text-1', kind: 'input', type: 'input-text' }, { id: 'image-1', kind: 'model', modelType: 'IMAGE', model: 'gpt-image-2', name: 'GPT Image 2' }], connections: [{ fromNodeId: 'text-1', fromPortRole: 'text-output', toNodeId: 'image-1', toPortRole: 'text-input' }] } },
      { id: 'wf-video', name: '商品视频工作流', data: { nodes: [{ id: 'text-1', kind: 'input', type: 'input-text' }, { id: 'video-1', kind: 'model', modelType: 'VIDEO', model: 'kling3', name: 'Kling 3' }], connections: [{ fromNodeId: 'text-1', fromPortRole: 'text-output', toNodeId: 'video-1', toPortRole: 'text-input' }] } },
      { id: 'wf-duplicate', name: '另一个商品图工作流', data: { nodes: [{ id: 'image-2', kind: 'model', modelType: 'IMAGE', model: 'gpt-image-2', name: '不要显示这个工作流名称' }], connections: [] } },
      { id: 'wf-generic-node-name', name: 'RENA 商品图工作流', data: { nodes: [{ id: 'image-3', kind: 'model', modelType: 'IMAGE', model: 'RENA2', name: 'img', displayName: '图片模型节点' }], connections: [] } },
      { id: 'wf-empty', name: '未完成工作流', data: { nodes: [], connections: [] } },
    ]);

    expect(profiles).toEqual([
      expect.objectContaining({ modelRoute: 'relayme-gpt-image-2', modelId: 'gpt-image-2', displayName: 'GPT Image 2', capabilities: ['image_generation', 'async_tasks'], capabilityStatus: 'complete' }),
      expect.objectContaining({ modelRoute: 'relayme-kling3', modelId: 'kling3', displayName: 'Kling 3', capabilities: ['video_generation', 'async_tasks'], capabilityStatus: 'complete' }),
      expect.objectContaining({ modelRoute: 'relayme-rena2', modelId: 'RENA2', displayName: 'RENA2', capabilities: ['image_generation', 'async_tasks'], capabilityStatus: 'complete' }),
    ]);
    expect(profiles.every((profile) => !profile.modelId?.startsWith('workflow:'))).toBe(true);
  });

  it('never grants reverse or video understanding from model names alone', () => {
    const profiles = buildRelayMeModelProfiles(relayModels);
    const text = profiles.find((item) => item.modelId === 'gemini-3.1-flash-lite');
    const video = profiles.find((item) => item.modelId === 'kling/kling-v3-video-generation');

    expect(text?.capabilities).not.toContain('vision');
    expect(text?.capabilities).not.toContain('reverse_prompt');
    expect(video?.capabilities).not.toContain('video_understanding');
  });

  it('maps RelayMe image-input chat routes to executable reverse prompting', () => {
    const profiles = buildRelayMeModelProfiles([{
      name: 'Vision Chat', deploymentName: 'vision-chat', capability: 'text', modelType: 'TEXT',
      endpoints: ['/api/ai-tools/v1/chat/completions'], inputModalities: ['text', 'image', 'video'], supportsVision: true,
      isDefault: false, offers: [{ id: '22', specialOffer: false }],
    }]);

    expect(profiles[0]?.capabilities).toEqual(['chat', 'vision', 'reverse_prompt', 'video_understanding']);
  });

  it('exposes RelayMe image-input chat routes as reverse models', () => {
    const profiles = buildRelayMeModelProfiles([{
      name: 'Vision Chat', deploymentName: 'vision-chat', capability: 'text', modelType: 'TEXT',
      endpoints: ['/api/ai-tools/v1/chat/completions'], inputModalities: ['text', 'image'], supportsVision: true,
      isDefault: false, offers: [{ id: '24', specialOffer: false }],
    }]);

    expect(profiles[0]?.capabilities).toEqual(['chat', 'vision', 'reverse_prompt']);
  });
  it('does not expose image reverse prompting for a RelayMe route that only declares video input', () => {
    const profiles = buildRelayMeModelProfiles([{
      name: 'Video Understanding Chat', deploymentName: 'video-understanding-chat', capability: 'text', modelType: 'TEXT',
      endpoints: ['/api/ai-tools/v1/chat/completions'], inputModalities: ['text', 'video'], supportsVision: false,
      isDefault: false, offers: [{ id: '23', specialOffer: false }],
    }]);

    expect(profiles[0]?.capabilities).toEqual(['chat', 'video_understanding']);
  });
  it('keeps same-name models from different providers separate', () => {
    const relay = buildRelayMeModelProfiles(relayModels).slice(0, 1);
    const merged = mergeProviderModelProfiles([
      ...relay,
      { ...relay[0]!, provider: 'comfly', modelRoute: 'comfly-image-route' },
    ]);

    expect(merged).toHaveLength(2);
    expect(new Set(merged.map((item) => item.provider))).toEqual(new Set(['comfly', 'relayme']));
  });
  it('keeps every model selectable when distinct provider ids normalize to the same route slug', () => {
    const profiles = buildComflyModelProfiles({
      version: 'catalog-collision',
      models: [
        { key: 'MiniMax-M2.1', name: 'MiniMax M2.1 A', provider: 'MiniMax', tags: ['对话'], apis: [], capabilityStatus: 'complete' },
        { key: 'minimax-m2.1', name: 'MiniMax M2.1 B', provider: 'MiniMax', tags: ['对话'], apis: [], capabilityStatus: 'complete' },
      ],
    });

    expect(profiles).toHaveLength(2);
    expect(new Set(profiles.map((profile) => profile.modelRoute)).size).toBe(2);
    expect(mergeProviderModelProfiles(profiles)).toHaveLength(2);
  });
});
