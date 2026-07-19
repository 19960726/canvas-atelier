import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { createElectronNetComflyFetch, type ElectronNetLike } from './electron-net-fetch';

describe('Electron provider transport response bounds', () => {
  it('rejects an oversized Content-Length before accepting response bytes', async () => {
    const net = responseNet({ headers: { 'content-length': ['9'] }, chunks: [] });
    const fetch = createElectronNetComflyFetch(net.adapter, { maxResponseBytes: 8 });

    await expect(fetch('https://assets.example/image.png')).rejects.toThrow(/too large/i);
    expect(net.aborted).toBe(true);
  });

  it('bounds chunked responses without Content-Length while accumulating', async () => {
    const net = responseNet({ chunks: [Buffer.alloc(5), Buffer.alloc(5)] });
    const fetch = createElectronNetComflyFetch(net.adapter, { maxResponseBytes: 8 });

    await expect(fetch('https://assets.example/image.png')).rejects.toThrow(/too large/i);
    expect(net.aborted).toBe(true);
  });

  it('does not trust a falsely small Content-Length header', async () => {
    const net = responseNet({ headers: { 'content-length': ['4'] }, chunks: [Buffer.alloc(9)] });
    const fetch = createElectronNetComflyFetch(net.adapter, { maxResponseBytes: 8 });

    await expect(fetch('https://assets.example/image.png')).rejects.toThrow(/too large/i);
    expect(net.aborted).toBe(true);
  });

  it('blocks redirects before consuming the redirected response body', async () => {
    const net = responseNet({ chunks: [Buffer.alloc(9)], redirect: true });
    const fetch = createElectronNetComflyFetch(net.adapter, { maxResponseBytes: 8 });

    await expect(fetch('https://assets.example/image.png')).rejects.toThrow(/redirect/i);
    expect(net.dataEmitted).toBe(false);
  });

  it('pins the actual HTTPS lookup address while preserving the verified hostname for TLS', async () => {
    const net = responseNet({ chunks: [Buffer.from('{}')] });
    const pinned = pinnedHttpsRequest({ chunks: [Buffer.from('{}')] });
    const fetch = createElectronNetComflyFetch(net.adapter, {
      pinnedHttpsRequest: pinned.adapter,
    });

    await expect(fetch('https://assets.example/image.png', {
      trustedResolvedAddress: '93.184.216.34',
    })).resolves.toMatchObject({ ok: true, status: 200 });
    expect(net.requestUrl).toBeNull();
    expect(pinned.options?.hostname).toBe('assets.example');
    expect(pinned.options?.servername).toBe('assets.example');
    expect(pinned.options?.path).toBe('/image.png');
    const resolved = await pinned.lookup('assets.example');
    expect(resolved).toEqual({ address: '93.184.216.34', family: 4 });
  });
});

function responseNet(options: {
  readonly chunks: readonly Buffer[];
  readonly headers?: Readonly<Record<string, readonly string[]>>;
  readonly redirect?: boolean;
}): {
  readonly adapter: ElectronNetLike;
  aborted: boolean;
  dataEmitted: boolean;
  readonly headers: Record<string, string>;
  requestUrl: string | null;
} {
  const state = {
    adapter: undefined as unknown as ElectronNetLike,
    aborted: false,
    dataEmitted: false,
    headers: {} as Record<string, string>,
    requestUrl: null as string | null,
  };
  state.adapter = {
    request(requestOptions) {
      state.requestUrl = requestOptions.url;
      const request = new EventEmitter() as EventEmitter & {
        abort(): void;
        end(): void;
        setHeader(name: string, value: string): void;
      };
      request.abort = () => { state.aborted = true; };
      request.setHeader = (name, value) => { state.headers[name.toLowerCase()] = value; };
      request.end = () => {
        queueMicrotask(() => {
          if (options.redirect === true) {
            request.emit('redirect', 302, 'GET', 'https://other.example/image.png', {});
            return;
          }
          const response = new EventEmitter() as EventEmitter & {
            readonly headers?: Readonly<Record<string, readonly string[]>>;
            readonly statusCode: number;
          };
          Object.defineProperties(response, {
            headers: { value: options.headers },
            statusCode: { value: 200 },
          });
          request.emit('response', response);
          for (const chunk of options.chunks) {
            state.dataEmitted = true;
            response.emit('data', chunk);
          }
          response.emit('end');
        });
      };
      return request;
    },
  };
  return state;
}

function pinnedHttpsRequest(options: {
  readonly chunks: readonly Buffer[];
}): {
  readonly adapter: NonNullable<Parameters<typeof createElectronNetComflyFetch>[1]>['pinnedHttpsRequest'];
  options: {
    readonly hostname: string;
    readonly lookup: (
      hostname: string,
      options: unknown,
      callback: (error: NodeJS.ErrnoException | null, address: string, family: 4 | 6) => void,
    ) => void;
    readonly path: string;
    readonly servername: string;
  } | null;
  lookup(hostname: string): Promise<{ readonly address: string; readonly family: 4 | 6 }>;
} {
  const state = {
    options: null as ReturnType<typeof pinnedHttpsRequest>['options'],
  };
  const adapter: ReturnType<typeof pinnedHttpsRequest>['adapter'] = (requestOptions, listener) => {
    state.options = requestOptions;
    const request = new EventEmitter() as EventEmitter & {
      abort(): void;
      end(): void;
      write?(chunk: string): void;
    };
    request.abort = () => undefined;
    request.write = () => undefined;
    request.end = () => {
      queueMicrotask(() => {
        const response = new EventEmitter() as EventEmitter & {
          readonly statusCode: number;
        };
        Object.defineProperty(response, 'statusCode', { value: 200 });
        listener(response);
        for (const chunk of options.chunks) response.emit('data', chunk);
        response.emit('end');
      });
    };
    return request;
  };
  return {
    adapter,
    get options() { return state.options; },
    lookup: (hostname) => new Promise((resolve, reject) => {
      if (state.options === null) {
        reject(new Error('lookup was not captured'));
        return;
      }
      state.options.lookup(hostname, {}, (error, address, family) => {
        if (error !== null) reject(error);
        else resolve({ address, family });
      });
    }),
  };
}
