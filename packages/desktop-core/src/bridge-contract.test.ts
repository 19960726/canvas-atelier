import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CanvasProject } from '@agent-canvas/domain';

import type { CommitRequest } from './contracts';
import type { OpenedProjectSession } from './project-repository';
import { createDesktopBridgeHandlers } from './bridge-handlers';
import {
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
      'createStablePoint',
      'exportPack',
      'getRecoveryPlan',
      'importPack',
      'openProject',
      'restore',
    ]);
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
