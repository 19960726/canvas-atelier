import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComflyClient, decodeGeminiInlineImage, mapComflyImageResolutionTier, normalizeBaseUrl, parseGeminiImageResponse } from './client';
import { mergeComflyModelRegistries } from './model-registry';
import type { ComflyFetch } from './types';

describe('normalizeBaseUrl', () => {
  it('removes whitespace and trailing slashes from the configured provider base URL', () => {
    expect(normalizeBaseUrl(' https://ai.comfly.org/// ')).toBe('https://ai.comfly.org');
  });
});

describe('ComflyClient', () => {
  it('maps supported tiers by orientation and rejects unsupported native 4K', () => {
    expect(mapComflyImageResolutionTier('1K', '16:9')).toBe('1024x1024');
    expect(mapComflyImageResolutionTier('2K', '16:9')).toBe('1536x1024');
    expect(mapComflyImageResolutionTier('2K', '9:16')).toBe('1024x1536');
    expect(() => mapComflyImageResolutionTier('4K', '16:9')).toThrow(/native 4K/i);
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
      throw new Error(`unexpected URL: ${url}`);
    });
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org', tokenSupplier: async () => 'secret-token', fetch });

    await expect(client.listAccessibleModelCatalog()).resolves.toEqual({
      version: 'catalog-v1',
      models: [
        expect.objectContaining({ key: 'gpt-image-2', name: 'gpt-image-2', tags: ['绘图', '图像编辑'] }),
        expect.objectContaining({ key: 'veo3.1-fast', name: 'Veo 3.1 Fast', tags: ['视频', '异步任务'], parameterTable: { headers: ['分辨率', '视频时长'], rows: [['720P', '5秒'], ['1080P', '10'], ['2k(720p upscale)', '15秒']] } }),
        expect.objectContaining({ key: 'vision-chat', name: 'Vision Chat', tags: ['对话', '识图', '多模态'] }),
        expect.objectContaining({ key: 'endpoint-only', capabilityStatus: 'incomplete' }),
        expect.objectContaining({ key: 'unknown-private', name: 'unknown-private', capabilityStatus: 'incomplete' }),
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
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

  it('preserves provider-native 4K for GPT Image 2 instead of rejecting or downgrading it', async () => {
    let postedBody: string | undefined;
    const fetch: ComflyFetch = vi.fn(async (_url, init) => {
      postedBody = init?.body;
      return jsonResponse({ taskId: 'task-gpt-image-2', status: 'queued' });
    });
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org', tokenSupplier: async () => 'secret-token', fetch });

    await expect(client.generateImage({
      model: 'gpt-image-2', prompt: 'high resolution product poster', async: true, aspect_ratio: '16:9', size: '4K',
    })).resolves.toMatchObject({ taskId: 'task-gpt-image-2' });

    expect(JSON.parse(String(postedBody))).toMatchObject({
      model: 'gpt-image-2', aspect_ratio: '16:9', size: '4K',
    });
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

  it('gets async image task state from /v1/images/tasks/{taskId}', async () => {
    const fetch = vi.fn(async () => jsonResponse({
      taskId: 'task-77',
      status: 'completed',
      data: [{ url: 'https://cdn.example.com/final.png' }],
    }));
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org', tokenSupplier: async () => 'secret-token', fetch });

    await expect(client.getImageTask('task-77')).resolves.toMatchObject({ status: 'completed' });
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

  it('gives image generation a 180 second timeout while connection checks stay short', async () => {
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
    await vi.advanceTimersByTimeAsync(179_950);

    await expect(outcome).resolves.toContain('timed out after 180000ms');
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
});

function jsonResponse(body: unknown, options: { ok?: boolean; status?: number } = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: async () => body,
  };
}
