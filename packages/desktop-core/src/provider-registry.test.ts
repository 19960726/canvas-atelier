import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviderBridgeHandlers } from './provider-ipc-handlers';
import { createSecureProviderCredentialStore } from './provider-credential-vault';
import { createProviderRegistry } from './provider-registry';
import type { ProviderService } from './provider-service-types';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('provider registry', () => {
  it('routes the same operation to the selected provider service', async () => {
    const comfly = providerService('comfly');
    const relayme = providerService('relayme');
    const registry = createProviderRegistry({ comfly, relayme });
    const handlers = createProviderBridgeHandlers(registry);

    await expect(handlers.getStatus(null, { provider: 'comfly' })).resolves.toMatchObject({ configured: true });
    await expect(handlers.getStatus(null, { provider: 'relayme' })).resolves.toMatchObject({ configured: false });
    await handlers.submitImageJob(null, {
      jobId: 'job-relay', provider: 'relayme', modelRoute: 'image-default', prompt: '测试',
      conversationId: 'conversation-1', referenceAssetIds: [],
    });

    expect(comfly.getStatus).toHaveBeenCalledTimes(1);
    expect(relayme.getStatus).toHaveBeenCalledTimes(1);
    expect(relayme.submitImageJob).toHaveBeenCalledTimes(1);
    expect(comfly.submitImageJob).not.toHaveBeenCalled();
  });

  it('rejects unknown providers before service execution', async () => {
    const registry = createProviderRegistry({ comfly: providerService('comfly'), relayme: providerService('relayme') });
    const handlers = createProviderBridgeHandlers(registry);

    await expect(handlers.getStatus(null, { provider: 'unknown' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});

describe('provider credential isolation', () => {
  it('keeps Comfly legacy credentials separate from RelayMe credentials', async () => {
    const appDataRoot = await mkdtemp(join(tmpdir(), 'provider-isolation-'));
    roots.push(appDataRoot);
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value, 'utf8'),
      decryptString: (value: Uint8Array) => Buffer.from(value).toString('utf8'),
    };
    const comfly = createSecureProviderCredentialStore({ appDataRoot, provider: 'comfly', safeStorage });
    const relayme = createSecureProviderCredentialStore({ appDataRoot, provider: 'relayme', safeStorage });

    await comfly.configure({ token: 'comfly-secret' });
    await relayme.configure({ token: 'relayme-secret' });

    await expect(comfly.getToken()).resolves.toBe('comfly-secret');
    await expect(relayme.getToken()).resolves.toBe('relayme-secret');
    await expect(comfly.getStatus()).resolves.toMatchObject({ configured: true });
    await expect(relayme.getStatus()).resolves.toMatchObject({ configured: true });
  });
});

function providerService(provider: 'comfly' | 'relayme'): ProviderService {
  return {
    getStatus: vi.fn(async () => ({ configured: provider === 'comfly', locked: false, encryption: 'safeStorage' as const })),
    revealCredential: vi.fn(async () => ({ token: `${provider}-secret` })),
    checkConnection: vi.fn(async () => ({ checkedAt: '2026-08-08T12:00:00.000Z', status: 'connected' as const })),
    configure: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const })),
    unlock: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const })),
    listAvailableModelIds: vi.fn(async () => []),
    listProfiles: vi.fn(async () => []),
    submitImageJob: vi.fn(async () => ({ providerTaskId: 'provider-job-1234567890abcdef1234567890abcdef' })),
    pollImageJob: vi.fn(async () => ({ status: 'running' as const })),
    cancelImageJob: vi.fn(async () => ({ status: 'cancelled' as const })),
    ackImageJobTerminal: vi.fn(async () => ({ acknowledged: true as const })),
  };
}
