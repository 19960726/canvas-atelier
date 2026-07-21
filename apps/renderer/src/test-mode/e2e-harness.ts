import type {
  KnowledgeSyncStatusSummary,
  ProjectImageAssetSummary,
  ProjectImageImportTarget,
  ProviderBridgeProfile,
  SubmitImageJobBridgeRequest,
} from '@agent-canvas/desktop-core';
import {
  createSkillPromotionCandidateFingerprint,
  createCanvasModuleNode,
  reviewSkillPromotionCandidate,
  rollbackSkillPromotionCandidate,
  skillPromotionCandidateSchema,
  type CanvasModuleType,
  type CanvasModuleExecutionState,
  type CanvasProject,
  type CanvasModuleNode,
  type ModelJob,
  type PlacementObject,
  type ProjectImageAsset,
  type ProjectMemoryEntry,
  type ProjectTransaction,
  type SkillPromotionCandidate,
} from '@agent-canvas/domain';
import type { KnowledgeBaseStateSummary } from '@agent-canvas/skill-store';
import { buildSkillPromotionCandidate } from '../../../../packages/skill-store/src/candidate-builder';
import {
  createStarterProject,
  replaceKnowledgeClientForTests,
  replaceModelJobExecutorForTests,
  replaceModelJobStorageForTests,
  replaceProjectPersistenceClientForTests,
  resetAppStoreForTests,
  useAppStore,
} from '../app/app-store';
import { createUntitledProject } from '../app/project-factory';
import type {
  ProjectCommitRequest,
  ProjectCommitResult,
  ProjectHydrationResult,
  ProjectImageImportResult,
  ProjectPersistenceClient,
  ProjectRestoreResult,
  ProjectStablePointResult,
} from '../app/desktop-persistence';
import type {
  KnowledgeClient,
  SkillCandidateReviewRequest,
  SkillCandidateReviewResult,
} from '../app/knowledge-client';
import {
  createInMemoryModelJobStorage,
  type ModelJobExecutor,
  type ModelJobStorage,
} from '../jobs/job-store';
import { createDurableCanvasStressProject } from './stress-project';

const installedFlag = '__NOVUS_E2E_INSTALLED__';
const fixedNow = '2026-07-16T09:00:00.000Z';
const e2eNonce = import.meta.env.VITE_NOVUS_E2E_NONCE ?? 'novus-e2e-local';

interface RuntimeState {
  assetSequence: number;
  commitLog: ProjectTransaction[];
  currentProject: CanvasProject;
  failNextModelJobEnqueue: boolean;
  knowledgeListeners: Set<(states: KnowledgeBaseStateSummary[]) => void>;
  knowledgeStates: KnowledgeBaseStateSummary[];
  managedRules: Map<string, string>;
  modelSubmissions: Array<Pick<ModelJob, 'conversationId' | 'id' | 'modelRoute' | 'retryCount'>>;
  pendingImageImports: Array<{
    byteSize: number;
    height: number;
    label: string;
    mediaType: 'image/png';
    width: number;
  }>;
  projectImages: ProjectImageAssetSummary[];
  providerProfiles: ProviderBridgeProfile[];
  revision: number;
  skillSyncWrites: Array<{
    candidateId: string;
    decision: string;
    projectId: string;
  }>;
  storage: ModelJobStorage;
}

export function installRendererE2EHarness(): void {
  const globalTarget = globalThis as typeof globalThis & { [installedFlag]?: true };
  if (globalTarget[installedFlag]) return;
  globalTarget[installedFlag] = true;

  const runtime = createRuntimeState();
  window.novusDesktop = createE2EProviderBridge(runtime);
  replaceProjectPersistenceClientForTests(createPersistenceClient(runtime));
  replaceKnowledgeClientForTests(createKnowledgeClient(runtime));
  replaceModelJobExecutorForTests(createModelExecutor(runtime));
  replaceModelJobStorageForTests(runtime.storage);
  resetAppStoreForTests();

  window.__NOVUS_E2E__ = {
    nonce: e2eNonce,
    async reset() {
      runtime.currentProject = createStarterProject();
      runtime.assetSequence = 0;
      runtime.revision = 0;
      runtime.commitLog = [];
      runtime.failNextModelJobEnqueue = false;
      runtime.knowledgeStates = [];
      runtime.managedRules = new Map();
      runtime.modelSubmissions = [];
      runtime.pendingImageImports = [];
      runtime.projectImages = [];
      runtime.providerProfiles = createE2EProviderProfiles();
      runtime.skillSyncWrites = [];
      runtime.storage = createE2EModelJobStorage(runtime);
      replaceModelJobExecutorForTests(createModelExecutor(runtime));
      replaceModelJobStorageForTests(runtime.storage);
      resetAppStoreForTests();
      await useAppStore.getState().hydratePersistence();
      await useAppStore.getState().initializeKnowledge();
    },
    async resetEmpty() {
      runtime.currentProject = createUntitledProject();
      runtime.assetSequence = 0;
      runtime.revision = 0;
      runtime.commitLog = [];
      runtime.failNextModelJobEnqueue = false;
      runtime.knowledgeStates = [];
      runtime.managedRules = new Map();
      runtime.modelSubmissions = [];
      runtime.pendingImageImports = [];
      runtime.projectImages = [];
      runtime.providerProfiles = createE2EProviderProfiles();
      runtime.skillSyncWrites = [];
      runtime.storage = createE2EModelJobStorage(runtime);
      replaceModelJobExecutorForTests(createModelExecutor(runtime));
      replaceModelJobStorageForTests(runtime.storage);
      resetAppStoreForTests({ project: 'empty' });
      useAppStore.setState({ project: runtime.currentProject });
      await useAppStore.getState().initializeKnowledge();
    },
    failNextModelJobEnqueue() {
      runtime.failNextModelJobEnqueue = true;
    },
    queueProjectImageImport(input) {
      runtime.pendingImageImports.push({
        byteSize: Math.max(1, Math.min(256 * 1024 * 1024, Math.floor(input.byteSize))),
        height: clampE2EDimension(input.height),
        label: sanitizeE2EImageLabel(input.label),
        mediaType: 'image/png',
        width: clampE2EDimension(input.width),
      });
    },
    get commitCount() {
      return runtime.commitLog.length;
    },
    async connectModules(sourceType, sourcePortId, targetType, targetPortId) {
      const state = useAppStore.getState();
      const source = findModuleNodeByType(state.project, sourceType);
      const target = findModuleNodeByType(state.project, targetType);
      if (!source || !target) return false;
      return state.connectModulePorts({
        source: source.id,
        sourceHandle: sourcePortId,
        target: target.id,
        targetHandle: targetPortId,
      });
    },
    async createModule(moduleType, position = { x: 240, y: 180 }) {
      return useAppStore.getState().addModuleNode(moduleType, position);
    },
    async configureModule(moduleType, patch) {
      const state = useAppStore.getState();
      const target = findModuleNodeByType(state.project, moduleType);
      if (!target) return false;
      const nextProject: CanvasProject = {
        ...state.project,
        nodes: state.project.nodes.map((node) => node.id === target.id
          ? {
              ...target,
              data: {
                ...target.data,
                config: { ...target.data.config, ...(patch.config ?? {}) },
                execution: patch.execution ?? target.data.execution,
              },
            }
          : node),
      };
      runtime.currentProject = nextProject;
      useAppStore.setState({ project: nextProject });
      return true;
    },
    async seedSkillSyncDivergence() {
      await seedSkillSyncDivergence(runtime);
      useAppStore.setState({
        project: runtime.currentProject,
        knowledgeBases: cloneKnowledgeStates(runtime.knowledgeStates),
      });
      publishKnowledge(runtime);
    },
    async seedModuleStressGraph(nodeCount, edgeCount) {
      return seedModuleStressGraph(runtime, nodeCount, edgeCount);
    },
    getState() {
      const state = useAppStore.getState();
      return {
        commitCount: runtime.commitLog.length,
        edgeCount: state.project.edges.length,
        nodeCount: state.project.nodes.length,
        moduleTypes: state.project.nodes
          .filter((node): node is CanvasModuleNode => node.type === 'module')
          .map((node) => node.data.moduleType),
        modulePositions: state.project.nodes
          .filter((node): node is CanvasModuleNode => node.type === 'module')
          .map((node) => ({ id: node.id, moduleType: node.data.moduleType, position: { ...node.position } })),
        modelJobs: state.modelJobs.map((job) => ({
          conversationId: job.conversationId,
          id: job.id,
          modelRoute: job.modelRoute,
          retryCount: job.retryCount,
          status: job.status,
        })),
        modelSubmissions: runtime.modelSubmissions.map((submission) => ({ ...submission })),
        projectAssetIds: (state.project.assets ?? []).map((asset) => asset.assetId),
        projectImages: state.projectImages.map((asset) => ({
          assetId: asset.assetId,
          displayUrl: asset.displayUrl,
          label: asset.label,
        })),
        durableProjectContainsTransientImageUrl: /(?:novus-asset:|\/__novus_e2e_asset\/|blob:|data:image)/u
          .test(JSON.stringify(state.project)),
        projectNodeTypes: state.project.nodes.map((node) => node.type),
        skillSyncWrites: runtime.skillSyncWrites.map((write) => ({ ...write })),
        undoDepth: state.undoStack.length,
      };
    },
  };
}

function createRuntimeState(): RuntimeState {
  const runtime: RuntimeState = {
    assetSequence: 0,
    commitLog: [],
    currentProject: createStarterProject(),
    failNextModelJobEnqueue: false,
    knowledgeListeners: new Set(),
    knowledgeStates: [],
    managedRules: new Map(),
    modelSubmissions: [],
    pendingImageImports: [],
    projectImages: [],
    providerProfiles: createE2EProviderProfiles(),
    revision: 0,
    skillSyncWrites: [],
    storage: createInMemoryModelJobStorage(),
  };
  runtime.storage = createE2EModelJobStorage(runtime);
  return runtime;
}

function findModuleNodeByType(project: CanvasProject, moduleType: CanvasModuleType): CanvasModuleNode | null {
  const node = project.nodes.find((candidate): candidate is CanvasModuleNode => (
    candidate.type === 'module' && candidate.data.moduleType === moduleType
  ));
  return node ?? null;
}

const e2eReferenceLayouts: Record<
  Exclude<PlacementObject['role'], 'placement_preview'>,
  Pick<PlacementObject, 'x' | 'y' | 'w' | 'h' | 'zIndex' | 'semanticLayer'>
> = {
  product_identity: { x: 0.34, y: 0.42, w: 0.32, h: 0.38, zIndex: 30, semanticLayer: 'hero_product' },
  scene_composition: { x: 0, y: 0, w: 1, h: 1, zIndex: 0, semanticLayer: 'background' },
  prop_reference: { x: 0.66, y: 0.58, w: 0.18, h: 0.22, zIndex: 20, semanticLayer: 'optional_prop' },
  material_lighting: { x: 0.08, y: 0.7, w: 0.2, h: 0.2, zIndex: 10, semanticLayer: 'midground' },
};

function importE2EProjectImage(
  runtime: RuntimeState,
  target: ProjectImageImportTarget,
): ProjectImageImportResult | null {
  const pending = runtime.pendingImageImports.shift();
  if (pending === undefined) return null;
  const targetNode = runtime.currentProject.nodes.find((node) => node.id === target.nodeId);
  if (targetNode === undefined) return null;

  runtime.assetSequence += 1;
  const assetId = runtime.assetSequence.toString(16).padStart(16, '0');
  const asset: ProjectImageAsset = {
    assetId,
    byteSize: pending.byteSize,
    extension: 'png',
    height: pending.height,
    label: pending.label,
    mediaType: pending.mediaType,
    origin: 'imported',
    sha256: assetId.repeat(4),
    width: pending.width,
  };
  let nextNode: CanvasProject['nodes'][number];
  if (target.kind === 'module') {
    if (targetNode.type !== 'module'
      || (targetNode.data.moduleType !== 'image_input' && targetNode.data.moduleType !== 'upload_image')) return null;
    nextNode = {
      ...targetNode,
      data: {
        ...targetNode.data,
        config: { ...targetNode.data.config, assetId },
      },
    };
  } else {
    if (targetNode.type !== 'placement_preview') return null;
    const object: PlacementObject = {
      id: `reference-${assetId}-${runtime.assetSequence}`,
      assetId,
      role: target.role,
      ...e2eReferenceLayouts[target.role],
      name: asset.label,
      rotation: 0,
      locked: false,
      visible: true,
      flipX: false,
      flipY: false,
    };
    nextNode = {
      ...targetNode,
      data: { ...targetNode.data, objects: [...targetNode.data.objects, object] },
    };
  }

  const assets = [...(runtime.currentProject.assets ?? []), asset];
  const transaction: ProjectTransaction = {
    id: `e2e-import-project-image-${assetId}`,
    label: 'Import managed E2E project image',
    operations: [
      { kind: 'set_project_assets', assets },
      { kind: 'canvas', operation: { kind: 'update_node', node: nextNode } },
    ],
  };
  runtime.currentProject = {
    ...runtime.currentProject,
    assets,
    nodes: runtime.currentProject.nodes.map((node) => node.id === nextNode.id ? nextNode : node),
  };
  runtime.revision += 1;
  runtime.commitLog.push(transaction);
  const summary = createE2EProjectImageSummary(runtime.currentProject, asset);
  runtime.projectImages = [...runtime.projectImages, summary];
  return { asset: summary, project: runtime.currentProject, revision: runtime.revision };
}

function createE2EProjectImageSummary(
  project: CanvasProject,
  asset: ProjectImageAsset,
): ProjectImageAssetSummary {
  return {
    ...asset,
    displayUrl: `${window.location.origin}/__novus_e2e_asset/${asset.assetId}.svg`,
    usageCount: JSON.stringify(project.nodes).split(asset.assetId).length - 1,
  };
}

function sanitizeE2EImageLabel(value: string): string {
  const label = value
    .replace(/\.[A-Za-z0-9]{1,8}$/u, '')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 120);
  return label || 'Managed image';
}

function clampE2EDimension(value: number): number {
  return Math.max(1, Math.min(8192, Math.floor(value)));
}

async function seedModuleStressGraph(runtime: RuntimeState, nodeCount: number, edgeCount: number): Promise<boolean> {
  if (Math.floor(nodeCount) === 300 && Math.floor(edgeCount) === 500) {
    const fixture = createDurableCanvasStressProject();
    const transaction: ProjectTransaction = {
      id: 'e2e-durable-stress-graph-300-500',
      label: 'Seed durable 300 node 500 edge acceptance graph',
      operations: [
        { kind: 'set_project_assets', assets: fixture.project.assets ?? [] },
        { kind: 'replace_canvas_state', nodes: fixture.project.nodes, edges: fixture.project.edges },
      ],
    };
    const committed = await useAppStore.getState().commitProjectTransaction(transaction, {
      kind: 'system',
      nextProject: fixture.project,
    });
    if (!committed) return false;
    runtime.currentProject = useAppStore.getState().project;
    runtime.projectImages = (runtime.currentProject.assets ?? []).map((asset) => createE2EProjectImageSummary(
      runtime.currentProject,
      asset,
    ));
    useAppStore.setState({ projectImages: runtime.projectImages });
    return true;
  }

  const boundedNodeCount = Math.max(2, Math.min(100, Math.floor(nodeCount)));
  const boundedEdgeCount = Math.max(0, Math.min(150, Math.floor(edgeCount)));
  const imageCount = Math.floor(boundedNodeCount / 2);
  const reverseCount = boundedNodeCount - imageCount;
  const nodes = [
    ...Array.from({ length: imageCount }, (_, index) => (
      createCanvasModuleNode(`stress-image-${index}`, 'image_input', {
        x: (index % 10) * 300,
        y: Math.floor(index / 10) * 180,
      })
    )),
    ...Array.from({ length: reverseCount }, (_, index) => (
      createCanvasModuleNode(`stress-reverse-${index}`, 'reverse_agent', {
        x: 1800 + (index % 10) * 300,
        y: Math.floor(index / 10) * 180,
      })
    )),
  ];
  const targetOrders = new Map<string, number>();
  const edges = Array.from({ length: boundedEdgeCount }, (_, index) => {
    const sourceIndex = index % imageCount;
    const targetIndex = Math.floor(index / imageCount) * 17 + index;
    const targetId = `stress-reverse-${targetIndex % reverseCount}`;
    const order = targetOrders.get(targetId) ?? 0;
    targetOrders.set(targetId, order + 1);
    return {
      id: `stress-edge-${index}`,
      source: `stress-image-${sourceIndex}`,
      sourcePortId: 'image',
      target: targetId,
      targetPortId: 'references',
      order,
    };
  });

  return useAppStore.getState().commitProjectTransaction({
    id: `e2e-stress-graph-${boundedNodeCount}-${boundedEdgeCount}`,
    label: 'Seed E2E module stress graph',
    operations: [
      ...nodes.map((node) => ({ kind: 'canvas' as const, operation: { kind: 'create_node' as const, node } })),
      ...edges.map((edge) => ({ kind: 'canvas' as const, operation: { kind: 'create_edge' as const, edge } })),
    ],
  }, { kind: 'system' });
}

function createE2EProviderBridge(runtime: RuntimeState): typeof window.novusDesktop {
  return {
    provider: {
      ackImageJobTerminal: async () => ({ acknowledged: true as const }),
      cancelImageJob: async () => ({ status: 'cancelled' as const }),
      configure: async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const }),
      getStatus: async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const }),
      listProfiles: async () => runtime.providerProfiles.map((profile) => ({
        ...profile,
        capabilities: [...profile.capabilities],
      })),
      pollImageJob: async () => ({ status: 'running' as const, progress: 0.35 }),
      submitImageJob: async (request: SubmitImageJobBridgeRequest) => ({
        providerTaskId: `e2e-bridge-task-${request.jobId}`,
      }),
      unlock: async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const }),
    },
  } as unknown as typeof window.novusDesktop;
}

function createE2EProviderProfiles(): ProviderBridgeProfile[] {
  return [
    {
      provider: 'comfly',
      modelRoute: 'image-generation',
      displayName: 'GPT Image',
      modelId: 'gpt-image-1',
      capabilities: ['image_generation', 'image_edit', 'async_tasks'],
    },
    {
      provider: 'comfly',
      modelRoute: 'nano-banana-2-actual-route',
      displayName: 'Nano Banana 2',
      modelId: 'nano-banana-2',
      capabilities: ['image_generation', 'async_tasks'],
    },
    {
      provider: 'comfly',
      modelRoute: 'image-edit-only-route',
      displayName: 'Image Edit Only',
      modelId: 'edit-only-model',
      capabilities: ['image_edit', 'async_tasks'],
    },
  ];
}

function createE2EModelJobStorage(runtime: RuntimeState): ModelJobStorage {
  const inner = createInMemoryModelJobStorage();
  return {
    get: (id) => inner.get(id),
    list: () => inner.list(),
    put: (job) => inner.put(job),
    bulkPut: async (jobs) => {
      if (runtime.failNextModelJobEnqueue) {
        runtime.failNextModelJobEnqueue = false;
        throw new Error('E2E model enqueue unavailable');
      }
      await inner.bulkPut(jobs);
    },
  };
}

function createPersistenceClient(runtime: RuntimeState): ProjectPersistenceClient {
  return {
    async close() {},
    async commit(request: ProjectCommitRequest): Promise<ProjectCommitResult> {
      runtime.currentProject = request.nextProject;
      runtime.revision += 1;
      runtime.commitLog.push(request.transaction);
      return {
        ok: true,
        project: runtime.currentProject,
        revision: runtime.revision,
      };
    },
    async hydrate(): Promise<ProjectHydrationResult> {
      return {
        availableSnapshotIds: [],
        lifecycle: 'durable',
        mode: 'browser',
        project: runtime.currentProject,
        revision: runtime.revision,
        saveStatus: 'saved',
      };
    },
    async importProjectImage(target) {
      return importE2EProjectImage(runtime, target);
    },
    async listProjectImages() {
      return runtime.projectImages.map((asset) => ({
        ...asset,
        usageCount: JSON.stringify(runtime.currentProject.nodes).split(asset.assetId).length - 1,
      }));
    },
    async restore(): Promise<ProjectRestoreResult> {
      return {
        availableSnapshotIds: [],
        lifecycle: 'durable',
        project: runtime.currentProject,
        revision: runtime.revision,
        saveStatus: 'saved',
      };
    },
    async stablePoint(): Promise<ProjectStablePointResult> {
      return {
        availableSnapshotIds: [],
        project: runtime.currentProject,
        revision: runtime.revision,
      };
    },
  };
}

function createKnowledgeClient(runtime: RuntimeState): KnowledgeClient {
  return {
    async start(listener) {
      runtime.knowledgeListeners.add(listener);
      listener(cloneKnowledgeStates(runtime.knowledgeStates));
    },
    stop() {
      runtime.knowledgeListeners.clear();
    },
    async configure() {},
    async prepareSkillCandidateReview(request) {
      if (request.baseRevision !== runtime.revision) {
        throw createE2EStalePrepareError('E2E skill candidate preparation base revision is stale');
      }
      const candidate = runtime.currentProject.skillPromotionCandidates.find((item) => item.id === request.candidateId);
      if (!candidate) throw new Error(`Unknown e2e skill candidate: ${request.candidateId}`);
      if (
        candidate.reviewStatus !== 'pending_review' ||
        candidate.reviewedAt !== undefined ||
        candidate.reviewTransactionId !== undefined ||
        createSkillPromotionCandidateFingerprint(candidate) !== request.candidateFingerprint
      ) {
        throw createE2EStalePrepareError('E2E skill candidate preparation fingerprint is stale');
      }
      const targetKnowledgeBaseId = candidate.targetKnowledgeBaseId ?? 'scene-skill';
      const targetKnowledgeSection = candidate.targetKnowledgeSection ?? 'composition/placement';
      const sourceIds = candidate.sourceProjectMemoryIds ?? [candidate.sourceProjectMemoryId];
      const sourceEntries = sourceIds.map((sourceId) => runtime.currentProject.projectMemory.find((entry) => entry.id === sourceId));
      if (sourceEntries.some((entry) => entry === undefined)) throw new Error('E2E source memory unavailable');
      const managedRule = runtime.managedRules.get(targetKnowledgeBaseId);
      if (!managedRule) throw new Error('E2E managed rule unavailable');
      const managedState = runtime.knowledgeStates.find((state) => state.knowledgeBaseId === targetKnowledgeBaseId);
      if (managedState === undefined || managedState.activeVersion === null || managedState.activeContentHash === null) {
        throw new Error('E2E managed snapshot unavailable');
      }
      const builderEntries = sourceEntries
        .filter((entry): entry is ProjectMemoryEntry => entry !== undefined)
        .map((entry) => ({ ...entry, nextStep: entry.rationale.trim() || entry.nextStep }));
      const reviewable = buildSkillPromotionCandidate(builderEntries, {
        affectedCapabilities: candidate.affectedCapabilities,
        candidateId: candidate.id,
        createdAt: candidate.createdAt,
        managedRule,
        proposedRule: candidate.rule,
        targetKnowledgeBaseId,
        targetSection: targetKnowledgeSection,
      });
      const prepared = skillPromotionCandidateSchema.parse({
        ...reviewable,
        preparedManagedSnapshot: {
          knowledgeBaseId: managedState.knowledgeBaseId,
          version: managedState.activeVersion,
          contentHash: managedState.activeContentHash,
        },
        reviewPreparationStatus: 'ready',
        reviewPreparationStartedAt: candidate.reviewPreparationStartedAt,
      });
      const candidates = runtime.currentProject.skillPromotionCandidates.map((item) => (
        item.id === prepared.id ? prepared : item
      ));
      runtime.currentProject = {
        ...runtime.currentProject,
        skillPromotionCandidates: candidates,
      };
      runtime.revision += 1;
      return {
        projectId: request.projectId,
        currentRevision: runtime.revision,
        candidate: prepared,
        candidates,
        knowledgeState: runtime.knowledgeStates.find((state) => state.knowledgeBaseId === targetKnowledgeBaseId) ?? null,
      };
    },
    async review(request: SkillCandidateReviewRequest): Promise<SkillCandidateReviewResult> {
      const candidate = runtime.currentProject.skillPromotionCandidates.find((item) => item.id === request.candidateId);
      if (!candidate) throw new Error(`Unknown e2e skill candidate: ${request.candidateId}`);
      if (request.decision !== 'rolled_back') {
        assertE2EReviewBinding(runtime, candidate, request);
      }

      const reviewed = reviewCandidate(runtime, candidate, request);
      const candidates = runtime.currentProject.skillPromotionCandidates.map((item) => (
        item.id === reviewed.id ? reviewed : item
      ));
      runtime.currentProject = {
        ...runtime.currentProject,
        skillPromotionCandidates: candidates,
      };

      const knowledgeState = request.decision === 'approved'
        ? promoteKnowledgeState(runtime, reviewed)
        : runtime.knowledgeStates.find((state) => state.knowledgeBaseId === reviewed.targetKnowledgeBaseId) ?? null;
      publishKnowledge(runtime);

      return {
        projectId: request.projectId,
        currentRevision: runtime.revision,
        candidate: reviewed,
        candidates,
        knowledgeState,
      };
    },
    getLease(runId, capability, references, citations) {
      return {
        schemaVersion: 1,
        leaseId: `e2e-lease-${runId}`,
        runId,
        createdAt: fixedNow,
        capability,
        snapshots: runtime.knowledgeStates
          .filter((state) => state.activeVersion !== null && state.activeContentHash !== null)
          .map((state) => ({
            knowledgeBaseId: state.knowledgeBaseId,
            version: state.activeVersion!,
            contentHash: state.activeContentHash!,
          })),
        references,
        citations,
        versionKey: runtime.knowledgeStates.length === 0
          ? 'no-snapshots-configured'
          : runtime.knowledgeStates.map((state) => `${state.knowledgeBaseId}@${state.activeVersion}:${state.activeContentHash?.slice(0, 12)}`).join('|'),
      };
    },
  };
}

function createModelExecutor(runtime: RuntimeState): ModelJobExecutor {
  return {
    async submit(job) {
      runtime.modelSubmissions.push({
        conversationId: job.conversationId,
        id: job.id,
        modelRoute: job.modelRoute,
        retryCount: job.retryCount,
      });
      return { providerTaskId: `e2e-provider-task-${job.id}-${job.retryCount}` };
    },
    async poll() {
      return { status: 'running', progress: 0.35 };
    },
    async cancel() {
      return { status: 'cancelled' };
    },
  };
}

function reviewCandidate(
  runtime: RuntimeState,
  candidate: SkillPromotionCandidate,
  request: SkillCandidateReviewRequest,
): SkillPromotionCandidate {
  if (request.decision === 'approved') {
    runtime.skillSyncWrites.push({
      candidateId: request.candidateId,
      decision: request.decision,
      projectId: request.projectId,
    });
    return reviewSkillPromotionCandidate(candidate, {
      decision: 'approved',
      publishedKnowledgeVersion: 2,
      reviewedAt: fixedNow,
      transactionId: `e2e-skill-sync-${request.candidateId}`,
    });
  }

  if (request.decision === 'rolled_back') {
    return rollbackSkillPromotionCandidate(candidate, fixedNow, {
      transactionId: `e2e-skill-rollback-${request.candidateId}`,
    });
  }

  return reviewSkillPromotionCandidate(candidate, {
    decision: request.decision,
    reviewedAt: fixedNow,
    transactionId: `e2e-skill-review-${request.candidateId}`,
  });
}

function assertE2EReviewBinding(
  runtime: RuntimeState,
  candidate: SkillPromotionCandidate,
  request: SkillCandidateReviewRequest,
): void {
  if (
    request.baseRevision !== runtime.revision ||
    request.candidateFingerprint === undefined ||
    request.preparedManagedSnapshot === undefined ||
    candidate.reviewStatus !== 'pending_review' ||
    candidate.reviewPreparationStatus !== 'ready' ||
    candidate.reviewedAt !== undefined ||
    candidate.reviewTransactionId !== undefined ||
    candidate.sourceRule === undefined ||
    candidate.managedRule === undefined ||
    candidate.diffHunks === undefined ||
    candidate.diffHunks.length === 0 ||
    candidate.preparedManagedSnapshot === undefined ||
    createSkillPromotionCandidateFingerprint(candidate) !== request.candidateFingerprint ||
    !preparedManagedSnapshotMatches(candidate.preparedManagedSnapshot, request.preparedManagedSnapshot)
  ) {
    throw createE2EStalePrepareError('E2E skill candidate review preview is stale');
  }
  const state = runtime.knowledgeStates.find((item) => item.knowledgeBaseId === request.preparedManagedSnapshot!.knowledgeBaseId);
  if (
    state === undefined ||
    state.activeVersion !== request.preparedManagedSnapshot.version ||
    state.activeContentHash !== request.preparedManagedSnapshot.contentHash
  ) {
    throw createE2EStalePrepareError('E2E skill candidate managed snapshot changed after preview');
  }
}

function preparedManagedSnapshotMatches(
  left: NonNullable<SkillPromotionCandidate['preparedManagedSnapshot']>,
  right: NonNullable<SkillPromotionCandidate['preparedManagedSnapshot']>,
): boolean {
  return left.knowledgeBaseId === right.knowledgeBaseId
    && left.version === right.version
    && left.contentHash === right.contentHash;
}

async function seedSkillSyncDivergence(runtime: RuntimeState): Promise<void> {
  const proposedRule = 'Proposed rule body: lock logo and prop spacing together.';
  const memory: ProjectMemoryEntry = {
    schemaVersion: 1,
    id: 'project-memory-e2e-divergence',
    projectId: 'local-project',
    projectRevision: 1,
    createdAt: fixedNow,
    kind: 'optimization',
    actor: 'agent',
    title: 'Guarded Skill divergence',
    changeSummary: 'Local source and managed Skill diverged before sync.',
    rationale: 'Source rule body: lock logo from local project memory.',
    snapshots: {
      beforeId: 'e2e-skill-before',
      afterId: 'e2e-skill-after',
    },
    context: {
      referenceAssetIds: [],
      resultAssetIds: [],
    },
    feedback: {
      keep: ['logo lock'],
      change: ['prop spacing'],
      never: ['sync before confirmation'],
    },
    nextStep: proposedRule,
  };
  runtime.currentProject = {
    ...createStarterProject(),
    projectMemory: [memory],
    skillPromotionCandidates: [],
  };
  runtime.knowledgeStates = [createManagedDivergenceState(1, 'a'.repeat(64), 'managed active v1')];
  runtime.managedRules.set('scene-skill', 'Managed rule body: keep the existing cool background lighting.');
  useAppStore.setState({
    project: runtime.currentProject,
    knowledgeBases: cloneKnowledgeStates(runtime.knowledgeStates),
  });
  await useAppStore.getState().promoteProjectMemory(memory.id);
  runtime.currentProject = useAppStore.getState().project;
}

function promoteKnowledgeState(runtime: RuntimeState, candidate: SkillPromotionCandidate): KnowledgeBaseStateSummary {
  const next = createManagedDivergenceState(
    candidate.publishedKnowledgeVersion ?? 2,
    'b'.repeat(64),
    'managed approved v2',
  );
  runtime.knowledgeStates = [next];
  return next;
}

function createManagedDivergenceState(
  version: number,
  hash: string,
  displayName: string,
): KnowledgeBaseStateSummary {
  return {
    schemaVersion: 1,
    knowledgeBaseId: 'scene-skill',
    displayName: 'Managed scene skill',
    status: 'active',
    activeVersion: version,
    activeContentHash: hash,
    stateRevision: version,
    versionCount: version,
    versions: [{
      version,
      contentHash: hash,
      displayName,
      publishedAt: fixedNow,
      sourceDeviceId: 'managed-e2e',
    }],
    lastFailure: null,
    lastRollbackAt: null,
  };
}

function publishKnowledge(runtime: RuntimeState): void {
  const states = cloneKnowledgeStates(runtime.knowledgeStates);
  for (const listener of runtime.knowledgeListeners) {
    listener(states);
  }
}

function cloneKnowledgeStates(states: KnowledgeBaseStateSummary[]): KnowledgeBaseStateSummary[] {
  return states.map((state) => ({
    ...state,
    versions: state.versions.map((version) => ({ ...version })),
    lastFailure: state.lastFailure ? { ...state.lastFailure } : null,
  }));
}

function createE2EStalePrepareError(message: string): Error & { code: string; retryable: boolean } {
  const error = new Error(message) as Error & { code: string; retryable: boolean };
  error.code = 'REVISION_CONFLICT';
  error.retryable = true;
  return error;
}

declare global {
  interface Window {
    __NOVUS_E2E__?: {
      commitCount: number;
      connectModules(
        sourceType: CanvasModuleType,
        sourcePortId: string,
        targetType: CanvasModuleType,
        targetPortId: string,
      ): Promise<boolean>;
      createModule(moduleType: CanvasModuleType, position?: { x: number; y: number }): Promise<boolean>;
      configureModule(moduleType: CanvasModuleType, patch: {
        config?: Record<string, unknown>;
        execution?: { state: CanvasModuleExecutionState; latestExecutionId?: string };
      }): Promise<boolean>;
      getState(): {
        commitCount: number;
        durableProjectContainsTransientImageUrl: boolean;
        edgeCount: number;
        nodeCount: number;
        moduleTypes: CanvasModuleType[];
        modulePositions: Array<{
          id: string;
          moduleType: CanvasModuleType;
          position: { x: number; y: number };
        }>;
        modelJobs: Array<Pick<ModelJob, 'conversationId' | 'id' | 'modelRoute' | 'retryCount' | 'status'>>;
        modelSubmissions: Array<Pick<ModelJob, 'conversationId' | 'id' | 'modelRoute' | 'retryCount'>>;
        projectAssetIds: string[];
        projectImages: Array<Pick<ProjectImageAssetSummary, 'assetId' | 'displayUrl' | 'label'>>;
        projectNodeTypes: string[];
        skillSyncWrites: Array<{
          candidateId: string;
          decision: string;
          projectId: string;
        }>;
        undoDepth: number;
      };
      failNextModelJobEnqueue(): void;
      nonce: string;
      queueProjectImageImport(input: {
        byteSize: number;
        height: number;
        label: string;
        mediaType: 'image/png';
        width: number;
      }): void;
      reset(): Promise<void>;
      resetEmpty(): Promise<void>;
      seedSkillSyncDivergence(): Promise<void>;
      seedModuleStressGraph(nodeCount: number, edgeCount: number): Promise<boolean>;
    };
  }
}
