import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import {
  parseGenerationHistoryRecord,
  type GenerationHistoryRecord,
} from '@agent-canvas/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { canonicalJson, sha256Canonical } from './canonical-json';
import * as desktopCore from './index';
import { NodeFileSystem, type FileHandleLike, type FileStatLike, type FileSystem } from './file-system';

interface HistoryStoreLike {
  addProjectReferences(input: {
    readonly historyId: string;
    readonly operationId: string;
    readonly references: ReadonlyArray<{
      readonly referenceId: string;
      readonly projectId: string;
      readonly projectDisplayLabel: string;
      readonly independentProjectAssetId?: string;
    }>;
  }): Promise<unknown>;
  getCapacity(): Promise<{
    readonly activeBytes: number;
    readonly activeCount: number;
    readonly missingOrCorruptCount: number;
    readonly trashBytes: number;
    readonly trashCount: number;
  }>;
  ingest(input: {
    readonly operationId: string;
    readonly record: GenerationHistoryRecord;
    readonly source: AsyncIterable<Uint8Array>;
  }): Promise<GenerationHistoryRecord>;
  list(request: unknown): Promise<{
    readonly records: readonly GenerationHistoryRecord[];
    readonly revision: number;
    readonly total: number;
    readonly nextCursor: string | null;
  }>;
  permanentlyDelete(input: { readonly historyIds: readonly string[]; readonly operationId: string }): Promise<unknown>;
  purgeExpired(input: { readonly operationId: string }): Promise<{
    readonly protectedIds: readonly string[];
    readonly purgedIds: readonly string[];
  }>;
  removeProjectReferences(input: {
    readonly historyId: string;
    readonly operationId: string;
    readonly referenceIds: readonly string[];
  }): Promise<unknown>;
  resolveAvailableAssetPath(historyAssetId: string): Promise<string | null>;
  restore(input: { readonly historyIds: readonly string[]; readonly operationId: string }): Promise<unknown>;
  setFavorite(input: {
    readonly favorite: boolean;
    readonly historyIds: readonly string[];
    readonly operationId: string;
  }): Promise<unknown>;
  softDelete(input: { readonly historyIds: readonly string[]; readonly operationId: string }): Promise<unknown>;
  upsertMetadata(input: { readonly operationId: string; readonly record: GenerationHistoryRecord }): Promise<GenerationHistoryRecord>;
  withAvailableAsset<T>(
    historyId: string,
    consumer: (asset: { readonly record: GenerationHistoryRecord; readonly source: NodeJS.ReadableStream }) => Promise<T>,
  ): Promise<T>;
}

describe('generation history media resolution', () => {
  it('resolves only active verified originals by opaque history asset id', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    const harness = await createHarness();
    const store = new Store(harness);
    const record = historyRecord('history_mediaaaaaaaaaaa', pngBytes);
    await store.ingest({ operationId: 'operation_ingest_mediaaaaa', record, source: chunks(pngBytes) });

    await expect(store.resolveAvailableAssetPath(record.output!.historyAssetId)).resolves.toBe(join(
      harness.historyRoot,
      'originals',
      `${record.output!.historyAssetId}.png`,
    ));
    await expect(store.resolveAvailableAssetPath('history_asset_unknownxx')).resolves.toBeNull();
    await expect(store.resolveAvailableAssetPath('../private-file')).resolves.toBeNull();

    await store.softDelete({ historyIds: [record.id], operationId: 'operation_trash_mediaaaaaa' });
    await expect(store.resolveAvailableAssetPath(record.output!.historyAssetId)).resolves.toBeNull();
  });

  it('rejects a same-size corrupted original during media resolution', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    const harness = await createHarness();
    const store = new Store(harness);
    const record = historyRecord('history_mediacorruptaaa', pngBytes);
    await store.ingest({ operationId: 'operation_ingest_mediabbb', record, source: chunks(pngBytes) });
    await writeFile(join(harness.historyRoot, 'originals', `${record.output!.historyAssetId}.png`), Buffer.alloc(pngBytes.length, 0x7f));

    await expect(store.resolveAvailableAssetPath(record.output!.historyAssetId)).resolves.toBeNull();
  });
});

type HistoryStoreConstructor = new (options: {
  readonly fileSystem?: FileSystem;
  readonly forbiddenRoots?: readonly string[];
  readonly hashFile?: (path: string) => Promise<string>;
  readonly historyRoot: string;
  readonly isNetworkPath?: (path: string) => boolean | Promise<boolean>;
  readonly now?: () => number;
  readonly ownedRoot: string;
}) => HistoryStoreLike;

const tempRoots: string[] = [];
const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03,
  0x08, 0x06, 0x00, 0x00, 0x00,
]);

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('durable generation history store', () => {
  it('creates an owned immutable original and restarts from an atomic checksummed index', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    const harness = await createHarness();
    const record = historyRecord('history_aaaaaaaaaaaaaaaa', pngBytes);

    const created = await new Store(harness).ingest({
      operationId: 'operation_ingest_aaaaaaaa',
      record,
      source: chunks(pngBytes),
    });

    expect(created).toEqual(record);
    expect(await readFile(join(
      harness.historyRoot,
      'originals',
      `${record.output!.historyAssetId}.png`,
    ))).toEqual(pngBytes);
    expect((await readdir(harness.historyRoot)).sort()).toEqual([
      '.novus-generation-history-root.json',
      'history.index.json',
      'originals',
      'recovery',
      'trash',
    ]);
    const serializedIndex = await readFile(join(harness.historyRoot, 'history.index.json'), 'utf8');
    expect(serializedIndex).toContain('payloadSha256');
    expect(serializedIndex).not.toContain('originals');
    expect(serializedIndex).not.toContain('base64');

    const reopened = await new Store(harness).list({ pageSize: 25 });
    expect(reopened.records).toEqual([record]);
    expect(reopened.total).toBe(1);
    expect(reopened.revision).toBe(1);
    expect(reopened.nextCursor).toBeNull();
  });

  it('rejects a second record that aliases an existing managed history asset identity', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    const harness = await createHarness();
    const store = new Store(harness);
    const first = historyRecord('history_aaaaaaaaaaaaaaaa', pngBytes);
    await store.ingest({ operationId: 'operation_ingest_aaaaaaaa', record: first, source: chunks(pngBytes) });
    const secondBase = historyRecord('history_bbbbbbbbbbbbbbbb', pngBytes);
    const aliased = parseGenerationHistoryRecord({
      ...secondBase,
      output: {
        ...secondBase.output!,
        historyAssetId: first.output!.historyAssetId,
      },
    });

    await expect(store.ingest({
      operationId: 'operation_ingest_bbbbbbbb',
      record: aliased,
      source: chunks(pngBytes),
    })).rejects.toMatchObject({ code: 'HISTORY_INVALID_REQUEST' });
    expect((await store.list({ filters: { trashState: 'all' } })).records).toEqual([first]);
    expect(await readdir(join(harness.historyRoot, 'originals'))).toEqual([
      `${first.output!.historyAssetId}.png`,
    ]);
  });

  it('recovers an orphaned valid original left by a crash before index commit', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    const harness = await createHarness();
    const store = new Store(harness);
    const record = historyRecord('history_aaaaaaaaaaaaaaaa', pngBytes);
    await store.list({});
    await writeFile(join(
      harness.historyRoot,
      'originals',
      `${record.output!.historyAssetId}.png`,
    ), pngBytes);

    await expect(store.ingest({
      operationId: 'operation_ingest_aaaaaaaa',
      record,
      source: chunks(pngBytes),
    })).resolves.toEqual(record);
    expect((await new Store(harness).list({})).records).toEqual([record]);
    expect(await readdir(join(harness.historyRoot, 'originals'))).toEqual([
      `${record.output!.historyAssetId}.png`,
    ]);
  });

  it('binds an ingest operation receipt to the complete safe record metadata', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    const harness = await createHarness();
    const store = new Store(harness);
    const record = historyRecord('history_aaaaaaaaaaaaaaaa', pngBytes);
    await store.ingest({ operationId: 'operation_ingest_aaaaaaaa', record, source: chunks(pngBytes) });
    await expect(store.ingest({
      operationId: 'operation_ingest_aaaaaaaa',
      record,
      source: chunks(pngBytes),
    })).resolves.toEqual(record);
    const changed = parseGenerationHistoryRecord({
      ...record,
      promptSummary: 'A different safe generation summary',
    });

    await expect(store.ingest({
      operationId: 'operation_ingest_aaaaaaaa',
      record: changed,
      source: chunks(pngBytes),
    })).rejects.toMatchObject({ code: 'HISTORY_INVALID_REQUEST' });
  });

  it('persists metadata-only lifecycle records and completes an existing running record with an original', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    expect(Store.prototype).toHaveProperty('upsertMetadata');
    if (!('upsertMetadata' in Store.prototype)) return;
    const harness = await createHarness();
    const store = new Store(harness);
    const queued = metadataHistoryRecord('history_aaaaaaaaaaaaaaaa', 'queued');
    const running = metadataHistoryRecord('history_aaaaaaaaaaaaaaaa', 'running');
    await store.upsertMetadata({ operationId: 'operation_history_queued_aaaaaaaa', record: queued });
    await store.upsertMetadata({ operationId: 'operation_history_running_aaaaaaaa', record: running });
    const succeeded = historyRecord('history_aaaaaaaaaaaaaaaa', pngBytes);
    await store.ingest({ operationId: 'operation_ingest_aaaaaaaa', record: succeeded, source: chunks(pngBytes) });
    const failed = metadataHistoryRecord('history_bbbbbbbbbbbbbbbb', 'failed');
    const cancelled = metadataHistoryRecord('history_cccccccccccccccc', 'cancelled');
    await store.upsertMetadata({ operationId: 'operation_history_failed_bbbbbbbb', record: failed });
    await store.upsertMetadata({ operationId: 'operation_history_cancelled_cccccccc', record: cancelled });

    const records = (await store.list({ filters: { trashState: 'all' }, sort: 'oldest' })).records;
    expect(records.map((record) => [record.id, record.status])).toEqual([
      [succeeded.id, 'succeeded'],
      [failed.id, 'failed'],
      [cancelled.id, 'cancelled'],
    ]);
    expect(await readFile(join(
      harness.historyRoot,
      'originals',
      `${succeeded.output!.historyAssetId}.png`,
    ))).toEqual(pngBytes);
  });

  it('bounds each expired purge receipt so the committed index remains reopenable', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    const harness = await createHarness();
    const expiredAt = Date.parse('2026-07-29T00:00:00.000Z');
    const store = new Store({ ...harness, now: () => expiredAt });
    await store.list({});
    const records = Array.from({ length: 101 }, (_, index) => failedTrashedHistoryRecord(index));
    const payload = { schemaVersion: 1, revision: 1, records, operations: [] };
    await writeFile(
      join(harness.historyRoot, 'history.index.json'),
      `${canonicalJson({ ...payload, payloadSha256: sha256Canonical(payload) })}\n`,
      'utf8',
    );

    const first = await store.purgeExpired({ operationId: 'operation_purge_aaaaaaaa' });
    expect(first.purgedIds).toHaveLength(100);
    const reopened = new Store({ ...harness, now: () => expiredAt });
    expect((await reopened.list({ filters: { trashState: 'all' } })).records).toHaveLength(1);
    const second = await reopened.purgeExpired({ operationId: 'operation_purge_bbbbbbbb' });
    expect(second.purgedIds).toHaveLength(1);
    expect((await new Store(harness).list({ filters: { trashState: 'all' } })).records).toEqual([]);
  });

  it.each([
    ['ENOSPC', 'HISTORY_DISK_FULL', false],
    ['EACCES', 'HISTORY_PERMISSION_DENIED', false],
    ['EINTR', 'HISTORY_WRITE_FAILED', true],
  ] as const)('%s during index replacement preserves the previous index and removes only new residue', async (
    errno,
    expectedCode,
    failAfterRename,
  ) => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    const harness = await createHarness();
    const faultFileSystem = new IndexFaultFileSystem();
    const store = new Store({ ...harness, fileSystem: faultFileSystem });
    const first = historyRecord('history_aaaaaaaaaaaaaaaa', pngBytes);
    await store.ingest({ operationId: 'operation_ingest_aaaaaaaa', record: first, source: chunks(pngBytes) });

    faultFileSystem.arm(errno, failAfterRename);
    const secondBytes = Buffer.concat([pngBytes, Buffer.from([0x01])]);
    const second = historyRecord('history_bbbbbbbbbbbbbbbb', secondBytes);
    await expect(store.ingest({
      operationId: 'operation_ingest_bbbbbbbb',
      record: second,
      source: chunks(secondBytes),
    })).rejects.toMatchObject({ code: expectedCode });

    const reopened = await new Store(harness).list({ pageSize: 25 });
    expect(reopened.records.map((record) => record.id)).toEqual([first.id]);
    expect(await readdir(join(harness.historyRoot, 'originals'))).toEqual([
      `${first.output!.historyAssetId}.png`,
    ]);
  });

  it('restores the previous canonical index after post-rename verification finds corruption', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    const harness = await createHarness();
    const fileSystem = new CorruptAfterIndexRenameFileSystem();
    const store = new Store({ ...harness, fileSystem });
    const first = historyRecord('history_aaaaaaaaaaaaaaaa', pngBytes);
    await store.ingest({ operationId: 'operation_ingest_aaaaaaaa', record: first, source: chunks(pngBytes) });
    const secondBytes = Buffer.concat([pngBytes, Buffer.from([0x01])]);
    const second = historyRecord('history_bbbbbbbbbbbbbbbb', secondBytes);
    fileSystem.arm();

    await expect(store.ingest({
      operationId: 'operation_ingest_bbbbbbbb',
      record: second,
      source: chunks(secondBytes),
    })).rejects.toMatchObject({ code: 'HISTORY_WRITE_FAILED' });
    expect((await new Store(harness).list({})).records).toEqual([first]);
    expect(await readdir(join(harness.historyRoot, 'originals'))).toEqual([
      `${first.output!.historyAssetId}.png`,
    ]);
  });

  it('cleans confined stale temp residue and returns a typed error for checksum corruption while retaining LKG evidence', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    const harness = await createHarness();
    const record = historyRecord('history_aaaaaaaaaaaaaaaa', pngBytes);
    const store = new Store(harness);
    await store.ingest({ operationId: 'operation_ingest_aaaaaaaa', record, source: chunks(pngBytes) });
    const staleTemp = join(harness.historyRoot, 'originals', '.history-ingest-stale.tmp');
    await writeFile(staleTemp, 'stale');
    const indexPath = join(harness.historyRoot, 'history.index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8')) as Record<string, unknown>;
    await writeFile(indexPath, `${JSON.stringify({ ...index, payloadSha256: '0'.repeat(64) })}\n`, 'utf8');

    await expect(new Store(harness).list({})).rejects.toMatchObject({ code: 'HISTORY_INDEX_CORRUPT' });
    expect(await readFile(join(harness.historyRoot, 'recovery', 'history.index.last-good.json'), 'utf8'))
      .toContain(record.id);
    expect(await readdir(join(harness.historyRoot, 'originals'))).not.toContain(basename(staleTemp));
    expect(await readFile(indexPath, 'utf8')).toContain('"payloadSha256":"' + '0'.repeat(64) + '"');
  });

  it('restores a missing canonical index from valid last-known-good evidence', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    const harness = await createHarness();
    const record = historyRecord('history_aaaaaaaaaaaaaaaa', pngBytes);
    const store = new Store(harness);
    await store.ingest({ operationId: 'operation_ingest_aaaaaaaa', record, source: chunks(pngBytes) });
    const indexPath = join(harness.historyRoot, 'history.index.json');
    const lkgPath = join(harness.historyRoot, 'recovery', 'history.index.last-good.json');
    expect(await readFile(lkgPath, 'utf8')).toContain(record.id);
    await rm(indexPath);

    expect((await new Store(harness).list({})).records).toEqual([record]);
    expect(await readFile(indexPath, 'utf8')).toContain(record.id);
    expect(await readFile(lkgPath, 'utf8')).toContain(record.id);
  });

  it('rejects a non-pristine root when both canonical and recovery indexes are missing', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    const harness = await createHarness();
    const record = historyRecord('history_aaaaaaaaaaaaaaaa', pngBytes);
    const store = new Store(harness);
    await store.ingest({ operationId: 'operation_ingest_aaaaaaaa', record, source: chunks(pngBytes) });
    const originalPath = join(harness.historyRoot, 'originals', `${record.output!.historyAssetId}.png`);
    await rm(join(harness.historyRoot, 'history.index.json'));
    await rm(join(harness.historyRoot, 'recovery', 'history.index.last-good.json'));

    await expect(new Store(harness).list({})).rejects.toMatchObject({ code: 'HISTORY_INDEX_CORRUPT' });
    expect(await readFile(originalPath)).toEqual(pngBytes);
    await expect(readFile(join(harness.historyRoot, 'history.index.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('generation history root confinement', () => {
  it('rejects a non-empty unmarked directory instead of claiming foreign data', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    const harness = await createHarness();
    await mkdir(harness.historyRoot);
    await writeFile(join(harness.historyRoot, 'foreign-user-data.txt'), 'do not touch', 'utf8');

    await expect(new Store(harness).list({})).rejects.toMatchObject({ code: 'HISTORY_INVALID_ROOT' });
    expect(await readFile(join(harness.historyRoot, 'foreign-user-data.txt'), 'utf8')).toBe('do not touch');
    expect(await readdir(harness.historyRoot)).toEqual(['foreign-user-data.txt']);
  });

  it('rejects root escapes, protected project/install intersections, and mapped network roots', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    const harness = await createHarness();
    const outside = join(dirname(harness.ownedRoot), 'outside-history');

    expect(() => new Store({ ...harness, historyRoot: outside })).toThrowError(expect.objectContaining({
      code: 'HISTORY_INVALID_ROOT',
    }));
    expect(() => new Store({ ...harness, forbiddenRoots: [harness.historyRoot] })).toThrowError(expect.objectContaining({
      code: 'HISTORY_INVALID_ROOT',
    }));
    await expect(new Store({ ...harness, isNetworkPath: () => true }).list({})).rejects.toMatchObject({
      code: 'HISTORY_INVALID_ROOT',
    });
  });

  it('rejects junction/reparse roots and leaves the outside target untouched', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    const harness = await createHarness();
    const outside = join(dirname(harness.ownedRoot), 'outside-target');
    await mkdir(outside);
    await writeFile(join(outside, 'sentinel.txt'), 'outside', 'utf8');
    await symlink(outside, harness.historyRoot, 'junction');

    await expect(new Store(harness).list({})).rejects.toMatchObject({ code: 'HISTORY_INVALID_ROOT' });
    expect(await readFile(join(outside, 'sentinel.txt'), 'utf8')).toBe('outside');
    expect(await readdir(outside)).toEqual(['sentinel.txt']);
  });
});

describe('generation history pagination', () => {
  it('uses an opaque revision-bound cursor with stable sort and rejects tampering or query reuse', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    const harness = await createHarness();
    const store = new Store(harness);
    const first = historyRecordAt('history_aaaaaaaaaaaaaaaa', pngBytes, '2026-07-18T12:00:00.000Z');
    const secondBytes = Buffer.concat([pngBytes, Buffer.from([0x01])]);
    const second = historyRecordAt('history_bbbbbbbbbbbbbbbb', secondBytes, '2026-07-19T12:00:00.000Z');
    const thirdBytes = Buffer.concat([pngBytes, Buffer.from([0x02])]);
    const third = historyRecordAt('history_cccccccccccccccc', thirdBytes, '2026-07-20T12:00:00.000Z');
    await store.ingest({ operationId: 'operation_ingest_aaaaaaaa', record: first, source: chunks(pngBytes) });
    await store.ingest({ operationId: 'operation_ingest_bbbbbbbb', record: second, source: chunks(secondBytes) });
    await store.ingest({ operationId: 'operation_ingest_cccccccc', record: third, source: chunks(thirdBytes) });

    const pageOne = await store.list({ pageSize: 2, sort: 'newest', filters: { trashState: 'all' } });
    expect(pageOne.records.map((record) => record.id)).toEqual([third.id, second.id]);
    expect(pageOne.nextCursor).toMatch(/^histcur_[A-Za-z0-9_-]+$/u);
    expect(pageOne.nextCursor).not.toContain(second.id);
    const pageTwo = await store.list({
      cursor: pageOne.nextCursor,
      pageSize: 2,
      sort: 'newest',
      filters: { trashState: 'all' },
    });
    expect(pageTwo.records.map((record) => record.id)).toEqual([first.id]);
    expect(pageTwo.nextCursor).toBeNull();

    await expect(store.list({
      cursor: `${pageOne.nextCursor!.slice(0, -1)}x`,
      pageSize: 2,
      sort: 'newest',
      filters: { trashState: 'all' },
    })).rejects.toMatchObject({ code: 'HISTORY_INVALID_REQUEST' });
    await expect(store.list({
      cursor: pageOne.nextCursor,
      pageSize: 2,
      sort: 'oldest',
      filters: { trashState: 'all' },
    })).rejects.toMatchObject({ code: 'HISTORY_INVALID_REQUEST' });
  });

  it('verifies only the selected page instead of hashing unrelated originals under the global lock', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    const harness = await createHarness();
    const store = new Store(harness);
    const first = historyRecordAt('history_aaaaaaaaaaaaaaaa', pngBytes, '2026-07-18T12:00:00.000Z');
    const secondBytes = Buffer.concat([pngBytes, Buffer.from([0x01])]);
    const second = historyRecordAt('history_bbbbbbbbbbbbbbbb', secondBytes, '2026-07-19T12:00:00.000Z');
    await store.ingest({ operationId: 'operation_ingest_aaaaaaaa', record: first, source: chunks(pngBytes) });
    await store.ingest({ operationId: 'operation_ingest_bbbbbbbb', record: second, source: chunks(secondBytes) });
    await rm(join(harness.historyRoot, 'originals', `${second.output!.historyAssetId}.png`));

    const pageOne = await store.list({ pageSize: 1, sort: 'oldest', filters: { trashState: 'all' } });
    expect(pageOne.records.map((record) => record.id)).toEqual([first.id]);
    expect(pageOne.revision).toBe(2);
    const pageTwo = await store.list({
      cursor: pageOne.nextCursor!,
      pageSize: 1,
      sort: 'oldest',
      filters: { trashState: 'all' },
    });
    expect(pageTwo.records[0]!.id).toBe(second.id);
    expect(pageTwo.records[0]!.output?.availability).toBe('missing');
    expect(pageTwo.revision).toBe(3);
  });
});

describe('generation history concurrent lifecycle', () => {
  it('returns exact capacity totals when a missing original falls beyond the former 32-record audit window', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    const harness = await createHarness();
    const store = new Store(harness);
    const records: GenerationHistoryRecord[] = [];
    let expectedActiveBytes = 0;
    for (let index = 0; index < 33; index += 1) {
      const suffix = index.toString(16).padStart(16, '0');
      const bytes = Buffer.concat([pngBytes, Buffer.from([index])]);
      const record = historyRecord(`history_${suffix}`, bytes);
      records.push(record);
      await store.ingest({ operationId: `operation_ingest_${suffix}`, record, source: chunks(bytes) });
      if (index < 32) expectedActiveBytes += bytes.byteLength;
    }
    const missing = records[32]!;
    await rm(join(harness.historyRoot, 'originals', `${missing.output!.historyAssetId}.png`));

    await expect(new Store(harness).getCapacity()).resolves.toEqual({
      activeBytes: expectedActiveBytes,
      activeCount: 33,
      trashBytes: 0,
      trashCount: 0,
      missingOrCorruptCount: 1,
    });
  }, 20_000);

  it('hashes capacity originals outside the global lock so mutations can commit during a slow audit', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    const harness = await createHarness();
    const record = historyRecord('history_aaaaaaaaaaaaaaaa', pngBytes);
    await new Store(harness).ingest({ operationId: 'operation_ingest_aaaaaaaa', record, source: chunks(pngBytes) });
    const hashEntered = deferred<void>();
    const releaseHash = deferred<void>();
    const slow = new Store({
      ...harness,
      hashFile: async () => {
        hashEntered.resolve();
        await releaseHash.promise;
        return record.output!.sha256;
      },
    });
    const capacity = slow.getCapacity();
    await hashEntered.promise;
    const mutation = new Store(harness).setFavorite({
      operationId: 'operation_favorite_slowaudit',
      historyIds: [record.id],
      favorite: true,
    });

    const committedBeforeAuditFinished = await Promise.race([
      mutation.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    expect(committedBeforeAuditFinished).toBe(true);
    releaseHash.resolve();
    await expect(capacity).resolves.toMatchObject({ activeCount: 1 });
    expect((await new Store(harness).list({ filters: { trashState: 'all' } })).records[0]!.favorite).toBe(true);
  }, 5_000);

  it('canonicalizes set-like history id batches before binding operation receipts', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    const harness = await createHarness();
    const store = new Store(harness);
    const first = historyRecord('history_aaaaaaaaaaaaaaaa', pngBytes);
    const secondBytes = Buffer.concat([pngBytes, Buffer.from([0x01])]);
    const second = historyRecord('history_bbbbbbbbbbbbbbbb', secondBytes);
    await store.ingest({ operationId: 'operation_ingest_aaaaaaaa', record: first, source: chunks(pngBytes) });
    await store.ingest({ operationId: 'operation_ingest_bbbbbbbb', record: second, source: chunks(secondBytes) });

    await store.setFavorite({
      operationId: 'operation_favorite_setlike',
      historyIds: [second.id, first.id],
      favorite: true,
    });
    await expect(store.setFavorite({
      operationId: 'operation_favorite_setlike',
      historyIds: [first.id, second.id],
      favorite: true,
    })).resolves.toMatchObject({ records: [{ favorite: true }, { favorite: true }] });
  });

  it('retries write confinement when a canonical lock vanishes between lstat and realpath', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    const harness = await createHarness();
    const first = new Store(harness);
    const record = historyRecord('history_aaaaaaaaaaaaaaaa', pngBytes);
    await first.ingest({ operationId: 'operation_ingest_aaaaaaaa', record, source: chunks(pngBytes) });
    const entered = deferred<void>();
    const release = deferred<void>();
    const held = first.withAvailableAsset(record.id, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const raceFileSystem = new VanishingLockRealpathFileSystem();
    const second = new Store({ ...harness, fileSystem: raceFileSystem });
    const update = second.setFavorite({
      operationId: 'operation_favorite_aaaaaaaa',
      historyIds: [record.id],
      favorite: true,
    });
    await raceFileSystem.observed;
    release.resolve();

    await expect(update).resolves.toMatchObject({ records: [{ favorite: true }] });
    await held;
  });

  it('merges concurrent favorite, trash, and reference updates and keeps retries idempotent', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    expect(Store.prototype).toHaveProperty('setFavorite');
    expect(Store.prototype).toHaveProperty('softDelete');
    expect(Store.prototype).toHaveProperty('addProjectReferences');
    if (!('setFavorite' in Store.prototype) || !('softDelete' in Store.prototype)) return;
    const harness = await createHarness();
    const now = Date.parse('2026-07-21T00:00:00.000Z');
    const first = new Store({ ...harness, now: () => now });
    const record = historyRecord('history_aaaaaaaaaaaaaaaa', pngBytes);
    await first.ingest({ operationId: 'operation_ingest_aaaaaaaa', record, source: chunks(pngBytes) });
    const second = new Store({ ...harness, now: () => now });
    const third = new Store({ ...harness, now: () => now });
    const reference = {
      referenceId: 'reference_aaaaaaaaaaaaaaaa',
      projectId: 'project_0123456789abcdef',
      projectDisplayLabel: 'Summer campaign',
    };

    await Promise.all([
      first.setFavorite({
        operationId: 'operation_favorite_aaaaaaaa',
        historyIds: [record.id],
        favorite: true,
      }),
      second.softDelete({
        operationId: 'operation_trash_aaaaaaaa',
        historyIds: [record.id],
      }),
      third.addProjectReferences({
        operationId: 'operation_reference_aaaaaaaa',
        historyId: record.id,
        references: [reference],
      }),
    ]);
    await first.setFavorite({
      operationId: 'operation_favorite_aaaaaaaa',
      historyIds: [record.id],
      favorite: true,
    });
    await expect(first.setFavorite({
      operationId: 'operation_favorite_aaaaaaaa',
      historyIds: [record.id],
      favorite: false,
    })).rejects.toMatchObject({ code: 'HISTORY_INVALID_REQUEST' });

    const persisted = (await new Store({ ...harness, now: () => now }).list({
      filters: { trashState: 'all' },
    })).records[0]!;
    expect(persisted.favorite).toBe(true);
    expect(persisted.trash).toEqual({
      deletedAt: '2026-07-21T00:00:00.000Z',
      retentionDeadline: '2026-07-28T00:00:00.000Z',
    });
    expect(persisted.projectReferences).toEqual([reference]);
    expect(persisted.projectReferenceCount).toBe(1);
    expect(await readdir(join(harness.historyRoot, 'originals'))).toEqual([]);
    expect(await readdir(join(harness.historyRoot, 'trash'))).toEqual([
      `${record.output!.historyAssetId}.png`,
    ]);
  });

  it('replays a completed permanent deletion without requiring the removed record', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    const harness = await createHarness();
    const store = new Store(harness);
    const record = historyRecord('history_aaaaaaaaaaaaaaaa', pngBytes);
    await store.ingest({ operationId: 'operation_ingest_aaaaaaaa', record, source: chunks(pngBytes) });
    await store.softDelete({ operationId: 'operation_trash_aaaaaaaa', historyIds: [record.id] });

    const first = await store.permanentlyDelete({
      operationId: 'operation_delete_aaaaaaaa',
      historyIds: [record.id],
    });
    expect(first).toMatchObject({ protectedIds: [], purgedIds: [record.id] });
    await expect(store.permanentlyDelete({
      operationId: 'operation_delete_aaaaaaaa',
      historyIds: [record.id],
    })).resolves.toMatchObject({ protectedIds: [], purgedIds: [record.id] });
  });

  it('requires active records to enter trash before permanent deletion', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    const harness = await createHarness();
    const store = new Store(harness);
    const record = historyRecord('history_aaaaaaaaaaaaaaaa', pngBytes);
    await store.ingest({ operationId: 'operation_ingest_aaaaaaaa', record, source: chunks(pngBytes) });

    await expect(store.permanentlyDelete({
      operationId: 'operation_delete_active_aaaaaaaa',
      historyIds: [record.id],
    })).rejects.toMatchObject({ code: 'HISTORY_INVALID_REQUEST' });
    expect((await store.list({ filters: { trashState: 'all' } })).records).toEqual([record]);
    expect(await readdir(join(harness.historyRoot, 'originals'))).toEqual([
      `${record.output!.historyAssetId}.png`,
    ]);
  });

  it.each(['queued', 'running'] as const)(
    'does not permanently delete a trashed %s provider lifecycle record',
    async (status) => {
      const Store = requireHistoryStore();
      if (Store === null) return;
      const harness = await createHarness();
      const store = new Store(harness);
      const record = providerLifecycleRecord('history_provider_lifecycle', status);
      await store.upsertMetadata({
        operationId: 'operation_provider_lifecycle',
        record,
      });
      await store.softDelete({
        operationId: 'operation_trash_provider_lifecycle',
        historyIds: [record.id],
      });

      await expect(store.permanentlyDelete({
        operationId: 'operation_delete_provider_lifecycle',
        historyIds: [record.id],
      })).rejects.toMatchObject({ code: 'HISTORY_INVALID_REQUEST' });
      expect((await store.list({ filters: { trashState: 'all' } })).records).toHaveLength(1);
    },
  );

  it('restores within retention and purges expired files only after blocking references are removed', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    expect(Store.prototype).toHaveProperty('restore');
    expect(Store.prototype).toHaveProperty('purgeExpired');
    if (!('restore' in Store.prototype) || !('purgeExpired' in Store.prototype)) return;
    const harness = await createHarness();
    const deletedAt = Date.parse('2026-07-21T00:00:00.000Z');
    const store = new Store({ ...harness, now: () => deletedAt });
    const record = historyRecord('history_aaaaaaaaaaaaaaaa', pngBytes);
    await store.ingest({ operationId: 'operation_ingest_aaaaaaaa', record, source: chunks(pngBytes) });
    await store.addProjectReferences({
      operationId: 'operation_reference_aaaaaaaa',
      historyId: record.id,
      references: [{
        referenceId: 'reference_aaaaaaaaaaaaaaaa',
        projectId: 'project_0123456789abcdef',
        projectDisplayLabel: 'Summer campaign',
      }],
    });
    await store.softDelete({ operationId: 'operation_trash_aaaaaaaa', historyIds: [record.id] });
    await store.restore({ operationId: 'operation_restore_aaaaaaaa', historyIds: [record.id] });
    expect((await store.list({ filters: { trashState: 'all' } })).records[0]!.trash).toBeNull();
    expect(await readdir(join(harness.historyRoot, 'originals'))).toHaveLength(1);

    await store.softDelete({ operationId: 'operation_trash_bbbbbbbb', historyIds: [record.id] });
    const expired = new Store({ ...harness, now: () => deletedAt + 7 * 24 * 60 * 60 * 1_000 + 1 });
    const protectedResult = await expired.purgeExpired({ operationId: 'operation_purge_aaaaaaaa' });
    expect(protectedResult).toMatchObject({ protectedIds: [record.id], purgedIds: [] });
    await expect(expired.purgeExpired({ operationId: 'operation_purge_aaaaaaaa' }))
      .resolves.toMatchObject({ protectedIds: [record.id], purgedIds: [] });
    await expect(expired.permanentlyDelete({
      operationId: 'operation_delete_aaaaaaaa',
      historyIds: [record.id],
    })).rejects.toMatchObject({ code: 'HISTORY_INVALID_REQUEST' });

    await expired.removeProjectReferences({
      operationId: 'operation_unreference_aaaaaaaa',
      historyId: record.id,
      referenceIds: ['reference_aaaaaaaaaaaaaaaa'],
    });
    const purged = await expired.purgeExpired({ operationId: 'operation_purge_bbbbbbbb' });
    expect(purged).toMatchObject({ protectedIds: [], purgedIds: [record.id] });
    await expect(expired.purgeExpired({ operationId: 'operation_purge_bbbbbbbb' }))
      .resolves.toMatchObject({ protectedIds: [], purgedIds: [record.id] });
    expect((await expired.list({ filters: { trashState: 'all' } })).records).toEqual([]);
    expect(await readdir(join(harness.historyRoot, 'trash'))).toEqual([]);
  });

  it('reports missing and corrupt originals without deleting metadata and includes them in capacity', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    expect(Store.prototype).toHaveProperty('getCapacity');
    if (!('getCapacity' in Store.prototype)) return;
    const harness = await createHarness();
    const store = new Store(harness);
    const record = historyRecord('history_aaaaaaaaaaaaaaaa', pngBytes);
    await store.ingest({ operationId: 'operation_ingest_aaaaaaaa', record, source: chunks(pngBytes) });
    const originalPath = join(harness.historyRoot, 'originals', `${record.output!.historyAssetId}.png`);
    await rm(originalPath);

    const missing = (await store.list({ filters: { trashState: 'all' } })).records[0]!;
    expect(missing.id).toBe(record.id);
    expect(missing.output!.availability).toBe('missing');
    await writeFile(originalPath, Buffer.alloc(pngBytes.byteLength, 0x01));
    const corrupt = (await store.list({ filters: { trashState: 'all' } })).records[0]!;
    expect(corrupt.id).toBe(record.id);
    expect(corrupt.output!.availability).toBe('corrupt');
    await expect(store.getCapacity()).resolves.toEqual({
      activeBytes: 0,
      activeCount: 1,
      trashBytes: 0,
      trashCount: 0,
      missingOrCorruptCount: 1,
    });
  });

  it('moves a confined corrupt original into trash and removes it on permanent deletion', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    const harness = await createHarness();
    const store = new Store(harness);
    const record = historyRecord('history_aaaaaaaaaaaaaaaa', pngBytes);
    await store.ingest({ operationId: 'operation_ingest_aaaaaaaa', record, source: chunks(pngBytes) });
    const originalPath = join(harness.historyRoot, 'originals', `${record.output!.historyAssetId}.png`);
    await writeFile(originalPath, Buffer.from('corrupt'));
    expect((await store.list({ filters: { trashState: 'all' } })).records[0]!.output?.availability).toBe('corrupt');
    await store.softDelete({
      operationId: 'operation_trash_corrupt_aaaaaaaa',
      historyIds: [record.id],
    });
    expect(await readdir(join(harness.historyRoot, 'originals'))).toEqual([]);
    expect(await readdir(join(harness.historyRoot, 'trash'))).toEqual([
      `${record.output!.historyAssetId}.png`,
    ]);

    await store.permanentlyDelete({
      operationId: 'operation_delete_aaaaaaaa',
      historyIds: [record.id],
    });
    expect((await store.list({ filters: { trashState: 'all' } })).records).toEqual([]);
    expect(await readdir(join(harness.historyRoot, 'originals'))).toEqual([]);
    expect((await readdir(join(harness.historyRoot, 'recovery')))
      .some((entry) => entry.startsWith('.history-purge-'))).toBe(false);
  });

  it('repairs an interrupted trash move from the durable index in the same process and after restart', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    const harness = await createHarness();
    const fileSystem = new InterruptedTrashMoveFileSystem();
    const store = new Store({ ...harness, fileSystem });
    const record = historyRecord('history_aaaaaaaaaaaaaaaa', pngBytes);
    await store.ingest({ operationId: 'operation_ingest_aaaaaaaa', record, source: chunks(pngBytes) });
    fileSystem.arm();

    await expect(store.softDelete({
      operationId: 'operation_trash_interrupted_aaaaaaaa',
      historyIds: [record.id],
    })).rejects.toMatchObject({ code: 'HISTORY_WRITE_FAILED' });
    expect(await readdir(join(harness.historyRoot, 'originals'))).toEqual([]);
    expect(await readdir(join(harness.historyRoot, 'trash'))).toEqual([
      `${record.output!.historyAssetId}.png`,
    ]);

    fileSystem.disarm();
    const persisted = (await store.list({ filters: { trashState: 'all' } })).records[0]!;
    expect(persisted.trash).toBeNull();
    expect(persisted.output?.availability).toBe('available');
    expect(await readdir(join(harness.historyRoot, 'originals'))).toEqual([
      `${record.output!.historyAssetId}.png`,
    ]);
    expect(await readdir(join(harness.historyRoot, 'trash'))).toEqual([]);
    await expect(new Store(harness).list({ filters: { trashState: 'all' } }))
      .resolves.toMatchObject({ records: [expect.objectContaining({ id: record.id, trash: null })] });
  });

  it('repairs an interrupted restore move in the same process', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    const harness = await createHarness();
    const fileSystem = new InterruptedRestoreMoveFileSystem();
    const store = new Store({ ...harness, fileSystem });
    const record = historyRecord('history_restore_same_process', pngBytes);
    await store.ingest({ operationId: 'operation_ingest_restore_same_process', record, source: chunks(pngBytes) });
    await store.softDelete({
      operationId: 'operation_trash_restore_same_process',
      historyIds: [record.id],
    });
    fileSystem.arm();

    await expect(store.restore({
      operationId: 'operation_restore_same_process',
      historyIds: [record.id],
    })).rejects.toMatchObject({ code: 'HISTORY_WRITE_FAILED' });
    expect(await readdir(join(harness.historyRoot, 'originals'))).toEqual([
      `${record.output!.historyAssetId}.png`,
    ]);
    expect(await readdir(join(harness.historyRoot, 'trash'))).toEqual([]);

    fileSystem.disarm();
    const persisted = (await store.list({ filters: { trashState: 'all' } })).records[0]!;
    expect(persisted.trash).not.toBeNull();
    expect(persisted.output?.availability).toBe('available');
    expect(await readdir(join(harness.historyRoot, 'originals'))).toEqual([]);
    expect(await readdir(join(harness.historyRoot, 'trash'))).toEqual([
      `${record.output!.historyAssetId}.png`,
    ]);
  });

  it('rolls back deletion staging on restart when the durable index still references the original', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    const harness = await createHarness();
    const fileSystem = new InterruptedDeletionFileSystem();
    const store = new Store({ ...harness, fileSystem });
    const record = historyRecord('history_aaaaaaaaaaaaaaaa', pngBytes);
    await store.ingest({ operationId: 'operation_ingest_aaaaaaaa', record, source: chunks(pngBytes) });
    await store.softDelete({ operationId: 'operation_trash_aaaaaaaa', historyIds: [record.id] });
    fileSystem.arm();

    await expect(store.permanentlyDelete({
      operationId: 'operation_delete_aaaaaaaa',
      historyIds: [record.id],
    })).rejects.toMatchObject({ code: 'HISTORY_WRITE_FAILED' });
    expect(await readdir(join(harness.historyRoot, 'trash'))).toEqual([]);
    expect((await readdir(join(harness.historyRoot, 'recovery')))
      .some((entry) => entry.startsWith('.history-purge-'))).toBe(true);

    const reopened = new Store(harness);
    expect((await reopened.list({ filters: { trashState: 'all' } })).records[0]!.trash).not.toBeNull();
    expect(await readFile(join(
      harness.historyRoot,
      'trash',
      `${record.output!.historyAssetId}.png`,
    ))).toEqual(pngBytes);
    expect((await readdir(join(harness.historyRoot, 'recovery')))
      .some((entry) => entry.startsWith('.history-purge-'))).toBe(false);
  });

  it('restores a corrupt staged original after an interrupted permanent-delete index commit', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    const harness = await createHarness();
    const fileSystem = new InterruptedDeletionFileSystem();
    const store = new Store({ ...harness, fileSystem });
    const record = historyRecord('history_corrupt_restart', pngBytes);
    await store.ingest({ operationId: 'operation_ingest_corrupt_restart', record, source: chunks(pngBytes) });
    const originalPath = join(harness.historyRoot, 'originals', `${record.output!.historyAssetId}.png`);
    await writeFile(originalPath, Buffer.from('corrupt'));
    await store.softDelete({
      operationId: 'operation_trash_corrupt_restart',
      historyIds: [record.id],
    });
    fileSystem.arm();

    await expect(store.permanentlyDelete({
      operationId: 'operation_delete_corrupt_restart',
      historyIds: [record.id],
    })).rejects.toMatchObject({ code: 'HISTORY_WRITE_FAILED' });

    const reopened = new Store(harness);
    const persisted = (await reopened.list({ filters: { trashState: 'all' } })).records[0]!;
    expect(persisted.output?.availability).toBe('corrupt');
    expect(await readFile(join(
      harness.historyRoot,
      'trash',
      `${record.output!.historyAssetId}.png`,
    ))).toEqual(Buffer.from('corrupt'));
  });

  it('does not report permanent deletion complete until staged cleanup succeeds', async () => {
    const Store = requireHistoryStore();
    if (Store === null) return;
    const harness = await createHarness();
    const fileSystem = new FailingDeletionCleanupFileSystem();
    const store = new Store({ ...harness, fileSystem });
    const record = historyRecord('history_cleanup_retry', pngBytes);
    await store.ingest({ operationId: 'operation_ingest_cleanup_retry', record, source: chunks(pngBytes) });
    await store.softDelete({
      operationId: 'operation_trash_cleanup_retry',
      historyIds: [record.id],
    });
    fileSystem.arm();

    await expect(store.permanentlyDelete({
      operationId: 'operation_delete_cleanup_retry',
      historyIds: [record.id],
    })).rejects.toMatchObject({ code: 'HISTORY_WRITE_FAILED' });
    expect((await readdir(join(harness.historyRoot, 'recovery')))
      .some((entry) => entry.startsWith('.history-purge-'))).toBe(true);

    fileSystem.disarm();
    await expect(store.permanentlyDelete({
      operationId: 'operation_delete_cleanup_retry',
      historyIds: [record.id],
    })).resolves.toMatchObject({ purgedIds: [record.id] });
    expect((await readdir(join(harness.historyRoot, 'recovery')))
      .some((entry) => entry.startsWith('.history-purge-'))).toBe(false);
  });
});

function requireHistoryStore(): HistoryStoreConstructor | null {
  expect(desktopCore).toHaveProperty('GenerationHistoryStore');
  const candidate = (desktopCore as Record<string, unknown>).GenerationHistoryStore;
  return typeof candidate === 'function' ? candidate as HistoryStoreConstructor : null;
}

async function createHarness(): Promise<{ historyRoot: string; ownedRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'generation-history-'));
  tempRoots.push(root);
  const ownedRoot = join(root, 'user-data');
  const historyRoot = join(ownedRoot, 'generation-history');
  await mkdir(ownedRoot);
  return { historyRoot, ownedRoot };
}

function historyRecord(id: string, bytes: Uint8Array): GenerationHistoryRecord {
  return historyRecordAt(id, bytes, '2026-07-18T12:00:00.000Z');
}

function providerLifecycleRecord(
  id: string,
  status: 'queued' | 'running',
): GenerationHistoryRecord {
  const timestamp = '2026-07-18T12:00:00.000Z';
  return parseGenerationHistoryRecord({
    schemaVersion: 1,
    id,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    project: null,
    job: { jobId: `job_${id}` },
    status,
    provider: {
      displayName: 'Comfly',
      modelDisplayName: 'Image Studio',
      capabilityRevision: 'image-v3',
    },
    promptSummary: 'Image generation request',
    parameters: {},
    output: null,
    favorite: false,
    tags: [],
    projectReferenceCount: 0,
    projectReferences: [],
    trash: null,
    termination: null,
  });
}

function historyRecordAt(id: string, bytes: Uint8Array, createdAt: string): GenerationHistoryRecord {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const completedAt = new Date(Date.parse(createdAt) + 2_000).toISOString();
  return parseGenerationHistoryRecord({
    schemaVersion: 1,
    id,
    createdAt,
    updatedAt: completedAt,
    completedAt,
    project: { projectId: 'project_0123456789abcdef', displayLabel: 'Summer campaign' },
    job: { jobId: `job_${id.slice(-16)}`, resultId: `result_${id.slice(-16)}` },
    status: 'succeeded',
    provider: {
      displayName: 'Comfly',
      modelDisplayName: 'Image Studio',
      capabilityRevision: 'image-v3',
    },
    promptSummary: 'Product on a quiet blue studio background',
    parameters: { aspectRatio: '1:1', quality: 'high', seed: 42, steps: 32 },
    output: {
      width: 2,
      height: 3,
      format: 'png',
      mediaType: 'image/png',
      byteSize: bytes.byteLength,
      availability: 'available',
      historyAssetId: `history_asset_${id.slice(-16)}`,
      sha256,
    },
    favorite: false,
    tags: ['studio'],
    projectReferenceCount: 0,
    projectReferences: [],
    trash: null,
    termination: null,
  });
}

function failedTrashedHistoryRecord(index: number): GenerationHistoryRecord {
  const suffix = index.toString(16).padStart(16, '0');
  return parseGenerationHistoryRecord({
    schemaVersion: 1,
    id: `history_${suffix}`,
    createdAt: '2026-07-18T12:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    completedAt: '2026-07-18T12:00:02.000Z',
    project: null,
    job: { jobId: `job_${suffix}` },
    status: 'failed',
    provider: {
      displayName: 'Comfly',
      modelDisplayName: 'Image Studio',
      capabilityRevision: 'image-v3',
    },
    promptSummary: 'Generation failed before producing an output',
    parameters: {},
    output: null,
    favorite: false,
    tags: [],
    projectReferenceCount: 0,
    projectReferences: [],
    trash: {
      deletedAt: '2026-07-21T00:00:00.000Z',
      retentionDeadline: '2026-07-28T00:00:00.000Z',
    },
    termination: { code: 'provider_failed', message: 'Generation failed' },
  });
}

function metadataHistoryRecord(
  id: string,
  status: 'queued' | 'running' | 'failed' | 'cancelled',
): GenerationHistoryRecord {
  const terminal = status === 'failed' || status === 'cancelled';
  const completedAt = terminal ? '2026-07-18T12:00:02.000Z' : null;
  return parseGenerationHistoryRecord({
    schemaVersion: 1,
    id,
    createdAt: '2026-07-18T12:00:00.000Z',
    updatedAt: status === 'queued' ? '2026-07-18T12:00:00.000Z' : '2026-07-18T12:00:02.000Z',
    completedAt,
    project: null,
    job: { jobId: `job_${id.slice(-16)}` },
    status,
    provider: {
      displayName: 'Comfly',
      modelDisplayName: 'Image Studio',
      capabilityRevision: 'image-v3',
    },
    promptSummary: 'Image generation request',
    parameters: {},
    output: null,
    favorite: false,
    tags: [],
    projectReferenceCount: 0,
    projectReferences: [],
    trash: null,
    termination: status === 'failed'
      ? { code: 'provider_failed', message: 'Generation failed' }
      : status === 'cancelled'
        ? { code: 'cancelled_by_user', message: 'Generation cancelled' }
        : null,
  });
}

async function* chunks(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  const middle = Math.max(1, Math.floor(bytes.byteLength / 2));
  yield bytes.subarray(0, middle);
  yield bytes.subarray(middle);
}

class IndexFaultFileSystem implements FileSystem {
  private readonly delegate = new NodeFileSystem();
  private errno: string | null = null;
  private failAfterRename = false;

  arm(errno: string, failAfterRename: boolean): void {
    this.errno = errno;
    this.failAfterRename = failAfterRename;
  }

  async link(source: string, destination: string): Promise<void> { await this.delegate.link!(source, destination); }
  async lstat(path: string): Promise<FileStatLike> { return this.delegate.lstat!(path); }
  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> { await this.delegate.mkdir(path, options); }
  async open(path: string, flags: string): Promise<FileHandleLike> {
    if (this.errno !== null && !this.failAfterRename && basename(path).startsWith('.history.index.json.tmp-')) {
      const errno = this.errno;
      this.errno = null;
      throw Object.assign(new Error('injected history index open failure'), { code: errno });
    }
    return this.delegate.open(path, flags);
  }
  async readFile(path: string, encoding: BufferEncoding): Promise<string> { return this.delegate.readFile(path, encoding); }
  async readFileBuffer(path: string): Promise<Uint8Array> { return this.delegate.readFileBuffer!(path); }
  async readdir(path: string): Promise<string[]> { return this.delegate.readdir(path); }
  async realpath(path: string): Promise<string> { return this.delegate.realpath!(path); }
  async rename(source: string, destination: string): Promise<void> {
    await this.delegate.rename(source, destination);
    if (this.errno !== null && this.failAfterRename && basename(destination) === 'history.index.json') {
      const errno = this.errno;
      this.errno = null;
      throw Object.assign(new Error('injected history index interruption'), { code: errno });
    }
  }
  async rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void> { await this.delegate.rm(path, options); }
  async stat(path: string): Promise<FileStatLike> { return this.delegate.stat(path); }
  async truncate(path: string, length: number): Promise<void> { await this.delegate.truncate!(path, length); }
  async unlink(path: string): Promise<void> { await this.delegate.unlink(path); }
  async writeFile(path: string, data: string, encoding: BufferEncoding): Promise<void> {
    await this.delegate.writeFile(path, data, encoding);
  }
}

class VanishingLockRealpathFileSystem implements FileSystem {
  private readonly delegate = new NodeFileSystem();
  private thrown = false;
  private readonly observation = deferred<void>();
  readonly observed = this.observation.promise;

  async link(source: string, destination: string): Promise<void> { await this.delegate.link!(source, destination); }
  async lstat(path: string): Promise<FileStatLike> { return this.delegate.lstat!(path); }
  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> { await this.delegate.mkdir(path, options); }
  async open(path: string, flags: string): Promise<FileHandleLike> { return this.delegate.open(path, flags); }
  async readFile(path: string, encoding: BufferEncoding): Promise<string> { return this.delegate.readFile(path, encoding); }
  async readFileBuffer(path: string): Promise<Uint8Array> { return this.delegate.readFileBuffer!(path); }
  async readdir(path: string): Promise<string[]> { return this.delegate.readdir(path); }
  async realpath(path: string): Promise<string> {
    if (!this.thrown && basename(path) === 'history.lock') {
      this.thrown = true;
      this.observation.resolve();
      throw Object.assign(new Error('lock vanished during realpath'), { code: 'ENOENT' });
    }
    return this.delegate.realpath!(path);
  }
  async rename(source: string, destination: string): Promise<void> { await this.delegate.rename(source, destination); }
  async rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void> { await this.delegate.rm(path, options); }
  async stat(path: string): Promise<FileStatLike> { return this.delegate.stat(path); }
  async truncate(path: string, length: number): Promise<void> { await this.delegate.truncate!(path, length); }
  async unlink(path: string): Promise<void> { await this.delegate.unlink(path); }
  async writeFile(path: string, data: string, encoding: BufferEncoding): Promise<void> {
    await this.delegate.writeFile(path, data, encoding);
  }
}

class CorruptAfterIndexRenameFileSystem implements FileSystem {
  private readonly delegate = new NodeFileSystem();
  private armed = false;

  arm(): void { this.armed = true; }

  async link(source: string, destination: string): Promise<void> { await this.delegate.link!(source, destination); }
  async lstat(path: string): Promise<FileStatLike> { return this.delegate.lstat!(path); }
  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> { await this.delegate.mkdir(path, options); }
  async open(path: string, flags: string): Promise<FileHandleLike> { return this.delegate.open(path, flags); }
  async readFile(path: string, encoding: BufferEncoding): Promise<string> { return this.delegate.readFile(path, encoding); }
  async readFileBuffer(path: string): Promise<Uint8Array> { return this.delegate.readFileBuffer!(path); }
  async readdir(path: string): Promise<string[]> { return this.delegate.readdir(path); }
  async realpath(path: string): Promise<string> { return this.delegate.realpath!(path); }
  async rename(source: string, destination: string): Promise<void> {
    await this.delegate.rename(source, destination);
    if (this.armed && basename(destination) === 'history.index.json') {
      this.armed = false;
      await this.delegate.writeFile(destination, 'corrupt', 'utf8');
    }
  }
  async rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void> { await this.delegate.rm(path, options); }
  async stat(path: string): Promise<FileStatLike> { return this.delegate.stat(path); }
  async truncate(path: string, length: number): Promise<void> { await this.delegate.truncate!(path, length); }
  async unlink(path: string): Promise<void> { await this.delegate.unlink(path); }
  async writeFile(path: string, data: string, encoding: BufferEncoding): Promise<void> {
    await this.delegate.writeFile(path, data, encoding);
  }
}

class InterruptedDeletionFileSystem implements FileSystem {
  private readonly delegate = new NodeFileSystem();
  private armed = false;
  private staged = false;
  private failedIndexWrite = false;

  arm(): void { this.armed = true; }

  async link(source: string, destination: string): Promise<void> { await this.delegate.link!(source, destination); }
  async lstat(path: string): Promise<FileStatLike> { return this.delegate.lstat!(path); }
  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> { await this.delegate.mkdir(path, options); }
  async open(path: string, flags: string): Promise<FileHandleLike> {
    if (
      this.armed
      && this.staged
      && !this.failedIndexWrite
      && basename(path).startsWith('.history.index.json.tmp-')
    ) {
      this.failedIndexWrite = true;
      throw Object.assign(new Error('injected interrupted deletion index write'), { code: 'EIO' });
    }
    return this.delegate.open(path, flags);
  }
  async readFile(path: string, encoding: BufferEncoding): Promise<string> { return this.delegate.readFile(path, encoding); }
  async readFileBuffer(path: string): Promise<Uint8Array> { return this.delegate.readFileBuffer!(path); }
  async readdir(path: string): Promise<string[]> { return this.delegate.readdir(path); }
  async realpath(path: string): Promise<string> { return this.delegate.realpath!(path); }
  async rename(source: string, destination: string): Promise<void> {
    if (this.armed && basename(source).startsWith('.history-purge-')) {
      throw Object.assign(new Error('injected interrupted deletion rollback'), { code: 'EIO' });
    }
    await this.delegate.rename(source, destination);
    if (this.armed && basename(destination).startsWith('.history-purge-')) this.staged = true;
  }
  async rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void> { await this.delegate.rm(path, options); }
  async stat(path: string): Promise<FileStatLike> { return this.delegate.stat(path); }
  async truncate(path: string, length: number): Promise<void> { await this.delegate.truncate!(path, length); }
  async unlink(path: string): Promise<void> { await this.delegate.unlink(path); }
  async writeFile(path: string, data: string, encoding: BufferEncoding): Promise<void> {
    await this.delegate.writeFile(path, data, encoding);
  }
}

class InterruptedTrashMoveFileSystem implements FileSystem {
  private readonly delegate = new NodeFileSystem();
  private armed = false;
  private movedToTrash = false;
  private failedIndexWrite = false;

  arm(): void { this.armed = true; }
  disarm(): void { this.armed = false; }

  async link(source: string, destination: string): Promise<void> { await this.delegate.link!(source, destination); }
  async lstat(path: string): Promise<FileStatLike> { return this.delegate.lstat!(path); }
  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> { await this.delegate.mkdir(path, options); }
  async open(path: string, flags: string): Promise<FileHandleLike> {
    if (
      this.armed
      && this.movedToTrash
      && !this.failedIndexWrite
      && basename(path).startsWith('.history.index.json.tmp-')
    ) {
      this.failedIndexWrite = true;
      throw Object.assign(new Error('injected interrupted trash index write'), { code: 'EIO' });
    }
    return this.delegate.open(path, flags);
  }
  async readFile(path: string, encoding: BufferEncoding): Promise<string> { return this.delegate.readFile(path, encoding); }
  async readFileBuffer(path: string): Promise<Uint8Array> { return this.delegate.readFileBuffer!(path); }
  async readdir(path: string): Promise<string[]> { return this.delegate.readdir(path); }
  async realpath(path: string): Promise<string> { return this.delegate.realpath!(path); }
  async rename(source: string, destination: string): Promise<void> {
    const sourceDirectory = basename(dirname(source));
    const destinationDirectory = basename(dirname(destination));
    if (this.armed && this.movedToTrash && sourceDirectory === 'trash' && destinationDirectory === 'originals') {
      throw Object.assign(new Error('injected interrupted trash rollback'), { code: 'EIO' });
    }
    await this.delegate.rename(source, destination);
    if (this.armed && sourceDirectory === 'originals' && destinationDirectory === 'trash') this.movedToTrash = true;
  }
  async rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void> { await this.delegate.rm(path, options); }
  async stat(path: string): Promise<FileStatLike> { return this.delegate.stat(path); }
  async truncate(path: string, length: number): Promise<void> { await this.delegate.truncate!(path, length); }
  async unlink(path: string): Promise<void> { await this.delegate.unlink(path); }
  async writeFile(path: string, data: string, encoding: BufferEncoding): Promise<void> {
    await this.delegate.writeFile(path, data, encoding);
  }
}

class InterruptedRestoreMoveFileSystem implements FileSystem {
  private readonly delegate = new NodeFileSystem();
  private armed = false;
  private movedToOriginals = false;
  private failedIndexWrite = false;

  arm(): void { this.armed = true; }
  disarm(): void { this.armed = false; }

  async link(source: string, destination: string): Promise<void> { await this.delegate.link!(source, destination); }
  async lstat(path: string): Promise<FileStatLike> { return this.delegate.lstat!(path); }
  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> { await this.delegate.mkdir(path, options); }
  async open(path: string, flags: string): Promise<FileHandleLike> {
    if (
      this.armed
      && this.movedToOriginals
      && !this.failedIndexWrite
      && basename(path).startsWith('.history.index.json.tmp-')
    ) {
      this.failedIndexWrite = true;
      throw Object.assign(new Error('injected interrupted restore index write'), { code: 'EIO' });
    }
    return this.delegate.open(path, flags);
  }
  async readFile(path: string, encoding: BufferEncoding): Promise<string> { return this.delegate.readFile(path, encoding); }
  async readFileBuffer(path: string): Promise<Uint8Array> { return this.delegate.readFileBuffer!(path); }
  async readdir(path: string): Promise<string[]> { return this.delegate.readdir(path); }
  async realpath(path: string): Promise<string> { return this.delegate.realpath!(path); }
  async rename(source: string, destination: string): Promise<void> {
    const sourceDirectory = basename(dirname(source));
    const destinationDirectory = basename(dirname(destination));
    if (this.armed && this.movedToOriginals && sourceDirectory === 'originals' && destinationDirectory === 'trash') {
      throw Object.assign(new Error('injected interrupted restore rollback'), { code: 'EIO' });
    }
    await this.delegate.rename(source, destination);
    if (this.armed && sourceDirectory === 'trash' && destinationDirectory === 'originals') this.movedToOriginals = true;
  }
  async rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void> { await this.delegate.rm(path, options); }
  async stat(path: string): Promise<FileStatLike> { return this.delegate.stat(path); }
  async truncate(path: string, length: number): Promise<void> { await this.delegate.truncate!(path, length); }
  async unlink(path: string): Promise<void> { await this.delegate.unlink(path); }
  async writeFile(path: string, data: string, encoding: BufferEncoding): Promise<void> {
    await this.delegate.writeFile(path, data, encoding);
  }
}

class FailingDeletionCleanupFileSystem implements FileSystem {
  private readonly delegate = new NodeFileSystem();
  private armed = false;

  arm(): void { this.armed = true; }
  disarm(): void { this.armed = false; }

  async link(source: string, destination: string): Promise<void> { await this.delegate.link!(source, destination); }
  async lstat(path: string): Promise<FileStatLike> { return this.delegate.lstat!(path); }
  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> { await this.delegate.mkdir(path, options); }
  async open(path: string, flags: string): Promise<FileHandleLike> { return this.delegate.open(path, flags); }
  async readFile(path: string, encoding: BufferEncoding): Promise<string> { return this.delegate.readFile(path, encoding); }
  async readFileBuffer(path: string): Promise<Uint8Array> { return this.delegate.readFileBuffer!(path); }
  async readdir(path: string): Promise<string[]> { return this.delegate.readdir(path); }
  async realpath(path: string): Promise<string> { return this.delegate.realpath!(path); }
  async rename(source: string, destination: string): Promise<void> { await this.delegate.rename(source, destination); }
  async rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void> {
    if (this.armed && basename(path).startsWith('.history-purge-')) {
      throw Object.assign(new Error('injected deletion cleanup failure'), { code: 'EIO' });
    }
    await this.delegate.rm(path, options);
  }
  async stat(path: string): Promise<FileStatLike> { return this.delegate.stat(path); }
  async truncate(path: string, length: number): Promise<void> { await this.delegate.truncate!(path, length); }
  async unlink(path: string): Promise<void> { await this.delegate.unlink(path); }
  async writeFile(path: string, data: string, encoding: BufferEncoding): Promise<void> {
    await this.delegate.writeFile(path, data, encoding);
  }
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value?: T): void } {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve: (value?: T) => resolvePromise(value as T),
  };
}
