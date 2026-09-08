import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { NodeFileSystem } from './file-system';
import { RecentProjectStore, createRecentProjectId } from './recent-project-store';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('recent project store', () => {
  it('persists safe summaries, deduplicates by project identity, and sorts most recently opened first', async () => {
    const fixture = await createFixture();
    const firstRoot = await createProjectRoot(fixture.workspaceRoot, 'First Project', 'project-first', true);
    const secondRoot = await createProjectRoot(fixture.workspaceRoot, 'Second Project', 'project-second', true);
    const movedFirstRoot = await createProjectRoot(fixture.workspaceRoot, 'First Project Moved', 'project-first', false);
    const store = new RecentProjectStore({ appDataRoot: fixture.appDataRoot });

    await store.upsert({
      root: firstRoot,
      projectId: 'project-first',
      displayName: 'First Project',
      lastOpenedAt: '2026-08-08T08:00:00.000Z',
      lastSavedAt: '2026-08-08T08:05:00.000Z',
      nodeCount: 3,
      imageCount: 2,
      videoCount: 1,
    });
    await store.upsert({
      root: secondRoot,
      projectId: 'project-second',
      displayName: 'Second Project',
      lastOpenedAt: '2026-08-09T08:00:00.000Z',
      lastSavedAt: '2026-08-09T08:05:00.000Z',
      nodeCount: 8,
      imageCount: 4,
      videoCount: 2,
    });
    await store.upsert({
      root: movedFirstRoot,
      projectId: 'project-first',
      displayName: 'First Project Moved',
      lastOpenedAt: '2026-08-10T08:00:00.000Z',
      lastSavedAt: '2026-08-10T08:05:00.000Z',
      nodeCount: 5,
      imageCount: 3,
      videoCount: 2,
    });

    const summaries = await new RecentProjectStore({ appDataRoot: fixture.appDataRoot }).list();

    expect(summaries.map((summary) => summary.projectId)).toEqual(['project-first', 'project-second']);
    expect(summaries[0]).toMatchObject({
      displayName: 'First Project Moved',
      availability: 'available',
      nodeCount: 5,
      imageCount: 3,
      videoCount: 2,
      previewUrl: null,
    });
    expect(summaries[1]?.previewUrl).toMatch(/^novus-recent-project:\/\/[a-z0-9_-]+\/preview$/u);
    await expect(store.resolvePreviewPath(summaries[1]!.recentProjectId))
      .resolves.toBe(join(secondRoot, 'preview.png'));
    expect(summaries.every((summary) => /^recent_[a-f0-9]{24}$/u.test(summary.recentProjectId))).toBe(true);

    const publicPayload = JSON.stringify(summaries);
    expect(publicPayload).not.toContain(fixture.workspaceRoot);
    expect(publicPayload).not.toContain('project.novus.json');
    expect(publicPayload).not.toMatch(/[A-Za-z]:\\/u);

    const internalIndex = JSON.parse(
      await readFile(join(fixture.appDataRoot, 'recent-projects.index.json'), 'utf8'),
    ) as { entries: Array<{ root: string }> };
    expect(internalIndex.entries.map((entry) => entry.root)).toContain(movedFirstRoot);
    expect(internalIndex.entries.map((entry) => entry.root)).not.toContain(firstRoot);
  });

  it('marks missing projects without deleting the index and removes only the recent entry', async () => {
    const fixture = await createFixture();
    const projectRoot = await createProjectRoot(fixture.workspaceRoot, 'Missing Later', 'project-missing', true);
    const store = new RecentProjectStore({ appDataRoot: fixture.appDataRoot });
    await store.upsert({
      root: projectRoot,
      projectId: 'project-missing',
      displayName: 'Missing Later',
      lastOpenedAt: '2026-08-10T09:00:00.000Z',
      lastSavedAt: '2026-08-10T09:01:00.000Z',
      nodeCount: 1,
      imageCount: 1,
      videoCount: 0,
    });
    await rm(projectRoot, { force: true, recursive: true });

    const [missing] = await store.list();
    expect(missing).toMatchObject({ availability: 'missing', previewUrl: null });
    expect(await store.resolveRoot(missing!.recentProjectId)).toBeNull();

    const remaining = await store.remove(missing!.recentProjectId);
    expect(remaining).toEqual([]);
    expect(await readFile(join(fixture.appDataRoot, 'recent-projects.index.json'), 'utf8')).not.toContain('project-missing');
  });

  it('removes recent entries without deleting managed or external project directories', async () => {
    const fixture = await createFixture();
    const managedRoot = await createProjectRoot(
      join(fixture.appDataRoot, 'projects'),
      'Managed Canvas',
      'project-managed',
      false,
    );
    const externalRoot = await createProjectRoot(
      fixture.workspaceRoot,
      'External Canvas',
      'project-external',
      false,
    );
    const store = new RecentProjectStore({ appDataRoot: fixture.appDataRoot });

    await store.upsert(createEntry(managedRoot, 'project-managed', 'Managed Canvas'));
    await store.upsert(createEntry(externalRoot, 'project-external', 'External Canvas'));
    const summaries = await store.list();

    await store.remove(summaries.find((item) => item.projectId === 'project-managed')!.recentProjectId);
    await expect(access(managedRoot)).resolves.toBeUndefined();

    await store.remove(summaries.find((item) => item.projectId === 'project-external')!.recentProjectId);
    await expect(access(externalRoot)).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([]);
  });

  it('serializes concurrent read-modify-write updates from different project sessions', async () => {
    const fixture = await createFixture();
    const firstRoot = await createProjectRoot(fixture.workspaceRoot, 'Concurrent First', 'project-concurrent-first', true);
    const secondRoot = await createProjectRoot(fixture.workspaceRoot, 'Concurrent Second', 'project-concurrent-second', true);
    const fileSystem = new CoordinatedRecentFileSystem();
    const store = new RecentProjectStore({ appDataRoot: fixture.appDataRoot, fileSystem });

    const first = store.upsert(createEntry(firstRoot, 'project-concurrent-first', 'Concurrent First'));
    await fileSystem.firstIndexReadStarted;
    const second = store.upsert(createEntry(secondRoot, 'project-concurrent-second', 'Concurrent Second'));
    fileSystem.releaseFirstIndexRead();
    await fileSystem.secondIndexReadStarted;
    fileSystem.releaseSecondIndexRead();
    await Promise.all([first, second]);

    await expect(store.list()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ projectId: 'project-concurrent-first' }),
      expect.objectContaining({ projectId: 'project-concurrent-second' }),
    ]));
  });

  it('returns recent projects when an old project path never finishes its availability stat', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fixture = await createFixture();
    const availableRoot = await createProjectRoot(fixture.workspaceRoot, 'Available Project', 'project-available', true);
    const stalledRoot = ['', '', 'offline-server', 'archive', 'Stalled.novus-project'].join('\\');
    const fileSystem = new StalledStatFileSystem(stalledRoot, availableRoot);
    const store = new RecentProjectStore({ appDataRoot: fixture.appDataRoot, fileSystem });
    await writeRecentIndex(fixture.appDataRoot, [
      createEntry(availableRoot, 'project-available', 'Available Project'),
      createEntry(stalledRoot, 'project-stalled', 'Stalled Project'),
    ]);

    try {
      const outcome = Promise.race([
        store.list().then((summaries) => ({ kind: 'listed' as const, summaries })),
        new Promise<{ readonly kind: 'test_timeout' }>((resolve) => {
          setTimeout(() => resolve({ kind: 'test_timeout' }), 30_000);
        }),
      ]);
      await fileSystem.stalledStatStarted;
      await vi.advanceTimersByTimeAsync(30_001);

      await expect(outcome).resolves.toMatchObject({
        kind: 'listed',
        summaries: expect.arrayContaining([
          expect.objectContaining({ availability: 'available', projectId: 'project-available' }),
          expect.objectContaining({ availability: 'missing', previewUrl: null, projectId: 'project-stalled' }),
        ]),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('limits repeated mapped-drive stats without blocking a later recent-project index write', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fixture = await createFixture();
    const availableRoot = await createProjectRoot(fixture.workspaceRoot, 'Still Writable', 'project-writable', true);
    const stalledRoots = Array.from({ length: 7 }, (_, index) => ['Z:', `offline-${index}`, 'archive', 'Stalled.novus-project'].join(String.fromCharCode(92)));
    const indexPath = join(fixture.appDataRoot, 'recent-projects.index.json');
    const fileSystem = new MultipleStalledStatFileSystem(stalledRoots, indexPath);
    const store = new RecentProjectStore({ appDataRoot: fixture.appDataRoot, fileSystem });
    await writeRecentIndex(fixture.appDataRoot, stalledRoots.map((root, index) => createEntry(root, `project-stalled-${index}`, `Stalled ${index}`)));

    try {
      const firstList = store.list();
      await fileSystem.firstStalledStatStarted;
      await vi.advanceTimersByTimeAsync(2_001);
      await expect(firstList).resolves.toHaveLength(stalledRoots.length);
      expect(fileSystem.rawStatStarts).toBe(1);

      for (let index = 0; index < 3; index += 1) {
        const repeatedList = store.list();
        await fileSystem.waitForIndexReads(index + 2);
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(2_001);
        await expect(repeatedList).resolves.toHaveLength(stalledRoots.length);
        expect(fileSystem.rawStatStarts).toBe(1);
      }

      const upsert = store.upsert(createEntry(availableRoot, 'project-writable', 'Still Writable'));
      await fileSystem.indexWriteCommitted;
      const persisted = JSON.parse(await readFile(indexPath, 'utf8')) as { entries: Array<{ projectId: string }> };
      expect(persisted.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ projectId: 'project-writable' }),
      ]));
      await fileSystem.waitForIndexReads(6);
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2_001);
      await expect(upsert).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ projectId: 'project-writable' }),
      ]));
      expect(fileSystem.rawStatStarts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes timed-out stat operations instead of running stale queued work later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fixture = await createFixture();
    const stalledRoots = Array.from({ length: 7 }, (_, index) => ['Z:', `expired-${index}`, 'Canvas.novus-project'].join(String.fromCharCode(92)));
    const fileSystem = new ReleasableFirstStatFileSystem(stalledRoots[0]!);
    const store = new RecentProjectStore({ appDataRoot: fixture.appDataRoot, fileSystem });
    await writeRecentIndex(fixture.appDataRoot, stalledRoots.map((root, index) => createEntry(root, `project-expired-${index}`, `Expired ${index}`)));

    try {
      const listing = store.list();
      await fileSystem.firstStatStarted;
      await vi.advanceTimersByTimeAsync(2_001);
      await expect(listing).resolves.toHaveLength(stalledRoots.length);
      expect(fileSystem.rawStatStarts).toBe(1);

      fileSystem.releaseFirstStat();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(fileSystem.rawStatStarts).toBe(1);
    } finally {
      fileSystem.releaseFirstStat();
      vi.useRealTimers();
    }
  });

  it('keeps the pending stat queue at a fixed maximum size', async () => {
    const fixture = await createFixture();
    const stalledRoots = Array.from({ length: 300 }, (_, index) => ['Z:', `bounded-${index}`, 'Canvas.novus-project'].join(String.fromCharCode(92)));
    const fileSystem = new ReleasableFirstStatFileSystem(stalledRoots[0]!);
    const store = new RecentProjectStore({ appDataRoot: fixture.appDataRoot, fileSystem });
    await writeRecentIndex(fixture.appDataRoot, stalledRoots.map((root, index) => createEntry(root, `project-bounded-${index}`, `Bounded ${index}`)));

    const listing = store.list();
    await fileSystem.firstStatStarted;
    fileSystem.releaseFirstStat();

    await expect(listing).resolves.toHaveLength(stalledRoots.length);
    expect(fileSystem.rawStatStarts).toBe(257);
  });
});

function createEntry(root: string, projectId: string, displayName: string) {
  return {
    root,
    projectId,
    displayName,
    lastOpenedAt: '2026-08-10T09:00:00.000Z',
    lastSavedAt: '2026-08-10T09:01:00.000Z',
    nodeCount: 1,
    imageCount: 0,
    videoCount: 0,
  };
}

async function createFixture() {
  const tempRoot = await mkdtemp(join(tmpdir(), 'novus-recent-project-store-'));
  tempRoots.push(tempRoot);
  const appDataRoot = join(tempRoot, 'app-data');
  const workspaceRoot = join(tempRoot, 'projects');
  await mkdir(appDataRoot, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  return { appDataRoot, workspaceRoot };
}

async function createProjectRoot(
  workspaceRoot: string,
  displayName: string,
  projectId: string,
  withPreview: boolean,
): Promise<string> {
  const root = join(workspaceRoot, `${displayName}.novus-project`);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'project.novus.json'), JSON.stringify({ projectId, projectName: displayName }), 'utf8');
  if (withPreview) await writeFile(join(root, 'preview.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return root;
}

async function writeRecentIndex(appDataRoot: string, entries: ReturnType<typeof createEntry>[]): Promise<void> {
  await writeFile(join(appDataRoot, 'recent-projects.index.json'), JSON.stringify({
    schemaVersion: 1,
    entries: entries.map((entry) => ({
      ...entry,
      recentProjectId: createRecentProjectId(entry.root),
    })),
  }), 'utf8');
}

class StalledStatFileSystem extends NodeFileSystem {
  readonly stalledStatStarted: Promise<void>;
  private reportStalledStat!: () => void;
  private readonly availableFiles: ReadonlySet<string>;

  constructor(
    private readonly stalledPath: string,
    private readonly availableRoot: string,
  ) {
    super();
    this.stalledStatStarted = new Promise<void>((resolve) => { this.reportStalledStat = resolve; });
    this.availableFiles = new Set([
      join(availableRoot, 'preview.png'),
      join(availableRoot, 'project.novus.json'),
    ]);
  }

  override async stat(path: string) {
    if (path === this.stalledPath) {
      this.reportStalledStat();
      return new Promise<never>(() => undefined);
    }
    return {
      isDirectory: () => path === this.availableRoot,
      isFile: () => this.availableFiles.has(path),
    } as Awaited<ReturnType<NodeFileSystem['stat']>>;
  }
}

class MultipleStalledStatFileSystem extends NodeFileSystem {
  readonly firstStalledStatStarted: Promise<void>;
  readonly indexWriteCommitted: Promise<void>;
  rawStatStarts = 0;
  private reportFirstStalledStat!: () => void;
  private reportIndexWriteCommitted!: () => void;
  private indexReadCount = 0;
  private readonly indexReadWaiters: Array<{ count: number; resolve: () => void }> = [];
  private readonly stalledPaths: ReadonlySet<string>;

  constructor(stalledPaths: readonly string[], private readonly indexPath: string) {
    super();
    this.stalledPaths = new Set(stalledPaths);
    this.firstStalledStatStarted = new Promise<void>((resolve) => { this.reportFirstStalledStat = resolve; });
    this.indexWriteCommitted = new Promise<void>((resolve) => { this.reportIndexWriteCommitted = resolve; });
  }

  async waitForIndexReads(count: number): Promise<void> {
    if (this.indexReadCount >= count) return;
    await new Promise<void>((resolve) => { this.indexReadWaiters.push({ count, resolve }); });
  }

  override async readFile(path: string, encoding: BufferEncoding): Promise<string> {
    const value = await super.readFile(path, encoding);
    if (path === this.indexPath) {
      this.indexReadCount += 1;
      for (let index = this.indexReadWaiters.length - 1; index >= 0; index -= 1) {
        const waiter = this.indexReadWaiters[index]!;
        if (this.indexReadCount < waiter.count) continue;
        this.indexReadWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
    return value;
  }

  override async rename(source: string, destination: string): Promise<void> {
    await super.rename(source, destination);
    if (destination === this.indexPath) this.reportIndexWriteCommitted();
  }

  override async stat(path: string) {
    if (this.stalledPaths.has(path)) {
      this.rawStatStarts += 1;
      this.reportFirstStalledStat();
      return new Promise<never>(() => undefined);
    }
    this.rawStatStarts += 1;
    return super.stat(path);
  }
}

class ReleasableFirstStatFileSystem extends NodeFileSystem {
  readonly firstStatStarted: Promise<void>;
  rawStatStarts = 0;
  private reportFirstStatStarted!: () => void;
  private releaseFirstStatGate!: () => void;
  private readonly firstStatGate: Promise<void>;

  constructor(private readonly firstStalledPath: string) {
    super();
    this.firstStatStarted = new Promise<void>((resolve) => { this.reportFirstStatStarted = resolve; });
    this.firstStatGate = new Promise<void>((resolve) => { this.releaseFirstStatGate = resolve; });
  }

  releaseFirstStat(): void {
    this.releaseFirstStatGate();
  }

  override async stat(path: string) {
    this.rawStatStarts += 1;
    if (path === this.firstStalledPath) {
      this.reportFirstStatStarted();
      await this.firstStatGate;
    }
    return {
      isDirectory: () => false,
      isFile: () => false,
    } as Awaited<ReturnType<NodeFileSystem['stat']>>;
  }
}

class CoordinatedRecentFileSystem extends NodeFileSystem {
  readonly firstIndexReadStarted: Promise<void>;
  readonly secondIndexReadStarted: Promise<void>;
  private releaseFirstRead!: () => void;
  private releaseSecondRead!: () => void;
  private reportFirstRead!: () => void;
  private reportSecondRead!: () => void;
  private readonly firstReadGate: Promise<void>;
  private readonly secondReadGate: Promise<void>;
  private indexReadCount = 0;

  constructor() {
    super();
    this.firstIndexReadStarted = new Promise<void>((resolve) => { this.reportFirstRead = resolve; });
    this.secondIndexReadStarted = new Promise<void>((resolve) => { this.reportSecondRead = resolve; });
    this.firstReadGate = new Promise<void>((resolve) => { this.releaseFirstRead = resolve; });
    this.secondReadGate = new Promise<void>((resolve) => { this.releaseSecondRead = resolve; });
  }

  releaseFirstIndexRead(): void {
    this.releaseFirstRead();
  }

  releaseSecondIndexRead(): void {
    this.releaseSecondRead();
  }

  override async readFile(path: string, encoding: BufferEncoding): Promise<string> {
    if (path.endsWith('recent-projects.index.json')) {
      this.indexReadCount += 1;
      if (this.indexReadCount === 1) {
        this.reportFirstRead();
        await this.firstReadGate;
      } else if (this.indexReadCount === 2) {
        this.reportSecondRead();
        await this.secondReadGate;
      }
    }
    return super.readFile(path, encoding);
  }
}
