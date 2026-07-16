import type { KnowledgeSyncStatusSummary } from '@agent-canvas/desktop-core';
import {
  reviewSkillPromotionCandidate,
  rollbackSkillPromotionCandidate,
  type CanvasProject,
  type ModelJob,
  type ProjectMemoryEntry,
  type ProjectTransaction,
  type SkillPromotionCandidate,
} from '@agent-canvas/domain';
import type { KnowledgeBaseStateSummary } from '@agent-canvas/skill-store';
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

interface RuntimeState {
  commitLog: ProjectTransaction[];
  currentProject: CanvasProject;
  knowledgeListeners: Set<(states: KnowledgeBaseStateSummary[]) => void>;
  knowledgeStates: KnowledgeBaseStateSummary[];
  modelSubmissions: Array<Pick<ModelJob, 'conversationId' | 'id' | 'modelRoute' | 'retryCount'>>;
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
  replaceProjectPersistenceClientForTests(createPersistenceClient(runtime));
  replaceKnowledgeClientForTests(createKnowledgeClient(runtime));
  replaceModelJobExecutorForTests(createModelExecutor(runtime));
  replaceModelJobStorageForTests(runtime.storage);
  resetAppStoreForTests();

  window.__NOVUS_E2E__ = {
    async reset() {
      runtime.currentProject = createStarterProject();
      runtime.revision = 0;
      runtime.commitLog = [];
      runtime.knowledgeStates = [];
      runtime.modelSubmissions = [];
      runtime.skillSyncWrites = [];
      runtime.storage = createInMemoryModelJobStorage();
      replaceModelJobExecutorForTests(createModelExecutor(runtime));
      replaceModelJobStorageForTests(runtime.storage);
      resetAppStoreForTests();
      await useAppStore.getState().hydratePersistence();
      await useAppStore.getState().initializeKnowledge();
    },
    async seedSkillSyncDivergence() {
      seedSkillSyncDivergence(runtime);
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
  return {
    commitLog: [],
    currentProject: createStarterProject(),
    knowledgeListeners: new Set(),
    knowledgeStates: [],
    modelSubmissions: [],
    revision: 0,
    skillSyncWrites: [],
    storage: createInMemoryModelJobStorage(),
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
    async review(request: SkillCandidateReviewRequest): Promise<SkillCandidateReviewResult> {
      const candidate = runtime.currentProject.skillPromotionCandidates.find((item) => item.id === request.candidateId);
      if (!candidate) throw new Error(`Unknown e2e skill candidate: ${request.candidateId}`);

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

function seedSkillSyncDivergence(runtime: RuntimeState): void {
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
    rationale: 'source keeps product logo locked',
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
    nextStep: 'proposed keeps product logo and prop spacing locked',
  };
  const candidate: SkillPromotionCandidate = {
    schemaVersion: 1,
    id: 'skill-candidate-e2e-divergence',
    sourceProjectId: 'local-project',
    sourceProjectMemoryId: memory.id,
    createdAt: fixedNow,
    title: memory.title,
    rationale: memory.rationale,
    rule: memory.nextStep,
    beforeRule: 'source keeps product logo locked',
    targetKnowledgeBaseId: 'scene-skill',
    targetKnowledgeSection: 'composition/placement',
    counts: {
      citationCount: 0,
      observationCount: 1,
      referenceCount: 0,
      supportingMemoryCount: 1,
    },
    confidence: 0.93,
    affectedCapabilities: ['image_generation'],
    evidence: memory.feedback,
    reviewStatus: 'pending_review',
  };

  runtime.currentProject = {
    ...createStarterProject(),
    projectMemory: [memory],
    skillPromotionCandidates: [candidate],
  };
  runtime.knowledgeStates = [createManagedDivergenceState(1, 'a'.repeat(64), 'managed active v1')];
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
      reset(): Promise<void>;
      seedSkillSyncDivergence(): Promise<void>;
    };
  }
}
