import { normalizeRelayMeBaseUrl } from './client';

const LOGIN_PATH = '/api/auth/user/login';
const AI_TOOLS_PATH = '/api/ai-tools/v1';

export type RelayMeAccountAuthErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_BASE_URL'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_RESTRICTED'
  | 'NETWORK_ERROR'
  | 'INVALID_RESPONSE'
  | 'TOKEN_MISSING'
  | 'CROSS_ORIGIN_REDIRECT'
  | 'SERVICE_UNAVAILABLE';

const ERROR_MESSAGES: Readonly<Record<RelayMeAccountAuthErrorCode, string>> = {
  INVALID_REQUEST: 'RelayMe login request is invalid',
  INVALID_BASE_URL: 'RelayMe AI Tools base URL is invalid',
  INVALID_CREDENTIALS: 'RelayMe username or password is invalid',
  ACCOUNT_RESTRICTED: 'RelayMe account is restricted',
  NETWORK_ERROR: 'RelayMe login network request failed',
  INVALID_RESPONSE: 'RelayMe login response is invalid',
  TOKEN_MISSING: 'RelayMe login response did not include a token',
  CROSS_ORIGIN_REDIRECT: 'RelayMe login rejected a cross-origin redirect',
  SERVICE_UNAVAILABLE: 'RelayMe login service is unavailable',
};

export class RelayMeAccountAuthError extends Error {
  readonly code: RelayMeAccountAuthErrorCode;
  readonly retryable: boolean;

  constructor(code: RelayMeAccountAuthErrorCode, retryable = false) {
    super(ERROR_MESSAGES[code]);
    this.name = 'RelayMeAccountAuthError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface RelayMeAccountAuthFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly url?: string;
  json(): Promise<unknown>;
}

export interface RelayMeAccountAuthFetchInit {
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly redirect: 'error';
}

export type RelayMeAccountAuthFetch = (
  url: string,
  init: RelayMeAccountAuthFetchInit,
) => Promise<RelayMeAccountAuthFetchResponse>;

export interface RelayMeAccountAuthOptions {
  readonly baseUrl: string;
  readonly fetch: RelayMeAccountAuthFetch;
}

export interface RelayMeAccountLoginRequest {
  readonly username: string;
  readonly password: string;
}

export class RelayMeAccountAuthClient {
  private readonly fetch: RelayMeAccountAuthFetch;
  private readonly loginUrl: URL;

  constructor(options: RelayMeAccountAuthOptions) {
    this.fetch = options.fetch;
    this.loginUrl = deriveRelayMeLoginUrl(options.baseUrl);
  }

  async login(request: RelayMeAccountLoginRequest): Promise<string> {
    if (!isNonEmptyString(request.username) || !isNonEmptyString(request.password)) {
      throw new RelayMeAccountAuthError('INVALID_REQUEST');
    }

    let response: RelayMeAccountAuthFetchResponse;
    try {
      response = await this.fetch(this.loginUrl.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: request.username, password: request.password }),
        redirect: 'error',
      });
    } catch {
      throw new RelayMeAccountAuthError('NETWORK_ERROR', true);
    }

    rejectCrossOriginResponse(response, this.loginUrl);
    if (response.status === 401 || response.status === 403) {
      throw new RelayMeAccountAuthError('INVALID_CREDENTIALS');
    }
    if (response.status === 423) {
      throw new RelayMeAccountAuthError('ACCOUNT_RESTRICTED');
    }

    const body = await parseResponseBody(response);
    if (hasRestrictedAccountMarker(body)) {
      throw new RelayMeAccountAuthError('ACCOUNT_RESTRICTED');
    }
    if (!response.ok) {
      throw new RelayMeAccountAuthError(
        'SERVICE_UNAVAILABLE',
        response.status === 429 || response.status >= 500,
      );
    }

    const token = extractToken(body);
    if (token === null) {
      throw new RelayMeAccountAuthError('TOKEN_MISSING');
    }
    return token;
  }
}

export async function loginRelayMeAccount(
  options: RelayMeAccountAuthOptions,
  request: RelayMeAccountLoginRequest,
): Promise<string> {
  return new RelayMeAccountAuthClient(options).login(request);
}

function deriveRelayMeLoginUrl(baseUrl: string): URL {
  try {
    const url = new URL(normalizeRelayMeBaseUrl(baseUrl));
    const path = url.pathname.replace(/\/+$/u, '');
    if (
      url.protocol !== 'https:'
      || url.username.length > 0
      || url.password.length > 0
      || url.search.length > 0
      || url.hash.length > 0
      || path !== AI_TOOLS_PATH
    ) {
      throw new RelayMeAccountAuthError('INVALID_BASE_URL');
    }
    return new URL(LOGIN_PATH, url.origin);
  } catch (error) {
    if (error instanceof RelayMeAccountAuthError) throw error;
    throw new RelayMeAccountAuthError('INVALID_BASE_URL');
  }
}

function rejectCrossOriginResponse(response: RelayMeAccountAuthFetchResponse, loginUrl: URL): void {
  if (response.url === undefined || response.url.length === 0) return;
  try {
    if (new URL(response.url).origin === loginUrl.origin) return;
  } catch {
    // Invalid response URLs fail closed below.
  }
  throw new RelayMeAccountAuthError('CROSS_ORIGIN_REDIRECT');
}

async function parseResponseBody(response: RelayMeAccountAuthFetchResponse): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new RelayMeAccountAuthError('INVALID_RESPONSE');
  }
}

function extractToken(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const direct = firstString(value.token, value.jwt, value.accessToken, value.access_token);
  if (direct !== null) return isValidOpaqueToken(direct) ? direct : null;
  if (!isRecord(value.data)) return null;
  const nested = firstString(value.data.token, value.data.jwt, value.data.accessToken, value.data.access_token);
  return nested !== null && isValidOpaqueToken(nested) ? nested : null;
}

function hasRestrictedAccountMarker(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return recordHasRestrictedAccountMarker(value)
    || (isRecord(value.data) && recordHasRestrictedAccountMarker(value.data));
}

function recordHasRestrictedAccountMarker(value: Readonly<Record<string, unknown>>): boolean {
  if (value.restricted === true || value.accountRestricted === true || value.disabled === true) return true;
  const marker = firstNonEmptyString(value.code, value.status, value.errorCode)?.toUpperCase();
  if (marker === 'ACCOUNT_RESTRICTED'
    || marker === 'ACCOUNT_DISABLED'
    || marker === 'ACCOUNT_LOCKED'
    || marker === 'USER_DISABLED'
    || marker === 'USER_LOCKED') return true;
  const message = firstNonEmptyString(value.message, value.error);
  return message !== null && (
    /\baccount\b[^.]{0,40}\b(?:restricted|disabled|locked|suspended)\b/iu.test(message)
    || /(?:账号|账户).{0,12}(?:受限|禁用|锁定|停用)/u.test(message)
  );
}

function firstNonEmptyString(...values: readonly unknown[]): string | null {
  for (const value of values) {
    if (isNonEmptyString(value)) return value;
  }
  return null;
}

function firstString(...values: readonly unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string') return value;
  }
  return null;
}

function isValidOpaqueToken(value: string): boolean {
  return value.length > 0 && value.length <= 16_384 && value === value.trim();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
