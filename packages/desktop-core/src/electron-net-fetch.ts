import { request as nodeHttpsRequest } from 'node:https';

import type { ComflyFetch, ComflyFetchResponse } from '@agent-canvas/provider-comfly';

export interface ElectronNetLike {
  request(options: { readonly url: string; readonly method: string; readonly redirect: 'manual' }): ElectronClientRequestLike;
}

export interface ElectronClientRequestLike {
  setHeader?(name: string, value: string): void;
  write?(chunk: string): void;
  end(): void;
  abort?(): void;
  on(event: 'response', listener: (response: ElectronIncomingMessageLike) => void): this;
  on(event: 'redirect', listener: (
    statusCode: number,
    method: string,
    redirectUrl: string,
    responseHeaders: Record<string, string[]>,
  ) => void): this;
  on(event: 'error', listener: (error: unknown) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
}

export type PinnedHttpsRequestLike = (
  options: {
    readonly headers?: Record<string, string>;
    readonly hostname: string;
    readonly lookup: (
      hostname: string,
      options: unknown,
      callback: (error: NodeJS.ErrnoException | null, address: string, family: 4 | 6) => void,
    ) => void;
    readonly method: string;
    readonly path: string;
    readonly port?: string;
    readonly protocol: 'https:';
    readonly servername: string;
  },
  listener: (response: ElectronIncomingMessageLike) => void,
) => ElectronClientRequestLike;

export interface ElectronIncomingMessageLike {
  readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly statusCode?: number;
  on(event: 'data', listener: (chunk: string | Uint8Array) => void): this;
  on(event: 'end', listener: () => void): this;
  on(event: 'error', listener: (error: unknown) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
}

export function createElectronNetComflyFetch(
  net: ElectronNetLike,
  options: {
    readonly maxResponseBytes?: number;
    readonly pinnedHttpsRequest?: PinnedHttpsRequestLike;
    readonly timeoutMs?: number;
  } = {},
): ComflyFetch {
  const maxResponseBytes = options.maxResponseBytes ?? 64 * 1024 * 1024;
  const pinnedHttpsRequest = options.pinnedHttpsRequest ?? nodeHttpsRequest as PinnedHttpsRequestLike;
  return async (url, init = {}) => {
    const parsedUrl = parseHttpsUrl(url);
    if (init.trustedResolvedAddress !== undefined) {
      return requestPinnedHttps(parsedUrl, init, init.trustedResolvedAddress, {
        maxResponseBytes,
        pinnedHttpsRequest,
        timeoutMs: options.timeoutMs,
      });
    }
    return await new Promise<ComflyFetchResponse>((resolve, reject) => {
      const request = net.request({
        url: parsedUrl.toString(),
        method: init.method ?? 'GET',
        redirect: 'manual',
      });
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (timeout !== null) clearTimeout(timeout);
        init.signal?.removeEventListener('abort', abort);
      };
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(sanitizeElectronNetError(message)));
      };
      const succeed = (response: ComflyFetchResponse) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(response);
      };
      const abort = () => {
        try {
          request.abort?.();
        } catch {
          // The sanitized abort error below is the public result.
        }
        fail('Provider network request aborted');
      };

      if (init.signal?.aborted) {
        abort();
        return;
      }
      init.signal?.addEventListener('abort', abort, { once: true });
      if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
        timeout = setTimeout(() => {
          try {
            request.abort?.();
          } catch {
            // The sanitized timeout error below is the public result.
          }
          fail('Provider network request timed out');
        }, options.timeoutMs);
      }

      for (const [name, value] of Object.entries(init.headers ?? {})) {
        request.setHeader?.(name, value);
      }
      request.on('response', (response) => {
        consumeResponse(response, request, maxResponseBytes, () => settled, fail, succeed);
      });
      request.on('redirect', () => fail('Provider network redirect was blocked'));
      request.on('error', () => fail('Provider network request failed'));
      if (init.body !== undefined) {
        request.write?.(init.body);
      }
      request.end();
    });
  };
}

function requestPinnedHttps(
  url: URL,
  init: NonNullable<Parameters<ComflyFetch>[1]>,
  trustedResolvedAddress: string,
  options: {
    readonly maxResponseBytes: number;
    readonly pinnedHttpsRequest: PinnedHttpsRequestLike;
    readonly timeoutMs?: number;
  },
): Promise<ComflyFetchResponse> {
  if (!/^[0-9a-f:.]+$/iu.test(trustedResolvedAddress)) {
    throw new Error('Provider network pinned address is invalid');
  }
  return new Promise<ComflyFetchResponse>((resolve, reject) => {
    const family: 4 | 6 = trustedResolvedAddress.includes(':') ? 6 : 4;
    const request = options.pinnedHttpsRequest({
      headers: init.headers,
      hostname: url.hostname,
      lookup: (_hostname, _lookupOptions, callback) => callback(null, trustedResolvedAddress, family),
      method: init.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      ...(url.port === '' ? {} : { port: url.port }),
      protocol: 'https:',
      servername: url.hostname,
    }, (response) => {
      consumeResponse(response, request, options.maxResponseBytes, () => settled, fail, succeed);
    });
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timeout !== null) clearTimeout(timeout);
      init.signal?.removeEventListener('abort', abort);
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(sanitizeElectronNetError(message)));
    };
    const succeed = (response: ComflyFetchResponse) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(response);
    };
    const abort = () => {
      try {
        request.abort?.();
      } catch {
        // The sanitized abort error below is the public result.
      }
      fail('Provider network request aborted');
    };
    if (init.signal?.aborted) {
      abort();
      return;
    }
    init.signal?.addEventListener('abort', abort, { once: true });
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        try {
          request.abort?.();
        } catch {
          // The sanitized timeout error below is the public result.
        }
        fail('Provider network request timed out');
      }, options.timeoutMs);
    }
    request.on('error', () => fail('Provider network request failed'));
    if (init.body !== undefined) request.write?.(init.body);
    request.end();
  });
}

function consumeResponse(
  response: ElectronIncomingMessageLike,
  request: ElectronClientRequestLike,
  maxResponseBytes: number,
  isSettled: () => boolean,
  fail: (message: string) => void,
  succeed: (response: ComflyFetchResponse) => void,
): void {
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  const declaredBytes = parseContentLength(response.headers);
  if (declaredBytes !== null && declaredBytes > maxResponseBytes) {
    failOversizedResponse();
    return;
  }
  response.on('data', (chunk) => {
    if (isSettled()) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receivedBytes += bytes.byteLength;
    if (receivedBytes > maxResponseBytes) {
      failOversizedResponse();
      return;
    }
    chunks.push(bytes);
  });
  response.on('end', () => {
    if (isSettled()) return;
    const bodyBytes = Buffer.concat(chunks);
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400) {
      fail('Provider network redirect was blocked');
      return;
    }
    succeed({
      ok: status >= 200 && status < 300,
      status,
      json: async () => parseJsonBody(bodyBytes.toString('utf8')),
      text: async () => bodyBytes.toString('utf8'),
      arrayBuffer: async () => bodyBytes.buffer.slice(
        bodyBytes.byteOffset,
        bodyBytes.byteOffset + bodyBytes.byteLength,
      ),
    } as ComflyFetchResponse & { text(): Promise<string> });
  });
  response.on('error', () => fail('Provider network response failed'));

  function failOversizedResponse(): void {
    fail('Provider network response was too large');
    try {
      request.abort?.();
    } catch {
      // The sanitized size failure above is the public result.
    }
  }
}

function parseContentLength(
  headers: Readonly<Record<string, string | readonly string[] | undefined>> | undefined,
): number | null {
  if (headers === undefined) return null;
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-length')?.[1];
  const raw = Array.isArray(entry) ? entry[0] : entry;
  if (raw === undefined || !/^\d+$/u.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER;
}

function parseHttpsUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Provider network request URL is invalid');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Provider network requests require HTTPS');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('Provider network request URL is invalid');
  }
  return parsed;
}

function parseJsonBody(body: string): unknown {
  try {
    return body.length === 0 ? null : JSON.parse(body);
  } catch {
    throw new Error('Provider returned invalid JSON response');
  }
}

function sanitizeElectronNetError(value: string): string {
  const sanitized = value
    .replace(/authorization\s*:\s*\S+(?:\s+\S+)?/giu, '[redacted]')
    .replace(/\bbearer\s+[a-z0-9._~+/=\-]+/giu, '[redacted]')
    .replace(/\bsk-[a-z0-9_-]{8,}\b/giu, '[redacted]')
    .replace(/\b(?:api[_ -]?key|token|secret|password)\s*[:=]\s*\S{4,}/giu, '[redacted]')
    .replace(/data:image\/[^;]+;base64,[a-z0-9+/=]+/giu, '[redacted]')
    .replace(/[A-Za-z]:[\\/][^\s"'`]+/gu, '[redacted]')
    .replace(/\\\\[^\\\s]+\\[^\s"'`]+/gu, '[redacted]')
    .replace(/(?:^|\s)\/(?:Users|home|var|opt|tmp|private)\/[^\s"'`]+/gu, ' [redacted]')
    .replace(/\s+/gu, ' ')
    .trim();
  return (sanitized || 'Provider network request failed').slice(0, 180);
}
