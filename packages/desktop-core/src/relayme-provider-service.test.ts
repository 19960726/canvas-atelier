import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RelayMeFetch } from '@agent-canvas/provider-relayme';
import { createAgentKnowledgeLease, createReversePromptRun } from '@agent-canvas/domain';
import { createRelayMeProviderService } from './relayme-provider-service';
import type { ProviderCredentialStore } from './provider-credential-vault';
import { createProviderTaskMappingStore } from './provider-task-ledger';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('RelayMe provider service', () => {
  it('maps RelayMe image authentication, quota, and capability failures to actionable bridge errors', async () => {
    const { service } = await createService([
      modelsResponse(),
      jsonResponse({ message: 'quota exceeded' }, { ok: false, status: 429 }),
    ]);
    await expect(service.submitImageJob({
      jobId: 'job-quota', provider: 'relayme', modelRoute: 'relayme-gpt-image-2', prompt: 'test',
      conversationId: 'conversation-quota', referenceAssetIds: [],
    })).rejects.toMatchObject({ code: 'PROVIDER_ERROR', retryable: true, message: expect.stringMatching(/额度|频率/u) });
  });

  it('validates a temporary account JWT against models before persisting it', async () => {
    const appDataRoot = await mkdtemp(join(tmpdir(), 'relayme-login-'));
    roots.push(appDataRoot);
    const credentials = credentialStore({ configured: false, locked: true });
    const service = createRelayMeProviderService({
      appDataRoot,
      credentialStore: credentials,
      fetch: vi.fn(async () => jsonResponse({ message: 'unavailable' }, { ok: false, status: 503 })),
      loginAccount: vi.fn(async () => 'header.payload.signature'),
    });

    await expect(service.loginRelayMe?.({ username: 'artist@example.test', password: 'not-a-real-password' }))
      .rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(credentials.configure).not.toHaveBeenCalled();
  });

  it('uses the live RelayMe model catalog and routes Agent chat to chat completions', async () => {
    const { service, fetch } = await createService([
      jsonResponse({ success: true, data: { models: [
        { id: '1', name: 'Relay Image', model: 'gpt-image-2', capability: 'image', modelType: 'IMAGE', endpoints: ['/api/ai-tools/v1/images/generations'], pricing: { image1k: '1', image2k: '2' } },
        { id: '2', name: 'Relay Chat', model: 'gemini-3.1-flash-lite', capability: 'text', modelType: 'TEXT', endpoints: ['/api/ai-tools/v1/chat/completions'] },
      ] } }),
      jsonResponse({ id: 'chat-1', model: 'gemini-3.1-flash-lite', choices: [{ message: { role: 'assistant', content: '已整理提示词' } }] }),
    ]);

    await expect(service.listProfiles()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'relayme', modelId: 'gpt-image-2', capabilities: ['image_generation', 'async_tasks'] }),
      expect.objectContaining({ provider: 'relayme', modelId: 'gemini-3.1-flash-lite', capabilities: ['chat'] }),
    ]));
    await expect(service.chat?.({
      provider: 'relayme', modelRoute: 'relayme-gemini-3-1-flash-lite',
      messages: [{ role: 'user', content: '帮我整理提示词' }],
      context: { knowledgeBaseIds: [], projectMemoryIds: [] },
    })).resolves.toEqual({ message: '已整理提示词', modelRoute: 'relayme-gemini-3-1-flash-lite', sources: [] });
    expect(fetch).toHaveBeenLastCalledWith(
      'https://www.ml.relayme.uk/api/ai-tools/v1/chat/completions',
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('帮我整理提示词') }),
    );
  });

  it('runs image reverse prompting through an explicitly declared RelayMe vision chat model', async () => {
    const imageAssetId = 'b'.repeat(16);
    const imageSha256 = 'b'.repeat(64);
    const references = [{ assetId: imageAssetId, label: 'Product', position: 0, role: 'product_identity' as const }];
    const run = createReversePromptRun({
      projectId: 'project-1',
      skill: { id: 'reverse-prompt', version: 'v1' },
      agentConfig: {
        modelRoute: 'relayme-vision-chat',
        role: 'Commercial visual analyst',
        task: 'Analyze the managed original image.',
        knowledgeBaseIds: [],
      },
      knowledgeLease: createAgentKnowledgeLease({
        runId: 'reverse-run-1', capability: 'reverse_prompt', snapshots: [], references, citations: [],
      }, { leaseId: 'lease-1', createdAt: '2026-08-09T00:00:00.000Z' }),
      approvedMemorySnapshot: {
        version: 'approved-1', approvedAt: '2026-08-09T00:00:00.000Z', approvedMemoryIds: [],
      },
      references,
    }, { createNonce: () => 'nonce-1', now: () => '2026-08-09T00:00:00.000Z' });
    const expected = {
      sessionId: run.sessionId,
      nonce: run.nonce,
      knowledgeSnapshotVersion: run.knowledgeLease.versionKey,
      analysis: 'Centered product with soft key light.',
      keywords: ['product', 'soft light'],
      positivePrompt: 'Centered product, soft key light.',
      negativeConstraints: ['No distorted logo.'],
      executionChecklist: ['Check silhouette.'],
    };
    const readManagedReverseMedia = vi.fn(async () => [{
      bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), mediaType: 'image/png',
    }] as const);
    const { service, fetch } = await createService([
      jsonResponse({ success: true, data: { models: [{
        id: '22', name: 'Vision Chat', model: 'vision-chat', capability: 'text', modelType: 'TEXT',
        inputModalities: ['text', 'image'], supportsVision: true,
        endpoints: ['/api/ai-tools/v1/chat/completions'],
      }] } }),
      jsonResponse({ id: 'reverse-1', model: 'vision-chat', choices: [{ message: { role: 'assistant', content: JSON.stringify(expected) } }] }),
    ], { readManagedReverseMedia });

    await expect(service.analyzeReversePrompt?.({
      sessionId: 'desktop-session-1', provider: 'relayme', run,
      media: [{ kind: 'image', assetId: imageAssetId, sha256: imageSha256, byteSize: 4, mediaType: 'image/png' }],
    })).resolves.toEqual(expected);
    expect(readManagedReverseMedia).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenLastCalledWith(
      'https://www.ml.relayme.uk/api/ai-tools/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringMatching(/seedance-2-5-reverse[\s\S]*2026-08-21\.1[\s\S]*@图片1[\s\S]*data:image\/png;base64,iVBORw==/u),
      }),
    );
  });

  it('reports a retryable truncation when RelayMe reverse chat finishes because of length', async () => {
    const imageAssetId = 'c'.repeat(16);
    const imageSha256 = 'c'.repeat(64);
    const references = [{ assetId: imageAssetId, label: 'Product', position: 0, role: 'product_identity' as const }];
    const run = createReversePromptRun({
      projectId: 'project-truncated',
      skill: { id: 'reverse-prompt', version: 'v1' },
      agentConfig: { modelRoute: 'relayme-vision-chat', role: 'Analyst', task: 'Analyze image.', knowledgeBaseIds: [] },
      knowledgeLease: createAgentKnowledgeLease({
        runId: 'reverse-run-truncated', capability: 'reverse_prompt', snapshots: [], references, citations: [],
      }, { leaseId: 'lease-truncated', createdAt: '2026-08-09T00:00:00.000Z' }),
      approvedMemorySnapshot: { version: 'approved-truncated', approvedAt: '2026-08-09T00:00:00.000Z', approvedMemoryIds: [] },
      references,
    }, { createNonce: () => 'nonce-truncated', now: () => '2026-08-09T00:00:00.000Z' });
    const { service } = await createService([
      jsonResponse({ success: true, data: { models: [{
        id: '22', name: 'Vision Chat', model: 'vision-chat', capability: 'text', modelType: 'TEXT',
        inputModalities: ['text', 'image'], supportsVision: true,
        endpoints: ['/api/ai-tools/v1/chat/completions'],
      }] } }),
      jsonResponse({
        id: 'reverse-length', model: 'vision-chat',
        choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '{"analysis":"truncated' } }],
      }),
    ], { readManagedReverseMedia: async () => [{ bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), mediaType: 'image/png' }] });

    await expect(service.analyzeReversePrompt?.({
      sessionId: 'desktop-session-truncated', provider: 'relayme', run,
      media: [{ kind: 'image', assetId: imageAssetId, sha256: imageSha256, byteSize: 4, mediaType: 'image/png' }],
    })).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_RESPONSE',
      message: 'Reverse-analysis response was truncated at the model output limit',
      retryable: true,
    });
  });
  it('keeps RelayMe raw task ids internal and maps exactly one image result', async () => {
    const storedImage = vi.fn(async () => ({ assetId: '0123456789abcdef', width: 1536, height: 1024 }));
    const historySink = {
      queued: vi.fn(async () => 'history_relayme_image'),
      reserveSubmission: vi.fn(async () => ({
        created: true,
        historyId: 'history_relayme_image',
        status: 'queued' as const,
        terminal: null,
      })),
      running: vi.fn(async () => undefined),
      succeeded: vi.fn(async () => ({ status: 'succeeded' as const })),
      failed: vi.fn(async () => ({ status: 'failed' as const })),
      cancelled: vi.fn(async () => ({ status: 'cancelled' as const })),
      getTerminal: vi.fn(async () => null),
    };
    const { service, fetch } = await createService([
      modelsResponse(),
      jsonResponse({ taskId: 'relay-raw-image-77', status: 'queued' }),
      jsonResponse({ status: 'COMPLETED', imageContent: 'https://cdn.example/result.png', width: 1536, height: 1024 }),
      binaryResponse(pngHeaderBytes()),
    ], { historySink: historySink as never, storeGeneratedImage: storedImage });
    const submitted = await service.submitImageJob({
      jobId: 'model-job-v2-relay-image', provider: 'relayme', modelRoute: 'relayme-gpt-image-2',
      prompt: '产品海报', conversationId: 'conversation-1', sessionId: 'desktop-session-1', referenceAssetIds: [],
      aspectRatio: '3:4', resolution: '2K', outputCount: 1,
    });

    const fetchCalls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const imageSubmission = JSON.parse(String((fetchCalls[1]?.[1] as { body?: unknown } | undefined)?.body)) as Record<string, unknown>;
    expect(imageSubmission).toMatchObject({
      imageAspectRatio: '3:4',
      imageQuality: 'medium',
      imageSampleSize: '2K',
    });
    expect(imageSubmission.imageQuality).not.toBe('2K');

    expect(submitted.providerTaskId).toMatch(/^provider-job-[a-f0-9]{32}$/u);
    expect(submitted.providerTaskId).not.toContain('relay-raw-image-77');
    await expect(service.pollImageJob({ provider: 'relayme', providerTaskId: submitted.providerTaskId })).resolves.toEqual({
      status: 'completed', progress: 1,
      result: { assetId: '0123456789abcdef', width: 1536, height: 1024 },
    });
    expect(storedImage).toHaveBeenCalledWith('desktop-session-1', expect.any(Uint8Array), 'image/png');
    expect(historySink.reserveSubmission).toHaveBeenCalledWith({
      jobId: 'model-job-v2-relay-image', kind: 'image', modelDisplayName: 'Relay Image', provider: 'relayme',
    });
    expect(historySink.running).toHaveBeenCalledWith('history_relayme_image');
    expect(historySink.succeeded).toHaveBeenCalledWith('history_relayme_image', expect.any(Uint8Array), {
      width: 1536, height: 1024,
    });
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      'https://cdn.example/result.png',
      expect.objectContaining({ trustedResolvedAddress: '8.8.8.8' }),
    );
  });

  it('submits RelayMe jobs when the legacy global task ledger belongs to Comfly', async () => {
    const appDataRoot = await mkdtemp(join(tmpdir(), 'relayme-ledger-isolation-'));
    roots.push(appDataRoot);
    const comflyLedger = createProviderTaskMappingStore({
      appDataRoot,
      secretSupplier: async () => ({ primary: 'comfly-mapping-key', fallback: [] }),
    });
    const existingComflyTaskId = `provider-job-${'a'.repeat(32)}`;
    await comflyLedger.set({
      provider: 'comfly',
      publicTaskId: existingComflyTaskId,
      rawTaskId: 'comfly-raw-task',
      kind: 'image',
      state: 'running',
      createdAt: '2026-08-08T11:00:00.000Z',
      updatedAt: '2026-08-08T11:00:00.000Z',
    });
    const responses = [
      modelsResponse(),
      jsonResponse({ taskId: 'relay-raw-image-isolated', status: 'queued' }),
    ];
    const service = createRelayMeProviderService({
      appDataRoot,
      credentialStore: credentialStore({ configured: true, locked: false }),
      fetch: vi.fn(async () => responses.shift() as ReturnType<typeof jsonResponse>),
      now: () => Date.parse('2026-08-08T12:00:00.000Z'),
    });

    await expect(service.submitImageJob({
      jobId: 'model-job-v2-relay-ledger-isolation',
      provider: 'relayme',
      modelRoute: 'relayme-gpt-image-2',
      prompt: 'isolated ledger',
      conversationId: 'conversation-ledger-isolation',
      sessionId: 'desktop-session-ledger-isolation',
      referenceAssetIds: [],
      aspectRatio: '1:1',
      resolution: '2K',
      outputCount: 1,
    })).resolves.toMatchObject({ providerTaskId: expect.stringMatching(/^provider-job-[a-f0-9]{32}$/u) });
    await expect(comflyLedger.get(existingComflyTaskId)).resolves.toMatchObject({ rawTaskId: 'comfly-raw-task' });
  });

  it('recovers an image task mapping after the provider service restarts', async () => {
    const appDataRoot = await mkdtemp(join(tmpdir(), 'relayme-service-restart-'));
    roots.push(appDataRoot);
    const credentials = credentialStore({ configured: true, locked: false });
    const submitResponses = [
      modelsResponse(),
      jsonResponse({ taskId: 'relay-raw-image-restart', status: 'queued' }),
    ];
    const submitFetch: RelayMeFetch = vi.fn(async () => submitResponses.shift() as ReturnType<typeof jsonResponse>);
    const firstService = createRelayMeProviderService({
      appDataRoot,
      credentialStore: credentials,
      fetch: submitFetch,
      resolveResultHost: async () => ['8.8.8.8'],
    });
    const submitted = await firstService.submitImageJob({
      jobId: 'model-job-v2-relay-restart', provider: 'relayme', modelRoute: 'relayme-gpt-image-2',
      prompt: 'Restart-safe image', conversationId: 'conversation-restart', sessionId: 'desktop-session-restart',
      referenceAssetIds: [], aspectRatio: '1:1', resolution: '1K', outputCount: 1,
    });

    const storedImage = vi.fn(async () => ({ assetId: 'abcdef0123456789', width: 1024, height: 1024 }));
    const pollResponses = [
      jsonResponse({ status: 'COMPLETED', imageContent: 'https://cdn.example/restart.png', width: 1024, height: 1024 }),
      binaryResponse(pngHeaderBytes()),
    ];
    const pollFetch: RelayMeFetch = vi.fn(async () => pollResponses.shift() as ReturnType<typeof jsonResponse>);
    const restartedService = createRelayMeProviderService({
      appDataRoot,
      credentialStore: credentials,
      fetch: pollFetch,
      resolveResultHost: async () => ['8.8.8.8'],
      storeGeneratedImage: storedImage,
    });

    await expect(restartedService.pollImageJob({
      provider: 'relayme', providerTaskId: submitted.providerTaskId,
    })).resolves.toEqual({
      status: 'completed', progress: 1,
      result: { assetId: 'abcdef0123456789', width: 1024, height: 1024 },
    });
    expect(pollFetch).toHaveBeenNthCalledWith(
      1,
      'https://www.ml.relayme.uk/api/ai-tools/v1/tasks/relay-raw-image-restart',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('submits and polls video jobs without manufacturing four preview results', async () => {
    const storedVideo = vi.fn(async () => ({ assetId: 'fedcba9876543210', width: null, height: null }));
    const { service, fetch } = await createService([
      modelsResponse(),
      jsonResponse({ taskId: 'relay-raw-video-91', status: 'queued' }),
      jsonResponse({ status: 'COMPLETED', videoContent: 'https://cdn.example/result.mp4', width: 1920, height: 1080, durationSeconds: 8 }),
      binaryResponse(mp4HeaderBytes()),
    ], { storeGeneratedVideo: storedVideo });
    const submitted = await service.submitVideoJob?.({
      jobId: 'model-job-v2-relay-video', provider: 'relayme', modelRoute: 'relayme-kling-kling-v3-video-generation',
      prompt: '镜头向前推进', conversationId: 'conversation-1', sessionId: 'desktop-session-1', referenceAssetIds: [],
      aspectRatio: '16:9', resolution: '1080p', durationSeconds: 8, outputCount: 1, audioEnabled: true,
    });
    expect(submitted?.providerTaskId).toMatch(/^provider-job-[a-f0-9]{32}$/u);
    await expect(service.pollVideoJob?.({ provider: 'relayme', providerTaskId: submitted!.providerTaskId })).resolves.toEqual({
      status: 'completed', progress: 1,
      result: { assetId: 'fedcba9876543210', width: 1920, height: 1080, durationSeconds: 8 },
    });
    expect(storedVideo).toHaveBeenCalledWith('desktop-session-1', expect.any(Uint8Array), 'video/mp4');
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://www.ml.relayme.uk/api/ai-tools/v1/videos/generations',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringMatching(/"messages":\[\{"role":"user","content":"镜头向前推进"\}\].*"videoAspectRatio":"16:9".*"videoQuality":"1080p".*"videoSeconds":8.*"audioEnabled":true/u),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      'https://www.ml.relayme.uk/api/ai-tools/v1/tasks/relay-raw-video-91',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      'https://cdn.example/result.mp4',
      expect.objectContaining({ method: 'GET', trustedResolvedAddress: '8.8.8.8' }),
    );
  });

  it('writes RelayMe video lifecycle events into the shared generation history sink', async () => {
    const historySink = {
      reserveSubmission: vi.fn(async () => ({ created: true, historyId: 'history_relaymevideoaaaaaa', status: 'queued' as const, terminal: null })),
      running: vi.fn(async () => undefined),
      succeeded: vi.fn(async () => ({ status: 'succeeded' as const, width: 1920, height: 1080 })),
      failed: vi.fn(async () => ({ status: 'failed' as const })),
      cancelled: vi.fn(async () => ({ status: 'cancelled' as const })),
      getTerminal: vi.fn(async () => null),
      queued: vi.fn(),
    };
    const storedVideo = vi.fn(async () => ({ assetId: 'fedcba9876543210', width: 1920, height: 1080 }));
    const { service } = await createService([
      modelsResponse(),
      jsonResponse({ taskId: 'relay-history-video-1', status: 'queued' }),
      jsonResponse({ status: 'COMPLETED', videoContent: 'https://cdn.example/history.mp4', width: 1920, height: 1080, durationSeconds: 8 }),
      binaryResponse(mp4HeaderBytes()),
    ], { historySink, storeGeneratedVideo: storedVideo });

    const submitted = await service.submitVideoJob?.({
      jobId: 'model-job-v2-relay-history-video', provider: 'relayme', modelRoute: 'relayme-kling-kling-v3-video-generation',
      prompt: 'camera move', conversationId: 'conversation-history', sessionId: 'desktop-session-history', referenceAssetIds: [],
      aspectRatio: '16:9', durationSeconds: 8, outputCount: 1,
    });
    await service.pollVideoJob?.({ provider: 'relayme', providerTaskId: submitted!.providerTaskId });

    expect(historySink.reserveSubmission).toHaveBeenCalledWith({
      jobId: 'model-job-v2-relay-history-video', kind: 'video', modelDisplayName: 'Kling3', provider: 'relayme',
    });
    expect(historySink.running).toHaveBeenCalledWith('history_relaymevideoaaaaaa');
    expect(historySink.succeeded).toHaveBeenCalledWith(
      'history_relaymevideoaaaaaa',
      expect.any(Uint8Array),
      { durationSeconds: 8, height: 1080, width: 1920 },
    );
  });
  it('decodes an inline RelayMe image only inside the main process before storing it', async () => {
    const inlineContent = `data:image/png;base64,${Buffer.from(pngHeaderBytes()).toString('base64')}`;
    const storedImage = vi.fn(async () => ({ assetId: '1111111111111111', width: 1, height: 1 }));
    const { service, fetch } = await createService([
      modelsResponse(),
      jsonResponse({ taskId: 'relay-inline-image', status: 'queued' }),
      jsonResponse({ status: 'COMPLETED', imageContent: inlineContent, width: 1, height: 1 }),
    ], { storeGeneratedImage: storedImage });
    const submitted = await service.submitImageJob({
      jobId: 'model-job-v2-relay-inline', provider: 'relayme', modelRoute: 'relayme-gpt-image-2',
      prompt: 'inline result', conversationId: 'conversation-inline', sessionId: 'desktop-session-inline', referenceAssetIds: [],
    });

    const result = await service.pollImageJob({ provider: 'relayme', providerTaskId: submitted.providerTaskId });
    expect(result).toEqual({ status: 'completed', progress: 1, result: { assetId: '1111111111111111', width: 1, height: 1 } });
    expect(storedImage).toHaveBeenCalledWith('desktop-session-inline', expect.any(Uint8Array), 'image/png');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result)).not.toMatch(/data:image|base64|https?:/iu);
  });

  it('blocks RelayMe result downloads when DNS resolves to a private address', async () => {
    const storedImage = vi.fn();
    const { service, fetch } = await createService([
      modelsResponse(),
      jsonResponse({ taskId: 'relay-private-image', status: 'queued' }),
      jsonResponse({ status: 'COMPLETED', imageContent: 'https://cdn.example/private.png' }),
    ], {
      resolveResultHost: async () => ['127.0.0.1'],
      storeGeneratedImage: storedImage,
    });
    const submitted = await service.submitImageJob({
      jobId: 'model-job-v2-relay-private', provider: 'relayme', modelRoute: 'relayme-gpt-image-2',
      prompt: 'private result', conversationId: 'conversation-private', sessionId: 'desktop-session-private', referenceAssetIds: [],
    });

    await expect(service.pollImageJob({ provider: 'relayme', providerTaskId: submitted.providerTaskId }))
      .rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
    expect(storedImage).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('fails closed with a Chinese capability error when RelayMe cancellation is undocumented', async () => {
    const { service } = await createService([
      modelsResponse(),
      jsonResponse({ taskId: 'relay-raw-video-cancel', status: 'queued' }),
    ]);
    const submitted = await service.submitVideoJob!({
      jobId: 'model-job-v2-relay-cancel', provider: 'relayme', modelRoute: 'relayme-kling-kling-v3-video-generation',
      prompt: '测试取消', conversationId: 'conversation-1', sessionId: 'desktop-session-1', referenceAssetIds: [],
    });

    await expect(service.cancelVideoJob?.({ provider: 'relayme', providerTaskId: submitted.providerTaskId }))
      .rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED', message: expect.stringMatching(/取消接口|取消任务/u) });
  });

  it('returns a Chinese credential error before any request when credentials are locked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relayme-service-'));
    roots.push(root);
    const service = createRelayMeProviderService({
      appDataRoot: root,
      credentialStore: credentialStore({ configured: true, locked: true }),
      fetch: vi.fn(),
    });

    await expect(service.listProfiles()).rejects.toMatchObject({
      code: 'CREDENTIALS_LOCKED', message: expect.stringMatching(/密钥|凭据/u),
    });
  });
  it('rejects manually configured RelayMe tokens because credentials come only from account login', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relayme-service-'));
    roots.push(root);
    const store = credentialStore({ configured: false, locked: true });
    const service = createRelayMeProviderService({
      appDataRoot: root,
      credentialStore: store,
      fetch: vi.fn(),
    });

    await expect(service.configure({ provider: 'relayme', token: 'relay-created-key' }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST', message: 'RelayMe 仅支持账号登录，不接受独立 API 密钥' });
    expect(store.configure).not.toHaveBeenCalled();
  });

  it('migrates the retired RelayMe host before reading the model catalog', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relayme-service-'));
    roots.push(root);
    const configurationRoot = join(root, 'providers', 'relayme');
    await mkdir(configurationRoot, { recursive: true });
    await writeFile(join(configurationRoot, 'provider-configuration.json'), `${JSON.stringify({
      version: 1,
      baseUrl: 'https://api.relayme.ai/api/ai-tools/v1',
      profiles: [],
    })}\n`, 'utf8');
    const fetch: RelayMeFetch = vi.fn(async () => modelsResponse());
    const service = createRelayMeProviderService({
      appDataRoot: root,
      credentialStore: credentialStore({ configured: true, locked: false }),
      fetch,
    });

    await service.listProfiles();

    expect(fetch).toHaveBeenCalledWith(
      'https://www.ml.relayme.uk/api/ai-tools/v1/models',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});

async function createService(
  responses: unknown[],
  storage: {
    readonly historySink?: Parameters<typeof createRelayMeProviderService>[0]['historySink'];
    readonly resolveResultHost?: (hostname: string) => Promise<readonly string[]>;
    readonly readManagedReverseMedia?: (sessionId: string, media: readonly unknown[]) => Promise<readonly { readonly bytes: Uint8Array; readonly mediaType: string }[]>;
    readonly storeGeneratedImage?: (sessionId: string, bytes: Uint8Array, mediaType: string) => Promise<{ readonly assetId: string; readonly width?: number | null; readonly height?: number | null }>;
    readonly storeGeneratedVideo?: (sessionId: string, bytes: Uint8Array, mediaType: 'video/mp4') => Promise<{ readonly assetId: string; readonly width?: number | null; readonly height?: number | null }>;
  } = {},
) {
  const appDataRoot = await mkdtemp(join(tmpdir(), 'relayme-service-'));
  roots.push(appDataRoot);
  const fetch: RelayMeFetch = vi.fn(async () => responses.shift() as ReturnType<typeof jsonResponse>);
  const service = createRelayMeProviderService({
    appDataRoot,
    credentialStore: credentialStore({ configured: true, locked: false }),
    fetch,
    resolveResultHost: async () => ['8.8.8.8'],
    ...storage,
    now: () => Date.parse('2026-08-08T12:00:00.000Z'),
  });
  return { service, fetch };
}

function credentialStore(status: { configured: boolean; locked: boolean }): ProviderCredentialStore {
  return {
    configure: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    unlock: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => ({ ...status, encryption: 'safeStorage' as const })),
    getPrimaryToken: vi.fn(async () => {
      if (status.locked) throw Object.assign(new Error('RelayMe 密钥已锁定'), { code: 'CREDENTIALS_LOCKED', retryable: true });
      return 'relay-secret';
    }),
    getToken: vi.fn(async () => {
      if (status.locked) throw Object.assign(new Error('RelayMe 密钥已锁定'), { code: 'CREDENTIALS_LOCKED', retryable: true });
      return 'relay-secret';
    }),
    getMappingKey: vi.fn(async () => 'mapping-key'),
    getMappingSecrets: vi.fn(async () => ({ primary: 'mapping-key', fallback: [] })),
  };
}

function modelsResponse() {
  return jsonResponse({ success: true, data: { models: [
    { id: '1', name: 'Relay Image', model: 'gpt-image-2', capability: 'image', modelType: 'IMAGE', endpoints: ['/api/ai-tools/v1/images/generations'], pricing: { image1k: '1', image2k: '2' } },
    {
      id: '2', name: 'Kling3', model: 'kling/kling-v3-video-generation', capability: 'video', modelType: 'VIDEO',
      endpoints: ['/api/ai-tools/v1/videos/generations'],
      videoCapabilities: { duration: { mode: 'range', min: 3, max: 15, step: 1, defaultValue: 5 } },
    },
  ] } });
}
function jsonResponse(body: unknown, options: { ok?: boolean; status?: number } = {}) {
  return { ok: options.ok ?? true, status: options.status ?? 200, async json() { return body; } };
}
function binaryResponse(bytes: Uint8Array) {
  return {
    ok: true,
    status: 200,
    async json() { throw new Error('binary response is not JSON'); },
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
  };
}

function pngHeaderBytes(): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
}

function mp4HeaderBytes(): Uint8Array {
  return Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
}
