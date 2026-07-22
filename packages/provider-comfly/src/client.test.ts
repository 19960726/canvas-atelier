import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComflyClient, normalizeBaseUrl } from './client';
import { mergeComflyModelRegistries } from './model-registry';
import type { ComflyFetch } from './types';

describe('normalizeBaseUrl', () => {
  it('removes whitespace and trailing slashes from the configured provider base URL', () => {
    expect(normalizeBaseUrl(' https://ai.comfly.org/// ')).toBe('https://ai.comfly.org');
  });
});

describe('ComflyClient', () => {
  afterEach(() => {
    vi.useRealTimers();
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
