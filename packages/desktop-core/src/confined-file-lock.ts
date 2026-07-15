import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { basename, dirname, join } from 'node:path';

import { canonicalJson } from './canonical-json.js';
import type { FileStatLike, FileSystem } from './file-system.js';

export type ProcessLiveness = boolean | 'unknown';

export interface ConfinedFileLockOptions {
  readonly fileSystem: FileSystem;
  readonly assertPathForRead: (path: string) => Promise<void>;
  readonly assertPathForWrite: (path: string) => Promise<void>;
  readonly isLocalProcessAlive?: (processId: number) => Promise<ProcessLiveness>;
  readonly monotonicNow?: () => number;
  readonly now?: () => number;
  readonly processId?: number;
  readonly processSessionFingerprint?: string;
  readonly retryMs?: number;
  readonly staleAgeMs?: number;
  readonly timeoutMs?: number;
  readonly timeoutMessage?: string;
}

export interface ConfinedFileLock {
  readonly path: string;
  readonly processSessionFingerprint: string;
  readonly token: string;
  readonly options: ConfinedFileLockOptions;
}

interface PersistedLock {
  readonly schemaVersion: 1 | 2;
  readonly token: string;
  readonly processId: number;
  readonly processSessionFingerprint: string | null;
  readonly createdAt: string;
}

interface IncompleteLockFingerprint {
  readonly contentHash: string;
  readonly mtimeMs: number;
  readonly size: number;
}

type PersistedLockRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'incomplete'; readonly fingerprint: IncompleteLockFingerprint }
  | { readonly kind: 'valid'; readonly lock: PersistedLock };

const DEFAULT_RETRY_MS = 10;
const DEFAULT_STALE_AGE_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_STALE_OWNER_TEMP_CLEANUP = 16;
const ATOMIC_LINK_ERROR_MESSAGE = 'Confined file lock requires atomic hard-link support on the app-data volume';
const PROCESS_SESSION_FINGERPRINT = createHash('sha256')
  .update(`${process.pid}:${Date.now()}:${randomBytes(16).toString('hex')}`, 'utf8')
  .digest('hex');

export async function acquireConfinedFileLock(
  path: string,
  options: ConfinedFileLockOptions,
): Promise<ConfinedFileLock> {
  const now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const processId = options.processId ?? process.pid;
  const processSessionFingerprint = options.processSessionFingerprint ?? PROCESS_SESSION_FINGERPRINT;
  if (processSessionFingerprint.trim().length === 0) {
    throw new Error('Confined file lock process session fingerprint is invalid');
  }
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const staleAgeMs = options.staleAgeMs ?? DEFAULT_STALE_AGE_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = monotonicNow();
  const token = createHash('sha256')
    .update(`${processId}:${processSessionFingerprint}:${Date.now()}:${Math.random()}`, 'utf8')
    .digest('hex');

  let ownerTempsCleaned = false;
  for (;;) {
    await assertWritablePath(path, options);
    if (!ownerTempsCleaned) {
      await cleanupStaleOwnerTemps(path, options, now(), staleAgeMs);
      ownerTempsCleaned = true;
    }
    const published = await tryPublishOwner(path, options, {
      schemaVersion: 2,
      token,
      processId,
      processSessionFingerprint,
      createdAt: new Date(now()).toISOString(),
    });
    if (published) {
      return { path, processSessionFingerprint, token, options };
    }

    if (await reclaimStaleLock(path, options, {
      now: now(),
      processId,
      processSessionFingerprint,
      staleAgeMs,
    })) {
      continue;
    }
    if (monotonicNow() - startedAt >= timeoutMs) {
      throw new Error(options.timeoutMessage ?? 'Timed out waiting for confined file lock');
    }
    await delay(retryMs);
  }
}

export async function releaseConfinedFileLock(lock: ConfinedFileLock): Promise<void> {
  try {
    const persisted = await readPersistedLock(lock.path, lock.options);
    if (persisted.kind !== 'valid' || !isOwnedLock(persisted.lock, lock)) return;
    const revalidated = await readPersistedLock(lock.path, lock.options);
    if (revalidated.kind === 'valid' && isOwnedLock(revalidated.lock, lock)) {
      await lock.options.fileSystem.unlink(lock.path);
    }
  } catch {
    // A replaced or inaccessible lock must remain for guarded recovery.
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

async function tryPublishOwner(
  path: string,
  options: ConfinedFileLockOptions,
  owner: {
    readonly schemaVersion: 2;
    readonly token: string;
    readonly processId: number;
    readonly processSessionFingerprint: string;
    readonly createdAt: string;
  },
): Promise<boolean> {
  const link = options.fileSystem.link;
  if (link === undefined) throw new Error(ATOMIC_LINK_ERROR_MESSAGE);
  const tempPath = join(dirname(path), `.${basename(path)}.owner-${owner.token}.tmp`);
  await options.assertPathForWrite(tempPath);
  let handle: Awaited<ReturnType<FileSystem['open']>> | null = null;
  let closed = false;
  try {
    handle = await options.fileSystem.open(tempPath, 'wx');
    await handle.writeFile(`${canonicalJson(owner)}\n`);
    await handle.sync();
    await handle.close();
    closed = true;
    await options.assertPathForRead(tempPath);
    const prepared = parsePersistedLock(await options.fileSystem.readFile(tempPath, 'utf8'));
    if (prepared === null || !sameOwnerRecord(prepared, owner)) {
      throw new Error('Confined file lock owner preparation is invalid');
    }
    try {
      await link.call(options.fileSystem, tempPath, path);
    } catch (error) {
      if (isErrno(error, 'EEXIST')) return false;
      if (isAtomicLinkCapabilityError(error)) throw new Error(ATOMIC_LINK_ERROR_MESSAGE);
      throw error;
    }
    return true;
  } finally {
    if (handle !== null && !closed) {
      try {
        await handle.close();
      } catch {
        // Preserve the publication outcome.
      }
    }
    try {
      await options.fileSystem.rm(tempPath, { force: true });
    } catch {
      // A prepared temp is not authoritative and may be cleaned later.
    }
  }
}

async function cleanupStaleOwnerTemps(
  path: string,
  options: ConfinedFileLockOptions,
  now: number,
  staleAgeMs: number,
): Promise<void> {
  const parent = dirname(path);
  const prefix = `.${basename(path)}.owner-`;
  let entries: string[];
  try {
    entries = await options.fileSystem.readdir(parent);
  } catch {
    return;
  }
  const candidates = entries
    .filter((entry) => entry.startsWith(prefix)
      && entry.endsWith('.tmp')
      && /^[a-f0-9]{64}$/u.test(entry.slice(prefix.length, -4)))
    .sort()
    .slice(0, MAX_STALE_OWNER_TEMP_CLEANUP);
  for (const entry of candidates) {
    const candidatePath = join(parent, entry);
    try {
      await options.assertPathForRead(candidatePath);
      const firstStat = await requireLstat(options.fileSystem, candidatePath);
      if (!firstStat.isFile() || firstStat.isSymbolicLink?.()) continue;
      if (typeof firstStat.mtimeMs !== 'number' || !Number.isFinite(firstStat.mtimeMs)) continue;
      if (now - firstStat.mtimeMs < staleAgeMs) continue;
      const firstRaw = await options.fileSystem.readFile(candidatePath, 'utf8');
      const firstFingerprint = incompleteFingerprint(firstRaw, firstStat);
      await options.assertPathForWrite(candidatePath);
      const secondStat = await requireLstat(options.fileSystem, candidatePath);
      if (!secondStat.isFile() || secondStat.isSymbolicLink?.()) continue;
      const secondRaw = await options.fileSystem.readFile(candidatePath, 'utf8');
      const secondFingerprint = incompleteFingerprint(secondRaw, secondStat);
      if (sameIncompleteLock(firstFingerprint, secondFingerprint)) {
        await unlinkGuarded(candidatePath, options.fileSystem);
      }
    } catch {
      // Cleanup is bounded and best-effort; acquisition still uses the canonical lock.
    }
  }
}
async function reclaimStaleLock(
  path: string,
  options: ConfinedFileLockOptions,
  current: {
    readonly now: number;
    readonly processId: number;
    readonly processSessionFingerprint: string;
    readonly staleAgeMs: number;
  },
): Promise<boolean> {
  const existing = await readPersistedLock(path, options);
  if (existing.kind === 'missing') return true;
  if (existing.kind === 'incomplete') {
    if (current.now - existing.fingerprint.mtimeMs < current.staleAgeMs) return false;
    const revalidated = await readPersistedLock(path, options);
    if (revalidated.kind !== 'incomplete' || !sameIncompleteLock(existing.fingerprint, revalidated.fingerprint)) {
      return false;
    }
    return unlinkGuarded(path, options.fileSystem);
  }

  const createdAt = Date.parse(existing.lock.createdAt);
  if (!Number.isFinite(createdAt) || current.now - createdAt < current.staleAgeMs) return false;
  let ownerIsDead = false;
  if (existing.lock.processId === current.processId) {
    ownerIsDead = existing.lock.processSessionFingerprint !== null
      && existing.lock.processSessionFingerprint !== current.processSessionFingerprint;
  } else {
    const liveness = await (options.isLocalProcessAlive ?? defaultLocalProcessLiveness)(existing.lock.processId);
    ownerIsDead = liveness === false;
  }
  if (!ownerIsDead) return false;

  const revalidated = await readPersistedLock(path, options);
  if (revalidated.kind !== 'valid' || !samePersistedLock(existing.lock, revalidated.lock)) return false;
  return unlinkGuarded(path, options.fileSystem);
}

async function unlinkGuarded(path: string, fileSystem: FileSystem): Promise<boolean> {
  try {
    await fileSystem.unlink(path);
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
    const stat = await requireLstat(options.fileSystem, path);
    const raw = await options.fileSystem.readFile(path, 'utf8');
    const parsed = parsePersistedLock(raw);
    return parsed === null
      ? { kind: 'incomplete', fingerprint: incompleteFingerprint(raw, stat) }
      : { kind: 'valid', lock: parsed };
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return { kind: 'missing' };
    if (await didVanishDuringWindowsRealpath(path, options.fileSystem, error)) return { kind: 'missing' };
    throw error;
  }
}

async function requireLstat(fileSystem: FileSystem, path: string): Promise<FileStatLike> {
  if (fileSystem.lstat === undefined) throw new Error('Confined file lock requires file system lstat');
  return fileSystem.lstat(path);
}

function incompleteFingerprint(raw: string, stat: FileStatLike): IncompleteLockFingerprint {
  if (typeof stat.mtimeMs !== 'number' || !Number.isFinite(stat.mtimeMs)) {
    throw new Error('Confined file lock requires file mtime');
  }
  return {
    contentHash: createHash('sha256').update(raw, 'utf8').digest('hex'),
    mtimeMs: stat.mtimeMs,
    size: typeof stat.size === 'number' ? stat.size : Buffer.byteLength(raw),
  };
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
  if ((!isErrno(error, 'EPERM') && !isErrno(error, 'EBADF')) || fileSystem.lstat === undefined) return false;
  try {
    await fileSystem.lstat(path);
    return false;
  } catch (nextError) {
    return isErrno(nextError, 'ENOENT');
  }
}

function parsePersistedLock(raw: string): PersistedLock | null {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) return null;
  if (typeof value.token !== 'string' || value.token.length === 0) return null;
  if (typeof value.processId !== 'number' || !Number.isInteger(value.processId) || value.processId <= 0) return null;
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) return null;
  const processSessionFingerprint = value.schemaVersion === 2
    ? value.processSessionFingerprint
    : null;
  if (value.schemaVersion === 2 && (typeof processSessionFingerprint !== 'string' || processSessionFingerprint.length === 0)) {
    return null;
  }
  return {
    schemaVersion: value.schemaVersion,
    token: value.token,
    processId: value.processId,
    processSessionFingerprint: processSessionFingerprint as string | null,
    createdAt: value.createdAt,
  };
}

function sameOwnerRecord(
  persisted: PersistedLock,
  owner: {
    readonly token: string;
    readonly processId: number;
    readonly processSessionFingerprint: string;
    readonly createdAt: string;
  },
): boolean {
  return persisted.schemaVersion === 2
    && persisted.token === owner.token
    && persisted.processId === owner.processId
    && persisted.processSessionFingerprint === owner.processSessionFingerprint
    && persisted.createdAt === owner.createdAt;
}
function isOwnedLock(persisted: PersistedLock, lock: ConfinedFileLock): boolean {
  return persisted.token === lock.token
    && persisted.processSessionFingerprint === lock.processSessionFingerprint;
}

function samePersistedLock(left: PersistedLock, right: PersistedLock): boolean {
  return left.token === right.token
    && left.processId === right.processId
    && left.processSessionFingerprint === right.processSessionFingerprint
    && left.createdAt === right.createdAt;
}

function sameIncompleteLock(left: IncompleteLockFingerprint, right: IncompleteLockFingerprint): boolean {
  return left.contentHash === right.contentHash
    && left.mtimeMs === right.mtimeMs
    && left.size === right.size;
}

function isAtomicLinkCapabilityError(error: unknown): boolean {
  return ['EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV']
    .some((code) => isErrno(error, code));
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
