import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
    expect(() => parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.submitImageJob, {
      jobId: 'job-1',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'draw a chair',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
      authorization: `Bearer ${token}`,
    })).toThrow(/unknown key/i);
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
    expect(serialized).toMatch(/"version":1/);
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
  it('lists sanitized dynamic profiles only when credentials are unlocked', async () => {
    const appDataRoot = await makeTempRoot();
    const credentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() });
    const service = createComflyProviderService({
      credentialStore,
      fetch: vi.fn(),
      profiles,
    });

    expect(await service.getStatus()).toMatchObject({ configured: false, locked: true });
    await service.configure({ token });

    const listed = await service.listProfiles();
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
      .mockResolvedValueOnce(jsonResponse({ taskId: 'task-123', status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({ taskId: 'task-123', status: 'running' }))
      .mockResolvedValueOnce(jsonResponse({
        taskId: 'task-123',
        status: 'succeeded',
        data: [{ url: 'https://assets.example/generated.png' }],
      }))
      .mockResolvedValueOnce(jsonResponse({ taskId: 'task-123', status: 'failed' }));
    const credentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() });
    const service = createComflyProviderService({ credentialStore, fetch, profiles });
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
    const failed = await service.pollImageJob({ provider: 'comfly', providerTaskId: submitted.providerTaskId });

    expect(submitted).toEqual({ providerTaskId: 'task-123' });
    expect(running).toEqual({ status: 'running', progress: undefined });
    expect(completed).toEqual({
      status: 'completed',
      progress: 1,
      result: {
        assetId: 'provider:comfly:task-123:0',
        url: 'https://assets.example/generated.png',
      },
    });
    expect(failed).toEqual({
      status: 'failed',
      error: { code: 'PROVIDER_ERROR', message: 'Provider image task failed', retryable: true },
    });
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual(expect.objectContaining({ authorization: `Bearer ${token}` }));
    expect(JSON.stringify({ submitted, running, completed })).not.toMatch(/sk-task|Authorization|base64/i);
    await cleanupTempRoot(appDataRoot);
  });

  it('rejects invalid provider responses and raw base64 results with sanitized errors', async () => {
    const appDataRoot = await makeTempRoot();
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ taskId: 'task-unsafe', status: 'succeeded', data: [{ b64_json: 'AAAAAAAAAAAAAAAAAAAA' }] }))
      .mockResolvedValueOnce(jsonResponse({ taskId: '', status: '???' }));
    const credentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage: createFakeSafeStorage() });
    const service = createComflyProviderService({ credentialStore, fetch, profiles });
    await service.configure({ token });

    await expect(service.pollImageJob({ provider: 'comfly', providerTaskId: 'task-unsafe' })).rejects.toMatchObject({
      code: 'PROTECTED_PAYLOAD',
      message: expect.not.stringMatching(/AAAAAAAA|sk-task/i),
    });
    await expect(service.pollImageJob({ provider: 'comfly', providerTaskId: 'task-invalid' })).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_RESPONSE',
    });
    await cleanupTempRoot(appDataRoot);
  });
});

describe('provider IPC handlers', () => {
  it('registers only the typed provider channels', () => {
    const service = {
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
    expect(registered).not.toContain('novus-desktop:provider:fetch');
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
    }
  });
});

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

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

async function makeTempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'novus-provider-'));
}

async function cleanupTempRoot(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true });
}
