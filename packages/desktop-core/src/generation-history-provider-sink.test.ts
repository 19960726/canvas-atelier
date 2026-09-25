import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createElectronTrustedImageDecoder,
  GenerationHistoryProviderSink,
} from './generation-history-provider-sink';
import { GenerationHistoryStore } from './generation-history-store';

const temporaryRoots: string[] = [];

const validWebp2x1 = Buffer.from('UklGRh4CAABXRUJQVlA4WAoAAAAwAAAAAQAAAAAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZBTFBIAwAAAAD/gABWUDggJAAAAJABAJ0BKgIAAQABQCYlAE6AG6B2hgD+RogeBxUcnXrS3NuIAA==', 'base64');

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Electron trusted image decoder', () => {
  it('keeps nativeImage as the only path for its existing PNG decode', async () => {
    const createWindow = vi.fn();
    const createFromBuffer = vi.fn(() => ({
      isEmpty: () => false,
      getSize: () => ({ width: 2, height: 3 }),
    }));
    const decoder = createElectronTrustedImageDecoder({ createFromBuffer }, {
      createWebpDecodeWindow: createWindow,
    });

    await expect(Promise.resolve(decoder(new Uint8Array([1, 2, 3]), {
      format: 'png',
      mediaType: 'image/png',
      width: 2,
      height: 3,
    }))).resolves.toBe(true);
    expect(createWindow).not.toHaveBeenCalled();
  });

  it('falls back to a disposable sandboxed WebP decoder when nativeImage cannot decode WebP', async () => {
    const root = await mkdtemp(join(tmpdir(), 'generation-history-webp-decoder-'));
    temporaryRoots.push(root);
    const destroy = vi.fn();
    const loadURL = vi.fn().mockResolvedValue(undefined);
    const executeJavaScript = vi.fn().mockResolvedValue({ width: 2, height: 1, pixel: [0, 0, 0, 255] });
    const createWindow = vi.fn(() => ({
      destroy,
      isDestroyed: () => false,
      loadURL,
      webContents: { executeJavaScript },
    }));
    const createFromBuffer = vi.fn(() => ({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
    }));
    const decoder = createElectronTrustedImageDecoder({ createFromBuffer }, {
      createWebpDecodeWindow: createWindow,
      temporaryDirectoryRoot: root,
    });

    await expect(Promise.resolve(decoder(validWebp2x1, {
      format: 'webp',
      mediaType: 'image/webp',
      width: 2,
      height: 1,
    }))).resolves.toBe(true);
    expect(createFromBuffer).toHaveBeenCalledOnce();
    expect(createWindow).toHaveBeenCalledOnce();
    expect(loadURL).toHaveBeenCalledWith(expect.stringMatching(/^file:\/\/\/.*\.webp$/u));
    expect(executeJavaScript).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expect(await readdir(root)).toEqual([]);
  });

  it('rejects a browser WebP decode with mismatched dimensions and still cleans up', async () => {
    const root = await mkdtemp(join(tmpdir(), 'generation-history-webp-mismatch-'));
    temporaryRoots.push(root);
    const destroy = vi.fn();
    const decoder = createElectronTrustedImageDecoder({
      createFromBuffer: () => ({
        isEmpty: () => true,
        getSize: () => ({ width: 0, height: 0 }),
      }),
    }, {
      createWebpDecodeWindow: () => ({
        destroy,
        isDestroyed: () => false,
        loadURL: vi.fn().mockResolvedValue(undefined),
        webContents: {
          executeJavaScript: vi.fn().mockResolvedValue({ width: 3, height: 1, pixel: [0, 0, 0, 255] }),
        },
      }),
      temporaryDirectoryRoot: root,
    });

    await expect(Promise.resolve(decoder(validWebp2x1, {
      format: 'webp',
      mediaType: 'image/webp',
      width: 2,
      height: 1,
    }))).resolves.toBe(false);
    expect(destroy).toHaveBeenCalledOnce();
    expect(await readdir(root)).toEqual([]);
  });
});

describe('GenerationHistoryProviderSink provider identity', () => {
  it.each([
    ['comfly', 'Comfly'],
    ['relayme', 'RelayMe'],
    ['julun', '巨轮 API'],
    ['4dai', '4D AI'],
  ] as const)('records %s jobs under their owning provider display name', async (provider, displayName) => {
    const ownedRoot = await mkdtemp(join(tmpdir(), `generation-history-${provider}-`));
    temporaryRoots.push(ownedRoot);
    const store = new GenerationHistoryStore({
      historyRoot: join(ownedRoot, 'generation-history'),
      ownedRoot,
      now: () => Date.parse('2026-09-09T08:00:00.000Z'),
    });
    const sink = new GenerationHistoryProviderSink({
      store,
      trustedImageDecoder: async () => true,
      now: () => Date.parse('2026-09-09T08:00:00.000Z'),
    });

    const historyId = await sink.queued({
      jobId: `job-${provider}`,
      modelDisplayName: `${provider} model`,
      provider,
    });

    await expect(store.getRecords([historyId])).resolves.toEqual([
      expect.objectContaining({
        provider: expect.objectContaining({ displayName }),
      }),
    ]);
  });

  it('persists exact image model route and generation parameters for history recovery', async () => {
    const ownedRoot = await mkdtemp(join(tmpdir(), 'generation-history-image-metadata-'));
    temporaryRoots.push(ownedRoot);
    const store = new GenerationHistoryStore({
      historyRoot: join(ownedRoot, 'generation-history'),
      ownedRoot,
      now: () => Date.parse('2026-09-09T08:00:00.000Z'),
    });
    const sink = new GenerationHistoryProviderSink({
      store,
      trustedImageDecoder: async () => true,
      now: () => Date.parse('2026-09-09T08:00:00.000Z'),
    });

    const reservation = await sink.reserveSubmission({
      jobId: 'job-nano-banana-2-history',
      kind: 'image',
      modelDisplayName: 'Nano Banana 2',
      modelId: 'nano-banana-2',
      modelRoute: 'comfly-nano-banana-2-2k',
      parameters: { aspectRatio: '9:16', resolution: '2K', outputCount: 1 },
      provider: 'comfly',
    });

    const record = (await store.getRecords([reservation.historyId]))[0]!;
    expect(record.provider).toMatchObject({
      modelDisplayName: 'Nano Banana 2',
      modelId: 'nano-banana-2',
      modelRoute: 'comfly-nano-banana-2-2k',
    });
    expect(record.parameters).toMatchObject({ aspectRatio: '9:16', resolution: '2K', outputCount: 1 });
  });
});
