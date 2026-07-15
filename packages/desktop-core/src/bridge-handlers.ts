import { basename, join } from 'node:path';

import {
  parseCanvasProject,
  projectTransactionSchema,
  reviewSkillPromotionCandidate,
  rollbackSkillPromotionCandidate,
  skillPromotionCandidateSchema,
  type CanvasProject,
  type SkillPromotionCandidate,
} from '@agent-canvas/domain';
import {
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
  type KnowledgeStateBridgeResult,
  type OpenProjectBridgeRequest,
  type OpenProjectBridgeResult,
  type PersistenceChannel,
  type PersistenceError,
  type ProjectManifest,
  type RecoveryCandidateBridgeSummary,
  type RecoveryPlanBridgeRequest,
  type RecoveryPlanBridgeResult,
  type ReviewSkillCandidateBridgeRequest,
  type ReviewSkillCandidateBridgeResult,
  type RestoreBridgeRequest,
  type RestoreBridgeResult,
  type SnapshotEnvelope,
  type StablePointBridgeRequest,
  type StablePointBridgeResult,
} from './contracts.js';
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
    reason: 'unacknowledged_project_transaction' | 'superseded_project_transaction',
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

export interface BridgeDialogAdapter {
  chooseImportDestination(): Promise<string | null>;
  chooseImportPackSource(): Promise<string | null>;
  chooseKnowledgeRoot(request: ConfigureKnowledgeBaseBridgeRequest): Promise<string | null>;
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
  readonly approvedSnapshotOutbox?: ApprovedSnapshotOutboxLike;
  readonly knowledgeRefreshService?: KnowledgeRefreshServiceLike;
  readonly knowledgeStore?: KnowledgeStoreLike;
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
  openProject(event: unknown, request: unknown): Promise<OpenProjectBridgeResult | null>;
  reviewSkillCandidate(event: unknown, request: unknown): Promise<ReviewSkillCandidateBridgeResult>;
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

interface PreparedBridgeSkillReview {
  readonly candidate: SkillPromotionCandidate;
  readonly candidates: SkillPromotionCandidate[];
  activateAfterAck(): Promise<{
    readonly approvedSnapshot?: KnowledgeSnapshot;
    readonly stagedTransitionId?: string;
    readonly knowledgeState: KnowledgeBaseStateSummary | null;
  }>;
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
  const knowledgeStore = dependencies.knowledgeStore ?? new ManagedKnowledgeStore({
    appDataRoot: dependencies.appDataRoot ?? process.cwd(),
    fileSystem,
  });
  const approvedSnapshotOutbox = dependencies.approvedSnapshotOutbox ?? null;
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
    sessions.set(sessionId, {
      recoveryCandidatePaths: new Map(),
      session: opened,
      sessionId,
      writer,
    });
    await reconcileStagedKnowledgeTransitionsForProject(opened);

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
    await reconcileStagedKnowledgeTransitionsForProject(opened);

    return {
      ...await summarizeSession(repository, sessionId, opened),
      importedRevision: result.importedRevision,
    };
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
    await knowledgeRefreshService.start(states.map((state) => state.knowledgeBaseId));
    return sanitizeKnowledgeSummary(await knowledgeRefreshService.refreshNow(validated.knowledgeBaseId));
  }

  async function getKnowledgeState(
    _event: unknown,
    _request: unknown,
  ): Promise<KnowledgeStateBridgeResult> {
    return {
      states: sanitizeKnowledgeSummaries(await knowledgeStore.listStates()),
    };
  }

  async function reviewSkillCandidate(
    _event: unknown,
    request: unknown,
  ): Promise<ReviewSkillCandidateBridgeResult> {
    const validated = validateReviewSkillCandidateBridgeRequest(request);
    const session = requireSingleWritableProjectSession(sessions, validated.projectId);
    const project = await repository.readCurrentProject(session.session);
    if (project.id !== validated.projectId) {
      throw invalidRequest('Project is not active');
    }

    const candidate = project.skillPromotionCandidates.find((item) => item.id === validated.candidateId);
    if (candidate === undefined) {
      throw invalidRequest('Skill candidate is unavailable');
    }
    assertPublicBridgePayload(candidate);

    const transactionId = `review-skill-${candidate.id}-${Date.now()}`;
    const preparedReview = validated.decision === 'rolled_back'
      ? await prepareRollbackSkillCandidatesForBridge(project.skillPromotionCandidates, candidate, validated, transactionId)
      : await prepareSkillCandidateReviewForBridge(project.skillPromotionCandidates, candidate, validated, transactionId);
    const reviewed = sanitizeSkillPromotionCandidate(preparedReview.candidate);
    const nextCandidates = preparedReview.candidates.map(sanitizeSkillPromotionCandidate);
    const currentRevision = await readCurrentRevision(repository, session.session);
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
    await flushScheduledSnapshotAfterCommit(session, ack, 'system');

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
    const knowledgeState = activated.knowledgeState ?? (
      reviewed.targetKnowledgeBaseId === undefined
        ? null
        : sanitizeKnowledgeSummaries(await knowledgeStore.listStates())
          .find((state) => state.knowledgeBaseId === reviewed.targetKnowledgeBaseId) ?? null
    );

    return {
      candidate: sanitizeSkillPromotionCandidate(reviewed),
      candidates: nextCandidates.map(sanitizeSkillPromotionCandidate),
      currentRevision: ack.revision,
      knowledgeState,
      projectId: validated.projectId,
    };
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
    openProject,
    reviewSkillCandidate,
    restore,
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
    candidates: readonly SkillPromotionCandidate[],
    candidate: SkillPromotionCandidate,
    request: ReviewSkillCandidateBridgeRequest,
    transactionId: string,
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
        candidates: candidates.map((item) => item.id === reviewed.id ? reviewed : item),
        activateAfterAck: async () => ({ knowledgeState: null }),
      };
    }

    if (candidate.targetKnowledgeBaseId === undefined) {
      throw invalidRequest('Approved skill candidates require a target knowledge base');
    }
    const active = await knowledgeStore.readActive(candidate.targetKnowledgeBaseId);
    if (active === null) {
      throw invalidRequest('Active knowledge snapshot is unavailable');
    }

    try {
      const states = await knowledgeStore.listStates();
      const targetSnapshot = await prepareApprovedKnowledgeSnapshotCandidate(candidate, active, states);
      const stagedAt = new Date().toISOString();
      const staged = knowledgeStore.stageApprovedSnapshot === undefined
        ? null
        : await knowledgeStore.stageApprovedSnapshot(targetSnapshot, {
          stageId: `knowledge-${transactionId}`,
          projectId: request.projectId,
          candidateId: candidate.id,
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
      const reviewed = reviewSkillPromotionCandidate(candidate, {
        decision: 'approved',
        reviewedAt: snapshot.publishedAt,
        publishedKnowledgeVersion: snapshot.version,
        transactionId,
      });
      return {
        candidate: reviewed,
        candidates: candidates.map((item) => item.id === reviewed.id ? reviewed : item),
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
  ipcMain.handle(BRIDGE_CHANNELS.closeProject, handlers.closeProject);
  ipcMain.handle(BRIDGE_CHANNELS.getRecoveryPlan, handlers.getRecoveryPlan);
  ipcMain.handle(BRIDGE_CHANNELS.configureKnowledgeBase, handlers.configureKnowledgeBase);
  ipcMain.handle(BRIDGE_CHANNELS.getKnowledgeState, handlers.getKnowledgeState);
  ipcMain.handle(BRIDGE_CHANNELS.reviewSkillCandidate, handlers.reviewSkillCandidate);
}

function withDialogDefaults(dialogs: Partial<BridgeDialogAdapter> | undefined): BridgeDialogAdapter {
  return {
    chooseImportDestination: dialogs?.chooseImportDestination ?? (async () => null),
    chooseImportPackSource: dialogs?.chooseImportPackSource ?? (async () => null),
    chooseKnowledgeRoot: dialogs?.chooseKnowledgeRoot ?? (async () => null),
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
    readCurrentRevision: repository?.readCurrentRevision ?? ((session) => fallback.readCurrentRevision(session)),
  };
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

function validateRestoreBridgeRequest(value: unknown): RestoreBridgeRequest {
  const record = expectPlainRecord(value);
  return {
    candidateId: record.candidateId === undefined
      ? undefined
      : parseNonEmptyString(record.candidateId, 'candidateId'),
    sessionId: parseNonEmptyString(record.sessionId, 'sessionId'),
  };
}

function validateReviewSkillCandidateBridgeRequest(value: unknown): ReviewSkillCandidateBridgeRequest {
  const record = expectPlainRecord(value);
  const decision = record.decision;
  if (decision !== 'approved' && decision !== 'rejected' && decision !== 'superseded' && decision !== 'rolled_back') {
    throw invalidRequest('Skill candidate review decision is invalid');
  }
  return {
    candidateId: parseNonEmptyString(record.candidateId, 'candidateId'),
    decision,
    projectId: parseNonEmptyString(record.projectId, 'projectId'),
    targetVersion: record.targetVersion === undefined
      ? undefined
      : parsePositiveInteger(record.targetVersion, 'targetVersion'),
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
    if (containsProtectedBridgeText(text)) {
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

function containsProtectedBridgeText(value: string): boolean {
  return /authorization\s*:/i.test(value)
    || /\bbearer\s+[a-z0-9._~+/=\-]{8,}/i.test(value)
    || /\b(?:api[_ -]?key|token|secret|password)\s*[:=]\s*\S+/i.test(value)
    || /\bsk-[a-z0-9_-]{8,}\b/i.test(value)
    || /\bgithub_pat_[a-z0-9_]+\b/i.test(value)
    || /data:image\/[a-z0-9.+-]+;base64,/i.test(value)
    || /[A-Za-z]:\\/.test(value)
    || /\\\\[^\\\s]+\\/.test(value)
    || /(?:^|\s)\/(?:Users|home|var|etc)\//.test(value);
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

function isPersistenceErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
