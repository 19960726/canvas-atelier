import type {
  DesktopBridgeApi,
  ChatSkillBridgeResult,
  CodexReasoningEffort,
  JournalTransactionKind,
  PersistenceErrorCode,
  ProjectImageAssetSummary,
  ProjectImageImportTarget,
  ProjectVideoAssetSummary,
  ProviderBridgeProfile,
} from '@agent-canvas/desktop-core';
import type { CanvasProject, ProjectTransaction, ReversePromptResult, ReversePromptRun } from '@agent-canvas/domain';
import { applyProjectTransaction, createCanvasModuleNode } from '@agent-canvas/domain';
import type { ProjectImageAsset, ProjectVideoAsset } from '@agent-canvas/domain';
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
const BROWSER_ASSET_PREVIEW_STORAGE_KEY = 'novus.browser.asset-previews.v1';

type BrowserAssetPreviewRecord = {
  readonly displayUrl: string;
  readonly mediaType: ProjectImageAsset['mediaType'] | ProjectVideoAsset['mediaType'];
};

export interface ManagedReversePromptMediaIdentity {
  readonly kind: 'image' | 'video';
  readonly assetId: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly mediaType: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp' | 'video/mp4';
}

interface ReversePromptProviderBridge {
  analyzeReversePrompt(input: {
    readonly sessionId: string;
    readonly provider: ProviderBridgeProfile['provider'];
    readonly run: ReversePromptRun;
    readonly media: readonly ManagedReversePromptMediaIdentity[];
  }): Promise<ReversePromptResult>;
}

interface SkillChatProviderBridge {
  chat(input: SkillChatRequest & { readonly sessionId: string }): Promise<ChatSkillBridgeResult>;
}

export interface SkillChatRequest {
  readonly provider: ProviderBridgeProfile['provider'] | 'codex';
  readonly modelRoute: string;
  readonly requestId?: string;
  readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[];
  readonly context: { readonly knowledgeBaseIds: readonly string[]; readonly projectMemoryIds: readonly string[] };
  readonly referenceAssetIds?: readonly string[];
  readonly referenceMentions?: readonly { readonly assetId: string; readonly label: string; readonly mention: string }[];
  readonly agentMode?: 'chat' | 'original' | 'codex';
  readonly reasoningEffort?: CodexReasoningEffort;
  readonly visualAnalysis?: boolean;
}

export type PersistenceMode = 'browser' | 'desktop';
export type ProjectSaveStatus = 'pending' | 'saving' | 'saved' | 'error' | 'read_only';
export type ProjectLifecycle = 'untitled' | 'durable';
export type ProjectCommitErrorCode = PersistenceErrorCode | 'RECOVERY_REQUIRED' | 'BROWSER_PERSIST_FAILED';

export interface ProjectHydrationResult {
  availableSnapshotIds: string[];
  lifecycle?: ProjectLifecycle;
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
  lifecycle?: ProjectLifecycle;
  project: CanvasProject;
  revision: number;
}

export interface ProjectRestoreResult {
  availableSnapshotIds: string[];
  lifecycle?: ProjectLifecycle;
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

export interface ProjectVideoImportResult {
  asset: ProjectVideoAssetSummary;
  project: CanvasProject;
  revision: number;
}

export type ProjectDroppedMediaImportResult = ProjectImageImportResult | ProjectVideoImportResult;

export interface ProjectHistoryCopyResult {
  project: CanvasProject;
  projectAssetId: string;
  revision: number;
}

export interface ProjectPersistenceClient {
  getSessionId?(): string | null;
  ensureModelExecutionSession?(): Promise<string | null>;
  analyzeReversePrompt?(input: {
    readonly provider: ProviderBridgeProfile['provider'];
    readonly run: ReversePromptRun;
    readonly media: readonly ManagedReversePromptMediaIdentity[];
  }): Promise<ReversePromptResult>;
  chatSkill?(input: SkillChatRequest): Promise<ChatSkillBridgeResult>;
  cancelChatSkill?(requestId: string): Promise<boolean>;
  close(): Promise<void>;
  commit(request: ProjectCommitRequest): Promise<ProjectCommitResult>;
  hydrate(): Promise<ProjectHydrationResult>;
  openProject?(recentProjectId?: string): Promise<ProjectHydrationResult | null>;
  reloadDurableProject?(): Promise<ProjectHydrationResult | null>;
  copyHistoryToProject?(input: {
    readonly historyId: string;
    readonly operationId: string;
  }): Promise<ProjectHistoryCopyResult | null>;
  importProjectImage(target: ProjectImageImportTarget, file?: File): Promise<ProjectImageImportResult | null>;
  importDroppedMedia?(input: {
    readonly file: File;
    readonly operationId: string;
    readonly position: { readonly x: number; readonly y: number };
  }): Promise<ProjectDroppedMediaImportResult | null>;
  importProjectVideo?(nodeId: string, file?: File): Promise<ProjectVideoImportResult | null>;
  importAgentReferenceVideo?(file?: File): Promise<ProjectVideoImportResult | null>;
  pasteClipboardImage(input: {
    readonly operationId: string;
    readonly position: { readonly x: number; readonly y: number };
    readonly reconcileOnly?: true;
  }): Promise<ProjectImageImportResult | null>;
  pasteClipboardVideo?(input: {
    readonly operationId: string;
    readonly position: { readonly x: number; readonly y: number };
    readonly reconcileOnly?: true;
  }): Promise<ProjectVideoImportResult | null>;
  listProjectImages(): Promise<ProjectImageAssetSummary[]>;
  listProjectVideos?(): Promise<ProjectVideoAssetSummary[]>;
  restore(snapshotId: string): Promise<ProjectRestoreResult>;
  stablePoint(): Promise<ProjectStablePointResult>;
}

export interface LegacyProjectImportClient {
  createFromLegacyBundle(bundle: PersistedProjectBundle): Promise<unknown>;
}

let activeProjectPersistenceClient: ProjectPersistenceClient | null = null;

export function createProjectPersistenceClient(): ProjectPersistenceClient {
  const bridge = globalThis.window?.novusDesktop;
  activeProjectPersistenceClient = bridge === undefined
    ? createBrowserPersistenceClient()
    : createDesktopPersistenceClient(bridge);
  return activeProjectPersistenceClient;
}

export function getActiveProjectSessionId(): string | null {
  return activeProjectPersistenceClient?.getSessionId?.() ?? null;
}

export function registerActiveProjectPersistenceClient(client: ProjectPersistenceClient): void {
  activeProjectPersistenceClient = client;
}

export function createBrowserPersistenceClient(storage = getStorage()): ProjectPersistenceClient {
  let currentProject: CanvasProject | null = null;
  let revision = 0;
  let availableSnapshotIds: string[] = [];
  const assetPreviews = loadBrowserAssetPreviews(storage);
  const assetUrls = new Map<string, string>([...assetPreviews].map(([assetId, preview]) => [assetId, preview.displayUrl]));
  const imageAssets = new Map<string, ProjectImageAssetSummary>();
  const videoAssets = new Map<string, ProjectVideoAssetSummary>();

  return {
    getSessionId: () => null,
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
      rebuildBrowserAssetSummaries(currentProject, assetPreviews, imageAssets, videoAssets);
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
    async importProjectImage(target, file) {
      const importTarget = target as ProjectImageImportTarget | { readonly kind: 'agent_reference' };
      if (file === undefined) return null;
      const project = currentProject;
      if (project === null) return null;
      if (!isImageFile(file)) return null;
      const asset = await createBrowserImageAsset(file, assetUrls, storage, assetPreviews);
      if (importTarget.kind === 'agent_reference') {
        const nextProject = {
          ...project,
          assets: [...(project.assets ?? []).filter((candidate) => candidate.assetId !== asset.assetId), asset],
        };
        if (!persistCurrentProject(nextProject, storage)) return null;
        currentProject = nextProject;
        revision += 1;
        const summary = { ...asset, displayUrl: assetUrls.get(asset.assetId) ?? '', usageCount: 0 };
        imageAssets.set(asset.assetId, summary);
        return { asset: summary, project: currentProject, revision };
      }
      const node = project.nodes.find((candidate) => candidate.id === importTarget.nodeId);
      if (node === undefined) return null;
      const nextProject = updateProjectNodeAsset(project, importTarget.nodeId, asset.assetId, asset, importTarget.kind);
      if (nextProject === null || !persistCurrentProject(nextProject, storage)) return null;
      currentProject = nextProject;
      revision += 1;
      const summary = { ...asset, displayUrl: assetUrls.get(asset.assetId) ?? '', usageCount: 1 };
      imageAssets.set(asset.assetId, summary);
      return { asset: summary, project: currentProject, revision };
    },
    async importDroppedMedia(input) {
      if (currentProject === null || !isSupportedBrowserMediaFile(input.file)) return null;
      const isVideo = isVideoFile(input.file);
      const asset = isVideo
        ? await createBrowserVideoAsset(input.file, assetUrls, storage, assetPreviews)
        : await createBrowserImageAsset(input.file, assetUrls, storage, assetPreviews);
      const node = createCanvasModuleNode(
        `browser-media-${asset.assetId}`,
        isVideo ? 'video_input' : 'image_input',
        input.position,
      );
      node.data.config = { assetId: asset.assetId };
      const nextProject = { ...currentProject, nodes: [...currentProject.nodes, node], assets: [...(currentProject.assets ?? []), asset] };
      if (!persistCurrentProject(nextProject, storage)) return null;
      currentProject = nextProject;
      revision += 1;
      if (isVideo) {
        const summary = { ...asset, displayUrl: assetUrls.get(asset.assetId) ?? '', usageCount: 1 } as ProjectVideoAssetSummary;
        videoAssets.set(asset.assetId, summary);
        return { asset: summary, project: currentProject, revision };
      }
      const summary = { ...asset, displayUrl: assetUrls.get(asset.assetId) ?? '', usageCount: 1 } as ProjectImageAssetSummary;
      imageAssets.set(asset.assetId, summary);
      return { asset: summary, project: currentProject, revision };
    },
    async importProjectVideo(nodeId, file) {
      if (currentProject === null || file === undefined || !isVideoFile(file)) return null;
      const asset = await createBrowserVideoAsset(file, assetUrls, storage, assetPreviews);
      const node = currentProject.nodes.find((candidate) => candidate.id === nodeId);
      if (node === undefined) return null;
      const nextProject = updateProjectNodeAsset(currentProject, nodeId, asset.assetId, asset, 'module');
      if (nextProject === null || !persistCurrentProject(nextProject, storage)) return null;
      currentProject = nextProject;
      revision += 1;
      const summary = { ...asset, displayUrl: assetUrls.get(asset.assetId) ?? '', usageCount: 1 } as ProjectVideoAssetSummary;
      videoAssets.set(asset.assetId, summary);
      return { asset: summary, project: currentProject, revision };
    },
    async importAgentReferenceVideo(file) {
      if (currentProject === null || file === undefined || !isVideoFile(file)) return null;
      const asset = await createBrowserVideoAsset(file, assetUrls, storage, assetPreviews);
      const nextProject = {
        ...currentProject,
        assets: [...(currentProject.assets ?? []).filter((candidate) => candidate.assetId !== asset.assetId), asset],
      };
      if (!persistCurrentProject(nextProject, storage)) return null;
      currentProject = nextProject;
      revision += 1;
      const summary = { ...asset, displayUrl: assetUrls.get(asset.assetId) ?? '', usageCount: 0 } as ProjectVideoAssetSummary;
      videoAssets.set(asset.assetId, summary);
      return { asset: summary, project: currentProject, revision };
    },    async pasteClipboardImage() {
      return null;
    },
    async pasteClipboardVideo() {
      return null;
    },
    async listProjectImages() {
      return [...imageAssets.values()];
    },
    async listProjectVideos() {
      return [...videoAssets.values()];
    },
    async restore(snapshotId) {
      const bundle = loadPersistedProjectBundle(storage);
      const snapshot = bundle?.snapshots.find((entry) => entry.id === snapshotId);
      currentProject = snapshot?.project ?? currentProject ?? bundle?.current ?? createUntitledProject();
      rebuildBrowserAssetSummaries(currentProject, assetPreviews, imageAssets, videoAssets);
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
        lifecycle: currentProject === null ? 'untitled' : 'durable',
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
  let startupRestoreAttempted = false;
  let pendingWritableSession: Promise<string | null> | null = null;
  const activeCodexRequestIds = new Set<string>();
  const cancelledCodexRequestIds = new Set<string>();

  const cancelActiveCodexRequests = async (): Promise<void> => {
    const requestIds = [...activeCodexRequestIds];
    await Promise.all(requestIds.map(async (requestId) => {
      cancelledCodexRequestIds.add(requestId);
      try {
        await bridge.codexCli.cancel({ requestId });
      } catch {
        // Closing/switching must continue even if the already-stopping CLI bridge disappeared.
      }
    }));
  };

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
    getSessionId: () => sessionId,
    ensureModelExecutionSession: () => ensureWritableSession(),
    async analyzeReversePrompt(input) {
      const writableSessionId = await ensureWritableSession();
      if (writableSessionId === null) throw createImportError('INVALID_REQUEST');
      const provider = bridge.provider as typeof bridge.provider & Partial<ReversePromptProviderBridge>;
      if (provider.analyzeReversePrompt === undefined) throw createImportError('INVALID_REQUEST');
      try {
        return await provider.analyzeReversePrompt({
          media: [...input.media],
          provider: input.provider,
          run: input.run,
          sessionId: writableSessionId,
        });
      } catch (error) {
        throw createDisplaySafeProviderError(error);
      }
    },
    async chatSkill(input) {
      if (input.provider === 'codex') {
        if (input.requestId === undefined) throw createImportError('INVALID_REQUEST');
        const localRequestId = input.requestId;
        activeCodexRequestIds.add(localRequestId);
        try {
          const writableSessionId = await ensureWritableSession();
          if (writableSessionId === null) throw createImportError('INVALID_REQUEST');
          if (cancelledCodexRequestIds.has(localRequestId)) throw createCodexCancellationError();
          if ((input.referenceAssetIds?.length ?? 0) > 0 || (input.referenceMentions?.length ?? 0) > 0) {
            const unsupported = new Error('Codex CLI managed images are unavailable') as Error & { code?: string; retryable?: boolean };
            unsupported.code = 'CODEX_CLI_INVALID_REQUEST';
            unsupported.retryable = false;
            throw unsupported;
          }
          return await bridge.codexCli.chat({
            provider: 'codex',
            modelRoute: 'codex/gpt-6-astra',
            agentMode: 'codex',
            reasoningEffort: input.reasoningEffort ?? 'medium',
            messages: input.messages.map((message) => ({ ...message })),
            context: {
              knowledgeBaseIds: [...input.context.knowledgeBaseIds],
              projectMemoryIds: [...input.context.projectMemoryIds],
            },
            sessionId: writableSessionId,
            requestId: localRequestId,
            ...(input.visualAnalysis === undefined ? {} : { visualAnalysis: input.visualAnalysis }),
          });
        } catch (error) {
          throw createDisplaySafeCodexError(error);
        } finally {
          activeCodexRequestIds.delete(localRequestId);
          cancelledCodexRequestIds.delete(localRequestId);
        }
      }
      const writableSessionId = await ensureWritableSession();
      if (writableSessionId === null) throw createImportError('INVALID_REQUEST');
      const provider = bridge.provider as typeof bridge.provider & Partial<SkillChatProviderBridge>;
      if (provider.chat === undefined) throw createImportError('INVALID_REQUEST');
      try {
        const { requestId: _localRequestId, ...providerInput } = input;
        return await provider.chat({
          ...providerInput,
          referenceAssetIds: [...(input.referenceAssetIds ?? [])],
          sessionId: writableSessionId,
        });
      } catch (error) {
        throw createDisplaySafeProviderError(error);
      }
    },
    async cancelChatSkill(requestId) {
      if (!activeCodexRequestIds.has(requestId)) return false;
      cancelledCodexRequestIds.add(requestId);
      try {
        await bridge.codexCli.cancel({ requestId });
        return true;
      } catch {
        return true;
      }
    },
    async close() {
      await cancelActiveCodexRequests();
      if (sessionId === null) return;
      const closingSessionId = sessionId;
      const closingProjectId = projectId;
      await bridge.closeProject({ sessionId: closingSessionId });
      if (
        sessionId !== closingSessionId
        || projectId !== closingProjectId
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
      if (sessionId === null && !startupRestoreAttempted) {
        startupRestoreAttempted = true;
        try {
          const recentProjects = await bridge.recentProjects.list();
          const latestAvailableProject = recentProjects.find((project) => project.availability === 'available');
          const latestLooksLikeCurrentCanvas = latestAvailableProject !== undefined
            && (
              latestAvailableProject.nodeCount > 0
              || latestAvailableProject.imageCount > 0
              || latestAvailableProject.videoCount > 0
              || typeof latestAvailableProject.lastOpenedAt === 'string'
            );
          if (latestAvailableProject !== undefined && latestLooksLikeCurrentCanvas) {
            const selected = await bridge.recentProjects.open({
              recentProjectId: latestAvailableProject.recentProjectId,
              mode: 'write',
            });
            if (selected !== null) return adoptSelectedSession(selected);
          }
          const recoveryPreview = await bridge.openLatestRecoveryPreview?.() ?? null;
          if (recoveryPreview !== null) return adoptSelectedSession(recoveryPreview);
          if (latestAvailableProject !== undefined) {
            const selected = await bridge.recentProjects.open({
              recentProjectId: latestAvailableProject.recentProjectId,
              mode: 'write',
            });
            if (selected !== null) return adoptSelectedSession(selected);
          }
        } catch {
          // Startup recovery is best-effort. A missing or stale recent project must not block a clean canvas.
        }
      }
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
    async openProject(recentProjectId) {
      await cancelActiveCodexRequests();
      if (recoveryRequired) throw createImportError('RECOVERY_REQUIRED');
      const previousSessionId = sessionId;
      const selected = recentProjectId === undefined
        ? await bridge.openProject({ mode: 'write' })
        : await bridge.recentProjects.open({ recentProjectId, mode: 'write' });
      if (selected === null) return null;
      if (previousSessionId !== null) {
        try {
          await bridge.closeProject({ sessionId: previousSessionId });
        } catch (error) {
          // The main process may have already reclaimed this session when a
          // renderer reload reopened the same project. Closing an already
          // removed session is idempotent; preserve all other close errors.
          if (readErrorCode(error) !== 'INVALID_SESSION') throw error;
        }
      }
      return adoptSelectedSession(selected);
    },
    async reloadDurableProject() {
      if (recoveryRequired) throw createImportError('RECOVERY_REQUIRED');
      const activeSessionId = sessionId;
      if (activeSessionId === null) return null;
      clientGeneration += 1;
      const selected = await bridge.refreshProject({ sessionId: activeSessionId });
      if (
        selected.sessionId !== activeSessionId
        || selected.projectId !== projectId
        || selected.mode !== 'write'
        || selected.recoveryRequired === true
      ) return null;
      return adoptSelectedSession(selected);
    },
    async importProjectImage(target, file) {
      const writableSessionId = await ensureWritableSession();
      if (writableSessionId === null) return null;
      const operationId = createDesktopDroppedMediaOperationId();
      let result = file !== undefined && (target.kind === 'module' || target.kind === 'agent_reference')
        ? await bridge.projectImages.importDroppedMedia({
            sessionId: writableSessionId,
            target: target.kind === 'module'
              ? { kind: 'module', nodeId: target.nodeId, operationId }
              : { kind: 'agent_reference', operationId },
          }, file)
        : await bridge.projectImages.importImage({ sessionId: writableSessionId, target });
      if (result === null && file !== undefined && target.kind === 'agent_reference') {
        result = await bridge.projectImages.pasteClipboardImage({
          sessionId: writableSessionId,
          target: { kind: 'agent_reference', operationId: createDesktopClipboardOperationId() },
        });
      }
      if (result === null) return null;
      currentProject = validateRecoveredProject(result.project, currentProject);
      revision = result.currentRevision;
      if (result.asset.mediaType === 'video/mp4') return null;
      return {
        asset: result.asset,
        project: currentProject,
        revision,
      };
    },
    async importDroppedMedia(input) {
      const writableSessionId = await ensureWritableSession();
      if (writableSessionId === null) return null;
      const result = await bridge.projectImages.importDroppedMedia({
        sessionId: writableSessionId,
        target: {
          kind: 'new_media_input',
          operationId: input.operationId,
          position: input.position,
        },
      }, input.file);
      if (result === null || !('asset' in result)) {
        return null;
      }
      currentProject = validateRecoveredProject(result.project, currentProject);
      revision = result.currentRevision;
      if (result.asset.mediaType === 'video/mp4') {
        return { asset: result.asset, project: currentProject, revision };
      }
      return { asset: result.asset, project: currentProject, revision };
    },
    async copyHistoryToProject(input) {
      if (sessionId === null) return null;
      if (recoveryRequired) throw createImportError('RECOVERY_REQUIRED');
      const result = await bridge.history.copyToProject({
        historyIds: [input.historyId],
        operationId: input.operationId,
        sessionId,
      });
      const copied = result.copies.find((item) => item.historyId === input.historyId);
      if (copied === undefined) return null;
      currentProject = validateRecoveredProject(result.project, currentProject);
      revision = result.currentRevision;
      return {
        project: currentProject,
        projectAssetId: copied.projectAssetId,
        revision,
      };
    },
    async importProjectVideo(nodeId) {
      const writableSessionId = await ensureWritableSession();
      if (writableSessionId === null) return null;
      const result = await bridge.projectVideos.importVideo({
        sessionId: writableSessionId,
        target: { kind: 'module', nodeId },
      });
      if (result === null) return null;
      currentProject = validateRecoveredProject(result.project, currentProject);
      revision = result.currentRevision;
      return { asset: result.asset, project: currentProject, revision };
    },
    async importAgentReferenceVideo() {
      const writableSessionId = await ensureWritableSession();
      if (writableSessionId === null) return null;
      const result = await bridge.projectVideos.importVideo({
        sessionId: writableSessionId,
        target: { kind: 'agent_reference' },
      });
      if (result === null) return null;
      currentProject = validateRecoveredProject(result.project, currentProject);
      revision = result.currentRevision;
      return { asset: result.asset, project: currentProject, revision };
    },
    async pasteClipboardImage(input) {
      const writableSessionId = await ensureWritableSession();
      if (writableSessionId === null) return null;
      const request = {
        sessionId: writableSessionId,
        target: {
          kind: 'new_image_input' as const,
          operationId: input.operationId,
          position: input.position,
          ...(input.reconcileOnly === true ? { reconcileOnly: true as const } : {}),
        },
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
    async pasteClipboardVideo(input) {
      const writableSessionId = await ensureWritableSession();
      if (writableSessionId === null) return null;
      const request = {
        sessionId: writableSessionId,
        target: {
          kind: 'new_video_input' as const,
          operationId: input.operationId,
          position: input.position,
          ...(input.reconcileOnly === true ? { reconcileOnly: true as const } : {}),
        },
      };
      let result;
      try {
        result = await bridge.projectVideos.pasteClipboardVideo(request);
      } catch (error) {
        if (!shouldRetryClipboardPaste(error)) throw error;
        result = await bridge.projectVideos.pasteClipboardVideo(request);
      }
      if (result === null) return null;
      currentProject = validateRecoveredProject(result.project, currentProject);
      revision = result.currentRevision;
      return { asset: result.asset, project: currentProject, revision };
    },
    async listProjectImages() {
      return sessionId === null ? [] : bridge.projectImages.list({ sessionId });
    },
    async listProjectVideos() {
      return sessionId === null ? [] : bridge.projectVideos.list({ sessionId });
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
      if (sessionId === null) {
        const writableSessionId = await ensureWritableSession();
        if (writableSessionId === null) {
          return { availableSnapshotIds: [], lifecycle: 'untitled', project: currentProject, revision };
        }
      } else if (mode === 'write') {
        const result = await bridge.createStablePoint({ sessionId });
        revision = result.revision;
        availableSnapshotIds = await readDesktopRecoverySnapshotIds();
      }
      return {
        availableSnapshotIds,
        lifecycle: sessionId === null ? 'untitled' : 'durable',
        project: currentProject,
        revision,
      };
    },
  };

  async function ensureWritableSession(): Promise<string | null> {
    if (recoveryRequired) throw createImportError('RECOVERY_REQUIRED');
    if (sessionId !== null) return mode === 'write' ? sessionId : null;
    if (pendingWritableSession !== null) return pendingWritableSession;
    const createGeneration = clientGeneration;
    const createRequest = (async () => {
      const created = await bridge.createProject({ project: currentProject });
      if (created === null) return null;
      if (clientGeneration !== createGeneration || sessionId !== null) {
        return sessionId !== null && mode === 'write' ? sessionId : null;
      }
      await adoptSelectedSession(created);
      return mode === 'write' ? sessionId : null;
    })();
    const trackedRequest = createRequest.finally(() => {
      if (pendingWritableSession === trackedRequest) pendingWritableSession = null;
    });
    pendingWritableSession = trackedRequest;
    return trackedRequest;
  }

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

  async function desktopCommit(
    request: ProjectCommitRequest,
    allowRevisionRefresh = true,
  ): Promise<ProjectCommitResult> {
    if (sessionId === null || projectId === null) {
      // The first autosave establishes the current canvas on disk. Keeping
      // this session open makes every later autosave overwrite the same
      // project instead of creating another untitled canvas.
      currentProject = validateRecoveredProject(request.nextProject, request.previousProject);
      if (typeof bridge.createProject !== 'function') {
        return { ok: true, project: currentProject, revision };
      }
      const writableSessionId = await ensureWritableSession();
      if (writableSessionId === null || sessionId === null || projectId === null) {
        return { code: 'DURABLE_WRITE_FAILED', ok: false, project: currentProject, revision };
      }
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
      if (
        code === 'REVISION_CONFLICT'
        && allowRevisionRefresh
        && sessionId === commitSessionId
        && projectId === commitProjectId
      ) {
        try {
          const refreshed = await bridge.refreshProject({ sessionId: commitSessionId });
          if (
            refreshed.sessionId === commitSessionId
            && refreshed.projectId === commitProjectId
            && refreshed.mode === 'write'
          ) {
            await adoptSelectedSession(refreshed);
            const rebasedProject = applyProjectTransaction(currentProject, request.transaction);
            return desktopCommit({
              ...request,
              baseRevision: revision,
              nextProject: rebasedProject,
              previousProject: currentProject,
            }, false);
          }
        } catch {
          // Fall through to the typed conflict when refresh or replay fails.
        }
      }
      // The desktop bridge uses INVALID_REQUEST when the transaction no
      // longer applies to the durable project (for example a second delete
      // arriving after the first one was acknowledged). Refresh the session
      // and surface it as a revision conflict so the renderer offers a
      // deliberate reload instead of retrying the stale transaction forever.
      if (code === 'INVALID_REQUEST' && sessionId === commitSessionId && projectId === commitProjectId) {
        try {
          const refreshed = await bridge.refreshProject({ sessionId: commitSessionId });
          if (refreshed.sessionId === commitSessionId && refreshed.projectId === commitProjectId && refreshed.mode === 'write') {
            await adoptSelectedSession(refreshed);
            return { code: 'REVISION_CONFLICT', ok: false, project: currentProject, revision };
          }
        } catch {
          // Preserve the original typed error when the refresh itself fails.
        }
      }
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

function createDesktopDroppedMediaOperationId(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === 'function') return `dropped_media_${crypto.randomUUID().toLocaleLowerCase()}`;
  return `dropped_media_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function createDesktopClipboardOperationId(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === 'function') return `clipboard_paste_${crypto.randomUUID().toLocaleLowerCase()}`;
  return `clipboard_paste_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function shouldRetryClipboardPaste(error: unknown): boolean {
  if (!isRecord(error) || typeof error.code !== 'string') return true;
  return error.code === 'DURABLE_WRITE_FAILED' || error.code === 'REVISION_CONFLICT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function createDisplaySafeProviderError(error: unknown): Error & { code?: string; retryable?: boolean } {
  const safe = new Error('Provider request failed') as Error & { code?: string; retryable?: boolean };
  if (isRecord(error) && typeof error.code === 'string') safe.code = error.code;
  if (isRecord(error) && typeof error.retryable === 'boolean') safe.retryable = error.retryable;
  return safe;
}

function createDisplaySafeCodexError(error: unknown): Error & { code?: string; retryable?: boolean } {
  const code = isRecord(error) && typeof error.code === 'string' && error.code.startsWith('CODEX_CLI_')
    ? error.code
    : 'CODEX_CLI_FAILED';
  const safe = new Error('Codex CLI request failed') as Error & { code?: string; retryable?: boolean };
  safe.code = code;
  safe.retryable = isRecord(error) && typeof error.retryable === 'boolean' ? error.retryable : true;
  return safe;
}

function createCodexCancellationError(): Error & { code: string; retryable: boolean } {
  const error = new Error('Codex CLI request cancelled') as Error & { code: string; retryable: boolean };
  error.code = 'CODEX_CLI_CANCELLED';
  error.retryable = true;
  return error;
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

function isImageFile(file: File): boolean {
  return ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type.toLowerCase());
}

function isVideoFile(file: File): boolean {
  return file.type.toLowerCase() === 'video/mp4' || /\.mp4$/iu.test(file.name);
}

function isSupportedBrowserMediaFile(file: File): boolean {
  return isImageFile(file) || isVideoFile(file);
}

function loadBrowserAssetPreviews(storage: Storage | null): Map<string, BrowserAssetPreviewRecord> {
  if (storage === null) return new Map();
  try {
    const raw = storage.getItem(BROWSER_ASSET_PREVIEW_STORAGE_KEY);
    if (raw === null) return new Map();
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map();
    const previews = new Map<string, BrowserAssetPreviewRecord>();
    for (const [assetId, value] of Object.entries(parsed)) {
      if (!/^[a-f0-9]{16}$/u.test(assetId) || value === null || typeof value !== 'object') continue;
      const displayUrl = (value as { displayUrl?: unknown }).displayUrl;
      const mediaType = (value as { mediaType?: unknown }).mediaType;
      if (typeof displayUrl !== 'string' || typeof mediaType !== 'string') continue;
      if (!['image/gif', 'image/jpeg', 'image/png', 'image/webp', 'video/mp4'].includes(mediaType)) continue;
      previews.set(assetId, { displayUrl, mediaType: mediaType as BrowserAssetPreviewRecord['mediaType'] });
    }
    return previews;
  } catch {
    return new Map();
  }
}

function persistBrowserAssetPreview(
  storage: Storage | null,
  previews: Map<string, BrowserAssetPreviewRecord>,
  assetId: string,
  mediaType: BrowserAssetPreviewRecord['mediaType'],
  displayUrl: string,
): void {
  const record = { displayUrl, mediaType } satisfies BrowserAssetPreviewRecord;
  previews.set(assetId, record);
  if (storage === null) return;
  try {
    storage.setItem(BROWSER_ASSET_PREVIEW_STORAGE_KEY, JSON.stringify(Object.fromEntries(previews)));
  } catch {
    // The active browser session still uses the in-memory preview. Desktop builds
    // use novus-asset URLs and are not subject to browser storage quota limits.
  }
}

function rebuildBrowserAssetSummaries(
  project: CanvasProject,
  previews: Map<string, BrowserAssetPreviewRecord>,
  imageAssets: Map<string, ProjectImageAssetSummary>,
  videoAssets: Map<string, ProjectVideoAssetSummary>,
): void {
  imageAssets.clear();
  videoAssets.clear();
  for (const asset of project.assets ?? []) {
    const preview = previews.get(asset.assetId);
    if (preview === undefined || preview.mediaType !== asset.mediaType || preview.displayUrl.length === 0) continue;
    const usageCount = countBrowserAssetUsage(project, asset.assetId);
    if (asset.mediaType === 'video/mp4') {
      videoAssets.set(asset.assetId, { ...asset, displayUrl: preview.displayUrl, usageCount });
    } else {
      imageAssets.set(asset.assetId, { ...asset, displayUrl: preview.displayUrl, usageCount });
    }
  }
}

function countBrowserAssetUsage(project: CanvasProject, assetId: string): number {
  return project.nodes.reduce((count, node) => count + ('config' in node.data && containsBrowserAssetId(node.data.config, assetId) ? 1 : 0), 0);
}

function containsBrowserAssetId(value: unknown, assetId: string): boolean {
  if (value === assetId) return true;
  if (Array.isArray(value)) return value.some((entry) => containsBrowserAssetId(entry, assetId));
  if (value === null || typeof value !== 'object') return false;
  return Object.values(value).some((entry) => containsBrowserAssetId(entry, assetId));
}
async function createBrowserImageAsset(file: File, urls: Map<string, string>, storage: Storage | null, previews: Map<string, BrowserAssetPreviewRecord>): Promise<ProjectImageAsset> {
  const digest = await digestFile(file);
  const mediaType = normalizeImageMediaType(file.type);
  const extension = mediaType === 'image/jpeg' ? 'jpg' : mediaType.slice('image/'.length) as 'gif' | 'png' | 'webp';
  const assetId = digest.slice(0, 16);
  const displayUrl = await createBrowserPreviewUrl(file);
  urls.set(assetId, displayUrl);
  persistBrowserAssetPreview(storage, previews, assetId, mediaType, displayUrl);
  const dimensions = await readImageDimensions(displayUrl);
  return {
    assetId,
    byteSize: file.size,
    extension,
    height: dimensions.height,
    label: safeBrowserAssetLabel(file.name, 'Imported image'),
    mediaType,
    origin: 'imported',
    sha256: digest,
    width: dimensions.width,
  };
}

async function createBrowserVideoAsset(file: File, urls: Map<string, string>, storage: Storage | null, previews: Map<string, BrowserAssetPreviewRecord>): Promise<ProjectVideoAsset> {
  const digest = await digestFile(file);
  const assetId = digest.slice(0, 16);
  const displayUrl = await createBrowserPreviewUrl(file);
  urls.set(assetId, displayUrl);
  persistBrowserAssetPreview(storage, previews, assetId, 'video/mp4', displayUrl);
  const metadata = await readVideoMetadata(displayUrl);
  return {
    assetId,
    byteSize: file.size,
    durationMs: metadata.durationMs,
    extension: 'mp4',
    height: metadata.height,
    label: safeBrowserAssetLabel(file.name, 'Imported video'),
    mediaType: 'video/mp4',
    origin: 'imported',
    sha256: digest,
    width: metadata.width,
  };
}

function updateProjectNodeAsset(
  project: CanvasProject,
  nodeId: string,
  assetId: string,
  asset: ProjectImageAsset | ProjectVideoAsset,
  kind: ProjectImageImportTarget['kind'],
): CanvasProject | null {
  if (kind !== 'module') return null;
  const node = project.nodes.find((candidate) => candidate.id === nodeId);
  if (node?.type !== 'module') return null;
  const nextNode = {
    ...node,
    data: {
      ...node.data,
      config: { ...node.data.config, assetId },
    },
  };
  const assets = [...(project.assets ?? []).filter((candidate) => candidate.assetId !== assetId), asset];
  return { ...project, nodes: project.nodes.map((candidate) => candidate.id === nodeId ? nextNode : candidate), assets };
}

function normalizeImageMediaType(value: string): 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp' {
  if (value === 'image/jpeg') return value;
  if (value === 'image/gif') return value;
  if (value === 'image/webp') return value;
  return 'image/png';
}

async function digestFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
  }
  let seed = 2166136261;
  for (const value of bytes) seed = Math.imul(seed ^ value, 16777619);
  const part = (seed >>> 0).toString(16).padStart(8, '0');
  return part.repeat(8).slice(0, 64);
}

async function createBrowserPreviewUrl(file: File): Promise<string> {
  return await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  });
}

async function readImageDimensions(url: string): Promise<{ width: number | null; height: number | null }> {
  if (typeof Image === 'undefined' || url.length === 0) return { width: null, height: null };
  return await new Promise((resolve) => {
    const image = new Image();
    const timeout = globalThis.setTimeout(() => resolve({ width: null, height: null }), 250);
    image.onload = () => resolve({ width: image.naturalWidth || null, height: image.naturalHeight || null });
    image.onerror = () => resolve({ width: null, height: null });
    image.src = url;
    void timeout;
  });
}

async function readVideoMetadata(url: string): Promise<{ width: number | null; height: number | null; durationMs: number | null }> {
  if (typeof document === 'undefined' || url.length === 0) return { width: null, height: null, durationMs: null };
  return await new Promise((resolve) => {
    const video = document.createElement('video');
    const timeout = globalThis.setTimeout(() => resolve({ width: null, height: null, durationMs: null }), 250);
    video.onloadedmetadata = () => resolve({
      width: video.videoWidth || null,
      height: video.videoHeight || null,
      durationMs: Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration * 1000) : null,
    });
    video.onerror = () => resolve({ width: null, height: null, durationMs: null });
    video.src = url;
    void timeout;
  });
}

function safeBrowserAssetLabel(name: string, fallback: string): string {
  const label = name.replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 120);
  return label.length > 0 ? label : fallback;
}
