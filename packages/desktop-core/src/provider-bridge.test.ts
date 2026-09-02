import { createCipheriv, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';
import { createAgentKnowledgeLease, createReversePromptRun, type ReversePromptRun } from '@agent-canvas/domain';
import { createKnowledgeSnapshotCandidate } from '@agent-canvas/skill-store';

import {
  PROVIDER_BRIDGE_CHANNELS,
  createElectronNetComflyFetch,
  createComflyProviderService,
  createProviderBridgeHandlers,
  createSecureProviderCredentialStore,
  normalizeProviderBridgeError,
  parseProviderBridgeRequest,
  parseProviderBridgeResponse,
  registerProviderBridgeHandlers,
  type ProviderBridgeProfile,
  type SafeStorageAdapter,
  type SubmitImageJobBridgeRequest,
} from './provider-bridge.js';
import { ManagedKnowledgeStore } from './managed-knowledge-store.js';
import { NodeFileSystem, type FileHandleLike, type FileSystem } from './file-system.js';
import { deriveGenerationHistoryId } from './generation-history-provider-sink.js';

const token = 'sk-task-9-secret-token';
const passphrase = 'correct horse battery staple';
const scrypt = promisify(scryptCallback);
const profiles: ProviderBridgeProfile[] = [
  {
    provider: 'comfly',
    modelRoute: 'gpt-image',
    displayName: 'GPT Image',
    modelId: 'provider-gpt-image-route',
    capabilities: ['image_generation', 'async_tasks'],
  },
  {
    provider: 'comfly',
    modelRoute: 'nano-banana-2',
    displayName: 'Nano Banana 2',
    capabilities: ['image_generation', 'async_tasks'],
  },
];

describe('provider bridge contracts', () => {
  it('keeps the submitted image resolution tier stable before provider mapping', () => {
    expect(parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.submitImageJob, {
      jobId: 'job-tier', provider: 'comfly', modelRoute: 'gpt-image', prompt: 'draw a chair',
      conversationId: 'conversation-tier', referenceAssetIds: [], aspectRatio: '16:9', resolution: '4K',
    })).toMatchObject({ resolution: '4K', aspectRatio: '16:9' });
  });

  it('accepts up to three hidden image and reverse credential keys without returning them from status', () => {
    const parsed = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.configure, {
      token: 'primary-image-key',
      imageTokens: ['primary-image-key', 'image-key-2', 'image-key-3'],
      reverseTokens: ['primary-reverse-key', 'reverse-key-2', 'reverse-key-3'],
    });

    expect(parsed).toMatchObject({
      imageTokens: ['primary-image-key', 'image-key-2', 'image-key-3'],
      reverseTokens: ['primary-reverse-key', 'reverse-key-2', 'reverse-key-3'],
    });
    expect(() => parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.configure, {
      token: 'primary-image-key',
      imageTokens: ['a', 'b', 'c', 'd'],
    })).toThrow();
  });

  it('keeps provider IPC request and response contracts backed by strict Zod schemas', async () => {
    const contractsSource = await readFile(join(process.cwd(), 'packages/desktop-core/src/provider-contracts.ts'), 'utf8');
    const bridgeSource = await readFile(join(process.cwd(), 'packages/desktop-core/src/provider-bridge.ts'), 'utf8');

    expect(contractsSource).toMatch(/from 'zod'/u);
    expect(contractsSource).toMatch(/ProviderBridgeRequestSchemas/u);
    expect(contractsSource).toMatch(/ProviderBridgeResponseSchemas/u);
    expect(contractsSource).toMatch(/\.strict\(\)/u);
    expect(bridgeSource).not.toMatch(/function validateConfigureRequest|function expectStrictRecord/u);
  });

  it('rejects unknown provider channels and unknown request fields', () => {
    expect(() => parseProviderBridgeRequest('novus-desktop:provider:fetch', {})).toThrow(/unknown provider channel/i);
    expect(() => parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.getStatus, { extra: true })).toThrow(/unknown key/i);
    const parseUnknownAuthorizationField = () => parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.submitImageJob, {
      jobId: 'job-1',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'draw a chair',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
      authorization: `Bearer ${token}`,
    });

    expect(parseUnknownAuthorizationField).toThrow(/unknown key/i);
    expect(parseUnknownAuthorizationField).not.toThrow(/authorization|bearer|sk-task-9/i);
  });

  it('rejects protected provider payloads before they reach service code', () => {
    expect(() => parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.submitImageJob, {
      jobId: 'job-unsafe',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'use data:image/png;base64,AAAAAAAAAAAAAAAAAAAA',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    })).toThrow(/protected payload/i);
  });

  it('accepts controlled Skill Chat text and context ids while rejecting protected data', () => {
    const request = {
      provider: 'comfly' as const,
      modelRoute: 'skill-chat',
      messages: [{ role: 'user' as const, content: 'Compare the composition options.' }],
      context: {
        knowledgeBaseIds: ['catalog'],
        projectMemoryIds: ['project-memory-1'],
      },
    };

    expect(parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.chat, request)).toEqual(request);
    expect(parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.chat, {
      ...request,
      messages: [{ role: 'user', content: 'ThisIsAnOrdinarySentenceWithWords' }],
    })).toEqual({
      ...request,
      messages: [{ role: 'user', content: 'ThisIsAnOrdinarySentenceWithWords' }],
    });
    expect(() => parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.chat, {
      ...request,
      messages: [{ role: 'user', content: 'Read C:\\Users\\private\\brief.md' }],
    })).toThrow(/protected payload/i);
    expect(() => parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.chat, {
      ...request,
      messages: [{ role: 'user', content: 'Open https://unsafe.example/context' }],
    })).toThrow(/protected payload/i);
    expect(() => parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.chat, {
      ...request,
      context: { ...request.context, secret: token },
    })).toThrow(/unknown key/i);

    const twentyManagedImageIds = Array.from({ length: 20 }, (_, index) => index.toString(16).padStart(16, '0'));
    expect(parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.chat, {
      ...request,
      sessionId: 'desktop-session-1',
      referenceAssetIds: twentyManagedImageIds,
    })).toEqual({
      ...request,
      sessionId: 'desktop-session-1',
      referenceAssetIds: twentyManagedImageIds,
    });

    expect(parseProviderBridgeResponse(PROVIDER_BRIDGE_CHANNELS.chat, {
      message: 'Use the lower-angle reference for a more dramatic framing.',
      modelRoute: 'skill-chat',
      sources: [{ knowledgeBaseId: 'catalog', version: 1, displayName: 'Catalog' }],
    })).toEqual({
      message: 'Use the lower-angle reference for a more dramatic framing.',
      modelRoute: 'skill-chat',
      sources: [{ knowledgeBaseId: 'catalog', version: 1, displayName: 'Catalog' }],
    });

    for (const protectedText of [
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
      '/9j/4AAQSkZJRgABAQAAAQABAAD',
      'Read C:/Users/private/brief.md',
      'Read /srv/private/brief.md',
    ]) {
      expect(() => parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.chat, {
        ...request,
        messages: [{ role: 'user', content: protectedText }],
      })).toThrow(/protected payload/i);
      expect(() => parseProviderBridgeResponse(PROVIDER_BRIDGE_CHANNELS.chat, {
        message: protectedText,
        modelRoute: 'skill-chat',
        sources: [],
      })).toThrow(/protected payload/i);
    }
  });

  it('accepts only the stable comfly provider identifier in configured profiles', () => {
    expect(() => parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.configure, {
      token,
      profiles: [{
        provider: 'comfly-enterprise',
        modelRoute: 'nano-banana-2-route',
        displayName: 'Nano Banana 2',
        capabilities: ['image_generation', 'async_tasks'],
      }],
    })).toThrow(/provider request is invalid/i);
  });

  it('normalizes errors without leaking token-like details', () => {
    const normalized = normalizeProviderBridgeError(
      new Error(`Authorization: Bearer ${token} failed from C:\\Users\\Private\\image.png`),
    );

    expect(normalized).toEqual(expect.objectContaining({
      code: 'PROVIDER_ERROR',
      retryable: false,
    }));
    expect(JSON.stringify(normalized)).not.toMatch(/Authorization|Bearer|sk-task-9|C:\\\\Users/i);
  });
});

describe('reverse prompt analysis bridge contract', () => {
  it('accepts only opaque session metadata, a pinned reverse run, and managed media identities', () => {
    const imageAssetId = 'b'.repeat(16);
    const imageSha256 = 'b'.repeat(64);
    const videoAssetId = 'c'.repeat(16);
    const videoSha256 = 'c'.repeat(64);
    const references = [{
      assetId: imageAssetId,
      label: 'Product',
      position: 0,
      role: 'product_identity' as const,
    }];
    const run = createReversePromptRun({
      projectId: 'project-1',
      skill: { id: 'reverse-prompt', version: 'v1' },
      agentConfig: {
        modelRoute: 'comfly/gemini-video',
        role: 'Commercial visual analyst',
        task: 'Analyze the managed original media.',
        knowledgeBaseIds: ['catalog', 'composition'],
      },
      knowledgeLease: createAgentKnowledgeLease({
        runId: 'reverse-run-1',
        capability: 'reverse_prompt',
        snapshots: [
          { knowledgeBaseId: 'catalog', version: 1, contentHash: 'd'.repeat(64) },
          { knowledgeBaseId: 'composition', version: 2, contentHash: 'e'.repeat(64) },
        ],
        references,
        citations: [],
      }, { leaseId: 'lease-1', createdAt: '2026-07-22T00:00:00.000Z' }),
      approvedMemorySnapshot: {
        version: 'approved-1',
        approvedAt: '2026-07-22T00:00:00.000Z',
        approvedMemoryIds: [],
      },
      references,
      videoInput: {
        assetId: videoAssetId,
        byteSize: 1_024,
        durationMs: 1_000,
        extension: 'mp4',
        height: 1_080,
        label: 'Launch film',
        mediaType: 'video/mp4',
        origin: 'imported',
        sha256: videoSha256,
        width: 1_920,
      },
    }, {
      createNonce: () => 'nonce-1',
      now: () => '2026-07-22T00:00:00.000Z',
    });
    const request = {
      sessionId: 'desktop-session-1',
      provider: 'comfly',
      run,
      media: [
        { kind: 'image', assetId: imageAssetId, sha256: imageSha256, byteSize: 512, mediaType: 'image/png' },
        { kind: 'video', assetId: videoAssetId, sha256: videoSha256, byteSize: 1_024, mediaType: 'video/mp4' },
      ],
    };
    const result = {
      sessionId: run.sessionId,
      nonce: run.nonce,
      knowledgeSnapshotVersion: run.knowledgeLease.versionKey,
      analysis: 'The product is framed centrally with a soft key light.',
      keywords: ['product', 'soft key light'],
      positivePrompt: 'A centrally framed product with a soft key light.',
      negativeConstraints: ['Do not distort the product.'],
      executionChecklist: ['Check the product silhouette.'],
    };

    expect(parseProviderBridgeRequest('novus-desktop:provider:analyze-reverse-prompt', request)).toEqual(request);
    expect(parseProviderBridgeResponse('novus-desktop:provider:analyze-reverse-prompt', result)).toEqual(result);
    expect(() => parseProviderBridgeRequest('novus-desktop:provider:analyze-reverse-prompt', {
      ...request,
      sessionId: 'https://unsafe.example/session',
    })).toThrow(/provider request is invalid/i);
    expect(() => parseProviderBridgeRequest('novus-desktop:provider:analyze-reverse-prompt', {
      ...request,
      media: [{ ...request.media[0], localPath: 'C:\\private\\source.png' }],
    })).toThrow(/unknown key/i);
    expect(() => parseProviderBridgeRequest('novus-desktop:provider:analyze-reverse-prompt', {
      ...request,
      media: [{ ...request.media[0], bytes: 'AAECAwQFBgcICQoLDA0ODw==' }],
    })).toThrow(/unknown key/i);
    expect(() => parseProviderBridgeRequest('novus-desktop:provider:analyze-reverse-prompt', {
      ...request,
      authorization: `Bearer ${token}`,
    })).toThrow(/unknown key/i);
  });
  it('accepts multiple videos and images only when managed media matches the ordered run exactly', () => {
    const imageA = { assetId: '1'.repeat(16), sha256: '1'.repeat(64), byteSize: 256, label: 'Image A', mediaType: 'image/png' as const, role: 'product_identity' as const };
    const videoA = { assetId: '2'.repeat(16), sha256: '2'.repeat(64), byteSize: 512, durationMs: 1000, extension: 'mp4' as const, height: 1080, label: 'Video A', mediaType: 'video/mp4' as const, origin: 'imported' as const, width: 1920 };
    const imageB = { assetId: '3'.repeat(16), sha256: '3'.repeat(64), byteSize: 768, label: 'Image B', mediaType: 'image/jpeg' as const, role: 'scene_composition' as const };
    const videoB = { assetId: '4'.repeat(16), sha256: '4'.repeat(64), byteSize: 1024, durationMs: 2000, extension: 'mp4' as const, height: 720, label: 'Video B', mediaType: 'video/mp4' as const, origin: 'imported' as const, width: 1280 };
    const references = [
      { assetId: imageA.assetId, label: imageA.label, position: 0, role: imageA.role },
      { assetId: imageB.assetId, label: imageB.label, position: 1, role: imageB.role },
    ];
    const run = createReversePromptRun({
      projectId: 'project-ordered-media',
      skill: { id: 'reverse-prompt', version: 'v1' },
      agentConfig: { modelRoute: 'comfly/gemini-video', role: 'Analyst', task: 'Compare all media.', knowledgeBaseIds: [] },
      knowledgeLease: createAgentKnowledgeLease({ runId: 'reverse-run-ordered', capability: 'reverse_prompt', snapshots: [], references, citations: [] }, { leaseId: 'lease-ordered', createdAt: '2026-08-06T00:00:00.000Z' }),
      approvedMemorySnapshot: { version: 'approved-ordered', approvedAt: '2026-08-06T00:00:00.000Z', approvedMemoryIds: [] },
      references,
      orderedMedia: [
        { kind: 'video', ...videoA, order: 0 },
        { kind: 'image', ...imageA, order: 1 },
        { kind: 'video', ...videoB, order: 2 },
        { kind: 'image', ...imageB, order: 3 },
      ],
    }, { createNonce: () => 'nonce-ordered', now: () => '2026-08-06T00:00:00.000Z' });
    const media = [
      { kind: 'video' as const, assetId: videoA.assetId, sha256: videoA.sha256, byteSize: videoA.byteSize, mediaType: videoA.mediaType },
      { kind: 'image' as const, assetId: imageA.assetId, sha256: imageA.sha256, byteSize: imageA.byteSize, mediaType: imageA.mediaType },
      { kind: 'video' as const, assetId: videoB.assetId, sha256: videoB.sha256, byteSize: videoB.byteSize, mediaType: videoB.mediaType },
      { kind: 'image' as const, assetId: imageB.assetId, sha256: imageB.sha256, byteSize: imageB.byteSize, mediaType: imageB.mediaType },
    ];
    const request = { sessionId: 'desktop-session-ordered', provider: 'comfly', run, media };

    expect(parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.analyzeReversePrompt, request)).toEqual(request);
    expect(() => parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.analyzeReversePrompt, {
      ...request,
      media: [media[1], media[0], media[2], media[3]],
    })).toThrow(/must match the ordered reverse-prompt media exactly/i);
  });
});

describe('secure provider credential storage', () => {
  it.each(['comfly', 'relayme'] as const)(
    'allows an explicit new %s key to replace a safeStorage envelope that this Windows profile can no longer decrypt',
    async (provider) => {
      const appDataRoot = await makeTempRoot();
      const originalStorage = createScopedFakeSafeStorage('old-profile');
      const currentStorage = createScopedFakeSafeStorage('current-profile');
      const original = createSecureProviderCredentialStore({ appDataRoot, provider, safeStorage: originalStorage });
      await original.configure({ token: 'old-provider-key' });

      const recovered = createSecureProviderCredentialStore({ appDataRoot, provider, safeStorage: currentStorage });
      await expect(recovered.getToken()).rejects.toMatchObject({ code: 'CREDENTIALS_LOCKED' });

      await expect(recovered.configure({ token: 'replacement-provider-key' })).resolves.toBeUndefined();
      await expect(recovered.getToken()).resolves.toBe('replacement-provider-key');
      const restarted = createSecureProviderCredentialStore({ appDataRoot, provider, safeStorage: currentStorage });
      await expect(restarted.getToken()).resolves.toBe('replacement-provider-key');
      await cleanupTempRoot(appDataRoot);
    },
  );

  it('keeps the RelayMe key encrypted and available after the desktop service restarts', async () => {
    const appDataRoot = await makeTempRoot();
    const safeStorage = createFakeSafeStorage();
    const store = createSecureProviderCredentialStore({ appDataRoot, provider: 'relayme', safeStorage });

    await store.configure({ token: 'relayme-persisted-key' });

    const restarted = createSecureProviderCredentialStore({ appDataRoot, provider: 'relayme', safeStorage });
    await expect(restarted.getStatus()).resolves.toMatchObject({ configured: true, locked: false, encryption: 'safeStorage' });
    await expect(restarted.getToken()).resolves.toBe('relayme-persisted-key');
    const serialized = await readFile(join(appDataRoot, 'providers', 'relayme', 'provider-credentials.json'), 'utf8');
    expect(serialized).not.toContain('relayme-persisted-key');
    await cleanupTempRoot(appDataRoot);
  });

  it('keeps three image and three reverse tokens encrypted across a store restart', async () => {
    const appDataRoot = await makeTempRoot();
    const safeStorage = createFakeSafeStorage();
    const store = createSecureProviderCredentialStore({ appDataRoot, safeStorage });

    await store.configure({
      token: 'image-token-1',
      imageTokens: ['image-token-1', 'image-token-2', 'image-token-3'],
      reverseTokens: ['reverse-token-1', 'reverse-token-2', 'reverse-token-3'],
    });

    await expect(store.getToken('image')).resolves.toBe('image-token-1');
    await expect(store.getToken('language')).resolves.toBe('reverse-token-1');
    const restarted = createSecureProviderCredentialStore({ appDataRoot, safeStorage });
    await expect(restarted.getToken('image')).resolves.toBe('image-token-1');
    await expect(restarted.getToken('language')).resolves.toBe('reverse-token-1');
    const serialized = await readFile(join(appDataRoot, 'provider-credentials.json'), 'utf8');
    expect(serialized).not.toContain('image-token-1');
    expect(serialized).not.toContain('reverse-token-1');
    await cleanupTempRoot(appDataRoot);
  });

  it('roundtrips with safeStorage without serializing plaintext token', async () => {
    const appDataRoot = await makeTempRoot();
    const safeStorage = createFakeSafeStorage();
    const store = createSecureProviderCredentialStore({ appDataRoot, safeStorage });

    await store.configure({ token });

    expect(await store.getStatus()).toMatchObject({ configured: true, locked: false, encryption: 'safeStorage' });
    await expect(store.getToken()).resolves.toBe(token);
    const serialized = await readFile(join(appDataRoot, 'provider-credentials.json'), 'utf8');
    expect(serialized).not.toContain(token);
    await cleanupTempRoot(appDataRoot);
  });

  it('uses passphrase AES-GCM on legacy fallback and sanitizes wrong passphrases', async () => {
    const appDataRoot = await makeTempRoot();
    const store = createSecureProviderCredentialStore({ appDataRoot, safeStorage: unavailableSafeStorage() });

    await store.configure({ token, passphrase });
    const serialized = await readFile(join(appDataRoot, 'provider-credentials.json'), 'utf8');
    expect(serialized).toMatch(/"version":2/);
    expect(serialized).toMatch(/"ciphertextHex":/);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(passphrase);

    const restarted = createSecureProviderCredentialStore({ appDataRoot, safeStorage: unavailableSafeStorage() });
    expect(await restarted.getStatus()).toMatchObject({ configured: true, locked: true, encryption: 'passphrase' });
    await expect(restarted.unlock({ passphrase: 'wrong passphrase' })).rejects.toMatchObject({
      code: 'CREDENTIALS_LOCKED',
      message: expect.not.stringMatching(/wrong passphrase|sk-task-9|correct horse/i),
    });
    await restarted.unlock({ passphrase });
    await expect(restarted.getToken()).resolves.toBe(token);
    await cleanupTempRoot(appDataRoot);
  });

  it('stays unconfigured when no encryption path is available', async () => {
    const appDataRoot = await makeTempRoot();
    const store = createSecureProviderCredentialStore({ appDataRoot, safeStorage: unavailableSafeStorage() });

    await expect(store.configure({ token })).rejects.toMatchObject({ code: 'CREDENTIALS_LOCKED' });
    expect(await store.getStatus()).toMatchObject({ configured: false, locked: true, encryption: 'unavailable' });
    await expect(readFile(join(appDataRoot, 'provider-credentials.json'), 'utf8')).rejects.toThrow();
    await cleanupTempRoot(appDataRoot);
  });

  it.each(['open', 'write', 'sync', 'rename'] as const)(
    'preserves existing credential bytes when atomic %s fails before target replacement',
    async (phase) => {
      const appDataRoot = await makeTempRoot();
      const safeStorage = createFakeSafeStorage();
      const initial = createSecureProviderCredentialStore({ appDataRoot, safeStorage });
      await initial.configure({ token: 'sk-original-credential-token' });
      const before = await readFile(join(appDataRoot, 'provider-credentials.json'), 'utf8');

      const failing = createSecureProviderCredentialStore({
        appDataRoot,
        safeStorage,
        fileSystem: new FailingAtomicWriteFileSystem('provider-credentials.json', phase),
      });

      await expect(failing.configure({ token: 'sk-rotated-credential-token' })).rejects.toBeTruthy();
      await expect(readFile(join(appDataRoot, 'provider-credentials.json'), 'utf8')).resolves.toBe(before);
      await expect(createSecureProviderCredentialStore({ appDataRoot, safeStorage }).getToken()).resolves.toBe('sk-original-credential-token');
      await cleanupTempRoot(appDataRoot);
    },
  );

  it('restores existing credential bytes when post-replace verification fails inside app data', async () => {
    const appDataRoot = await makeTempRoot();
    const safeStorage = createFakeSafeStorage();
    const initial = createSecureProviderCredentialStore({ appDataRoot, safeStorage });
    await initial.configure({ token: 'sk-original-post-verify-token' });
    const before = await readFile(join(appDataRoot, 'provider-credentials.json'), 'utf8');

    const failing = createSecureProviderCredentialStore({
      appDataRoot,
      safeStorage,
      fileSystem: new PostReplaceVerificationFailureFileSystem(appDataRoot, 'provider-credentials.json'),
    });

    await expect(failing.configure({ token: 'sk-rotated-post-verify-token' })).rejects.toBeTruthy();
    await expect(readFile(join(appDataRoot, 'provider-credentials.json'), 'utf8')).resolves.toBe(before);
    await expect(createSecureProviderCredentialStore({ appDataRoot, safeStorage }).getToken()).resolves.toBe('sk-original-post-verify-token');
    await cleanupTempRoot(appDataRoot);
  });

  it('keeps legacy credential bytes when migration write fails before target replacement', async () => {
    const appDataRoot = await makeTempRoot();
    const safeStorage = createFakeSafeStorage();
    await writeLegacySafeStorageCredential(appDataRoot, safeStorage, 'sk-legacy-migration-token');
    const before = await readFile(join(appDataRoot, 'provider-credentials.json'), 'utf8');

    const failing = createSecureProviderCredentialStore({
      appDataRoot,
      safeStorage,
      fileSystem: new FailingAtomicWriteFileSystem('provider-credentials.json', 'sync'),
    });

    await expect(failing.getToken()).rejects.toBeTruthy();
    await expect(readFile(join(appDataRoot, 'provider-credentials.json'), 'utf8')).resolves.toBe(before);
    await expect(createSecureProviderCredentialStore({ appDataRoot, safeStorage }).getToken()).resolves.toBe('sk-legacy-migration-token');
    await cleanupTempRoot(appDataRoot);
  });
});

describe('Comfly provider service', () => {
  it('pins active managed knowledge for chat and returns only safe source summaries', async () => {
    const appDataRoot = await makeTempRoot();
    const knowledgeStore = new ManagedKnowledgeStore({ appDataRoot });
    await publishKnowledgeSnapshot(knowledgeStore, 'catalog', 'Catalog', 'prompts/catalog.md', 'Keep the product silhouette clear.');
    const fetch = vi.fn(async () => jsonResponse({
      id: 'chat-response-1',
      model: 'provider-skill-chat',
      choices: [{ message: { role: 'assistant', content: 'Use a clear silhouette and a restrained background.' } }],
    }));
    const credentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() });
    const projectMemoryContextResolver = {
      resolveSelectedProjectMemory: vi.fn(async () => [{
        memoryId: 'project-memory-1',
        projectRevision: 24,
        summary: 'Keep the product silhouette clear and the background restrained.',
      }]),
    };
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore,
      fetch,
      profiles: [{
        provider: 'comfly',
        modelRoute: 'skill-chat',
        modelId: 'provider-skill-chat',
        displayName: 'Skill Chat',
        capabilities: ['chat'],
      }],
      projectMemoryContextResolver,
    });
    await service.configure({ token });

    await expect(service.chat?.({
      provider: 'comfly',
      modelRoute: 'skill-chat',
      messages: [{ role: 'user', content: 'How should I frame this product?' }],
      context: { knowledgeBaseIds: ['catalog'], projectMemoryIds: ['project-memory-1'] },
    })).resolves.toEqual({
      message: 'Use a clear silhouette and a restrained background.',
      modelRoute: 'skill-chat',
      sources: [{ knowledgeBaseId: 'catalog', version: 1, displayName: 'Catalog' }],
    });

    const payload = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, { body?: string }])[1].body)) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(payload.model).toBe('provider-skill-chat');
    expect(payload.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'How should I frame this product?' }),
      expect.objectContaining({ role: 'system', content: expect.stringContaining('Keep the product silhouette clear.') }),
    ]));
    expect(projectMemoryContextResolver.resolveSelectedProjectMemory).toHaveBeenCalledWith(['project-memory-1']);
    const systemMessage = payload.messages.find((message) => message.role === 'system')?.content ?? '';
    expect(systemMessage).toContain('"projectRevision":24');
    expect(systemMessage).not.toContain('"projectMemoryIds"');
    expect(JSON.stringify(payload)).not.toMatch(/C:\\|https?:\/\//i);
    await cleanupTempRoot(appDataRoot);
  });

  it('rejects selected project memory when no controlled main-process resolver is configured', async () => {
    const appDataRoot = await makeTempRoot();
    const fetch = vi.fn();
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() }),
      fetch,
      profiles: [{
        provider: 'comfly',
        modelRoute: 'skill-chat',
        displayName: 'Skill Chat',
        capabilities: ['chat'],
      }],
    });
    await service.configure({ token });

    await expect(service.chat?.({
      provider: 'comfly',
      modelRoute: 'skill-chat',
      messages: [{ role: 'user', content: 'Use the approved project direction.' }],
      context: { knowledgeBaseIds: [], projectMemoryIds: ['project-memory-1'] },
    })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(fetch).not.toHaveBeenCalled();
    await cleanupTempRoot(appDataRoot);
  });

  it('rejects controlled image references on a chat route without vision capability before transport', async () => {
    const appDataRoot = await makeTempRoot();
    const fetch = vi.fn();
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() }),
      fetch,
      profiles: [{
        provider: 'comfly',
        modelRoute: 'text-only-skill-chat',
        displayName: 'Text only Skill Chat',
        capabilities: ['chat'],
      }],
    });
    await service.configure({ token });

    await expect(service.chat?.({
      provider: 'comfly',
      modelRoute: 'text-only-skill-chat',
      sessionId: 'desktop-session-1',
      referenceAssetIds: ['a'.repeat(16)],
      messages: [{ role: 'user', content: 'Analyze the selected managed image.' }],
      context: { knowledgeBaseIds: [], projectMemoryIds: [] },
    })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(fetch).not.toHaveBeenCalled();
    await cleanupTempRoot(appDataRoot);
  });

  it('uses only main-process resolved managed image bytes for a vision Skill chat request', async () => {
    const appDataRoot = await makeTempRoot();
    const fetch = vi.fn(async () => jsonResponse({
      id: 'chat-response-vision-1',
      model: 'provider-vision-skill-chat',
      choices: [{ message: { role: 'assistant', content: 'The managed image has a centered product.' } }],
    }));
    const readManagedSkillChatImages = vi.fn(async () => [{
      bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
      mediaType: 'image/png' as const,
    }]);
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() }),
      fetch,
      profiles: [{
        provider: 'comfly',
        modelRoute: 'vision-skill-chat',
        modelId: 'provider-vision-skill-chat',
        displayName: 'Vision Skill Chat',
        capabilities: ['chat', 'vision'],
      }],
      readManagedSkillChatImages,
    });
    await service.configure({ token });

    await expect(service.chat?.({
      provider: 'comfly',
      modelRoute: 'vision-skill-chat',
      sessionId: 'desktop-session-1',
      referenceAssetIds: ['a'.repeat(16)],
      messages: [{ role: 'user', content: 'Analyze the selected managed image.' }],
      context: { knowledgeBaseIds: [], projectMemoryIds: [] },
    })).resolves.toMatchObject({ message: 'The managed image has a centered product.' });

    expect(readManagedSkillChatImages).toHaveBeenCalledWith('desktop-session-1', ['a'.repeat(16)]);
    const payload = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, { body?: string }])[1].body)) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const userMessage = payload.messages.find((message) => message.role === 'user');
    expect(userMessage?.content).toEqual([
      { type: 'text', text: 'Analyze the selected managed image.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw==' } },
    ]);
    expect(JSON.stringify(payload)).not.toMatch(/C:\\|https?:\/\//i);
    await cleanupTempRoot(appDataRoot);
  });

  it('rejects unsafe project-memory resolver summaries before provider transport', async () => {
    const appDataRoot = await makeTempRoot();
    const fetch = vi.fn();
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() }),
      fetch,
      profiles: [{
        provider: 'comfly',
        modelRoute: 'skill-chat',
        displayName: 'Skill Chat',
        capabilities: ['chat'],
      }],
      projectMemoryContextResolver: {
        resolveSelectedProjectMemory: async () => [{
          memoryId: 'project-memory-1',
          projectRevision: 24,
          summary: 'Read C:/Users/private/project-memory.json',
        }],
      },
    });
    await service.configure({ token });

    await expect(service.chat?.({
      provider: 'comfly',
      modelRoute: 'skill-chat',
      messages: [{ role: 'user', content: 'Use the approved project direction.' }],
      context: { knowledgeBaseIds: [], projectMemoryIds: ['project-memory-1'] },
    })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(fetch).not.toHaveBeenCalled();
    await cleanupTempRoot(appDataRoot);
  });

  it('rejects chat calls for configured routes without chat capability before transport', async () => {
    const appDataRoot = await makeTempRoot();
    const fetch = vi.fn();
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() }),
      fetch,
      profiles,
    });
    await service.configure({ token });

    await expect(service.chat?.({
      provider: 'comfly',
      modelRoute: 'gpt-image',
      messages: [{ role: 'user', content: 'Give me composition advice.' }],
      context: { knowledgeBaseIds: [], projectMemoryIds: [] },
    })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(fetch).not.toHaveBeenCalled();
    await cleanupTempRoot(appDataRoot);
  });

  it('runs image-only reverse analysis through a catalog-discovered OpenAI-compatible vision chat route', async () => {
    const appDataRoot = await makeTempRoot();
    const knowledgeStore = new ManagedKnowledgeStore({ appDataRoot });
    const request = await createReversePromptRequestWithManagedKnowledge(appDataRoot, knowledgeStore);
    const imageOnlyRequest = {
      ...request,
      run: { ...request.run, agentConfig: { ...request.run.agentConfig!, modelRoute: 'comfly-vision-chat' }, orderedMedia: [request.run.orderedMedia[0]!], videoInput: undefined },
      media: [request.media[0]!],
    };
    const fetch = vi.fn(async () => jsonResponse({
      id: 'reverse-chat-1', model: 'vision-chat-model',
      choices: [{ message: { role: 'assistant', content: JSON.stringify(reversePromptResultFor(imageOnlyRequest.run)) } }],
    }));
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() }),
      fetch,
      profiles: [{
        provider: 'comfly', modelRoute: 'comfly-vision-chat', modelId: 'vision-chat-model', displayName: 'Vision Chat',
        capabilities: ['chat', 'vision', 'reverse_prompt'],
      }],
      readManagedReverseMedia: async () => [{ bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), mediaType: 'image/png' }],
    });
    await service.configure({ token });

    await expect(service.analyzeReversePrompt?.(imageOnlyRequest)).resolves.toEqual(reversePromptResultFor(imageOnlyRequest.run));
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/v1\/chat\/completions$/u), expect.objectContaining({ method: 'POST' }));
    const payload = JSON.parse(String((fetch.mock.calls[0] as unknown as readonly [string, { readonly body?: unknown }])[1]?.body)) as {
      messages: Array<{ content: unknown }>;
    };
    expect(JSON.stringify(payload.messages)).toContain('data:image/png;base64,iVBORw==');
    expect(JSON.stringify(payload.messages)).toContain('Catalog guidance.');
    await cleanupTempRoot(appDataRoot);
  });

  it('reports a retryable truncation when an OpenAI-compatible reverse chat finishes because of length', async () => {
    const appDataRoot = await makeTempRoot();
    const knowledgeStore = new ManagedKnowledgeStore({ appDataRoot });
    const request = await createReversePromptRequestWithManagedKnowledge(appDataRoot, knowledgeStore);
    const imageOnlyRequest = {
      ...request,
      run: { ...request.run, agentConfig: { ...request.run.agentConfig!, modelRoute: 'comfly-vision-chat' }, orderedMedia: [request.run.orderedMedia[0]!], videoInput: undefined },
      media: [request.media[0]!],
    };
    const fetch = vi.fn(async () => jsonResponse({
      id: 'reverse-chat-length', model: 'vision-chat-model',
      choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '{"analysis":"truncated' } }],
    }));
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() }),
      fetch,
      profiles: [{
        provider: 'comfly', modelRoute: 'comfly-vision-chat', modelId: 'vision-chat-model', displayName: 'Vision Chat',
        capabilities: ['chat', 'vision', 'reverse_prompt'],
      }],
      readManagedReverseMedia: async () => [{ bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), mediaType: 'image/png' }],
    });
    await service.configure({ token });

    await expect(service.analyzeReversePrompt?.(imageOnlyRequest)).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_RESPONSE',
      message: 'Reverse-analysis response was truncated at the model output limit',
      retryable: true,
    });

    await cleanupTempRoot(appDataRoot);
  });

  it('uses a vision dialogue model for reverse analysis even without a derived reverse tag', async () => {
    vi.useFakeTimers();
    const appDataRoot = await makeTempRoot();
    try {
      const knowledgeStore = new ManagedKnowledgeStore({ appDataRoot });
      const request = await createReversePromptRequestWithManagedKnowledge(appDataRoot, knowledgeStore);
      const imageOnlyRequest = {
        ...request,
        run: {
          ...request.run,
          agentConfig: { ...request.run.agentConfig!, modelRoute: 'comfly-vision-chat' },
          orderedMedia: [request.run.orderedMedia[0]!],
          videoInput: undefined,
        },
        media: [request.media[0]!],
      };
      let capturedSignal: AbortSignal | undefined;
      let resolveFetchStarted!: () => void;
      const fetchStarted = new Promise<void>((resolve) => { resolveFetchStarted = resolve; });
      let resolveFetch!: (value: ReturnType<typeof jsonResponse>) => void;
      const fetch = vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
        capturedSignal = init?.signal;
        resolveFetchStarted();
        return new Promise<ReturnType<typeof jsonResponse>>((resolve) => { resolveFetch = resolve; });
      });
      const service = createComflyProviderService({
        appDataRoot,
        credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() }),
        fetch,
        profiles: [{
          provider: 'comfly', modelRoute: 'comfly-vision-chat', modelId: 'vision-chat-model', displayName: 'Vision Chat',
          capabilities: ['chat', 'vision'],
        }],
        readManagedReverseMedia: async () => [{
          bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
          mediaType: 'image/png',
        }],
      });
      await service.configure({ token });

      const pending = service.analyzeReversePrompt!(imageOnlyRequest);
      await fetchStarted;
      await vi.advanceTimersByTimeAsync(30_001);
      expect(capturedSignal?.aborted).toBe(false);
      resolveFetch(jsonResponse({
        id: 'reverse-response',
        model: 'vision-chat-model',
        choices: [{ message: { role: 'assistant', content: JSON.stringify(reversePromptResultFor(imageOnlyRequest.run)) } }],
      }));
      await expect(pending).resolves.toEqual(reversePromptResultFor(imageOnlyRequest.run));
    } finally {
      vi.useRealTimers();
      await cleanupTempRoot(appDataRoot);
    }
  });

  it('keeps Gemini-native reverse alive after 30 seconds and forwards its five minute timeout', async () => {
    vi.useFakeTimers();
    const appDataRoot = await makeTempRoot();
    try {
      const knowledgeStore = new ManagedKnowledgeStore({ appDataRoot });
      const request = await createReversePromptRequestWithManagedKnowledge(appDataRoot, knowledgeStore);
      let capturedSignal: AbortSignal | undefined;
      let capturedTimeoutMs: number | undefined;
      let resolveFetchStarted!: () => void;
      const fetchStarted = new Promise<void>((resolve) => { resolveFetchStarted = resolve; });
      let resolveFetch!: (value: ReturnType<typeof jsonResponse>) => void;
      const fetch = vi.fn(async (_url: string, init?: { signal?: AbortSignal; timeoutMs?: number }) => {
        capturedSignal = init?.signal;
        capturedTimeoutMs = init?.timeoutMs;
        resolveFetchStarted();
        return new Promise<ReturnType<typeof jsonResponse>>((resolve) => { resolveFetch = resolve; });
      });
      const service = createComflyProviderService({
        appDataRoot,
        credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() }),
        fetch,
        profiles: [geminiReverseProfile()],
        readManagedReverseMedia: async () => [
          { bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), mediaType: 'image/png' },
          { bytes: Uint8Array.from([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70]), mediaType: 'video/mp4' },
        ],
      });
      await service.configure({ token });

      const pending = service.analyzeReversePrompt!(request);
      await fetchStarted;
      expect(capturedTimeoutMs).toBe(300_000);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(capturedSignal?.aborted).toBe(false);
      resolveFetch(jsonResponse({
        candidates: [{ content: { parts: [{ text: JSON.stringify(reversePromptResultFor(request.run)) }] } }],
      }));
      await expect(pending).resolves.toEqual(reversePromptResultFor(request.run));
    } finally {
      vi.useRealTimers();
      await cleanupTempRoot(appDataRoot);
    }
  });

  it('sends pinned managed knowledge bodies and original managed media to the Gemini-compatible route', async () => {
    const appDataRoot = await makeTempRoot();
    const knowledgeStore = new ManagedKnowledgeStore({ appDataRoot });
    const request = await createReversePromptRequestWithManagedKnowledge(appDataRoot, knowledgeStore);
    const fetch = vi.fn(async () => jsonResponse({
      candidates: [{ content: { parts: [{ text: JSON.stringify(reversePromptResultFor(request.run)) }] } }],
    }));
    const credentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() });
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore,
      fetch,
      profiles: [geminiReverseProfile()],
      readManagedReverseMedia: async () => [
        { bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), mediaType: 'image/png' },
        { bytes: Uint8Array.from([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70]), mediaType: 'video/mp4' },
      ],
    });
    await service.configure({ token });

    await expect(service.analyzeReversePrompt?.(request)).resolves.toEqual(reversePromptResultFor(request.run));

    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1beta\/models\/gemini-video-provider-id:generateContent$/u),
      expect.objectContaining({ method: 'POST' }),
    );
    const fetchCall = fetch.mock.calls[0] as unknown as readonly [string, { readonly body?: unknown }];
    const payload = JSON.parse(String(fetchCall[1]?.body)) as {
      generationConfig?: { responseMimeType?: string; maxOutputTokens?: number };
      contents: Array<{ parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> }>;
    };
    expect(payload.generationConfig).toEqual({ responseMimeType: 'application/json', maxOutputTokens: 16_384 });
    const parts = payload.contents[0]?.parts ?? [];
    const requestText = JSON.parse(parts[0]?.text ?? '{}') as {
      builtinSkills?: Array<{ id?: string; version?: string }>;
      knowledge?: unknown[];
      mediaManifest?: Array<{ mention?: string }>;
      requiredOutput?: Record<string, unknown>;
    };
    expect(requestText.builtinSkills).toEqual([expect.objectContaining({
      id: 'seedance-2-5-reverse',
      version: '2026-08-21.1',
    })]);
    expect(requestText.knowledge).toHaveLength(2);
    expect(requestText.knowledge).toEqual([
      expect.objectContaining({ knowledgeBaseId: 'catalog', documents: [{ relativePath: 'prompts/catalog.md', content: 'Catalog guidance.' }] }),
      expect.objectContaining({ knowledgeBaseId: 'composition', documents: [{ relativePath: 'prompts/composition.md', content: 'Composition guidance.' }] }),
    ]);
    expect(requestText.requiredOutput).toEqual(expect.objectContaining({
      sessionId: request.run.sessionId,
      nonce: request.run.nonce,
      knowledgeSnapshotVersion: request.run.knowledgeLease.versionKey,
      analysis: expect.stringMatching(/空间|材质|镜头/u),
      keywords: [expect.stringMatching(/关键词/u)],
      positivePrompt: expect.stringMatching(/提示词/u),
      positivePromptZh: expect.stringMatching(/中文/u),
      positivePromptEn: expect.stringMatching(/English/u),
      mediaResponsibilities: expect.any(Array),
      materialsAndTextures: expect.any(Array),
      effects: expect.any(Array),
      fluids: expect.any(Array),
      videoTimeline: expect.any(Array),
      whiteBackgroundAdaptation: expect.any(Object),
      promptLogic: expect.any(Object),
      seedance25: expect.any(Object),
      negativeConstraints: [expect.stringMatching(/约束/u)],
      executionChecklist: [expect.stringMatching(/检查/u)],
    }));
    expect(parts.slice(1)).toEqual([
      { inlineData: { mimeType: 'image/png', data: 'iVBORw==' } },
      { inlineData: { mimeType: 'video/mp4', data: 'AAAAAGZ0eXA=' } },
    ]);
    await cleanupTempRoot(appDataRoot);
  });

  it('preserves every interleaved image and video when sending ordered reverse media', async () => {
    const appDataRoot = await makeTempRoot();
    const request = createOrderedMultiReversePromptRequest();
    const fetch = vi.fn(async () => jsonResponse({
      candidates: [{ content: { parts: [{ text: JSON.stringify(reversePromptResultFor(request.run)) }] } }],
    }));
    const readManagedReverseMedia = vi.fn(async () => [
      { bytes: Uint8Array.from([1]), mediaType: 'video/mp4' },
      { bytes: Uint8Array.from([2]), mediaType: 'image/png' },
      { bytes: Uint8Array.from([3]), mediaType: 'video/mp4' },
      { bytes: Uint8Array.from([4]), mediaType: 'image/jpeg' },
    ] as const);
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() }),
      fetch,
      profiles: [geminiReverseProfile()],
      readManagedReverseMedia,
    });
    await service.configure({ token });

    await expect(service.analyzeReversePrompt?.(request)).resolves.toEqual(reversePromptResultFor(request.run));
    expect(readManagedReverseMedia).toHaveBeenCalledWith(request.sessionId, request.media);
    const fetchCall = fetch.mock.calls[0] as unknown as readonly [string, { readonly body?: unknown }];
    const payload = JSON.parse(String(fetchCall[1]?.body)) as { contents: Array<{ parts: Array<{ inlineData?: { mimeType: string; data: string } }> }> };
    expect(payload.contents[0]?.parts.slice(1)).toEqual([
      { inlineData: { mimeType: 'video/mp4', data: 'AQ==' } },
      { inlineData: { mimeType: 'image/png', data: 'Ag==' } },
      { inlineData: { mimeType: 'video/mp4', data: 'Aw==' } },
      { inlineData: { mimeType: 'image/jpeg', data: 'BA==' } },
    ]);
    await cleanupTempRoot(appDataRoot);
  });

  it('requires video understanding whenever ordered reverse media contains videos', async () => {
    const appDataRoot = await makeTempRoot();
    const request = createOrderedMultiReversePromptRequest();
    const fetch = vi.fn();
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() }),
      fetch,
      profiles: [{ ...geminiReverseProfile(), capabilities: ['gemini_native', 'reverse_prompt'] }],
      readManagedReverseMedia: async () => [],
    });
    await service.configure({ token });

    await expect(service.analyzeReversePrompt?.(request)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(fetch).not.toHaveBeenCalled();
    await cleanupTempRoot(appDataRoot);
  });
  it('rejects a Gemini reverse-analysis result whose identity does not match the pinned run', async () => {
    const appDataRoot = await makeTempRoot();
    const knowledgeStore = new ManagedKnowledgeStore({ appDataRoot });
    const request = await createReversePromptRequestWithManagedKnowledge(appDataRoot, knowledgeStore);
    const fetch = vi.fn(async () => jsonResponse({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        ...reversePromptResultFor(request.run),
        sessionId: 'different-session',
      }) }] } }],
    }));
    const credentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() });
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore,
      fetch,
      profiles: [geminiReverseProfile()],
      readManagedReverseMedia: async () => [
        { bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), mediaType: 'image/png' },
        { bytes: Uint8Array.from([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70]), mediaType: 'video/mp4' },
      ],
    });
    await service.configure({ token });

    await expect(service.analyzeReversePrompt?.(request)).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_RESPONSE',
      message: 'Reverse-analysis response identity does not match the active run',
      retryable: false,
    });

    await cleanupTempRoot(appDataRoot);
  });

  it('accepts a complete Gemini reverse core result when an optional professional section is malformed', async () => {
    const appDataRoot = await makeTempRoot();
    const request = await createReversePromptRequestWithManagedKnowledge(appDataRoot, new ManagedKnowledgeStore({ appDataRoot }));
    const fetch = vi.fn(async () => jsonResponse({
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({
        ...reversePromptResultFor(request.run),
        camera: 'wide-angle',
      }) }] } }],
    }));
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() }),
      fetch,
      profiles: [geminiReverseProfile()],
      readManagedReverseMedia: async () => [],
    });
    await service.configure({ token });

    await expect(service.analyzeReversePrompt?.(request)).resolves.toEqual(reversePromptResultFor(request.run));

    await cleanupTempRoot(appDataRoot);
  });

  it('rejects malformed media responsibilities instead of dropping the provider section', async () => {
    const appDataRoot = await makeTempRoot();
    const request = await createReversePromptRequestWithManagedKnowledge(appDataRoot, new ManagedKnowledgeStore({ appDataRoot }));
    const fetch = vi.fn(async () => jsonResponse({
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({
        ...reversePromptResultFor(request.run),
        mediaResponsibilities: [{ sourceId: request.run.orderedMedia[0]!.assetId }],
      }) }] } }],
    }));
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() }),
      fetch,
      profiles: [geminiReverseProfile()],
      readManagedReverseMedia: async () => [],
    });
    await service.configure({ token });

    await expect(service.analyzeReversePrompt?.(request)).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_RESPONSE',
      message: 'Reverse-analysis response failed schema validation',
    });

    await cleanupTempRoot(appDataRoot);
  });

  it('reports a retryable truncation when Gemini stops at its output token limit', async () => {
    const appDataRoot = await makeTempRoot();
    const request = await createReversePromptRequestWithManagedKnowledge(appDataRoot, new ManagedKnowledgeStore({ appDataRoot }));
    const fetch = vi.fn(async () => jsonResponse({
      candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"analysis":"truncated' }] } }],
    }));
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() }),
      fetch,
      profiles: [geminiReverseProfile()],
      readManagedReverseMedia: async () => [],
    });
    await service.configure({ token });

    await expect(service.analyzeReversePrompt?.(request)).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_RESPONSE',
      message: 'Reverse-analysis response was truncated at the model output limit',
      retryable: true,
    });

    await cleanupTempRoot(appDataRoot);
  });

  it.each([
    ['has no text candidate', { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'iVBORw==' } }] } }] }, 'Reverse-analysis response did not contain text'],
    ['returns malformed JSON text', { candidates: [{ content: { parts: [{ text: '{not-json' }] } }] }, 'Reverse-analysis response was not valid JSON'],
    ['returns JSON rejected by the reverse-analysis response schema', { candidates: [{ content: { parts: [{ text: JSON.stringify({ sessionId: 'session', nonce: 'nonce' }) }] } }] }, 'Reverse-analysis response failed schema validation'],
  ])('surfaces a sanitized PROVIDER_INVALID_RESPONSE when Gemini %s', async (_caseName, response, expectedMessage) => {
    const appDataRoot = await makeTempRoot();
    const request = await createReversePromptRequestWithManagedKnowledge(appDataRoot, new ManagedKnowledgeStore({ appDataRoot }));
    const fetch = vi.fn(async () => jsonResponse(response));
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() }),
      fetch,
      profiles: [geminiReverseProfile()],
      readManagedReverseMedia: async () => [],
    });
    await service.configure({ token });

    await expect(service.analyzeReversePrompt?.(request)).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_RESPONSE',
      message: expectedMessage,
    });

    await cleanupTempRoot(appDataRoot);
  });

  it.each([
    ['is missing', [] as ProviderBridgeProfile[]],
    ['does not support Gemini-native reverse analysis', [{ ...geminiReverseProfile(), capabilities: ['reverse_prompt'] as ProviderBridgeProfile['capabilities'] }]],
    ['does not support video understanding for an MP4 run', [{ ...geminiReverseProfile(), capabilities: ['gemini_native', 'reverse_prompt'] as ProviderBridgeProfile['capabilities'] }]],
  ])('rejects before Provider transport when the reverse-analysis profile %s', async (_caseName, profiles) => {
    const appDataRoot = await makeTempRoot();
    const request = await createReversePromptRequestWithManagedKnowledge(appDataRoot, new ManagedKnowledgeStore({ appDataRoot }));
    const fetch = vi.fn();
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() }),
      fetch,
      profiles,
      readManagedReverseMedia: async () => [],
    });
    await service.configure({ token });

    await expect(service.analyzeReversePrompt?.(request)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(fetch).not.toHaveBeenCalled();

    await cleanupTempRoot(appDataRoot);
  });

  it('rejects missing pinned knowledge before calling the Provider', async () => {
    const knowledgeRoot = await makeTempRoot();
    const request = await createReversePromptRequestWithManagedKnowledge(knowledgeRoot, new ManagedKnowledgeStore({ appDataRoot: knowledgeRoot }));
    const appDataRoot = await makeTempRoot();
    const fetch = vi.fn();
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() }),
      fetch,
      profiles: [geminiReverseProfile()],
      readManagedReverseMedia: async () => [],
    });
    await service.configure({ token });

    await expect(service.analyzeReversePrompt?.(request)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(fetch).not.toHaveBeenCalled();

    await cleanupTempRoot(knowledgeRoot);
    await cleanupTempRoot(appDataRoot);
  });

  it('rejects a pinned knowledge hash mismatch before calling the Provider', async () => {
    const appDataRoot = await makeTempRoot();
    const request = await createReversePromptRequestWithManagedKnowledge(appDataRoot, new ManagedKnowledgeStore({ appDataRoot }));
    const fetch = vi.fn();
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() }),
      fetch,
      profiles: [geminiReverseProfile()],
      readManagedReverseMedia: async () => [],
    });
    await service.configure({ token });
    const mismatched = {
      ...request,
      run: {
        ...request.run,
        knowledgeLease: createAgentKnowledgeLease({
          runId: 'reverse-run-1',
          capability: 'reverse_prompt',
          snapshots: [{ ...request.run.knowledgeLease.snapshots[0]!, contentHash: 'f'.repeat(64) }, request.run.knowledgeLease.snapshots[1]!],
          references: request.run.references,
          citations: [],
        }, { leaseId: 'lease-1', createdAt: '2026-07-22T00:00:00.000Z' }),
      },
    };

    await expect(service.analyzeReversePrompt?.(mismatched)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(fetch).not.toHaveBeenCalled();

    await cleanupTempRoot(appDataRoot);
  });

  it('rejects reverse analysis when the managed media resolver is unavailable', async () => {
    const appDataRoot = await makeTempRoot();
    const request = await createReversePromptRequestWithManagedKnowledge(appDataRoot, new ManagedKnowledgeStore({ appDataRoot }));
    const fetch = vi.fn();
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() }),
      fetch,
      profiles: [geminiReverseProfile()],
    });
    await service.configure({ token });

    await expect(service.analyzeReversePrompt?.(request)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(fetch).not.toHaveBeenCalled();

    await cleanupTempRoot(appDataRoot);
  });

  it('rejects an MP4 larger than 20 MiB before reading managed media', async () => {
    const appDataRoot = await makeTempRoot();
    const request = await createReversePromptRequestWithManagedKnowledge(appDataRoot, new ManagedKnowledgeStore({ appDataRoot }));
    const fetch = vi.fn();
    const readManagedReverseMedia = vi.fn(async () => []);
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() }),
      fetch,
      profiles: [geminiReverseProfile()],
      readManagedReverseMedia,
    });
    await service.configure({ token });
    const byteSize = 20 * 1024 * 1024 + 1;
    const oversized = {
      ...request,
      run: { ...request.run, videoInput: { ...request.run.videoInput!, byteSize } },
      media: [request.media[0]!, { ...request.media[1]!, byteSize }],
    };

    await expect(service.analyzeReversePrompt?.(oversized)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(readManagedReverseMedia).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    await cleanupTempRoot(appDataRoot);
  });

  it('checks credentials through the free models endpoint without creating a provider job', async () => {
    const appDataRoot = await makeTempRoot();
    const fetch = vi.fn(async () => jsonResponse({ data: [{ id: 'private-model-id' }], object: 'list' }));
    const credentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() });
    const service = createComflyProviderService({ appDataRoot, credentialStore, fetch, profiles });

    await expect(service.checkConnection()).resolves.toMatchObject({ status: 'unconfigured' });
    expect(fetch).not.toHaveBeenCalled();
    await service.configure({ token });
    await expect(service.checkConnection()).resolves.toMatchObject({ status: 'connected' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/v1\/models$/u), expect.objectContaining({ method: 'GET' }));
    await cleanupTempRoot(appDataRoot);
  });

  it('reads account-visible model ids through the configured Comfly connection', async () => {
    const appDataRoot = await makeTempRoot();
    const fetch = vi.fn(async () => jsonResponse({
      object: 'list',
      data: [{ id: 'gpt-image-2' }, { id: 'gemini-3.1-flash-lite' }, { id: null }],
    }));
    const credentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() });
    const service = createComflyProviderService({ appDataRoot, credentialStore, fetch, profiles });
    await service.configure({ token });

    await expect(service.listAvailableModelIds()).resolves.toEqual(['gpt-image-2', 'gemini-3.1-flash-lite']);
    expect(fetch).toHaveBeenCalledWith('https://ai.comfly.org/v1/models', expect.objectContaining({ method: 'GET' }));
    await cleanupTempRoot(appDataRoot);
  });

  it('returns an empty profile inventory when no profiles are configured', async () => {
    const appDataRoot = await makeTempRoot();
    const credentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() });
    const service = createComflyProviderService({ appDataRoot, credentialStore, fetch: vi.fn() });

    await expect(service.listProfiles()).resolves.toEqual([]);
    await service.configure({ token });
    await expect(service.listProfiles()).resolves.toEqual([]);
    await cleanupTempRoot(appDataRoot);
  });
  it('lists sanitized dynamic profiles only when credentials are unlocked', async () => {
    const appDataRoot = await makeTempRoot();
    const credentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() });
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore,
      fetch: vi.fn(),
      profiles,
    });

    expect(await service.getStatus()).toMatchObject({ configured: false, locked: true });
    const listedBeforeConfigure = await service.listProfiles();
    await service.configure({ token });
    const listed = await service.listProfiles();
    expect(listedBeforeConfigure).toEqual(listed);
    expect(listed).toMatchObject([
      { provider: 'comfly', modelRoute: 'gpt-image', displayName: 'GPT Image' },
      { provider: 'comfly', modelRoute: 'nano-banana-2', displayName: 'Nano Banana 2' },
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/token|secret|Authorization|sk-task/i);
    await cleanupTempRoot(appDataRoot);
  });

  it('executes a dynamically discovered Comfly image model immediately after the key is saved', async () => {
    const appDataRoot = await makeTempRoot();
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/models')) return jsonResponse({ object: 'list', data: [{ id: 'gpt-image-2' }] });
      if (url.endsWith('/api/models/price')) return jsonResponse({ data: {
        version: 'catalog-runtime-v1',
        models: [{ key: 'gpt-image-2', name: 'GPT Image 2', provider: 'OpenAI', tags: '绘图,异步任务', apis: ['POST-/v1/images/generations-1'] }],
      } });
      if (url.endsWith('/v1/images/generations?async=true')) return jsonResponse({ taskId: 'dynamic-image-task', status: 'queued' });
      throw new Error(`unexpected URL: ${url}`);
    });
    const credentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() });
    const service = createComflyProviderService({ appDataRoot, credentialStore, fetch, discoverModelCatalog: true });
    await service.configure({ token });

    await expect(service.listProfiles()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ modelRoute: 'comfly-gpt-image-2', modelId: 'gpt-image-2', capabilities: expect.arrayContaining(['image_generation']) }),
    ]));
    await expect(service.submitImageJob({
      jobId: 'model-job-v2-dynamic-image',
      provider: 'comfly',
      modelRoute: 'comfly-gpt-image-2',
      prompt: 'draw a product scene',
      conversationId: 'conversation-dynamic-image',
      referenceAssetIds: [],
      aspectRatio: '16:9',
      resolution: '2K',
      outputCount: 1,
    })).resolves.toEqual({ providerTaskId: expect.stringMatching(/^provider-job-/u) });
    expect(fetch).toHaveBeenCalledWith('https://ai.comfly.org/v1/images/generations?async=true', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ authorization: `Bearer ${token}` }),
      body: expect.stringContaining('"model":"gpt-image-2"'),
    }));
    await cleanupTempRoot(appDataRoot);
  });

  it('stores a synchronous Comfly image result for models without async task support', async () => {
    const appDataRoot = await makeTempRoot();
    const storeGeneratedImage = vi.fn(async () => ({ assetId: 'abcdef0123456789', width: 1024, height: 1024 }));
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/models')) return jsonResponse({ object: 'list', data: [{ id: 'nano-banana-2' }] });
      if (url.endsWith('/api/models/price')) return jsonResponse({ data: {
        version: 'catalog-sync-image-v1',
        models: [{
          key: 'nano-banana-2',
          name: 'Nano Banana 2',
          provider: 'Google',
          tags: '对话',
          apis: ['POST-/v1/chat/completions-1', 'POST-/v1/images/generations-2'],
        }],
      } });
      if (url.endsWith('/v1/images/generations')) return jsonResponse({ data: [{ b64_json: 'iVBORw0KGgo=' }] });
      throw new Error(`unexpected URL: ${url}`);
    });
    const credentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() });
    const service = createComflyProviderService({ appDataRoot, credentialStore, fetch, discoverModelCatalog: true, storeGeneratedImage });
    await service.configure({ token });

    const submitted = await service.submitImageJob({
      jobId: 'model-job-v2-sync-image',
      provider: 'comfly',
      modelRoute: 'comfly-nano-banana-2',
      prompt: 'draw a product scene',
      conversationId: 'conversation-sync-image',
      sessionId: 'desktop-session-sync-image',
      referenceAssetIds: [],
    });

    await expect(service.pollImageJob({ provider: 'comfly', providerTaskId: submitted.providerTaskId })).resolves.toEqual({
      status: 'completed',
      progress: 1,
      result: { assetId: 'abcdef0123456789', width: 1024, height: 1024 },
    });
    expect(fetch).toHaveBeenCalledWith('https://ai.comfly.org/v1/images/generations', expect.objectContaining({ method: 'POST' }));
    expect(storeGeneratedImage).toHaveBeenCalledWith('desktop-session-sync-image', expect.any(Uint8Array), 'image/png');
    await cleanupTempRoot(appDataRoot);
  });
  it('refreshes the discovered model catalog after the provider key changes', async () => {
    const appDataRoot = await makeTempRoot();
    const fetch = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      const tokenId = init?.headers?.authorization === 'Bearer sk-second-provider' ? 'second-image-model' : 'first-image-model';
      if (url.endsWith('/v1/models')) return jsonResponse({ object: 'list', data: [{ id: tokenId }] });
      if (url.endsWith('/api/models/price')) return jsonResponse({ data: {
        version: `catalog-${tokenId}`,
        models: [{ key: tokenId, name: tokenId, provider: 'Test', tags: '绘图,异步任务' }],
      } });
      throw new Error(`unexpected URL: ${url}`);
    });
    const credentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() });
    const service = createComflyProviderService({ appDataRoot, credentialStore, fetch, discoverModelCatalog: true });

    await service.configure({ token: 'sk-first-provider' });
    await expect(service.listProfiles()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: 'first-image-model' }),
    ]));

    await service.configure({ token: 'sk-second-provider' });
    const refreshedProfiles = await service.listProfiles();
    expect(refreshedProfiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: 'second-image-model' }),
    ]));
    expect(refreshedProfiles).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: 'first-image-model' }),
    ]));
    await cleanupTempRoot(appDataRoot);
  });
  it('updates model routes without replacing the saved provider credential', async () => {
    const appDataRoot = await makeTempRoot();
    const safeStorage = createFakeSafeStorage();
    const credentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage });
    const service = createComflyProviderService({ appDataRoot, credentialStore, fetch: vi.fn(), profiles });
    await service.configure({ token: 'sk-model-route-credential' });

    expect(typeof (service as unknown as { updateProfiles?: unknown }).updateProfiles).toBe('function');
    await (service as unknown as { updateProfiles(request: { profiles: ProviderBridgeProfile[] }): Promise<unknown> }).updateProfiles({ profiles: [{
      provider: 'comfly',
      modelRoute: 'image-default',
      displayName: 'gpt-image-2',
      modelId: 'gpt-image-2',
      capabilities: ['image_generation', 'image_edit', 'async_tasks'],
    }] });

    expect(await credentialStore.getToken()).toBe('sk-model-route-credential');
    await expect(service.listProfiles()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ modelRoute: 'image-default', modelId: 'gpt-image-2' }),
    ]));
    await cleanupTempRoot(appDataRoot);
  });

  it('maps async image submit and polling to public job contracts', async () => {
    const appDataRoot = await makeTempRoot();
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-123', status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-123', status: 'running' }))
      .mockResolvedValueOnce(jsonResponse({
        taskId: 'raw-provider-task-123',
        status: 'succeeded',
        data: [{ url: 'https://assets.example/generated.png' }],
      }))
      .mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-456', status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-456', status: 'failed' }));
    const credentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() });
    const service = createComflyProviderService({ appDataRoot, credentialStore, fetch, profiles });
    await service.configure({ token });

    const submitted = await service.submitImageJob({
      jobId: 'job-1',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'draw a chair',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    });
    const running = await service.pollImageJob({ provider: 'comfly', providerTaskId: submitted.providerTaskId });
    const completed = await service.pollImageJob({ provider: 'comfly', providerTaskId: submitted.providerTaskId });
    const failedSubmission = await service.submitImageJob({
      jobId: 'job-2',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'draw a lamp',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    });
    const failed = await service.pollImageJob({ provider: 'comfly', providerTaskId: failedSubmission.providerTaskId });

    expect(submitted.providerTaskId).toMatch(/^provider-job-/);
    expect(submitted.providerTaskId).not.toContain('raw-provider-task-123');
    expect(running).toEqual({ status: 'running', progress: undefined });
    expect(completed).toEqual({
      status: 'completed',
      progress: 1,
      result: {
        assetId: `provider-result-${submitted.providerTaskId}`,
      },
    });
    expect(failed).toEqual({
      status: 'failed',
      error: { code: 'PROVIDER_ERROR', message: 'Provider image task failed', retryable: true },
    });
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual(expect.objectContaining({ authorization: `Bearer ${token}` }));
    expect(fetch.mock.calls.map((call) => call[0])).toContain('https://ai.comfly.org/v1/images/tasks/raw-provider-task-123');
    expect(fetch.mock.calls.map((call) => call[0])).toContain('https://ai.comfly.org/v1/images/tasks/raw-provider-task-456');
    expect(JSON.stringify({ submitted, running, completed, failedSubmission, failed })).not.toMatch(/raw-provider-task-(123|456)|sk-task|Authorization|base64/i);
    expect(JSON.stringify(completed)).not.toMatch(/https:\/\/assets\.example|generated\.png/i);
    await cleanupTempRoot(appDataRoot);
  });

  it('consumes an async Comfly b64_json result inside the main process without exposing it over IPC', async () => {
    const appDataRoot = await makeTempRoot();
    const imageBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ taskId: 'raw-inline-image-task', status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({
        taskId: 'raw-inline-image-task',
        status: 'succeeded',
        data: [{ b64_json: Buffer.from(imageBytes).toString('base64') }],
      }));
    const historySink = {
      reserveSubmission: vi.fn(async (input: { readonly jobId: string }) => ({
        created: true,
        historyId: deriveGenerationHistoryId(input.jobId),
        status: 'queued' as const,
        terminal: null,
      })),
      queued: vi.fn(async (input: { readonly jobId: string }) => deriveGenerationHistoryId(input.jobId)),
      running: vi.fn(async () => undefined),
      succeeded: vi.fn(async () => ({ status: 'succeeded' as const, width: 1, height: 1 })),
      failed: vi.fn(async () => ({ status: 'failed' as const })),
      cancelled: vi.fn(async () => ({ status: 'cancelled' as const })),
      getTerminal: vi.fn(async () => null),
    };
    const credentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() });
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore,
      fetch,
      profiles,
      historySink,
    });
    await service.configure({ token });

    const submitted = await service.submitImageJob({
      jobId: 'model-job-v2-inline-image',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'draw a product',
      conversationId: 'conversation-inline-image',
      referenceAssetIds: [],
    });
    const completed = await service.pollImageJob({ provider: 'comfly', providerTaskId: submitted.providerTaskId });

    expect(historySink.succeeded).toHaveBeenCalledWith(
      deriveGenerationHistoryId('model-job-v2-inline-image'),
      imageBytes,
    );
    expect(completed).toEqual({
      status: 'completed',
      progress: 1,
      result: { assetId: `provider-result-${submitted.providerTaskId}`, width: 1, height: 1 },
    });
    expect(JSON.stringify(completed)).not.toMatch(/base64|iVBOR|b64_json/iu);
    await cleanupTempRoot(appDataRoot);
  });

  it('stores an async Comfly image in the active project and returns the real asset id', async () => {
    const appDataRoot = await makeTempRoot();
    const imageBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ taskId: 'raw-project-image-task', status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({
        taskId: 'raw-project-image-task',
        status: 'succeeded',
        data: [{ b64_json: Buffer.from(imageBytes).toString('base64') }],
      }));
    const storeGeneratedImage = vi.fn(async () => ({
      assetId: '0123456789abcdef',
      width: 1,
      height: 1,
    }));
    const historySink = {
      reserveSubmission: vi.fn(async (input: { readonly jobId: string }) => ({
        created: true,
        historyId: deriveGenerationHistoryId(input.jobId),
        status: 'queued' as const,
        terminal: null,
      })),
      queued: vi.fn(async (input: { readonly jobId: string }) => deriveGenerationHistoryId(input.jobId)),
      running: vi.fn(async () => undefined),
      succeeded: vi.fn(async () => ({ status: 'succeeded' as const, width: 1, height: 1 })),
      failed: vi.fn(async () => ({ status: 'failed' as const })),
      cancelled: vi.fn(async () => ({ status: 'cancelled' as const })),
      getTerminal: vi.fn(async () => null),
    };
    const credentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() });
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore,
      fetch,
      profiles,
      historySink,
      storeGeneratedImage,
    });
    await service.configure({ token });

    const submitted = await service.submitImageJob({
      jobId: 'model-job-v2-project-image',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'draw a product',
      conversationId: 'conversation-project-image',
      sessionId: 'desktop-session-project-image',
      referenceAssetIds: [],
    });
    const completed = await service.pollImageJob({ provider: 'comfly', providerTaskId: submitted.providerTaskId });

    expect(storeGeneratedImage).toHaveBeenCalledWith(
      'desktop-session-project-image',
      imageBytes,
      'image/png',
    );
    expect(historySink.succeeded).toHaveBeenCalledWith(
      deriveGenerationHistoryId('model-job-v2-project-image'),
      imageBytes,
    );
    expect(completed).toEqual({
      status: 'completed',
      progress: 1,
      result: { assetId: '0123456789abcdef', width: 1, height: 1 },
    });
    await cleanupTempRoot(appDataRoot);
  });

  it('materializes a provider result when history already reports success but the project asset is missing', async () => {
    const appDataRoot = await makeTempRoot();
    const imageBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ taskId: 'raw-history-recovery-task', status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({
        taskId: 'raw-history-recovery-task',
        status: 'succeeded',
        data: [{ b64_json: Buffer.from(imageBytes).toString('base64') }],
      }));
    const storeGeneratedImage = vi.fn(async () => ({ assetId: 'fedcba9876543210', width: 1, height: 1 }));
    const historySink = {
      reserveSubmission: vi.fn(async (input: { readonly jobId: string }) => ({
        created: true,
        historyId: deriveGenerationHistoryId(input.jobId),
        status: 'queued' as const,
        terminal: null,
      })),
      queued: vi.fn(async (input: { readonly jobId: string }) => deriveGenerationHistoryId(input.jobId)),
      running: vi.fn(async () => undefined),
      succeeded: vi.fn(async () => ({ status: 'succeeded' as const, width: 1, height: 1 })),
      failed: vi.fn(async () => ({ status: 'failed' as const })),
      cancelled: vi.fn(async () => ({ status: 'cancelled' as const })),
      getTerminal: vi.fn(async () => ({ status: 'succeeded' as const, width: 1, height: 1 })),
    };
    const credentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() });
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore,
      fetch,
      profiles,
      historySink,
      storeGeneratedImage,
    });
    await service.configure({ token });

    const submitted = await service.submitImageJob({
      jobId: 'model-job-v2-history-recovery',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'recover a generated product',
      conversationId: 'conversation-history-recovery',
      sessionId: 'desktop-session-history-recovery',
      referenceAssetIds: [],
    });
    const completed = await service.pollImageJob({ provider: 'comfly', providerTaskId: submitted.providerTaskId });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(storeGeneratedImage).toHaveBeenCalledWith(
      'desktop-session-history-recovery',
      imageBytes,
      'image/png',
    );
    expect(completed).toEqual({
      status: 'completed',
      progress: 1,
      result: { assetId: 'fedcba9876543210', width: 1, height: 1 },
    });
    await cleanupTempRoot(appDataRoot);
  });

  it('accepts Comfly snake-case task envelopes and nested output image results', async () => {
    const appDataRoot = await makeTempRoot();
    const imageBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ task_id: 'raw-nested-image-task', status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({
        data: {
          task_id: 'raw-nested-image-task',
          status: 'SUCCESS',
          output: { images: [{ url: 'https://assets.example/nested-generated.png', width: 1536, height: 1024 }] },
        },
      }))
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => imageBytes.buffer });
    const credentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() });
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore,
      fetch,
      profiles,
      resolveResultHost: async () => ['93.184.216.34'],
      storeGeneratedImage: async () => ({
        assetId: 'abcdef0123456789',
        width: 1536,
        height: 1024,
      }),
    });
    await service.configure({ token });

    const submitted = await service.submitImageJob({
      jobId: 'model-job-v2-nested-image',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'draw a product photo',
      conversationId: 'conversation-nested-image',
      referenceAssetIds: [],
    });
    await expect(service.pollImageJob({ provider: 'comfly', providerTaskId: submitted.providerTaskId })).resolves.toEqual({
      status: 'completed',
      progress: 1,
      result: { assetId: 'abcdef0123456789', width: 1536, height: 1024 },
    });
    await cleanupTempRoot(appDataRoot);
  });

  it('runs a documented Comfly v2 text-to-video task and stores the returned MP4', async () => {
    const appDataRoot = await makeTempRoot();
    const mp4 = Uint8Array.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    let submittedBody: string | undefined;
    const fetch = vi.fn(async (url: string, init?: { readonly body?: string }) => {
      if (url.endsWith('/v2/videos/generations')) {
        submittedBody = init?.body;
        return jsonResponse({ task_id: 'raw-video-task-1' });
      }
      if (url.endsWith('/v2/videos/generations/raw-video-task-1')) return jsonResponse({
        task_id: 'raw-video-task-1', status: 'SUCCESS', progress: 100,
        data: { output: 'https://assets.example/generated.mp4', duration: 8 },
      });
      if (url === 'https://assets.example/generated.mp4') return {
        ok: true, status: 200, json: async () => ({}),
        arrayBuffer: async () => mp4.buffer.slice(mp4.byteOffset, mp4.byteOffset + mp4.byteLength),
      };
      throw new Error(`unexpected URL: ${url}`);
    });
    const storeGeneratedVideo = vi.fn(async () => ({ assetId: 'fedcba9876543210', width: 1920, height: 1080 }));
    const historySink = {
      queued: vi.fn(async (input: { readonly jobId: string }) => deriveGenerationHistoryId(input.jobId)),
      reserveSubmission: vi.fn(async (input: { readonly jobId: string }) => ({
        created: true,
        historyId: deriveGenerationHistoryId(input.jobId),
        status: 'queued' as const,
        terminal: null,
      })),
      running: vi.fn(async () => undefined),
      succeeded: vi.fn(async () => ({ status: 'succeeded' })),
      failed: vi.fn(async () => ({ status: 'failed' })),
      cancelled: vi.fn(async () => ({ status: 'cancelled' })),
      getTerminal: vi.fn(async () => null),
    };
    const credentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() });
    const service = createComflyProviderService({
      appDataRoot, credentialStore, fetch,
      profiles: [{ provider: 'comfly', modelRoute: 'veo-video', modelId: 'veo3.1-fast', displayName: 'Veo 3.1 Fast', capabilities: ['video_generation', 'async_tasks'] }],
      resolveResultHost: async () => ['93.184.216.34'],
      storeGeneratedVideo,
      historySink: historySink as never,
    });
    await service.configure({ token });

    const submitted = await service.submitVideoJob!({
      jobId: 'model-job-v2-video-1', provider: 'comfly', modelRoute: 'veo-video',
      prompt: 'A product rotates on a clean studio table', conversationId: 'video-session-1',
      referenceAssetIds: [], aspectRatio: '16:9', resolution: '2K', durationSeconds: 8,
      outputCount: 1, audioEnabled: true,
    });
    const completed = await service.pollVideoJob!({ provider: 'comfly', providerTaskId: submitted.providerTaskId });

    expect(submitted.providerTaskId).toMatch(/^provider-job-/u);
    expect(completed).toEqual({
      status: 'completed', progress: 1,
      result: { assetId: 'fedcba9876543210', width: 1920, height: 1080, durationSeconds: 8 },
    });
    expect(storeGeneratedVideo).toHaveBeenCalledWith('video-session-1', mp4, 'video/mp4');
    expect(historySink.reserveSubmission).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'model-job-v2-video-1', kind: 'video', provider: 'comfly', modelDisplayName: 'Veo 3.1 Fast',
    }));
    const historyId = deriveGenerationHistoryId('model-job-v2-video-1');
    expect(historySink.running).toHaveBeenCalledWith(historyId);
    expect(historySink.succeeded).toHaveBeenCalledWith(historyId, mp4, expect.objectContaining({
      width: 1920, height: 1080, durationSeconds: 8,
    }));
    expect(JSON.parse(String(submittedBody))).toEqual({
      model: 'veo3.1-fast', prompt: 'A product rotates on a clean studio table',
      aspect_ratio: '16:9', resolution: '2k', duration: 8, audio: true,
    });
    await cleanupTempRoot(appDataRoot);
  });
  it('forwards schema-validated image controls to the Comfly image request', async () => {
    const appDataRoot = await makeTempRoot();
    const fetch = vi.fn(async (_url: string, _init?: { body?: string }) => jsonResponse({ taskId: 'raw-provider-task-parameters', status: 'queued' }));
    const credentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() });
    const service = createComflyProviderService({ appDataRoot, credentialStore, fetch, profiles });
    await service.configure({ token });

    await service.submitImageJob({
      jobId: 'job-parameters',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'draw a studio product photograph',
      conversationId: 'conversation-parameters',
      referenceAssetIds: [],
      aspectRatio: '16:9',
      resolution: '2K',
      outputCount: 2,
    });

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(expect.objectContaining({
      model: 'provider-gpt-image-route',
      prompt: 'draw a studio product photograph',
      async: true,
      aspect_ratio: '16:9',
      size: '1536x1024',
      n: 2,
    }));
    await cleanupTempRoot(appDataRoot);
  });

  it('pins the focused bridge test to the local Comfly tier mapping contract', async () => {
    const source = await readFile(join(process.cwd(), 'packages/provider-comfly/src/client.ts'), 'utf8');
    expect(source).toMatch(/mapComflyImageResolutionTier\(input\.size, input\.aspect_ratio\)/u);
    expect(source).toMatch(/CAPABILITY_UNSUPPORTED/u);
    expect(source).toMatch(/native 4K output/u);
  });

  it('stores Gemini native inline image output and returns the project asset id', async () => {
    const appDataRoot = await makeTempRoot();
    const fetch = vi.fn(async () => jsonResponse({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }] } }],
    }));
    const storeGeneratedImage = vi.fn(async () => ({ assetId: 'e77617115ffe6399', width: 1, height: 1 }));
    const credentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() });
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore,
      fetch,
      storeGeneratedImage,
      profiles: [{ provider: 'comfly', modelRoute: 'gemini-image', modelId: 'gemini-3-pro-image-preview', displayName: 'Gemini Image', capabilities: ['image_generation', 'gemini_native'] }],
    });
    await service.configure({ token });

    const submitted = await service.submitImageJob({ jobId: 'gemini-job', provider: 'comfly', modelRoute: 'gemini-image', prompt: 'draw a chair', conversationId: 'session-1', referenceAssetIds: [] });
    const completed = await service.pollImageJob({ provider: 'comfly', providerTaskId: submitted.providerTaskId });

    expect(storeGeneratedImage).toHaveBeenCalledWith('session-1', expect.any(Uint8Array), 'image/png');
    expect(completed).toEqual({ status: 'completed', progress: 1, result: { assetId: 'e77617115ffe6399', width: 1, height: 1 } });
    expect((fetch.mock.calls as unknown as Array<[string, unknown]>)[0]?.[0]).toContain('/v1beta/models/gemini-3-pro-image-preview:generateContent');
    await cleanupTempRoot(appDataRoot);
  });

  it('sends managed generation images in @1 then @2 order and preserves existing task retries', async () => {
    const fetch = vi.fn(async (_url, init) => {
      expect(JSON.parse(String(init.body))).toMatchObject({
        model: 'nano-banana-2',
        prompt: [
          '@1 is the authoritative scene: preserve its composition, camera, lighting, and background.',
          '@2 is the authoritative replacement product: preserve its identity, proportions, material, color, and logo.',
          'Replace only the primary subject in @1 with @2. Do not blend, duplicate, or redesign the scene.',
          'Replace the product only.',
        ].join('\n'),
        image: [
          'data:image/png;base64,iVBORw==',
          'data:image/jpeg;base64,/9j/2Q==',
        ],
      });
      return jsonResponse({ taskId: 'provider-raw-task', status: 'pending' });
    });
    const readManagedGenerationImages = vi.fn()
      .mockResolvedValueOnce([
        { bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), mediaType: 'image/png' as const },
        { bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), mediaType: 'image/jpeg' as const },
      ])
      .mockRejectedValueOnce(new Error('project is no longer open'));
    const appDataRoot = await makeTempRoot();
    const credentialStore = createSecureProviderCredentialStore({
      appDataRoot,
      safeStorage: createFakeSafeStorage(),
    });
    await credentialStore.configure({ token: 'provider-token' });
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore,
      fetch,
      readManagedGenerationImages,
      profiles: [{
        provider: 'comfly',
        modelRoute: 'nano-banana-2',
        modelId: 'nano-banana-2',
        displayName: 'Nano Banana 2',
        capabilities: ['image_generation', 'image_edit', 'async_tasks'],
      }],
    });

    const request = {
      jobId: 'model-job-v2-11111111111111111111111111111111',
      provider: 'comfly',
      modelRoute: 'nano-banana-2',
      prompt: 'Replace the product only.',
      conversationId: 'conversation-reference-order',
      sessionId: 'desktop-session-1',
      referenceAssetIds: ['1'.repeat(16), '2'.repeat(16)],
    } satisfies SubmitImageJobBridgeRequest;

    const first = await service.submitImageJob(request);
    await expect(service.submitImageJob(request)).resolves.toEqual(first);

    expect(readManagedGenerationImages).toHaveBeenCalledWith(
      'desktop-session-1',
      ['1'.repeat(16), '2'.repeat(16)],
    );
    expect(readManagedGenerationImages).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await cleanupTempRoot(appDataRoot);
  });

  it('rejects reference generation without a session before reading managed images', async () => {
    const appDataRoot = await makeTempRoot();
    const fetch = vi.fn();
    const readManagedGenerationImages = vi.fn();
    const credentialStore = createSecureProviderCredentialStore({
      appDataRoot,
      safeStorage: createFakeSafeStorage(),
    });
    await credentialStore.configure({ token: 'provider-token' });
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore,
      fetch,
      readManagedGenerationImages,
      profiles: [{
        provider: 'comfly',
        modelRoute: 'nano-banana-2',
        modelId: 'nano-banana-2',
        displayName: 'Nano Banana 2',
        capabilities: ['image_generation', 'image_edit', 'async_tasks'],
      }],
    });

    await expect(service.submitImageJob({
      jobId: 'model-job-v2-33333333333333333333333333333333',
      provider: 'comfly',
      modelRoute: 'nano-banana-2',
      prompt: 'Use the selected reference.',
      conversationId: 'conversation-missing-session',
      referenceAssetIds: ['1'.repeat(16)],
    }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(readManagedGenerationImages).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    await cleanupTempRoot(appDataRoot);
  });

  it('rejects references for image-generation-only routes before fetch', async () => {
    const appDataRoot = await makeTempRoot();
    const fetch = vi.fn();
    const credentialStore = createSecureProviderCredentialStore({
      appDataRoot,
      safeStorage: createFakeSafeStorage(),
    });
    await credentialStore.configure({ token: 'provider-token' });
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore,
      fetch,
      readManagedGenerationImages: vi.fn(async () => [{
        bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
        mediaType: 'image/png' as const,
      }]),
      profiles: [{
        provider: 'comfly',
        modelRoute: 'text-only-image',
        modelId: 'text-only-image',
        displayName: 'Text Only Image',
        capabilities: ['image_generation'],
      }],
    });

    await expect(service.submitImageJob({
      jobId: 'model-job-v2-22222222222222222222222222222222',
      provider: 'comfly',
      modelRoute: 'text-only-image',
      prompt: 'Use the selected reference.',
      conversationId: 'conversation-unsupported-reference',
      sessionId: 'desktop-session-1',
      referenceAssetIds: ['1'.repeat(16)],
    }))
      .rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(fetch).not.toHaveBeenCalled();
    await cleanupTempRoot(appDataRoot);
  });

  it('submits and polls through the Electron net.request adapter without global fetch', async () => {
    vi.stubGlobal('fetch', undefined);
    const appDataRoot = await makeTempRoot();
    const safeStorage = createFakeSafeStorage();
    const net = createFakeElectronNet([
      { statusCode: 200, body: { taskId: 'raw-provider-task-electron-22', status: 'queued' } },
      {
        statusCode: 200,
        body: {
          taskId: 'raw-provider-task-electron-22',
          status: 'succeeded',
          data: [{ url: 'https://assets.example/electron-22.png', width: 512, height: 512 }],
        },
      },
    ]);
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage }),
      fetch: createElectronNetComflyFetch(net),
      profiles,
    });
    await service.configure({ token });

    const submitted = await service.submitImageJob({
      jobId: 'job-electron-22',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'prove legacy adapter works',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    });
    const completed = await service.pollImageJob({
      provider: 'comfly',
      providerTaskId: submitted.providerTaskId,
    });

    expect(completed).toEqual({
      status: 'completed',
      progress: 1,
      result: {
        assetId: `provider-result-${submitted.providerTaskId}`,
        width: 512,
        height: 512,
      },
    });
    expect(net.requests.map((request) => request.url)).toEqual([
      'https://ai.comfly.org/v1/images/generations?async=true',
      'https://ai.comfly.org/v1/images/tasks/raw-provider-task-electron-22',
    ]);
    expect(net.requests[0]?.method).toBe('POST');
    expect(net.requests[1]?.method).toBe('GET');
    expect(net.requests[0]?.headers).toEqual(expect.objectContaining({
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    }));
    expect(net.requests[0]?.body).toContain('prove legacy adapter works');
    expect(JSON.stringify({ completed, requests: net.requests })).not.toMatch(/globalThis\.fetch|electron-22\.png|base64/i);
    await cleanupTempRoot(appDataRoot);
  });

  it('rejects non-HTTPS Electron net adapter requests and cleans transport errors', async () => {
    const net = createFakeElectronNet([]);
    const fetch = createElectronNetComflyFetch(net, { timeoutMs: 25 });

    await expect(fetch('http://api.comfly.chat/v1/images/generations', { method: 'POST' })).rejects.toThrow(/https/i);
    await expect(fetch('https://api.comfly.chat/v1/images/generations', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: `{"apiKey":"${token}","path":"C:\\Users\\Private\\source.png"}`,
      signal: AbortSignal.timeout(1),
    })).rejects.not.toThrow(/Bearer|sk-task-9|apiKey|Users|source\.png/i);
  });

  it.each([
    'http://api.comfly.chat/v1/images/tasks/raw-provider-task',
    'https://10.0.0.4/v1/images/tasks/raw-provider-task',
    'https://assets.example/redirected.png',
  ])('rejects Electron redirects to %s without forwarding sanitized details', async (redirectUrl) => {
    const net = createRedirectElectronNet(redirectUrl);
    const fetch = createElectronNetComflyFetch(net);

    await expect(fetch('https://api.comfly.chat/v1/images/generations', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: '{"prompt":"draw"}',
    })).rejects.not.toThrow(/Bearer|sk-task-9|10\.0\.0\.4|raw-provider-task|redirected\.png/i);

    expect(net.requests).toHaveLength(1);
    expect(net.requests[0]?.options).toEqual(expect.objectContaining({
      url: 'https://api.comfly.chat/v1/images/generations',
      method: 'POST',
      redirect: 'manual',
    }));
    expect(net.requests[0]?.headers).toEqual({ authorization: `Bearer ${token}` });
  });

  it('preserves durable task mappings across token rotation and service restart', async () => {
    const appDataRoot = await makeTempRoot();
    const safeStorage = createFakeSafeStorage();
    const credentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage });
    const first = createComflyProviderService({
      appDataRoot,
      credentialStore,
      fetch: vi.fn().mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-rotate', status: 'queued' })),
      profiles,
    });
    await first.configure({ token: 'sk-first-rotation-token', profiles });
    const submitted = await first.submitImageJob({
      jobId: 'job-rotate',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'preserve rotation mapping',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    });

    await first.configure({ token: 'sk-second-rotation-token', profiles });

    const restartedFetch = vi.fn().mockResolvedValueOnce(jsonResponse({
      taskId: 'raw-provider-task-rotate',
      status: 'succeeded',
      data: [{ url: 'https://assets.example/rotated.png' }],
    }));
    const restarted = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage }),
      fetch: restartedFetch,
      profiles,
    });

    await expect(restarted.pollImageJob({
      provider: 'comfly',
      providerTaskId: submitted.providerTaskId,
    })).resolves.toEqual({
      status: 'completed',
      progress: 1,
      result: { assetId: `provider-result-${submitted.providerTaskId}` },
    });
    expect(restartedFetch.mock.calls[0]?.[1]?.headers).toEqual(expect.objectContaining({
      authorization: 'Bearer sk-second-rotation-token',
    }));
    await cleanupTempRoot(appDataRoot);
  });

  it('migrates v1 token-encrypted task mappings through protected fallback keys and survives rotation', async () => {
    const appDataRoot = await makeTempRoot();
    const safeStorage = createFakeSafeStorage();
    const legacyToken = 'sk-legacy-mapping-token';
    const publicTaskId = 'provider-job-1234567890abcdef1234567890abcdea';
    await writeLegacySafeStorageCredential(appDataRoot, safeStorage, legacyToken);
    await writeEncryptedTaskMappingsForTest(appDataRoot, legacyToken, [{
      provider: 'comfly',
      publicTaskId,
      rawTaskId: 'raw-provider-task-legacy-fallback',
      state: 'running',
      createdAt: '2026-07-16T08:00:00.000Z',
      updatedAt: '2026-07-16T08:00:00.000Z',
    }]);
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage }),
      fetch: vi.fn().mockResolvedValueOnce(jsonResponse({
        taskId: 'raw-provider-task-legacy-fallback',
        status: 'succeeded',
        data: [{ url: 'https://assets.example/legacy-fallback.png' }],
      })),
      profiles,
    });

    await expect(service.pollImageJob({ provider: 'comfly', providerTaskId: publicTaskId })).resolves.toEqual({
      status: 'completed',
      progress: 1,
      result: { assetId: `provider-result-${publicTaskId}` },
    });
    await service.configure({ token: 'sk-rotated-after-legacy-migration', profiles });
    const restarted = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage }),
      fetch: vi.fn(),
      profiles,
    });

    await expect(restarted.pollImageJob({ provider: 'comfly', providerTaskId: publicTaskId })).resolves.toMatchObject({ status: 'completed' });
    const serialized = await readAllFiles(appDataRoot);
    expect(serialized).not.toContain(legacyToken);
    expect(serialized).not.toContain('sk-rotated-after-legacy-migration');
    expect(serialized).not.toContain('raw-provider-task-legacy-fallback');
    expect(serialized).not.toContain(publicTaskId);
    await cleanupTempRoot(appDataRoot);
  });

  it.each([1, 4] as const)(
    'blocks legacy job identities after a v%s ledger migration while allowing a new run identity',
    async (ledgerVersion) => {
    const appDataRoot = await makeTempRoot();
    const safeStorage = createFakeSafeStorage();
    const legacyToken = ['sk', 'legacy-submission-barrier-token'].join('-');
    await writeLegacySafeStorageCredential(appDataRoot, safeStorage, legacyToken);
    await writeEncryptedTaskMappingsForTest(appDataRoot, legacyToken, [], ledgerVersion);
    const fetch = vi.fn().mockResolvedValue(jsonResponse({
      taskId: 'raw-provider-task-after-migration',
      status: 'queued',
    }));
    const request = {
      provider: 'comfly' as const,
      modelRoute: 'gpt-image',
      prompt: 'migration submission barrier',
      conversationId: 'conversation-migration-barrier',
      referenceAssetIds: [],
    };
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage }),
      fetch,
      profiles,
    });

    await expect(service.submitImageJob({
      ...request,
      jobId: 'model-job-legacy-acked-and-deleted',
    })).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
    expect(fetch).not.toHaveBeenCalled();

    await expect(service.submitImageJob({
      ...request,
      jobId: 'model-job-v2-new-run-after-migration',
    })).resolves.toMatchObject({ providerTaskId: expect.any(String) });
    expect(fetch).toHaveBeenCalledTimes(1);

    const restartedFetch = vi.fn();
    const restarted = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage }),
      fetch: restartedFetch,
      profiles,
    });
    await expect(restarted.submitImageJob({
      ...request,
      jobId: 'model-job-legacy-acked-and-deleted',
    })).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
    expect(restartedFetch).not.toHaveBeenCalled();
    await cleanupTempRoot(appDataRoot);
    },
  );

  it('keeps passphrase-backed running jobs paused while credentials are locked and resumes after unlock', async () => {
    const appDataRoot = await makeTempRoot();
    const firstStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage: unavailableSafeStorage() });
    const first = createComflyProviderService({
      appDataRoot,
      credentialStore: firstStore,
      fetch: vi.fn().mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-locked', status: 'queued' })),
      profiles,
    });
    await first.configure({ token, passphrase });
    const submitted = await first.submitImageJob({
      jobId: 'job-locked',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'resume after unlock',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    });

    const fetch = vi.fn().mockResolvedValueOnce(jsonResponse({
      taskId: 'raw-provider-task-locked',
      status: 'succeeded',
      data: [{ url: 'https://assets.example/locked.png' }],
    }));
    const restartedStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage: unavailableSafeStorage() });
    const restarted = createComflyProviderService({
      appDataRoot,
      credentialStore: restartedStore,
      fetch,
      profiles,
    });

    await expect(restarted.pollImageJob({
      provider: 'comfly',
      providerTaskId: submitted.providerTaskId,
    })).resolves.toEqual({
      status: 'running',
      blockedReason: 'credentials_locked',
      progress: undefined,
    });
    expect(fetch).not.toHaveBeenCalled();

    await restarted.unlock({ passphrase });
    await expect(restarted.pollImageJob({
      provider: 'comfly',
      providerTaskId: submitted.providerTaskId,
    })).resolves.toMatchObject({ status: 'completed' });
    expect(fetch).toHaveBeenCalledTimes(1);
    await cleanupTempRoot(appDataRoot);
  });

  it('recovers opaque task mappings after a main-process restart without writing plaintext ids to disk', async () => {
    const appDataRoot = await makeTempRoot();
    const safeStorage = createFakeSafeStorage();
    const firstFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-restart', status: 'queued' }));
    const firstCredentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage });
    const first = createComflyProviderService({ appDataRoot, credentialStore: firstCredentialStore, fetch: firstFetch, profiles });
    await first.configure({ token });

    const submitted = await first.submitImageJob({
      jobId: 'job-restart',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'recover after restart',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    });

    const secondFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        taskId: 'raw-provider-task-restart',
        status: 'succeeded',
        data: [{ url: 'https://assets.example/restart.png' }],
      }));
    const restartedCredentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage });
    const restarted = createComflyProviderService({
      appDataRoot,
      credentialStore: restartedCredentialStore,
      fetch: secondFetch,
      profiles,
    });

    await expect(restarted.pollImageJob({
      provider: 'comfly',
      providerTaskId: submitted.providerTaskId,
    })).resolves.toEqual({
      status: 'completed',
      progress: 1,
      result: {
        assetId: `provider-result-${submitted.providerTaskId}`,
      },
    });

    const serialized = await readAllFiles(appDataRoot);
    expect(serialized).not.toContain('raw-provider-task-restart');
    expect(serialized).not.toContain(submitted.providerTaskId);
    await cleanupTempRoot(appDataRoot);
  });

  it('serializes concurrent durable mapping writes so restart recovery does not lose submitted jobs', async () => {
    const appDataRoot = await makeTempRoot();
    const safeStorage = createFakeSafeStorage();
    const firstCredentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage });
    const first = createComflyProviderService({
      appDataRoot,
      credentialStore: firstCredentialStore,
      fetch: vi.fn()
        .mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-a', status: 'queued' }))
        .mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-b', status: 'queued' })),
      profiles,
    });
    await first.configure({ token });

    const [submittedA, submittedB] = await Promise.all([
      first.submitImageJob({
        jobId: 'job-a',
        provider: 'comfly',
        modelRoute: 'gpt-image',
        prompt: 'A',
        conversationId: 'conversation-1',
        referenceAssetIds: [],
      }),
      first.submitImageJob({
        jobId: 'job-b',
        provider: 'comfly',
        modelRoute: 'nano-banana-2',
        prompt: 'B',
        conversationId: 'conversation-1',
        referenceAssetIds: [],
      }),
    ]);

    const restartedCredentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage });
    const restarted = createComflyProviderService({
      appDataRoot,
      credentialStore: restartedCredentialStore,
      fetch: vi.fn()
        .mockResolvedValueOnce(jsonResponse({
          taskId: 'raw-provider-task-a',
          status: 'succeeded',
          data: [{ url: 'https://assets.example/a.png' }],
        }))
        .mockResolvedValueOnce(jsonResponse({
          taskId: 'raw-provider-task-b',
          status: 'succeeded',
          data: [{ url: 'https://assets.example/b.png' }],
        })),
      profiles,
    });

    await expect(restarted.pollImageJob({
      provider: 'comfly',
      providerTaskId: submittedA.providerTaskId,
    })).resolves.toMatchObject({ status: 'completed' });
    await expect(restarted.pollImageJob({
      provider: 'comfly',
      providerTaskId: submittedB.providerTaskId,
    })).resolves.toMatchObject({ status: 'completed' });

    const serialized = await readAllFiles(appDataRoot);
    expect(serialized).not.toContain('raw-provider-task-a');
    expect(serialized).not.toContain('raw-provider-task-b');
    await cleanupTempRoot(appDataRoot);
  });

  it('uses cross-process file locking so two service instances do not overwrite each other mappings', async () => {
    const appDataRoot = await makeTempRoot();
    const safeStorage = createFakeSafeStorage();
    const fileSystem = new DelayedMissingMappingReadFileSystem();
    const credentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage });
    await credentialStore.configure({ token });
    const first = createComflyProviderService({
      appDataRoot,
      credentialStore,
      fetch: vi.fn().mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-cross-a', status: 'queued' })),
      fileSystem,
      profiles,
    });
    const second = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage }),
      fetch: vi.fn().mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-cross-b', status: 'queued' })),
      fileSystem,
      profiles,
    });

    const [submittedA, submittedB] = await Promise.all([
      first.submitImageJob({
        jobId: 'job-cross-a',
        provider: 'comfly',
        modelRoute: 'gpt-image',
        prompt: 'cross process a',
        conversationId: 'conversation-1',
        referenceAssetIds: [],
      }),
      second.submitImageJob({
        jobId: 'job-cross-b',
        provider: 'comfly',
        modelRoute: 'gpt-image',
        prompt: 'cross process b',
        conversationId: 'conversation-1',
        referenceAssetIds: [],
      }),
    ]);

    const restarted = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage }),
      fetch: vi.fn()
        .mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-cross-a', status: 'running' }))
        .mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-cross-b', status: 'running' })),
      profiles,
    });

    await expect(restarted.pollImageJob({ provider: 'comfly', providerTaskId: submittedA.providerTaskId })).resolves.toMatchObject({ status: 'running' });
    await expect(restarted.pollImageJob({ provider: 'comfly', providerTaskId: submittedB.providerTaskId })).resolves.toMatchObject({ status: 'running' });
    await cleanupTempRoot(appDataRoot);
  });

  it('reports provider mapping confinement failures with provider mapping errors, not credential lock errors', async () => {
    const appDataRoot = await makeTempRoot();
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() }),
      fetch: vi.fn(),
      fileSystem: createMappingSymlinkFileSystem(appDataRoot),
      profiles,
    });
    await expect(service.pollImageJob({
      provider: 'comfly',
      providerTaskId: 'provider-job-symlink',
    })).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      message: expect.stringMatching(/mapping path/i),
    });
    await cleanupTempRoot(appDataRoot);
  });

  it('rolls back in-root mapping writes when post-write confinement verification fails', async () => {
    const appDataRoot = await makeTempRoot();
    const safeStorage = createFakeSafeStorage();
    const fileSystem = new PostReplaceVerificationFailureFileSystem(appDataRoot, 'provider-task-mappings.json');
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage }),
      fetch: vi.fn().mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-escape', status: 'queued' })),
      fileSystem,
      profiles,
    });
    await service.configure({ token });

    await expect(service.submitImageJob({
      jobId: 'job-post-write-escape',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'escape after write',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    })).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      message: expect.stringMatching(/mapping path/i),
    });
    await expect(readFile(join(appDataRoot, 'provider-task-mappings.json'), 'utf8')).rejects.toThrow();
    await cleanupTempRoot(appDataRoot);
  });

  it.each(['open', 'write', 'sync', 'rename'] as const)(
    'preserves running task mappings when atomic %s fails before target replacement',
    async (phase) => {
      const appDataRoot = await makeTempRoot();
      const safeStorage = createFakeSafeStorage();
      const first = createComflyProviderService({
        appDataRoot,
        credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage }),
        fetch: vi.fn().mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-running-preserved', status: 'queued' })),
        profiles,
      });
      await first.configure({ token });
      const submitted = await first.submitImageJob({
        jobId: 'job-running-preserved',
        provider: 'comfly',
        modelRoute: 'gpt-image',
        prompt: 'keep running mapping',
        conversationId: 'conversation-1',
        referenceAssetIds: [],
      });
      const before = await readFile(join(appDataRoot, 'provider-task-mappings.json'), 'utf8');

      const failing = createComflyProviderService({
        appDataRoot,
        credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage }),
        fetch: vi.fn().mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-failed-write', status: 'queued' })),
        fileSystem: new FailingAtomicWriteFileSystem('provider-task-mappings.json', phase),
        profiles,
      });

      await expect(failing.submitImageJob({
        jobId: 'job-failed-write',
        provider: 'comfly',
        modelRoute: 'gpt-image',
        prompt: 'this write fails',
        conversationId: 'conversation-1',
        referenceAssetIds: [],
      })).rejects.toBeTruthy();
      await expect(readFile(join(appDataRoot, 'provider-task-mappings.json'), 'utf8')).resolves.toBe(before);

      const restarted = createComflyProviderService({
        appDataRoot,
        credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage }),
        fetch: vi.fn().mockResolvedValueOnce(jsonResponse({
          taskId: 'raw-provider-task-running-preserved',
          status: 'succeeded',
          data: [{ url: 'https://assets.example/running-preserved.png' }],
        })),
        profiles,
      });
      await expect(restarted.pollImageJob({
        provider: 'comfly',
        providerTaskId: submitted.providerTaskId,
      })).resolves.toMatchObject({
        status: 'completed',
        result: { assetId: `provider-result-${submitted.providerTaskId}` },
      });
      await cleanupTempRoot(appDataRoot);
    },
  );

  it('restores unACKed terminal task mappings when post-replace verification fails inside app data', async () => {
    const appDataRoot = await makeTempRoot();
    const safeStorage = createFakeSafeStorage();
    const first = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage }),
      fetch: vi.fn()
        .mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-terminal-preserved', status: 'queued' }))
        .mockResolvedValueOnce(jsonResponse({
          taskId: 'raw-provider-task-terminal-preserved',
          status: 'succeeded',
          data: [{ url: 'https://assets.example/terminal-preserved.png' }],
        })),
      profiles,
    });
    await first.configure({ token });
    const submitted = await first.submitImageJob({
      jobId: 'job-terminal-preserved',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'keep terminal mapping',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    });
    await expect(first.pollImageJob({
      provider: 'comfly',
      providerTaskId: submitted.providerTaskId,
    })).resolves.toMatchObject({ status: 'completed' });
    const before = await readFile(join(appDataRoot, 'provider-task-mappings.json'), 'utf8');

    const failing = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage }),
      fetch: vi.fn().mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-new-terminal', status: 'queued' })),
      fileSystem: new PostReplaceVerificationFailureFileSystem(appDataRoot, 'provider-task-mappings.json'),
      profiles,
    });

    await expect(failing.submitImageJob({
      jobId: 'job-new-terminal',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'post verify fails',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    })).rejects.toBeTruthy();
    await expect(readFile(join(appDataRoot, 'provider-task-mappings.json'), 'utf8')).resolves.toBe(before);

    const restarted = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage }),
      fetch: vi.fn(),
      profiles,
    });
    await expect(restarted.pollImageJob({
      provider: 'comfly',
      providerTaskId: submitted.providerTaskId,
    })).resolves.toMatchObject({
      status: 'completed',
      result: { assetId: `provider-result-${submitted.providerTaskId}` },
    });
    await cleanupTempRoot(appDataRoot);
  });

  it('keeps terminal tombstones replayable until renderer ACK and then cleans them up', async () => {
    const appDataRoot = await makeTempRoot();
    const safeStorage = createFakeSafeStorage();
    const credentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage });
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-success', status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-failure', status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-cancel', status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({
        taskId: 'raw-provider-task-success',
        status: 'succeeded',
        data: [{ url: 'https://assets.example/success.png' }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        taskId: 'raw-provider-task-failure',
        status: 'failed',
      }));
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore,
      fetch,
      profiles,
    });
    await service.configure({ token });

    const success = await service.submitImageJob({
      jobId: 'job-success',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'success',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    });
    const failure = await service.submitImageJob({
      jobId: 'job-failure',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'failure',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    });
    const cancelled = await service.submitImageJob({
      jobId: 'job-cancel',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'cancel',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    });

    const completed = await service.pollImageJob({ provider: 'comfly', providerTaskId: success.providerTaskId });
    const failed = await service.pollImageJob({ provider: 'comfly', providerTaskId: failure.providerTaskId });
    await expect(service.pollImageJob({ provider: 'comfly', providerTaskId: success.providerTaskId })).resolves.toEqual(completed);
    await expect(service.pollImageJob({ provider: 'comfly', providerTaskId: failure.providerTaskId })).resolves.toEqual(failed);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(completed).toEqual({
      status: 'completed',
      progress: 1,
      result: { assetId: `provider-result-${success.providerTaskId}` },
    });
    expect(failed).toEqual({
      status: 'failed',
      error: { code: 'PROVIDER_ERROR', message: 'Provider image task failed', retryable: true },
    });
    await expect(service.cancelImageJob({ provider: 'comfly', providerTaskId: cancelled.providerTaskId })).resolves.toEqual({
      status: 'cancelled',
    });
    await expect(service.pollImageJob({ provider: 'comfly', providerTaskId: cancelled.providerTaskId })).resolves.toEqual({
      status: 'cancelled',
    });

    const serialized = await readAllFiles(appDataRoot);
    expect(serialized).not.toContain('raw-provider-task-success');
    expect(serialized).not.toContain('raw-provider-task-failure');
    expect(serialized).not.toContain('raw-provider-task-cancel');

    const restarted = createComflyProviderService({ appDataRoot, credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage }), fetch: vi.fn(), profiles });
    await expect((restarted as unknown as ProviderServiceWithAck).ackImageJobTerminal({
      provider: 'comfly',
      providerTaskId: success.providerTaskId,
      status: 'failed',
    })).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_RESPONSE',
    });
    await (restarted as unknown as ProviderServiceWithAck).ackImageJobTerminal({
      provider: 'comfly',
      providerTaskId: success.providerTaskId,
      status: 'completed',
    });
    await (restarted as unknown as ProviderServiceWithAck).ackImageJobTerminal({
      provider: 'comfly',
      providerTaskId: failure.providerTaskId,
      status: 'failed',
    });
    await (restarted as unknown as ProviderServiceWithAck).ackImageJobTerminal({
      provider: 'comfly',
      providerTaskId: cancelled.providerTaskId,
      status: 'cancelled',
    });
    await expect(restarted.pollImageJob({ provider: 'comfly', providerTaskId: success.providerTaskId })).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
    await expect(restarted.pollImageJob({ provider: 'comfly', providerTaskId: failure.providerTaskId })).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
    await expect(restarted.pollImageJob({ provider: 'comfly', providerTaskId: cancelled.providerTaskId })).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
    await cleanupTempRoot(appDataRoot);
  });

  it('does not garbage collect unACKed terminal tombstones or active running mappings', async () => {
    const appDataRoot = await makeTempRoot();
    const safeStorage = createFakeSafeStorage();
    let now = Date.parse('2026-07-16T08:00:00.000Z');
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage }),
      fetch: vi.fn()
        .mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-terminal-ttl', status: 'queued' }))
        .mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-active-ttl', status: 'queued' }))
        .mockResolvedValueOnce(jsonResponse({
          taskId: 'raw-provider-task-terminal-ttl',
          status: 'succeeded',
          data: [{ url: 'https://assets.example/terminal-ttl.png' }],
        })),
      profiles,
      now: () => now,
      terminalTombstoneTtlMs: 1_000,
    } as never);
    await service.configure({ token });
    const terminal = await service.submitImageJob({
      jobId: 'job-terminal-ttl',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'terminal ttl',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    });
    const active = await service.submitImageJob({
      jobId: 'job-active-ttl',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'active ttl',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    });

    await expect(service.pollImageJob({ provider: 'comfly', providerTaskId: terminal.providerTaskId })).resolves.toMatchObject({ status: 'completed' });
    now += 8 * 24 * 60 * 60 * 1000;
    await service.listProfiles();

    const restarted = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage }),
      fetch: vi.fn().mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-active-ttl', status: 'running' })),
      profiles,
      now: () => now,
      terminalTombstoneTtlMs: 1_000,
    } as never);
    await expect(restarted.pollImageJob({ provider: 'comfly', providerTaskId: terminal.providerTaskId })).resolves.toMatchObject({ status: 'completed' });
    await expect(restarted.pollImageJob({ provider: 'comfly', providerTaskId: active.providerTaskId })).resolves.toMatchObject({ status: 'running' });
    await cleanupTempRoot(appDataRoot);
  });

  it('does not expose provider result URLs or redirect/private-network text in public responses', async () => {
    for (const unsafeUrl of [
      'http://assets.example/generated.png',
      'https://user:pass@assets.example/generated.png',
      'https://localhost/generated.png',
      'https://127.0.0.1/generated.png',
      'https://10.0.0.4/generated.png',
      'https://172.16.0.4/generated.png',
      'https://192.168.1.9/generated.png',
      'https://169.254.10.1/generated.png',
      'https://[::1]/generated.png',
      'https://[fc00::1]/generated.png',
      'https://[fe80::1]/generated.png',
      'https://assets.example/generated.png?redirect=http://169.254.169.254/latest/meta-data',
    ]) {
      const appDataRoot = await makeTempRoot();
      const credentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() });
      const service = createComflyProviderService({
        appDataRoot,
        credentialStore,
        fetch: vi.fn().mockResolvedValue(jsonResponse({
          taskId: 'raw-task-url',
          status: 'succeeded',
          data: [{ url: unsafeUrl }],
        })),
        profiles,
      });
      await service.configure({ token });
      const submitted = await service.submitImageJob({
        jobId: 'job-url',
        provider: 'comfly',
        modelRoute: 'gpt-image',
        prompt: 'draw a chair',
        conversationId: 'conversation-1',
        referenceAssetIds: [],
      });

      const publicResult = await service.pollImageJob({ provider: 'comfly', providerTaskId: submitted.providerTaskId });
      expect(publicResult).toEqual({
        status: 'completed',
        progress: 1,
        result: { assetId: `provider-result-${submitted.providerTaskId}` },
      });
      expect(JSON.stringify(publicResult)).not.toContain(unsafeUrl);
      const publicResultWithoutOpaqueId = JSON.stringify(publicResult).replace(/provider-result-provider-job-[a-f0-9]{32}/u, '');
      expect(publicResultWithoutOpaqueId).not.toMatch(/localhost|127\.0\.0\.1|10\.0\.0\.4|192\.168|169\.254|fc00|fe80|redirect|meta-data|generated\.png/i);
      await cleanupTempRoot(appDataRoot);
    }

    const appDataRoot = await makeTempRoot();
    const credentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() });
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore,
      fetch: vi.fn().mockResolvedValue(jsonResponse({ taskId: `Authorization: Bearer ${token}`, status: 'queued' })),
      profiles,
    });
    await service.configure({ token });
    await expect(service.submitImageJob({
      jobId: 'job-protected-task-id',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'draw a chair',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    })).rejects.toMatchObject({
      code: 'PROTECTED_PAYLOAD',
      message: expect.not.stringMatching(/Authorization|Bearer|sk-task-9/i),
    });
    await cleanupTempRoot(appDataRoot);
  }, 15_000);

  it('models cancel as a replayable terminal where first terminal wins', async () => {
    const appDataRoot = await makeTempRoot();
    const credentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() });
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore,
      fetch: vi.fn()
        .mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-cancel-first', status: 'queued' }))
        .mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-complete-first', status: 'queued' }))
        .mockResolvedValueOnce(jsonResponse({
          taskId: 'raw-provider-task-complete-first',
          status: 'succeeded',
          data: [{ url: 'https://assets.example/complete-first.png' }],
        })),
      profiles,
    });
    await service.configure({ token });
    const cancelFirst = await service.submitImageJob({
      jobId: 'job-cancel-first',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'cancel first',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    });
    const completeFirst = await service.submitImageJob({
      jobId: 'job-complete-first',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'complete first',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    });

    await expect(service.cancelImageJob({
      provider: 'comfly',
      providerTaskId: cancelFirst.providerTaskId,
    })).resolves.toEqual({
      status: 'cancelled',
    });
    await expect(service.cancelImageJob({ provider: 'comfly', providerTaskId: cancelFirst.providerTaskId })).resolves.toEqual({ status: 'cancelled' });
    await expect(service.pollImageJob({ provider: 'comfly', providerTaskId: cancelFirst.providerTaskId })).resolves.toEqual({ status: 'cancelled' });

    const completed = await service.pollImageJob({ provider: 'comfly', providerTaskId: completeFirst.providerTaskId });
    await expect(service.cancelImageJob({ provider: 'comfly', providerTaskId: completeFirst.providerTaskId })).resolves.toEqual(completed);
    await expect(service.pollImageJob({ provider: 'comfly', providerTaskId: completeFirst.providerTaskId })).resolves.toEqual(completed);
    await cleanupTempRoot(appDataRoot);
  });

  it('does not hold the configuration mutex while provider network requests are in flight', async () => {
    const appDataRoot = await makeTempRoot();
    const safeStorage = createFakeSafeStorage();
    const slowPoll = deferred<ReturnType<typeof jsonResponse>>();
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-slow', status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-fast', status: 'queued' }))
      .mockReturnValueOnce(slowPoll.promise)
      .mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-fast', status: 'running' }));
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage }),
      fetch,
      profiles,
    });
    await service.configure({ token });
    const slow = await service.submitImageJob({
      jobId: 'job-slow-poll',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'slow poll',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    });
    const fast = await service.submitImageJob({
      jobId: 'job-fast-poll',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'fast poll',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    });

    const pendingSlowPoll = service.pollImageJob({ provider: 'comfly', providerTaskId: slow.providerTaskId });
    await waitFor(() => fetch.mock.calls.length === 3);
    await expect(Promise.race([
      service.getStatus().then(() => 'status-resolved'),
      delay(25).then(() => 'status-blocked'),
    ])).resolves.toBe('status-resolved');
    await expect(Promise.race([
      service.pollImageJob({ provider: 'comfly', providerTaskId: fast.providerTaskId }).then((result) => result.status),
      delay(500).then(() => 'poll-blocked'),
    ])).resolves.toBe('running');
    await expect(service.cancelImageJob({ provider: 'comfly', providerTaskId: fast.providerTaskId })).resolves.toEqual({ status: 'cancelled' });

    slowPoll.resolve(jsonResponse({ taskId: 'raw-provider-task-slow', status: 'running' }));
    await expect(pendingSlowPoll).resolves.toMatchObject({ status: 'running' });
    await cleanupTempRoot(appDataRoot);
  });

  it('serializes configure so credentials, base URL, and profiles stay atomically consistent', async () => {
    const appDataRoot = await makeTempRoot();
    const gates = [deferred<void>(), deferred<void>()];
    const configuredTokens: string[] = [];
    let activeToken = '';
    const credentialStore = {
      configure: vi.fn(async ({ token: nextToken }: { token: string }) => {
        const gate = gates[configuredTokens.length]!;
        configuredTokens.push(nextToken);
        await gate.promise;
        activeToken = nextToken;
      }),
      clear: vi.fn(async () => undefined),
      unlock: vi.fn(async () => undefined),
      getStatus: vi.fn(async () => ({ configured: Boolean(activeToken), locked: !activeToken, encryption: 'safeStorage' as const })),
      getPrimaryToken: vi.fn(async () => activeToken),
      getToken: vi.fn(async () => activeToken),
      getMappingKey: vi.fn(async () => 'stable-test-mapping-key'),
      getMappingSecrets: vi.fn(async () => ({ primary: 'stable-test-mapping-key', fallback: [] })),
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ taskId: 'raw-second-task', status: 'queued' }));
    const service = createComflyProviderService({ credentialStore, fetch, appDataRoot });
    const first = service.configure({
      token: 'sk-first-token-value',
      baseUrl: 'https://first.example',
      profiles: [{
        provider: 'comfly',
        modelRoute: 'first-route',
        displayName: 'First Route',
        capabilities: ['image_generation', 'async_tasks'],
      }],
    });
    await waitFor(() => configuredTokens.length === 1);
    const second = service.configure({
      token: 'sk-second-token-value',
      baseUrl: 'https://second.example',
      profiles: [{
        provider: 'comfly',
        modelRoute: 'second-route',
        displayName: 'Second Route',
        capabilities: ['image_generation', 'async_tasks'],
      }],
    });

    await delay(10);
    expect(configuredTokens).toEqual(['sk-first-token-value']);
    gates[0]?.resolve();
    await waitFor(() => configuredTokens.length === 2);
    gates[1]?.resolve();
    await first;
    await second;
    expect(await service.getStatus()).toMatchObject({ configured: true, locked: false });

    await expect(service.listProfiles()).resolves.toEqual([{
      provider: 'comfly',
      modelRoute: 'second-route',
      displayName: 'Second Route',
      capabilities: ['async_tasks', 'image_generation'],
    }]);
    await service.submitImageJob({
      jobId: 'job-second',
      provider: 'comfly',
      modelRoute: 'second-route',
      prompt: 'draw a chair',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('https://second.example/v1/images/generations?async=true');
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual(expect.objectContaining({ authorization: 'Bearer sk-second-token-value' }));
    await cleanupTempRoot(appDataRoot);
  });

  it('restores safeStorage-backed custom base URL and profiles after service restart without constructor defaults', async () => {
    const appDataRoot = await makeTempRoot();
    const safeStorage = createFakeSafeStorage();
    const configuredProfiles: ProviderBridgeProfile[] = [{
      provider: 'comfly',
      modelRoute: 'persisted-route',
      displayName: 'Persisted Route',
      modelId: 'provider-persisted-route',
      capabilities: ['image_generation', 'async_tasks'],
    }];
    const first = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage }),
      fetch: vi.fn(),
    });
    await first.configure({
      token: 'sk-safe-config-token',
      baseUrl: 'https://persisted.example',
      profiles: configuredProfiles,
    });

    const restartedFetch = vi.fn().mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-persisted-safe', status: 'queued' }));
    const restarted = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage }),
      fetch: restartedFetch,
    });

    await expect(restarted.listProfiles()).resolves.toEqual([
      { ...configuredProfiles[0]!, capabilities: ['async_tasks', 'image_generation'] },
    ]);
    await restarted.submitImageJob({
      jobId: 'job-persisted-safe',
      provider: 'comfly',
      modelRoute: 'persisted-route',
      prompt: 'draw persisted safe storage config',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    });
    expect(restartedFetch.mock.calls[0]?.[0]).toBe('https://persisted.example/v1/images/generations?async=true');
    const serialized = await readAllFiles(appDataRoot);
    expect(serialized).not.toMatch(/sk-safe-config-token|Authorization|Bearer|base64|C:\\Users|mappingKey/i);
    await cleanupTempRoot(appDataRoot);
  });

  it('restores passphrase-backed custom base URL and profiles after unlock without writing secrets to disk', async () => {
    const appDataRoot = await makeTempRoot();
    const configuredProfiles: ProviderBridgeProfile[] = [{
      provider: 'comfly',
      modelRoute: 'passphrase-route',
      displayName: 'Passphrase Route',
      capabilities: ['image_generation', 'async_tasks'],
    }];
    const first = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage: unavailableSafeStorage() }),
      fetch: vi.fn(),
    });
    await first.configure({
      token: 'sk-passphrase-config-token',
      passphrase,
      baseUrl: 'https://passphrase.example',
      profiles: configuredProfiles,
    });

    const restartedFetch = vi.fn().mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-persisted-passphrase', status: 'queued' }));
    const restarted = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage: unavailableSafeStorage() }),
      fetch: restartedFetch,
    });

    await expect(restarted.getStatus()).resolves.toMatchObject({ configured: true, locked: true, encryption: 'passphrase' });
    await expect(restarted.listProfiles()).resolves.toEqual([
      { ...configuredProfiles[0]!, capabilities: ['async_tasks', 'image_generation'] },
    ]);
    await expect(restarted.submitImageJob({
      jobId: 'job-passphrase-before-unlock',
      provider: 'comfly',
      modelRoute: 'passphrase-route',
      prompt: 'blocked until unlock',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    })).rejects.toMatchObject({ code: 'CREDENTIALS_LOCKED' });

    await restarted.unlock({ passphrase });
    await restarted.submitImageJob({
      jobId: 'job-passphrase-after-unlock',
      provider: 'comfly',
      modelRoute: 'passphrase-route',
      prompt: 'draw persisted passphrase config',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    });
    expect(restartedFetch.mock.calls[0]?.[0]).toBe('https://passphrase.example/v1/images/generations?async=true');
    const serialized = await readAllFiles(appDataRoot);
    expect(serialized).not.toMatch(/sk-passphrase-config-token|correct horse|Authorization|Bearer|base64|C:\\Users|mappingKey/i);
    await cleanupTempRoot(appDataRoot);
  });

  it('keeps credentials unconfigured when the first configure fails before configuration persistence completes', async () => {
    const appDataRoot = await makeTempRoot();
    const safeStorage = createFakeSafeStorage();
    const fileSystem = new FailingAtomicWriteFileSystem('provider-configuration.json', 'rename');
    const configuredProfiles: ProviderBridgeProfile[] = [{
      provider: 'comfly',
      modelRoute: 'broken-route',
      displayName: 'Broken Route',
      capabilities: ['image_generation', 'async_tasks'],
    }];
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage, fileSystem }),
      fetch: vi.fn(),
      fileSystem,
    });

    await expect(service.configure({
      token: 'sk-config-write-failure-token',
      baseUrl: 'https://broken.example',
      profiles: configuredProfiles,
    })).rejects.toBeTruthy();

    await expect(service.getStatus()).resolves.toMatchObject({
      configured: false,
      locked: true,
      encryption: 'safeStorage',
    });
    await expect(service.listProfiles()).resolves.toEqual([]);
    await expect(readFile(join(appDataRoot, 'provider-credentials.json'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(appDataRoot, 'provider-configuration.json'), 'utf8')).rejects.toThrow();

    const restarted = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage }),
      fetch: vi.fn(),
    });
    await expect(restarted.getStatus()).resolves.toMatchObject({
      configured: false,
      locked: true,
      encryption: 'safeStorage',
    });
    await expect(restarted.listProfiles()).resolves.toEqual([]);
    const serialized = await readAllFiles(appDataRoot);
    expect(serialized).not.toMatch(/sk-config-write-failure-token|broken\.example|Broken Route|broken-route/i);
    await cleanupTempRoot(appDataRoot);
  });

  it('keeps the previous token, mapping state, and configuration when rotation fails before configuration persistence completes', async () => {
    const appDataRoot = await makeTempRoot();
    const safeStorage = createFakeSafeStorage();
    const firstFetch = vi.fn().mockResolvedValueOnce(jsonResponse({ taskId: 'raw-before-config-failure', status: 'queued' }));
    const initial = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage }),
      fetch: firstFetch,
    });
    await initial.configure({
      token: 'sk-old-config-token',
      baseUrl: 'https://stable-before.example',
      profiles: [{
        provider: 'comfly',
        modelRoute: 'stable-route',
        displayName: 'Stable Route',
        capabilities: ['image_generation', 'async_tasks'],
      }],
    });
    const submitted = await initial.submitImageJob({
      jobId: 'job-before-config-failure',
      provider: 'comfly',
      modelRoute: 'stable-route',
      prompt: 'draw from stable config',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    });

    const fileSystem = new FailingAtomicWriteFileSystem('provider-configuration.json', 'rename');
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        taskId: 'raw-before-config-failure',
        status: 'succeeded',
        data: [{ width: 256, height: 256 }],
      }))
      .mockResolvedValueOnce(jsonResponse({ taskId: 'raw-after-config-failure', status: 'queued' }));
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage, fileSystem }),
      fetch,
      fileSystem,
    });

    await expect(service.configure({
      token: 'sk-new-config-token',
      baseUrl: 'https://unstable-after.example',
      profiles: [{
        provider: 'comfly',
        modelRoute: 'unstable-route',
        displayName: 'Unstable Route',
        capabilities: ['image_generation', 'async_tasks'],
      }],
    })).rejects.toBeTruthy();

    await expect(service.listProfiles()).resolves.toEqual([{
      provider: 'comfly',
      modelRoute: 'stable-route',
      displayName: 'Stable Route',
      capabilities: ['async_tasks', 'image_generation'],
    }]);
    await expect(service.pollImageJob({
      provider: 'comfly',
      providerTaskId: submitted.providerTaskId,
    })).resolves.toEqual({
      status: 'completed',
      progress: 1,
      result: {
        assetId: `provider-result-${submitted.providerTaskId}`,
        width: 256,
        height: 256,
      },
    });
    await service.submitImageJob({
      jobId: 'job-after-config-failure',
      provider: 'comfly',
      modelRoute: 'stable-route',
      prompt: 'still uses stable token',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('https://stable-before.example/v1/images/tasks/raw-before-config-failure');
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual(expect.objectContaining({ authorization: 'Bearer sk-old-config-token' }));
    expect(fetch.mock.calls[1]?.[0]).toBe('https://stable-before.example/v1/images/generations?async=true');
    expect(fetch.mock.calls[1]?.[1]?.headers).toEqual(expect.objectContaining({ authorization: 'Bearer sk-old-config-token' }));
    const serialized = await readAllFiles(appDataRoot);
    expect(serialized).not.toMatch(/sk-new-config-token|unstable-after\.example|Unstable Route|unstable-route/i);
    await cleanupTempRoot(appDataRoot);
  });

  it('rolls back a first configure when credentials fail after configuration persistence succeeds', async () => {
    const appDataRoot = await makeTempRoot();
    const safeStorage = createFakeSafeStorage();
    const fileSystem = new RecordingFailingCredentialFileSystem('rename');
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage, fileSystem }),
      fetch: vi.fn(),
      fileSystem,
    });

    await expect(service.configure({
      token: 'sk-credential-write-failure-token',
      baseUrl: 'https://credential-failure.example',
      profiles: [{
        provider: 'comfly',
        modelRoute: 'credential-failure-route',
        displayName: 'Credential Failure Route',
        capabilities: ['image_generation', 'async_tasks'],
      }],
    })).rejects.toBeTruthy();

    expect(fileSystem.configurationRenameCount).toBeGreaterThan(0);
    await expect(service.getStatus()).resolves.toMatchObject({
      configured: false,
      locked: true,
      encryption: 'safeStorage',
    });
    await expect(service.listProfiles()).resolves.toEqual([]);
    await expect(readFile(join(appDataRoot, 'provider-credentials.json'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(appDataRoot, 'provider-configuration.json'), 'utf8')).rejects.toThrow();

    const restarted = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage }),
      fetch: vi.fn(),
    });
    await expect(restarted.getStatus()).resolves.toMatchObject({
      configured: false,
      locked: true,
      encryption: 'safeStorage',
    });
    await expect(restarted.listProfiles()).resolves.toEqual([]);
    const serialized = await readAllFiles(appDataRoot);
    expect(serialized).not.toMatch(/sk-credential-write-failure-token|credential-failure\.example|Credential Failure Route|credential-failure-route/i);
    await cleanupTempRoot(appDataRoot);
  });

  it('does not delete an outside sentinel during first-configure rollback when configuration delete sees a swapped target', async () => {
    const appDataRoot = await makeTempRoot();
    const safeStorage = createFakeSafeStorage();
    const outsideRoot = join(appDataRoot, '..', 'outside-config-delete');
    const outsideTargetPath = join(outsideRoot, 'provider-configuration.json');
    await new NodeFileSystem().mkdir(outsideRoot, { recursive: true });
    await writeFile(outsideTargetPath, 'outside-sentinel\n', 'utf8');
    const fileSystem = new RollbackDeleteSwapCredentialFileSystem({
      appDataRoot,
      outsideRoot,
      outsideTargetPath,
      phase: 'rename',
    });
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage, fileSystem }),
      fetch: vi.fn(),
      fileSystem,
    });

    await expect(service.configure({
      token: 'sk-rollback-delete-target',
      baseUrl: 'https://rollback-delete.example',
      profiles: [{
        provider: 'comfly',
        modelRoute: 'rollback-delete-route',
        displayName: 'Rollback Delete Route',
        capabilities: ['image_generation', 'async_tasks'],
      }],
    })).rejects.toBeTruthy();

    await expect(readFile(outsideTargetPath, 'utf8')).resolves.toBe('outside-sentinel\n');
    await cleanupTempRoot(appDataRoot);
  });

  it('restores the previous token, mapping state, and configuration when credential rotation fails after configuration persistence succeeds', async () => {
    const appDataRoot = await makeTempRoot();
    const safeStorage = createFakeSafeStorage();
    const firstFetch = vi.fn().mockResolvedValueOnce(jsonResponse({ taskId: 'raw-before-credential-failure', status: 'queued' }));
    const initial = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage }),
      fetch: firstFetch,
    });
    await initial.configure({
      token: 'sk-old-credential-token',
      baseUrl: 'https://stable-credential.example',
      profiles: [{
        provider: 'comfly',
        modelRoute: 'stable-credential-route',
        displayName: 'Stable Credential Route',
        capabilities: ['image_generation', 'async_tasks'],
      }],
    });
    const submitted = await initial.submitImageJob({
      jobId: 'job-before-credential-failure',
      provider: 'comfly',
      modelRoute: 'stable-credential-route',
      prompt: 'draw before credential failure',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    });

    const fileSystem = new RecordingFailingCredentialFileSystem('rename');
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        taskId: 'raw-before-credential-failure',
        status: 'succeeded',
        data: [{ width: 384, height: 384 }],
      }))
      .mockResolvedValueOnce(jsonResponse({ taskId: 'raw-after-credential-failure', status: 'queued' }));
    const service = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage, fileSystem }),
      fetch,
      fileSystem,
    });

    await expect(service.configure({
      token: 'sk-new-credential-token',
      baseUrl: 'https://unstable-credential.example',
      profiles: [{
        provider: 'comfly',
        modelRoute: 'unstable-credential-route',
        displayName: 'Unstable Credential Route',
        capabilities: ['image_generation', 'async_tasks'],
      }],
    })).rejects.toBeTruthy();

    expect(fileSystem.configurationRenameCount).toBeGreaterThan(0);
    await expect(service.listProfiles()).resolves.toEqual([{
      provider: 'comfly',
      modelRoute: 'stable-credential-route',
      displayName: 'Stable Credential Route',
      capabilities: ['async_tasks', 'image_generation'],
    }]);
    await expect(service.pollImageJob({
      provider: 'comfly',
      providerTaskId: submitted.providerTaskId,
    })).resolves.toEqual({
      status: 'completed',
      progress: 1,
      result: {
        assetId: `provider-result-${submitted.providerTaskId}`,
        width: 384,
        height: 384,
      },
    });
    await service.submitImageJob({
      jobId: 'job-after-credential-failure',
      provider: 'comfly',
      modelRoute: 'stable-credential-route',
      prompt: 'still uses stable credential',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('https://stable-credential.example/v1/images/tasks/raw-before-credential-failure');
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual(expect.objectContaining({ authorization: 'Bearer sk-old-credential-token' }));
    expect(fetch.mock.calls[1]?.[0]).toBe('https://stable-credential.example/v1/images/generations?async=true');
    expect(fetch.mock.calls[1]?.[1]?.headers).toEqual(expect.objectContaining({ authorization: 'Bearer sk-old-credential-token' }));
    const serialized = await readAllFiles(appDataRoot);
    expect(serialized).not.toMatch(/sk-new-credential-token|unstable-credential\.example|Unstable Credential Route|unstable-credential-route/i);
    await cleanupTempRoot(appDataRoot);
  });

  it('rejects malformed provider responses and malformed inline image results with sanitized errors', async () => {
    const appDataRoot = await makeTempRoot();
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ taskId: 'task-unsafe', status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({ taskId: 'task-unsafe', status: 'succeeded', data: [{ b64_json: '%%%not-base64%%%' }] }))
      .mockResolvedValueOnce(jsonResponse({ taskId: 'task-invalid', status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({ taskId: '', status: '???' }));
    const credentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() });
    const service = createComflyProviderService({ appDataRoot, credentialStore, fetch, profiles });
    await service.configure({ token });

    const unsafeSubmitted = await service.submitImageJob({
      jobId: 'job-unsafe-response',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'draw a chair',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    });
    await expect(service.pollImageJob({ provider: 'comfly', providerTaskId: unsafeSubmitted.providerTaskId })).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_RESPONSE',
      message: expect.not.stringMatching(/AAAAAAAA|sk-task/i),
    });
    const invalidSubmitted = await service.submitImageJob({
      jobId: 'job-invalid-response',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'draw a chair',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    });
    await expect(service.pollImageJob({ provider: 'comfly', providerTaskId: invalidSubmitted.providerTaskId })).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_RESPONSE',
    });
    await cleanupTempRoot(appDataRoot);
  });

  it('replaces raw Comfly task ids in poll API, fetch, timeout, and invalid-response errors before IPC exposure', async () => {
    const appDataRoot = await makeTempRoot();
    const safeStorage = createFakeSafeStorage();
    const submitCredentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage });
    const submitService = createComflyProviderService({
      appDataRoot,
      credentialStore: submitCredentialStore,
      fetch: vi.fn().mockResolvedValue(jsonResponse({ taskId: 'raw-provider-task-error', status: 'queued' })),
      profiles,
    });
    await submitService.configure({ token });
    const submitted = await submitService.submitImageJob({
      jobId: 'job-error',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'error path',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    });

    const apiRestarted = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage }),
      fetch: vi.fn().mockResolvedValue(jsonResponse({
        message: 'upstream failed',
      }, { ok: false, status: 500 })),
      profiles,
    });
    await expect(apiRestarted.pollImageJob({
      provider: 'comfly',
      providerTaskId: submitted.providerTaskId,
    })).rejects.toMatchObject({
      message: expect.not.stringMatching(/raw-provider-task-error|\/v1\/images\/tasks\//i),
    });

    const fetchRestarted = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage }),
      fetch: vi.fn().mockRejectedValue(new Error('fetch failed for /v1/images/tasks/raw-provider-task-error')),
      profiles,
    });
    await expect(fetchRestarted.pollImageJob({
      provider: 'comfly',
      providerTaskId: submitted.providerTaskId,
    })).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: expect.not.stringMatching(/raw-provider-task-error|\/v1\/images\/tasks\//i),
    });

    const invalidRestarted = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage }),
      fetch: vi.fn().mockResolvedValue(jsonResponse({ taskId: '', status: '???' })),
      profiles,
    });
    await expect(invalidRestarted.pollImageJob({
      provider: 'comfly',
      providerTaskId: submitted.providerTaskId,
    })).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_RESPONSE',
      message: expect.not.stringMatching(/raw-provider-task-error|\/v1\/images\/tasks\//i),
    });

    const timeoutRestarted = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage }),
      fetch: vi.fn().mockRejectedValue(new Error('Comfly request timed out after 50ms for /v1/images/tasks/raw-provider-task-error')),
      profiles,
      timeoutMs: 50,
    });
    await expect(timeoutRestarted.pollImageJob({
      provider: 'comfly',
      providerTaskId: submitted.providerTaskId,
    })).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: expect.not.stringMatching(/raw-provider-task-error|\/v1\/images\/tasks\//i),
    });

    await cleanupTempRoot(appDataRoot);
  });
});

describe('provider IPC handlers', () => {
  it('registers only the typed provider channels', () => {
    const service = {
      ackImageJobTerminal: vi.fn(),
      cancelImageJob: vi.fn(),
      configure: vi.fn(),
      checkConnection: vi.fn(),
      getStatus: vi.fn(),
      revealCredential: vi.fn(),
      listAvailableModelIds: vi.fn(),
      listProfiles: vi.fn(),
      pollImageJob: vi.fn(),
      submitImageJob: vi.fn(),
      unlock: vi.fn(),
    };
    const handlers = createProviderBridgeHandlers(service);
    const registered: string[] = [];

    registerProviderBridgeHandlers({ handle: (channel) => registered.push(channel) }, handlers);

    expect(registered).toEqual(Object.values(PROVIDER_BRIDGE_CHANNELS));
    expect(registered).toContain('novus-desktop:provider:ack-image-job-terminal');
    expect(registered).not.toContain('novus-desktop:provider:fetch');
  });

  it('strictly validates and sanitizes service responses at the IPC boundary', async () => {
    const malformedHandlers = createProviderBridgeHandlers({
      cancelImageJob: vi.fn(async () => ({ status: 'ok' })),
      configure: vi.fn(),
      getStatus: vi.fn(async () => ({ configured: 'yes', locked: false, encryption: 'safeStorage' })),
      listProfiles: vi.fn(async () => [{
        provider: 'comfly-enterprise',
        modelRoute: 'nano-banana-2-route',
        displayName: 'Nano Banana 2',
        capabilities: ['image_generation', 'async_tasks'],
      }]),
      pollImageJob: vi.fn(async () => ({
        status: 'failed',
        error: {
          code: 'PROVIDER_ERROR',
          message: `Authorization: Bearer ${token} raw-provider-task-123`,
          retryable: false,
        },
      })),
      submitImageJob: vi.fn(async () => ({ providerTaskId: 'raw-provider-task-123' })),
      unlock: vi.fn(),
    } as never);

    await expect(malformedHandlers.getStatus({}, undefined)).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
    await expect(malformedHandlers.listProfiles({}, undefined)).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
    await expect(malformedHandlers.submitImageJob({}, {
      jobId: 'job-malformed',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'draw a chair',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    })).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
    await expect(malformedHandlers.cancelImageJob({}, {
      provider: 'comfly',
      providerTaskId: 'provider-job-1',
    })).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });

    await expect(malformedHandlers.pollImageJob({}, {
      provider: 'comfly',
      providerTaskId: 'provider-job-1',
    })).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_RESPONSE',
    });

    const sanitizedHandlers = createProviderBridgeHandlers({
      cancelImageJob: vi.fn(async () => ({ status: 'cancelled' })),
      configure: vi.fn(),
      getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' })),
      listProfiles: vi.fn(async () => [{
        provider: 'comfly',
        modelRoute: 'nano-banana-2-route',
        displayName: 'Nano Banana 2',
        modelId: 'provider-owned-nano-route',
        capabilities: ['image_generation', 'async_tasks'],
      }]),
      pollImageJob: vi.fn(async () => ({
        status: 'failed',
        error: {
          code: 'PROVIDER_ERROR',
          message: `Authorization: Bearer ${token}`,
          retryable: false,
        },
      })),
      submitImageJob: vi.fn(async () => ({ providerTaskId: 'provider-job-1234567890abcdef1234567890abcdef' })),
      unlock: vi.fn(),
    } as never);

    await expect(sanitizedHandlers.pollImageJob({}, {
      provider: 'comfly',
      providerTaskId: 'provider-job-1234567890abcdef1234567890abcdef',
    })).resolves.toEqual({
      status: 'failed',
      error: {
        code: 'PROVIDER_ERROR',
        message: '[redacted]',
        retryable: false,
      },
    });
  });

  it('registers serializable provider envelopes so locked errors survive an invoke round trip', async () => {
    const service = {
      ackImageJobTerminal: vi.fn(),
      cancelImageJob: vi.fn(),
      configure: vi.fn(),
      getStatus: vi.fn(),
      listProfiles: vi.fn(),
      pollImageJob: vi.fn(async () => {
        const error = new Error('Provider credentials are locked') as Error & { code: string; retryable: boolean };
        error.code = 'CREDENTIALS_LOCKED';
        error.retryable = true;
        throw error;
      }),
      submitImageJob: vi.fn(),
      unlock: vi.fn(),
    };
    const handlers = createProviderBridgeHandlers(service as never);
    const registered = new Map<string, (event: unknown, request: unknown) => Promise<unknown>>();
    registerProviderBridgeHandlers({
      handle: (channel, listener) => {
        registered.set(channel, listener);
      },
    }, handlers);

    const envelope = await registered.get(PROVIDER_BRIDGE_CHANNELS.pollImageJob)?.({}, {
      provider: 'comfly',
      providerTaskId: 'provider-job-1234567890abcdef1234567890abcdef',
    });
    const roundTripped = JSON.parse(JSON.stringify(envelope));

    expect(roundTripped).toEqual({
      ok: false,
      error: {
        code: 'CREDENTIALS_LOCKED',
        message: 'Provider credentials are locked',
        retryable: true,
      },
    });
  });

  it('allows only opaque provider result asset ids across the IPC boundary', async () => {
    const goodAssetId = 'provider-result-provider-job-1234567890abcdef1234567890abcdef';
    const goodHandlers = createProviderBridgeHandlers({
      ackImageJobTerminal: vi.fn(),
      cancelImageJob: vi.fn(async () => ({ status: 'cancelled' })),
      configure: vi.fn(),
      getStatus: vi.fn(),
      listProfiles: vi.fn(),
      pollImageJob: vi.fn(async () => ({
        status: 'completed',
        progress: 1,
        result: { assetId: goodAssetId, width: 512, height: 512 },
      })),
      submitImageJob: vi.fn(),
      unlock: vi.fn(),
    } as never);

    await expect(goodHandlers.pollImageJob({}, {
      provider: 'comfly',
      providerTaskId: 'provider-job-1234567890abcdef1234567890abcdef',
    })).resolves.toEqual({
      status: 'completed',
      progress: 1,
      result: { assetId: goodAssetId, width: 512, height: 512 },
    });

    for (const assetId of [
      'provider:comfly:provider-job-1234567890abcdef1234567890abcdef:0',
      'https://assets.example/generated.png',
      'data:image/png;base64,AAAAAAAAAAAAAAAAAAAA',
      'C:\\Users\\Private\\generated.png',
      '../generated.png',
      'asset-live-job',
    ]) {
      const handlers = createProviderBridgeHandlers({
        ackImageJobTerminal: vi.fn(),
        cancelImageJob: vi.fn(),
        configure: vi.fn(),
        getStatus: vi.fn(),
        listProfiles: vi.fn(),
        pollImageJob: vi.fn(async () => ({
          status: 'completed',
          progress: 1,
          result: { assetId },
        })),
        submitImageJob: vi.fn(),
        unlock: vi.fn(),
      } as never);

      await expect(handlers.pollImageJob({}, {
        provider: 'comfly',
        providerTaskId: 'provider-job-1234567890abcdef1234567890abcdef',
      })).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
    }
  });

  it('rejects malformed progress, blocked reasons, error codes, and ACK payloads at the IPC boundary', async () => {
    for (const progress of [Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1]) {
      const handlers = createProviderBridgeHandlers({
        cancelImageJob: vi.fn(),
        configure: vi.fn(),
        getStatus: vi.fn(),
        listProfiles: vi.fn(),
        pollImageJob: vi.fn(async () => ({ status: 'running', progress })),
        submitImageJob: vi.fn(),
        unlock: vi.fn(),
        ackImageJobTerminal: vi.fn(),
      } as never);
      await expect(handlers.pollImageJob({}, {
        provider: 'comfly',
        providerTaskId: 'provider-job-progress',
      })).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
    }

    const unknownBlockedReason = createProviderBridgeHandlers({
      cancelImageJob: vi.fn(),
      configure: vi.fn(),
      getStatus: vi.fn(),
      listProfiles: vi.fn(),
      pollImageJob: vi.fn(async () => ({ status: 'running', blockedReason: 'network_private' })),
      submitImageJob: vi.fn(),
      unlock: vi.fn(),
      ackImageJobTerminal: vi.fn(),
    } as never);
    await expect(unknownBlockedReason.pollImageJob({}, {
      provider: 'comfly',
      providerTaskId: 'provider-job-blocked',
    })).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });

    const unknownCode = createProviderBridgeHandlers({
      cancelImageJob: vi.fn(),
      configure: vi.fn(),
      getStatus: vi.fn(),
      listProfiles: vi.fn(),
      pollImageJob: vi.fn(async () => ({
        status: 'failed',
        error: { code: 'TOTALLY_UNKNOWN', message: 'unknown', retryable: false },
      })),
      submitImageJob: vi.fn(),
      unlock: vi.fn(),
      ackImageJobTerminal: vi.fn(),
    } as never);
    await expect(unknownCode.pollImageJob({}, {
      provider: 'comfly',
      providerTaskId: 'provider-job-error',
    })).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });

    const cancelled = createProviderBridgeHandlers({
      cancelImageJob: vi.fn(async () => ({ status: 'cancelled' })),
      configure: vi.fn(),
      getStatus: vi.fn(),
      listProfiles: vi.fn(),
      pollImageJob: vi.fn(async () => ({ status: 'cancelled' })),
      submitImageJob: vi.fn(),
      unlock: vi.fn(),
      ackImageJobTerminal: vi.fn(),
    } as never);
    await expect(cancelled.pollImageJob({}, {
      provider: 'comfly',
      providerTaskId: 'provider-job-cancelled',
    })).resolves.toEqual({ status: 'cancelled' });
    await expect(cancelled.cancelImageJob({}, {
      provider: 'comfly',
      providerTaskId: 'provider-job-cancelled',
    })).resolves.toEqual({ status: 'cancelled' });

    const ack = vi.fn(async () => ({ acknowledged: true }));
    const handlers = createProviderBridgeHandlers({
      cancelImageJob: vi.fn(),
      configure: vi.fn(),
      getStatus: vi.fn(),
      listProfiles: vi.fn(),
      pollImageJob: vi.fn(),
      submitImageJob: vi.fn(),
      unlock: vi.fn(),
      ackImageJobTerminal: ack,
    } as never) as unknown as ProviderHandlersWithAck;

    await expect(handlers.ackImageJobTerminal({}, {
      provider: 'comfly',
      providerTaskId: 'provider-job-ack',
      status: 'completed',
      extra: true,
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(handlers.ackImageJobTerminal({}, {
      provider: 'comfly',
      providerTaskId: 'provider-job-ack',
      status: 'running',
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(handlers.ackImageJobTerminal({}, {
      provider: 'comfly',
      providerTaskId: 'provider-job-ack',
      status: 'completed',
    })).resolves.toEqual({ acknowledged: true });
  });
});

describe('desktop shell provider wiring', () => {
  it('keeps provider bridge orchestration separate from vault, ledger, and transport internals', async () => {
    const source = await readFile(join(process.cwd(), 'packages/desktop-core/src/provider-bridge.ts'), 'utf8');

    expect(source).not.toMatch(/createCipheriv|createDecipheriv|scrypt|acquireConfinedFileLock|writeAtomic|provider-task-mappings\.json|provider-credentials\.json/u);
    expect(source.split(/\r?\n/u).length).toBeLessThan(1100);
  });

  it('wires Modern and Legacy provider services after app readiness with safeStorage', async () => {
    for (const mainPath of [
      join(process.cwd(), 'apps/desktop-modern/src/main.ts'),
      join(process.cwd(), 'apps/desktop-legacy/src/main.ts'),
    ]) {
      const source = await readFile(mainPath, 'utf8');
      const readyIndex = source.indexOf('app.whenReady().then');
      const safeStorageIndex = source.indexOf('safeStorage');
      const providerStoreIndex = source.indexOf('createSecureProviderCredentialStore({', readyIndex);
      const registerIndex = source.indexOf('registerProviderBridgeHandlers(ipcMain', readyIndex);

      expect(readyIndex).toBeGreaterThanOrEqual(0);
      expect(safeStorageIndex).toBeGreaterThanOrEqual(0);
      expect(providerStoreIndex).toBeGreaterThan(readyIndex);
      expect(registerIndex).toBeGreaterThan(readyIndex);
      expect(source).toContain('contextIsolation: true');
      expect(source).toContain('nodeIntegration: false');
      expect(source).toContain('app.requestSingleInstanceLock()');
      expect(source).toContain("app.on('second-instance'");
      expect(source).toContain('createElectronNetComflyFetch(net)');
      expect(source).not.toContain('globalThis.fetch');
    }
  });
});

type ProviderTerminalAckStatus = 'completed' | 'failed' | 'cancelled';

interface ProviderServiceWithAck {
  ackImageJobTerminal(request: {
    provider: 'comfly';
    providerTaskId: string;
    status: ProviderTerminalAckStatus;
  }): Promise<{ acknowledged: true }>;
}

interface ProviderHandlersWithAck {
  ackImageJobTerminal(event: unknown, request: unknown): Promise<{ acknowledged: true }>;
}

class DelayedMissingMappingReadFileSystem extends NodeFileSystem {
  private missingMappingReads = 0;
  private readonly secondReadArrived: Promise<void>;
  private resolveSecondRead: (() => void) | null = null;

  constructor() {
    super();
    this.secondReadArrived = new Promise((resolve) => {
      this.resolveSecondRead = resolve;
    });
  }

  override async readFile(path: string, encoding: BufferEncoding): Promise<string> {
    if (path.endsWith('provider-task-mappings.json') && this.missingMappingReads < 2) {
      this.missingMappingReads += 1;
      if (this.missingMappingReads === 2) this.resolveSecondRead?.();
      await Promise.race([this.secondReadArrived, delay(25)]);
    }
    return super.readFile(path, encoding);
  }
}

function createMappingSymlinkFileSystem(appDataRoot: string): FileSystem {
  const delegate = new NodeFileSystem();
  const mappingPath = join(appDataRoot, 'provider-task-mappings.json');
  return {
    ...delegate,
    link: (source, destination) => delegate.link(source, destination),
    lstat: async (path) => {
      if (path === mappingPath) {
        return {
          isDirectory: () => false,
          isFile: () => false,
          isSymbolicLink: () => true,
        };
      }
      return delegate.lstat(path);
    },
    mkdir: (path, options) => delegate.mkdir(path, options),
    open: (path, flags) => delegate.open(path, flags),
    readFile: (path, encoding) => delegate.readFile(path, encoding),
    readdir: (path) => delegate.readdir(path),
    realpath: (path) => delegate.realpath(path),
    rename: (source, destination) => delegate.rename(source, destination),
    rm: (path, options) => delegate.rm(path, options),
    stat: (path) => delegate.stat(path),
    unlink: (path) => delegate.unlink(path),
    writeFile: (path, data, encoding) => delegate.writeFile(path, data, encoding),
  };
}

class PostWriteEscapeMappingFileSystem extends NodeFileSystem {
  private readonly mappingPath: string;
  private readonly escapedMappingPath: string;
  private escaped = false;

  constructor(appDataRoot: string) {
    super();
    this.mappingPath = join(appDataRoot, 'provider-task-mappings.json');
    this.escapedMappingPath = join(appDataRoot, '..', 'escaped-provider-task-mappings.json');
  }

  override async rename(source: string, destination: string): Promise<void> {
    await super.rename(source, destination);
    if (destination === this.mappingPath) {
      this.escaped = true;
    }
  }

  override async realpath(path: string): Promise<string> {
    if (this.escaped && path === this.mappingPath) {
      return this.escapedMappingPath;
    }
    return super.realpath(path);
  }
}

type AtomicFailurePhase = 'open' | 'write' | 'sync' | 'rename';

class FailingAtomicWriteFileSystem extends NodeFileSystem {
  private failed = false;

  constructor(
    private readonly targetFileName: string,
    private readonly phase: AtomicFailurePhase,
  ) {
    super();
  }

  override open(path: string, flags: string): ReturnType<NodeFileSystem['open']> {
    return this.openForTest(path, flags) as ReturnType<NodeFileSystem['open']>;
  }

  private async openForTest(path: string, flags: string): Promise<FileHandleLike> {
    if (!this.failed && this.phase === 'open' && path.includes(`.${this.targetFileName}.tmp-`)) {
      this.failed = true;
      throw new Error(`injected ${this.targetFileName} temp open failure`);
    }
    const handle = await super.open(path, flags);
    if (!path.includes(`.${this.targetFileName}.tmp-`)) return handle;
    return {
      close: () => handle.close(),
      sync: async () => {
        if (!this.failed && this.phase === 'sync') {
          this.failed = true;
          throw new Error(`injected ${this.targetFileName} temp sync failure`);
        }
        await handle.sync();
      },
      truncate: (length: number) => handle.truncate?.(length) ?? Promise.resolve(),
      writeFile: async (data: string | Uint8Array) => {
        if (!this.failed && this.phase === 'write') {
          this.failed = true;
          throw new Error(`injected ${this.targetFileName} temp write failure`);
        }
        await handle.writeFile(data);
      },
    };
  }

  override async rename(source: string, destination: string): Promise<void> {
    if (!this.failed && this.phase === 'rename' && destination.endsWith(this.targetFileName)) {
      this.failed = true;
      throw new Error(`injected ${this.targetFileName} rename failure`);
    }
    await super.rename(source, destination);
  }
}

class RecordingFailingCredentialFileSystem extends FailingAtomicWriteFileSystem {
  configurationRenameCount = 0;

  constructor(phase: AtomicFailurePhase) {
    super('provider-credentials.json', phase);
  }

  override async rename(source: string, destination: string): Promise<void> {
    if (destination.endsWith('provider-configuration.json')) {
      this.configurationRenameCount += 1;
    }
    await super.rename(source, destination);
  }
}

class RollbackDeleteSwapCredentialFileSystem extends RecordingFailingCredentialFileSystem {
  private deleteSwapActivated = false;
  private configurationTargetPath: string;
  private readonly appDataRoot: string;
  private readonly outsideRoot: string;
  private readonly outsideTargetPath: string;

  constructor(options: {
    readonly appDataRoot: string;
    readonly outsideRoot: string;
    readonly outsideTargetPath: string;
    readonly phase: AtomicFailurePhase;
  }) {
    super(options.phase);
    this.appDataRoot = options.appDataRoot;
    this.outsideRoot = options.outsideRoot;
    this.outsideTargetPath = options.outsideTargetPath;
    this.configurationTargetPath = join(options.appDataRoot, 'provider-configuration.json');
  }

  override async realpath(path: string): Promise<string> {
    if (!this.deleteSwapActivated && path === dirname(this.configurationTargetPath)) {
      const resolved = await super.realpath(path);
      this.deleteSwapActivated = true;
      return resolved;
    }
    if (this.deleteSwapActivated && path === this.configurationTargetPath) {
      return this.outsideTargetPath;
    }
    if (this.deleteSwapActivated && path === this.appDataRoot) {
      return this.outsideRoot;
    }
    return super.realpath(this.translatePath(path));
  }

  override async readFile(path: string, encoding: BufferEncoding): Promise<string> {
    return super.readFile(this.translatePath(path), encoding);
  }

  override async rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void> {
    await super.rm(this.translatePath(path), options);
  }

  private translatePath(path: string): string {
    if (!this.deleteSwapActivated) return path;
    if (path === this.configurationTargetPath) return this.outsideTargetPath;
    return path;
  }
}

class PostReplaceVerificationFailureFileSystem extends NodeFileSystem {
  private shouldFailTargetRealpath = false;

  constructor(
    private readonly appDataRoot: string,
    private readonly targetFileName: string,
  ) {
    super();
  }

  override async rename(source: string, destination: string): Promise<void> {
    await super.rename(source, destination);
    if (destination === join(this.appDataRoot, this.targetFileName)) {
      this.shouldFailTargetRealpath = true;
    }
  }

  override async realpath(path: string): Promise<string> {
    if (this.shouldFailTargetRealpath && path === join(this.appDataRoot, this.targetFileName)) {
      this.shouldFailTargetRealpath = false;
      throw new Error(`injected ${this.targetFileName} post-replace verification failure`);
    }
    return super.realpath(path);
  }
}

type FakeElectronResponse = {
  readonly statusCode: number;
  readonly body: unknown;
};

type FakeElectronRequestRecord = {
  readonly options: Record<string, unknown>;
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
};

function createFakeElectronNet(responses: FakeElectronResponse[]) {
  const pending = [...responses];
  const requests: FakeElectronRequestRecord[] = [];
  return {
    requests,
    request(options: { readonly url?: string; readonly method?: string }) {
      return new FakeElectronClientRequest(options, pending, requests);
    },
  };
}

class FakeElectronClientRequest extends EventEmitter {
  private readonly headers: Record<string, string> = {};
  private body = '';

  constructor(
    private readonly options: { readonly url?: string; readonly method?: string },
    private readonly responses: FakeElectronResponse[],
    private readonly requests: FakeElectronRequestRecord[],
  ) {
    super();
  }

  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }

  write(chunk: string | Uint8Array): void {
    this.body += Buffer.from(chunk).toString('utf8');
  }

  end(): void {
    this.requests.push({
      options: { ...this.options },
      url: this.options.url ?? '',
      method: this.options.method ?? 'GET',
      headers: { ...this.headers },
      body: this.body,
    });
    const response = this.responses.shift();
    if (response === undefined) return;
    const incoming = new EventEmitter() as EventEmitter & { statusCode: number };
    incoming.statusCode = response.statusCode;
    queueMicrotask(() => {
      this.emit('response', incoming);
      incoming.emit('data', Buffer.from(JSON.stringify(response.body), 'utf8'));
      incoming.emit('end');
    });
  }

  abort(): void {
    this.emit('error', new Error(`Authorization: Bearer ${token} from C:\\Users\\Private\\source.png`));
  }
}

function createRedirectElectronNet(redirectUrl: string) {
  const requests: FakeElectronRequestRecord[] = [];
  return {
    requests,
    request(options: { readonly url?: string; readonly method?: string; readonly redirect?: string }) {
      return new RedirectElectronClientRequest(options, redirectUrl, requests);
    },
  };
}

class RedirectElectronClientRequest extends EventEmitter {
  private readonly headers: Record<string, string> = {};
  private body = '';

  constructor(
    private readonly options: { readonly url?: string; readonly method?: string; readonly redirect?: string },
    private readonly redirectUrl: string,
    private readonly requests: FakeElectronRequestRecord[],
  ) {
    super();
  }

  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }

  write(chunk: string | Uint8Array): void {
    this.body += Buffer.from(chunk).toString('utf8');
  }

  end(): void {
    this.requests.push({
      options: { ...this.options },
      url: this.options.url ?? '',
      method: this.options.method ?? 'GET',
      headers: { ...this.headers },
      body: this.body,
    });
    const incoming = new EventEmitter() as EventEmitter & { statusCode: number };
    incoming.statusCode = 302;
    queueMicrotask(() => {
      this.emit('redirect', 302, this.options.method ?? 'GET', this.redirectUrl, {
        location: [this.redirectUrl],
        authorization: [`Bearer ${token}`],
      });
      this.emit('response', incoming);
      incoming.emit('data', Buffer.from(JSON.stringify({ location: this.redirectUrl }), 'utf8'));
      incoming.emit('end');
    });
  }

  abort(): void {
    this.emit('error', new Error(`Authorization: Bearer ${token} redirect ${this.redirectUrl}`));
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1000) {
      throw new Error('Timed out waiting for condition');
    }
    await delay(0);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFakeSafeStorage(): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${Buffer.from(value, 'utf8').toString('base64')}`, 'utf8'),
    decryptString: (value) => {
      const text = Buffer.from(value).toString('utf8');
      return Buffer.from(text.slice('encrypted:'.length), 'base64').toString('utf8');
    },
  };
}

function createScopedFakeSafeStorage(scope: string): SafeStorageAdapter {
  const prefix = `${scope}:`;
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`${prefix}${Buffer.from(value, 'utf8').toString('base64')}`, 'utf8'),
    decryptString: (value) => {
      const text = Buffer.from(value).toString('utf8');
      if (!text.startsWith(prefix)) throw new Error('encrypted for another Windows profile');
      return Buffer.from(text.slice(prefix.length), 'base64').toString('utf8');
    },
  };
}

function unavailableSafeStorage(): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('safeStorage unavailable');
    },
    decryptString: () => {
      throw new Error('safeStorage unavailable');
    },
  };
}

function jsonResponse(body: unknown, options: { ok?: boolean; status?: number } = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: async () => body,
  };
}

async function writeLegacySafeStorageCredential(
  appDataRoot: string,
  safeStorage: SafeStorageAdapter,
  legacyToken: string,
): Promise<void> {
  await writeFile(join(appDataRoot, 'provider-credentials.json'), `${JSON.stringify({
    version: 1,
    kind: 'safeStorage',
    ciphertextHex: Buffer.from(safeStorage.encryptString(legacyToken)).toString('hex'),
  })}\n`, 'utf8');
}

async function writeEncryptedTaskMappingsForTest(
  appDataRoot: string,
  secret: string,
  mappings: unknown[],
  payloadVersion: 1 | 4 = 1,
): Promise<void> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await scrypt(secret, salt, 32) as Buffer;
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const payload = payloadVersion === 4
    ? { version: 4, mappings, submissionReservations: [] }
    : { version: 1, mappings };
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  await writeFile(join(appDataRoot, 'provider-task-mappings.json'), `${JSON.stringify({
    version: 1,
    saltHex: salt.toString('hex'),
    ivHex: iv.toString('hex'),
    authTagHex: cipher.getAuthTag().toString('hex'),
    ciphertextHex: ciphertext.toString('hex'),
  })}\n`, 'utf8');
}

async function makeTempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'novus-provider-'));
}

async function cleanupTempRoot(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true });
}

async function readAllFiles(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  const contents = await Promise.all(entries.map(async (entry) => {
    const nextPath = join(root, entry.name);
    if (entry.isDirectory()) {
      return readAllFiles(nextPath);
    }
    return readFile(nextPath, 'utf8');
  }));
  return contents.join('\n');
}

function geminiReverseProfile(): ProviderBridgeProfile {
  return {
    provider: 'comfly',
    modelRoute: 'comfly/gemini-video',
    modelId: 'gemini-video-provider-id',
    displayName: 'Gemini Video',
    capabilities: ['gemini_native', 'reverse_prompt', 'video_understanding'],
  };
}

function createOrderedMultiReversePromptRequest() {
  const imageA = { assetId: '1'.repeat(16), sha256: '1'.repeat(64), byteSize: 256, label: 'Image A', mediaType: 'image/png' as const, role: 'product_identity' as const };
  const videoA = { assetId: '2'.repeat(16), sha256: '2'.repeat(64), byteSize: 512, durationMs: 1000, extension: 'mp4' as const, height: 1080, label: 'Video A', mediaType: 'video/mp4' as const, origin: 'imported' as const, width: 1920 };
  const imageB = { assetId: '3'.repeat(16), sha256: '3'.repeat(64), byteSize: 768, label: 'Image B', mediaType: 'image/jpeg' as const, role: 'scene_composition' as const };
  const videoB = { assetId: '4'.repeat(16), sha256: '4'.repeat(64), byteSize: 1024, durationMs: 2000, extension: 'mp4' as const, height: 720, label: 'Video B', mediaType: 'video/mp4' as const, origin: 'imported' as const, width: 1280 };
  const references = [
    { assetId: imageA.assetId, label: imageA.label, position: 0, role: imageA.role },
    { assetId: imageB.assetId, label: imageB.label, position: 1, role: imageB.role },
  ];
  const run = createReversePromptRun({
    projectId: 'project-ordered-media',
    skill: { id: 'reverse-prompt', version: 'v1' },
    agentConfig: { modelRoute: 'comfly/gemini-video', role: 'Analyst', task: 'Compare all media.', knowledgeBaseIds: [] },
    knowledgeLease: createAgentKnowledgeLease({ runId: 'reverse-run-ordered', capability: 'reverse_prompt', snapshots: [], references, citations: [] }, { leaseId: 'lease-ordered', createdAt: '2026-08-06T00:00:00.000Z' }),
    approvedMemorySnapshot: { version: 'approved-ordered', approvedAt: '2026-08-06T00:00:00.000Z', approvedMemoryIds: [] },
    references,
    orderedMedia: [
      { kind: 'video', ...videoA, order: 0 },
      { kind: 'image', ...imageA, order: 1 },
      { kind: 'video', ...videoB, order: 2 },
      { kind: 'image', ...imageB, order: 3 },
    ],
  }, { createNonce: () => 'nonce-ordered', now: () => '2026-08-06T00:00:00.000Z' });
  return {
    sessionId: 'desktop-session-ordered',
    provider: 'comfly' as const,
    run,
    media: [
      { kind: 'video' as const, assetId: videoA.assetId, sha256: videoA.sha256, byteSize: videoA.byteSize, mediaType: videoA.mediaType },
      { kind: 'image' as const, assetId: imageA.assetId, sha256: imageA.sha256, byteSize: imageA.byteSize, mediaType: imageA.mediaType },
      { kind: 'video' as const, assetId: videoB.assetId, sha256: videoB.sha256, byteSize: videoB.byteSize, mediaType: videoB.mediaType },
      { kind: 'image' as const, assetId: imageB.assetId, sha256: imageB.sha256, byteSize: imageB.byteSize, mediaType: imageB.mediaType },
    ],
  };
}
async function createReversePromptRequestWithManagedKnowledge(
  appDataRoot: string,
  knowledgeStore: ManagedKnowledgeStore,
) {
  const catalog = await publishKnowledgeSnapshot(knowledgeStore, 'catalog', 'Catalog', 'prompts/catalog.md', 'Catalog guidance.');
  const composition = await publishKnowledgeSnapshot(knowledgeStore, 'composition', 'Composition', 'prompts/composition.md', 'Composition guidance.');
  const imageAssetId = 'b'.repeat(16);
  const imageSha256 = 'b'.repeat(64);
  const videoAssetId = 'c'.repeat(16);
  const videoSha256 = 'c'.repeat(64);
  const references = [{
    assetId: imageAssetId,
    label: 'Product',
    position: 0,
    role: 'product_identity' as const,
  }];
  const run = createReversePromptRun({
    projectId: 'project-1',
    skill: { id: 'reverse-prompt', version: 'v1' },
    agentConfig: {
      modelRoute: 'comfly/gemini-video',
      role: 'Commercial visual analyst',
      task: 'Analyze the managed original media.',
      knowledgeBaseIds: ['catalog', 'composition'],
    },
    knowledgeLease: createAgentKnowledgeLease({
      runId: 'reverse-run-1',
      capability: 'reverse_prompt',
      snapshots: [
        { knowledgeBaseId: catalog.knowledgeBaseId, version: catalog.version, contentHash: catalog.contentHash },
        { knowledgeBaseId: composition.knowledgeBaseId, version: composition.version, contentHash: composition.contentHash },
      ],
      references,
      citations: [],
    }, { leaseId: 'lease-1', createdAt: '2026-07-22T00:00:00.000Z' }),
    approvedMemorySnapshot: {
      version: 'approved-1',
      approvedAt: '2026-07-22T00:00:00.000Z',
      approvedMemoryIds: [],
    },
    references,
    videoInput: {
      assetId: videoAssetId,
      byteSize: 1_024,
      durationMs: 1_000,
      extension: 'mp4',
      height: 1_080,
      label: 'Launch film',
      mediaType: 'video/mp4',
      origin: 'imported',
      sha256: videoSha256,
      width: 1_920,
    },
  }, {
    createNonce: () => 'nonce-1',
    now: () => '2026-07-22T00:00:00.000Z',
  });
  return {
    sessionId: 'desktop-session-1',
    provider: 'comfly' as const,
    run,
    media: [
      { kind: 'image' as const, assetId: imageAssetId, sha256: imageSha256, byteSize: 512, mediaType: 'image/png' as const },
      { kind: 'video' as const, assetId: videoAssetId, sha256: videoSha256, byteSize: 1_024, mediaType: 'video/mp4' as const },
    ],
  };
}

async function publishKnowledgeSnapshot(
  knowledgeStore: ManagedKnowledgeStore,
  knowledgeBaseId: string,
  displayName: string,
  relativePath: string,
  content: string,
) {
  await knowledgeStore.configure({ knowledgeBaseId, displayName, rootPath: `managed-${knowledgeBaseId}` });
  const candidate = createKnowledgeSnapshotCandidate({
    knowledgeBaseId,
    displayName,
    documents: [{ relativePath, content }],
  });
  const snapshot = {
    ...candidate,
    version: 1,
    publishedAt: '2026-07-22T00:00:00.000Z',
    sourceDeviceId: 'desktop-1',
  };
  await knowledgeStore.publish(snapshot);
  return snapshot;
}

function reversePromptResultFor(run: ReversePromptRun) {
  return {
    sessionId: run.sessionId,
    nonce: run.nonce,
    knowledgeSnapshotVersion: run.knowledgeLease.versionKey,
    analysis: 'The product is framed centrally with a soft key light.',
    keywords: ['product', 'soft key light'],
    positivePrompt: 'A centrally framed product with a soft key light.',
    negativeConstraints: ['Do not distort the product.'],
    executionChecklist: ['Check the product silhouette.'],
  };
}
