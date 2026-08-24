import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, parse, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCacheDirectoryService,
  createNodeCacheDirectoryServiceAdapters,
  type CacheDirectoryServiceAdapters,
} from './cache-directory-service.js';

describe('cache directory service', () => {
  let tempRoot: string;
  let defaultRoot: string;
  let customRoot: string;
  let stateFilePath: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'novus-cache-directory-'));
    defaultRoot = join(tempRoot, 'default-cache');
    customRoot = join(tempRoot, 'custom-cache');
    stateFilePath = join(tempRoot, 'state', 'cache-directory.json');
  });

  afterEach(async () => {
    await rm(tempRoot, { force: true, recursive: true });
  });

  it('copies and verifies before switching', async () => {
    const adapters = testAdapters({ selectedPath: customRoot });
    const service = createCacheDirectoryService(adapters);
    await seedFile(defaultRoot, 'thumbs/a.webp', 'image');

    expect((await service.chooseCacheDirectory())?.path).toBe(customRoot);
    expect(await readFile(join(customRoot, 'thumbs/a.webp'), 'utf8')).toBe('image');
    expect(adapters.verifyDirectoryCopy).toHaveBeenCalled();
  });

  it('rolls back when verification fails', async () => {
    const service = createCacheDirectoryService(testAdapters({
      selectedPath: customRoot,
      failVerification: true,
    }));
    await seedFile(defaultRoot, 'thumbs/a.webp', 'image');

    await expect(service.chooseCacheDirectory()).rejects.toThrow('CACHE_MIGRATION_FAILED');
    expect((await service.getCacheDirectory()).path).toBe(defaultRoot);
    await expect(readFile(join(defaultRoot, 'thumbs/a.webp'), 'utf8')).resolves.toBe('image');
    await expect(stat(customRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns null when selection is cancelled', async () => {
    await expect(createCacheDirectoryService(testAdapters({ selectedPath: null }))
      .chooseCacheDirectory()).resolves.toBeNull();
  });

  it('moves a custom cache back to the default root before clearing configuration', async () => {
    const adapters = testAdapters({ configuredPath: customRoot, selectedPath: null });
    const service = createCacheDirectoryService(adapters);
    await seedFile(customRoot, 'previews/frame-1.webp', 'preview');

    await expect(service.resetCacheDirectory()).resolves.toMatchObject({
      path: defaultRoot,
      isDefault: true,
      available: true,
    });
    await expect(readFile(join(defaultRoot, 'previews/frame-1.webp'), 'utf8')).resolves.toBe('preview');
    await expect(readFile(stateFilePath, 'utf8')).resolves.toContain('null');
  });

  it('opens only the effective dedicated cache directory', async () => {
    const adapters = testAdapters({ configuredPath: customRoot, selectedPath: null });
    const service = createCacheDirectoryService(adapters);

    await expect(service.openCacheDirectory()).resolves.toEqual({ opened: true });
    expect(adapters.openDirectory).toHaveBeenCalledWith(customRoot);
  });

  it('rejects filesystem roots without changing the configured cache', async () => {
    const unsafeRoot = parse(resolve(tempRoot)).root;
    const service = createCacheDirectoryService(testAdapters({ selectedPath: unsafeRoot }));

    await expect(service.chooseCacheDirectory()).rejects.toThrow('CACHE_DIRECTORY_UNSAFE');
    expect((await service.getCacheDirectory()).path).toBe(defaultRoot);
  });

  it('does not delete a pre-existing unowned migration sibling', async () => {
    const migrationSibling = join(dirname(customRoot), `.${basename(customRoot)}.novus-cache-migration`);
    await seedFile(defaultRoot, 'thumbs/a.webp', 'image');
    await seedFile(migrationSibling, 'keep.txt', 'user migration data');
    const service = createCacheDirectoryService(createNodeCacheDirectoryServiceAdapters({
      defaultCacheRoot: defaultRoot,
      stateFilePath,
      chooseDirectory: async () => customRoot,
      openDirectory: async () => true,
    }));

    await expect(service.chooseCacheDirectory()).resolves.toMatchObject({ path: customRoot });
    await expect(readFile(join(migrationSibling, 'keep.txt'), 'utf8')).resolves.toBe('user migration data');
  });

  it('clears busy after rejecting an unsafe target', async () => {
    const unsafeRoot = parse(resolve(tempRoot)).root;
    const adapters = testAdapters({ selectedPath: unsafeRoot });
    const service = createCacheDirectoryService(adapters);

    await expect(service.chooseCacheDirectory()).rejects.toThrow('CACHE_DIRECTORY_UNSAFE');
    await expect(service.getCacheDirectory()).resolves.toMatchObject({ busy: false });
    await expect(service.resetCacheDirectory()).resolves.toMatchObject({ path: defaultRoot, busy: false });
    await expect(service.openCacheDirectory()).resolves.toEqual({ opened: true });
  });
  it('never replaces a non-empty directory that is not an owned cache', async () => {
    await seedFile(defaultRoot, 'thumbs/a.webp', 'image');
    await seedFile(customRoot, 'keep.txt', 'user data');
    const service = createCacheDirectoryService(createNodeCacheDirectoryServiceAdapters({
      defaultCacheRoot: defaultRoot,
      stateFilePath,
      chooseDirectory: async () => customRoot,
      openDirectory: async () => true,
    }));

    await expect(service.chooseCacheDirectory()).rejects.toThrow('CACHE_MIGRATION_FAILED');
    await expect(readFile(join(customRoot, 'keep.txt'), 'utf8')).resolves.toBe('user data');
    await expect(readFile(join(defaultRoot, 'thumbs/a.webp'), 'utf8')).resolves.toBe('image');
  });
  it('never deletes an unrelated migration-backup sibling', async () => {
    const backupRoot = `${customRoot}.novus-cache-backup`;
    await seedFile(defaultRoot, 'thumbs/a.webp', 'image');
    await seedFile(backupRoot, 'keep.txt', 'user backup');
    const service = createCacheDirectoryService(createNodeCacheDirectoryServiceAdapters({
      defaultCacheRoot: defaultRoot,
      stateFilePath,
      chooseDirectory: async () => customRoot,
      openDirectory: async () => true,
    }));

    await expect(service.chooseCacheDirectory()).rejects.toThrow('CACHE_MIGRATION_FAILED');
    await expect(readFile(join(backupRoot, 'keep.txt'), 'utf8')).resolves.toBe('user backup');
    await expect(readFile(join(defaultRoot, 'thumbs/a.webp'), 'utf8')).resolves.toBe('image');
  });
  function testAdapters(options: {
    configuredPath?: string | null;
    failVerification?: boolean;
    selectedPath: string | null;
  }): CacheDirectoryServiceAdapters & {
    openDirectory: ReturnType<typeof vi.fn<(path: string) => Promise<boolean>>>;
    verifyDirectoryCopy: ReturnType<typeof vi.fn<(source: string, target: string) => Promise<void>>>;
  } {
    let configuredPath = options.configuredPath ?? null;
    const openDirectory = vi.fn(async (_path: string) => true);
    const verifyDirectoryCopy = vi.fn(async (source: string, target: string) => {
      if (options.failVerification) throw new Error('injected verification failure');
      const [sourceStat, targetStat] = await Promise.all([stat(source), stat(target)]);
      if (!sourceStat.isDirectory() || !targetStat.isDirectory()) throw new Error('not a directory');
    });

    return {
      defaultCacheRoot: defaultRoot,
      stateFilePath,
      chooseDirectory: async () => options.selectedPath,
      openDirectory,
      async copyDirectory(source, target) {
        await mkdir(target, { recursive: true });
        await cp(source, target, { force: true, recursive: true });
      },
      verifyDirectoryCopy,
      async removeDirectory(path) {
        await rm(path, { force: true, recursive: true });
      },
      async ensureDirectory(path) {
        await mkdir(path, { recursive: true });
      },
      async readConfiguredPath() {
        return configuredPath;
      },
      async writeConfiguredPathAtomically(path) {
        configuredPath = path;
        await mkdir(dirname(stateFilePath), { recursive: true });
        await writeFile(stateFilePath, JSON.stringify({ path }), 'utf8');
      },
    };
  }
});

async function seedFile(root: string, relativePath: string, contents: string): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');
}
