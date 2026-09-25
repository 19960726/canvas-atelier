import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ComflyClient,
  decodeGeminiInlineImage,
  mapComflyGptImageExactSize,
  mapComflyImageResolutionTier,
  normalizeBaseUrl,
  parseGeminiImageResponse,
} from './client';
import { mergeComflyModelRegistries } from './model-registry';
import type { ComflyFetch } from './types';

describe('normalizeBaseUrl', () => {
  it('removes whitespace and trailing slashes from the configured provider base URL', () => {
    expect(normalizeBaseUrl(' https://ai.comfly.org/// ')).toBe('https://ai.comfly.org');
  });
});

describe('ComflyClient', () => {
  it('submits GPT reference edits as multipart image files with exact size and generation timeout', async () => {
    const fetch = vi.fn<ComflyFetch>(async () => jsonResponse({ task_id: 'edit-task' }));
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org', tokenSupplier: async () => 'secret-token', fetch, generationTimeoutMs: 180_000 });
    await client.editImage({ model: 'gpt-image-2.5-sunburst-2k', prompt: 'Keep product geometry', async: true, size: '2K', aspect_ratio: '16:9', quality: 'auto', output_format: 'webp', background: 'transparent', image: [{ mediaType: 'image/png', bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]) }, { mediaType: 'image/jpeg', bytes: Uint8Array.from([0xff, 0xd8, 0xff]) }] });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://ai.comfly.org/v1/images/edits?async=true');
    expect(init?.timeoutMs).toBe(180_000);
    expect(init?.headers?.['content-type']).toMatch(/^multipart\/form-data; boundary=/u);
    expect(init?.body).toBeInstanceOf(Uint8Array);
    const multipart = await new Response(new Blob([Uint8Array.from(init?.body as Uint8Array)]), { headers: { 'content-type': init!.headers!['content-type']! } }).formData();
    expect(multipart.get('size')).toBe('2048x1152');
    expect(multipart.get('quality')).toBe('auto');
    expect(multipart.get('output_format')).toBe('webp');
    expect(multipart.get('background')).toBe('transparent');
    expect(multipart.has('aspect_ratio')).toBe(false);
    expect(multipart.has('async')).toBe(false);
    const images = multipart.getAll('image') as File[];
    expect(images).toHaveLength(2);
    expect(images.map((image) => image.type)).toEqual(['image/png', 'image/jpeg']);
    expect(new Uint8Array(await images[0]!.arrayBuffer())).toEqual(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
  });
  it.each(['gpt-image-2.5-flare-4k', 'gpt-image-2.5-sunburst-4k', 'edit-model'])('submits %s edits asynchronously and polls the returned task without resubmission', async (model) => {
    const fetch = vi.fn<ComflyFetch>(async (url) => jsonResponse(url.includes('/tasks/')
      ? { task_id: 'async-edit', status: 'SUCCESS', data: { data: [{ url: 'https://cdn.example.com/done.png' }] } }
      : { task_id: 'async-edit' }));
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org', tokenSupplier: async () => 'secret-token', fetch });
    const image = model === 'edit-model' ? 'https://example.com/reference.png' : [{ mediaType: 'image/png', bytes: Uint8Array.from([137, 80, 78, 71]) }];
    await expect(client.editImage({ model, prompt: 'preserve warm scene', async: true, image })).resolves.toMatchObject({ taskId: 'async-edit', status: 'queued' });
    expect(fetch.mock.calls[0]![0]).toBe('https://ai.comfly.org/v1/images/edits?async=true');
    if (model === 'edit-model') expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).not.toHaveProperty('async');
    await expect(client.getImageTask('async-edit')).resolves.toMatchObject({ status: 'SUCCESS' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]![0]).toBe('https://ai.comfly.org/v1/images/tasks/async-edit');
  });

  it('maps supported tiers by orientation and rejects unsupported native 4K', () => {
    expect(mapComflyImageResolutionTier('1K', '16:9')).toBe('1024x1024');
    expect(mapComflyImageResolutionTier('2K', '16:9')).toBe('1536x1024');
    expect(mapComflyImageResolutionTier('2K', '9:16')).toBe('1024x1536');
    expect(() => mapComflyImageResolutionTier('4K', '16:9')).toThrow(/native 4K/i);
  });

  it.each(['1:1', '2:3', '3:2', '4:3', '3:4', '16:9', '9:16'] as const)(
    'maps every GPT Image %s tier to a documented exact-pixel size',
    (aspectRatio) => {
      for (const tier of ['1K', '2K', '4K'] as const) {
        const [width, height] = mapComflyGptImageExactSize(tier, aspectRatio).split('x').map(Number) as [number, number];
        expect(width % 16).toBe(0);
        expect(height % 16).toBe(0);
        expect(width).toBeLessThanOrEqual(3840);
        expect(height).toBeLessThanOrEqual(3840);
        expect(width * height).toBeGreaterThanOrEqual(655_360);
        expect(width * height).toBeLessThanOrEqual(8_294_400);
        expect(Math.max(width, height) / Math.min(width, height)).toBeLessThanOrEqual(3);
      }
    },
  );

  it('uses the documented common 4K landscape and portrait sizes for GPT Image', () => {
    expect(mapComflyGptImageExactSize('4K', '16:9')).toBe('3840x2160');
    expect(mapComflyGptImageExactSize('4K', '9:16')).toBe('2160x3840');
    expect(mapComflyGptImageExactSize('4K', '3:4')).toBe('2480x3312');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('extracts inline Gemini image parts without exposing raw response shape to callers', () => {
    expect(parseGeminiImageResponse({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'base64-image' } }] } }],
    })).toEqual([{ mimeType: 'image/png', data: 'base64-image' }]);
  });

  it('decodes validated Gemini inline image data into bytes', () => {
    expect([...decodeGeminiInlineImage({ mimeType: 'image/png', data: 'iVBORw0KGgo=' })]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(() => decodeGeminiInlineImage({ mimeType: 'text/plain', data: 'aGVsbG8=' })).toThrow(/invalid inline image/i);
  });

  it('checks authentication with the free OpenAI-compatible models endpoint', async () => {
    const fetch = vi.fn(async () => jsonResponse({ data: [{ id: 'private-model-id' }], object: 'list' }));
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org', tokenSupplier: async () => 'secret-token', fetch });

    await expect(client.checkConnection()).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith('https://ai.comfly.org/v1/models', expect.objectContaining({
      method: 'GET',
      headers: { authorization: 'Bearer secret-token' },
    }));
  });

  it('returns only account-visible model ids from the OpenAI-compatible models endpoint', async () => {
    const fetch = vi.fn(async () => jsonResponse({
      object: 'list',
      data: [
        { id: 'gpt-image-2', object: 'model' },
        { id: 'gemini-3.1-flash-lite', object: 'model' },
        { id: 42, object: 'model' },
      ],
    }));
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org', tokenSupplier: async () => 'secret-token', fetch });

    await expect(client.listModelIds()).resolves.toEqual(['gpt-image-2', 'gemini-3.1-flash-lite']);
    expect(fetch).toHaveBeenCalledWith('https://ai.comfly.org/v1/models', expect.objectContaining({ method: 'GET' }));
  });

  it('joins account-visible ids with the official Comfly model catalog without sending the API key to the public catalog endpoint', async () => {
    const fetch = vi.fn(async (url: string, init) => {
      if (url.endsWith('/v1/models')) {
        return jsonResponse({ data: [{ id: 'gpt-image-2' }, { id: 'veo3.1-fast' }, { id: 'vision-chat' }, { id: 'endpoint-only' }, { id: 'unknown-private' }] });
      }
      if (url.endsWith('/api/models/price')) {
        expect(init?.headers ?? {}).not.toHaveProperty('authorization');
        return jsonResponse({ data: { version: 'catalog-v1', models: [
          { key: 'gpt-image-2', name: 'gpt-image-2', provider: 'OpenAI', tags: '绘图,图像编辑', apis: ['POST-/v1/images/generations-1', 'POST-/v1/images/edits-2'] },
          {
            key: 'veo3.1-fast', name: 'Veo 3.1 Fast', provider: 'Google', tags: '视频,异步任务', apis: ['POST-/v2/videos/generations-3'],
            ratios: { headers: ['分辨率', '视频时长'], rows: [['720P', '5秒'], ['1080P', 10], ['2k(720p upscale)', '15秒']] },
          },
          { key: 'vision-chat', name: 'Vision Chat', provider: 'Google', tags: '对话,识图,多模态', apis: ['POST-/v1/chat/completions-4'] },
          { key: 'endpoint-only', name: 'Endpoint Only', provider: 'Other', tags: [], apis: ['POST-/v1/images/generations-5'] },
          { key: 'not-in-account', name: 'Hidden Model', provider: 'Other', tags: '绘图', apis: [] },
        ] } });
      }
      if (url.endsWith('/api/pricing')) {
        expect(init?.headers ?? {}).not.toHaveProperty('authorization');
        return jsonResponse({ data: [] });
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org', tokenSupplier: async () => 'secret-token', fetch });

    await expect(client.listAccessibleModelCatalog()).resolves.toEqual({
      version: 'catalog-v1',
      models: [
        expect.objectContaining({ key: 'gpt-image-2', name: 'gpt-image-2', tags: ['绘图', '图像编辑'] }),
        expect.objectContaining({ key: 'veo3.1-fast', name: 'Veo 3.1 Fast', tags: ['视频', '异步任务'], parameterTable: { headers: ['分辨率', '视频时长'], rows: [['720P', '5秒'], ['1080P', '10'], ['2k(720p upscale)', '15秒']] } }),
        expect.objectContaining({ key: 'vision-chat', name: 'Vision Chat', tags: ['对话', '识图', '多模态'] }),
        expect.objectContaining({ key: 'endpoint-only', capabilityStatus: 'complete' }),
        expect.objectContaining({ key: 'unknown-private', name: 'unknown-private', capabilityStatus: 'incomplete' }),
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('merges positive image evidence from both public catalogs before applying the exact authenticated model intersection', async () => {
    const newlyDiscoveredImageModels = [
      'dall-e-2',
      'flux-pro-1.1-ultra',
      'flux-schnell',
      'gpt-image-1-2025-04-15',
      'gpt-image-1-mini',
      'gpt-image-1-mini-2025-10-06',
      'gpt-image-2-2k',
      'gpt-image-2-4k',
      'gpt-image-2-vip',
    ];
    const fetch = vi.fn(async (url: string, init) => {
      if (url.endsWith('/v1/models')) {
        return jsonResponse({ data: [
          ...newlyDiscoveredImageModels.map((id) => ({ id })),
          { id: 'nano-banana-2' },
          { id: 'case-sensitive-model' },
        ] });
      }
      if (url.endsWith('/api/models/price')) {
        expect(init?.headers ?? {}).not.toHaveProperty('authorization');
        return jsonResponse({ data: { version: 'legacy-v856', models: [
          { key: 'nano-banana-2', name: 'Nano Banana 2', provider: 'Google', tags: '对话', apis: ['POST-/v1/images/generations-341817446', 'POST-/v1/images/edits-341817449'] },
          { key: 'flux-pro-1.1-ultra', name: 'Flux Pro 1.1 Ultra', provider: 'Black Forest Labs', tags: '对话', apis: ['POST-/v1/images/edits-303213093'] },
          { key: 'flux-schnell', name: 'Flux Schnell', provider: 'Black Forest Labs', tags: '对话', apis: ['POST-/v1/images/edits-303213093'] },
          { key: 'gpt-image-1-mini', name: 'GPT Image 1 Mini', provider: 'OpenAI', tags: '对话', apis: ['POST-/v1/images/edits-339685644'] },
          { key: 'Case-Sensitive-Model', name: 'Wrong case must not match', provider: 'Other', tags: '绘图', apis: ['POST-/v1/images/generations-1'] },
        ] } });
      }
      if (url.endsWith('/api/pricing')) {
        expect(init?.headers ?? {}).not.toHaveProperty('authorization');
        return jsonResponse({ data: [
          ...[
            'dall-e-2',
            'flux-pro-1.1-ultra',
            'flux-schnell',
            'gpt-image-1-2025-04-15',
            'gpt-image-1-mini',
            'gpt-image-1-mini-2025-10-06',
          ].map((model_name) => ({
            model_name,
            description: null,
            tags: null,
            apis: null,
            supported_endpoint_types: ['image-generation', 'openai'],
          })),
          { model_name: 'gpt-image-2-2k', tags: '绘图,图像编辑', supported_endpoint_types: ['openai'], apis: ['POST-/v1/images/generations-302915860'] },
          { model_name: 'gpt-image-2-4k', tags: '绘图', supported_endpoint_types: ['openai'], apis: ['POST-/v1/images/generations-302915860'] },
          { model_name: 'gpt-image-2-4k', tags: '图像编辑', supported_endpoint_types: ['openai'], apis: ['POST-/v1/images/generations-302915860'] },
          { model_name: 'gpt-image-2-vip', tags: '绘图,图像编辑', supported_endpoint_types: ['openai'], apis: ['POST-/v1/images/generations-302915860'] },
          { model_name: 'nano-banana-2', tags: '对话,识图,多模态', supported_endpoint_types: ['gemini', 'openai'], apis: [] },
          { model_name: 'hidden-public-image', supported_endpoint_types: ['image-generation'] },
          { model_name: 'case-sensitive-model', supported_endpoint_types: ['openai'], apis: [] },
        ] });
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org', tokenSupplier: async () => 'secret-token', fetch });

    const catalog = await client.listAccessibleModelCatalog();
    expect(catalog.version).toBe('legacy-v856');
    expect(catalog.models.map((model) => model.key)).toEqual([...newlyDiscoveredImageModels, 'nano-banana-2', 'case-sensitive-model']);
    for (const modelId of newlyDiscoveredImageModels) {
      expect(catalog.models.find((model) => model.key === modelId)).toMatchObject({
        capabilityStatus: 'complete',
        apis: expect.arrayContaining(['/v1/images/generations']),
      });
    }
    for (const modelId of ['flux-pro-1.1-ultra', 'flux-schnell', 'gpt-image-1-mini']) {
      expect(catalog.models.find((model) => model.key === modelId)?.apis).toEqual(expect.arrayContaining([
        '/v1/images/generations',
        expect.stringMatching(/^POST-\/v1\/images\/edits-/u),
      ]));
    }
    expect(catalog.models.filter((model) => model.key === 'gpt-image-2-4k')).toHaveLength(1);
    expect(catalog.models.find((model) => model.key === 'gpt-image-2-4k')?.tags).toEqual(['绘图', '图像编辑']);
    expect(catalog.models.find((model) => model.key === 'nano-banana-2')).toMatchObject({
      capabilityStatus: 'complete',
      endpointTypes: ['gemini', 'openai'],
      apis: expect.arrayContaining(['POST-/v1/images/generations-341817446']),
    });
    expect(catalog.models.find((model) => model.key === 'case-sensitive-model')).toMatchObject({
      name: 'case-sensitive-model', capabilityStatus: 'incomplete',
    });
    expect(catalog.models.some((model) => model.key === 'hidden-public-image')).toBe(false);
  });

  it('restores the documented Seedream v5 generations route when the pricing catalog omits apis', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/models')) return jsonResponse({ data: [{ id: 'seedream-v5-pro' }] });
      if (url.endsWith('/api/models/price')) return jsonResponse({ data: { version: 'seedream-v5', models: [] } });
      if (url.endsWith('/api/pricing')) return jsonResponse({ data: [{
        model_name: 'seedream-v5-pro',
        tags: '绘图,图像编辑',
        supported_endpoint_types: ['openai'],
        apis: null,
      }] });
      throw new Error(`unexpected URL: ${url}`);
    });
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org', tokenSupplier: async () => 'secret-token', fetch });

    await expect(client.listAccessibleModelCatalog()).resolves.toEqual({
      version: 'seedream-v5',
      models: [expect.objectContaining({
        key: 'seedream-v5-pro',
        capabilityStatus: 'complete',
        apis: ['/v1/images/generations'],
      })],
    });
  });

  it.each([
    ['malformed', { data: { models: [] } }],
    ['failed', { error: { message: 'temporarily unavailable' } }],
  ])('falls back to the legacy public catalog when the new pricing catalog is %s', async (_case, pricingBody) => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/models')) return jsonResponse({ data: [{ id: 'legacy-image' }] });
      if (url.endsWith('/api/models/price')) return jsonResponse({ data: { version: 'legacy-v1', models: [
        { key: 'legacy-image', name: 'Legacy Image', provider: 'Comfly', tags: '绘图', apis: ['POST-/v1/images/generations-1'] },
      ] } });
      if (url.endsWith('/api/pricing')) return jsonResponse(pricingBody, { ok: _case !== 'failed', status: _case === 'failed' ? 503 : 200 });
      throw new Error(`unexpected URL: ${url}`);
    });
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org', tokenSupplier: async () => 'secret-token', fetch });

    await expect(client.listAccessibleModelCatalog()).resolves.toEqual({
      version: 'legacy-v1',
      models: [expect.objectContaining({ key: 'legacy-image', capabilityStatus: 'complete' })],
    });
  });

  it('does not promote fuzzy endpoint names or image-edit tags into generation or edit transports', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/models')) return jsonResponse({ data: [{ id: 'fuzzy-image' }] });
      if (url.endsWith('/api/models/price')) return jsonResponse({ data: { version: 'legacy-v1', models: [] } });
      if (url.endsWith('/api/pricing')) return jsonResponse({ data: [{
        model_name: 'fuzzy-image', tags: '绘图,图像编辑',
        supported_endpoint_types: ['image-generation-preview'],
        apis: ['POST-/v1/images/generations-preview-1', 'POST-/v1/images/edits-extra-2'],
      }] });
      throw new Error(`unexpected URL: ${url}`);
    });
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org', tokenSupplier: async () => 'secret-token', fetch });

    await expect(client.listAccessibleModelCatalog()).resolves.toEqual({
      version: 'legacy-v1',
      models: [expect.objectContaining({ key: 'fuzzy-image', apis: [], capabilityStatus: 'complete' })],
    });
  });

  it('posts OpenAI-compatible chat payloads to /v1/chat/completions with request-time authorization', async () => {
    const fetch = vi.fn(async () => jsonResponse({
      id: 'chat-1',
      model: 'vision-chat',
      choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
    }));
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org/', tokenSupplier: async () => 'secret-token', fetch });

    await expect(client.chat({
      model: 'vision-chat',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe the product placement.' },
          { type: 'image_url', image_url: { url: 'https://example.com/reference.png' } },
        ],
      }],
    })).resolves.toMatchObject({ id: 'chat-1', model: 'vision-chat' });

    expect(fetch).toHaveBeenCalledWith('https://ai.comfly.org/v1/chat/completions', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        authorization: 'Bearer secret-token',
        'content-type': 'application/json',
      }),
      body: expect.stringContaining('"image_url"'),
    }));
  });

  it('posts response payloads to /v1/responses', async () => {
    const fetch = vi.fn(async () => jsonResponse({
      id: 'resp-1',
      model: 'planner-lite',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
    }));
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org', tokenSupplier: async () => 'secret-token', fetch });

    await expect(client.responses({
      model: 'planner-lite',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Summarize the plan.' }] }],
    })).resolves.toMatchObject({ id: 'resp-1' });

    expect(fetch).toHaveBeenCalledWith('https://ai.comfly.org/v1/responses', expect.objectContaining({ method: 'POST' }));
  });

  it('submits and polls the documented Comfly v2 video task protocol', async () => {
    const fetch = vi.fn(async (url: string) => url.endsWith('/v2/videos/generations')
      ? jsonResponse({ task_id: 'video-task-1' })
      : jsonResponse({
          task_id: 'video-task-1',
          status: 'SUCCESS',
          progress: 100,
          data: { output: 'https://cdn.example.com/result.mp4' },
        }));
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org', tokenSupplier: async () => 'secret-token', fetch });

    await expect(client.generateVideo({
      model: 'veo3.1-fast',
      prompt: 'A product rotates on a clean studio table',
      aspect_ratio: '16:9',
      resolution: '1080p',
      duration: 8,
      audio: true,
    })).resolves.toEqual({ taskId: 'video-task-1' });
    await expect(client.getVideoTask('video-task-1')).resolves.toMatchObject({
      taskId: 'video-task-1', status: 'SUCCESS', progress: 100,
      data: { output: 'https://cdn.example.com/result.mp4' },
    });

    expect(fetch).toHaveBeenNthCalledWith(1, 'https://ai.comfly.org/v2/videos/generations', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        model: 'veo3.1-fast', prompt: 'A product rotates on a clean studio table',
        aspect_ratio: '16:9', resolution: '1080p', duration: 8, audio: true,
      }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://ai.comfly.org/v2/videos/generations/video-task-1', expect.objectContaining({ method: 'GET' }));
  });
  it('posts async image generation payloads to /v1/images/generations?async=true', async () => {
    const fetch = vi.fn(async () => jsonResponse({ taskId: 'task-1', status: 'queued' }));
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org', tokenSupplier: async () => 'secret-token', fetch });

    await expect(client.generateImage({ model: 'image-model', prompt: '产品海报', async: true })).resolves.toEqual({
      taskId: 'task-1',
      status: 'queued',
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://ai.comfly.org/v1/images/generations?async=true',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('accepts the documented async image submission response without a status field', async () => {
    const fetch = vi.fn(async () => jsonResponse({ task_id: 'documented-task-1' }));
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org', tokenSupplier: async () => 'secret-token', fetch });

    await expect(client.generateImage({
      model: 'gpt-image-2', prompt: '产品海报', async: true, size: '1024x1024',
    })).resolves.toEqual({ taskId: 'documented-task-1', status: 'queued' });
  });

  it('converts the Canvas 4K tier to the documented exact GPT Image 2 size', async () => {
    let postedBody: string | undefined;
    const fetch: ComflyFetch = vi.fn(async (_url, init) => {
      postedBody = init?.body;
      return jsonResponse({ taskId: 'task-gpt-image-2', status: 'queued' });
    });
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org', tokenSupplier: async () => 'secret-token', fetch });

    await expect(client.generateImage({
      model: 'gpt-image-2', prompt: 'high resolution product poster', async: true, aspect_ratio: '16:9', size: '4K',
    })).resolves.toMatchObject({ taskId: 'task-gpt-image-2' });

    const requestBody = JSON.parse(String(postedBody));
    expect(requestBody).toMatchObject({ model: 'gpt-image-2', size: '3840x2160' });
    expect(requestBody).not.toHaveProperty('aspect_ratio');
    expect(requestBody).not.toHaveProperty('async');
  });

  it.each([
    'gpt-image-2-4k',
    'gpt-image-2-vip',
    'gpt-image-2.5-flare-4k',
    'gpt-image-2.5-sunburst-4k',
  ])('sends documented exact 4K pixels for fixed-resolution GPT image variant %s', async (model) => {
    let postedBody: string | undefined;
    const fetch: ComflyFetch = vi.fn(async (_url, init) => {
      postedBody = typeof init?.body === 'string' ? init.body : undefined;
      return jsonResponse({ taskId: `task-${model}`, status: 'queued' });
    });
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org', tokenSupplier: async () => 'secret-token', fetch });

    await expect(client.generateImage({
      model, prompt: 'native four-k catalog image', async: true, aspect_ratio: '16:9', size: '4K', quality: 'high',
    })).resolves.toMatchObject({ taskId: `task-${model}` });

    const requestBody = JSON.parse(String(postedBody));
    expect(requestBody).toMatchObject({ model, size: '3840x2160', quality: 'high' });
    expect(requestBody).not.toHaveProperty('aspect_ratio');
    expect(requestBody).not.toHaveProperty('async');
  });

  it('uses the documented image_size tier for Nano Banana image models', async () => {
    let postedBody: string | undefined;
    const fetch: ComflyFetch = vi.fn(async (_url, init) => {
      postedBody = init?.body;
      return jsonResponse({ taskId: 'task-nano-banana-pro', status: 'queued' });
    });
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org', tokenSupplier: async () => 'secret-token', fetch });

    await expect(client.generateImage({
      model: 'nano-banana-pro', prompt: 'high resolution product poster', async: true, aspect_ratio: '3:4', size: '4K',
    })).resolves.toMatchObject({ taskId: 'task-nano-banana-pro' });

    const requestBody = JSON.parse(String(postedBody));
    expect(requestBody).toMatchObject({
      model: 'nano-banana-pro', aspect_ratio: '3:4', image_size: '4K',
    });
    expect(requestBody).not.toHaveProperty('size');
  });

  it('keeps Nano Banana 2 model identity, aspect ratio, and resolution tier intact', async () => {
    let postedBody: string | undefined;
    const fetch: ComflyFetch = vi.fn(async (_url, init) => {
      postedBody = init?.body;
      return jsonResponse({ taskId: 'task-nano-banana-2', status: 'queued' });
    });
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org', tokenSupplier: async () => 'secret-token', fetch });

    await expect(client.generateImage({
      model: 'nano-banana-2', prompt: 'portrait product image', async: true, aspect_ratio: '9:16', size: '2K',
    })).resolves.toMatchObject({ taskId: 'task-nano-banana-2' });

    const requestBody = JSON.parse(String(postedBody));
    expect(requestBody).toMatchObject({
      model: 'nano-banana-2', aspect_ratio: '9:16', image_size: '2K',
    });
    expect(requestBody).not.toHaveProperty('size');
  });

  it.each([
    'gemini-3.1-flash-image-preview',
    'gemini-3.1-flash-image-preview-512px',
    'gemini-3.1-flash-image-preview-2k',
    'gemini-3.1-flash-image-preview-4k',
  ])('uses the provider-native image_size tier for Gemini 3.1 Flash Image variant %s', async (model) => {
    let postedBody: string | undefined;
    const fetch: ComflyFetch = vi.fn(async (_url, init) => {
      postedBody = init?.body;
      return jsonResponse({ taskId: `task-${model}`, status: 'queued' });
    });
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org', tokenSupplier: async () => 'secret-token', fetch });

    await expect(client.generateImage({
      model, prompt: 'high resolution product poster', async: true, aspect_ratio: '16:9', size: '4K',
    })).resolves.toMatchObject({ taskId: `task-${model}` });

    const requestBody = JSON.parse(String(postedBody));
    expect(requestBody).toMatchObject({ model, aspect_ratio: '16:9', image_size: '4K' });
    expect(requestBody).not.toHaveProperty('size');
  });

  it('does not submit non-canonical Gemini image aliases as native 4K models', async () => {
    const fetch: ComflyFetch = vi.fn(async () => jsonResponse({ taskId: 'unexpected', status: 'queued' }));
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org', tokenSupplier: async () => 'secret-token', fetch });

    for (const model of [
      'gemini-3-1-flash-image-preview-4k',
      ' gemini-3.1-flash-image-preview-4k ',
      'GEMINI-3.1-FLASH-IMAGE-PREVIEW-4K',
    ]) {
      await expect(client.generateImage({
        model, prompt: 'high resolution product poster', size: '4K',
      })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('posts image edit payloads to /v1/images/edits', async () => {
    const fetch = vi.fn(async () => jsonResponse({
      created: 1721121600,
      data: [{ url: 'https://cdn.example.com/result.png' }],
    }));
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org', tokenSupplier: async () => 'secret-token', fetch });

    await expect(client.editImage({
      model: 'edit-model',
      prompt: '保留主体，优化道具层次',
      image: 'https://example.com/original.png',
      mask: 'https://example.com/mask.png',
    })).resolves.toMatchObject({ data: [{ url: 'https://cdn.example.com/result.png' }] });

    expect(fetch).toHaveBeenCalledWith('https://ai.comfly.org/v1/images/edits', expect.objectContaining({ method: 'POST' }));
  });

  it('gets the documented nested async image task state from /v1/images/tasks/{taskId}', async () => {
    const fetch = vi.fn(async () => jsonResponse({ code: 'success', data: {
      task_id: 'task-77',
      status: 'SUCCESS',
      data: { data: [{ url: 'https://cdn.example.com/final.png' }] },
    } }));
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org', tokenSupplier: async () => 'secret-token', fetch });

    await expect(client.getImageTask('task-77')).resolves.toEqual({
      taskId: 'task-77', status: 'SUCCESS', data: { data: [{ url: 'https://cdn.example.com/final.png' }] },
    });
    expect(fetch).toHaveBeenCalledWith('https://ai.comfly.org/v1/images/tasks/task-77', expect.objectContaining({ method: 'GET' }));
  });

  it('posts Gemini-native payloads to /v1beta/models/{model}:generateContent', async () => {
    const contents = [{ role: 'user', parts: [{ text: 'Describe this scene.' }] }];
    let postedBody: string | undefined;
    const fetch: ComflyFetch = vi.fn(async (_url, init) => {
      postedBody = init?.body;
      return jsonResponse({
        candidates: [{ content: { parts: [{ text: 'ok' }], role: 'model' }, finishReason: 'STOP' }],
      });
    });
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org', tokenSupplier: async () => 'secret-token', fetch });

    await expect(client.generateGeminiContent({
      model: 'gemini-image',
      contents,
    })).resolves.toMatchObject({ candidates: [{ finishReason: 'STOP' }] });

    expect(fetch).toHaveBeenCalledWith(
      'https://ai.comfly.org/v1beta/models/gemini-image:generateContent',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(String(postedBody));
    expect(body).toEqual({ contents });
    expect(body).not.toHaveProperty('model');
  });

  it('forwards an explicit chat timeout to the fetch adapter', async () => {
    const fetch: ComflyFetch = vi.fn(async () => jsonResponse({
      id: 'chat-1',
      model: 'vision-chat-model',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    }));
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org', tokenSupplier: async () => 'secret-token', fetch });

    await client.chat({
      model: 'vision-chat-model',
      messages: [{ role: 'user', content: 'Describe the referenced image.' }],
    }, 120_000);

    expect(fetch).toHaveBeenCalledWith(
      'https://ai.comfly.org/v1/chat/completions',
      expect.objectContaining({ timeoutMs: 120_000 }),
    );
  });

  it('adds ordered inlineData parts after the reference contract', async () => {
    const fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init.body));
      expect(body.contents[0].parts).toEqual([
        { text: expect.stringContaining('@1 is the authoritative scene') },
        { inlineData: { mimeType: 'image/png', data: 'iVBORw==' } },
        { inlineData: { mimeType: 'image/jpeg', data: '/9j/2Q==' } },
      ]);
      return jsonResponse({ candidates: [{ content: { parts: [{
        inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' },
      }] } }] });
    });
    const client = new ComflyClient({
      baseUrl: 'https://ai.comfly.org',
      tokenSupplier: async () => 'provider-token',
      fetch,
    });

    await client.generateGeminiImage({
      model: 'gemini-image',
      prompt: '@1 is the authoritative scene: preserve its composition, camera, lighting, and background.\nReplace the product only.',
      images: [
        { mediaType: 'image/png', bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]) },
        { mediaType: 'image/jpeg', bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]) },
      ],
    });
  });

  it('aborts timed out requests and redacts provider secrets from timeout errors', async () => {
    vi.useFakeTimers();
    const fetch: ComflyFetch = (_url: string, init?: { signal?: AbortSignal }) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('Authorization: Bearer secret-token data:image/png;base64,QUJDREVGR0g= E:\\private\\scene.png');
        error.name = 'AbortError';
        reject(error);
      });
    });
    const client = new ComflyClient({
      baseUrl: 'https://ai.comfly.org',
      tokenSupplier: async () => 'secret-token',
      fetch,
      timeoutMs: 50,
      generationTimeoutMs: 50,
    });

    const pending = client.generateImage({
      model: 'image-model',
      prompt: '超时测试',
      image: 'data:image/png;base64,QUJDREVGR0g=',
    });
    const errorPromise = pending.catch((value: unknown) => value);
    await vi.advanceTimersByTimeAsync(50);

    const error = await errorPromise;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('timed out');
    expect((error as Error).message).not.toContain('secret-token');
    expect((error as Error).message).not.toContain('data:image/png;base64');
    expect((error as Error).message).not.toContain('E:\\private\\scene.png');
  });

  it('gives synchronous image generation a 300 second timeout while connection checks stay short', async () => {
    vi.useFakeTimers();
    const fetch: ComflyFetch = (_url: string, init?: { signal?: AbortSignal }) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
    const client = new ComflyClient({
      baseUrl: 'https://ai.comfly.org',
      tokenSupplier: async () => 'secret-token',
      fetch,
      timeoutMs: 50,
    });

    const pending = client.generateImage({ model: 'nano-banana-pro', prompt: 'draw a chair' });
    const outcome = pending.then(() => 'resolved', (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(50);
    await expect(Promise.race([outcome, Promise.resolve('still-running')])).resolves.toBe('still-running');
    await vi.advanceTimersByTimeAsync(299_950);

    await expect(outcome).resolves.toContain('timed out after 300000ms');
  });

  it('redacts provider error bodies before surfacing API failures', async () => {
    const fetch = vi.fn(async () => jsonResponse({
      error: {
        message: 'Authorization: Bearer secret-token data:image/png;base64,QUJDREVGR0g= C:\\Users\\alice\\secret\\scene.png',
        type: 'invalid_request_error',
      },
    }, { ok: false, status: 401 }));
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org', tokenSupplier: async () => 'secret-token', fetch });

    const error = await client.generateImage({ model: 'image-model', prompt: '生成产品图' }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('401');
    expect((error as Error).message).not.toContain('secret-token');
    expect((error as Error).message).not.toContain('alice');
    expect((error as Error).message).not.toContain('data:image/png;base64');
  });

  it('rejects invalid success bodies with a schema error', async () => {
    const fetch = vi.fn(async () => jsonResponse({ ok: true }));
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org', tokenSupplier: async () => 'secret-token', fetch });

    await expect(client.getImageTask('task-77')).rejects.toThrow(/response/i);
  });
});

describe('mergeComflyModelRegistries', () => {
  it('merges provider/model routes with display names and capability overrides without hardcoding fixed model IDs', () => {
    const merged = mergeComflyModelRegistries({
      providerModels: [
        {
          provider: 'comfly',
          modelRoute: 'agent-conversation',
          modelId: 'vision-pro-2026',
          displayName: '视觉规划',
          capabilities: ['chat', 'vision'],
        },
        {
          provider: 'comfly',
          modelRoute: 'image-generation',
          modelId: 'image-max-2026',
          displayName: 'Nano Banana 2',
          capabilities: ['image_generation', 'image_edit', 'async_tasks'],
        },
      ],
      profileModels: [
        {
          provider: 'openai',
          modelRoute: 'image-generation',
          modelId: 'gpt-image-1',
          displayName: 'GPT Image',
          capabilities: ['image_generation', 'image_edit'],
        },
        {
          provider: 'comfly',
          modelRoute: 'agent-conversation',
          displayName: '共享对话主模型',
          capabilities: ['responses'],
        },
      ],
    });

    expect(merged).toEqual([
      {
        provider: 'comfly',
        modelRoute: 'agent-conversation',
        modelId: 'vision-pro-2026',
        displayName: '共享对话主模型',
        capabilities: ['chat', 'responses', 'vision'],
        source: 'merged',
      },
      {
        provider: 'comfly',
        modelRoute: 'image-generation',
        modelId: 'image-max-2026',
        displayName: 'Nano Banana 2',
        capabilities: ['async_tasks', 'image_edit', 'image_generation'],
        source: 'provider',
      },
      {
        provider: 'openai',
        modelRoute: 'image-generation',
        modelId: 'gpt-image-1',
        displayName: 'GPT Image',
        capabilities: ['image_edit', 'image_generation'],
        source: 'profile',
      },
    ]);
  });

  it('preserves incomplete capability evidence and profile constraints while merging routes', () => {
    const merged = mergeComflyModelRegistries({
      providerModels: [{
        provider: 'comfly', modelRoute: 'gemini-image', modelId: 'gemini-3.1-flash-image-preview',
        displayName: 'Gemini Image', capabilities: ['image_generation'], capabilityStatus: 'complete',
      }],
      profileModels: [{
        provider: 'comfly', modelRoute: 'gemini-image', modelId: 'gemini-3.1-flash-image-preview',
        displayName: 'Cached Gemini Image', capabilities: ['image_generation'], capabilityStatus: 'incomplete',
        constraints: { image: { resolutions: ['2K'] } },
      }],
    });

    expect(merged).toEqual([expect.objectContaining({
      capabilityStatus: 'incomplete',
      constraints: { image: { resolutions: ['2K'] } },
      displayName: 'Cached Gemini Image',
      source: 'merged',
    })]);
  });
});

function jsonResponse(body: unknown, options: { ok?: boolean; status?: number } = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: async () => body,
  };
}
