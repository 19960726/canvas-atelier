import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KnowledgeRefreshService, type KnowledgeRefreshClock, type KnowledgeWatchAdapter, type KnowledgeWatchEvent, type KnowledgeWatchHandle } from './knowledge-refresh-service';
import { ManagedKnowledgeStore } from './managed-knowledge-store';

const runKnowledgePerf = process.env.NOVUS_RUN_KNOWLEDGE_PERF === '1';
const describePerf = runKnowledgePerf ? describe : describe.skip;
const KNOWLEDGE_REFRESH_DUPLICATE_EVENT_BUDGET_MS = 1_500;

describePerf('knowledge refresh performance', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it('deduplicates one thousand duplicate watcher events for one stable content hash', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'knowledge-refresh-perf-'));
    tempRoots.push(tempRoot);
    const sourceRoot = join(tempRoot, 'source');
    const appDataRoot = join(tempRoot, 'app-data');
    await writeKnowledgeFile(sourceRoot, 'memory/main.md', '# Scene Skill\nUse calmer liquid arcs.');
    const store = new CountingManagedKnowledgeStore({ appDataRoot });
    await store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: sourceRoot,
    });
    const watcher = new ManualWatchAdapter();
    const clock = new ManualClock();
    const service = new KnowledgeRefreshService({
      clock,
      debounceMs: 250,
      sourceDeviceId: 'perf-device',
      store,
      watchAdapter: watcher,
    });
    const states: unknown[] = [];
    service.subscribe((state) => states.push(state));

    await service.start(['scene-skill']);
    const startedAt = performance.now();
    for (let index = 0; index < 1_000; index += 1) {
      watcher.emit(sourceRoot, { eventType: 'change', filename: 'memory/main.md' });
    }
    await clock.advanceBy(250);
    const elapsedMs = performance.now() - startedAt;

    expect(store.publishCount).toBe(1);
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      activeVersion: 1,
      versionCount: 1,
    });
    expect(elapsedMs).toBeLessThan(KNOWLEDGE_REFRESH_DUPLICATE_EVENT_BUDGET_MS);
  });
});

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

class ManualWatchAdapter implements KnowledgeWatchAdapter {
  private readonly watches: ManualWatch[] = [];

  watch(rootPath: string, listener: (event: KnowledgeWatchEvent) => void): KnowledgeWatchHandle {
    this.watches.push({ listener, rootPath });
    return { close: () => undefined };
  }

  emit(rootPath: string, event: KnowledgeWatchEvent): void {
    for (const watch of this.watches) {
      if (watch.rootPath === rootPath) watch.listener(event);
    }
  }
}

interface ManualWatch {
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
    this.timers.set(id, { callback, dueAt: this.currentTime + delayMs, id });
    return id;
  }

  async advanceBy(ms: number): Promise<void> {
    this.currentTime += ms;
    for (;;) {
      const due = [...this.timers.values()]
        .filter((timer) => timer.dueAt <= this.currentTime)
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
      if (!due) return;
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
