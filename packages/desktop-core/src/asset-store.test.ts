import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { AssetStore } from './asset-store';

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
    })).rejects.toThrow(/journal append failed/);

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
});

function readableFrom(bytes: Buffer): Readable {
  return Readable.from([bytes.subarray(0, 7), bytes.subarray(7)]);
}

async function createProjectRoot(tempRoots: string[]): Promise<string> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'asset-store-test-'));
  tempRoots.push(tempRoot);
  const projectRoot = join(tempRoot, 'Project.novus-project');
  await import('node:fs/promises').then(async ({ mkdir }) => {
    await mkdir(join(projectRoot, 'assets'), { recursive: true });
    await mkdir(join(projectRoot, 'recovery', 'quarantine'), { recursive: true });
  });
  return projectRoot;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
