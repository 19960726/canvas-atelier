import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStarterProject } from './app-store';
import {
  createDesktopPersistenceClient,
  migrateLegacyProject,
  type LegacyProjectImportClient,
} from './desktop-persistence';
import { PROJECT_STORAGE_KEY } from './project-persistence';

describe('desktop persistence', () => {
  beforeEach(() => {
    localStorage.clear();
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

    await client.hydrate();

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

    const hydrated = await client.hydrate();
    const result = await client.commit({
      baseRevision: hydrated.revision,
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

    expect(hydrated.revision).toBe(4);
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

    await client.hydrate();
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

    const result = await client.hydrate();

    expect(result.project.name).toBe('Desktop read-only project');
    expect(result.saveStatus).toBe('read_only');
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
    await client.hydrate();

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
