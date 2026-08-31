import { describe, expect, it } from 'vitest';
import {
  createProviderBridgeError,
  createProviderBridgeErrorEnvelope,
  PROVIDER_BRIDGE_CHANNELS,
  parseProviderBridgeEnvelope,
  parseProviderBridgeRequest,
  parseProviderBridgeResponse,
} from './provider-contracts';

describe('provider profile bridge contract', () => {
  it.each(['WEB_LOGIN_CANCELLED', 'WEB_LOGIN_TIMEOUT'] as const)(
    'preserves the sanitized %s web-login error across the IPC envelope',
    (code) => {
      const envelope = createProviderBridgeErrorEnvelope(createProviderBridgeError(
        code,
        code === 'WEB_LOGIN_CANCELLED' ? 'RelayMe 网页登录已取消' : 'RelayMe 网页登录超时，请重试',
        true,
      ));

      expect(() => parseProviderBridgeEnvelope(
        PROVIDER_BRIDGE_CHANNELS.loginRelayMeWeb,
        envelope,
      )).toThrow(expect.objectContaining({ code, retryable: true }));
    },
  );

  it('accepts a complete provider catalog with up to 1000 model profiles', () => {
    const profiles = Array.from({ length: 830 }, (_, index) => ({
      provider: 'comfly' as const,
      modelRoute: `comfly-model-${index}`,
      displayName: `Comfly Model ${index}`,
      modelId: `model-${index}`,
      capabilities: ['chat' as const],
    }));

    expect(() => parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.updateProfiles, {
      provider: 'comfly',
      profiles,
    })).not.toThrow();
  });

  it('keeps active-provider and RelayMe account IPC contracts narrow and token-free', () => {
    const channels = PROVIDER_BRIDGE_CHANNELS as Record<string, string>;

    expect(channels.getActiveProvider).toBe('novus-desktop:provider:get-active-provider');
    expect(channels.setActiveProvider).toBe('novus-desktop:provider:set-active-provider');
    expect(channels.loginRelayMe).toBe('novus-desktop:provider:login-relayme');
    expect(channels.loginRelayMeWeb).toBe('novus-desktop:provider:login-relayme-web');
    expect(channels.logoutRelayMe).toBe('novus-desktop:provider:logout-relayme');
    expect(parseProviderBridgeRequest(channels.loginRelayMeWeb!, undefined)).toBeUndefined();
    expect(parseProviderBridgeRequest(channels.loginRelayMeWeb!, {})).toBeUndefined();
    expect(() => parseProviderBridgeRequest(channels.loginRelayMeWeb!, {
      password: 'never-accept-a-renderer-password',
    })).toThrow(/invalid|unknown key/i);
    expect(parseProviderBridgeResponse(channels.loginRelayMeWeb!, {
      activeProvider: 'relayme',
    })).toEqual({ activeProvider: 'relayme' });
    expect(() => parseProviderBridgeResponse(channels.loginRelayMeWeb!, {
      activeProvider: 'relayme',
      token: 'never-return-a-jwt',
    })).toThrow(/invalid|unknown key/i);
    expect(parseProviderBridgeRequest(channels.loginRelayMe!, {
      username: 'artist@example.test',
      password: 'not-a-real-password',
    })).toEqual({ username: 'artist@example.test', password: 'not-a-real-password' });
    expect(() => parseProviderBridgeRequest(channels.loginRelayMe!, {
      username: 'artist@example.test',
      password: 'not-a-real-password',
      token: 'never-accept-a-renderer-token',
    })).toThrow(/unknown key/i);
    expect(() => parseProviderBridgeResponse(channels.loginRelayMe!, {
      activeProvider: 'relayme',
      token: 'never-return-a-jwt',
    })).toThrow(/unknown key/i);
  });

  it('preserves a whitelisted reverse failure reason across the IPC envelope', () => {
    const envelope = createProviderBridgeErrorEnvelope(createProviderBridgeError(
      'PROVIDER_INVALID_RESPONSE',
      'opaque reverse failure',
      true,
      'TRUNCATED',
    ));

    expect(() => parseProviderBridgeEnvelope(PROVIDER_BRIDGE_CHANNELS.analyzeReversePrompt, envelope))
      .toThrow(expect.objectContaining({
        code: 'PROVIDER_INVALID_RESPONSE',
        retryable: true,
        reason: 'TRUNCATED',
      }));
  });
});
