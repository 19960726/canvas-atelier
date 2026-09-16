import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createComflyProviderService,
  createSecureProviderCredentialStore,
  type ProviderBridgeProfile,
  type SafeStorageAdapter,
} from './provider-bridge.js';
import { supportsVerifiedComflyVideoInputMode } from './comfly-video-jobs.js';

const roots: string[] = [];

describe('Comfly capability regressions', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it.each([
    ['Wan text-to-video accepts no images', 'wan2.2-t2v-plus', 0, true],
    ['Wan text-to-video rejects one image', 'wan2.2-t2v-plus', 1, false],
    ['Wan image-to-video accepts exactly one image', 'wan2.2-i2v-plus', 1, true],
    ['Wan image-to-video rejects no image', 'wan2.2-i2v-plus', 0, false],
    ['Wan image-to-video rejects two images', 'wan2.2-i2v-plus', 2, false],
    ['Wan keyframe video accepts exactly two images', 'wanx2.1-kf2v-plus', 2, true],
    ['Wan keyframe video rejects one image', 'wanx2.1-kf2v-plus', 1, false],
    ['Veo text-only rejects one image', 'veo3-fast', 1, false],
    ['Veo single-frame accepts one image', 'veo3-pro-frames', 1, true],
    ['Veo single-frame rejects two images', 'veo3-pro-frames', 2, false],
    ['Veo two-frame accepts two images', 'veo2-fast-frames', 2, true],
    ['Veo two-frame rejects three images', 'veo2-fast-frames', 3, false],
  ] as const)('%s in the shared video-input predicate', (_label, modelId, referenceCount, expected) => {
    expect(supportsVerifiedComflyVideoInputMode(modelId, referenceCount)).toBe(expected);
  });

  it('keeps Nano Banana reference generation on the documented synchronous generations route', async () => {
    const appDataRoot = await makeTempRoot();
    const fetch = vi.fn(async (_url: string, _init?: { readonly body?: string | Uint8Array }) => jsonResponse({
      data: [{ b64_json: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64') }],
    }));
    const storeGeneratedImage = vi.fn(async () => ({ assetId: '1'.repeat(16), width: 1, height: 1 }));
    const service = await configuredService({
      appDataRoot,
      fetch,
      profiles: [profile('nano-banana-2-2k', ['image_generation', 'image_edit'])],
      readManagedGenerationImages: async () => [
        { bytes: Uint8Array.from([1, 2, 3]), mediaType: 'image/png' as const },
        { bytes: Uint8Array.from([4, 5, 6]), mediaType: 'image/jpeg' as const },
      ],
      storeGeneratedImage,
    });

    await service.submitImageJob({
      jobId: 'model-job-v2-comfly-nano-sync',
      provider: 'comfly',
      modelRoute: 'nano-banana-2-2k',
      prompt: 'Replace the product.',
      conversationId: 'conversation-nano-sync',
      sessionId: 'desktop-session-nano-sync',
      referenceAssetIds: ['a'.repeat(16), 'b'.repeat(16)],
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe('https://ai.comfly.org/v1/images/generations');
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body.image).toEqual([
      'data:image/png;base64,AQID',
      'data:image/jpeg;base64,BAUG',
    ]);
    expect(body).not.toHaveProperty('async');
    expect(storeGeneratedImage).toHaveBeenCalledOnce();
  });

  it('routes Flux Pro image generation through Comfly edits transport', async () => {
    const appDataRoot = await makeTempRoot();
    const fetch = vi.fn(async (_url: string, _init?: { readonly body?: string | Uint8Array }) => jsonResponse({
      created: 1721121600,
      data: [{ b64_json: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64') }],
    }));
    const storeGeneratedImage = vi.fn(async () => ({ assetId: '2'.repeat(16), width: 1, height: 1 }));
    const service = await configuredService({
      appDataRoot,
      fetch,
      profiles: [profile('flux-pro-1.1-ultra', ['image_generation', 'image_edit'])],
      storeGeneratedImage,
    });

    await service.submitImageJob({
      jobId: 'model-job-v2-comfly-flux-edit-transport',
      provider: 'comfly',
      modelRoute: 'flux-pro-1.1-ultra',
      prompt: 'Generate a clean product image.',
      conversationId: 'conversation-flux-edit-transport',
      referenceAssetIds: [],
      aspectRatio: '16:9',
      resolution: '2K',
      outputCount: 1,
    });

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe('https://ai.comfly.org/v1/images/edits');
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'flux-pro-1.1-ultra',
      prompt: 'Generate a clean product image.',
      aspect_ratio: '16:9',
      size: '2K',
      n: 1,
    });
    expect(storeGeneratedImage).toHaveBeenCalledOnce();
  });

  it('submits managed reference images with Seedance-native parameter names', async () => {
    const appDataRoot = await makeTempRoot();
    const fetch = vi.fn(async (_url: string, _init?: { readonly body?: string | Uint8Array }) => jsonResponse({ task_id: 'seedance-task-1' }));
    const readManagedGenerationImages = vi.fn(async () => [
      { bytes: Uint8Array.from([1, 2, 3]), mediaType: 'image/png' as const },
      { bytes: Uint8Array.from([4, 5, 6]), mediaType: 'image/jpeg' as const },
    ]);
    const service = await configuredService({
      appDataRoot,
      fetch,
      profiles: [profile('doubao-seedance-2.5', ['video_generation', 'async_tasks'])],
      readManagedGenerationImages,
    });

    await service.submitVideoJob!({
      jobId: 'model-job-v2-comfly-seedance-i2v',
      provider: 'comfly',
      modelRoute: 'doubao-seedance-2.5',
      prompt: 'Animate the product naturally.',
      conversationId: 'conversation-seedance-i2v',
      sessionId: 'desktop-session-seedance-i2v',
      referenceAssetIds: ['a'.repeat(16), 'b'.repeat(16)],
      aspectRatio: '16:9',
      resolution: '1080p',
      durationSeconds: 10,
      outputCount: 1,
      audioEnabled: true,
    });

    expect(readManagedGenerationImages).toHaveBeenCalledWith(
      'desktop-session-seedance-i2v',
      ['a'.repeat(16), 'b'.repeat(16)],
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      model: 'doubao-seedance-2.5',
      prompt: 'Animate the product naturally.',
      images: ['data:image/png;base64,AQID', 'data:image/jpeg;base64,BAUG'],
      ratio: '16:9',
      resolution: '1080p',
      duration: 10,
      generate_audio: true,
    });
  });

  it('maps Wan text-to-video resolution and ratio to the documented size field', async () => {
    const appDataRoot = await makeTempRoot();
    const fetch = vi.fn(async (_url: string, _init?: { readonly body?: string | Uint8Array }) => jsonResponse({ task_id: 'wan-task-1' }));
    const service = await configuredService({
      appDataRoot,
      fetch,
      profiles: [profile('wan2.2-t2v-plus', ['video_generation', 'async_tasks'])],
    });

    await service.submitVideoJob!({
      jobId: 'model-job-v2-comfly-wan-t2v',
      provider: 'comfly',
      modelRoute: 'wan2.2-t2v-plus',
      prompt: 'A product rotates on a studio table.',
      conversationId: 'conversation-wan-t2v',
      referenceAssetIds: [],
      aspectRatio: '9:16',
      resolution: '720p',
      durationSeconds: 5,
      outputCount: 1,
      audioEnabled: false,
    });

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      model: 'wan2.2-t2v-plus',
      prompt: 'A product rotates on a studio table.',
      size: '720x1280',
      duration: 5,
    });
  });

  it.each([
    ['Wan text-to-video rejects image input', 'wan2.2-t2v-plus', 1],
    ['Wan image-to-video requires one image', 'wan2.2-i2v-plus', 0],
    ['Wan image-to-video rejects a second image', 'wan2.2-i2v-plus', 2],
    ['Wan keyframe video requires both frames', 'wanx2.1-kf2v-plus', 1],
    ['Wan undocumented models fail closed', 'wan2.5-preview', 0],
    ['Seedance rejects more than two frames', 'doubao-seedance-2.5', 3],
    ['Seedance text-only route rejects start/end frames', 'doubao-seedance-1-0-lite-t2v-250428', 2],
    ['Seedance undocumented models fail closed', 'doubao-seedance-1-5-pro-251215', 0],
    ['Veo text-only models reject image input', 'veo3-fast', 1],
    ['Veo image-only component models require an image', 'veo3.1-components', 0],
    ['Veo single-frame models reject a second image', 'veo3-pro-frames', 2],
    ['Veo two-frame models reject a third image', 'veo2-fast-frames', 3],
    ['Veo three-component models reject a fourth image', 'veo2-fast-components', 4],
    ['Veo models without documented multi-image support reject a second image', 'veo3.1', 2],
    ['Veo undocumented models fail closed', 'veo3.1-fast', 0],
    ['Undocumented video families fail closed', 'grok-imagine-video-1.5', 0],
  ] as const)('%s before reading assets or calling the paid endpoint', async (_label, modelId, referenceCount) => {
    const appDataRoot = await makeTempRoot();
    const fetch = vi.fn(async (_url: string, _init?: { readonly body?: string | Uint8Array }) => jsonResponse({ task_id: 'must-not-submit' }));
    const readManagedGenerationImages = vi.fn(async (
      _sessionId: string,
      referenceAssetIds: readonly string[],
    ) => referenceAssetIds.map((_, index) => ({
      bytes: Uint8Array.from([index + 1]),
      mediaType: 'image/png' as const,
    })));
    const service = await configuredService({
      appDataRoot,
      fetch,
      profiles: [profile(modelId, ['video_generation', 'async_tasks'])],
      readManagedGenerationImages,
    });
    const referenceAssetIds = Array.from(
      { length: referenceCount },
      (_, index) => String(index + 1).repeat(16),
    );

    await expect(service.submitVideoJob!({
      jobId: `model-job-v2-comfly-invalid-${modelId.replace(/\./gu, '-')}-${referenceCount}`,
      provider: 'comfly',
      modelRoute: modelId,
      prompt: 'Do not spend credits on an unsupported request.',
      conversationId: 'conversation-invalid-video-input',
      ...(referenceCount === 0 ? {} : { sessionId: 'desktop-session-invalid-video-input' }),
      referenceAssetIds,
      outputCount: 1,
    })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });

    expect(readManagedGenerationImages).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['Wan image-to-video accepts exactly one image', 'wan2.2-i2v-plus', 1],
    ['Wan keyframe video accepts exactly two images', 'wanx2.1-kf2v-plus', 2],
    ['Seedance accepts one image', 'doubao-seedance-2.5', 1],
    ['Veo single-frame video accepts one image', 'veo3-pro-frames', 1],
    ['Veo first/last-frame video accepts two images', 'veo2-fast-frames', 2],
    ['Veo component video accepts three images', 'veo2-fast-components', 3],
    ['Veo text-to-video accepts no images', 'veo3.1', 0],
  ] as const)('%s', async (_label, modelId, referenceCount) => {
    const appDataRoot = await makeTempRoot();
    const fetch = vi.fn(async (_url: string, _init?: { readonly body?: string | Uint8Array }) => jsonResponse({ task_id: 'documented-video-task' }));
    const readManagedGenerationImages = vi.fn(async (
      _sessionId: string,
      referenceAssetIds: readonly string[],
    ) => referenceAssetIds.map((_, index) => ({
      bytes: Uint8Array.from([index + 1]),
      mediaType: 'image/png' as const,
    })));
    const service = await configuredService({
      appDataRoot,
      fetch,
      profiles: [profile(modelId, ['video_generation', 'async_tasks'])],
      readManagedGenerationImages,
    });
    const referenceAssetIds = Array.from(
      { length: referenceCount },
      (_, index) => String(index + 1).repeat(16),
    );

    await expect(service.submitVideoJob!({
      jobId: `model-job-v2-comfly-valid-${modelId.replace(/\./gu, '-')}-${referenceCount}`,
      provider: 'comfly',
      modelRoute: modelId,
      prompt: 'Submit a documented Comfly video request.',
      conversationId: 'conversation-valid-video-input',
      ...(referenceCount === 0 ? {} : { sessionId: 'desktop-session-valid-video-input' }),
      referenceAssetIds,
      outputCount: 1,
    })).resolves.toEqual({ providerTaskId: expect.stringMatching(/^provider-job-/u) });

    expect(fetch).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as { readonly images?: readonly string[] };
    expect(body.images ?? []).toHaveLength(referenceCount);
  });

  it('surfaces a sanitized Comfly video failure reason', async () => {
    const appDataRoot = await makeTempRoot();
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ task_id: 'failed-video-task' }))
      .mockResolvedValueOnce(jsonResponse({
        task_id: 'failed-video-task',
        status: 'FAILURE',
        fail_reason: '参考图不符合模型要求 https://private.example/result token=top-secret-value',
      }));
    const service = await configuredService({
      appDataRoot,
      fetch,
      profiles: [profile('doubao-seedance-2.5', ['video_generation', 'async_tasks'])],
    });

    const submitted = await service.submitVideoJob!({
      jobId: 'model-job-v2-comfly-video-failure',
      provider: 'comfly',
      modelRoute: 'doubao-seedance-2.5',
      prompt: 'Animate the product.',
      conversationId: 'conversation-video-failure',
      referenceAssetIds: [],
    });
    const result = await service.pollVideoJob!({ provider: 'comfly', providerTaskId: submitted.providerTaskId });

    expect(result).toMatchObject({
      status: 'failed',
      error: { message: expect.stringContaining('参考图不符合模型要求') },
    });
    expect(JSON.stringify(result)).not.toMatch(/private\.example|top-secret-value/u);
  });
});

function profile(modelId: string, capabilities: ProviderBridgeProfile['capabilities']): ProviderBridgeProfile {
  return {
    provider: 'comfly',
    modelRoute: modelId,
    modelId,
    displayName: modelId,
    capabilities,
  };
}

async function configuredService(
  options: Omit<Parameters<typeof createComflyProviderService>[0], 'credentialStore'>,
) {
  const credentialStore = createSecureProviderCredentialStore({
    appDataRoot: options.appDataRoot,
    safeStorage: fakeSafeStorage(),
  });
  const service = createComflyProviderService({ ...options, credentialStore });
  await service.configure({ token: 'provider-test-token' });
  return service;
}

function fakeSafeStorage(): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8'),
    decryptString: (value) => Buffer.from(value).toString('utf8'),
  };
}

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'novus-comfly-regression-'));
  roots.push(root);
  return root;
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}
