import { createHash } from 'node:crypto';
import { join, normalize } from 'node:path';

import { canonicalJson } from './canonical-json.js';
import { type FileSystem, NodeFileSystem, writeAtomic } from './file-system.js';

const RECENT_PROJECT_INDEX_SCHEMA_VERSION = 1;
const RECENT_PROJECT_INDEX_FILE = 'recent-projects.index.json';
const PROJECT_MANIFEST_FILE = 'project.novus.json';
const PROJECT_PREVIEW_FILE = 'preview.png';
const RECENT_PROJECT_STAT_TIMEOUT_MS = 2_000;
const RECENT_PROJECT_STAT_QUEUE_LIMIT = 256;

export interface RecentProjectSummary {
  readonly recentProjectId: string;
  readonly projectId: string;
  readonly displayName: string;
  readonly lastOpenedAt: string;
  readonly lastSavedAt: string;
  readonly availability: 'available' | 'missing';
  readonly nodeCount: number;
  readonly imageCount: number;
  readonly videoCount: number;
  readonly previewUrl: string | null;
}

export interface RecentProjectEntryInput {
  readonly root: string;
  readonly projectId: string;
  readonly displayName: string;
  readonly lastOpenedAt: string;
  readonly lastSavedAt: string;
  readonly nodeCount: number;
  readonly imageCount: number;
  readonly videoCount: number;
}

export interface RecentProjectStoreOptions {
  readonly appDataRoot: string;
  readonly fileSystem?: FileSystem;
}

interface InternalRecentProjectEntry extends RecentProjectEntryInput {
  readonly recentProjectId: string;
}

interface RecentProjectIndex {
  readonly schemaVersion: typeof RECENT_PROJECT_INDEX_SCHEMA_VERSION;
  readonly entries: readonly InternalRecentProjectEntry[];
}

interface QueuedStatOperation {
  started: boolean;
  settled: boolean;
  readonly execute: () => Promise<void>;
  readonly cancel: () => void;
}

export class RecentProjectStore {
  private readonly appDataRoot: string;
  private readonly fileSystem: FileSystem;
  private readonly indexPath: string;
  // The index is a read-modify-write document. Serialize mutations for this
  // store instance so simultaneous project sessions cannot overwrite each
  // other's recent entry with a stale snapshot.
  private mutationTail: Promise<void> = Promise.resolve();
  // Windows cannot abort an in-flight fs.stat against an unavailable UNC or
  // mapped drive. Keep availability probes in one bounded lane so stale recent
  // entries cannot consume the libuv worker pool used by project persistence.
  private statOperationActive = false;
  private readonly statOperationQueue: QueuedStatOperation[] = [];

  constructor(options: RecentProjectStoreOptions) {
    if (typeof options.appDataRoot !== 'string' || options.appDataRoot.length === 0) {
      throw new Error('RECENT_PROJECT_INVALID_ROOT');
    }
    this.appDataRoot = options.appDataRoot;
    this.fileSystem = options.fileSystem ?? new NodeFileSystem();
    this.indexPath = join(this.appDataRoot, RECENT_PROJECT_INDEX_FILE);
  }

  async upsert(input: RecentProjectEntryInput): Promise<readonly RecentProjectSummary[]> {
    const entry = validateRecentProjectEntry(input);
    await this.enqueueMutation(async () => {
      const index = await this.readIndex();
      const recentProjectId = createRecentProjectId(entry.root);
      const entries = index.entries
        .filter((existing) => existing.projectId !== entry.projectId && existing.recentProjectId !== recentProjectId)
        .concat({ ...entry, recentProjectId });
      await this.writeIndex(entries);
    });
    return this.readSummaries();
  }

  async list(): Promise<readonly RecentProjectSummary[]> {
    await this.mutationTail;
    return this.readSummaries();
  }

  private async readSummaries(): Promise<readonly RecentProjectSummary[]> {
    const index = await this.readIndex();
    const summaries = await Promise.all(index.entries.map((entry) => this.toSummary(entry)));
    return summaries.sort((left, right) => {
      const openedOrder = Date.parse(right.lastOpenedAt) - Date.parse(left.lastOpenedAt);
      if (openedOrder !== 0) return openedOrder;
      return Date.parse(right.lastSavedAt) - Date.parse(left.lastSavedAt);
    });
  }

  async remove(recentProjectId: string): Promise<readonly RecentProjectSummary[]> {
    assertRecentProjectId(recentProjectId);
    await this.enqueueMutation(async () => {
      const index = await this.readIndex();
      await this.writeIndex(index.entries.filter((entry) => entry.recentProjectId !== recentProjectId));
    });
    return this.readSummaries();
  }

  async resolveRoot(recentProjectId: string): Promise<string | null> {
    assertRecentProjectId(recentProjectId);
    await this.mutationTail;
    const entry = (await this.readIndex()).entries.find((candidate) => candidate.recentProjectId === recentProjectId);
    if (entry === undefined || !(await this.isAvailable(entry.root))) return null;
    return entry.root;
  }
  async resolvePreviewPath(recentProjectId: string): Promise<string | null> {
    const root = await this.resolveRoot(recentProjectId);
    if (root === null) return null;
    const previewPath = join(root, PROJECT_PREVIEW_FILE);
    return await this.fileExists(previewPath, 'file') ? previewPath : null;
  }

  async relocate(recentProjectId: string, root: string): Promise<RecentProjectSummary | null> {
    assertRecentProjectId(recentProjectId);
    const nextRecentProjectId = await this.enqueueMutation(async () => {
      const index = await this.readIndex();
      const entry = index.entries.find((candidate) => candidate.recentProjectId === recentProjectId);
      if (entry === undefined) return null;
      if (!(await this.isAvailable(root)) || !(await this.projectIdAtRootMatches(root, entry.projectId))) return null;
      const relocated = validateRecentProjectEntry({ ...entry, root });
      const nextId = createRecentProjectId(relocated.root);
      const entries = index.entries
        .filter((candidate) => candidate.recentProjectId !== recentProjectId && candidate.recentProjectId !== nextId)
        .concat({ ...relocated, recentProjectId: nextId });
      await this.writeIndex(entries);
      return nextId;
    });
    if (nextRecentProjectId === null) return null;
    return (await this.readSummaries()).find((summary) => summary.recentProjectId === nextRecentProjectId) ?? null;
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async toSummary(entry: InternalRecentProjectEntry): Promise<RecentProjectSummary> {
    const availability = await this.isAvailable(entry.root) ? 'available' : 'missing';
    const previewPath = join(entry.root, PROJECT_PREVIEW_FILE);
    const previewAvailable = availability === 'available' && await this.fileExists(previewPath, 'file');
    return {
      recentProjectId: entry.recentProjectId,
      projectId: entry.projectId,
      displayName: entry.displayName,
      lastOpenedAt: entry.lastOpenedAt,
      lastSavedAt: entry.lastSavedAt,
      availability,
      nodeCount: entry.nodeCount,
      imageCount: entry.imageCount,
      videoCount: entry.videoCount,
      previewUrl: previewAvailable
        ? `novus-recent-project://${entry.recentProjectId}/preview`
        : null,
    };
  }

  private async isAvailable(root: string): Promise<boolean> {
    const manifestPath = join(root, PROJECT_MANIFEST_FILE);
    return this.runStatOperation(async () => {
      const rootStat = await this.fileSystem.stat(root);
      if (!rootStat.isDirectory()) return false;
      return (await this.fileSystem.stat(manifestPath)).isFile();
    }, false);
  }

  private async projectIdAtRootMatches(root: string, expectedProjectId: string): Promise<boolean> {
    try {
      const parsed = JSON.parse(await this.fileSystem.readFile(join(root, PROJECT_MANIFEST_FILE), 'utf8')) as unknown;
      return typeof parsed === 'object'
        && parsed !== null
        && !Array.isArray(parsed)
        && (parsed as { readonly projectId?: unknown }).projectId === expectedProjectId;
    } catch {
      return false;
    }
  }

  private fileExists(path: string, kind: 'directory' | 'file'): Promise<boolean> {
    return this.runStatOperation(async () => {
      const stat = await this.fileSystem.stat(path);
      return kind === 'directory' ? stat.isDirectory() : stat.isFile();
    }, false);
  }

  private async runStatOperation<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
    const scheduled = this.scheduleStatOperation(operation, fallback);
    const timeoutId = globalThis.setTimeout(scheduled.cancel, RECENT_PROJECT_STAT_TIMEOUT_MS);
    try {
      return await scheduled.promise;
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
  }

  private scheduleStatOperation<T>(
    operation: () => Promise<T>,
    fallback: T,
  ): { readonly promise: Promise<T>; readonly cancel: () => void } {
    let resolveResult!: (value: T) => void;
    const promise = new Promise<T>((resolve) => { resolveResult = resolve; });
    let entry!: QueuedStatOperation;
    const settle = (value: T): void => {
      if (entry.settled) return;
      entry.settled = true;
      resolveResult(value);
    };
    entry = {
      started: false,
      settled: false,
      execute: async () => {
        try {
          settle(await operation());
        } catch {
          settle(fallback);
        }
      },
      cancel: () => {
        if (entry.settled) return;
        if (!entry.started) {
          const index = this.statOperationQueue.indexOf(entry);
          if (index >= 0) this.statOperationQueue.splice(index, 1);
        }
        settle(fallback);
      },
    };
    if (!this.statOperationActive) {
      this.startStatOperation(entry);
    } else if (this.statOperationQueue.length < RECENT_PROJECT_STAT_QUEUE_LIMIT) {
      this.statOperationQueue.push(entry);
    } else {
      entry.cancel();
    }
    return { promise, cancel: entry.cancel };
  }

  private startStatOperation(entry: QueuedStatOperation): void {
    this.statOperationActive = true;
    entry.started = true;
    void entry.execute().finally(() => {
      this.statOperationActive = false;
      this.startNextStatOperation();
    });
  }

  private startNextStatOperation(): void {
    while (this.statOperationQueue.length > 0) {
      const next = this.statOperationQueue.shift()!;
      if (next.settled) continue;
      this.startStatOperation(next);
      return;
    }
  }

  private async readIndex(): Promise<RecentProjectIndex> {
    let raw: string;
    try {
      raw = await this.fileSystem.readFile(this.indexPath, 'utf8');
    } catch (error) {
      if (hasErrno(error, 'ENOENT')) return { schemaVersion: RECENT_PROJECT_INDEX_SCHEMA_VERSION, entries: [] };
      throw error;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecentProjectIndex(parsed)) throw new Error('RECENT_PROJECT_INDEX_CORRUPT');
    return parsed;
  }

  private async writeIndex(entries: readonly InternalRecentProjectEntry[]): Promise<void> {
    await this.fileSystem.mkdir(this.appDataRoot, { recursive: true });
    await writeAtomic(this.fileSystem, this.indexPath, `${canonicalJson({
      schemaVersion: RECENT_PROJECT_INDEX_SCHEMA_VERSION,
      entries,
    })}\n`);
  }
}

export function createRecentProjectId(root: string): string {
  const normalizedRoot = normalize(root).replace(/\\\\/gu, '/').toLocaleLowerCase('en-US');
  return `recent_${createHash('sha256').update(normalizedRoot).digest('hex').slice(0, 24)}`;
}

function validateRecentProjectEntry(input: RecentProjectEntryInput): RecentProjectEntryInput {
  if (typeof input.root !== 'string' || input.root.length === 0) throw new Error('RECENT_PROJECT_INVALID_ENTRY');
  if (typeof input.projectId !== 'string' || input.projectId.length === 0 || input.projectId.length > 200) {
    throw new Error('RECENT_PROJECT_INVALID_ENTRY');
  }
  if (typeof input.displayName !== 'string' || input.displayName.trim().length === 0 || input.displayName.length > 200) {
    throw new Error('RECENT_PROJECT_INVALID_ENTRY');
  }
  if (!isIsoDate(input.lastOpenedAt) || !isIsoDate(input.lastSavedAt)) throw new Error('RECENT_PROJECT_INVALID_ENTRY');
  for (const count of [input.nodeCount, input.imageCount, input.videoCount]) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('RECENT_PROJECT_INVALID_ENTRY');
  }
  return {
    root: input.root,
    projectId: input.projectId,
    displayName: input.displayName.trim(),
    lastOpenedAt: input.lastOpenedAt,
    lastSavedAt: input.lastSavedAt,
    nodeCount: input.nodeCount,
    imageCount: input.imageCount,
    videoCount: input.videoCount,
  };
}

function isRecentProjectIndex(value: unknown): value is RecentProjectIndex {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Partial<RecentProjectIndex>;
  return record.schemaVersion === RECENT_PROJECT_INDEX_SCHEMA_VERSION
    && Array.isArray(record.entries)
    && record.entries.every(isInternalEntry);
}

function isInternalEntry(value: unknown): value is InternalRecentProjectEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  try {
    const record = value as Partial<InternalRecentProjectEntry>;
    assertRecentProjectId(record.recentProjectId);
    validateRecentProjectEntry(record as RecentProjectEntryInput);
    return createRecentProjectId(record.root!) === record.recentProjectId;
  } catch {
    return false;
  }
}

function assertRecentProjectId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^recent_[a-f0-9]{24}$/u.test(value)) {
    throw new Error('RECENT_PROJECT_INVALID_ID');
  }
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function hasErrno(error: unknown, errno: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === errno;
}
