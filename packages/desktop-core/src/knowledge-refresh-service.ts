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

export class KnowledgeRefreshService<Timer = ReturnType<typeof setTimeout>> {
  private readonly clock: KnowledgeRefreshClock<Timer>;
  private readonly debounceMs: number;
  private readonly fileSystem: FileSystem;
  private readonly listeners = new Set<(state: KnowledgeBaseStateSummary) => void>();
  private readonly sourceDeviceId: string;
  private readonly store: ManagedKnowledgeStore;
  private readonly timers = new Map<string, PendingTimer<Timer>>();
  private readonly watchAdapter: KnowledgeWatchAdapter;
  private readonly watches = new Map<string, ActiveWatch>();
  private started = false;

  constructor(options: KnowledgeRefreshServiceOptions<Timer>) {
    this.clock = options.clock ?? createSystemClock<Timer>();
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.fileSystem = options.fileSystem ?? new NodeFileSystem();
    this.sourceDeviceId = options.sourceDeviceId ?? DEFAULT_SOURCE_DEVICE_ID;
    this.store = options.store;
    this.watchAdapter = options.watchAdapter ?? new NodeKnowledgeWatchAdapter();
  }

  async start(knowledgeBaseIds: string[]): Promise<void> {
    await this.stop();
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
    for (const pending of this.timers.values()) {
      this.clock.clearTimeout(pending.timer);
    }
    this.timers.clear();

    const handles = [...this.watches.values()].map((watch) => watch.handle);
    this.watches.clear();
    await Promise.all(handles.map(async (handle) => {
      await handle.close();
    }));
  }

  async refreshNow(knowledgeBaseId: string): Promise<KnowledgeBaseStateSummary> {
    const configuration = await this.store.readConfiguration(knowledgeBaseId);
    if (configuration === null) {
      throw new Error('Unknown knowledge base');
    }

    try {
      const candidate = createKnowledgeSnapshotCandidate({
        knowledgeBaseId: configuration.knowledgeBaseId,
        displayName: configuration.displayName,
        documents: await this.readSourceDocuments(configuration.rootPath),
      });
      const current = await this.readCurrentSummary(configuration);
      if (current.activeContentHash === candidate.contentHash) {
        return cloneSummary(current);
      }

      const snapshot: KnowledgeSnapshot = {
        ...candidate,
        version: nextVersion(current),
        publishedAt: this.clock.now().toISOString(),
        sourceDeviceId: this.sourceDeviceId,
      };
      await this.store.publish(snapshot);
      const next = await this.readCurrentSummary(configuration);
      this.emit(next);
      return cloneSummary(next);
    } catch (error) {
      const fallback = await this.store.recordRefreshFailure(
        configuration.knowledgeBaseId,
        sanitizeFailureReason(error, configuration.rootPath),
        this.clock.now().toISOString(),
      );
      this.emit(fallback);
      return cloneSummary(fallback);
    }
  }

  subscribe(listener: (state: KnowledgeBaseStateSummary) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private onWatchEvent(knowledgeBaseId: string, event: KnowledgeWatchEvent): void {
    if (!this.started || isIgnoredTemporaryPath(event.filename)) {
      return;
    }

    const pending = this.timers.get(knowledgeBaseId);
    if (pending) {
      this.clock.clearTimeout(pending.timer);
    }

    const timer = this.clock.setTimeout(async () => {
      this.timers.delete(knowledgeBaseId);
      if (this.started) {
        await this.refreshNow(knowledgeBaseId);
      }
    }, this.debounceMs);
    this.timers.set(knowledgeBaseId, { timer });
  }

  private async readSourceDocuments(rootPath: string): Promise<SourceDocument[]> {
    const root = normalize(resolve(rootPath));
    const documents: SourceDocument[] = [];
    await this.readDirectory(root, root, documents);
    return documents.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
  }

  private async readDirectory(root: string, directory: string, documents: SourceDocument[]): Promise<void> {
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
        await this.readDirectory(root, path, documents);
      } else if (stat.isFile()) {
        documents.push({
          relativePath: toManagedRelativePath(root, path),
          content: await this.fileSystem.readFile(path, 'utf8'),
        });
      }
    }
  }

  private async readCurrentSummary(
    configuration: InternalKnowledgeConfiguration,
  ): Promise<KnowledgeBaseStateSummary> {
    return (await this.store.listStates()).find((state) => (
      state.knowledgeBaseId === configuration.knowledgeBaseId
    )) ?? createEmptySummary(configuration);
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
