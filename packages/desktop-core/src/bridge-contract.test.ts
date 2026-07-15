import { describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CanvasProject } from '@agent-canvas/domain';
import type { KnowledgeBaseStateSummary } from '@agent-canvas/skill-store';

import type { CommitRequest } from './contracts';
import { releaseJournalState } from './journal-writer';
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
      'openProject',
      'restore',
      'reviewSkillCandidate',
      'subscribeKnowledgeState',
    ]);
    expect(createPreloadApi(mockInvoke)).not.toHaveProperty('readFile');
    expect(createPreloadApi(mockInvoke)).not.toHaveProperty('watchPath');
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

  it('restricts safe mode to recovery-only bridge methods', () => {
    const mockInvoke = vi.fn(async () => undefined) as DesktopBridgeInvoke;

    expect(Object.keys(createSafeModePreloadApi(mockInvoke)).sort()).toEqual([
      'getRecoveryPlan',
      'openProject',
      'restore',
    ]);
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

  it('returns public knowledge summaries without private store fields', async () => {
    const state = createKnowledgeStateSummary();
    const handlers = createDesktopBridgeHandlers({
      knowledgeRefreshService: {
        refreshNow: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        subscribe: vi.fn(),
      },
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

    expect(result).toEqual({ states: [state] });
    expect(JSON.stringify(result)).not.toContain('Private');
    expect(JSON.stringify(result)).not.toContain('rootPath');
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
    const commit = vi.fn(async () => ({
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
        listStates: vi.fn(async () => [rolledBackKnowledgeState()]),
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

  it('returns the restored desktop-owned project after recovery restore', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'novus-bridge-'));
    const projectRoot = join(tempRoot, 'Demo.novus-project');
    await mkdir(join(projectRoot, 'snapshots'), { recursive: true });
    await mkdir(join(projectRoot, 'journal'), { recursive: true });
    const session = createOpenedSession(projectRoot);
    const restoredProject = { ...starterProject, name: 'Restored Project' };
    const candidatePath = join(tempRoot, 'candidate.json');
    await writeFile(join(projectRoot, 'project.novus.json'), `${JSON.stringify(session.manifest)}\n`, 'utf8');
    await writeFile(candidatePath, JSON.stringify({
      project: restoredProject,
      projectId: starterProject.id,
      revision: 3,
      snapshotId: 'snapshot-after',
    }), 'utf8');
    const handlers = createDesktopBridgeHandlers({
      appDataRoot: 'C:\\redacted\\AppData',
      createId: () => 'candidate-1',
      dialogs: {
        chooseProjectRoot: vi.fn(async () => projectRoot),
      },
      recoveryScanner: {
        scan: vi.fn(async () => ({
          action: 'choose_recovery' as const,
          candidates: [{
            path: candidatePath,
            project: restoredProject,
            projectId: starterProject.id,
            revision: 3,
            snapshotId: 'snapshot-after',
            tailStatus: 'complete' as const,
          }],
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
      await expect(handlers.restore({}, { candidateId: 'candidate-1', sessionId: opened!.sessionId })).resolves.toMatchObject({
        project: restoredProject,
        restoredRevision: 3,
      });
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
