import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { basename, dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from 'node:path';

import {
  filterAndSortGenerationHistory,
  GENERATION_HISTORY_TRASH_RETENTION_MS,
  parseGenerationHistoryListRequest,
  parseGenerationHistoryRecord,
  type GenerationHistoryListRequest,
  type GenerationHistoryRecord,
} from '@agent-canvas/domain';

import { canonicalJson, sha256Canonical } from './canonical-json.js';
import { acquireConfinedFileLock, releaseConfinedFileLock } from './confined-file-lock.js';
import { NodeFileSystem, type FileHandleLike, type FileStatLike, type FileSystem } from './file-system.js';

const HISTORY_ROOT_MARKER = '.novus-generation-history-root.json';
const HISTORY_INDEX_FILE = 'history.index.json';
const HISTORY_LOCK_FILE = 'history.lock';
const HISTORY_INDEX_LKG_FILE = 'history.index.last-good.json';
const HISTORY_INDEX_SCHEMA_VERSION = 1;
const HISTORY_ROOT_SCHEMA_VERSION = 1;
const MAX_HISTORY_ORIGINAL_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_HISTORY_OPERATIONS = 5_000;
const MAX_HISTORY_MUTATION_BATCH = 100;
const MAX_HISTORY_AVAILABILITY_AUDIT_CONCURRENCY = 4;
const MAX_STALE_TEMP_CLEANUP = 64;
const HISTORY_LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
const HISTORY_LOCK_ACQUIRE_RETRY_MS = 10;

export type GenerationHistoryStoreErrorCode =
  | 'HISTORY_INVALID_REQUEST'
  | 'HISTORY_INVALID_ROOT'
  | 'HISTORY_CONFINEMENT_VIOLATION'
  | 'HISTORY_DISK_FULL'
  | 'HISTORY_PERMISSION_DENIED'
  | 'HISTORY_WRITE_FAILED'
  | 'HISTORY_INDEX_CORRUPT'
  | 'HISTORY_ASSET_CORRUPT'
  | 'HISTORY_LOCK_TIMEOUT';

export interface GenerationHistoryStoreError extends Error {
  readonly code: GenerationHistoryStoreErrorCode;
  readonly retryable: boolean;
}

export interface GenerationHistoryStoreOptions {
  readonly fileSystem?: FileSystem;
  readonly forbiddenRoots?: readonly string[];
  readonly historyRoot: string;
  readonly hashFile?: (path: string) => Promise<string>;
  readonly isNetworkPath?: (path: string) => boolean | Promise<boolean>;
  readonly now?: () => number;
  readonly ownedRoot: string;
}

export interface IngestGenerationHistoryInput {
  readonly operationId: string;
  readonly record: GenerationHistoryRecord;
  readonly source: AsyncIterable<Uint8Array> | NodeJS.ReadableStream;
}

export interface GenerationHistoryListResult {
  readonly nextCursor: string | null;
  readonly records: readonly GenerationHistoryRecord[];
  readonly revision: number;
  readonly total: number;
}

export interface GenerationHistoryMutationResult {
  readonly records: readonly GenerationHistoryRecord[];
  readonly revision: number;
}

export interface GenerationHistoryCapacity {
  readonly activeBytes: number;
  readonly activeCount: number;
  readonly missingOrCorruptCount: number;
  readonly trashBytes: number;
  readonly trashCount: number;
}

export interface GenerationHistoryPurgeResult {
  readonly protectedIds: readonly string[];
  readonly purgedIds: readonly string[];
  readonly revision: number;
}

export interface GenerationHistoryProjectReferenceInput {
  readonly referenceId: string;
  readonly projectId: string;
  readonly projectDisplayLabel: string;
  readonly independentProjectAssetId?: string;
}

export interface GenerationHistoryAvailableAsset {
  readonly record: GenerationHistoryRecord;
  readonly source: NodeJS.ReadableStream;
}

interface HistoryOperationReceipt {
  readonly kind:
    | 'ingest'
    | 'metadata'
    | 'favorite'
    | 'trash'
    | 'restore'
    | 'add_reference'
    | 'remove_reference'
    | 'permanent_delete'
    | 'purge';
  readonly operationId: string;
  readonly protectedIds: readonly string[];
  readonly recordIds: readonly string[];
  readonly requestSha256: string;
}

interface HistoryIndexPayload {
  readonly schemaVersion: typeof HISTORY_INDEX_SCHEMA_VERSION;
  readonly revision: number;
  readonly records: readonly GenerationHistoryRecord[];
  readonly operations: readonly HistoryOperationReceipt[];
}

interface HistoryIndexEnvelope extends HistoryIndexPayload {
  readonly payloadSha256: string;
}

interface HistoryRootIdentity {
  readonly historyRoot: string;
  readonly ownedRoot: string;
}

interface HistoryAssetMove {
  readonly destination: string;
  readonly source: string;
}

interface HistoryCursorPayload {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly sort: 'newest' | 'oldest';
  readonly filterSha256: string;
  readonly createdAt: string;
  readonly recordId: string;
}

export class GenerationHistoryStore {
  private readonly fileSystem: FileSystem;
  private readonly forbiddenRoots: readonly string[];
  private readonly historyRoot: string;
  private readonly hashFile: (path: string) => Promise<string>;
  private readonly isNetworkPath: (path: string) => boolean | Promise<boolean>;
  private readonly now: () => number;
  private readonly ownedRoot: string;
  private operationTail: Promise<void> = Promise.resolve();
  private rootIdentity: HistoryRootIdentity | null = null;

  constructor(options: GenerationHistoryStoreOptions) {
    this.fileSystem = options.fileSystem ?? new NodeFileSystem();
    this.historyRoot = resolve(options.historyRoot);
    this.hashFile = options.hashFile ?? sha256File;
    this.ownedRoot = resolve(options.ownedRoot);
    this.forbiddenRoots = (options.forbiddenRoots ?? []).map((root) => resolve(root));
    this.isNetworkPath = options.isNetworkPath ?? defaultIsNetworkPath;
    this.now = options.now ?? Date.now;
    this.assertLexicalRootConfiguration();
  }

  async ingest(input: IngestGenerationHistoryInput): Promise<GenerationHistoryRecord> {
    const operationId = parseOpaqueOperationId(input.operationId);
    const record = parseGenerationHistoryRecord(input.record);
    const output = record.output;
    if (record.status !== 'succeeded' || output === null || output.availability !== 'available') {
      throw historyError('HISTORY_INVALID_REQUEST', false, 'History ingestion requires an available succeeded record');
    }

    return this.withLockedIndex(async (current, currentRaw) => {
      const receipt = current.operations.find((operation) => operation.operationId === operationId);
      const requestSha256 = sha256Canonical({
        kind: 'ingest',
        record,
      });
      if (receipt !== undefined) {
        assertMatchingReceipt(receipt, 'ingest', requestSha256);
        const existing = current.records.find((candidate) => candidate.id === receipt.recordIds[0]);
        if (existing === undefined) {
          throw historyError('HISTORY_INVALID_REQUEST', false, 'Completed history ingestion is no longer available');
        }
        return existing;
      }
      const priorRecord = current.records.find((candidate) => candidate.id === record.id);
      if (priorRecord !== undefined && isTerminalHistoryStatus(priorRecord.status)) {
        return priorRecord;
      }
      if (priorRecord !== undefined && (
        priorRecord.output !== null
        || (priorRecord.status !== 'queued' && priorRecord.status !== 'running')
        || priorRecord.createdAt !== record.createdAt
        || priorRecord.job.jobId !== record.job.jobId
      )) {
        throw historyError('HISTORY_INVALID_REQUEST', false, 'History record id is already in use');
      }
      if (current.records.some((candidate) => (
        candidate.id !== record.id && candidate.output?.historyAssetId === output.historyAssetId
      ))) {
        throw historyError('HISTORY_INVALID_REQUEST', false, 'History asset id is already in use');
      }
      const storedRecord = priorRecord === undefined ? record : parseGenerationHistoryRecord({
        ...record,
        favorite: priorRecord.favorite,
        tags: priorRecord.tags,
        projectReferenceCount: priorRecord.projectReferenceCount,
        projectReferences: priorRecord.projectReferences,
        trash: priorRecord.trash,
      });

      const originalsRoot = join(this.historyRoot, 'originals');
      const finalPath = join(originalsRoot, `${output.historyAssetId}.${output.format}`);
      const tempPath = join(
        originalsRoot,
        `.history-ingest-${createHash('sha256').update(operationId).digest('hex').slice(0, 16)}-${randomBytes(6).toString('hex')}.tmp`,
      );
      let finalCreated = false;
      let tempCreated = false;
      let handle: FileHandleLike | null = null;
      let closed = false;
      try {
        await this.assertConfinedPathForWrite(tempPath);
        handle = await this.fileSystem.open(tempPath, 'wx');
        tempCreated = true;
        const hash = createHash('sha256');
        let byteSize = 0;
        for await (const rawChunk of input.source as AsyncIterable<Uint8Array>) {
          const chunk = Buffer.from(rawChunk);
          byteSize += chunk.byteLength;
          if (byteSize > MAX_HISTORY_ORIGINAL_BYTES || byteSize > output.byteSize) {
            throw historyError('HISTORY_ASSET_CORRUPT', false, 'History original size does not match safe metadata');
          }
          hash.update(chunk);
          if (handle.write !== undefined) {
            await handle.write(chunk);
          } else {
            await handle.writeFile(chunk);
          }
        }
        await handle.sync();
        await handle.close();
        closed = true;
        if (byteSize !== output.byteSize || hash.digest('hex') !== output.sha256) {
          throw historyError('HISTORY_ASSET_CORRUPT', false, 'History original checksum does not match safe metadata');
        }

        const existing = await this.inspectOriginal(finalPath, output.sha256, output.byteSize);
        if (existing === 'missing') {
          await this.assertConfinedPathForWrite(tempPath);
          await this.assertConfinedPathForWrite(finalPath);
          await this.fileSystem.rename(tempPath, finalPath);
          finalCreated = true;
          tempCreated = false;
          const verified = await this.inspectOriginal(finalPath, output.sha256, output.byteSize);
          if (verified !== 'valid') {
            throw historyError('HISTORY_ASSET_CORRUPT', false, 'History original failed integrity verification');
          }
        } else if (existing === 'valid') {
          await this.removeConfinedFile(tempPath);
          tempCreated = false;
        } else {
          throw historyError('HISTORY_ASSET_CORRUPT', false, 'History asset identity conflicts with existing content');
        }

        const next: HistoryIndexPayload = {
          schemaVersion: HISTORY_INDEX_SCHEMA_VERSION,
          revision: current.revision + 1,
          records: priorRecord === undefined
            ? [...current.records, storedRecord]
            : replaceRecord(current.records, storedRecord),
          operations: trimOperations([
            ...current.operations,
            { kind: 'ingest', operationId, protectedIds: [], recordIds: [record.id], requestSha256 },
          ]),
        };
        await this.writeIndexUnlocked(next, currentRaw);
        return storedRecord;
      } catch (error) {
        if (handle !== null && !closed) {
          try {
            await handle.close();
          } catch {
            // Preserve the primary sanitized history failure.
          }
        }
        if (tempCreated) await this.removeConfinedFile(tempPath);
        if (finalCreated) await this.removeConfinedFile(finalPath);
        throw normalizeHistoryError(error, 'History ingestion failed');
      }
    });
  }

  async upsertMetadata(input: {
    readonly operationId: string;
    readonly record: GenerationHistoryRecord;
  }): Promise<GenerationHistoryRecord> {
    const operationId = parseOpaqueOperationId(input.operationId);
    const requested = parseGenerationHistoryRecord(input.record);
    if (requested.status === 'succeeded' || requested.output !== null) {
      throw historyError('HISTORY_INVALID_REQUEST', false, 'History metadata update cannot contain an original');
    }
    const requestSha256 = sha256Canonical({ kind: 'metadata', record: requested });
    return this.withLockedIndex(async (current, currentRaw) => {
      const prior = findMatchingReceipt(current, operationId, 'metadata', requestSha256);
      if (prior !== null) {
        const existing = current.records.find((record) => record.id === prior.recordIds[0]);
        if (existing === undefined) {
          throw historyError('HISTORY_INVALID_REQUEST', false, 'Completed history metadata update is unavailable');
        }
        return existing;
      }
      const existing = current.records.find((record) => record.id === requested.id);
      if (existing !== undefined) {
        if (isTerminalHistoryStatus(existing.status) && isTerminalHistoryStatus(requested.status)) {
          return existing;
        }
        if (
          existing.createdAt !== requested.createdAt
          || existing.job.jobId !== requested.job.jobId
          || !isMetadataTransitionAllowed(existing.status, requested.status)
        ) {
          throw historyError('HISTORY_INVALID_REQUEST', false, 'History metadata transition is invalid');
        }
      }
      const stored = existing === undefined ? requested : parseGenerationHistoryRecord({
        ...requested,
        favorite: existing.favorite,
        tags: existing.tags,
        projectReferenceCount: existing.projectReferenceCount,
        projectReferences: existing.projectReferences,
        trash: existing.trash,
      });
      const records = existing === undefined
        ? [...current.records, stored]
        : replaceRecord(current.records, stored);
      const next = nextIndex(current, records, {
        kind: 'metadata', operationId, protectedIds: [], recordIds: [stored.id], requestSha256,
      });
      await this.writeIndexUnlocked(next, currentRaw);
      return stored;
    });
  }

  async list(request: unknown): Promise<GenerationHistoryListResult> {
    let parsedRequest: GenerationHistoryListRequest;
    try {
      parsedRequest = parseGenerationHistoryListRequest(request);
    } catch {
      throw historyError('HISTORY_INVALID_REQUEST', false, 'Generation history query is invalid');
    }
    return this.withLockedIndex(async (current, currentRaw) => {
      const sorted = filterAndSortGenerationHistory(current.records, parsedRequest);
      let startIndex = 0;
      if (parsedRequest.cursor !== undefined) {
        const cursor = parseHistoryCursor(parsedRequest.cursor);
        if (
          cursor.revision !== current.revision
          || cursor.sort !== parsedRequest.sort
          || cursor.filterSha256 !== historyFilterSha256(parsedRequest)
        ) {
          throw historyError('HISTORY_INVALID_REQUEST', false, 'Generation history cursor is stale or mismatched');
        }
        const cursorIndex = sorted.findIndex((record) => (
          record.id === cursor.recordId && record.createdAt === cursor.createdAt
        ));
        if (cursorIndex < 0) {
          throw historyError('HISTORY_INVALID_REQUEST', false, 'Generation history cursor target is unavailable');
        }
        startIndex = cursorIndex + 1;
      }
      const selectedPage = sorted.slice(startIndex, startIndex + parsedRequest.pageSize);
      const refreshed = await this.refreshAvailabilityForIdsUnlocked(
        current,
        currentRaw,
        selectedPage.map((record) => record.id),
      );
      const pageRecords = selectedPage.map((record) => (
        refreshed.records.find((candidate) => candidate.id === record.id) ?? record
      ));
      const hasNextPage = startIndex + selectedPage.length < sorted.length;
      const lastRecord = pageRecords[pageRecords.length - 1];
      return Object.freeze({
        nextCursor: hasNextPage && lastRecord !== undefined
          ? createHistoryCursor({
            schemaVersion: 1,
            revision: refreshed.revision,
            sort: parsedRequest.sort,
            filterSha256: historyFilterSha256(parsedRequest),
            createdAt: lastRecord.createdAt,
            recordId: lastRecord.id,
          })
          : null,
        records: Object.freeze(pageRecords),
        revision: refreshed.revision,
        total: sorted.length,
      });
    });
  }

  async setFavorite(input: {
    readonly favorite: boolean;
    readonly historyIds: readonly string[];
    readonly operationId: string;
  }): Promise<GenerationHistoryMutationResult> {
    const operationId = parseOpaqueOperationId(input.operationId);
    const historyIds = parseHistoryIdSet(input.historyIds);
    if (typeof input.favorite !== 'boolean') {
      throw historyError('HISTORY_INVALID_REQUEST', false, 'History favorite value is invalid');
    }
    const requestSha256 = sha256Canonical({ kind: 'favorite', historyIds, favorite: input.favorite });
    return this.withLockedIndex(async (current, currentRaw) => {
      const prior = findMatchingReceipt(current, operationId, 'favorite', requestSha256);
      if (prior !== null) return mutationResult(current, prior.recordIds);
      requireHistoryRecords(current, historyIds);
      const records = current.records.map((record) => historyIds.includes(record.id)
        ? parseGenerationHistoryRecord({
          ...record,
          favorite: input.favorite,
          updatedAt: mutationTimestamp(this.now(), record.updatedAt),
        })
        : record);
      const next = nextIndex(current, records, {
        kind: 'favorite', operationId, protectedIds: [], recordIds: historyIds, requestSha256,
      });
      await this.writeIndexUnlocked(next, currentRaw);
      return mutationResult(next, historyIds);
    });
  }

  async softDelete(input: {
    readonly historyIds: readonly string[];
    readonly operationId: string;
  }): Promise<GenerationHistoryMutationResult> {
    return this.mutateTrashState(input, true);
  }

  async restore(input: {
    readonly historyIds: readonly string[];
    readonly operationId: string;
  }): Promise<GenerationHistoryMutationResult> {
    return this.mutateTrashState(input, false);
  }

  async addProjectReferences(input: {
    readonly historyId: string;
    readonly operationId: string;
    readonly references: readonly GenerationHistoryProjectReferenceInput[];
  }): Promise<GenerationHistoryMutationResult> {
    const operationId = parseOpaqueOperationId(input.operationId);
    const historyId = parseOpaqueId(input.historyId, 'History record identity is invalid');
    if (!Array.isArray(input.references) || input.references.length < 1 || input.references.length > 50) {
      throw historyError('HISTORY_INVALID_REQUEST', false, 'History project references are invalid');
    }
    const references = input.references.map((reference) => ({ ...reference }));
    const requestSha256 = sha256Canonical({ kind: 'add_reference', historyId, references });
    return this.withLockedIndex(async (current, currentRaw) => {
      const prior = findMatchingReceipt(current, operationId, 'add_reference', requestSha256);
      if (prior !== null) return mutationResult(current, prior.recordIds);
      const record = requireHistoryRecords(current, [historyId])[0]!;
      const nextReferences = [...record.projectReferences];
      for (const reference of references) {
        const existing = nextReferences.find((candidate) => candidate.referenceId === reference.referenceId);
        if (existing !== undefined) {
          if (canonicalJson(existing) !== canonicalJson(reference)) {
            throw historyError('HISTORY_INVALID_REQUEST', false, 'History project reference identity conflicts');
          }
          continue;
        }
        nextReferences.push(reference);
      }
      const updated = parseGenerationHistoryRecord({
        ...record,
        projectReferenceCount: nextReferences.length,
        projectReferences: nextReferences,
        updatedAt: mutationTimestamp(this.now(), record.updatedAt),
      });
      const records = replaceRecord(current.records, updated);
      const next = nextIndex(current, records, {
        kind: 'add_reference', operationId, protectedIds: [], recordIds: [historyId], requestSha256,
      });
      await this.writeIndexUnlocked(next, currentRaw);
      return mutationResult(next, [historyId]);
    });
  }

  async removeProjectReferences(input: {
    readonly historyId: string;
    readonly operationId: string;
    readonly referenceIds: readonly string[];
  }): Promise<GenerationHistoryMutationResult> {
    const operationId = parseOpaqueOperationId(input.operationId);
    const historyId = parseOpaqueId(input.historyId, 'History record identity is invalid');
    const referenceIds = parseHistoryIdSet(input.referenceIds, 50);
    const requestSha256 = sha256Canonical({ kind: 'remove_reference', historyId, referenceIds });
    return this.withLockedIndex(async (current, currentRaw) => {
      const prior = findMatchingReceipt(current, operationId, 'remove_reference', requestSha256);
      if (prior !== null) return mutationResult(current, prior.recordIds);
      const record = requireHistoryRecords(current, [historyId])[0]!;
      const projectReferences = record.projectReferences.filter((reference) => !referenceIds.includes(reference.referenceId));
      const updated = parseGenerationHistoryRecord({
        ...record,
        projectReferenceCount: projectReferences.length,
        projectReferences,
        updatedAt: mutationTimestamp(this.now(), record.updatedAt),
      });
      const next = nextIndex(current, replaceRecord(current.records, updated), {
        kind: 'remove_reference', operationId, protectedIds: [], recordIds: [historyId], requestSha256,
      });
      await this.writeIndexUnlocked(next, currentRaw);
      return mutationResult(next, [historyId]);
    });
  }

  async permanentlyDelete(input: {
    readonly historyIds: readonly string[];
    readonly operationId: string;
  }): Promise<GenerationHistoryPurgeResult> {
    const operationId = parseOpaqueOperationId(input.operationId);
    const historyIds = parseHistoryIdSet(input.historyIds);
    return this.deleteRecords(operationId, historyIds, 'permanent_delete', false);
  }

  async purgeExpired(input: { readonly operationId: string }): Promise<GenerationHistoryPurgeResult> {
    const operationId = parseOpaqueOperationId(input.operationId);
    return this.deleteRecords(operationId, [], 'purge', true);
  }

  async getCapacity(): Promise<GenerationHistoryCapacity> {
    for (;;) {
      const snapshot = await this.withLockedIndex(async (current) => ({
        revision: current.revision,
        records: [...current.records],
      }));
      const audited = await this.auditAvailabilityOutsideLock(snapshot.records);
      const committed = await this.withLockedIndex(async (current, currentRaw) => {
        if (current.revision !== snapshot.revision) return null;
        let changed = false;
        const records = current.records.map((record) => {
          if (record.output === null) return record;
          const availability = audited.get(record.id);
          if (availability === undefined || availability === record.output.availability) return record;
          changed = true;
          return parseGenerationHistoryRecord({
            ...record,
            output: { ...record.output, availability },
            updatedAt: mutationTimestamp(this.now(), record.updatedAt),
          });
        });
        if (!changed) return capacityFromRecords(records);
        const next: HistoryIndexPayload = {
          ...current,
          revision: current.revision + 1,
          records,
        };
        await this.writeIndexUnlocked(next, currentRaw);
        return capacityFromRecords(next.records);
      });
      if (committed !== null) return committed;
    }
  }

  async getRecords(historyIds: readonly string[]): Promise<readonly GenerationHistoryRecord[]> {
    const ids = parseHistoryIdBatch(historyIds);
    return this.withLockedIndex(async (current, currentRaw) => {
      requireHistoryRecords(current, ids);
      const refreshed = await this.refreshAvailabilityForIdsUnlocked(current, currentRaw, ids);
      return Object.freeze([...requireHistoryRecords(refreshed, ids)]);
    });
  }

  async withAvailableAsset<T>(
    historyId: string,
    consumer: (asset: GenerationHistoryAvailableAsset) => Promise<T>,
  ): Promise<T> {
    const id = parseOpaqueId(historyId, 'History record identity is invalid');
    if (typeof consumer !== 'function') {
      throw historyError('HISTORY_INVALID_REQUEST', false, 'History asset consumer is invalid');
    }
    return this.withLockedIndex(async (current, currentRaw) => {
      requireHistoryRecords(current, [id]);
      const refreshed = await this.refreshAvailabilityForIdsUnlocked(current, currentRaw, [id]);
      const record = requireHistoryRecords(refreshed, [id])[0]!;
      if (record.output === null || record.output.availability !== 'available') {
        throw historyError('HISTORY_ASSET_CORRUPT', false, 'History original is unavailable');
      }
      const path = this.recordAssetPath(record);
      if (await this.inspectOriginal(path, record.output.sha256, record.output.byteSize) !== 'valid') {
        throw historyError('HISTORY_ASSET_CORRUPT', false, 'History original is unavailable');
      }
      const source = createReadStream(path);
      try {
        return await consumer({ record, source });
      } finally {
        source.destroy();
      }
    });
  }

  async assertSeparatedLocation(path: string): Promise<void> {
    if (typeof path !== 'string' || !isAbsolute(path) || pathsIntersect(this.historyRoot, resolve(path))) {
      throw historyError('HISTORY_INVALID_REQUEST', false, 'History external location conflicts with the owned root');
    }
    await this.ensureRoot();
    const stats = await this.requireLstat(path).catch((error) => {
      throw normalizeHistoryError(error, 'History external location is unavailable');
    });
    if (!stats.isDirectory() || isLinkOrReparse(stats)) {
      throw historyError('HISTORY_INVALID_REQUEST', false, 'History external location is invalid');
    }
    const realExternal = await this.requireRealpath(path);
    const identity = await this.captureRootIdentity();
    if (pathsIntersect(identity.historyRoot, realExternal)) {
      throw historyError('HISTORY_INVALID_REQUEST', false, 'History external location conflicts with the owned root');
    }
  }

  private async mutateTrashState(
    input: { readonly historyIds: readonly string[]; readonly operationId: string },
    trashed: boolean,
  ): Promise<GenerationHistoryMutationResult> {
    const operationId = parseOpaqueOperationId(input.operationId);
    const historyIds = parseHistoryIdSet(input.historyIds);
    const kind = trashed ? 'trash' as const : 'restore' as const;
    const requestSha256 = sha256Canonical({ kind, historyIds });
    return this.withLockedIndex(async (current, currentRaw) => {
      const prior = findMatchingReceipt(current, operationId, kind, requestSha256);
      if (prior !== null) return mutationResult(current, prior.recordIds);
      const selected = requireHistoryRecords(current, historyIds);
      const moves: HistoryAssetMove[] = [];
      try {
        for (const record of selected) {
          if ((record.trash !== null) === trashed || record.output === null || record.output.availability !== 'available') continue;
          const move = await this.moveRecordAsset(record, trashed);
          if (move !== null) moves.push(move);
        }
        const now = this.now();
        const records = current.records.map((record) => {
          if (!historyIds.includes(record.id) || (record.trash !== null) === trashed) return record;
          return parseGenerationHistoryRecord({
            ...record,
            trash: trashed ? {
              deletedAt: new Date(now).toISOString(),
              retentionDeadline: new Date(now + GENERATION_HISTORY_TRASH_RETENTION_MS).toISOString(),
            } : null,
            updatedAt: mutationTimestamp(now, record.updatedAt),
          });
        });
        const next = nextIndex(current, records, {
          kind, operationId, protectedIds: [], recordIds: historyIds, requestSha256,
        });
        await this.writeIndexUnlocked(next, currentRaw);
        return mutationResult(next, historyIds);
      } catch (error) {
        await this.rollbackMoves(moves);
        throw normalizeHistoryError(error, 'Generation history lifecycle update failed');
      }
    });
  }

  private async deleteRecords(
    operationId: string,
    requestedIds: readonly string[],
    kind: 'permanent_delete' | 'purge',
    expiredOnly: boolean,
  ): Promise<GenerationHistoryPurgeResult> {
    const requestSha256 = expiredOnly
      ? sha256Canonical({ kind: 'purge' })
      : sha256Canonical({ kind: 'permanent_delete', historyIds: requestedIds });
    return this.withLockedIndex(async (current, currentRaw) => {
      const prior = findMatchingReceipt(current, operationId, kind, requestSha256);
      if (prior !== null) {
        return Object.freeze({
          protectedIds: prior.protectedIds,
          purgedIds: prior.recordIds,
          revision: current.revision,
        });
      }
      const candidates = expiredOnly
        ? current.records.filter((record) => record.trash !== null
          && Date.parse(record.trash.retentionDeadline) <= this.now())
          .sort((left, right) => Number(hasBlockingProjectReference(left)) - Number(hasBlockingProjectReference(right))
            || left.id.localeCompare(right.id))
          .slice(0, MAX_HISTORY_MUTATION_BATCH)
        : requireHistoryRecords(current, requestedIds);
      const protectedIds = candidates.filter(hasBlockingProjectReference).map((record) => record.id);
      if (!expiredOnly && protectedIds.length > 0) {
        throw historyError('HISTORY_INVALID_REQUEST', false, 'Referenced history cannot be permanently deleted');
      }
      const deletable = candidates.filter((record) => !protectedIds.includes(record.id));
      const stagedMoves: HistoryAssetMove[] = [];
      try {
        for (const record of deletable) {
          const staged = await this.stageRecordForDeletion(record);
          if (staged !== null) stagedMoves.push(staged);
        }
        const purgedIds = deletable.map((record) => record.id);
        const next = nextIndex(
          current,
          current.records.filter((record) => !purgedIds.includes(record.id)),
          { kind, operationId, protectedIds, recordIds: purgedIds, requestSha256 },
        );
        await this.writeIndexUnlocked(next, currentRaw);
        for (const move of stagedMoves) await this.removeConfinedFile(move.destination);
        return Object.freeze({ protectedIds, purgedIds, revision: next.revision });
      } catch (error) {
        await this.rollbackMoves(stagedMoves);
        throw normalizeHistoryError(error, 'Generation history deletion failed');
      }
    });
  }

  private async refreshAvailabilityForIdsUnlocked(
    current: HistoryIndexPayload,
    currentRaw: string,
    historyIds: readonly string[],
  ): Promise<HistoryIndexPayload> {
    if (historyIds.length === 0) return current;
    const selected = new Set(historyIds);
    let changed = false;
    const records: GenerationHistoryRecord[] = [];
    for (const record of current.records) {
      if (record.output === null || !selected.has(record.id)) {
        records.push(record);
        continue;
      }
      const state = await this.inspectOriginal(
        this.recordAssetPath(record),
        record.output.sha256,
        record.output.byteSize,
      );
      const availability = state === 'valid' ? 'available' : state;
      if (availability === record.output.availability) {
        records.push(record);
        continue;
      }
      changed = true;
      records.push(parseGenerationHistoryRecord({
        ...record,
        output: { ...record.output, availability },
        updatedAt: mutationTimestamp(this.now(), record.updatedAt),
      }));
    }
    if (!changed) return current;
    const next: HistoryIndexPayload = {
      ...current,
      revision: current.revision + 1,
      records,
    };
    await this.writeIndexUnlocked(next, currentRaw);
    return next;
  }

  private async auditAvailabilityOutsideLock(
    records: readonly GenerationHistoryRecord[],
  ): Promise<Map<string, 'available' | 'missing' | 'corrupt'>> {
    const candidates = records.filter((record) => record.output !== null);
    const audited = new Map<string, 'available' | 'missing' | 'corrupt'>();
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(MAX_HISTORY_AVAILABILITY_AUDIT_CONCURRENCY, candidates.length) },
      async () => {
        for (;;) {
          const index = nextIndex;
          nextIndex += 1;
          const record = candidates[index];
          if (record === undefined || record.output === null) return;
          const state = await this.inspectOriginal(
            this.recordAssetPath(record),
            record.output.sha256,
            record.output.byteSize,
          );
          audited.set(record.id, state === 'valid' ? 'available' : state);
        }
      },
    );
    await Promise.all(workers);
    return audited;
  }

  private async moveRecordAsset(record: GenerationHistoryRecord, toTrash: boolean): Promise<HistoryAssetMove | null> {
    if (record.output === null) return null;
    const fileName = `${record.output.historyAssetId}.${record.output.format}`;
    const source = join(this.historyRoot, toTrash ? 'originals' : 'trash', fileName);
    const destination = join(this.historyRoot, toTrash ? 'trash' : 'originals', fileName);
    const destinationState = await this.inspectOriginal(destination, record.output.sha256, record.output.byteSize);
    const sourceState = await this.inspectOriginal(source, record.output.sha256, record.output.byteSize);
    if (destinationState === 'valid' && sourceState === 'missing') return null;
    if (destinationState !== 'missing' || sourceState !== 'valid') {
      throw historyError('HISTORY_ASSET_CORRUPT', false, 'History original cannot cross the trash boundary safely');
    }
    try {
      await this.assertConfinedPathForWrite(source);
      await this.assertConfinedPathForWrite(destination);
      await this.fileSystem.rename(source, destination);
    } catch (error) {
      const afterDestination = await this.inspectOriginal(destination, record.output.sha256, record.output.byteSize);
      const afterSource = await this.inspectOriginal(source, record.output.sha256, record.output.byteSize);
      if (afterDestination !== 'valid' || afterSource !== 'missing') throw error;
    }
    return { source, destination };
  }

  private async stageRecordForDeletion(record: GenerationHistoryRecord): Promise<HistoryAssetMove | null> {
    if (record.output === null) return null;
    const source = this.recordAssetPath(record);
    let sourceStats: FileStatLike;
    try {
      await this.assertConfinedPathForRead(source);
      sourceStats = await this.requireLstat(source);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return null;
      throw error;
    }
    if (!isRegularFile(sourceStats)) {
      throw historyError('HISTORY_ASSET_CORRUPT', false, 'History original is not a confined regular file');
    }
    const destination = join(
      this.historyRoot,
      'recovery',
      `.history-purge-${record.output.historyAssetId}-${randomBytes(6).toString('hex')}.tmp`,
    );
    await this.assertConfinedPathForWrite(source);
    await this.assertConfinedPathForWrite(destination);
    await this.fileSystem.rename(source, destination);
    return { source, destination };
  }

  private recordAssetPath(record: GenerationHistoryRecord): string {
    if (record.output === null) {
      throw historyError('HISTORY_INVALID_REQUEST', false, 'History record has no managed original');
    }
    return join(
      this.historyRoot,
      record.trash === null ? 'originals' : 'trash',
      `${record.output.historyAssetId}.${record.output.format}`,
    );
  }

  private async rollbackMoves(moves: readonly HistoryAssetMove[]): Promise<void> {
    for (const move of [...moves].reverse()) {
      try {
        await this.assertConfinedPathForRead(move.destination);
        await this.assertConfinedPathForWrite(move.source);
        await this.fileSystem.rename(move.destination, move.source);
      } catch {
        // Preserve LKG/index evidence when a filesystem rollback is interrupted.
      }
    }
  }

  private async withLockedIndex<T>(
    operation: (index: HistoryIndexPayload, raw: string) => Promise<T>,
  ): Promise<T> {
    return this.enqueue(async () => {
      await this.ensureRoot();
      const lockPath = join(this.historyRoot, HISTORY_LOCK_FILE);
      let lock;
      try {
        lock = await this.acquireHistoryLock(lockPath);
      } catch (error) {
        if (error instanceof Error && /timed out/iu.test(error.message)) {
          throw historyError('HISTORY_LOCK_TIMEOUT', true, 'Generation history is busy');
        }
        throw normalizeHistoryError(error, 'Generation history lock failed');
      }
      try {
        await this.cleanupOwnedTemps();
        const index = await this.readOrCreateIndexUnlocked();
        await this.reconcileDeletionStages(index.payload);
        return await operation(index.payload, index.raw);
      } finally {
        await releaseConfinedFileLock(lock);
      }
    });
  }

  private async acquireHistoryLock(lockPath: string): Promise<Awaited<ReturnType<typeof acquireConfinedFileLock>>> {
    const startedAt = performance.now();
    for (;;) {
      try {
        return await acquireConfinedFileLock(lockPath, {
          fileSystem: this.fileSystem,
          assertPathForRead: (path) => this.assertConfinedPathForRead(path),
          assertPathForWrite: (path) => this.assertConfinedPathForWrite(path),
          timeoutMs: HISTORY_LOCK_ACQUIRE_TIMEOUT_MS,
          timeoutMessage: 'Timed out waiting for generation history lock',
        });
      } catch (error) {
        if (isHistoryError(error)) throw error;
        if (error instanceof Error && /timed out/iu.test(error.message)) {
          throw error;
        }
        if (performance.now() - startedAt >= HISTORY_LOCK_ACQUIRE_TIMEOUT_MS) throw error;
        await delay(HISTORY_LOCK_ACQUIRE_RETRY_MS);
      }
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async ensureRoot(): Promise<HistoryRootIdentity> {
    if (await this.isNetworkPath(this.ownedRoot) || await this.isNetworkPath(this.historyRoot)) {
      throw historyError('HISTORY_INVALID_ROOT', false, 'Generation history requires a local owned root');
    }
    await this.assertRegularDirectory(this.ownedRoot, 'Generation history owned root is invalid');
    let historyRootExisted = true;
    try {
      await this.fileSystem.mkdir(this.historyRoot);
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw normalizeHistoryError(error, 'Generation history root is unavailable');
    }
    try {
      await this.requireLstat(this.historyRoot);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
      historyRootExisted = false;
      await this.fileSystem.mkdir(this.historyRoot);
    }
    await this.assertRegularDirectory(this.historyRoot, 'Generation history root is invalid');
    const identity = await this.captureRootIdentity();

    const markerPath = join(this.historyRoot, HISTORY_ROOT_MARKER);
    if (historyRootExisted && !await this.pathExists(markerPath)) {
      const entries = await this.fileSystem.readdir(this.historyRoot);
      if (entries.length > 0) {
        throw historyError('HISTORY_INVALID_ROOT', false, 'Generation history root is not application-owned');
      }
    }
    await this.ensureRootMarker();

    for (const directoryName of ['originals', 'trash', 'recovery'] as const) {
      const directoryPath = join(this.historyRoot, directoryName);
      try {
        await this.fileSystem.mkdir(directoryPath);
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw normalizeHistoryError(error, 'Generation history layout is unavailable');
      }
      await this.assertRegularDirectory(directoryPath, 'Generation history directory is invalid');
      await this.assertConfinedPathForRead(directoryPath);
    }
    return identity;
  }

  private async ensureRootMarker(): Promise<void> {
    const markerPath = join(this.historyRoot, HISTORY_ROOT_MARKER);
    const marker = `${canonicalJson({ kind: 'novus-generation-history', schemaVersion: HISTORY_ROOT_SCHEMA_VERSION })}\n`;
    let handle: FileHandleLike | null = null;
    try {
      await this.assertConfinedPathForWrite(markerPath);
      handle = await this.fileSystem.open(markerPath, 'wx');
      await handle.writeFile(marker);
      await handle.sync();
      await handle.close();
      handle = null;
    } catch (error) {
      if (handle !== null) {
        try { await handle.close(); } catch { /* Preserve marker error. */ }
      }
      if (!isErrno(error, 'EEXIST')) throw normalizeHistoryError(error, 'Generation history marker is unavailable');
      await this.assertConfinedPathForRead(markerPath);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await this.fileSystem.readFile(markerPath, 'utf8')) as unknown;
      } catch {
        throw historyError('HISTORY_INVALID_ROOT', false, 'Generation history marker is invalid');
      }
      if (!isExactRecord(parsed, ['kind', 'schemaVersion'])
        || parsed.kind !== 'novus-generation-history'
        || parsed.schemaVersion !== HISTORY_ROOT_SCHEMA_VERSION) {
        throw historyError('HISTORY_INVALID_ROOT', false, 'Generation history marker is invalid');
      }
    }
  }

  private async readOrCreateIndexUnlocked(): Promise<{ payload: HistoryIndexPayload; raw: string }> {
    const indexPath = join(this.historyRoot, HISTORY_INDEX_FILE);
    try {
      await this.assertConfinedPathForRead(indexPath);
      const raw = await this.fileSystem.readFile(indexPath, 'utf8');
      return { payload: parseHistoryIndex(raw), raw };
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) {
        if (isHistoryError(error)) throw error;
        throw historyError('HISTORY_INDEX_CORRUPT', false, 'Generation history index is corrupt');
      }
      const lkgPath = join(this.historyRoot, 'recovery', HISTORY_INDEX_LKG_FILE);
      const recoveredRaw = await this.readOptionalFile(lkgPath);
      if (recoveredRaw !== null) {
        const recovered = parseHistoryIndex(recoveredRaw);
        await this.writeAtomicConfined(indexPath, recoveredRaw);
        return { payload: recovered, raw: recoveredRaw };
      }
      if (!await this.isPristineIndexlessRoot()) {
        throw historyError('HISTORY_INDEX_CORRUPT', false, 'Generation history index is missing');
      }
      const empty: HistoryIndexPayload = {
        schemaVersion: HISTORY_INDEX_SCHEMA_VERSION,
        revision: 0,
        records: [],
        operations: [],
      };
      await this.writeIndexUnlocked(empty, null);
      const raw = serializeHistoryIndex(empty);
      return { payload: empty, raw };
    }
  }

  private async isPristineIndexlessRoot(): Promise<boolean> {
    for (const directory of ['originals', 'trash', 'recovery'] as const) {
      if ((await this.fileSystem.readdir(join(this.historyRoot, directory))).length > 0) return false;
    }
    return true;
  }

  private async writeIndexUnlocked(next: HistoryIndexPayload, previousRaw: string | null): Promise<void> {
    const indexPath = join(this.historyRoot, HISTORY_INDEX_FILE);
    const lkgPath = join(this.historyRoot, 'recovery', HISTORY_INDEX_LKG_FILE);
    const nextRaw = serializeHistoryIndex(next);
    parseHistoryIndex(nextRaw);
    if (previousRaw !== null) {
      try {
        await this.writeAtomicConfined(lkgPath, previousRaw);
      } catch {
        // A valid canonical index remains authoritative; preserve any prior LKG.
      }
    }
    await this.writeAtomicConfined(indexPath, nextRaw);
    try {
      await this.writeAtomicConfined(lkgPath, nextRaw);
    } catch {
      // The newly committed canonical index remains authoritative.
    }
  }

  private async writeAtomicConfined(targetPath: string, data: string): Promise<void> {
    const previous = await this.readOptionalFile(targetPath);
    const tempPath = join(dirname(targetPath), `.${basename(targetPath)}.tmp-${randomBytes(8).toString('hex')}`);
    let handle: FileHandleLike | null = null;
    let closed = false;
    let targetReplaced = false;
    let tempCreated = false;
    try {
      await this.assertConfinedPathForWrite(tempPath);
      handle = await this.fileSystem.open(tempPath, 'wx');
      tempCreated = true;
      await handle.writeFile(data);
      await handle.sync();
      await handle.close();
      closed = true;
      await this.assertConfinedPathForWrite(tempPath);
      await this.assertConfinedPathForWrite(targetPath);
      await this.fileSystem.rename(tempPath, targetPath);
      targetReplaced = true;
      tempCreated = false;
      await this.assertConfinedPathForRead(targetPath);
      if (await this.fileSystem.readFile(targetPath, 'utf8') !== data) {
        throw historyError('HISTORY_WRITE_FAILED', true, 'Generation history atomic verification failed');
      }
    } catch (error) {
      if (handle !== null && !closed) {
        try { await handle.close(); } catch { /* Preserve atomic write failure. */ }
      }
      if (tempCreated) await this.removeConfinedFile(tempPath);
      const targetIsReplacement = await this.fileEquals(targetPath, data);
      if (targetReplaced || targetIsReplacement) await this.restoreAtomicTarget(targetPath, previous);
      throw normalizeHistoryError(error, 'Generation history atomic write failed');
    }
  }

  private async restoreAtomicTarget(targetPath: string, previous: string | null): Promise<void> {
    try {
      if (previous === null) {
        await this.removeConfinedFile(targetPath);
        return;
      }
      const tempPath = join(dirname(targetPath), `.${basename(targetPath)}.restore-${randomBytes(8).toString('hex')}.tmp`);
      await this.assertConfinedPathForWrite(tempPath);
      const handle = await this.fileSystem.open(tempPath, 'wx');
      try {
        await handle.writeFile(previous);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.assertConfinedPathForWrite(targetPath);
      await this.fileSystem.rename(tempPath, targetPath);
    } catch {
      // LKG evidence remains available when rollback itself is interrupted.
    }
  }

  private async cleanupOwnedTemps(): Promise<void> {
    for (const directory of [this.historyRoot, join(this.historyRoot, 'originals'), join(this.historyRoot, 'trash'), join(this.historyRoot, 'recovery')]) {
      let entries: string[];
      try {
        entries = await this.fileSystem.readdir(directory);
      } catch {
        continue;
      }
      const candidates = entries
        .filter((entry) => !entry.startsWith('.history-purge-')
          && (/^\.history(?:[.-].+)?\.tmp(?:-[a-f0-9]+)?$/u.test(entry)
            || /^\.history\.[^.]+\.json\.(?:tmp|restore)-[a-f0-9]+(?:\.tmp)?$/u.test(entry)))
        .sort()
        .slice(0, MAX_STALE_TEMP_CLEANUP);
      for (const entry of candidates) await this.removeConfinedFile(join(directory, entry));
    }
  }

  private async reconcileDeletionStages(current: HistoryIndexPayload): Promise<void> {
    const recoveryRoot = join(this.historyRoot, 'recovery');
    const entries = (await this.fileSystem.readdir(recoveryRoot))
      .filter((entry) => /^\.history-purge-.+-[a-f0-9]{12}\.tmp$/u.test(entry))
      .sort();
    for (const entry of entries) {
      const match = /^\.history-purge-(.+)-[a-f0-9]{12}\.tmp$/u.exec(entry);
      if (match === null) continue;
      const stagePath = join(recoveryRoot, entry);
      const historyAssetId = match[1]!;
      const record = current.records.find((candidate) => candidate.output?.historyAssetId === historyAssetId);
      if (record?.output === undefined || record.output === null) {
        await this.removeConfinedFile(stagePath);
        continue;
      }
      const sourcePath = this.recordAssetPath(record);
      const stagedState = await this.inspectOriginal(stagePath, record.output.sha256, record.output.byteSize);
      const sourceState = await this.inspectOriginal(sourcePath, record.output.sha256, record.output.byteSize);
      if (stagedState === 'valid' && sourceState === 'missing') {
        await this.assertConfinedPathForWrite(stagePath);
        await this.assertConfinedPathForWrite(sourcePath);
        await this.fileSystem.rename(stagePath, sourcePath);
        if (await this.inspectOriginal(sourcePath, record.output.sha256, record.output.byteSize) !== 'valid') {
          throw historyError('HISTORY_ASSET_CORRUPT', false, 'History deletion recovery failed integrity verification');
        }
        continue;
      }
      if (stagedState === 'valid' && sourceState === 'valid') {
        await this.removeConfinedFile(stagePath);
        continue;
      }
      if (stagedState === 'missing') continue;
      throw historyError('HISTORY_ASSET_CORRUPT', false, 'History deletion recovery evidence is corrupt');
    }
  }

  private async inspectOriginal(
    path: string,
    expectedSha256: string,
    expectedByteSize: number,
  ): Promise<'missing' | 'valid' | 'corrupt'> {
    try {
      await this.assertConfinedPathForRead(path);
      const stats = await this.requireLstat(path);
      if (!isRegularFile(stats) || stats.size !== expectedByteSize) return 'corrupt';
      return await this.hashFile(path) === expectedSha256 ? 'valid' : 'corrupt';
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return 'missing';
      if (isHistoryError(error)) return 'corrupt';
      throw error;
    }
  }

  private async assertConfinedPathForRead(path: string): Promise<void> {
    await this.assertConfinedPath(path, false);
  }

  private async assertConfinedPathForWrite(path: string): Promise<void> {
    await this.assertConfinedPath(path, true);
  }

  private async assertConfinedPath(path: string, allowMissingTarget: boolean): Promise<void> {
    const identity = await this.captureRootIdentity();
    const resolvedPath = resolve(path);
    const confinedRelative = relative(this.historyRoot, resolvedPath);
    if (confinedRelative === '' || confinedRelative.startsWith('..') || isAbsolute(confinedRelative)) {
      throw historyError('HISTORY_CONFINEMENT_VIOLATION', false, 'Generation history path is outside the owned root');
    }
    const segments = confinedRelative.split(/[\\/]+/u);
    let current = identity.historyRoot;
    for (let index = 0; index < segments.length; index += 1) {
      current = join(current, segments[index]!);
      let stats: FileStatLike;
      try {
        stats = await this.requireLstat(current);
      } catch (error) {
        if (allowMissingTarget && index === segments.length - 1 && isErrno(error, 'ENOENT')) {
          const realParent = await this.requireRealpath(dirname(current));
          const expectedRealParent = join(identity.historyRoot, ...segments.slice(0, -1));
          if (!samePath(realParent, expectedRealParent)) {
            throw historyError('HISTORY_CONFINEMENT_VIOLATION', false, 'Generation history parent is invalid');
          }
          return;
        }
        throw error;
      }
      if (isLinkOrReparse(stats)) {
        throw historyError('HISTORY_CONFINEMENT_VIOLATION', false, 'Generation history does not allow linked paths');
      }
      if (index < segments.length - 1 && !stats.isDirectory()) {
        throw historyError('HISTORY_CONFINEMENT_VIOLATION', false, 'Generation history parent is invalid');
      }
      let realCurrent: string;
      try {
        realCurrent = await this.requireRealpath(current);
      } catch (error) {
        if (allowMissingTarget && index === segments.length - 1 && isErrno(error, 'ENOENT')) {
          const realParent = await this.requireRealpath(dirname(current));
          const expectedRealParent = join(identity.historyRoot, ...segments.slice(0, -1));
          if (!samePath(realParent, expectedRealParent)) {
            throw historyError('HISTORY_CONFINEMENT_VIOLATION', false, 'Generation history parent is invalid');
          }
          return;
        }
        throw error;
      }
      const expectedRealCurrent = join(identity.historyRoot, ...segments.slice(0, index + 1));
      if (!samePath(realCurrent, expectedRealCurrent)) {
        throw historyError('HISTORY_CONFINEMENT_VIOLATION', false, 'Generation history path identity changed');
      }
    }
  }

  private async captureRootIdentity(): Promise<HistoryRootIdentity> {
    const realOwnedRoot = await this.requireRealpath(this.ownedRoot);
    const realHistoryRoot = await this.requireRealpath(this.historyRoot);
    if (relative(realOwnedRoot, realHistoryRoot) !== basename(this.historyRoot)) {
      throw historyError('HISTORY_INVALID_ROOT', false, 'Generation history root identity is invalid');
    }
    const identity = { ownedRoot: realOwnedRoot, historyRoot: realHistoryRoot };
    if (this.rootIdentity !== null && (
      !samePath(this.rootIdentity.ownedRoot, identity.ownedRoot)
      || !samePath(this.rootIdentity.historyRoot, identity.historyRoot)
    )) {
      throw historyError('HISTORY_INVALID_ROOT', false, 'Generation history root identity changed');
    }
    this.rootIdentity = identity;
    return identity;
  }

  private async assertRegularDirectory(path: string, message: string): Promise<void> {
    const stats = await this.requireLstat(path).catch((error) => {
      throw normalizeHistoryError(error, message);
    });
    if (!stats.isDirectory() || isLinkOrReparse(stats)) {
      throw historyError('HISTORY_INVALID_ROOT', false, message);
    }
    await this.requireRealpath(path);
  }

  private async requireLstat(path: string): Promise<FileStatLike> {
    if (this.fileSystem.lstat === undefined) {
      throw historyError('HISTORY_INVALID_ROOT', false, 'Generation history requires lstat confinement');
    }
    return this.fileSystem.lstat(path);
  }

  private async requireRealpath(path: string): Promise<string> {
    if (this.fileSystem.realpath === undefined) {
      throw historyError('HISTORY_INVALID_ROOT', false, 'Generation history requires realpath confinement');
    }
    return normalize(resolve(await this.fileSystem.realpath(path)));
  }

  private async readOptionalFile(path: string): Promise<string | null> {
    try {
      await this.assertConfinedPathForRead(path);
      return await this.fileSystem.readFile(path, 'utf8');
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return null;
      throw error;
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await this.requireLstat(path);
      return true;
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return false;
      throw error;
    }
  }

  private async fileEquals(path: string, expected: string): Promise<boolean> {
    try {
      await this.assertConfinedPathForRead(path);
      return await this.fileSystem.readFile(path, 'utf8') === expected;
    } catch {
      return false;
    }
  }

  private async removeConfinedFile(path: string): Promise<void> {
    try {
      await this.assertConfinedPathForRead(path);
      const stats = await this.requireLstat(path);
      if (!isRegularFile(stats)) return;
      await this.assertConfinedPathForWrite(path);
      await this.fileSystem.rm(path, { force: true });
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) {
        // Owned residue cleanup is best-effort after a typed primary failure.
      }
    }
  }

  private assertLexicalRootConfiguration(): void {
    if (!isAbsolute(this.historyRoot) || !isAbsolute(this.ownedRoot)) {
      throw historyError('HISTORY_INVALID_ROOT', false, 'Generation history root must be absolute');
    }
    if (isFileSystemRoot(this.historyRoot) || isFileSystemRoot(this.ownedRoot)) {
      throw historyError('HISTORY_INVALID_ROOT', false, 'Generation history cannot use a filesystem root');
    }
    if (!samePath(dirname(this.historyRoot), this.ownedRoot)) {
      throw historyError('HISTORY_INVALID_ROOT', false, 'Generation history root must be a direct owned child');
    }
    for (const forbidden of this.forbiddenRoots) {
      if (pathsIntersect(this.historyRoot, forbidden)) {
        throw historyError('HISTORY_INVALID_ROOT', false, 'Generation history root conflicts with a protected location');
      }
    }
  }
}

function serializeHistoryIndex(payload: HistoryIndexPayload): string {
  const envelope: HistoryIndexEnvelope = {
    ...payload,
    payloadSha256: sha256Canonical(payload),
  };
  return `${canonicalJson(envelope)}\n`;
}

function parseHistoryIndex(raw: string): HistoryIndexPayload {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw historyError('HISTORY_INDEX_CORRUPT', false, 'Generation history index is corrupt');
  }
  if (!isExactRecord(value, ['schemaVersion', 'revision', 'records', 'operations', 'payloadSha256'])
    || value.schemaVersion !== HISTORY_INDEX_SCHEMA_VERSION
    || typeof value.revision !== 'number'
    || !Number.isSafeInteger(value.revision)
    || value.revision < 0
    || !Array.isArray(value.records)
    || !Array.isArray(value.operations)
    || value.operations.length > MAX_HISTORY_OPERATIONS
    || typeof value.payloadSha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.payloadSha256)) {
    throw historyError('HISTORY_INDEX_CORRUPT', false, 'Generation history index is corrupt');
  }
  let records: GenerationHistoryRecord[];
  let operations: HistoryOperationReceipt[];
  try {
    records = value.records.map(parseGenerationHistoryRecord);
    operations = value.operations.map(parseOperationReceipt);
  } catch {
    throw historyError('HISTORY_INDEX_CORRUPT', false, 'Generation history index is corrupt');
  }
  const payload: HistoryIndexPayload = {
    schemaVersion: HISTORY_INDEX_SCHEMA_VERSION,
    revision: value.revision,
    records,
    operations,
  };
  if (sha256Canonical(payload) !== value.payloadSha256) {
    throw historyError('HISTORY_INDEX_CORRUPT', false, 'Generation history index checksum is invalid');
  }
  if (new Set(records.map((record) => record.id)).size !== records.length
    || new Set(operations.map((operation) => operation.operationId)).size !== operations.length) {
    throw historyError('HISTORY_INDEX_CORRUPT', false, 'Generation history index contains duplicate identities');
  }
  return payload;
}

function parseOperationReceipt(value: unknown): HistoryOperationReceipt {
  if (!isExactRecord(value, ['kind', 'operationId', 'protectedIds', 'recordIds', 'requestSha256'])
    || !isOperationKind(value.kind)
    || !Array.isArray(value.protectedIds)
    || value.protectedIds.length > MAX_HISTORY_MUTATION_BATCH
    || !Array.isArray(value.recordIds)
    || value.recordIds.length > MAX_HISTORY_MUTATION_BATCH
    || typeof value.requestSha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.requestSha256)) {
    throw historyError('HISTORY_INDEX_CORRUPT', false, 'Generation history operation receipt is invalid');
  }
  return {
    kind: value.kind,
    operationId: parseOpaqueOperationId(value.operationId),
    protectedIds: value.protectedIds.map((recordId) => parseOpaqueId(recordId, 'History record identity is invalid')),
    recordIds: value.recordIds.map((recordId) => parseOpaqueId(recordId, 'History record identity is invalid')),
    requestSha256: value.requestSha256,
  };
}

function parseOpaqueOperationId(value: unknown): string {
  return parseOpaqueId(value, 'History operation identity is invalid');
}

function parseOpaqueId(value: unknown, message: string): string {
  if (typeof value === 'string' && /^[a-z][a-z0-9_-]{7,95}$/u.test(value)) return value;
  throw historyError('HISTORY_INVALID_REQUEST', false, message);
}

function trimOperations(operations: readonly HistoryOperationReceipt[]): HistoryOperationReceipt[] {
  return operations.slice(Math.max(0, operations.length - MAX_HISTORY_OPERATIONS));
}

function isOperationKind(value: unknown): value is HistoryOperationReceipt['kind'] {
  return value === 'ingest'
    || value === 'metadata'
    || value === 'favorite'
    || value === 'trash'
    || value === 'restore'
    || value === 'add_reference'
    || value === 'remove_reference'
    || value === 'permanent_delete'
    || value === 'purge';
}

function isMetadataTransitionAllowed(
  current: GenerationHistoryRecord['status'],
  next: GenerationHistoryRecord['status'],
): boolean {
  if (current === 'queued') return next === 'queued' || next === 'running' || next === 'failed' || next === 'cancelled';
  if (current === 'running') return next === 'running' || next === 'failed' || next === 'cancelled';
  return false;
}

function isTerminalHistoryStatus(status: GenerationHistoryRecord['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function assertMatchingReceipt(
  receipt: HistoryOperationReceipt,
  kind: HistoryOperationReceipt['kind'],
  requestSha256: string,
): void {
  if (receipt.kind !== kind || receipt.requestSha256 !== requestSha256) {
    throw historyError('HISTORY_INVALID_REQUEST', false, 'History operation id was already used for another request');
  }
}

function findMatchingReceipt(
  current: HistoryIndexPayload,
  operationId: string,
  kind: HistoryOperationReceipt['kind'],
  requestSha256: string,
): HistoryOperationReceipt | null {
  const receipt = current.operations.find((operation) => operation.operationId === operationId);
  if (receipt === undefined) return null;
  assertMatchingReceipt(receipt, kind, requestSha256);
  return receipt;
}

function nextIndex(
  current: HistoryIndexPayload,
  records: readonly GenerationHistoryRecord[],
  receipt: HistoryOperationReceipt,
): HistoryIndexPayload {
  return {
    schemaVersion: HISTORY_INDEX_SCHEMA_VERSION,
    revision: current.revision + 1,
    records,
    operations: trimOperations([...current.operations, receipt]),
  };
}

function parseHistoryIdBatch(value: readonly string[], maximum = MAX_HISTORY_MUTATION_BATCH): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    throw historyError('HISTORY_INVALID_REQUEST', false, 'History record batch is invalid');
  }
  const ids = value.map((id) => parseOpaqueId(id, 'History record identity is invalid'));
  if (new Set(ids).size !== ids.length) {
    throw historyError('HISTORY_INVALID_REQUEST', false, 'History record batch contains duplicates');
  }
  return ids;
}

function parseHistoryIdSet(value: readonly string[], maximum = MAX_HISTORY_MUTATION_BATCH): string[] {
  return parseHistoryIdBatch(value, maximum).sort((left, right) => left.localeCompare(right));
}

function requireHistoryRecords(
  current: HistoryIndexPayload,
  historyIds: readonly string[],
): GenerationHistoryRecord[] {
  const records = historyIds.map((historyId) => current.records.find((record) => record.id === historyId));
  if (records.some((record) => record === undefined)) {
    throw historyError('HISTORY_INVALID_REQUEST', false, 'History record is unavailable');
  }
  return records as GenerationHistoryRecord[];
}

function mutationResult(
  index: HistoryIndexPayload,
  historyIds: readonly string[],
): GenerationHistoryMutationResult {
  return Object.freeze({
    records: Object.freeze(index.records.filter((record) => historyIds.includes(record.id))),
    revision: index.revision,
  });
}

function capacityFromRecords(records: readonly GenerationHistoryRecord[]): GenerationHistoryCapacity {
  let activeBytes = 0;
  let activeCount = 0;
  let trashBytes = 0;
  let trashCount = 0;
  let missingOrCorruptCount = 0;
  for (const record of records) {
    if (record.trash === null) activeCount += 1;
    else trashCount += 1;
    if (record.output === null) continue;
    if (record.output.availability !== 'available') {
      missingOrCorruptCount += 1;
      continue;
    }
    if (record.trash === null) activeBytes += record.output.byteSize;
    else trashBytes += record.output.byteSize;
  }
  return Object.freeze({ activeBytes, activeCount, trashBytes, trashCount, missingOrCorruptCount });
}

function replaceRecord(
  records: readonly GenerationHistoryRecord[],
  updated: GenerationHistoryRecord,
): GenerationHistoryRecord[] {
  return records.map((record) => record.id === updated.id ? updated : record);
}

function mutationTimestamp(now: number, currentUpdatedAt: string): string {
  return new Date(Math.max(now, Date.parse(currentUpdatedAt))).toISOString();
}

function hasBlockingProjectReference(record: GenerationHistoryRecord): boolean {
  return record.projectReferences.some((reference) => reference.independentProjectAssetId === undefined);
}

function historyFilterSha256(request: GenerationHistoryListRequest): string {
  return sha256Canonical({ filters: request.filters, sort: request.sort });
}

function createHistoryCursor(payload: HistoryCursorPayload): string {
  const body = toBase64Url(Buffer.from(canonicalJson(payload), 'utf8'));
  const checksum = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 24);
  return `histcur_${body}_${checksum}`;
}

function parseHistoryCursor(cursor: string): HistoryCursorPayload {
  const encoded = cursor.slice('histcur_'.length);
  const separatorIndex = encoded.lastIndexOf('_');
  if (separatorIndex <= 0) {
    throw historyError('HISTORY_INVALID_REQUEST', false, 'Generation history cursor is invalid');
  }
  const body = encoded.slice(0, separatorIndex);
  const checksum = encoded.slice(separatorIndex + 1);
  const expectedChecksum = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 24);
  if (checksum !== expectedChecksum) {
    throw historyError('HISTORY_INVALID_REQUEST', false, 'Generation history cursor checksum is invalid');
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(fromBase64Url(body), 'base64').toString('utf8')) as unknown;
  } catch {
    throw historyError('HISTORY_INVALID_REQUEST', false, 'Generation history cursor is invalid');
  }
  if (!isExactRecord(value, ['schemaVersion', 'revision', 'sort', 'filterSha256', 'createdAt', 'recordId'])
    || value.schemaVersion !== 1
    || typeof value.revision !== 'number'
    || !Number.isSafeInteger(value.revision)
    || value.revision < 0
    || (value.sort !== 'newest' && value.sort !== 'oldest')
    || typeof value.filterSha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.filterSha256)
    || typeof value.createdAt !== 'string'
    || !Number.isFinite(Date.parse(value.createdAt))) {
    throw historyError('HISTORY_INVALID_REQUEST', false, 'Generation history cursor is invalid');
  }
  return {
    schemaVersion: 1,
    revision: value.revision,
    sort: value.sort,
    filterSha256: value.filterSha256,
    createdAt: value.createdAt,
    recordId: parseOpaqueId(value.recordId, 'History cursor record identity is invalid'),
  };
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/gu, '');
}

function fromBase64Url(value: string): string {
  const base64 = value.replace(/-/gu, '+').replace(/_/gu, '/');
  return `${base64}${'='.repeat((4 - base64.length % 4) % 4)}`;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function historyError(
  code: GenerationHistoryStoreErrorCode,
  retryable: boolean,
  message: string,
): GenerationHistoryStoreError {
  return Object.assign(new Error(message), { code, retryable });
}

function normalizeHistoryError(error: unknown, fallbackMessage: string): GenerationHistoryStoreError {
  if (isHistoryError(error)) return error;
  if (isErrno(error, 'ENOSPC')) return historyError('HISTORY_DISK_FULL', true, 'Generation history storage is full');
  if (isErrno(error, 'EACCES') || isErrno(error, 'EPERM') || isErrno(error, 'EROFS')) {
    return historyError('HISTORY_PERMISSION_DENIED', true, 'Generation history storage is not writable');
  }
  return historyError('HISTORY_WRITE_FAILED', true, fallbackMessage);
}

function isHistoryError(error: unknown): error is GenerationHistoryStoreError {
  return error instanceof Error
    && 'code' in error
    && typeof error.code === 'string'
    && error.code.startsWith('HISTORY_')
    && 'retryable' in error
    && typeof error.retryable === 'boolean';
}

function isExactRecord(value: unknown, allowedKeys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key))
    && allowedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isRegularFile(stats: FileStatLike): boolean {
  return stats.isFile() && !isLinkOrReparse(stats);
}

function isLinkOrReparse(stats: FileStatLike): boolean {
  return stats.isSymbolicLink?.() === true || stats.isReparsePoint?.() === true;
}

function defaultIsNetworkPath(path: string): boolean {
  return /^[/\\]{2}/u.test(path);
}

function isFileSystemRoot(path: string): boolean {
  return samePath(parse(path).root, path);
}

function pathsIntersect(left: string, right: string): boolean {
  const normalizedLeft = comparablePath(left);
  const normalizedRight = comparablePath(right);
  return normalizedLeft === normalizedRight
    || normalizedLeft.startsWith(`${normalizedRight}${sep}`)
    || normalizedRight.startsWith(`${normalizedLeft}${sep}`);
}

function samePath(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

function comparablePath(path: string): string {
  const normalized = normalize(resolve(path));
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}

function isErrno(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));
}
