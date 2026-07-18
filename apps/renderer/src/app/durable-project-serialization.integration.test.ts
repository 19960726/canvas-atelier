/// <reference types="node" />

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProjectRepository,
  SnapshotScheduler,
  createDesktopBridgeHandlers,
  readValidJournal,
  replayJournal,
  type DesktopBridgeHandlers,
  type PersistenceErrorCode,
} from '@agent-canvas/desktop-core';
import { parseCanvasProject, type CanvasProject } from '@agent-canvas/domain';
import {
  createStarterProject,
  replaceProjectPersistenceClientForTests,
  resetAppStoreForTests,
  useAppStore,
} from './app-store';
import type {
  ProjectCommitRequest,
  ProjectCommitResult,
  ProjectPersistenceClient,
} from './desktop-persistence';

describe('durable project serialization integration', () => {
  let handlers: DesktopBridgeHandlers | null = null;
  let tempRoot: string | null = null;

  beforeEach(() => {
    delete window.novusDesktop;
    localStorage.clear();
    resetAppStoreForTests();
  });

  afterEach(async () => {
    await handlers?.closeAllProjects();
    handlers = null;
    if (tempRoot !== null) await rm(tempRoot, { force: true, recursive: true });
    tempRoot = null;
  });

  it('writes module and reference operations in queue order and replays both after restart', async () => {
    const initialProject = createDurableQueueProject();
    const created = await createRealDurableHarness(initialProject);
    const releaseFirst = deferred<void>();
    let commitCalls = 0;
    replaceProjectPersistenceClientForTests(createBridgePersistenceClient(created, async (request, commitReal) => {
      commitCalls += 1;
      if (commitCalls === 1) await releaseFirst.promise;
      return commitReal(request);
    }));
    useAppStore.setState({
      desktopRevision: 0,
      persistenceMode: 'desktop',
      project: initialProject,
      projectLifecycle: 'durable',
      saveStatus: 'saved',
    });

    const move = useAppStore.getState().commitNodePosition('prompt-start', { x: 860, y: 210 });
    const reorder = useAppStore.getState().commitReferenceOrder(['scene', 'product']);
    expect.soft(commitCalls).toBe(1);

    releaseFirst.resolve();
    await expect(Promise.all([move, reorder])).resolves.toEqual([true, true]);

    const journalPath = join(created.projectRoot, 'journal', 'active.ndjson');
    const journal = await readValidJournal(journalPath);
    expect(journal.records.map((record) => record.label)).toEqual([
      'Move canvas node',
      'Reorder Agent references',
    ]);
    expect(journal.records.map((record) => record.revision)).toEqual([1, 2]);
    const replayed = replayJournal(initialProject, 0, journal.records);
    expect(replayed.revision).toBe(2);
    expect(replayed.project.nodes.find((node) => node.id === 'prompt-start')?.position).toEqual({ x: 860, y: 210 });
    expect(readPlacementAssetIds(replayed.project)).toEqual(['scene', 'product']);

    await created.handlers.closeProject({}, { sessionId: created.sessionId });
    const restarted = await created.repository.open(created.projectRoot, { mode: 'write' });
    const restartedProject = await created.repository.readCurrentProject(restarted);
    expect(restartedProject.nodes.find((node) => node.id === 'prompt-start')?.position).toEqual({ x: 860, y: 210 });
    expect(readPlacementAssetIds(restartedProject)).toEqual(['scene', 'product']);
    await created.repository.close(restarted);
  });

  it('keeps a failed first operation dirty and prevents queued operations from reaching journal or replay', async () => {
    const initialProject = createDurableQueueProject();
    const created = await createRealDurableHarness(initialProject);
    const firstFailure = deferred<ProjectCommitResult>();
    let commitCalls = 0;
    replaceProjectPersistenceClientForTests(createBridgePersistenceClient(created, async (request, commitReal) => {
      commitCalls += 1;
      if (commitCalls === 1) return firstFailure.promise;
      return commitReal(request);
    }));
    useAppStore.setState({
      desktopRevision: 0,
      persistenceMode: 'desktop',
      project: initialProject,
      projectLifecycle: 'durable',
      saveStatus: 'saved',
    });

    const move = useAppStore.getState().commitNodePosition('prompt-start', { x: 860, y: 210 });
    const reorder = useAppStore.getState().commitReferenceOrder(['scene', 'product']);
    expect.soft(commitCalls).toBe(1);
    firstFailure.resolve({
      code: 'DISK_FULL',
      ok: false,
      project: initialProject,
      revision: 0,
    });

    await expect(Promise.all([move, reorder])).resolves.toEqual([false, false]);
    expect(useAppStore.getState()).toMatchObject({
      canRetryProjectCommit: true,
      desktopRevision: 0,
      saveErrorCode: 'DISK_FULL',
      saveStatus: 'error',
    });
    expect(useAppStore.getState().project.nodes.find((node) => node.id === 'prompt-start')?.position).toEqual({ x: 860, y: 210 });
    expect(readPlacementAssetIds(useAppStore.getState().project)).toEqual(['product', 'scene']);

    const journalPath = join(created.projectRoot, 'journal', 'active.ndjson');
    const journal = await readValidJournal(journalPath);
    expect(journal.records).toEqual([]);
    const replayed = replayJournal(initialProject, 0, journal.records);
    expect(replayed).toMatchObject({ project: initialProject, revision: 0 });

    await created.handlers.closeProject({}, { sessionId: created.sessionId });
    const restarted = await created.repository.open(created.projectRoot, { mode: 'write' });
    const restartedProject = await created.repository.readCurrentProject(restarted);
    expect(restartedProject.nodes.find((node) => node.id === 'prompt-start')?.position).toEqual(initialProject.nodes.find((node) => node.id === 'prompt-start')?.position);
    expect(readPlacementAssetIds(restartedProject)).toEqual(['product', 'scene']);
    await created.repository.close(restarted);
  });

  async function createRealDurableHarness(initialProject: CanvasProject) {
    tempRoot = await mkdtemp(join(tmpdir(), 'durable-project-queue-'));
    const projectRoot = join(tempRoot, 'Queue.novus-project');
    const repository = new ProjectRepository({
      createId: sequentialId('queue-project'),
      deviceId: 'queue-test-device',
    });
    const initialSession = await repository.create(projectRoot, {
      project: initialProject,
      projectId: initialProject.id,
      projectName: initialProject.name,
    });
    await repository.close(initialSession);
    handlers = createDesktopBridgeHandlers({
      createId: sequentialId('queue-bridge'),
      dialogs: { chooseProjectRoot: async () => projectRoot },
      repository: {
        close: (session) => repository.close(session),
        open: (root, options) => repository.open(root, options),
        openJournalWriter: (session) => repository.openJournalWriter(session),
        readCurrentProject: (session) => repository.readCurrentProject(session),
        readCurrentRevision: (session) => repository.readCurrentRevision(session),
      },
      snapshotScheduler: {
        consider: () => null,
        flush: vi.fn(),
      } as unknown as SnapshotScheduler,
    });
    const opened = await handlers.openProject({}, { mode: 'write' });
    if (opened === null) throw new Error('Expected durable queue project to open');
    return { handlers, opened, projectRoot, repository, sessionId: opened.sessionId };
  }
});

function createBridgePersistenceClient(
  harness: {
    handlers: DesktopBridgeHandlers;
    opened: NonNullable<Awaited<ReturnType<DesktopBridgeHandlers['openProject']>>>;
    sessionId: string;
  },
  commit: (
    request: ProjectCommitRequest,
    commitReal: (request: ProjectCommitRequest) => Promise<ProjectCommitResult>,
  ) => Promise<ProjectCommitResult>,
): ProjectPersistenceClient {
  const commitReal = async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => {
    try {
      const ack = await harness.handlers.commit({}, {
        baseRevision: request.baseRevision,
        kind: request.kind,
        projectId: request.projectId,
        sessionId: harness.sessionId,
        transaction: request.transaction,
      });
      return { ok: true, project: request.nextProject, revision: ack.revision };
    } catch (error) {
      return {
        code: readErrorCode(error),
        ok: false,
        project: request.previousProject,
        revision: request.baseRevision,
      };
    }
  };
  return {
    close: async () => undefined,
    commit: (request) => commit(request, commitReal),
    hydrate: async () => ({
      availableSnapshotIds: [],
      lifecycle: 'durable',
      mode: 'desktop',
      project: harness.opened.project,
      revision: harness.opened.currentRevision,
      saveStatus: 'saved',
    }),
    importProjectImage: async () => null,
    listProjectImages: async () => [],
    restore: async () => ({
      availableSnapshotIds: [],
      lifecycle: 'durable',
      project: harness.opened.project,
      revision: harness.opened.currentRevision,
      saveStatus: 'saved',
    }),
    stablePoint: async () => ({
      availableSnapshotIds: [],
      project: harness.opened.project,
      revision: harness.opened.currentRevision,
    }),
  };
}

function createDurableQueueProject(): CanvasProject {
  const project = createStarterProject();
  const placement = project.nodes.find((node) => node.type === 'placement_preview');
  if (!placement || placement.type !== 'placement_preview') throw new Error('Missing placement preview');
  const template = placement.data.objects[0]!;
  return parseCanvasProject({
    ...project,
    name: 'Durable queue project',
    nodes: project.nodes.map((node) => node.id === placement.id
      ? {
          ...placement,
          data: {
            ...placement.data,
            objects: [
              { ...template, id: 'product', assetId: 'product', name: 'Product' },
              { ...template, id: 'scene', assetId: 'scene', name: 'Scene', role: 'scene_composition' as const },
            ],
          },
        }
      : node),
  });
}

function readPlacementAssetIds(project: CanvasProject): string[] {
  const placement = project.nodes.find((node) => node.type === 'placement_preview');
  return placement?.type === 'placement_preview'
    ? placement.data.objects.map((object) => object.assetId)
    : [];
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function readErrorCode(error: unknown): PersistenceErrorCode {
  return (typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code: string }).code
    : 'INVALID_REQUEST') as PersistenceErrorCode;
}

function sequentialId(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}
