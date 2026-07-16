import type {
  KnowledgeSyncStatusSummary,
  ProviderBridgeProfile,
  SubmitImageJobBridgeRequest,
} from '@agent-canvas/desktop-core';
import {
  createSkillPromotionCandidateFingerprint,
  reviewSkillPromotionCandidate,
  rollbackSkillPromotionCandidate,
  skillPromotionCandidateSchema,
  type CanvasProject,
  type ModelJob,
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
import type {
  ProjectCommitRequest,
  ProjectCommitResult,
  ProjectHydrationResult,
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

const installedFlag = '__NOVUS_E2E_INSTALLED__';
const fixedNow = '2026-07-16T09:00:00.000Z';
const e2eNonce = import.meta.env.VITE_NOVUS_E2E_NONCE ?? 'novus-e2e-local';

interface RuntimeState {
  commitLog: ProjectTransaction[];
  currentProject: CanvasProject;
  failNextModelJobEnqueue: boolean;
  knowledgeListeners: Set<(states: KnowledgeBaseStateSummary[]) => void>;
  knowledgeStates: KnowledgeBaseStateSummary[];
  managedRules: Map<string, string>;
  modelSubmissions: Array<Pick<ModelJob, 'conversationId' | 'id' | 'modelRoute' | 'retryCount'>>;
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
      runtime.revision = 0;
      runtime.commitLog = [];
      runtime.failNextModelJobEnqueue = false;
      runtime.knowledgeStates = [];
      runtime.managedRules = new Map();
      runtime.modelSubmissions = [];
      runtime.providerProfiles = createE2EProviderProfiles();
      runtime.skillSyncWrites = [];
      runtime.storage = createE2EModelJobStorage(runtime);
      replaceModelJobExecutorForTests(createModelExecutor(runtime));
      replaceModelJobStorageForTests(runtime.storage);
      resetAppStoreForTests();
      await useAppStore.getState().hydratePersistence();
      await useAppStore.getState().initializeKnowledge();
    },
    failNextModelJobEnqueue() {
      runtime.failNextModelJobEnqueue = true;
    },
    async seedSkillSyncDivergence() {
      await seedSkillSyncDivergence(runtime);
      useAppStore.setState({
        project: runtime.currentProject,
        knowledgeBases: cloneKnowledgeStates(runtime.knowledgeStates),
      });
      publishKnowledge(runtime);
    },
    getState() {
      const state = useAppStore.getState();
      return {
        commitCount: runtime.commitLog.length,
        modelJobs: state.modelJobs.map((job) => ({
          conversationId: job.conversationId,
          id: job.id,
          modelRoute: job.modelRoute,
          retryCount: job.retryCount,
          status: job.status,
        })),
        modelSubmissions: runtime.modelSubmissions.map((submission) => ({ ...submission })),
        projectNodeTypes: state.project.nodes.map((node) => node.type),
        skillSyncWrites: runtime.skillSyncWrites.map((write) => ({ ...write })),
      };
    },
  };
}

function createRuntimeState(): RuntimeState {
  const runtime: RuntimeState = {
    commitLog: [],
    currentProject: createStarterProject(),
    failNextModelJobEnqueue: false,
    knowledgeListeners: new Set(),
    knowledgeStates: [],
    managedRules: new Map(),
    modelSubmissions: [],
    providerProfiles: createE2EProviderProfiles(),
    revision: 0,
    skillSyncWrites: [],
    storage: createInMemoryModelJobStorage(),
  };
  runtime.storage = createE2EModelJobStorage(runtime);
  return runtime;
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
        mode: 'browser',
        project: runtime.currentProject,
        revision: runtime.revision,
        saveStatus: 'saved',
      };
    },
    async restore(): Promise<ProjectRestoreResult> {
      return {
        availableSnapshotIds: [],
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
      getState(): {
        commitCount: number;
        modelJobs: Array<Pick<ModelJob, 'conversationId' | 'id' | 'modelRoute' | 'retryCount' | 'status'>>;
        modelSubmissions: Array<Pick<ModelJob, 'conversationId' | 'id' | 'modelRoute' | 'retryCount'>>;
        projectNodeTypes: string[];
        skillSyncWrites: Array<{
          candidateId: string;
          decision: string;
          projectId: string;
        }>;
      };
      failNextModelJobEnqueue(): void;
      nonce: string;
      reset(): Promise<void>;
      seedSkillSyncDivergence(): Promise<void>;
    };
  }
}
