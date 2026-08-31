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

  it('normalizes uppercase live video resolution suffixes without rejecting the whole catalog', async () => {
    const fetch = vi.fn(async () => jsonResponse({ success: true, data: [
      {
        id: '28',
        name: 'MiniMax-H3',
        deploymentName: 'MiniMax-H3',
        modelType: 'VIDEO',
        videoCapabilities: {
          resolutions: ['768P', '2K'],
          aspectRatios: ['16:9', '21:9', 'adaptive'],
          duration: { mode: 'range', min: 5, max: 15, step: 1, defaultValue: 5 },
        },
      },
    ] }));
    const client = new RelayMeClient({ tokenSupplier: async () => 'relay-secret', fetch });

    await expect(client.listModels()).resolves.toMatchObject([{
      deploymentName: 'MiniMax-H3',
      videoCapabilities: { resolutions: ['768p', '2K'], aspectRatios: ['16:9'] },
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

  it('normalizes the live RelayMe chat envelope into the shared chat response', async () => {
    const fetch = vi.fn(async () => jsonResponse({
      success: true,
      data: {
        content: 'OK',
        model: 'gemini-3.1-flash-lite',
        promptTokens: 12,
        completionTokens: 1,
        totalTokens: 13,
      },
      pointsCharged: '0.01',
    }));
    const client = new RelayMeClient({ tokenSupplier: async () => 'relay-secret', fetch });

    await expect(client.chat({
      model: 'gemini-3.1-flash-lite', messages: [{ role: 'user', content: '只回复 OK' }],
    })).resolves.toMatchObject({
      model: 'gemini-3.1-flash-lite',
      choices: [{ message: { role: 'assistant', content: 'OK' } }],
      usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
    });
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
      videoAspectRatio: '16:9', videoResolution: '2K', videoSeconds: 8, videoGenerateAudio: true,
    })).resolves.toMatchObject({ taskId: 'video-task-1' });
    expect(fetch).toHaveBeenCalledWith(
      'https://www.ml.relayme.uk/api/ai-tools/v1/images/generations',
      expect.objectContaining({ body: expect.stringContaining('"imageAspectRatio":"16:9"') }),
    );
    expect(fetch).toHaveBeenCalledWith(
      'https://www.ml.relayme.uk/api/ai-tools/v1/videos/generations',
      expect.objectContaining({ body: expect.stringMatching(/"messages":\[\{"role":"user","content":"镜头向前推进"\}\].*"videoAspectRatio":"16:9".*"videoResolution":"2K".*"videoSeconds":8.*"videoGenerateAudio":true/u) }),
    );
  });

  it('uses the authenticated workflow API without changing legacy generation routes', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/workflows')) return jsonResponse({ success: true, data: [{ id: 12, name: 'Image workflow' }] });
      if (url.endsWith('/workflows/12')) return jsonResponse({ success: true, data: { id: 12, name: 'Image workflow', data: { nodes: [], connections: [] } } });
      if (url.endsWith('/workflows/wf-image/schema')) return jsonResponse({ inputs: { 'text-1': { type: 'string' } } });
      if (url.endsWith('/workflows/wf-image/runs')) return jsonResponse({ runId: 'run-image-1', status: 'QUEUED' });
      if (url.endsWith('/workflow-runs/run-image-1')) return jsonResponse({ runId: 'run-image-1', status: 'COMPLETED', outputs: {} });
      return jsonResponse({ success: true });
    });
    const client = new RelayMeClient({ tokenSupplier: async () => 'account-login-token', fetch });

    await expect(client.listWorkflows()).resolves.toMatchObject([{ id: '12', name: 'Image workflow' }]);
    await expect(client.getWorkflow('12')).resolves.toMatchObject({ id: '12', name: 'Image workflow' });
    await expect(client.getWorkflowSchema('wf-image')).resolves.toMatchObject({ inputs: { 'text-1': { type: 'string' } } });
    await expect(client.runWorkflow('wf-image', { 'text-1': '产品摄影' }, 'job-1')).resolves.toMatchObject({ runId: 'run-image-1' });
    await expect(client.getWorkflowRun('run-image-1')).resolves.toMatchObject({ status: 'COMPLETED' });

    expect(fetch).toHaveBeenCalledWith(
      'https://www.ml.relayme.uk/api/ai-tools/v1/workflows/wf-image/runs',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer account-login-token', 'Idempotency-Key': 'job-1' }),
      }),
    );
    expect(fetch.mock.calls.map(([url]) => url)).not.toContain('https://www.ml.relayme.uk/api/ai-tools/v1/images/generations');
  });

  it('recovers a workflow run id from the documented 202 Location header', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 202,
      headers: { get: (name: string) => name.toLowerCase() === 'location' ? '/api/ai-tools/v1/workflow-runs/123e4567-e89b-12d3-a456-426614174000' : null },
      json: async () => { throw new SyntaxError('empty response'); },
    }));
    const client = new RelayMeClient({ tokenSupplier: async () => 'account-login-token', fetch });

    await expect(client.runWorkflow('12', { 'text-1': '产品摄影' }, 'job-202')).resolves.toEqual({
      runId: '123e4567-e89b-12d3-a456-426614174000',
      status: 'QUEUED',
    });
  });

  it('gets task state and fails closed for undocumented cancellation', async () => {
    const fetch = vi.fn(async () => jsonResponse({ status: 'COMPLETED', videoContent: 'https://cdn.example/result.mp4' }));
    const client = new RelayMeClient({ tokenSupplier: async () => 'relay-secret', fetch });

    await expect(client.getTask('task-1')).resolves.toMatchObject({ status: 'COMPLETED', videoContent: 'https://cdn.example/result.mp4' });
    await expect(client.cancelTask('task-1')).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('lists the authenticated RelayMe task center with pagination', async () => {
    const fetch = vi.fn(async () => jsonResponse({
      data: [{ taskId: 'task-image-1', type: 'image', status: 'COMPLETED', createdAt: '2026-08-29T10:00:00.000Z' }],
      total: 1,
      page: 1,
      totalPages: 1,
    }));
    const client = new RelayMeClient({ tokenSupplier: async () => 'account-login-token', fetch });

    await expect(client.listTasks(1, 20)).resolves.toEqual({
      tasks: [{ taskId: 'task-image-1', type: 'image', status: 'COMPLETED', createdAt: '2026-08-29T10:00:00.000Z' }],
      total: 1,
      page: 1,
      totalPages: 1,
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://www.ml.relayme.uk/api/ai-tools/v1/tasks?page=1&size=20',
      expect.objectContaining({ method: 'GET', headers: { authorization: 'Bearer account-login-token' } }),
    );
  });

  it('accepts RelayMe task polling responses nested under data.task', async () => {
    const fetch = vi.fn(async () => jsonResponse({ data: { task: { id: 'task-2', state: 'SUCCEEDED', output: { images: [{ url: 'https://cdn.example/result.png' }] } } } }));
    const client = new RelayMeClient({ tokenSupplier: async () => 'account-login-token', fetch });

    await expect(client.getTask('task-2')).resolves.toMatchObject({ status: 'SUCCEEDED', result: { images: [{ url: 'https://cdn.example/result.png' }] } });
  });

  it('accepts completed task payloads with nullable RelayMe fields', async () => {
    const fetch: RelayMeFetch = vi.fn(async () => jsonResponse({
      taskId: 'task-completed-nullables',
      status: 'COMPLETED',
      error: null,
      imageContent: 'https://cdn.example/result.png',
      videoContent: null,
    }));
    const client = new RelayMeClient({ tokenSupplier: async () => 'relay-secret', fetch });

    await expect(client.getTask('task-completed-nullables')).resolves.toMatchObject({
      taskId: 'task-completed-nullables',
      status: 'COMPLETED',
      imageContent: 'https://cdn.example/result.png',
    });
  });

  it('accepts the live RelayMe task list shape with millisecond timestamps and null errors', async () => {
    const fetch: RelayMeFetch = vi.fn(async () => jsonResponse({
      data: [{
        taskId: 'task-list-live-shape',
        type: 'image',
        status: 'COMPLETED',
        createdAt: 1_788_088_611_359,
        error: null,
      }],
      page: 1,
      pageSize: 20,
      total: 1,
      totalPages: 1,
    }));
    const client = new RelayMeClient({ tokenSupplier: async () => 'relay-secret', fetch });

    await expect(client.listTasks()).resolves.toEqual({
      tasks: [{
        taskId: 'task-list-live-shape',
        type: 'image',
        status: 'COMPLETED',
        createdAt: new Date(1_788_088_611_359).toISOString(),
      }],
      page: 1,
      total: 1,
      totalPages: 1,
    });
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
