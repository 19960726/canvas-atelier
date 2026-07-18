import { describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import {
  applyProjectTransaction,
  createAgentKnowledgeLease,
  createSkillPromotionCandidateFingerprint,
  createUserFeedbackMemory,
  type CanvasProject,
  type SkillPromotionCandidate,
} from '@agent-canvas/domain';
import {
  createKnowledgeSnapshotCandidate,
  type KnowledgeBaseStateSummary,
  type KnowledgeSnapshot,
} from '@agent-canvas/skill-store';

import type { CommitRequest } from './contracts';
import { ApprovedSnapshotPullCoordinator } from './approved-snapshot-pull';
import { releaseJournalState } from './journal-writer';
import { KnowledgeRefreshService } from './knowledge-refresh-service';
import { ManagedKnowledgeStore } from './managed-knowledge-store';
import { NodeFileSystem } from './file-system';
import { ProjectRepository, type OpenedProjectSession } from './project-repository';
import { createDesktopBridgeHandlers, registerDesktopBridgeHandlers } from './bridge-handlers';
import { SnapshotScheduler } from './snapshot-scheduler';
import {
  BRIDGE_CHANNELS,
  createPreloadApi,
  createSafeModePreloadApi,
  redactBridgeDiagnostics,
  type DesktopBridgeInvoke,
} from './preload-api';

describe('desktop bridge contract', () => {
  const starterProject: CanvasProject = {
    version: 1,
    id: 'project-1',
    name: 'Bridge Project',
    nodes: [],
    edges: [],
    projectMemory: [],
    skillPromotionCandidates: [],
  };

  it('does not expose arbitrary filesystem methods', () => {
    const mockInvoke = vi.fn(async () => undefined) as DesktopBridgeInvoke;

    expect(Object.keys(createPreloadApi(mockInvoke)).sort()).toEqual([
      'closeProject',
      'commit',
      'configureKnowledgeBase',
      'createStablePoint',
      'exportPack',
      'getKnowledgeState',
      'getRecoveryPlan',
      'importPack',
      'lifecycle',
      'openProject',
      'prepareSkillCandidateReview',
      'projectImages',
      'provider',
      'restore',
      'reviewSkillCandidate',
      'subscribeKnowledgeState',
      'subscribeKnowledgeSyncStatus',
    ]);
    expect(Object.keys(createPreloadApi(mockInvoke).provider).sort()).toEqual([
      'ackImageJobTerminal',
      'cancelImageJob',
      'configure',
      'getStatus',
      'listProfiles',
      'pollImageJob',
      'submitImageJob',
      'unlock',
    ]);
    expect(createPreloadApi(mockInvoke)).not.toHaveProperty('readFile');
    expect(createPreloadApi(mockInvoke)).not.toHaveProperty('watchPath');
    expect(createPreloadApi(mockInvoke).provider).not.toHaveProperty('fetch');
    expect(Object.keys(createPreloadApi(mockInvoke).projectImages).sort()).toEqual(['importImage', 'list']);
    expect(createPreloadApi(mockInvoke).projectImages).not.toHaveProperty('readFile');
    expect(Object.keys(createPreloadApi(mockInvoke).lifecycle).sort()).toEqual([
      'ackCloseFlush',
      'chooseCloseDecision',
      'subscribeCloseFlushRequest',
    ]);
  });

  it('unwraps provider IPC envelopes and preserves serializable locked errors in the renderer', async () => {
    const invoke = vi.fn(async () => JSON.parse(JSON.stringify({
      ok: false,
      error: {
        code: 'CREDENTIALS_LOCKED',
        message: 'Provider credentials are locked',
        retryable: true,
      },
    }))) as DesktopBridgeInvoke;
    const api = createPreloadApi(invoke);

    await expect(api.provider.pollImageJob({
      provider: 'comfly',
      providerTaskId: 'provider-job-1234567890abcdef1234567890abcdef',
    })).rejects.toMatchObject({
      code: 'CREDENTIALS_LOCKED',
      message: 'Provider credentials are locked',
      retryable: true,
    });
  });

  it('rejects malformed provider IPC envelopes before exposing values to renderer code', async () => {
    const invoke = vi.fn(async () => ({ ok: true, value: { status: 'running', extra: true } })) as DesktopBridgeInvoke;
    const api = createPreloadApi(invoke);

    await expect(api.provider.pollImageJob({
      provider: 'comfly',
      providerTaskId: 'provider-job-1234567890abcdef1234567890abcdef',
    })).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
  });

  it('subscribes and unsubscribes knowledge state listeners through the event channel', () => {
    const mockInvoke = vi.fn(async () => undefined) as DesktopBridgeInvoke;
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((_channel, _listener) => unsubscribe);
    const api = createPreloadApi(mockInvoke, subscribe);
    const listener = vi.fn();

    const stop = api.subscribeKnowledgeState(listener);
    const eventListener = subscribe.mock.calls[0]?.[1];
    eventListener?.(createKnowledgeStateSummary());
    stop();

    expect(subscribe).toHaveBeenCalledWith(BRIDGE_CHANNELS.knowledgeStateChanged, expect.any(Function));
    expect(listener).toHaveBeenCalledWith(createKnowledgeStateSummary());
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('subscribes to sanitized knowledge sync lifecycle through its own event channel', () => {
    const mockInvoke = vi.fn(async () => undefined) as DesktopBridgeInvoke;
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((_channel, _listener) => unsubscribe);
    const api = createPreloadApi(mockInvoke, subscribe);
    const listener = vi.fn();
    const status = {
      schemaVersion: 1 as const,
      knowledgeBaseId: 'scene-skill',
      status: 'offline' as const,
      changedAt: '2026-07-16T04:00:00.000Z',
      lastFailure: { reason: 'Network unavailable', failedAt: '2026-07-16T04:00:00.000Z' },
    };

    const stop = api.subscribeKnowledgeSyncStatus(listener);
    subscribe.mock.calls[0]?.[1]?.(status);
    stop();

    expect(subscribe).toHaveBeenCalledWith(BRIDGE_CHANNELS.knowledgeSyncStatusChanged, expect.any(Function));
    expect(listener).toHaveBeenCalledWith(status);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it('subscribes to close-flush requests and ACKs only strict matching lifecycle payloads', () => {
    const send = vi.fn();
    const subscribe = vi.fn((_channel, _listener) => () => undefined);
    const api = createPreloadApi(vi.fn(async () => undefined) as DesktopBridgeInvoke, subscribe, send);
    const listener = vi.fn();

    api.lifecycle.subscribeCloseFlushRequest(listener);
    const eventListener = subscribe.mock.calls[0]?.[1];
    eventListener?.({ requestId: 'close-request-123456' });
    eventListener?.({ requestId: 'close-request-123456', path: 'C:\\Users\\Private\\draft.json' });
    eventListener?.({ requestId: '../project' });

    expect(subscribe).toHaveBeenCalledWith(BRIDGE_CHANNELS.closeFlushRequest, expect.any(Function));
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({ requestId: 'close-request-123456' });

    expect(api.lifecycle.ackCloseFlush({ requestId: 'close-request-123456', phase: 'save_started' })).toBe(true);
    expect(api.lifecycle.ackCloseFlush({ requestId: 'close-request-123456', phase: 'completed', outcome: 'saved', token: 'secret' } as never)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(BRIDGE_CHANNELS.closeFlushAck, { requestId: 'close-request-123456', phase: 'save_started' });
  });
  it('invokes the close-choice channel with strict requests and defaults malformed responses to cancel', async () => {
    const invoke = vi.fn(async () => 'discard');
    const api = createPreloadApi(invoke as DesktopBridgeInvoke);
    const request = { dirty: true, projectName: '未命名画布', untitled: true };

    await expect(api.lifecycle.chooseCloseDecision(request)).resolves.toBe('discard');
    expect(invoke).toHaveBeenCalledWith(BRIDGE_CHANNELS.closeChoice, request);

    invoke.mockResolvedValueOnce('unexpected');
    await expect(api.lifecycle.chooseCloseDecision(request)).resolves.toBe('cancel');

    await expect(api.lifecycle.chooseCloseDecision({
      ...request,
      projectName: 'C:\\Users\\Private\\draft.json',
    })).resolves.toBe('cancel');
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it('drops protected values from sync lifecycle events at the preload boundary', () => {
    const subscribe = vi.fn((_channel, _listener) => () => undefined);
    const api = createPreloadApi(vi.fn(async () => undefined) as DesktopBridgeInvoke, subscribe);
    const listener = vi.fn();

    api.subscribeKnowledgeSyncStatus(listener);
    const eventListener = subscribe.mock.calls[0]?.[1];
    eventListener?.({
      schemaVersion: 1,
      knowledgeBaseId: 'scene-skill',
      status: 'offline',
      changedAt: '2026-07-16T04:00:00.000Z',
      lastFailure: {
        reason: 'Authorization: Bearer secret at C:\\Users\\Private\\sync.json',
        failedAt: '2026-07-16T04:00:00.000Z',
      },
    });
    eventListener?.({
      schemaVersion: 1,
      knowledgeBaseId: 'scene-skill',
      status: 'offline',
      changedAt: '2026-07-16T04:00:00.000Z',
      lastFailure: {
        reason: 'Network unavailable',
        failedAt: '2026-07-16T04:00:00.000Z',
        privatePath: 'C:\\Users\\Private\\sync.json',
      },
    });

    expect(listener).not.toHaveBeenCalled();
  });
  it('restricts safe mode to recovery-only bridge methods', () => {
    const mockInvoke = vi.fn(async () => undefined) as DesktopBridgeInvoke;

    expect(Object.keys(createSafeModePreloadApi(mockInvoke)).sort()).toEqual([
      'getRecoveryPlan',
      'openProject',
      'restore',
    ]);
  });

  it('keeps preload contracts isolated from main-process provider dependencies', async () => {
    const preloadApiSource = await readFile(join(process.cwd(), 'packages/desktop-core/src/preload-api.ts'), 'utf8');
    expect(preloadApiSource).not.toMatch(/provider-bridge|node:crypto|node:fs|provider-comfly|ComflyClient|safeStorage/u);

    for (const entryPoint of [
      'apps/desktop-modern/src/preload.ts',
      'apps/desktop-modern/src/safe-preload.ts',
      'apps/desktop-legacy/src/preload.ts',
      'apps/desktop-legacy/src/safe-preload.ts',
    ]) {
      const result = await build({
        absWorkingDir: process.cwd(),
        bundle: true,
        entryPoints: [entryPoint],
        external: ['electron'],
        format: 'esm',
        platform: 'node',
        target: 'node16',
        write: false,
      });
      const bundle = result.outputFiles[0]?.text;
      expect(bundle, `missing in-memory preload bundle for ${entryPoint}`).toBeDefined();
      expect(bundle).not.toMatch(/node:crypto|node:fs|provider-comfly|ComflyClient|createCipheriv|createComflyProviderService/u);
    }
  });

  it('redacts Windows paths with spaces and non-user drive roots from bridge diagnostics', () => {
    expect(redactBridgeDiagnostics('Failed at C:\\Program Files\\Novus Atelier\\foo.txt')).not.toContain('Program Files');
    expect(redactBridgeDiagnostics('Failed at E:\\画布项目\\demo\\project.novus.json')).not.toContain('画布项目');
    expect(redactBridgeDiagnostics('open file:///E:/画布项目/demo/project.novus.json')).not.toContain('画布项目');
    expect(redactBridgeDiagnostics('open file:///E:/canvas with spaces/demo/project.novus.json')).not.toContain('with spaces');
    expect(redactBridgeDiagnostics('UNC \\\\server\\share\\Folder With Spaces\\image.png')).not.toContain('Folder With Spaces');
  });

  it('rejects commits outside the active session', async () => {
    const handlers = createDesktopBridgeHandlers({
      repository: {
        close: vi.fn(async () => undefined),
      },
    });

    const request: CommitRequest & { readonly sessionId: string } = {
      baseRevision: 0,
      kind: 'canvas',
      projectId: 'project-1',
      sessionId: 'session-1',
      transaction: {
        id: 'tx-1',
        label: 'create prompt-1',
        operations: [
          {
            kind: 'canvas',
            operation: {
              kind: 'create_node',
              node: {
                id: 'prompt-1',
                type: 'prompt',
                position: { x: 0, y: 0 },
                data: { prompt: 'Prompt 1', requirementIds: [] },
              },
            },
          },
        ],
      },
    };

    await expect(
      handlers.commit({}, { ...request, sessionId: 'unknown' }),
    ).rejects.toMatchObject({ code: 'INVALID_SESSION' });
  });

  it('returns the current desktop-owned project when opening a session', async () => {
    const session = createOpenedSession();
    const handlers = createDesktopBridgeHandlers({
      dialogs: {
        chooseProjectRoot: vi.fn(async () => 'C:\\redacted\\Demo.novus-project'),
      },
      repository: {
        close: vi.fn(async () => undefined),
        open: vi.fn(async () => session),
        openJournalWriter: vi.fn(async () => ({
          commit: vi.fn(),
        })),
        readCurrentProject: vi.fn(async () => starterProject),
      },
    });

    await expect(handlers.openProject({}, { mode: 'write' })).resolves.toMatchObject({
      project: starterProject,
      projectId: starterProject.id,
      stableSnapshotRevision: 2,
    });
  });

  it('cancels knowledge configuration through the main-process picker without accepting renderer paths', async () => {
    const chooseKnowledgeRoot = vi.fn(async () => null);
    const configure = vi.fn();
    const handlers = createDesktopBridgeHandlers({
      dialogs: {
        chooseKnowledgeRoot,
      },
      knowledgeRefreshService: {
        refreshNow: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        subscribe: vi.fn(),
      },
      knowledgeStore: {
        configure,
        listStates: vi.fn(async () => []),
        readActive: vi.fn(async () => null),
      },
      repository: {
        close: vi.fn(async () => undefined),
      },
    });

    await expect(handlers.configureKnowledgeBase({}, {
      displayName: 'Scene Skill',
      knowledgeBaseId: 'scene-skill',
      rootPath: 'C:\\Users\\Private\\Documents',
    })).resolves.toBeNull();

    expect(chooseKnowledgeRoot).toHaveBeenCalledWith({
      displayName: 'Scene Skill',
      knowledgeBaseId: 'scene-skill',
    });
    expect(configure).not.toHaveBeenCalled();
  });

  it('updates remote pull configuration after local configure and refresh succeed', async () => {
    const state = createKnowledgeStateSummary();
    const updateConfiguredKnowledgeBases = vi.fn(async () => undefined);
    const start = vi.fn(async () => undefined);
    const refreshNow = vi.fn(async () => state);
    const handlers = createDesktopBridgeHandlers({
      dialogs: { chooseKnowledgeRoot: vi.fn(async () => String.raw`C:\redacted\knowledge`) },
      knowledgeConfigurationSync: { updateConfiguredKnowledgeBases },
      knowledgeRefreshService: {
        refreshNow,
        start,
        stop: vi.fn(),
        subscribe: vi.fn(),
      },
      knowledgeStore: {
        configure: vi.fn(async () => ({ schemaVersion: 1 as const, knowledgeBaseId: 'scene-skill', displayName: 'Scene Skill', knowledgeRootId: 'root-scene-skill' })),
        listStates: vi.fn(async () => [state]),
        readActive: vi.fn(async () => null),
      },
      repository: { close: vi.fn(async () => undefined) },
    });

    await expect(handlers.configureKnowledgeBase({}, {
      displayName: 'Scene Skill',
      knowledgeBaseId: 'scene-skill',
    })).resolves.toEqual(state);

    expect(start).toHaveBeenCalledWith(['scene-skill']);
    expect(refreshNow).toHaveBeenCalledWith('scene-skill');
    expect(updateConfiguredKnowledgeBases).toHaveBeenCalledWith(['scene-skill']);
    expect(refreshNow.mock.invocationCallOrder[0]).toBeLessThan(updateConfiguredKnowledgeBases.mock.invocationCallOrder[0]!);
  });
  it('configures through the real bridge and immediately pulls remote state without restart', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'novus-configure-sync-'));
    const appDataRoot = join(tempRoot, 'app-data');
    const sourceRoot = join(tempRoot, 'knowledge', 'scene-skill');
    await mkdir(join(sourceRoot, 'memory'), { recursive: true });
    await writeFile(join(sourceRoot, 'memory', 'main.md'), '# local scene skill', 'utf8');
    const store = new ManagedKnowledgeStore({ appDataRoot });
    const refresh = new KnowledgeRefreshService({
      stabilityWait: async () => undefined,
      store,
      watchAdapter: { watch: () => ({ close: () => undefined }) },
    });
    const remote = createKnowledgeSnapshot('# remote scene skill', 2);
    const pullApprovedSnapshot = vi.fn(async () => ({ snapshot: remote, cursor: 'cursor-configured-live' }));
    const coordinator = new ApprovedSnapshotPullCoordinator({
      appDataRoot,
      client: { pullApprovedSnapshot },
      clearInterval: vi.fn(),
      setInterval: () => 101,
      store,
    });
    const statuses: string[] = [];
    coordinator.subscribeSyncStatus((status) => statuses.push(status.status));
    await coordinator.start([]);
    const handlers = createDesktopBridgeHandlers({
      appDataRoot,
      dialogs: { chooseKnowledgeRoot: vi.fn(async () => sourceRoot) },
      knowledgeConfigurationSync: coordinator,
      knowledgeRefreshService: refresh,
      knowledgeStore: store,
      knowledgeSyncStatusProvider: coordinator,
      repository: { close: vi.fn(async () => undefined) },
    });

    try {
      await expect(handlers.configureKnowledgeBase({}, {
        displayName: 'Scene Skill',
        knowledgeBaseId: 'scene-skill',
      })).resolves.toMatchObject({ activeVersion: 2, status: 'active' });

      expect(pullApprovedSnapshot).toHaveBeenCalledWith('scene-skill', undefined);
      expect(statuses).toEqual(['syncing', 'updated']);
      await expect(store.readActive('scene-skill')).resolves.toEqual(remote);
    } finally {
      await refresh.stop();
      await coordinator.stop();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
  it('returns public knowledge summaries without private store fields', async () => {
    const state = createKnowledgeStateSummary();
    const syncStatus = {
      schemaVersion: 1 as const,
      knowledgeBaseId: 'scene-skill',
      status: 'offline' as const,
      changedAt: '2026-07-16T04:00:00.000Z',
      lastFailure: { reason: 'Network unavailable', failedAt: '2026-07-16T04:00:00.000Z' },
    };
    const handlers = createDesktopBridgeHandlers({
      knowledgeRefreshService: {
        refreshNow: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        subscribe: vi.fn(),
      },
      knowledgeSyncStatusProvider: { listSyncStatuses: vi.fn(() => [syncStatus]) },
      knowledgeStore: {
        configure: vi.fn(),
        listStates: vi.fn(async () => [{ ...state, rootPath: 'C:\\Users\\Private\\Knowledge' }]),
        readActive: vi.fn(async () => null),
      },
      repository: {
        close: vi.fn(async () => undefined),
      },
    });

    const result = await handlers.getKnowledgeState({}, undefined);

    expect(result).toEqual({ states: [state], syncStatuses: [syncStatus] });
    expect(JSON.stringify(result)).not.toContain('Private');
    expect(JSON.stringify(result)).not.toContain('rootPath');
  });

  it('rejects protected retained sync status during bridge hydration', async () => {
    const handlers = createDesktopBridgeHandlers({
      knowledgeRefreshService: createKnowledgeRefreshServiceStub(),
      knowledgeStore: {
        configure: vi.fn(),
        listStates: vi.fn(async () => []),
        readActive: vi.fn(async () => null),
      },
      knowledgeSyncStatusProvider: {
        listSyncStatuses: () => [{
          schemaVersion: 1,
          knowledgeBaseId: 'scene-skill',
          status: 'offline',
          changedAt: '2026-07-16T04:00:00.000Z',
          lastFailure: {
            reason: 'Authorization: Bearer secret at C:\\Users\\Private\\sync.json',
            failedAt: '2026-07-16T04:00:00.000Z',
          },
        }],
      },
      repository: { close: vi.fn(async () => undefined) },
    });

    await expect(handlers.getKnowledgeState({}, undefined)).rejects.toThrow(/protected|public/i);
  });
  it('rejects missing active-project skill candidates with INVALID_REQUEST', async () => {
    const handlers = createDesktopBridgeHandlers({
      repository: {
        close: vi.fn(async () => undefined),
      },
    });

    await expect(handlers.reviewSkillCandidate({}, {
      candidateId: 'candidate-missing',
      decision: 'rejected',
      projectId: starterProject.id,
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('rolls back approved skill candidates through managed knowledge rollback and persists audit state', async () => {
    const approvedCandidate = createApprovedSkillCandidate();
    const project: CanvasProject = {
      ...starterProject,
      skillPromotionCandidates: [approvedCandidate],
    };
    const commit = vi.fn(async (_request: CommitRequest) => ({
      committedAt: '2026-07-15T10:00:00.000Z',
      projectId: starterProject.id,
      revision: 6,
      sequence: 6,
      transactionId: 'review-skill-candidate-1',
    }));
    const rollback = vi.fn(async () => rolledBackKnowledgeState());
    const handlers = createDesktopBridgeHandlers({
      createId: createSequentialId('session'),
      dialogs: {
        chooseProjectRoot: vi.fn(async () => 'C:\\redacted\\Demo.novus-project'),
      },
      knowledgeRefreshService: {
        refreshNow: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        subscribe: vi.fn(),
      },
      knowledgeStore: {
        configure: vi.fn(),
        listStates: vi.fn(async () => [knowledgeStateAtVersion(3, 3)]),
        readActive: vi.fn(async () => null),
        rollback,
      } as never,
      repository: {
        close: vi.fn(async () => undefined),
        open: vi.fn(async () => createOpenedSession()),
        openJournalWriter: vi.fn(async () => ({ commit })),
        readCurrentProject: vi.fn(async () => project),
        readCurrentRevision: vi.fn(async () => 5),
      },
    });

    await handlers.openProject({}, { mode: 'write' });
    const result = await handlers.reviewSkillCandidate({}, {
      candidateId: approvedCandidate.id,
      decision: 'rolled_back',
      projectId: starterProject.id,
      targetVersion: 2,
    });

    expect(rollback).toHaveBeenCalledWith('scene-skill', 2);
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
      baseRevision: 5,
      kind: 'system',
      projectId: starterProject.id,
      transaction: expect.objectContaining({
        operations: [expect.objectContaining({
          kind: 'set_skill_candidates',
          candidates: [expect.objectContaining({
            id: approvedCandidate.id,
            reviewStatus: 'rolled_back',
            publishedKnowledgeVersion: 3,
            rolledBackAt: expect.any(String),
          })],
        })],
      }),
    }));
    expect(result).toMatchObject({
      currentRevision: 6,
      candidate: {
        id: approvedCandidate.id,
        reviewStatus: 'rolled_back',
      },
      knowledgeState: {
        activeVersion: 2,
        status: 'rolled_back',
      },
    });
  });

  it('does not activate approved knowledge before the project review commit is acknowledged', async () => {
    const active = createKnowledgeSnapshot('# Scene Skill', 1);
    const pendingCandidate = createReadySkillCandidate(active);
    const project = createProjectWithPendingSkillCandidate(pendingCandidate);
    const commit = vi.fn(async () => {
      throw new Error('injected project commit failure');
    });
    const publish = vi.fn(async () => undefined);
    const handlers = createDesktopBridgeHandlers({
      createId: createSequentialId('session'),
      dialogs: {
        chooseProjectRoot: vi.fn(async () => 'C:\\redacted\\Demo.novus-project'),
      },
      knowledgeRefreshService: {
        refreshNow: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        subscribe: vi.fn(),
      },
      knowledgeStore: {
        configure: vi.fn(),
        listStates: vi.fn(async () => [knowledgeStateAtVersion(1, 1)]),
        publish,
        readActive: vi.fn(async () => active),
      } as never,
      repository: {
        close: vi.fn(async () => undefined),
        open: vi.fn(async () => createOpenedSession()),
        openJournalWriter: vi.fn(async () => ({ commit })),
        readCurrentProject: vi.fn(async () => project),
        readCurrentRevision: vi.fn(async () => 5),
      },
    });

    await handlers.openProject({}, { mode: 'write' });
    await expect(handlers.reviewSkillCandidate({}, createBoundReviewRequest(pendingCandidate, active))).rejects.toThrow(/commit failure/);

    expect(commit).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  });

  it('commits approved skill candidates with production source, managed, and proposed review text', async () => {
    const active = createKnowledgeSnapshot('Managed rule body: keep the existing cool background lighting.', 1);
    const pendingCandidate = createReadySkillCandidate(active);
    const sourceMemory = {
      ...createBridgeFeedbackMemory('memory-feedback', 1),
      nextStep: 'Source memory rule body: keep the product logo locked before changing props.',
    };
    const project: CanvasProject = {
      ...starterProject,
      projectMemory: [sourceMemory],
      skillPromotionCandidates: [pendingCandidate],
    };
    const approvedSnapshot = createKnowledgeSnapshot('# approved version 2', 2);
    const commit = vi.fn(async (_request: CommitRequest) => ({
      committedAt: '2026-07-16T05:00:00.000Z',
      projectId: starterProject.id,
      revision: 6,
      sequence: 6,
      transactionId: 'review-skill-candidate-1',
    }));
    const stageApprovedSnapshot = vi.fn(async (_candidate, metadata: { stageId: string }) => ({
      stageId: metadata.stageId,
      snapshot: approvedSnapshot,
    }));
    const handlers = createDesktopBridgeHandlers({
      approvedSnapshotOutbox: { enqueueApprovedSnapshot: vi.fn(async () => undefined) },
      createId: createSequentialId('session'),
      dialogs: { chooseProjectRoot: vi.fn(async () => 'C:\\redacted\\Demo.novus-project') },
      knowledgeRefreshService: createKnowledgeRefreshServiceStub(),
      knowledgeStore: {
        activateStagedTransition: vi.fn(async () => knowledgeStateAtVersion(2, 2)),
        configure: vi.fn(),
        finalizeStagedTransition: vi.fn(async () => undefined),
        listStates: vi.fn(async () => [knowledgeStateAtVersion(1, 1)]),
        readActive: vi.fn(async () => active),
        recordStagedTransitionOutboxIntent: vi.fn(async () => undefined),
        stageApprovedSnapshot,
      } as never,
      repository: {
        close: vi.fn(async () => undefined),
        open: vi.fn(async () => createOpenedSession()),
        openJournalWriter: vi.fn(async () => ({ commit })),
        readCurrentProject: vi.fn(async () => project),
        readCurrentRevision: vi.fn(async () => 5),
      },
    });

    await handlers.openProject({}, { mode: 'write' });
    await expect(handlers.reviewSkillCandidate({}, createBoundReviewRequest(pendingCandidate, active))).resolves.toMatchObject({
      candidate: {
        reviewStatus: 'approved',
        sourceRule: expect.stringContaining('Source memory rule body: keep the product logo locked before changing props.'),
        managedRule: 'Managed rule body: keep the existing cool background lighting.',
        rule: 'Use slower, heavier liquid arcs.',
      },
    });

    const operation = commit.mock.calls[0]![0].transaction.operations[0];
    if (operation === undefined || operation.kind !== 'set_skill_candidates') {
      throw new Error('Expected set_skill_candidates operation');
    }
    const reviewedCandidate = operation.candidates[0]!;
    expect(reviewedCandidate.sourceRule).toContain('Source memory rule body: keep the product logo locked before changing props.');
    expect(reviewedCandidate.managedRule).toBe('Managed rule body: keep the existing cool background lighting.');
    expect(reviewedCandidate.rule).toBe('Use slower, heavier liquid arcs.');
    expect(reviewedCandidate.diffHunks).toEqual([
      '- Managed rule body: keep the existing cool background lighting.',
      '+ Use slower, heavier liquid arcs.',
    ]);
    expect(stageApprovedSnapshot).toHaveBeenCalledOnce();
  });

  it('prepares reviewable Skill candidate preview without writing source knowledge', async () => {
    const pendingCandidate = createPendingSkillCandidate();
    const sourceMemory = {
      ...createBridgeFeedbackMemory('memory-feedback', 1),
      nextStep: 'Source memory rule body: keep the product logo locked before changing props.',
    };
    const project: CanvasProject = {
      ...starterProject,
      projectMemory: [sourceMemory],
      skillPromotionCandidates: [pendingCandidate],
    };
    const active = createKnowledgeSnapshot('Managed rule body: keep the existing cool background lighting.', 1);
    const commit = vi.fn(async (_request: CommitRequest) => ({
      committedAt: '2026-07-16T05:00:00.000Z',
      projectId: starterProject.id,
      revision: 6,
      sequence: 6,
      transactionId: 'prepare-skill-candidate-1',
    }));
    const stageApprovedSnapshot = vi.fn();
    const handlers = createDesktopBridgeHandlers({
      approvedSnapshotOutbox: { enqueueApprovedSnapshot: vi.fn(async () => undefined) },
      createId: createSequentialId('session'),
      dialogs: { chooseProjectRoot: vi.fn(async () => 'C:\\redacted\\Demo.novus-project') },
      knowledgeRefreshService: createKnowledgeRefreshServiceStub(),
      knowledgeStore: {
        activateStagedTransition: vi.fn(),
        configure: vi.fn(),
        finalizeStagedTransition: vi.fn(),
        listStates: vi.fn(async () => [knowledgeStateAtVersion(1, 1)]),
        readActive: vi.fn(async () => active),
        recordStagedTransitionOutboxIntent: vi.fn(),
        stageApprovedSnapshot,
      } as never,
      repository: {
        close: vi.fn(async () => undefined),
        open: vi.fn(async () => createOpenedSession()),
        openJournalWriter: vi.fn(async () => ({ commit })),
        readCurrentProject: vi.fn(async () => project),
        readCurrentRevision: vi.fn(async () => 5),
      },
    });

    await handlers.openProject({}, { mode: 'write' });
    const result = await handlers.prepareSkillCandidateReview({}, {
      baseRevision: 5,
      candidateId: pendingCandidate.id,
      candidateFingerprint: createSkillPromotionCandidateFingerprint(pendingCandidate),
      projectId: starterProject.id,
    });

    expect(result.candidate).toMatchObject({
      id: pendingCandidate.id,
      reviewStatus: 'pending_review',
      sourceRule: expect.stringContaining('Source memory rule body: keep the product logo locked before changing props.'),
      managedRule: 'Managed rule body: keep the existing cool background lighting.',
      rule: 'Use slower, heavier liquid arcs.',
    });
    expect(result.candidate.diffHunks).toEqual([
      '- Managed rule body: keep the existing cool background lighting.',
      '+ Use slower, heavier liquid arcs.',
    ]);
    expect(stageApprovedSnapshot).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledOnce();
  });

  it('rejects Skill approval when the active managed snapshot changed after the prepared preview', async () => {
    const previewSnapshot = createKnowledgeSnapshot('Managed rule body: keep the existing cool background lighting.', 1);
    const refreshedSnapshot = createKnowledgeSnapshot('Managed rule body: refreshed after preview.', 2);
    const readyCandidate = createReadySkillCandidate(previewSnapshot);
    const project = createProjectWithPendingSkillCandidate(readyCandidate);
    const commit = vi.fn(async (_request: CommitRequest) => ({
      committedAt: '2026-07-16T05:30:00.000Z',
      projectId: starterProject.id,
      revision: 6,
      sequence: 6,
      transactionId: 'review-skill-candidate-1',
    }));
    const stageApprovedSnapshot = vi.fn(async (_candidate, metadata: { stageId: string }) => ({
      stageId: metadata.stageId,
      snapshot: createKnowledgeSnapshot('# approved version 2', 2),
    }));
    const handlers = createDesktopBridgeHandlers({
      approvedSnapshotOutbox: { enqueueApprovedSnapshot: vi.fn(async () => undefined) },
      createId: createSequentialId('session'),
      dialogs: { chooseProjectRoot: vi.fn(async () => 'C:\\redacted\\Demo.novus-project') },
      knowledgeRefreshService: createKnowledgeRefreshServiceStub(),
      knowledgeStore: {
        activateStagedTransition: vi.fn(),
        configure: vi.fn(),
        finalizeStagedTransition: vi.fn(),
        listStates: vi.fn(async () => [knowledgeStateAtVersion(2, 2)]),
        readActive: vi.fn(async () => refreshedSnapshot),
        recordStagedTransitionOutboxIntent: vi.fn(),
        stageApprovedSnapshot,
      } as never,
      repository: {
        close: vi.fn(async () => undefined),
        open: vi.fn(async () => createOpenedSession()),
        openJournalWriter: vi.fn(async () => ({ commit })),
        readCurrentProject: vi.fn(async () => project),
        readCurrentRevision: vi.fn(async () => 5),
      },
    });

    await handlers.openProject({}, { mode: 'write' });
    await expect(handlers.reviewSkillCandidate({}, createBoundReviewRequest(readyCandidate, previewSnapshot))).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
      retryable: true,
    });

    expect(stageApprovedSnapshot).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('rejects Skill approval when the project revision and candidate changed after the prepared preview', async () => {
    const previewSnapshot = createKnowledgeSnapshot('Managed rule body: keep the existing cool background lighting.', 1);
    const readyCandidate = createReadySkillCandidate(previewSnapshot);
    const project = createProjectWithPendingSkillCandidate(readyCandidate);
    const mutatedCandidate = {
      ...readyCandidate,
      rule: 'Mutated candidate rule after preview.',
    } as SkillPromotionCandidate;
    const mutatedProject = createProjectWithPendingSkillCandidate(mutatedCandidate);
    const commit = vi.fn(async (_request: CommitRequest) => ({
      committedAt: '2026-07-16T05:31:00.000Z',
      projectId: starterProject.id,
      revision: 7,
      sequence: 7,
      transactionId: 'review-skill-candidate-mutated',
    }));
    const stageApprovedSnapshot = vi.fn(async (_candidate, metadata: { stageId: string }) => ({
      stageId: metadata.stageId,
      snapshot: createKnowledgeSnapshot('# approved version 2', 2),
    }));
    const readCurrentProject = vi.fn()
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce(mutatedProject);
    const readCurrentRevision = vi.fn()
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(6);
    const handlers = createDesktopBridgeHandlers({
      approvedSnapshotOutbox: { enqueueApprovedSnapshot: vi.fn(async () => undefined) },
      createId: createSequentialId('session'),
      dialogs: { chooseProjectRoot: vi.fn(async () => 'C:\\redacted\\Demo.novus-project') },
      knowledgeRefreshService: createKnowledgeRefreshServiceStub(),
      knowledgeStore: {
        activateStagedTransition: vi.fn(),
        configure: vi.fn(),
        discardStagedTransition: vi.fn(async () => undefined),
        finalizeStagedTransition: vi.fn(),
        listStates: vi.fn(async () => [knowledgeStateAtVersion(1, 1)]),
        readActive: vi.fn(async () => previewSnapshot),
        recordStagedTransitionOutboxIntent: vi.fn(),
        stageApprovedSnapshot,
      } as never,
      repository: {
        close: vi.fn(async () => undefined),
        open: vi.fn(async () => createOpenedSession()),
        openJournalWriter: vi.fn(async () => ({ commit })),
        readCurrentProject,
        readCurrentRevision,
      },
    });

    await handlers.openProject({}, { mode: 'write' });
    await expect(handlers.reviewSkillCandidate({}, createBoundReviewRequest(readyCandidate, previewSnapshot))).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
      retryable: true,
    });

    expect(stageApprovedSnapshot).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('rejects stale Skill candidate preparation when the candidate changed before commit', async () => {
    const pendingCandidate = createPendingSkillCandidate();
    const sourceMemory = {
      ...createBridgeFeedbackMemory('memory-feedback', 1),
      nextStep: 'Source memory rule body: keep the product logo locked before changing props.',
    };
    const project: CanvasProject = {
      ...starterProject,
      projectMemory: [sourceMemory],
      skillPromotionCandidates: [pendingCandidate],
    };
    const rejectedCandidate: SkillPromotionCandidate = {
      ...pendingCandidate,
      reviewStatus: 'rejected',
      reviewedAt: '2026-07-16T05:01:00.000Z',
      reviewTransactionId: 'review-skill-rejected',
    };
    const projectAfterReject: CanvasProject = {
      ...project,
      skillPromotionCandidates: [rejectedCandidate],
    };
    const active = createKnowledgeSnapshot('Managed rule body: keep the existing cool background lighting.', 1);
    const commit = vi.fn(async (_request: CommitRequest) => ({
      committedAt: '2026-07-16T05:00:00.000Z',
      projectId: starterProject.id,
      revision: 6,
      sequence: 6,
      transactionId: 'prepare-skill-candidate-1',
    }));
    const readCurrentProject = vi.fn(async () => (
      readCurrentProject.mock.calls.length <= 2 ? project : projectAfterReject
    ));
    const handlers = createDesktopBridgeHandlers({
      createId: createSequentialId('session'),
      dialogs: { chooseProjectRoot: vi.fn(async () => 'C:\\redacted\\Demo.novus-project') },
      knowledgeRefreshService: createKnowledgeRefreshServiceStub(),
      knowledgeStore: {
        configure: vi.fn(),
        listStates: vi.fn(async () => [knowledgeStateAtVersion(1, 1)]),
        readActive: vi.fn(async () => active),
      } as never,
      repository: {
        close: vi.fn(async () => undefined),
        open: vi.fn(async () => createOpenedSession()),
        openJournalWriter: vi.fn(async () => ({ commit })),
        readCurrentProject,
        readCurrentRevision: vi.fn(async () => 5),
      },
    });

    await handlers.openProject({}, { mode: 'write' });
    await expect(handlers.prepareSkillCandidateReview({}, {
      baseRevision: 5,
      candidateId: pendingCandidate.id,
      candidateFingerprint: createSkillPromotionCandidateFingerprint(pendingCandidate),
      projectId: starterProject.id,
    })).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
      retryable: true,
    });

    expect(commit).not.toHaveBeenCalled();
  });

  it('rejects skill approval without source memory content instead of fabricating review text', async () => {
    const active = createKnowledgeSnapshot('Managed rule body: keep stable lighting.', 1);
    const pendingCandidate = createReadySkillCandidate(active);
    const project: CanvasProject = {
      ...starterProject,
      projectMemory: [],
      skillPromotionCandidates: [pendingCandidate],
    };
    const commit = vi.fn();
    const stageApprovedSnapshot = vi.fn();
    const handlers = createDesktopBridgeHandlers({
      approvedSnapshotOutbox: { enqueueApprovedSnapshot: vi.fn(async () => undefined) },
      createId: createSequentialId('session'),
      dialogs: { chooseProjectRoot: vi.fn(async () => 'C:\\redacted\\Demo.novus-project') },
      knowledgeRefreshService: createKnowledgeRefreshServiceStub(),
      knowledgeStore: {
        activateStagedTransition: vi.fn(),
        configure: vi.fn(),
        finalizeStagedTransition: vi.fn(),
        listStates: vi.fn(async () => [knowledgeStateAtVersion(1, 1)]),
        readActive: vi.fn(async () => active),
        recordStagedTransitionOutboxIntent: vi.fn(),
        stageApprovedSnapshot,
      } as never,
      repository: {
        close: vi.fn(async () => undefined),
        open: vi.fn(async () => createOpenedSession()),
        openJournalWriter: vi.fn(async () => ({ commit })),
        readCurrentProject: vi.fn(async () => project),
        readCurrentRevision: vi.fn(async () => 5),
      },
    });

    await handlers.openProject({}, { mode: 'write' });
    await expect(handlers.reviewSkillCandidate({}, createBoundReviewRequest(pendingCandidate, active))).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    expect(commit).not.toHaveBeenCalled();
    expect(stageApprovedSnapshot).not.toHaveBeenCalled();
  });

  it('does not activate rollback knowledge before the project review commit is acknowledged', async () => {
    const approvedCandidate = createApprovedSkillCandidate();
    const project: CanvasProject = {
      ...starterProject,
      skillPromotionCandidates: [approvedCandidate],
    };
    const commit = vi.fn(async () => {
      throw new Error('injected rollback commit failure');
    });
    const rollback = vi.fn(async () => rolledBackKnowledgeState());
    const handlers = createDesktopBridgeHandlers({
      createId: createSequentialId('session'),
      dialogs: {
        chooseProjectRoot: vi.fn(async () => 'C:\\redacted\\Demo.novus-project'),
      },
      knowledgeRefreshService: {
        refreshNow: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        subscribe: vi.fn(),
      },
      knowledgeStore: {
        configure: vi.fn(),
        listStates: vi.fn(async () => [knowledgeStateAtVersion(3, 3)]),
        readActive: vi.fn(async () => null),
        rollback,
      } as never,
      repository: {
        close: vi.fn(async () => undefined),
        open: vi.fn(async () => createOpenedSession()),
        openJournalWriter: vi.fn(async () => ({ commit })),
        readCurrentProject: vi.fn(async () => project),
        readCurrentRevision: vi.fn(async () => 5),
      },
    });

    await handlers.openProject({}, { mode: 'write' });
    await expect(handlers.reviewSkillCandidate({}, {
      candidateId: approvedCandidate.id,
      decision: 'rolled_back',
      projectId: starterProject.id,
      targetVersion: 2,
    })).rejects.toThrow(/commit failure/);

    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
  });

  it('discards a staged approval when commit rejects before append so the next approval can proceed without reopen', async () => {
    const active = createKnowledgeSnapshot('# Scene Skill', 1);
    const pendingCandidate = createReadySkillCandidate(active);
    const project = createProjectWithPendingSkillCandidate(pendingCandidate);
    const snapshot = createKnowledgeSnapshot('# approved version 2', 2);
    let reserved = false;
    const discardStagedTransition = vi.fn(async () => { reserved = false; });
    const stageApprovedSnapshot = vi.fn(async (_candidate, metadata: { stageId: string }) => {
      if (reserved) throw new Error('reservation still held');
      reserved = true;
      return { stageId: metadata.stageId, snapshot };
    });
    const activateStagedTransition = vi.fn(async () => knowledgeStateAtVersion(2, 2));
    const finalizeStagedTransition = vi.fn(async () => { reserved = false; });
    const commit = vi.fn()
      .mockRejectedValueOnce(new Error('injected reject before append'))
      .mockResolvedValueOnce({
        committedAt: '2026-07-16T02:00:00.000Z',
        projectId: starterProject.id,
        revision: 6,
        sequence: 6,
        transactionId: 'acknowledged-second-attempt',
      });
    const handlers = createDesktopBridgeHandlers({
      approvedSnapshotOutbox: { enqueueApprovedSnapshot: vi.fn(async () => undefined) },
      createId: createSequentialId('session'),
      dialogs: { chooseProjectRoot: vi.fn(async () => 'C:\\redacted\\Demo.novus-project') },
      knowledgeRefreshService: createKnowledgeRefreshServiceStub(),
      knowledgeStore: {
        activateStagedTransition,
        configure: vi.fn(),
        discardStagedTransition,
        finalizeStagedTransition,
        listStates: vi.fn(async () => [knowledgeStateAtVersion(1, 1)]),
        readActive: vi.fn(async () => active),
        recordStagedTransitionOutboxIntent: vi.fn(async () => undefined),
        stageApprovedSnapshot,
      } as never,
      repository: {
        close: vi.fn(async () => undefined),
        open: vi.fn(async () => createOpenedSession()),
        openJournalWriter: vi.fn(async () => ({ commit })),
        readCurrentProject: vi.fn(async () => project),
        readCurrentRevision: vi.fn(async () => 5),
      },
    });

    await handlers.openProject({}, { mode: 'write' });
    const request = createBoundReviewRequest(pendingCandidate, active);
    await expect(handlers.reviewSkillCandidate({}, request)).rejects.toThrow(/reject before append/);
    expect(discardStagedTransition).toHaveBeenCalledWith(expect.stringMatching(/^knowledge-review-skill-/), 'commit_not_acknowledged');
    expect(activateStagedTransition).not.toHaveBeenCalled();

    await expect(handlers.reviewSkillCandidate({}, request)).resolves.toMatchObject({
      candidate: { reviewStatus: 'approved' },
      currentRevision: 6,
    });
    expect(stageApprovedSnapshot).toHaveBeenCalledTimes(2);
  });

  it('preserves the staged reservation and original commit error when durable read-back is ambiguous', async () => {
    const active = createKnowledgeSnapshot('# Scene Skill', 1);
    const pendingCandidate = createReadySkillCandidate(active);
    const project = createProjectWithPendingSkillCandidate(pendingCandidate);
    const snapshot = createKnowledgeSnapshot('# approved version 2', 2);
    const commitError = new Error('injected commit rejection');
    const discardStagedTransition = vi.fn(async () => undefined);
    const readCurrentProject = vi.fn()
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce(project)
      .mockRejectedValueOnce(new Error('injected durable read-back failure'));
    const handlers = createDesktopBridgeHandlers({
      approvedSnapshotOutbox: { enqueueApprovedSnapshot: vi.fn(async () => undefined) },
      createId: createSequentialId('session'),
      dialogs: { chooseProjectRoot: vi.fn(async () => 'C:\\redacted\\Demo.novus-project') },
      knowledgeRefreshService: createKnowledgeRefreshServiceStub(),
      knowledgeStore: {
        activateStagedTransition: vi.fn(),
        configure: vi.fn(),
        discardStagedTransition,
        finalizeStagedTransition: vi.fn(),
        listStates: vi.fn(async () => [knowledgeStateAtVersion(1, 1)]),
        readActive: vi.fn(async () => active),
        recordStagedTransitionOutboxIntent: vi.fn(),
        stageApprovedSnapshot: vi.fn(async (_candidate, metadata: { stageId: string }) => ({
          stageId: metadata.stageId,
          snapshot,
        })),
      } as never,
      repository: {
        close: vi.fn(async () => undefined),
        open: vi.fn(async () => createOpenedSession()),
        openJournalWriter: vi.fn(async () => ({ commit: vi.fn(async () => { throw commitError; }) })),
        readCurrentProject,
        readCurrentRevision: vi.fn(async () => 5),
      },
    });

    await handlers.openProject({}, { mode: 'write' });
    await expect(handlers.reviewSkillCandidate({}, createBoundReviewRequest(pendingCandidate, active))).rejects.toBe(commitError);

    expect(discardStagedTransition).not.toHaveBeenCalled();
  });
  it('preserves the original commit error and stage when exact-project revision readback is ambiguous', async () => {
    const active = createKnowledgeSnapshot('# Scene Skill', 1);
    const pendingCandidate = createReadySkillCandidate(active);
    let persistedProject = createProjectWithPendingSkillCandidate(pendingCandidate);
    const snapshot = createKnowledgeSnapshot('# approved version 2', 2);
    const commitError = new Error('response lost after durable append');
    const discardStagedTransition = vi.fn(async () => undefined);
    const activateStagedTransition = vi.fn();
    const commit = vi.fn(async (request: CommitRequest) => {
      const operation = request.transaction.operations.find((item) => item.kind === 'set_skill_candidates');
      if (operation?.kind !== 'set_skill_candidates') throw new Error('missing candidate commit');
      persistedProject = { ...persistedProject, skillPromotionCandidates: [...operation.candidates] };
      throw commitError;
    });
    const handlers = createDesktopBridgeHandlers({
      approvedSnapshotOutbox: { enqueueApprovedSnapshot: vi.fn(async () => undefined) },
      createId: createSequentialId('session'),
      dialogs: { chooseProjectRoot: vi.fn(async () => 'C:\\redacted\\Demo.novus-project') },
      knowledgeRefreshService: createKnowledgeRefreshServiceStub(),
      knowledgeStore: {
        activateStagedTransition,
        configure: vi.fn(),
        discardStagedTransition,
        finalizeStagedTransition: vi.fn(),
        listStates: vi.fn(async () => [knowledgeStateAtVersion(1, 1)]),
        readActive: vi.fn(async () => active),
        recordStagedTransitionOutboxIntent: vi.fn(),
        stageApprovedSnapshot: vi.fn(async (_candidate, metadata: { stageId: string }) => ({
          stageId: metadata.stageId,
          snapshot,
        })),
      } as never,
      repository: {
        close: vi.fn(async () => undefined),
        open: vi.fn(async () => createOpenedSession()),
        openJournalWriter: vi.fn(async () => ({ commit })),
        readCurrentProject: vi.fn(async () => persistedProject),
        readCurrentRevision: vi.fn()
          .mockResolvedValueOnce(5)
          .mockResolvedValueOnce(5)
          .mockResolvedValueOnce(5)
          .mockRejectedValueOnce(new Error('transient revision readback failure')),
      },
    });

    await handlers.openProject({}, { mode: 'write' });
    await expect(handlers.reviewSkillCandidate({}, createBoundReviewRequest(pendingCandidate, active))).rejects.toBe(commitError);

    expect(discardStagedTransition).not.toHaveBeenCalled();
    expect(activateStagedTransition).not.toHaveBeenCalled();
  });
  it('preserves a response-lost acknowledged stage through transient readback failure for startup recovery', async () => {
    const active = createKnowledgeSnapshot('# Scene Skill', 1);
    const pendingCandidate = createReadySkillCandidate(active);
    let persistedProject = createProjectWithPendingSkillCandidate(pendingCandidate);
    const snapshot = createKnowledgeSnapshot('# approved version 2', 2);
    let stagedSummary: {
      stageId: string;
      projectId: string;
      candidateId: string;
      transactionId: string;
      knowledgeBaseId: string;
      kind: 'approved_snapshot';
      phase: 'staged';
      expectedActiveVersion: number;
      expectedActiveContentHash: string;
      publicationVersion: number;
      publicationContentHash: string;
    } | null = null;
    const discardStagedTransition = vi.fn(async () => undefined);
    const commitError = new Error('response lost after durable append');
    const commit = vi.fn(async (request: CommitRequest) => {
      const operation = request.transaction.operations.find((item) => item.kind === 'set_skill_candidates');
      if (operation?.kind !== 'set_skill_candidates') throw new Error('missing candidate commit');
      persistedProject = { ...persistedProject, skillPromotionCandidates: [...operation.candidates] };
      throw commitError;
    });
    let readCount = 0;
    const firstHandlers = createDesktopBridgeHandlers({
      approvedSnapshotOutbox: { enqueueApprovedSnapshot: vi.fn(async () => undefined) },
      createId: createSequentialId('session'),
      dialogs: { chooseProjectRoot: vi.fn(async () => 'C:\\redacted\\Demo.novus-project') },
      knowledgeRefreshService: createKnowledgeRefreshServiceStub(),
      knowledgeStore: {
        activateStagedTransition: vi.fn(),
        configure: vi.fn(),
        discardStagedTransition,
        finalizeStagedTransition: vi.fn(),
        listStates: vi.fn(async () => [knowledgeStateAtVersion(1, 1)]),
        readActive: vi.fn(async () => active),
        recordStagedTransitionOutboxIntent: vi.fn(),
        stageApprovedSnapshot: vi.fn(async (_candidate, metadata: {
          stageId: string;
          projectId: string;
          candidateId: string;
          transactionId: string;
          expectedActiveVersion: number;
          expectedActiveContentHash: string;
        }) => {
          stagedSummary = {
            ...metadata,
            knowledgeBaseId: 'scene-skill',
            kind: 'approved_snapshot',
            phase: 'staged',
            publicationVersion: snapshot.version,
            publicationContentHash: snapshot.contentHash,
          };
          return { stageId: metadata.stageId, snapshot };
        }),
      } as never,
      repository: {
        close: vi.fn(async () => undefined),
        open: vi.fn(async () => createOpenedSession()),
        openJournalWriter: vi.fn(async () => ({ commit })),
        readCurrentProject: vi.fn(async () => {
          readCount += 1;
          if (readCount === 4) throw new Error('transient durable readback failure');
          return persistedProject;
        }),
        readCurrentRevision: vi.fn(async () => 5),
      },
    });

    await firstHandlers.openProject({}, { mode: 'write' });
    await expect(firstHandlers.reviewSkillCandidate({}, createBoundReviewRequest(pendingCandidate, active))).rejects.toBe(commitError);
    expect(discardStagedTransition).not.toHaveBeenCalled();
    expect(stagedSummary).not.toBeNull();

    const activateStagedTransition = vi.fn(async () => knowledgeStateAtVersion(2, 2));
    const enqueueApprovedSnapshot = vi.fn(async () => undefined);
    const recordStagedTransitionOutboxIntent = vi.fn(async () => undefined);
    const finalizeStagedTransition = vi.fn(async () => undefined);
    const recoveredHandlers = createDesktopBridgeHandlers({
      approvedSnapshotOutbox: { enqueueApprovedSnapshot },
      createId: createSequentialId('recovered-session'),
      dialogs: { chooseProjectRoot: vi.fn(async () => 'C:\\redacted\\Demo.novus-project') },
      knowledgeRefreshService: createKnowledgeRefreshServiceStub(),
      knowledgeStore: {
        activateStagedTransition,
        configure: vi.fn(),
        discardStagedTransition,
        finalizeStagedTransition,
        listStagedKnowledgeTransitions: vi.fn(async () => [stagedSummary!]),
        listStates: vi.fn(async () => [knowledgeStateAtVersion(2, 2)]),
        readActive: vi.fn(async () => snapshot),
        readVersion: vi.fn(async () => snapshot),
        recordStagedTransitionOutboxIntent,
      } as never,
      repository: {
        close: vi.fn(async () => undefined),
        open: vi.fn(async () => createOpenedSession()),
        openJournalWriter: vi.fn(async () => ({ commit: vi.fn() })),
        readCurrentProject: vi.fn(async () => persistedProject),
        readCurrentRevision: vi.fn(async () => 6),
      },
    });

    await recoveredHandlers.openProject({}, { mode: 'write' });

    expect(activateStagedTransition).toHaveBeenCalledWith(stagedSummary!.stageId);
    expect(enqueueApprovedSnapshot).toHaveBeenCalledWith(snapshot);
    expect(recordStagedTransitionOutboxIntent).toHaveBeenCalledWith(stagedSummary!.stageId);
    expect(finalizeStagedTransition).toHaveBeenCalledWith(stagedSummary!.stageId);
  });
  it('completes an exact durable approval when commit appended but its response was lost', async () => {
    const active = createKnowledgeSnapshot('# Scene Skill', 1);
    const pendingCandidate = createReadySkillCandidate(active);
    let persistedProject = createProjectWithPendingSkillCandidate(pendingCandidate);
    let revision = 5;
    const snapshot = createKnowledgeSnapshot('# approved version 2', 2);
    const activateStagedTransition = vi.fn(async () => knowledgeStateAtVersion(2, 2));
    const enqueueApprovedSnapshot = vi.fn(async () => undefined);
    const recordStagedTransitionOutboxIntent = vi.fn(async () => undefined);
    const finalizeStagedTransition = vi.fn(async () => undefined);
    const discardStagedTransition = vi.fn(async () => undefined);
    const commit = vi.fn(async (request: CommitRequest) => {
      const operation = request.transaction.operations.find((item) => item.kind === 'set_skill_candidates');
      if (operation?.kind !== 'set_skill_candidates') throw new Error('missing candidate commit');
      persistedProject = { ...persistedProject, skillPromotionCandidates: [...operation.candidates] };
      revision = 6;
      throw new Error('injected response lost after append');
    });
    const handlers = createDesktopBridgeHandlers({
      approvedSnapshotOutbox: { enqueueApprovedSnapshot },
      createId: createSequentialId('session'),
      dialogs: { chooseProjectRoot: vi.fn(async () => 'C:\\redacted\\Demo.novus-project') },
      knowledgeRefreshService: createKnowledgeRefreshServiceStub(),
      knowledgeStore: {
        activateStagedTransition,
        configure: vi.fn(),
        discardStagedTransition,
        finalizeStagedTransition,
        listStates: vi.fn(async () => [knowledgeStateAtVersion(1, 1)]),
        readActive: vi.fn(async () => active),
        recordStagedTransitionOutboxIntent,
        stageApprovedSnapshot: vi.fn(async (_candidate, metadata: { stageId: string }) => ({
          stageId: metadata.stageId,
          snapshot,
        })),
      } as never,
      repository: {
        close: vi.fn(async () => undefined),
        open: vi.fn(async () => createOpenedSession()),
        openJournalWriter: vi.fn(async () => ({ commit })),
        readCurrentProject: vi.fn(async () => persistedProject),
        readCurrentRevision: vi.fn(async () => revision),
      },
    });

    await handlers.openProject({}, { mode: 'write' });
    const result = await handlers.reviewSkillCandidate({}, createBoundReviewRequest(pendingCandidate, active));

    expect(result).toMatchObject({ candidate: { reviewStatus: 'approved' }, currentRevision: 6 });
    expect(activateStagedTransition).toHaveBeenCalledOnce();
    expect(enqueueApprovedSnapshot).toHaveBeenCalledWith(snapshot);
    expect(recordStagedTransitionOutboxIntent).toHaveBeenCalledOnce();
    expect(finalizeStagedTransition).toHaveBeenCalledOnce();
    expect(discardStagedTransition).not.toHaveBeenCalled();
  });
  it('allocates approval versions after rollback from every retained version, not only the active snapshot', async () => {
    const active = createKnowledgeSnapshot('# Scene Skill', 1);
    const pendingCandidate = createReadySkillCandidate(active);
    const project = createProjectWithPendingSkillCandidate(pendingCandidate);
    const commit = vi.fn(async () => ({
      committedAt: '2026-07-15T10:00:00.000Z',
      projectId: starterProject.id,
      revision: 6,
      sequence: 6,
      transactionId: 'review-skill-candidate-after-rollback',
    }));
    let publishedSnapshot: KnowledgeSnapshot | null = null;
    const publish = vi.fn(async (snapshot: KnowledgeSnapshot) => {
      publishedSnapshot = snapshot;
    });
    const enqueueApprovedSnapshot = vi.fn(async (_snapshot: KnowledgeSnapshot) => undefined);
    const handlers = createDesktopBridgeHandlers({
      approvedSnapshotOutbox: { enqueueApprovedSnapshot },
      createId: createSequentialId('session'),
      dialogs: {
        chooseProjectRoot: vi.fn(async () => 'C:\\redacted\\Demo.novus-project'),
      },
      knowledgeRefreshService: {
        refreshNow: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        subscribe: vi.fn(),
      },
      knowledgeStore: {
        configure: vi.fn(),
        listStates: vi.fn(async () => [knowledgeStateAtVersion(1, 3)]),
        publish,
        readActive: vi.fn(async () => active),
      } as never,
      repository: {
        close: vi.fn(async () => undefined),
        open: vi.fn(async () => createOpenedSession()),
        openJournalWriter: vi.fn(async () => ({ commit })),
        readCurrentProject: vi.fn(async () => project),
        readCurrentRevision: vi.fn(async () => 5),
      },
    });

    await handlers.openProject({}, { mode: 'write' });
    const result = await handlers.reviewSkillCandidate({}, createBoundReviewRequest(pendingCandidate, active));

    expect(result.candidate).toMatchObject({
      reviewStatus: 'approved',
      publishedKnowledgeVersion: 4,
    });
    expect(publishedSnapshot).toMatchObject({ version: 4 });
    expect(enqueueApprovedSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeBaseId: 'scene-skill',
      version: 4,
    }));
  });

  it('rolls back every approved candidate published above the target through the previous active version', async () => {
    const selected = {
      ...createApprovedSkillCandidate(),
      id: 'candidate-v4-selected',
      sourceProjectMemoryId: 'memory-v4',
      sourceProjectMemoryIds: ['memory-v4'],
      publishedKnowledgeVersion: 4,
    };
    const candidateV3 = {
      ...createApprovedSkillCandidate(),
      id: 'candidate-v3',
      sourceProjectMemoryId: 'memory-v3',
      sourceProjectMemoryIds: ['memory-v3'],
      publishedKnowledgeVersion: 3,
    };
    const candidateV5 = {
      ...createApprovedSkillCandidate(),
      id: 'candidate-v5',
      sourceProjectMemoryId: 'memory-v5',
      sourceProjectMemoryIds: ['memory-v5'],
      publishedKnowledgeVersion: 5,
    };
    const candidateAtTarget = {
      ...createApprovedSkillCandidate(),
      id: 'candidate-v2',
      sourceProjectMemoryId: 'memory-v2',
      sourceProjectMemoryIds: ['memory-v2'],
      publishedKnowledgeVersion: 2,
    };
    const candidateAfterPreviousActive = {
      ...createApprovedSkillCandidate(),
      id: 'candidate-v6',
      sourceProjectMemoryId: 'memory-v6',
      sourceProjectMemoryIds: ['memory-v6'],
      publishedKnowledgeVersion: 6,
    };
    const otherKnowledgeBase = {
      ...createApprovedSkillCandidate(),
      id: 'candidate-other-kb',
      sourceProjectMemoryId: 'memory-other',
      sourceProjectMemoryIds: ['memory-other'],
      targetKnowledgeBaseId: 'other-skill',
      publishedKnowledgeVersion: 4,
    };
    const rejectedCandidate = {
      ...createApprovedSkillCandidate(),
      id: 'candidate-rejected',
      sourceProjectMemoryId: 'memory-rejected',
      sourceProjectMemoryIds: ['memory-rejected'],
      reviewStatus: 'rejected' as const,
      publishedKnowledgeVersion: undefined,
    };
    const feedbackHistory = [
      'memory-v2',
      'memory-v3',
      'memory-v4',
      'memory-v5',
      'memory-v6',
      'memory-other',
      'memory-rejected',
    ].map((memoryId, index) => createBridgeFeedbackMemory(memoryId, index + 1));
    const project: CanvasProject = {
      ...starterProject,
      projectMemory: feedbackHistory,
      skillPromotionCandidates: [
        candidateAtTarget,
        candidateV3,
        selected,
        candidateV5,
        candidateAfterPreviousActive,
        otherKnowledgeBase,
        rejectedCandidate,
      ],
    };
    const beforeRollback = knowledgeStateAtVersion(5, 6);
    const afterRollback = {
      ...knowledgeStateAtVersion(2, 6),
      status: 'rolled_back' as const,
      lastRollbackAt: '2026-07-15T10:00:00.000Z',
    };
    let persistedProject = project;
    const commit = vi.fn(async (request: CommitRequest) => {
      persistedProject = applyProjectTransaction(persistedProject, request.transaction);
      return {
        committedAt: '2026-07-15T10:00:00.000Z',
        projectId: starterProject.id,
        revision: 6,
        sequence: 6,
        transactionId: 'review-skill-candidate-range',
      };
    });
    const listStates = vi.fn()
      .mockResolvedValueOnce([beforeRollback])
      .mockResolvedValue([afterRollback]);
    const rollback = vi.fn(async () => afterRollback);
    const handlers = createDesktopBridgeHandlers({
      createId: createSequentialId('session'),
      dialogs: {
        chooseProjectRoot: vi.fn(async () => 'C:\\redacted\\Demo.novus-project'),
      },
      knowledgeRefreshService: {
        refreshNow: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        subscribe: vi.fn(),
      },
      knowledgeStore: {
        configure: vi.fn(),
        listStates,
        readActive: vi.fn(async () => null),
        rollback,
      } as never,
      repository: {
        close: vi.fn(async () => undefined),
        open: vi.fn(async () => createOpenedSession()),
        openJournalWriter: vi.fn(async () => ({ commit })),
        readCurrentProject: vi.fn(async () => project),
        readCurrentRevision: vi.fn(async () => 5),
      },
    });

    await handlers.openProject({}, { mode: 'write' });
    const result = await handlers.reviewSkillCandidate({}, {
      candidateId: selected.id,
      decision: 'rolled_back',
      projectId: starterProject.id,
      targetVersion: 2,
    });

    expect(rollback).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledWith('scene-skill', 2);
    expect(commit).toHaveBeenCalledOnce();
    const transaction = commit.mock.calls[0]![0].transaction;
    expect(transaction.operations).toHaveLength(1);
    const operation = transaction.operations[0];
    expect(operation).toMatchObject({ kind: 'set_skill_candidates' });
    if (operation?.kind !== 'set_skill_candidates') {
      throw new Error('Expected one set_skill_candidates rollback operation');
    }
    const persisted = operation.candidates;
    expect(persisted.filter((candidate) => candidate.reviewStatus === 'rolled_back').map((candidate) => candidate.id).sort()).toEqual([
      'candidate-v3',
      'candidate-v4-selected',
      'candidate-v5',
    ]);
    expect(persisted.find((candidate) => candidate.id === candidateAtTarget.id)?.reviewStatus).toBe('approved');
    expect(persisted.find((candidate) => candidate.id === candidateAfterPreviousActive.id)?.reviewStatus).toBe('approved');
    expect(persisted.find((candidate) => candidate.id === otherKnowledgeBase.id)?.reviewStatus).toBe('approved');
    expect(persisted.find((candidate) => candidate.id === rejectedCandidate.id)?.reviewStatus).toBe('rejected');
    expect(persistedProject.projectMemory).toEqual(feedbackHistory);
    expect(result).toMatchObject({
      candidate: { id: selected.id, reviewStatus: 'rolled_back' },
      knowledgeState: { activeVersion: 2, status: 'rolled_back' },
    });
    expect(result.candidates?.filter((candidate) => candidate.reviewStatus === 'rolled_back').map((candidate) => candidate.id).sort()).toEqual([
      'candidate-v3',
      'candidate-v4-selected',
      'candidate-v5',
    ]);
  });
  it('rejects rollback without a valid older target before mutating project or knowledge state', async () => {
    const approvedCandidate = createApprovedSkillCandidate();
    const commit = vi.fn();
    const rollback = vi.fn();
    const handlers = createDesktopBridgeHandlers({
      createId: createSequentialId('session'),
      dialogs: {
        chooseProjectRoot: vi.fn(async () => 'C:\\redacted\\Demo.novus-project'),
      },
      knowledgeRefreshService: {
        refreshNow: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        subscribe: vi.fn(),
      },
      knowledgeStore: {
        configure: vi.fn(),
        listStates: vi.fn(async () => [createKnowledgeStateSummary()]),
        readActive: vi.fn(async () => null),
        rollback,
      } as never,
      repository: {
        close: vi.fn(async () => undefined),
        open: vi.fn(async () => createOpenedSession()),
        openJournalWriter: vi.fn(async () => ({ commit })),
        readCurrentProject: vi.fn(async () => ({
          ...starterProject,
          skillPromotionCandidates: [approvedCandidate],
        })),
        readCurrentRevision: vi.fn(async () => 5),
      },
    });

    await handlers.openProject({}, { mode: 'write' });

    await expect(handlers.reviewSkillCandidate({}, {
      candidateId: approvedCandidate.id,
      decision: 'rolled_back',
      projectId: starterProject.id,
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(handlers.reviewSkillCandidate({}, {
      candidateId: approvedCandidate.id,
      decision: 'rolled_back',
      projectId: starterProject.id,
      targetVersion: 3,
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(rollback).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('discards an unacknowledged staged transition instead of authorizing by candidate id', async () => {
    const pendingCandidate = createPendingSkillCandidate();
    const activateStagedTransition = vi.fn();
    const discardStagedTransition = vi.fn(async () => undefined);
    const handlers = createDesktopBridgeHandlers({
      createId: createSequentialId('session'),
      dialogs: { chooseProjectRoot: vi.fn(async () => 'C:\\redacted\\Demo.novus-project') },
      knowledgeRefreshService: createKnowledgeRefreshServiceStub(),
      knowledgeStore: {
        activateStagedTransition,
        configure: vi.fn(),
        discardStagedTransition,
        listStagedKnowledgeTransitions: vi.fn(async () => [{
          stageId: 'stage-unacknowledged',
          projectId: starterProject.id,
          candidateId: pendingCandidate.id,
          transactionId: 'review-transaction-old',
          knowledgeBaseId: 'scene-skill',
          kind: 'approved_snapshot',
          phase: 'staged',
          expectedActiveVersion: 1,
          expectedActiveContentHash: 'a'.repeat(64),
          publicationVersion: 2,
          publicationContentHash: 'b'.repeat(64),
        }]),
        listStates: vi.fn(async () => []),
        readActive: vi.fn(async () => null),
      } as never,
      repository: {
        close: vi.fn(async () => undefined),
        open: vi.fn(async () => createOpenedSession()),
        openJournalWriter: vi.fn(async () => ({ commit: vi.fn() })),
        readCurrentProject: vi.fn(async () => createProjectWithPendingSkillCandidate(pendingCandidate)),
      },
    });

    await handlers.openProject({}, { mode: 'write' });

    expect(activateStagedTransition).not.toHaveBeenCalled();
    expect(discardStagedTransition).toHaveBeenCalledWith(
      'stage-unacknowledged',
      'unacknowledged_project_transaction',
    );
  });

  it('does not let a later review transaction with the same candidate id authorize an older stage', async () => {
    const candidate = {
      ...createApprovedSkillCandidate(),
      reviewTransactionId: 'review-transaction-new',
    } as SkillPromotionCandidate;
    const activateStagedTransition = vi.fn();
    const discardStagedTransition = vi.fn(async () => undefined);
    const handlers = createDesktopBridgeHandlers({
      createId: createSequentialId('session'),
      dialogs: { chooseProjectRoot: vi.fn(async () => 'C:\\redacted\\Demo.novus-project') },
      knowledgeRefreshService: createKnowledgeRefreshServiceStub(),
      knowledgeStore: {
        activateStagedTransition,
        configure: vi.fn(),
        discardStagedTransition,
        listStagedKnowledgeTransitions: vi.fn(async () => [{
          stageId: 'stage-old-review',
          projectId: starterProject.id,
          candidateId: candidate.id,
          transactionId: 'review-transaction-old',
          knowledgeBaseId: 'scene-skill',
          kind: 'approved_snapshot',
          phase: 'staged',
          expectedActiveVersion: 2,
          expectedActiveContentHash: 'b'.repeat(64),
          publicationVersion: 3,
          publicationContentHash: 'c'.repeat(64),
        }]),
        listStates: vi.fn(async () => []),
        readActive: vi.fn(async () => null),
      } as never,
      repository: {
        close: vi.fn(async () => undefined),
        open: vi.fn(async () => createOpenedSession()),
        openJournalWriter: vi.fn(async () => ({ commit: vi.fn() })),
        readCurrentProject: vi.fn(async () => ({
          ...starterProject,
          skillPromotionCandidates: [candidate],
        })),
      },
    });

    await handlers.openProject({}, { mode: 'write' });

    expect(activateStagedTransition).not.toHaveBeenCalled();
    expect(discardStagedTransition).toHaveBeenCalledWith(
      'stage-old-review',
      'superseded_project_transaction',
    );
  });

  it('recovers an exact acknowledged approval after activation crashes before outbox enqueue', async () => {
    const snapshot = createKnowledgeSnapshot('# approved version 2', 2);
    const candidate = {
      ...createApprovedSkillCandidate(),
      publishedKnowledgeVersion: 2,
      reviewTransactionId: 'review-transaction-exact',
    } as SkillPromotionCandidate;
    const activateStagedTransition = vi.fn(async () => knowledgeStateAtVersion(2, 2));
    const enqueueApprovedSnapshot = vi.fn()
      .mockRejectedValueOnce(new Error('injected crash after activation before outbox enqueue'))
      .mockResolvedValueOnce(undefined);
    const finalizeStagedTransition = vi.fn(async () => undefined);
    const recordStagedTransitionOutboxIntent = vi.fn(async () => undefined);
    const handlers = createDesktopBridgeHandlers({
      approvedSnapshotOutbox: { enqueueApprovedSnapshot },
      createId: createSequentialId('session'),
      dialogs: { chooseProjectRoot: vi.fn(async () => 'C:\\redacted\\Demo.novus-project') },
      knowledgeRefreshService: createKnowledgeRefreshServiceStub(),
      knowledgeStore: {
        activateStagedTransition,
        configure: vi.fn(),
        discardStagedTransition: vi.fn(),
        finalizeStagedTransition,
        listStagedKnowledgeTransitions: vi.fn(async () => [{
          stageId: 'stage-exact-review',
          projectId: starterProject.id,
          candidateId: candidate.id,
          transactionId: 'review-transaction-exact',
          knowledgeBaseId: 'scene-skill',
          kind: 'approved_snapshot',
          phase: 'activated',
          expectedActiveVersion: 1,
          expectedActiveContentHash: 'a'.repeat(64),
          publicationVersion: 2,
          publicationContentHash: snapshot.contentHash,
        }]),
        listStates: vi.fn(async () => [knowledgeStateAtVersion(2, 2)]),
        readActive: vi.fn(async () => snapshot),
        readVersion: vi.fn(async () => snapshot),
        recordStagedTransitionOutboxIntent,
      } as never,
      repository: {
        close: vi.fn(async () => undefined),
        open: vi.fn(async () => createOpenedSession()),
        openJournalWriter: vi.fn(async () => ({ commit: vi.fn() })),
        readCurrentProject: vi.fn(async () => ({
          ...starterProject,
          skillPromotionCandidates: [candidate],
        })),
      },
    });

    await handlers.openProject({}, { mode: 'write' });

    expect(activateStagedTransition).toHaveBeenCalledTimes(1);
    expect(enqueueApprovedSnapshot).toHaveBeenCalledTimes(1);
    expect(recordStagedTransitionOutboxIntent).not.toHaveBeenCalled();
    expect(finalizeStagedTransition).not.toHaveBeenCalled();

    await handlers.openProject({}, { mode: 'write' });

    expect(activateStagedTransition).toHaveBeenCalledTimes(2);
    expect(enqueueApprovedSnapshot).toHaveBeenCalledTimes(2);
    expect(enqueueApprovedSnapshot).toHaveBeenLastCalledWith(snapshot);
    expect(recordStagedTransitionOutboxIntent).toHaveBeenCalledWith('stage-exact-review');
    expect(finalizeStagedTransition).toHaveBeenCalledWith('stage-exact-review');
    expect(enqueueApprovedSnapshot.mock.invocationCallOrder[1]).toBeLessThan(finalizeStagedTransition.mock.invocationCallOrder[0]!);
  });
  it('registers managed knowledge invoke channels', () => {
    const channels: string[] = [];
    const ipcMain = {
      handle: vi.fn((channel: string) => {
        channels.push(channel);
      }),
    };
    const handlers = createDesktopBridgeHandlers({
      repository: {
        close: vi.fn(async () => undefined),
      },
    });

    registerDesktopBridgeHandlers(ipcMain, handlers);

    expect(channels).toEqual(expect.arrayContaining([
      BRIDGE_CHANNELS.configureKnowledgeBase,
      BRIDGE_CHANNELS.getKnowledgeState,
      BRIDGE_CHANNELS.prepareSkillCandidateReview,
      BRIDGE_CHANNELS.reviewSkillCandidate,
    ]));
  });

  it('returns the active journal head revision when reopening newer-than-stable projects', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'novus-bridge-head-'));
    const projectRoot = join(tempRoot, 'HeadRevision.novus-project');
    const repository = new ProjectRepository({
      createId: createSequentialId('head'),
      now: () => new Date('2026-07-14T00:00:00.000Z'),
      processId: 5521,
    });
    const created = await repository.create(projectRoot, {
      project: starterProject,
      projectId: starterProject.id,
      projectName: starterProject.name,
    });
    const writer = await repository.openJournalWriter(created);
    await writer.commit(makeCreatePromptRequest(starterProject.id, 'tx-active-head', 0, 'prompt-active-head'));
    releaseJournalState(join(projectRoot, 'journal', 'active.ndjson'), starterProject.id);
    await rm(join(projectRoot, 'recovery', 'project.lock'), { force: true });

    const handlers = createDesktopBridgeHandlers({
      dialogs: {
        chooseProjectRoot: vi.fn(async () => projectRoot),
      },
    });

    try {
      const opened = await handlers.openProject({}, { mode: 'write' });

      expect(opened).toMatchObject({
        currentRevision: 1,
        stableSnapshotRevision: 0,
      });
      await expect(handlers.commit({}, {
        ...makeCreatePromptRequest(starterProject.id, 'tx-after-reopen', opened!.currentRevision, 'prompt-after-reopen'),
        sessionId: opened!.sessionId,
      })).resolves.toMatchObject({ revision: 2, sequence: 2 });
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it('runs snapshot scheduling after agent commits', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'novus-bridge-schedule-'));
    const projectRoot = join(tempRoot, 'Scheduled.novus-project');
    await mkdir(join(projectRoot, 'journal'), { recursive: true });
    const session = createOpenedSession(projectRoot);
    await writeFile(join(projectRoot, 'journal', 'active.ndjson'), '', 'utf8');
    await writeFile(join(projectRoot, 'project.novus.json'), `${JSON.stringify(session.manifest)}\n`, 'utf8');
    const commit = vi.fn(async () => ({
      committedAt: '2026-07-14T00:00:00.000Z',
      projectId: starterProject.id,
      revision: 3,
      sequence: 3,
      transactionId: 'tx-agent-scheduled',
    }));
    const consider = vi.fn(() => ({ reason: 'agent_transaction' as const }));
    const flush = vi.fn(async () => ({
      path: 'snapshots/s-3-agent.json.gz',
      reason: 'agent_transaction' as const,
      revision: 3,
      snapshotId: 's-3-agent',
    }));
    const handlers = createDesktopBridgeHandlers({
      dialogs: {
        chooseProjectRoot: vi.fn(async () => projectRoot),
      },
      repository: {
        close: vi.fn(async () => undefined),
        open: vi.fn(async () => session),
        openJournalWriter: vi.fn(async () => ({ commit })),
        readCurrentProject: vi.fn(async () => starterProject),
      },
      snapshotScheduler: { consider, flush } as unknown as SnapshotScheduler,
    });

    try {
      const opened = await handlers.openProject({}, { mode: 'write' });
      await handlers.commit({}, {
        ...makeCreatePromptRequest(starterProject.id, 'tx-agent-scheduled', 2, 'prompt-agent-scheduled'),
        kind: 'agent',
        sessionId: opened!.sessionId,
      });

      expect(consider).toHaveBeenCalledWith(
        expect.objectContaining({ root: session.root }),
        expect.objectContaining({
          lastTransactionKind: 'agent',
          pendingChanges: true,
          transactionCount: 1,
        }),
      );
      expect(flush).toHaveBeenCalledWith(expect.objectContaining({ root: session.root }), { reason: 'agent_transaction' });
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it('flushes a dirty write session on close before marking clean and removing the lock', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'novus-bridge-close-'));
    const projectRoot = join(tempRoot, 'CloseFlush.novus-project');
    const fileSystem = new NodeFileSystem();
    const repository = new ProjectRepository({
      createId: createSequentialId('close'),
      fileSystem,
      now: () => new Date('2026-07-14T00:00:00.000Z'),
      processId: 6521,
    });
    const initial = await repository.create(projectRoot, {
      project: starterProject,
      projectId: starterProject.id,
      projectName: starterProject.name,
    });
    await repository.close(initial);

    const handlers = createDesktopBridgeHandlers({
      dialogs: {
        chooseProjectRoot: vi.fn(async () => projectRoot),
      },
      fileSystem,
      repository: {
        close: (session) => repository.close(session),
        open: (root, options) => repository.open(root, options),
        openJournalWriter: (session) => repository.openJournalWriter(session),
        readCurrentProject: (session) => repository.readCurrentProject(session),
      },
      snapshotScheduler: new SnapshotScheduler({
        fileSystem,
        worker: (input) => SnapshotScheduler.defaultWorker(input),
      }),
    });

    try {
      const opened = await handlers.openProject({}, { mode: 'write' });
      await handlers.commit({}, {
        ...makeCreatePromptRequest(starterProject.id, 'tx-close-flush', opened!.currentRevision, 'prompt-close-flush'),
        sessionId: opened!.sessionId,
      });
      await handlers.closeProject({}, { sessionId: opened!.sessionId });

      const manifest = JSON.parse(await readFile(join(projectRoot, 'project.novus.json'), 'utf8')) as {
        cleanClose: boolean;
        stableSnapshotPath: string;
        stableSnapshotRevision: number;
      };
      const cleanClose = JSON.parse(await readFile(join(projectRoot, 'recovery', 'clean-close.json'), 'utf8')) as {
        clean: boolean;
      };

      expect(manifest).toMatchObject({
        cleanClose: true,
        stableSnapshotRevision: 1,
      });
      expect(manifest.stableSnapshotPath).toMatch(/^snapshots\/s-1-[a-f0-9]{8}\.json\.gz$/);
      expect(cleanClose.clean).toBe(true);
      expect(await readFile(join(projectRoot, 'journal', 'active.ndjson'), 'utf8')).toBe('');
      await expect(access(join(projectRoot, 'recovery', 'project.lock'))).rejects.toThrow();
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it('closes all active bridge sessions for main-process shutdown', async () => {
    const close = vi.fn(async () => undefined);
    const handlers = createDesktopBridgeHandlers({
      createId: createSequentialId('session'),
      dialogs: {
        chooseProjectRoot: vi.fn()
          .mockResolvedValueOnce('C:\\redacted\\One.novus-project')
          .mockResolvedValueOnce('C:\\redacted\\Two.novus-project'),
      },
      repository: {
        close,
        open: vi.fn()
          .mockResolvedValueOnce(createOpenedSession('C:\\redacted\\One.novus-project'))
          .mockResolvedValueOnce(createOpenedSession('C:\\redacted\\Two.novus-project')),
        openJournalWriter: vi.fn(async () => ({ commit: vi.fn() })),
        readCurrentProject: vi.fn(async () => starterProject),
      },
      snapshotScheduler: {
        consider: vi.fn(() => null),
        flush: vi.fn(),
      } as unknown as SnapshotScheduler,
    });

    const first = await handlers.openProject({}, { mode: 'write' });
    const second = await handlers.openProject({}, { mode: 'write' });
    await handlers.closeAllProjects();

    expect(close).toHaveBeenCalledTimes(2);
    await expect(handlers.closeProject({}, { sessionId: first!.sessionId })).rejects.toMatchObject({ code: 'INVALID_SESSION' });
    await expect(handlers.closeProject({}, { sessionId: second!.sessionId })).rejects.toMatchObject({ code: 'INVALID_SESSION' });
  });

  it('releases an acquired write session when open initialization fails before registration', async () => {
    const projectRoot = ['C:', 'redacted', 'OpenFailure.novus-project'].join(String.fromCharCode(92));
    const opened = createOpenedSession(projectRoot);
    const close = vi.fn(async () => undefined);
    const handlers = createDesktopBridgeHandlers({
      dialogs: { chooseProjectRoot: vi.fn(async () => opened.root) },
      repository: {
        close,
        open: vi.fn(async () => opened),
        openJournalWriter: vi.fn(async () => ({ commit: vi.fn() })),
        readCurrentProject: vi.fn(async () => { throw new Error('summary unavailable'); }),
      },
      snapshotScheduler: {
        consider: vi.fn(() => null),
        flush: vi.fn(),
      } as unknown as SnapshotScheduler,
    });

    await expect(handlers.openProject({}, { mode: 'write' })).rejects.toThrow(/summary unavailable/i);
    expect(close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith(opened);
  });

  it('opens a corrupt stable snapshot as an explicit recovery preview with valid candidates', async () => {
    const projectRoot = ['C:', 'redacted', 'CorruptRecovery.novus-project'].join(String.fromCharCode(92));
    const candidatePath = ['C:', 'redacted', 'candidate.json'].join(String.fromCharCode(92));
    const opened = createOpenedSession(projectRoot);
    const recoveredProject = { ...starterProject, name: 'Recovered preview' };
    const close = vi.fn(async () => undefined);
    const corruptError = Object.assign(new Error('Stable snapshot is corrupt'), {
      code: 'CORRUPT_SNAPSHOT',
      retryable: false,
    });
    const scan = vi.fn(async () => ({
      action: 'choose_recovery' as const,
      candidates: [{
        path: candidatePath,
        project: recoveredProject,
        revision: 3,
        snapshotId: 'snapshot-recovered',
        tailStatus: 'complete' as const,
      }],
      issues: ['corrupt_snapshot'],
      projectId: starterProject.id,
      recoveredRevision: 3,
      stableSnapshotId: 'snapshot-recovered',
      targetRevision: 3,
    }));
    const handlers = createDesktopBridgeHandlers({
      createId: createSequentialId('session'),
      dialogs: { chooseProjectRoot: vi.fn(async () => opened.root) },
      recoveryScanner: { scan },
      repository: {
        close,
        open: vi.fn(async () => opened),
        openJournalWriter: vi.fn(async () => ({ commit: vi.fn() })),
        readCurrentProject: vi.fn(async () => { throw corruptError; }),
      },
      snapshotScheduler: {
        consider: vi.fn(() => null),
        flush: vi.fn(),
      } as unknown as SnapshotScheduler,
    });

    const result = await handlers.openProject({}, { mode: 'write' });
    expect(result).toMatchObject({
      currentRevision: 3,
      project: recoveredProject,
      recoveryRequired: true,
      stableSnapshotId: 'snapshot-recovered',
      stableSnapshotRevision: 3,
    });
    const plan = await handlers.getRecoveryPlan({}, { sessionId: result!.sessionId });
    expect(plan).toMatchObject({ action: 'choose_recovery', recoveredRevision: 3 });
    expect(plan.candidates).toHaveLength(1);

    await handlers.closeAllProjects();
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps opaque recovery candidate ids stable through one restore and rejects replay, foreign, stale, and invalid candidates', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'novus-bridge-'));
    const projectRoot = join(tempRoot, 'Demo.novus-project');
    await mkdir(join(projectRoot, 'snapshots'), { recursive: true });
    await mkdir(join(projectRoot, 'journal'), { recursive: true });
    const session = createOpenedSession(projectRoot);
    const restoredProject = { ...starterProject, name: 'Restored Project' };
    const candidatePath = join(tempRoot, 'candidate.json');
    const invalidCandidatePath = join(tempRoot, 'invalid-candidate.json');
    await writeFile(join(projectRoot, 'project.novus.json'), `${JSON.stringify(session.manifest)}\n`, 'utf8');
    await writeFile(candidatePath, JSON.stringify({
      project: restoredProject,
      projectId: starterProject.id,
      revision: 3,
      snapshotId: 'snapshot-after',
    }), 'utf8');
    await writeFile(invalidCandidatePath, JSON.stringify({
      project: { ...restoredProject, nodes: [{ id: 'broken', type: 'reference' }] },
      projectId: starterProject.id,
      revision: 4,
      snapshotId: 'snapshot-invalid',
    }), 'utf8');
    const createId = vi.fn()
      .mockReturnValueOnce('session-opaque')
      .mockReturnValueOnce('candidate-valid-first')
      .mockReturnValueOnce('candidate-invalid-first')
      .mockReturnValueOnce('restore-internal-id')
      .mockReturnValueOnce('candidate-valid-second')
      .mockReturnValueOnce('candidate-invalid-second');
    const handlers = createDesktopBridgeHandlers({
      appDataRoot: 'C:\\redacted\\AppData',
      createId,
      dialogs: {
        chooseProjectRoot: vi.fn(async () => projectRoot),
      },
      recoveryScanner: {
        scan: vi.fn(async () => ({
          action: 'choose_recovery' as const,
          candidates: [
            {
              path: candidatePath,
              project: restoredProject,
              projectId: starterProject.id,
              revision: 3,
              snapshotId: 'snapshot-after',
              tailStatus: 'complete' as const,
            },
            {
              path: invalidCandidatePath,
              project: { ...restoredProject, nodes: [{ id: 'broken', type: 'reference' }] } as unknown as CanvasProject,
              projectId: starterProject.id,
              revision: 4,
              snapshotId: 'snapshot-invalid',
              tailStatus: 'complete' as const,
            },
          ],
          issues: [],
          projectId: starterProject.id,
          recoveredRevision: null,
          stableSnapshotId: 'stable-before',
          targetRevision: 3,
        })),
      },
      repository: {
        close: vi.fn(async () => undefined),
        open: vi.fn(async () => session),
        openJournalWriter: vi.fn(async () => ({
          commit: vi.fn(),
        })),
        readCurrentProject: vi.fn()
          .mockResolvedValueOnce(starterProject)
          .mockResolvedValueOnce(restoredProject),
      },
    });

    try {
      const opened = await handlers.openProject({}, { mode: 'write' });
      const firstPlan = await handlers.getRecoveryPlan({}, { sessionId: opened!.sessionId });
      expect(firstPlan.candidates.map((candidate) => candidate.candidateId)).toEqual([
        'candidate-valid-first',
        'candidate-invalid-first',
      ]);
      await expect(handlers.restore({}, { candidateId: 'candidate-foreign', sessionId: opened!.sessionId })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      await expect(handlers.restore({}, { candidateId: 'candidate-valid-first', sessionId: opened!.sessionId })).resolves.toMatchObject({
        project: restoredProject,
        restoredRevision: 3,
      });
      await expect(handlers.restore({}, { candidateId: 'candidate-valid-first', sessionId: opened!.sessionId })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

      const secondPlan = await handlers.getRecoveryPlan({}, { sessionId: opened!.sessionId });
      expect(secondPlan.candidates.map((candidate) => candidate.candidateId)).toEqual([
        'candidate-valid-second',
        'candidate-invalid-second',
      ]);
      await expect(handlers.restore({}, { candidateId: 'candidate-invalid-first', sessionId: opened!.sessionId })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      await expect(handlers.restore({}, { candidateId: 'candidate-invalid-second', sessionId: opened!.sessionId })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

function createOpenedSession(root = 'C:\\redacted\\Demo.novus-project'): OpenedProjectSession {
  return {
    lock: {
      channel: 'modern',
      deviceId: 'device-1',
      heartbeatAt: '2026-07-14T00:00:00.000Z',
      openedAt: '2026-07-14T00:00:00.000Z',
      processId: 1,
      projectId: 'project-1',
      schemaVersion: 1,
      sessionId: 'lock-session',
    },
    manifest: {
      activeJournalSegment: 'journal/active.ndjson',
      assetInventory: { assetCount: 0, totalBytes: 0 },
      cleanClose: false,
      formatVersion: 1,
      minimumCompatibleWriterVersion: 1,
      nextSequence: 3,
      projectId: 'project-1',
      projectName: 'Bridge Project',
      stableSnapshotId: 'stable-2',
      stableSnapshotPath: 'snapshots/stable-2.json',
      stableSnapshotRevision: 2,
    },
    mode: 'write',
    root,
  };
}

function createKnowledgeStateSummary(): KnowledgeBaseStateSummary {
  return {
    schemaVersion: 1,
    knowledgeBaseId: 'scene-skill',
    displayName: 'Scene Skill',
    status: 'active',
    activeVersion: 1,
    activeContentHash: 'a'.repeat(64),
    versionCount: 1,
    versions: [{
      version: 1,
      contentHash: 'a'.repeat(64),
      publishedAt: '2026-07-15T00:00:00.000Z',
      sourceDeviceId: 'desktop-core',
      displayName: 'Scene Skill',
    }],
    lastFailure: null,
    lastRollbackAt: null,
  };
}

function createBridgeFeedbackMemory(memoryId: string, projectRevision: number) {
  const createdAt = `2026-07-15T08:0${projectRevision}:00.000Z`;
  const knowledgeLease = createAgentKnowledgeLease({
    runId: `run-${memoryId}`,
    capability: 'reverse_prompt',
    snapshots: [],
    references: [],
    citations: [],
  }, {
    leaseId: `lease-${memoryId}`,
    createdAt,
  });
  return createUserFeedbackMemory({
    projectId: 'project-1',
    projectRevision,
    title: `Feedback ${memoryId}`,
    userRequest: 'Keep the product stable',
    correction: 'Use the reviewed scene rule',
    knowledgeLease,
    references: [],
    citations: [],
    feedback: { keep: ['product'], change: ['scene'], never: [] },
  }, {
    memoryId,
    createdAt,
    snapshots: {
      beforeId: `${memoryId}-before`,
      afterId: `${memoryId}-after`,
    },
  });
}
function knowledgeStateAtVersion(activeVersion: number, versionCount: number): KnowledgeBaseStateSummary {
  return {
    ...createKnowledgeStateSummary(),
    activeVersion,
    activeContentHash: String.fromCharCode(96 + activeVersion).repeat(64),
    versionCount,
    versions: Array.from({ length: versionCount }, (_, index) => ({
      version: index + 1,
      contentHash: String.fromCharCode(97 + index).repeat(64),
      publishedAt: `2026-07-15T0${index}:00:00.000Z`,
      sourceDeviceId: 'desktop-core',
      displayName: 'Scene Skill',
    })),
  };
}
function rolledBackKnowledgeState(): KnowledgeBaseStateSummary {
  return {
    ...createKnowledgeStateSummary(),
    status: 'rolled_back',
    activeVersion: 2,
    activeContentHash: 'b'.repeat(64),
    versionCount: 3,
    versions: [
      { version: 1, contentHash: 'a'.repeat(64), publishedAt: '2026-07-15T00:00:00.000Z', sourceDeviceId: 'desktop-core', displayName: 'Scene Skill' },
      { version: 2, contentHash: 'b'.repeat(64), publishedAt: '2026-07-15T01:00:00.000Z', sourceDeviceId: 'desktop-core', displayName: 'Scene Skill' },
      { version: 3, contentHash: 'c'.repeat(64), publishedAt: '2026-07-15T02:00:00.000Z', sourceDeviceId: 'desktop-core', displayName: 'Scene Skill' },
    ],
    lastRollbackAt: '2026-07-15T10:00:00.000Z',
  };
}

function createKnowledgeRefreshServiceStub() {
  return {
    refreshNow: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    subscribe: vi.fn(),
  };
}
function createApprovedSkillCandidate() {
  return {
    schemaVersion: 1 as const,
    id: 'candidate-approved',
    sourceProjectId: 'project-1',
    sourceProjectMemoryId: 'memory-feedback',
    sourceProjectMemoryIds: ['memory-feedback'],
    createdAt: '2026-07-15T08:00:00.000Z',
    title: 'Liquid restraint',
    rationale: 'Feedback asks for calmer liquid.',
    rule: 'Use slower, heavier liquid arcs.',
    targetKnowledgeBaseId: 'scene-skill',
    targetKnowledgeSection: 'reverse-prompt/liquid',
    counts: { supportingMemoryCount: 1 },
    confidence: 0.9,
    affectedCapabilities: ['reverse_prompt' as const],
    evidence: { keep: ['product'], change: ['liquid'], never: [] },
    reviewStatus: 'approved' as const,
    reviewedAt: '2026-07-15T09:00:00.000Z',
    publishedKnowledgeVersion: 3,
  };
}

function createPendingSkillCandidate(): SkillPromotionCandidate {
  return {
    schemaVersion: 1,
    id: 'candidate-pending',
    sourceProjectId: 'project-1',
    sourceProjectMemoryId: 'memory-feedback',
    sourceProjectMemoryIds: ['memory-feedback'],
    createdAt: '2026-07-15T08:00:00.000Z',
    title: 'Liquid restraint',
    rationale: 'Feedback asks for calmer liquid.',
    rule: 'Use slower, heavier liquid arcs.',
    targetKnowledgeBaseId: 'scene-skill',
    targetKnowledgeSection: 'reverse-prompt/liquid',
    counts: { supportingMemoryCount: 1 },
    confidence: 0.9,
    affectedCapabilities: ['reverse_prompt'],
    evidence: { keep: ['product'], change: ['liquid'], never: [] },
    reviewStatus: 'pending_review',
  };
}

function createReadySkillCandidate(snapshot: KnowledgeSnapshot): SkillPromotionCandidate {
  return {
    ...createPendingSkillCandidate(),
    sourceRule: 'Source memory rule body: keep the product logo locked before changing props.',
    managedRule: 'Managed rule body: keep the existing cool background lighting.',
    diffHunks: [
      '- Managed rule body: keep the existing cool background lighting.',
      '+ Use slower, heavier liquid arcs.',
    ],
    reviewPreparationStatus: 'ready',
    reviewPreparationStartedAt: '2026-07-16T05:00:00.000Z',
    preparedManagedSnapshot: {
      knowledgeBaseId: snapshot.knowledgeBaseId,
      version: snapshot.version,
      contentHash: snapshot.contentHash,
    },
  } as SkillPromotionCandidate;
}

function createBoundReviewRequest(
  candidate: SkillPromotionCandidate,
  snapshot: KnowledgeSnapshot,
  overrides: Partial<{
    decision: 'approved' | 'rejected' | 'superseded';
    baseRevision: number;
  }> = {},
) {
  return {
    baseRevision: overrides.baseRevision ?? 5,
    candidateId: candidate.id,
    candidateFingerprint: createSkillPromotionCandidateFingerprint(candidate),
    decision: overrides.decision ?? 'approved',
    preparedManagedSnapshot: {
      knowledgeBaseId: snapshot.knowledgeBaseId,
      version: snapshot.version,
      contentHash: snapshot.contentHash,
    },
    projectId: 'project-1',
  };
}

function createProjectWithPendingSkillCandidate(candidate = createPendingSkillCandidate()): CanvasProject {
  return {
    ...{
      version: 1,
      id: 'project-1',
      name: 'Bridge Project',
      nodes: [],
      edges: [],
      projectMemory: [],
      skillPromotionCandidates: [],
    },
    projectMemory: [createBridgeFeedbackMemory(candidate.sourceProjectMemoryId, 1)],
    skillPromotionCandidates: [candidate],
  };
}

function createKnowledgeSnapshot(content: string, version: number): KnowledgeSnapshot {
  const candidate = createKnowledgeSnapshotCandidate({
    knowledgeBaseId: 'scene-skill',
    displayName: 'Scene Skill',
    documents: [{ relativePath: 'memory/main.md', content }],
  });
  return {
    ...candidate,
    version,
    publishedAt: `2026-07-15T0${version}:00:00.000Z`,
    sourceDeviceId: 'desktop-core',
  };
}

function createSequentialId(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

function makeCreatePromptRequest(
  projectId: string,
  transactionId: string,
  baseRevision: number,
  nodeId: string,
): CommitRequest {
  return {
    baseRevision,
    kind: 'canvas',
    projectId,
    transaction: {
      id: transactionId,
      label: `create ${nodeId}`,
      operations: [{
        kind: 'canvas',
        operation: {
          kind: 'create_node',
          node: {
            id: nodeId,
            type: 'prompt',
            position: { x: 0, y: 0 },
            data: { prompt: `Prompt ${nodeId}`, requirementIds: [] },
          },
        },
      }],
    },
  };
}
