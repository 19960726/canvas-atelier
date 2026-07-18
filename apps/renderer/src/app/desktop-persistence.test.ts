import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStarterProject } from './app-store';
import {
  createBrowserPersistenceClient,
  createDesktopPersistenceClient,
  migrateLegacyProject,
  type LegacyProjectImportClient,
} from './desktop-persistence';
import { PROJECT_STORAGE_KEY } from './project-persistence';

describe('desktop persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('keeps normal browser launch empty even when prior canvas content exists locally', async () => {
    localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify({
      current: { ...createStarterProject(), name: 'Browser recent project' },
      schemaVersion: 2,
      snapshots: [],
    }));

    const hydrated = await createBrowserPersistenceClient().hydrate();

    expect(hydrated.project).toMatchObject({ name: '未命名画布', nodes: [], edges: [] });
    expect(hydrated.lifecycle).toBe('untitled');
    expect(hydrated.saveStatus).toBe('pending');
  });

  it('does not invoke the desktop project picker or auto-open a recent project during normal hydration', async () => {
    const recentProject = { ...createStarterProject(), name: 'Recent desktop project' };
    const openProject = vi.fn(async () => ({
      currentRevision: 7,
      mode: 'write' as const,
      project: recentProject,
      projectId: recentProject.id,
      projectName: recentProject.name,
      sessionId: 'recent-session',
      stableSnapshotId: 'stable-7',
      stableSnapshotRevision: 7,
    }));
    const bridge = {
      closeProject: vi.fn(async () => {}),
      commit: vi.fn(),
      createStablePoint: vi.fn(),
      exportPack: vi.fn(),
      getRecoveryPlan: vi.fn(),
      importPack: vi.fn(),
      openProject,
      restore: vi.fn(),
    };

    const hydrated = await createDesktopPersistenceClient(bridge).hydrate();

    expect(openProject).not.toHaveBeenCalled();
    expect(hydrated.project).toMatchObject({ name: '未命名画布', nodes: [], edges: [] });
    expect(hydrated.availableSnapshotIds).toEqual([]);
    expect(hydrated.lifecycle).toBe('untitled');
    expect(hydrated.saveStatus).toBe('pending');
    expect(hydrated.recoveryRequired).not.toBe(true);
  });

  it('propagates an explicit recovery-required preview instead of presenting it as saved', async () => {
    const previewProject = { ...createStarterProject(), name: 'Recovery preview' };
    const bridge = {
      closeProject: vi.fn(async () => undefined),
      commit: vi.fn(),
      createStablePoint: vi.fn(),
      getRecoveryPlan: vi.fn(async () => createRecoveryPlan(
        previewProject.id,
        'snapshot-recovery',
        'candidate-recovery',
        3,
      )),
      openProject: vi.fn(async () => ({
        ...createDesktopSession(previewProject, 'recovery-session', 3),
        recoveryRequired: true as const,
      })),
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []) },
      restore: vi.fn(),
    };
    const client = createDesktopPersistenceClient(bridge as never);

    const opened = await client.openProject?.();
    const hydrated = await client.hydrate();

    expect(opened).toMatchObject({
      project: previewProject,
      recoveryRequired: true,
      saveStatus: 'error',
    });
    expect(hydrated).toMatchObject({
      recoveryRequired: true,
      saveStatus: 'error',
    });
  });

  it('allows only restore or close-without-flush while a recovery preview is unresolved', async () => {
    const previewProject = { ...createStarterProject(), name: 'Recovery preview' };
    const restoredProject = { ...previewProject, name: 'Recovered durable project' };
    const commit = vi.fn(async () => ({
      committedAt: '2026-07-19T00:00:00.000Z',
      projectId: previewProject.id,
      revision: 4,
      sequence: 4,
      transactionId: 'tx-recovery-blocked',
    }));
    const createStablePoint = vi.fn(async () => ({
      path: 'redacted-path',
      reason: 'stable_point' as const,
      revision: 3,
      snapshotId: 'stable-3',
    }));
    const restore = vi.fn(async () => ({
      ...createDesktopSession(restoredProject, 'recovery-session', 3),
      restoredRevision: 3,
    }));
    const bridge = {
      closeProject: vi.fn(async () => undefined),
      commit,
      createStablePoint,
      getRecoveryPlan: vi.fn(async () => createRecoveryPlan(
        previewProject.id,
        'snapshot-recovery',
        'candidate-recovery',
        3,
      )),
      openProject: vi.fn(async () => ({
        ...createDesktopSession(previewProject, 'recovery-session', 3),
        recoveryRequired: true as const,
      })),
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []) },
      restore,
    };
    const client = createDesktopPersistenceClient(bridge as never);
    await client.openProject?.();

    const blocked = await client.commit({
      baseRevision: 3,
      kind: 'canvas',
      nextProject: { ...previewProject, name: 'Must not commit preview' },
      previousProject: previewProject,
      projectId: previewProject.id,
      transaction: { id: 'tx-recovery-blocked', label: 'Blocked recovery commit', operations: [] },
    });

    expect(blocked).toMatchObject({ code: 'RECOVERY_REQUIRED', ok: false, project: previewProject, revision: 3 });
    await expect(client.stablePoint()).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(commit).not.toHaveBeenCalled();
    expect(createStablePoint).not.toHaveBeenCalled();

    await expect(client.restore('snapshot-recovery')).resolves.toMatchObject({
      project: restoredProject,
      recoveryRequired: false,
      saveStatus: 'saved',
    });
    expect(restore).toHaveBeenCalledWith({ candidateId: 'candidate-recovery', sessionId: 'recovery-session' });
  });

  it('keeps startup image reads and initial untitled edits in memory without opening or committing a hidden desktop session', async () => {
    const openProject = vi.fn();
    const commit = vi.fn();
    const list = vi.fn();
    const importImage = vi.fn();
    const bridge = {
      closeProject: vi.fn(),
      commit,
      createStablePoint: vi.fn(),
      getRecoveryPlan: vi.fn(),
      openProject,
      projectImages: { importImage, list },
      restore: vi.fn(),
    };
    const client = createDesktopPersistenceClient(bridge as never);
    const hydrated = await client.hydrate();
    const edited = { ...hydrated.project, name: 'Renamed in-memory draft' };

    await expect(client.listProjectImages()).resolves.toEqual([]);
    await expect(client.importProjectImage({ kind: 'module', nodeId: 'module-1' })).resolves.toBeNull();
    const result = await client.commit({
      baseRevision: 0,
      kind: 'canvas',
      nextProject: edited,
      previousProject: hydrated.project,
      projectId: hydrated.project.id,
      transaction: { id: 'tx-untitled-memory', label: 'Edit untitled', operations: [] },
    });

    expect(result).toMatchObject({ ok: true, project: edited, revision: 0 });
    expect(openProject).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(importImage).not.toHaveBeenCalled();
  });

  it('uses the explicit open path every time and switches to the newly selected durable project', async () => {
    const firstProject = { ...createStarterProject(), name: 'First durable project' };
    const secondProject = { ...createStarterProject(), id: 'second-project', name: '未命名画布' };
    const openProject = vi.fn()
      .mockResolvedValueOnce(createDesktopSession(firstProject, 'first-session', 3))
      .mockResolvedValueOnce(createDesktopSession(secondProject, 'second-session', 7));
    const closeProject = vi.fn(async () => undefined);
    const bridge = {
      closeProject,
      commit: vi.fn(),
      createStablePoint: vi.fn(),
      getRecoveryPlan: vi.fn(async () => ({ action: 'auto_recover', candidates: [], issues: [], projectId: secondProject.id, recoveredRevision: null, stableSnapshotId: null, targetRevision: null })),
      openProject,
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []) },
      restore: vi.fn(),
    };
    const client = createDesktopPersistenceClient(bridge as never);

    const first = await client.openProject?.();
    const second = await client.openProject?.();

    expect(openProject).toHaveBeenCalledTimes(2);
    expect(closeProject).toHaveBeenCalledWith({ sessionId: 'first-session' });
    expect(first).toMatchObject({ lifecycle: 'durable', project: { name: 'First durable project' }, revision: 3 });
    expect(second).toMatchObject({ lifecycle: 'durable', project: { id: 'second-project', name: '未命名画布' }, revision: 7 });
  });

  it('clears prior recovery candidates when the selected project recovery plan fails', async () => {
    const firstProject = { ...createStarterProject(), name: 'First recovery project' };
    const secondProject = { ...createStarterProject(), id: 'second-project', name: 'Second recovery project' };
    const firstPlan = createRecoveryPlan(firstProject.id, 'first-after', 'candidate-first', 4);
    const secondPlan = createRecoveryPlan(secondProject.id, 'second-after', 'candidate-second', 8);
    const getRecoveryPlan = vi.fn()
      .mockResolvedValueOnce(firstPlan)
      .mockRejectedValueOnce(new Error('second recovery plan unavailable'))
      .mockResolvedValue(secondPlan);
    const restore = vi.fn(async () => ({
      ...createDesktopSession(secondProject, 'second-session', 8),
      restoredRevision: 8,
      stableSnapshotId: 'second-after',
      stableSnapshotRevision: 8,
    }));
    const bridge = {
      closeProject: vi.fn(async () => undefined),
      commit: vi.fn(),
      createStablePoint: vi.fn(async () => ({
        path: 'redacted-path',
        reason: 'stable_point' as const,
        revision: 8,
        snapshotId: 'stable-8',
      })),
      getRecoveryPlan,
      openProject: vi.fn()
        .mockResolvedValueOnce(createDesktopSession(firstProject, 'first-session', 3))
        .mockResolvedValueOnce(createDesktopSession(secondProject, 'second-session', 7)),
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []) },
      restore,
    };
    const client = createDesktopPersistenceClient(bridge as never);

    const first = await client.openProject?.();
    const second = await client.openProject?.();

    expect(first?.availableSnapshotIds).toEqual(['first-after']);
    expect(second).toMatchObject({
      availableSnapshotIds: [],
      project: { id: secondProject.id, name: secondProject.name },
      revision: 7,
    });
    await expect(client.restore('first-after')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(restore).not.toHaveBeenCalled();

    await expect(client.stablePoint()).resolves.toMatchObject({
      availableSnapshotIds: ['second-after'],
      project: { id: secondProject.id },
      revision: 8,
    });
    await client.restore('second-after');
    expect(restore).toHaveBeenCalledWith({ candidateId: 'candidate-second', sessionId: 'second-session' });
  });

  it('replaces recovery candidates instead of mixing them after a successful project switch', async () => {
    const firstProject = { ...createStarterProject(), name: 'First recovery project' };
    const secondProject = { ...createStarterProject(), id: 'second-project', name: 'Second recovery project' };
    const getRecoveryPlan = vi.fn()
      .mockResolvedValueOnce(createRecoveryPlan(firstProject.id, 'first-after', 'candidate-first', 4))
      .mockResolvedValue(createRecoveryPlan(secondProject.id, 'second-after', 'candidate-second', 8));
    const restore = vi.fn(async () => ({
      ...createDesktopSession(secondProject, 'second-session', 8),
      restoredRevision: 8,
      stableSnapshotId: 'second-after',
      stableSnapshotRevision: 8,
    }));
    const bridge = {
      closeProject: vi.fn(async () => undefined),
      commit: vi.fn(),
      createStablePoint: vi.fn(),
      getRecoveryPlan,
      openProject: vi.fn()
        .mockResolvedValueOnce(createDesktopSession(firstProject, 'first-session', 3))
        .mockResolvedValueOnce(createDesktopSession(secondProject, 'second-session', 7)),
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []) },
      restore,
    };
    const client = createDesktopPersistenceClient(bridge as never);

    await client.openProject?.();
    const second = await client.openProject?.();

    expect(second?.availableSnapshotIds).toEqual(['second-after']);
    await expect(client.restore('first-after')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(restore).not.toHaveBeenCalled();
    await client.restore('second-after');
    expect(restore).toHaveBeenCalledWith({ candidateId: 'candidate-second', sessionId: 'second-session' });
  });

  it('ignores a prior session recovery plan that completes after the project switch', async () => {
    const firstProject = { ...createStarterProject(), name: 'First recovery project' };
    const secondProject = { ...createStarterProject(), id: 'second-project', name: 'Second recovery project' };
    let resolveFirstPlan!: (plan: ReturnType<typeof createRecoveryPlan>) => void;
    const firstPlanPromise = new Promise<ReturnType<typeof createRecoveryPlan>>((resolve) => {
      resolveFirstPlan = resolve;
    });
    const getRecoveryPlan = vi.fn(({ sessionId }: { sessionId: string }) => sessionId === 'first-session'
      ? firstPlanPromise
      : Promise.resolve(createRecoveryPlan(secondProject.id, 'second-after', 'candidate-second', 8)));
    const restore = vi.fn();
    const bridge = {
      closeProject: vi.fn(async () => undefined),
      commit: vi.fn(),
      createStablePoint: vi.fn(),
      getRecoveryPlan,
      openProject: vi.fn()
        .mockResolvedValueOnce(createDesktopSession(firstProject, 'first-session', 3))
        .mockResolvedValueOnce(createDesktopSession(secondProject, 'second-session', 7)),
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []) },
      restore,
    };
    const client = createDesktopPersistenceClient(bridge as never);

    const firstOpen = client.openProject!();
    await vi.waitFor(() => {
      expect(getRecoveryPlan).toHaveBeenCalledWith({ sessionId: 'first-session' });
    });
    const second = await client.openProject!();
    resolveFirstPlan(createRecoveryPlan(firstProject.id, 'first-after', 'candidate-first', 4));
    await firstOpen;

    expect(second?.availableSnapshotIds).toEqual(['second-after']);
    await expect(client.hydrate()).resolves.toMatchObject({
      availableSnapshotIds: ['second-after'],
      project: { id: secondProject.id },
    });
    await expect(client.restore('first-after')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(restore).not.toHaveBeenCalled();
  });

  it('removes a v2 localStorage bundle only after desktop import acknowledgement', async () => {
    const legacyBundleJson = JSON.stringify({
      current: createStarterProject(),
      schemaVersion: 2,
      snapshots: [],
    });
    const client: LegacyProjectImportClient = {
      createFromLegacyBundle: vi.fn(async () => {}),
    };

    localStorage.setItem(PROJECT_STORAGE_KEY, legacyBundleJson);

    await migrateLegacyProject(client);

    expect(client.createFromLegacyBundle).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBeNull();
  });

  it('keeps the v2 localStorage bundle when desktop import fails', async () => {
    const legacyBundleJson = JSON.stringify({
      current: createStarterProject(),
      schemaVersion: 2,
      snapshots: [],
    });
    const client: LegacyProjectImportClient = {
      createFromLegacyBundle: vi.fn(async () => {
        throw new Error('desktop import failed');
      }),
    };

    localStorage.setItem(PROJECT_STORAGE_KEY, legacyBundleJson);

    await expect(migrateLegacyProject(client)).rejects.toThrow('desktop import failed');
    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBe(legacyBundleJson);
  });

  it('returns the last durable desktop project on REVISION_CONFLICT', async () => {
    const durableProject = createStarterProject();
    const staleProject = { ...durableProject, name: 'stale-draft' };
    const bridge = {
      closeProject: vi.fn(async () => {}),
      commit: vi.fn(async () => {
        const error = new Error('Base revision is stale') as Error & { code: string };
        error.code = 'REVISION_CONFLICT';
        throw error;
      }),
      createStablePoint: vi.fn(async () => ({
        path: 'redacted-path',
        reason: 'stable_point' as const,
        revision: 3,
        snapshotId: 'stable-3',
      })),
      exportPack: vi.fn(),
      getRecoveryPlan: vi.fn(),
      importPack: vi.fn(),
      openProject: vi.fn(async () => ({
        currentRevision: 3,
        mode: 'write' as const,
        project: durableProject,
        projectId: durableProject.id,
        projectName: durableProject.name,
        sessionId: 'desktop-session',
        stableSnapshotId: null,
        stableSnapshotRevision: 3,
      })),
      restore: vi.fn(),
    };
    const client = createDesktopPersistenceClient(bridge);

    await client.openProject?.();

    const result = await client.commit({
      baseRevision: 2,
      kind: 'canvas',
      nextProject: { ...durableProject, name: 'stale-draft' },
      previousProject: durableProject,
      projectId: durableProject.id,
      transaction: {
        id: 'tx-conflict',
        label: 'Conflict draft',
        operations: [{
          kind: 'replace_canvas_state',
          nodes: durableProject.nodes,
          edges: durableProject.edges,
        }],
      },
    });

    expect(result).toMatchObject({
      code: 'REVISION_CONFLICT',
      ok: false,
      project: durableProject,
      revision: 3,
    });
  });

  it('uses the bridge current revision instead of the stable snapshot revision after hydrate', async () => {
    const durableProject = createStarterProject();
    const bridge = {
      closeProject: vi.fn(async () => {}),
      commit: vi.fn(async () => ({
        committedAt: '2026-07-14T00:00:00.000Z',
        projectId: durableProject.id,
        revision: 5,
        sequence: 5,
        transactionId: 'tx-after-hydrate-head',
      })),
      createStablePoint: vi.fn(),
      exportPack: vi.fn(),
      getRecoveryPlan: vi.fn(async () => ({
        action: 'auto_recover' as const,
        candidates: [],
        issues: [],
        projectId: durableProject.id,
        recoveredRevision: null,
        stableSnapshotId: 'stable-3',
        targetRevision: null,
      })),
      importPack: vi.fn(),
      openProject: vi.fn(async () => ({
        currentRevision: 4,
        mode: 'write' as const,
        project: durableProject,
        projectId: durableProject.id,
        projectName: durableProject.name,
        sessionId: 'desktop-session',
        stableSnapshotId: 'stable-3',
        stableSnapshotRevision: 3,
      })),
      restore: vi.fn(),
    };
    const client = createDesktopPersistenceClient(bridge);

    const hydrated = await client.openProject?.();
    expect(hydrated).not.toBeNull();
    const result = await client.commit({
      baseRevision: hydrated!.revision,
      kind: 'canvas',
      nextProject: { ...durableProject, name: 'After current head' },
      previousProject: durableProject,
      projectId: durableProject.id,
      transaction: {
        id: 'tx-after-hydrate-head',
        label: 'After current head',
        operations: [{
          kind: 'replace_canvas_state',
          nodes: durableProject.nodes,
          edges: durableProject.edges,
        }],
      },
    });

    expect(hydrated!.revision).toBe(4);
    expect(bridge.commit).toHaveBeenCalledWith(expect.objectContaining({ baseRevision: 4 }));
    expect(result).toMatchObject({ ok: true, revision: 5 });
  });

  it('maps desktop snapshot ids to opaque recovery candidate ids before restore', async () => {
    const durableProject = createStarterProject();
    const restoredProject = { ...durableProject, name: 'Restored from bridge' };
    const bridge = {
      closeProject: vi.fn(async () => {}),
      commit: vi.fn(),
      createStablePoint: vi.fn(async () => ({
        path: 'redacted-path',
        reason: 'stable_point' as const,
        revision: 3,
        snapshotId: 'stable-3',
      })),
      exportPack: vi.fn(),
      getRecoveryPlan: vi.fn(async () => ({
        action: 'choose_recovery' as const,
        candidates: [{
          candidateId: 'candidate-opaque',
          revision: 4,
          snapshotId: 'desktop-after',
          tailStatus: 'complete' as const,
        }],
        issues: [],
        projectId: durableProject.id,
        recoveredRevision: null,
        stableSnapshotId: 'stable-3',
        targetRevision: 4,
      })),
      importPack: vi.fn(),
      openProject: vi.fn(async () => ({
        currentRevision: 3,
        mode: 'write' as const,
        project: durableProject,
        projectId: durableProject.id,
        projectName: durableProject.name,
        sessionId: 'desktop-session',
        stableSnapshotId: 'stable-3',
        stableSnapshotRevision: 3,
      })),
      restore: vi.fn(async () => ({
        currentRevision: 4,
        mode: 'write' as const,
        project: restoredProject,
        projectId: durableProject.id,
        projectName: durableProject.name,
        restoredRevision: 4,
        sessionId: 'desktop-session',
        stableSnapshotId: 'desktop-after',
        stableSnapshotRevision: 4,
      })),
    };
    const client = createDesktopPersistenceClient(bridge);

    await client.openProject?.();
    const result = await client.restore('desktop-after');

    expect(bridge.restore).toHaveBeenCalledWith({ candidateId: 'candidate-opaque', sessionId: 'desktop-session' });
    expect(result.project.name).toBe('Restored from bridge');
    expect(result.revision).toBe(4);
  });

  it('keeps bridge project state when read-only desktop opens with legacy browser storage', async () => {
    const bridgeProject = { ...createStarterProject(), name: 'Desktop read-only project' };
    localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify({
      current: { ...createStarterProject(), name: 'Stale browser draft' },
      schemaVersion: 2,
      snapshots: [],
    }));
    const bridge = {
      closeProject: vi.fn(async () => {}),
      commit: vi.fn(),
      createStablePoint: vi.fn(),
      exportPack: vi.fn(),
      getRecoveryPlan: vi.fn(async () => ({
        action: 'read_only' as const,
        candidates: [],
        issues: [],
        projectId: bridgeProject.id,
        recoveredRevision: null,
        stableSnapshotId: null,
        targetRevision: null,
      })),
      importPack: vi.fn(),
      openProject: vi.fn(async () => ({
        currentRevision: 7,
        mode: 'read_only' as const,
        project: bridgeProject,
        projectId: bridgeProject.id,
        projectName: bridgeProject.name,
        sessionId: 'desktop-session',
        stableSnapshotId: 'stable-7',
        stableSnapshotRevision: 7,
      })),
      restore: vi.fn(),
    };
    const client = createDesktopPersistenceClient(bridge);

    const result = await client.openProject?.();

    expect(result?.project.name).toBe('Desktop read-only project');
    expect(result?.saveStatus).toBe('read_only');
    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).not.toBeNull();
  });

  it('binds project image operations to the hidden desktop session and advances durable state only after ACK', async () => {
    const durableProject = createStarterProject();
    const importedProject = {
      ...durableProject,
      assets: [{
        assetId: '0123456789abcdef',
        byteSize: 42,
        extension: 'png' as const,
        height: 3,
        label: 'Product',
        mediaType: 'image/png' as const,
        origin: 'imported' as const,
        sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        width: 2,
      }],
    };
    const asset = {
      ...importedProject.assets[0]!,
      displayUrl: 'novus-asset://project/desktop-session/0123456789abcdef',
      usageCount: 1,
    };
    const projectImages = {
      importImage: vi.fn(async () => ({ asset, currentRevision: 8, project: importedProject })),
      list: vi.fn(async () => [asset]),
    };
    const bridge = {
      closeProject: vi.fn(async () => {}),
      commit: vi.fn(),
      createStablePoint: vi.fn(),
      exportPack: vi.fn(),
      getRecoveryPlan: vi.fn(async () => ({
        action: 'auto_recover' as const,
        candidates: [],
        issues: [],
        projectId: durableProject.id,
        recoveredRevision: null,
        stableSnapshotId: null,
        targetRevision: 7,
      })),
      importPack: vi.fn(),
      openProject: vi.fn(async () => ({
        currentRevision: 7,
        mode: 'write' as const,
        project: durableProject,
        projectId: durableProject.id,
        projectName: durableProject.name,
        sessionId: 'desktop-session',
        stableSnapshotId: null,
        stableSnapshotRevision: 7,
      })),
      projectImages,
      restore: vi.fn(),
    };
    const client = createDesktopPersistenceClient(bridge);
    await client.openProject?.();

    await expect(client.listProjectImages()).resolves.toEqual([asset]);
    await expect(client.importProjectImage({ kind: 'module', nodeId: 'image-input' })).resolves.toEqual({
      asset,
      project: importedProject,
      revision: 8,
    });
    expect(projectImages.list).toHaveBeenCalledWith({ sessionId: 'desktop-session' });
    expect(projectImages.importImage).toHaveBeenCalledWith({
      sessionId: 'desktop-session',
      target: { kind: 'module', nodeId: 'image-input' },
    });
  });
});

function createDesktopSession(project: ReturnType<typeof createStarterProject>, sessionId: string, revision: number) {
  return {
    currentRevision: revision,
    mode: 'write' as const,
    project,
    projectId: project.id,
    projectName: project.name,
    sessionId,
    stableSnapshotId: null,
    stableSnapshotRevision: revision,
  };
}

function createRecoveryPlan(
  projectId: string,
  snapshotId: string,
  candidateId: string,
  revision: number,
) {
  return {
    action: 'choose_recovery' as const,
    candidates: [{ candidateId, revision, snapshotId, tailStatus: 'complete' as const }],
    issues: [],
    projectId,
    recoveredRevision: null,
    stableSnapshotId: null,
    targetRevision: revision,
  };
}
