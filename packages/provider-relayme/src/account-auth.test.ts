import { describe, expect, it, vi } from 'vitest';

import * as relayme from './index';
import {
  RelayMeAccountAuthClient,
  loginRelayMeAccount,
  type RelayMeAccountAuthFetch,
  type RelayMeAccountAuthFetchResponse,
} from './account-auth';

const fixtureUsername = 'test-user@example.invalid';
const fixturePassword = 'fixture-password-not-a-real-secret';
const fixtureJwt = 'fixture-header.fixture-payload.fixture-signature';
const rawProviderBody = 'raw-provider-body-that-must-not-escape';

describe('RelayMe account authentication public API', () => {
  it('exports the account login client and function', () => {
    const exports = relayme as Record<string, unknown>;

    expect(exports.RelayMeAccountAuthClient).toBeTypeOf('function');
    expect(exports.loginRelayMeAccount).toBeTypeOf('function');
  });

  it('uses the official email field at the same-origin login endpoint and returns only the token', async () => {
    const fetch = vi.fn(async () => jsonResponse({ token: fixtureJwt }));

    const result = await loginRelayMeAccount(
      { baseUrl: 'https://relay.example/api/ai-tools/v1/', fetch },
      { username: fixtureUsername, password: fixturePassword },
    );

    expect(result).toBe(fixtureJwt);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith('https://relay.example/api/auth/user/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: fixtureUsername, password: fixturePassword }),
      redirect: 'error',
    });
  });

  it.each([401, 403])('maps HTTP %s to the stable invalid-credentials error', async (status) => {
    const client = createClient(async () => jsonResponse(
      { message: `${rawProviderBody} ${fixtureUsername} ${fixturePassword} ${fixtureJwt}` },
      { ok: false, status },
    ));

    const error = await client.login({ username: fixtureUsername, password: fixturePassword }).catch(identity);

    expect(error).toMatchObject({ code: 'INVALID_CREDENTIALS', retryable: false });
    expectSerializedErrorToBeSafe(error);
  });

  it('maps a restricted account response without exposing the provider body', async () => {
    const client = createClient(async () => jsonResponse(
      { code: 'ACCOUNT_RESTRICTED', message: `${rawProviderBody} ${fixtureJwt}` },
      { ok: false, status: 423 },
    ));

    const error = await client.login({ username: fixtureUsername, password: fixturePassword }).catch(identity);

    expect(error).toMatchObject({ code: 'ACCOUNT_RESTRICTED', retryable: false });
    expectSerializedErrorToBeSafe(error);
  });

  it('maps a structured restricted-account message without returning that message', async () => {
    const client = createClient(async () => jsonResponse({
      success: false,
      message: `Account is restricted. ${rawProviderBody} ${fixtureJwt}`,
    }));

    const error = await client.login({ username: fixtureUsername, password: fixturePassword }).catch(identity);

    expect(error).toMatchObject({ code: 'ACCOUNT_RESTRICTED', retryable: false });
    expectSerializedErrorToBeSafe(error);
  });

  it('maps network failures to a stable error without retaining the thrown cause', async () => {
    const client = createClient(async () => {
      throw new Error(`${rawProviderBody} ${fixtureUsername} ${fixturePassword} ${fixtureJwt}`);
    });

    const error = await client.login({ username: fixtureUsername, password: fixturePassword }).catch(identity);

    expect(error).toMatchObject({ code: 'NETWORK_ERROR', retryable: true });
    expect(error).not.toHaveProperty('cause');
    expectSerializedErrorToBeSafe(error);
  });

  it('maps non-JSON success responses to a stable invalid-response error', async () => {
    const client = createClient(async () => ({
      ok: true,
      status: 200,
      async json() {
        throw new Error(`${rawProviderBody} ${fixtureUsername} ${fixturePassword} ${fixtureJwt}`);
      },
    }));

    const error = await client.login({ username: fixtureUsername, password: fixturePassword }).catch(identity);

    expect(error).toMatchObject({ code: 'INVALID_RESPONSE', retryable: false });
    expectSerializedErrorToBeSafe(error);
  });

  it('maps a JSON response without a token to a stable missing-token error', async () => {
    const client = createClient(async () => jsonResponse({
      username: fixtureUsername,
      password: fixturePassword,
      response: rawProviderBody,
    }));

    const error = await client.login({ username: fixtureUsername, password: fixturePassword }).catch(identity);

    expect(error).toMatchObject({ code: 'TOKEN_MISSING', retryable: false });
    expectSerializedErrorToBeSafe(error);
  });

  it('accepts the official nested data token as an opaque value', async () => {
    const opaqueToken = 'relayme-opaque-session-token';
    const client = createClient(async () => jsonResponse({ data: { token: opaqueToken } }));

    await expect(client.login({ username: fixtureUsername, password: fixturePassword })).resolves.toBe(opaqueToken);
  });

  it('rejects a JWT with surrounding whitespace without exposing it', async () => {
    const paddedToken = ` ${fixtureJwt} `;
    const client = createClient(async () => jsonResponse({ token: paddedToken }));

    const error = await client.login({ username: fixtureUsername, password: fixturePassword }).catch(identity);

    expect(error).toMatchObject({ code: 'TOKEN_MISSING', retryable: false });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(fixtureJwt);
  });

  it('rejects a whitespace-only token with the stable missing-token error', async () => {
    const client = createClient(async () => jsonResponse({ token: '   ' }));

    const error = await client.login({ username: fixtureUsername, password: fixturePassword }).catch(identity);

    expect(error).toMatchObject({ code: 'TOKEN_MISSING', retryable: false });
    expectSerializedErrorToBeSafe(error);
  });

  it('rejects an overlong token without exposing it', async () => {
    const overlongToken = 'x'.repeat(16_385);
    const client = createClient(async () => jsonResponse({ data: { token: overlongToken } }));

    const error = await client.login({ username: fixtureUsername, password: fixturePassword }).catch(identity);

    expect(error).toMatchObject({ code: 'TOKEN_MISSING', retryable: false });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(overlongToken);
  });

  it('rejects non-AI-Tools base URLs instead of accepting an injected login URL', async () => {
    const fetch = vi.fn(async () => jsonResponse({ token: fixtureJwt }));

    const error = await loginRelayMeAccount(
      { baseUrl: 'https://attacker.example/api/auth/user/login', fetch },
      { username: fixtureUsername, password: fixturePassword },
    ).catch(identity);

    expect(error).toMatchObject({ code: 'INVALID_BASE_URL', retryable: false });
    expect(fetch).not.toHaveBeenCalled();
    expectSerializedErrorToBeSafe(error);
  });

  it('rejects a fetch implementation that reports a cross-origin redirect', async () => {
    const client = createClient(async () => ({
      ...jsonResponse({ token: fixtureJwt }),
      url: 'https://attacker.example/api/auth/user/login',
    }));

    const error = await client.login({ username: fixtureUsername, password: fixturePassword }).catch(identity);

    expect(error).toMatchObject({ code: 'CROSS_ORIGIN_REDIRECT', retryable: false });
    expectSerializedErrorToBeSafe(error);
  });
});

function createClient(fetch: RelayMeAccountAuthFetch): RelayMeAccountAuthClient {
  return new RelayMeAccountAuthClient({ baseUrl: 'https://relay.example/api/ai-tools/v1', fetch });
}

function jsonResponse(
  body: unknown,
  options: { readonly ok?: boolean; readonly status?: number } = {},
): RelayMeAccountAuthFetchResponse {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    async json() { return body; },
  };
}

function identity(value: unknown): unknown {
  return value;
}

function expectSerializedErrorToBeSafe(error: unknown): void {
  const serialized = `${String(error)} ${JSON.stringify(error)}`;
  expect(serialized).not.toContain(fixtureUsername);
  expect(serialized).not.toContain(fixturePassword);
  expect(serialized).not.toContain(fixtureJwt);
  expect(serialized).not.toContain(rawProviderBody);
}
