import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelayMeClient, normalizeRelayMeBaseUrl } from './client';
import type { RelayMeFetch } from './types';

describe('RelayMeClient', () => {
  afterEach(() => vi.useRealTimers());

  it('normalizes the ai-tools API base URL', () => {
    expect(normalizeRelayMeBaseUrl(' https://api.relayme.ai/api/ai-tools/v1/// '))
      .toBe('https://www.ml.relayme.uk/api/ai-tools/v1');
  });

  it('parses the documented models envelope and merges duplicate model offers without losing explicit capabilities', async () => {
    const fetch = vi.fn(async () => jsonResponse({ success: true, data: { models: [
      {
        id: '12', name: 'RENA', model: 'gemini-2.5-flash-image', capability: 'image', modelType: 'IMAGE',
        endpoints: ['/api/ai-tools/v1/images/generations'],
        isSpecialOffer: false, pricing: { image1k: '80', image2k: '80', image4k: '80' },
      },
      {
        id: '20', name: 'RENA', model: 'gemini-2.5-flash-image', capability: 'image', modelType: 'IMAGE',
        endpoints: ['/api/ai-tools/v1/images/generations'],
        isSpecialOffer: true, pricing: { image1k: '20', image2k: '20', image4k: '20' },
      },
      {
        id: '15', name: 'Kling3', model: 'kling/kling-v3-video-generation', capability: 'video', modelType: 'VIDEO',
        endpoints: ['/api/ai-tools/v1/videos/generations'],
        videoCapabilities: { duration: { mode: 'range', min: 3, max: 15, step: 1, defaultValue: 5 } },
      },
    ] } }));
    const client = new RelayMeClient({ tokenSupplier: async () => 'relay-secret', fetch });

    const models = await client.listModels();

    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({ deploymentName: 'gemini-2.5-flash-image', capability: 'image', modelType: 'IMAGE' });
    expect(models[0]?.offers).toHaveLength(2);
    expect(models[1]).toMatchObject({
      deploymentName: 'kling/kling-v3-video-generation',
      videoCapabilities: { duration: { mode: 'range', min: 3, max: 15, step: 1 } },
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://www.ml.relayme.uk/api/ai-tools/v1/models',
      expect.objectContaining({ method: 'GET', headers: { authorization: 'Bearer relay-secret' } }),
    );
  });

  it('accepts the live workflow catalog aliases and preserves video parameter capabilities', async () => {
    const fetch = vi.fn(async () => jsonResponse({ success: true, data: { models: [
      {
        id: 31,
        name: 'Seedance 2.0 Pro',
        deploymentName: 'sdance2.0-pro',
        type: 'VIDEO',
        endpoints: ['/api/ai-tools/v1/videos/generations'],
        videoCapabilities: {
          resolutions: ['480p', '720p', '1080p'],
          aspectRatios: ['16:9', '9:16', '1:1'],
          duration: { mode: 'options', options: [5, 10, 15], defaultValue: 5 },
        },
      },
    ] } }));
    const client = new RelayMeClient({ tokenSupplier: async () => 'relay-secret', fetch });

    await expect(client.listModels()).resolves.toMatchObject([{
      deploymentName: 'sdance2.0-pro',
      capability: 'video',
      modelType: 'VIDEO',
      videoCapabilities: {
        resolutions: ['480p', '720p', '1080p'],
        aspectRatios: ['16:9', '9:16', '1:1'],
        duration: { mode: 'options', options: [5, 10, 15], defaultValue: 5 },
      },
    }]);
  });

  it('posts OpenAI-compatible chat requests', async () => {
    const fetch = vi.fn(async () => jsonResponse({
      id: 'chat-1', model: 'gemini-3.1-flash-lite',
      choices: [{ message: { role: 'assistant', content: '完成' } }],
    }));
    const client = new RelayMeClient({ tokenSupplier: async () => 'relay-secret', fetch });

    await expect(client.chat({
      model: 'gemini-3.1-flash-lite', messages: [{ role: 'user', content: '整理提示词' }],
    })).resolves.toMatchObject({ id: 'chat-1' });
    expect(fetch).toHaveBeenCalledWith(
      'https://www.ml.relayme.uk/api/ai-tools/v1/chat/completions',
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('整理提示词') }),
    );
  });

  it('submits image and video generations with provider-specific fields', async () => {
    const fetch = vi.fn(async (url: string) => jsonResponse({ taskId: url.includes('/videos/') ? 'video-task-1' : 'image-task-1', status: 'queued' }));
    const client = new RelayMeClient({ tokenSupplier: async () => 'relay-secret', fetch });

    await expect(client.generateImage({
      model: 'gpt-image-2', messages: [{ role: 'user', content: '产品海报' }],
      imageAspectRatio: '16:9', imageQuality: 'high', n: 2,
    })).resolves.toMatchObject({ taskId: 'image-task-1' });
    await expect(client.generateVideo({
      model: 'kling/kling-v3-video-generation', messages: [{ role: 'user', content: '镜头向前推进' }],
      videoAspectRatio: '16:9', videoQuality: '2K', videoSeconds: 8, audioEnabled: true,
    })).resolves.toMatchObject({ taskId: 'video-task-1' });
    expect(fetch).toHaveBeenCalledWith(
      'https://www.ml.relayme.uk/api/ai-tools/v1/images/generations',
      expect.objectContaining({ body: expect.stringContaining('"imageAspectRatio":"16:9"') }),
    );
    expect(fetch).toHaveBeenCalledWith(
      'https://www.ml.relayme.uk/api/ai-tools/v1/videos/generations',
      expect.objectContaining({ body: expect.stringMatching(/"messages":\[\{"role":"user","content":"镜头向前推进"\}\].*"videoAspectRatio":"16:9".*"videoQuality":"2K".*"videoSeconds":8.*"audioEnabled":true/u) }),
    );
  });

  it('gets task state and fails closed for undocumented cancellation', async () => {
    const fetch = vi.fn(async () => jsonResponse({ status: 'COMPLETED', videoContent: 'https://cdn.example/result.mp4' }));
    const client = new RelayMeClient({ tokenSupplier: async () => 'relay-secret', fetch });

    await expect(client.getTask('task-1')).resolves.toMatchObject({ status: 'COMPLETED', videoContent: 'https://cdn.example/result.mp4' });
    await expect(client.cancelTask('task-1')).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves explicit media input metadata needed for reverse-prompt routing', async () => {
    const fetch = vi.fn(async () => jsonResponse({ data: { models: [
      {
        id: '22', name: 'Vision Chat', model: 'vision-chat', capability: 'text', modelType: 'TEXT',
        inputModalities: ['text', 'image', 'video'], supportsVision: true,
        endpoints: ['/api/ai-tools/v1/chat/completions'],
      },
    ] } }));
    const client = new RelayMeClient({ tokenSupplier: async () => 'relay-secret', fetch });

    await expect(client.listModels()).resolves.toMatchObject([{
      deploymentName: 'vision-chat', inputModalities: ['text', 'image', 'video'], supportsVision: true,
    }]);
  });

  it('redacts keys and protected payloads from API errors', async () => {
    const fetch = vi.fn(async () => jsonResponse({
      success: false,
      error: 'Authorization: Bearer relay-secret C:\Users\Private\input.png',
    }, { ok: false, status: 401 }));
    const client = new RelayMeClient({ tokenSupplier: async () => 'relay-secret', fetch });

    const error = await client.listModels().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('401');
    expect((error as Error).message).not.toMatch(/relay-secret|C:\\Users\\Private/iu);
  });

  it('surfaces a harmless RelayMe string error instead of the invalid-response fallback', async () => {
    const fetch = vi.fn(async () => jsonResponse({
      success: false,
      error: 'API key is invalid',
    }, { ok: false, status: 401 }));
    const client = new RelayMeClient({ tokenSupplier: async () => 'relay-secret', fetch });

    const error = await client.listModels().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('API key is invalid');
    expect((error as Error).message).not.toContain('供应商返回了无效错误响应');
  });

  it('aborts timed out requests', async () => {
    vi.useFakeTimers();
    const fetch: RelayMeFetch = vi.fn((_url: string, init) => new Promise<never>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted relay-secret')));
    }));
    const client = new RelayMeClient({ tokenSupplier: async () => 'relay-secret', fetch, timeoutMs: 25 });

    const pending = client.listModels().catch((reason: unknown) => reason);
    await vi.advanceTimersByTimeAsync(25);
    const error = await pending;

    expect((error as Error).message).toContain('timed out');
    expect((error as Error).message).not.toContain('relay-secret');
  });
});

function jsonResponse(body: unknown, options: { readonly ok?: boolean; readonly status?: number } = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    async json() { return body; },
  };
}
