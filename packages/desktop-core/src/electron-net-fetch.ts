import type { ComflyFetch, ComflyFetchResponse } from '@agent-canvas/provider-comfly';

export interface ElectronNetLike {
  request(options: { readonly url: string; readonly method: string }): ElectronClientRequestLike;
}

export interface ElectronClientRequestLike {
  setHeader?(name: string, value: string): void;
  write?(chunk: string): void;
  end(): void;
  abort?(): void;
  on(event: 'response', listener: (response: ElectronIncomingMessageLike) => void): this;
  on(event: 'error', listener: (error: unknown) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
}

export interface ElectronIncomingMessageLike {
  readonly statusCode?: number;
  on(event: 'data', listener: (chunk: string | Uint8Array) => void): this;
  on(event: 'end', listener: () => void): this;
  on(event: 'error', listener: (error: unknown) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
}

export function createElectronNetComflyFetch(
  net: ElectronNetLike,
  options: { readonly timeoutMs?: number } = {},
): ComflyFetch {
  return async (url, init = {}) => {
    const parsedUrl = parseHttpsUrl(url);
    return await new Promise<ComflyFetchResponse>((resolve, reject) => {
      const request = net.request({
        url: parsedUrl.toString(),
        method: init.method ?? 'GET',
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
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const status = response.statusCode ?? 0;
          succeed({
            ok: status >= 200 && status < 300,
            status,
            json: async () => parseJsonBody(body),
            text: async () => body,
          } as ComflyFetchResponse & { text(): Promise<string> });
        });
        response.on('error', () => fail('Provider network response failed'));
      });
      request.on('error', () => fail('Provider network request failed'));
      if (init.body !== undefined) {
        request.write?.(init.body);
      }
      request.end();
    });
  };
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
