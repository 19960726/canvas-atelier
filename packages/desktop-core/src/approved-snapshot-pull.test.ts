import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createKnowledgeSnapshotCandidate, type KnowledgeSnapshot } from '@agent-canvas/skill-store';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApprovedSnapshotPullCoordinator } from './approved-snapshot-pull';
import { ManagedKnowledgeStore } from './managed-knowledge-store';

describe('ApprovedSnapshotPullCoordinator', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it('pulls approved snapshots on online startup, publishes them, emits state, and persists a sanitized cursor', async () => {
    const fixture = await createPullFixture(tempRoots);
    const remote = createSnapshot('# remote version 2', 2);
    const pullApprovedSnapshot = vi.fn(async () => ({ snapshot: remote, cursor: 'cursor-2' }));
    const coordinator = createCoordinator(fixture, { pullApprovedSnapshot });
    const emitted: unknown[] = [];
    coordinator.subscribe((state) => emitted.push(state));

    await coordinator.start(['scene-skill']);

    await expect(fixture.store.readActive('scene-skill')).resolves.toEqual(remote);
    expect(pullApprovedSnapshot).toHaveBeenCalledWith('scene-skill', undefined);
    expect(emitted).toEqual([expect.objectContaining({ activeVersion: 2, status: 'active' })]);
    const rawCursor = await readFile(join(fixture.appDataRoot, 'sync', 'approved-snapshot-pull-cursors.json'), 'utf8');
    expect(JSON.parse(rawCursor)).toEqual({ schemaVersion: 1, cursors: { 'scene-skill': 'cursor-2' } });
    expect(rawCursor).not.toMatch(/Authorization|Bearer|data:image|[A-Za-z]:\\/u);
    await coordinator.stop();
  });

  it('stays offline without pulling, then a restarted online coordinator drains from durable cursor state', async () => {
    const fixture = await createPullFixture(tempRoots);
    const offlinePull = vi.fn();
    const offline = createCoordinator(fixture, { pullApprovedSnapshot: offlinePull }, false);

    await offline.start(['scene-skill']);
    await offline.stop();
    expect(offlinePull).not.toHaveBeenCalled();

    const remote = createSnapshot('# remote version 2', 2);
    const onlinePull = vi.fn(async () => ({ snapshot: remote, cursor: 'cursor-2' }));
    const restarted = createCoordinator(fixture, { pullApprovedSnapshot: onlinePull }, true);
    await restarted.start(['scene-skill']);

    expect(onlinePull).toHaveBeenCalledWith('scene-skill', undefined);
    await expect(fixture.store.readActive('scene-skill')).resolves.toEqual(remote);
    await restarted.stop();
  });

  it('emits sanitized offline and conflict lifecycle states, then recovers to updated without changing known-good state early', async () => {
    const fixture = await createPullFixture(tempRoots);
    const local = createSnapshot('# local version 2', 2);
    const conflicting = createSnapshot('# conflicting version 2', 2);
    const recovered = createSnapshot('# remote version 3', 3);
    await fixture.store.publish(local);

    const offline = createCoordinator(fixture, { pullApprovedSnapshot: vi.fn() }, false);
    const offlineStatuses: unknown[] = [];
    offline.subscribeSyncStatus((status) => offlineStatuses.push(status));
    await offline.start(['scene-skill']);
    expect(offlineStatuses).toEqual([expect.objectContaining({
      knowledgeBaseId: 'scene-skill',
      status: 'offline',
      lastFailure: expect.objectContaining({ reason: expect.any(String), failedAt: expect.any(String) }),
    })]);
    await expect(fixture.store.readActive('scene-skill')).resolves.toEqual(local);
    await offline.stop();

    const pullApprovedSnapshot = vi.fn()
      .mockResolvedValueOnce({ snapshot: conflicting, cursor: 'cursor-conflict' })
      .mockResolvedValueOnce({ snapshot: recovered, cursor: 'cursor-3' });
    const coordinator = createCoordinator(fixture, { pullApprovedSnapshot });
    const statuses: unknown[] = [];
    coordinator.subscribeSyncStatus((status) => statuses.push(status));
    await coordinator.start(['scene-skill']);
    await expect(fixture.store.readActive('scene-skill')).resolves.toEqual(local);
    expect(statuses.map((status) => (status as { status: string }).status)).toEqual(['syncing', 'conflict']);

    await coordinator.pullNow();
    await expect(fixture.store.readActive('scene-skill')).resolves.toEqual(recovered);
    expect(statuses.map((status) => (status as { status: string }).status)).toEqual([
      'syncing', 'conflict', 'syncing', 'updated',
    ]);
    expect(JSON.stringify(statuses)).not.toMatch(/Authorization|Bearer|data:image|[A-Za-z]:\\/u);
    await coordinator.stop();
  });
  it('restores and advances the per-knowledge-base cursor after restart', async () => {
    const fixture = await createPullFixture(tempRoots);
    const first = createCoordinator(fixture, {
      pullApprovedSnapshot: vi.fn(async () => ({ snapshot: createSnapshot('# remote version 2', 2), cursor: 'cursor-2' })),
    });
    await first.start(['scene-skill']);
    await first.stop();

    const pullApprovedSnapshot = vi.fn(async () => ({ snapshot: null, cursor: 'cursor-3' }));
    const restarted = createCoordinator(fixture, { pullApprovedSnapshot });
    await restarted.start(['scene-skill']);

    expect(pullApprovedSnapshot).toHaveBeenCalledWith('scene-skill', 'cursor-2');
    const cursorState = JSON.parse(await readFile(
      join(fixture.appDataRoot, 'sync', 'approved-snapshot-pull-cursors.json'),
      'utf8',
    ));
    expect(cursorState).toEqual({ schemaVersion: 1, cursors: { 'scene-skill': 'cursor-3' } });
    await restarted.stop();
  });

  it('treats an identical approved snapshot as idempotent and advances its cursor without adding a version', async () => {
    const fixture = await createPullFixture(tempRoots);
    const remote = createSnapshot('# remote version 2', 2);
    await fixture.store.publish(remote);
    const coordinator = createCoordinator(fixture, {
      pullApprovedSnapshot: vi.fn(async () => ({ snapshot: remote, cursor: 'cursor-idempotent' })),
    });

    await coordinator.start(['scene-skill']);

    await expect(fixture.store.listStates()).resolves.toEqual([
      expect.objectContaining({ activeVersion: 2, versionCount: 2, lastFailure: null }),
    ]);
    const rawCursor = await readFile(join(fixture.appDataRoot, 'sync', 'approved-snapshot-pull-cursors.json'), 'utf8');
    expect(rawCursor).toContain('cursor-idempotent');
    await coordinator.stop();
  });

  it('preserves known-good knowledge and does not advance the cursor on a same-version hash conflict', async () => {
    const fixture = await createPullFixture(tempRoots);
    const local = createSnapshot('# local version 2', 2);
    const conflicting = createSnapshot('# conflicting version 2', 2);
    await fixture.store.publish(local);
    const coordinator = createCoordinator(fixture, {
      pullApprovedSnapshot: vi.fn(async () => ({ snapshot: conflicting, cursor: 'cursor-conflict' })),
    });

    await coordinator.start(['scene-skill']);

    await expect(fixture.store.readActive('scene-skill')).resolves.toEqual(local);
    await expect(readFile(join(fixture.appDataRoot, 'sync', 'approved-snapshot-pull-cursors.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await coordinator.stop();
  });

  it('defers remote publication and cursor advancement while a review transition reserves the knowledge base', async () => {
    const fixture = await createPullFixture(tempRoots);
    const active = await fixture.store.readActive('scene-skill');
    if (active === null) throw new Error('expected active snapshot');
    await fixture.store.stageApprovedSnapshot(createKnowledgeSnapshotCandidate({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      documents: [{ relativePath: 'memory/main.md', content: '# staged review' }],
    }), {
      stageId: 'stage-reserved',
      projectId: 'project-1',
      candidateId: 'candidate-1',
      transactionId: 'transaction-1',
      expectedActiveVersion: active.version,
      expectedActiveContentHash: active.contentHash,
      sourceDeviceId: 'device-a',
      stagedAt: '2026-07-16T01:00:00.000Z',
    });
    const pullApprovedSnapshot = vi.fn(async () => ({
      snapshot: createSnapshot('# remote version 2', 2),
      cursor: 'cursor-reserved',
    }));
    const coordinator = createCoordinator(fixture, { pullApprovedSnapshot });

    await coordinator.start(['scene-skill']);

    expect(pullApprovedSnapshot).not.toHaveBeenCalled();
    await expect(fixture.store.readActive('scene-skill')).resolves.toEqual(active);
    await coordinator.stop();
  });

  it('retains no-client startup offline status for later bridge hydration', async () => {
    const fixture = await createPullFixture(tempRoots);
    const coordinator = new ApprovedSnapshotPullCoordinator({
      appDataRoot: fixture.appDataRoot,
      client: null,
      clearInterval: vi.fn(),
      setInterval: () => 101,
      store: fixture.store,
    });

    await coordinator.start(['scene-skill']);

    expect(coordinator.listSyncStatuses()).toEqual([expect.objectContaining({
      knowledgeBaseId: 'scene-skill',
      status: 'offline',
      lastFailure: expect.objectContaining({ reason: expect.any(String) }),
    })]);
    await coordinator.stop();
  });

  it('keeps a rolled-back retained remote version conflicted across restart without advancing its cursor', async () => {
    const fixture = await createPullFixture(tempRoots);
    const version2 = createSnapshot('# local version 2', 2);
    const version3 = createSnapshot('# local version 3', 3);
    await fixture.store.publish(version2);
    await fixture.store.publish(version3);
    await fixture.store.rollback('scene-skill', 2);
    const cursorPath = join(fixture.appDataRoot, 'sync', 'approved-snapshot-pull-cursors.json');

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const pullApprovedSnapshot = vi.fn(async () => ({ snapshot: version3, cursor: 'cursor-rolled-back-v3' }));
      const coordinator = createCoordinator(fixture, { pullApprovedSnapshot });
      const statuses: Array<{ status: string }> = [];
      coordinator.subscribeSyncStatus((status) => statuses.push(status));

      await coordinator.start(['scene-skill']);

      expect(pullApprovedSnapshot).toHaveBeenCalledWith('scene-skill', undefined);
      await expect(fixture.store.readActive('scene-skill')).resolves.toEqual(version2);
      expect(statuses[statuses.length - 1]).toMatchObject({ status: 'conflict' });
      await expect(readFile(cursorPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await coordinator.stop();
    }
  });
  it('assigns strictly increasing changedAt values when lifecycle transitions share one wall-clock millisecond', async () => {
    const fixture = await createPullFixture(tempRoots);
    const local = createSnapshot('# local version 2', 2);
    await fixture.store.publish(local);
    const pullApprovedSnapshot = vi.fn()
      .mockResolvedValueOnce({ snapshot: createSnapshot('# conflict version 2', 2) })
      .mockResolvedValueOnce({ snapshot: createSnapshot('# recovered version 3', 3) });
    const coordinator = new ApprovedSnapshotPullCoordinator({
      appDataRoot: fixture.appDataRoot,
      client: { pullApprovedSnapshot },
      clearInterval: vi.fn(),
      now: () => Date.parse('2026-07-16T04:00:00.000Z'),
      setInterval: () => 101,
      store: fixture.store,
    });
    const statuses: Array<{ changedAt: string }> = [];
    coordinator.subscribeSyncStatus((status) => statuses.push(status));

    await coordinator.start(['scene-skill']);
    await coordinator.pullNow();

    expect(statuses.map((status) => status.changedAt)).toEqual([
      '2026-07-16T04:00:00.000Z',
      '2026-07-16T04:00:00.001Z',
      '2026-07-16T04:00:00.002Z',
      '2026-07-16T04:00:00.003Z',
    ]);
    await coordinator.stop();
  });
  it('awaits an in-flight pull and publish during stop', async () => {
    const fixture = await createPullFixture(tempRoots);
    const started = deferred<void>();
    const release = deferred<void>();
    const remote = createSnapshot('# remote version 2', 2);
    const coordinator = createCoordinator(fixture, {
      pullApprovedSnapshot: async () => {
        started.resolve();
        await release.promise;
        return { snapshot: remote, cursor: 'cursor-stop' };
      },
    });
    const startPromise = coordinator.start(['scene-skill']);
    await started.promise;
    let stopped = false;

    const stopPromise = coordinator.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    release.resolve();
    await Promise.all([startPromise, stopPromise]);
    expect(stopped).toBe(true);
    await expect(fixture.store.readActive('scene-skill')).resolves.toEqual(remote);
  });
});

async function createPullFixture(tempRoots: string[]) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'approved-snapshot-pull-'));
  tempRoots.push(tempRoot);
  const appDataRoot = join(tempRoot, 'app-data');
  const sourceRoot = join(tempRoot, 'source', 'scene-skill');
  await mkdir(sourceRoot, { recursive: true });
  const store = new ManagedKnowledgeStore({ appDataRoot });
  await store.configure({ knowledgeBaseId: 'scene-skill', displayName: 'Scene Skill', rootPath: sourceRoot });
  await store.publish(createSnapshot('# local version 1', 1));
  return { appDataRoot, store };
}

function createCoordinator(
  fixture: Awaited<ReturnType<typeof createPullFixture>>,
  client: { pullApprovedSnapshot(knowledgeBaseId: string, cursor?: string): Promise<{ snapshot: KnowledgeSnapshot | null; cursor?: string }> },
  online = true,
) {
  return new ApprovedSnapshotPullCoordinator({
    appDataRoot: fixture.appDataRoot,
    client,
    clearInterval: vi.fn(),
    isOnline: () => online,
    setInterval: () => 101,
    store: fixture.store,
  });
}

function createSnapshot(content: string, version: number): KnowledgeSnapshot {
  return {
    ...createKnowledgeSnapshotCandidate({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      documents: [{ relativePath: 'memory/main.md', content }],
    }),
    version,
    publishedAt: `2026-07-16T00:0${version}:00.000Z`,
    sourceDeviceId: 'remote-device',
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
