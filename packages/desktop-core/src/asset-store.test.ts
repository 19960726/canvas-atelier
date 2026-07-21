import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AssetStore, verifyAssetFile } from './asset-store';

const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x9d, 0x74, 0x66,
  0x7a, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

describe('AssetStore', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it('commits streamed bytes before returning content-addressed asset metadata', async () => {
    const projectRoot = await createProjectRoot(tempRoots);
    const store = new AssetStore();

    const asset = await store.stageAndCommit(projectRoot, readableFrom(pngBytes), {
      originalName: 'Reference.PNG',
    });

    const expectedHash = sha256(pngBytes);
    expect(asset).toMatchObject({
      byteSize: pngBytes.length,
      extension: 'png',
      height: 3,
      id: expectedHash.slice(0, 16),
      mediaType: 'image/png',
      relativePath: `assets/${expectedHash.slice(0, 16)}.png`,
      sha256: expectedHash,
      width: 2,
    });
    expect(await readFile(join(projectRoot, asset.relativePath))).toEqual(pngBytes);
  });

  it('commits a structurally valid MP4 as a managed video asset', async () => {
    const projectRoot = await createProjectRoot(tempRoots);
    const store = new AssetStore();
    const mp4Bytes = createMinimalMp4();

    const asset = await store.stageAndCommit(projectRoot, readableFrom(mp4Bytes), {
      mediaType: 'video/mp4',
      originalName: 'turntable.mp4',
    });

    expect(asset).toMatchObject({
      byteSize: mp4Bytes.length,
      extension: 'mp4',
      height: null,
      mediaType: 'video/mp4',
      width: null,
    });
    expect(await readFile(join(projectRoot, asset.relativePath))).toEqual(mp4Bytes);
  });

  it('omits a catalogued MP4 when same-size bytes fail integrity verification', async () => {
    const projectRoot = await createProjectRoot(tempRoots);
    const store = new AssetStore();
    const mp4Bytes = createMinimalMp4();
    const asset = await store.stageAndCommit(projectRoot, readableFrom(mp4Bytes), {
      mediaType: 'video/mp4',
      originalName: 'turntable.mp4',
    });
    const corrupted = Buffer.from(mp4Bytes);
    corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
    await writeFile(join(projectRoot, asset.relativePath), corrupted);

    await expect(store.list(projectRoot, [{
      assetId: asset.id,
      byteSize: asset.byteSize,
      extension: asset.extension,
      height: asset.height,
      mediaType: asset.mediaType,
      sha256: asset.sha256,
      width: asset.width,
    }])).resolves.toEqual([]);
  });

  it('single-flights unchanged catalog verification and invalidates it after same-size replacement', async () => {
    const projectRoot = await createProjectRoot(tempRoots);
    const expectedHash = sha256(pngBytes);
    const assetId = expectedHash.slice(0, 16);
    const assetPath = join(projectRoot, 'assets', `${assetId}.png`);
    await writeFile(assetPath, pngBytes);
    const catalog = [{
      assetId,
      byteSize: pngBytes.length,
      extension: 'png' as const,
      height: 3,
      mediaType: 'image/png' as const,
      sha256: expectedHash,
      width: 2,
    }];
    const verify = vi.fn(verifyAssetFile);
    const store = new AssetStore(verify);

    const [first, second] = await Promise.all([
      store.list(projectRoot, catalog),
      store.list(projectRoot, catalog),
    ]);
    await expect(store.resolvePath(projectRoot, assetId, 'png', expectedHash, pngBytes.length))
      .resolves.toBe(await realpath(assetPath));
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(verify).toHaveBeenCalledOnce();

    const corrupted = Buffer.from(pngBytes);
    corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
    await writeFile(assetPath, corrupted);
    await expect(store.resolvePath(projectRoot, assetId, 'png', expectedHash, pngBytes.length)).resolves.toBeNull();
  });

  it('single-flights concurrent verified path resolution', async () => {
    const projectRoot = await createProjectRoot(tempRoots);
    const bytes = createMinimalMp4();
    const expectedHash = sha256(bytes);
    const assetId = expectedHash.slice(0, 16);
    const assetPath = join(projectRoot, 'assets', `${assetId}.mp4`);
    await writeFile(assetPath, bytes);
    const inspect = vi.fn(async () => ({
      byteSize: bytes.length,
      extension: 'mp4' as const,
      height: null,
      id: assetId,
      mediaType: 'video/mp4' as const,
      relativePath: `assets/${assetId}.mp4`,
      sha256: expectedHash,
      width: null,
    }));
    const store = new AssetStore(verifyAssetFile, inspect);

    const results = await Promise.all([
      store.resolvePath(projectRoot, assetId, 'mp4', expectedHash, bytes.length),
      store.resolvePath(projectRoot, assetId, 'mp4', expectedHash, bytes.length),
    ]);

    expect(results).toEqual([await realpath(assetPath), await realpath(assetPath)]);
    expect(inspect).toHaveBeenCalledOnce();
  });

  it.each([
    ['empty ftyp', Buffer.concat([mp4Box('ftyp'), validMoovBox(), mp4Box('mdat', Buffer.from([1]))])],
    ['empty moov', Buffer.concat([mp4Box('ftyp', Buffer.from('isom\0\0\0\0isom')), mp4Box('moov'), mp4Box('mdat', Buffer.from([1]))])],
    ['garbage moov payload', Buffer.concat([mp4Box('ftyp', Buffer.from('isom\0\0\0\0isom')), mp4Box('moov', Buffer.from('garbage')), mp4Box('mdat', Buffer.from([1]))])],
    ['moov without trak', Buffer.concat([mp4Box('ftyp', Buffer.from('isom\0\0\0\0isom')), mp4Box('moov', validMvhdBox()), mp4Box('mdat', Buffer.from([1]))])],
    ['missing moov', Buffer.concat([mp4Box('ftyp', Buffer.from('isom\0\0\0\0isom')), mp4Box('mdat', Buffer.from([1]))])],
    ['missing mdat', Buffer.concat([mp4Box('ftyp', Buffer.from('isom\0\0\0\0isom')), mp4Box('moov')])],
    ['truncated box', Buffer.concat([mp4Box('ftyp', Buffer.from('isom\0\0\0\0isom')), Buffer.from([0, 0, 0, 40, 0x6d, 0x6f, 0x6f, 0x76])])],
    ['spoofed bytes', Buffer.from('not an mp4 file')],
  ])('rejects invalid MP4 structure: %s', async (_label, bytes) => {
    const projectRoot = await createProjectRoot(tempRoots);
    const store = new AssetStore();

    await expect(store.stageAndCommit(projectRoot, readableFrom(bytes), {
      mediaType: 'video/mp4',
      originalName: 'unsafe.mp4',
    })).rejects.toMatchObject({ code: 'PACKAGE_VALIDATION_FAILED' });

    expect(await readdir(join(projectRoot, 'assets'))).toEqual([]);
  });

  it('enumerates verified managed images and resolves only content-addressed ids', async () => {
    const projectRoot = await createProjectRoot(tempRoots);
    const store = new AssetStore();
    const asset = await store.stageAndCommit(projectRoot, readableFrom(pngBytes), {
      originalName: 'Reference.PNG',
    });
    await writeFile(join(projectRoot, 'assets', 'not-an-asset.png'), Buffer.from('not an image'));
    await writeFile(join(projectRoot, 'assets', `${asset.id}.gif`), Buffer.from('GIF89a-not-the-catalogued-image'));

    await expect(store.list(projectRoot)).resolves.toEqual([asset]);
    await expect(store.resolvePath(projectRoot, asset.id, asset.extension))
      .resolves.toBe(await realpath(join(projectRoot, asset.relativePath)));
    await expect(store.resolvePath(projectRoot, '../project.novus.json')).resolves.toBeNull();
    await expect(store.resolvePath(projectRoot, 'not-an-asset')).resolves.toBeNull();

    const tamperedBytes = Buffer.from(pngBytes);
    tamperedBytes[tamperedBytes.length - 1] = tamperedBytes[tamperedBytes.length - 1]! ^ 1;
    await writeFile(join(projectRoot, asset.relativePath), tamperedBytes);
    await expect(store.resolvePath(
      projectRoot,
      asset.id,
      asset.extension,
      asset.sha256,
      asset.byteSize,
    )).resolves.toBeNull();
  });

  it('omits durable catalog entries whose complete content hash does not match', async () => {
    const projectRoot = await createProjectRoot(tempRoots);
    const store = new AssetStore();
    const catalog = Array.from({ length: 32 }, (_, index) => {
      const assetId = index.toString(16).padStart(16, '0');
      return {
        assetId,
        byteSize: pngBytes.length,
        extension: 'png' as const,
        height: 3,
        mediaType: 'image/png' as const,
        sha256: `${assetId}${'0'.repeat(48)}`,
        width: 2,
      };
    });
    await Promise.all(catalog.map((asset) => (
      writeFile(join(projectRoot, 'assets', `${asset.assetId}.png`), pngBytes)
    )));

    await expect(store.list(projectRoot, catalog)).resolves.toEqual([]);
    await expect(store.resolvePath(
      projectRoot,
      catalog[0]!.assetId,
      catalog[0]!.extension,
      catalog[0]!.sha256,
      catalog[0]!.byteSize,
    )).resolves.toBeNull();
  });

  it('rejects redirected asset directories before listing, resolving, or writing files', async () => {
    const projectRoot = await createProjectRoot(tempRoots);
    const assetsRoot = join(projectRoot, 'assets');
    const redirectedRoot = join(projectRoot, '..', 'redirected-assets');
    await rm(assetsRoot, { force: true, recursive: true });
    await mkdir(redirectedRoot, { recursive: true });
    await symlink(redirectedRoot, assetsRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const store = new AssetStore();

    await expect(store.list(projectRoot)).rejects.toMatchObject({ code: 'PACKAGE_VALIDATION_FAILED' });
    await expect(store.resolvePath(projectRoot, sha256(pngBytes).slice(0, 16)))
      .rejects.toMatchObject({ code: 'PACKAGE_VALIDATION_FAILED' });
    await expect(store.stageAndCommit(projectRoot, readableFrom(pngBytes), { originalName: 'reference.png' }))
      .rejects.toMatchObject({ code: 'PACKAGE_VALIDATION_FAILED' });
    expect(await readdir(redirectedRoot)).toEqual([]);
  });

  it('rejects redirected quarantine directories before staging an import', async () => {
    const projectRoot = await createProjectRoot(tempRoots);
    const quarantineRoot = join(projectRoot, 'recovery', 'quarantine');
    const redirectedRoot = join(projectRoot, '..', 'redirected-quarantine');
    await rm(quarantineRoot, { force: true, recursive: true });
    await mkdir(redirectedRoot, { recursive: true });
    await symlink(redirectedRoot, quarantineRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const store = new AssetStore();

    await expect(store.stageAndCommit(projectRoot, readableFrom(pngBytes), { originalName: 'reference.png' }))
      .rejects.toMatchObject({ code: 'PACKAGE_VALIDATION_FAILED' });
    expect(await readdir(join(projectRoot, 'assets'))).toEqual([]);
    expect(await readdir(redirectedRoot)).toEqual([]);
  });

  it('rejects redirected recovery parents before creating quarantine outside the project', async () => {
    const projectRoot = await createProjectRoot(tempRoots);
    const recoveryRoot = join(projectRoot, 'recovery');
    const redirectedRoot = join(projectRoot, '..', 'redirected-recovery');
    await rm(recoveryRoot, { force: true, recursive: true });
    await mkdir(redirectedRoot, { recursive: true });
    await symlink(redirectedRoot, recoveryRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const store = new AssetStore();

    await expect(store.stageAndCommit(projectRoot, readableFrom(pngBytes), { originalName: 'reference.png' }))
      .rejects.toMatchObject({ code: 'PACKAGE_VALIDATION_FAILED' });
    expect(await readdir(join(projectRoot, 'assets'))).toEqual([]);
    expect(await readdir(redirectedRoot)).toEqual([]);
  });

  it('promotes staged bytes with atomic rename instead of hard links', async () => {
    vi.resetModules();
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const link = vi.fn(async () => {
      throw new Error('hard links are forbidden for asset promotion');
    });
    const rename = vi.fn(async (source: string, destination: string) => actualFs.rename(source, destination));
    const projectRoot = await createProjectRoot(tempRoots);

    vi.doMock('node:fs/promises', () => ({
      ...actualFs,
      link,
      rename,
    }));

    try {
      const { AssetStore: MockedAssetStore } = await import('./asset-store');
      const asset = await new MockedAssetStore().stageAndCommit(projectRoot, readableFrom(pngBytes), {
        originalName: 'reference.png',
      });

      expect(link).not.toHaveBeenCalled();
      expect(rename).toHaveBeenCalledWith(
        expect.stringContaining('.staging-'),
        await realpath(join(projectRoot, 'assets')).then((root) => join(root, `${asset.id}.${asset.extension}`)),
      );
      expect(await readFile(join(projectRoot, asset.relativePath))).toEqual(pngBytes);
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });

  it('rejects unsupported extensions and removes staged bytes', async () => {
    const projectRoot = await createProjectRoot(tempRoots);
    const store = new AssetStore();

    await expect(store.stageAndCommit(projectRoot, readableFrom(Buffer.from('MZ')), {
      originalName: 'payload.exe',
    })).rejects.toMatchObject({ code: 'PACKAGE_VALIDATION_FAILED' });

    expect(await readdir(join(projectRoot, 'assets'))).toEqual([]);
    expect(await readdir(join(projectRoot, 'recovery', 'quarantine'))).toEqual([]);
  });

  it('rejects image bytes when the original extension is not allow-listed', async () => {
    const projectRoot = await createProjectRoot(tempRoots);
    const store = new AssetStore();

    await expect(store.stageAndCommit(projectRoot, readableFrom(pngBytes), {
      originalName: 'reference.exe',
    })).rejects.toMatchObject({ code: 'PACKAGE_VALIDATION_FAILED' });

    expect(await readdir(join(projectRoot, 'assets'))).toEqual([]);
  });

  it('quarantines the committed asset if the durable reference transaction fails', async () => {
    const projectRoot = await createProjectRoot(tempRoots);
    const store = new AssetStore();

    await expect(store.stageAndCommit(projectRoot, readableFrom(pngBytes), {
      commitReference: async () => {
        throw new Error('journal append failed');
      },
      originalName: 'reference.png',
    })).rejects.toMatchObject({
      code: 'DURABLE_WRITE_FAILED',
      message: 'Managed project asset write failed: durable storage operation failed',
      retryable: true,
    });

    expect(await readdir(join(projectRoot, 'assets'))).toEqual([]);
    const quarantineFiles = await readdir(join(projectRoot, 'recovery', 'quarantine'));
    expect(quarantineFiles).toHaveLength(1);
    expect(await readFile(join(projectRoot, 'recovery', 'quarantine', quarantineFiles[0]!))).toEqual(pngBytes);
  });

  it('verifies an expected content hash before committing', async () => {
    const projectRoot = await createProjectRoot(tempRoots);
    const store = new AssetStore();

    await expect(store.stageAndCommit(projectRoot, readableFrom(pngBytes), {
      expectedSha256: '0'.repeat(64),
      originalName: 'reference.png',
    })).rejects.toMatchObject({ code: 'PACKAGE_VALIDATION_FAILED' });

    await expect(stat(join(projectRoot, 'assets'))).resolves.toMatchObject({});
    expect(await readdir(join(projectRoot, 'assets'))).toEqual([]);
  });

  it('reuses an existing short-hash asset path only when the full digest matches', async () => {
    const projectRoot = await createProjectRoot(tempRoots);
    const store = new AssetStore();
    const expectedHash = sha256(pngBytes);
    const shortHashPath = join(projectRoot, 'assets', `${expectedHash.slice(0, 16)}.png`);
    await writeFile(shortHashPath, pngBytes);

    const asset = await store.stageAndCommit(projectRoot, readableFrom(pngBytes), {
      originalName: 'reference.png',
    });

    expect(asset.relativePath).toBe(`assets/${expectedHash.slice(0, 16)}.png`);
    expect(await readFile(shortHashPath)).toEqual(pngBytes);
  });

  it('rejects and preserves the existing asset when the short-hash path has different content', async () => {
    const projectRoot = await createProjectRoot(tempRoots);
    const store = new AssetStore();
    const expectedHash = sha256(pngBytes);
    const shortHashPath = join(projectRoot, 'assets', `${expectedHash.slice(0, 16)}.png`);
    const existingBytes = Buffer.from('different existing bytes');
    await writeFile(shortHashPath, existingBytes);

    await expect(store.stageAndCommit(projectRoot, readableFrom(pngBytes), {
      originalName: 'reference.png',
    })).rejects.toMatchObject({ code: 'PACKAGE_VALIDATION_FAILED' });

    expect(await readFile(shortHashPath)).toEqual(existingBytes);
    expect(await readdir(join(projectRoot, 'assets'))).toEqual([`${expectedHash.slice(0, 16)}.png`]);
  });

  it('rejects when a different extension already uses the short hash for different content', async () => {
    vi.resetModules();
    const actualCrypto = await vi.importActual<typeof import('node:crypto')>('node:crypto');
    const tempRoot = await createProjectRoot(tempRoots);
    const sharedShortId = '0123456789abcdef';
    const pngHash = `${sharedShortId}a${'0'.repeat(47)}`;
    const jpgHash = `${sharedShortId}b${'1'.repeat(47)}`;
    const jpgBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const shortHashPath = join(tempRoot, 'assets', `${sharedShortId}.png`);
    await writeFile(shortHashPath, pngBytes);

    vi.doMock('node:crypto', () => ({
      ...actualCrypto,
      createHash: vi.fn((algorithm: string) => {
        if (algorithm !== 'sha256') {
          return actualCrypto.createHash(algorithm);
        }
        const chunks: Buffer[] = [];
        return {
          update(chunk: Buffer | Uint8Array | string) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            return this;
          },
          digest(encoding?: 'hex') {
            const bytes = Buffer.concat(chunks);
            const mappedHash = bytes.equals(pngBytes)
              ? pngHash
              : bytes.equals(jpgBytes)
                ? jpgHash
                : actualCrypto.createHash('sha256').update(bytes).digest('hex');
            return encoding === 'hex' ? mappedHash : Buffer.from(mappedHash, 'hex');
          },
        };
      }),
    }));

    try {
      const { AssetStore: MockedAssetStore } = await import('./asset-store');
      const store = new MockedAssetStore();

      await expect(store.stageAndCommit(tempRoot, readableFrom(jpgBytes), {
        originalName: 'collision.jpg',
      })).rejects.toMatchObject({ code: 'PACKAGE_VALIDATION_FAILED' });

      expect(await readFile(shortHashPath)).toEqual(pngBytes);
      expect(await readdir(join(tempRoot, 'assets'))).toEqual([`${sharedShortId}.png`]);
    } finally {
      vi.doUnmock('node:crypto');
      vi.resetModules();
    }
  });
});

function readableFrom(bytes: Buffer): Readable {
  return Readable.from([bytes.subarray(0, 7), bytes.subarray(7)]);
}

async function createProjectRoot(tempRoots: string[]): Promise<string> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'asset-store-test-'));
  tempRoots.push(tempRoot);
  const projectRoot = join(tempRoot, 'Project.novus-project');
  await mkdir(join(projectRoot, 'assets'), { recursive: true });
  await mkdir(join(projectRoot, 'recovery', 'quarantine'), { recursive: true });
  return projectRoot;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function createMinimalMp4(): Buffer {
  return Buffer.concat([
    mp4Box('ftyp', Buffer.from('isom\0\0\0\0isomiso2mp41')),
    validMoovBox(),
    mp4Box('mdat', Buffer.from([0, 0, 0, 1])),
  ]);
}

function validMoovBox(): Buffer {
  return mp4Box('moov', Buffer.concat([
    validMvhdBox(),
    mp4Box('trak', mp4Box('tkhd', Buffer.alloc(4))),
  ]));
}

function validMvhdBox(): Buffer {
  const payload = Buffer.alloc(100);
  payload.writeUInt32BE(1_000, 12);
  return mp4Box('mvhd', payload);
}

function mp4Box(type: string, payload: Uint8Array = new Uint8Array()): Buffer {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, 4, 'ascii');
  Buffer.from(payload).copy(box, 8);
  return box;
}
