/// <reference types="node" />

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NodeFileSystem,
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

  it('serializes an active real journal commit before restore and keeps the restored writer replayable', async () => {
    const initialProject = createDurableQueueProject();
    const restoredPrompt = initialProject.nodes.find((node) => node.id === 'prompt-start')!;
    const restoredProject = parseCanvasProject({
      ...initialProject,
      name: 'Restored durable snapshot',
      nodes: initialProject.nodes.map((node) => node.id === restoredPrompt.id
        ? { ...restoredPrompt, position: { x: 720, y: 180 } }
        : node),
    });
    const commitEntered = deferred<void>();
    const releaseCommit = deferred<void>();
    const fileSystem = new RestoreJournalObserverFileSystem();
    const created = await createRealDurableHarness(initialProject, {
      fileSystem,
      recoveryProject: restoredProject,
      syncGate: {
        async wait() {
          commitEntered.resolve();
          await releaseCommit.promise;
        },
      },
    });
    const plan = await created.handlers.getRecoveryPlan({}, { sessionId: created.sessionId });
    const candidateId = plan.candidates[0]?.candidateId;
    if (candidateId === undefined) throw new Error('Expected recovery candidate');
    const firstMovedNode = {
      ...initialProject.nodes.find((node) => node.id === 'prompt-start')!,
      position: { x: 860, y: 210 },
    };
    const commitA = created.handlers.commit({}, {
      baseRevision: 0,
      kind: 'canvas',
      projectId: initialProject.id,
      sessionId: created.sessionId,
      transaction: {
        id: 'tx-before-restore',
        label: 'Move before restore',
        operations: [{ kind: 'canvas', operation: { kind: 'update_node', node: firstMovedNode } }],
      },
    });
    await commitEntered.promise;

    fileSystem.observeRestoreJournal = true;
    const restore = created.handlers.restore({}, { candidateId, sessionId: created.sessionId });
    const settled = Promise.allSettled([commitA, restore]);
    const restoreTouchedJournalBeforeCommit = await Promise.race([
      fileSystem.restoreJournalReplaced.promise.then(() => true),
      delay(50).then(() => false),
    ]);
    releaseCommit.resolve();
    const [commitResult, restoreResult] = await settled;

    expect(restoreTouchedJournalBeforeCommit).toBe(false);
    expect(commitResult.status).toBe('fulfilled');
    expect(restoreResult).toMatchObject({
      status: 'fulfilled',
      value: { project: { name: 'Restored durable snapshot' }, restoredRevision: 0 },
    });
    const journalPath = join(created.projectRoot, 'journal', 'active.ndjson');
    expect((await readValidJournal(journalPath, { baseRevision: 0, firstSequence: 1 })).records).toEqual([]);

    const postRestoreNode = {
      ...restoredProject.nodes.find((node) => node.id === 'prompt-start')!,
      position: { x: 900, y: 260 },
    };
    await expect(created.handlers.commit({}, {
      baseRevision: 0,
      kind: 'canvas',
      projectId: restoredProject.id,
      sessionId: created.sessionId,
      transaction: {
        id: 'tx-after-restore',
        label: 'Move after restore',
        operations: [{ kind: 'canvas', operation: { kind: 'update_node', node: postRestoreNode } }],
      },
    })).resolves.toMatchObject({ revision: 1, transactionId: 'tx-after-restore' });
    const journal = await readValidJournal(journalPath, { baseRevision: 0, firstSequence: 1 });
    expect(journal.records.map((record) => record.transactionId)).toEqual(['tx-after-restore']);
    expect(replayJournal(restoredProject, 0, journal.records)).toMatchObject({
      project: { name: 'Restored durable snapshot' },
      revision: 1,
    });

    await created.handlers.closeProject({}, { sessionId: created.sessionId });
    const reopened = await created.repository.open(created.projectRoot, { mode: 'write' });
    const reopenedProject = await created.repository.readCurrentProject(reopened);
    expect(reopenedProject.name).toBe('Restored durable snapshot');
    expect(reopenedProject.nodes.find((node) => node.id === 'prompt-start')?.position).toEqual({ x: 900, y: 260 });
    await created.repository.close(reopened);
  });

  async function createRealDurableHarness(
    initialProject: CanvasProject,
    options: {
      fileSystem?: NodeFileSystem;
      recoveryProject?: CanvasProject;
      syncGate?: { wait(): Promise<void> };
    } = {},
  ) {
    tempRoot = await mkdtemp(join(tmpdir(), 'durable-project-queue-'));
    const projectRoot = join(tempRoot, 'Queue.novus-project');
    const fileSystem = options.fileSystem ?? new NodeFileSystem();
    const repository = new ProjectRepository({
      createId: sequentialId('queue-project'),
      deviceId: 'queue-test-device',
      fileSystem,
    });
    const initialSession = await repository.create(projectRoot, {
      project: initialProject,
      projectId: initialProject.id,
      projectName: initialProject.name,
    });
    await repository.close(initialSession);
    const candidatePath = join(tempRoot, 'recovery-candidate.json');
    if (options.recoveryProject !== undefined) {
      await fileSystem.writeFile(candidatePath, JSON.stringify({
        project: options.recoveryProject,
        projectId: options.recoveryProject.id,
        revision: 0,
        snapshotId: 'snapshot-restored',
      }), 'utf8');
    }
    let deferNextCommit = options.syncGate !== undefined;
    const openJournalWriter = vi.fn(async (session: Parameters<ProjectRepository['openJournalWriter']>[0]) => {
      const writer = await repository.openJournalWriter(session);
      return {
        commit: (request: Parameters<typeof writer.commit>[0]) => {
          const syncGate = deferNextCommit ? options.syncGate : undefined;
          deferNextCommit = false;
          return writer.commit(request, syncGate === undefined ? {} : { syncGate });
        },
      };
    });
    handlers = createDesktopBridgeHandlers({
      createId: sequentialId('queue-bridge'),
      dialogs: { chooseProjectRoot: async () => projectRoot },
      fileSystem,
      ...(options.recoveryProject === undefined ? {} : {
        recoveryScanner: {
          scan: async () => ({
            action: 'choose_recovery' as const,
            candidates: [{
              path: candidatePath,
              project: options.recoveryProject!,
              revision: 0,
              snapshotId: 'snapshot-restored',
              tailStatus: 'complete' as const,
            }],
            issues: [],
            projectId: options.recoveryProject!.id,
            recoveredRevision: 0,
            stableSnapshotId: 'snapshot-restored',
            targetRevision: 0,
          }),
        },
      }),
      repository: {
        close: (session) => repository.close(session),
        open: (root, options) => repository.open(root, options),
        openJournalWriter,
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
    return { handlers, opened, openJournalWriter, projectRoot, repository, sessionId: opened.sessionId };
  }
});

class RestoreJournalObserverFileSystem extends NodeFileSystem {
  observeRestoreJournal = false;
  readonly restoreJournalReplaced = deferred<void>();

  override async rename(source: string, destination: string): Promise<void> {
    await super.rename(source, destination);
    if (
      this.observeRestoreJournal
      && destination.split('\\').join('/').endsWith('/journal/active.ndjson')
    ) {
      this.restoreJournalReplaced.resolve();
    }
  }
}

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
    pasteClipboardImage: async () => null,
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
