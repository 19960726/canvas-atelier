import { createReadStream } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';

import {
  parseCanvasProject,
  applyProjectTransaction,
  containsProtectedRendererPayload,
  MAX_GENERATION_REFERENCES,
  projectImageAssetSchema,
  projectVideoAssetSchema,
  projectTransactionSchema,
  createCanvasModuleNode,
  createSkillPromotionCandidateFingerprint,
  reviewSkillPromotionCandidate,
  rollbackSkillPromotionCandidate,
  skillPromotionCandidateSchema,
  type CanvasProject,
  type ProjectImageAsset,
  type ProjectAsset,
  type ProjectVideoAsset,
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
  type CreateProjectBridgeRequest,
  type CreateProjectBridgeResult,
  type ExportPackBridgeRequest,
  type ExportPackBridgeResult,
  type ImportPackBridgeRequest,
  type ImportPackBridgeResult,
  type ImportDroppedProjectMediaBridgeRequest,
  type ImportDroppedProjectMediaBridgeResult,
  type ImportProjectImageBridgeRequest,
  type ImportProjectImageBridgeResult,
  type ImportProjectVideoBridgeRequest,
  type ImportProjectVideoBridgeResult,
  type PasteProjectClipboardImageBridgeRequest,
  type PasteProjectClipboardImageBridgeResult,
  type PasteProjectClipboardVideoBridgeRequest,
  type PasteProjectClipboardVideoBridgeResult,
  type KnowledgeStateBridgeResult,
  type KnowledgeSyncStatusSummary,
  type ListProjectImagesBridgeRequest,
  type ListProjectVideosBridgeRequest,
  type OpenProjectBridgeRequest,
  type OpenProjectBridgeResult,
  type OpenRecentProjectBridgeRequest,
  type RecentProjectRequest,
  type RecentProjectSummary,
  type PrepareSkillCandidateReviewBridgeRequest,
  type PrepareSkillCandidateReviewBridgeResult,
  type PersistenceChannel,
  type PersistenceError,
  type ProjectManifest,
  type ProjectImageAssetSummary,
  type ProjectVideoAssetSummary,
  type ProjectClipboardImageTarget,
  type ProjectClipboardVideoTarget,
  type ProjectImageImportTarget,
  type RecoveryCandidateBridgeSummary,
  type RecoveryPlanBridgeRequest,
  type RecoveryPlanBridgeResult,
  type RefreshProjectBridgeRequest,
  type ReviewSkillCandidateBridgeRequest,
  type ReviewSkillCandidateBridgeResult,
  type RestoreBridgeRequest,
  type RestoreBridgeResult,
  type SkillCandidatePreparedManagedSnapshot,
  type SnapshotEnvelope,
  type StablePointBridgeRequest,
  type StablePointBridgeResult,
  type AddGenerationHistoryProjectReferencesBridgeRequest,
  type CompareGenerationHistoryBridgeRequest,
  type CopyGenerationHistoryToProjectBridgeRequest,
  type CopyGenerationHistoryToProjectBridgeResult,
  type ExportGenerationHistoryBridgeRequest,
  type ExportGenerationHistoryBridgeResult,
  type GenerationHistoryBatchBridgeRequest,
  type GenerationHistoryCapacityBridgeResult,
  type GenerationHistoryComparisonBridgeResult,
  type GenerationHistoryMutationBridgeResult,
  type GenerationHistoryPurgeBridgeRequest,
  type GenerationHistoryPurgeBridgeResult,
  type GenerationHistoryRecordBridgeRequest,
  type GenerationHistoryReusableBridgeResult,
  type ListGenerationHistoryBridgeRequest,
  type ListGenerationHistoryBridgeResult,
  type SetGenerationHistoryFavoriteBridgeRequest,
  type PhotoshopImportRequest,
  type PhotoshopImportResult,
} from './contracts.js';
import { AssetStore, type AssetMetadata } from './asset-store.js';
import type { ManagedReversePromptMediaIdentity } from './provider-contracts.js';
import type { ClipboardImageAdapter, TrustedClipboardImage } from './electron-clipboard-image.js';
import type { ClipboardVideoAdapter } from './electron-clipboard-video.js';
import { openSafeLocalMp4Source, type SafeLocalMp4Source } from './local-video-source.js';
import { NodeFileSystem, type FileSystem, writeAtomic } from './file-system.js';
import { GenerationHistoryService, type GenerationHistoryExportFileSummary } from './generation-history-service.js';
import { GenerationHistoryStore } from './generation-history-store.js';
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
  PROJECT_DIRECTORIES,
  ProjectRepository,
} from './project-repository.js';
import {
  RecoveryScanner,
  type OrphanRecoveryCandidate,
  type RecoveryCandidate,
  type RecoveryScanResult,
} from './recovery-scanner.js';
import { RecentProjectStore, type RecentProjectEntryInput } from './recent-project-store.js';
import {
  SnapshotScheduler,
  type SnapshotFlushResult,
  type SnapshotReason,
} from './snapshot-scheduler.js';
import { BRIDGE_CHANNELS } from './preload-api.js';
import { createProjectAssetDisplayUrl, parseProjectAssetDisplayUrl } from './project-asset-url.js';
import { parseGenerationHistoryAssetUrl } from './generation-history-asset-url.js';
import { parsePhotoshopImportRequest } from './photoshop-contract.js';
import { buildLegacyOrphanedImageResultRepair } from './legacy-generation-repair.js';
import {
  PhotoshopSmartObjectService,
  type PhotoshopManagedAssetResolver,
  type PhotoshopSmartObjectAdapter,
} from './photoshop-smart-object-service.js';

interface BridgeWriter {
  commit(request: Omit<CommitBridgeRequest, 'sessionId'>): Promise<CommitAck>;
}

interface ProjectRepositoryLike {
  create(root: string, options: { project: CanvasProject; projectId?: string; projectName?: string }): Promise<OpenedProjectSession>;
  close(session: OpenedProjectSession): Promise<void>;
  open(root: string, options: { mode: 'write' | 'read_only' }): Promise<OpenedProjectSession>;
  openJournalWriter(session: OpenedProjectSession): Promise<BridgeWriter>;
  readCurrentProject(session: OpenedProjectSession): Promise<CanvasProject>;
  readCurrentRevision?(session: OpenedProjectSession): Promise<number>;
  readStableProject?(session: OpenedProjectSession): Promise<CanvasProject>;
}

interface RecentProjectStoreLike {
  list(): Promise<readonly RecentProjectSummary[]>;
  relocate(recentProjectId: string, root: string): Promise<RecentProjectSummary | null>;
  remove(recentProjectId: string): Promise<readonly RecentProjectSummary[]>;
  resolvePreviewPath(recentProjectId: string): Promise<string | null>;
  resolveRoot(recentProjectId: string): Promise<string | null>;
  upsert(input: RecentProjectEntryInput): Promise<readonly RecentProjectSummary[]>;
}

interface ProjectAssetStoreLike {
  list(projectRoot: string, catalog?: readonly ProjectAsset[]): Promise<AssetMetadata[]>;
  resolvePath(
    projectRoot: string,
    assetId: string,
    extension: ProjectAsset['extension'],
    sha256: string,
    byteSize: number,
  ): Promise<string | null>;
  stageAndCommit(
    projectRoot: string,
    source: NodeJS.ReadableStream,
    options: {
      readonly commitReference?: (asset: AssetMetadata) => Promise<void>;
      readonly maxBytes?: number;
      readonly mediaType?: string;
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
  discoverLatestOrphanCandidate?(): Promise<OrphanRecoveryCandidate | null>;
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
  chooseCreateProjectRoot(project: CanvasProject): Promise<string | null>;
  chooseImportDestination(): Promise<string | null>;
  chooseImportPackSource(): Promise<string | null>;
  chooseKnowledgeRoot(request: ConfigureKnowledgeBaseBridgeRequest): Promise<string | null>;
  chooseHistoryExportDirectory(files: readonly GenerationHistoryExportFileSummary[]): Promise<string | null>;
  choosePackExportPath(session: BridgeSessionSummary): Promise<string | null>;
  chooseProjectImage(): Promise<string | null>;
  chooseProjectVideo(): Promise<string | null>;
  chooseProjectRoot(request: OpenProjectBridgeRequest): Promise<string | null>;
}

export interface DesktopBridgeHandlerDependencies {
  readonly appDataRoot?: string;
  readonly channel?: PersistenceChannel;
  readonly captureProjectPreview?: () => Promise<Uint8Array | null>;
  readonly clipboard?: ClipboardImageAdapter;
  readonly clipboardVideo?: ClipboardVideoAdapter;
  readonly createId?: () => string;
  readonly dialogs?: Partial<BridgeDialogAdapter>;
  readonly fileSystem?: FileSystem;
  readonly importerIsolationRoot?: string;
  readonly now?: () => string;
  readonly recentProjectStore?: RecentProjectStoreLike;
  readonly openVideoSource?: (sourcePath: string) => Promise<SafeLocalMp4Source | null>;
  readonly approvedSnapshotOutbox?: ApprovedSnapshotOutboxLike;
  readonly assetStore?: ProjectAssetStoreLike;
  readonly knowledgeConfigurationSync?: KnowledgeConfigurationSyncLike;
  readonly knowledgeRefreshService?: KnowledgeRefreshServiceLike;
  readonly knowledgeStore?: KnowledgeStoreLike;
  readonly knowledgeSyncStatusProvider?: KnowledgeSyncStatusProviderLike;
  readonly historyService?: GenerationHistoryService;
  readonly historyIsNetworkPath?: (path: string) => boolean | Promise<boolean>;
  readonly historyStore?: GenerationHistoryStore;
  readonly packExporter?: NovusPackExporterLike;
  readonly packImporter?: NovusPackImporterLike;
  readonly recoveryScanner?: RecoveryScannerLike;
  readonly repository?: Partial<ProjectRepositoryLike>;
  readonly snapshotScheduler?: SnapshotSchedulerLike;
  readonly photoshopSmartObjectAdapter?: PhotoshopSmartObjectAdapter;
}

export interface DesktopBridgeHandlers {
  closeAllProjects(): Promise<void>;
  closeProject(event: unknown, request: unknown): Promise<void>;
  createProject(event: unknown, request: unknown): Promise<CreateProjectBridgeResult | null>;
  commit(event: unknown, request: unknown): Promise<CommitAck>;
  configureKnowledgeBase(event: unknown, request: unknown): Promise<KnowledgeBaseStateSummary | null>;
  createStablePoint(event: unknown, request: unknown): Promise<StablePointBridgeResult>;
  exportPack(event: unknown, request: unknown): Promise<ExportPackBridgeResult | null>;
  getKnowledgeState(event: unknown, request: unknown): Promise<KnowledgeStateBridgeResult>;
  getRecoveryPlan(event: unknown, request: unknown): Promise<RecoveryPlanBridgeResult>;
  importPack(event: unknown, request: unknown): Promise<ImportPackBridgeResult | null>;
  importDroppedProjectMedia(event: unknown, request: unknown): Promise<ImportDroppedProjectMediaBridgeResult | null>;
  importProjectImage(event: unknown, request: unknown): Promise<ImportProjectImageBridgeResult | null>;
  importProjectImageToPhotoshop(event: unknown, request: unknown): Promise<PhotoshopImportResult>;
  importProjectVideo(event: unknown, request: unknown): Promise<ImportProjectVideoBridgeResult | null>;
  pasteProjectClipboardImage(event: unknown, request: unknown): Promise<PasteProjectClipboardImageBridgeResult | null>;
  writeClipboardImage(event: unknown, request: unknown): Promise<boolean>;
  pasteProjectClipboardVideo(event: unknown, request: unknown): Promise<PasteProjectClipboardVideoBridgeResult | null>;
  listProjectImages(event: unknown, request: unknown): Promise<ProjectImageAssetSummary[]>;
  listProjectVideos(event: unknown, request: unknown): Promise<ProjectVideoAssetSummary[]>;
  listGenerationHistory(event: unknown, request: unknown): Promise<ListGenerationHistoryBridgeResult>;
  getGenerationHistoryCapacity(event: unknown, request?: unknown): Promise<GenerationHistoryCapacityBridgeResult>;
  setGenerationHistoryFavorite(event: unknown, request: unknown): Promise<GenerationHistoryMutationBridgeResult>;
  getGenerationHistoryReusableSummary(event: unknown, request: unknown): Promise<GenerationHistoryReusableBridgeResult>;
  compareGenerationHistory(event: unknown, request: unknown): Promise<GenerationHistoryComparisonBridgeResult>;
  copyGenerationHistoryToProject(event: unknown, request: unknown): Promise<CopyGenerationHistoryToProjectBridgeResult>;
  addGenerationHistoryProjectReferences(event: unknown, request: unknown): Promise<GenerationHistoryMutationBridgeResult[]>;
  exportGenerationHistory(event: unknown, request: unknown): Promise<ExportGenerationHistoryBridgeResult>;
  trashGenerationHistory(event: unknown, request: unknown): Promise<GenerationHistoryMutationBridgeResult>;
  restoreGenerationHistory(event: unknown, request: unknown): Promise<GenerationHistoryMutationBridgeResult>;
  permanentlyDeleteGenerationHistory(event: unknown, request: unknown): Promise<GenerationHistoryPurgeBridgeResult>;
  purgeGenerationHistory(event: unknown, request: unknown): Promise<GenerationHistoryPurgeBridgeResult>;
  listRecentProjects(event: unknown, request?: unknown): Promise<readonly RecentProjectSummary[]>;
  openLatestRecoveryPreview(event: unknown): Promise<OpenProjectBridgeResult | null>;
  openProject(event: unknown, request: unknown): Promise<OpenProjectBridgeResult | null>;
  refreshProject(event: unknown, request: unknown): Promise<OpenProjectBridgeResult>;
  openRecentProject(event: unknown, request: unknown): Promise<OpenProjectBridgeResult | null>;
  relocateRecentProject(event: unknown, request: unknown): Promise<RecentProjectSummary | null>;
  removeRecentProject(event: unknown, request: unknown): Promise<readonly RecentProjectSummary[]>;
  prepareSkillCandidateReview(event: unknown, request: unknown): Promise<PrepareSkillCandidateReviewBridgeResult>;
  reviewSkillCandidate(event: unknown, request: unknown): Promise<ReviewSkillCandidateBridgeResult>;
  readManagedSkillChatImages(sessionId: string, referenceAssetIds: readonly string[]): Promise<readonly ManagedSkillChatImageContent[]>;
  storeGeneratedImage(sessionId: string, bytes: Uint8Array, mediaType: string): Promise<ProjectImageAsset>;
  storeGeneratedVideo(sessionId: string, bytes: Uint8Array, mediaType: 'video/mp4'): Promise<ProjectVideoAsset>;
  restore(event: unknown, request: unknown): Promise<RestoreBridgeResult>;
  readManagedReverseMedia(sessionId: string, media: readonly ManagedReversePromptMediaIdentity[]): Promise<readonly ManagedReversePromptMediaContent[]>;
  resolveProjectImagePath(displayUrl: string): Promise<string | null>;
  resolveRecentProjectPreviewPath(displayUrl: string): Promise<string | null>;
  resolveGenerationHistoryImagePath(displayUrl: string): Promise<string | null>;
}

export interface ManagedReversePromptMediaContent {
  readonly bytes: Uint8Array;
  readonly mediaType: ManagedReversePromptMediaIdentity['mediaType'];
}

export interface ManagedSkillChatImageContent {
  readonly bytes: Uint8Array;
  readonly mediaType: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';
}

export interface DesktopIpcMainLike {
  handle(channel: string, listener: (event: unknown, request: unknown) => Promise<unknown>): void;
}

interface BridgeSessionContext {
  assets: Map<string, ProjectAsset>;
  closeState: 'open' | 'closing' | 'retry_only';
  imageImportInFlight: boolean;
  maintenanceTail: Promise<void>;
  openedAt: string;
  recoveryRequired: boolean;
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
const MAX_PROJECT_VIDEO_BYTES = 4 * 1024 * 1024 * 1024;
const PROJECT_PREVIEW_CAPTURE_TIMEOUT_MS = 2_000;
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
  const appDataRoot = dependencies.appDataRoot ?? process.cwd();
  const now = dependencies.now ?? (() => new Date().toISOString());
  const recentProjectStore = dependencies.recentProjectStore ?? new RecentProjectStore({
    appDataRoot: dependencies.appDataRoot ?? process.cwd(),
    fileSystem,
  });
  const assetStore = dependencies.assetStore ?? new AssetStore();
  const createId = dependencies.createId ?? defaultId;
  const clipboard = dependencies.clipboard ?? { readImage: async () => null, writeImage: async () => false };
  const clipboardVideo = dependencies.clipboardVideo ?? { readVideoPath: async () => null };
  const openVideoSource = dependencies.openVideoSource ?? openSafeLocalMp4Source;
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
  const historyStore = dependencies.historyStore ?? new GenerationHistoryStore({
    historyRoot: join(dependencies.appDataRoot ?? process.cwd(), 'generation-history'),
    ownedRoot: dependencies.appDataRoot ?? process.cwd(),
    fileSystem,
    isNetworkPath: dependencies.historyIsNetworkPath,
  });
  const historyService = dependencies.historyService ?? new GenerationHistoryService({
    assetStore: assetStore instanceof AssetStore ? assetStore : undefined,
    store: historyStore,
  });
  const sessions = new Map<string, BridgeSessionContext>();
  const photoshopAssetResolver: PhotoshopManagedAssetResolver = {
    async resolve(request) {
      const session = requireSession(sessions, request.sessionId);
      const project = await repository.readCurrentProject(session.session);
      const asset = (project.assets ?? []).find((candidate) => candidate.assetId === request.assetId);
      if (asset === undefined) return null;
      if (!asset.mediaType.startsWith('image/')) {
        return { absolutePath: '', label: asset.label, mediaType: asset.mediaType };
      }
      const absolutePath = await assetStore.resolvePath(
        session.session.root,
        asset.assetId,
        asset.extension,
        asset.sha256,
        asset.byteSize,
      );
      if (absolutePath === null) return null;
      return { absolutePath, label: asset.label, mediaType: asset.mediaType };
    },
  };
  const photoshopSmartObjectService = new PhotoshopSmartObjectService(
    photoshopAssetResolver,
    dependencies.photoshopSmartObjectAdapter ?? {
      async place() {
        return { ok: false, code: 'desktop_bridge_unavailable' };
      },
    },
  );

  async function createProject(_event: unknown, request: unknown): Promise<CreateProjectBridgeResult | null> {
    const validated = validateCreateProjectBridgeRequest(request);
    const projectsRoot = join(appDataRoot, 'projects');
    await fileSystem.mkdir(projectsRoot, { recursive: true });
    const root = join(projectsRoot, `${validated.project.id}.novus-project`);
    const openedAt = now();
    const opened = await requireMethod(repository, 'create')(root, {
      project: validated.project,
      projectId: validated.project.id,
      projectName: validated.project.name,
    });
    const sessionId = createId();
    let registered = false;
    try {
      const summary = await summarizeSession(repository, sessionId, opened);
      const writer = await requireMethod(repository, 'openJournalWriter')(opened);
      sessions.set(sessionId, {
        assets: new Map((summary.project.assets ?? []).map((asset) => [asset.assetId, asset])),
        closeState: 'open',
        imageImportInFlight: false,
        maintenanceTail: Promise.resolve(),
        openedAt,
        recoveryCandidatePaths: new Map(),
        recoveryRequired: false,
        session: opened,
        sessionId,
        writer,
      });
      registered = true;
      await writeProjectPreview(opened.root);
      await recordRecentProject(summary, opened.root, openedAt, openedAt);
      return summary;
    } catch (error) {
      if (registered) sessions.delete(sessionId);
      await requireMethod(repository, 'close')(opened).catch(() => undefined);
      throw error;
    }
  }
  async function listRecentProjects(_event: unknown, _request?: unknown): Promise<readonly RecentProjectSummary[]> {
    return recentProjectStore.list();
  }

  async function openProject(_event: unknown, request: unknown): Promise<OpenProjectBridgeResult | null> {
    const validated = validateOpenProjectBridgeRequest(request);
    const root = await dialogs.chooseProjectRoot(validated);
    if (root === null) return null;
    return openProjectAtRoot(root, validated.mode);
  }

  async function openLatestRecoveryPreview(_event: unknown): Promise<OpenProjectBridgeResult | null> {
    const candidate = await recoveryScanner.discoverLatestOrphanCandidate?.() ?? null;
    if (candidate === null) return null;
    const root = join(appDataRoot, 'projects', `${candidate.projectId}.novus-project`);
    if (await pathExists(fileSystem, root)) return null;
    const sessionId = createId();
    const candidateId = createId();
    const openedAt = now();
    const session: OpenedProjectSession = {
      lock: null,
      manifest: createOrphanRecoveryManifest(candidate),
      mode: 'write',
      root,
    };
    const summary = summarizeRecoveryPreview(sessionId, session, candidate);
    sessions.set(sessionId, {
      assets: new Map((summary.project.assets ?? []).map((asset) => [asset.assetId, asset])),
      closeState: 'open',
      imageImportInFlight: false,
      maintenanceTail: Promise.resolve(),
      openedAt,
      recoveryCandidatePaths: new Map([[candidateId, candidate.path]]),
      recoveryRequired: true,
      session,
      sessionId,
      writer: null,
    });
    return summary;
  }

  async function refreshProject(_event: unknown, request: unknown): Promise<OpenProjectBridgeResult> {
    const validated = validateSessionRequest(request) as RefreshProjectBridgeRequest;
    const session = requireSession(sessions, validated.sessionId);
    return enqueueSessionMaintenance(session, async () => {
      if (session.recoveryRequired) {
        throw createPersistenceError(
          'RECOVERY_REQUIRED',
          false,
          'Recovery preview must be restored or discarded before refreshing',
        );
      }
      if (session.session.mode === 'write') {
        return summarizeSession(repository, session.sessionId, session.session);
      }

      let candidate: OpenedProjectSession | null = null;
      try {
        candidate = await requireMethod(repository, 'open')(session.session.root, { mode: 'write' });
        if (candidate.mode !== 'write') {
          return summarizeSession(repository, session.sessionId, session.session);
        }
        const writer = await requireMethod(repository, 'openJournalWriter')(candidate);
        const summary = await summarizeSession(repository, session.sessionId, candidate);
        session.session = candidate;
        session.writer = writer;
        session.assets = new Map((summary.project.assets ?? []).map((asset) => [asset.assetId, asset]));
        return summary;
      } catch {
        if (candidate?.mode === 'write') {
          try {
            await requireMethod(repository, 'close')(candidate);
          } catch {
            // Keep the original read-only context so a later refresh can retry.
          }
        }
        return summarizeSession(repository, session.sessionId, session.session);
      }
    });
  }

  async function openRecentProject(_event: unknown, request: unknown): Promise<OpenProjectBridgeResult | null> {
    const validated = validateOpenRecentProjectBridgeRequest(request);
    const root = await recentProjectStore.resolveRoot(validated.recentProjectId);
    if (root === null) return null;
    return openProjectAtRoot(root, validated.mode);
  }

  async function removeRecentProject(_event: unknown, request: unknown): Promise<readonly RecentProjectSummary[]> {
    const validated = validateRecentProjectRequest(request);
    return recentProjectStore.remove(validated.recentProjectId);
  }

  async function relocateRecentProject(_event: unknown, request: unknown): Promise<RecentProjectSummary | null> {
    const validated = validateRecentProjectRequest(request);
    const root = await dialogs.chooseProjectRoot({ mode: 'write' });
    if (root === null) return null;
    return recentProjectStore.relocate(validated.recentProjectId, root);
  }

  async function openProjectAtRoot(
    root: string,
    mode: 'write' | 'read_only',
  ): Promise<OpenProjectBridgeResult> {
    const openedAt = now();
    const opened = await requireMethod(repository, 'open')(root, { mode });
    const sessionId = createId();
    let registered = false;
    try {
      let summary: BridgeSessionSummary;
      try {
        summary = await summarizeSession(repository, sessionId, opened);
      } catch (error) {
        if (!hasPersistenceErrorCode(error, 'CORRUPT_SNAPSHOT')) throw error;
        const scan = await recoveryScanner.scan(opened.root);
        const candidate = selectHighestCompleteRecoveryCandidate(scan, opened.manifest.projectId);
        if (candidate === null) throw error;
        summary = summarizeRecoveryPreview(sessionId, opened, candidate);
        sessions.set(sessionId, {
          assets: new Map((summary.project.assets ?? []).map((asset) => [asset.assetId, asset])),
          closeState: 'open',
          imageImportInFlight: false,
          maintenanceTail: Promise.resolve(),
          openedAt,
          recoveryCandidatePaths: new Map(),
          recoveryRequired: true,
          session: opened,
          sessionId,
          writer: null,
        });
        registered = true;
        await recordRecentProject(summary, opened.root, openedAt, openedAt);
        return summary;
      }

      const writer = opened.mode === 'write'
        ? await requireMethod(repository, 'openJournalWriter')(opened)
        : null;
      if (writer !== null && repository.readStableProject !== undefined) {
        try {
          const stableProject = await repository.readStableProject(opened);
          const currentProject = await repository.readCurrentProject(opened);
          const repair = buildLegacyOrphanedImageResultRepair(stableProject, currentProject);
          if (repair !== null) {
            applyProjectTransaction(currentProject, repair);
            await writer.commit({
              baseRevision: await readCurrentRevision(repository, opened),
              kind: 'system',
              projectId: currentProject.id,
              transaction: repair,
            });
            summary = await summarizeSession(repository, sessionId, opened);
          }
        } catch {
          // A best-effort legacy repair must never prevent the project from opening.
        }
      }
      sessions.set(sessionId, {
        assets: new Map((summary.project.assets ?? []).map((asset) => [asset.assetId, asset])),
        closeState: 'open',
        imageImportInFlight: false,
        maintenanceTail: Promise.resolve(),
        openedAt,
        recoveryCandidatePaths: new Map(),
        recoveryRequired: false,
        session: opened,
        sessionId,
        writer,
      });
      registered = true;
      await reconcileStagedKnowledgeTransitionsForProject(opened);
      await recordRecentProject(summary, opened.root, openedAt, openedAt);
      return summary;
    } catch (error) {
      if (registered) sessions.delete(sessionId);
      try {
        await requireMethod(repository, 'close')(opened);
      } catch {
        // Preserve the open initialization failure for the caller.
      }
      throw error;
    }
  }
  async function commit(_event: unknown, request: unknown): Promise<CommitAck> {
    const validated = validateCommitBridgeRequest(request);
    if (validated.transaction.operations.some((operation) => operation.kind === 'set_project_assets')) {
      throw invalidRequest('Project assets can only be changed through the managed image bridge');
    }
    const session = requireWritableSession(sessions, validated.sessionId);
    assertPublicBridgePayload(validated.transaction);
    return enqueueSessionMaintenance(session, async () => {
      if (session.writer === null) {
        throw createPersistenceError(
          'CONCURRENT_WRITER',
          true,
          'Commit requires a writable desktop session',
        );
      }
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
      const savedProject = await repository.readCurrentProject(session.session);
      await recordRecentProject({
        ...await summarizeSession(repository, session.sessionId, session.session),
        project: savedProject,
      }, session.session.root, session.openedAt, now());
      return ack;
    });
  }

  async function createStablePoint(
    _event: unknown,
    request: unknown,
  ): Promise<StablePointBridgeResult> {
    const validated = validateSessionRequest(request);
    const session = requireWritableSession(sessions, validated.sessionId);
    return enqueueSessionMaintenance(session, async () => {
      const flushed = await snapshotScheduler.flush(session.session, { reason: 'stable_point' });
      session.session = await refreshSessionManifest(fileSystem, session.session);
      await writeProjectPreview(session.session.root);
      return {
        path: flushed.path,
        reason: 'stable_point',
        revision: flushed.revision,
        snapshotId: flushed.snapshotId,
      };
    });
  }

  async function getRecoveryPlan(
    _event: unknown,
    request: unknown,
  ): Promise<RecoveryPlanBridgeResult> {
    const validated = validateSessionRequest(request);
    const session = requireSession(sessions, validated.sessionId);
    if (
      session.recoveryRequired
      && session.recoveryCandidatePaths.size > 0
      && !await pathExists(fileSystem, session.session.root)
    ) {
      return retainedOrphanRecoveryPlan(fileSystem, session);
    }
    const scan = await recoveryScanner.scan(session.session.root);
    session.recoveryCandidatePaths.clear();
    return sanitizeRecoveryPlan(scan, session.recoveryCandidatePaths, createId);
  }

  async function restore(_event: unknown, request: unknown): Promise<RestoreBridgeResult> {
    const validated = validateRestoreBridgeRequest(request);
    const session = requireWritableSession(sessions, validated.sessionId, { allowRecovery: true });
    if (validated.candidateId === undefined) {
      throw createPersistenceError('INVALID_REQUEST', false, 'Restore candidate id is required');
    }
    return enqueueSessionMaintenance(session, async () => {
      const mirrorPath = session.recoveryCandidatePaths.get(validated.candidateId!);
      if (mirrorPath === undefined) {
        throw createPersistenceError('INVALID_REQUEST', false, 'Restore candidate is unavailable');
      }
      const previewSession = session.session;
      let restoredSession: OpenedProjectSession | null = null;
      let reopenedSession: OpenedProjectSession | null = null;
      let recreatedRoot = false;
      try {
        const restored = await restoreRecoveryCandidate(fileSystem, createId, session, mirrorPath, appDataRoot);
        const restoredManifest = restored.manifest;
        recreatedRoot = restored.recreatedRoot;
        if (recreatedRoot) {
          releaseJournalState(join(previewSession.root, ...ACTIVE_JOURNAL_SEGMENT.split('/')), restoredManifest.projectId);
          reopenedSession = await requireMethod(repository, 'open')(previewSession.root, { mode: 'write' });
          restoredSession = reopenedSession;
        } else {
          restoredSession = {
            ...previewSession,
            manifest: restoredManifest,
          };
        }
        let restoredWriter = session.writer;
        if (restoredSession.mode === 'write') {
          releaseJournalState(join(restoredSession.root, ...ACTIVE_JOURNAL_SEGMENT.split('/')), restoredManifest.projectId);
          restoredWriter = await requireMethod(repository, 'openJournalWriter')(restoredSession);
        }

        const summary = await summarizeSession(repository, session.sessionId, restoredSession);
        await writeProjectPreview(restoredSession.root);
        await recordRecentProject(summary, restoredSession.root, session.openedAt, now());
        session.recoveryCandidatePaths.clear();
        session.session = restoredSession;
        session.writer = restoredWriter;
        session.recoveryRequired = false;
        session.assets = new Map((summary.project.assets ?? []).map((asset) => [asset.assetId, asset]));
        return {
          ...summary,
          restoredRevision: restoredManifest.stableSnapshotRevision,
        };
      } catch (error) {
        if (reopenedSession !== null) {
          try {
            await requireMethod(repository, 'close')(reopenedSession);
          } catch {
            // Preserve the restoration failure for retry.
          }
        }
        if (recreatedRoot) {
          await fileSystem.rm(previewSession.root, { force: true, recursive: true }).catch(() => undefined);
        }
        session.session = previewSession;
        session.writer = null;
        session.recoveryRequired = true;
        throw error;
      }
    });
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
    const sessionId = createId();
    let registered = false;
    try {
      const summary = await summarizeSession(repository, sessionId, opened);
      const writer = opened.mode === 'write'
        ? await requireMethod(repository, 'openJournalWriter')(opened)
        : null;
      sessions.set(sessionId, {
        assets: new Map((summary.project.assets ?? []).map((asset) => [asset.assetId, asset])),
        closeState: 'open',
        imageImportInFlight: false,
        maintenanceTail: Promise.resolve(),
        openedAt: now(),
        recoveryCandidatePaths: new Map(),
        recoveryRequired: false,
        session: opened,
        sessionId,
        writer,
      });
      registered = true;
      await reconcileStagedKnowledgeTransitionsForProject(opened);

      return {
        ...summary,
        importedRevision: result.importedRevision,
      };
    } catch (error) {
      if (registered) sessions.delete(sessionId);
      try {
        await requireMethod(repository, 'close')(opened);
      } catch {
        // Preserve the import initialization failure for the caller.
      }
      throw error;
    }
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
    const openedSession = session.session;
    const targetNodeId = validated.target.kind === 'module' ? validated.target.nodeId : null;
    session.imageImportInFlight = true;
    try {
      const sourcePath = await dialogs.chooseProjectImage();
      if (sourcePath === null) return null;
      return enqueueSessionMaintenance(session, async () => {
        const currentSession = requireWritableSession(sessions, validated.sessionId);
        if (currentSession !== session || currentSession.session !== openedSession) {
          throw createPersistenceError('INVALID_SESSION', false, 'Desktop session changed before image import');
        }
        if (currentSession.writer === null) {
          throw createPersistenceError('CONCURRENT_WRITER', true, 'Image import requires a writable desktop session');
        }
        const writer = currentSession.writer;
        await validateProjectImageTarget(repository, currentSession, validated.target);

        const commitState: {
          value?: { readonly ack: CommitAck; readonly asset: ProjectImageAsset; readonly project: CanvasProject };
        } = {};
        await assetStore.stageAndCommit(currentSession.session.root, createReadStream(sourcePath), {
          maxBytes: MAX_PROJECT_IMAGE_BYTES,
          originalName: basename(sourcePath),
          commitReference: async (storedAsset) => {
            const currentProject = await repository.readCurrentProject(currentSession.session);
            const currentRevision = await readCurrentRevision(repository, currentSession.session);
            const projectAsset = createImportedProjectImageAsset(storedAsset, sourcePath);
            const transaction = createProjectImageImportTransaction(
              currentProject,
              validated.target,
              projectAsset,
              createId,
            );
            const nextProject = applyProjectTransaction(currentProject, transaction);
            const ack = await writer.commit({
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
        currentSession.assets.set(committed.asset.assetId, committed.asset);
        await flushScheduledSnapshotAfterCommit(currentSession, committed.ack, 'canvas');
        const summary = createProjectImageSummary(
          committed.asset,
          currentSession.sessionId,
          countProjectImageUsage(committed.project, committed.asset.assetId),
        );
        const result = {
          asset: summary,
          currentRevision: committed.ack.revision,
          project: committed.project,
        };
        assertPublicBridgePayload(result);
        return result;
      });
    } finally {
      session.imageImportInFlight = false;
    }
  }

  async function importProjectImageToPhotoshop(
    _event: unknown,
    request: unknown,
  ): Promise<PhotoshopImportResult> {
    const validated: PhotoshopImportRequest = parsePhotoshopImportRequest(request);
    return photoshopSmartObjectService.import(validated);
  }

  async function pasteProjectClipboardImage(
    _event: unknown,
    request: unknown,
  ): Promise<PasteProjectClipboardImageBridgeResult | null> {
    const validated = validatePasteProjectClipboardImageBridgeRequest(request);
    const session = requireWritableSession(sessions, validated.sessionId);
    if (session.writer === null) {
      throw createPersistenceError('CONCURRENT_WRITER', true, 'Clipboard image paste requires a writable desktop session');
    }
    if (session.imageImportInFlight) {
      throw invalidRequest('A project image import is already in progress');
    }
    session.imageImportInFlight = true;
    try {
      return enqueueSessionMaintenance(session, async () => {
        const currentSession = requireWritableSession(sessions, validated.sessionId);
        if (currentSession !== session || currentSession.writer === null) {
          throw createPersistenceError('INVALID_SESSION', false, 'Desktop session changed before clipboard image paste');
        }
        const existing = await readExistingClipboardImagePaste(assetStore, repository, currentSession, validated.target);
        if (existing !== null) return existing;
        if (validated.target.kind === 'new_image_input' && validated.target.reconcileOnly === true) return null;
        const image = await clipboard.readImage();
        if (image === null) return null;
        const commitState: {
          value?: { readonly ack: CommitAck; readonly asset: ProjectImageAsset; readonly project: CanvasProject };
        } = {};
        await assetStore.stageAndCommit(currentSession.session.root, Readable.from([image.bytes]), {
          maxBytes: MAX_PROJECT_IMAGE_BYTES,
          originalName: 'clipboard.png',
          commitReference: async (storedAsset) => {
            assertClipboardAssetMatches(storedAsset, image);
            const currentProject = await repository.readCurrentProject(currentSession.session);
            const currentRevision = await readCurrentRevision(repository, currentSession.session);
            const projectAsset = createClipboardProjectImageAsset(storedAsset, image.label);
            const transaction = createClipboardImagePasteTransaction(
              currentProject,
              validated.target,
              projectAsset,
            );
            const nextProject = applyProjectTransaction(currentProject, transaction);
            const ack = await currentSession.writer!.commit({
              baseRevision: currentRevision,
              kind: 'canvas',
              projectId: currentProject.id,
              transaction,
            });
            commitState.value = { ack, asset: projectAsset, project: nextProject };
          },
        });
        const committed = commitState.value;
        if (committed === undefined) throw invalidRequest('Clipboard image paste did not reach its durable commit boundary');
        currentSession.assets.set(committed.asset.assetId, committed.asset);
        await flushScheduledSnapshotAfterCommit(currentSession, committed.ack, 'canvas');
        const result = {
          asset: createProjectImageSummary(
            committed.asset,
            currentSession.sessionId,
            countProjectImageUsage(committed.project, committed.asset.assetId),
          ),
          currentRevision: committed.ack.revision,
          project: committed.project,
        };
        assertPublicBridgePayload(result);
        return result;
      });
    } finally {
      session.imageImportInFlight = false;
    }
  }

  async function writeClipboardImage(_event: unknown, request: unknown): Promise<boolean> {
    if (!(request instanceof Uint8Array) && !Buffer.isBuffer(request)) return false;
    return clipboard.writeImage?.(new Uint8Array(request)) ?? false;
  }

  async function importDroppedProjectMedia(
    _event: unknown,
    payload: unknown,
  ): Promise<ImportDroppedProjectMediaBridgeResult | null> {
    const { request, sourcePath } = validateImportDroppedProjectMediaPayload(payload);
    const session = requireWritableSession(sessions, request.sessionId);
    if (session.writer === null) {
      throw createPersistenceError('CONCURRENT_WRITER', true, 'Dropped media import requires a writable desktop session');
    }
    if (session.imageImportInFlight) throw invalidRequest('A project asset import is already in progress');
    const openedSession = session.session;
    session.imageImportInFlight = true;
    try {
      return await enqueueSessionMaintenance(session, async () => {
        const currentSession = requireWritableSession(sessions, request.sessionId);
        if (currentSession !== session || currentSession.session !== openedSession || currentSession.writer === null) {
          throw createPersistenceError('INVALID_SESSION', false, 'Desktop session changed before dropped media import');
        }
        const videoSource = await openVideoSource(sourcePath);
        if (videoSource !== null) {
          if (request.target.kind !== 'new_media_input') {
            await videoSource.close().catch(() => undefined);
            throw invalidRequest('An image or Agent image reference target can only import an image');
          }
          const videoTarget = request.target;
          const commitState: {
            value?: { readonly asset: ProjectVideoAsset; readonly project: CanvasProject; readonly revision: number };
          } = {};
          try {
            await assetStore.stageAndCommit(currentSession.session.root, videoSource.stream, {
              maxBytes: MAX_PROJECT_VIDEO_BYTES,
              mediaType: 'video/mp4',
              originalName: basename(sourcePath),
              commitReference: async (storedAsset) => {
                assertVideoSourceSizeUnchanged(storedAsset, videoSource.byteSize);
                const currentProject = await repository.readCurrentProject(currentSession.session);
                const currentRevision = await readCurrentRevision(repository, currentSession.session);
                const projectAsset = createImportedProjectVideoAsset(storedAsset);
                const transaction = createDroppedVideoImportTransaction(currentProject, videoTarget, projectAsset);
                const nextProject = applyProjectTransaction(currentProject, transaction);
                const revision = await commitWithDurableReconciliation(
                  currentSession.writer!,
                  repository,
                  currentSession.session,
                  { baseRevision: currentRevision, kind: 'canvas', projectId: currentProject.id, transaction },
                  nextProject,
                );
                commitState.value = { asset: projectAsset, project: nextProject, revision };
              },
            });
          } finally {
            await videoSource.close().catch(() => undefined);
          }
          const committed = commitState.value;
          if (committed === undefined) throw invalidRequest('Dropped video import did not reach its durable commit boundary');
          currentSession.assets.set(committed.asset.assetId, committed.asset);
          await flushScheduledSnapshot(currentSession, {
            closing: false,
            lastTransactionKind: 'canvas',
            revision: committed.revision,
            stablePoint: false,
          });
          const result = {
            asset: createProjectVideoSummary(
              committed.asset,
              currentSession.sessionId,
              countProjectImageUsage(committed.project, committed.asset.assetId),
            ),
            currentRevision: committed.revision,
            project: committed.project,
          };
          assertPublicBridgePayload(result);
          return result;
        }
        if (extname(sourcePath).toLowerCase() === '.mp4') {
          throw invalidRequest('Dropped video must be one regular local MP4 file within the size limit');
        }
        const commitState: {
          value?: { readonly ack: CommitAck; readonly asset: ProjectImageAsset; readonly project: CanvasProject };
        } = {};
        await assetStore.stageAndCommit(currentSession.session.root, createReadStream(sourcePath), {
          maxBytes: MAX_PROJECT_IMAGE_BYTES,
          originalName: basename(sourcePath),
          commitReference: async (storedAsset) => {
            const currentProject = await repository.readCurrentProject(currentSession.session);
            const currentRevision = await readCurrentRevision(repository, currentSession.session);
            const projectAsset = createImportedProjectImageAsset(storedAsset, sourcePath);
            const transaction = createDroppedImageImportTransaction(currentProject, request.target, projectAsset);
            const nextProject = applyProjectTransaction(currentProject, transaction);
            const ack = await currentSession.writer!.commit({
              baseRevision: currentRevision,
              kind: 'canvas',
              projectId: currentProject.id,
              transaction,
            });
            commitState.value = { ack, asset: projectAsset, project: nextProject };
          },
        });
        const committed = commitState.value;
        if (committed === undefined) throw invalidRequest('Dropped media import did not reach its durable commit boundary');
        currentSession.assets.set(committed.asset.assetId, committed.asset);
        await flushScheduledSnapshotAfterCommit(currentSession, committed.ack, 'canvas');
        const result = {
          asset: createProjectImageSummary(
            committed.asset,
            currentSession.sessionId,
            countProjectImageUsage(committed.project, committed.asset.assetId),
          ),
          currentRevision: committed.ack.revision,
          project: committed.project,
        };
        assertPublicBridgePayload(result);
        return result;
      });
    } finally {
      session.imageImportInFlight = false;
    }
  }

  async function importProjectVideo(
    _event: unknown,
    request: unknown,
  ): Promise<ImportProjectVideoBridgeResult | null> {
    const validated = validateImportProjectVideoBridgeRequest(request);
    const session = requireWritableSession(sessions, validated.sessionId);
    if (session.writer === null) {
      throw createPersistenceError('CONCURRENT_WRITER', true, 'Video import requires a writable desktop session');
    }
    if (session.imageImportInFlight) throw invalidRequest('A project asset import is already in progress');
    const openedSession = session.session;
    const targetNodeId = validated.target.kind === 'module' ? validated.target.nodeId : null;
    session.imageImportInFlight = true;
    try {
      const sourcePath = await dialogs.chooseProjectVideo();
      if (sourcePath === null) return null;
      return enqueueSessionMaintenance(session, async () => {
        const currentSession = requireWritableSession(sessions, validated.sessionId);
        if (currentSession !== session || currentSession.session !== openedSession || currentSession.writer === null) {
          throw createPersistenceError('INVALID_SESSION', false, 'Desktop session changed before video import');
        }
        const currentProject = await repository.readCurrentProject(currentSession.session);
        if (targetNodeId !== null) {
          const node = currentProject.nodes.find((candidate) => candidate.id === targetNodeId);
          if (node?.type !== 'module' || node.data.moduleType !== 'video_input') {
            throw invalidRequest('Project video module target is not import-capable');
          }
        }
        const source = await openVideoSource(sourcePath);
        if (source === null) {
          throw invalidRequest('Video source must be one regular local MP4 file within the size limit');
        }
        const writer = currentSession.writer;
        const commitState: {
          value?: { readonly asset: ProjectVideoAsset; readonly project: CanvasProject; readonly revision: number };
        } = {};
        try {
          await assetStore.stageAndCommit(currentSession.session.root, source.stream, {
            maxBytes: MAX_PROJECT_VIDEO_BYTES,
            mediaType: 'video/mp4',
            originalName: basename(sourcePath),
            commitReference: async (storedAsset) => {
              assertVideoSourceSizeUnchanged(storedAsset, source.byteSize);
              const durableProject = await repository.readCurrentProject(currentSession.session);
              const targetNode = targetNodeId === null
                ? undefined
                : durableProject.nodes.find((candidate) => candidate.id === targetNodeId);
              if (targetNodeId !== null && (targetNode?.type !== 'module' || targetNode.data.moduleType !== 'video_input')) {
                throw invalidRequest('Project video module target changed before commit');
              }
              const asset = createImportedProjectVideoAsset(storedAsset);
              const operations: ProjectTransaction['operations'] = [
                { kind: 'set_project_assets', assets: upsertProjectAsset(durableProject.assets ?? [], asset) },
              ];
              if (targetNode?.type === 'module') {
                const nextNode = {
                  ...targetNode,
                  data: { ...targetNode.data, config: { ...targetNode.data.config, assetId: asset.assetId } },
                };
                operations.push({ kind: 'canvas', operation: { kind: 'update_node', node: nextNode } });
              }
              const transaction: ProjectTransaction = {
                id: `import-project-video-${asset.assetId}-${createId()}`,
                label: validated.target.kind === 'agent_reference'
                  ? 'Import managed Agent reference video'
                  : 'Import managed project video',
                operations,
              };
              const nextProject = applyProjectTransaction(durableProject, transaction);
              const commitRequest = {
                baseRevision: await readCurrentRevision(repository, currentSession.session),
                kind: 'canvas',
                projectId: durableProject.id,
                transaction,
              } as const;
              const revision = await commitWithDurableReconciliation(
                writer,
                repository,
                currentSession.session,
                commitRequest,
                nextProject,
              );
              commitState.value = { asset, project: nextProject, revision };
            },
          });
        } finally {
          await source.close().catch(() => undefined);
        }
        const committed = commitState.value;
        if (committed === undefined) throw invalidRequest('Video import did not reach its durable commit boundary');
        currentSession.assets.set(committed.asset.assetId, committed.asset);
        await flushScheduledSnapshot(currentSession, {
          closing: false,
          lastTransactionKind: 'canvas',
          revision: committed.revision,
          stablePoint: false,
        });
        const result = {
          asset: createProjectVideoSummary(
            committed.asset,
            currentSession.sessionId,
            countProjectImageUsage(committed.project, committed.asset.assetId),
          ),
          currentRevision: committed.revision,
          project: committed.project,
        };
        assertPublicBridgePayload(result);
        return result;
      });
    } finally {
      session.imageImportInFlight = false;
    }
  }

  async function pasteProjectClipboardVideo(
    _event: unknown,
    request: unknown,
  ): Promise<PasteProjectClipboardVideoBridgeResult | null> {
    const validated = validatePasteProjectClipboardVideoBridgeRequest(request);
    const session = requireWritableSession(sessions, validated.sessionId);
    if (session.writer === null) {
      throw createPersistenceError('CONCURRENT_WRITER', true, 'Clipboard video paste requires a writable desktop session');
    }
    if (session.imageImportInFlight) throw invalidRequest('A project asset import is already in progress');
    session.imageImportInFlight = true;
    try {
      return enqueueSessionMaintenance(session, async () => {
        const currentSession = requireWritableSession(sessions, validated.sessionId);
        if (currentSession !== session || currentSession.writer === null) {
          throw createPersistenceError('INVALID_SESSION', false, 'Desktop session changed before clipboard video paste');
        }
        const existing = await readExistingClipboardVideoPaste(assetStore, repository, currentSession, validated.target);
        if (existing !== null) return existing;
        if (validated.target.reconcileOnly === true) return null;
        const clipboardEntry = await clipboardVideo.readVideoPath();
        if (clipboardEntry === null) return null;
        const source = await openVideoSource(clipboardEntry.sourcePath);
        if (source === null) {
          throw invalidRequest('Video source must be one regular local MP4 file within the size limit');
        }
        const commitState: {
          value?: { readonly asset: ProjectVideoAsset; readonly project: CanvasProject; readonly revision: number };
        } = {};
        try {
          await assetStore.stageAndCommit(currentSession.session.root, source.stream, {
            maxBytes: MAX_PROJECT_VIDEO_BYTES,
            mediaType: 'video/mp4',
            originalName: basename(clipboardEntry.sourcePath),
            commitReference: async (storedAsset) => {
              assertVideoSourceSizeUnchanged(storedAsset, source.byteSize);
              const currentProject = await repository.readCurrentProject(currentSession.session);
              const currentRevision = await readCurrentRevision(repository, currentSession.session);
              const projectAsset = createImportedProjectVideoAsset(storedAsset);
              const transaction = createClipboardVideoPasteTransaction(currentProject, validated.target, projectAsset);
              const nextProject = applyProjectTransaction(currentProject, transaction);
              const commitRequest = {
                baseRevision: currentRevision,
                kind: 'canvas',
                projectId: currentProject.id,
                transaction,
              } as const;
              const revision = await commitWithDurableReconciliation(
                currentSession.writer!,
                repository,
                currentSession.session,
                commitRequest,
                nextProject,
              );
              commitState.value = { asset: projectAsset, project: nextProject, revision };
            },
          });
        } finally {
          await source.close().catch(() => undefined);
        }
        const committed = commitState.value;
        if (committed === undefined) throw invalidRequest('Clipboard video paste did not reach its durable commit boundary');
        currentSession.assets.set(committed.asset.assetId, committed.asset);
        await flushScheduledSnapshot(currentSession, {
          closing: false,
          lastTransactionKind: 'canvas',
          revision: committed.revision,
          stablePoint: false,
        });
        const result = {
          asset: createProjectVideoSummary(
            committed.asset,
            currentSession.sessionId,
            countProjectImageUsage(committed.project, committed.asset.assetId),
          ),
          currentRevision: committed.revision,
          project: committed.project,
        };
        assertPublicBridgePayload(result);
        return result;
      });
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
    const projectAssets = project.assets ?? [];
    const storedAssetList = await assetStore.list(
      session.session.root,
      projectAssets,
    );
    if (projectAssets.length > 0 && storedAssetList.length === 0) {
      throw createPersistenceError(
        'MISSING_ASSET',
        true,
        'A managed project asset is missing or failed integrity verification',
      );
    }
    const storedAssets = new Map(storedAssetList.map((asset) => [asset.id, asset]));
    const summaries = projectAssets
      .filter(isProjectImageAsset)
      .filter((asset) => storedAssetMatchesProjectAsset(storedAssets.get(asset.assetId), asset))
      .map((asset) => createProjectImageSummary(
        asset,
        session.sessionId,
        countProjectImageUsage(project, asset.assetId),
      ));
    session.assets = new Map(projectAssets.map((asset) => [asset.assetId, asset]));
    assertPublicBridgePayload(summaries);
    return summaries;
  }

  async function listProjectVideos(
    _event: unknown,
    request: unknown,
  ): Promise<ProjectVideoAssetSummary[]> {
    const validated = validateListProjectVideosBridgeRequest(request);
    const session = requireSession(sessions, validated.sessionId);
    const project = await repository.readCurrentProject(session.session);
    const projectAssets = project.assets ?? [];
    const storedAssetList = await assetStore.list(session.session.root, projectAssets);
    if (projectAssets.length > 0 && storedAssetList.length === 0) {
      throw createPersistenceError('MISSING_ASSET', true, 'A managed project asset is missing or failed integrity verification');
    }
    const storedAssets = new Map(storedAssetList.map((asset) => [asset.id, asset]));
    const summaries = projectAssets
      .filter(isProjectVideoAsset)
      .filter((asset) => storedAssetMatchesProjectAsset(storedAssets.get(asset.assetId), asset))
      .map((asset) => createProjectVideoSummary(asset, session.sessionId, countProjectImageUsage(project, asset.assetId)));
    session.assets = new Map(projectAssets.map((asset) => [asset.assetId, asset]));
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

  async function readManagedReverseMedia(
    sessionId: string,
    media: readonly ManagedReversePromptMediaIdentity[],
  ): Promise<readonly ManagedReversePromptMediaContent[]> {
    const session = requireSession(sessions, sessionId);
    if (fileSystem.readFileBuffer === undefined) throw createPersistenceError('MISSING_ASSET', false, 'Managed media reader is unavailable');
    return Promise.all(media.map(async (identity) => {
      const asset = session.assets.get(identity.assetId);
      if (asset === undefined || asset.sha256 !== identity.sha256 || asset.byteSize !== identity.byteSize || asset.mediaType !== identity.mediaType || (identity.kind === 'image' && !isProjectImageAsset(asset)) || (identity.kind === 'video' && !isProjectVideoAsset(asset))) {
        throw createPersistenceError('MISSING_ASSET', false, 'Managed reverse-analysis media is unavailable');
      }
      const path = await assetStore.resolvePath(session.session.root, asset.assetId, asset.extension, asset.sha256, asset.byteSize);
      if (path === null) throw createPersistenceError('MISSING_ASSET', false, 'Managed reverse-analysis media failed integrity verification');
      return { bytes: await fileSystem.readFileBuffer!(path), mediaType: identity.mediaType };
    }));
  }

  async function readManagedSkillChatImages(
    sessionId: string,
    referenceAssetIds: readonly string[],
  ): Promise<readonly ManagedSkillChatImageContent[]> {
    const session = requireSession(sessions, sessionId);
    if (fileSystem.readFileBuffer === undefined) throw createPersistenceError('MISSING_ASSET', false, 'Managed Skill chat image reader is unavailable');
    const project = await repository.readCurrentProject(session.session);
    const projectAssets = project.assets ?? [];
    session.assets = new Map(projectAssets.map((asset) => [asset.assetId, asset]));
    return Promise.all(referenceAssetIds.map(async (assetId) => {
      const asset = session.assets.get(assetId);
      if (asset === undefined || !isProjectImageAsset(asset)) {
        throw createPersistenceError('MISSING_ASSET', false, 'Managed Skill chat image is unavailable');
      }
      const path = await assetStore.resolvePath(session.session.root, asset.assetId, asset.extension, asset.sha256, asset.byteSize);
      if (path === null) throw createPersistenceError('MISSING_ASSET', false, 'Managed Skill chat image failed integrity verification');
      return { bytes: await fileSystem.readFileBuffer!(path), mediaType: asset.mediaType };
    }));
  }

  async function storeGeneratedImage(
    sessionId: string,
    bytes: Uint8Array,
    mediaType: string,
  ): Promise<ProjectImageAsset> {
    if (!mediaType.startsWith('image/')) throw invalidRequest('Generated result must be an image');
    if (bytes.byteLength === 0) throw invalidRequest('Generated result is empty');
    const session = requireWritableSession(sessions, sessionId);
    return enqueueSessionMaintenance(session, async () => {
      const currentSession = requireWritableSession(sessions, sessionId);
      if (currentSession.writer === null) throw createPersistenceError('CONCURRENT_WRITER', true, 'Generated image requires a writable desktop session');
      const commitState: { value?: { readonly ack: CommitAck; readonly asset: ProjectImageAsset } } = {};
      await assetStore.stageAndCommit(currentSession.session.root, Readable.from([bytes]), {
        maxBytes: MAX_PROJECT_IMAGE_BYTES,
        mediaType,
        originalName: 'generated.png',
        commitReference: async (storedAsset) => {
          const currentProject = await repository.readCurrentProject(currentSession.session);
          const currentRevision = await readCurrentRevision(repository, currentSession.session);
          const asset = createHistoryProjectImageAsset(storedAsset, 'generated');
          const transaction: ProjectTransaction = {
            id: `generated-image-${createId()}`,
            label: 'Store generated image',
            operations: [{ kind: 'set_project_assets', assets: upsertProjectImageAsset(currentProject.assets ?? [], asset) }],
          };
          const ack = await currentSession.writer!.commit({ baseRevision: currentRevision, kind: 'canvas', projectId: currentProject.id, transaction });
          commitState.value = { ack, asset };
        },
      });
      if (commitState.value === undefined) throw invalidRequest('Generated image did not reach its durable commit boundary');
      currentSession.assets.set(commitState.value.asset.assetId, commitState.value.asset);
      await flushScheduledSnapshotAfterCommit(currentSession, commitState.value.ack, 'canvas');
      return commitState.value.asset;
    });
  }

  async function storeGeneratedVideo(
    sessionId: string,
    bytes: Uint8Array,
    mediaType: 'video/mp4',
  ): Promise<ProjectVideoAsset> {
    if (mediaType !== 'video/mp4') throw invalidRequest('Generated video result must be an MP4');
    if (bytes.byteLength === 0) throw invalidRequest('Generated video result is empty');
    const session = requireWritableSession(sessions, sessionId);
    return enqueueSessionMaintenance(session, async () => {
      const currentSession = requireWritableSession(sessions, sessionId);
      if (currentSession.writer === null) throw createPersistenceError('CONCURRENT_WRITER', true, 'Generated video requires a writable desktop session');
      const commitState: { value?: { readonly ack: CommitAck; readonly asset: ProjectVideoAsset } } = {};
      await assetStore.stageAndCommit(currentSession.session.root, Readable.from([bytes]), {
        maxBytes: MAX_PROJECT_VIDEO_BYTES,
        mediaType,
        originalName: 'generated.mp4',
        commitReference: async (storedAsset) => {
          const currentProject = await repository.readCurrentProject(currentSession.session);
          const currentRevision = await readCurrentRevision(repository, currentSession.session);
          const asset = createImportedProjectVideoAsset(storedAsset);
          const transaction: ProjectTransaction = {
            id: `generated-video-${createId()}`,
            label: 'Store generated video',
            operations: [{ kind: 'set_project_assets', assets: upsertProjectAsset(currentProject.assets ?? [], asset) }],
          };
          const ack = await currentSession.writer!.commit({ baseRevision: currentRevision, kind: 'canvas', projectId: currentProject.id, transaction });
          commitState.value = { ack, asset };
        },
      });
      if (commitState.value === undefined) throw invalidRequest('Generated video did not reach its durable commit boundary');
      currentSession.assets.set(commitState.value.asset.assetId, commitState.value.asset);
      await flushScheduledSnapshotAfterCommit(currentSession, commitState.value.ack, 'canvas');
      return commitState.value.asset;
    });
  }
  async function resolveRecentProjectPreviewPath(displayUrl: string): Promise<string | null> {
    const match = /^novus-recent-project:\/\/(recent_[a-f0-9]{24})\/preview$/u.exec(displayUrl);
    if (match === null) return null;
    return recentProjectStore.resolvePreviewPath(match[1]!);
  }

  async function resolveGenerationHistoryImagePath(displayUrl: string): Promise<string | null> {
    const identity = parseGenerationHistoryAssetUrl(displayUrl);
    if (identity === null) return null;
    return historyStore.resolveAvailableAssetPath(identity.historyAssetId);
  }

  async function listGenerationHistory(
    _event: unknown,
    request: unknown,
  ): Promise<ListGenerationHistoryBridgeResult> {
    return historyStore.list(request);
  }

  async function getGenerationHistoryCapacity(
    _event: unknown,
    request?: unknown,
  ): Promise<GenerationHistoryCapacityBridgeResult> {
    if (request !== undefined) throw invalidHistoryRequest('History capacity request does not accept a payload');
    return historyStore.getCapacity();
  }

  async function setGenerationHistoryFavorite(
    _event: unknown,
    request: unknown,
  ): Promise<GenerationHistoryMutationBridgeResult> {
    return historyStore.setFavorite(validateHistoryFavoriteRequest(request));
  }

  async function getGenerationHistoryReusableSummary(
    _event: unknown,
    request: unknown,
  ): Promise<GenerationHistoryReusableBridgeResult> {
    const validated = validateHistoryRecordRequest(request);
    return historyService.getReusableSummary(validated.historyId);
  }

  async function compareGenerationHistory(
    _event: unknown,
    request: unknown,
  ): Promise<GenerationHistoryComparisonBridgeResult> {
    const validated = validateHistoryComparisonRequest(request);
    return historyService.compare(validated.historyIds);
  }

  async function copyGenerationHistoryToProject(
    _event: unknown,
    request: unknown,
  ): Promise<CopyGenerationHistoryToProjectBridgeResult> {
    const validated = validateHistoryProjectBatchRequest(request);
    const session = requireWritableSession(sessions, validated.sessionId);
    return enqueueSessionMaintenance(session, async () => {
      const currentSession = requireWritableSession(sessions, validated.sessionId);
      const writer = requireBridgeWriter(currentSession);
      const copied = await historyService.copyToProject({
        historyIds: validated.historyIds,
        operationId: validated.operationId,
        projectDisplayLabel: currentSession.session.manifest.projectName,
        projectId: currentSession.session.manifest.projectId,
        projectRoot: currentSession.session.root,
        commitProjectAsset: async (storedAsset, historyRecord) => {
          const currentProject = await repository.readCurrentProject(currentSession.session);
          const projectAsset = createHistoryProjectImageAsset(storedAsset, historyRecord.id);
          const existing = (currentProject.assets ?? []).find((asset) => asset.assetId === projectAsset.assetId);
          if (existing !== undefined && existing.sha256 === projectAsset.sha256) {
            currentSession.assets.set(existing.assetId, existing);
            return;
          }
          const currentRevision = await readCurrentRevision(repository, currentSession.session);
          const transaction: ProjectTransaction = {
            id: `history-copy-${sha256Canonical({
              operationId: validated.operationId,
              historyId: historyRecord.id,
            }).slice(0, 32)}`,
            label: 'Copy generation history asset into project',
            operations: [{
              kind: 'set_project_assets',
              assets: upsertProjectImageAsset(currentProject.assets ?? [], projectAsset),
            }],
          };
          const ack = await writer.commit({
            baseRevision: currentRevision,
            kind: 'canvas',
            projectId: currentProject.id,
            transaction,
          });
          currentSession.assets.set(projectAsset.assetId, projectAsset);
          await flushScheduledSnapshotAfterCommit(currentSession, ack, 'canvas');
        },
      });
      const project = await repository.readCurrentProject(currentSession.session);
      const currentRevision = await readCurrentRevision(repository, currentSession.session);
      return { ...copied, currentRevision, project };
    });
  }

  async function addGenerationHistoryProjectReferences(
    _event: unknown,
    request: unknown,
  ): Promise<GenerationHistoryMutationBridgeResult[]> {
    const validated = validateHistoryProjectBatchRequest(request);
    const session = requireWritableSession(sessions, validated.sessionId);
    return enqueueSessionMaintenance(session, async () => {
      const currentSession = requireWritableSession(sessions, validated.sessionId);
      const results: GenerationHistoryMutationBridgeResult[] = [];
      for (const historyId of validated.historyIds) {
        const suffix = sha256Canonical({ operationId: validated.operationId, historyId }).slice(0, 24);
        results.push(await historyStore.addProjectReferences({
          historyId,
          operationId: `operation_projectref_${suffix}`,
          references: [{
            referenceId: `reference_${suffix}`,
            projectId: currentSession.session.manifest.projectId,
            projectDisplayLabel: currentSession.session.manifest.projectName,
          }],
        }));
      }
      return results;
    });
  }

  async function exportGenerationHistory(
    _event: unknown,
    request: unknown,
  ): Promise<ExportGenerationHistoryBridgeResult> {
    const validated = validateHistoryExportRequest(request);
    return historyService.exportSelected({
      historyIds: validated.historyIds,
      chooseDestination: (files) => dialogs.chooseHistoryExportDirectory(files),
    });
  }

  async function trashGenerationHistory(
    _event: unknown,
    request: unknown,
  ): Promise<GenerationHistoryMutationBridgeResult> {
    return historyStore.softDelete(validateHistoryBatchRequest(request));
  }

  async function restoreGenerationHistory(
    _event: unknown,
    request: unknown,
  ): Promise<GenerationHistoryMutationBridgeResult> {
    return historyStore.restore(validateHistoryBatchRequest(request));
  }

  async function permanentlyDeleteGenerationHistory(
    _event: unknown,
    request: unknown,
  ): Promise<GenerationHistoryPurgeBridgeResult> {
    return historyStore.permanentlyDelete(validateHistoryBatchRequest(request));
  }

  async function purgeGenerationHistory(
    _event: unknown,
    request: unknown,
  ): Promise<GenerationHistoryPurgeBridgeResult> {
    return historyStore.purgeExpired(validateHistoryPurgeRequest(request));
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
    return enqueueSessionMaintenance(session, async () => {
      if (requireSingleWritableProjectSession(sessions, validated.projectId) !== session) {
        throw invalidRequest('Project session changed before Skill preparation');
      }
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
    });
  }

  async function reviewSkillCandidate(
    _event: unknown,
    request: unknown,
  ): Promise<ReviewSkillCandidateBridgeResult> {
    const validated = validateReviewSkillCandidateBridgeRequest(request);
    const session = requireSingleWritableProjectSession(sessions, validated.projectId);
    return enqueueSessionMaintenance(session, async () => {
      if (requireSingleWritableProjectSession(sessions, validated.projectId) !== session) {
        throw invalidRequest('Project session changed before Skill review');
      }
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
    });
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
    const validated = validateCloseProjectBridgeRequest(request);
    const session = requireSessionForClose(sessions, validated.sessionId);
    session.closeState = 'closing';
    try {
      await enqueueSessionMaintenance(
        session,
        () => closeBridgeSession(session, { flush: validated.flush !== false }),
      );
      if (sessions.get(validated.sessionId) === session) {
        sessions.delete(validated.sessionId);
      }
    } catch (error) {
      session.closeState = 'retry_only';
      throw error;
    }
  }

  async function closeAllProjects(): Promise<void> {
    const activeSessions = [...sessions.values()];
    sessions.clear();
    for (const session of activeSessions) {
      session.closeState = 'closing';
      await enqueueSessionMaintenance(session, () => closeBridgeSession(session));
    }
    await knowledgeRefreshService.stop();
  }

  return {
    closeAllProjects,
    closeProject,
    createProject,
    commit,
    configureKnowledgeBase,
    createStablePoint,
    exportPack,
    getKnowledgeState,
    getRecoveryPlan,
    importPack,
    importDroppedProjectMedia,
    importProjectImage,
    importProjectImageToPhotoshop,
    importProjectVideo,
    pasteProjectClipboardImage,
    writeClipboardImage,
    pasteProjectClipboardVideo,
    addGenerationHistoryProjectReferences,
    compareGenerationHistory,
    copyGenerationHistoryToProject,
    exportGenerationHistory,
    getGenerationHistoryCapacity,
    getGenerationHistoryReusableSummary,
    listGenerationHistory,
    listProjectImages,
    listProjectVideos,
    listRecentProjects,
    openLatestRecoveryPreview,
    openProject,
    refreshProject,
    openRecentProject,
    relocateRecentProject,
    removeRecentProject,
    prepareSkillCandidateReview,
    reviewSkillCandidate,
    permanentlyDeleteGenerationHistory,
    purgeGenerationHistory,
    restoreGenerationHistory,
    restore,
    readManagedReverseMedia,
    readManagedSkillChatImages,
    storeGeneratedImage,
    storeGeneratedVideo,
    resolveGenerationHistoryImagePath,
    resolveProjectImagePath,
    resolveRecentProjectPreviewPath,
    setGenerationHistoryFavorite,
    trashGenerationHistory,
  };

  async function writeProjectPreview(projectRoot: string): Promise<void> {
    if (dependencies.captureProjectPreview === undefined) return;
    try {
      const bytes = await captureOptionalProjectPreview(dependencies.captureProjectPreview);
      if (bytes === null || bytes.byteLength < 8 || bytes.byteLength > 10 * 1024 * 1024) return;
      const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      if (!pngSignature.every((value, index) => bytes[index] === value)) return;
      await writeAtomic(fileSystem, join(projectRoot, 'preview.png'), bytes);
    } catch {
      // A preview is optional metadata; capture failure must not block project durability.
    }
  }
  async function recordRecentProject(
    summary: BridgeSessionSummary,
    root: string,
    lastOpenedAt: string,
    lastSavedAt: string,
  ): Promise<void> {
    const assets = summary.project.assets ?? [];
    try {
      await recentProjectStore.upsert({
        root,
        projectId: summary.projectId,
        displayName: summary.projectName,
        lastOpenedAt,
        lastSavedAt,
        nodeCount: summary.project.nodes.length,
        imageCount: assets.filter((asset) => asset.mediaType.startsWith('image/')).length,
        videoCount: assets.filter((asset) => asset.mediaType === 'video/mp4').length,
      });
    } catch {
      // The recent-project index is auxiliary metadata. A temporarily locked or
      // unavailable index must never prevent the user's project from opening or saving.
    }
  }
  async function closeBridgeSession(
    session: BridgeSessionContext,
    options: { flush?: boolean } = {},
  ): Promise<void> {
    if (options.flush !== false && session.session.mode === 'write' && !session.recoveryRequired) {
      await flushScheduledSnapshot(session, {
        closing: true,
        lastTransactionKind: undefined,
        stablePoint: false,
      });
    }
    await requireMethod(repository, 'close')(session.session);
  }

  function enqueueSessionMaintenance<T>(
    session: BridgeSessionContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    const result = session.maintenanceTail.then(operation);
    session.maintenanceTail = result.then(() => undefined, () => undefined);
    return result;
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

function captureOptionalProjectPreview(
  capture: () => Promise<Uint8Array | null>,
): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      resolve(null);
    }, PROJECT_PREVIEW_CAPTURE_TIMEOUT_MS);
    void capture().then(
      (bytes) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(bytes);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(null);
      },
    );
  });
}

export function registerDesktopBridgeHandlers(
  ipcMain: DesktopIpcMainLike,
  handlers: DesktopBridgeHandlers,
): void {
  ipcMain.handle(BRIDGE_CHANNELS.openProject, handlers.openProject);
  ipcMain.handle(BRIDGE_CHANNELS.refreshProject, handlers.refreshProject);
  ipcMain.handle(BRIDGE_CHANNELS.recentProjects.list, handlers.listRecentProjects);
  ipcMain.handle(BRIDGE_CHANNELS.recentProjects.open, handlers.openRecentProject);
  ipcMain.handle(BRIDGE_CHANNELS.recentProjects.remove, handlers.removeRecentProject);
  ipcMain.handle(BRIDGE_CHANNELS.recentProjects.relocate, handlers.relocateRecentProject);
  ipcMain.handle(BRIDGE_CHANNELS.createProject, handlers.createProject);
  ipcMain.handle(BRIDGE_CHANNELS.commit, handlers.commit);
  ipcMain.handle(BRIDGE_CHANNELS.createStablePoint, handlers.createStablePoint);
  ipcMain.handle(BRIDGE_CHANNELS.restore, handlers.restore);
  ipcMain.handle(BRIDGE_CHANNELS.exportPack, handlers.exportPack);
  ipcMain.handle(BRIDGE_CHANNELS.importPack, handlers.importPack);
  ipcMain.handle(BRIDGE_CHANNELS.importDroppedProjectMedia, handlers.importDroppedProjectMedia);
  ipcMain.handle(BRIDGE_CHANNELS.importProjectImage, handlers.importProjectImage);
  ipcMain.handle(BRIDGE_CHANNELS.importProjectImageToPhotoshop, handlers.importProjectImageToPhotoshop);
  ipcMain.handle(BRIDGE_CHANNELS.importProjectVideo, handlers.importProjectVideo);
  ipcMain.handle(BRIDGE_CHANNELS.pasteProjectClipboardImage, handlers.pasteProjectClipboardImage);
  ipcMain.handle(BRIDGE_CHANNELS.writeClipboardImage, handlers.writeClipboardImage);
  ipcMain.handle(BRIDGE_CHANNELS.pasteProjectClipboardVideo, handlers.pasteProjectClipboardVideo);
  ipcMain.handle(BRIDGE_CHANNELS.listProjectImages, handlers.listProjectImages);
  ipcMain.handle(BRIDGE_CHANNELS.listProjectVideos, handlers.listProjectVideos);
  ipcMain.handle(BRIDGE_CHANNELS.openLatestRecoveryPreview, handlers.openLatestRecoveryPreview);
  ipcMain.handle(BRIDGE_CHANNELS.closeProject, handlers.closeProject);
  ipcMain.handle(BRIDGE_CHANNELS.getRecoveryPlan, handlers.getRecoveryPlan);
  ipcMain.handle(BRIDGE_CHANNELS.configureKnowledgeBase, handlers.configureKnowledgeBase);
  ipcMain.handle(BRIDGE_CHANNELS.getKnowledgeState, handlers.getKnowledgeState);
  ipcMain.handle(BRIDGE_CHANNELS.prepareSkillCandidateReview, handlers.prepareSkillCandidateReview);
  ipcMain.handle(BRIDGE_CHANNELS.reviewSkillCandidate, handlers.reviewSkillCandidate);
  ipcMain.handle(BRIDGE_CHANNELS.history.list, handlers.listGenerationHistory);
  ipcMain.handle(BRIDGE_CHANNELS.history.capacity, handlers.getGenerationHistoryCapacity);
  ipcMain.handle(BRIDGE_CHANNELS.history.setFavorite, handlers.setGenerationHistoryFavorite);
  ipcMain.handle(BRIDGE_CHANNELS.history.reuse, handlers.getGenerationHistoryReusableSummary);
  ipcMain.handle(BRIDGE_CHANNELS.history.compare, handlers.compareGenerationHistory);
  ipcMain.handle(BRIDGE_CHANNELS.history.copyToProject, handlers.copyGenerationHistoryToProject);
  ipcMain.handle(BRIDGE_CHANNELS.history.addProjectReferences, handlers.addGenerationHistoryProjectReferences);
  ipcMain.handle(BRIDGE_CHANNELS.history.exportSelected, handlers.exportGenerationHistory);
  ipcMain.handle(BRIDGE_CHANNELS.history.trash, handlers.trashGenerationHistory);
  ipcMain.handle(BRIDGE_CHANNELS.history.restore, handlers.restoreGenerationHistory);
  ipcMain.handle(BRIDGE_CHANNELS.history.permanentlyDelete, handlers.permanentlyDeleteGenerationHistory);
  ipcMain.handle(BRIDGE_CHANNELS.history.purgeExpired, handlers.purgeGenerationHistory);
}

function withDialogDefaults(dialogs: Partial<BridgeDialogAdapter> | undefined): BridgeDialogAdapter {
  return {
    chooseCreateProjectRoot: dialogs?.chooseCreateProjectRoot ?? (async () => null),
    chooseImportDestination: dialogs?.chooseImportDestination ?? (async () => null),
    chooseImportPackSource: dialogs?.chooseImportPackSource ?? (async () => null),
    chooseKnowledgeRoot: dialogs?.chooseKnowledgeRoot ?? (async () => null),
    chooseHistoryExportDirectory: dialogs?.chooseHistoryExportDirectory ?? (async () => null),
    choosePackExportPath: dialogs?.choosePackExportPath ?? (async () => null),
    chooseProjectImage: dialogs?.chooseProjectImage ?? (async () => null),
    chooseProjectVideo: dialogs?.chooseProjectVideo ?? (async () => null),
    chooseProjectRoot: dialogs?.chooseProjectRoot ?? (async () => null),
  };
}

function withRepositoryDefaults(
  repository: Partial<ProjectRepositoryLike> | undefined,
  options: { readonly channel: PersistenceChannel; readonly fileSystem: FileSystem },
): ProjectRepositoryLike {
  if (repository?.create !== undefined && repository.open !== undefined && repository.close !== undefined && repository.openJournalWriter !== undefined) {
    return repository as ProjectRepositoryLike;
  }

  const fallback = new ProjectRepository({
    channel: options.channel,
    fileSystem: options.fileSystem,
  });
  return {
    create: repository?.create ?? ((root, createOptions) => fallback.create(root, createOptions)),
    close: repository?.close ?? ((session) => fallback.close(session)),
    open: repository?.open ?? ((root, openOptions) => fallback.open(root, openOptions)),
    openJournalWriter: repository?.openJournalWriter ?? ((session) => fallback.openJournalWriter(session)),
    readCurrentProject: repository?.readCurrentProject ?? ((session) => fallback.readCurrentProject(session)),
    readCurrentRevision: repository?.readCurrentRevision
      ?? (repository?.readCurrentProject === undefined
        ? ((session) => fallback.readCurrentRevision(session))
        : async (session) => session.manifest.stableSnapshotRevision),
    readStableProject: repository?.readStableProject ?? ((session) => fallback.readStableProject(session)),
  };
}

async function validateProjectImageTarget(
  repository: ProjectRepositoryLike,
  session: BridgeSessionContext,
  target: ProjectImageImportTarget,
): Promise<void> {
  if (target.kind === 'agent_reference') return;
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

function createImportedProjectVideoAsset(storedAsset: AssetMetadata): ProjectVideoAsset {
  const base = {
    assetId: storedAsset.id,
    byteSize: storedAsset.byteSize,
    durationMs: null,
    extension: storedAsset.extension,
    height: storedAsset.height,
    label: `Video ${storedAsset.id.slice(0, 8)}`,
    mediaType: storedAsset.mediaType,
    origin: 'imported' as const,
    sha256: storedAsset.sha256,
    width: storedAsset.width,
  };
  const parsed = projectVideoAssetSchema.safeParse(base);
  return parsed.success
    ? parsed.data
    : projectVideoAssetSchema.parse({ ...base, label: `Video ${storedAsset.id.slice(0, 8)}` });
}

function assertVideoSourceSizeUnchanged(storedAsset: AssetMetadata, verifiedByteSize: number): void {
  if (storedAsset.byteSize !== verifiedByteSize) {
    throw invalidRequest('Video source changed while it was being imported');
  }
}

function createHistoryProjectImageAsset(storedAsset: AssetMetadata, historyId: string): ProjectImageAsset {
  return projectImageAssetSchema.parse({
    assetId: storedAsset.id,
    byteSize: storedAsset.byteSize,
    extension: storedAsset.extension,
    height: storedAsset.height,
    label: `History ${historyId.slice(-8)}`,
    mediaType: storedAsset.mediaType,
    origin: 'generated',
    sha256: storedAsset.sha256,
    width: storedAsset.width,
  });
}

function createProjectImageImportTransaction(
  project: CanvasProject,
  target: ProjectImageImportTarget,
  asset: ProjectImageAsset,
  createId: () => string,
): ProjectTransaction {
  const assets = upsertProjectImageAsset(project.assets ?? [], asset);
  const suffix = createId();
  if (target.kind === 'agent_reference') {
    return {
      id: `import-agent-reference-image-${asset.assetId}-${suffix}`,
      label: 'Import managed Agent reference image',
      operations: [{ kind: 'set_project_assets', assets }],
    };
  }
  const node = project.nodes.find((candidate) => candidate.id === target.nodeId);
  if (node === undefined) throw invalidRequest('Project image target node is unavailable');
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
  return {
    id: `import-project-image-${asset.assetId}-${suffix}`,
    label: 'Import managed project image',
    operations: [
      { kind: 'set_project_assets', assets },
      { kind: 'canvas', operation: { kind: 'update_node', node: nextNode } },
    ],
  };
}

function createClipboardImagePasteTransaction(
  project: CanvasProject,
  target: ProjectClipboardImageTarget,
  asset: ProjectImageAsset,
): ProjectTransaction {
  const identity = clipboardImagePasteIdentity(target.operationId);
  if (target.kind === 'agent_reference') {
    return {
      id: identity.transactionId,
      label: 'Paste clipboard Agent reference image',
      operations: [{ kind: 'set_project_assets', assets: upsertProjectImageAsset(project.assets ?? [], asset) }],
    };
  }
  const node = createCanvasModuleNode(identity.nodeId, 'image_input', target.position);
  const boundNode = {
    ...node,
    data: {
      ...node.data,
      config: { ...node.data.config, assetId: asset.assetId },
    },
  };
  return {
    id: identity.transactionId,
    label: 'Paste clipboard image',
    operations: [
      { kind: 'set_project_assets', assets: upsertProjectImageAsset(project.assets ?? [], asset) },
      { kind: 'canvas', operation: { kind: 'create_node', node: boundNode } },
    ],
  };
}

function createClipboardVideoPasteTransaction(
  project: CanvasProject,
  target: ProjectClipboardVideoTarget,
  asset: ProjectVideoAsset,
): ProjectTransaction {
  const identity = clipboardVideoPasteIdentity(target.operationId);
  const node = createCanvasModuleNode(identity.nodeId, 'video_input', target.position);
  const boundNode = { ...node, data: { ...node.data, config: { ...node.data.config, assetId: asset.assetId } } };
  return {
    id: identity.transactionId,
    label: 'Paste clipboard video',
    operations: [
      { kind: 'set_project_assets', assets: upsertProjectAsset(project.assets ?? [], asset) },
      { kind: 'canvas', operation: { kind: 'create_node', node: boundNode } },
    ],
  };
}

function createDroppedImageImportTransaction(
  project: CanvasProject,
  target: ImportDroppedProjectMediaBridgeRequest['target'],
  asset: ProjectImageAsset,
): ProjectTransaction {
  const identity = droppedMediaIdentity(target.operationId);
  if (target.kind === 'agent_reference') {
    return {
      id: identity.transactionId,
      label: 'Import pasted Agent reference image',
      operations: [{ kind: 'set_project_assets', assets: upsertProjectImageAsset(project.assets ?? [], asset) }],
    };
  }
  if (target.kind === 'module') {
    return createProjectImageImportTransaction(
      project,
      { kind: 'module', nodeId: target.nodeId },
      asset,
      () => identity.transactionId,
    );
  }
  const node = createCanvasModuleNode(identity.nodeId, 'image_input', target.position);
  const boundNode = { ...node, data: { ...node.data, config: { ...node.data.config, assetId: asset.assetId } } };
  return {
    id: identity.transactionId,
    label: 'Import dropped image',
    operations: [
      { kind: 'set_project_assets', assets: upsertProjectImageAsset(project.assets ?? [], asset) },
      { kind: 'canvas', operation: { kind: 'create_node', node: boundNode } },
    ],
  };
}

function createDroppedVideoImportTransaction(
  project: CanvasProject,
  target: Extract<ImportDroppedProjectMediaBridgeRequest['target'], { readonly kind: 'new_media_input' }>,
  asset: ProjectVideoAsset,
): ProjectTransaction {
  const identity = droppedMediaIdentity(target.operationId, 'video');
  const node = createCanvasModuleNode(identity.nodeId, 'video_input', target.position);
  const boundNode = { ...node, data: { ...node.data, config: { ...node.data.config, assetId: asset.assetId } } };
  return {
    id: identity.transactionId,
    label: 'Import dropped video',
    operations: [
      { kind: 'set_project_assets', assets: upsertProjectAsset(project.assets ?? [], asset) },
      { kind: 'canvas', operation: { kind: 'create_node', node: boundNode } },
    ],
  };
}

function droppedMediaIdentity(
  operationId: string,
  mediaType: 'image' | 'video' = 'image',
): { readonly nodeId: string; readonly transactionId: string } {
  const suffix = sha256Canonical({ operationId }).slice(0, 24);
  return {
    nodeId: `dropped-${mediaType}-${suffix}`,
    transactionId: `import-dropped-${mediaType}-${suffix}`,
  };
}

async function readExistingClipboardImagePaste(
  assetStore: ProjectAssetStoreLike,
  repository: ProjectRepositoryLike,
  session: BridgeSessionContext,
  target: ProjectClipboardImageTarget,
): Promise<PasteProjectClipboardImageBridgeResult | null> {
  if (target.kind === 'agent_reference') return null;
  const identity = clipboardImagePasteIdentity(target.operationId);
  const project = await repository.readCurrentProject(session.session);
  const node = project.nodes.find((candidate) => candidate.id === identity.nodeId);
  if (node === undefined) return null;
  if (
    node.type !== 'module'
    || node.data.moduleType !== 'image_input'
    || node.position.x !== target.position.x
    || node.position.y !== target.position.y
  ) {
    throw invalidRequest('Clipboard operation identity is already bound to different canvas content');
  }
  const assetId = typeof node.data.config.assetId === 'string' ? node.data.config.assetId : null;
  const asset = project.assets?.find((candidate) => candidate.assetId === assetId);
  if (asset === undefined || !isProjectImageAsset(asset)) {
    throw invalidRequest('Clipboard operation receipt is missing its managed image asset');
  }
  const resolvedPath = await assetStore.resolvePath(
    session.session.root,
    asset.assetId,
    asset.extension,
    asset.sha256,
    asset.byteSize,
  );
  if (resolvedPath === null) {
    throw createPersistenceError('MISSING_ASSET', true, 'Clipboard operation receipt references a missing managed image');
  }
  session.assets.set(asset.assetId, asset);
  const result = {
    asset: createProjectImageSummary(asset, session.sessionId, countProjectImageUsage(project, asset.assetId)),
    currentRevision: await readCurrentRevision(repository, session.session),
    project,
  };
  assertPublicBridgePayload(result);
  return result;
}

function clipboardImagePasteIdentity(operationId: string): { readonly nodeId: string; readonly transactionId: string } {
  const suffix = sha256Canonical({ operationId }).slice(0, 24);
  return {
    nodeId: `clipboard-image-${suffix}`,
    transactionId: `paste-clipboard-image-${suffix}`,
  };
}

async function readExistingClipboardVideoPaste(
  assetStore: ProjectAssetStoreLike,
  repository: ProjectRepositoryLike,
  session: BridgeSessionContext,
  target: ProjectClipboardVideoTarget,
): Promise<PasteProjectClipboardVideoBridgeResult | null> {
  const identity = clipboardVideoPasteIdentity(target.operationId);
  const project = await repository.readCurrentProject(session.session);
  const node = project.nodes.find((candidate) => candidate.id === identity.nodeId);
  if (node === undefined) return null;
  if (
    node.type !== 'module'
    || node.data.moduleType !== 'video_input'
    || node.position.x !== target.position.x
    || node.position.y !== target.position.y
  ) {
    throw invalidRequest('Clipboard video operation identity is already bound to different canvas content');
  }
  const assetId = typeof node.data.config.assetId === 'string' ? node.data.config.assetId : null;
  const asset = project.assets?.find((candidate) => candidate.assetId === assetId);
  if (asset === undefined || !isProjectVideoAsset(asset)) {
    throw invalidRequest('Clipboard video operation receipt is missing its managed asset');
  }
  const resolvedPath = await assetStore.resolvePath(
    session.session.root,
    asset.assetId,
    asset.extension,
    asset.sha256,
    asset.byteSize,
  );
  if (resolvedPath === null) {
    throw createPersistenceError('MISSING_ASSET', true, 'Clipboard video operation references a missing managed asset');
  }
  session.assets.set(asset.assetId, asset);
  const result = {
    asset: createProjectVideoSummary(asset, session.sessionId, countProjectImageUsage(project, asset.assetId)),
    currentRevision: await readCurrentRevision(repository, session.session),
    project,
  };
  assertPublicBridgePayload(result);
  return result;
}

function clipboardVideoPasteIdentity(operationId: string): { readonly nodeId: string; readonly transactionId: string } {
  const suffix = sha256Canonical({ operationId }).slice(0, 24);
  return {
    nodeId: `clipboard-video-${suffix}`,
    transactionId: `paste-clipboard-video-${suffix}`,
  };
}

function assertClipboardAssetMatches(storedAsset: AssetMetadata, image: TrustedClipboardImage): void {
  if (
    storedAsset.mediaType !== 'image/png'
    || storedAsset.extension !== 'png'
    || storedAsset.width !== image.width
    || storedAsset.height !== image.height
  ) {
    throw invalidRequest('Clipboard PNG metadata changed before durable import');
  }
}

function createClipboardProjectImageAsset(storedAsset: AssetMetadata, label: string): ProjectImageAsset {
  return projectImageAssetSchema.parse({
    assetId: storedAsset.id,
    byteSize: storedAsset.byteSize,
    extension: storedAsset.extension,
    height: storedAsset.height,
    label,
    mediaType: storedAsset.mediaType,
    origin: 'imported',
    sha256: storedAsset.sha256,
    width: storedAsset.width,
  });
}

function upsertProjectImageAsset(
  assets: readonly ProjectAsset[],
  asset: ProjectImageAsset,
): ProjectAsset[] {
  const existing = assets.find((candidate) => candidate.assetId === asset.assetId);
  if (existing !== undefined && existing.sha256 !== asset.sha256) {
    throw invalidRequest('Project image id conflicts with existing catalog metadata');
  }
  return existing === undefined
    ? [...assets, asset]
    : assets.map((candidate) => candidate.assetId === asset.assetId ? asset : candidate);
}

function upsertProjectAsset(assets: readonly ProjectAsset[], asset: ProjectAsset): ProjectAsset[] {
  const existing = assets.find((candidate) => candidate.assetId === asset.assetId);
  if (existing !== undefined && existing.sha256 !== asset.sha256) {
    throw invalidRequest('Project asset id conflicts with existing catalog metadata');
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

function createProjectVideoSummary(
  asset: ProjectVideoAsset,
  sessionId: string,
  usageCount: number,
): ProjectVideoAssetSummary {
  return {
    ...asset,
    displayUrl: createProjectAssetDisplayUrl(sessionId, asset.assetId),
    usageCount,
  };
}

function storedAssetMatchesProjectAsset(
  storedAsset: AssetMetadata | undefined,
  projectAsset: ProjectAsset,
): boolean {
  return storedAsset !== undefined
    && storedAsset.id === projectAsset.assetId
    && storedAsset.sha256 === projectAsset.sha256
    && storedAsset.byteSize === projectAsset.byteSize
    && storedAsset.extension === projectAsset.extension
    && storedAsset.mediaType === projectAsset.mediaType;
}

function isProjectImageAsset(asset: ProjectAsset): asset is ProjectImageAsset {
  return asset.mediaType.startsWith('image/');
}

function isProjectVideoAsset(asset: ProjectAsset): asset is ProjectVideoAsset {
  return asset.mediaType === 'video/mp4';
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

function summarizeRecoveryPreview(
  sessionId: string,
  session: OpenedProjectSession,
  candidate: RecoveryCandidate,
): BridgeSessionSummary {
  return {
    currentRevision: candidate.revision,
    mode: session.mode,
    project: candidate.project,
    projectId: session.manifest.projectId,
    projectName: session.manifest.projectName,
    recoveryRequired: true,
    sessionId,
    stableSnapshotId: candidate.snapshotId,
    stableSnapshotRevision: candidate.revision,
  };
}

function createOrphanRecoveryManifest(candidate: OrphanRecoveryCandidate): ProjectManifest {
  const assets = candidate.project.assets ?? [];
  return {
    activeJournalSegment: ACTIVE_JOURNAL_SEGMENT,
    assetInventory: {
      assetCount: assets.length,
      totalBytes: assets.reduce((total, asset) => total + asset.byteSize, 0),
    },
    cleanClose: false,
    formatVersion: PROJECT_FORMAT_VERSION,
    minimumCompatibleWriterVersion: PROJECT_FORMAT_VERSION,
    nextSequence: candidate.revision + 1,
    projectId: candidate.projectId,
    projectName: candidate.project.name,
    stableSnapshotId: candidate.snapshotId,
    stableSnapshotPath: null,
    stableSnapshotRevision: candidate.revision,
  };
}

async function retainedOrphanRecoveryPlan(
  fileSystem: FileSystem,
  session: BridgeSessionContext,
): Promise<RecoveryPlanBridgeResult> {
  const candidates: RecoveryCandidateBridgeSummary[] = [];
  for (const [candidateId, path] of session.recoveryCandidatePaths) {
    const mirror = parseRecoveryCandidateMirror(
      JSON.parse(await fileSystem.readFile(path, 'utf8')) as unknown,
      session.session.manifest.projectId,
    );
    candidates.push({
      candidateId,
      revision: mirror.revision,
      snapshotId: mirror.snapshotId,
      tailStatus: 'complete',
    });
  }
  candidates.sort((left, right) => right.revision - left.revision || left.snapshotId.localeCompare(right.snapshotId));
  const selected = candidates[0] ?? null;
  return {
    action: 'choose_recovery',
    candidates,
    issues: ['missing_project_root'],
    projectId: session.session.manifest.projectId,
    recoveredRevision: selected?.revision ?? null,
    stableSnapshotId: selected?.snapshotId ?? null,
    targetRevision: selected?.revision ?? null,
  };
}

function selectHighestCompleteRecoveryCandidate(
  scan: RecoveryScanResult,
  projectId: string,
): RecoveryCandidate | null {
  const candidates = [...scan.candidates]
    .filter((candidate) => candidate.tailStatus === 'complete')
    .sort((left, right) => right.revision - left.revision || left.snapshotId.localeCompare(right.snapshotId));
  for (const candidate of candidates) {
    try {
      const project = parseCanvasProject(candidate.project);
      if (project.id === projectId && scan.projectId === projectId) return { ...candidate, project };
    } catch {
      // Continue to the next complete candidate.
    }
  }
  return null;
}

function hasPersistenceErrorCode(error: unknown, code: PersistenceError['code']): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === code;
}

async function readCurrentRevision(
  repository: ProjectRepositoryLike,
  session: OpenedProjectSession,
): Promise<number> {
  return repository.readCurrentRevision === undefined
    ? session.manifest.stableSnapshotRevision
    : repository.readCurrentRevision(session);
}

async function commitWithDurableReconciliation(
  writer: BridgeWriter,
  repository: ProjectRepositoryLike,
  session: OpenedProjectSession,
  request: Omit<CommitBridgeRequest, 'sessionId'>,
  expectedProject: CanvasProject,
): Promise<number> {
  try {
    return (await writer.commit(request)).revision;
  } catch (error) {
    const [durableProject, durableRevision] = await Promise.all([
      repository.readCurrentProject(session),
      readCurrentRevision(repository, session),
    ]).catch(() => [null, null] as const);
    if (
      durableProject === null
      || durableRevision === null
      || durableRevision !== request.baseRevision + 1
      || sha256Canonical(durableProject) !== sha256Canonical(expectedProject)
    ) {
      throw error;
    }
    return durableRevision;
  }
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
  if (session === undefined || session.closeState !== 'open') {
    throw createPersistenceError('INVALID_SESSION', false, 'Desktop session is not active');
  }
  return session;
}

function requireSessionForClose(
  sessions: Map<string, BridgeSessionContext>,
  sessionId: string,
): BridgeSessionContext {
  const session = sessions.get(sessionId);
  if (session === undefined || session.closeState === 'closing') {
    throw createPersistenceError('INVALID_SESSION', false, 'Desktop session is not active');
  }
  return session;
}

function requireWritableSession(
  sessions: Map<string, BridgeSessionContext>,
  sessionId: string,
  options: { readonly allowRecovery?: boolean } = {},
): BridgeSessionContext {
  const session = requireSession(sessions, sessionId);
  if (session.session.mode !== 'write') {
    throw createPersistenceError(
      'CONCURRENT_WRITER',
      true,
      'Desktop session is read-only',
    );
  }
  if (session.recoveryRequired && options.allowRecovery !== true) {
    throw createPersistenceError(
      'RECOVERY_REQUIRED',
      false,
      'Recovery preview must be restored or discarded before writing',
    );
  }
  return session;
}

function requireSingleWritableProjectSession(
  sessions: Map<string, BridgeSessionContext>,
  projectId: string,
): BridgeSessionContext {
  const projectSessions = [...sessions.values()].filter((context) => (
    context.session.manifest.projectId === projectId
  ));
  const matches = projectSessions.filter((context) => (
    context.session.mode === 'write'
    && context.closeState === 'open'
    && !context.recoveryRequired
  ));
  if (matches.length === 1) {
    return matches[0]!;
  }
  if (projectSessions.some((context) => context.closeState !== 'open')) {
    throw createPersistenceError('INVALID_SESSION', false, 'Desktop session is not active');
  }
  if (projectSessions.some((context) => context.recoveryRequired)) {
    throw createPersistenceError(
      'RECOVERY_REQUIRED',
      false,
      'Recovery preview must be restored or discarded before writing',
    );
  }
  if (projectSessions.some((context) => context.session.mode !== 'write')) {
    throw createPersistenceError('CONCURRENT_WRITER', true, 'Desktop session is read-only');
  }
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
  appDataRoot: string,
): Promise<{ readonly manifest: ProjectManifest; readonly recreatedRoot: boolean }> {
  const rootExists = await pathExists(fileSystem, session.session.root);
  let recreatedRoot = false;
  let manifest: ProjectManifest;
  if (rootExists) {
    manifest = await readProjectManifest(fileSystem, session.session.root);
  } else {
    assertManagedRecoveryRoot(appDataRoot, session.session.root);
    manifest = session.session.manifest;
    for (const directory of PROJECT_DIRECTORIES) {
      await fileSystem.mkdir(join(session.session.root, ...directory.split('/')), { recursive: true });
    }
    recreatedRoot = true;
  }
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
    projectName: parseCanvasProject(candidate.project).name,
    stableSnapshotId: snapshotId,
    stableSnapshotPath: snapshotPath,
    stableSnapshotRevision: candidate.revision,
  };
  await writeAtomic(
    fileSystem,
    join(session.session.root, PROJECT_MANIFEST_PATH),
    `${canonicalJson(nextManifest)}\n`,
  );
  return { manifest: nextManifest, recreatedRoot };
}

function assertManagedRecoveryRoot(appDataRoot: string, projectRoot: string): void {
  const managedProjectsRoot = resolve(appDataRoot, 'projects');
  const candidateRoot = resolve(projectRoot);
  const relativePath = relative(managedProjectsRoot, candidateRoot);
  if (
    relativePath.length === 0
    || relativePath.startsWith('..')
    || isAbsolute(relativePath)
    || !basename(candidateRoot).endsWith('.novus-project')
  ) {
    throw createPersistenceError(
      'INVALID_REQUEST',
      false,
      'Missing recovery roots can only be recreated inside the managed projects directory',
    );
  }
}

async function pathExists(fileSystem: FileSystem, path: string): Promise<boolean> {
  try {
    await fileSystem.stat(path);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
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

  let parsedProject: CanvasProject;
  try {
    parsedProject = parseCanvasProject(project);
  } catch {
    throw createPersistenceError('INVALID_REQUEST', false, 'Recovery candidate project is invalid');
  }
  return {
    project: parsedProject,
    projectId,
    revision,
    snapshotId,
  };
}

function validateCreateProjectBridgeRequest(value: unknown): CreateProjectBridgeRequest {
  const record = expectPlainRecord(value);
  try {
    return { project: parseCanvasProject(record.project) };
  } catch {
    throw createPersistenceError('INVALID_REQUEST', false, 'Create project payload is invalid');
  }
}
function validateOpenProjectBridgeRequest(value: unknown): OpenProjectBridgeRequest {
  const record = expectPlainRecord(value);
  assertExactKeys(record, ['mode'], 'Open project request');
  return { mode: parseMode(record.mode) };
}

function validateOpenRecentProjectBridgeRequest(value: unknown): OpenRecentProjectBridgeRequest {
  const record = expectPlainRecord(value);
  assertExactKeys(record, ['mode', 'recentProjectId'], 'Open recent project request');
  return {
    mode: parseMode(record.mode),
    recentProjectId: parseRecentProjectId(record.recentProjectId),
  };
}

function validateRecentProjectRequest(value: unknown): RecentProjectRequest {
  const record = expectPlainRecord(value);
  assertExactKeys(record, ['recentProjectId'], 'Recent project request');
  return { recentProjectId: parseRecentProjectId(record.recentProjectId) };
}

function parseRecentProjectId(value: unknown): string {
  if (typeof value !== 'string' || !/^recent_[a-f0-9]{24}$/u.test(value)) {
    throw invalidRequest('Recent project id is invalid');
  }
  return value;
}

function validateCloseProjectBridgeRequest(value: unknown): CloseProjectBridgeRequest {
  const record = expectPlainRecord(value);
  if (record.flush !== undefined && record.flush !== false) {
    throw createPersistenceError('INVALID_REQUEST', false, 'Close flush must be false when provided');
  }
  return {
    ...(record.flush === false ? { flush: false as const } : {}),
    sessionId: parseNonEmptyString(record.sessionId, 'sessionId'),
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
  } else if (kind === 'agent_reference') {
    assertExactKeys(targetRecord, ['kind'], 'Agent reference image target');
    target = { kind };
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

function validateImportProjectVideoBridgeRequest(value: unknown): ImportProjectVideoBridgeRequest {
  const record = expectPlainRecord(value);
  assertExactKeys(record, ['sessionId', 'target'], 'Project video import request');
  const targetRecord = expectPlainRecord(record.target);
  let target: ImportProjectVideoBridgeRequest['target'];
  if (targetRecord.kind === 'module') {
    assertExactKeys(targetRecord, ['kind', 'nodeId'], 'Project video module target');
    target = { kind: 'module', nodeId: parseNonEmptyString(targetRecord.nodeId, 'target.nodeId') };
  } else if (targetRecord.kind === 'agent_reference') {
    assertExactKeys(targetRecord, ['kind'], 'Agent reference video target');
    target = { kind: 'agent_reference' };
  } else {
    throw invalidRequest('Project video import target kind is invalid');
  }
  const request = {
    sessionId: parseNonEmptyString(record.sessionId, 'sessionId'),
    target,
  };
  assertPublicBridgePayload(request);
  return request;
}

function validateImportDroppedProjectMediaPayload(value: unknown): {
  readonly request: ImportDroppedProjectMediaBridgeRequest;
  readonly sourcePath: string;
} {
  const record = expectPlainRecord(value);
  assertExactKeys(record, ['request', 'sourcePath'], 'Dropped project media import payload');
  const request = validateImportDroppedProjectMediaBridgeRequest(record.request);
  const sourcePath = parseNonEmptyString(record.sourcePath, 'sourcePath');
  if (!isAbsolute(sourcePath)) throw invalidRequest('Dropped media source must be an absolute local path');
  return { request, sourcePath };
}

function validateImportDroppedProjectMediaBridgeRequest(value: unknown): ImportDroppedProjectMediaBridgeRequest {
  const record = expectPlainRecord(value);
  assertExactKeys(record, ['sessionId', 'target'], 'Dropped project media import request');
  const target = expectPlainRecord(record.target);
  const sessionId = parseNonEmptyString(record.sessionId, 'sessionId');
  const operationId = parseDroppedMediaOperationId(target.operationId);
  if (target.kind === 'agent_reference') {
    assertExactKeys(target, ['kind', 'operationId'], 'Dropped Agent reference target');
    const request = { sessionId, target: { kind: 'agent_reference' as const, operationId } };
    assertPublicBridgePayload(request);
    return request;
  }
  if (target.kind === 'module') {
    assertExactKeys(target, ['kind', 'nodeId', 'operationId'], 'Dropped project media module target');
    const request = {
      sessionId,
      target: {
        kind: 'module' as const,
        nodeId: parseNonEmptyString(target.nodeId, 'target.nodeId'),
        operationId,
      },
    };
    assertPublicBridgePayload(request);
    return request;
  }
  assertExactKeys(target, ['kind', 'operationId', 'position'], 'Dropped project media target');
  if (target.kind !== 'new_media_input') throw invalidRequest('Dropped project media target kind is invalid');
  const position = expectPlainRecord(target.position);
  assertExactKeys(position, ['x', 'y'], 'Dropped project media position');
  const request = {
    sessionId,
    target: {
      kind: 'new_media_input' as const,
      operationId,
      position: {
        x: parseBoundedCanvasCoordinate(position.x, 'target.position.x'),
        y: parseBoundedCanvasCoordinate(position.y, 'target.position.y'),
      },
    },
  };
  assertPublicBridgePayload(request);
  return request;
}

function validatePasteProjectClipboardImageBridgeRequest(value: unknown): PasteProjectClipboardImageBridgeRequest {
  const record = expectPlainRecord(value);
  assertExactKeys(record, ['sessionId', 'target'], 'Clipboard image paste request');
  const target = expectPlainRecord(record.target);
  if (target.kind === 'agent_reference') {
    assertExactKeys(target, ['kind', 'operationId'], 'Clipboard Agent reference target');
    const request = {
      sessionId: parseNonEmptyString(record.sessionId, 'sessionId'),
      target: { kind: 'agent_reference' as const, operationId: parseClipboardOperationId(target.operationId) },
    };
    assertPublicBridgePayload(request);
    return request;
  }
  assertExactKeys(target, ['kind', 'operationId', 'position', 'reconcileOnly'], 'Clipboard image paste target');
  if (target.kind !== 'new_image_input') throw invalidRequest('Clipboard image paste target kind is invalid');
  if ('reconcileOnly' in target && target.reconcileOnly !== true) {
    throw invalidRequest('Clipboard image reconcileOnly must be true when provided');
  }
  const position = expectPlainRecord(target.position);
  assertExactKeys(position, ['x', 'y'], 'Clipboard image paste position');
  const request = {
    sessionId: parseNonEmptyString(record.sessionId, 'sessionId'),
    target: {
      kind: 'new_image_input' as const,
      operationId: parseClipboardOperationId(target.operationId),
      position: {
        x: parseBoundedCanvasCoordinate(position.x, 'target.position.x'),
        y: parseBoundedCanvasCoordinate(position.y, 'target.position.y'),
      },
      ...(target.reconcileOnly === true ? { reconcileOnly: true as const } : {}),
    },
  };
  assertPublicBridgePayload(request);
  return request;
}

function validatePasteProjectClipboardVideoBridgeRequest(value: unknown): PasteProjectClipboardVideoBridgeRequest {
  const record = expectPlainRecord(value);
  assertExactKeys(record, ['sessionId', 'target'], 'Clipboard video paste request');
  const target = expectPlainRecord(record.target);
  assertExactKeys(target, ['kind', 'operationId', 'position', 'reconcileOnly'], 'Clipboard video paste target');
  if (target.kind !== 'new_video_input') throw invalidRequest('Clipboard video paste target kind is invalid');
  if ('reconcileOnly' in target && target.reconcileOnly !== true) {
    throw invalidRequest('Clipboard video reconcileOnly must be true when provided');
  }
  const position = expectPlainRecord(target.position);
  assertExactKeys(position, ['x', 'y'], 'Clipboard video paste position');
  const request = {
    sessionId: parseNonEmptyString(record.sessionId, 'sessionId'),
    target: {
      kind: 'new_video_input' as const,
      operationId: parseClipboardVideoOperationId(target.operationId),
      position: {
        x: parseBoundedCanvasCoordinate(position.x, 'target.position.x'),
        y: parseBoundedCanvasCoordinate(position.y, 'target.position.y'),
      },
      ...(target.reconcileOnly === true ? { reconcileOnly: true as const } : {}),
    },
  };
  assertPublicBridgePayload(request);
  return request;
}

function parseClipboardOperationId(value: unknown): string {
  if (typeof value === 'string' && /^clipboard_paste_[a-z0-9-]{4,72}$/u.test(value)) return value;
  throw invalidRequest('Clipboard image paste operation identity is invalid');
}

function parseClipboardVideoOperationId(value: unknown): string {
  if (typeof value === 'string' && /^clipboard_video_[a-z0-9-]{4,72}$/u.test(value)) return value;
  throw invalidRequest('Clipboard video paste operation identity is invalid');
}

function parseDroppedMediaOperationId(value: unknown): string {
  if (typeof value === 'string' && /^dropped_media_[a-z0-9-]{4,72}$/u.test(value)) return value;
  throw invalidRequest('Dropped media operation identity is invalid');
}

function parseBoundedCanvasCoordinate(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 10_000_000) {
    throw invalidRequest(`${field} must be a finite canvas coordinate`);
  }
  return value;
}

function validateListProjectImagesBridgeRequest(value: unknown): ListProjectImagesBridgeRequest {
  const record = expectPlainRecord(value);
  assertExactKeys(record, ['sessionId'], 'Project image list request');
  const request = { sessionId: parseNonEmptyString(record.sessionId, 'sessionId') };
  assertPublicBridgePayload(request);
  return request;
}

function validateListProjectVideosBridgeRequest(value: unknown): ListProjectVideosBridgeRequest {
  const record = expectPlainRecord(value);
  assertExactKeys(record, ['sessionId'], 'Project video list request');
  const request = { sessionId: parseNonEmptyString(record.sessionId, 'sessionId') };
  assertPublicBridgePayload(request);
  return request;
}

function validateHistoryRecordRequest(value: unknown): GenerationHistoryRecordBridgeRequest {
  const record = expectPlainRecord(value);
  assertHistoryExactKeys(record, ['historyId'], 'Generation history record request');
  return { historyId: parseHistoryBridgeId(record.historyId) };
}

function validateHistoryBatchRequest(value: unknown): GenerationHistoryBatchBridgeRequest {
  const record = expectPlainRecord(value);
  assertHistoryExactKeys(record, ['historyIds', 'operationId'], 'Generation history batch request');
  return {
    historyIds: parseHistoryBridgeIds(record.historyIds, 1, 100),
    operationId: parseHistoryBridgeId(record.operationId),
  };
}

function validateHistoryFavoriteRequest(value: unknown): SetGenerationHistoryFavoriteBridgeRequest {
  const record = expectPlainRecord(value);
  assertHistoryExactKeys(record, ['favorite', 'historyIds', 'operationId'], 'Generation history favorite request');
  if (typeof record.favorite !== 'boolean') throw invalidHistoryRequest('History favorite value is invalid');
  return {
    favorite: record.favorite,
    historyIds: parseHistoryBridgeIds(record.historyIds, 1, 100),
    operationId: parseHistoryBridgeId(record.operationId),
  };
}

function validateHistoryComparisonRequest(value: unknown): CompareGenerationHistoryBridgeRequest {
  const record = expectPlainRecord(value);
  assertHistoryExactKeys(record, ['historyIds'], 'Generation history comparison request');
  return { historyIds: parseHistoryBridgeIds(record.historyIds, 2, 20) };
}

function validateHistoryProjectBatchRequest(value: unknown): CopyGenerationHistoryToProjectBridgeRequest & AddGenerationHistoryProjectReferencesBridgeRequest {
  const record = expectPlainRecord(value);
  assertHistoryExactKeys(record, ['historyIds', 'operationId', 'sessionId'], 'Generation history project request');
  return {
    historyIds: parseHistoryBridgeIds(record.historyIds, 1, 100),
    operationId: parseHistoryBridgeId(record.operationId),
    sessionId: parseNonEmptyString(record.sessionId, 'sessionId'),
  };
}

function validateHistoryExportRequest(value: unknown): ExportGenerationHistoryBridgeRequest {
  const record = expectPlainRecord(value);
  assertHistoryExactKeys(record, ['historyIds'], 'Generation history export request');
  return { historyIds: parseHistoryBridgeIds(record.historyIds, 1, 100) };
}

function validateHistoryPurgeRequest(value: unknown): GenerationHistoryPurgeBridgeRequest {
  const record = expectPlainRecord(value);
  assertHistoryExactKeys(record, ['operationId'], 'Generation history purge request');
  return { operationId: parseHistoryBridgeId(record.operationId) };
}

function parseHistoryBridgeIds(value: unknown, minimum: number, maximum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw invalidHistoryRequest('Generation history selection is invalid');
  }
  const ids = value.map(parseHistoryBridgeId);
  if (new Set(ids).size !== ids.length) throw invalidHistoryRequest('Generation history selection contains duplicates');
  return ids;
}

function parseHistoryBridgeId(value: unknown): string {
  if (typeof value === 'string' && /^[a-z][a-z0-9_-]{7,95}$/u.test(value)) return value;
  throw invalidHistoryRequest('Generation history identity is invalid');
}

function invalidHistoryRequest(message: string): Error & { readonly code: 'HISTORY_INVALID_REQUEST'; readonly retryable: false } {
  return Object.assign(new Error(message), { code: 'HISTORY_INVALID_REQUEST' as const, retryable: false as const });
}

function assertHistoryExactKeys(record: Record<string, unknown>, allowedKeys: readonly string[], label: string): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw invalidHistoryRequest(`${label} contains unsupported fields`);
  }
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
