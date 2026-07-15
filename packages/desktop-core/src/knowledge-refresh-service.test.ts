import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';

import { createKnowledgeSnapshotCandidate } from '@agent-canvas/skill-store';
import { afterEach, describe, expect, it } from 'vitest';

import { NodeFileSystem } from './file-system';
import {
  KnowledgeRefreshService,
  type KnowledgeRefreshClock,
  type KnowledgeWatchAdapter,
  type KnowledgeWatchEvent,
  type KnowledgeWatchHandle,
} from './knowledge-refresh-service';
import { createDesktopBridgeHandlers } from './bridge-handlers';
import { ManagedKnowledgeStore } from './managed-knowledge-store';

describe('KnowledgeRefreshService', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  it('debounces repeated file events into one refresh and publish', async () => {
    const fixture = await createConfiguredFixture(tempRoots);
    await writeKnowledgeFile(fixture.sourceRoot, 'memory/main.md', '# Scene memory');
    const watcher = new ManualWatchAdapter();
    const clock = new ManualClock();
    const sourceFileSystem = new CountingSourceFileSystem(fixture.sourceRoot);
    const service = new KnowledgeRefreshService({
      clock,
      fileSystem: sourceFileSystem,
      sourceDeviceId: 'test-device',
      store: fixture.store,
      watchAdapter: watcher,
    });
    const states: unknown[] = [];
    service.subscribe((state) => states.push(state));

    await service.start(['scene-skill']);
    watcher.emit(fixture.sourceRoot, { eventType: 'change', filename: 'memory/main.md' });
    watcher.emit(fixture.sourceRoot, { eventType: 'change', filename: 'memory/main.md' });
    watcher.emit(fixture.sourceRoot, { eventType: 'rename', filename: 'memory/main.md' });

    await clock.advanceBy(249);
    expect(sourceFileSystem.sourceReadCount).toBe(0);
    expect(fixture.store.publishCount).toBe(0);

    await clock.advanceBy(1);

    expect(sourceFileSystem.sourceReadCount).toBe(1);
    expect(fixture.store.publishCount).toBe(1);
    expect(states).toEqual([expect.objectContaining({
      knowledgeBaseId: 'scene-skill',
      status: 'active',
      activeVersion: 1,
      versionCount: 1,
    })]);
  });

  it('keeps the previous active snapshot and emits fallback when refreshed content is protected', async () => {
    const fixture = await createConfiguredFixture(tempRoots);
    await writeKnowledgeFile(fixture.sourceRoot, 'memory/main.md', '# Scene memory');
    const clock = new ManualClock();
    const service = new KnowledgeRefreshService({
      clock,
      sourceDeviceId: 'test-device',
      store: fixture.store,
      watchAdapter: new ManualWatchAdapter(),
    });
    const states: unknown[] = [];
    let persistedAtFallbackEmit: Promise<unknown> | null = null;
    service.subscribe((state) => {
      states.push(state);
      if (state.status === 'fallback') {
        persistedAtFallbackEmit = new ManagedKnowledgeStore({ appDataRoot: fixture.appDataRoot })
          .listStates()
          .then((persisted) => persisted[0]);
      }
    });
    const first = await service.refreshNow('scene-skill');

    await writeKnowledgeFile(
      fixture.sourceRoot,
      'memory/main.md',
      'Authorization: Bearer secret-token-value',
    );
    const fallback = await service.refreshNow('scene-skill');

    expect(first).toMatchObject({ status: 'active', activeVersion: 1 });
    expect(fallback).toMatchObject({
      status: 'fallback',
      activeVersion: 1,
      activeContentHash: first.activeContentHash,
      versionCount: 1,
      lastFailure: {
        reason: expect.any(String),
        failedAt: '2026-07-15T08:00:00.000Z',
      },
    });
    expect(await fixture.store.readActive('scene-skill')).toMatchObject({
      version: 1,
      contentHash: first.activeContentHash,
    });
    expect(fixture.store.publishCount).toBe(1);
    expect(states[states.length - 1]).toEqual(fallback);
    await expect(persistedAtFallbackEmit).resolves.toEqual(fallback);

    const restartedStore = new ManagedKnowledgeStore({ appDataRoot: fixture.appDataRoot });
    await expect(restartedStore.listStates()).resolves.toEqual([fallback]);
    const restartedService = new KnowledgeRefreshService({
      clock,
      sourceDeviceId: 'test-device',
      store: restartedStore,
      watchAdapter: new ManualWatchAdapter(),
    });
    const handlers = createDesktopBridgeHandlers({
      knowledgeRefreshService: restartedService,
      knowledgeStore: restartedStore,
      repository: { close: async () => undefined },
    });
    await expect(handlers.getKnowledgeState({}, undefined)).resolves.toEqual({ states: [fallback] });

    await writeKnowledgeFile(fixture.sourceRoot, 'memory/main.md', '# Recovered scene memory');
    const recovered = await restartedService.refreshNow('scene-skill');
    expect(recovered).toMatchObject({
      status: 'active',
      activeVersion: 2,
      versionCount: 2,
      lastFailure: null,
    });
    await expect(new ManagedKnowledgeStore({ appDataRoot: fixture.appDataRoot }).listStates()).resolves.toEqual([recovered]);
  });

  it('does not publish or emit a new state when refreshed files have duplicate content', async () => {
    const fixture = await createConfiguredFixture(tempRoots);
    await writeKnowledgeFile(fixture.sourceRoot, 'memory/main.md', '# Scene memory');
    const service = new KnowledgeRefreshService({
      sourceDeviceId: 'test-device',
      store: fixture.store,
      watchAdapter: new ManualWatchAdapter(),
    });
    const states: unknown[] = [];
    service.subscribe((state) => states.push(state));

    const first = await service.refreshNow('scene-skill');
    const second = await service.refreshNow('scene-skill');

    expect(first).toMatchObject({ activeVersion: 1, versionCount: 1 });
    expect(second).toEqual(first);
    expect(fixture.store.publishCount).toBe(1);
    expect(states).toHaveLength(1);
  });

  it('clears watchers and pending timers on stop', async () => {
    const fixture = await createConfiguredFixture(tempRoots);
    await writeKnowledgeFile(fixture.sourceRoot, 'memory/main.md', '# Scene memory');
    const watcher = new ManualWatchAdapter();
    const clock = new ManualClock();
    const service = new KnowledgeRefreshService({
      clock,
      sourceDeviceId: 'test-device',
      store: fixture.store,
      watchAdapter: watcher,
    });

    await service.start(['scene-skill']);
    watcher.emit(fixture.sourceRoot, { eventType: 'change', filename: 'memory/main.md' });
    await service.stop();
    watcher.emit(fixture.sourceRoot, { eventType: 'change', filename: 'memory/main.md' });
    await clock.advanceBy(250);

    expect(fixture.store.publishCount).toBe(0);
    expect(watcher.closedCount).toBe(1);
  });

  it('ignores temp-file-only watch events', async () => {
    const fixture = await createConfiguredFixture(tempRoots);
    await writeKnowledgeFile(fixture.sourceRoot, 'memory/main.md', '# Scene memory');
    const watcher = new ManualWatchAdapter();
    const clock = new ManualClock();
    const sourceFileSystem = new CountingSourceFileSystem(fixture.sourceRoot);
    const service = new KnowledgeRefreshService({
      clock,
      fileSystem: sourceFileSystem,
      sourceDeviceId: 'test-device',
      store: fixture.store,
      watchAdapter: watcher,
    });

    await service.start(['scene-skill']);
    watcher.emit(fixture.sourceRoot, { eventType: 'change', filename: 'memory/main.md.tmp' });
    watcher.emit(fixture.sourceRoot, { eventType: 'change', filename: 'memory/.main.md.swp' });
    watcher.emit(fixture.sourceRoot, { eventType: 'change', filename: 'memory/main.md~' });
    await clock.advanceBy(250);

    expect(sourceFileSystem.sourceReadCount).toBe(0);
    expect(fixture.store.publishCount).toBe(0);
  });

  it('emits sanitized fallback failures without protected content or private root paths', async () => {
    const fixture = await createConfiguredFixture(tempRoots);
    const privatePath = join(fixture.sourceRoot, 'memory', 'main.md');
    await writeKnowledgeFile(
      fixture.sourceRoot,
      'memory/main.md',
      `token=secret-value\n${privatePath}\ndata:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA`,
    );
    const service = new KnowledgeRefreshService({
      sourceDeviceId: 'test-device',
      store: fixture.store,
      watchAdapter: new ManualWatchAdapter(),
    });
    const states: unknown[] = [];
    service.subscribe((state) => states.push(state));

    const fallback = await service.refreshNow('scene-skill');
    const serialized = JSON.stringify(fallback);

    expect(fallback).toMatchObject({
      status: 'empty',
      activeVersion: null,
      versionCount: 0,
      lastFailure: {
        reason: expect.any(String),
      },
    });
    expect(serialized).not.toContain('secret-value');
    expect(serialized).not.toContain('token=');
    expect(serialized).not.toContain('data:image');
    expect(serialized).not.toContain('iVBORw0KGgo');
    expect(serialized).not.toContain(privatePath);
    expect(serialized).not.toContain(fixture.sourceRoot);
    expect(states).toEqual([fallback]);
    await expect(new ManagedKnowledgeStore({ appDataRoot: fixture.appDataRoot }).listStates()).resolves.toEqual([fallback]);
  });
  it('re-stats across a stability window and retries a partial save before publishing', async () => {
    const fixture = await createConfiguredFixture(tempRoots);
    await writeKnowledgeFile(fixture.sourceRoot, 'memory/main.md', '# partial');
    const watcher = new ManualWatchAdapter();
    const clock = new ManualClock();
    let stabilityPass = 0;
    const service = new KnowledgeRefreshService({
      clock,
      sourceDeviceId: 'test-device',
      stabilityWait: async () => {
        stabilityPass += 1;
        if (stabilityPass === 1) {
          await writeKnowledgeFile(fixture.sourceRoot, 'memory/main.md', '# complete saved content');
        }
      },
      store: fixture.store,
      watchAdapter: watcher,
    });

    await service.start(['scene-skill']);
    watcher.emit(fixture.sourceRoot, { eventType: 'change', filename: 'memory/main.md' });
    await clock.advanceBy(250);

    expect(fixture.store.publishCount).toBe(0);
    await expect(fixture.store.listStates()).resolves.toEqual([
      expect.objectContaining({ activeVersion: null, lastFailure: null }),
    ]);

    await clock.advanceBy(250);

    expect(fixture.store.publishCount).toBe(1);
    await expect(fixture.store.readActive('scene-skill')).resolves.toMatchObject({
      documents: [expect.objectContaining({ content: '# complete saved content' })],
    });
  });

  it('serializes overlapping refreshes per knowledge base and publishes the latest rapid save', async () => {
    const fixture = await createConfiguredFixture(tempRoots);
    await writeKnowledgeFile(fixture.sourceRoot, 'memory/main.md', '# first save');
    const watcher = new ManualWatchAdapter();
    const clock = new ManualClock();
    const blockingStore = new BlockingManagedKnowledgeStore({ appDataRoot: fixture.appDataRoot });
    const service = new KnowledgeRefreshService({
      clock,
      sourceDeviceId: 'test-device',
      stabilityWait: async () => undefined,
      store: blockingStore,
      watchAdapter: watcher,
    });

    await service.start(['scene-skill']);
    watcher.emit(fixture.sourceRoot, { eventType: 'change', filename: 'memory/main.md' });
    const firstAdvance = clock.advanceBy(250);
    await blockingStore.firstPublishStarted.promise;

    await writeKnowledgeFile(fixture.sourceRoot, 'memory/main.md', '# latest save');
    watcher.emit(fixture.sourceRoot, { eventType: 'change', filename: 'memory/main.md' });
    const secondAdvance = clock.advanceBy(250);
    blockingStore.releaseFirstPublish.resolve();
    await Promise.all([firstAdvance, secondAdvance]);

    expect(blockingStore.maxConcurrentPublishes).toBe(1);
    expect(blockingStore.publishCount).toBe(2);
    await expect(blockingStore.readActive('scene-skill')).resolves.toMatchObject({
      version: 2,
      documents: [expect.objectContaining({ content: '# latest save' })],
    });
  });

  it('queues a watcher retry while a review transition reserves the knowledge base', async () => {
    const fixture = await createConfiguredFixture(tempRoots);
    await writeKnowledgeFile(fixture.sourceRoot, 'memory/main.md', '# initial');
    const initialService = new KnowledgeRefreshService({
      sourceDeviceId: 'test-device',
      stabilityWait: async () => undefined,
      store: fixture.store,
      watchAdapter: new ManualWatchAdapter(),
    });
    const initial = await initialService.refreshNow('scene-skill');
    await fixture.store.stageApprovedSnapshot(createKnowledgeSnapshotCandidate({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      documents: [{ relativePath: 'memory/main.md', content: '# staged review' }],
    }), {
      stageId: 'stage-refresh-reservation',
      projectId: 'project-1',
      candidateId: 'candidate-1',
      transactionId: 'transaction-1',
      expectedActiveVersion: initial.activeVersion!,
      expectedActiveContentHash: initial.activeContentHash!,
      sourceDeviceId: 'device-a',
      stagedAt: '2026-07-16T01:00:00.000Z',
    });
    await writeKnowledgeFile(fixture.sourceRoot, 'memory/main.md', '# watcher update after review');
    const watcher = new ManualWatchAdapter();
    const clock = new ManualClock();
    const states: unknown[] = [];
    const service = new KnowledgeRefreshService({
      clock,
      sourceDeviceId: 'test-device',
      stabilityWait: async () => undefined,
      store: fixture.store,
      watchAdapter: watcher,
    });
    service.subscribe((state) => states.push(state));

    await service.start(['scene-skill']);
    watcher.emit(fixture.sourceRoot, { eventType: 'change', filename: 'memory/main.md' });
    await clock.advanceBy(250);

    expect(fixture.store.publishCount).toBe(1);
    expect(states).toEqual([]);
    await fixture.store.discardStagedTransition('stage-refresh-reservation', 'unacknowledged_project_transaction');
    await clock.advanceBy(250);

    expect(fixture.store.publishCount).toBe(2);
    await expect(fixture.store.readActive('scene-skill')).resolves.toMatchObject({
      version: 2,
      documents: [expect.objectContaining({ content: '# watcher update after review' })],
    });
  });

  it('awaits refresh work during stop and prevents post-stop publish or emit', async () => {
    const fixture = await createConfiguredFixture(tempRoots);
    await writeKnowledgeFile(fixture.sourceRoot, 'memory/main.md', '# stop in flight');
    const watcher = new ManualWatchAdapter();
    const clock = new ManualClock();
    const stabilityStarted = deferred<void>();
    const releaseStability = deferred<void>();
    const states: unknown[] = [];
    const service = new KnowledgeRefreshService({
      clock,
      sourceDeviceId: 'test-device',
      stabilityWait: async () => {
        stabilityStarted.resolve();
        await releaseStability.promise;
      },
      store: fixture.store,
      watchAdapter: watcher,
    });
    service.subscribe((state) => states.push(state));

    await service.start(['scene-skill']);
    watcher.emit(fixture.sourceRoot, { eventType: 'change', filename: 'memory/main.md' });
    const advancePromise = clock.advanceBy(250);
    await stabilityStarted.promise;
    let stopped = false;
    const stopPromise = service.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    releaseStability.resolve();
    await Promise.all([advancePromise, stopPromise]);

    expect(stopped).toBe(true);
    expect(fixture.store.publishCount).toBe(0);
    expect(states).toEqual([]);
  });
});

async function createConfiguredFixture(tempRoots: string[]) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'knowledge-refresh-service-'));
  tempRoots.push(tempRoot);
  const appDataRoot = join(tempRoot, 'app-data');
  const sourceRoot = join(tempRoot, 'workspace', 'scene-skill');
  await mkdir(sourceRoot, { recursive: true });
  const store = new CountingManagedKnowledgeStore({ appDataRoot });
  await store.configure({
    knowledgeBaseId: 'scene-skill',
    displayName: 'Scene Skill',
    rootPath: sourceRoot,
  });

  return { appDataRoot, sourceRoot, store };
}

async function writeKnowledgeFile(root: string, relativePath: string, content: string): Promise<void> {
  const target = join(root, ...relativePath.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

class CountingManagedKnowledgeStore extends ManagedKnowledgeStore {
  publishCount = 0;

  override async publish(snapshot: Parameters<ManagedKnowledgeStore['publish']>[0]): Promise<void> {
    await super.publish(snapshot);
    this.publishCount += 1;
  }
}

class BlockingManagedKnowledgeStore extends ManagedKnowledgeStore {
  readonly firstPublishStarted = deferred<void>();
  readonly releaseFirstPublish = deferred<void>();
  publishCount = 0;
  maxConcurrentPublishes = 0;
  private concurrentPublishes = 0;

  override async publish(snapshot: Parameters<ManagedKnowledgeStore['publish']>[0]): Promise<void> {
    this.concurrentPublishes += 1;
    this.maxConcurrentPublishes = Math.max(this.maxConcurrentPublishes, this.concurrentPublishes);
    try {
      if (this.publishCount === 0) {
        this.firstPublishStarted.resolve();
        await this.releaseFirstPublish.promise;
      }
      await super.publish(snapshot);
      this.publishCount += 1;
    } finally {
      this.concurrentPublishes -= 1;
    }
  }
}

class CountingSourceFileSystem extends NodeFileSystem {
  sourceReadCount = 0;
  private readonly sourceRoot: string;

  constructor(sourceRoot: string) {
    super();
    this.sourceRoot = normalize(sourceRoot).toLowerCase();
  }

  override async readFile(path: string, encoding: BufferEncoding): Promise<string> {
    if (normalize(path).toLowerCase().startsWith(this.sourceRoot)) {
      this.sourceReadCount += 1;
    }
    return super.readFile(path, encoding);
  }
}

class ManualWatchAdapter implements KnowledgeWatchAdapter {
  closedCount = 0;
  private readonly watches: ManualWatch[] = [];

  watch(rootPath: string, listener: (event: KnowledgeWatchEvent) => void): KnowledgeWatchHandle {
    const watch: ManualWatch = { closed: false, listener, rootPath: normalize(rootPath) };
    this.watches.push(watch);
    return {
      close: () => {
        watch.closed = true;
        this.closedCount += 1;
      },
    };
  }

  emit(rootPath: string, event: KnowledgeWatchEvent): void {
    const normalizedRoot = normalize(rootPath);
    for (const watch of this.watches) {
      if (!watch.closed && watch.rootPath === normalizedRoot) {
        watch.listener(event);
      }
    }
  }
}

interface ManualWatch {
  closed: boolean;
  listener(event: KnowledgeWatchEvent): void;
  rootPath: string;
}

class ManualClock implements KnowledgeRefreshClock<number> {
  private currentTime = Date.parse('2026-07-15T08:00:00.000Z');
  private nextTimerId = 1;
  private readonly timers = new Map<number, ManualTimer>();

  clearTimeout(timer: number): void {
    this.timers.delete(timer);
  }

  now(): Date {
    return new Date(this.currentTime);
  }

  setTimeout(callback: () => void | Promise<void>, delayMs: number): number {
    const id = this.nextTimerId;
    this.nextTimerId += 1;
    this.timers.set(id, {
      callback,
      dueAt: this.currentTime + delayMs,
      id,
    });
    return id;
  }

  async advanceBy(ms: number): Promise<void> {
    this.currentTime += ms;
    for (;;) {
      const due = [...this.timers.values()]
        .filter((timer) => timer.dueAt <= this.currentTime)
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
      if (!due) {
        return;
      }
      this.timers.delete(due.id);
      await due.callback();
    }
  }
}

interface ManualTimer {
  callback(): void | Promise<void>;
  dueAt: number;
  id: number;
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
