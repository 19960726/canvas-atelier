import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, normalize } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { sha256Canonical } from './canonical-json';
import {
  SNAPSHOT_SCHEMA_VERSION,
  STALE_LOCK_MS,
  type ProjectManifest,
  type SnapshotEnvelope,
} from './contracts';
import { NodeFileSystem, writeAtomic, type FileHandleLike, type FileSystem } from './file-system';
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

  it('allows at most one writer when two stale-lock reclaimers race around a replacement lock', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const projectRoot = join(tempRoot, 'StaleRace.novus-project');
    const lockPath = join(projectRoot, 'recovery', 'project.lock');
    const repository = createRepository({ processId: 5102 });

    const created = await repository.create(projectRoot, {
      project: starterProject,
      projectId: 'project-stale-race',
      projectName: 'StaleRace',
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

    const coordinator = createReclaimRaceCoordinator();
    const firstRepository = createRepository({
      fileSystem: new ReclaimRaceFileSystem('first', lockPath, coordinator),
      isLocalProcessAlive: () => false,
      processId: 6201,
    });
    const secondRepository = createRepository({
      fileSystem: new ReclaimRaceFileSystem('second', lockPath, coordinator),
      isLocalProcessAlive: () => false,
      processId: 6202,
    });

    const sessions = await Promise.all([
      firstRepository.open(projectRoot, { mode: 'write' }),
      secondRepository.open(projectRoot, { mode: 'write' }),
    ]);

    const writeSessions = sessions.filter((session) => session.mode === 'write');
    expect(writeSessions).toHaveLength(1);

    const activeLock = await readJson<TestProjectLock>(lockPath);
    expect(activeLock.sessionId).toBe(writeSessions[0]!.lock!.sessionId);
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

  it('leaves a replacement writer lock intact when close races between ownership check and removal', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const projectRoot = join(tempRoot, 'CloseRace.novus-project');
    const lockPath = join(projectRoot, 'recovery', 'project.lock');
    const repository = createRepository({ processId: 10102 });

    const session = await repository.create(projectRoot, {
      project: starterProject,
      projectId: 'project-close-race',
      projectName: 'CloseRace',
    });

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

    await createRepository({
      fileSystem: new ReplaceLockDuringRemovalFileSystem(lockPath, replacementLock),
      processId: 10102,
    }).close(session);

    const activeLock = await readJson<TestProjectLock>(lockPath);
    expect(activeLock).toMatchObject({
      processId: 10103,
      sessionId: 'replacement-session',
    });
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

    const source = await firstRepository.create(sourceRoot, {
      project: starterProject,
      projectId: 'project-source',
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

interface ReclaimRaceCoordinator {
  readonly secondReadyToUnlink: DeferredVoid;
  readonly firstReplacementLockClosed: DeferredVoid;
}

function createReclaimRaceCoordinator(): ReclaimRaceCoordinator {
  return {
    firstReplacementLockClosed: createDeferredVoid(),
    secondReadyToUnlink: createDeferredVoid(),
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

class ReclaimRaceFileSystem extends DelegatingFileSystem {
  private readonly role: 'first' | 'second';
  private readonly lockPath: string;
  private readonly coordinator: ReclaimRaceCoordinator;

  constructor(role: 'first' | 'second', lockPath: string, coordinator: ReclaimRaceCoordinator) {
    super();
    this.role = role;
    this.lockPath = lockPath;
    this.coordinator = coordinator;
  }

  override async open(path: string, flags: string): Promise<FileHandleLike> {
    const handle = await super.open(path, flags);
    if (this.role === 'first' && flags === 'wx' && samePath(path, this.lockPath)) {
      return new SignalOnCloseHandle(handle, () => this.coordinator.firstReplacementLockClosed.resolve());
    }
    return handle;
  }

  override async rename(source: string, destination: string): Promise<void> {
    if (samePath(source, this.lockPath)) {
      if (this.role === 'first') {
        await this.coordinator.secondReadyToUnlink.promise;
      } else {
        this.coordinator.secondReadyToUnlink.resolve();
        await this.coordinator.firstReplacementLockClosed.promise;
      }
    }

    await super.rename(source, destination);
  }

  override async unlink(path: string): Promise<void> {
    if (samePath(path, this.lockPath)) {
      if (this.role === 'first') {
        await this.coordinator.secondReadyToUnlink.promise;
      } else {
        this.coordinator.secondReadyToUnlink.resolve();
        await this.coordinator.firstReplacementLockClosed.promise;
      }
    }

    await super.unlink(path);
  }
}

class ReplaceLockDuringRemovalFileSystem extends DelegatingFileSystem {
  private readonly lockPath: string;
  private readonly replacementLock: TestProjectLock;
  private injected = false;

  constructor(lockPath: string, replacementLock: TestProjectLock) {
    super();
    this.lockPath = lockPath;
    this.replacementLock = replacementLock;
  }

  override async rename(source: string, destination: string): Promise<void> {
    if (samePath(source, this.lockPath)) {
      await super.rename(source, destination);
      await this.injectReplacement();
      return;
    }

    await super.rename(source, destination);
  }

  override async unlink(path: string): Promise<void> {
    if (samePath(path, this.lockPath)) {
      await this.injectReplacement();
    }

    await super.unlink(path);
  }

  private async injectReplacement(): Promise<void> {
    if (this.injected) {
      return;
    }

    this.injected = true;
    await writeFile(this.lockPath, `${JSON.stringify(this.replacementLock)}\n`, 'utf8');
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

class SignalOnCloseHandle implements FileHandleLike {
  private readonly handle: FileHandleLike;
  private readonly onClose: () => void;

  constructor(handle: FileHandleLike, onClose: () => void) {
    this.handle = handle;
    this.onClose = onClose;
  }

  async close(): Promise<void> {
    try {
      await this.handle.close();
    } finally {
      this.onClose();
    }
  }

  async sync(): Promise<void> {
    await this.handle.sync();
  }

  async writeFile(data: string | Uint8Array): Promise<void> {
    await this.handle.writeFile(data);
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
