import { describe, expect, it, vi } from 'vitest';

import type { ComflyFetchResponse } from '@agent-canvas/provider-comfly';

import { createNewApiClient, type NewApiFetch, type NewApiFetchInit } from './newapi-client';

describe('New API client', () => {
  it('keeps public pricing unauthenticated while authenticating the account model catalog', async () => {
    const calls: Array<{ url: string; init: NewApiFetchInit | undefined }> = [];
    const fetch = sequenceFetch(calls, [
      jsonResponse({ object: 'list', data: [{ id: 'sora-2', object: 'model', created: 1, owned_by: 'tenant' }] }),
      jsonResponse({ success: true, data: [{ model_name: 'sora-2', supported_endpoint_types: ['openai-video'] }] }),
    ]);
    const client = createNewApiClient({
      provider: 'julun',
      tokenSupplier: async () => 'secret-token',
      fetch,
    });

    await expect(client.listModelIds()).resolves.toEqual(['sora-2']);
    await expect(client.listPublicPricing()).resolves.toEqual([
      { modelName: 'sora-2', supportedEndpointTypes: ['openai-video'] },
    ]);
    expect(calls[0]).toEqual({
      url: 'https://julun.cc/v1/models',
      init: expect.objectContaining({ headers: { authorization: 'Bearer secret-token' } }),
    });
    expect(calls[1]).toEqual({
      url: 'https://julun.cc/api/pricing',
      init: expect.not.objectContaining({ headers: expect.objectContaining({ authorization: expect.anything() }) }),
    });
  });

  it('uses the current documented openai-video multipart fields and endpoints', async () => {
    const calls: Array<{ url: string; init: NewApiFetchInit | undefined }> = [];
    const content = Uint8Array.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70]);
    const fetch = sequenceFetch(calls, [
      jsonResponse({ id: 'raw-video-task', status: 'queued', progress: 0 }),
      jsonResponse({ id: 'raw-video-task', status: 'completed', progress: 100 }),
      binaryResponse(content),
    ]);
    const client = createNewApiClient({
      provider: 'julun',
      tokenSupplier: async () => 'secret-token',
      fetch,
      boundarySupplier: () => 'canvas-boundary',
    });

    await expect(client.createVideo({
      model: 'sora-2',
      prompt: 'camera orbit',
      duration: 10,
      width: 1280,
      height: 720,
      inputReference: { bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), mediaType: 'image/png' },
    })).resolves.toMatchObject({ id: 'raw-video-task', status: 'queued' });
    await expect(client.getVideo('raw-video-task')).resolves.toMatchObject({ status: 'completed' });
    await expect(client.getVideoContent('raw-video-task')).resolves.toEqual(content);

    expect(calls.map((call) => call.url)).toEqual([
      'https://julun.cc/v1/videos',
      'https://julun.cc/v1/videos/raw-video-task',
      'https://julun.cc/v1/videos/raw-video-task/content',
    ]);
    const createInit = calls[0]!.init!;
    expect(createInit.headers).toEqual({
      authorization: 'Bearer secret-token',
      'content-type': 'multipart/form-data; boundary=canvas-boundary',
    });
    expect(createInit.body).toBeInstanceOf(Uint8Array);
    const multipart = Buffer.from(createInit.body as Uint8Array).toString('utf8');
    expect(multipart).toContain('name="model"\r\n\r\nsora-2');
    expect(multipart).toContain('name="prompt"\r\n\r\ncamera orbit');
    expect(multipart).toContain('name="duration"\r\n\r\n10');
    expect(multipart).toContain('name="width"\r\n\r\n1280');
    expect(multipart).toContain('name="height"\r\n\r\n720');
    expect(multipart).toContain('name="image"\r\n\r\ndata:image/png;base64,iVBORw==');
    expect(multipart).not.toContain('name="seconds"');
    expect(multipart).not.toContain('name="size"');
    expect(multipart).not.toContain('name="input_reference"');
  });

  it.each([
    [401, 'CREDENTIALS_LOCKED', false],
    [403, 'CREDENTIALS_LOCKED', false],
    [429, 'PROVIDER_ERROR', true],
    [503, 'PROVIDER_ERROR', true],
  ] as const)('maps HTTP %s without exposing provider response bodies', async (status, code, retryable) => {
    const client = createNewApiClient({
      provider: '4dai',
      tokenSupplier: async () => 'credential-secret',
      fetch: async () => ({ ok: false, status, json: async () => ({ error: { message: 'secret upstream body' } }) }),
    });

    await expect(client.listModelIds()).rejects.toMatchObject({ code, retryable, status });
    await expect(client.listModelIds()).rejects.not.toMatchObject({ message: expect.stringContaining('secret upstream body') });
  });

  it('maps transport failures as retryable and malformed payloads as invalid responses', async () => {
    const transport = createNewApiClient({
      provider: '4dai', tokenSupplier: async () => 'credential-secret',
      fetch: async () => { throw new Error('Provider network request timed out'); },
    });
    await expect(transport.listModelIds()).rejects.toMatchObject({ code: 'PROVIDER_ERROR', retryable: true });

    const malformed = createNewApiClient({
      provider: '4dai', tokenSupplier: async () => 'credential-secret',
      fetch: async () => jsonResponse({ data: [{ missing: 'id' }] }),
    });
    await expect(malformed.listModelIds()).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE', retryable: false });
  });

  it('uses 4D image generation and chat endpoints without enabling provider switching by URL', async () => {
    const calls: Array<{ url: string; init: NewApiFetchInit | undefined }> = [];
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fetch = sequenceFetch(calls, [
      jsonResponse({ created: 1, data: [{ b64_json: png.toString('base64') }] }),
      jsonResponse({ id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: 'a red product poster' } }] }),
    ]);
    const client = createNewApiClient({
      provider: '4dai',
      tokenSupplier: async () => 'secret-token',
      fetch,
    });

    await expect(client.generateImage({ model: 'gpt-image-1.5', prompt: 'poster', n: 1, quality: 'high' }))
      .resolves.toEqual({ kind: 'inline', bytes: new Uint8Array(png), mediaType: 'image/png' });
    await expect(client.createChatCompletion({ model: 'gpt-4.1', messages: [{ role: 'user', content: 'describe' }] }))
      .resolves.toBe('a red product poster');
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.4dai.cc/v1/images/generations',
      'https://api.4dai.cc/v1/chat/completions',
    ]);
    expect(() => createNewApiClient({
      provider: '4dai',
      apiBaseUrl: 'https://julun.cc/v1',
      tokenSupplier: async () => 'secret-token',
      fetch,
    })).toThrow(/official 4dai host/i);
  });

  it('uses the documented Gemini native image route and returns its inline image part', async () => {
    const calls: Array<{ url: string; init: NewApiFetchInit | undefined }> = [];
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
    const client = createNewApiClient({
      provider: '4dai',
      tokenSupplier: async () => 'secret-token',
      fetch: sequenceFetch(calls, [jsonResponse({ candidates: [{ content: { parts: [
        { text: 'generated' },
        { inlineData: { mimeType: 'image/png', data: png.toString('base64') } },
      ] } }] })]),
    });

    await expect(client.generateGeminiImage({
      model: 'gemini-3.1-flash-image-preview',
      prompt: 'keep the product',
      aspectRatio: '16:9',
      imageSize: '4K',
      references: [{ bytes: jpeg, mediaType: 'image/jpeg' }],
    })).resolves.toEqual({ kind: 'inline', bytes: new Uint8Array(png), mediaType: 'image/png' });

    expect(calls[0]!.url).toBe('https://api.4dai.cc/v1beta/models/gemini-3.1-flash-image-preview:generateContent');
    expect(calls[0]!.init!.headers).toEqual({
      authorization: 'Bearer secret-token',
      'content-type': 'application/json',
    });
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      contents: [{ role: 'user', parts: [
        { inlineData: { mimeType: 'image/jpeg', data: Buffer.from(jpeg).toString('base64') } },
        { text: 'keep the product' },
      ] }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio: '16:9', imageSize: '4K' },
      },
    });
  });

  it('rejects a Gemini image whose declared media type does not match its bytes', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const client = createNewApiClient({
      provider: '4dai',
      tokenSupplier: async () => 'secret-token',
      fetch: async () => jsonResponse({ candidates: [{ content: { parts: [
        { inlineData: { mimeType: 'image/jpeg', data: png.toString('base64') } },
      ] } }] }),
    });

    await expect(client.generateGeminiImage({
      model: 'gemini-3-pro-image-preview',
      prompt: 'poster',
      aspectRatio: '1:1',
      imageSize: '2K',
    })).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE', retryable: false });
  });
});

function sequenceFetch(
  calls: Array<{ url: string; init: NewApiFetchInit | undefined }>,
  responses: readonly ComflyFetchResponse[],
): NewApiFetch {
  const queue = [...responses];
  return vi.fn(async (url: string, init?: NewApiFetchInit) => {
    calls.push({ url, init });
    const response = queue.shift();
    if (response === undefined) throw new Error('Unexpected request');
    return response;
  });
}

function jsonResponse(value: unknown): ComflyFetchResponse {
  return { ok: true, status: 200, json: async () => value };
}

function binaryResponse(value: Uint8Array): ComflyFetchResponse {
  const bytes = Uint8Array.from(value);
  return {
    ok: true,
    status: 200,
    json: async () => null,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}
