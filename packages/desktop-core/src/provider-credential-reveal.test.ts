import { describe, expect, it, vi } from 'vitest';

import {
  PROVIDER_BRIDGE_CHANNELS,
  createProviderBridgeHandlers,
  parseProviderBridgeRequest,
  parseProviderBridgeResponse,
  registerProviderBridgeHandlers,
  type ProviderBridgeHandlers,
  type ProviderService,
} from './provider-bridge.js';

type RevealRequest = { readonly provider: 'comfly' | 'relayme' };
type RevealResult = { readonly token: string };
type RevealService = ProviderService & { revealCredential(): Promise<RevealResult> };
type RevealHandlers = ProviderBridgeHandlers & {
  revealCredential(event: unknown, request: unknown): Promise<RevealResult>;
};

const revealChannel = 'novus-desktop:provider:reveal-credential';
const syntheticToken = 'sk-synthetic-provider-key-for-reveal-test';

function createService(overrides: Partial<RevealService> = {}): RevealService {
  return {
    ackImageJobTerminal: vi.fn(),
    cancelImageJob: vi.fn(),
    checkConnection: vi.fn(),
    configure: vi.fn(),
    getStatus: vi.fn(),
    listAvailableModelIds: vi.fn(),
    listProfiles: vi.fn(),
    pollImageJob: vi.fn(),
    revealCredential: vi.fn(async () => ({ token: syntheticToken })),
    submitImageJob: vi.fn(),
    unlock: vi.fn(),
    ...overrides,
  } as RevealService;
}

describe('provider credential reveal bridge', () => {
  it('uses a dedicated strict request and response contract', () => {
    const channels = PROVIDER_BRIDGE_CHANNELS as typeof PROVIDER_BRIDGE_CHANNELS & {
      readonly revealCredential: string;
    };

    expect(channels.revealCredential).toBe(revealChannel);
    expect(parseProviderBridgeRequest(revealChannel, { provider: 'comfly' })).toEqual({ provider: 'comfly' });
    expect(parseProviderBridgeResponse(revealChannel, { token: syntheticToken })).toEqual({ token: syntheticToken });
    expect(() => parseProviderBridgeRequest(revealChannel, { provider: 'comfly', extra: true })).toThrow();
  });

  it('returns the configured provider credential only through the selected service', async () => {
    const service = createService();
    const handlers = createProviderBridgeHandlers(service) as RevealHandlers;

    await expect(handlers.revealCredential({}, { provider: 'comfly' } satisfies RevealRequest))
      .resolves.toEqual({ token: syntheticToken });
    expect(service.revealCredential).toHaveBeenCalledTimes(1);
  });

  it('rejects credential reveal calls from a renderer other than the trusted window', async () => {
    const handlers = createProviderBridgeHandlers(createService()) as RevealHandlers;
    const registered = new Map<string, (event: unknown, request: unknown) => Promise<unknown>>();
    const trustedSender = { id: 'trusted-renderer' };
    registerProviderBridgeHandlers({
      handle: (channel, listener) => registered.set(channel, listener),
    }, handlers, { getTrustedSender: () => trustedSender });

    const response = await registered.get(revealChannel)?.(
      { sender: { id: 'untrusted-renderer' } },
      { provider: 'comfly' },
    );

    expect(response).toEqual({
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        message: 'Credential reveal is not authorized',
        retryable: false,
      },
    });
    expect(JSON.stringify(response)).not.toContain(syntheticToken);
  });

  it('returns a sanitized locked error without including credential text', async () => {
    const lockedError = Object.assign(new Error(`locked ${syntheticToken}`), {
      code: 'CREDENTIALS_LOCKED',
      retryable: true,
    });
    const handlers = createProviderBridgeHandlers(createService({
      revealCredential: vi.fn(async () => { throw lockedError; }),
    })) as RevealHandlers;
    const registered = new Map<string, (event: unknown, request: unknown) => Promise<unknown>>();
    const trustedSender = { id: 'trusted-renderer' };
    registerProviderBridgeHandlers({
      handle: (channel, listener) => registered.set(channel, listener),
    }, handlers, { getTrustedSender: () => trustedSender });

    const response = await registered.get(revealChannel)?.(
      { sender: trustedSender },
      { provider: 'comfly' },
    );

    expect(response).toMatchObject({ ok: false, error: { code: 'CREDENTIALS_LOCKED' } });
    expect(JSON.stringify(response)).not.toContain(syntheticToken);
  });
});
