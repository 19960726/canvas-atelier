import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';

import {
  applyProjectTransaction,
  type CanvasProject,
  type ProjectTransaction,
} from '@agent-canvas/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { canonicalJson } from './canonical-json';
import { type CommitRequest, type JournalRecord } from './contracts';
import { NodeFileSystem, type FileHandleLike, type FileSystem } from './file-system';
import {
  JournalWriter,
  readValidJournal,
  replayJournal,
  resetJournalWriterRegistryForTests,
} from './journal-writer';
import { ProjectRepository } from './project-repository';

const baseNow = new Date('2026-07-14T12:00:00.000Z');

describe('JournalWriter', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    resetJournalWriterRegistryForTests();
    await Promise.all(
      tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { force: true, recursive: true })),
    );
  });

  it('acknowledges only after append and sync complete', async () => {
    const { activeJournal, writer } = await createWriter(tempRoots);
    const request = makeRequest('tx-sync-gated');
    const syncGate = createSyncGate();

    const pending = writer.commit(request, { syncGate });
    await syncGate.entered;

    await expect(Promise.race([pending, Promise.resolve('not-acked')])).resolves.toBe('not-acked');
    expect(await readFile(activeJournal, 'utf8')).toContain('"transactionId":"tx-sync-gated"');

    syncGate.release();

    await expect(pending).resolves.toMatchObject({
      transactionId: request.transaction.id,
      revision: 1,
      sequence: 1,
    });
  });

  it('returns the original acknowledgement for a duplicate transaction id', async () => {
    const { activeJournal, writer } = await createWriter(tempRoots);
    const request = makeRequest('tx-duplicate');

    const first = await writer.commit(request);
    const second = await writer.commit(request);

    expect(second).toEqual(first);
    expect((await readValidJournal(activeJournal)).records).toHaveLength(1);
  });

  it('rejects a duplicate transaction id with a different payload without appending', async () => {
    const { activeJournal, writer } = await createWriter(tempRoots);
    const request = makeRequest('tx-conflicting-duplicate');
    await writer.commit(request);

    await expect(
      writer.commit({
        ...request,
        transaction: {
          ...request.transaction,
          label: 'different payload',
        },
      }),
    ).rejects.toMatchObject({ code: 'CORRUPT_JOURNAL' });

    expect((await readValidJournal(activeJournal)).records).toHaveLength(1);
  });

  it('rejects a stale base revision without appending', async () => {
    const { activeJournal, writer } = await createWriter(tempRoots);
    const request = makeRequest('tx-stale', 9);

    await expect(writer.commit(request)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await readFile(activeJournal, 'utf8')).toBe('');
  });

  it('serializes concurrent commits by sequence and revision', async () => {
    const { activeJournal, writer } = await createWriter(tempRoots);
    const firstRequest = makeRequest('tx-concurrent-1', 0, makeCreatePromptTransaction('tx-concurrent-1', 'prompt-1'));
    const secondRequest = makeRequest('tx-concurrent-2', 1, makeCreatePromptTransaction('tx-concurrent-2', 'prompt-2'));

    const [firstAck, secondAck] = await Promise.all([
      writer.commit(firstRequest),
      writer.commit(secondRequest),
    ]);

    expect(firstAck).toMatchObject({ revision: 1, sequence: 1 });
    expect(secondAck).toMatchObject({ revision: 2, sequence: 2 });

    const read = await readValidJournal(activeJournal);
    expect(read.records.map((record) => [record.transactionId, record.sequence, record.revision])).toEqual([
      ['tx-concurrent-1', 1, 1],
      ['tx-concurrent-2', 2, 2],
    ]);
  });

  it('reconstructs idempotency from the journal after reopening', async () => {
    const { activeJournal, writer } = await createWriter(tempRoots);
    const request = makeRequest('tx-restart-idempotent');
    const originalAck = await writer.commit(request);

    const reopened = await JournalWriter.open({
      activeJournalPath: activeJournal,
      baseRevision: 0,
      nextSequence: 1,
      projectId: 'project-journal',
      now: () => baseNow,
    });
    const duplicateAck = await reopened.commit(request);

    expect(duplicateAck).toEqual(originalAck);
    expect((await readValidJournal(activeJournal)).records).toHaveLength(1);
  });

  it('reads a complete journal and replays it', async () => {
    const { activeJournal, writer } = await createWriter(tempRoots);
    await writer.commit(makeRequest('tx-read-1', 0, makeCreatePromptTransaction('tx-read-1', 'prompt-1')));
    await writer.commit(makeRequest('tx-read-2', 1, makeCreatePromptTransaction('tx-read-2', 'prompt-2')));

    const read = await readValidJournal(activeJournal);
    const replayed = replayJournal(makeProject(), 0, read.records);

    expect(read.tailStatus).toBe('complete');
    expect(read.validBytes).toBe(Buffer.byteLength(await readFile(activeJournal, 'utf8'), 'utf8'));
    expect(replayed).toMatchObject({ revision: 2 });
    expect(replayed.project.nodes.map((node) => node.id)).toEqual(['prompt-1', 'prompt-2']);
  });

  it('tolerates only an incomplete final line and reports validBytes', async () => {
    const { activeJournal, writer } = await createWriter(tempRoots);
    await writer.commit(makeRequest('tx-partial', 0));
    const complete = await readFile(activeJournal, 'utf8');
    await writeFile(activeJournal, `${complete}{"schemaVersion":`, 'utf8');

    const read = await readValidJournal(activeJournal);

    expect(read.records).toHaveLength(1);
    expect(read.validBytes).toBe(Buffer.byteLength(complete, 'utf8'));
    expect(read.tailStatus).toBe('partial_final_line');
  });

  it.each([
    ['checksum mismatch', (records: JournalRecord[]) => ({ ...records[0]!, label: 'tampered label' })],
    ['sequence mismatch', (records: JournalRecord[]) => signRecord({ ...withoutChecksum(records[0]!), sequence: 3 })],
    ['revision mismatch', (records: JournalRecord[]) => signRecord({ ...withoutChecksum(records[0]!), revision: 3 })],
    ['project mismatch', (records: JournalRecord[]) => signRecord({ ...withoutChecksum(records[0]!), projectId: 'other-project' })],
  ])('treats a complete %s before the tail as corrupt', async (_caseName, mutate) => {
    const { activeJournal, writer } = await createWriter(tempRoots);
    await writer.commit(makeRequest('tx-corrupt'));
    const [record] = (await readValidJournal(activeJournal)).records;
    await writeFile(activeJournal, `${canonicalJson(mutate([record!]))}\n`, 'utf8');

    await expect(
      readValidJournal(activeJournal, { expectedProjectId: 'project-journal' }),
    ).rejects.toMatchObject({ code: 'CORRUPT_JOURNAL' });
  });

  it('treats a malformed complete final line as corrupt', async () => {
    const { activeJournal, writer } = await createWriter(tempRoots);
    await writer.commit(makeRequest('tx-malformed-final'));
    await writeFile(activeJournal, `${await readFile(activeJournal, 'utf8')}not-json\n`, 'utf8');

    await expect(readValidJournal(activeJournal)).rejects.toMatchObject({ code: 'CORRUPT_JOURNAL' });
  });

  it('replays through applyProjectTransaction with operation order preserved', async () => {
    const { activeJournal, writer } = await createWriter(tempRoots);
    const orderedTransaction: ProjectTransaction = {
      id: 'tx-ordered',
      label: 'ordered graph creation',
      operations: [
        { kind: 'canvas', operation: { kind: 'create_node', node: makePromptNode('prompt-a') } },
        { kind: 'canvas', operation: { kind: 'create_node', node: makePromptNode('prompt-b') } },
        {
          kind: 'canvas',
          operation: {
            kind: 'create_edge',
            edge: { id: 'edge-a-b', source: 'prompt-a', target: 'prompt-b' },
          },
        },
      ],
    };

    await writer.commit(makeRequest('tx-ordered', 0, orderedTransaction));

    const records = (await readValidJournal(activeJournal)).records;
    const replayed = replayJournal(makeProject(), 0, records);
    const direct = applyProjectTransaction(makeProject(), orderedTransaction);

    expect(records[0]!.operations.map((operation) => operation.kind)).toEqual([
      'canvas',
      'canvas',
      'canvas',
    ]);
    expect(replayed.project).toEqual(direct);
  });

  it('does not acknowledge or advance in-memory revision when the append fails', async () => {
    const { activeJournal, projectRoot } = await createJournalFile(tempRoots);
    const writer = await JournalWriter.open({
      activeJournalPath: activeJournal,
      baseRevision: 0,
      fileSystem: new FailWriteFileSystem(activeJournal),
      nextSequence: 1,
      projectId: 'project-journal',
      now: () => baseNow,
    });

    await expect(writer.commit(makeRequest('tx-write-fails'))).rejects.toThrow(/injected write failure/i);

    const recovered = await JournalWriter.open({
      activeJournalPath: activeJournal,
      baseRevision: 0,
      nextSequence: 1,
      projectId: 'project-journal',
      now: () => baseNow,
    });
    const ack = await recovered.commit(makeRequest('tx-after-failure'));

    expect(projectRoot).toContain('JournalProject.novus-project');
    expect(ack).toMatchObject({ revision: 1, sequence: 1 });
    expect((await readValidJournal(activeJournal)).records.map((record) => record.transactionId)).toEqual([
      'tx-after-failure',
    ]);
  });

  it('rolls back a complete append when sync fails so restart does not replay it', async () => {
    const { activeJournal } = await createJournalFile(tempRoots);
    const writer = await JournalWriter.open({
      activeJournalPath: activeJournal,
      baseRevision: 0,
      fileSystem: new FailFirstSyncFileSystem(activeJournal),
      nextSequence: 1,
      projectId: 'project-journal',
      now: () => baseNow,
    });

    await expect(writer.commit(makeRequest('tx-sync-fails'))).rejects.toThrow(
      /injected sync failure/i,
    );
    expect(await readFile(activeJournal, 'utf8')).toBe('');

    resetJournalWriterRegistryForTests();
    const recovered = await JournalWriter.open({
      activeJournalPath: activeJournal,
      baseRevision: 0,
      nextSequence: 1,
      projectId: 'project-journal',
      now: () => baseNow,
    });
    const ack = await recovered.commit(makeRequest('tx-after-sync-failure'));

    expect(ack).toMatchObject({ revision: 1, sequence: 1 });
    expect((await readValidJournal(activeJournal)).records.map((record) => record.transactionId)).toEqual([
      'tx-after-sync-failure',
    ]);
  });

  it('poisons a journal state when rollback after sync failure cannot be confirmed', async () => {
    const { activeJournal } = await createJournalFile(tempRoots);
    const writer = await JournalWriter.open({
      activeJournalPath: activeJournal,
      baseRevision: 0,
      fileSystem: new FailRollbackAfterSyncFailureFileSystem(activeJournal),
      nextSequence: 1,
      projectId: 'project-journal',
      now: () => baseNow,
    });

    await expect(writer.commit(makeRequest('tx-uncertain-sync'))).rejects.toMatchObject({
      code: 'CORRUPT_JOURNAL',
      retryable: false,
    });
    await expect(writer.commit(makeRequest('tx-after-uncertain-sync'))).rejects.toMatchObject({
      code: 'CORRUPT_JOURNAL',
      retryable: false,
    });
  });

  it('treats close failure after successful sync as cleanup after a durable commit', async () => {
    const { activeJournal } = await createJournalFile(tempRoots);
    const writer = await JournalWriter.open({
      activeJournalPath: activeJournal,
      baseRevision: 0,
      fileSystem: new FailFirstCloseFileSystem(activeJournal),
      nextSequence: 1,
      projectId: 'project-journal',
      now: () => baseNow,
    });
    const request = makeRequest('tx-close-fails');

    const ack = await writer.commit(request);
    const duplicateAck = await writer.commit(request);
    const nextAck = await writer.commit(makeRequest('tx-after-close-failure', 1));

    expect(duplicateAck).toEqual(ack);
    expect(ack).toMatchObject({ revision: 1, sequence: 1 });
    expect(nextAck).toMatchObject({ revision: 2, sequence: 2 });
    expect((await readValidJournal(activeJournal)).records.map((record) => record.transactionId)).toEqual([
      'tx-close-fails',
      'tx-after-close-failure',
    ]);
  });

  it('shares revision, sequence, and idempotency state across writer instances for one journal', async () => {
    const { activeJournal } = await createJournalFile(tempRoots);
    const firstWriter = await JournalWriter.open({
      activeJournalPath: activeJournal,
      baseRevision: 0,
      nextSequence: 1,
      projectId: 'project-journal',
      now: () => baseNow,
    });
    const secondWriter = await JournalWriter.open({
      activeJournalPath: activeJournal,
      baseRevision: 0,
      nextSequence: 1,
      projectId: 'project-journal',
      now: () => baseNow,
    });

    const [firstAck, secondAck] = await Promise.all([
      firstWriter.commit(
        makeRequest('tx-shared-writer-1', 0, makeCreatePromptTransaction('tx-shared-writer-1', 'prompt-shared-1')),
      ),
      secondWriter.commit(
        makeRequest('tx-shared-writer-2', 1, makeCreatePromptTransaction('tx-shared-writer-2', 'prompt-shared-2')),
      ),
    ]);
    const duplicateAck = await secondWriter.commit(
      makeRequest('tx-shared-writer-1', 0, makeCreatePromptTransaction('tx-shared-writer-1', 'prompt-shared-1')),
    );

    expect(firstAck).toMatchObject({ revision: 1, sequence: 1 });
    expect(secondAck).toMatchObject({ revision: 2, sequence: 2 });
    expect(duplicateAck).toEqual(firstAck);
    expect((await readValidJournal(activeJournal)).records.map((record) => [
      record.transactionId,
      record.sequence,
      record.revision,
    ])).toEqual([
      ['tx-shared-writer-1', 1, 1],
      ['tx-shared-writer-2', 2, 2],
    ]);
  });

  it('opens from a repository write session using the manifest active journal path', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const projectRoot = join(tempRoot, 'RepositoryJournal.novus-project');
    const repository = createRepository();
    const session = await repository.create(projectRoot, {
      project: makeProject(),
      projectId: 'project-journal',
      projectName: 'RepositoryJournal',
    });

    const writer = await repository.openJournalWriter(session, { now: () => baseNow });
    const ack = await writer.commit(makeRequest('tx-repository'));

    expect(ack).toMatchObject({ revision: 1, sequence: 1 });
    expect((await readValidJournal(join(projectRoot, 'journal', 'active.ndjson'))).records).toHaveLength(1);
  });

  it('rejects repository journal opening for read-only sessions', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const projectRoot = join(tempRoot, 'ReadOnlyJournal.novus-project');
    const repository = createRepository({ processId: 4101 });
    await repository.create(projectRoot, {
      project: makeProject(),
      projectId: 'project-journal',
      projectName: 'ReadOnlyJournal',
    });
    const readOnly = await createRepository({ processId: 4102 }).open(projectRoot, { mode: 'write' });

    await expect(repository.openJournalWriter(readOnly, { now: () => baseNow })).rejects.toMatchObject({
      code: 'CONCURRENT_WRITER',
    });
  });
});

async function createWriter(tempRoots: string[]) {
  const { activeJournal, projectRoot } = await createJournalFile(tempRoots);
  const writer = await JournalWriter.open({
    activeJournalPath: activeJournal,
    baseRevision: 0,
    nextSequence: 1,
    projectId: 'project-journal',
    now: () => baseNow,
  });

  return { activeJournal, projectRoot, writer };
}

async function createJournalFile(tempRoots: string[]) {
  const tempRoot = await createTempRoot(tempRoots);
  const projectRoot = join(tempRoot, 'JournalProject.novus-project');
  const journalRoot = join(projectRoot, 'journal');
  const activeJournal = join(journalRoot, 'active.ndjson');
  await mkdir(journalRoot, { recursive: true });
  await writeFile(activeJournal, '', 'utf8');
  return { activeJournal, projectRoot };
}

async function createTempRoot(tempRoots: string[]) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'desktop-core-journal-writer-'));
  tempRoots.push(tempRoot);
  return tempRoot;
}

function makeRequest(
  transactionId: string,
  baseRevision = 0,
  transaction: ProjectTransaction = makeCreatePromptTransaction(transactionId, `prompt-${transactionId}`),
): CommitRequest {
  return {
    projectId: 'project-journal',
    baseRevision,
    kind: 'canvas',
    transaction,
  };
}

function makeCreatePromptTransaction(transactionId: string, nodeId: string): ProjectTransaction {
  return {
    id: transactionId,
    label: `create ${nodeId}`,
    operations: [{ kind: 'canvas', operation: { kind: 'create_node', node: makePromptNode(nodeId) } }],
  };
}

function makePromptNode(id: string) {
  return {
    id,
    type: 'prompt' as const,
    position: { x: 0, y: 0 },
    data: { prompt: `Prompt ${id}`, requirementIds: [] },
  };
}

function makeProject(): CanvasProject {
  return {
    version: 1,
    id: 'project-journal',
    name: 'Journal Project',
    nodes: [],
    edges: [],
    projectMemory: [],
    skillPromotionCandidates: [],
  };
}

function withoutChecksum(record: JournalRecord): Omit<JournalRecord, 'payloadSha256'> {
  const { payloadSha256: _payloadSha256, ...payload } = record;
  return payload;
}

function signRecord(payload: Omit<JournalRecord, 'payloadSha256'>): JournalRecord {
  return {
    ...payload,
    payloadSha256: createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex'),
  };
}

function createSyncGate() {
  let enteredResolve: () => void = () => undefined;
  let releaseResolve: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });

  return {
    entered,
    release: releaseResolve,
    async wait() {
      enteredResolve();
      await released;
    },
  };
}

function createRepository(overrides: Partial<ConstructorParameters<typeof ProjectRepository>[0]> = {}) {
  let idCounter = 0;

  return new ProjectRepository({
    channel: 'modern',
    createId: () => `generated-${++idCounter}`,
    deviceId: 'device-under-test',
    fileSystem: new NodeFileSystem(),
    now: () => baseNow,
    processId: 3101,
    ...overrides,
  });
}

class FailWriteFileSystem implements FileSystem {
  private readonly delegate = new NodeFileSystem();
  private readonly targetPath: string;

  constructor(targetPath: string) {
    this.targetPath = targetPath;
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.delegate.mkdir(path, options);
  }

  async open(path: string, flags: string): Promise<FileHandleLike> {
    const handle = await this.delegate.open(path, flags);
    if (samePath(path, this.targetPath) && isJournalAppendFlag(flags)) {
      return new FailWriteHandle(handle);
    }
    return handle;
  }

  async readFile(path: string, encoding: BufferEncoding): Promise<string> {
    return this.delegate.readFile(path, encoding);
  }

  async readdir(path: string): Promise<string[]> {
    return this.delegate.readdir(path);
  }

  async rename(source: string, destination: string): Promise<void> {
    await this.delegate.rename(source, destination);
  }

  async rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void> {
    await this.delegate.rm(path, options);
  }

  async stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }> {
    return this.delegate.stat(path);
  }

  async truncate(path: string, length: number): Promise<void> {
    await this.delegate.truncate(path, length);
  }

  async unlink(path: string): Promise<void> {
    await this.delegate.unlink(path);
  }

  async writeFile(path: string, data: string, encoding: BufferEncoding): Promise<void> {
    await this.delegate.writeFile(path, data, encoding);
  }
}

class FailWriteHandle implements FileHandleLike {
  private readonly handle: FileHandleLike;

  constructor(handle: FileHandleLike) {
    this.handle = handle;
  }

  async close(): Promise<void> {
    await this.handle.close();
  }

  async sync(): Promise<void> {
    await this.handle.sync();
  }

  async truncate(length: number): Promise<void> {
    await (this.handle as FileHandleLike & { truncate(length: number): Promise<void> }).truncate(length);
  }

  async writeFile(_data: string | Uint8Array): Promise<void> {
    throw new Error('injected write failure');
  }
}

class FailFirstSyncFileSystem implements FileSystem {
  private readonly delegate = new NodeFileSystem();
  private readonly targetPath: string;
  private failed = false;

  constructor(targetPath: string) {
    this.targetPath = targetPath;
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.delegate.mkdir(path, options);
  }

  async open(path: string, flags: string): Promise<FileHandleLike> {
    const handle = await this.delegate.open(path, flags);
    if (samePath(path, this.targetPath) && isJournalAppendFlag(flags)) {
      return new FailFirstSyncHandle(handle, () => {
        if (!this.failed) {
          this.failed = true;
          throw new Error('injected sync failure');
        }
      });
    }
    return handle;
  }

  async readFile(path: string, encoding: BufferEncoding): Promise<string> {
    return this.delegate.readFile(path, encoding);
  }

  async readdir(path: string): Promise<string[]> {
    return this.delegate.readdir(path);
  }

  async rename(source: string, destination: string): Promise<void> {
    await this.delegate.rename(source, destination);
  }

  async rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void> {
    await this.delegate.rm(path, options);
  }

  async stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }> {
    return this.delegate.stat(path);
  }

  async truncate(path: string, length: number): Promise<void> {
    await this.delegate.truncate(path, length);
  }

  async unlink(path: string): Promise<void> {
    await this.delegate.unlink(path);
  }

  async writeFile(path: string, data: string, encoding: BufferEncoding): Promise<void> {
    await this.delegate.writeFile(path, data, encoding);
  }
}

class FailFirstSyncHandle implements FileHandleLike {
  private readonly handle: FileHandleLike;
  private readonly failSyncOnce: () => void;

  constructor(handle: FileHandleLike, failSyncOnce: () => void) {
    this.handle = handle;
    this.failSyncOnce = failSyncOnce;
  }

  async close(): Promise<void> {
    await this.handle.close();
  }

  async sync(): Promise<void> {
    this.failSyncOnce();
    await this.handle.sync();
  }

  async truncate(length: number): Promise<void> {
    await (this.handle as FileHandleLike & { truncate(length: number): Promise<void> }).truncate(length);
  }

  async writeFile(data: string | Uint8Array): Promise<void> {
    await this.handle.writeFile(data);
  }
}

class FailRollbackAfterSyncFailureFileSystem implements FileSystem {
  private readonly delegate = new NodeFileSystem();
  private readonly targetPath: string;
  private failed = false;

  constructor(targetPath: string) {
    this.targetPath = targetPath;
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.delegate.mkdir(path, options);
  }

  async open(path: string, flags: string): Promise<FileHandleLike> {
    const handle = await this.delegate.open(path, flags);
    if (samePath(path, this.targetPath) && isJournalAppendFlag(flags)) {
      return new FailRollbackAfterSyncFailureHandle(handle, () => {
        if (!this.failed) {
          this.failed = true;
          throw new Error('injected sync failure');
        }
      });
    }
    return handle;
  }

  async readFile(path: string, encoding: BufferEncoding): Promise<string> {
    return this.delegate.readFile(path, encoding);
  }

  async readdir(path: string): Promise<string[]> {
    return this.delegate.readdir(path);
  }

  async rename(source: string, destination: string): Promise<void> {
    await this.delegate.rename(source, destination);
  }

  async rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void> {
    await this.delegate.rm(path, options);
  }

  async stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }> {
    return this.delegate.stat(path);
  }

  async truncate(_path: string, _length: number): Promise<void> {
    throw new Error('injected rollback truncate failure');
  }

  async unlink(path: string): Promise<void> {
    await this.delegate.unlink(path);
  }

  async writeFile(path: string, data: string, encoding: BufferEncoding): Promise<void> {
    await this.delegate.writeFile(path, data, encoding);
  }
}

class FailRollbackAfterSyncFailureHandle implements FileHandleLike {
  private readonly handle: FileHandleLike;
  private readonly failSyncOnce: () => void;

  constructor(handle: FileHandleLike, failSyncOnce: () => void) {
    this.handle = handle;
    this.failSyncOnce = failSyncOnce;
  }

  async close(): Promise<void> {
    await this.handle.close();
  }

  async sync(): Promise<void> {
    this.failSyncOnce();
    await this.handle.sync();
  }

  async truncate(_length: number): Promise<void> {
    throw new Error('injected rollback truncate failure');
  }

  async writeFile(data: string | Uint8Array): Promise<void> {
    await this.handle.writeFile(data);
  }
}

class FailFirstCloseFileSystem implements FileSystem {
  private readonly delegate = new NodeFileSystem();
  private readonly targetPath: string;
  private failed = false;

  constructor(targetPath: string) {
    this.targetPath = targetPath;
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.delegate.mkdir(path, options);
  }

  async open(path: string, flags: string): Promise<FileHandleLike> {
    const handle = await this.delegate.open(path, flags);
    if (samePath(path, this.targetPath) && isJournalAppendFlag(flags)) {
      return new FailFirstCloseHandle(handle, () => {
        if (!this.failed) {
          this.failed = true;
          throw new Error('injected close failure');
        }
      });
    }
    return handle;
  }

  async readFile(path: string, encoding: BufferEncoding): Promise<string> {
    return this.delegate.readFile(path, encoding);
  }

  async readdir(path: string): Promise<string[]> {
    return this.delegate.readdir(path);
  }

  async rename(source: string, destination: string): Promise<void> {
    await this.delegate.rename(source, destination);
  }

  async rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void> {
    await this.delegate.rm(path, options);
  }

  async stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }> {
    return this.delegate.stat(path);
  }

  async truncate(path: string, length: number): Promise<void> {
    await this.delegate.truncate(path, length);
  }

  async unlink(path: string): Promise<void> {
    await this.delegate.unlink(path);
  }

  async writeFile(path: string, data: string, encoding: BufferEncoding): Promise<void> {
    await this.delegate.writeFile(path, data, encoding);
  }
}

class FailFirstCloseHandle implements FileHandleLike {
  private readonly handle: FileHandleLike;
  private readonly failCloseOnce: () => void;

  constructor(handle: FileHandleLike, failCloseOnce: () => void) {
    this.handle = handle;
    this.failCloseOnce = failCloseOnce;
  }

  async close(): Promise<void> {
    this.failCloseOnce();
    await this.handle.close();
  }

  async sync(): Promise<void> {
    await this.handle.sync();
  }

  async writeFile(data: string | Uint8Array): Promise<void> {
    await this.handle.writeFile(data);
  }
}

function samePath(left: string, right: string): boolean {
  return normalize(left).toLowerCase() === normalize(right).toLowerCase();
}

function isJournalAppendFlag(flags: string): boolean {
  return flags === 'a' || flags === 'a+';
}
