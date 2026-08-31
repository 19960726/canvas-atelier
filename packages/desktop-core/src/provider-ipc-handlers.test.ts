import { describe, expect, it, vi } from 'vitest';

import { createProviderBridgeHandlers } from './provider-ipc-handlers';
import type { ProviderRegistry } from './provider-registry';
import type { ProviderService } from './provider-service-types';

describe('active provider IPC handlers', () => {
  it('activates RelayMe only after official web login completes', async () => {
    const relayme = fakeService();
    const activeStore = {
      getActiveProvider: vi.fn(async () => ({ activeProvider: null })),
      setActiveProvider: vi.fn(async (activeProvider: 'comfly' | 'relayme' | null) => ({ activeProvider })),
    };
    relayme.loginRelayMeWeb = vi.fn(async () => {
      expect(activeStore.setActiveProvider).not.toHaveBeenCalled();
    });
    const comfly = fakeService();
    const registry: ProviderRegistry = { get: (provider) => provider === 'comfly' ? comfly : relayme };
    const handlers = createHandlers(registry, { activeStore });

    await expect(handlers.loginRelayMeWeb({}, undefined)).resolves.toEqual({ activeProvider: 'relayme' });
    expect(relayme.loginRelayMeWeb).toHaveBeenCalledOnce();
    expect(activeStore.setActiveProvider).toHaveBeenCalledOnce();
    expect(activeStore.setActiveProvider).toHaveBeenCalledWith('relayme');
    expect(comfly.loginRelayMeWeb).toBeUndefined();
  });

  it('uses the persisted active provider as the main-process execution authority', async () => {
    const comfly = fakeService();
    const relayme = fakeService();
    const registry: ProviderRegistry = { get: (provider) => provider === 'comfly' ? comfly : relayme };
    const activeStore = {
      getActiveProvider: vi.fn(async () => ({ activeProvider: 'comfly' as const })),
      setActiveProvider: vi.fn(async (activeProvider: 'comfly' | 'relayme' | null) => ({ activeProvider })),
    };
    const handlers = createHandlers(registry, { activeStore });

    await expect(handlers.submitImageJob({}, imageRequest('relayme'))).rejects.toMatchObject({ code: 'PROVIDER_INACTIVE' });
    await expect(handlers.chat({}, chatRequest('relayme'))).rejects.toMatchObject({ code: 'PROVIDER_INACTIVE' });
    await expect(handlers.submitImageJob({}, imageRequest('comfly'))).resolves.toEqual({ providerTaskId: 'provider-job-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    expect(relayme.submitImageJob).not.toHaveBeenCalled();
  });

  it('allows active-provider changes only for configured providers without deleting the other provider', async () => {
    const comfly = fakeService({ configured: true });
    const relayme = fakeService({ configured: false });
    const activeStore = {
      getActiveProvider: vi.fn(async () => ({ activeProvider: null })),
      setActiveProvider: vi.fn(async (activeProvider: 'comfly' | 'relayme' | null) => ({ activeProvider })),
    };
    const registry: ProviderRegistry = { get: (provider) => provider === 'comfly' ? comfly : relayme };
    const handlers = createHandlers(registry, { activeStore });

    await expect(handlers.setActiveProvider({}, { activeProvider: 'relayme' })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    await expect(handlers.setActiveProvider({}, { activeProvider: 'comfly' })).resolves.toEqual({ activeProvider: 'comfly' });
    expect(comfly.revealCredential).not.toHaveBeenCalled();
    expect(relayme.revealCredential).not.toHaveBeenCalled();
  });

  it('clears an expired RelayMe session and activity only when RelayMe is currently active', async () => {
    const comfly = fakeService();
    const relayme = fakeService();
    relayme.submitImageJob.mockRejectedValue(Object.assign(new Error('expired'), {
      code: 'PROVIDER_ERROR', retryable: false, authenticationExpired: true,
    }));
    relayme.logoutRelayMe = vi.fn(async () => undefined);
    const activeStore = {
      getActiveProvider: vi.fn(async (): Promise<{ activeProvider: 'comfly' | 'relayme' | null }> => ({ activeProvider: 'relayme' })),
      setActiveProvider: vi.fn(async (activeProvider: 'comfly' | 'relayme' | null) => ({ activeProvider })),
    };
    const registry: ProviderRegistry = { get: (provider) => provider === 'comfly' ? comfly : relayme };
    const handlers = createHandlers(registry, { activeStore });

    await expect(handlers.submitImageJob({}, imageRequest('relayme'))).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(relayme.logoutRelayMe).toHaveBeenCalledOnce();
    expect(activeStore.setActiveProvider).toHaveBeenCalledWith(null);

    activeStore.getActiveProvider.mockResolvedValue({ activeProvider: 'comfly' });
    await expect(handlers.submitImageJob({}, imageRequest('relayme'))).rejects.toMatchObject({ code: 'PROVIDER_INACTIVE' });
    expect(relayme.logoutRelayMe).toHaveBeenCalledOnce();
    expect(activeStore.setActiveProvider).toHaveBeenCalledOnce();
  });

  it('clears an active RelayMe session for every poll, cancel, acknowledgement, and catalog request', async () => {
    const relayme = fakeService();
    const relaymeMock = relayme as any;
    const expired = Object.assign(new Error('expired'), { authenticationExpired: true });
    relaymeMock.pollImageJob.mockRejectedValue(expired);
    relaymeMock.cancelImageJob.mockRejectedValue(expired);
    relaymeMock.ackImageJobTerminal.mockRejectedValue(expired);
    relaymeMock.pollVideoJob = vi.fn().mockRejectedValue(expired);
    relaymeMock.cancelVideoJob = vi.fn().mockRejectedValue(expired);
    relaymeMock.ackVideoJobTerminal = vi.fn().mockRejectedValue(expired);
    relaymeMock.listAvailableModelIds.mockRejectedValue(expired);
    relaymeMock.listProfiles.mockRejectedValue(expired);
    relaymeMock.logoutRelayMe = vi.fn(async () => undefined);
    const activeStore = expiredRelayMeStore();
    const handlers = createHandlers({ get: () => relayme } as ProviderRegistry, { activeStore }) as any;

    const requests = [
      () => handlers.pollImageJob({}, taskRequest('relayme')),
      () => handlers.cancelImageJob({}, taskRequest('relayme')),
      () => handlers.ackImageJobTerminal({}, terminalTaskRequest('relayme')),
      () => handlers.pollVideoJob({}, taskRequest('relayme')),
      () => handlers.cancelVideoJob({}, taskRequest('relayme')),
      () => handlers.ackVideoJobTerminal({}, terminalTaskRequest('relayme')),
      () => handlers.listAvailableModelIds({}, { provider: 'relayme' }),
      () => handlers.listProfiles({}, { provider: 'relayme' }),
    ];
    for (const invoke of requests) await expect(invoke()).rejects.toThrow('expired');
    expect(relayme.logoutRelayMe).toHaveBeenCalledTimes(requests.length);
    expect(activeStore.setActiveProvider).toHaveBeenCalledTimes(requests.length);
    expect(activeStore.setActiveProvider).toHaveBeenLastCalledWith(null);
  });
});

const createHandlers = createProviderBridgeHandlers as unknown as (
  registry: ProviderRegistry,
  options: { activeStore: { getActiveProvider(): Promise<{ activeProvider: 'comfly' | 'relayme' | null }>; setActiveProvider(provider: 'comfly' | 'relayme' | null): Promise<{ activeProvider: 'comfly' | 'relayme' | null }> } },
) => ReturnType<typeof createProviderBridgeHandlers> & {
  getActiveProvider(event: unknown, request: unknown): Promise<{ activeProvider: 'comfly' | 'relayme' | null }>;
  setActiveProvider(event: unknown, request: unknown): Promise<{ activeProvider: 'comfly' | 'relayme' | null }>;
  loginRelayMeWeb(event: unknown, request: unknown): Promise<{ activeProvider: 'comfly' | 'relayme' | null }>;
};

function fakeService(status: { configured: boolean } = { configured: true }): ProviderService & { submitImageJob: ReturnType<typeof vi.fn> } {
  return {
    getStatus: vi.fn(async () => ({ configured: status.configured, locked: false, encryption: 'safeStorage' as const })),
    revealCredential: vi.fn(),
    checkConnection: vi.fn(),
    configure: vi.fn(),
    unlock: vi.fn(),
    listAvailableModelIds: vi.fn(),
    listProfiles: vi.fn(),
    submitImageJob: vi.fn(async () => ({ providerTaskId: 'provider-job-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })),
    pollImageJob: vi.fn(),
    cancelImageJob: vi.fn(),
    ackImageJobTerminal: vi.fn(),
    chat: vi.fn(async () => ({ message: 'ok', modelRoute: 'chat', sources: [] })),
  } as unknown as ProviderService & { submitImageJob: ReturnType<typeof vi.fn> };
}

function imageRequest(provider: 'comfly' | 'relayme') {
  return { jobId: 'job-1', provider, modelRoute: 'image', prompt: 'Draw a chair', conversationId: 'conversation-1', referenceAssetIds: [] };
}

function chatRequest(provider: 'comfly' | 'relayme') {
  return { provider, modelRoute: 'chat', messages: [{ role: 'user' as const, content: 'Hello' }], context: { knowledgeBaseIds: [], projectMemoryIds: [] } };
}

function taskRequest(provider: 'comfly' | 'relayme') {
  return { provider, providerTaskId: 'provider-job-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
}

function terminalTaskRequest(provider: 'comfly' | 'relayme') {
  return { ...taskRequest(provider), status: 'completed' };
}

function expiredRelayMeStore() {
  return {
    getActiveProvider: vi.fn(async () => ({ activeProvider: 'relayme' as const })),
    setActiveProvider: vi.fn(async (activeProvider: 'comfly' | 'relayme' | null) => ({ activeProvider })),
  };
}
