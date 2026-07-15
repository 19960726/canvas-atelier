import { createHash } from 'node:crypto';

import { canonicalJson } from './canonical-json.js';
import type { FileHandleLike, FileSystem } from './file-system.js';

export type ProcessLiveness = boolean | 'unknown';

export interface ConfinedFileLockOptions {
  readonly fileSystem: FileSystem;
  readonly assertPathForRead: (path: string) => Promise<void>;
  readonly assertPathForWrite: (path: string) => Promise<void>;
  readonly isLocalProcessAlive?: (processId: number) => Promise<ProcessLiveness>;
  readonly now?: () => number;
  readonly processId?: number;
  readonly retryMs?: number;
  readonly staleAgeMs?: number;
  readonly timeoutMs?: number;
  readonly timeoutMessage?: string;
}

export interface ConfinedFileLock {
  readonly handle: FileHandleLike;
  readonly path: string;
  readonly token: string;
  readonly options: ConfinedFileLockOptions;
}

interface PersistedLock {
  readonly schemaVersion: 1;
  readonly token: string;
  readonly processId: number;
  readonly createdAt: string;
}

type PersistedLockRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'valid'; readonly lock: PersistedLock };

const DEFAULT_RETRY_MS = 10;
const DEFAULT_STALE_AGE_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 5_000;

export async function acquireConfinedFileLock(
  path: string,
  options: ConfinedFileLockOptions,
): Promise<ConfinedFileLock> {
  const now = options.now ?? Date.now;
  const processId = options.processId ?? process.pid;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const staleAgeMs = options.staleAgeMs ?? DEFAULT_STALE_AGE_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  const token = createHash('sha256')
    .update(`${processId}:${Date.now()}:${Math.random()}`, 'utf8')
    .digest('hex');

  for (;;) {
    await assertWritablePath(path, options);
    let handle: FileHandleLike | null = null;
    try {
      handle = await options.fileSystem.open(path, 'wx');
      const createdAt = new Date(now()).toISOString();
      await handle.writeFile(`${canonicalJson({ schemaVersion: 1, token, processId, createdAt })}\n`);
      await handle.sync();
      return { handle, path, token, options };
    } catch (error) {
      if (handle !== null) {
        try {
          await handle.close();
        } catch {
          // Preserve the acquisition failure.
        }
      }
      if (!isErrno(error, 'EEXIST')) throw error;
    }

    if (await reclaimDeadStaleLock(path, options, now(), staleAgeMs)) {
      continue;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(options.timeoutMessage ?? 'Timed out waiting for confined file lock');
    }
    await delay(retryMs);
  }
}

export async function releaseConfinedFileLock(lock: ConfinedFileLock): Promise<void> {
  let closed = false;
  try {
    const persisted = await readPersistedLock(lock.path, lock.options);
    if (persisted.kind !== 'valid' || persisted.lock.token !== lock.token) return;
    await lock.handle.close();
    closed = true;
    const revalidated = await readPersistedLock(lock.path, lock.options);
    if (revalidated.kind === 'valid' && revalidated.lock.token === lock.token) {
      await lock.options.fileSystem.unlink(lock.path);
    }
  } catch {
    // A replaced or inaccessible lock must remain for a future guarded recovery.
  } finally {
    if (!closed) {
      try {
        await lock.handle.close();
      } catch {
        // Preserve the operation outcome.
      }
    }
  }
}

export async function defaultLocalProcessLiveness(processId: number): Promise<ProcessLiveness> {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return isErrno(error, 'ESRCH') ? false : 'unknown';
  }
}

async function reclaimDeadStaleLock(
  path: string,
  options: ConfinedFileLockOptions,
  now: number,
  staleAgeMs: number,
): Promise<boolean> {
  const existing = await readPersistedLock(path, options);
  if (existing.kind === 'missing') return true;
  if (existing.kind === 'invalid') return false;
  const createdAt = Date.parse(existing.lock.createdAt);
  if (!Number.isFinite(createdAt) || now - createdAt < staleAgeMs) return false;
  const liveness = await (options.isLocalProcessAlive ?? defaultLocalProcessLiveness)(existing.lock.processId);
  if (liveness !== false) return false;

  const revalidated = await readPersistedLock(path, options);
  if (revalidated.kind !== 'valid' || !samePersistedLock(existing.lock, revalidated.lock)) return false;
  try {
    await options.fileSystem.unlink(path);
    return true;
  } catch (error) {
    return isErrno(error, 'ENOENT');
  }
}

async function readPersistedLock(
  path: string,
  options: ConfinedFileLockOptions,
): Promise<PersistedLockRead> {
  try {
    await assertReadablePath(path, options);
    const parsed = parsePersistedLock(JSON.parse(await options.fileSystem.readFile(path, 'utf8')) as unknown);
    return parsed === null ? { kind: 'invalid' } : { kind: 'valid', lock: parsed };
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return { kind: 'missing' };
    if (await didVanishDuringWindowsRealpath(path, options.fileSystem, error)) return { kind: 'missing' };
    return { kind: 'invalid' };
  }
}

async function assertWritablePath(path: string, options: ConfinedFileLockOptions): Promise<void> {
  try {
    await options.assertPathForWrite(path);
  } catch (error) {
    if (!await didVanishDuringWindowsRealpath(path, options.fileSystem, error)) throw error;
    await options.assertPathForWrite(path);
  }
}

async function assertReadablePath(path: string, options: ConfinedFileLockOptions): Promise<void> {
  try {
    await options.assertPathForRead(path);
  } catch (error) {
    if (!await didVanishDuringWindowsRealpath(path, options.fileSystem, error)) throw error;
    throw Object.assign(new Error('Lock vanished'), { code: 'ENOENT' });
  }
}

async function didVanishDuringWindowsRealpath(
  path: string,
  fileSystem: FileSystem,
  error: unknown,
): Promise<boolean> {
  if (!isErrno(error, 'EPERM') || fileSystem.lstat === undefined) return false;
  try {
    await fileSystem.lstat(path);
    return false;
  } catch (nextError) {
    return isErrno(nextError, 'ENOENT');
  }
}

function parsePersistedLock(value: unknown): PersistedLock | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  if (typeof value.token !== 'string' || value.token.length === 0) return null;
  if (typeof value.processId !== 'number' || !Number.isInteger(value.processId) || value.processId <= 0) return null;
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) return null;
  return {
    schemaVersion: 1,
    token: value.token,
    processId: value.processId,
    createdAt: value.createdAt,
  };
}

function samePersistedLock(left: PersistedLock, right: PersistedLock): boolean {
  return left.token === right.token
    && left.processId === right.processId
    && left.createdAt === right.createdAt;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));
}
