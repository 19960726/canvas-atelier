import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename, dirname, join, normalize, resolve, sep } from 'node:path';
import { URL } from 'node:url';

import {
  drainWritebackOutbox,
  enqueueWritebackJob,
  MemorySyncClient,
  serializeWritebackOutboxForTransfer,
  type KnowledgeSnapshot,
  type MemorySyncFetch,
  type WritebackOutboxJob,
  type WritebackOutboxState,
  type WritebackPlan,
} from '@agent-canvas/skill-store';

import { canonicalJson } from './canonical-json.js';
import { acquireConfinedFileLock, releaseConfinedFileLock } from './confined-file-lock.js';
import type { ApprovedSnapshotPullClient } from './approved-snapshot-pull.js';
import { type FileSystem, NodeFileSystem, writeAtomic } from './file-system.js';

export interface ApprovedSnapshotUploadClient {
  uploadApprovedSnapshot(
    snapshot: KnowledgeSnapshot,
    options: { readonly idempotencyKey: string },
  ): Promise<ApprovedSnapshotUploadResult>;
}

export interface ApprovedSnapshotUploadResult {
  /** Authoritative durable acknowledgement. Outbox jobs clear only when this is true. */
  readonly accepted: boolean;
  /** Idempotency diagnostic only; it never substitutes for an accepted acknowledgement. */
  readonly duplicate?: boolean;
}

export interface ApprovedSnapshotSyncClient extends ApprovedSnapshotUploadClient, ApprovedSnapshotPullClient {}

export interface ApprovedSnapshotReadableStore {
  readVersion(knowledgeBaseId: string, version: number): Promise<KnowledgeSnapshot | null>;
}

export interface ApprovedSnapshotOutboxOptions {
  readonly appDataRoot: string;
  readonly client?: ApprovedSnapshotUploadClient;
  readonly fileSystem?: FileSystem;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly store: ApprovedSnapshotReadableStore;
}

export interface ApprovedSnapshotSyncEnvironment {
  readonly NOVUS_KNOWLEDGE_SYNC_TOKEN?: string;
  readonly NOVUS_KNOWLEDGE_SYNC_URL?: string;
  readonly NOVUS_MEMORY_SYNC_TOKEN?: string;
  readonly NOVUS_MEMORY_SYNC_URL?: string;
}

export interface ApprovedSnapshotOutboxDrainHandle {
  drainNow(): Promise<void>;
  stop(): Promise<void>;
}

export interface ApprovedSnapshotOutboxDrainOptions {
  readonly client: ApprovedSnapshotUploadClient | null;
  readonly clearInterval?: (handle: unknown) => void;
  readonly intervalMs?: number;
  readonly isOnline?: () => boolean;
  readonly outbox: Pick<ApprovedSnapshotOutbox, 'drainApprovedSnapshots'>;
  readonly setInterval?: (listener: () => void, intervalMs: number) => unknown;
}

const DEFAULT_APPROVED_SNAPSHOT_DRAIN_INTERVAL_MS = 30_000;
const MAX_SYNC_RESPONSE_BYTES = 4 * 1024 * 1024;
const OUTBOX_LOCK_RETRY_MS = 10;
const OUTBOX_LOCK_TIMEOUT_MS = 5_000;

export class ApprovedSnapshotOutbox {
  private readonly appDataRoot: string;
  private readonly client: ApprovedSnapshotUploadClient | null;
  private readonly fileSystem: FileSystem;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly store: ApprovedSnapshotReadableStore;
  private readonly syncRoot: string;

  constructor(options: ApprovedSnapshotOutboxOptions) {
    this.appDataRoot = resolve(options.appDataRoot);
    this.client = options.client ?? null;
    this.fileSystem = options.fileSystem ?? new NodeFileSystem();
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.store = options.store;
    this.syncRoot = confinedJoin(this.appDataRoot, 'sync');
  }

  async enqueueApprovedSnapshot(snapshot: KnowledgeSnapshot): Promise<void> {
    await this.withStateLock(async () => {
      const state = await this.readStateUnlocked();
      const approvedSnapshot = {
        knowledgeBaseId: snapshot.knowledgeBaseId,
        version: snapshot.version,
        contentHash: snapshot.contentHash,
      };
      const alreadyQueued = state.jobs.some((job) => (
        job.approvedSnapshot?.knowledgeBaseId === approvedSnapshot.knowledgeBaseId &&
        job.approvedSnapshot.version === approvedSnapshot.version &&
        job.approvedSnapshot.contentHash === approvedSnapshot.contentHash
      ));
      if (alreadyQueued) {
        return;
      }

      await this.writeStateUnlocked(enqueueWritebackJob(state, {
        approvedSnapshot,
        historyPath: 'approved-snapshot-sync',
        plan: createApprovedSnapshotPlan(approvedSnapshot),
        target: 'source',
      }, {
        now: this.now,
        random: this.random,
      }));
    });
  }

  async drainApprovedSnapshots(client: ApprovedSnapshotUploadClient | null = this.client): Promise<{
    readonly processedJobIds: string[];
    readonly state: WritebackOutboxState;
  }> {
    return this.withLock(this.drainLockPath(), async () => {
      const state = await this.withStateLock(() => this.readStateUnlocked());
      if (client === null) {
        return {
          processedJobIds: [],
          state,
        };
      }

      const authorizationByJobId = Object.fromEntries(state.jobs.map((job) => [
        job.id,
        { approvalToken: 'approved-snapshot-sync' },
      ]));
      const drained = await drainWritebackOutbox(state, {
        authorizationByJobId,
        now: this.now,
        random: this.random,
        performWriteback: async ({ job }) => {
          const approved = job.approvedSnapshot;
          if (approved === undefined) {
            return { ok: true };
          }
          const snapshot = await this.store.readVersion(approved.knowledgeBaseId, approved.version);
          if (snapshot === null || snapshot.contentHash !== approved.contentHash) {
            return {
              ok: false,
              reason: 'missing_approved_snapshot',
              retryable: true,
            };
          }
          try {
            const result = await client.uploadApprovedSnapshot(snapshot, { idempotencyKey: job.id });
            if (!result.accepted) {
              return {
                ok: false,
                reason: 'approved_snapshot_not_accepted',
                retryable: true,
              };
            }
            return { ok: true };
          } catch (error) {
            return {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              reason: 'approved_snapshot_upload_failed',
              retryable: true,
            };
          }
        },
      });

      const committedState = await this.withStateLock(async () => {
        const latest = await this.readStateUnlocked();
        const merged = mergeDrainedState(state, drained.state, latest);
        await this.writeStateUnlocked(merged);
        return merged;
      });
      return { processedJobIds: drained.processedJobIds, state: committedState };
    });
  }

  async readPublicState(): Promise<ReturnType<typeof serializeWritebackOutboxForTransfer>> {
    const state = await this.withStateLock(() => this.readStateUnlocked());
    return serializeWritebackOutboxForTransfer(state);
  }

  private async readStateUnlocked(): Promise<WritebackOutboxState> {
    try {
      await this.assertManagedFile(this.statePath());
      const raw = await this.fileSystem.readFile(this.statePath(), 'utf8');
      return normalizeOutboxState(JSON.parse(raw) as unknown);
    } catch (error) {
      if (isMissingFileError(error)) {
        return { schemaVersion: 1, jobs: [] };
      }
      throw error;
    }
  }

  private async writeStateUnlocked(state: WritebackOutboxState): Promise<void> {
    await this.ensureSyncDirectory();
    await this.assertManagedFileForWrite(this.statePath());
    await writeAtomic(
      this.fileSystem,
      this.statePath(),
      `${canonicalJson(normalizeOutboxState(state))}\n`,
    );
  }

  private async withStateLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.withLock(this.stateLockPath(), operation);
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

  private async acquireLock(lockPath: string) {
    return acquireConfinedFileLock(lockPath, {
      fileSystem: this.fileSystem,
      assertPathForRead: (path) => this.assertManagedFile(path),
      assertPathForWrite: (path) => this.assertManagedFileForWrite(path),
      now: this.now,
      timeoutMessage: 'Timed out waiting for approved snapshot outbox lock',
    });
  }

  private async releaseLock(lock: Awaited<ReturnType<ApprovedSnapshotOutbox['acquireLock']>>): Promise<void> {
    await releaseConfinedFileLock(lock);
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
      throw new Error('Approved snapshot outbox path escaped app data');
    }
    await this.assertRealManagedPath(path);
  }

  private async assertManagedFile(path: string): Promise<void> {
    const lstat = this.requireFileSystemMethod('lstat', this.fileSystem.lstat);
    const metadata = await lstat.call(this.fileSystem, path);
    if (!metadata.isFile() || metadata.isSymbolicLink?.()) {
      throw new Error('Approved snapshot outbox path escaped app data');
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
        throw new Error('Approved snapshot outbox path escaped app data');
      }
    }
  }

  private async assertRealManagedPath(path: string): Promise<void> {
    const realpath = this.requireFileSystemMethod('realpath', this.fileSystem.realpath);
    const realSyncRoot = normalize(await realpath.call(this.fileSystem, this.syncRoot));
    const realTarget = normalize(await realpath.call(this.fileSystem, path));
    if (!isWithinDirectory(realSyncRoot, realTarget)) {
      throw new Error('Approved snapshot outbox path escaped app data');
    }
  }

  private requireFileSystemMethod<Name extends 'lstat' | 'realpath'>(
    name: Name,
    method: FileSystem[Name],
  ): NonNullable<FileSystem[Name]> {
    if (method === undefined) {
      throw new Error(`Approved snapshot outbox requires file system ${name}`);
    }
    return method;
  }

  private statePath(): string {
    return confinedJoin(this.syncRoot, 'approved-snapshot-outbox.json');
  }

  private stateLockPath(): string {
    return confinedJoin(this.syncRoot, 'approved-snapshot-outbox.lock');
  }

  private drainLockPath(): string {
    return confinedJoin(this.syncRoot, 'approved-snapshot-drain.lock');
  }
}

export function createApprovedSnapshotSyncClientFromEnv(
  env: ApprovedSnapshotSyncEnvironment,
  fetch: MemorySyncFetch = createNodeMemorySyncFetch(),
): ApprovedSnapshotSyncClient | null {
  const baseUrl = firstConfiguredValue(env.NOVUS_KNOWLEDGE_SYNC_URL, env.NOVUS_MEMORY_SYNC_URL);
  const token = firstConfiguredValue(env.NOVUS_KNOWLEDGE_SYNC_TOKEN, env.NOVUS_MEMORY_SYNC_TOKEN);
  if (baseUrl === null || token === null) {
    return null;
  }
  return new MemorySyncClient({
    baseUrl,
    fetch,
    tokenSupplier: async () => token,
  });
}

export function startApprovedSnapshotOutboxDrain(
  options: ApprovedSnapshotOutboxDrainOptions,
): ApprovedSnapshotOutboxDrainHandle {
  const clearTimer: (handle: unknown) => void = options.clearInterval
    ?? ((handle) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>));
  const intervalMs = options.intervalMs ?? DEFAULT_APPROVED_SNAPSHOT_DRAIN_INTERVAL_MS;
  const isOnline = options.isOnline ?? (() => true);
  const setTimer: (listener: () => void, intervalMs: number) => unknown = options.setInterval
    ?? ((listener, ms) => globalThis.setInterval(listener, ms));
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const drainNow = async (): Promise<void> => {
    if (stopped || options.client === null || !isOnline()) {
      return;
    }
    if (inFlight !== null) {
      return inFlight;
    }
    inFlight = options.outbox
      .drainApprovedSnapshots(options.client)
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  const timer = options.client === null
    ? null
    : setTimer(() => {
      void drainNow();
    }, intervalMs);
  void drainNow();

  return {
    drainNow,
    async stop() {
      stopped = true;
      if (timer !== null) {
        clearTimer(timer);
      }
      await inFlight;
    },
  };
}

function firstConfiguredValue(...values: (string | undefined)[]): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function createNodeMemorySyncFetch(): MemorySyncFetch {
  return async (url, init = {}) => new Promise((resolvePromise, reject) => {
    const parsedUrl = new URL(url);
    const request = parsedUrl.protocol === 'https:'
      ? httpsRequest
      : parsedUrl.protocol === 'http:'
        ? httpRequest
        : null;
    if (request === null) {
      reject(new Error('knowledge sync URL must use http or https'));
      return;
    }

    const outgoing = request(parsedUrl, {
      headers: init.headers,
      method: init.method ?? 'GET',
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > MAX_SYNC_RESPONSE_BYTES) {
          outgoing.destroy(new Error('knowledge sync response exceeded the maximum size'));
        }
      });
      response.on('end', () => {
        const status = response.statusCode ?? 0;
        resolvePromise({
          ok: status >= 200 && status < 300,
          status,
          json: async () => (body.length === 0 ? null : JSON.parse(body) as unknown),
        });
      });
    });
    outgoing.on('error', reject);
    if (init.body !== undefined) {
      outgoing.write(init.body);
    }
    outgoing.end();
  });
}

function createApprovedSnapshotPlan(snapshot: {
  readonly knowledgeBaseId: string;
  readonly version: number;
  readonly contentHash: string;
}): WritebackPlan {
  const diffHash = createHash('sha256')
    .update(canonicalJson({ approvedSnapshot: snapshot }), 'utf8')
    .digest('hex');
  return {
    diffHash,
    diff: [],
    targets: {
      source: { writeFiles: [], preservedFiles: [], blockedFiles: [] },
      app: { writeFiles: [], preservedFiles: [], blockedFiles: [] },
    },
    payload: { memory: [], originalImages: [] },
    roots: { baseRoot: '.', appRoot: '.', sourceRoot: '.' },
  };
}

function normalizeOutboxState(value: unknown): WritebackOutboxState {
  if (!isRecord(value) || !hasOnlyKeys(value, ['schemaVersion', 'jobs']) || value.schemaVersion !== 1 || !Array.isArray(value.jobs)) {
    throw new Error('Approved snapshot outbox state is invalid');
  }
  const jobs = value.jobs.map(normalizeOutboxJob);
  if (new Set(jobs.map((job) => job.id)).size !== jobs.length) {
    throw new Error('Approved snapshot outbox state is invalid');
  }
  return { schemaVersion: 1, jobs };
}

function normalizeOutboxJob(value: unknown): WritebackOutboxJob {
  const allowedKeys = [
    'id',
    'target',
    'plan',
    'historyPath',
    'approvedSnapshot',
    'status',
    'attemptCount',
    'createdAt',
    'updatedAt',
    'nextRetryAt',
    'lastError',
    'requiresReauthorization',
  ];
  if (!isRecord(value) || !hasOnlyKeys(value, allowedKeys)) {
    throw new Error('Approved snapshot outbox state is invalid');
  }
  const approvedSnapshot = normalizeApprovedSnapshotReference(value.approvedSnapshot);
  const plan = createApprovedSnapshotPlan(approvedSnapshot);
  if (canonicalJson(value.plan) !== canonicalJson(plan)) {
    throw new Error('Approved snapshot outbox state is invalid');
  }
  const status = value.status;
  if (status !== 'queued' && status !== 'uploading' && status !== 'retry_wait') {
    throw new Error('Approved snapshot outbox state is invalid');
  }
  const nextRetryAt = value.nextRetryAt === undefined ? undefined : requireDateString(value.nextRetryAt);
  const lastError = value.lastError === undefined ? undefined : requireSafePublicString(value.lastError);
  if (
    typeof value.id !== 'string' || !/^[a-f0-9]{16}$/u.test(value.id) ||
    value.target !== 'source' ||
    value.historyPath !== 'approved-snapshot-sync' ||
    !Number.isInteger(value.attemptCount) || (value.attemptCount as number) < 0 ||
    value.requiresReauthorization !== true
  ) {
    throw new Error('Approved snapshot outbox state is invalid');
  }
  return {
    id: value.id,
    target: 'source',
    plan,
    historyPath: 'approved-snapshot-sync',
    approvedSnapshot,
    status,
    attemptCount: value.attemptCount as number,
    createdAt: requireDateString(value.createdAt),
    updatedAt: requireDateString(value.updatedAt),
    ...(nextRetryAt === undefined ? {} : { nextRetryAt }),
    ...(lastError === undefined ? {} : { lastError }),
    requiresReauthorization: true,
  };
}

function normalizeApprovedSnapshotReference(value: unknown): {
  knowledgeBaseId: string;
  version: number;
  contentHash: string;
} {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['knowledgeBaseId', 'version', 'contentHash']) ||
    typeof value.knowledgeBaseId !== 'string' ||
    value.knowledgeBaseId.trim().length === 0 ||
    containsProtectedValue(value.knowledgeBaseId) ||
    !Number.isInteger(value.version) ||
    (value.version as number) <= 0 ||
    typeof value.contentHash !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.contentHash)
  ) {
    throw new Error('Approved snapshot outbox state is invalid');
  }
  return {
    knowledgeBaseId: value.knowledgeBaseId,
    version: value.version as number,
    contentHash: value.contentHash,
  };
}

function mergeDrainedState(
  drainedInput: WritebackOutboxState,
  drainedOutput: WritebackOutboxState,
  latest: WritebackOutboxState,
): WritebackOutboxState {
  const inputIds = new Set(drainedInput.jobs.map((job) => job.id));
  const outputById = new Map(drainedOutput.jobs.map((job) => [job.id, job]));
  return normalizeOutboxState({
    schemaVersion: 1,
    jobs: latest.jobs.flatMap((job) => {
      if (!inputIds.has(job.id)) {
        return [job];
      }
      const updated = outputById.get(job.id);
      return updated === undefined ? [] : [updated];
    }),
  });
}

function requireDateString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || Number.isNaN(Date.parse(value))) {
    throw new Error('Approved snapshot outbox state is invalid');
  }
  return value;
}

function requireSafePublicString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 240 || containsProtectedValue(value)) {
    throw new Error('Approved snapshot outbox state is invalid');
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

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function confinedJoin(base: string, ...segments: string[]): string {
  const resolvedBase = resolve(base);
  const target = resolve(resolvedBase, ...segments);
  if (!isWithinDirectory(resolvedBase, target)) {
    throw new Error('Approved snapshot outbox path escaped app data');
  }
  return target;
}

function isWithinDirectory(base: string, target: string): boolean {
  return target === base || target.startsWith(`${base}${sep}`);
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
