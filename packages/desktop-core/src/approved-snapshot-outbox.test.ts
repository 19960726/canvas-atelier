import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createKnowledgeSnapshotCandidate } from '@agent-canvas/skill-store';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApprovedSnapshotOutbox,
  createApprovedSnapshotSyncClientFromEnv,
  startApprovedSnapshotOutboxDrain,
} from './approved-snapshot-outbox';
import { ManagedKnowledgeStore } from './managed-knowledge-store';

describe('ApprovedSnapshotOutbox', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it('restores an approved snapshot outbox job after restart and drains through memory sync without serializing documents', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'approved-snapshot-outbox-'));
    tempRoots.push(tempRoot);
    const appDataRoot = join(tempRoot, 'app-data');
    const store = new ManagedKnowledgeStore({ appDataRoot });
    await store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: join(tempRoot, 'source', 'scene-skill'),
    });
    const candidate = createKnowledgeSnapshotCandidate({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      documents: [{ relativePath: 'memory/main.md', content: '# Scene Skill\n\nUse calmer liquid arcs.' }],
    });
    await store.publish({
      ...candidate,
      version: 1,
      publishedAt: '2026-07-15T10:00:00.000Z',
      sourceDeviceId: 'device-a',
    });
    const snapshot = await store.readVersion('scene-skill', 1);
    if (snapshot === null) throw new Error('expected retained snapshot');

    const outbox = new ApprovedSnapshotOutbox({
      appDataRoot,
      now: () => Date.parse('2026-07-15T10:01:00.000Z'),
      random: () => 0.25,
      store,
    });
    await outbox.enqueueApprovedSnapshot(snapshot);

    const rawOutbox = await readFile(join(appDataRoot, 'sync', 'approved-snapshot-outbox.json'), 'utf8');
    expect(rawOutbox).toContain('"approvedSnapshot"');
    expect(rawOutbox).toContain('"version":1');
    expect(rawOutbox).not.toContain('Use calmer liquid arcs');
    expect(rawOutbox).not.toContain('memory/main.md');
    expect(rawOutbox).not.toMatch(/Authorization|Bearer|data:image|[A-Za-z]:\\\\/u);

    const uploadApprovedSnapshot = vi.fn(async () => ({ accepted: true }));
    const restarted = new ApprovedSnapshotOutbox({
      appDataRoot,
      client: { uploadApprovedSnapshot },
      now: () => Date.parse('2026-07-15T10:02:00.000Z'),
      random: () => 0.5,
      store: new ManagedKnowledgeStore({ appDataRoot }),
    });
    const drained = await restarted.drainApprovedSnapshots();

    expect(drained.processedJobIds).toHaveLength(1);
    expect(uploadApprovedSnapshot).toHaveBeenCalledWith(snapshot, {
      idempotencyKey: drained.processedJobIds[0],
    });
    await expect(restarted.readPublicState()).resolves.toEqual({ schemaVersion: 1, jobs: [] });
  });

  it('creates the existing memory sync client from desktop runtime configuration only when fully configured', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ accepted: true, duplicate: false, snapshotId: 'scene-skill@1' }),
    }));
    const snapshot = createKnowledgeSnapshotCandidate({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      documents: [{ relativePath: 'memory/main.md', content: '# Scene Skill' }],
    });

    expect(createApprovedSnapshotSyncClientFromEnv({}, fetch)).toBeNull();
    expect(createApprovedSnapshotSyncClientFromEnv({ NOVUS_KNOWLEDGE_SYNC_URL: 'https://knowledge.example.com' }, fetch)).toBeNull();

    const client = createApprovedSnapshotSyncClientFromEnv({
      NOVUS_KNOWLEDGE_SYNC_TOKEN: 'secret-token',
      NOVUS_KNOWLEDGE_SYNC_URL: 'https://knowledge.example.com/',
    }, fetch);

    expect(client).not.toBeNull();
    await expect(client!.uploadApprovedSnapshot({
      ...snapshot,
      version: 1,
      publishedAt: '2026-07-15T10:00:00.000Z',
      sourceDeviceId: 'device-a',
    }, { idempotencyKey: 'idem-1' })).resolves.toEqual({
      accepted: true,
      duplicate: false,
      snapshotId: 'scene-skill@1',
    });
    expect(fetch).toHaveBeenCalledWith('https://knowledge.example.com/v1/knowledge-bases/scene-skill/approved-snapshot', expect.objectContaining({
      headers: expect.objectContaining({
        authorization: 'Bearer secret-token',
        'idempotency-key': 'idem-1',
      }),
      method: 'PUT',
    }));
  });

  it('keeps an explicitly rejected snapshot durable until the remote reports an accepted duplicate', async () => {
    const fixture = await createApprovedOutboxFixture(tempRoots);
    let now = Date.parse('2026-07-15T10:02:00.000Z');
    const outbox = new ApprovedSnapshotOutbox({
      appDataRoot: fixture.appDataRoot,
      now: () => now,
      random: () => 0.25,
      store: fixture.store,
    });
    await outbox.enqueueApprovedSnapshot(fixture.firstSnapshot);

    const rejected = await outbox.drainApprovedSnapshots({
      uploadApprovedSnapshot: async () => ({
        accepted: false,
        duplicate: false,
      }),
    });
    expect(rejected.processedJobIds).toEqual([]);
    expect(rejected.state.jobs).toEqual([
      expect.objectContaining({
        attemptCount: 1,
        lastError: 'approved_snapshot_not_accepted',
        status: 'retry_wait',
      }),
    ]);

    now += 2_000;
    const duplicate = await outbox.drainApprovedSnapshots({
      uploadApprovedSnapshot: async () => ({
        accepted: false,
        duplicate: true,
      }),
    });
    expect(duplicate.processedJobIds).toHaveLength(1);
    expect(duplicate.state.jobs).toEqual([]);
  });

  it('drains approved snapshot outbox at startup and when the online-gated retry boundary opens', async () => {
    let tick: (() => void) | undefined;
    const clearInterval = vi.fn();
    const drainApprovedSnapshots = vi.fn(async () => ({ processedJobIds: [], state: { schemaVersion: 1 as const, jobs: [] } }));
    const client = { uploadApprovedSnapshot: vi.fn() };
    let online = true;

    const handle = startApprovedSnapshotOutboxDrain({
      client,
      clearInterval,
      intervalMs: 10,
      isOnline: () => online,
      outbox: { drainApprovedSnapshots },
      setInterval: (listener) => {
        tick = listener;
        return 101;
      },
    });

    await handle.drainNow();
    expect(drainApprovedSnapshots).toHaveBeenCalledTimes(1);
    expect(drainApprovedSnapshots).toHaveBeenCalledWith(client);

    online = false;
    tick?.();
    await Promise.resolve();
    expect(drainApprovedSnapshots).toHaveBeenCalledTimes(1);

    online = true;
    tick?.();
    await Promise.resolve();
    expect(drainApprovedSnapshots).toHaveBeenCalledTimes(2);

    handle.stop();
    expect(clearInterval).toHaveBeenCalledWith(101);
  });

  it('serializes concurrent approved snapshot enqueues without losing either job', async () => {
    const fixture = await createApprovedOutboxFixture(tempRoots);
    const first = new ApprovedSnapshotOutbox({
      appDataRoot: fixture.appDataRoot,
      now: () => Date.parse('2026-07-15T10:03:00.000Z'),
      random: () => 0.1,
      store: fixture.store,
    });
    const second = new ApprovedSnapshotOutbox({
      appDataRoot: fixture.appDataRoot,
      now: () => Date.parse('2026-07-15T10:03:01.000Z'),
      random: () => 0.2,
      store: fixture.store,
    });

    await Promise.all([
      first.enqueueApprovedSnapshot(fixture.firstSnapshot),
      second.enqueueApprovedSnapshot(fixture.secondSnapshot),
    ]);

    const publicState = await first.readPublicState();
    expect(publicState.jobs.map((job) => job.approvedSnapshot?.version).sort()).toEqual([1, 2]);
  });

  it('does not lose an enqueue that races an in-flight drain state write', async () => {
    const fixture = await createApprovedOutboxFixture(tempRoots);
    const queued = new ApprovedSnapshotOutbox({
      appDataRoot: fixture.appDataRoot,
      now: () => Date.parse('2026-07-15T10:04:00.000Z'),
      random: () => 0.3,
      store: fixture.store,
    });
    await queued.enqueueApprovedSnapshot(fixture.firstSnapshot);
    const uploadStarted = deferred<void>();
    const releaseUpload = deferred<void>();
    const draining = new ApprovedSnapshotOutbox({
      appDataRoot: fixture.appDataRoot,
      client: {
        uploadApprovedSnapshot: async () => {
          uploadStarted.resolve();
          await releaseUpload.promise;
          return { accepted: true };
        },
      },
      now: () => Date.parse('2026-07-15T10:04:01.000Z'),
      random: () => 0.4,
      store: fixture.store,
    });

    const drainPromise = draining.drainApprovedSnapshots();
    await uploadStarted.promise;
    await queued.enqueueApprovedSnapshot(fixture.secondSnapshot);
    releaseUpload.resolve();
    await drainPromise;

    const publicState = await queued.readPublicState();
    expect(publicState.jobs.map((job) => job.approvedSnapshot?.version)).toEqual([2]);
  });

  it('rejects corrupt nested persisted outbox jobs before public serialization or drain', async () => {
    const fixture = await createApprovedOutboxFixture(tempRoots);
    const syncRoot = join(fixture.appDataRoot, 'sync');
    await mkdir(syncRoot, { recursive: true });
    await writeFile(join(syncRoot, 'approved-snapshot-outbox.json'), JSON.stringify({
      schemaVersion: 1,
      jobs: [{ id: 'corrupt-job', approvedSnapshot: { knowledgeBaseId: 'scene-skill', version: 1 } }],
    }), 'utf8');
    const restarted = new ApprovedSnapshotOutbox({
      appDataRoot: fixture.appDataRoot,
      store: fixture.store,
    });

    await expect(restarted.readPublicState()).rejects.toThrow(/outbox state is invalid/i);
    await expect(restarted.drainApprovedSnapshots({ uploadApprovedSnapshot: vi.fn() })).rejects.toThrow(/outbox state is invalid/i);
  });

  it('awaits the active drain upload and state write during async stop', async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const drainApprovedSnapshots = vi.fn(async () => {
      started.resolve();
      await release.promise;
      return { processedJobIds: [], state: { schemaVersion: 1 as const, jobs: [] } };
    });
    const handle = startApprovedSnapshotOutboxDrain({
      client: { uploadApprovedSnapshot: vi.fn() },
      clearInterval: vi.fn(),
      intervalMs: 10,
      isOnline: () => true,
      outbox: { drainApprovedSnapshots },
      setInterval: () => 101,
    });
    await started.promise;
    let stopped = false;

    const stopPromise = handle.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    release.resolve();
    await stopPromise;
    expect(stopped).toBe(true);
    expect(drainApprovedSnapshots).toHaveBeenCalledTimes(1);
  });});

async function createApprovedOutboxFixture(tempRoots: string[]) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'approved-outbox-concurrency-'));
  tempRoots.push(tempRoot);
  const appDataRoot = join(tempRoot, 'app-data');
  const store = new ManagedKnowledgeStore({ appDataRoot });
  await store.configure({
    knowledgeBaseId: 'scene-skill',
    displayName: 'Scene Skill',
    rootPath: join(tempRoot, 'source', 'scene-skill'),
  });
  const createSnapshot = (content: string, version: number) => ({
    ...createKnowledgeSnapshotCandidate({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      documents: [{ relativePath: 'memory/main.md', content }],
    }),
    version,
    publishedAt: `2026-07-15T10:0${version}:00.000Z`,
    sourceDeviceId: 'device-a',
  });
  const firstSnapshot = createSnapshot('# version 1', 1);
  const secondSnapshot = createSnapshot('# version 2', 2);
  await store.publish(firstSnapshot);
  await store.publish(secondSnapshot);
  return { appDataRoot, firstSnapshot, secondSnapshot, store };
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
