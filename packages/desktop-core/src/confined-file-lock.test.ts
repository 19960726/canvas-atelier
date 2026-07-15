import { describe, expect, it, vi } from 'vitest';

import type { FileHandleLike, FileStatLike, FileSystem } from './file-system';
import { acquireConfinedFileLock, releaseConfinedFileLock } from './confined-file-lock';

const LOCK_PATH = 'C:\\app-data\\sync\\state.lock';

describe('confined file lock', () => {
  it('publishes a fully synced owner record through atomic no-replace link', async () => {
    const fileSystem = new MemoryLockFileSystem();

    const lock = await acquireConfinedFileLock(LOCK_PATH, options(fileSystem));

    const owner = JSON.parse(fileSystem.readContents(LOCK_PATH)) as Record<string, unknown>;
    expect(fileSystem.events.findIndex((event) => event.startsWith('sync:')))
      .toBeLessThan(fileSystem.events.findIndex((event) => event.startsWith('link:')));
    expect(owner).toMatchObject({
      schemaVersion: 2,
      processId: 100,
      processSessionFingerprint: 'session-current',
      token: lock.token,
    });
    expect(fileSystem.openedPaths).not.toContain(LOCK_PATH);

    await releaseConfinedFileLock(lock);
    expect(fileSystem.has(LOCK_PATH)).toBe(false);
  });

  it('never exposes a canonical lock when publication crashes after prepare', async () => {
    const fileSystem = new MemoryLockFileSystem();
    fileSystem.failLinkWith = Object.assign(new Error('injected crash before publish'), { code: 'PROCESS_CRASH' });

    await expect(acquireConfinedFileLock(LOCK_PATH, options(fileSystem))).rejects.toThrow(/crash before publish/i);

    expect(fileSystem.has(LOCK_PATH)).toBe(false);
    expect(fileSystem.events).toEqual(expect.arrayContaining([expect.stringMatching(/^sync:/), expect.stringMatching(/^link:/)]));
  });

  it.each(['', '{"schemaVersion":2,"token":"partial'])(
    'recovers a stale incomplete canonical lock without treating it as a live owner',
    async (contents) => {
      const fileSystem = new MemoryLockFileSystem();
      fileSystem.seed(LOCK_PATH, contents, Date.parse('2026-07-16T00:00:00.000Z'));
      const isLocalProcessAlive = vi.fn(async () => 'unknown' as const);

      const lock = await acquireConfinedFileLock(LOCK_PATH, options(fileSystem, {
        isLocalProcessAlive,
        now: () => Date.parse('2026-07-16T00:00:30.000Z'),
        staleAgeMs: 10_000,
      }));

      expect(isLocalProcessAlive).not.toHaveBeenCalled();
      expect(fileSystem.unlinkedContents).toContain(contents);
      await releaseConfinedFileLock(lock);
    },
  );

  it('reclaims a stale owner from a reused current PID only when its process-session fingerprint differs', async () => {
    const fileSystem = ownerFileSystem({
      token: 'previous-session-token',
      processId: 100,
      processSessionFingerprint: 'previous-session',
    });
    const isLocalProcessAlive = vi.fn(async () => true as const);

    const lock = await acquireConfinedFileLock(LOCK_PATH, options(fileSystem, {
      isLocalProcessAlive,
      now: () => Date.parse('2026-07-16T00:00:30.000Z'),
      staleAgeMs: 10_000,
    }));

    expect(isLocalProcessAlive).not.toHaveBeenCalled();
    expect(fileSystem.unlinkedContents.some((raw) => raw.includes('previous-session-token'))).toBe(true);
    await releaseConfinedFileLock(lock);
  });

  it('reclaims a stale lock only after proving a different local owner is dead', async () => {
    const fileSystem = ownerFileSystem({ token: 'dead-token', processId: 91 });
    const isLocalProcessAlive = vi.fn(async () => false as const);

    const lock = await acquireConfinedFileLock(LOCK_PATH, options(fileSystem, {
      isLocalProcessAlive,
      now: () => Date.parse('2026-07-16T00:00:30.000Z'),
      staleAgeMs: 10_000,
    }));

    expect(isLocalProcessAlive).toHaveBeenCalledWith(91);
    expect(fileSystem.unlinkedContents.some((raw) => raw.includes('dead-token'))).toBe(true);
    await releaseConfinedFileLock(lock);
  });

  it.each([
    ['live', true],
    ['unknown', 'unknown'],
  ] as const)('never reclaims a stale %s-owner lock', async (_name, liveness) => {
    const fileSystem = ownerFileSystem({ token: 'owned-token', processId: 91 });

    await expect(acquireConfinedFileLock(LOCK_PATH, options(fileSystem, {
      isLocalProcessAlive: async () => liveness,
      now: () => Date.parse('2026-07-16T00:00:30.000Z'),
      staleAgeMs: 10_000,
      timeoutMs: 0,
    }))).rejects.toThrow(/timed out/i);

    expect(fileSystem.unlinkedContents).toEqual([]);
    expect(fileSystem.readContents(LOCK_PATH)).toContain('owned-token');
  });

  it('does not unlink a stale lock when token or session fingerprint changes during guarded reclaim', async () => {
    const fileSystem = ownerFileSystem({ token: 'stale-token', processId: 91 });
    fileSystem.replaceBeforeRevalidation = {
      token: 'replacement-token',
      processSessionFingerprint: 'replacement-session',
    };

    await expect(acquireConfinedFileLock(LOCK_PATH, options(fileSystem, {
      isLocalProcessAlive: async () => false,
      now: () => Date.parse('2026-07-16T00:00:30.000Z'),
      staleAgeMs: 10_000,
      timeoutMs: 0,
    }))).rejects.toThrow(/timed out/i);

    expect(fileSystem.unlinkedContents).toEqual([]);
    expect(fileSystem.readContents(LOCK_PATH)).toContain('replacement-token');
  });

  it.each(['EPERM', 'EBADF'] as const)(
    'retries confinement when Windows realpath reports %s and re-lstat confirms the lock vanished',
    async (errorCode) => {
      const fileSystem = new MemoryLockFileSystem();
      let assertions = 0;
      const assertPathForWrite = vi.fn(async () => {
        assertions += 1;
        if (assertions === 1) throw Object.assign(new Error('vanished during realpath'), { code: errorCode });
      });
      fileSystem.lstatErrors.push(Object.assign(new Error('vanished'), { code: 'ENOENT' }));

      const lock = await acquireConfinedFileLock(LOCK_PATH, options(fileSystem, { assertPathForWrite }));

      expect(assertPathForWrite).toHaveBeenCalledTimes(3);
      expect(fileSystem.lstatCalls).toBe(1);
      await releaseConfinedFileLock(lock);
    },
  );

  it('uses monotonic elapsed time for lock acquisition timeout', async () => {
    const fileSystem = ownerFileSystem({ token: 'live-token', processId: 91 });
    const monotonicNow = vi.fn()
      .mockReturnValueOnce(100)
      .mockReturnValue(110);

    await expect(acquireConfinedFileLock(LOCK_PATH, options(fileSystem, {
      isLocalProcessAlive: async () => true,
      monotonicNow,
      timeoutMs: 5,
    }))).rejects.toThrow(/timed out/i);

    expect(monotonicNow).toHaveBeenCalled();
  });
});

function ownerFileSystem(overrides: Partial<Record<string, unknown>>): MemoryLockFileSystem {
  const fileSystem = new MemoryLockFileSystem();
  fileSystem.seed(LOCK_PATH, `${JSON.stringify({
    schemaVersion: 2,
    token: 'owner-token',
    processId: 91,
    processSessionFingerprint: 'owner-session',
    createdAt: '2026-07-16T00:00:00.000Z',
    ...overrides,
  })}\n`, Date.parse('2026-07-16T00:00:00.000Z'));
  return fileSystem;
}

function options(
  fileSystem: FileSystem,
  overrides: Partial<Parameters<typeof acquireConfinedFileLock>[1]> & { monotonicNow?: () => number } = {},
): Parameters<typeof acquireConfinedFileLock>[1] {
  return {
    fileSystem,
    assertPathForRead: async () => undefined,
    assertPathForWrite: async () => undefined,
    isLocalProcessAlive: async () => false,
    now: () => Date.parse('2026-07-16T00:00:01.000Z'),
    processId: 100,
    processSessionFingerprint: 'session-current',
    retryMs: 0,
    staleAgeMs: 10_000,
    timeoutMs: 25,
    ...overrides,
  } as Parameters<typeof acquireConfinedFileLock>[1];
}

class MemoryLockFileSystem implements FileSystem {
  readonly events: string[] = [];
  readonly openedPaths: string[] = [];
  readonly unlinkedContents: string[] = [];
  failLinkWith: unknown = null;
  lstatCalls = 0;
  lstatErrors: unknown[] = [];
  replaceBeforeRevalidation: { token: string; processSessionFingerprint: string } | null = null;
  private readonly files = new Map<string, { contents: string; mtimeMs: number }>();
  private canonicalReadCount = 0;

  has(path: string): boolean { return this.files.has(path); }
  readContents(path: string): string {
    const file = this.files.get(path);
    if (file === undefined) throw new Error(`missing test file ${path}`);
    return file.contents;
  }
  seed(path: string, contents: string, mtimeMs: number): void {
    this.files.set(path, { contents, mtimeMs });
  }

  async lstat(path: string): Promise<FileStatLike> {
    this.lstatCalls += 1;
    const error = this.lstatErrors.shift();
    if (error !== undefined) throw error;
    const file = this.files.get(path);
    if (file === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return fileStat(file);
  }
  async link(source: string, destination: string): Promise<void> {
    this.events.push(`link:${source}->${destination}`);
    if (this.failLinkWith !== null) throw this.failLinkWith;
    if (this.files.has(destination)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    const sourceFile = this.files.get(source);
    if (sourceFile === undefined) throw Object.assign(new Error('missing source'), { code: 'ENOENT' });
    this.files.set(destination, { ...sourceFile });
  }
  async mkdir(): Promise<void> {}
  async open(path: string, flags: string): Promise<FileHandleLike> {
    if (flags !== 'wx') throw new Error('unexpected flags');
    if (this.files.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    this.openedPaths.push(path);
    this.files.set(path, { contents: '', mtimeMs: Date.parse('2026-07-16T00:00:01.000Z') });
    return {
      close: async () => { this.events.push(`close:${path}`); },
      sync: async () => { this.events.push(`sync:${path}`); },
      writeFile: async (data) => {
        const file = this.files.get(path)!;
        file.contents = String(data);
        this.events.push(`write:${path}`);
      },
    };
  }
  async readFile(path: string): Promise<string> {
    const file = this.files.get(path);
    if (file === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    if (path === LOCK_PATH) {
      this.canonicalReadCount += 1;
      if (this.replaceBeforeRevalidation !== null && this.canonicalReadCount === 2) {
        const parsed = JSON.parse(file.contents) as Record<string, unknown>;
        Object.assign(parsed, this.replaceBeforeRevalidation);
        file.contents = `${JSON.stringify(parsed)}\n`;
      }
    }
    return file.contents;
  }
  async readdir(): Promise<string[]> { return []; }
  async rename(source: string, destination: string): Promise<void> {
    const file = this.files.get(source);
    if (file === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    this.files.set(destination, file);
    this.files.delete(source);
  }
  async rm(path: string): Promise<void> { this.files.delete(path); }
  async stat(path: string): Promise<FileStatLike> {
    const file = this.files.get(path);
    if (file === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return fileStat(file);
  }
  async unlink(path: string): Promise<void> {
    const file = this.files.get(path);
    if (file === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    this.unlinkedContents.push(file.contents);
    this.files.delete(path);
  }
  async writeFile(path: string, data: string): Promise<void> {
    this.files.set(path, { contents: data, mtimeMs: Date.now() });
  }
}

function fileStat(file: { contents: string; mtimeMs: number }): FileStatLike {
  return {
    size: Buffer.byteLength(file.contents),
    mtimeMs: file.mtimeMs,
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}
