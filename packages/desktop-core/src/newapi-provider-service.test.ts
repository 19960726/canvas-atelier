import { describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ComflyFetchResponse } from '@agent-canvas/provider-comfly';
import { createAgentKnowledgeLease, createReversePromptRun } from '@agent-canvas/domain';

import type { NewApiFetch, NewApiFetchInit } from './newapi-client';
import { deriveGenerationHistoryId } from './generation-history-provider-sink';
import { NodeFileSystem } from './file-system';
import type { NewApiModelProfile } from './newapi-model-catalog';
import type { ProviderTaskMappingRecord, ProviderTaskMappingStore } from './provider-task-ledger';
import type { ProviderBridgeProfile } from './provider-contracts';
import {
  createNewApiProviderService,
  mapGptImage2ExactSize,
  mapNewApiVideoSize,
  mapOpenAiImageSize,
  select4daiGptImageModel,
  type NewApiServiceConfigurationStore,
} from './newapi-provider-service';

describe('GPT Image 2 exact size mapping', () => {
  it('maps the requested 16:9 tiers to documented exact sizes', () => {
    expect(mapGptImage2ExactSize('16:9', '2K')).toBe('2560x1440');
    expect(mapGptImage2ExactSize('16:9', '4K')).toBe('3824x2144');
  });

  it.each(['1:1', '2:3', '3:2', '4:3', '3:4', '16:9', '9:16'] as const)(
    'keeps every %s output on the 16-pixel grid and inside GPT Image 2 bounds',
    (ratio) => {
      for (const tier of ['1K', '2K', '4K'] as const) {
        const [width, height] = mapGptImage2ExactSize(ratio, tier).split('x').map(Number) as [number, number];
        expect(width % 16).toBe(0);
        expect(height % 16).toBe(0);
        expect(width).toBeLessThan(3840);
        expect(height).toBeLessThan(3840);
        expect(width * height).toBeGreaterThanOrEqual(655_360);
        expect(width * height).toBeLessThanOrEqual(8_294_400);
      }
    },
  );

  it('uses an account-visible 2K or 4K variant and otherwise keeps the selected route', () => {
    const visible = ['gpt-image-2', 'gpt-image-2-2k', 'gpt-image-2-4k'];
    expect(select4daiGptImageModel('gpt-image-2', '2K', visible)).toBe('gpt-image-2-2k');
    expect(select4daiGptImageModel('gpt-image-2', '4K', visible)).toBe('gpt-image-2-4k');
    expect(select4daiGptImageModel('gpt-image-2', '4K', ['gpt-image-2'])).toBe('gpt-image-2');
    expect(select4daiGptImageModel('gpt-image-1.5', '4K', visible)).toBe('gpt-image-1.5');
  });
});

describe('OpenAI image size mapping', () => {
  it('maps GPT Image 1 and 1.5 ratios to supported square, landscape, and portrait sizes', () => {
    expect(mapOpenAiImageSize('gpt-image-1', '1:1', '1K')).toBe('1024x1024');
    expect(mapOpenAiImageSize('gpt-image-1.5', '3:2', '1K')).toBe('1536x1024');
    expect(mapOpenAiImageSize('gpt-image-1.5', '2:3', '1K')).toBe('1024x1536');
  });

  it.each(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'])(
    'keeps the audited 4D GPT Image 2.5 model %s on the native 4K size path',
    (model) => {
      expect(mapOpenAiImageSize(model, '1:1', '4K')).toBe('2864x2864');
    },
  );
});

describe('Julun video size mapping', () => {
  it('maps symbolic 2K/4K resolutions to real landscape and portrait pixels', () => {
    expect(mapNewApiVideoSize('16:9', '2K')).toBe('2560x1440');
    expect(mapNewApiVideoSize('16:9', '4K')).toBe('3840x2160');
    expect(mapNewApiVideoSize('9:16', '2K')).toBe('1440x2560');
    expect(mapNewApiVideoSize('9:16', '4K')).toBe('2160x3840');
  });
});

describe('secure New API provider service', () => {
  it.each([
    ['julun', 'https://julun-gateway.example/v1'],
    ['4dai', 'https://4d-gateway.example/v1'],
  ] as const)('exposes the persisted %s Base URL through provider status', async (provider, baseUrl) => {
    const service = createNewApiProviderService({
      provider,
      credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore(baseUrl),
      fetch: sequenceFetch([], []),
    });

    await expect(service.getStatus()).resolves.toEqual({
      configured: true,
      locked: false,
      encryption: 'safeStorage',
      baseUrl,
    });
  });

  it('reports a configured but locked credential as service limited without probing the network', async () => {
    const fetch = vi.fn();
    const service = createNewApiProviderService({
      provider: '4dai',
      credentialStore: {
        configure: vi.fn(async () => undefined),
        unlock: vi.fn(async () => undefined),
        getStatus: async () => ({ configured: true, locked: true, encryption: 'passphrase' as const }),
        getPrimaryToken: async () => { throw new Error('credential is locked'); },
      },
      configurationStore: memoryConfigurationStore('https://api.4dai.cc/v1'),
      fetch,
      now: () => new Date('2026-09-10T00:00:00.000Z'),
    });

    await expect(service.checkConnection()).resolves.toEqual({
      checkedAt: '2026-09-10T00:00:00.000Z',
      status: 'service_limited',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refreshes Julun from the authenticated/public intersection and never exposes the raw video id', async () => {
    const rawTaskId = 'provider-raw-task-very-secret';
    const mp4 = Uint8Array.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
    const fetch = sequenceFetch(calls, [
      jsonResponse({ object: 'list', data: [{ id: 'minimax_h3' }] }),
      jsonResponse({ success: true, data: [{ model_name: 'minimax_h3', supported_endpoint_types: ['openai-video'] }] }),
      jsonResponse({ id: rawTaskId, status: 'queued' }),
      jsonResponse({ id: rawTaskId, status: 'completed', progress: 100 }),
      binaryResponse(mp4),
    ]);
    const ledger = providerLedger();
    const service = createNewApiProviderService({
      provider: 'julun',
      credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://julun.cc/v1'),
      fetch,
      providerTaskMappings: ledger.adapter,
      storeGeneratedVideo: async (_sessionId, bytes, mediaType) => {
        expect(bytes).toEqual(mp4);
        expect(mediaType).toBe('video/mp4');
        return { assetId: '0123456789abcdef' };
      },
    });

    await expect(service.refreshCatalog()).resolves.toEqual([
      expect.objectContaining({
        provider: 'julun', modelId: 'minimax_h3', capabilities: ['video_generation', 'async_tasks'],
        constraints: { video: {
          aspectRatios: ['16:9', '9:16'], resolutions: ['480p', '768p'],
          duration: { mode: 'range', defaultValue: 10, min: 5, max: 15, step: 1 }, outputCounts: [1],
        } },
      }),
    ]);
    const verifiedVideoRoute = (await service.listProfiles()).find(profile => profile.modelId === 'minimax_h3')!;
    await service.updateProfiles!({ provider: 'julun', profiles: [verifiedVideoRoute] });
    const submitted = await service.submitVideoJob({
      provider: 'julun', modelRoute: 'julun-minimax-h3', prompt: 'orbit', sessionId: 'session-1',
      aspectRatio: '16:9', resolution: '768p', durationSeconds: 5, referenceAssetIds: [], outputCount: 1,
    });
    expect(submitted.providerTaskId).toMatch(/^provider-job-[a-f0-9]{32}$/u);
    expect(JSON.stringify(submitted)).not.toContain(rawTaskId);
    expect(ledger.records.get(submitted.providerTaskId)).toMatchObject({
      provider: 'julun', rawTaskId, kind: 'video', state: 'running',
    });
    const completed = await service.pollVideoJob({ provider: 'julun', providerTaskId: submitted.providerTaskId });
    expect(completed).toEqual({ status: 'completed', progress: 1, result: { assetId: '0123456789abcdef' } });
    expect(JSON.stringify(completed)).not.toContain(rawTaskId);
    expect(calls.map((call) => call.url).slice(-3)).toEqual([
      'https://julun.cc/v1/videos',
      `https://julun.cc/v1/videos/${rawTaskId}`,
      `https://julun.cc/v1/videos/${rawTaskId}/content`,
    ]);
    const multipart = Buffer.from(calls[2]!.init!.body as Uint8Array).toString('utf8');
    expect(multipart).toContain('name="model"\r\n\r\nminimax_h3');
    expect(multipart).toContain('name="duration"\r\n\r\n5');
    expect(multipart).toContain('name="width"\r\n\r\n1365');
    expect(multipart).toContain('name="height"\r\n\r\n768');
    expect(multipart).not.toContain('name="audio');
  });

  it('routes 4D GPT Image 2 4K to the visible variant while retaining quality and exact size', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
    const fetch = sequenceFetch(calls, [
      jsonResponse({ object: 'list', data: [{ id: 'gpt-image-2' }, { id: 'gpt-image-2-4k' }] }),
      jsonResponse({ success: true, data: [
        { model_name: 'gpt-image-2', supported_endpoint_types: ['image-generation'] },
        { model_name: 'gpt-image-2-4k', supported_endpoint_types: ['image-generation'] },
      ] }),
      jsonResponse({ created: 1, data: [{ b64_json: Buffer.from(png).toString('base64') }] }),
    ]);
    const history = historySink();
    const service = createNewApiProviderService({
      provider: '4dai',
      credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://api.4dai.cc/v1'),
      fetch,
      historySink: history.adapter,
      storeGeneratedImage: async (_sessionId, bytes, mediaType) => {
        expect(bytes).toEqual(png);
        expect(mediaType).toBe('image/png');
        return { assetId: 'fedcba9876543210' };
      },
    });
    await service.refreshCatalog();

    const submitted = await service.submitImageJob({
      jobId: 'model-job-v2-history-4d', provider: '4dai', modelRoute: '4dai-gpt-image-2', prompt: 'poster', sessionId: 'session-2',
      aspectRatio: '16:9', resolution: '4K', quality: 'high', referenceAssetIds: [], outputCount: 1,
    });
    const payload = JSON.parse(calls[calls.length - 1]!.init!.body as string) as Record<string, unknown>;
    expect(payload).toMatchObject({
      model: 'gpt-image-2-4k', quality: 'high', size: '3824x2144', n: 1, prompt: 'poster',
    });
    await expect(service.pollImageJob({ provider: '4dai', providerTaskId: submitted.providerTaskId }))
      .resolves.toEqual({ status: 'completed', progress: 1, result: { assetId: 'fedcba9876543210', assetIds: ['fedcba9876543210'] } });
    expect(history.events).toEqual(['reserve:image:4dai:gpt-image-2', 'running', 'succeeded:image/png']);
  });

  it.each([
    ['gpt-image-1', '4dai-gpt-image-1', '2K'],
    ['gpt-image-1.5', '4dai-gpt-image-1-5', '4K'],
  ] as const)('rejects unsupported %s resolution before making a paid request', async (modelId, modelRoute, resolution) => {
    const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
    const service = createNewApiProviderService({
      provider: '4dai', credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://api.4dai.cc/v1', [{
        provider: '4dai', modelRoute, displayName: modelId, modelId,
        capabilities: ['image_generation'], capabilityStatus: 'complete',
      }]),
      fetch: sequenceFetch(calls, []),
      storeGeneratedImage: async () => ({ assetId: 'fedcba9876543210' }),
    });

    await expect(service.submitImageJob({
      provider: '4dai', modelRoute, prompt: 'poster', sessionId: 'session-size',
      aspectRatio: '16:9', resolution, quality: 'high', referenceAssetIds: [], outputCount: 1,
    })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED', retryable: false });
    expect(calls).toHaveLength(0);
  });

  it.each(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'] as const)(
    'submits the audited 4D %s route as native 4K when the caller omits a resolution',
    async (modelId) => {
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
      const modelRoute = `4dai-${modelId.replace(/[^a-z0-9]+/gu, '-')}`;
      const service = createNewApiProviderService({
        provider: '4dai',
        credentialStore: configuredCredentialStore(),
        configurationStore: memoryConfigurationStore('https://api.4dai.cc/v1', [{
          provider: '4dai', modelRoute, displayName: modelId, modelId,
          capabilities: ['image_generation'], capabilityStatus: 'complete',
          constraints: { image: { aspectRatios: ['1:1'], resolutions: ['4K'], outputCounts: [1] } },
        }]),
        fetch: sequenceFetch(calls, [
          jsonResponse({ data: [{ b64_json: Buffer.from(png).toString('base64') }] }),
        ]),
        storeGeneratedImage: async () => ({ assetId: 'fedcba9876543210' }),
      });

      await service.submitImageJob({
        provider: '4dai', modelRoute, prompt: 'native 4K poster', sessionId: 'session-2-5',
        quality: 'high', referenceAssetIds: [], outputCount: 1,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe('https://api.4dai.cc/v1/images/generations');
      expect(JSON.parse(calls[0]!.init!.body as string)).toMatchObject({
        model: modelId,
        quality: 'high',
        size: '2864x2864',
        n: 1,
      });
    },
  );

  it.each([
    ['gemini-3.1-flash-image-preview', '4dai-gemini-3-1-flash-image-preview'],
    ['gemini-3-pro-image-preview', '4dai-gemini-3-pro-image-preview'],
  ] as const)('submits the audited 4D %s route through Gemini native image generation', async (modelId, modelRoute) => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
    const service = createNewApiProviderService({
      provider: '4dai',
      credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://api.4dai.cc/v1', [{
        provider: '4dai', modelRoute, displayName: modelId, modelId,
        capabilities: ['image_generation', 'image_edit'], capabilityStatus: 'complete',
        constraints: { image: {
          aspectRatios: ['1:1', '2:3', '3:2', '4:3', '3:4', '16:9', '9:16'],
          resolutions: ['1K', '2K', '4K'], outputCounts: [1],
        } },
      }]),
      fetch: sequenceFetch(calls, [jsonResponse({ candidates: [{ content: { parts: [
        { text: 'Generated image' },
        { inlineData: { mimeType: 'image/png', data: Buffer.from(png).toString('base64') } },
      ] } }] })]),
      storeGeneratedImage: async (_sessionId, bytes, mediaType) => {
        expect(bytes).toEqual(png);
        expect(mediaType).toBe('image/png');
        return { assetId: 'fedcba9876543210' };
      },
    });

    const submitted = await service.submitImageJob({
      provider: '4dai', modelRoute, prompt: 'product poster', sessionId: 'session-banana',
      aspectRatio: '16:9', resolution: '4K', referenceAssetIds: [], outputCount: 1,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://api.4dai.cc/v1beta/models/${modelId}:generateContent`);
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'product poster' }] }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio: '16:9', imageSize: '4K' },
      },
    });
    await expect(service.pollImageJob({ provider: '4dai', providerTaskId: submitted.providerTaskId }))
      .resolves.toEqual({ status: 'completed', progress: 1, result: {
        assetId: 'fedcba9876543210', assetIds: ['fedcba9876543210'],
      } });
  });

  it('sends managed reference bytes when 4D Nano Banana edits an image', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const reference = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
    const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
    const readReferenceImage = vi.fn(async () => ({ bytes: reference, mediaType: 'image/jpeg' as const }));
    const service = createNewApiProviderService({
      provider: '4dai',
      credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://api.4dai.cc/v1', [{
        provider: '4dai', modelRoute: '4dai-gemini-3-1-flash-image-preview',
        displayName: 'Nano Banana 2', modelId: 'gemini-3.1-flash-image-preview',
        capabilities: ['image_generation', 'image_edit'], capabilityStatus: 'complete',
        constraints: { image: { aspectRatios: ['1:1'], resolutions: ['2K'], outputCounts: [1] } },
      }]),
      fetch: sequenceFetch(calls, [jsonResponse({ candidates: [{ content: { parts: [
        { inlineData: { mimeType: 'image/png', data: Buffer.from(png).toString('base64') } },
      ] } }] })]),
      readReferenceImage,
      storeGeneratedImage: async () => ({ assetId: 'fedcba9876543211' }),
    });

    await service.submitImageJob({
      provider: '4dai', modelRoute: '4dai-gemini-3-1-flash-image-preview',
      prompt: 'keep the product and change the background', sessionId: 'session-banana-edit',
      aspectRatio: '1:1', resolution: '2K', referenceAssetIds: ['0123456789abcdef'], outputCount: 1,
    });

    expect(readReferenceImage).toHaveBeenCalledWith('session-banana-edit', '0123456789abcdef');
    expect(JSON.parse(calls[0]!.init!.body as string)).toMatchObject({
      contents: [{ role: 'user', parts: [
        { inlineData: { mimeType: 'image/jpeg', data: Buffer.from(reference).toString('base64') } },
        { text: 'keep the product and change the background' },
      ] }],
      generationConfig: { imageConfig: { aspectRatio: '1:1', imageSize: '2K' } },
    });
  });

  it('does not switch GPT Image 2 to an openai-only incomplete 4K variant', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
    const service = createNewApiProviderService({
      provider: '4dai', credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://api.4dai.cc/v1'),
      fetch: sequenceFetch(calls, [
        jsonResponse({ data: [{ id: 'gpt-image-2' }, { id: 'gpt-image-2-4k' }] }),
        jsonResponse({ data: [
          { model_name: 'gpt-image-2', supported_endpoint_types: ['image-generation'] },
          { model_name: 'gpt-image-2-4k', supported_endpoint_types: ['openai'] },
        ] }),
        jsonResponse({ data: [{ b64_json: Buffer.from(png).toString('base64') }] }),
      ]),
      storeGeneratedImage: async () => ({ assetId: 'fedcba9876543210' }),
    });
    await service.refreshCatalog();

    await service.submitImageJob({
      provider: '4dai', modelRoute: '4dai-gpt-image-2', prompt: 'poster', sessionId: 'session-variant',
      aspectRatio: '16:9', resolution: '4K', referenceAssetIds: [], outputCount: 1,
    });

    expect(JSON.parse(calls[2]!.init!.body as string)).toMatchObject({ model: 'gpt-image-2' });
  });

  it('keeps a remote 4D image recoverable across a transient download and service restart', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const resultUrl = 'https://cdn.example.test/generated.png';
    const ledger = providerLedger();
    const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
    const configurationStore = memoryConfigurationStore('https://api.4dai.cc/v1', [{
      provider: '4dai', modelRoute: '4dai-gpt-image-2', displayName: 'gpt-image-2', modelId: 'gpt-image-2',
      capabilities: ['image_generation'], capabilityStatus: 'complete',
    }]);
    const common = {
      provider: '4dai' as const,
      credentialStore: configuredCredentialStore(), configurationStore,
      providerTaskMappings: ledger.adapter,
      historySink: durableHistorySink(),
      resolveResultHost: async () => ['93.184.216.34'],
      storeGeneratedImage: vi.fn(async () => ({ assetId: 'fedcba9876543210' })),
    };
    const request = {
      jobId: 'model-job-v2-remote-image-restart', provider: '4dai' as const, modelRoute: '4dai-gpt-image-2',
      prompt: 'poster', sessionId: 'session-remote-image', referenceAssetIds: [] as string[], outputCount: 1 as const,
    };
    const first = createNewApiProviderService({
      ...common,
      fetch: sequenceFetch(calls, [jsonResponse({ data: [{ url: resultUrl }] })]),
    });

    const submitted = await first.submitImageJob(request);
    expect(ledger.records.get(submitted.providerTaskId)).toMatchObject({ kind: 'image', state: 'running', rawTaskId: resultUrl });

    const restarted = createNewApiProviderService({
      ...common,
      fetch: sequenceFetch(calls, [
        { ok: false, status: 503, json: async () => ({}) },
        binaryResponse(png),
      ]),
    });
    await expect(restarted.submitImageJob(request)).resolves.toEqual(submitted);
    await expect(restarted.pollImageJob({ provider: '4dai', providerTaskId: submitted.providerTaskId }))
      .resolves.toEqual({ status: 'running' });
    await expect(restarted.pollImageJob({ provider: '4dai', providerTaskId: submitted.providerTaskId }))
      .resolves.toEqual({ status: 'completed', progress: 1, result: { assetId: 'fedcba9876543210', assetIds: ['fedcba9876543210'] } });
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.4dai.cc/v1/images/generations', resultUrl, resultUrl,
    ]);
    expect(common.storeGeneratedImage).toHaveBeenCalledTimes(1);
  });

  it.each(['network', 408, 425, 429, 500, 503] as const)(
    'keeps a remote 4D image running after a transient %s download failure',
    async (failure) => {
      const resultUrl = 'https://cdn.example.test/transient.png';
      let requestCount = 0;
      const fetch: NewApiFetch = vi.fn(async () => {
        requestCount += 1;
        if (requestCount === 1) return jsonResponse({ data: [{ url: resultUrl }] });
        if (failure === 'network') throw new Error('temporary network failure');
        return { ok: false, status: failure, json: async () => ({}) };
      });
      const service = createNewApiProviderService({
        provider: '4dai', credentialStore: configuredCredentialStore(),
        configurationStore: memoryConfigurationStore('https://api.4dai.cc/v1', [{
          provider: '4dai', modelRoute: '4dai-gpt-image-2', displayName: 'gpt-image-2', modelId: 'gpt-image-2',
          capabilities: ['image_generation'], capabilityStatus: 'complete',
        }]),
        fetch,
        resolveResultHost: async () => ['93.184.216.34'],
        storeGeneratedImage: async () => ({ assetId: 'fedcba9876543210' }),
      });
      const submitted = await service.submitImageJob({
        provider: '4dai', modelRoute: '4dai-gpt-image-2', prompt: 'poster', sessionId: 'session-transient',
        referenceAssetIds: [], outputCount: 1,
      });

      await expect(service.pollImageJob({ provider: '4dai', providerTaskId: submitted.providerTaskId }))
        .resolves.toEqual({ status: 'running' });
    },
  );

  it('persists a Julun remote task before a throwing history running callback', async () => {
    const ledger = providerLedger();
    const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
    const baseHistory = durableHistorySink();
    const historySink = { ...baseHistory, running: vi.fn(async () => { throw new Error('history unavailable'); }) };
    const options = {
      provider: 'julun' as const, credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://julun.cc/v1', [{
        provider: 'julun', modelRoute: 'julun-minimax-h3', displayName: 'minimax_h3', modelId: 'minimax_h3',
        capabilities: ['video_generation', 'async_tasks'], capabilityStatus: 'complete',
      }]),
      providerTaskMappings: ledger.adapter, historySink,
    };
    const request = {
      jobId: 'model-job-v2-history-running', provider: 'julun' as const, modelRoute: 'julun-minimax-h3', prompt: 'orbit',
      sessionId: 'session-history-running', referenceAssetIds: [] as string[], outputCount: 1 as const,
    };
    const first = createNewApiProviderService({
      ...options,
      fetch: sequenceFetch(calls, [jsonResponse({ id: 'raw-task', status: 'queued' })]),
    });

    const submitted = await first.submitVideoJob(request);
    expect(ledger.records.get(submitted.providerTaskId)).toMatchObject({ state: 'running', rawTaskId: 'raw-task' });
    const restartedFetch = vi.fn(async () => { throw new Error('paid POST must not repeat'); });
    const restarted = createNewApiProviderService({ ...options, fetch: restartedFetch });
    await expect(restarted.submitVideoJob(request)).resolves.toEqual(submitted);
    expect(restartedFetch).not.toHaveBeenCalled();
  });

  it('keeps a stored 4D image retryable when the history success callback throws', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const baseHistory = durableHistorySink();
    const service = createNewApiProviderService({
      provider: '4dai', credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://api.4dai.cc/v1', [{
        provider: '4dai', modelRoute: '4dai-gpt-image-2', displayName: 'gpt-image-2', modelId: 'gpt-image-2',
        capabilities: ['image_generation'], capabilityStatus: 'complete',
      }]),
      fetch: sequenceFetch([], [jsonResponse({ data: [{ b64_json: Buffer.from(png).toString('base64') }] })]),
      historySink: { ...baseHistory, succeeded: vi.fn(async () => { throw new Error('history unavailable'); }) },
      storeGeneratedImage: async () => ({ assetId: 'fedcba9876543210' }),
    });

    const submitted = await service.submitImageJob({
      jobId: 'model-job-v2-history-success', provider: '4dai', modelRoute: '4dai-gpt-image-2', prompt: 'poster',
      sessionId: 'session-history-success', referenceAssetIds: [], outputCount: 1,
    });
    await expect(service.pollImageJob({ provider: '4dai', providerTaskId: submitted.providerTaskId }))
      .resolves.toMatchObject({ status: 'running' });
  });

  it('keeps provider failure retryable until history is durable and leaves cancellation pending when history is unavailable', async () => {
    const failedLedger = providerLedger();
    const baseHistory = durableHistorySink();
    const failedService = createNewApiProviderService({
      provider: 'julun', credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://julun.cc/v1', [{
        provider: 'julun', modelRoute: 'julun-minimax-h3', displayName: 'minimax_h3', modelId: 'minimax_h3',
        capabilities: ['video_generation', 'async_tasks'], capabilityStatus: 'complete',
      }]),
      providerTaskMappings: failedLedger.adapter,
      historySink: { ...baseHistory, failed: vi.fn(async () => { throw new Error('history unavailable'); }) },
      fetch: sequenceFetch([], [
        jsonResponse({ id: 'raw-failed', status: 'queued' }),
        jsonResponse({ id: 'raw-failed', status: 'failed' }),
      ]),
    });
    const failed = await failedService.submitVideoJob({
      jobId: 'model-job-v2-history-failed', provider: 'julun', modelRoute: 'julun-minimax-h3', prompt: 'orbit',
      sessionId: 'session-history-failed', referenceAssetIds: [], outputCount: 1,
    });
    await expect(failedService.pollVideoJob({ provider: 'julun', providerTaskId: failed.providerTaskId }))
      .resolves.toMatchObject({ status: 'running' });
    expect(failedLedger.records.get(failed.providerTaskId)).toMatchObject({ state: 'running' });

    const cancelledLedger = providerLedger();
    const cancelledService = createNewApiProviderService({
      provider: 'julun', credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://julun.cc/v1', [{
        provider: 'julun', modelRoute: 'julun-minimax-h3', displayName: 'minimax_h3', modelId: 'minimax_h3',
        capabilities: ['video_generation', 'async_tasks'], capabilityStatus: 'complete',
      }]),
      providerTaskMappings: cancelledLedger.adapter,
      historySink: { ...baseHistory, cancelled: vi.fn(async () => { throw new Error('history unavailable'); }) },
      fetch: sequenceFetch([], [jsonResponse({ id: 'raw-cancelled', status: 'queued' })]),
    });
    const cancelled = await cancelledService.submitVideoJob({
      jobId: 'model-job-v2-history-cancelled', provider: 'julun', modelRoute: 'julun-minimax-h3', prompt: 'orbit',
      sessionId: 'session-history-cancelled', referenceAssetIds: [], outputCount: 1,
    });
    await expect(cancelledService.cancelVideoJob({ provider: 'julun', providerTaskId: cancelled.providerTaskId }))
      .rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true,
        message: expect.stringContaining('提交状态不确定') });
    expect(cancelledLedger.records.get(cancelled.providerTaskId)).toMatchObject({ state: 'running' });
  });

  it('does not cancel a 4D image whose durable history already succeeded', async () => {
    const ledger = providerLedger();
    const history = durableHistorySink();
    const cancelled = vi.fn(async () => ({ status: 'succeeded' as const, width: 1, height: 1 }));
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const service = createNewApiProviderService({
      provider: '4dai', credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://api.4dai.cc/v1', [{
        provider: '4dai', modelRoute: '4dai-gpt-image-2', displayName: 'gpt-image-2', modelId: 'gpt-image-2',
        capabilities: ['image_generation'], capabilityStatus: 'complete',
      }]),
      providerTaskMappings: ledger.adapter, historySink: { ...history, cancelled },
      fetch: sequenceFetch([], [jsonResponse({ data: [{ url: 'https://cdn.example.test/image.png' }] })]),
      storeGeneratedImage: async () => ({ assetId: '0123456789abcdef' }),
    });
    const submitted = await service.submitImageJob({
      jobId: 'model-job-v2-history-won-image', provider: '4dai', modelRoute: '4dai-gpt-image-2',
      prompt: 'poster', sessionId: 'session-history-won', referenceAssetIds: [], outputCount: 1,
    });
    await expect(service.cancelImageJob({ provider: '4dai', providerTaskId: submitted.providerTaskId }))
      .rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true,
        message: expect.stringContaining('提交状态不确定') });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(ledger.records.get(submitted.providerTaskId)).toMatchObject({ state: 'running' });
  });

  it('reconciles an ambiguous Julun cancellation from durable history on poll without a provider request', async () => {
    const ledger = providerLedger();
    const history = durableHistorySink();
    let durableCancelled = false;
    const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
    const service = createNewApiProviderService({
      provider: 'julun', credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://julun.cc/v1', [{
        provider: 'julun', modelRoute: 'julun-minimax-h3', displayName: 'minimax_h3', modelId: 'minimax_h3',
        capabilities: ['video_generation', 'async_tasks'], capabilityStatus: 'complete',
      }]),
      providerTaskMappings: ledger.adapter,
      historySink: {
        ...history,
        cancelled: async () => { durableCancelled = true; throw new Error('history post-write verification failed'); },
        getTerminal: async () => durableCancelled ? { status: 'cancelled' as const } : null,
      },
      fetch: sequenceFetch(calls, [jsonResponse({ id: 'one-paid-video', status: 'queued' })]),
    });
    const submitted = await service.submitVideoJob({
      jobId: 'model-job-v2-ambiguous-cancel-julun', provider: 'julun', modelRoute: 'julun-minimax-h3',
      prompt: 'orbit', sessionId: 'session-ambiguous-cancel', referenceAssetIds: [], outputCount: 1,
    });
    await expect(service.cancelVideoJob({ provider: 'julun', providerTaskId: submitted.providerTaskId }))
      .rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    expect(ledger.records.get(submitted.providerTaskId)).toMatchObject({ state: 'running' });
    await expect(service.pollVideoJob({ provider: 'julun', providerTaskId: submitted.providerTaskId }))
      .resolves.toEqual({ status: 'cancelled' });
    expect(ledger.records.get(submitted.providerTaskId)).toMatchObject({ state: 'cancelled' });
    expect(calls).toHaveLength(1);
  });

  it('maps a remotely cancelled Julun task to cancelled even when history is unavailable', async () => {
    const ledger = providerLedger();
    const baseHistory = durableHistorySink();
    const cancelledHistory = vi.fn(async () => { throw new Error('history unavailable'); });
    const service = createNewApiProviderService({
      provider: 'julun', credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://julun.cc/v1', [{
        provider: 'julun', modelRoute: 'julun-minimax-h3', displayName: 'minimax_h3', modelId: 'minimax_h3',
        capabilities: ['video_generation', 'async_tasks'], capabilityStatus: 'complete',
      }]),
      providerTaskMappings: ledger.adapter,
      historySink: { ...baseHistory, cancelled: cancelledHistory },
      fetch: sequenceFetch([], [
        jsonResponse({ id: 'raw-remote-cancelled', status: 'queued' }),
        jsonResponse({ id: 'raw-remote-cancelled', status: 'cancelled' }),
      ]),
    });
    const submitted = await service.submitVideoJob({
      jobId: 'model-job-v2-remote-cancelled', provider: 'julun', modelRoute: 'julun-minimax-h3', prompt: 'orbit',
      sessionId: 'session-remote-cancelled', referenceAssetIds: [], outputCount: 1,
    });

    await expect(service.pollVideoJob({ provider: 'julun', providerTaskId: submitted.providerTaskId }))
      .resolves.toEqual({ status: 'cancelled' });
    expect(ledger.records.get(submitted.providerTaskId)).toMatchObject({ state: 'cancelled' });
    expect(cancelledHistory).toHaveBeenCalledWith(deriveGenerationHistoryId('model-job-v2-remote-cancelled'), 'cancelled_by_system');
  });

  it('reuses the same terminal image task across a service restart without another paid POST', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ledger = providerLedger();
    const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
    const options = {
      provider: '4dai' as const,
      credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://api.4dai.cc/v1', [{
        provider: '4dai', modelRoute: '4dai-gpt-image-1-5', displayName: 'gpt-image-1.5', modelId: 'gpt-image-1.5',
        capabilities: ['image_generation'], capabilityStatus: 'complete',
      }]),
      providerTaskMappings: ledger.adapter,
      historySink: durableHistorySink(),
      storeGeneratedImage: async () => ({ assetId: 'fedcba9876543210' }),
    };
    const first = createNewApiProviderService({
      ...options,
      fetch: sequenceFetch(calls, [jsonResponse({ data: [{ b64_json: Buffer.from(png).toString('base64') }] })]),
    });
    const request = {
      jobId: 'model-job-v2-idempotent-image', provider: '4dai' as const, modelRoute: '4dai-gpt-image-1-5', prompt: 'poster',
      sessionId: 'session-idempotent', referenceAssetIds: [] as string[], outputCount: 1 as const,
    };
    const submitted = await first.submitImageJob(request);
    const restartedFetch = vi.fn(async () => { throw new Error('paid POST must not repeat'); });
    const restarted = createNewApiProviderService({ ...options, fetch: restartedFetch });

    await expect(restarted.submitImageJob(request)).resolves.toEqual(submitted);
    expect(restartedFetch).not.toHaveBeenCalled();
  });

  it('fails closed after a successful remote submit when the ledger write fails', async () => {
    const ledger = providerLedger();
    ledger.adapter.set = vi.fn(async () => { throw new Error('disk unavailable'); });
    const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
    const service = createNewApiProviderService({
      provider: 'julun', credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://julun.cc/v1', [{
        provider: 'julun', modelRoute: 'julun-minimax-h3', displayName: 'minimax_h3', modelId: 'minimax_h3',
        capabilities: ['video_generation', 'async_tasks'], capabilityStatus: 'complete',
      }]),
      fetch: sequenceFetch(calls, [jsonResponse({ id: 'raw-task', status: 'queued' })]),
      providerTaskMappings: ledger.adapter,
    });
    const request = {
      jobId: 'model-job-v2-ledger-failure', provider: 'julun' as const, modelRoute: 'julun-minimax-h3', prompt: 'orbit',
      sessionId: 'session-ledger', referenceAssetIds: [] as string[], outputCount: 1 as const,
    };

    await expect(service.submitVideoJob(request)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE', message: expect.stringContaining('提交状态不确定'),
    });
    await expect(service.submitVideoJob(request)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE', message: expect.stringContaining('提交状态不确定'),
    });
    expect(calls).toHaveLength(1);
  });

  it('persists invalid completed video content as a non-retryable terminal failure', async () => {
    const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
    const service = createNewApiProviderService({
      provider: 'julun', credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://julun.cc/v1', [{
        provider: 'julun', modelRoute: 'julun-minimax-h3', displayName: 'minimax_h3', modelId: 'minimax_h3',
        capabilities: ['video_generation', 'async_tasks'], capabilityStatus: 'complete',
      }]),
      fetch: sequenceFetch(calls, [
        jsonResponse({ id: 'raw-task', status: 'queued' }),
        jsonResponse({ id: 'raw-task', status: 'completed' }),
        binaryResponse(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])),
      ]),
      storeGeneratedVideo: async () => ({ assetId: '0123456789abcdef' }),
    });
    const submitted = await service.submitVideoJob({
      provider: 'julun', modelRoute: 'julun-minimax-h3', prompt: 'orbit', sessionId: 'session-invalid', referenceAssetIds: [], outputCount: 1,
    });

    await expect(service.pollVideoJob({ provider: 'julun', providerTaskId: submitted.providerTaskId })).resolves.toMatchObject({
      status: 'failed', error: { code: 'PROVIDER_INVALID_RESPONSE', retryable: false },
    });
    await expect(service.pollVideoJob({ provider: 'julun', providerTaskId: submitted.providerTaskId })).resolves.toMatchObject({ status: 'failed' });
    expect(calls).toHaveLength(3);
  });

  it('keeps a completed video retryable when managed storage is temporarily unavailable', async () => {
    const mp4 = Uint8Array.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70]);
    const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
    const service = createNewApiProviderService({
      provider: 'julun', credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://julun.cc/v1', [{
        provider: 'julun', modelRoute: 'julun-minimax-h3', displayName: 'minimax_h3', modelId: 'minimax_h3',
        capabilities: ['video_generation', 'async_tasks'], capabilityStatus: 'complete',
      }]),
      fetch: sequenceFetch(calls, [
        jsonResponse({ id: 'raw-task', status: 'queued' }),
        jsonResponse({ id: 'raw-task', status: 'completed' }),
        binaryResponse(mp4),
      ]),
      storeGeneratedVideo: vi.fn()
        .mockRejectedValueOnce(new Error('managed asset store failed'))
        .mockResolvedValue({ assetId: '0123456789abcdef' }),
    });
    const submitted = await service.submitVideoJob({
      provider: 'julun', modelRoute: 'julun-minimax-h3', prompt: 'orbit', sessionId: 'session-store', referenceAssetIds: [], outputCount: 1,
    });

    await expect(service.pollVideoJob({ provider: 'julun', providerTaskId: submitted.providerTaskId })).resolves.toMatchObject({ status: 'running' });
    await expect(service.pollVideoJob({ provider: 'julun', providerTaskId: submitted.providerTaskId })).resolves.toMatchObject({ status: 'completed' });
    expect(calls).toHaveLength(3);
  });

  it('closes a missing paid Julun video outbox as uncertain without another provider request', async () => {
    const appDataRoot = await mkdtemp(join(tmpdir(), 'newapi-video-missing-'));
    try {
      const mp4 = Uint8Array.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70]);
      const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
      const ledger = providerLedger();
      const service = createNewApiProviderService({
        provider: 'julun', appDataRoot, credentialStore: configuredCredentialStore(),
        configurationStore: memoryConfigurationStore('https://julun.cc/v1', [{
          provider: 'julun', modelRoute: 'julun-minimax-h3', displayName: 'minimax_h3', modelId: 'minimax_h3',
          capabilities: ['video_generation', 'async_tasks'], capabilityStatus: 'complete',
        }]),
        providerTaskMappings: ledger.adapter,
        bindGenerationProject: async () => ({ projectId: 'video-project', rootFingerprint: 'a'.repeat(64) }),
        storeGeneratedVideoForProject: vi.fn(async () => { throw new Error('project temporarily busy'); }),
        fetch: sequenceFetch(calls, [
          jsonResponse({ id: 'raw-task', status: 'queued' }),
          jsonResponse({ id: 'raw-task', status: 'completed' }), binaryResponse(mp4),
        ]),
      });
      const submitted = await service.submitVideoJob({
        jobId: 'model-job-v2-video-outbox-missing', projectId: 'video-project', provider: 'julun',
        modelRoute: 'julun-minimax-h3', prompt: 'orbit', sessionId: 'video-session', referenceAssetIds: [], outputCount: 1,
      });
      await expect(service.pollVideoJob({ provider: 'julun', providerTaskId: submitted.providerTaskId }))
        .resolves.toMatchObject({ status: 'running' });
      await rm(join(appDataRoot, `newapi-pending-${submitted.providerTaskId}.bin`));
      await expect(service.pollVideoJob({ provider: 'julun', providerTaskId: submitted.providerTaskId }))
        .resolves.toMatchObject({ status: 'failed', error: { code: 'PROVIDER_INVALID_RESPONSE',
          message: expect.stringContaining('提交状态不确定'), retryable: false } });
      expect(calls).toHaveLength(3);
    } finally {
      await rm(appDataRoot, { recursive: true, force: true });
    }
  });

  it('stages a paid inline 4D result before project storage and repairs history after restart without a second POST', async () => {
    const appDataRoot = await mkdtemp(join(tmpdir(), 'newapi-pending-'));
    try {
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const binding = { projectId: 'project-a', rootFingerprint: 'a'.repeat(64) };
      const ledger = providerLedger();
      const history = durableHistorySink();
      const succeeded = vi.fn().mockRejectedValueOnce(new Error('history busy'))
        .mockResolvedValue({ status: 'succeeded', width: 1, height: 1 });
      const bindGenerationProject = vi.fn(async (_sessionId: string, projectId?: string) => {
        if (projectId !== binding.projectId) throw new Error('wrong project');
        return binding;
      });
      const common = {
        provider: '4dai' as const, appDataRoot,
        credentialStore: configuredCredentialStore(),
        configurationStore: memoryConfigurationStore('https://api.4dai.cc/v1', [{
          provider: '4dai', modelRoute: '4dai-gpt-image-2', displayName: 'gpt-image-2', modelId: 'gpt-image-2',
          capabilities: ['image_generation' as const], capabilityStatus: 'complete' as const,
        }]),
        providerTaskMappings: ledger.adapter, historySink: { ...history, succeeded },
        bindGenerationProject,
      };
      const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
      const first = createNewApiProviderService({
        ...common,
        fetch: sequenceFetch(calls, [jsonResponse({ data: [{ b64_json: Buffer.from(png).toString('base64') }] })]),
        storeGeneratedImageForProject: vi.fn(async () => { throw new Error('project temporarily unavailable'); }),
      });
      const request = {
        jobId: 'model-job-v2-inline-recovery', projectId: 'project-a', provider: '4dai' as const,
        modelRoute: '4dai-gpt-image-2', prompt: 'poster', sessionId: 'old-session',
        referenceAssetIds: [] as string[], outputCount: 1 as const,
      };
      const submitted = await first.submitImageJob(request);
      expect(ledger.records.get(submitted.providerTaskId)).toMatchObject({
        state: 'running', projectBinding: binding,
      });
      await expect(first.pollImageJob({ provider: '4dai', providerTaskId: submitted.providerTaskId }))
        .resolves.toMatchObject({ status: 'running' });

      const boundStore = vi.fn(async (_binding: typeof binding, _bytes: Uint8Array, _mediaType: string) => ({ assetId: 'fedcba9876543210' }));
      const noSecondPost = vi.fn(async () => { throw new Error('paid POST must not repeat'); });
      const restarted = createNewApiProviderService({
        ...common, fetch: noSecondPost, storeGeneratedImageForProject: boundStore,
      });
      await expect(restarted.submitImageJob(request)).resolves.toEqual(submitted);
      await expect(restarted.pollImageJob({ provider: '4dai', providerTaskId: submitted.providerTaskId }))
        .resolves.toMatchObject({ status: 'running' });
      await expect(restarted.pollImageJob({ provider: '4dai', providerTaskId: submitted.providerTaskId }))
        .resolves.toMatchObject({ status: 'completed', result: { assetId: 'fedcba9876543210' } });
      expect(boundStore).toHaveBeenCalledTimes(1);
      expect(boundStore.mock.calls[0]?.[0]).toEqual(binding);
      expect(Array.from(boundStore.mock.calls[0]?.[1] as Uint8Array)).toEqual(Array.from(png));
      expect(boundStore.mock.calls[0]?.[2]).toBe('image/png');
      expect(succeeded).toHaveBeenCalledTimes(2);
      expect(noSecondPost).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
      await restarted.ackImageJobTerminal({ provider: '4dai', providerTaskId: submitted.providerTaskId });
      await expect(access(join(appDataRoot, `newapi-pending-${submitted.providerTaskId}.bin`))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(appDataRoot, { recursive: true, force: true });
    }
  });

  it('binds a Julun destination before paid POST and resumes a completed video in that project after restart', async () => {
    const appDataRoot = await mkdtemp(join(tmpdir(), 'newapi-video-pending-'));
    try {
      const mp4 = Uint8Array.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70]);
      const binding = { projectId: 'project-a', rootFingerprint: 'a'.repeat(64) };
      const ledger = providerLedger();
      const bindGenerationProject = vi.fn(async (_sessionId: string, projectId?: string) => {
        if (projectId !== binding.projectId) throw new Error('wrong project');
        return binding;
      });
      const common = {
        provider: 'julun' as const, appDataRoot,
        credentialStore: configuredCredentialStore(),
        configurationStore: memoryConfigurationStore('https://julun.cc/v1', [{
          provider: 'julun', modelRoute: 'julun-minimax-h3', displayName: 'minimax_h3', modelId: 'minimax_h3',
          capabilities: ['video_generation' as const, 'async_tasks' as const], capabilityStatus: 'complete' as const,
        }]),
        providerTaskMappings: ledger.adapter, bindGenerationProject,
      };
      const firstCalls: Array<{ url: string; init?: NewApiFetchInit }> = [];
      const first = createNewApiProviderService({
        ...common, fetch: sequenceFetch(firstCalls, [jsonResponse({ id: 'raw-task', status: 'queued' })]),
      });
      const request = {
        jobId: 'model-job-v2-bound-video', projectId: 'project-a', provider: 'julun' as const,
        modelRoute: 'julun-minimax-h3', prompt: 'orbit', sessionId: 'old-session',
        referenceAssetIds: [] as string[], outputCount: 1 as const,
      };
      await expect(first.submitVideoJob({ ...request, projectId: 'project-b' })).rejects.toThrow('wrong project');
      expect(firstCalls).toHaveLength(0);
      const submitted = await first.submitVideoJob(request);
      expect(ledger.records.get(submitted.providerTaskId)).toMatchObject({ projectBinding: binding });
      const wrongProject = createNewApiProviderService({
        ...common,
        bindGenerationProject: async () => ({ projectId: 'project-b', rootFingerprint: 'b'.repeat(64) }),
        fetch: vi.fn(async () => { throw new Error('paid POST must not repeat'); }),
      });
      await expect(wrongProject.submitVideoJob({ ...request, projectId: 'project-b' }))
        .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      const storeGeneratedVideoForProject = vi.fn()
        .mockRejectedValueOnce(new Error('project temporarily unavailable'))
        .mockResolvedValue({ assetId: '0123456789abcdef' });
      const restartCalls: Array<{ url: string; init?: NewApiFetchInit }> = [];
      const restarted = createNewApiProviderService({
        ...common,
        fetch: sequenceFetch(restartCalls, [
          jsonResponse({ id: 'raw-task', status: 'completed' }), binaryResponse(mp4),
        ]),
        storeGeneratedVideoForProject,
      });
      await expect(restarted.pollVideoJob({ provider: 'julun', providerTaskId: submitted.providerTaskId }))
        .resolves.toMatchObject({ status: 'running' });
      await expect(restarted.pollVideoJob({ provider: 'julun', providerTaskId: submitted.providerTaskId }))
        .resolves.toMatchObject({ status: 'completed', result: { assetId: '0123456789abcdef' } });
      expect(storeGeneratedVideoForProject).toHaveBeenCalledTimes(2);
      expect(storeGeneratedVideoForProject.mock.lastCall?.[0]).toEqual(binding);
      expect(Array.from(storeGeneratedVideoForProject.mock.lastCall?.[1] as Uint8Array)).toEqual(Array.from(mp4));
      expect(storeGeneratedVideoForProject.mock.lastCall?.[2]).toBe('video/mp4');
      expect(restartCalls).toHaveLength(2);
      expect(firstCalls).toHaveLength(1);
    } finally {
      await rm(appDataRoot, { recursive: true, force: true });
    }
  });

  it('does not write a legacy unbound 4D result into a newly opened same-id project', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const taskId = `provider-job-${'a'.repeat(32)}`;
    const ledger = providerLedger();
    ledger.records.set(taskId, {
      provider: '4dai', publicTaskId: taskId, rawTaskId: 'https://cdn.example.test/legacy.png',
      kind: 'image', state: 'running', sessionId: 'legacy-session',
      createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z',
    });
    const storeGeneratedImage = vi.fn(async () => ({ assetId: 'fedcba9876543210' }));
    const storeGeneratedImageForProject = vi.fn(async () => ({ assetId: 'fedcba9876543210' }));
    const service = createNewApiProviderService({
      provider: '4dai', credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://api.4dai.cc/v1'),
      providerTaskMappings: ledger.adapter,
      bindGenerationProject: async () => ({ projectId: 'same-id', rootFingerprint: 'b'.repeat(64) }),
      storeGeneratedImage, storeGeneratedImageForProject,
      resolveResultHost: async () => ['93.184.216.34'],
      fetch: sequenceFetch([], [binaryResponse(png)]),
    });

    await expect(service.pollImageJob({ provider: '4dai', providerTaskId: taskId }))
      .resolves.toMatchObject({ status: 'failed', error: { code: 'PROVIDER_UNAVAILABLE', retryable: false } });
    expect(storeGeneratedImage).not.toHaveBeenCalled();
    expect(storeGeneratedImageForProject).not.toHaveBeenCalled();
    expect(ledger.records.get(taskId)).toMatchObject({ state: 'failed', sessionId: 'legacy-session' });
  });

  it.each(['corrupt', 'missing', 'symlink'] as const)('shows an uncertain terminal failure for a %s staged 4D result', async (damage) => {
    const appDataRoot = await mkdtemp(join(tmpdir(), 'newapi-corrupt-'));
    try {
      const fileSystem = new NodeFileSystem();
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const ledger = providerLedger();
      const storeGeneratedImageForProject = vi.fn(async () => { throw new Error('temporary project lock'); });
      const service = createNewApiProviderService({
        provider: '4dai', appDataRoot, fileSystem, credentialStore: configuredCredentialStore(),
        configurationStore: memoryConfigurationStore('https://api.4dai.cc/v1', [{
          provider: '4dai', modelRoute: '4dai-gpt-image-2', displayName: 'gpt-image-2', modelId: 'gpt-image-2',
          capabilities: ['image_generation'], capabilityStatus: 'complete',
        }]),
        providerTaskMappings: ledger.adapter, historySink: durableHistorySink(),
        bindGenerationProject: async () => ({ projectId: 'project-a', rootFingerprint: 'a'.repeat(64) }),
        storeGeneratedImageForProject,
        fetch: sequenceFetch([], [jsonResponse({ data: [{ b64_json: Buffer.from(png).toString('base64') }] })]),
      });
      const submitted = await service.submitImageJob({
        jobId: 'model-job-v2-corrupt-inline', projectId: 'project-a', provider: '4dai',
        modelRoute: '4dai-gpt-image-2', prompt: 'poster', sessionId: 'session-a', referenceAssetIds: [], outputCount: 1,
      });
      const pendingPath = join(appDataRoot, `newapi-pending-${submitted.providerTaskId}.bin`);
      if (damage === 'corrupt') await writeFile(pendingPath, Uint8Array.from([1, 2, 3]));
      else if (damage === 'missing') await rm(pendingPath);
      else {
        const originalLstat = fileSystem.lstat.bind(fileSystem);
        vi.spyOn(fileSystem, 'lstat').mockImplementation(async (path) => {
          const stat = await originalLstat(path);
          return path === pendingPath ? Object.assign(stat, { isSymbolicLink: () => true }) : stat;
        });
      }
      await expect(service.pollImageJob({ provider: '4dai', providerTaskId: submitted.providerTaskId }))
        .resolves.toMatchObject({ status: 'failed', error: { code: 'PROVIDER_INVALID_RESPONSE',
          message: expect.stringContaining('提交状态不确定'), retryable: false } });
      expect(storeGeneratedImageForProject).toHaveBeenCalledTimes(1);
      expect(ledger.records.get(submitted.providerTaskId)).toMatchObject({ state: 'failed' });
    } finally {
      await rm(appDataRoot, { recursive: true, force: true });
    }
  });

  it('retries an accepted Julun task mapping write without sending another paid POST', async () => {
    const ledger = providerLedger();
    const originalSet = ledger.adapter.set.bind(ledger.adapter);
    const set = vi.spyOn(ledger.adapter, 'set')
      .mockRejectedValueOnce(new Error('temporary mapping lock'))
      .mockImplementation(originalSet);
    const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
    const service = createNewApiProviderService({
      provider: 'julun', credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://julun.cc/v1', [{
        provider: 'julun', modelRoute: 'julun-minimax-h3', displayName: 'minimax_h3', modelId: 'minimax_h3',
        capabilities: ['video_generation', 'async_tasks'], capabilityStatus: 'complete',
      }]),
      providerTaskMappings: ledger.adapter,
      fetch: sequenceFetch(calls, [jsonResponse({ id: 'raw-task', status: 'queued' })]),
    });
    const submitted = await service.submitVideoJob({
      jobId: 'model-job-v2-mapping-retry', provider: 'julun', modelRoute: 'julun-minimax-h3',
      prompt: 'orbit', sessionId: 'session-retry', referenceAssetIds: [], outputCount: 1,
    });
    expect(set).toHaveBeenCalledTimes(2);
    expect(ledger.records.get(submitted.providerTaskId)).toMatchObject({ state: 'running', rawTaskId: 'raw-task' });
    expect(calls).toHaveLength(1);
  });

  it('retries a 4D image after a pre-POST history reservation failure with the same job ID', async () => {
    const ledger = providerLedger();
    const history = durableHistorySink();
    let attempts = 0;
    const reserveSubmission = vi.fn(async (input: { jobId: string }) => {
      if (++attempts === 1) throw new Error('history index temporarily locked');
      return { created: true, historyId: deriveGenerationHistoryId(input.jobId), status: 'queued' as const, terminal: null };
    });
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
    const service = createNewApiProviderService({
      provider: '4dai', credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://api.4dai.cc/v1', [{
        provider: '4dai', modelRoute: '4dai-gpt-image-2', displayName: 'gpt-image-2', modelId: 'gpt-image-2',
        capabilities: ['image_generation'], capabilityStatus: 'complete',
      }]),
      providerTaskMappings: ledger.adapter, historySink: { ...history, reserveSubmission },
      fetch: sequenceFetch(calls, [jsonResponse({ data: [{ b64_json: Buffer.from(png).toString('base64') }] })]),
      storeGeneratedImage: async () => ({ assetId: '0123456789abcdef' }),
    });
    const request = { jobId: 'model-job-v2-prepost-history-4d', provider: '4dai' as const,
      modelRoute: '4dai-gpt-image-2', prompt: 'poster', sessionId: 'session-prepost-4d',
      referenceAssetIds: [] as string[], outputCount: 1 as const };
    await expect(service.submitImageJob(request)).rejects.toThrow('history index temporarily locked');
    expect(calls).toHaveLength(0);
    const submitted = await service.submitImageJob(request);
    await expect(service.submitImageJob(request)).resolves.toEqual(submitted);
    expect(calls).toHaveLength(1);
    await expect(service.pollImageJob({ provider: '4dai', providerTaskId: submitted.providerTaskId }))
      .resolves.toMatchObject({ status: 'completed' });
  });

  it('claims a queued Julun history after a pre-POST ledger write failure without duplicating POST', async () => {
    const ledger = providerLedger();
    const originalReserve = ledger.adapter.reserveSubmission.bind(ledger.adapter);
    vi.spyOn(ledger.adapter, 'reserveSubmission')
      .mockRejectedValueOnce(new Error('ledger temporarily locked'))
      .mockImplementation(originalReserve);
    let historyReservations = 0;
    const history = {
      ...durableHistorySink(),
      reserveSubmission: vi.fn(async (input: { jobId: string }) => ({
        created: ++historyReservations === 1, historyId: deriveGenerationHistoryId(input.jobId),
        status: 'queued' as const, terminal: null,
      })),
    };
    const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
    const service = createNewApiProviderService({
      provider: 'julun', credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://julun.cc/v1', [{
        provider: 'julun', modelRoute: 'julun-minimax-h3', displayName: 'minimax_h3', modelId: 'minimax_h3',
        capabilities: ['video_generation', 'async_tasks'], capabilityStatus: 'complete',
      }]),
      providerTaskMappings: ledger.adapter, historySink: history,
      fetch: sequenceFetch(calls, [jsonResponse({ id: 'one-paid-video', status: 'queued' })]),
    });
    const request = { jobId: 'model-job-v2-prepost-ledger-julun', provider: 'julun' as const,
      modelRoute: 'julun-minimax-h3', prompt: 'orbit', sessionId: 'session-prepost-julun',
      referenceAssetIds: [] as string[], outputCount: 1 as const };
    await expect(service.submitVideoJob(request)).rejects.toThrow('ledger temporarily locked');
    expect(calls).toHaveLength(0);
    const submitted = await service.submitVideoJob(request);
    await expect(service.submitVideoJob(request)).resolves.toEqual(submitted);
    expect(calls).toHaveLength(1);
    expect(history.reserveSubmission).toHaveBeenCalledTimes(2);
    expect(ledger.records.get(submitted.providerTaskId)).toMatchObject({ state: 'running', rawTaskId: 'one-paid-video' });
  });

  it('marks an accepted Julun task with an unavailable local mapping as uncertain without another paid POST', async () => {
    const ledger = providerLedger();
    const originalSet = ledger.adapter.set.bind(ledger.adapter);
    let failures = 3;
    vi.spyOn(ledger.adapter, 'set').mockImplementation(async (record) => {
      if (failures-- > 0) throw new Error('temporary mapping lock');
      return originalSet(record);
    });
    const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
    const service = createNewApiProviderService({
      provider: 'julun', credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://julun.cc/v1', [{
        provider: 'julun', modelRoute: 'julun-minimax-h3', displayName: 'minimax_h3', modelId: 'minimax_h3',
        capabilities: ['video_generation', 'async_tasks'], capabilityStatus: 'complete',
      }]),
      providerTaskMappings: ledger.adapter,
      fetch: sequenceFetch(calls, [jsonResponse({ id: 'raw-task', status: 'queued' })]),
    });
    const request = {
      jobId: 'model-job-v2-mapping-uncertain', provider: 'julun' as const, modelRoute: 'julun-minimax-h3',
      prompt: 'orbit', sessionId: 'session-retry', referenceAssetIds: [] as string[], outputCount: 1 as const,
    };
    await expect(service.submitVideoJob(request)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE', message: expect.stringContaining('提交状态不确定'),
    });
    const submitted = await service.submitVideoJob(request);
    expect(ledger.records.get(submitted.providerTaskId)).toMatchObject({ state: 'running', rawTaskId: 'raw-task' });
    expect(calls).toHaveLength(1);
  });

  it.each([
    [0, 'minimax_h3'], [3, 'minimax_h3'], [0, 'sd2.5'], [3, 'sd2.5'],
  ] as const)('restores an accepted Julun task before new-request gates after %i ledger failures and reclassification to %s', async (writeFailures, changedModelId) => {
    const ledger = providerLedger();
    const originalSet = ledger.adapter.set.bind(ledger.adapter);
    let remainingFailures = writeFailures;
    let originalPublicTaskId = '';
    vi.spyOn(ledger.adapter, 'set').mockImplementation(async record => {
      originalPublicTaskId ||= record.publicTaskId;
      if (remainingFailures-- > 0) throw new Error('temporary mapping lock');
      return originalSet(record);
    });
    const selected = {
      provider: 'julun' as const, modelRoute: 'julun-restoration-fixture', displayName: 'MiniMax H3', modelId: 'minimax_h3',
      capabilities: ['video_generation' as const, 'async_tasks' as const], capabilityStatus: 'complete' as const,
    };
    const configurationStore = memoryConfigurationStore('https://julun.cc/v1', [selected]);
    const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
    const getPrimaryToken = vi.fn(async () => 'fixture-token');
    const readReferenceImage = vi.fn(async () => { throw new Error('an existing task must not read new references'); });
    const binding = { projectId: 'project-restoration', rootFingerprint: 'a'.repeat(64) };
    const service = createNewApiProviderService({
      provider: 'julun', configurationStore, providerTaskMappings: ledger.adapter,
      credentialStore: { ...configuredCredentialStore(), getPrimaryToken },
      bindGenerationProject: async () => binding,
      fetch: sequenceFetch(calls, [jsonResponse({ id: 'one-accepted-task', status: 'queued' })]), readReferenceImage,
    });
    const request = {
      jobId: `model-job-v2-restoration-${writeFailures}-${changedModelId}`, provider: 'julun' as const,
      modelRoute: selected.modelRoute, projectId: binding.projectId, prompt: 'orbit', sessionId: 'session-restoration',
      referenceAssetIds: [] as string[],
    };
    if (writeFailures === 0) await service.submitVideoJob(request);
    else await expect(service.submitVideoJob(request)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(originalPublicTaskId).toMatch(/^provider-job-[a-f0-9]{32}$/u);
    await configurationStore.write({ baseUrl: 'https://julun.cc/v1', profiles: [{
      ...selected, modelId: changedModelId, capabilityStatus: 'incomplete', enabled: false,
      constraints: { video: { resolutions: ['4K'], duration: { mode: 'options', options: [999] } } },
    }] });
    await expect(service.submitVideoJob({ ...request, resolution: '4K', durationSeconds: 999,
      referenceAssetIds: ['0123456789abcdef'] })).resolves.toEqual({ providerTaskId: originalPublicTaskId });
    expect(calls).toHaveLength(1);
    expect(getPrimaryToken).toHaveBeenCalledTimes(1);
    expect(readReferenceImage).not.toHaveBeenCalled();
    expect(ledger.records.get(originalPublicTaskId)).toMatchObject({ kind: 'video', state: 'running', rawTaskId: 'one-accepted-task', projectBinding: binding });
  });

  it.each(['provider', 'history', 'kind', 'session', 'project'] as const)(
    'rejects an existing Julun mapping with mismatched %s identity without returning it or submitting', async mismatch => {
    const ledger = providerLedger();
    const jobId = `model-job-v2-existing-${mismatch}`;
    const historyId = deriveGenerationHistoryId(jobId);
    const existing: ProviderTaskMappingRecord = {
      provider: mismatch === 'provider' ? '4dai' : 'julun',
      historyId: mismatch === 'history' ? 'wrong-history' : historyId,
      kind: mismatch === 'kind' ? 'image' : 'video', sessionId: mismatch === 'session' ? 'other-session' : 'session-existing',
      publicTaskId: `provider-job-${'c'.repeat(32)}`, rawTaskId: 'already-accepted', state: 'running',
      createdAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-03T00:00:00.000Z',
      ...(mismatch === 'project' ? { projectBinding: { projectId: 'project-old', rootFingerprint: 'a'.repeat(64) } } : {}),
    };
    vi.spyOn(ledger.adapter, 'findByHistoryId').mockResolvedValue(existing);
    const reservation = vi.spyOn(ledger.adapter, 'reserveSubmission');
    const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
    const service = createNewApiProviderService({
      provider: 'julun', credentialStore: configuredCredentialStore(), providerTaskMappings: ledger.adapter,
      configurationStore: memoryConfigurationStore('https://julun.cc/v1', [{
        provider: 'julun', modelRoute: 'julun-minimax-h3', displayName: 'MiniMax', modelId: 'minimax_h3',
        capabilities: ['video_generation', 'async_tasks'], capabilityStatus: 'complete',
      }]),
      fetch: sequenceFetch(calls, []),
      ...(mismatch === 'project' ? { bindGenerationProject: async () => ({ projectId: 'project-new', rootFingerprint: 'b'.repeat(64) }) } : {}),
    });
    await expect(service.submitVideoJob({
      provider: 'julun', jobId, modelRoute: 'julun-minimax-h3', prompt: 'orbit', sessionId: 'session-existing', referenceAssetIds: [],
    })).rejects.toMatchObject({ code: mismatch === 'session' || mismatch === 'project' ? 'INVALID_REQUEST' : 'PROVIDER_INVALID_RESPONSE' });
    expect(calls).toEqual([]);
    expect(reservation).not.toHaveBeenCalled();
  });

  it('rejects an image mapping that appears during the video pre-POST lookup race', async () => {
    const ledger = providerLedger();
    const jobId = 'model-job-v2-kind-race';
    vi.spyOn(ledger.adapter, 'findByHistoryId').mockResolvedValueOnce(undefined).mockResolvedValue({
      provider: 'julun', historyId: deriveGenerationHistoryId(jobId), kind: 'image', sessionId: 'session-race',
      publicTaskId: `provider-job-${'d'.repeat(32)}`, rawTaskId: 'image-task', state: 'running',
      createdAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-03T00:00:00.000Z',
    });
    const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
    const service = createNewApiProviderService({
      provider: 'julun', credentialStore: configuredCredentialStore(), providerTaskMappings: ledger.adapter,
      configurationStore: memoryConfigurationStore('https://julun.cc/v1', [{
        provider: 'julun', modelRoute: 'julun-minimax-h3', displayName: 'MiniMax', modelId: 'minimax_h3',
        capabilities: ['video_generation', 'async_tasks'], capabilityStatus: 'complete',
      }]), fetch: sequenceFetch(calls, []),
    });
    await expect(service.submitVideoJob({ provider: 'julun', jobId, modelRoute: 'julun-minimax-h3', prompt: 'orbit',
      sessionId: 'session-race', referenceAssetIds: [] })).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
    expect(calls).toEqual([]);
  });

  it('recovers accepted inline bytes in the same process after three temporary staging failures', async () => {
    const appDataRoot = await mkdtemp(join(tmpdir(), 'newapi-stage-retry-'));
    try {
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const fileSystem = new NodeFileSystem();
      const originalOpen = fileSystem.open.bind(fileSystem);
      let failures = 3;
      vi.spyOn(fileSystem, 'open').mockImplementation(async (path, flags) => {
        if (path.includes('newapi-pending-') && failures-- > 0) throw new Error('temporary disk lock');
        return originalOpen(path, flags);
      });
      const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
      const ledger = providerLedger();
      const service = createNewApiProviderService({
        provider: '4dai', appDataRoot, fileSystem, credentialStore: configuredCredentialStore(),
        configurationStore: memoryConfigurationStore('https://api.4dai.cc/v1', [{
          provider: '4dai', modelRoute: '4dai-gpt-image-2', displayName: 'gpt-image-2', modelId: 'gpt-image-2',
          capabilities: ['image_generation'], capabilityStatus: 'complete',
        }]),
        providerTaskMappings: ledger.adapter,
        bindGenerationProject: async () => ({ projectId: 'project-a', rootFingerprint: 'a'.repeat(64) }),
        storeGeneratedImageForProject: async () => ({ assetId: 'fedcba9876543210' }),
        fetch: sequenceFetch(calls, [jsonResponse({ data: [{ b64_json: Buffer.from(png).toString('base64') }] })]),
      });
      const request = {
        jobId: 'model-job-v2-stage-retry', projectId: 'project-a', provider: '4dai' as const,
        modelRoute: '4dai-gpt-image-2', prompt: 'poster', sessionId: 'session-a',
        referenceAssetIds: [] as string[], outputCount: 1 as const,
      };
      await expect(service.submitImageJob(request)).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE', message: expect.stringContaining('提交状态不确定'),
      });
      const submitted = await service.submitImageJob(request);
      await expect(service.pollImageJob({ provider: '4dai', providerTaskId: submitted.providerTaskId }))
        .resolves.toMatchObject({ status: 'completed' });
      expect(calls).toHaveLength(1);
    } finally {
      await rm(appDataRoot, { recursive: true, force: true });
    }
  });

  it('does not resurrect a cancelled 4D task when a deferred project write finishes', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ledger = providerLedger();
    let beginStore!: () => void;
    let resolveStore!: (value: { assetId: string }) => void;
    const storing = new Promise<void>((resolve) => { beginStore = resolve; });
    const storeGeneratedImageForProject = vi.fn(async () => {
      beginStore();
      return new Promise<{ assetId: string }>((resolve) => { resolveStore = resolve; });
    });
    const service = createNewApiProviderService({
      provider: '4dai', credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://api.4dai.cc/v1', [{
        provider: '4dai', modelRoute: '4dai-gpt-image-2', displayName: 'gpt-image-2', modelId: 'gpt-image-2',
        capabilities: ['image_generation'], capabilityStatus: 'complete',
      }]),
      providerTaskMappings: ledger.adapter,
      bindGenerationProject: async () => ({ projectId: 'project-a', rootFingerprint: 'a'.repeat(64) }),
      storeGeneratedImageForProject,
      resolveResultHost: async () => ['93.184.216.34'],
      fetch: sequenceFetch([], [
        jsonResponse({ data: [{ url: 'https://cdn.example.test/deferred.png' }] }), binaryResponse(png),
      ]),
    });
    const submitted = await service.submitImageJob({
      jobId: 'model-job-v2-cancel-race', projectId: 'project-a', provider: '4dai',
      modelRoute: '4dai-gpt-image-2', prompt: 'poster', sessionId: 'session-a', referenceAssetIds: [], outputCount: 1,
    });
    const polling = service.pollImageJob({ provider: '4dai', providerTaskId: submitted.providerTaskId });
    await storing;
    await expect(service.cancelImageJob({ provider: '4dai', providerTaskId: submitted.providerTaskId }))
      .resolves.toEqual({ status: 'cancelled' });
    resolveStore({ assetId: 'fedcba9876543210' });
    await expect(polling).resolves.toEqual({ status: 'cancelled' });
    expect(ledger.records.get(submitted.providerTaskId)).toMatchObject({ state: 'cancelled' });
  });

  it('does not recreate an acknowledged 4D task when an older result download finishes', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ledger = providerLedger();
    let beginDownload!: () => void;
    let resolveDownload!: (response: ComflyFetchResponse) => void;
    const downloading = new Promise<void>((resolve) => { beginDownload = resolve; });
    let calls = 0;
    const fetch: NewApiFetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ data: [{ url: 'https://cdn.example.test/late.png' }] });
      beginDownload();
      return new Promise<ComflyFetchResponse>((resolve) => { resolveDownload = resolve; });
    });
    const storeGeneratedImageForProject = vi.fn(async () => ({ assetId: 'fedcba9876543210' }));
    const service = createNewApiProviderService({
      provider: '4dai', credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://api.4dai.cc/v1', [{
        provider: '4dai', modelRoute: '4dai-gpt-image-2', displayName: 'gpt-image-2', modelId: 'gpt-image-2',
        capabilities: ['image_generation'], capabilityStatus: 'complete',
      }]),
      providerTaskMappings: ledger.adapter,
      bindGenerationProject: async () => ({ projectId: 'project-a', rootFingerprint: 'a'.repeat(64) }),
      storeGeneratedImageForProject, resolveResultHost: async () => ['93.184.216.34'], fetch,
    });
    const submitted = await service.submitImageJob({
      jobId: 'model-job-v2-ack-race', projectId: 'project-a', provider: '4dai',
      modelRoute: '4dai-gpt-image-2', prompt: 'poster', sessionId: 'session-a', referenceAssetIds: [], outputCount: 1,
    });
    const polling = service.pollImageJob({ provider: '4dai', providerTaskId: submitted.providerTaskId });
    await downloading;
    await service.cancelImageJob({ provider: '4dai', providerTaskId: submitted.providerTaskId });
    await service.ackImageJobTerminal({ provider: '4dai', providerTaskId: submitted.providerTaskId });
    resolveDownload(binaryResponse(png));
    await expect(polling).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(ledger.records.has(submitted.providerTaskId)).toBe(false);
    expect(storeGeneratedImageForProject).not.toHaveBeenCalled();
  });

  it('keeps a completed video remote when content download fails transiently, then retries', async () => {
    const mp4 = Uint8Array.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70]);
    const service = createNewApiProviderService({
      provider: 'julun', credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://julun.cc/v1', [{
        provider: 'julun', modelRoute: 'julun-minimax-h3', displayName: 'minimax_h3', modelId: 'minimax_h3',
        capabilities: ['video_generation', 'async_tasks'], capabilityStatus: 'complete',
      }]),
      fetch: sequenceFetch([], [
        jsonResponse({ id: 'raw-task', status: 'queued' }),
        jsonResponse({ id: 'raw-task', status: 'completed' }),
        { ok: false, status: 503, json: async () => ({}) },
        jsonResponse({ id: 'raw-task', status: 'completed' }),
        binaryResponse(mp4),
      ]),
      storeGeneratedVideo: async () => ({ assetId: '0123456789abcdef' }),
    });
    const submitted = await service.submitVideoJob({
      provider: 'julun', modelRoute: 'julun-minimax-h3', prompt: 'orbit', sessionId: 'session-retry', referenceAssetIds: [], outputCount: 1,
    });

    await expect(service.pollVideoJob({ provider: 'julun', providerTaskId: submitted.providerTaskId }))
      .rejects.toMatchObject({ code: 'PROVIDER_ERROR', retryable: true });
    await expect(service.pollVideoJob({ provider: 'julun', providerTaskId: submitted.providerTaskId }))
      .resolves.toMatchObject({ status: 'completed' });
  });

  it('fails closed for cross-capability calls', async () => {
    const julun = createNewApiProviderService({
      provider: 'julun', credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://julun.cc/v1'), fetch: sequenceFetch([], []),
    });
    const fourD = createNewApiProviderService({
      provider: '4dai', credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://api.4dai.cc/v1'), fetch: sequenceFetch([], []),
    });
    await expect(julun.submitImageJob({ provider: 'julun' } as never)).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    await expect(fourD.submitVideoJob({ provider: '4dai' } as never)).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
  });

  it('uses the deep reverse budget for 4D Agent visual analysis and keeps ordinary chat defaults', async () => {
    const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
    const fetch = sequenceFetch(calls, [
      jsonResponse({ object: 'list', data: [{ id: 'gpt-6-astra' }] }),
      jsonResponse({ success: true, data: [{
        model_name: 'gpt-6-astra', supported_endpoint_types: ['openai'], image_ratio: 0.5,
      }] }),
      jsonResponse({ choices: [{ message: { role: 'assistant', content: 'bright red package' } }] }),
      jsonResponse({ choices: [{ message: { role: 'assistant', content: 'ordinary reply' } }] }),
    ]);
    const service = createNewApiProviderService({
      provider: '4dai', credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://api.4dai.cc/v1'), fetch,
      readReferenceImage: async () => ({
        bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), mediaType: 'image/png',
      }),
    });
    await service.refreshCatalog();

    await expect(service.chat({
      provider: '4dai', modelRoute: '4dai-gpt-6-astra', sessionId: 'session-3',
      referenceAssetIds: ['0123456789abcdef'],
      referenceMentions: [{ assetId: '0123456789abcdef', label: '产品图', mention: '@图片1' }],
      visualAnalysis: true,
      reverseAnalysisDepth: 'deep',
      messages: [{ role: 'user', content: 'describe the image' }],
      context: { knowledgeBaseIds: [], projectMemoryIds: [] },
    })).resolves.toEqual({ message: 'bright red package', modelRoute: '4dai-gpt-6-astra', sources: [] });
    await expect(service.chat({
      provider: '4dai', modelRoute: '4dai-gpt-6-astra',
      messages: [{ role: 'user', content: 'ordinary question' }],
      context: { knowledgeBaseIds: [], projectMemoryIds: [] },
    })).resolves.toEqual({ message: 'ordinary reply', modelRoute: '4dai-gpt-6-astra', sources: [] });

    const chatCalls = calls.filter((call) => call.url.endsWith('/chat/completions'));
    const deepPayload = JSON.parse(chatCalls[0]!.init!.body as string) as { max_tokens?: number; messages: unknown[] };
    expect(JSON.stringify(deepPayload.messages)).toContain('data:image/png;base64,iVBORw==');
    expect(deepPayload.max_tokens).toBe(16_384);
    expect(chatCalls[0]!.init!.timeoutMs).toBe(600_000);
    const ordinaryPayload = JSON.parse(chatCalls[1]!.init!.body as string) as { max_tokens?: number };
    expect(ordinaryPayload.max_tokens).toBeUndefined();
    expect(chatCalls[1]!.init!.timeoutMs).toBe(180_000);
  });

  it('rejects a remote image on localhost before DNS resolution or asset storage', async () => {
    const resolveResultHost = vi.fn(async () => ['127.0.0.1']);
    const storeGeneratedImage = vi.fn(async () => ({ assetId: 'fedcba9876543210' }));
    const configurationStore = memoryConfigurationStore('https://api.4dai.cc/v1', [{
      provider: '4dai', modelRoute: '4dai-gpt-image-1-5', displayName: 'GPT Image 1.5',
      modelId: 'gpt-image-1.5', capabilities: ['image_generation'], capabilityStatus: 'complete',
    }]);
    const service = createNewApiProviderService({
      provider: '4dai', credentialStore: configuredCredentialStore(), configurationStore,
      fetch: sequenceFetch([], [jsonResponse({ data: [{ url: 'https://localhost/private.png' }] })]),
      resolveResultHost,
      storeGeneratedImage,
    });

    const submitted = await service.submitImageJob({
      provider: '4dai', modelRoute: '4dai-gpt-image-1-5', prompt: 'poster', sessionId: 'session-4',
      referenceAssetIds: [], outputCount: 1,
    });
    await expect(service.pollImageJob({ provider: '4dai', providerTaskId: submitted.providerTaskId }))
      .resolves.toMatchObject({ status: 'failed', error: { code: 'PROVIDER_INVALID_RESPONSE', retryable: false } });
    expect(resolveResultHost).not.toHaveBeenCalled();
    expect(storeGeneratedImage).not.toHaveBeenCalled();
  });

  it('delegates credential configuration/unlock and never returns a token except through revealCredential', async () => {
    const credentials = configuredCredentialStore();
    const service = createNewApiProviderService({
      provider: '4dai', credentialStore: credentials,
      configurationStore: memoryConfigurationStore('https://api.4dai.cc/v1'), fetch: sequenceFetch([], []),
    });

    await expect(service.configure({ provider: '4dai', token: 'replacement-token' }))
      .resolves.toEqual({ configured: true, locked: false, encryption: 'safeStorage', baseUrl: 'https://api.4dai.cc/v1' });
    await expect(service.unlock({ provider: '4dai', passphrase: 'passphrase' }))
      .resolves.toEqual({ configured: true, locked: false, encryption: 'safeStorage', baseUrl: 'https://api.4dai.cc/v1' });
    await expect(service.revealCredential()).resolves.toEqual({ token: 'credential-secret' });
    expect(credentials.configure).toHaveBeenCalledWith({ token: 'replacement-token' });
    expect(credentials.unlock).toHaveBeenCalledWith({ passphrase: 'passphrase' });
  });

  it('persists only verified same-provider routes selected in the settings catalog', async () => {
    const complete: NewApiModelProfile = {
      provider: '4dai',
      modelRoute: '4dai-gpt-image-1-5',
      displayName: 'GPT Image 1.5',
      modelId: 'gpt-image-1.5',
      capabilities: ['image_generation'],
      capabilityStatus: 'complete',
    };
    const pending: NewApiModelProfile = {
      provider: '4dai',
      modelRoute: '4dai-unverified-image',
      displayName: 'Unverified image',
      modelId: 'unverified-image',
      capabilities: ['image_generation'],
      capabilityStatus: 'incomplete',
    };
    const configurationStore = memoryConfigurationStore('https://api.4dai.cc/v1', [complete, pending]);
    const service = createNewApiProviderService({
      provider: '4dai',
      credentialStore: configuredCredentialStore(),
      configurationStore,
      fetch: sequenceFetch([], []),
    });

    await expect(service.updateProfiles!({ provider: '4dai', profiles: [pending] }))
      .rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    await expect(service.updateProfiles!({ provider: '4dai', profiles: [complete] }))
      .resolves.toEqual({ configured: true, locked: false, encryption: 'safeStorage', baseUrl: 'https://api.4dai.cc/v1' });
    await expect(service.listProfiles()).resolves.toEqual([complete]);
  });

  it('saves and executes the exact model selected when two New API model ids normalize to the same legacy slug', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
    const service = createNewApiProviderService({
      provider: '4dai',
      credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://api.4dai.cc/v1'),
      fetch: sequenceFetch(calls, [
        jsonResponse({ data: [{ id: 'foo.bar' }, { id: 'foo-bar' }] }),
        jsonResponse({ data: [
          { model_name: 'foo.bar', supported_endpoint_types: ['image-generation'] },
          { model_name: 'foo-bar', supported_endpoint_types: ['image-generation'] },
        ] }),
        jsonResponse({ data: [{ b64_json: Buffer.from(png).toString('base64') }] }),
      ]),
      storeGeneratedImage: async () => ({ assetId: 'fedcba9876543213' }),
    });
    const profiles = await service.refreshCatalog();
    const selected = profiles.find((profile) => profile.modelId === 'foo.bar')!;

    expect(new Set(profiles.map((profile) => profile.modelRoute)).size).toBe(2);
    await service.updateProfiles({ provider: '4dai', profiles: [selected] });
    await service.submitImageJob({
      provider: '4dai', modelRoute: selected.modelRoute, prompt: 'exact route', sessionId: 'session-collision',
      referenceAssetIds: [], outputCount: 1,
    });

    expect(JSON.parse(calls[2]!.init!.body as string)).toMatchObject({
      model: 'foo.bar', size: '1024x1024', n: 1,
    });
    await expect(service.listProfiles()).resolves.toEqual([
      expect.objectContaining({ modelId: 'foo.bar', modelRoute: selected.modelRoute, enabled: true }),
      expect.objectContaining({ modelId: 'foo-bar', enabled: false }),
    ]);
  });

  it('rejects non-square or above-1K requests for an unknown verified 4D image model before submission', async () => {
    const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
    const service = createNewApiProviderService({
      provider: '4dai', credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://api.4dai.cc/v1', [{
        provider: '4dai', modelRoute: '4dai-vendor-image-v7', displayName: 'vendor-image-v7', modelId: 'vendor-image-v7',
        capabilities: ['image_generation'], capabilityStatus: 'complete',
      }]),
      fetch: sequenceFetch(calls, []),
      storeGeneratedImage: async () => ({ assetId: 'fedcba9876543214' }),
    });

    await expect(service.submitImageJob({
      provider: '4dai', modelRoute: '4dai-vendor-image-v7', prompt: 'unsupported size', sessionId: 'session-unknown-size',
      aspectRatio: '16:9', resolution: '2K', referenceAssetIds: [], outputCount: 1,
    })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED', retryable: false });
    expect(calls).toHaveLength(0);
  });

  it('shows authenticated openai-only image candidates but never saves or executes them', async () => {
    const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
    const service = createNewApiProviderService({
      provider: '4dai', credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://api.4dai.cc/v1'),
      fetch: sequenceFetch(calls, [
        jsonResponse({ data: [{ id: 'gpt-image-2' }] }),
        jsonResponse({ data: [{ model_name: 'gpt-image-2', supported_endpoint_types: ['openai'] }] }),
      ]),
      storeGeneratedImage: async () => ({ assetId: 'fedcba9876543210' }),
    });
    const [candidate] = await service.refreshCatalog();

    expect(candidate).toMatchObject({ modelId: 'gpt-image-2', capabilities: ['image_generation'], capabilityStatus: 'incomplete' });
    await expect(service.updateProfiles!({ provider: '4dai', profiles: [candidate!] }))
      .rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    await expect(service.submitImageJob({
      provider: '4dai', modelRoute: '4dai-gpt-image-2', prompt: 'poster', sessionId: 'session-candidate',
      referenceAssetIds: [], outputCount: 1,
    })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(calls).toHaveLength(2);
  });

  it('preserves a disabled 4D route when the remote catalog is refreshed', async () => {
    const selected: NewApiModelProfile = {
      provider: '4dai', modelRoute: '4dai-gpt-image-1-5', displayName: 'gpt-image-1.5', modelId: 'gpt-image-1.5',
      capabilities: ['image_generation'], capabilityStatus: 'complete',
    };
    const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
    const service = createNewApiProviderService({
      provider: '4dai',
      credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://api.4dai.cc/v1', [selected]),
      fetch: sequenceFetch(calls, [
        jsonResponse({ object: 'list', data: [{ id: 'gpt-image-1.5' }, { id: 'gpt-image-2' }] }),
        jsonResponse({ success: true, data: [
          { model_name: 'gpt-image-1.5', supported_endpoint_types: ['image-generation'] },
          { model_name: 'gpt-image-2', supported_endpoint_types: ['image-generation'] },
        ] }),
      ]),
    });

    await service.refreshCatalog();
    await expect(service.listProfiles()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ modelRoute: '4dai-gpt-image-1-5', enabled: true }),
      expect.objectContaining({ modelRoute: '4dai-gpt-image-2', enabled: false }),
    ]));
    await expect(service.submitImageJob({
      jobId: 'model-job-v2-disabled-route', provider: '4dai', modelRoute: '4dai-gpt-image-2', prompt: 'poster',
      sessionId: 'session-disabled', referenceAssetIds: [], outputCount: 1,
    })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(calls).toHaveLength(2);
  });

  it('runs 4D reverse prompting only through a verified vision profile and managed image bytes', async () => {
    const imageAssetId = 'b'.repeat(16);
    const references = [{ assetId: imageAssetId, label: 'Product', position: 0, role: 'product_identity' as const }];
    const run = createReversePromptRun({
      projectId: 'project-1', skill: { id: 'reverse-prompt', version: 'v1' },
      agentConfig: {
        modelRoute: '4dai-gpt-6-astra',
        role: 'Analyst',
        task: 'Analyze.',
        analysisDepth: 'deep',
        knowledgeBaseIds: [],
      },
      knowledgeLease: createAgentKnowledgeLease({
        runId: 'reverse-run-4d', capability: 'reverse_prompt', snapshots: [], references, citations: [],
      }, { leaseId: 'lease-4d', createdAt: '2026-09-09T00:00:00.000Z' }),
      approvedMemorySnapshot: { version: 'approved-1', approvedAt: '2026-09-09T00:00:00.000Z', approvedMemoryIds: [] },
      references,
    }, { createNonce: () => 'nonce-4d', now: () => '2026-09-09T00:00:00.000Z' });
    const providerResult = {
      sessionId: run.sessionId, nonce: run.nonce, knowledgeSnapshotVersion: run.knowledgeLease.versionKey,
      analysis: 'Centered product.', keywords: ['product'], positivePrompt: 'Centered product.',
      negativeConstraints: ['No distortion.'], executionChecklist: ['Check silhouette.'],
    };
    const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
    const service = createNewApiProviderService({
      provider: '4dai', credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://api.4dai.cc/v1'),
      fetch: sequenceFetch(calls, [
        jsonResponse({ data: [{ id: 'gpt-6-astra' }] }),
        jsonResponse({ data: [{ model_name: 'gpt-6-astra', supported_endpoint_types: ['openai'], image_ratio: 0.5 }] }),
        jsonResponse({ choices: [{ message: { content: JSON.stringify(providerResult) } }] }),
      ]),
      readManagedReverseMedia: async () => [{ bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), mediaType: 'image/png' }],
    });
    await service.refreshCatalog();

    await expect(service.analyzeReversePrompt?.({
      sessionId: 'desktop-session-1', provider: '4dai', run,
      media: [{ kind: 'image', assetId: imageAssetId, sha256: 'b'.repeat(64), byteSize: 4, mediaType: 'image/png' }],
    })).resolves.toMatchObject(providerResult);
    expect(calls[calls.length - 1]!.url).toBe('https://api.4dai.cc/v1/chat/completions');
    expect(calls[calls.length - 1]!.init!.body).toContain('data:image/png;base64,iVBORw==');
    expect(calls[calls.length - 1]!.init!.timeoutMs).toBe(600_000);
    expect(JSON.parse(String(calls[calls.length - 1]!.init!.body))).toMatchObject({
      max_tokens: 16_384,
    });
  });

  it('requires the explicit reverse_prompt capability for 4D reverse analysis', async () => {
    const service = createNewApiProviderService({
      provider: '4dai', credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://api.4dai.cc/v1', [{
        provider: '4dai', modelRoute: '4dai-vision-only', displayName: 'vision-only', modelId: 'vision-only',
        capabilities: ['vision'], capabilityStatus: 'complete',
      }]),
      fetch: sequenceFetch([], []),
    });

    await expect(service.analyzeReversePrompt({
      provider: '4dai', run: { agentConfig: { modelRoute: '4dai-vision-only' }, orderedMedia: [] },
    } as never)).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
  });

  it('rejects a response-only 4D reverse profile before reading media or calling chat completions', async () => {
    const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
    const readManagedReverseMedia = vi.fn(async () => []);
    const imageAssetId = 'c'.repeat(16);
    const references = [{ assetId: imageAssetId, label: 'Product', position: 0, role: 'product_identity' as const }];
    const run = createReversePromptRun({
      projectId: 'project-response-only', skill: { id: 'reverse-prompt', version: 'v1' },
      agentConfig: { modelRoute: '4dai-responses-vision', role: 'Analyst', task: 'Analyze.', knowledgeBaseIds: [] },
      knowledgeLease: createAgentKnowledgeLease({
        runId: 'reverse-run-response-only', capability: 'reverse_prompt', snapshots: [], references, citations: [],
      }, { leaseId: 'lease-response-only', createdAt: '2026-09-09T00:00:00.000Z' }),
      approvedMemorySnapshot: { version: 'approved-response-only', approvedAt: '2026-09-09T00:00:00.000Z', approvedMemoryIds: [] },
      references,
    }, { createNonce: () => 'nonce-response-only', now: () => '2026-09-09T00:00:00.000Z' });
    const service = createNewApiProviderService({
      provider: '4dai', credentialStore: configuredCredentialStore(),
      configurationStore: memoryConfigurationStore('https://api.4dai.cc/v1', [{
        provider: '4dai', modelRoute: '4dai-responses-vision', displayName: 'Responses Vision', modelId: 'responses-vision',
        capabilities: ['responses', 'vision', 'reverse_prompt'], capabilityStatus: 'complete',
      }]),
      fetch: sequenceFetch(calls, []),
      readManagedReverseMedia,
    });

    await expect(service.analyzeReversePrompt({
      sessionId: 'desktop-session-response-only', provider: '4dai', run,
      media: [{ kind: 'image', assetId: imageAssetId, sha256: 'c'.repeat(64), byteSize: 4, mediaType: 'image/png' }],
    })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(readManagedReverseMedia).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});

function configuredCredentialStore() {
  return {
    configure: vi.fn(async () => undefined),
    unlock: vi.fn(async () => undefined),
    getStatus: async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const }),
    getPrimaryToken: async () => 'credential-secret',
  };
}

function memoryConfigurationStore(baseUrl: string, profiles: readonly NewApiModelProfile[] = []): NewApiServiceConfigurationStore {
  let snapshot: { baseUrl: string; profiles: ProviderBridgeProfile[] } = {
    baseUrl,
    profiles: profiles.map((profile) => ({ ...profile, capabilities: [...profile.capabilities] })),
  };
  return {
    read: async () => snapshot,
    write: async (next) => { snapshot = { baseUrl: next.baseUrl, profiles: [...next.profiles] }; },
  };
}

function sequenceFetch(
  calls: Array<{ url: string; init?: NewApiFetchInit }>,
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

function binaryResponse(bytes: Uint8Array): ComflyFetchResponse {
  return {
    ok: true,
    status: 200,
    json: async () => null,
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  };
}

function historySink() {
  const events: string[] = [];
  return {
    events,
    adapter: {
      reserveSubmission: async (input: { kind?: 'image' | 'video'; provider?: string; modelDisplayName: string }) => {
        events.push(`reserve:${input.kind}:${input.provider}:${input.modelDisplayName}`);
        return { created: true, historyId: 'history-1', status: 'queued' as const, terminal: null };
      },
      queued: async () => 'history-1',
      running: async () => { events.push('running'); },
      getTerminal: async () => null,
      failed: async () => ({ status: 'failed' as const }),
      cancelled: async () => ({ status: 'cancelled' as const }),
      succeeded: async (_id: string, bytes: Uint8Array) => {
        events.push(`succeeded:${bytes[0] === 0x89 ? 'image/png' : 'video/mp4'}`);
        return { status: 'succeeded' as const, width: 1, height: 1 };
      },
    },
  };
}

function providerLedger() {
  const records = new Map<string, ProviderTaskMappingRecord>();
  const reservations = new Set<string>();
  const adapter: ProviderTaskMappingStore = {
    updateRunning: async (id, update, now) => {
      const record = records.get(id);
      if (record === undefined || record.state !== 'running'
        || (update.expectedRawTaskId !== undefined && record.rawTaskId !== update.expectedRawTaskId)) return record;
      const next = { ...record, updatedAt: now, rawTaskId: update.rawTaskId ?? record.rawTaskId,
        result: record.result ?? update.result };
      records.set(id, next);
      return next;
    },
    attachStoredImageResult: async (id, result, now) => {
      const record = records.get(id);
      if (record === undefined || record.state !== 'running' || record.result !== undefined) return record;
      const updated = { ...record, result, updatedAt: now };
      records.set(id, updated);
      return updated;
    },
    get: async (id) => records.get(id),
    set: async (record) => { records.set(record.publicTaskId, record); },
    setIfAbsent: async (record) => {
      const existing = records.get(record.publicTaskId);
      if (existing !== undefined) return existing;
      records.set(record.publicTaskId, record);
      return record;
    },
    ackTerminal: async (id) => { records.delete(id); },
    findByHistoryId: async (id) => [...records.values()].find((record) => record.historyId === id),
    gcTerminalTombstones: async () => undefined,
    markCancelled: async (id, now) => {
      const record = records.get(id);
      if (record === undefined) return undefined;
      const next = { ...record, state: 'cancelled' as const, updatedAt: now, terminalAt: now };
      records.set(id, next);
      return next;
    },
    markTerminal: async (id, result, now) => {
      const record = records.get(id);
      if (record === undefined) return undefined;
      const next = result.status === 'completed'
        ? { ...record, state: 'completed' as const, result: result.result, updatedAt: now, terminalAt: now }
        : { ...record, state: 'failed' as const, error: result.error, updatedAt: now, terminalAt: now };
      records.set(id, next);
      return next;
    },
    reserveSubmission: async ({ historyId }) => {
      if (reservations.has(historyId)) return false;
      reservations.add(historyId);
      return true;
    },
  };
  return { adapter, records, reservations };
}

function durableHistorySink() {
  return {
    reserveSubmission: async (input: { jobId: string }) => ({
      created: true, historyId: deriveGenerationHistoryId(input.jobId), status: 'queued' as const, terminal: null,
    }),
    queued: async (input: { jobId: string }) => deriveGenerationHistoryId(input.jobId),
    running: async () => undefined,
    getTerminal: async () => null,
    failed: async () => ({ status: 'failed' as const }),
    cancelled: async () => ({ status: 'cancelled' as const }),
    succeeded: async () => ({ status: 'succeeded' as const, width: 1, height: 1 }),
  };
}
