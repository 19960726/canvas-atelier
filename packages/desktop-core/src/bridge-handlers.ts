import { createReadStream } from 'node:fs';
import { basename, extname, join } from 'node:path';

import {
  parseCanvasProject,
  applyProjectTransaction,
  containsProtectedRendererPayload,
  MAX_GENERATION_REFERENCES,
  projectImageAssetSchema,
  projectTransactionSchema,
  createSkillPromotionCandidateFingerprint,
  reviewSkillPromotionCandidate,
  rollbackSkillPromotionCandidate,
  skillPromotionCandidateSchema,
  type CanvasProject,
  type ProjectImageAsset,
  type ProjectTransaction,
  type PlacementObject,
  type ReferenceRole,
  type SkillPromotionCandidate,
} from '@agent-canvas/domain';
import {
  buildSkillPromotionCandidate,
  KnowledgeSnapshotRegistry,
  SkillKnowledgePromotionService,
  SkillWritebackService,
  type KnowledgeBaseStateSummary,
  type KnowledgeSnapshot,
  type KnowledgeSnapshotCandidate,
} from '@agent-canvas/skill-store';

import { canonicalJson, sha256Canonical } from './canonical-json.js';
import {
  PROJECT_FORMAT_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  type BridgeSessionSummary,
  type CloseProjectBridgeRequest,
  type CommitAck,
  type CommitBridgeRequest,
  type ConfigureKnowledgeBaseBridgeRequest,
  type ExportPackBridgeRequest,
  type ExportPackBridgeResult,
  type ImportPackBridgeRequest,
  type ImportPackBridgeResult,
  type ImportProjectImageBridgeRequest,
  type ImportProjectImageBridgeResult,
  type KnowledgeStateBridgeResult,
  type KnowledgeSyncStatusSummary,
  type ListProjectImagesBridgeRequest,
  type OpenProjectBridgeRequest,
  type OpenProjectBridgeResult,
  type PrepareSkillCandidateReviewBridgeRequest,
  type PrepareSkillCandidateReviewBridgeResult,
  type PersistenceChannel,
  type PersistenceError,
  type ProjectManifest,
  type ProjectImageAssetSummary,
  type ProjectImageImportTarget,
  type RecoveryCandidateBridgeSummary,
  type RecoveryPlanBridgeRequest,
  type RecoveryPlanBridgeResult,
  type ReviewSkillCandidateBridgeRequest,
  type ReviewSkillCandidateBridgeResult,
  type RestoreBridgeRequest,
  type RestoreBridgeResult,
  type SkillCandidatePreparedManagedSnapshot,
  type SnapshotEnvelope,
  type StablePointBridgeRequest,
  type StablePointBridgeResult,
} from './contracts.js';
import { AssetStore, type AssetMetadata } from './asset-store.js';
import { NodeFileSystem, type FileSystem, writeAtomic } from './file-system.js';
import { createPersistenceError, releaseJournalState, writeInitialJournalCommitBoundary } from './journal-writer.js';
import { KnowledgeRefreshService } from './knowledge-refresh-service.js';
import {
  type ConfigureKnowledgeRoot,
  type ConfiguredKnowledgeBase,
  ManagedKnowledgeStore,
  type StageApprovedSnapshotMetadata,
  type StageRollbackMetadata,
  type StagedKnowledgeTransitionSummary,
} from './managed-knowledge-store.js';
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
  type SnapshotReason,
} from './snapshot-scheduler.js';
import { BRIDGE_CHANNELS } from './preload-api.js';
import { createProjectAssetDisplayUrl, parseProjectAssetDisplayUrl } from './project-asset-url.js';

interface BridgeWriter {
  commit(request: Omit<CommitBridgeRequest, 'sessionId'>): Promise<CommitAck>;
}

interface ProjectRepositoryLike {
  close(session: OpenedProjectSession): Promise<void>;
  open(root: string, options: { mode: 'write' | 'read_only' }): Promise<OpenedProjectSession>;
  openJournalWriter(session: OpenedProjectSession): Promise<BridgeWriter>;
  readCurrentProject(session: OpenedProjectSession): Promise<CanvasProject>;
  readCurrentRevision?(session: OpenedProjectSession): Promise<number>;
}

interface ProjectAssetStoreLike {
  list(projectRoot: string, catalog?: readonly ProjectImageAsset[]): Promise<AssetMetadata[]>;
  resolvePath(
    projectRoot: string,
    assetId: string,
    extension: ProjectImageAsset['extension'],
    sha256: string,
    byteSize: number,
  ): Promise<string | null>;
  stageAndCommit(
    projectRoot: string,
    source: NodeJS.ReadableStream,
    options: {
      readonly commitReference?: (asset: AssetMetadata) => Promise<void>;
      readonly maxBytes?: number;
      readonly originalName?: string;
    },
  ): Promise<AssetMetadata>;
}

interface SnapshotSchedulerLike {
  consider?(
    session: Pick<OpenedProjectSession, 'root'>,
    event: {
      readonly activeJournalBytes: number;
      readonly closing?: boolean;
      readonly idleMs?: number;
      readonly lastTransactionKind?: 'canvas' | 'agent' | 'system';
      readonly pendingChanges: boolean;
      readonly stablePoint?: boolean;
      readonly transactionCount: number;
    },
  ): { readonly reason: SnapshotReason } | null;
  flush(
    session: OpenedProjectSession,
    request: { reason: SnapshotReason },
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

interface KnowledgeStoreLike {
  configure(input: ConfigureKnowledgeRoot): Promise<ConfiguredKnowledgeBase>;
  activateStagedTransition?(stageId: string): Promise<KnowledgeBaseStateSummary>;
  discardStagedTransition?(
    stageId: string,
    reason: 'commit_not_acknowledged' | 'unacknowledged_project_transaction' | 'superseded_project_transaction',
  ): Promise<void>;
  finalizeStagedTransition?(stageId: string): Promise<void>;
  recordStagedTransitionOutboxIntent?(stageId: string): Promise<void>;
  listStates(): Promise<KnowledgeBaseStateSummary[]>;
  listStagedKnowledgeTransitions?(): Promise<StagedKnowledgeTransitionSummary[]>;
  publish?(snapshot: KnowledgeSnapshot): Promise<void>;
  readActive(knowledgeBaseId: string): Promise<KnowledgeSnapshot | null>;
  readVersion?(knowledgeBaseId: string, version: number): Promise<KnowledgeSnapshot | null>;
  rollback?(knowledgeBaseId: string, version: number): Promise<KnowledgeBaseStateSummary>;
  stageApprovedSnapshot?(
    candidate: KnowledgeSnapshotCandidate,
    metadata: StageApprovedSnapshotMetadata,
  ): Promise<{ stageId: string; snapshot: KnowledgeSnapshot }>;
  stageRollback?(
    input: { knowledgeBaseId: string; targetVersion: number },
    metadata: StageRollbackMetadata,
  ): Promise<{ stageId: string; targetVersion: number }>;
}

interface KnowledgeRefreshServiceLike {
  refreshNow(knowledgeBaseId: string): Promise<KnowledgeBaseStateSummary>;
  start(knowledgeBaseIds: string[]): Promise<void>;
  stop(): Promise<void>;
  subscribe(listener: (state: KnowledgeBaseStateSummary) => void): () => void;
}

interface ApprovedSnapshotOutboxLike {
  enqueueApprovedSnapshot(snapshot: KnowledgeSnapshot): Promise<void>;
}

interface KnowledgeSyncStatusProviderLike {
  listSyncStatuses(): readonly KnowledgeSyncStatusSummary[];
}

interface KnowledgeConfigurationSyncLike {
  updateConfiguredKnowledgeBases(knowledgeBaseIds: string[]): Promise<void>;
}

export interface BridgeDialogAdapter {
  chooseImportDestination(): Promise<string | null>;
  chooseImportPackSource(): Promise<string | null>;
  chooseKnowledgeRoot(request: ConfigureKnowledgeBaseBridgeRequest): Promise<string | null>;
  choosePackExportPath(session: BridgeSessionSummary): Promise<string | null>;
  chooseProjectImage(): Promise<string | null>;
  chooseProjectRoot(request: OpenProjectBridgeRequest): Promise<string | null>;
}

export interface DesktopBridgeHandlerDependencies {
  readonly appDataRoot?: string;
  readonly channel?: PersistenceChannel;
  readonly createId?: () => string;
  readonly dialogs?: Partial<BridgeDialogAdapter>;
  readonly fileSystem?: FileSystem;
  readonly importerIsolationRoot?: string;
  readonly approvedSnapshotOutbox?: ApprovedSnapshotOutboxLike;
  readonly assetStore?: ProjectAssetStoreLike;
  readonly knowledgeConfigurationSync?: KnowledgeConfigurationSyncLike;
  readonly knowledgeRefreshService?: KnowledgeRefreshServiceLike;
  readonly knowledgeStore?: KnowledgeStoreLike;
  readonly knowledgeSyncStatusProvider?: KnowledgeSyncStatusProviderLike;
  readonly packExporter?: NovusPackExporterLike;
  readonly packImporter?: NovusPackImporterLike;
  readonly recoveryScanner?: RecoveryScannerLike;
  readonly repository?: Partial<ProjectRepositoryLike>;
  readonly snapshotScheduler?: SnapshotSchedulerLike;
}

export interface DesktopBridgeHandlers {
  closeAllProjects(): Promise<void>;
  closeProject(event: unknown, request: unknown): Promise<void>;
  commit(event: unknown, request: unknown): Promise<CommitAck>;
  configureKnowledgeBase(event: unknown, request: unknown): Promise<KnowledgeBaseStateSummary | null>;
  createStablePoint(event: unknown, request: unknown): Promise<StablePointBridgeResult>;
  exportPack(event: unknown, request: unknown): Promise<ExportPackBridgeResult | null>;
  getKnowledgeState(event: unknown, request: unknown): Promise<KnowledgeStateBridgeResult>;
  getRecoveryPlan(event: unknown, request: unknown): Promise<RecoveryPlanBridgeResult>;
  importPack(event: unknown, request: unknown): Promise<ImportPackBridgeResult | null>;
  importProjectImage(event: unknown, request: unknown): Promise<ImportProjectImageBridgeResult | null>;
  listProjectImages(event: unknown, request: unknown): Promise<ProjectImageAssetSummary[]>;
  openProject(event: unknown, request: unknown): Promise<OpenProjectBridgeResult | null>;
  prepareSkillCandidateReview(event: unknown, request: unknown): Promise<PrepareSkillCandidateReviewBridgeResult>;
  reviewSkillCandidate(event: unknown, request: unknown): Promise<ReviewSkillCandidateBridgeResult>;
  restore(event: unknown, request: unknown): Promise<RestoreBridgeResult>;
  resolveProjectImagePath(displayUrl: string): Promise<string | null>;
}

export interface DesktopIpcMainLike {
  handle(channel: string, listener: (event: unknown, request: unknown) => Promise<unknown>): void;
}

interface BridgeSessionContext {
  assets: Map<string, ProjectImageAsset>;
  imageImportInFlight: boolean;
  session: OpenedProjectSession;
  sessionId: string;
  recoveryCandidatePaths: Map<string, string>;
  writer: BridgeWriter | null;
}

interface PreparedBridgeSkillReview {
  readonly candidate: SkillPromotionCandidate;
  readonly candidates: SkillPromotionCandidate[];
  readonly stagedTransitionId?: string;
  activateAfterAck(): Promise<{
    readonly approvedSnapshot?: KnowledgeSnapshot;
    readonly stagedTransitionId?: string;
    readonly knowledgeState: KnowledgeBaseStateSummary | null;
  }>;
}

interface BoundSkillReviewState {
  readonly active: KnowledgeSnapshot;
  readonly candidate: SkillPromotionCandidate;
  readonly project: CanvasProject;
  readonly revision: number;
}

interface RecoveryCandidateMirror {
  readonly project: Record<string, unknown>;
  readonly projectId: string;
  readonly revision: number;
  readonly snapshotId: string;
}

const PROJECT_MANIFEST_PATH = 'project.novus.json';
const ACTIVE_JOURNAL_SEGMENT = 'journal/active.ndjson';
const MAX_PROJECT_IMAGE_BYTES = 256 * 1024 * 1024;
type ImportableReferenceRole = Exclude<ReferenceRole, 'placement_preview'>;
const PROJECT_IMAGE_REFERENCE_LAYOUT: Record<
  ImportableReferenceRole,
  Pick<PlacementObject, 'x' | 'y' | 'w' | 'h' | 'zIndex' | 'semanticLayer'>
> = {
  product_identity: { x: 0.34, y: 0.42, w: 0.32, h: 0.38, zIndex: 30, semanticLayer: 'hero_product' },
  scene_composition: { x: 0, y: 0, w: 1, h: 1, zIndex: 0, semanticLayer: 'background' },
  prop_reference: { x: 0.66, y: 0.58, w: 0.18, h: 0.22, zIndex: 20, semanticLayer: 'optional_prop' },
  material_lighting: { x: 0.08, y: 0.7, w: 0.2, h: 0.2, zIndex: 10, semanticLayer: 'midground' },
};

export function createDesktopBridgeHandlers(
  dependencies: DesktopBridgeHandlerDependencies = {},
): DesktopBridgeHandlers {
  const fileSystem = dependencies.fileSystem ?? new NodeFileSystem();
  const assetStore = dependencies.assetStore ?? new AssetStore();
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
  const knowledgeStore = dependencies.knowledgeStore ?? new ManagedKnowledgeStore({
    appDataRoot: dependencies.appDataRoot ?? process.cwd(),
    fileSystem,
  });
  const approvedSnapshotOutbox = dependencies.approvedSnapshotOutbox ?? null;
  const knowledgeConfigurationSync = dependencies.knowledgeConfigurationSync ?? null;
  const knowledgeSyncStatusProvider = dependencies.knowledgeSyncStatusProvider ?? null;
  const knowledgeRefreshService = dependencies.knowledgeRefreshService ?? new KnowledgeRefreshService({
    fileSystem,
    store: knowledgeStore as ManagedKnowledgeStore,
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
    const summary = await summarizeSession(repository, sessionId, opened);
    sessions.set(sessionId, {
      assets: new Map((summary.project.assets ?? []).map((asset) => [asset.assetId, asset])),
      imageImportInFlight: false,
      recoveryCandidatePaths: new Map(),
      session: opened,
      sessionId,
      writer,
    });
    await reconcileStagedKnowledgeTransitionsForProject(opened);

    return summary;
  }

  async function commit(_event: unknown, request: unknown): Promise<CommitAck> {
    const validated = validateCommitBridgeRequest(request);
    if (validated.transaction.operations.some((operation) => operation.kind === 'set_project_assets')) {
      throw invalidRequest('Project assets can only be changed through the managed image bridge');
    }
    const session = requireSession(sessions, validated.sessionId);
    if (session.writer === null) {
      throw createPersistenceError(
        'CONCURRENT_WRITER',
        true,
        'Commit requires a writable desktop session',
      );
    }
    assertPublicBridgePayload(validated.transaction);
    const currentProject = await repository.readCurrentProject(session.session);
    try {
      applyProjectTransaction(currentProject, validated.transaction);
    } catch {
      throw invalidRequest('Commit transaction is invalid for the current project');
    }

    const ack = await session.writer.commit({
      baseRevision: validated.baseRevision,
      kind: validated.kind,
      projectId: validated.projectId,
      transaction: validated.transaction,
    });
    await flushScheduledSnapshotAfterCommit(session, ack, validated.kind);
    return ack;
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

    const summary = await summarizeSession(repository, session.sessionId, session.session);
    session.assets = new Map((summary.project.assets ?? []).map((asset) => [asset.assetId, asset]));
    return {
      ...summary,
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
    const summary = await summarizeSession(repository, sessionId, opened);
    sessions.set(sessionId, {
      assets: new Map((summary.project.assets ?? []).map((asset) => [asset.assetId, asset])),
      imageImportInFlight: false,
      recoveryCandidatePaths: new Map(),
      session: opened,
      sessionId,
      writer,
    });
    await reconcileStagedKnowledgeTransitionsForProject(opened);

    return {
      ...summary,
      importedRevision: result.importedRevision,
    };
  }

  async function importProjectImage(
    _event: unknown,
    request: unknown,
  ): Promise<ImportProjectImageBridgeResult | null> {
    const validated = validateImportProjectImageBridgeRequest(request);
    const session = requireWritableSession(sessions, validated.sessionId);
    if (session.writer === null) {
      throw createPersistenceError('CONCURRENT_WRITER', true, 'Image import requires a writable desktop session');
    }
    if (session.imageImportInFlight) {
      throw invalidRequest('A project image import is already in progress');
    }
    session.imageImportInFlight = true;
    try {
      await validateProjectImageTarget(repository, session, validated.target);
      const sourcePath = await dialogs.chooseProjectImage();
      if (sourcePath === null) return null;

      const commitState: {
        value?: { readonly ack: CommitAck; readonly asset: ProjectImageAsset; readonly project: CanvasProject };
      } = {};
      await assetStore.stageAndCommit(session.session.root, createReadStream(sourcePath), {
        maxBytes: MAX_PROJECT_IMAGE_BYTES,
        originalName: basename(sourcePath),
        commitReference: async (storedAsset) => {
          const currentProject = await repository.readCurrentProject(session.session);
          const currentRevision = await readCurrentRevision(repository, session.session);
          const projectAsset = createImportedProjectImageAsset(storedAsset, sourcePath);
          const transaction = createProjectImageImportTransaction(
            currentProject,
            validated.target,
            projectAsset,
            createId,
          );
          const nextProject = applyProjectTransaction(currentProject, transaction);
          const ack = await session.writer!.commit({
            baseRevision: currentRevision,
            kind: 'canvas',
            projectId: currentProject.id,
            transaction,
          });
          commitState.value = { ack, asset: projectAsset, project: nextProject };
        },
      });

      const committed = commitState.value;
      if (committed === undefined) {
        throw invalidRequest('Image import did not reach its durable commit boundary');
      }
      session.assets.set(committed.asset.assetId, committed.asset);
      await flushScheduledSnapshotAfterCommit(session, committed.ack, 'canvas');
      const summary = createProjectImageSummary(
        committed.asset,
        session.sessionId,
        countProjectImageUsage(committed.project, committed.asset.assetId),
      );
      const result = {
        asset: summary,
        currentRevision: committed.ack.revision,
        project: committed.project,
      };
      assertPublicBridgePayload(result);
      return result;
    } finally {
      session.imageImportInFlight = false;
    }
  }

  async function listProjectImages(
    _event: unknown,
    request: unknown,
  ): Promise<ProjectImageAssetSummary[]> {
    const validated = validateListProjectImagesBridgeRequest(request);
    const session = requireSession(sessions, validated.sessionId);
    const project = await repository.readCurrentProject(session.session);
    const storedAssets = new Map((await assetStore.list(
      session.session.root,
      project.assets ?? [],
    )).map((asset) => [asset.id, asset]));
    const summaries = (project.assets ?? [])
      .filter((asset) => storedAssetMatchesProjectAsset(storedAssets.get(asset.assetId), asset))
      .map((asset) => createProjectImageSummary(
        asset,
        session.sessionId,
        countProjectImageUsage(project, asset.assetId),
      ));
    session.assets = new Map(summaries.map((asset) => [asset.assetId, asset]));
    assertPublicBridgePayload(summaries);
    return summaries;
  }

  async function resolveProjectImagePath(displayUrl: string): Promise<string | null> {
    const identity = parseProjectAssetDisplayUrl(displayUrl);
    if (identity === null) return null;
    const session = sessions.get(identity.sessionId);
    const asset = session?.assets.get(identity.assetId);
    if (session === undefined || asset === undefined) return null;
    return assetStore.resolvePath(
      session.session.root,
      identity.assetId,
      asset.extension,
      asset.sha256,
      asset.byteSize,
    );
  }

  async function configureKnowledgeBase(
    _event: unknown,
    request: unknown,
  ): Promise<KnowledgeBaseStateSummary | null> {
    const validated = validateConfigureKnowledgeBaseBridgeRequest(request);
    const rootPath = await dialogs.chooseKnowledgeRoot(validated);
    if (rootPath === null) {
      return null;
    }

    await knowledgeStore.configure({
      ...validated,
      rootPath,
    });
    const states = await knowledgeStore.listStates();
    const knowledgeBaseIds = states.map((state) => state.knowledgeBaseId);
    await knowledgeRefreshService.start(knowledgeBaseIds);
    const refreshed = await knowledgeRefreshService.refreshNow(validated.knowledgeBaseId);
    await knowledgeConfigurationSync?.updateConfiguredKnowledgeBases(knowledgeBaseIds);
    const authoritative = (await knowledgeStore.listStates())
      .find((state) => state.knowledgeBaseId === validated.knowledgeBaseId) ?? refreshed;
    return sanitizeKnowledgeSummary(authoritative);
  }

  async function getKnowledgeState(
    _event: unknown,
    _request: unknown,
  ): Promise<KnowledgeStateBridgeResult> {
    return {
      states: sanitizeKnowledgeSummaries(await knowledgeStore.listStates()),
      ...(knowledgeSyncStatusProvider === null ? {} : {
        syncStatuses: sanitizeKnowledgeSyncStatuses(knowledgeSyncStatusProvider.listSyncStatuses()),
      }),
    };
  }

  async function prepareSkillCandidateReview(
    _event: unknown,
    request: unknown,
  ): Promise<PrepareSkillCandidateReviewBridgeResult> {
    const validated = validatePrepareSkillCandidateReviewBridgeRequest(request);
    const session = requireSingleWritableProjectSession(sessions, validated.projectId);
    const baseRevision = await readCurrentRevision(repository, session.session);
    if (baseRevision !== validated.baseRevision) {
      throw staleSkillPreparation('Skill candidate preparation base revision is stale');
    }
    const project = await repository.readCurrentProject(session.session);
    if (project.id !== validated.projectId) {
      throw invalidRequest('Project is not active');
    }

    const candidate = requireCurrentPrepareCandidate(project, validated.candidateId, validated.candidateFingerprint);
    assertPublicBridgePayload(candidate);
    if (candidate.targetKnowledgeBaseId === undefined) {
      throw invalidRequest('Skill candidate preparation requires a target knowledge base');
    }

    const active = await knowledgeStore.readActive(candidate.targetKnowledgeBaseId);
    if (active === null) {
      throw invalidRequest('Active knowledge snapshot is unavailable');
    }
    const reviewableCandidate = buildReviewableSkillCandidate(project, candidate, active);
    if (reviewableCandidate === null || !reviewableCandidate.sourceRule || !reviewableCandidate.managedRule) {
      throw invalidRequest('Skill candidate source and managed rule text are unavailable');
    }
    const latestRevision = await readCurrentRevision(repository, session.session);
    if (latestRevision !== validated.baseRevision) {
      throw staleSkillPreparation('Skill candidate preparation revision changed before commit');
    }
    const latestProject = await repository.readCurrentProject(session.session);
    if (latestProject.id !== validated.projectId) {
      throw invalidRequest('Project is not active');
    }
    requireCurrentPrepareCandidate(latestProject, validated.candidateId, validated.candidateFingerprint);
    const reviewed = sanitizeSkillPromotionCandidate({
      ...reviewableCandidate,
      preparedManagedSnapshot: createPreparedManagedSnapshot(active),
      reviewPreparationStatus: 'ready',
    });
    const nextCandidates = latestProject.skillPromotionCandidates.map((item) => (
      item.id === reviewed.id ? reviewed : item
    )).map(sanitizeSkillPromotionCandidate);
    const transactionId = `prepare-skill-${candidate.id}-${Date.now()}`;
    const ack = await requireBridgeWriter(session).commit({
      baseRevision: validated.baseRevision,
      kind: 'system',
      projectId: validated.projectId,
      transaction: {
        id: transactionId,
        label: `Prepare skill candidate ${reviewed.id}`,
        operations: [{ kind: 'set_skill_candidates', candidates: nextCandidates }],
      },
    });
    await flushScheduledSnapshotAfterCommit(session, ack, 'system');
    const knowledgeState = sanitizeKnowledgeSummaries(await knowledgeStore.listStates())
      .find((state) => state.knowledgeBaseId === reviewed.targetKnowledgeBaseId) ?? null;
    return {
      candidate: reviewed,
      candidates: nextCandidates,
      currentRevision: ack.revision,
      knowledgeState,
      projectId: validated.projectId,
    };
  }

  async function reviewSkillCandidate(
    _event: unknown,
    request: unknown,
  ): Promise<ReviewSkillCandidateBridgeResult> {
    const validated = validateReviewSkillCandidateBridgeRequest(request);
    const session = requireSingleWritableProjectSession(sessions, validated.projectId);
    const initialState = validated.decision === 'rolled_back'
      ? null
      : await readBoundSkillReviewState(session, validated);
    const project = initialState?.project ?? await repository.readCurrentProject(session.session);
    if (project.id !== validated.projectId) {
      throw invalidRequest('Project is not active');
    }

    const candidate = initialState?.candidate ?? project.skillPromotionCandidates.find((item) => item.id === validated.candidateId);
    if (candidate === undefined) {
      throw invalidRequest('Skill candidate is unavailable');
    }
    assertPublicBridgePayload(candidate);

    const transactionId = `review-skill-${candidate.id}-${Date.now()}`;
    const latestState = validated.decision === 'rolled_back'
      ? null
      : await readBoundSkillReviewState(session, validated);
    const preparedReview = validated.decision === 'rolled_back'
      ? await prepareRollbackSkillCandidatesForBridge(project.skillPromotionCandidates, candidate, validated, transactionId)
      : await prepareSkillCandidateReviewForBridge(latestState!.project, latestState!.candidate, validated, transactionId, latestState!.active);
    const reviewed = sanitizeSkillPromotionCandidate(preparedReview.candidate);
    const nextCandidates = preparedReview.candidates.map(sanitizeSkillPromotionCandidate);
    const currentRevision = latestState?.revision ?? await readCurrentRevision(repository, session.session);
    let committedRevision: number;
    try {
      const ack = await requireBridgeWriter(session).commit({
        baseRevision: currentRevision,
        kind: 'system',
        projectId: validated.projectId,
        transaction: {
          id: transactionId,
          label: `Review skill candidate ${reviewed.id}`,
          operations: [{ kind: 'set_skill_candidates', candidates: nextCandidates }],
        },
      });
      committedRevision = ack.revision;
      await flushScheduledSnapshotAfterCommit(session, ack, 'system');
    } catch (commitError) {
      if (preparedReview.stagedTransitionId === undefined) {
        throw commitError;
      }
      let durableProject: CanvasProject;
      try {
        durableProject = await repository.readCurrentProject(session.session);
      } catch {
        throw commitError;
      }
      const durableCandidate = durableProject.skillPromotionCandidates.find((item) => item.id === reviewed.id);
      if (!isExactAcknowledgedReview(durableCandidate, reviewed, transactionId)) {
        await discardPreparedReviewAfterCommitFailure(preparedReview.stagedTransitionId);
        throw commitError;
      }
      try {
        committedRevision = await readCurrentRevision(repository, session.session);
      } catch {
        throw commitError;
      }
    }

    const activated = await completePreparedReviewAfterAck(preparedReview);
    const knowledgeState = activated.knowledgeState ?? (
      reviewed.targetKnowledgeBaseId === undefined
        ? null
        : sanitizeKnowledgeSummaries(await knowledgeStore.listStates())
          .find((state) => state.knowledgeBaseId === reviewed.targetKnowledgeBaseId) ?? null
    );

    return {
      candidate: sanitizeSkillPromotionCandidate(reviewed),
      candidates: nextCandidates.map(sanitizeSkillPromotionCandidate),
      currentRevision: committedRevision,
      knowledgeState,
      projectId: validated.projectId,
    };
  }

  async function discardPreparedReviewAfterCommitFailure(stageId: string): Promise<void> {
    try {
      await requireMethod(knowledgeStore, 'discardStagedTransition').call(
        knowledgeStore,
        stageId,
        'commit_not_acknowledged',
      );
    } catch {
      // Preserve the original commit boundary failure for the caller.
    }
  }
  async function completePreparedReviewAfterAck(
    preparedReview: PreparedBridgeSkillReview,
  ): Promise<Awaited<ReturnType<PreparedBridgeSkillReview['activateAfterAck']>>> {
    const activated = await preparedReview.activateAfterAck();
    if (activated.approvedSnapshot !== undefined) {
      if (approvedSnapshotOutbox === null) {
        throw invalidRequest('Approved snapshot outbox is unavailable');
      }
      await approvedSnapshotOutbox.enqueueApprovedSnapshot(activated.approvedSnapshot);
      if (activated.stagedTransitionId !== undefined) {
        await requireMethod(knowledgeStore, 'recordStagedTransitionOutboxIntent').call(knowledgeStore, activated.stagedTransitionId);
        await requireMethod(knowledgeStore, 'finalizeStagedTransition').call(knowledgeStore, activated.stagedTransitionId);
      }
    } else if (activated.stagedTransitionId !== undefined) {
      await requireMethod(knowledgeStore, 'finalizeStagedTransition').call(knowledgeStore, activated.stagedTransitionId);
    }
    return activated;
  }
  async function closeProject(_event: unknown, request: unknown): Promise<void> {
    const validated = validateSessionRequest(request);
    const session = requireSession(sessions, validated.sessionId);
    sessions.delete(validated.sessionId);
    await closeBridgeSession(session);
  }

  async function closeAllProjects(): Promise<void> {
    const activeSessions = [...sessions.values()];
    sessions.clear();
    for (const session of activeSessions) {
      await closeBridgeSession(session);
    }
    await knowledgeRefreshService.stop();
  }

  return {
    closeAllProjects,
    closeProject,
    commit,
    configureKnowledgeBase,
    createStablePoint,
    exportPack,
    getKnowledgeState,
    getRecoveryPlan,
    importPack,
    importProjectImage,
    listProjectImages,
    openProject,
    prepareSkillCandidateReview,
    reviewSkillCandidate,
    restore,
    resolveProjectImagePath,
  };

  async function closeBridgeSession(session: BridgeSessionContext): Promise<void> {
    if (session.session.mode === 'write') {
      await flushScheduledSnapshot(session, {
        closing: true,
        lastTransactionKind: undefined,
        stablePoint: false,
      });
    }
    await requireMethod(repository, 'close')(session.session);
  }

  async function flushScheduledSnapshotAfterCommit(
    session: BridgeSessionContext,
    ack: CommitAck,
    kind: 'canvas' | 'agent' | 'system',
  ): Promise<void> {
    await flushScheduledSnapshot(session, {
      closing: false,
      lastTransactionKind: kind,
      stablePoint: false,
      revision: ack.revision,
    });
  }

  async function flushScheduledSnapshot(
    session: BridgeSessionContext,
    options: {
      readonly closing: boolean;
      readonly lastTransactionKind?: 'canvas' | 'agent' | 'system';
      readonly revision?: number;
      readonly stablePoint: boolean;
    },
  ): Promise<void> {
    if (session.session.mode !== 'write') {
      return;
    }
    const currentRevision = options.revision ?? await readCurrentRevision(repository, session.session);
    const transactionCount = Math.max(0, currentRevision - session.session.manifest.stableSnapshotRevision);
    const activeJournalBytes = await readActiveJournalBytes(fileSystem, session.session);
    const pendingChanges = transactionCount > 0 || activeJournalBytes > 0;
    const decision = snapshotScheduler.consider?.(session.session, {
      activeJournalBytes,
      closing: options.closing,
      lastTransactionKind: options.lastTransactionKind,
      pendingChanges,
      stablePoint: options.stablePoint,
      transactionCount,
    }) ?? null;

    if (decision === null || (!pendingChanges && decision.reason !== 'close')) {
      return;
    }

    await snapshotScheduler.flush(session.session, { reason: decision.reason });
    session.session = await refreshSessionManifest(fileSystem, session.session);
  }

  async function prepareSkillCandidateReviewForBridge(
    project: CanvasProject,
    candidate: SkillPromotionCandidate,
    request: ReviewSkillCandidateBridgeRequest,
    transactionId: string,
    preparedActive?: KnowledgeSnapshot,
  ): Promise<PreparedBridgeSkillReview> {
    if (request.decision === 'rolled_back') {
      throw invalidRequest('Rollback must use the managed rollback flow');
    }

    if (request.decision !== 'approved') {
      const reviewed = reviewSkillPromotionCandidate(candidate, {
        decision: request.decision,
        reviewedAt: new Date().toISOString(),
        transactionId,
      });
      return {
        candidate: reviewed,
        candidates: project.skillPromotionCandidates.map((item) => item.id === reviewed.id ? reviewed : item),
        activateAfterAck: async () => ({ knowledgeState: null }),
      };
    }

    if (candidate.targetKnowledgeBaseId === undefined) {
      throw invalidRequest('Approved skill candidates require a target knowledge base');
    }
    const active = preparedActive ?? await knowledgeStore.readActive(candidate.targetKnowledgeBaseId);
    if (active === null) {
      throw invalidRequest('Active knowledge snapshot is unavailable');
    }
    const reviewableCandidate = buildReviewableSkillCandidate(project, candidate, active);
    if (reviewableCandidate === null || !reviewableCandidate.sourceRule || !reviewableCandidate.managedRule) {
      throw invalidRequest('Skill candidate source and managed rule text are unavailable');
    }

    try {
      const states = await knowledgeStore.listStates();
      const targetSnapshot = await prepareApprovedKnowledgeSnapshotCandidate(reviewableCandidate, active, states);
      const stagedAt = new Date().toISOString();
      const staged = knowledgeStore.stageApprovedSnapshot === undefined
        ? null
        : await knowledgeStore.stageApprovedSnapshot(targetSnapshot, {
          stageId: `knowledge-${transactionId}`,
          projectId: request.projectId,
          candidateId: reviewableCandidate.id,
          transactionId,
          expectedActiveVersion: active.version,
          expectedActiveContentHash: active.contentHash,
          sourceDeviceId: 'desktop-bridge',
          stagedAt,
        });
      const snapshot = staged?.snapshot ?? createLocallyVersionedApprovedSnapshot(
        targetSnapshot,
        active,
        states,
        stagedAt,
      );
      const reviewed = reviewSkillPromotionCandidate(reviewableCandidate, {
        decision: 'approved',
        reviewedAt: snapshot.publishedAt,
        publishedKnowledgeVersion: snapshot.version,
        transactionId,
      });
      return {
        candidate: reviewed,
        candidates: project.skillPromotionCandidates.map((item) => item.id === reviewed.id ? reviewed : item),
        ...(staged === null ? {} : { stagedTransitionId: staged.stageId }),
        activateAfterAck: async () => {
          const knowledgeState = staged === null
            ? await publishApprovedSnapshotAfterAck(snapshot)
            : await activateStagedKnowledgeAfterAck(staged.stageId);
          return {
            approvedSnapshot: snapshot,
            ...(staged === null ? {} : { stagedTransitionId: staged.stageId }),
            knowledgeState,
          };
        },
      };
    } catch (error) {
      if (isPersistenceErrorCode(error, 'INVALID_REQUEST')) {
        throw error;
      }
      throw invalidRequest('Skill candidate approval is unavailable');
    }
  }

  async function readBoundSkillReviewState(
    session: BridgeSessionContext,
    request: ReviewSkillCandidateBridgeRequest,
  ): Promise<BoundSkillReviewState> {
    const project = await repository.readCurrentProject(session.session);
    if (project.id !== request.projectId) {
      throw invalidRequest('Project is not active');
    }
    if (!project.skillPromotionCandidates.some((item) => item.id === request.candidateId)) {
      throw invalidRequest('Skill candidate is unavailable');
    }

    if (
      request.baseRevision === undefined ||
      request.candidateFingerprint === undefined ||
      request.preparedManagedSnapshot === undefined
    ) {
      throw staleSkillPreparation('Skill candidate review preview must be prepared again');
    }

    const revision = await readCurrentRevision(repository, session.session);
    if (revision !== request.baseRevision) {
      throw staleSkillPreparation('Skill candidate review base revision is stale');
    }

    const candidate = requireCurrentReviewCandidate(project, request.candidateId, request.candidateFingerprint);
    assertPublicBridgePayload(candidate);
    if (candidate.targetKnowledgeBaseId === undefined) {
      throw invalidRequest('Skill candidate review requires a target knowledge base');
    }
    const active = await knowledgeStore.readActive(candidate.targetKnowledgeBaseId);
    if (active === null) {
      throw invalidRequest('Active knowledge snapshot is unavailable');
    }
    assertPreparedManagedSnapshotMatches(candidate, request.preparedManagedSnapshot, active);

    return { active, candidate, project, revision };
  }

  function buildReviewableSkillCandidate(
    project: CanvasProject,
    candidate: SkillPromotionCandidate,
    active: KnowledgeSnapshot,
  ): SkillPromotionCandidate | null {
    if (!candidate.targetKnowledgeBaseId || !candidate.targetKnowledgeSection) return null;
    const sourceIds = candidate.sourceProjectMemoryIds ?? [candidate.sourceProjectMemoryId];
    const sourceEntries = sourceIds.map((sourceId) => (
      project.projectMemory.find((memory) => memory.id === sourceId)
    ));
    if (sourceEntries.some((entry) => entry === undefined)) return null;
    const managedRule = extractManagedRule(active, candidate);
    if (managedRule === undefined) return null;

    try {
      return buildSkillPromotionCandidate(sourceEntries.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined), {
        affectedCapabilities: candidate.affectedCapabilities,
        candidateId: candidate.id,
        createdAt: candidate.createdAt,
        managedRule,
        proposedRule: candidate.rule,
        targetKnowledgeBaseId: candidate.targetKnowledgeBaseId,
        targetSection: candidate.targetKnowledgeSection,
      });
    } catch {
      return null;
    }
  }

  function extractManagedRule(active: KnowledgeSnapshot, candidate: SkillPromotionCandidate): string | undefined {
    const targetPath = candidate.targetKnowledgeSection === undefined
      ? undefined
      : promotionDocumentPathForBridge(candidate.targetKnowledgeSection);
    const exactDocument = targetPath === undefined
      ? undefined
      : active.documents.find((document) => document.relativePath === targetPath);
    const content = exactDocument?.content
      ?? (active.documents.length === 1
        ? active.documents[0]?.content
        : active.documents
          .map((document) => document.content)
          .join('\n\n'));
    const trimmed = content?.trim();
    return trimmed ? trimmed : undefined;
  }

  function promotionDocumentPathForBridge(section: string): string {
    const normalized = section.replace(/\\/g, '/').split('/')
      .map((part) => part.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, ''))
      .filter(Boolean)
      .join('/');
    return `memory/promotions/${normalized}.md`;
  }

  async function prepareApprovedKnowledgeSnapshotCandidate(
    candidate: SkillPromotionCandidate,
    active: KnowledgeSnapshot,
    states: readonly KnowledgeBaseStateSummary[],
  ): Promise<KnowledgeSnapshotCandidate> {
    const retainedSnapshots = await readRetainedSnapshotsForRegistry(active, states);
    const registry = new KnowledgeSnapshotRegistry([{
      schemaVersion: 1,
      knowledgeBaseId: active.knowledgeBaseId,
      displayName: active.displayName,
      status: 'active',
      active,
      versions: retainedSnapshots,
      lastFailure: null,
      lastRollbackAt: null,
    }]);
    const writebackService = new SkillWritebackService();
    const promotionService = new SkillKnowledgePromotionService({
      registry,
      sourceDeviceId: 'desktop-bridge',
      writebackService,
    });
    const prepared = promotionService.prepare(candidate, active);
    const approval = writebackService.issueApproval(prepared.diffHash, {
      random: () => 0.5,
      ttlMs: 60_000,
    });
    const claimed = writebackService.claimApproval(prepared.diffHash, approval.approvalToken);
    if (!claimed.ok) {
      throw invalidRequest('Skill candidate approval is unavailable');
    }
    return prepared.targetSnapshot;
  }

  async function readRetainedSnapshotsForRegistry(
    active: KnowledgeSnapshot,
    states: readonly KnowledgeBaseStateSummary[],
  ): Promise<KnowledgeSnapshot[]> {
    const readVersion = knowledgeStore.readVersion;
    const state = states.find((item) => item.knowledgeBaseId === active.knowledgeBaseId);
    if (readVersion === undefined || state === undefined) {
      return [active];
    }
    const versions = (await Promise.all(state.versions.map(async (version) => (
      readVersion.call(knowledgeStore, active.knowledgeBaseId, version.version)
    )))).filter((snapshot): snapshot is KnowledgeSnapshot => snapshot !== null);
    if (!versions.some((snapshot) => snapshot.version === active.version)) {
      versions.push(active);
    }
    return versions.sort((left, right) => left.version - right.version);
  }

  function createLocallyVersionedApprovedSnapshot(
    targetSnapshot: KnowledgeSnapshotCandidate,
    active: KnowledgeSnapshot,
    states: readonly KnowledgeBaseStateSummary[],
    publishedAt: string,
  ): KnowledgeSnapshot {
    const state = states.find((item) => item.knowledgeBaseId === active.knowledgeBaseId);
    const retainedVersion = state?.versions.reduce((max, version) => Math.max(max, version.version), 0) ?? 0;
    return {
      ...targetSnapshot,
      version: Math.max(retainedVersion, active.version) + 1,
      publishedAt,
      sourceDeviceId: 'desktop-bridge',
    };
  }

  async function publishApprovedSnapshotAfterAck(snapshot: KnowledgeSnapshot): Promise<KnowledgeBaseStateSummary | null> {
    const publish = knowledgeStore.publish;
    if (publish === undefined) {
      throw invalidRequest('Knowledge publication is unavailable');
    }
    await publish.call(knowledgeStore, snapshot);
    return sanitizeKnowledgeSummaries(await knowledgeStore.listStates())
      .find((state) => state.knowledgeBaseId === snapshot.knowledgeBaseId) ?? null;
  }

  async function activateStagedKnowledgeAfterAck(stageId: string): Promise<KnowledgeBaseStateSummary | null> {
    const activate = knowledgeStore.activateStagedTransition;
    if (activate === undefined) {
      throw invalidRequest('Knowledge staged activation is unavailable');
    }
    return sanitizeKnowledgeSummary(await activate.call(knowledgeStore, stageId));
  }

  async function prepareRollbackSkillCandidatesForBridge(
    candidates: readonly SkillPromotionCandidate[],
    candidate: SkillPromotionCandidate,
    request: ReviewSkillCandidateBridgeRequest,
    transactionId: string,
  ): Promise<PreparedBridgeSkillReview> {
    const targetVersion = request.targetVersion;
    if (
      targetVersion === undefined ||
      !Number.isInteger(targetVersion) ||
      targetVersion <= 0 ||
      candidate.reviewStatus !== 'approved' ||
      candidate.targetKnowledgeBaseId === undefined ||
      candidate.publishedKnowledgeVersion === undefined ||
      targetVersion >= candidate.publishedKnowledgeVersion
    ) {
      throw invalidRequest('Rollback requires a valid older target version');
    }
    const states = await knowledgeStore.listStates();
    const state = states.find((item) => item.knowledgeBaseId === candidate.targetKnowledgeBaseId);
    if (
      state === undefined ||
      state.activeVersion === null ||
      state.activeContentHash === null ||
      candidate.publishedKnowledgeVersion > state.activeVersion ||
      !state.versions.some((version) => version.version === targetVersion)
    ) {
      throw invalidRequest('Rollback target version is unavailable');
    }

    const rolledBackAt = new Date().toISOString();
    const previousActiveVersion = state.activeVersion;
    const staged = knowledgeStore.stageRollback === undefined
      ? null
      : await knowledgeStore.stageRollback({
        knowledgeBaseId: candidate.targetKnowledgeBaseId,
        targetVersion,
      }, {
        stageId: `knowledge-${transactionId}`,
        projectId: request.projectId,
        candidateId: candidate.id,
        transactionId,
        expectedActiveVersion: state.activeVersion,
        expectedActiveContentHash: state.activeContentHash,
        stagedAt: rolledBackAt,
      });
    if (staged === null && knowledgeStore.rollback === undefined) {
      throw invalidRequest('Knowledge rollback is unavailable');
    }

    const nextCandidates = candidates.map((item) => (
      item.reviewStatus === 'approved' &&
      item.targetKnowledgeBaseId === candidate.targetKnowledgeBaseId &&
      item.publishedKnowledgeVersion !== undefined &&
      item.publishedKnowledgeVersion > targetVersion &&
      item.publishedKnowledgeVersion <= previousActiveVersion
        ? rollbackSkillPromotionCandidate(item, rolledBackAt, { transactionId })
        : item
    ));
    const reviewed = nextCandidates.find((item) => item.id === candidate.id);
    if (reviewed === undefined || reviewed.reviewStatus !== 'rolled_back') {
      throw invalidRequest('Rollback did not update the selected skill candidate');
    }

    return {
      candidate: reviewed,
      candidates: nextCandidates,
      ...(staged === null ? {} : { stagedTransitionId: staged.stageId }),
      activateAfterAck: async () => {
        const rolledBackState = staged === null
          ? sanitizeKnowledgeSummary(await knowledgeStore.rollback!.call(knowledgeStore, candidate.targetKnowledgeBaseId!, targetVersion))
          : await activateStagedKnowledgeAfterAck(staged.stageId);
        if (rolledBackState === null || rolledBackState.activeVersion !== targetVersion) {
          throw invalidRequest('Knowledge rollback target was not activated');
        }
        return {
          knowledgeState: rolledBackState,
          ...(staged === null ? {} : { stagedTransitionId: staged.stageId }),
        };
      },
    };
  }

  async function reconcileStagedKnowledgeTransitionsForProject(session: OpenedProjectSession): Promise<void> {
    const listStaged = knowledgeStore.listStagedKnowledgeTransitions;
    const activate = knowledgeStore.activateStagedTransition;
    if (listStaged === undefined || activate === undefined) {
      return;
    }

    const stagedTransitions = await listStaged.call(knowledgeStore);
    if (stagedTransitions.length === 0) {
      return;
    }

    const project = await repository.readCurrentProject(session);
    const candidatesById = new Map(project.skillPromotionCandidates.map((candidate) => [candidate.id, candidate]));
    for (const staged of stagedTransitions) {
      if (staged.projectId !== project.id) {
        continue;
      }
      try {
        if (staged.phase === 'completed') {
          await requireMethod(knowledgeStore, 'finalizeStagedTransition').call(knowledgeStore, staged.stageId);
          continue;
        }

        const candidate = candidatesById.get(staged.candidateId);
        const exactTransaction = candidate?.reviewTransactionId === staged.transactionId;
        const exactLifecycle = staged.kind === 'approved_snapshot'
          ? candidate?.reviewStatus === 'approved' &&
            candidate.publishedKnowledgeVersion === staged.publicationVersion
          : candidate?.reviewStatus === 'rolled_back';
        if (!exactTransaction || !exactLifecycle) {
          if (staged.phase === 'staged' && knowledgeStore.discardStagedTransition !== undefined) {
            const reason = candidate?.reviewTransactionId !== undefined &&
              candidate.reviewTransactionId !== staged.transactionId
              ? 'superseded_project_transaction'
              : 'unacknowledged_project_transaction';
            await knowledgeStore.discardStagedTransition(staged.stageId, reason);
          }
          continue;
        }

        await activate.call(knowledgeStore, staged.stageId);
        if (staged.kind === 'approved_snapshot') {
          if (
            approvedSnapshotOutbox === null ||
            staged.publicationVersion === undefined ||
            staged.publicationContentHash === undefined
          ) {
            throw invalidRequest('Approved snapshot recovery is unavailable');
          }
          const readVersion = requireMethod(knowledgeStore, 'readVersion');
          const snapshot = await readVersion.call(
            knowledgeStore,
            staged.knowledgeBaseId,
            staged.publicationVersion,
          );
          if (snapshot === null || snapshot.contentHash !== staged.publicationContentHash) {
            throw invalidRequest('Approved snapshot recovery content is unavailable');
          }
          await approvedSnapshotOutbox.enqueueApprovedSnapshot(snapshot);
          await requireMethod(knowledgeStore, 'recordStagedTransitionOutboxIntent').call(knowledgeStore, staged.stageId);
        }
        await requireMethod(knowledgeStore, 'finalizeStagedTransition').call(knowledgeStore, staged.stageId);
      } catch {
        // Preserve the exact staged transition and reservation for retry.
      }
    }
  }

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
  ipcMain.handle(BRIDGE_CHANNELS.importProjectImage, handlers.importProjectImage);
  ipcMain.handle(BRIDGE_CHANNELS.listProjectImages, handlers.listProjectImages);
  ipcMain.handle(BRIDGE_CHANNELS.closeProject, handlers.closeProject);
  ipcMain.handle(BRIDGE_CHANNELS.getRecoveryPlan, handlers.getRecoveryPlan);
  ipcMain.handle(BRIDGE_CHANNELS.configureKnowledgeBase, handlers.configureKnowledgeBase);
  ipcMain.handle(BRIDGE_CHANNELS.getKnowledgeState, handlers.getKnowledgeState);
  ipcMain.handle(BRIDGE_CHANNELS.prepareSkillCandidateReview, handlers.prepareSkillCandidateReview);
  ipcMain.handle(BRIDGE_CHANNELS.reviewSkillCandidate, handlers.reviewSkillCandidate);
}

function withDialogDefaults(dialogs: Partial<BridgeDialogAdapter> | undefined): BridgeDialogAdapter {
  return {
    chooseImportDestination: dialogs?.chooseImportDestination ?? (async () => null),
    chooseImportPackSource: dialogs?.chooseImportPackSource ?? (async () => null),
    chooseKnowledgeRoot: dialogs?.chooseKnowledgeRoot ?? (async () => null),
    choosePackExportPath: dialogs?.choosePackExportPath ?? (async () => null),
    chooseProjectImage: dialogs?.chooseProjectImage ?? (async () => null),
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
    readCurrentRevision: repository?.readCurrentRevision ?? ((session) => fallback.readCurrentRevision(session)),
  };
}

async function validateProjectImageTarget(
  repository: ProjectRepositoryLike,
  session: BridgeSessionContext,
  target: ProjectImageImportTarget,
): Promise<void> {
  const project = await repository.readCurrentProject(session.session);
  const node = project.nodes.find((candidate) => candidate.id === target.nodeId);
  if (node === undefined) throw invalidRequest('Project image target node is unavailable');
  if (target.kind === 'module') {
    if (node.type !== 'module' || (node.data.moduleType !== 'image_input' && node.data.moduleType !== 'upload_image')) {
      throw invalidRequest('Project image module target is not import-capable');
    }
    return;
  }
  if (node.type !== 'placement_preview') {
    throw invalidRequest('Project image placement target is unavailable');
  }
  const userReferences = node.data.objects.filter((object) => !object.assetId.startsWith('starter-'));
  if (userReferences.length >= MAX_GENERATION_REFERENCES) {
    throw invalidRequest(`Project references are limited to ${MAX_GENERATION_REFERENCES} images`);
  }
}

function createImportedProjectImageAsset(storedAsset: AssetMetadata, sourcePath: string): ProjectImageAsset {
  const rawLabel = basename(sourcePath, extname(sourcePath))
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 120);
  const base = {
    assetId: storedAsset.id,
    byteSize: storedAsset.byteSize,
    extension: storedAsset.extension,
    height: storedAsset.height,
    label: rawLabel || `Image ${storedAsset.id.slice(0, 8)}`,
    mediaType: storedAsset.mediaType,
    origin: 'imported' as const,
    sha256: storedAsset.sha256,
    width: storedAsset.width,
  };
  const parsed = projectImageAssetSchema.safeParse(base);
  return parsed.success
    ? parsed.data
    : projectImageAssetSchema.parse({ ...base, label: `Image ${storedAsset.id.slice(0, 8)}` });
}

function createProjectImageImportTransaction(
  project: CanvasProject,
  target: ProjectImageImportTarget,
  asset: ProjectImageAsset,
  createId: () => string,
): ProjectTransaction {
  const node = project.nodes.find((candidate) => candidate.id === target.nodeId);
  if (node === undefined) throw invalidRequest('Project image target node is unavailable');
  const assets = upsertProjectImageAsset(project.assets ?? [], asset);
  let nextNode: CanvasProject['nodes'][number];
  if (target.kind === 'module') {
    if (node.type !== 'module' || (node.data.moduleType !== 'image_input' && node.data.moduleType !== 'upload_image')) {
      throw invalidRequest('Project image module target is not import-capable');
    }
    nextNode = {
      ...node,
      data: {
        ...node.data,
        config: { ...node.data.config, assetId: asset.assetId },
      },
    };
  } else {
    if (node.type !== 'placement_preview') {
      throw invalidRequest('Project image placement target is unavailable');
    }
    const userReferences = node.data.objects.filter((object) => !object.assetId.startsWith('starter-'));
    if (userReferences.length >= MAX_GENERATION_REFERENCES) {
      throw invalidRequest(`Project references are limited to ${MAX_GENERATION_REFERENCES} images`);
    }
    if (node.data.objects.some((object) => object.assetId === asset.assetId)) {
      throw invalidRequest('Project image is already present in the ordered references');
    }
    const layout = PROJECT_IMAGE_REFERENCE_LAYOUT[target.role];
    const object: PlacementObject = {
      id: `reference-${asset.assetId}-${createId()}`,
      assetId: asset.assetId,
      role: target.role,
      ...layout,
      name: asset.label,
      rotation: 0,
      locked: false,
      visible: true,
      flipX: false,
      flipY: false,
    };
    nextNode = {
      ...node,
      data: { ...node.data, objects: [...node.data.objects, object] },
    };
  }
  const suffix = createId();
  return {
    id: `import-project-image-${asset.assetId}-${suffix}`,
    label: 'Import managed project image',
    operations: [
      { kind: 'set_project_assets', assets },
      { kind: 'canvas', operation: { kind: 'update_node', node: nextNode } },
    ],
  };
}

function upsertProjectImageAsset(
  assets: readonly ProjectImageAsset[],
  asset: ProjectImageAsset,
): ProjectImageAsset[] {
  const existing = assets.find((candidate) => candidate.assetId === asset.assetId);
  if (existing !== undefined && existing.sha256 !== asset.sha256) {
    throw invalidRequest('Project image id conflicts with existing catalog metadata');
  }
  return existing === undefined
    ? [...assets, asset]
    : assets.map((candidate) => candidate.assetId === asset.assetId ? asset : candidate);
}

function createProjectImageSummary(
  asset: ProjectImageAsset,
  sessionId: string,
  usageCount: number,
): ProjectImageAssetSummary {
  return {
    ...asset,
    displayUrl: createProjectAssetDisplayUrl(sessionId, asset.assetId),
    usageCount,
  };
}

function storedAssetMatchesProjectAsset(
  storedAsset: AssetMetadata | undefined,
  projectAsset: ProjectImageAsset,
): boolean {
  return storedAsset !== undefined
    && storedAsset.id === projectAsset.assetId
    && storedAsset.sha256 === projectAsset.sha256
    && storedAsset.byteSize === projectAsset.byteSize
    && storedAsset.extension === projectAsset.extension
    && storedAsset.mediaType === projectAsset.mediaType;
}

function countProjectImageUsage(project: CanvasProject, assetId: string): number {
  return collectExactStringCount(project.nodes, assetId);
}

function collectExactStringCount(value: unknown, expected: string): number {
  if (value === expected) return 1;
  if (Array.isArray(value)) {
    return value.reduce((total, child) => total + collectExactStringCount(child, expected), 0);
  }
  if (isRecord(value)) {
    return Object.values(value).reduce<number>(
      (total, child) => total + collectExactStringCount(child, expected),
      0,
    );
  }
  return 0;
}

async function summarizeSession(
  repository: ProjectRepositoryLike,
  sessionId: string,
  session: OpenedProjectSession,
): Promise<BridgeSessionSummary> {
  const project = await repository.readCurrentProject(session);
  const currentRevision = await readCurrentRevision(repository, session);
  return {
    currentRevision,
    mode: session.mode,
    project,
    projectId: session.manifest.projectId,
    projectName: session.manifest.projectName,
    sessionId,
    stableSnapshotId: session.manifest.stableSnapshotId,
    stableSnapshotRevision: session.manifest.stableSnapshotRevision,
  };
}

async function readCurrentRevision(
  repository: ProjectRepositoryLike,
  session: OpenedProjectSession,
): Promise<number> {
  return repository.readCurrentRevision === undefined
    ? session.manifest.stableSnapshotRevision
    : repository.readCurrentRevision(session);
}

async function readActiveJournalBytes(
  fileSystem: FileSystem,
  session: OpenedProjectSession,
): Promise<number> {
  try {
    const stats = await fileSystem.stat(join(session.root, ...session.manifest.activeJournalSegment.split('/')));
    return typeof stats.size === 'number' && Number.isFinite(stats.size) ? stats.size : 0;
  } catch {
    return 0;
  }
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

function requireSingleWritableProjectSession(
  sessions: Map<string, BridgeSessionContext>,
  projectId: string,
): BridgeSessionContext {
  const matches = [...sessions.values()].filter((context) => (
    context.session.mode === 'write' &&
    context.session.manifest.projectId === projectId
  ));
  if (matches.length !== 1) {
    throw invalidRequest('Expected exactly one active writable project session');
  }
  return matches[0]!;
}

function requireBridgeWriter(session: BridgeSessionContext): BridgeWriter {
  if (session.writer === null) {
    throw invalidRequest('Skill candidate review requires a writable desktop session');
  }
  return session.writer;
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
  await writeInitialJournalCommitBoundary(fileSystem, join(session.session.root, ...ACTIVE_JOURNAL_SEGMENT.split('/')), {
    baseRevision: candidate.revision,
    nextSequence: candidate.revision + 1,
    projectId: manifest.projectId,
    updatedAt: envelope.createdAt,
  });
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

function validateConfigureKnowledgeBaseBridgeRequest(value: unknown): ConfigureKnowledgeBaseBridgeRequest {
  const record = expectPlainRecord(value);
  const request = {
    displayName: parseNonEmptyString(record.displayName, 'displayName'),
    knowledgeBaseId: parseNonEmptyString(record.knowledgeBaseId, 'knowledgeBaseId'),
  };
  assertPublicBridgePayload(request);
  return request;
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

function validateImportProjectImageBridgeRequest(value: unknown): ImportProjectImageBridgeRequest {
  const record = expectPlainRecord(value);
  assertExactKeys(record, ['sessionId', 'target'], 'Project image import request');
  const targetRecord = expectPlainRecord(record.target);
  const kind = targetRecord.kind;
  let target: ProjectImageImportTarget;
  if (kind === 'module') {
    assertExactKeys(targetRecord, ['kind', 'nodeId'], 'Project image module target');
    target = {
      kind,
      nodeId: parseNonEmptyString(targetRecord.nodeId, 'target.nodeId'),
    };
  } else if (kind === 'placement_reference') {
    assertExactKeys(targetRecord, ['kind', 'nodeId', 'role'], 'Project image placement target');
    target = {
      kind,
      nodeId: parseNonEmptyString(targetRecord.nodeId, 'target.nodeId'),
      role: parseReferenceRole(targetRecord.role),
    };
  } else {
    throw invalidRequest('Project image import target kind is invalid');
  }
  const request = {
    sessionId: parseNonEmptyString(record.sessionId, 'sessionId'),
    target,
  };
  assertPublicBridgePayload(request);
  return request;
}

function validateListProjectImagesBridgeRequest(value: unknown): ListProjectImagesBridgeRequest {
  const record = expectPlainRecord(value);
  assertExactKeys(record, ['sessionId'], 'Project image list request');
  const request = { sessionId: parseNonEmptyString(record.sessionId, 'sessionId') };
  assertPublicBridgePayload(request);
  return request;
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

function isExactAcknowledgedReview(
  durableCandidate: SkillPromotionCandidate | undefined,
  expectedCandidate: SkillPromotionCandidate,
  transactionId: string,
): boolean {
  if (
    durableCandidate === undefined ||
    durableCandidate.reviewTransactionId !== transactionId ||
    durableCandidate.reviewStatus !== expectedCandidate.reviewStatus
  ) {
    return false;
  }
  if (expectedCandidate.reviewStatus === 'approved') {
    return durableCandidate.publishedKnowledgeVersion === expectedCandidate.publishedKnowledgeVersion;
  }
  if (expectedCandidate.reviewStatus === 'rolled_back') {
    return durableCandidate.publishedKnowledgeVersion === expectedCandidate.publishedKnowledgeVersion
      && durableCandidate.rolledBackAt === expectedCandidate.rolledBackAt;
  }
  return durableCandidate.reviewedAt === expectedCandidate.reviewedAt;
}

function requireCurrentPrepareCandidate(
  project: CanvasProject,
  candidateId: string,
  candidateFingerprint: string,
): SkillPromotionCandidate {
  const candidate = project.skillPromotionCandidates.find((item) => item.id === candidateId);
  if (candidate === undefined) {
    throw invalidRequest('Skill candidate is unavailable');
  }
  if (
    candidate.reviewStatus !== 'pending_review' ||
    candidate.reviewedAt !== undefined ||
    candidate.reviewTransactionId !== undefined
  ) {
    throw staleSkillPreparation('Skill candidate preparation was superseded');
  }
  if (createSkillPromotionCandidateFingerprint(candidate) !== candidateFingerprint) {
    throw staleSkillPreparation('Skill candidate preparation fingerprint is stale');
  }
  return candidate;
}

function requireCurrentReviewCandidate(
  project: CanvasProject,
  candidateId: string,
  candidateFingerprint: string,
): SkillPromotionCandidate {
  const candidate = project.skillPromotionCandidates.find((item) => item.id === candidateId);
  if (candidate === undefined) {
    throw invalidRequest('Skill candidate is unavailable');
  }
  if (
    candidate.reviewStatus !== 'pending_review' ||
    candidate.reviewPreparationStatus !== 'ready' ||
    candidate.reviewedAt !== undefined ||
    candidate.reviewTransactionId !== undefined ||
    candidate.sourceRule === undefined ||
    candidate.managedRule === undefined ||
    candidate.diffHunks === undefined ||
    candidate.diffHunks.length === 0 ||
    candidate.preparedManagedSnapshot === undefined
  ) {
    throw staleSkillPreparation('Skill candidate review preview must be prepared again');
  }
  if (createSkillPromotionCandidateFingerprint(candidate) !== candidateFingerprint) {
    throw staleSkillPreparation('Skill candidate review fingerprint is stale');
  }
  return candidate;
}

function createPreparedManagedSnapshot(snapshot: KnowledgeSnapshot): SkillCandidatePreparedManagedSnapshot {
  return {
    knowledgeBaseId: snapshot.knowledgeBaseId,
    version: snapshot.version,
    contentHash: snapshot.contentHash,
  };
}

function assertPreparedManagedSnapshotMatches(
  candidate: SkillPromotionCandidate,
  requestSnapshot: SkillCandidatePreparedManagedSnapshot,
  active: KnowledgeSnapshot,
): void {
  const activeSnapshot = createPreparedManagedSnapshot(active);
  if (
    candidate.preparedManagedSnapshot === undefined ||
    !preparedManagedSnapshotsMatch(candidate.preparedManagedSnapshot, requestSnapshot) ||
    !preparedManagedSnapshotsMatch(requestSnapshot, activeSnapshot)
  ) {
    throw staleSkillPreparation('Skill candidate managed snapshot changed after preview');
  }
}

function preparedManagedSnapshotsMatch(
  left: SkillCandidatePreparedManagedSnapshot,
  right: SkillCandidatePreparedManagedSnapshot,
): boolean {
  return left.knowledgeBaseId === right.knowledgeBaseId
    && left.version === right.version
    && left.contentHash === right.contentHash;
}

function validatePrepareSkillCandidateReviewBridgeRequest(value: unknown): PrepareSkillCandidateReviewBridgeRequest {
  const record = expectPlainRecord(value);
  return {
    baseRevision: parseNonNegativeInteger(record.baseRevision, 'baseRevision'),
    candidateId: parseNonEmptyString(record.candidateId, 'candidateId'),
    candidateFingerprint: parseNonEmptyString(record.candidateFingerprint, 'candidateFingerprint'),
    projectId: parseNonEmptyString(record.projectId, 'projectId'),
  };
}

function validateReviewSkillCandidateBridgeRequest(value: unknown): ReviewSkillCandidateBridgeRequest {
  const record = expectPlainRecord(value);
  const decision = record.decision;
  if (decision !== 'approved' && decision !== 'rejected' && decision !== 'superseded' && decision !== 'rolled_back') {
    throw invalidRequest('Skill candidate review decision is invalid');
  }
  return {
    baseRevision: record.baseRevision === undefined
      ? undefined
      : parseNonNegativeInteger(record.baseRevision, 'baseRevision'),
    candidateId: parseNonEmptyString(record.candidateId, 'candidateId'),
    candidateFingerprint: record.candidateFingerprint === undefined
      ? undefined
      : parseNonEmptyString(record.candidateFingerprint, 'candidateFingerprint'),
    decision,
    preparedManagedSnapshot: record.preparedManagedSnapshot === undefined
      ? undefined
      : parsePreparedManagedSnapshot(record.preparedManagedSnapshot),
    projectId: parseNonEmptyString(record.projectId, 'projectId'),
    targetVersion: record.targetVersion === undefined
      ? undefined
      : parsePositiveInteger(record.targetVersion, 'targetVersion'),
  };
}

function parsePreparedManagedSnapshot(value: unknown): SkillCandidatePreparedManagedSnapshot {
  const record = expectPlainRecord(value);
  const contentHash = parseNonEmptyString(record.contentHash, 'preparedManagedSnapshot.contentHash');
  if (!/^[a-f0-9]{64}$/i.test(contentHash)) {
    throw invalidRequest('preparedManagedSnapshot.contentHash must be a content hash');
  }
  return {
    knowledgeBaseId: parseNonEmptyString(record.knowledgeBaseId, 'preparedManagedSnapshot.knowledgeBaseId'),
    version: parsePositiveInteger(record.version, 'preparedManagedSnapshot.version'),
    contentHash,
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

function parseReferenceRole(value: unknown): ImportableReferenceRole {
  if (
    value === 'product_identity'
    || value === 'scene_composition'
    || value === 'prop_reference'
    || value === 'material_lighting'
  ) {
    return value;
  }
  throw invalidRequest('Project image reference role is invalid');
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

function assertExactKeys(record: Record<string, unknown>, allowedKeys: readonly string[], label: string): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw invalidRequest(`${label} contains unsupported fields`);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
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

function sanitizeKnowledgeSyncStatuses(
  statuses: readonly KnowledgeSyncStatusSummary[],
): KnowledgeSyncStatusSummary[] {
  return statuses.map((status) => {
    assertPublicBridgePayload(status);
    return {
      schemaVersion: 1,
      knowledgeBaseId: status.knowledgeBaseId,
      status: status.status,
      changedAt: status.changedAt,
      lastFailure: status.lastFailure === null ? null : {
        reason: status.lastFailure.reason,
        failedAt: status.lastFailure.failedAt,
      },
    };
  });
}
function sanitizeKnowledgeSummaries(
  states: readonly KnowledgeBaseStateSummary[],
): KnowledgeBaseStateSummary[] {
  return states.map(sanitizeKnowledgeSummary).sort(compareKnowledgeSummaries);
}

function sanitizeKnowledgeSummary(state: KnowledgeBaseStateSummary): KnowledgeBaseStateSummary {
  const summary: KnowledgeBaseStateSummary = {
    schemaVersion: 1,
    knowledgeBaseId: parseNonEmptyString(state.knowledgeBaseId, 'knowledgeBaseId'),
    displayName: state.displayName === null
      ? null
      : parseNonEmptyString(state.displayName, 'displayName'),
    status: parseKnowledgeStatus(state.status),
    activeVersion: state.activeVersion === null
      ? null
      : parsePositiveInteger(state.activeVersion, 'activeVersion'),
    activeContentHash: state.activeContentHash === null
      ? null
      : parseHash(state.activeContentHash, 'activeContentHash'),
    ...(state.stateRevision === undefined
      ? {}
      : { stateRevision: parseNonNegativeInteger(state.stateRevision, 'stateRevision') }),
    versionCount: parseNonNegativeInteger(state.versionCount, 'versionCount'),
    versions: Array.isArray(state.versions)
      ? state.versions.map((version) => ({
        version: parsePositiveInteger(version.version, 'version'),
        contentHash: parseHash(version.contentHash, 'contentHash'),
        publishedAt: parseDateString(version.publishedAt, 'publishedAt'),
        sourceDeviceId: parseNonEmptyString(version.sourceDeviceId, 'sourceDeviceId'),
        displayName: parseNonEmptyString(version.displayName, 'displayName'),
      })).sort((left, right) => left.version - right.version)
      : [],
    lastFailure: state.lastFailure === null
      ? null
      : {
        reason: parseNonEmptyString(state.lastFailure.reason, 'reason'),
        failedAt: parseDateString(state.lastFailure.failedAt, 'failedAt'),
      },
    lastRollbackAt: state.lastRollbackAt === null
      ? null
      : parseDateString(state.lastRollbackAt, 'lastRollbackAt'),
  };
  if (summary.versions.length !== summary.versionCount) {
    throw invalidRequest('Knowledge state version count is invalid');
  }
  assertPublicBridgePayload(summary);
  return summary;
}

function sanitizeSkillPromotionCandidate(candidate: SkillPromotionCandidate): SkillPromotionCandidate {
  const parsed = skillPromotionCandidateSchema.parse(candidate);
  const sanitized = skillPromotionCandidateSchema.parse({
    schemaVersion: parsed.schemaVersion,
    id: parsed.id,
    sourceProjectId: parsed.sourceProjectId,
    sourceProjectMemoryId: parsed.sourceProjectMemoryId,
    createdAt: parsed.createdAt,
    title: parsed.title,
    rationale: parsed.rationale,
    rule: parsed.rule,
    evidence: parsed.evidence,
    reviewStatus: parsed.reviewStatus,
    ...(parsed.sourceProjectMemoryIds === undefined ? {} : { sourceProjectMemoryIds: parsed.sourceProjectMemoryIds }),
    ...(parsed.beforeRule === undefined ? {} : { beforeRule: parsed.beforeRule }),
    ...(parsed.sourceRule === undefined ? {} : { sourceRule: parsed.sourceRule }),
    ...(parsed.managedRule === undefined ? {} : { managedRule: parsed.managedRule }),
    ...(parsed.diffHunks === undefined ? {} : { diffHunks: parsed.diffHunks }),
    ...(parsed.reviewPreparationStatus === undefined ? {} : { reviewPreparationStatus: parsed.reviewPreparationStatus }),
    ...(parsed.reviewPreparationStartedAt === undefined ? {} : { reviewPreparationStartedAt: parsed.reviewPreparationStartedAt }),
    ...(parsed.reviewPreparationError === undefined ? {} : { reviewPreparationError: parsed.reviewPreparationError }),
    ...(parsed.preparedManagedSnapshot === undefined ? {} : { preparedManagedSnapshot: parsed.preparedManagedSnapshot }),
    ...(parsed.targetKnowledgeBaseId === undefined ? {} : { targetKnowledgeBaseId: parsed.targetKnowledgeBaseId }),
    ...(parsed.targetKnowledgeSection === undefined ? {} : { targetKnowledgeSection: parsed.targetKnowledgeSection }),
    ...(parsed.counts === undefined ? {} : { counts: parsed.counts }),
    ...(parsed.confidence === undefined ? {} : { confidence: parsed.confidence }),
    ...(parsed.affectedCapabilities === undefined ? {} : { affectedCapabilities: parsed.affectedCapabilities }),
    ...(parsed.reviewedAt === undefined ? {} : { reviewedAt: parsed.reviewedAt }),
    ...(parsed.reviewTransactionId === undefined ? {} : { reviewTransactionId: parsed.reviewTransactionId }),
    ...(parsed.publishedKnowledgeVersion === undefined ? {} : { publishedKnowledgeVersion: parsed.publishedKnowledgeVersion }),
    ...(parsed.rolledBackAt === undefined ? {} : { rolledBackAt: parsed.rolledBackAt }),
  });
  assertPublicBridgePayload(sanitized);
  return sanitized;
}

function assertPublicBridgePayload(value: unknown): void {
  for (const text of collectStrings(value)) {
    if (containsProtectedRendererPayload(text)) {
      throw invalidRequest('Public bridge payload contains protected content');
    }
  }
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectStrings);
  }
  if (isRecord(value)) {
    return Object.values(value).flatMap(collectStrings);
  }
  return [];
}

function parseKnowledgeStatus(value: unknown): KnowledgeBaseStateSummary['status'] {
  if (value === 'empty' || value === 'active' || value === 'fallback' || value === 'rolled_back') {
    return value;
  }
  throw invalidRequest('Knowledge state status is invalid');
}

function parsePositiveInteger(value: unknown, fieldName: string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  throw invalidRequest(`${fieldName} must be a positive integer`);
}

function parseHash(value: unknown, fieldName: string): string {
  const stringValue = parseNonEmptyString(value, fieldName);
  if (!/^[a-f0-9]{64}$/u.test(stringValue)) {
    throw invalidRequest(`${fieldName} must be a lowercase SHA-256 digest`);
  }
  return stringValue;
}

function parseDateString(value: unknown, fieldName: string): string {
  const stringValue = parseNonEmptyString(value, fieldName);
  if (Number.isNaN(Date.parse(stringValue))) {
    throw invalidRequest(`${fieldName} must be an ISO timestamp`);
  }
  return stringValue;
}

function compareKnowledgeSummaries(left: KnowledgeBaseStateSummary, right: KnowledgeBaseStateSummary): number {
  return left.knowledgeBaseId < right.knowledgeBaseId ? -1 : left.knowledgeBaseId > right.knowledgeBaseId ? 1 : 0;
}

function invalidRequest(message: string): PersistenceError {
  return createPersistenceError('INVALID_REQUEST', false, message);
}

function staleSkillPreparation(message: string): PersistenceError {
  return createPersistenceError('REVISION_CONFLICT', true, message);
}

function isPersistenceErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
