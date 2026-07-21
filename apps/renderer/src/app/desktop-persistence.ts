import type {
  DesktopBridgeApi,
  JournalTransactionKind,
  PersistenceErrorCode,
  ProjectImageAssetSummary,
  ProjectImageImportTarget,
} from '@agent-canvas/desktop-core';
import type { CanvasProject, ProjectTransaction } from '@agent-canvas/domain';
import {
  clearPersistedProjectBundle,
  loadPersistedProjectBundle,
  persistCurrentProject,
  persistProjectTransition,
  type PersistedProjectBundle,
} from './project-persistence';
import {
  findDurableRecoveryCandidate,
  selectDurableRecoverySnapshotIds,
  validateRecoveredProject,
} from './recovery';
import { createUntitledProject } from './project-factory';

export type PersistenceMode = 'browser' | 'desktop';
export type ProjectSaveStatus = 'pending' | 'saving' | 'saved' | 'error' | 'read_only';
export type ProjectLifecycle = 'untitled' | 'durable';
export type ProjectCommitErrorCode = PersistenceErrorCode | 'RECOVERY_REQUIRED' | 'BROWSER_PERSIST_FAILED';

export interface ProjectHydrationResult {
  availableSnapshotIds: string[];
  lifecycle: ProjectLifecycle;
  mode: PersistenceMode;
  project: CanvasProject;
  recoveryRequired?: boolean;
  revision: number;
  saveStatus: Extract<ProjectSaveStatus, 'pending' | 'saved' | 'error' | 'read_only'>;
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
  lifecycle: ProjectLifecycle;
  project: CanvasProject;
  recoveryRequired?: boolean;
  revision: number;
  saveStatus: Extract<ProjectSaveStatus, 'saved' | 'error' | 'read_only'>;
}

export interface ProjectImageImportResult {
  asset: ProjectImageAssetSummary;
  project: CanvasProject;
  revision: number;
}

export interface ProjectPersistenceClient {
  close(): Promise<void>;
  commit(request: ProjectCommitRequest): Promise<ProjectCommitResult>;
  hydrate(): Promise<ProjectHydrationResult>;
  openProject?(): Promise<ProjectHydrationResult | null>;
  reloadDurableProject?(): Promise<ProjectHydrationResult | null>;
  importProjectImage(target: ProjectImageImportTarget): Promise<ProjectImageImportResult | null>;
  pasteClipboardImage(input: {
    readonly operationId: string;
    readonly position: { readonly x: number; readonly y: number };
  }): Promise<ProjectImageImportResult | null>;
  listProjectImages(): Promise<ProjectImageAssetSummary[]>;
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
      currentProject = createUntitledProject();
      availableSnapshotIds = [];
      revision = 0;
      return {
        availableSnapshotIds,
        lifecycle: 'untitled',
        mode: 'browser',
        project: currentProject,
        revision,
        saveStatus: 'pending',
      };
    },
    async openProject() {
      const bundle = loadPersistedProjectBundle(storage);
      if (bundle === null) return null;
      currentProject = bundle.current;
      availableSnapshotIds = bundle.snapshots.map((snapshot) => snapshot.id);
      revision = 0;
      return {
        availableSnapshotIds,
        lifecycle: 'durable',
        mode: 'browser',
        project: currentProject,
        revision,
        saveStatus: 'saved',
      };
    },
    async importProjectImage() {
      return null;
    },
    async pasteClipboardImage() {
      return null;
    },
    async listProjectImages() {
      return [];
    },
    async restore(snapshotId) {
      const bundle = loadPersistedProjectBundle(storage);
      const snapshot = bundle?.snapshots.find((entry) => entry.id === snapshotId);
      currentProject = snapshot?.project ?? currentProject ?? bundle?.current ?? createUntitledProject();
      availableSnapshotIds = bundle?.snapshots.map((entry) => entry.id) ?? [];
      if (snapshot !== undefined) {
        persistCurrentProject(currentProject, storage);
      }
      return {
        availableSnapshotIds,
        lifecycle: 'durable',
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
        project: currentProject ?? createUntitledProject(),
        revision,
      };
    },
  };
}

export function createDesktopPersistenceClient(bridge: DesktopBridgeApi): ProjectPersistenceClient {
  let sessionId: string | null = null;
  let projectId: string | null = null;
  let mode: 'write' | 'read_only' = 'write';
  let currentProject = createUntitledProject();
  let revision = 0;
  let recoveryRequired = false;
  let availableSnapshotIds: string[] = [];
  let recoveryCandidateIds = new Map<string, string>();
  let clientGeneration = 0;

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
      const closingSessionId = sessionId;
      const closingProjectId = projectId;
      const closingGeneration = clientGeneration;
      await bridge.closeProject({ sessionId: closingSessionId });
      if (
        sessionId !== closingSessionId
        || projectId !== closingProjectId
        || clientGeneration !== closingGeneration
      ) return;
      clientGeneration += 1;
      sessionId = null;
      projectId = null;
      mode = 'write';
      currentProject = createUntitledProject();
      revision = 0;
      recoveryRequired = false;
      availableSnapshotIds = [];
      recoveryCandidateIds = new Map();
    },
    commit: desktopCommit,
    async hydrate() {
      clientGeneration += 1;
      return {
        availableSnapshotIds: sessionId === null ? [] : availableSnapshotIds,
        lifecycle: sessionId === null ? 'untitled' : 'durable',
        mode: 'desktop',
        project: currentProject,
        recoveryRequired,
        revision,
        saveStatus: sessionId === null
          ? 'pending'
          : recoveryRequired
            ? 'error'
            : mode === 'read_only' ? 'read_only' : 'saved',
      };
    },
    async openProject() {
      if (recoveryRequired) throw createImportError('RECOVERY_REQUIRED');
      const previousSessionId = sessionId;
      const selected = await bridge.openProject({ mode: 'write' });
      if (selected === null) return null;
      if (previousSessionId !== null) await bridge.closeProject({ sessionId: previousSessionId });
      return adoptSelectedSession(selected);
    },
    async reloadDurableProject() {
      if (recoveryRequired) throw createImportError('RECOVERY_REQUIRED');
      const previousSessionId = sessionId;
      if (previousSessionId !== null) {
        await bridge.closeProject({
          flush: false,
          sessionId: previousSessionId,
        } as Parameters<DesktopBridgeApi['closeProject']>[0] & { readonly flush: false });
        if (sessionId === previousSessionId) {
          clientGeneration += 1;
          sessionId = null;
          projectId = null;
          mode = 'write';
          recoveryRequired = false;
          availableSnapshotIds = [];
          recoveryCandidateIds = new Map();
        }
      }

      const selected = await bridge.openProject({ mode: 'write' });
      if (selected === null) return null;
      if (selected.mode !== 'write' || selected.recoveryRequired === true) {
        await bridge.closeProject({
          flush: false,
          sessionId: selected.sessionId,
        } as Parameters<DesktopBridgeApi['closeProject']>[0] & { readonly flush: false });
        return null;
      }
      return adoptSelectedSession(selected);
    },
    async importProjectImage(target) {
      if (sessionId === null) return null;
      if (recoveryRequired) throw createImportError('RECOVERY_REQUIRED');
      const result = await bridge.projectImages.importImage({ sessionId, target });
      if (result === null) return null;
      currentProject = validateRecoveredProject(result.project, currentProject);
      revision = result.currentRevision;
      return {
        asset: result.asset,
        project: currentProject,
        revision,
      };
    },
    async pasteClipboardImage(input) {
      if (sessionId === null) return null;
      if (recoveryRequired) throw createImportError('RECOVERY_REQUIRED');
      const request = {
        sessionId,
        target: { kind: 'new_image_input' as const, operationId: input.operationId, position: input.position },
      };
      let result;
      try {
        result = await bridge.projectImages.pasteClipboardImage(request);
      } catch (error) {
        if (!shouldRetryClipboardPaste(error)) throw error;
        result = await bridge.projectImages.pasteClipboardImage(request);
      }
      if (result === null) return null;
      currentProject = validateRecoveredProject(result.project, currentProject);
      revision = result.currentRevision;
      return { asset: result.asset, project: currentProject, revision };
    },
    async listProjectImages() {
      return sessionId === null ? [] : bridge.projectImages.list({ sessionId });
    },
    async restore(snapshotId) {
      if (sessionId !== null && mode === 'write') {
        const candidateId = recoveryCandidateIds.get(snapshotId);
        if (candidateId === undefined) {
          throw createImportError('INVALID_REQUEST');
        }
        const restoreSessionId = sessionId;
        const restoreProjectId = projectId;
        const restoreGeneration = clientGeneration;
        const previousProject = currentProject;
        const previousRevision = revision;
        const result = await bridge.restore({ candidateId, sessionId: restoreSessionId });
        if (
          sessionId !== restoreSessionId
          || projectId !== restoreProjectId
          || clientGeneration !== restoreGeneration
        ) {
          return {
            availableSnapshotIds,
            lifecycle: sessionId === null ? 'untitled' : 'durable',
            project: currentProject,
            recoveryRequired,
            revision,
            saveStatus: readDesktopSaveStatus(),
          };
        }
        clientGeneration += 1;
        currentProject = validateRecoveredProject(result.project, previousProject);
        revision = currentProject === previousProject && result.project !== previousProject
          ? previousRevision
          : result.restoredRevision;
        availableSnapshotIds = await readDesktopRecoverySnapshotIds();
        recoveryRequired = false;
      }
      return {
        availableSnapshotIds,
        lifecycle: sessionId === null ? 'untitled' : 'durable',
        project: currentProject,
        recoveryRequired,
        revision,
        saveStatus: recoveryRequired ? 'error' : mode === 'read_only' ? 'read_only' : 'saved',
      };
    },
    async stablePoint() {
      if (recoveryRequired) throw createImportError('RECOVERY_REQUIRED');
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

  async function adoptSelectedSession(
    selected: NonNullable<Awaited<ReturnType<DesktopBridgeApi['openProject']>>>,
  ): Promise<ProjectHydrationResult> {
    clientGeneration += 1;
    sessionId = selected.sessionId;
    projectId = selected.projectId;
    mode = selected.mode;
    currentProject = validateRecoveredProject(selected.project, currentProject);
    revision = selected.currentRevision ?? selected.stableSnapshotRevision;
    recoveryRequired = selected.recoveryRequired === true;
    availableSnapshotIds = [];
    recoveryCandidateIds = new Map();
    availableSnapshotIds = await readDesktopRecoverySnapshotIds(selected.sessionId);
    return {
      availableSnapshotIds,
      lifecycle: 'durable',
      mode: 'desktop',
      project: currentProject,
      recoveryRequired,
      revision,
      saveStatus: recoveryRequired ? 'error' : mode === 'read_only' ? 'read_only' : 'saved',
    };
  }

  async function desktopCommit(request: ProjectCommitRequest): Promise<ProjectCommitResult> {
    if (sessionId === null || projectId === null) {
      currentProject = validateRecoveredProject(request.nextProject, request.previousProject);
      return {
        ok: true,
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
    if (recoveryRequired) {
      return {
        code: 'RECOVERY_REQUIRED',
        ok: false,
        project: currentProject,
        revision,
      };
    }
    const commitSessionId = sessionId;
    const commitProjectId = projectId;
    const commitGeneration = clientGeneration;
    try {
      const ack = await bridge.commit({
        baseRevision: request.baseRevision,
        kind: request.kind,
        projectId: commitProjectId,
        sessionId: commitSessionId,
        transaction: request.transaction,
      });
      const acknowledgedProject = validateRecoveredProject(
        request.nextProject,
        clientGeneration === commitGeneration ? currentProject : request.previousProject,
      );
      if (
        sessionId === commitSessionId
        && projectId === commitProjectId
        && clientGeneration === commitGeneration
      ) {
        currentProject = acknowledgedProject;
        revision = ack.revision;
      }
      return {
        ok: true,
        project: acknowledgedProject,
        revision: ack.revision,
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

  async function readDesktopRecoverySnapshotIds(requestedSessionId = sessionId): Promise<string[]> {
    if (requestedSessionId === null) return availableSnapshotIds;
    try {
      const plan = await bridge.getRecoveryPlan({ sessionId: requestedSessionId });
      if (sessionId !== requestedSessionId) return availableSnapshotIds;
      const completeCandidates = plan.candidates.filter((candidate) => candidate.tailStatus === 'complete');
      recoveryCandidateIds = new Map(completeCandidates.map((candidate) => [candidate.snapshotId, candidate.candidateId]));
      return completeCandidates.map((candidate) => candidate.snapshotId);
    } catch {
      if (sessionId !== requestedSessionId) return availableSnapshotIds;
      recoveryCandidateIds = new Map();
      return [];
    }
  }

  function readDesktopSaveStatus(): Extract<ProjectSaveStatus, 'error' | 'read_only' | 'saved'> {
    return recoveryRequired ? 'error' : mode === 'read_only' ? 'read_only' : 'saved';
  }
}

function shouldRetryClipboardPaste(error: unknown): boolean {
  if (!isRecord(error) || typeof error.code !== 'string') return true;
  return error.code === 'DURABLE_WRITE_FAILED' || error.code === 'REVISION_CONFLICT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
