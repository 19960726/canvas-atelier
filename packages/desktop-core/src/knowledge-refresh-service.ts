import { watch as watchFileSystem } from 'node:fs';
import { basename, normalize, relative, resolve, sep } from 'node:path';

import {
  createKnowledgeSnapshotCandidate,
  type KnowledgeBaseStateSummary,
  type KnowledgeSnapshot,
} from '@agent-canvas/skill-store';

import { type FileSystem, NodeFileSystem } from './file-system.js';
import { type InternalKnowledgeConfiguration, ManagedKnowledgeStore } from './managed-knowledge-store.js';

const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_STABILITY_WINDOW_MS = 50;
const DEFAULT_SOURCE_DEVICE_ID = 'desktop-core';
const FALLBACK_REASON = 'Knowledge refresh failed';

export interface KnowledgeWatchEvent {
  readonly eventType?: string;
  readonly filename?: string | Buffer | null;
}

export interface KnowledgeWatchHandle {
  close(): void | Promise<void>;
}

export interface KnowledgeWatchAdapter {
  watch(rootPath: string, listener: (event: KnowledgeWatchEvent) => void): KnowledgeWatchHandle;
}

export interface KnowledgeRefreshClock<Timer = ReturnType<typeof setTimeout>> {
  clearTimeout(timer: Timer): void;
  now(): Date;
  setTimeout(callback: () => void | Promise<void>, delayMs: number): Timer;
}

export interface KnowledgeRefreshServiceOptions<Timer = ReturnType<typeof setTimeout>> {
  readonly clock?: KnowledgeRefreshClock<Timer>;
  readonly debounceMs?: number;
  readonly fileSystem?: FileSystem;
  readonly sourceDeviceId?: string;
  readonly stabilityWait?: (delayMs: number) => Promise<void>;
  readonly stabilityWindowMs?: number;
  readonly store: ManagedKnowledgeStore;
  readonly watchAdapter?: KnowledgeWatchAdapter;
}

interface ActiveWatch {
  readonly handle: KnowledgeWatchHandle;
}

interface PendingTimer<Timer> {
  readonly timer: Timer;
}

interface SourceDocument {
  readonly relativePath: string;
  readonly content: string;
}

interface SourceFileManifestEntry {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly size: number | null;
  readonly mtimeMs: number | null;
}

interface RefreshQueue {
  requested: boolean;
  requestedEpoch: number | null;
  promise: Promise<KnowledgeBaseStateSummary>;
}

class RefreshCancelledError extends Error {}
class SourceUnstableError extends Error {}

export class KnowledgeRefreshService<Timer = ReturnType<typeof setTimeout>> {
  private readonly clock: KnowledgeRefreshClock<Timer>;
  private readonly debounceMs: number;
  private readonly fileSystem: FileSystem;
  private readonly listeners = new Set<(state: KnowledgeBaseStateSummary) => void>();
  private readonly queues = new Map<string, RefreshQueue>();
  private readonly sourceDeviceId: string;
  private readonly stabilityWait: (delayMs: number) => Promise<void>;
  private readonly stabilityWindowMs: number;
  private readonly store: ManagedKnowledgeStore;
  private readonly timers = new Map<string, PendingTimer<Timer>>();
  private readonly watchAdapter: KnowledgeWatchAdapter;
  private readonly watches = new Map<string, ActiveWatch>();
  private lifecycleEpoch = 0;
  private started = false;

  constructor(options: KnowledgeRefreshServiceOptions<Timer>) {
    this.clock = options.clock ?? createSystemClock<Timer>();
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.fileSystem = options.fileSystem ?? new NodeFileSystem();
    this.sourceDeviceId = options.sourceDeviceId ?? DEFAULT_SOURCE_DEVICE_ID;
    this.stabilityWait = options.stabilityWait ?? delay;
    this.stabilityWindowMs = options.stabilityWindowMs ?? DEFAULT_STABILITY_WINDOW_MS;
    this.store = options.store;
    this.watchAdapter = options.watchAdapter ?? new NodeKnowledgeWatchAdapter();
  }

  async start(knowledgeBaseIds: string[]): Promise<void> {
    await this.stop();
    this.lifecycleEpoch += 1;
    this.started = true;

    for (const knowledgeBaseId of knowledgeBaseIds) {
      const configuration = await this.store.readConfiguration(knowledgeBaseId);
      if (configuration === null) {
        throw new Error('Unknown knowledge base');
      }

      const handle = this.watchAdapter.watch(configuration.rootPath, (event) => {
        this.onWatchEvent(knowledgeBaseId, event);
      });
      this.watches.set(knowledgeBaseId, { handle });
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    this.lifecycleEpoch += 1;
    for (const pending of this.timers.values()) {
      this.clock.clearTimeout(pending.timer);
    }
    this.timers.clear();

    const handles = [...this.watches.values()].map((watch) => watch.handle);
    this.watches.clear();
    await Promise.all(handles.map(async (handle) => {
      await handle.close();
    }));
    await Promise.all([...this.queues.values()].map((queue) => queue.promise));
  }

  async refreshNow(knowledgeBaseId: string): Promise<KnowledgeBaseStateSummary> {
    return this.enqueueRefresh(knowledgeBaseId, this.started ? this.lifecycleEpoch : null);
  }

  subscribe(listener: (state: KnowledgeBaseStateSummary) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private enqueueRefresh(knowledgeBaseId: string, epoch: number | null): Promise<KnowledgeBaseStateSummary> {
    const existing = this.queues.get(knowledgeBaseId);
    if (existing !== undefined) {
      existing.requested = true;
      existing.requestedEpoch = epoch;
      return existing.promise;
    }

    const queue: RefreshQueue = {
      requested: true,
      requestedEpoch: epoch,
      promise: Promise.resolve(null as unknown as KnowledgeBaseStateSummary),
    };
    queue.promise = (async () => {
      let result: KnowledgeBaseStateSummary | null = null;
      while (queue.requested) {
        queue.requested = false;
        const requestedEpoch = queue.requestedEpoch;
        queue.requestedEpoch = null;
        result = await this.performRefresh(knowledgeBaseId, requestedEpoch);
      }
      if (result !== null) {
        return result;
      }
      const configuration = await this.requireConfiguration(knowledgeBaseId);
      return this.readCurrentSummary(configuration);
    })().finally(() => {
      if (this.queues.get(knowledgeBaseId) === queue) {
        this.queues.delete(knowledgeBaseId);
      }
    });
    this.queues.set(knowledgeBaseId, queue);
    return queue.promise;
  }

  private async performRefresh(
    knowledgeBaseId: string,
    epoch: number | null,
  ): Promise<KnowledgeBaseStateSummary> {
    const configuration = await this.requireConfiguration(knowledgeBaseId);
    const currentBefore = await this.readCurrentSummary(configuration);
    if (!this.isRefreshActive(epoch)) {
      return cloneSummary(currentBefore);
    }
    if (await this.store.hasUnresolvedKnowledgeTransition(knowledgeBaseId)) {
      this.scheduleRetry(knowledgeBaseId, epoch);
      return cloneSummary(currentBefore);
    }

    try {
      const documents = await this.readStableSourceDocuments(configuration.rootPath, epoch);
      this.assertRefreshActive(epoch);
      const candidate = createKnowledgeSnapshotCandidate({
        knowledgeBaseId: configuration.knowledgeBaseId,
        displayName: configuration.displayName,
        documents,
      });
      const current = await this.readCurrentSummary(configuration);
      if (current.activeContentHash === candidate.contentHash) {
        return cloneSummary(current);
      }
      if (await this.store.hasUnresolvedKnowledgeTransition(knowledgeBaseId)) {
        this.scheduleRetry(knowledgeBaseId, epoch);
        return cloneSummary(current);
      }
      this.assertRefreshActive(epoch);

      const snapshot: KnowledgeSnapshot = {
        ...candidate,
        version: nextVersion(current),
        publishedAt: this.clock.now().toISOString(),
        sourceDeviceId: this.sourceDeviceId,
      };
      await this.store.publish(snapshot);
      const next = await this.readCurrentSummary(configuration);
      if (this.isRefreshActive(epoch)) {
        this.emit(next);
      }
      return cloneSummary(next);
    } catch (error) {
      if (error instanceof SourceUnstableError || isReservationError(error)) {
        this.scheduleRetry(knowledgeBaseId, epoch);
        return cloneSummary(await this.readCurrentSummary(configuration));
      }
      if (error instanceof RefreshCancelledError || !this.isRefreshActive(epoch)) {
        return cloneSummary(await this.readCurrentSummary(configuration));
      }
      const fallback = await this.store.recordRefreshFailure(
        configuration.knowledgeBaseId,
        sanitizeFailureReason(error, configuration.rootPath),
        this.clock.now().toISOString(),
      );
      if (this.isRefreshActive(epoch)) {
        this.emit(fallback);
      }
      return cloneSummary(fallback);
    }
  }

  private onWatchEvent(knowledgeBaseId: string, event: KnowledgeWatchEvent): void {
    if (!this.started || isIgnoredTemporaryPath(event.filename)) {
      return;
    }
    this.scheduleRefresh(knowledgeBaseId, this.lifecycleEpoch);
  }

  private scheduleRefresh(knowledgeBaseId: string, epoch: number): void {
    const pending = this.timers.get(knowledgeBaseId);
    if (pending) {
      this.clock.clearTimeout(pending.timer);
    }

    const timer = this.clock.setTimeout(async () => {
      this.timers.delete(knowledgeBaseId);
      if (this.isRefreshActive(epoch)) {
        await this.enqueueRefresh(knowledgeBaseId, epoch);
      }
    }, this.debounceMs);
    this.timers.set(knowledgeBaseId, { timer });
  }

  private scheduleRetry(knowledgeBaseId: string, epoch: number | null): void {
    if (epoch !== null && this.isRefreshActive(epoch)) {
      this.scheduleRefresh(knowledgeBaseId, epoch);
    }
  }

  private async readStableSourceDocuments(
    rootPath: string,
    epoch: number | null,
  ): Promise<SourceDocument[]> {
    const root = normalize(resolve(rootPath));
    const before = await this.readSourceManifest(root);
    this.assertRefreshActive(epoch);
    await this.stabilityWait(this.stabilityWindowMs);
    this.assertRefreshActive(epoch);
    const after = await this.readSourceManifest(root);
    if (!manifestsEqual(before, after)) {
      throw new SourceUnstableError('Knowledge source changed during the stability window');
    }

    const documents: SourceDocument[] = [];
    for (const entry of after) {
      this.assertRefreshActive(epoch);
      documents.push({
        relativePath: entry.relativePath,
        content: await this.fileSystem.readFile(entry.absolutePath, 'utf8'),
      });
    }
    return documents;
  }

  private async readSourceManifest(root: string): Promise<SourceFileManifestEntry[]> {
    const entries: SourceFileManifestEntry[] = [];
    await this.readManifestDirectory(root, root, entries);
    return entries.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
  }

  private async readManifestDirectory(
    root: string,
    directory: string,
    manifest: SourceFileManifestEntry[],
  ): Promise<void> {
    const entries = (await this.fileSystem.readdir(directory)).sort(compareStrings);
    for (const entry of entries) {
      if (isIgnoredTemporaryName(entry)) {
        continue;
      }

      const path = confinedResolve(root, directory, entry);
      const stat = this.fileSystem.lstat
        ? await this.fileSystem.lstat(path)
        : await this.fileSystem.stat(path);
      if (stat.isSymbolicLink?.()) {
        continue;
      }

      if (stat.isDirectory()) {
        await this.readManifestDirectory(root, path, manifest);
      } else if (stat.isFile()) {
        manifest.push({
          absolutePath: path,
          relativePath: toManagedRelativePath(root, path),
          size: typeof stat.size === 'number' ? stat.size : null,
          mtimeMs: typeof stat.mtimeMs === 'number' ? stat.mtimeMs : null,
        });
      }
    }
  }

  private async requireConfiguration(knowledgeBaseId: string): Promise<InternalKnowledgeConfiguration> {
    const configuration = await this.store.readConfiguration(knowledgeBaseId);
    if (configuration === null) {
      throw new Error('Unknown knowledge base');
    }
    return configuration;
  }

  private async readCurrentSummary(
    configuration: InternalKnowledgeConfiguration,
  ): Promise<KnowledgeBaseStateSummary> {
    return (await this.store.listStates()).find((state) => (
      state.knowledgeBaseId === configuration.knowledgeBaseId
    )) ?? createEmptySummary(configuration);
  }

  private isRefreshActive(epoch: number | null): boolean {
    return epoch === null || (this.started && epoch === this.lifecycleEpoch);
  }

  private assertRefreshActive(epoch: number | null): void {
    if (!this.isRefreshActive(epoch)) {
      throw new RefreshCancelledError('Knowledge refresh stopped');
    }
  }

  private emit(state: KnowledgeBaseStateSummary): void {
    for (const listener of this.listeners) {
      listener(cloneSummary(state));
    }
  }
}

class NodeKnowledgeWatchAdapter implements KnowledgeWatchAdapter {
  watch(rootPath: string, listener: (event: KnowledgeWatchEvent) => void): KnowledgeWatchHandle {
    const watcher = watchFileSystem(rootPath, { recursive: true }, (eventType, filename) => {
      listener({
        eventType,
        filename: filename === null ? null : String(filename),
      });
    });
    return {
      close: () => {
        watcher.close();
      },
    };
  }
}

function createSystemClock<Timer>(): KnowledgeRefreshClock<Timer> {
  return {
    clearTimeout: (timer) => {
      clearTimeout(timer as ReturnType<typeof setTimeout>);
    },
    now: () => new Date(),
    setTimeout: (callback, delayMs) => (
      setTimeout(() => {
        void callback();
      }, delayMs) as Timer
    ),
  };
}

function createEmptySummary(configuration: InternalKnowledgeConfiguration): KnowledgeBaseStateSummary {
  return {
    schemaVersion: 1,
    knowledgeBaseId: configuration.knowledgeBaseId,
    displayName: configuration.displayName,
    status: 'empty',
    activeVersion: null,
    activeContentHash: null,
    versionCount: 0,
    versions: [],
    lastFailure: null,
    lastRollbackAt: null,
  };
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

function nextVersion(summary: KnowledgeBaseStateSummary): number {
  return summary.versions.reduce((max, version) => Math.max(max, version.version), 0) + 1;
}

function manifestsEqual(
  left: readonly SourceFileManifestEntry[],
  right: readonly SourceFileManifestEntry[],
): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const candidate = right[index];
    return candidate !== undefined &&
      candidate.relativePath === entry.relativePath &&
      candidate.size === entry.size &&
      candidate.mtimeMs === entry.mtimeMs;
  });
}

function confinedResolve(root: string, directory: string, entry: string): string {
  const target = normalize(resolve(directory, entry));
  if (!isWithinDirectory(root, target)) {
    throw new Error('Knowledge source path escaped its trusted root');
  }
  return target;
}

function toManagedRelativePath(root: string, path: string): string {
  const relativePath = relative(root, path).replace(/\\/g, '/');
  if (!relativePath || relativePath.startsWith('../') || relativePath === '..') {
    throw new Error('Knowledge source path escaped its trusted root');
  }
  return relativePath;
}

function isWithinDirectory(root: string, target: string): boolean {
  const normalizedRoot = normalize(root).toLowerCase();
  const normalizedTarget = normalize(target).toLowerCase();
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${sep}`);
}

function isIgnoredTemporaryPath(filename: KnowledgeWatchEvent['filename']): boolean {
  if (filename === null || filename === undefined) {
    return false;
  }
  return String(filename).split(/[\\/]/u).some(isIgnoredTemporaryName);
}

function isIgnoredTemporaryName(name: string): boolean {
  const baseName = basename(name);
  return baseName.startsWith('.')
    || baseName.endsWith('.tmp')
    || baseName.endsWith('.swp')
    || baseName.endsWith('.swx')
    || baseName.endsWith('~');
}

function isReservationError(error: unknown): boolean {
  return error instanceof Error && /reserved by an unresolved review transition/iu.test(error.message);
}

function sanitizeFailureReason(error: unknown, rootPath: string): string {
  const rawReason = error instanceof Error ? error.message : String(error);
  let reason = rawReason.trim() || FALLBACK_REASON;
  reason = replaceAllLiteral(reason, normalize(rootPath), '[REDACTED_PATH]');
  reason = replaceAllLiteral(reason, rootPath, '[REDACTED_PATH]');
  reason = reason
    .replace(/authorization\s*:\s*(?:basic|bearer|token)?\s*\S+/gi, 'Authorization: [REDACTED_AUTH]')
    .replace(/\bbearer\s+[a-z0-9._~+/=\-]{8,}/gi, '[REDACTED_AUTH]')
    .replace(/\b(?:api[_ -]?key|token|secret|password)\s*[:=]\s*\S+/gi, '[REDACTED_SECRET]')
    .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, '[REDACTED_SECRET]')
    .replace(/\bgh[pousr]_[a-z0-9_]{8,}\b/gi, '[REDACTED_SECRET]')
    .replace(/\bgithub_pat_[a-z0-9_]+\b/gi, '[REDACTED_SECRET]')
    .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi, '[REDACTED_SECRET]')
    .replace(/data:[^,\s;]+(?:;[^,\s;=]+(?:=[^,\s;]+)?)*;base64,[a-z0-9+/=\s-]+/gi, '[REDACTED_DATA_URL]')
    .replace(/[A-Za-z]:\\(?:[^\\\s"]+\\)*[^\\\s"]+/g, '[REDACTED_PATH]')
    .replace(/\\\\[^\\\s]+\\(?:[^\\\s"]+\\)*[^\\\s"]+/g, '[REDACTED_PATH]')
    .replace(/(?:^|\s)\/(?:Users|home|var|etc)\/[^\s"]+/g, ' [REDACTED_PATH]')
    .replace(/(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{64,}={0,2}(?![A-Za-z0-9+/=])/g, '[REDACTED_BASE64]')
    .trim();

  if (!reason || containsProtectedPublicValue(reason)) {
    return FALLBACK_REASON;
  }

  return reason.slice(0, 240);
}

function containsProtectedPublicValue(value: string): boolean {
  return /authorization\s*:/i.test(value)
    || /\bbearer\s+[a-z0-9._~+/=\-]{8,}/i.test(value)
    || /\b(?:api[_ -]?key|token|secret|password)\s*[:=]\s*\S+/i.test(value)
    || /data:[^,\s;]+(?:;[^,\s;=]+(?:=[^,\s;]+)?)*;base64,/i.test(value)
    || /[A-Za-z]:\\/.test(value)
    || /\\\\[^\\\s]+\\/.test(value)
    || /(?:^|\s)\/(?:Users|home|var|etc)\//.test(value);
}

function replaceAllLiteral(value: string, needle: string, replacement: string): string {
  if (!needle) {
    return value;
  }
  return value.split(needle).join(replacement);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}
