import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { STALE_LOCK_MS } from './contracts';
import { NodeFileSystem } from './file-system';
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
