import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, normalize } from 'node:path';
import type { CanvasProject } from '@agent-canvas/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { sha256Canonical } from './canonical-json';
import {
  SNAPSHOT_SCHEMA_VERSION,
  STALE_LOCK_MS,
  type CommitRequest,
  type ProjectManifest,
  type SnapshotEnvelope,
} from './contracts';
import { NodeFileSystem, writeAtomic, type FileHandleLike, type FileSystem } from './file-system';
import { readValidJournal, replayJournal } from './journal-writer';
import {
  MAX_WIN7_PROJECT_ROOT_PATH_LENGTH,
  ProjectRepository,
  type OpenedProjectSession,
} from './project-repository';

interface TestProjectLock {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly deviceId: string;
  readonly processId: number;
  readonly channel: 'legacy' | 'modern';
  readonly sessionId: string;
  readonly openedAt: string;
  readonly heartbeatAt: string;
}

interface TestCleanCloseMarker {
  readonly clean: boolean;
  readonly closedAt: string | null;
}

const starterProject = {
  nodes: [],
  viewport: {
    x: 0,
    y: 0,
    zoom: 1,
  },
};

const baseNow = new Date('2026-07-14T12:00:00.000Z');

describe('ProjectRepository', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { force: true, recursive: true })),
    );
  });

  it('creates the project layout with only relative internal paths in the manifest', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const projectRoot = join(tempRoot, 'Demo Project.novus-project');
    const repository = createRepository();

    const session = await repository.create(projectRoot, {
      project: starterProject,
      projectId: 'project-demo',
      projectName: 'Demo Project',
    });

    expect(session.mode).toBe('write');
    await expectLayout(projectRoot);

    const manifest = await readJson<Record<string, unknown>>(join(projectRoot, 'project.novus.json'));
    expect(manifest).toMatchObject({
      activeJournalSegment: 'journal/active.ndjson',
      cleanClose: false,
      formatVersion: 1,
      projectId: 'project-demo',
      projectName: 'Demo Project',
      stableSnapshotRevision: 0,
    });
    expect(JSON.stringify(manifest)).not.toContain(tempRoot);

    const snapshotFiles = await readdir(join(projectRoot, 'snapshots'));
    expect(snapshotFiles).toHaveLength(1);

    const snapshot = await readJson<Record<string, unknown>>(
      join(projectRoot, 'snapshots', snapshotFiles[0]!),
    );
    expect(snapshot).toMatchObject({
      project: starterProject,
      projectId: 'project-demo',
      revision: 0,
      schemaVersion: 1,
    });

    const journalContent = await readFile(join(projectRoot, 'journal', 'active.ndjson'), 'utf8');
    expect(journalContent).toBe('');

    const cleanClose = await readJson<TestCleanCloseMarker>(
      join(projectRoot, 'recovery', 'clean-close.json'),
    );
    expect(cleanClose).toMatchObject({
      clean: false,
      closedAt: null,
    });
  });

  it('reopens an existing project from disk after a clean close', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const projectRoot = join(tempRoot, 'Reopenable.novus-project');
    const repository = createRepository();

    const created = await repository.create(projectRoot, {
      project: starterProject,
      projectId: 'project-reopen',
      projectName: 'Reopenable',
    });
    await repository.close(created);

    const cleanClose = await readJson<TestCleanCloseMarker>(
      join(projectRoot, 'recovery', 'clean-close.json'),
    );
    expect(cleanClose).toMatchObject({
      clean: true,
    });

    const reopened = await repository.open(projectRoot, { mode: 'write' });

    expect(reopened.mode).toBe('write');
    expect(reopened.root).toBe(projectRoot);
    expect(reopened.manifest).toMatchObject({
      activeJournalSegment: 'journal/active.ndjson',
      projectId: 'project-reopen',
      projectName: 'Reopenable',
      stableSnapshotRevision: 0,
    });
  });

  it('opens a second live writer as read-only while the first lock is still live', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const projectRoot = join(tempRoot, 'Locked.novus-project');
    const firstRepository = createRepository({ processId: 3101 });
    const secondRepository = createRepository({ processId: 4101 });

    const first = await firstRepository.create(projectRoot, {
      project: starterProject,
      projectId: 'project-live-lock',
      projectName: 'Locked',
    });
    const second = await secondRepository.open(projectRoot, { mode: 'write' });

    expect(first.mode).toBe('write');
    expect(second.mode).toBe('read_only');
    expect(second.manifest.projectId).toBe('project-live-lock');
  });

  it('reclaims a stale local lock only when the injected process check confirms the owner is dead', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const projectRoot = join(tempRoot, 'StaleLocal.novus-project');
    const repository = createRepository({ processId: 5101 });

    const created = await repository.create(projectRoot, {
      project: starterProject,
      projectId: 'project-stale-local',
      projectName: 'StaleLocal',
    });
    await repository.close(created);

    const staleHeartbeatAt = new Date(baseNow.getTime() - (STALE_LOCK_MS + 1_000)).toISOString();
    await writeProjectLock(projectRoot, {
      channel: 'modern',
      deviceId: 'device-under-test',
      heartbeatAt: staleHeartbeatAt,
      openedAt: staleHeartbeatAt,
      processId: 9191,
      projectId: created.manifest.projectId,
      schemaVersion: 1,
      sessionId: 'stale-session',
    });

    let observedPid: number | null = null;
    const reopened = await createRepository({
      isLocalProcessAlive: (processId) => {
        observedPid = processId;
        return false;
      },
      processId: 6101,
    }).open(projectRoot, { mode: 'write' });

    expect(observedPid).toBe(9191);
    expect(reopened.mode).toBe('write');

    const activeLock = await readJson<TestProjectLock>(join(projectRoot, 'recovery', 'project.lock'));
    expect(activeLock.processId).toBe(6101);
    expect(activeLock.sessionId).not.toBe('stale-session');
  });

  it('keeps a third opener read-only while stale reclaim is in progress', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const projectRoot = join(tempRoot, 'StaleThirdOpener.novus-project');
    const lockPath = join(projectRoot, 'recovery', 'project.lock');
    const guardPath = join(projectRoot, 'recovery', 'project.lock.guard');
    const repository = createRepository({ processId: 5102 });

    const created = await repository.create(projectRoot, {
      project: starterProject,
      projectId: 'project-stale-third-opener',
      projectName: 'StaleThirdOpener',
    });
    await repository.close(created);

    const staleHeartbeatAt = new Date(baseNow.getTime() - (STALE_LOCK_MS + 1_000)).toISOString();
    await writeProjectLock(projectRoot, {
      channel: 'modern',
      deviceId: 'device-under-test',
      heartbeatAt: staleHeartbeatAt,
      openedAt: staleHeartbeatAt,
      processId: 9292,
      projectId: created.manifest.projectId,
      schemaVersion: 1,
      sessionId: 'stale-race-session',
    });

    const coordinator = createOperationWindowCoordinator();
    const firstRepository = createRepository({
      fileSystem: new PauseDuringLockOperationFileSystem(lockPath, guardPath, coordinator),
      isLocalProcessAlive: () => false,
      processId: 6201,
    });
    const thirdRepository = createRepository({
      isLocalProcessAlive: () => false,
      processId: 6203,
    });

    const firstOpen = firstRepository.open(projectRoot, { mode: 'write' });
    await coordinator.operationStarted.promise;
    const third = await thirdRepository.open(projectRoot, { mode: 'write' });
    coordinator.concurrentAttemptDone.resolve();
    const first = await firstOpen;

    expect(third.mode).toBe('read_only');
    expect(first.mode).toBe('write');

    const activeLock = await readJson<TestProjectLock>(lockPath);
    expect(activeLock.sessionId).toBe(first.lock!.sessionId);
    expect(activeLock.processId).toBe(6201);
  });

  it('keeps nonlocal or unverifiable stale locks read-only', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const projectRoot = join(tempRoot, 'RemoteLock.novus-project');
    const repository = createRepository({ processId: 7101 });

    const created = await repository.create(projectRoot, {
      project: starterProject,
      projectId: 'project-remote-lock',
      projectName: 'RemoteLock',
    });
    await repository.close(created);

    const staleHeartbeatAt = new Date(baseNow.getTime() - (STALE_LOCK_MS + 1_000)).toISOString();
    await writeProjectLock(projectRoot, {
      channel: 'modern',
      deviceId: 'remote-device',
      heartbeatAt: staleHeartbeatAt,
      openedAt: staleHeartbeatAt,
      processId: 8181,
      projectId: created.manifest.projectId,
      schemaVersion: 1,
      sessionId: 'remote-session',
    });

    const remoteLocked = await createRepository({
      isLocalProcessAlive: () => false,
      processId: 8101,
    }).open(projectRoot, { mode: 'write' });
    expect(remoteLocked.mode).toBe('read_only');

    await writeProjectLock(projectRoot, {
      channel: 'modern',
      deviceId: 'device-under-test',
      heartbeatAt: staleHeartbeatAt,
      openedAt: staleHeartbeatAt,
      processId: 8282,
      projectId: created.manifest.projectId,
      schemaVersion: 1,
      sessionId: 'unknown-session',
    });

    const unverifiable = await createRepository({
      isLocalProcessAlive: () => 'unknown',
      processId: 9101,
    }).open(projectRoot, { mode: 'write' });
    expect(unverifiable.mode).toBe('read_only');
  });

  it('rejects unsafe Win7 project root lengths before writing anything', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const prefix = join(tempRoot, 'unsafe-');
    const unsafeName =
      'x'.repeat(MAX_WIN7_PROJECT_ROOT_PATH_LENGTH - prefix.length + 1) + '.novus-project';
    const projectRoot = `${prefix}${unsafeName}`;
    const repository = createRepository();

    await expect(
      repository.create(projectRoot, {
        project: starterProject,
        projectId: 'project-too-long',
        projectName: basename(projectRoot, '.novus-project'),
      }),
    ).rejects.toThrow(/Win7/i);

    await expect(stat(projectRoot)).rejects.toThrow();
  });

  it('removes the lock and marks a clean close when the writer closes', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const projectRoot = join(tempRoot, 'CleanClose.novus-project');
    const repository = createRepository();

    const session = await repository.create(projectRoot, {
      project: starterProject,
      projectId: 'project-clean-close',
      projectName: 'CleanClose',
    });
    await repository.close(session);

    await expect(access(join(projectRoot, 'recovery', 'project.lock'))).rejects.toThrow();

    const cleanClose = await readJson<TestCleanCloseMarker>(
      join(projectRoot, 'recovery', 'clean-close.json'),
    );
    expect(cleanClose).toMatchObject({
      clean: true,
    });

    const reopened = await repository.open(projectRoot, { mode: 'write' });
    expect(reopened.mode).toBe('write');
    expect(reopened.manifest.cleanClose).toBe(false);
  });

  it('evicts active journal state on close so a recreated path initializes from disk with a changed project id', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const projectRoot = join(tempRoot, 'RecreatedPath.novus-project');
    const repository = createRepository({ processId: 10302 });
    const firstProject = makeCanvasProject('project-recreated-first');

    const first = await repository.create(projectRoot, {
      project: firstProject,
      projectId: firstProject.id,
      projectName: 'RecreatedPath',
    });
    const firstWriter = await repository.openJournalWriter(first, { now: () => baseNow });
    await firstWriter.commit(
      makeCreatePromptCommitRequest(first.manifest.projectId, 'tx-recreated-first', 0, 'prompt-first'),
    );
    await repository.close(first);
    await rm(projectRoot, { force: true, recursive: true });

    const secondProject = makeCanvasProject('project-recreated-second');
    const second = await repository.create(projectRoot, {
      project: secondProject,
      projectId: secondProject.id,
      projectName: 'RecreatedPath',
    });
    const secondWriter = await repository.openJournalWriter(second, { now: () => baseNow });
    const secondAck = await secondWriter.commit(
      makeCreatePromptCommitRequest(second.manifest.projectId, 'tx-recreated-second', 0, 'prompt-second'),
    );

    expect(secondAck).toMatchObject({ projectId: secondProject.id, revision: 1, sequence: 1 });
    const secondRecords = await readFile(join(projectRoot, 'journal', 'active.ndjson'), 'utf8');
    expect(secondRecords).toContain('"projectId":"project-recreated-second"');
    expect(secondRecords).not.toContain('project-recreated-first');
  });

  it('invalidates stale journal writers on close and gives reopened writers a fresh registry entry', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const projectRoot = join(tempRoot, 'ReopenJournalRegistry.novus-project');
    const repository = createRepository({ processId: 10303 });
    const firstProject = makeCanvasProject('project-reopen-journal-first');

    const firstSession = await repository.create(projectRoot, {
      project: firstProject,
      projectId: firstProject.id,
      projectName: 'ReopenJournalRegistry',
    });
    const writerA = await repository.openJournalWriter(firstSession, { now: () => baseNow });
    const firstAck = await writerA.commit(
      makeCreatePromptCommitRequest(firstSession.manifest.projectId, 'tx-reopen-journal-1', 0, 'prompt-reopen-1'),
    );

    await repository.close(firstSession);

    const reopenedSession = await repository.open(projectRoot, { mode: 'write' });
    const writerB = await repository.openJournalWriter(reopenedSession, { now: () => baseNow });

    await expect(
      writerA.commit(
        makeCreatePromptCommitRequest(firstSession.manifest.projectId, 'tx-reopen-journal-stale', 1, 'prompt-stale'),
      ),
    ).rejects.toMatchObject({
      code: 'CONCURRENT_WRITER',
      retryable: false,
    });

    const secondAck = await writerB.commit(
      makeCreatePromptCommitRequest(reopenedSession.manifest.projectId, 'tx-reopen-journal-2', 1, 'prompt-reopen-2'),
    );
    const read = await readValidJournal(join(projectRoot, 'journal', 'active.ndjson'));

    expect(firstAck).toMatchObject({ revision: 1, sequence: 1 });
    expect(secondAck).toMatchObject({ revision: 2, sequence: 2 });
    expect(read.records.map((record) => [record.transactionId, record.sequence, record.revision])).toEqual([
      ['tx-reopen-journal-1', 1, 1],
      ['tx-reopen-journal-2', 2, 2],
    ]);
  });

  it('keeps the project dirty when owned lock removal fails during close', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const projectRoot = join(tempRoot, 'DirtyCloseFailure.novus-project');
    const lockPath = join(projectRoot, 'recovery', 'project.lock');
    const guardPath = join(projectRoot, 'recovery', 'project.lock.guard');
    const repository = createRepository({
      fileSystem: new FailRmFileSystem(lockPath),
    });

    const session = await repository.create(projectRoot, {
      project: starterProject,
      projectId: 'project-dirty-close-failure',
      projectName: 'DirtyCloseFailure',
    });

    await expect(repository.close(session)).rejects.toThrow(/injected rm failure/i);

    await expect(access(lockPath)).resolves.toBeUndefined();
    await expect(access(guardPath)).rejects.toThrow();

    const manifest = await readProjectManifest(projectRoot);
    expect(manifest.cleanClose).toBe(false);

    const cleanClose = await readJson<TestCleanCloseMarker>(
      join(projectRoot, 'recovery', 'clean-close.json'),
    );
    expect(cleanClose).toMatchObject({
      clean: false,
      closedAt: null,
    });
  });

  it('keeps a third opener read-only while close observes a non-owned lock', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const projectRoot = join(tempRoot, 'CloseRace.novus-project');
    const lockPath = join(projectRoot, 'recovery', 'project.lock');
    const guardPath = join(projectRoot, 'recovery', 'project.lock.guard');
    const repository = createRepository({ processId: 10102 });

    const session = await repository.create(projectRoot, {
      project: starterProject,
      projectId: 'project-close-race',
      projectName: 'CloseRace',
    });
    const writer = await repository.openJournalWriter(session, { now: () => baseNow });
    await writer.commit(
      makeCreatePromptCommitRequest(session.manifest.projectId, 'tx-close-race', 0, 'prompt-close-race'),
    );

    const replacementOpenedAt = new Date(baseNow.getTime() + 1_000).toISOString();
    const replacementLock: TestProjectLock = {
      channel: 'modern',
      deviceId: 'device-under-test',
      heartbeatAt: replacementOpenedAt,
      openedAt: replacementOpenedAt,
      processId: 10103,
      projectId: session.manifest.projectId,
      schemaVersion: 1,
      sessionId: 'replacement-session',
    };
    await writeProjectLock(projectRoot, replacementLock);

    const coordinator = createOperationWindowCoordinator();
    const closePromise = createRepository({
      fileSystem: new PauseDuringLockOperationFileSystem(lockPath, guardPath, coordinator),
      processId: 10102,
    }).close(session);
    await coordinator.operationStarted.promise;
    const third = await createRepository({ processId: 10104 }).open(projectRoot, { mode: 'write' });
    coordinator.concurrentAttemptDone.resolve();
    await closePromise;

    await expect(
      writer.commit(
        makeCreatePromptCommitRequest(session.manifest.projectId, 'tx-close-race-stale', 1, 'prompt-close-race-stale'),
      ),
    ).rejects.toMatchObject({
      code: 'CONCURRENT_WRITER',
      retryable: false,
    });

    expect(third.mode).toBe('read_only');
    const activeLock = await readJson<TestProjectLock>(lockPath);
    expect(activeLock).toMatchObject({
      processId: 10103,
      sessionId: 'replacement-session',
    });
    expect((await readValidJournal(join(projectRoot, 'journal', 'active.ndjson'))).records).toHaveLength(1);
  });

  it('invalidates journal writers when close cannot acquire its guard', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const projectRoot = join(tempRoot, 'GuardUnavailableClose.novus-project');
    const guardPath = join(projectRoot, 'recovery', 'project.lock.guard');
    const repository = createRepository({ processId: 10105 });

    const session = await repository.create(projectRoot, {
      project: starterProject,
      projectId: 'project-guard-unavailable-close',
      projectName: 'GuardUnavailableClose',
    });
    const writer = await repository.openJournalWriter(session, { now: () => baseNow });
    await writer.commit(
      makeCreatePromptCommitRequest(session.manifest.projectId, 'tx-guard-unavailable-close', 0, 'prompt-guard-unavailable-close'),
    );

    await writeFile(guardPath, '{"token":"existing"}\n', 'utf8');
    await repository.close(session);

    await expect(
      writer.commit(
        makeCreatePromptCommitRequest(session.manifest.projectId, 'tx-guard-unavailable-close-stale', 1, 'prompt-guard-unavailable-close-stale'),
      ),
    ).rejects.toMatchObject({
      code: 'CONCURRENT_WRITER',
      retryable: false,
    });

    expect((await readValidJournal(join(projectRoot, 'journal', 'active.ndjson'))).records).toHaveLength(1);
  });

  it('returns read-only under an existing operation guard without changing a stale canonical lock', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const projectRoot = join(tempRoot, 'ExistingGuardOpen.novus-project');
    const guardPath = join(projectRoot, 'recovery', 'project.lock.guard');
    const repository = createRepository({ processId: 10202 });

    const created = await repository.create(projectRoot, {
      project: starterProject,
      projectId: 'project-existing-guard-open',
      projectName: 'ExistingGuardOpen',
    });
    await repository.close(created);

    const staleHeartbeatAt = new Date(baseNow.getTime() - (STALE_LOCK_MS + 1_000)).toISOString();
    const staleLock: TestProjectLock = {
      channel: 'modern',
      deviceId: 'device-under-test',
      heartbeatAt: staleHeartbeatAt,
      openedAt: staleHeartbeatAt,
      processId: 10203,
      projectId: created.manifest.projectId,
      schemaVersion: 1,
      sessionId: 'guarded-stale-session',
    };
    await writeProjectLock(projectRoot, staleLock);
    await writeFile(guardPath, '{"token":"existing"}\n', 'utf8');

    const guarded = await createRepository({
      isLocalProcessAlive: () => false,
      processId: 10204,
    }).open(projectRoot, { mode: 'write' });

    expect(guarded.mode).toBe('read_only');
    expect(await readJson<TestProjectLock>(join(projectRoot, 'recovery', 'project.lock'))).toEqual(
      staleLock,
    );
  });

  it('leaves an owned canonical lock in place when close cannot acquire the operation guard', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const projectRoot = join(tempRoot, 'ExistingGuardClose.novus-project');
    const guardPath = join(projectRoot, 'recovery', 'project.lock.guard');
    const repository = createRepository({ processId: 10205 });

    const session = await repository.create(projectRoot, {
      project: starterProject,
      projectId: 'project-existing-guard-close',
      projectName: 'ExistingGuardClose',
    });
    await writeFile(guardPath, '{"token":"existing"}\n', 'utf8');

    await repository.close(session);

    expect(await readJson<TestProjectLock>(join(projectRoot, 'recovery', 'project.lock'))).toEqual(
      session.lock,
    );
  });

  it('rejects saveAs when the stable snapshot path escapes snapshots and leaves no destination', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const sourceRoot = join(tempRoot, 'TraversalSource.novus-project');
    const destinationRoot = join(tempRoot, 'Traversal Copy.novus-project');
    const repository = createRepository({ processId: 11102 });

    const source = await repository.create(sourceRoot, {
      project: starterProject,
      projectId: 'project-traversal-source',
      projectName: 'TraversalSource',
    });
    const sourceManifest = source.manifest;
    const outsideProject = {
      nodes: [{ id: 'outside-project-state' }],
    };
    await writeSnapshotEnvelope(join(tempRoot, 'outside.json'), {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      projectId: sourceManifest.projectId,
      snapshotId: sourceManifest.stableSnapshotId!,
      previousSnapshotId: null,
      revision: sourceManifest.stableSnapshotRevision,
      createdAt: baseNow.toISOString(),
      project: outsideProject,
      projectSha256: sha256Canonical(outsideProject),
    });
    const tamperedSource: OpenedProjectSession = {
      ...source,
      manifest: {
        ...source.manifest,
        stableSnapshotPath: '../outside.json',
      },
    };

    await expect(repository.saveAs(tamperedSource, destinationRoot)).rejects.toThrow(
      /stable snapshot path/i,
    );
    await expect(stat(destinationRoot)).rejects.toThrow();
  });

  it('rejects saveAs when the stable snapshot path is absolute and leaves no destination', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const sourceRoot = join(tempRoot, 'AbsoluteSource.novus-project');
    const destinationRoot = join(tempRoot, 'Absolute Copy.novus-project');
    const repository = createRepository({ processId: 11103 });

    const source = await repository.create(sourceRoot, {
      project: starterProject,
      projectId: 'project-absolute-source',
      projectName: 'AbsoluteSource',
    });
    const sourceManifest = source.manifest;
    const outsideProject = {
      nodes: [{ id: 'absolute-project-state' }],
    };
    const absoluteSnapshotPath = join(tempRoot, 'absolute.json');
    await writeSnapshotEnvelope(absoluteSnapshotPath, {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      projectId: sourceManifest.projectId,
      snapshotId: sourceManifest.stableSnapshotId!,
      previousSnapshotId: null,
      revision: sourceManifest.stableSnapshotRevision,
      createdAt: baseNow.toISOString(),
      project: outsideProject,
      projectSha256: sha256Canonical(outsideProject),
    });
    const tamperedSource: OpenedProjectSession = {
      ...source,
      manifest: {
        ...source.manifest,
        stableSnapshotPath: absoluteSnapshotPath,
      },
    };

    await expect(repository.saveAs(tamperedSource, destinationRoot)).rejects.toThrow(
      /stable snapshot path/i,
    );
    await expect(stat(destinationRoot)).rejects.toThrow();
  });

  it.each([
    [
      'schema version',
      (snapshot: SnapshotEnvelope): unknown => ({
        ...snapshot,
        schemaVersion: SNAPSHOT_SCHEMA_VERSION + 1,
      }),
    ],
    [
      'project id',
      (snapshot: SnapshotEnvelope): unknown => ({
        ...snapshot,
        projectId: 'different-project',
      }),
    ],
    [
      'snapshot id',
      (snapshot: SnapshotEnvelope): unknown => ({
        ...snapshot,
        snapshotId: 'different-snapshot',
      }),
    ],
    [
      'revision',
      (snapshot: SnapshotEnvelope): unknown => ({
        ...snapshot,
        revision: snapshot.revision + 1,
      }),
    ],
    [
      'checksum',
      (snapshot: SnapshotEnvelope): unknown => ({
        ...snapshot,
        projectSha256: 'incorrect-checksum',
      }),
    ],
    [
      'project shape',
      (snapshot: SnapshotEnvelope): unknown => {
        const { project: _project, ...withoutProject } = snapshot;
        return withoutProject;
      },
    ],
  ])('rejects saveAs when the stable snapshot envelope has an invalid %s', async (_caseName, mutate) => {
    const tempRoot = await createTempRoot(tempRoots);
    const sourceRoot = join(tempRoot, 'EnvelopeSource.novus-project');
    const destinationRoot = join(tempRoot, 'Envelope Copy.novus-project');
    const repository = createRepository({ processId: 11104 });

    const source = await repository.create(sourceRoot, {
      project: starterProject,
      projectId: 'project-envelope-source',
      projectName: 'EnvelopeSource',
    });
    const sourceManifest = await readProjectManifest(sourceRoot);
    const snapshotPath = join(sourceRoot, ...sourceManifest.stableSnapshotPath!.split('/'));
    const snapshot = await readJson<SnapshotEnvelope>(snapshotPath);
    await writeFile(snapshotPath, `${JSON.stringify(mutate(snapshot))}\n`, 'utf8');

    await expect(repository.saveAs(source, destinationRoot)).rejects.toThrow(/stable snapshot/i);
    await expect(stat(destinationRoot)).rejects.toThrow();
  });

  it('saveAs opens the destination as the writable owner even from a read-only source session', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const sourceRoot = join(tempRoot, 'Source.novus-project');
    const destinationRoot = join(tempRoot, 'Source Copy.novus-project');
    const firstRepository = createRepository({ processId: 10101 });
    const secondRepository = createRepository({ processId: 11101 });
    const thirdRepository = createRepository({ processId: 12101 });
    const sourceProject = makeCanvasProject('project-source');

    const source = await firstRepository.create(sourceRoot, {
      project: sourceProject,
      projectId: sourceProject.id,
      projectName: 'Source',
    });
    const readOnlySource = await secondRepository.open(sourceRoot, { mode: 'write' });

    expect(readOnlySource.mode).toBe('read_only');

    const copied = await secondRepository.saveAs(readOnlySource, destinationRoot);

    expect(copied.mode).toBe('write');
    expect(copied.root).toBe(destinationRoot);
    expect(copied.manifest.projectId).not.toBe(source.manifest.projectId);
    expect(JSON.stringify(copied.manifest)).not.toContain(tempRoot);

    const competingCopyWriter = await thirdRepository.open(destinationRoot, { mode: 'write' });
    expect(competingCopyWriter.mode).toBe('read_only');

    const originalStillLocked = await thirdRepository.open(sourceRoot, { mode: 'write' });
    expect(originalStillLocked.mode).toBe('read_only');
  });

  it('saveAs copies the stable snapshot replayed through committed journal records', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const sourceRoot = join(tempRoot, 'JournalSource.novus-project');
    const destinationRoot = join(tempRoot, 'JournalSource Copy.novus-project');
    const repository = createRepository({ processId: 11105 });
    const sourceProject = makeCanvasProject('project-journal-save-as');

    const source = await repository.create(sourceRoot, {
      project: sourceProject,
      projectId: sourceProject.id,
      projectName: 'JournalSource',
    });
    const writer = await repository.openJournalWriter(source, { now: () => baseNow });
    await writer.commit(
      makeCreatePromptCommitRequest(source.manifest.projectId, 'tx-save-as-node', 0, 'prompt-save-as'),
    );

    const copied = await repository.saveAs(source, destinationRoot);
    const copiedManifest = await readProjectManifest(destinationRoot);
    const copiedSnapshot = await readJson<SnapshotEnvelope>(
      join(destinationRoot, ...copiedManifest.stableSnapshotPath!.split('/')),
    );

    expect(copied.mode).toBe('write');
    expect(readProjectNodeIds(copiedSnapshot.project)).toContain('prompt-save-as');
  });

  it('saveAs rewrites CanvasProject identity and remains replayable after copying journaled state', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const sourceRoot = join(tempRoot, 'IdentitySource.novus-project');
    const destinationRoot = join(tempRoot, 'Identity Copy.novus-project');
    const repository = createRepository({ processId: 11108 });
    const sourceProject = makeCanvasProjectWithMemory('project-identity-source');

    const source = await repository.create(sourceRoot, {
      project: sourceProject,
      projectId: sourceProject.id,
      projectName: 'IdentitySource',
    });
    const writer = await repository.openJournalWriter(source, { now: () => baseNow });
    await writer.commit(makeIdentityJournalCommitRequest(sourceProject.id));

    const copied = await repository.saveAs(source, destinationRoot);
    const copiedManifest = await readProjectManifest(destinationRoot);
    const copiedSnapshot = await readJson<SnapshotEnvelope>(
      join(destinationRoot, ...copiedManifest.stableSnapshotPath!.split('/')),
    );
    const copiedProject = copiedSnapshot.project as CanvasProject;
    const sourceManifest = await readProjectManifest(sourceRoot);
    const sourceSnapshot = await readJson<SnapshotEnvelope>(
      join(sourceRoot, ...sourceManifest.stableSnapshotPath!.split('/')),
    );

    expect(copied.manifest.projectId).toBe(copiedProject.id);
    expect(copiedProject.name).toBe('Identity Copy');
    expect(copiedProject.projectMemory.map((entry) => entry.projectId)).toEqual([
      copiedProject.id,
      copiedProject.id,
    ]);
    expect(copiedProject.skillPromotionCandidates.map((candidate) => candidate.sourceProjectId)).toEqual([
      copiedProject.id,
    ]);
    expect(copiedProject.projectMemory.map((entry) => entry.title)).toEqual([
      'Initial optimization',
      'Journaled generation',
    ]);
    expect(readProjectNodeIds(copiedSnapshot.project)).toEqual([
      'reference-identity',
      'prompt-journaled',
    ]);
    expect((sourceSnapshot.project as CanvasProject).id).toBe(sourceProject.id);
    expect((sourceSnapshot.project as CanvasProject).projectMemory[0]!.projectId).toBe(sourceProject.id);

    const copiedWriter = await repository.openJournalWriter(copied, { now: () => baseNow });
    await copiedWriter.commit(
      makeCreatePromptCommitRequest(copiedProject.id, 'tx-copy-replay', 0, 'prompt-copy-replay'),
    );
    const copiedJournalRecords = await readValidJournal(join(destinationRoot, 'journal', 'active.ndjson'), {
      baseRevision: copiedManifest.stableSnapshotRevision,
      expectedProjectId: copiedProject.id,
      firstSequence: copiedManifest.nextSequence,
    });
    const copiedJournal = replayJournal(
      copiedProject,
      copiedManifest.stableSnapshotRevision,
      copiedJournalRecords.records,
    );

    expect(copiedJournal.revision).toBe(1);
    expect(readProjectNodeIds(copiedJournal.project)).toContain('prompt-copy-replay');
  });

  it('saveAs tolerates an incomplete final journal tail while copying committed records', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const sourceRoot = join(tempRoot, 'PartialTailSource.novus-project');
    const destinationRoot = join(tempRoot, 'PartialTailSource Copy.novus-project');
    const repository = createRepository({ processId: 11106 });
    const sourceProject = makeCanvasProject('project-partial-tail-save-as');

    const source = await repository.create(sourceRoot, {
      project: sourceProject,
      projectId: sourceProject.id,
      projectName: 'PartialTailSource',
    });
    const writer = await repository.openJournalWriter(source, { now: () => baseNow });
    await writer.commit(
      makeCreatePromptCommitRequest(source.manifest.projectId, 'tx-save-as-partial', 0, 'prompt-partial'),
    );
    const activeJournal = join(sourceRoot, 'journal', 'active.ndjson');
    await writeFile(activeJournal, `${await readFile(activeJournal, 'utf8')}{"schemaVersion":`, 'utf8');

    await repository.saveAs(source, destinationRoot);
    const copiedManifest = await readProjectManifest(destinationRoot);
    const copiedSnapshot = await readJson<SnapshotEnvelope>(
      join(destinationRoot, ...copiedManifest.stableSnapshotPath!.split('/')),
    );

    expect(readProjectNodeIds(copiedSnapshot.project)).toContain('prompt-partial');
  });

  it('rejects saveAs when the active journal contains a corrupt committed record', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const sourceRoot = join(tempRoot, 'CorruptJournalSource.novus-project');
    const destinationRoot = join(tempRoot, 'CorruptJournalSource Copy.novus-project');
    const repository = createRepository({ processId: 11107 });
    const sourceProject = makeCanvasProject('project-corrupt-journal-save-as');

    const source = await repository.create(sourceRoot, {
      project: sourceProject,
      projectId: sourceProject.id,
      projectName: 'CorruptJournalSource',
    });
    const writer = await repository.openJournalWriter(source, { now: () => baseNow });
    await writer.commit(
      makeCreatePromptCommitRequest(source.manifest.projectId, 'tx-save-as-corrupt', 0, 'prompt-corrupt'),
    );
    const activeJournal = join(sourceRoot, 'journal', 'active.ndjson');
    await writeFile(activeJournal, `${await readFile(activeJournal, 'utf8')}not-json\n`, 'utf8');

    await expect(repository.saveAs(source, destinationRoot)).rejects.toMatchObject({
      code: 'CORRUPT_JOURNAL',
      retryable: false,
    });
    await expect(stat(destinationRoot)).rejects.toThrow();
  });

  it('removes a newly-created root when project creation fails before manifest completion', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const projectRoot = join(tempRoot, 'ManifestRollback.novus-project');
    const repository = createRepository({
      fileSystem: new FailRenameFileSystem(join(projectRoot, 'project.novus.json')),
      processId: 13101,
    });

    await expect(
      repository.create(projectRoot, {
        project: starterProject,
        projectId: 'project-manifest-rollback',
        projectName: 'ManifestRollback',
      }),
    ).rejects.toThrow(/injected rename failure/i);

    await expect(stat(projectRoot)).rejects.toThrow();
  });

  it('preserves a pre-existing destination root when create fails before ownership', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const projectRoot = join(tempRoot, 'ExistingDestination.novus-project');
    const sentinelPath = join(projectRoot, 'sentinel.txt');
    const repository = createRepository({ processId: 13103 });
    await mkdir(projectRoot);
    await writeFile(sentinelPath, 'keep-me', 'utf8');

    await expect(
      repository.create(projectRoot, {
        project: starterProject,
        projectId: 'project-existing-destination',
        projectName: 'ExistingDestination',
      }),
    ).rejects.toThrow();

    await expect(readFile(sentinelPath, 'utf8')).resolves.toBe('keep-me');
  });

  it('removes a newly-created root when project creation fails before lock acquisition', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const projectRoot = join(tempRoot, 'LockRollback.novus-project');
    const repository = createRepository({
      fileSystem: new FailOpenFileSystem(join(projectRoot, 'recovery', 'project.lock')),
      processId: 13102,
    });

    await expect(
      repository.create(projectRoot, {
        project: starterProject,
        projectId: 'project-lock-rollback',
        projectName: 'LockRollback',
      }),
    ).rejects.toThrow(/injected open failure/i);

    await expect(stat(projectRoot)).rejects.toThrow();
  });

  it.each([
    ['sync', 'atomic-sync.txt', true],
    ['rename', 'atomic-rename.txt', false],
  ])('cleans writeAtomic temp files after a failing %s without promoting the target', async (_caseName, fileName, failSync) => {
    const tempRoot = await createTempRoot(tempRoots);
    const targetPath = join(tempRoot, fileName);
    const fileSystem = failSync
      ? new FailSyncFileSystem()
      : new FailRenameFileSystem(targetPath, { preserveTarget: true });

    if (!failSync) {
      await writeFile(targetPath, 'old-value', 'utf8');
    }

    await expect(writeAtomic(fileSystem, targetPath, 'new-value')).rejects.toThrow(/injected/i);

    if (failSync) {
      await expect(access(targetPath)).rejects.toThrow();
      expect(await readdir(tempRoot)).toEqual([]);
    } else {
      await expect(readFile(targetPath, 'utf8')).resolves.toBe('old-value');
      expect(await readdir(tempRoot)).toEqual([fileName]);
    }
  });
});

function createRepository(overrides: Partial<ConstructorParameters<typeof ProjectRepository>[0]> = {}) {
  let idCounter = 0;

  return new ProjectRepository({
    channel: 'modern',
    createId: () => `generated-${++idCounter}`,
    deviceId: 'device-under-test',
    fileSystem: new NodeFileSystem(),
    now: () => new Date(baseNow),
    processId: 2101,
    ...overrides,
  });
}

async function createTempRoot(tempRoots: string[]) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'desktop-core-project-repository-'));
  tempRoots.push(tempRoot);
  return tempRoot;
}

function makeCanvasProject(projectId: string): CanvasProject {
  return {
    version: 1,
    id: projectId,
    name: 'Save As Journal Project',
    nodes: [],
    edges: [],
    projectMemory: [],
    skillPromotionCandidates: [],
  };
}

function makeCanvasProjectWithMemory(projectId: string): CanvasProject {
  const memory = makeProjectMemoryEntry(projectId, 'memory-initial-optimization', 0, 'Initial optimization');

  return {
    version: 1,
    id: projectId,
    name: 'Identity Source',
    nodes: [{
      id: 'reference-identity',
      type: 'reference',
      position: { x: 0, y: 0 },
      data: { assetId: 'asset-stable-1', role: 'product_identity' },
    }],
    edges: [],
    projectMemory: [memory],
    skillPromotionCandidates: [{
      schemaVersion: 1,
      id: 'candidate-initial-optimization',
      sourceProjectId: projectId,
      sourceProjectMemoryId: memory.id,
      createdAt: baseNow.toISOString(),
      title: memory.title,
      rationale: memory.rationale,
      rule: memory.nextStep,
      evidence: memory.feedback,
      reviewStatus: 'pending_review',
    }],
  };
}

function makeProjectMemoryEntry(
  projectId: string,
  id: string,
  projectRevision: number,
  title: string,
) {
  return {
    schemaVersion: 1 as const,
    id,
    projectId,
    projectRevision,
    createdAt: baseNow.toISOString(),
    kind: 'optimization' as const,
    actor: 'agent' as const,
    title,
    changeSummary: `${title} summary`,
    rationale: `${title} rationale`,
    snapshots: {
      beforeId: `${id}-before`,
      afterId: `${id}-after`,
    },
    context: {
      referenceAssetIds: ['asset-stable-1'],
      resultAssetIds: ['asset-result-1'],
    },
    feedback: {
      keep: ['Keep lighting'],
      change: ['Reduce clutter'],
      never: ['Avoid cropped product'],
      score: 5,
    },
    nextStep: `${title} reusable rule`,
  };
}

function makeIdentityJournalCommitRequest(projectId: string): CommitRequest {
  return {
    projectId,
    baseRevision: 0,
    kind: 'canvas',
    transaction: {
      id: 'tx-save-as-identity',
      label: 'append memory and prompt',
      operations: [
        {
          kind: 'append_project_memory',
          entry: makeProjectMemoryEntry(projectId, 'memory-journaled-generation', 1, 'Journaled generation'),
        },
        {
          kind: 'canvas',
          operation: {
            kind: 'create_node',
            node: makePromptNode('prompt-journaled'),
          },
        },
      ],
    },
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
    kind: 'canvas',
    transaction: {
      id: transactionId,
      label: `create ${nodeId}`,
      operations: [
        { kind: 'canvas', operation: { kind: 'create_node', node: makePromptNode(nodeId) } },
      ],
    },
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

function readProjectNodeIds(project: SnapshotEnvelope['project']): string[] {
  const nodes = project.nodes;
  if (!Array.isArray(nodes)) {
    return [];
  }

  return nodes
    .map((node) => {
      if (node !== null && typeof node === 'object' && 'id' in node && typeof node.id === 'string') {
        return node.id;
      }
      return null;
    })
    .filter((id): id is string => id !== null);
}

async function expectLayout(projectRoot: string) {
  expect(await readdir(projectRoot)).toEqual(
    expect.arrayContaining([
      'assets',
      'indexes',
      'journal',
      'project.novus.json',
      'recovery',
      'snapshots',
    ]),
  );
  expect(await readdir(join(projectRoot, 'journal'))).toEqual(
    expect.arrayContaining(['active.ndjson', 'archive']),
  );
  expect(await readdir(join(projectRoot, 'recovery'))).toEqual(
    expect.arrayContaining(['clean-close.json', 'project.lock', 'quarantine']),
  );
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function writeProjectLock(projectRoot: string, lock: TestProjectLock) {
  await writeFile(join(projectRoot, 'recovery', 'project.lock'), `${JSON.stringify(lock)}\n`, 'utf8');
}

async function readProjectManifest(projectRoot: string): Promise<ProjectManifest> {
  return readJson<ProjectManifest>(join(projectRoot, 'project.novus.json'));
}

async function writeSnapshotEnvelope(path: string, snapshot: SnapshotEnvelope) {
  await writeFile(path, `${JSON.stringify(snapshot)}\n`, 'utf8');
}

interface DeferredVoid {
  readonly promise: Promise<void>;
  resolve(): void;
}

interface OperationWindowCoordinator {
  readonly operationStarted: DeferredVoid;
  readonly concurrentAttemptDone: DeferredVoid;
}

function createOperationWindowCoordinator(): OperationWindowCoordinator {
  return {
    concurrentAttemptDone: createDeferredVoid(),
    operationStarted: createDeferredVoid(),
  };
}

function createDeferredVoid(): DeferredVoid {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((resolvePromise) => {
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

  async unlink(path: string): Promise<void> {
    await this.delegate.unlink(path);
  }

  async writeFile(path: string, data: string, encoding: BufferEncoding): Promise<void> {
    await this.delegate.writeFile(path, data, encoding);
  }
}

class PauseDuringLockOperationFileSystem extends DelegatingFileSystem {
  private readonly lockPath: string;
  private readonly guardPath: string;
  private readonly coordinator: OperationWindowCoordinator;
  private paused = false;

  constructor(
    lockPath: string,
    guardPath: string,
    coordinator: OperationWindowCoordinator,
  ) {
    super();
    this.lockPath = lockPath;
    this.guardPath = guardPath;
    this.coordinator = coordinator;
  }

  override async open(path: string, flags: string): Promise<FileHandleLike> {
    const handle = await super.open(path, flags);
    if (flags === 'wx' && samePath(path, this.guardPath)) {
      await this.pauseOnce();
    }
    return handle;
  }

  override async rename(source: string, destination: string): Promise<void> {
    await super.rename(source, destination);
    if (samePath(source, this.lockPath)) {
      await this.pauseOnce();
    }
  }

  private async pauseOnce(): Promise<void> {
    if (this.paused) {
      return;
    }

    this.paused = true;
    this.coordinator.operationStarted.resolve();
    await this.coordinator.concurrentAttemptDone.promise;
  }
}

class FailOpenFileSystem extends DelegatingFileSystem {
  private readonly targetPath: string;

  constructor(targetPath: string) {
    super();
    this.targetPath = targetPath;
  }

  override async open(path: string, flags: string): Promise<FileHandleLike> {
    if (flags === 'wx' && samePath(path, this.targetPath)) {
      throw new Error('injected open failure');
    }

    return super.open(path, flags);
  }
}

class FailRmFileSystem extends DelegatingFileSystem {
  private readonly targetPath: string;

  constructor(targetPath: string) {
    super();
    this.targetPath = targetPath;
  }

  override async rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void> {
    if (samePath(path, this.targetPath)) {
      throw new Error('injected rm failure');
    }

    await super.rm(path, options);
  }
}

class FailRenameFileSystem extends DelegatingFileSystem {
  private readonly targetPath: string;

  constructor(targetPath: string, _options: { preserveTarget?: boolean } = {}) {
    super();
    this.targetPath = targetPath;
  }

  override async rename(source: string, destination: string): Promise<void> {
    if (samePath(destination, this.targetPath)) {
      throw new Error('injected rename failure');
    }

    await super.rename(source, destination);
  }
}

class FailSyncFileSystem extends DelegatingFileSystem {
  override async open(path: string, flags: string): Promise<FileHandleLike> {
    return new FailSyncHandle(await super.open(path, flags));
  }
}

class FailSyncHandle implements FileHandleLike {
  private readonly handle: FileHandleLike;

  constructor(handle: FileHandleLike) {
    this.handle = handle;
  }

  async close(): Promise<void> {
    await this.handle.close();
  }

  async sync(): Promise<void> {
    throw new Error('injected sync failure');
  }

  async writeFile(data: string | Uint8Array): Promise<void> {
    await this.handle.writeFile(data);
  }
}

function samePath(left: string, right: string): boolean {
  return normalize(left).toLowerCase() === normalize(right).toLowerCase();
}
