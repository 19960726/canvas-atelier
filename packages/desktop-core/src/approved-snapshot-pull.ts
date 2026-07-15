import { createHash } from 'node:crypto';
import { basename, dirname, join, normalize, resolve, sep } from 'node:path';

import {
  knowledgeSnapshotSyncSchema,
  type KnowledgeBaseStateSummary,
  type KnowledgeSnapshot,
} from '@agent-canvas/skill-store';

import { canonicalJson } from './canonical-json.js';
import { type FileHandleLike, type FileSystem, NodeFileSystem, writeAtomic } from './file-system.js';

export interface ApprovedSnapshotPullClient {
  pullApprovedSnapshot(
    knowledgeBaseId: string,
    cursor?: string,
  ): Promise<{ snapshot: KnowledgeSnapshot | null; cursor?: string }>;
}

export interface ApprovedSnapshotPullStore {
  hasUnresolvedKnowledgeTransition(knowledgeBaseId: string): Promise<boolean>;
  listStates(): Promise<KnowledgeBaseStateSummary[]>;
  publish(snapshot: KnowledgeSnapshot): Promise<void>;
  readActive(knowledgeBaseId: string): Promise<KnowledgeSnapshot | null>;
}

export interface ApprovedSnapshotPullCoordinatorOptions {
  readonly appDataRoot: string;
  readonly client: ApprovedSnapshotPullClient | null;
  readonly clearInterval?: (handle: unknown) => void;
  readonly fileSystem?: FileSystem;
  readonly intervalMs?: number;
  readonly isOnline?: () => boolean;
  readonly now?: () => number;
  readonly setInterval?: (listener: () => void, intervalMs: number) => unknown;
  readonly store: ApprovedSnapshotPullStore;
}

interface CursorState {
  readonly schemaVersion: 1;
  readonly cursors: Readonly<Record<string, string>>;
}

interface PullLock {
  readonly handle: FileHandleLike;
  readonly path: string;
  readonly token: string;
}

const DEFAULT_PULL_INTERVAL_MS = 30_000;
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;

export class ApprovedSnapshotPullCoordinator {
  private readonly appDataRoot: string;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly client: ApprovedSnapshotPullClient | null;
  private readonly fileSystem: FileSystem;
  private readonly intervalMs: number;
  private readonly isOnline: () => boolean;
  private readonly listeners = new Set<(state: KnowledgeBaseStateSummary) => void>();
  private readonly now: () => number;
  private readonly setTimer: (listener: () => void, intervalMs: number) => unknown;
  private readonly store: ApprovedSnapshotPullStore;
  private readonly syncRoot: string;
  private inFlight: Promise<void> | null = null;
  private knowledgeBaseIds: string[] = [];
  private stopped = true;
  private timer: unknown | null = null;

  constructor(options: ApprovedSnapshotPullCoordinatorOptions) {
    this.appDataRoot = resolve(options.appDataRoot);
    this.clearTimer = options.clearInterval
      ?? ((handle) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>));
    this.client = options.client;
    this.fileSystem = options.fileSystem ?? new NodeFileSystem();
    this.intervalMs = options.intervalMs ?? DEFAULT_PULL_INTERVAL_MS;
    this.isOnline = options.isOnline ?? (() => true);
    this.now = options.now ?? Date.now;
    this.setTimer = options.setInterval
      ?? ((listener, intervalMs) => globalThis.setInterval(listener, intervalMs));
    this.store = options.store;
    this.syncRoot = confinedJoin(this.appDataRoot, 'sync');
  }

  subscribe(listener: (state: KnowledgeBaseStateSummary) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async start(knowledgeBaseIds: string[]): Promise<void> {
    await this.stop();
    this.knowledgeBaseIds = [...new Set(knowledgeBaseIds)].sort(compareStrings);
    this.stopped = false;
    if (this.client !== null) {
      this.timer = this.setTimer(() => {
        void this.pullNow();
      }, this.intervalMs);
    }
    await this.pullNow();
  }

  async pullNow(): Promise<void> {
    if (this.stopped || this.client === null || !this.isOnline()) {
      return;
    }
    if (this.inFlight !== null) {
      return this.inFlight;
    }
    this.inFlight = this.pullConfiguredKnowledgeBases()
      .catch(() => undefined)
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    await this.inFlight;
  }

  private async pullConfiguredKnowledgeBases(): Promise<void> {
    for (const knowledgeBaseId of this.knowledgeBaseIds) {
      if (await this.store.hasUnresolvedKnowledgeTransition(knowledgeBaseId)) {
        continue;
      }
      try {
        await this.withLock(this.pullLockPath(knowledgeBaseId), async () => {
          if (await this.store.hasUnresolvedKnowledgeTransition(knowledgeBaseId)) {
            return;
          }
          const cursor = await this.readCursor(knowledgeBaseId);
          const result = await this.client!.pullApprovedSnapshot(knowledgeBaseId, cursor);
          const snapshot = result.snapshot === null
            ? null
            : knowledgeSnapshotSyncSchema.parse(result.snapshot);
          const nextCursor = result.cursor === undefined ? undefined : normalizeCursor(result.cursor);
          if (snapshot !== null) {
            const handled = await this.applyRemoteSnapshot(knowledgeBaseId, snapshot);
            if (!handled) {
              return;
            }
          }
          if (nextCursor !== undefined) {
            await this.writeCursor(knowledgeBaseId, nextCursor);
          }
        });
      } catch {
        // Preserve the cursor and known-good snapshot for the next online poll.
      }
    }
  }

  private async applyRemoteSnapshot(
    knowledgeBaseId: string,
    snapshot: KnowledgeSnapshot,
  ): Promise<boolean> {
    if (snapshot.knowledgeBaseId !== knowledgeBaseId) {
      return false;
    }
    const active = await this.store.readActive(knowledgeBaseId);
    if (active !== null) {
      if (snapshot.version < active.version) {
        return true;
      }
      if (snapshot.version === active.version) {
        return canonicalJson(snapshot) === canonicalJson(active);
      }
    }
    if (await this.store.hasUnresolvedKnowledgeTransition(knowledgeBaseId)) {
      return false;
    }
    try {
      await this.store.publish(snapshot);
    } catch {
      return false;
    }
    const next = (await this.store.listStates()).find((state) => state.knowledgeBaseId === knowledgeBaseId);
    if (next !== undefined) {
      this.emit(next);
    }
    return true;
  }

  private emit(state: KnowledgeBaseStateSummary): void {
    const cloned = cloneSummary(state);
    for (const listener of this.listeners) {
      listener(cloned);
    }
  }

  private async readCursor(knowledgeBaseId: string): Promise<string | undefined> {
    const state = await this.withLock(this.cursorLockPath(), () => this.readCursorStateUnlocked());
    return state.cursors[knowledgeBaseId];
  }

  private async writeCursor(knowledgeBaseId: string, cursor: string): Promise<void> {
    await this.withLock(this.cursorLockPath(), async () => {
      const current = await this.readCursorStateUnlocked();
      const cursors = {
        ...current.cursors,
        [normalizeKnowledgeBaseId(knowledgeBaseId)]: normalizeCursor(cursor),
      };
      await this.writeCursorStateUnlocked({ schemaVersion: 1, cursors });
    });
  }

  private async readCursorStateUnlocked(): Promise<CursorState> {
    try {
      await this.assertManagedFile(this.cursorPath());
      const raw = await this.fileSystem.readFile(this.cursorPath(), 'utf8');
      return normalizeCursorState(JSON.parse(raw) as unknown);
    } catch (error) {
      if (isMissingFileError(error)) {
        return { schemaVersion: 1, cursors: {} };
      }
      throw error;
    }
  }

  private async writeCursorStateUnlocked(state: CursorState): Promise<void> {
    await this.ensureSyncDirectory();
    await this.assertManagedFileForWrite(this.cursorPath());
    await writeAtomic(
      this.fileSystem,
      this.cursorPath(),
      `${canonicalJson(normalizeCursorState(state))}\n`,
    );
  }

  private async withLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
    await this.ensureSyncDirectory();
    const lock = await this.acquireLock(lockPath);
    try {
      return await operation();
    } finally {
      await this.releaseLock(lock);
    }
  }

  private async acquireLock(lockPath: string): Promise<PullLock> {
    const token = createHash('sha256')
      .update(`${process.pid}:${Date.now()}:${Math.random()}`, 'utf8')
      .digest('hex');
    const startedAt = Date.now();
    for (;;) {
      await this.assertManagedFileForWrite(lockPath);
      let handle: FileHandleLike | null = null;
      let closed = false;
      try {
        handle = await this.fileSystem.open(lockPath, 'wx');
        await handle.writeFile(`${canonicalJson({
          schemaVersion: 1,
          token,
          processId: process.pid,
          createdAt: new Date(this.now()).toISOString(),
        })}\n`);
        await handle.sync();
        return { handle, path: lockPath, token };
      } catch (error) {
        if (handle !== null && !closed) {
          try {
            await handle.close();
            closed = true;
          } catch {
            // Preserve the lock acquisition failure.
          }
        }
        if (!isErrno(error, 'EEXIST')) {
          throw error;
        }
        if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
          throw new Error('Timed out waiting for approved snapshot pull lock');
        }
        await delay(LOCK_RETRY_MS);
      }
    }
  }

  private async releaseLock(lock: PullLock): Promise<void> {
    let closed = false;
    try {
      await this.assertManagedFile(lock.path);
      const parsed = JSON.parse(await this.fileSystem.readFile(lock.path, 'utf8')) as unknown;
      if (isOwnedLock(parsed, lock.token)) {
        await lock.handle.close();
        closed = true;
        await this.fileSystem.unlink(lock.path);
      }
    } catch {
      // Do not remove a lock that may have been replaced by another process.
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

  private async ensureSyncDirectory(): Promise<void> {
    await this.fileSystem.mkdir(this.appDataRoot, { recursive: true });
    await this.fileSystem.mkdir(this.syncRoot, { recursive: true });
    await this.assertManagedDirectory(this.syncRoot);
  }

  private async assertManagedDirectory(path: string): Promise<void> {
    const lstat = this.requireFileSystemMethod('lstat', this.fileSystem.lstat);
    const metadata = await lstat.call(this.fileSystem, path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink?.()) {
      throw new Error('Approved snapshot pull path escaped app data');
    }
    await this.assertRealManagedPath(path);
  }

  private async assertManagedFile(path: string): Promise<void> {
    const lstat = this.requireFileSystemMethod('lstat', this.fileSystem.lstat);
    const metadata = await lstat.call(this.fileSystem, path);
    if (!metadata.isFile() || metadata.isSymbolicLink?.()) {
      throw new Error('Approved snapshot pull path escaped app data');
    }
    await this.assertRealManagedPath(path);
  }

  private async assertManagedFileForWrite(path: string): Promise<void> {
    await this.assertManagedDirectory(dirname(path));
    try {
      await this.assertManagedFile(path);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
      const realpath = this.requireFileSystemMethod('realpath', this.fileSystem.realpath);
      const realSyncRoot = normalize(await realpath.call(this.fileSystem, this.syncRoot));
      const realParent = normalize(await realpath.call(this.fileSystem, dirname(path)));
      const target = normalize(resolve(realParent, basename(path)));
      if (!isWithinDirectory(realSyncRoot, target)) {
        throw new Error('Approved snapshot pull path escaped app data');
      }
    }
  }

  private async assertRealManagedPath(path: string): Promise<void> {
    const realpath = this.requireFileSystemMethod('realpath', this.fileSystem.realpath);
    const realSyncRoot = normalize(await realpath.call(this.fileSystem, this.syncRoot));
    const realTarget = normalize(await realpath.call(this.fileSystem, path));
    if (!isWithinDirectory(realSyncRoot, realTarget)) {
      throw new Error('Approved snapshot pull path escaped app data');
    }
  }

  private requireFileSystemMethod<Name extends 'lstat' | 'realpath'>(
    name: Name,
    method: FileSystem[Name],
  ): NonNullable<FileSystem[Name]> {
    if (method === undefined) {
      throw new Error(`Approved snapshot pull requires file system ${name}`);
    }
    return method;
  }

  private cursorPath(): string {
    return confinedJoin(this.syncRoot, 'approved-snapshot-pull-cursors.json');
  }

  private cursorLockPath(): string {
    return confinedJoin(this.syncRoot, 'approved-snapshot-pull-cursors.lock');
  }

  private pullLockPath(knowledgeBaseId: string): string {
    const id = createHash('sha256').update(normalizeKnowledgeBaseId(knowledgeBaseId), 'utf8').digest('hex').slice(0, 24);
    return confinedJoin(this.syncRoot, `approved-snapshot-pull-${id}.lock`);
  }
}

function normalizeCursorState(value: unknown): CursorState {
  if (!isRecord(value) || !hasOnlyKeys(value, ['schemaVersion', 'cursors']) || value.schemaVersion !== 1 || !isRecord(value.cursors)) {
    throw new Error('Approved snapshot pull cursor state is invalid');
  }
  const cursors: Record<string, string> = {};
  for (const [knowledgeBaseId, cursor] of Object.entries(value.cursors).sort(([left], [right]) => compareStrings(left, right))) {
    cursors[normalizeKnowledgeBaseId(knowledgeBaseId)] = normalizeCursor(cursor);
  }
  return { schemaVersion: 1, cursors };
}

function normalizeKnowledgeBaseId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 160 || containsProtectedValue(value)) {
    throw new Error('Approved snapshot pull cursor state is invalid');
  }
  return value;
}

function normalizeCursor(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || containsProtectedValue(value)) {
    throw new Error('Approved snapshot pull cursor state is invalid');
  }
  return value;
}

function containsProtectedValue(value: string): boolean {
  return /authorization\s*:/iu.test(value)
    || /\bbearer\s+\S+/iu.test(value)
    || /\b(?:api[_ -]?key|token|secret|password)\s*[:=]\s*\S+/iu.test(value)
    || /data:[^,\s;]+(?:;[^,\s;]+)*;base64,/iu.test(value)
    || /[A-Za-z]:\\/u.test(value)
    || /\\\\[^\\\s]+\\/u.test(value)
    || /(?:^|\s)\/(?:Users|home|var|etc|opt|tmp)\//u.test(value)
    || /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{64,}={0,2}(?![A-Za-z0-9+/=])/u.test(value);
}

function cloneSummary(summary: KnowledgeBaseStateSummary): KnowledgeBaseStateSummary {
  return {
    schemaVersion: 1,
    knowledgeBaseId: summary.knowledgeBaseId,
    displayName: summary.displayName,
    status: summary.status,
    activeVersion: summary.activeVersion,
    activeContentHash: summary.activeContentHash,
    versionCount: summary.versionCount,
    versions: summary.versions.map((version) => ({ ...version })),
    lastFailure: summary.lastFailure ? { ...summary.lastFailure } : null,
    lastRollbackAt: summary.lastRollbackAt,
  };
}

function confinedJoin(base: string, ...segments: string[]): string {
  const resolvedBase = resolve(base);
  const target = resolve(resolvedBase, ...segments);
  if (!isWithinDirectory(resolvedBase, target)) {
    throw new Error('Approved snapshot pull path escaped app data');
  }
  return target;
}

function isWithinDirectory(base: string, target: string): boolean {
  return target === base || target.startsWith(`${base}${sep}`);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function isOwnedLock(value: unknown, token: string): boolean {
  return isRecord(value) && value.schemaVersion === 1 && value.token === token;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}
