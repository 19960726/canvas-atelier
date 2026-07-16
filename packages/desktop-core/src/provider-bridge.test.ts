import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import {
  PROVIDER_BRIDGE_CHANNELS,
  createComflyProviderService,
  createProviderBridgeHandlers,
  createSecureProviderCredentialStore,
  normalizeProviderBridgeError,
  parseProviderBridgeRequest,
  registerProviderBridgeHandlers,
  type ProviderBridgeProfile,
  type SafeStorageAdapter,
} from './provider-bridge.js';
import { NodeFileSystem, type FileSystem } from './file-system.js';

const token = 'sk-task-9-secret-token';
const passphrase = 'correct horse battery staple';
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

  it('accepts only the stable comfly provider identifier in configured profiles', () => {
    expect(() => parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.configure, {
      token,
      profiles: [{
        provider: 'comfly-enterprise',
        modelRoute: 'nano-banana-2-route',
        displayName: 'Nano Banana 2',
        capabilities: ['image_generation', 'async_tasks'],
      }],
    })).toThrow(/provider unavailable|provider is unavailable/i);
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

describe('secure provider credential storage', () => {
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
});

describe('Comfly provider service', () => {
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
      referenceAssetIds: ['asset-reference'],
    });
    const running = await service.pollImageJob({ provider: 'comfly', providerTaskId: submitted.providerTaskId });
    const completed = await service.pollImageJob({ provider: 'comfly', providerTaskId: submitted.providerTaskId });
    const failedSubmission = await service.submitImageJob({
      jobId: 'job-2',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'draw a lamp',
      conversationId: 'conversation-1',
      referenceAssetIds: ['asset-reference'],
    });
    const failed = await service.pollImageJob({ provider: 'comfly', providerTaskId: failedSubmission.providerTaskId });

    expect(submitted.providerTaskId).toMatch(/^provider-job-/);
    expect(submitted.providerTaskId).not.toContain('raw-provider-task-123');
    expect(running).toEqual({ status: 'running', progress: undefined });
    expect(completed).toEqual({
      status: 'completed',
      progress: 1,
      result: {
        assetId: `provider:comfly:${submitted.providerTaskId}:0`,
      },
    });
    expect(failed).toEqual({
      status: 'failed',
      error: { code: 'PROVIDER_ERROR', message: 'Provider image task failed', retryable: true },
    });
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual(expect.objectContaining({ authorization: `Bearer ${token}` }));
    expect(fetch.mock.calls.map((call) => call[0])).toContain('https://api.comfly.chat/v1/images/tasks/raw-provider-task-123');
    expect(fetch.mock.calls.map((call) => call[0])).toContain('https://api.comfly.chat/v1/images/tasks/raw-provider-task-456');
    expect(JSON.stringify({ submitted, running, completed, failedSubmission, failed })).not.toMatch(/raw-provider-task-(123|456)|sk-task|Authorization|base64/i);
    expect(JSON.stringify(completed)).not.toMatch(/https:\/\/assets\.example|generated\.png/i);
    await cleanupTempRoot(appDataRoot);
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
      result: { assetId: `provider:comfly:${submitted.providerTaskId}:0` },
    });
    expect(restartedFetch.mock.calls[0]?.[1]?.headers).toEqual(expect.objectContaining({
      authorization: 'Bearer sk-second-rotation-token',
    }));
    await cleanupTempRoot(appDataRoot);
  });

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
        assetId: `provider:comfly:${submitted.providerTaskId}:0`,
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
      result: { assetId: `provider:comfly:${success.providerTaskId}:0` },
    });
    expect(failed).toEqual({
      status: 'failed',
      error: { code: 'PROVIDER_ERROR', message: 'Provider image task failed', retryable: true },
    });
    await expect(service.cancelImageJob({ provider: 'comfly', providerTaskId: cancelled.providerTaskId })).resolves.toEqual({
      status: 'local-only',
      remoteCancelled: false,
      reason: 'unsupported',
    });

    const serialized = await readAllFiles(appDataRoot);
    expect(serialized).not.toContain('raw-provider-task-success');
    expect(serialized).not.toContain('raw-provider-task-failure');
    expect(serialized).not.toContain('raw-provider-task-cancel');

    const restarted = createComflyProviderService({ appDataRoot, credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage }), fetch: vi.fn(), profiles });
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

  it('garbage collects expired terminal tombstones without removing active running mappings', async () => {
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
    now += 1_500;
    await service.listProfiles();

    const restarted = createComflyProviderService({
      appDataRoot,
      credentialStore: createSecureProviderCredentialStore({ appDataRoot, safeStorage }),
      fetch: vi.fn().mockResolvedValueOnce(jsonResponse({ taskId: 'raw-provider-task-active-ttl', status: 'running' })),
      profiles,
      now: () => now,
      terminalTombstoneTtlMs: 1_000,
    } as never);
    await expect(restarted.pollImageJob({ provider: 'comfly', providerTaskId: terminal.providerTaskId })).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
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
        result: { assetId: `provider:comfly:${submitted.providerTaskId}:0` },
      });
      expect(JSON.stringify(publicResult)).not.toContain(unsafeUrl);
      expect(JSON.stringify(publicResult)).not.toMatch(/localhost|127\.0\.0\.1|10\.0\.0\.4|192\.168|169\.254|fc00|fe80|redirect|meta-data|generated\.png/i);
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
  });

  it('models cancel as local-only unsupported when the provider has no remote cancel API', async () => {
    const appDataRoot = await makeTempRoot();
    const credentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() });
    const service = createComflyProviderService({ appDataRoot, credentialStore, fetch: vi.fn(), profiles });
    await service.configure({ token });

    await expect(service.cancelImageJob({
      provider: 'comfly',
      providerTaskId: 'provider-job-public-1',
    })).resolves.toEqual({
      status: 'local-only',
      remoteCancelled: false,
      reason: 'unsupported',
    });
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
      unlock: vi.fn(async () => undefined),
      getStatus: vi.fn(async () => ({ configured: Boolean(activeToken), locked: !activeToken, encryption: 'safeStorage' as const })),
      getToken: vi.fn(async () => activeToken),
      getMappingKey: vi.fn(async () => 'stable-test-mapping-key'),
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

  it('rejects invalid provider responses and raw base64 results with sanitized errors', async () => {
    const appDataRoot = await makeTempRoot();
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ taskId: 'task-unsafe', status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({ taskId: 'task-unsafe', status: 'succeeded', data: [{ b64_json: 'AAAAAAAAAAAAAAAAAAAA' }] }))
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
      code: 'PROTECTED_PAYLOAD',
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
      getStatus: vi.fn(),
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
      cancelImageJob: vi.fn(async () => ({ status: 'local-only', remoteCancelled: false, reason: 'unsupported' })),
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
      submitImageJob: vi.fn(async () => ({ providerTaskId: 'provider-job-public-1' })),
      unlock: vi.fn(),
    } as never);

    await expect(sanitizedHandlers.pollImageJob({}, {
      provider: 'comfly',
      providerTaskId: 'provider-job-public-1',
    })).resolves.toEqual({
      status: 'failed',
      error: {
        code: 'PROVIDER_ERROR',
        message: '[redacted]',
        retryable: false,
      },
    });
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
