import type {
  DesktopBridgeApi,
  JournalTransactionKind,
  PersistenceErrorCode,
} from '@agent-canvas/desktop-core';
import type { CanvasProject, ProjectTransaction } from '@agent-canvas/domain';
import {
  clearPersistedProjectBundle,
  loadPersistedProjectBundle,
  persistCurrentProject,
  persistProjectTransition,
  type PersistedProjectBundle,
} from './project-persistence';

export type PersistenceMode = 'browser' | 'desktop';
export type ProjectSaveStatus = 'pending' | 'saving' | 'saved' | 'error' | 'read_only';
export type ProjectCommitErrorCode = PersistenceErrorCode | 'BROWSER_PERSIST_FAILED';

export interface ProjectHydrationResult {
  availableSnapshotIds: string[];
  mode: PersistenceMode;
  project: CanvasProject;
  revision: number;
  saveStatus: Extract<ProjectSaveStatus, 'pending' | 'saved' | 'read_only'>;
}

export interface ProjectCommitRequest {
  baseRevision: number;
  kind: JournalTransactionKind;
  nextProject: CanvasProject;
  previousProject: CanvasProject;
  projectId: string;
  transaction: ProjectTransaction;
}

export type ProjectCommitResult =
  | {
    ok: true;
    project: CanvasProject;
    revision: number;
  }
  | {
    code: ProjectCommitErrorCode;
    ok: false;
    project: CanvasProject;
    revision: number;
  };

export interface ProjectStablePointResult {
  availableSnapshotIds: string[];
  project: CanvasProject;
  revision: number;
}

export interface ProjectRestoreResult {
  availableSnapshotIds: string[];
  project: CanvasProject;
  revision: number;
  saveStatus: Extract<ProjectSaveStatus, 'saved' | 'read_only'>;
}

export interface ProjectPersistenceClient {
  close(): Promise<void>;
  commit(request: ProjectCommitRequest): Promise<ProjectCommitResult>;
  hydrate(): Promise<ProjectHydrationResult>;
  restore(snapshotId: string): Promise<ProjectRestoreResult>;
  stablePoint(): Promise<ProjectStablePointResult>;
}

export interface LegacyProjectImportClient {
  createFromLegacyBundle(bundle: PersistedProjectBundle): Promise<unknown>;
}

export function createProjectPersistenceClient(): ProjectPersistenceClient {
  const bridge = globalThis.window?.novusDesktop;
  return bridge === undefined
    ? createBrowserPersistenceClient()
    : createDesktopPersistenceClient(bridge);
}

export function createBrowserPersistenceClient(storage = getStorage()): ProjectPersistenceClient {
  let currentProject: CanvasProject | null = null;
  let revision = 0;
  let availableSnapshotIds: string[] = [];

  return {
    async close() {},
    async commit(request) {
      const snapshotIds = selectSnapshotIds(request.transaction);
      const saved = snapshotIds === null
        ? persistCurrentProject(request.nextProject, storage)
        : persistProjectTransition(request.previousProject, request.nextProject, snapshotIds, storage);
      if (!saved) {
        return {
          code: 'BROWSER_PERSIST_FAILED',
          ok: false,
          project: currentProject ?? request.previousProject,
          revision,
        };
      }
      currentProject = request.nextProject;
      revision += 1;
      availableSnapshotIds = readSnapshotIds(storage);
      return {
        ok: true,
        project: currentProject,
        revision,
      };
    },
    async hydrate() {
      const bundle = loadPersistedProjectBundle(storage);
      currentProject = bundle?.current ?? null;
      availableSnapshotIds = bundle?.snapshots.map((snapshot) => snapshot.id) ?? [];
      revision = 0;
      return {
        availableSnapshotIds,
        mode: 'browser',
        project: currentProject ?? createFallbackProject(),
        revision,
        saveStatus: currentProject === null ? 'pending' : 'saved',
      };
    },
    async restore(snapshotId) {
      const bundle = loadPersistedProjectBundle(storage);
      const snapshot = bundle?.snapshots.find((entry) => entry.id === snapshotId);
      currentProject = snapshot?.project ?? currentProject ?? bundle?.current ?? createFallbackProject();
      availableSnapshotIds = bundle?.snapshots.map((entry) => entry.id) ?? [];
      if (snapshot !== undefined) {
        persistCurrentProject(currentProject, storage);
      }
      return {
        availableSnapshotIds,
        project: currentProject,
        revision,
        saveStatus: 'saved',
      };
    },
    async stablePoint() {
      if (currentProject !== null) {
        persistCurrentProject(currentProject, storage);
        availableSnapshotIds = readSnapshotIds(storage);
      }
      return {
        availableSnapshotIds,
        project: currentProject ?? createFallbackProject(),
        revision,
      };
    },
  };
}

export function createDesktopPersistenceClient(bridge: DesktopBridgeApi): ProjectPersistenceClient {
  let sessionId: string | null = null;
  let projectId: string | null = null;
  let mode: 'write' | 'read_only' = 'write';
  let currentProject = createFallbackProject();
  let revision = 0;
  let availableSnapshotIds: string[] = [];

  const importClient: LegacyProjectImportClient = {
    async createFromLegacyBundle(bundle) {
      const nextProject = normalizeLegacyProject(bundle.current, projectId ?? bundle.current.id);
      const result = await desktopCommit({
        baseRevision: revision,
        kind: 'system',
        nextProject,
        previousProject: currentProject,
        projectId: projectId ?? nextProject.id,
        transaction: createLegacyImportTransaction(nextProject),
      });
      if (!result.ok) {
        throw createImportError(result.code);
      }
    },
  };

  return {
    async close() {
      if (sessionId === null) return;
      await bridge.closeProject({ sessionId });
      sessionId = null;
    },
    commit: desktopCommit,
    async hydrate() {
      await ensureSession();

      const legacyBundle = loadPersistedProjectBundle();
      if (legacyBundle !== null && mode === 'write') {
        currentProject = normalizeLegacyProject(legacyBundle.current, projectId ?? legacyBundle.current.id);
      }

      if (legacyBundle !== null && mode === 'write' && sessionId !== null) {
        await migrateLegacyProject(importClient);
        availableSnapshotIds = await readDesktopRecoverySnapshotIds();
        return {
          availableSnapshotIds,
          mode: 'desktop',
          project: currentProject,
          revision,
          saveStatus: 'saved',
        };
      }

      availableSnapshotIds = await readDesktopRecoverySnapshotIds();
      return {
        availableSnapshotIds,
        mode: 'desktop',
        project: currentProject,
        revision,
        saveStatus: mode === 'read_only' ? 'read_only' : 'saved',
      };
    },
    async restore(snapshotId) {
      if (sessionId !== null && mode === 'write') {
        const plan = await bridge.getRecoveryPlan({ sessionId });
        const candidate = plan.candidates.find((entry) => entry.snapshotId === snapshotId);
        if (candidate === undefined) {
          throw createImportError('INVALID_REQUEST');
        }
        const result = await bridge.restore({ candidateId: candidate.candidateId, sessionId });
        currentProject = result.project;
        revision = result.restoredRevision;
        availableSnapshotIds = await readDesktopRecoverySnapshotIds();
      }
      return {
        availableSnapshotIds,
        project: currentProject,
        revision,
        saveStatus: mode === 'read_only' ? 'read_only' : 'saved',
      };
    },
    async stablePoint() {
      if (sessionId !== null && mode === 'write') {
        const result = await bridge.createStablePoint({ sessionId });
        revision = result.revision;
        availableSnapshotIds = await readDesktopRecoverySnapshotIds();
      }
      return {
        availableSnapshotIds,
        project: currentProject,
        revision,
      };
    },
  };

  async function desktopCommit(request: ProjectCommitRequest): Promise<ProjectCommitResult> {
    await ensureSession();
    if (sessionId === null || projectId === null) {
      return {
        code: 'INVALID_SESSION',
        ok: false,
        project: currentProject,
        revision,
      };
    }
    if (mode === 'read_only') {
      return {
        code: 'CONCURRENT_WRITER',
        ok: false,
        project: currentProject,
        revision,
      };
    }
    try {
      const ack = await bridge.commit({
        baseRevision: request.baseRevision,
        kind: request.kind,
        projectId,
        sessionId,
        transaction: request.transaction,
      });
      currentProject = request.nextProject;
      revision = ack.revision;
      return {
        ok: true,
        project: currentProject,
        revision,
      };
    } catch (error) {
      const code = readErrorCode(error);
      return {
        code,
        ok: false,
        project: currentProject,
        revision,
      };
    }
  }

  async function ensureSession(): Promise<void> {
    if (sessionId !== null) return;
    const session = await bridge.openProject({ mode: 'write' });
    if (session === null) return;
    sessionId = session.sessionId;
    projectId = session.projectId;
    mode = session.mode;
    currentProject = session.project;
    revision = session.stableSnapshotRevision;
    availableSnapshotIds = await readDesktopRecoverySnapshotIds();
  }

  async function readDesktopRecoverySnapshotIds(): Promise<string[]> {
    if (sessionId === null) return availableSnapshotIds;
    try {
      const plan = await bridge.getRecoveryPlan({ sessionId });
      return plan.candidates.map((candidate) => candidate.snapshotId);
    } catch {
      return availableSnapshotIds;
    }
  }
}

export async function migrateLegacyProject(
  client: LegacyProjectImportClient,
  storage = getStorage(),
): Promise<PersistedProjectBundle | null> {
  const bundle = loadPersistedProjectBundle(storage);
  if (bundle === null) {
    return null;
  }
  await client.createFromLegacyBundle(bundle);
  clearPersistedProjectBundle(storage);
  return bundle;
}

function createFallbackProject(): CanvasProject {
  return {
    version: 1,
    id: 'local-project',
    name: '未命名画布',
    nodes: [
      { id: 'reference-start', type: 'reference', position: { x: 120, y: 160 }, data: { assetId: 'starter-product', role: 'product_identity' } },
      { id: 'placement-start', type: 'placement_preview', position: { x: 460, y: 270 }, data: {
        board: { id: 'starter-board', aspectRatio: '4:5', width: 1080, height: 1350, safeAreas: [{ id: 'copy-top', x: 0.08, y: 0.06, w: 0.84, h: 0.16, purpose: 'copy_safe' }] },
        objects: [{ id: 'product-main', assetId: 'starter-product', role: 'product_identity', x: 0.34, y: 0.42, w: 0.32, h: 0.38, rotation: 0, zIndex: 20, locked: false, visible: true, flipX: false, flipY: false, semanticLayer: 'hero_product', name: '主产品' }],
      } },
      { id: 'prompt-start', type: 'prompt', position: { x: 800, y: 160 }, data: { prompt: '等待确认后执行模型任务', requirementIds: [] } },
    ],
    edges: [
      { id: 'edge-reference-placement', source: 'reference-start', target: 'placement-start' },
      { id: 'edge-placement-prompt', source: 'placement-start', target: 'prompt-start', label: 'agent-plan' },
    ],
    projectMemory: [],
    skillPromotionCandidates: [],
  };
}

function createImportError(code: ProjectCommitErrorCode): Error & { code: ProjectCommitErrorCode } {
  const error = new Error(`Legacy project import failed with ${code}`) as Error & { code: ProjectCommitErrorCode };
  error.code = code;
  return error;
}

function createLegacyImportTransaction(project: CanvasProject): ProjectTransaction {
  return {
    id: `desktop-legacy-import-${Date.now()}`,
    label: 'Import legacy browser project',
    operations: [
      {
        kind: 'replace_canvas_state',
        nodes: project.nodes,
        edges: project.edges,
      },
      ...project.projectMemory.map((entry) => ({
        kind: 'append_project_memory' as const,
        entry,
      })),
      {
        kind: 'set_skill_candidates' as const,
        candidates: project.skillPromotionCandidates,
      },
    ],
  };
}

function getStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function normalizeLegacyProject(project: CanvasProject, targetProjectId: string): CanvasProject {
  return {
    ...project,
    id: targetProjectId,
    projectMemory: project.projectMemory.map((entry) => ({
      ...entry,
      projectId: targetProjectId,
    })),
    skillPromotionCandidates: project.skillPromotionCandidates.map((candidate) => ({
      ...candidate,
      sourceProjectId: targetProjectId,
    })),
  };
}

function readErrorCode(error: unknown): ProjectCommitErrorCode {
  const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code as ProjectCommitErrorCode : 'INVALID_REQUEST';
}

function readSnapshotIds(storage = getStorage()): string[] {
  return loadPersistedProjectBundle(storage)?.snapshots.map((snapshot) => snapshot.id) ?? [];
}

function selectSnapshotIds(transaction: ProjectTransaction): { beforeId: string; afterId: string } | null {
  for (let index = transaction.operations.length - 1; index >= 0; index -= 1) {
    const operation = transaction.operations[index];
    if (operation?.kind === 'append_project_memory') {
      return operation.entry.snapshots;
    }
  }
  return null;
}
