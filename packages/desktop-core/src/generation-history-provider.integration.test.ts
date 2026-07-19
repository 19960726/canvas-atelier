import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import type { ComflyFetch, ComflyFetchResponse } from '@agent-canvas/provider-comfly';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as desktopCore from './index';
import type { ProviderCredentialStore } from './provider-credential-vault';
import type { ProviderService } from './provider-service-types';
import { GenerationHistoryStore } from './generation-history-store';

interface HistorySink {
  cancelled(historyId: string): Promise<unknown>;
  failed(historyId: string, code: 'provider_failed' | 'provider_unavailable' | 'invalid_result'): Promise<unknown>;
  queued(input: { readonly jobId: string; readonly modelDisplayName: string }): Promise<string>;
  running(historyId: string): Promise<void>;
  succeeded(historyId: string, bytes: Uint8Array): Promise<unknown>;
}
type HistorySinkConstructor = new (options: {
  readonly trustedImageDecoder?: (bytes: Uint8Array, image: unknown) => boolean | Promise<boolean>;
  readonly store: GenerationHistoryStore;
}) => HistorySink;
type ProviderFactory = (options: {
  readonly appDataRoot: string;
  readonly credentialStore: ProviderCredentialStore;
  readonly fetch: ComflyFetch;
  readonly historySink: unknown;
  readonly profiles: readonly unknown[];
  readonly resolveResultHost: (hostname: string) => Promise<readonly string[]>;
}) => ProviderService;

const roots: string[] = [];
const pngBytes = createPng(2, 3);
const gifBytes = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
  0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
  0x00, 0x00, 0x00, 0xff, 0xff, 0xff,
  0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);
const jpegHeaderOnly = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
  0x00, 0x03, 0x00, 0x02, 0x03,
  0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  0xff, 0xd9,
]);
const webpVp8HeaderOnly = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x12, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
  0x06, 0x00, 0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a,
  0x02, 0x00, 0x03, 0x00,
]);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('provider generation history production sink', () => {
  it('records queued, running, succeeded, failed, and cancelled jobs through the real provider service', async () => {
    expect(desktopCore).toHaveProperty('GenerationHistoryProviderSink');
    const Sink = (desktopCore as Record<string, unknown>).GenerationHistoryProviderSink as HistorySinkConstructor | undefined;
    if (Sink === undefined) return;
    const root = await mkdtemp(join(tmpdir(), 'provider-generation-history-'));
    roots.push(root);
    const appDataRoot = join(root, 'user-data');
    await mkdir(appDataRoot);
    const store = new GenerationHistoryStore({
      historyRoot: join(appDataRoot, 'generation-history'),
      ownedRoot: appDataRoot,
    });
    const sink = new Sink({ store });
    const submitEntered = deferred<void>();
    const firstSubmit = deferred<ComflyFetchResponse>();
    const rawTaskIds = [
      ['raw', 'provider', 'task', 'succeeded'].join('-'),
      ['raw', 'provider', 'task', 'failed'].join('-'),
      ['raw', 'provider', 'task', 'cancelled'].join('-'),
    ];
    const resultUrl = ['https:', '//assets.example', '/generated.png'].join('');
    let submitCount = 0;
    const fetch: ComflyFetch = vi.fn(async (url) => {
      if (url.includes('/v1/images/generations')) {
        const index = submitCount++;
        if (index === 0) {
          submitEntered.resolve();
          return firstSubmit.promise;
        }
        return jsonResponse({ taskId: rawTaskIds[index], status: 'queued' });
      }
      if (url.includes(encodeURIComponent(rawTaskIds[0]!))) {
        return jsonResponse({
          taskId: rawTaskIds[0],
          status: 'succeeded',
          data: [{ url: resultUrl, width: 2, height: 3 }],
        });
      }
      if (url.includes(encodeURIComponent(rawTaskIds[1]!))) {
        return jsonResponse({ taskId: rawTaskIds[1], status: 'failed' });
      }
      if (url === resultUrl) return binaryResponse(pngBytes);
      throw new Error('unexpected provider request');
    });
    const resolveResultHost = vi.fn(async () => ['93.184.216.34']);
    const service = (desktopCore.createComflyProviderService as unknown as ProviderFactory)({
      appDataRoot,
      credentialStore: credentialStore(),
      fetch,
      historySink: sink,
      resolveResultHost,
      profiles: [{
        provider: 'comfly',
        modelRoute: 'gpt-image',
        displayName: 'GPT Image',
        capabilities: ['image_generation', 'async_tasks'],
      }],
    });
    const prompt = 'A private product prompt that must not be durable';
    const submitSucceeded = service.submitImageJob({
      jobId: 'job-provider-history-succeeded',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt,
      conversationId: 'conversation-provider-history-succeeded',
      referenceAssetIds: [],
    });
    await submitEntered.promise;
    expect((await store.list({ filters: { trashState: 'all' } })).records.map((record) => record.status))
      .toEqual(['queued']);
    firstSubmit.resolve(jsonResponse({ taskId: rawTaskIds[0], status: 'queued' }));
    const succeededHandle = await submitSucceeded;
    expect((await store.list({ filters: { trashState: 'all' } })).records[0]!.status).toBe('running');
    const completedPoll = await service.pollImageJob({
      provider: 'comfly',
      providerTaskId: succeededHandle.providerTaskId,
    });
    expect(resolveResultHost).toHaveBeenCalledWith('assets.example');
    expect(fetch).toHaveBeenCalledWith(resultUrl, { trustedResolvedAddress: '93.184.216.34' });
    expect(completedPoll).toMatchObject({ status: 'completed' });

    const failedHandle = await service.submitImageJob({
      jobId: 'job-provider-history-failed',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'A second private prompt',
      conversationId: 'conversation-provider-history-failed',
      referenceAssetIds: [],
    });
    await expect(service.pollImageJob({
      provider: 'comfly',
      providerTaskId: failedHandle.providerTaskId,
    })).resolves.toMatchObject({ status: 'failed' });

    const cancelledHandle = await service.submitImageJob({
      jobId: 'job-provider-history-cancelled',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'A third private prompt',
      conversationId: 'conversation-provider-history-cancelled',
      referenceAssetIds: [],
    });
    await expect(service.cancelImageJob({
      provider: 'comfly',
      providerTaskId: cancelledHandle.providerTaskId,
    })).resolves.toMatchObject({ status: 'cancelled' });

    const records = (await store.list({ filters: { trashState: 'all' }, sort: 'oldest' })).records;
    expect(records.map((record) => record.status)).toEqual(['succeeded', 'failed', 'cancelled']);
    const succeeded = records[0]!;
    expect(succeeded.output).toMatchObject({
      availability: 'available',
      byteSize: pngBytes.byteLength,
      format: 'png',
      height: 3,
      mediaType: 'image/png',
      width: 2,
    });
    expect(await readFile(join(
      appDataRoot,
      'generation-history',
      'originals',
      `${succeeded.output!.historyAssetId}.png`,
    ))).toEqual(pngBytes);
    const serializedIndex = await readFile(join(appDataRoot, 'generation-history', 'history.index.json'), 'utf8');
    expect(serializedIndex).not.toContain(prompt);
    expect(serializedIndex).not.toContain('conversation-provider-history');
    expect(serializedIndex).not.toContain(resultUrl);
    expect(serializedIndex).not.toContain(rawTaskIds[0]);
  }, 15_000);

  it('persists submission failures without durable prompt or conversation content', async () => {
    const { appDataRoot, sink, store } = await createHistorySink();
    const fetch: ComflyFetch = vi.fn(async () => {
      throw new Error('provider network request failed');
    });
    const service = createProviderService(appDataRoot, fetch, sink);
    const prompt = 'A submission prompt that must never reach history';

    await expect(service.submitImageJob({
      jobId: 'job-provider-history-submit-failed',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt,
      conversationId: 'conversation-provider-history-submit-failed',
      referenceAssetIds: [],
    })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });

    const records = (await store.list({ filters: { trashState: 'all' } })).records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      status: 'failed',
      termination: { code: 'provider_unavailable', message: 'Provider unavailable' },
    });
    const serializedIndex = await readFile(join(appDataRoot, 'generation-history', 'history.index.json'), 'utf8');
    expect(serializedIndex).not.toContain(prompt);
    expect(serializedIndex).not.toContain('conversation-provider-history-submit-failed');
  });

  it('blocks local or literal result URLs before download and records an invalid result', async () => {
    const { appDataRoot, sink, store } = await createHistorySink();
    const rawTaskId = 'raw-provider-task-private-result';
    const fetch: ComflyFetch = vi.fn(async (url) => {
      if (url.includes('/v1/images/generations')) return jsonResponse({ taskId: rawTaskId, status: 'queued' });
      if (url.includes(encodeURIComponent(rawTaskId))) {
        return jsonResponse({
          taskId: rawTaskId,
          status: 'succeeded',
          data: [{ url: 'https://127.0.0.1/generated.png', width: 2, height: 3 }],
        });
      }
      throw new Error('unsafe result download was attempted');
    });
    const service = createProviderService(appDataRoot, fetch, sink);
    const submitted = await service.submitImageJob({
      jobId: 'job-provider-history-private-result',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'private prompt',
      conversationId: 'conversation-provider-history-private-result',
      referenceAssetIds: [],
    });

    await expect(service.pollImageJob({
      provider: 'comfly',
      providerTaskId: submitted.providerTaskId,
    })).resolves.toMatchObject({ status: 'failed' });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await store.list({ filters: { trashState: 'all' } })).records[0]).toMatchObject({
      status: 'failed',
      termination: { code: 'invalid_result', message: 'Generated result was invalid' },
    });
  });

  it('rejects a result hostname when any resolved address is private', async () => {
    const { appDataRoot, sink } = await createHistorySink();
    const rawTaskId = 'raw-provider-task-private-dns-result';
    const resultUrl = 'https://private-target.example/generated.png';
    const fetch: ComflyFetch = vi.fn(async (url) => {
      if (url.includes('/v1/images/generations')) return jsonResponse({ taskId: rawTaskId, status: 'queued' });
      if (url.includes(encodeURIComponent(rawTaskId))) {
        return jsonResponse({ taskId: rawTaskId, status: 'succeeded', data: [{ url: resultUrl }] });
      }
      return binaryResponse(pngBytes);
    });
    const service = createProviderService(appDataRoot, fetch, sink, async () => [
      '93.184.216.34',
      '127.0.0.1',
    ]);
    const submitted = await service.submitImageJob({
      jobId: 'job-provider-history-private-dns-result',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'private prompt',
      conversationId: 'conversation-provider-history-private-dns-result',
      referenceAssetIds: [],
    });

    await expect(service.pollImageJob({ provider: 'comfly', providerTaskId: submitted.providerTaskId }))
      .resolves.toMatchObject({ status: 'failed' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('fails closed when result-host DNS resolution fails', async () => {
    const { appDataRoot, sink } = await createHistorySink();
    const rawTaskId = 'raw-provider-task-dns-failure';
    const fetch: ComflyFetch = vi.fn(async (url) => {
      if (url.includes('/v1/images/generations')) return jsonResponse({ taskId: rawTaskId, status: 'queued' });
      if (url.includes(encodeURIComponent(rawTaskId))) {
        return jsonResponse({
          taskId: rawTaskId,
          status: 'succeeded',
          data: [{ url: 'https://unresolved-target.example/generated.png' }],
        });
      }
      return binaryResponse(pngBytes);
    });
    const service = createProviderService(appDataRoot, fetch, sink, async () => {
      throw new Error('dns unavailable');
    });
    const submitted = await service.submitImageJob({
      jobId: 'job-provider-history-dns-failure',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'private prompt',
      conversationId: 'conversation-provider-history-dns-failure',
      referenceAssetIds: [],
    });

    await expect(service.pollImageJob({ provider: 'comfly', providerTaskId: submitted.providerTaskId }))
      .resolves.toMatchObject({ status: 'failed' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['truncated PNG', pngBytes.subarray(0, 29)],
    ['PNG with trailing bytes', Buffer.concat([pngBytes, Buffer.from([0x00])])],
    ['PNG with deceptive dimensions', createDimensionMismatchPng()],
    ['truncated GIF', gifBytes.subarray(0, gifBytes.byteLength - 1)],
    ['JPEG without scan data', jpegHeaderOnly],
    ['WebP VP8 header without frame data', webpVp8HeaderOnly],
  ])('rejects a structurally invalid %s instead of persisting an available original', async (_name, invalidBytes) => {
    const { sink, store } = await createHistorySink();
    const historyId = await sink.queued({
      jobId: `job-invalid-image-${String(_name).replace(/\s+/gu, '-').toLowerCase()}`,
      modelDisplayName: 'GPT Image',
    });
    await sink.running(historyId);

    await expect(sink.succeeded(historyId, invalidBytes)).rejects.toThrow(/invalid/i);
    expect((await store.list({ filters: { trashState: 'all' } })).records[0]!.status).toBe('running');
  });

  it('requires the injected trusted decoder to accept a provider image before persisting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'provider-generation-history-'));
    roots.push(root);
    const appDataRoot = join(root, 'user-data');
    await mkdir(appDataRoot);
    const store = new GenerationHistoryStore({
      historyRoot: join(appDataRoot, 'generation-history'),
      ownedRoot: appDataRoot,
    });
    const Sink = (desktopCore as Record<string, unknown>).GenerationHistoryProviderSink as HistorySinkConstructor;
    const sink = new Sink({ store, trustedImageDecoder: async () => false });
    const historyId = await sink.queued({
      jobId: 'job-trusted-decoder-rejects',
      modelDisplayName: 'GPT Image',
    });
    await sink.running(historyId);

    await expect(sink.succeeded(historyId, pngBytes)).rejects.toThrow(/invalid/i);
    expect((await store.list({ filters: { trashState: 'all' } })).records[0]!.status).toBe('running');
  });

  it('reconciles a succeeded history terminal after restart when the provider later reports failure', async () => {
    const { appDataRoot, sink, store } = await createHistorySink();
    const rawTaskId = 'raw-provider-task-history-first-succeeded';
    const firstService = createProviderService(
      appDataRoot,
      vi.fn(async () => jsonResponse({ taskId: rawTaskId, status: 'queued' })),
      sink,
    );
    const submitted = await firstService.submitImageJob({
      jobId: 'job-provider-history-first-succeeded',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'private prompt',
      conversationId: 'conversation-provider-history-first-succeeded',
      referenceAssetIds: [],
    });
    const historyId = await sink.queued({
      jobId: 'job-provider-history-first-succeeded',
      modelDisplayName: 'GPT Image',
    });
    await sink.succeeded(historyId, pngBytes);
    const restartedFetch: ComflyFetch = vi.fn(async () => jsonResponse({ taskId: rawTaskId, status: 'failed' }));
    const restarted = createProviderService(appDataRoot, restartedFetch, sink);

    await expect(restarted.pollImageJob({
      provider: 'comfly',
      providerTaskId: submitted.providerTaskId,
    })).resolves.toMatchObject({ status: 'completed', result: { width: 2, height: 3 } });
    expect(restartedFetch).not.toHaveBeenCalled();
    expect((await store.list({ filters: { trashState: 'all' } })).records[0]!.status).toBe('succeeded');
  });

  it('keeps a failed history terminal when a concurrent cancel arrives before the ledger terminal commit', async () => {
    const { appDataRoot, sink, store } = await createHistorySink();
    const rawTaskId = 'raw-provider-task-history-first-failed';
    const service = createProviderService(
      appDataRoot,
      vi.fn(async () => jsonResponse({ taskId: rawTaskId, status: 'queued' })),
      sink,
    );
    const submitted = await service.submitImageJob({
      jobId: 'job-provider-history-first-failed',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'private prompt',
      conversationId: 'conversation-provider-history-first-failed',
      referenceAssetIds: [],
    });
    const historyId = await sink.queued({
      jobId: 'job-provider-history-first-failed',
      modelDisplayName: 'GPT Image',
    });
    await sink.failed(historyId, 'provider_failed');

    await expect(service.cancelImageJob({
      provider: 'comfly',
      providerTaskId: submitted.providerTaskId,
    })).resolves.toMatchObject({ status: 'failed' });
    expect((await store.list({ filters: { trashState: 'all' } })).records[0]!.status).toBe('failed');
  });

  it('returns the first durable terminal for concurrent different terminal updates', async () => {
    const { sink, store } = await createHistorySink();
    const historyId = await sink.queued({
      jobId: 'job-provider-history-concurrent-terminal',
      modelDisplayName: 'GPT Image',
    });
    await sink.running(historyId);

    const results = await Promise.all([
      sink.failed(historyId, 'provider_failed'),
      sink.cancelled(historyId),
    ]);

    const terminals = results as Array<{ readonly status: string }>;
    expect(terminals[1]).toEqual(terminals[0]);
    expect((await store.list({ filters: { trashState: 'all' } })).records[0]!.status).toBe(terminals[0]!.status);
  });

  it('uses pinned DNS evidence for the actual result download transport', async () => {
    const { appDataRoot, sink } = await createHistorySink();
    const rawTaskId = 'raw-provider-task-pinned-download';
    const resultUrl = 'https://assets.example/generated.png';
    const fetch: ComflyFetch = vi.fn(async (url, init) => {
      if (url.includes('/v1/images/generations')) return jsonResponse({ taskId: rawTaskId, status: 'queued' });
      if (url.includes(encodeURIComponent(rawTaskId))) {
        return jsonResponse({ taskId: rawTaskId, status: 'succeeded', data: [{ url: resultUrl }] });
      }
      expect(init).toMatchObject({ trustedResolvedAddress: '93.184.216.34' });
      return binaryResponse(pngBytes);
    });
    const service = createProviderService(appDataRoot, fetch, sink);
    const submitted = await service.submitImageJob({
      jobId: 'job-provider-history-pinned-download',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'private prompt',
      conversationId: 'conversation-provider-history-pinned-download',
      referenceAssetIds: [],
    });

    await expect(service.pollImageJob({ provider: 'comfly', providerTaskId: submitted.providerTaskId }))
      .resolves.toMatchObject({ status: 'completed' });
  });

  it('does not submit another paid provider request when the same job id is already terminal', async () => {
    const { appDataRoot, sink } = await createHistorySink();
    const rawTaskId = 'raw-provider-task-same-job-terminal';
    const firstFetch: ComflyFetch = vi.fn(async () => jsonResponse({ taskId: rawTaskId, status: 'queued' }));
    const firstService = createProviderService(appDataRoot, firstFetch, sink);
    await firstService.submitImageJob({
      jobId: 'job-provider-history-same-terminal',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'private prompt',
      conversationId: 'conversation-provider-history-same-terminal',
      referenceAssetIds: [],
    });
    const historyId = await sink.queued({
      jobId: 'job-provider-history-same-terminal',
      modelDisplayName: 'GPT Image',
    });
    await sink.failed(historyId, 'provider_failed');
    const retryFetch: ComflyFetch = vi.fn(async () => {
      throw new Error('paid provider request must not be retried for terminal job id');
    });
    const retryService = createProviderService(appDataRoot, retryFetch, sink);

    await expect(retryService.submitImageJob({
      jobId: 'job-provider-history-same-terminal',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'private prompt retry',
      conversationId: 'conversation-provider-history-same-terminal-retry',
      referenceAssetIds: [],
    })).resolves.toMatchObject({ providerTaskId: expect.any(String) });
    expect(retryFetch).not.toHaveBeenCalled();
  });

  it('wires one shared durable store into history handlers and the provider sink in both desktop mains', async () => {
    for (const mainPath of [
      join(process.cwd(), 'apps/desktop-modern/src/main.ts'),
      join(process.cwd(), 'apps/desktop-legacy/src/main.ts'),
    ]) {
      const source = await readFile(mainPath, 'utf8');
      expect(source).toContain('const generationHistoryStore = new GenerationHistoryStore({');
      expect(source).toContain('historyStore: generationHistoryStore');
      expect(source).toContain('historySink: new GenerationHistoryProviderSink({');
      expect(source).toContain('trustedImageDecoder: createElectronTrustedImageDecoder(nativeImage)');
      expect(source).toContain("lookup(hostname, { all: true, verbatim: true })");
    }
  });
});

async function createHistorySink(): Promise<{
  readonly appDataRoot: string;
  readonly sink: HistorySink;
  readonly store: GenerationHistoryStore;
}> {
  const root = await mkdtemp(join(tmpdir(), 'provider-generation-history-'));
  roots.push(root);
  const appDataRoot = join(root, 'user-data');
  await mkdir(appDataRoot);
  const store = new GenerationHistoryStore({
    historyRoot: join(appDataRoot, 'generation-history'),
    ownedRoot: appDataRoot,
  });
  const Sink = (desktopCore as Record<string, unknown>).GenerationHistoryProviderSink as HistorySinkConstructor;
  return { appDataRoot, sink: new Sink({ store }), store };
}

function createPng(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function createDimensionMismatchPng(): Buffer {
  const bytes = createPng(2, 3);
  bytes.writeUInt32BE(4, 16);
  const typeAndData = bytes.subarray(12, 29);
  bytes.writeUInt32BE(crc32(typeAndData), 29);
  return bytes;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.byteLength);
  return chunk;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb88320);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createProviderService(
  appDataRoot: string,
  fetch: ComflyFetch,
  historySink: unknown,
  resolveResultHost: (hostname: string) => Promise<readonly string[]> = async () => ['93.184.216.34'],
): ProviderService {
  return (desktopCore.createComflyProviderService as unknown as ProviderFactory)({
    appDataRoot,
    credentialStore: credentialStore(),
    fetch,
    historySink,
    resolveResultHost,
    profiles: [{
      provider: 'comfly',
      modelRoute: 'gpt-image',
      displayName: 'GPT Image',
      capabilities: ['image_generation', 'async_tasks'],
    }],
  });
}

function credentialStore(): ProviderCredentialStore {
  const mappingKey = '11'.repeat(32);
  return {
    configure: async () => undefined,
    unlock: async () => undefined,
    getStatus: async () => ({ configured: true, locked: false, encryption: 'safeStorage' }),
    getToken: async () => ['provider', 'credential'].join('-'),
    getMappingKey: async () => mappingKey,
    getMappingSecrets: async () => ({ primary: mappingKey, fallback: [] }),
  };
}

function jsonResponse(value: unknown): ComflyFetchResponse {
  return { ok: true, status: 200, json: async () => value };
}

function binaryResponse(bytes: Uint8Array): ComflyFetchResponse {
  const buffer = Buffer.from(bytes);
  return {
    ok: true,
    status: 200,
    json: async () => null,
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  } as ComflyFetchResponse & { arrayBuffer(): Promise<ArrayBuffer> };
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value?: T): void } {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: (value?: T) => resolvePromise(value as T) };
}
