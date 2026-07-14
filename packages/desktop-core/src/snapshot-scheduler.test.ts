import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';

import { parseCanvasProject, type CanvasProject, type ProjectTransaction } from '@agent-canvas/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { sha256Canonical } from './canonical-json';
import {
  SNAPSHOT_BYTE_LIMIT,
  SNAPSHOT_TRANSACTION_LIMIT,
  type CommitRequest,
  type ProjectManifest,
  type SnapshotEnvelope,
} from './contracts';
import { NodeFileSystem, type FileHandleLike, type FileSystem } from './file-system';
import { readValidJournal, resetJournalWriterRegistryForTests } from './journal-writer';
import { ProjectRepository } from './project-repository';
import { SnapshotScheduler, type SnapshotReason } from './snapshot-scheduler';
import { buildSnapshotProject, type SnapshotWorkerInput, type SnapshotWorkerOutput } from './snapshot-worker';

const gunzipAsync = promisify(gunzip);
const baseNow = new Date('2026-07-14T12:00:00.000Z');

describe('SnapshotScheduler', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    resetJournalWriterRegistryForTests();
    await Promise.all(
      tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { force: true, recursive: true })),
    );
  });

  it.each([
    ['transaction_limit', { transactionCount: SNAPSHOT_TRANSACTION_LIMIT, activeJournalBytes: 1, pendingChanges: true }],
    ['byte_limit', { transactionCount: 1, activeJournalBytes: SNAPSHOT_BYTE_LIMIT, pendingChanges: true }],
    ['agent_transaction', { transactionCount: 1, activeJournalBytes: 1, lastTransactionKind: 'agent', pendingChanges: true }],
    ['stable_point', { transactionCount: 1, activeJournalBytes: 1, stablePoint: true, pendingChanges: true }],
    ['idle', { transactionCount: 1, activeJournalBytes: 1, idleMs: 5_000, pendingChanges: true }],
    ['close', { transactionCount: 0, activeJournalBytes: 0, closing: true, pendingChanges: false }],
  ] satisfies Array<[SnapshotReason, Parameters<SnapshotScheduler['consider']>[1]]>)(
    'schedules an exact %s rotation reason',
    (reason, event) => {
      const scheduler = new SnapshotScheduler();

      expect(scheduler.consider({ root: 'project-root' }, event)).toEqual({ reason });
    },
  );

  it('does not schedule idle compaction before five idle seconds with pending changes', () => {
    const scheduler = new SnapshotScheduler();

    expect(scheduler.consider({ root: 'project-root' }, {
      activeJournalBytes: 1,
      idleMs: 4_999,
      pendingChanges: true,
      transactionCount: 1,
    })).toBeNull();
    expect(scheduler.consider({ root: 'project-root' }, {
      activeJournalBytes: 1,
      idleMs: 5_000,
      pendingChanges: false,
      transactionCount: 1,
    })).toBeNull();
  });

  it('rotates before snapshotting while keeping live writers bound to the new active journal', async () => {
    const { projectRoot, repository, session } = await createProject(tempRoots, 'project-rotate');
    const writer = await repository.openJournalWriter(session, { now: () => baseNow });
    for (let revision = 0; revision < SNAPSHOT_TRANSACTION_LIMIT; revision += 1) {
      await writer.commit(makeCreatePromptCommitRequest(
        session.manifest.projectId,
        `tx-rotate-${revision + 1}`,
        revision,
        `prompt-rotate-${revision + 1}`,
      ));
    }
    const scheduler = new SnapshotScheduler({
      now: () => baseNow,
      worker: async (input) => {
        const activeAfterRotation = await readFile(join(projectRoot, 'journal', 'active.ndjson'), 'utf8');
        expect(activeAfterRotation).toBe('');

        await writer.commit(makeCreatePromptCommitRequest(
          session.manifest.projectId,
          'tx-after-rotation',
          input.targetRevision,
          'prompt-after-rotation',
        ));

        return SnapshotScheduler.defaultWorker(input);
      },
    });

    const snapshot = await scheduler.flush(session, { reason: 'transaction_limit' });

    expect(snapshot.revision).toBe(200);
    const activeRecords = (await readValidJournal(join(projectRoot, 'journal', 'active.ndjson'), {
      baseRevision: 200,
      expectedProjectId: session.manifest.projectId,
      firstSequence: 201,
    })).records;
    expect(activeRecords.map((record) => [record.transactionId, record.revision])).toEqual([
      ['tx-after-rotation', 201],
    ]);
  });

  it('waits for queued commits before rotating and keeps the live writer on the new active journal', async () => {
    const fileSystem = new PauseFirstJournalAppendFileSystem();
    const { projectRoot, repository, session } = await createProject(tempRoots, 'project-queued-barrier', fileSystem);
    const writer = await repository.openJournalWriter(session, { fileSystem, now: () => baseNow });
    const pendingCommit = writer.commit(makeCreatePromptCommitRequest(
      session.manifest.projectId,
      'tx-pre-barrier',
      0,
      'prompt-pre-barrier',
    ));
    await fileSystem.firstAppendStarted.promise;

    const scheduler = new SnapshotScheduler({
      fileSystem,
      now: () => baseNow,
      worker: (input) => SnapshotScheduler.defaultWorker(input),
    });
    const pendingFlush = scheduler.flush(session, { reason: 'stable_point' });

    await expect(Promise.race([
      pendingFlush.then(() => 'flushed'),
      Promise.resolve('still-waiting'),
    ])).resolves.toBe('still-waiting');

    fileSystem.releaseFirstAppend();
    await expect(pendingCommit).resolves.toMatchObject({ revision: 1, sequence: 1 });
    await expect(pendingFlush).resolves.toMatchObject({ revision: 1 });

    const postBarrierAck = await writer.commit(makeCreatePromptCommitRequest(
      session.manifest.projectId,
      'tx-post-barrier',
      1,
      'prompt-post-barrier',
    ));
    const manifest = await readJson<ProjectManifest>(join(projectRoot, 'project.novus.json'));
    const activeRecords = (await readValidJournal(join(projectRoot, 'journal', 'active.ndjson'), {
      baseRevision: 1,
      expectedProjectId: session.manifest.projectId,
      firstSequence: 2,
    })).records;

    expect(postBarrierAck).toMatchObject({ revision: 2, sequence: 2 });
    expect(manifest.stableSnapshotRevision).toBe(1);
    expect(activeRecords.map((record) => [record.transactionId, record.revision])).toEqual([
      ['tx-post-barrier', 2],
    ]);
  });

  it('rolls worker failures back by merging archived and post-rotation active commits under a barrier', async () => {
    const { projectRoot, session, writer } = await createProjectWithCommits(tempRoots, 'project-worker-rollback', 2);
    const oldManifest = await readJson<ProjectManifest>(join(projectRoot, 'project.novus.json'));
    const scheduler = new SnapshotScheduler({
      now: () => baseNow,
      worker: async (input) => {
        const postRotationAck = await writer.commit(makeCreatePromptCommitRequest(
          session.manifest.projectId,
          'tx-post-worker-failure',
          input.targetRevision,
          'prompt-post-worker-failure',
        ));
        expect(postRotationAck).toMatchObject({ revision: 3, sequence: 3 });
        throw new Error('injected worker failure');
      },
    });

    await expect(scheduler.flush(session, { reason: 'stable_point' })).rejects.toThrow(/injected worker failure/i);

    const manifest = await readJson<ProjectManifest>(join(projectRoot, 'project.novus.json'));
    const activeRecords = (await readValidJournal(join(projectRoot, 'journal', 'active.ndjson'), {
      baseRevision: 0,
      expectedProjectId: session.manifest.projectId,
      firstSequence: 1,
    })).records;

    expect(manifest).toEqual(oldManifest);
    expect(activeRecords.map((record) => [record.transactionId, record.revision])).toEqual([
      ['tx-1', 1],
      ['tx-2', 2],
      ['tx-post-worker-failure', 3],
    ]);
  });

  it('preserves the old manifest and poisons live writers when rollback after manifest failure is uncertain', async () => {
    const { projectRoot, session, writer } = await createProjectWithCommits(tempRoots, 'project-uncertain-rollback', 1);
    const fileSystem = new FailManifestAndRollbackFileSystem(join(projectRoot, 'project.novus.json'));
    const oldManifest = await readJson<ProjectManifest>(join(projectRoot, 'project.novus.json'));
    const scheduler = new SnapshotScheduler({
      fileSystem,
      now: () => baseNow,
      worker: (input) => SnapshotScheduler.defaultWorker(input),
    });

    await expect(scheduler.flush(session, { reason: 'stable_point' })).rejects.toMatchObject({
      code: 'CORRUPT_JOURNAL',
      retryable: false,
    });
    await expect(writer.commit(makeCreatePromptCommitRequest(
      session.manifest.projectId,
      'tx-after-uncertain-rollback',
      1,
      'prompt-after-uncertain-rollback',
    ))).rejects.toMatchObject({
      code: 'CORRUPT_JOURNAL',
      retryable: false,
    });
    await expect(readJson<ProjectManifest>(join(projectRoot, 'project.novus.json'))).resolves.toEqual(oldManifest);
  });

  it('verifies gzip snapshots through the injected filesystem', async () => {
    const { session } = await createProjectWithCommits(tempRoots, 'project-injected-gzip-fs', 1);
    const fileSystem = new CountingBinaryReadFileSystem();
    const scheduler = new SnapshotScheduler({
      fileSystem,
      now: () => baseNow,
      worker: (input) => SnapshotScheduler.defaultWorker(input),
    });

    await scheduler.flush(session, { reason: 'stable_point' });

    expect(fileSystem.binaryReadPaths.some((path) => path.endsWith('.json.gz'))).toBe(true);
  });

  it('uses a node worker entry URL by default while preserving worker factory injection', async () => {
    const { session } = await createProjectWithCommits(tempRoots, 'project-default-worker-url', 1);
    let workerUrl: string | null = null;
    const scheduler = new SnapshotScheduler({
      now: () => baseNow,
      workerFactory: (url: URL) => {
        workerUrl = url.pathname.replace(/\\/g, '/');
        return new ImmediateSnapshotWorker();
      },
    });

    await expect(scheduler.flush(session, { reason: 'stable_point' })).resolves.toMatchObject({
      revision: 1,
    });

    expect(workerUrl).toMatch(/snapshot-worker-entry\.js$/);
  });

  it('writes a verified gzip snapshot and atomically advances the manifest', async () => {
    const { projectRoot, session, writer } = await createProjectWithCommits(tempRoots, 'project-gzip', 3);
    const scheduler = new SnapshotScheduler({
      now: () => baseNow,
      worker: (input) => SnapshotScheduler.defaultWorker(input),
    });

    const snapshot = await scheduler.flush(session, { reason: 'stable_point' });
    const manifest = await readJson<ProjectManifest>(join(projectRoot, 'project.novus.json'));
    const snapshotPath = join(projectRoot, ...manifest.stableSnapshotPath!.split('/'));
    const gzipBytes = await readFile(snapshotPath);
    const envelope = JSON.parse((await gunzipAsync(gzipBytes)).toString('utf8')) as SnapshotEnvelope;

    expect(snapshot).toMatchObject({ revision: 3 });
    expect(manifest).toMatchObject({
      activeJournalSegment: 'journal/active.ndjson',
      cleanClose: false,
      nextSequence: 4,
      stableSnapshotId: snapshot.snapshotId,
      stableSnapshotRevision: 3,
    });
    expect(manifest.stableSnapshotPath).toMatch(/^snapshots\/s-3-[a-f0-9]{8}\.json\.gz$/);
    expect(envelope.projectSha256).toBe(sha256Canonical(envelope.project));
    expect(envelope.revision).toBe(3);
    expect(parseCanvasProject(envelope.project).nodes.map((node) => node.id)).toEqual([
      'prompt-1',
      'prompt-2',
      'prompt-3',
    ]);
    expect((await readValidJournal(join(projectRoot, 'journal', 'active.ndjson'), {
      baseRevision: 3,
      expectedProjectId: session.manifest.projectId,
      firstSequence: 4,
    })).records).toEqual([]);
    await expect(writer.commit(makeCreatePromptCommitRequest(session.manifest.projectId, 'tx-old', 3, 'prompt-old')))
      .resolves.toMatchObject({ revision: 4, sequence: 4 });
    expect((await readValidJournal(join(projectRoot, 'journal', 'active.ndjson'), {
      baseRevision: 3,
      expectedProjectId: session.manifest.projectId,
      firstSequence: 4,
    })).records.map((record) => record.transactionId)).toEqual(['tx-old']);
  });

  it('runs only one worker per project while a rotation is already in flight', async () => {
    const { session } = await createProjectWithCommits(tempRoots, 'project-one-worker', 2);
    let workerCalls = 0;
    const gate = createDeferred<void>();
    const scheduler = new SnapshotScheduler({
      now: () => baseNow,
      worker: async (input) => {
        workerCalls += 1;
        await gate.promise;
        return SnapshotScheduler.defaultWorker(input);
      },
    });

    const first = scheduler.flush(session, { reason: 'stable_point' });
    const second = scheduler.flush(session, { reason: 'close' });
    gate.resolve();
    const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);

    expect(workerCalls).toBe(1);
    expect(secondSnapshot).toEqual(firstSnapshot);
  });
});

async function createProject(tempRoots: string[], projectId: string, fileSystem?: FileSystem) {
  const tempRoot = await createTempRoot(tempRoots);
  const projectRoot = join(tempRoot, `${projectId}.novus-project`);
  const repository = createRepository(fileSystem === undefined ? {} : { fileSystem });
  const project = makeProject(projectId);
  const session = await repository.create(projectRoot, {
    project,
    projectId,
    projectName: projectId,
  });

  return { project, projectRoot, repository, session };
}

async function createProjectWithCommits(tempRoots: string[], projectId: string, count: number) {
  const created = await createProject(tempRoots, projectId);
  const writer = await created.repository.openJournalWriter(created.session, { now: () => baseNow });
  for (let revision = 0; revision < count; revision += 1) {
    await writer.commit(makeCreatePromptCommitRequest(
      created.session.manifest.projectId,
      `tx-${revision + 1}`,
      revision,
      `prompt-${revision + 1}`,
    ));
  }

  return { ...created, writer };
}

function createRepository(overrides: Partial<ConstructorParameters<typeof ProjectRepository>[0]> = {}) {
  let idCounter = 0;

  return new ProjectRepository({
    channel: 'modern',
    createId: () => `generated-${++idCounter}`,
    deviceId: 'device-under-test',
    now: () => baseNow,
    processId: 4101,
    ...overrides,
  });
}

async function createTempRoot(tempRoots: string[]) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'desktop-core-snapshot-scheduler-'));
  tempRoots.push(tempRoot);
  return tempRoot;
}

function makeProject(projectId: string): CanvasProject {
  return {
    version: 1,
    id: projectId,
    name: projectId,
    nodes: [],
    edges: [],
    projectMemory: [],
    skillPromotionCandidates: [],
  };
}

function makeCreatePromptCommitRequest(
  projectId: string,
  transactionId: string,
  baseRevision: number,
  nodeId: string,
): CommitRequest {
  return {
    projectId,
    baseRevision,
    kind: transactionId.includes('agent') ? 'agent' : 'canvas',
    transaction: makeCreatePromptTransaction(transactionId, nodeId),
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

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

function createDeferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class DelegatingFileSystem implements FileSystem {
  protected readonly delegate: FileSystem;

  constructor(delegate: FileSystem = new NodeFileSystem()) {
    this.delegate = delegate;
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.delegate.mkdir(path, options);
  }

  async open(path: string, flags: string): Promise<FileHandleLike> {
    return this.delegate.open(path, flags);
  }

  async readFile(path: string, encoding: BufferEncoding): Promise<string> {
    return this.delegate.readFile(path, encoding);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const maybeBinaryReader = this.delegate as FileSystem & { readFileBuffer?: (path: string) => Promise<Uint8Array> };
    if (maybeBinaryReader.readFileBuffer !== undefined) {
      return maybeBinaryReader.readFileBuffer(path);
    }
    return Buffer.from(await this.delegate.readFile(path, 'latin1'), 'latin1');
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

  async stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean; readonly size?: number }> {
    return this.delegate.stat(path);
  }

  async truncate(path: string, length: number): Promise<void> {
    const maybeTruncate = this.delegate as FileSystem & { truncate?: (path: string, length: number) => Promise<void> };
    if (maybeTruncate.truncate === undefined) {
      throw new Error('delegate truncate unavailable');
    }
    await maybeTruncate.truncate(path, length);
  }

  async unlink(path: string): Promise<void> {
    await this.delegate.unlink(path);
  }

  async writeFile(path: string, data: string, encoding: BufferEncoding): Promise<void> {
    await this.delegate.writeFile(path, data, encoding);
  }
}

class PauseFirstJournalAppendFileSystem extends DelegatingFileSystem {
  readonly firstAppendStarted = createDeferred<void>();
  private readonly firstAppendReleased = createDeferred<void>();
  private paused = false;

  releaseFirstAppend(): void {
    this.firstAppendReleased.resolve();
  }

  override async open(path: string, flags: string): Promise<FileHandleLike> {
    const handle = await super.open(path, flags);
    if (!this.paused && flags === 'a+' && path.endsWith(join('journal', 'active.ndjson'))) {
      this.paused = true;
      return new PauseFirstWriteHandle(handle, this.firstAppendStarted, this.firstAppendReleased);
    }
    return handle;
  }
}

class PauseFirstWriteHandle implements FileHandleLike {
  private readonly handle: FileHandleLike;
  private readonly entered: ReturnType<typeof createDeferred<void>>;
  private readonly release: ReturnType<typeof createDeferred<void>>;

  constructor(
    handle: FileHandleLike,
    entered: ReturnType<typeof createDeferred<void>>,
    release: ReturnType<typeof createDeferred<void>>,
  ) {
    this.handle = handle;
    this.entered = entered;
    this.release = release;
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

  async writeFile(data: string | Uint8Array): Promise<void> {
    this.entered.resolve();
    await this.release.promise;
    await this.handle.writeFile(data);
  }
}

class FailManifestAndRollbackFileSystem extends DelegatingFileSystem {
  private readonly manifestPath: string;
  private manifestRenameFailed = false;

  constructor(manifestPath: string) {
    super();
    this.manifestPath = manifestPath;
  }

  override async rename(source: string, destination: string): Promise<void> {
    if (samePath(destination, this.manifestPath)) {
      this.manifestRenameFailed = true;
      throw new Error('injected manifest rename failure');
    }

    if (this.manifestRenameFailed && destination.endsWith(join('journal', 'active.ndjson'))) {
      throw new Error('injected rollback rename failure');
    }

    await super.rename(source, destination);
  }
}

class CountingBinaryReadFileSystem extends DelegatingFileSystem {
  readonly binaryReadPaths: string[] = [];

  override async readFileBuffer(path: string): Promise<Uint8Array> {
    this.binaryReadPaths.push(path);
    return super.readFileBuffer(path);
  }
}

class ImmediateSnapshotWorker {
  private messageHandler: ((message: { ok: true; output: SnapshotWorkerOutput }) => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  private exitHandler: ((code: number) => void) | null = null;

  once(event: string, handler: ((message: { ok: true; output: SnapshotWorkerOutput }) => void) | ((error: Error) => void) | ((code: number) => void)) {
    if (event === 'message') {
      this.messageHandler = handler as (message: { ok: true; output: SnapshotWorkerOutput }) => void;
    } else if (event === 'error') {
      this.errorHandler = handler as (error: Error) => void;
    } else if (event === 'exit') {
      this.exitHandler = handler as (code: number) => void;
    }
    return this;
  }

  postMessage(input: SnapshotWorkerInput): void {
    buildSnapshotProject(input).then(
      (output) => {
        this.messageHandler?.({ ok: true, output });
        this.exitHandler?.(0);
      },
      (error) => this.errorHandler?.(error instanceof Error ? error : new Error(String(error))),
    );
  }

  async terminate(): Promise<number> {
    return 0;
  }
}

function samePath(left: string, right: string): boolean {
  return normalize(left).toLowerCase() === normalize(right).toLowerCase();
}
