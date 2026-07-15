import { describe, expect, it, vi } from 'vitest';

import type { FileHandleLike, FileStatLike, FileSystem } from './file-system';
import { acquireConfinedFileLock, releaseConfinedFileLock } from './confined-file-lock';

const LOCK_PATH = 'C:\\app-data\\sync\\state.lock';

describe('confined file lock', () => {
  it('reclaims a stale lock only after proving the local owner is dead', async () => {
    const fileSystem = new MemoryLockFileSystem({
      schemaVersion: 1,
      token: 'dead-token',
      processId: 91,
      createdAt: '2026-07-16T00:00:00.000Z',
    });
    const isLocalProcessAlive = vi.fn(async () => false as const);

    const lock = await acquireConfinedFileLock(LOCK_PATH, options(fileSystem, {
      isLocalProcessAlive,
      now: () => Date.parse('2026-07-16T00:00:30.000Z'),
      processId: 92,
      staleAgeMs: 10_000,
    }));

    expect(isLocalProcessAlive).toHaveBeenCalledWith(91);
    expect(fileSystem.unlinkedTokens).toEqual(['dead-token']);
    expect(JSON.parse(fileSystem.contents!)).toMatchObject({ processId: 92, token: lock.token });
    await releaseConfinedFileLock(lock);
  });

  it.each([
    ['live', true],
    ['unknown', 'unknown'],
  ] as const)('never reclaims a stale %s-owner lock', async (_name, liveness) => {
    const fileSystem = new MemoryLockFileSystem({
      schemaVersion: 1,
      token: 'owned-token',
      processId: 91,
      createdAt: '2026-07-16T00:00:00.000Z',
    });

    await expect(acquireConfinedFileLock(LOCK_PATH, options(fileSystem, {
      isLocalProcessAlive: async () => liveness,
      now: () => Date.parse('2026-07-16T00:00:30.000Z'),
      staleAgeMs: 10_000,
      timeoutMs: 0,
    }))).rejects.toThrow(/timed out/i);

    expect(fileSystem.unlinkedTokens).toEqual([]);
    expect(JSON.parse(fileSystem.contents!)).toMatchObject({ token: 'owned-token' });
  });

  it('treats a malformed lock as an unknown owner and times out without reclaiming it', async () => {
    const fileSystem = new MemoryLockFileSystem(null);
    fileSystem.contents = '{"schemaVersion":1}\n';
    fileSystem.failOpenAfter = 2;

    await expect(acquireConfinedFileLock(LOCK_PATH, options(fileSystem, {
      timeoutMs: 0,
    }))).rejects.toThrow(/timed out/i);

    expect(fileSystem.unlinkedTokens).toEqual([]);
    expect(fileSystem.contents).toContain('schemaVersion');
  });
  it('does not unlink a stale lock when its token is replaced during guarded reclaim', async () => {
    const fileSystem = new MemoryLockFileSystem({
      schemaVersion: 1,
      token: 'stale-token',
      processId: 91,
      createdAt: '2026-07-16T00:00:00.000Z',
    });
    fileSystem.replaceTokenBeforeRevalidation = 'replacement-token';

    await expect(acquireConfinedFileLock(LOCK_PATH, options(fileSystem, {
      isLocalProcessAlive: async () => false,
      now: () => Date.parse('2026-07-16T00:00:30.000Z'),
      staleAgeMs: 10_000,
      timeoutMs: 0,
    }))).rejects.toThrow(/timed out/i);

    expect(fileSystem.unlinkedTokens).toEqual([]);
    expect(JSON.parse(fileSystem.contents!)).toMatchObject({ token: 'replacement-token' });
  });

  it('retries confinement when Windows realpath reports EPERM and re-lstat confirms the lock vanished', async () => {
    const fileSystem = new MemoryLockFileSystem(null);
    let assertions = 0;
    const assertPathForWrite = vi.fn(async () => {
      assertions += 1;
      if (assertions === 1) {
        const error = Object.assign(new Error('vanished during realpath'), { code: 'EPERM' });
        throw error;
      }
    });
    fileSystem.lstatErrors.push(Object.assign(new Error('vanished'), { code: 'ENOENT' }));

    const lock = await acquireConfinedFileLock(LOCK_PATH, options(fileSystem, { assertPathForWrite }));

    expect(assertPathForWrite).toHaveBeenCalledTimes(2);
    expect(fileSystem.lstatCalls).toBe(1);
    await releaseConfinedFileLock(lock);
  });
});

function options(
  fileSystem: FileSystem,
  overrides: Partial<Parameters<typeof acquireConfinedFileLock>[1]> = {},
): Parameters<typeof acquireConfinedFileLock>[1] {
  return {
    fileSystem,
    assertPathForRead: async () => undefined,
    assertPathForWrite: async () => undefined,
    isLocalProcessAlive: async () => false,
    now: () => Date.parse('2026-07-16T00:00:01.000Z'),
    processId: 100,
    retryMs: 0,
    staleAgeMs: 10_000,
    timeoutMs: 25,
    ...overrides,
  };
}

class MemoryLockFileSystem implements FileSystem {
  contents: string | null;
  failOpenAfter: number | null = null;
  lstatCalls = 0;
  lstatErrors: unknown[] = [];
  replaceTokenBeforeRevalidation: string | null = null;
  unlinkedTokens: string[] = [];
  private openCount = 0;
  private readCount = 0;

  constructor(lock: Record<string, unknown> | null) {
    this.contents = lock === null ? null : `${JSON.stringify(lock)}\n`;
  }

  async lstat(): Promise<FileStatLike> {
    this.lstatCalls += 1;
    const error = this.lstatErrors.shift();
    if (error !== undefined) throw error;
    if (this.contents === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return fileStat(true);
  }
  async mkdir(): Promise<void> {}
  async open(_path: string, flags: string): Promise<FileHandleLike> {
    if (flags !== 'wx') throw new Error('unexpected flags');
    this.openCount += 1;
    if (this.failOpenAfter !== null && this.openCount > this.failOpenAfter) throw new Error('lock loop exceeded guard');
    if (this.contents !== null) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    return {
      close: async () => undefined,
      sync: async () => undefined,
      writeFile: async (data) => { this.contents = String(data); },
    };
  }
  async readFile(): Promise<string> {
    if (this.contents === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    this.readCount += 1;
    if (this.replaceTokenBeforeRevalidation !== null && this.readCount === 2) {
      const parsed = JSON.parse(this.contents) as Record<string, unknown>;
      parsed.token = this.replaceTokenBeforeRevalidation;
      this.contents = `${JSON.stringify(parsed)}\n`;
    }
    return this.contents;
  }
  async readdir(): Promise<string[]> { return []; }
  async rename(): Promise<void> {}
  async rm(): Promise<void> { this.contents = null; }
  async stat(): Promise<FileStatLike> { return fileStat(this.contents !== null); }
  async unlink(): Promise<void> {
    if (this.contents === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    this.unlinkedTokens.push((JSON.parse(this.contents) as { token: string }).token);
    this.contents = null;
  }
  async writeFile(): Promise<void> {}
}

function fileStat(file: boolean): FileStatLike {
  return {
    isDirectory: () => !file,
    isFile: () => file,
    isSymbolicLink: () => false,
  };
}