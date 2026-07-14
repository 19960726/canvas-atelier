import { basename, join } from 'node:path';

import { parseCanvasProject, projectTransactionSchema, type CanvasProject } from '@agent-canvas/domain';

import { canonicalJson, sha256Canonical } from './canonical-json.js';
import {
  PROJECT_FORMAT_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  type BridgeSessionSummary,
  type CloseProjectBridgeRequest,
  type CommitAck,
  type CommitBridgeRequest,
  type ExportPackBridgeRequest,
  type ExportPackBridgeResult,
  type ImportPackBridgeRequest,
  type ImportPackBridgeResult,
  type OpenProjectBridgeRequest,
  type OpenProjectBridgeResult,
  type PersistenceChannel,
  type ProjectManifest,
  type RecoveryCandidateBridgeSummary,
  type RecoveryPlanBridgeRequest,
  type RecoveryPlanBridgeResult,
  type RestoreBridgeRequest,
  type RestoreBridgeResult,
  type SnapshotEnvelope,
  type StablePointBridgeRequest,
  type StablePointBridgeResult,
} from './contracts.js';
import { NodeFileSystem, type FileSystem, writeAtomic } from './file-system.js';
import { createPersistenceError, releaseJournalState } from './journal-writer.js';
import {
  NovusPackExporter,
  NovusPackImporter,
  type NovusPackExportResult,
  type NovusPackImportResult,
} from './novus-pack.js';
import {
  type OpenedProjectSession,
  ProjectRepository,
} from './project-repository.js';
import {
  RecoveryScanner,
  type RecoveryCandidate,
  type RecoveryScanResult,
} from './recovery-scanner.js';
import {
  SnapshotScheduler,
  type SnapshotFlushResult,
} from './snapshot-scheduler.js';
import { BRIDGE_CHANNELS } from './preload-api.js';

interface BridgeWriter {
  commit(request: Omit<CommitBridgeRequest, 'sessionId'>): Promise<CommitAck>;
}

interface ProjectRepositoryLike {
  close(session: OpenedProjectSession): Promise<void>;
  open(root: string, options: { mode: 'write' | 'read_only' }): Promise<OpenedProjectSession>;
  openJournalWriter(session: OpenedProjectSession): Promise<BridgeWriter>;
  readCurrentProject(session: OpenedProjectSession): Promise<CanvasProject>;
}

interface SnapshotSchedulerLike {
  flush(
    session: OpenedProjectSession,
    request: { reason: 'stable_point' },
  ): Promise<SnapshotFlushResult>;
}

interface RecoveryScannerLike {
  scan(projectRoot: string): Promise<RecoveryScanResult>;
}

interface NovusPackExporterLike {
  exportRevision(projectRoot: string, destinationPath: string): Promise<NovusPackExportResult>;
}

interface NovusPackImporterLike {
  importTo(packagePath: string, destinationRoot: string): Promise<NovusPackImportResult>;
}

export interface BridgeDialogAdapter {
  chooseImportDestination(): Promise<string | null>;
  chooseImportPackSource(): Promise<string | null>;
  choosePackExportPath(session: BridgeSessionSummary): Promise<string | null>;
  chooseProjectRoot(request: OpenProjectBridgeRequest): Promise<string | null>;
}

export interface DesktopBridgeHandlerDependencies {
  readonly appDataRoot?: string;
  readonly channel?: PersistenceChannel;
  readonly createId?: () => string;
  readonly dialogs?: Partial<BridgeDialogAdapter>;
  readonly fileSystem?: FileSystem;
  readonly importerIsolationRoot?: string;
  readonly packExporter?: NovusPackExporterLike;
  readonly packImporter?: NovusPackImporterLike;
  readonly recoveryScanner?: RecoveryScannerLike;
  readonly repository?: Partial<ProjectRepositoryLike>;
  readonly snapshotScheduler?: SnapshotSchedulerLike;
}

export interface DesktopBridgeHandlers {
  closeProject(event: unknown, request: unknown): Promise<void>;
  commit(event: unknown, request: unknown): Promise<CommitAck>;
  createStablePoint(event: unknown, request: unknown): Promise<StablePointBridgeResult>;
  exportPack(event: unknown, request: unknown): Promise<ExportPackBridgeResult | null>;
  getRecoveryPlan(event: unknown, request: unknown): Promise<RecoveryPlanBridgeResult>;
  importPack(event: unknown, request: unknown): Promise<ImportPackBridgeResult | null>;
  openProject(event: unknown, request: unknown): Promise<OpenProjectBridgeResult | null>;
  restore(event: unknown, request: unknown): Promise<RestoreBridgeResult>;
}

export interface DesktopIpcMainLike {
  handle(channel: string, listener: (event: unknown, request: unknown) => Promise<unknown>): void;
}

interface BridgeSessionContext {
  session: OpenedProjectSession;
  sessionId: string;
  recoveryCandidatePaths: Map<string, string>;
  writer: BridgeWriter | null;
}

interface RecoveryCandidateMirror {
  readonly project: Record<string, unknown>;
  readonly projectId: string;
  readonly revision: number;
  readonly snapshotId: string;
}

const PROJECT_MANIFEST_PATH = 'project.novus.json';
const ACTIVE_JOURNAL_SEGMENT = 'journal/active.ndjson';

export function createDesktopBridgeHandlers(
  dependencies: DesktopBridgeHandlerDependencies = {},
): DesktopBridgeHandlers {
  const fileSystem = dependencies.fileSystem ?? new NodeFileSystem();
  const createId = dependencies.createId ?? defaultId;
  const dialogs = withDialogDefaults(dependencies.dialogs);
  const repository = withRepositoryDefaults(dependencies.repository, {
    channel: dependencies.channel ?? 'modern',
    fileSystem,
  });
  const snapshotScheduler = dependencies.snapshotScheduler ?? new SnapshotScheduler({ fileSystem });
  const recoveryScanner = dependencies.recoveryScanner ?? new RecoveryScanner({
    appDataRoot: dependencies.appDataRoot ?? process.cwd(),
    createId,
    fileSystem,
  });
  const packExporter = dependencies.packExporter ?? new NovusPackExporter();
  const packImporter = dependencies.packImporter ?? new NovusPackImporter({
    isolationRoot: dependencies.importerIsolationRoot,
  });
  const sessions = new Map<string, BridgeSessionContext>();

  async function openProject(_event: unknown, request: unknown): Promise<OpenProjectBridgeResult | null> {
    const validated = validateOpenProjectBridgeRequest(request);
    const root = await dialogs.chooseProjectRoot(validated);
    if (root === null) {
      return null;
    }

    const opened = await requireMethod(repository, 'open')(root, { mode: validated.mode });
    const writer = opened.mode === 'write'
      ? await requireMethod(repository, 'openJournalWriter')(opened)
      : null;
    const sessionId = createId();
    sessions.set(sessionId, {
      recoveryCandidatePaths: new Map(),
      session: opened,
      sessionId,
      writer,
    });

    return summarizeSession(repository, sessionId, opened);
  }

  async function commit(_event: unknown, request: unknown): Promise<CommitAck> {
    const validated = validateCommitBridgeRequest(request);
    const session = requireSession(sessions, validated.sessionId);
    if (session.writer === null) {
      throw createPersistenceError(
        'CONCURRENT_WRITER',
        true,
        'Commit requires a writable desktop session',
      );
    }

    return session.writer.commit({
      baseRevision: validated.baseRevision,
      kind: validated.kind,
      projectId: validated.projectId,
      transaction: validated.transaction,
    });
  }

  async function createStablePoint(
    _event: unknown,
    request: unknown,
  ): Promise<StablePointBridgeResult> {
    const validated = validateSessionRequest(request);
    const session = requireWritableSession(sessions, validated.sessionId);
    const flushed = await snapshotScheduler.flush(session.session, { reason: 'stable_point' });
    session.session = await refreshSessionManifest(fileSystem, session.session);
    return {
      path: flushed.path,
      reason: 'stable_point',
      revision: flushed.revision,
      snapshotId: flushed.snapshotId,
    };
  }

  async function getRecoveryPlan(
    _event: unknown,
    request: unknown,
  ): Promise<RecoveryPlanBridgeResult> {
    const validated = validateSessionRequest(request);
    const session = requireSession(sessions, validated.sessionId);
    const scan = await recoveryScanner.scan(session.session.root);
    session.recoveryCandidatePaths.clear();
    return sanitizeRecoveryPlan(scan, session.recoveryCandidatePaths, createId);
  }

  async function restore(_event: unknown, request: unknown): Promise<RestoreBridgeResult> {
    const validated = validateRestoreBridgeRequest(request);
    const session = requireWritableSession(sessions, validated.sessionId);
    const plan = await getRecoveryPlan({}, { sessionId: validated.sessionId });
    const candidateSummary = selectRecoveryCandidate(plan, validated.candidateId);
    const mirrorPath = session.recoveryCandidatePaths.get(candidateSummary.candidateId);
    if (mirrorPath === undefined) {
      throw createPersistenceError('INVALID_REQUEST', false, 'Restore candidate is unavailable');
    }

    const restoredManifest = await restoreRecoveryCandidate(fileSystem, createId, session, mirrorPath);
    session.session = {
      ...session.session,
      manifest: restoredManifest,
    };
    if (session.writer !== null) {
      releaseJournalState(join(session.session.root, ...ACTIVE_JOURNAL_SEGMENT.split('/')), session.session.manifest.projectId);
      session.writer = await requireMethod(repository, 'openJournalWriter')(session.session);
    }

    return {
      ...await summarizeSession(repository, session.sessionId, session.session),
      restoredRevision: restoredManifest.stableSnapshotRevision,
    };
  }

  async function exportPack(
    _event: unknown,
    request: unknown,
  ): Promise<ExportPackBridgeResult | null> {
    const validated = validateSessionRequest(request);
    const session = requireSession(sessions, validated.sessionId);
    if (session.session.mode === 'write') {
      await createStablePoint({}, { sessionId: validated.sessionId });
    }

    const destinationPath = await dialogs.choosePackExportPath(
      await summarizeSession(repository, session.sessionId, session.session),
    );
    if (destinationPath === null) {
      return null;
    }

    const result = await packExporter.exportRevision(session.session.root, destinationPath);
    return {
      inventory: result.inventory,
      packageName: basename(result.packagePath),
      pinnedRevision: result.pinnedRevision,
    };
  }

  async function importPack(
    _event: unknown,
    request: unknown,
  ): Promise<ImportPackBridgeResult | null> {
    const validated = validateImportPackBridgeRequest(request);
    const packagePath = await dialogs.chooseImportPackSource();
    if (packagePath === null) {
      return null;
    }
    const destinationRoot = await dialogs.chooseImportDestination();
    if (destinationRoot === null) {
      return null;
    }

    const result = await packImporter.importTo(packagePath, destinationRoot);
    const opened = await requireMethod(repository, 'open')(result.projectRoot, { mode: validated.mode });
    const writer = opened.mode === 'write'
      ? await requireMethod(repository, 'openJournalWriter')(opened)
      : null;
    const sessionId = createId();
    sessions.set(sessionId, {
      recoveryCandidatePaths: new Map(),
      session: opened,
      sessionId,
      writer,
    });

    return {
      ...await summarizeSession(repository, sessionId, opened),
      importedRevision: result.importedRevision,
    };
  }

  async function closeProject(_event: unknown, request: unknown): Promise<void> {
    const validated = validateSessionRequest(request);
    const session = requireSession(sessions, validated.sessionId);
    sessions.delete(validated.sessionId);
    await requireMethod(repository, 'close')(session.session);
  }

  return {
    closeProject,
    commit,
    createStablePoint,
    exportPack,
    getRecoveryPlan,
    importPack,
    openProject,
    restore,
  };
}

export function registerDesktopBridgeHandlers(
  ipcMain: DesktopIpcMainLike,
  handlers: DesktopBridgeHandlers,
): void {
  ipcMain.handle(BRIDGE_CHANNELS.openProject, handlers.openProject);
  ipcMain.handle(BRIDGE_CHANNELS.commit, handlers.commit);
  ipcMain.handle(BRIDGE_CHANNELS.createStablePoint, handlers.createStablePoint);
  ipcMain.handle(BRIDGE_CHANNELS.restore, handlers.restore);
  ipcMain.handle(BRIDGE_CHANNELS.exportPack, handlers.exportPack);
  ipcMain.handle(BRIDGE_CHANNELS.importPack, handlers.importPack);
  ipcMain.handle(BRIDGE_CHANNELS.closeProject, handlers.closeProject);
  ipcMain.handle(BRIDGE_CHANNELS.getRecoveryPlan, handlers.getRecoveryPlan);
}

function withDialogDefaults(dialogs: Partial<BridgeDialogAdapter> | undefined): BridgeDialogAdapter {
  return {
    chooseImportDestination: dialogs?.chooseImportDestination ?? (async () => null),
    chooseImportPackSource: dialogs?.chooseImportPackSource ?? (async () => null),
    choosePackExportPath: dialogs?.choosePackExportPath ?? (async () => null),
    chooseProjectRoot: dialogs?.chooseProjectRoot ?? (async () => null),
  };
}

function withRepositoryDefaults(
  repository: Partial<ProjectRepositoryLike> | undefined,
  options: { readonly channel: PersistenceChannel; readonly fileSystem: FileSystem },
): ProjectRepositoryLike {
  if (repository?.open !== undefined && repository.close !== undefined && repository.openJournalWriter !== undefined) {
    return repository as ProjectRepositoryLike;
  }

  const fallback = new ProjectRepository({
    channel: options.channel,
    fileSystem: options.fileSystem,
  });
  return {
    close: repository?.close ?? ((session) => fallback.close(session)),
    open: repository?.open ?? ((root, openOptions) => fallback.open(root, openOptions)),
    openJournalWriter: repository?.openJournalWriter ?? ((session) => fallback.openJournalWriter(session)),
    readCurrentProject: repository?.readCurrentProject ?? ((session) => fallback.readCurrentProject(session)),
  };
}

async function summarizeSession(
  repository: ProjectRepositoryLike,
  sessionId: string,
  session: OpenedProjectSession,
): Promise<BridgeSessionSummary> {
  return {
    mode: session.mode,
    project: await repository.readCurrentProject(session),
    projectId: session.manifest.projectId,
    projectName: session.manifest.projectName,
    sessionId,
    stableSnapshotId: session.manifest.stableSnapshotId,
    stableSnapshotRevision: session.manifest.stableSnapshotRevision,
  };
}

function requireSession(
  sessions: Map<string, BridgeSessionContext>,
  sessionId: string,
): BridgeSessionContext {
  const session = sessions.get(sessionId);
  if (session === undefined) {
    throw createPersistenceError('INVALID_SESSION', false, 'Desktop session is not active');
  }
  return session;
}

function requireWritableSession(
  sessions: Map<string, BridgeSessionContext>,
  sessionId: string,
): BridgeSessionContext {
  const session = requireSession(sessions, sessionId);
  if (session.session.mode !== 'write') {
    throw createPersistenceError(
      'CONCURRENT_WRITER',
      true,
      'Desktop session is read-only',
    );
  }
  return session;
}

function sanitizeRecoveryPlan(
  scan: RecoveryScanResult,
  candidatePaths: Map<string, string>,
  createId: () => string,
): RecoveryPlanBridgeResult {
  const candidates = scan.candidates.map((candidate) => sanitizeRecoveryCandidate(candidate, candidatePaths, createId));
  return {
    action: scan.action,
    candidates,
    issues: scan.issues,
    projectId: scan.projectId,
    recoveredRevision: scan.recoveredRevision,
    stableSnapshotId: scan.stableSnapshotId,
    targetRevision: scan.targetRevision,
  };
}

function sanitizeRecoveryCandidate(
  candidate: RecoveryCandidate,
  candidatePaths: Map<string, string>,
  createId: () => string,
): RecoveryCandidateBridgeSummary {
  const candidateId = createId();
  candidatePaths.set(candidateId, candidate.path);
  return {
    candidateId,
    revision: candidate.revision,
    snapshotId: candidate.snapshotId,
    tailStatus: candidate.tailStatus,
  };
}

function selectRecoveryCandidate(
  plan: RecoveryPlanBridgeResult,
  candidateId: string | undefined,
): RecoveryCandidateBridgeSummary {
  if (candidateId !== undefined) {
    const selected = plan.candidates.find((candidate) => candidate.candidateId === candidateId);
    if (selected === undefined) {
      throw createPersistenceError('INVALID_REQUEST', false, 'Restore candidate id is invalid');
    }
    return selected;
  }

  const selected = plan.candidates.find((candidate) => candidate.revision === plan.targetRevision)
    ?? plan.candidates[0];
  if (selected === undefined) {
    throw createPersistenceError('INVALID_REQUEST', false, 'Recovery candidate is unavailable');
  }
  return selected;
}

async function restoreRecoveryCandidate(
  fileSystem: FileSystem,
  createId: () => string,
  session: BridgeSessionContext,
  mirrorPath: string,
): Promise<ProjectManifest> {
  const manifest = await readProjectManifest(fileSystem, session.session.root);
  const candidate = parseRecoveryCandidateMirror(
    JSON.parse(await fileSystem.readFile(mirrorPath, 'utf8')) as unknown,
    manifest.projectId,
  );
  const snapshotId = `restored-${candidate.revision}-${createId()}`;
  const snapshotPath = `snapshots/${snapshotId}.json`;
  const envelope: SnapshotEnvelope = {
    createdAt: new Date().toISOString(),
    previousSnapshotId: manifest.stableSnapshotId,
    project: candidate.project,
    projectId: manifest.projectId,
    projectSha256: sha256Canonical(candidate.project),
    revision: candidate.revision,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId,
  };
  await writeAtomic(
    fileSystem,
    join(session.session.root, ...snapshotPath.split('/')),
    `${canonicalJson(envelope)}\n`,
  );
  await writeAtomic(fileSystem, join(session.session.root, ...ACTIVE_JOURNAL_SEGMENT.split('/')), '');
  const nextManifest: ProjectManifest = {
    ...manifest,
    cleanClose: false,
    formatVersion: PROJECT_FORMAT_VERSION,
    nextSequence: candidate.revision + 1,
    stableSnapshotId: snapshotId,
    stableSnapshotPath: snapshotPath,
    stableSnapshotRevision: candidate.revision,
  };
  await writeAtomic(
    fileSystem,
    join(session.session.root, PROJECT_MANIFEST_PATH),
    `${canonicalJson(nextManifest)}\n`,
  );
  return nextManifest;
}

async function refreshSessionManifest(
  fileSystem: FileSystem,
  session: OpenedProjectSession,
): Promise<OpenedProjectSession> {
  return {
    ...session,
    manifest: await readProjectManifest(fileSystem, session.root),
  };
}

async function readProjectManifest(fileSystem: FileSystem, root: string): Promise<ProjectManifest> {
  return JSON.parse(await fileSystem.readFile(join(root, PROJECT_MANIFEST_PATH), 'utf8')) as ProjectManifest;
}

function parseRecoveryCandidateMirror(value: unknown, projectId: string): RecoveryCandidateMirror {
  const record = expectPlainRecord(value);
  const revision = record.revision;
  const snapshotId = record.snapshotId;
  const project = record.project;
  if (
    record.projectId !== projectId ||
    typeof revision !== 'number' ||
    !Number.isInteger(revision) ||
    revision < 0 ||
    typeof snapshotId !== 'string' ||
    !isPlainRecord(project)
  ) {
    throw createPersistenceError('INVALID_REQUEST', false, 'Recovery candidate payload is invalid');
  }

  parseCanvasProject(project);
  return {
    project,
    projectId,
    revision,
    snapshotId,
  };
}

function validateOpenProjectBridgeRequest(value: unknown): OpenProjectBridgeRequest {
  const record = expectPlainRecord(value);
  return {
    mode: parseMode(record.mode),
  };
}

function validateCommitBridgeRequest(value: unknown): CommitBridgeRequest {
  const record = expectPlainRecord(value);
  return {
    baseRevision: parseNonNegativeInteger(record.baseRevision, 'baseRevision'),
    kind: parseTransactionKind(record.kind),
    projectId: parseNonEmptyString(record.projectId, 'projectId'),
    sessionId: parseNonEmptyString(record.sessionId, 'sessionId'),
    transaction: projectTransactionSchema.parse(record.transaction),
  };
}

function validateImportPackBridgeRequest(value: unknown): ImportPackBridgeRequest {
  const record = expectPlainRecord(value);
  return {
    mode: parseMode(record.mode),
  };
}

function validateRestoreBridgeRequest(value: unknown): RestoreBridgeRequest {
  const record = expectPlainRecord(value);
  return {
    candidateId: record.candidateId === undefined
      ? undefined
      : parseNonEmptyString(record.candidateId, 'candidateId'),
    sessionId: parseNonEmptyString(record.sessionId, 'sessionId'),
  };
}

function validateSessionRequest(
  value: unknown,
): CloseProjectBridgeRequest | ExportPackBridgeRequest | RecoveryPlanBridgeRequest | StablePointBridgeRequest {
  const record = expectPlainRecord(value);
  return {
    sessionId: parseNonEmptyString(record.sessionId, 'sessionId'),
  };
}

function parseMode(value: unknown): 'write' | 'read_only' {
  if (value === 'write' || value === 'read_only') {
    return value;
  }
  throw createPersistenceError('INVALID_REQUEST', false, 'Mode must be write or read_only');
}

function parseTransactionKind(value: unknown): 'canvas' | 'agent' | 'system' {
  if (value === 'canvas' || value === 'agent' || value === 'system') {
    return value;
  }
  throw createPersistenceError('INVALID_REQUEST', false, 'Transaction kind is invalid');
}

function parseNonNegativeInteger(value: unknown, fieldName: string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  throw createPersistenceError('INVALID_REQUEST', false, `${fieldName} must be a non-negative integer`);
}

function parseNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  throw createPersistenceError('INVALID_REQUEST', false, `${fieldName} must be a non-empty string`);
}

function expectPlainRecord(value: unknown): Record<string, unknown> {
  if (isPlainRecord(value)) {
    return value;
  }
  throw createPersistenceError('INVALID_REQUEST', false, 'Request payload must be an object');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function requireMethod<TObject extends object, TKey extends keyof TObject>(
  value: TObject,
  key: TKey,
): NonNullable<TObject[TKey]> {
  const candidate = value[key];
  if (candidate === undefined || candidate === null) {
    throw new Error(`Desktop bridge dependency is missing ${String(key)}`);
  }
  return candidate as NonNullable<TObject[TKey]>;
}

function defaultId(): string {
  return `desktop-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
