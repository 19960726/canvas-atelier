import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import { JournalWriter, readValidJournal, resetJournalWriterRegistryForTests } from './journal-writer';
import { ProjectRepository } from './project-repository';
import { SnapshotScheduler, type SnapshotReason } from './snapshot-scheduler';

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

  it('rotates before snapshotting, invalidates stale writers, and keeps later writes active', async () => {
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
        await expect(
          writer.commit(makeCreatePromptCommitRequest(session.manifest.projectId, 'tx-stale-writer', 200, 'prompt-stale')),
        ).rejects.toMatchObject({ code: 'CONCURRENT_WRITER' });

        const freshWriter = await JournalWriter.open({
          activeJournalPath: join(projectRoot, 'journal', 'active.ndjson'),
          baseRevision: input.targetRevision,
          nextSequence: input.targetRevision + 1,
          projectId: session.manifest.projectId,
          now: () => baseNow,
        });
        await freshWriter.commit(makeCreatePromptCommitRequest(
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

  it('writes a verified gzip snapshot and atomically advances the manifest', async () => {
    const { projectRoot, session, writer } = await createProjectWithCommits(tempRoots, 'project-gzip', 3);
    const scheduler = new SnapshotScheduler({ now: () => baseNow });

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
      .rejects.toMatchObject({ code: 'CONCURRENT_WRITER' });
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

async function createProject(tempRoots: string[], projectId: string) {
  const tempRoot = await createTempRoot(tempRoots);
  const projectRoot = join(tempRoot, `${projectId}.novus-project`);
  const repository = createRepository();
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
