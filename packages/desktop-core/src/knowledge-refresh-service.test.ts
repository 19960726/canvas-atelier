import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { NodeFileSystem } from './file-system';
import {
  KnowledgeRefreshService,
  type KnowledgeRefreshClock,
  type KnowledgeWatchAdapter,
  type KnowledgeWatchEvent,
  type KnowledgeWatchHandle,
} from './knowledge-refresh-service';
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
    service.subscribe((state) => states.push(state));
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
