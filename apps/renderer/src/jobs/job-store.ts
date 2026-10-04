import Dexie, { type Table } from 'dexie';
import type { CanvasNode, CanvasProject, ImageAspectRatio, ImageQuality, ModelJob, ModelJobKind, ModelJobProvider, ProjectTransaction, VideoResolutionTier } from '@agent-canvas/domain';
import {
  assertPublicModelJobPayload,
  createConfirmedModelJob,
  modelJobSchema,
  sanitizeModelJobError,
  transitionModelJob,
} from '@agent-canvas/domain';
import { createModelJobRunId } from './model-job-identity';
import { isRejectedLayerResult } from './layer-result-retry';
import { isPotentiallyPaidProviderJob, isUncertainExternalSubmission, UNCERTAIN_EXTERNAL_SUBMISSION_ERROR } from './model-job-retry-policy';
import { invalidateLayeringProof } from '../app/layering-proof';

const DEFAULT_POLL_CONCURRENCY = 4;
const DEFAULT_MATERIALIZE_CONCURRENCY = 2;
const DEFAULT_CANCEL_TIMEOUT_MS = 3_000;
const DEFAULT_TERMINAL_ACK_TIMEOUT_MS = 1_000;
const MAX_RECOVERABLE_RUNNING_JOB_AGE_MS = 30 * 60 * 1_000;

function isRecoverableRunningJobFresh(job: ModelJob, currentTime: string): boolean {
  const timestamp = job.updatedAt ?? job.createdAt;
  if (timestamp === undefined) return false;
  const updatedAt = Date.parse(timestamp);
  const recoveredAt = Date.parse(currentTime);
  return Number.isFinite(updatedAt)
    && Number.isFinite(recoveredAt)
    && recoveredAt - updatedAt <= MAX_RECOVERABLE_RUNNING_JOB_AGE_MS;
}

export interface ModelJobRequest {
  id: string;
  kind?: ModelJobKind;
  promptNodeId: string;
  prompt: string;
  provider: ModelJobProvider;
  modelRoute: string;
  displayName: string;
  modelId: string;
  referenceAssetIds: string[];
  referenceSnapshotRevision?: number;
  referenceSnapshotFingerprint?: string;
  aspectRatio?: ImageAspectRatio;
  resolution?: '1K' | '2K' | '4K';
  imageQuality?: ImageQuality;
  imageOutputFormat?: ModelJob['imageOutputFormat'];
  imageBackground?: ModelJob['imageBackground'];
  videoResolution?: VideoResolutionTier;
  durationSeconds?: number;
  audioEnabled?: boolean;
  outputCount?: 1 | 2 | 3 | 4;
  layeringGroupId?: string;
  layeringLayerId?: string;
  layeringOutputContract?: NonNullable<ModelJob['layeringOutputContract']>;
  layeringConfirmationDigest?: string;
}

export interface EnqueueConfirmedJobsInput {
  conversationId: string;
  projectId?: string;
  projectSessionId?: string;
  confirmedAt?: string;
  requests: ModelJobRequest[];
}

export interface ModelJobSubmission {
  providerTaskId: string;
}

export interface ModelJobResult {
  assetId: string;
  assetIds?: string[];
  width?: number;
  height?: number;
  durationSeconds?: number;
  /** Provider result representation is retained as an untrusted candidate label. */
  resultRepresentation?: 'alpha-matte' | 'independent-rgba-candidate' | 'opaque-background-candidate';
  decode?: () => Promise<void>;
}

export type ModelJobPollResult =
  | { status: 'running'; progress?: number; blockedReason?: 'credentials_locked' }
  | { status: 'completed'; progress?: number; result: ModelJobResult }
  | { status: 'failed'; error: unknown }
  | { status: 'cancelled' };

export interface ModelJobExecutor {
  submit(job: ModelJob): Promise<ModelJobSubmission>;
  poll(job: ModelJob): Promise<ModelJobPollResult>;
  cancel?(job: ModelJob): Promise<ModelJobPollResult | void>;
  ackTerminal?(job: ModelJob): Promise<void>;
}

export interface ModelJobStorage {
  get(id: string): Promise<ModelJob | undefined>;
  list(): Promise<ModelJob[]>;
  put(job: ModelJob): Promise<void>;
  bulkPut(jobs: ModelJob[]): Promise<void>;
}

export interface ResultMaterialization {
  readonly resultNodeId: string;
  readonly transaction: ProjectTransaction;
}

export type BuildResultMaterialization = (
  project: CanvasProject | undefined,
) => ResultMaterialization;

export interface ResultMaterializationCommit {
  readonly committed: boolean;
  readonly resultNodeId: string;
}

export interface ModelJobStoreOptions {
  storage?: ModelJobStorage;
  executor: ModelJobExecutor;
  commitProjectTransaction: (
    build: BuildResultMaterialization,
    ownerJob: ModelJob,
    isOwnerRunning: () => Promise<boolean>,
  ) => Promise<ResultMaterializationCommit>;
  repairCompletedProjectTransaction?: (
    build: BuildResultMaterialization,
    ownerJob: ModelJob,
  ) => Promise<ResultMaterializationCommit>;
  /**
   * Completed jobs live in one local queue database, while projects have
   * independent durable sessions.  Callers can veto startup repair for jobs
   * that do not belong to the currently hydrated project; without this guard
   * a stale job from another project can append a result while the user is
   * editing, producing a false save-conflict banner.
   */
  shouldRepairCompletedProjectTransaction?: (ownerJob: ModelJob) => boolean | Promise<boolean>;
  canContinueResult?: (
    ownerJob: ModelJob,
    isOwnerRunning: () => Promise<boolean>,
  ) => Promise<boolean>;
  canRecoverRunningJob?: (ownerJob: ModelJob) => Promise<boolean>;
  isJobInScope?: (ownerJob: ModelJob) => boolean;
  shouldProcessJob?: (ownerJob: ModelJob) => boolean;
  getProject?: () => CanvasProject;
  pollConcurrency?: number;
  decodeConcurrency?: number;
  now?: () => string;
  pollIntervalMs?: number;
}

export interface ModelJobStore {
  enqueueConfirmedJobs(input: EnqueueConfirmedJobsInput): Promise<ModelJob[]>;
  recover(options?: { preserveOutOfScopeJobs?: boolean; resumeOwnedJobs?: boolean }): Promise<void>;
  run(): Promise<void>;
  stop(): void;
  processQueue(): Promise<void>;
  pollActiveJobs(): Promise<void>;
  retryJob(id: string, overrides?: { id?: string; projectId?: string; projectSessionId?: string; rejectedLayerResultAssetId?: string }): Promise<ModelJob>;
  cancelQueuedJob(id: string): Promise<void>;
  listJobs(): Promise<ModelJob[]>;
  subscribe(listener: (jobs: ModelJob[]) => void): () => void;
}

class ModelJobDexie extends Dexie {
  jobs!: Table<ModelJob, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      jobs: '&id,status,providerTaskId,updatedAt,createdAt',
    });
  }
}

export function createDexieModelJobStorage(databaseName = 'novus-atelier-model-jobs'): ModelJobStorage {
  const database = new ModelJobDexie(databaseName);
  return {
    get: (id) => database.jobs.get(id),
    list: async () => (await database.jobs.toArray()).sort(compareJobs),
    put: async (job) => { await database.jobs.put(job); },
    bulkPut: async (jobs) => { await database.jobs.bulkPut(jobs); },
  };
}

export function createInMemoryModelJobStorage(seed: ModelJob[] = []): ModelJobStorage {
  const jobs = new Map(seed.map((job) => [job.id, { ...job, referenceAssetIds: [...job.referenceAssetIds] }]));
  return {
    get: async (id) => cloneJob(jobs.get(id)),
    list: async () => [...jobs.values()].map(cloneRequiredJob).sort(compareJobs),
    put: async (job) => { jobs.set(job.id, cloneRequiredJob(job)); },
    bulkPut: async (nextJobs) => {
      for (const job of nextJobs) jobs.set(job.id, cloneRequiredJob(job));
    },
  };
}

export function createModelJobStore(options: ModelJobStoreOptions): ModelJobStore {
  const storage = options.storage ?? createDexieModelJobStorage();
  const now = options.now ?? (() => new Date().toISOString());
  const pollIntervalMs = options.pollIntervalMs ?? 750;
  const pollConcurrency = Math.max(1, options.pollConcurrency ?? DEFAULT_POLL_CONCURRENCY);
  const decodeConcurrency = Math.max(1, options.decodeConcurrency ?? DEFAULT_MATERIALIZE_CONCURRENCY);
  const listeners = new Set<(jobs: ModelJob[]) => void>();
  const providerQueue = new AsyncQueue(pollConcurrency);
  const resultDecodeQueue = new AsyncQueue(decodeConcurrency);
  const resultCommitQueue = new AsyncQueue(1);
  const submittingJobs = new Set<string>();
  const cancellationRequests = new Set<string>();
  const pollingJobs = new Set<string>();
  const pollRetryStates = new Map<string, { failures: number; nextPollAt: number }>();
  const materializingJobs = new Set<string>();
  const shouldProcessJob = options.shouldProcessJob ?? (() => true);
  const isJobInScope = options.isJobInScope ?? shouldProcessJob;
  const retryingJobs = new Map<string, Promise<ModelJob>>();
  let activeRun: Promise<void> | null = null;
  let runRequestedWhileActive = false;
  let stopped = false;
  let store!: ModelJobStore;

  const emit = async () => {
    if (listeners.size === 0) return;
    const jobs = await storage.list();
    const cloned = jobs.map(cloneRequiredJob);
    for (const listener of listeners) listener(cloned.map(cloneRequiredJob));
  };
  const putJob = async (job: ModelJob) => {
    await storage.put(job);
    await emit();
  };
  const bulkPutJobs = async (jobs: ModelJob[]) => {
    await storage.bulkPut(jobs);
    await emit();
  };

  const submitAndResolveCancellation = async (id: string) => {
    try {
      await submitJob(id, storage, putJob, options.executor, providerQueue, now, submittingJobs, shouldProcessJob, cancellationRequests);
    } finally {
      if (cancellationRequests.has(id)) {
        const latest = await storage.get(id);
        cancellationRequests.delete(id);
        if (latest?.status === 'running') await store.cancelQueuedJob(id);
      }
    }
  };

  const runOnce = async (optionsForRun: { poll: 'once' | 'until-terminal'; submitQueued: boolean }) => {
    await ackPendingTerminalJobs(storage, putJob, options.executor, now);

    if (optionsForRun.submitQueued) {
      const queued = (await storage.list()).filter((job) => job.status === 'queued' && shouldProcessJob(job));
      await runLimited(queued, queued.length, async (job) => {
        await submitAndResolveCancellation(job.id);
      });
    }

    const running = (await storage.list()).filter((job) => job.status === 'running' && shouldProcessJob(job));
    await runLimited(running, running.length, async (job) => {
      await pollJob(job.id, storage, putJob, options, providerQueue, resultDecodeQueue, resultCommitQueue, now, pollingJobs, materializingJobs, pollRetryStates, pollIntervalMs);
    });
  };

  const runUntilTerminal = async () => {
    stopped = false;
    while (!stopped) {
      await runOnce({ poll: 'once', submitQueued: true });
      if (stopped) return;
      const jobs = await storage.list();
      if (!jobs.some((job) => shouldProcessJob(job)
        && (job.status === 'queued' || job.status === 'submitting' || job.status === 'running'))) return;
      await delay(pollIntervalMs);
    }
  };

  const coalescedRun = (): Promise<void> => {
    if (activeRun) {
      // A new job may arrive after the current run's final queue read. Keep
      // that wakeup until the active promise settles instead of returning it.
      runRequestedWhileActive = true;
      return activeRun;
    }
    runRequestedWhileActive = false;
    activeRun = runUntilTerminal().then(
      () => {
        const shouldRunAgain = runRequestedWhileActive;
        activeRun = null;
        return shouldRunAgain ? coalescedRun() : undefined;
      },
      (error: unknown) => {
        const shouldRunAgain = runRequestedWhileActive;
        activeRun = null;
        // A transient queue read must not discard a later explicit wakeup.
        // One replay is enough; a persistent storage failure still rejects.
        if (shouldRunAgain) return coalescedRun();
        throw error;
      },
    );
    return activeRun;
  };

  store = {
    enqueueConfirmedJobs: async (input) => {
      if (!input.confirmedAt) throw new Error('confirmedAt is required before enqueueing model jobs');
      assertPublicModelJobPayload(input);
      const jobs = input.requests.map((request, queueIndex) => createConfirmedModelJob({
        ...request,
        confirmedAt: input.confirmedAt,
        conversationId: input.conversationId,
        projectId: input.projectId,
        projectSessionId: input.projectSessionId,
        createdAt: now(),
        queueIndex,
      }));
      await bulkPutJobs(jobs);
      return jobs.map(cloneRequiredJob);
    },
    recover: async (recoveryOptions) => {
      const jobs = await storage.list();
      const shouldPreserve = (job: ModelJob) => {
        if (!isJobInScope(job)) {
          return job.projectId !== undefined || recoveryOptions?.preserveOutOfScopeJobs === true;
        }
        return shouldProcessJob(job)
          && recoveryOptions?.resumeOwnedJobs === true
          && (job.status === 'queued' || (job.status === 'submitting' && submittingJobs.has(job.id)));
      };
      await Promise.all(jobs.map(async (job) => {
        if (job.status !== 'queued' && job.status !== 'submitting' && job.status !== 'running') return;
        // The queue is shared by every canvas. Leave another project's active
        // record untouched so opening this project neither cancels paid work
        // nor keeps polling a result that cannot be committed here.
        if (shouldPreserve(job)) return;
        if (job.status === 'running'
          && options.canRecoverRunningJob !== undefined
          && (isRecoverableRunningJobFresh(job, now())
            || (job.providerTaskId !== undefined && isPotentiallyPaidProviderJob(job)))) {
          if (await options.canRecoverRunningJob(job)) return;
        }
        // Recovery may wait for provider ownership while workers advance. Only
        // migrate the same active run, using its latest data; never bulk-write
        // unchanged snapshots over concurrent progress or terminal results.
        const latest = await storage.get(job.id);
        if (!isSameJobRun(latest, job) || latest.status !== job.status || shouldPreserve(latest)) return;
        const uncertainExternalSubmission = isPotentiallyPaidProviderJob(latest)
          && (latest.status === 'submitting' || latest.providerTaskId !== undefined);
        await putJob(transitionModelJob(latest, 'cancelled', {
          completedAt: now(),
          updatedAt: now(),
          error: uncertainExternalSubmission ? UNCERTAIN_EXTERNAL_SUBMISSION_ERROR : undefined,
        }));
      }));
      await repairCompletedCanvasResults(await storage.list(), options);
      await ackPendingTerminalJobs(storage, putJob, options.executor, now);
    },
    run: () => coalescedRun(),
    stop: () => {
      stopped = true;
      runRequestedWhileActive = false;
    },
    processQueue: async () => {
      if (activeRun) return activeRun;
      const queued = (await storage.list()).filter((job) => job.status === 'queued' && shouldProcessJob(job));
      await runLimited(queued, queued.length, async (job) => {
        await submitAndResolveCancellation(job.id);
      });
    },
    pollActiveJobs: async () => {
      if (activeRun) return activeRun;
      const running = (await storage.list()).filter((job) => job.status === 'running' && shouldProcessJob(job));
      await runLimited(running, running.length, async (job) => {
        await pollJob(job.id, storage, putJob, options, providerQueue, resultDecodeQueue, resultCommitQueue, now, pollingJobs, materializingJobs, pollRetryStates, pollIntervalMs);
      });
    },
    retryJob: (id, overrides) => {
      const existing = retryingJobs.get(id);
      if (existing !== undefined) return existing;
      const operation = (async () => {
        const job = await requireJob(storage, id);
        const rejectedLayerResult = job.status === 'completed'
          && (overrides?.projectId === undefined || overrides.projectId === job.projectId)
          && isRejectedLayerResult(options.getProject?.(), job, overrides?.rejectedLayerResultAssetId);
        if (job.status !== 'failed' && job.status !== 'cancelled' && !rejectedLayerResult) {
          throw new Error(`model job cannot be retried from ${job.status}`);
        }
        if (isUncertainExternalSubmission(job)) {
          throw new Error(UNCERTAIN_EXTERNAL_SUBMISSION_ERROR);
        }
        const timestamp = now();
        const retry = createConfirmedModelJob({
          id: overrides?.id ?? createModelJobRunId(),
          kind: job.kind,
          confirmedAt: timestamp,
          conversationId: requireRetryField(job.conversationId, 'conversationId'),
          projectId: overrides?.projectId ?? job.projectId,
          projectSessionId: overrides?.projectSessionId ?? job.projectSessionId,
          createdAt: timestamp,
          displayName: requireRetryField(job.displayName, 'displayName'),
          modelId: job.modelId,
          modelRoute: requireRetryField(job.modelRoute, 'modelRoute'),
          prompt: job.prompt,
          promptNodeId: job.promptNodeId,
          provider: requireProviderField(job.provider),
          queueIndex: job.queueIndex,
          referenceAssetIds: [...job.referenceAssetIds],
          referenceSnapshotFingerprint: job.referenceSnapshotFingerprint,
          referenceSnapshotRevision: job.referenceSnapshotRevision,
          aspectRatio: job.aspectRatio,
          resolution: job.resolution,
          imageQuality: job.imageQuality,
          imageOutputFormat: job.imageOutputFormat,
          imageBackground: job.imageBackground,
          videoResolution: job.videoResolution,
          durationSeconds: job.durationSeconds,
          audioEnabled: job.audioEnabled,
          outputCount: job.outputCount as 1 | 2 | 3 | 4 | undefined,
          layeringGroupId: job.layeringGroupId,
          layeringLayerId: job.layeringLayerId,
          ...(job.layeringOutputContract === undefined ? {} : {
            layeringOutputContract: job.layeringOutputContract,
            layeringConfirmationDigest: job.layeringConfirmationDigest,
          }),
        });
        const retryRecord = { ...retry, retryCount: job.retryCount + 1 };
        await bulkPutJobs([
          { ...job, error: job.error === undefined ? undefined : sanitizeModelJobError(job.error) },
          retryRecord,
        ]);
        return cloneRequiredJob(retryRecord);
      })().finally(() => { retryingJobs.delete(id); });
      retryingJobs.set(id, operation);
      return operation;
    },
    cancelQueuedJob: async (id) => {
      cancellationRequests.add(id);
      const job = await requireJob(storage, id);
      if (job.status === 'queued') {
        await putJob(transitionModelJob(job, 'cancelled', { updatedAt: now() }));
        if (!submittingJobs.has(id)) cancellationRequests.delete(id);
        return;
      }
      if ((job.status === 'submitting' || job.status === 'running') && options.executor.cancel) {
        // A submission has no provider handle yet. The provider may accept it
        // before submit() returns, so a local cancellation cannot be terminal.
        if (job.status === 'submitting' && job.providerTaskId === undefined) return;
        cancellationRequests.delete(id);
        try {
          const cancelResult = await waitForCancellation(options.executor.cancel(job), DEFAULT_CANCEL_TIMEOUT_MS);
          const latest = await storage.get(id);
          if (latest && (latest.status === 'submitting' || latest.status === 'running')) {
            if (cancelResult?.status === 'completed' && latest.status === 'running') {
              await materializeResult(latest, cancelResult.result, options, storage, putJob, resultDecodeQueue, resultCommitQueue, now, materializingJobs);
              return;
            }
            if (cancelResult?.status === 'failed') {
              await putTerminalJob(storage, putJob, options.executor, latest, 'failed', {
                error: sanitizeModelJobError(cancelResult.error),
                updatedAt: now(),
              }, now);
              return;
            }
            if (cancelResult?.status === 'cancelled') {
              await putTerminalJob(storage, putJob, options.executor, latest, 'cancelled', { updatedAt: now() }, now);
            }
          }
        } catch (error) {
          const latest = await storage.get(id);
          if (latest) {
            const errorPatch = { error: sanitizeModelJobError(error), updatedAt: now() };
            if (isPotentiallyPaidProviderJob(latest)
              && (latest.status === 'running' || latest.status === 'submitting')) {
              await putJob({ ...latest, ...errorPatch });
            } else if (latest.status === 'running' || latest.status === 'submitting') {
              await putJob(transitionModelJob(latest, 'failed', errorPatch));
            } else {
              await putJob({ ...latest, ...errorPatch });
            }
          }
        }
        return;
      }
      cancellationRequests.delete(id);
      throw new Error(`model job cannot be cancelled from ${job.status}`);
    },
    listJobs: async () => storage.list(),
    subscribe: (listener) => {
      listeners.add(listener);
      void storage.list().then((jobs) => listener(jobs.map(cloneRequiredJob)));
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return store;
}

function requireProviderField(value: ModelJobProvider | undefined): ModelJobProvider {
  if (value !== 'comfly' && value !== 'relayme' && value !== 'julun' && value !== '4dai') {
    throw new Error('provider is required to create a new model job run');
  }
  return value;
}

function waitForCancellation(
  operation: Promise<ModelJobPollResult | void>,
  timeoutMs: number,
): Promise<ModelJobPollResult | void> {
  return new Promise((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => resolve(undefined), timeoutMs);
    operation.then(
      (result) => {
        globalThis.clearTimeout(timeoutId);
        resolve(result);
      },
      (error) => {
        globalThis.clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

function waitForTerminalAcknowledgement(operation: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => reject(new Error('Provider terminal acknowledgement timed out')), timeoutMs);
    operation.then(
      () => {
        globalThis.clearTimeout(timeoutId);
        resolve();
      },
      (error) => {
        globalThis.clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

function requireRetryField(value: string | undefined, fieldName: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${fieldName} is required to create a new model job run`);
  }
  return value;
}

async function submitJob(
  id: string,
  storage: ModelJobStorage,
  putJob: (job: ModelJob) => Promise<void>,
  executor: ModelJobExecutor,
  providerQueue: AsyncQueue,
  now: () => string,
  submittingJobs: Set<string>,
  shouldProcessJob: (job: ModelJob) => boolean,
  cancellationRequests: Set<string>,
): Promise<void> {
  if (submittingJobs.has(id)) return;
  submittingJobs.add(id);
  try {
    const queued = await storage.get(id);
    if (!queued || queued.status !== 'queued' || !shouldProcessJob(queued)) return;
    const submitting = transitionModelJob(queued, 'submitting', { updatedAt: now(), error: undefined });
    await putJob(submitting);
    let submitted: ModelJobSubmission | undefined;
    let providerCalled = false;
    try {
      submitted = await providerQueue.run(async () => {
        const latest = await storage.get(id);
        if (!isSameJobRun(latest, submitting) || latest.status !== 'submitting') return;
        if (!shouldProcessJob(latest)) {
          // This worker has not called the provider. Restore a validated queue
          // record so returning to its project can submit it exactly once.
          await putJob(modelJobSchema.parse({ ...latest, status: 'queued', updatedAt: now() }));
          return;
        }
        if (cancellationRequests.delete(id)) {
          await putJob(transitionModelJob(latest, 'cancelled', { updatedAt: now() }));
          return;
        }
        providerCalled = true;
        return executor.submit(latest);
      });
      if (submitted === undefined && !providerCalled) return;
      if (submitted === undefined || typeof submitted.providerTaskId !== 'string' || submitted.providerTaskId.trim().length === 0) {
        submitted = undefined;
        throw new Error('Provider submission acknowledgement did not contain a task id');
      }
      const latest = await storage.get(id);
      if (!latest || latest.status !== 'submitting' || latest.retryCount !== submitting.retryCount) return;
      await putJob(transitionModelJob(latest, 'running', {
        providerTaskId: submitted.providerTaskId,
        startedAt: latest.startedAt ?? now(),
        updatedAt: now(),
      }));
    } catch (error) {
      const latest = await storage.get(id);
      if (!latest || latest.status !== 'submitting' || latest.retryCount !== submitting.retryCount) return;
      if (submitted !== undefined) {
        // The provider already accepted this job. Persist its handle even if
        // the first local write failed; never turn it into a fresh paid run.
        const running = transitionModelJob(latest, 'running', {
          providerTaskId: submitted.providerTaskId,
          startedAt: latest.startedAt ?? now(),
          updatedAt: now(),
        });
        try {
          await putJob(running);
          return;
        } catch (writeError) {
          const afterWrite = await storage.get(id);
          if (afterWrite?.status === 'running' && afterWrite.providerTaskId === submitted.providerTaskId) return;
          if (!afterWrite || afterWrite.status !== 'submitting') throw writeError;
          await putJob(transitionModelJob(afterWrite, 'failed', {
            providerTaskId: submitted.providerTaskId,
            error: `${UNCERTAIN_EXTERNAL_SUBMISSION_ERROR} ${sanitizeModelJobError(writeError)}`,
            updatedAt: now(),
          }));
          return;
        }
      }
      await putJob(transitionModelJob(latest, 'failed', {
        error: isPotentiallyPaidProviderJob(latest)
          ? `${UNCERTAIN_EXTERNAL_SUBMISSION_ERROR} ${sanitizeModelJobError(error)}`
          : sanitizeModelJobError(error),
        updatedAt: now(),
      }));
    }
  } finally {
    submittingJobs.delete(id);
  }
}

async function pollJob(
  id: string,
  storage: ModelJobStorage,
  putJob: (job: ModelJob) => Promise<void>,
  options: ModelJobStoreOptions,
  providerQueue: AsyncQueue,
  resultDecodeQueue: AsyncQueue,
  resultCommitQueue: AsyncQueue,
  now: () => string,
  pollingJobs: Set<string>,
  materializingJobs: Set<string>,
  pollRetryStates: Map<string, { failures: number; nextPollAt: number }>,
  pollIntervalMs: number,
): Promise<void> {
  if (pollingJobs.has(id)) return;
  pollingJobs.add(id);
  try {
    const job = await storage.get(id);
    if (!job || job.status !== 'running' || options.shouldProcessJob?.(job) === false) return;
    const retryState = pollRetryStates.get(id);
    if (retryState !== undefined && Date.parse(now()) < retryState.nextPollAt) return;
    let result: ModelJobPollResult | undefined;
    try {
      result = await providerQueue.run(async () => {
        const latest = await storage.get(id);
        if (!isSameRunningJob(latest, job) || options.shouldProcessJob?.(latest) === false) return;
        return options.executor.poll(latest);
      });
    } catch (error) {
      const latest = await storage.get(id);
      if (!isSameRunningJob(latest, job)) return;
      if (isRetryableProviderPollError(error)) {
        const timestamp = now();
        if (pollIntervalMs > 0) {
          const failures = (retryState?.failures ?? 0) + 1;
          pollRetryStates.set(id, {
            failures,
            nextPollAt: Date.parse(timestamp) + Math.min(30_000, 1_000 * 2 ** Math.min(failures - 1, 5)),
          });
        }
        await putJob({ ...latest, error: sanitizeModelJobError(error), updatedAt: timestamp });
        return;
      }
      pollRetryStates.delete(id);
      await putJob(transitionModelJob(latest, 'failed', {
        error: isPotentiallyPaidProviderJob(latest) && latest.providerTaskId !== undefined
          ? `${UNCERTAIN_EXTERNAL_SUBMISSION_ERROR} ${sanitizeModelJobError(error)}`
          : sanitizeModelJobError(error),
        updatedAt: now(),
      }));
      return;
    }
    if (result === undefined) return;
    pollRetryStates.delete(id);
    try {
      const latest = await storage.get(id);
      if (!isSameRunningJob(latest, job)) return;
      if (result.status === 'running') {
        const { error: _staleError, ...recoverable } = latest;
        await putJob({ ...recoverable, progress: result.progress, updatedAt: now() });
        return;
      }
      if (result.status === 'failed') {
        await putTerminalJob(storage, putJob, options.executor, latest, 'failed', {
          error: sanitizeModelJobError(result.error),
          updatedAt: now(),
        }, now);
        return;
      }
      if (result.status === 'cancelled') {
        await putTerminalJob(storage, putJob, options.executor, latest, 'cancelled', {
          updatedAt: now(),
        }, now);
        return;
      }
      await materializeResult(latest, result.result, options, storage, putJob, resultDecodeQueue, resultCommitQueue, now, materializingJobs);
    } catch (error) {
      const latest = await storage.get(id);
      if (!isSameRunningJob(latest, job)) return;
      if (isPotentiallyPaidProviderJob(latest) && latest.providerTaskId !== undefined
        && isRetryableLocalResultError(error)) {
        await putJob({ ...latest, error: sanitizeModelJobError(error), updatedAt: now() });
      } else {
        await putJob(transitionModelJob(latest, 'failed', {
          error: isPotentiallyPaidProviderJob(latest) && latest.providerTaskId !== undefined
            ? `${UNCERTAIN_EXTERNAL_SUBMISSION_ERROR} ${sanitizeModelJobError(error)}`
            : sanitizeModelJobError(error),
          updatedAt: now(),
        }));
      }
    }
  } finally {
    pollingJobs.delete(id);
  }
}

function isRetryableProviderPollError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
    && 'message' in error
    && typeof error.message === 'string'
    && 'retryable' in error
    && error.retryable === true;
}

function isRetryableLocalResultError(error: unknown): boolean {
  if (isRetryableProviderPollError(error)) return true;
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && [
    'SAVE_TIMEOUT', 'PROJECT_SAVE_CONFLICT', 'PROJECT_SAVE_RETRY_REQUIRED',
    'DURABLE_WRITE_FAILED', 'PROJECT_WRITE_FAILED', 'PERMISSION_DENIED',
    'EAGAIN', 'EBUSY', 'ETIMEDOUT',
  ].includes(code);
}

async function materializeResult(
  job: ModelJob,
  result: ModelJobResult,
  options: ModelJobStoreOptions,
  storage: ModelJobStorage,
  putJob: (job: ModelJob) => Promise<void>,
  resultDecodeQueue: AsyncQueue,
  resultCommitQueue: AsyncQueue,
  now: () => string,
  materializingJobs: Set<string>,
): Promise<void> {
  if (materializingJobs.has(job.id)) return;
  materializingJobs.add(job.id);
  try {
    const existingBeforeDecode = findExistingResult(options.getProject?.(), job, result);
    if (existingBeforeDecode) {
      await completeFromExistingResult(job, result, existingBeforeDecode, storage, putJob, options, now);
      return;
    }
    const beforeDecode = await storage.get(job.id);
    if (!isSameRunningJob(beforeDecode, job)) return;
    await resultDecodeQueue.run(async () => {
      await result.decode?.();
    });
    await resultCommitQueue.run(async () => {
      const latest = await storage.get(job.id);
      if (!isSameRunningJob(latest, job)) return;
      const existingAfterDecode = findExistingResult(options.getProject?.(), latest, result);
      if (existingAfterDecode) {
        await completeFromExistingResult(latest, result, existingAfterDecode, storage, putJob, options, now);
        return;
      }
      const build = createResultMaterializationBuild(latest, result);
      const isOwnerRunning = async () => isSameRunningJob(await storage.get(latest.id), latest);
      const commit = await options.commitProjectTransaction(build, latest, isOwnerRunning);
      const afterCommit = await storage.get(job.id);
      if (!isSameRunningJob(afterCommit, latest)) return;
      if (!commit.committed) return;
      if (options.getProject !== undefined && findExistingResult(options.getProject(), latest, result) === undefined) return;
      await putTerminalJob(storage, putJob, options.executor, afterCommit, 'completed', {
        completedAt: now(),
        progress: 1,
        resultAssetId: result.assetId,
        resultAssetIds: resultAssetIds(result),
        resultNodeId: commit.resultNodeId,
        updatedAt: now(),
      }, now);
    });
  } finally {
    materializingJobs.delete(job.id);
  }
}

async function repairCompletedCanvasResults(
  jobs: readonly ModelJob[],
  options: ModelJobStoreOptions,
): Promise<void> {
  for (const job of jobs) {
    if (job.status !== 'completed' || job.resultAssetId === undefined) continue;
    if (options.shouldRepairCompletedProjectTransaction !== undefined
      && !await options.shouldRepairCompletedProjectTransaction(job)) continue;
    const result = {
      assetId: job.resultAssetId,
      ...(job.resultAssetIds === undefined ? {} : { assetIds: job.resultAssetIds }),
    };
    if (findExistingResult(options.getProject?.(), job, result)) continue;
    const build = createResultMaterializationBuild(job, result);
    const formalSource = findFormalGenerationSourceNode(options.getProject?.(), job.promptNodeId, job.kind);
    if (formalSource !== undefined && options.repairCompletedProjectTransaction !== undefined) {
      await options.repairCompletedProjectTransaction(build, job);
      continue;
    }
    await options.commitProjectTransaction(build, job, async () => true);
  }
}

function createResultMaterializationBuild(
  job: ModelJob,
  result: ModelJobResult,
): BuildResultMaterialization {
  return (project) => createResultMaterialization(job, result, project);
}

function createResultMaterialization(
  job: ModelJob,
  result: ModelJobResult,
  project: CanvasProject | undefined,
): ResultMaterialization {
  if (job.layeringGroupId !== undefined && job.layeringLayerId !== undefined) {
    const layerNode = project?.nodes.find((candidate): candidate is Extract<CanvasNode, { type: 'module' }> => candidate.type === 'module'
      && candidate.id === job.promptNodeId && candidate.data.moduleType === 'image_layer'
      && candidate.data.config.groupId === job.layeringGroupId
      && candidate.data.config.layerId === job.layeringLayerId
      && candidate.data.config.jobId === job.id);
    if (layerNode === undefined) throw new Error('The owned image layer for this task is no longer available.');
    // A provider result is always a fresh, unvalidated candidate.  Keep the
    // confirmed request binding beside it, while removing every local proof
    // that belonged to a previous asset/refinement.  In particular, a v2
    // independent-RGBA declaration must never become foreground merely by
    // returning from the provider or by repeating a prompt.
    const {
      qualityReason: _oldQualityReason,
      qualityValidationVersion: _oldQualityValidationVersion,
      foregroundProvenance: _oldForegroundProvenance,
      foregroundValidation: _oldForegroundValidation,
      preparedRgb: _oldPreparedRgb,
      layerPrepared: _oldLayerPrepared,
      resultRepresentation: _oldResultRepresentation,
      assemblyConfirmationDigest: _oldAssemblyConfirmationDigest,
      semanticReviewAccepted: _oldSemanticReviewAccepted,
      semanticReviewDigest: _oldSemanticReviewDigest,
      formatQualityStatus: _oldFormatQualityStatus,
      qualityFormatCheckedAssetId: _oldQualityFormatCheckedAssetId,
      ...candidateConfig
    } = layerNode.data.config;
    const expectedRepresentation = job.layeringOutputContract === 'source-independent-rgba-v2'
      ? 'independent-rgba-candidate' as const
      : job.layeringOutputContract === 'opaque-background-v2'
        ? 'opaque-background-candidate' as const
        : job.layeringOutputContract === 'source-alpha-matte-v1'
          ? 'alpha-matte' as const
          : undefined;
    const resultRepresentation = job.layeringOutputContract === undefined
      ? normalizeLayeringResultRepresentation(result.resultRepresentation)
      : expectedRepresentation;
    const nextNode: CanvasNode = {
      ...layerNode,
      data: {
        ...layerNode.data,
        config: {
          ...candidateConfig,
          resultAssetId: result.assetId,
          ...(result.width === undefined ? {} : { resultWidth: result.width }),
          ...(result.height === undefined ? {} : { resultHeight: result.height }),
          resultJobId: job.id,
          ...(resultRepresentation === undefined ? {} : { resultRepresentation }),
          ...(job.layeringOutputContract === undefined ? {} : {
            layeringOutputContract: job.layeringOutputContract,
            layeringConfirmationDigest: job.layeringConfirmationDigest,
          }),
          pixelColorSpace: null,
          refinedFromAssetId: null,
          mattingRegions: [],
          qualityReason: null,
          qualityValidationVersion: null,
          qualityStatus: 'pending',
          status: 'validating',
          needsReconfirm: true,
        },
        execution: { ...layerNode.data.execution, state: 'running' },
      },
    };
    const groupNode = project?.nodes.find((candidate): candidate is Extract<CanvasNode, { type: 'module' }> => candidate.type === 'module'
      && candidate.data.moduleType === 'image_layering' && candidate.data.config.groupId === job.layeringGroupId);
    const operations: ProjectTransaction['operations'][number][] = [{ kind: 'canvas', operation: { kind: 'update_node', node: nextNode } }];
    if (groupNode) {
      const { assemblyConfirmationDigest: _oldGroupAssembly, semanticReviewAccepted: _oldGroupReview, semanticReviewDigest: _oldGroupDigest,
        ...groupConfig } = groupNode.data.config;
      operations.push({ kind: 'canvas', operation: { kind: 'update_node', node: { ...groupNode, data: { ...groupNode.data, config: {
        ...groupConfig, needsReconfirm: true, status: 'validating', resultState: 'needs_review',
      } } } } });
      for (const sibling of project?.nodes ?? []) {
        if (sibling.type !== 'module' || sibling.id === layerNode.id || sibling.data.moduleType !== 'image_layer'
          || sibling.data.config.groupId !== job.layeringGroupId) continue;
        operations.push({ kind: 'canvas', operation: { kind: 'update_node', node: {
          ...sibling, data: { ...sibling.data, config: invalidateLayeringProof(sibling.data.config) },
        } } });
      }
    }
    return {
      resultNodeId: layerNode.id,
      transaction: {
        id: `model-job-layer-result-${job.id}`,
        label: `保存图片图层结果 ${job.layeringLayerId}`,
        operations,
      },
    };
  }
  const isVideo = job.kind === 'video';
  const sourceNode = findFormalGenerationSourceNode(project, job.promptNodeId, job.kind);
  if (sourceNode !== undefined) {
    const previousConfig = sourceNode.data.config;
    const pendingResultJobIds = readPendingResultJobIds(previousConfig)
      .filter((jobId) => jobId !== job.id);
    const nextConfig = isVideo
      ? {
        ...previousConfig,
        videoResults: [
          ...readStoredVideoResults(previousConfig.videoResults).filter((item) => item.assetId !== result.assetId),
          {
            assetId: result.assetId,
            durationMs: Math.max(1, Math.round((result.durationSeconds ?? job.durationSeconds ?? 0.001) * 1000)),
            mediaType: 'video/mp4',
          },
        ].slice(-4),
        resultState: 'fresh',
        lastResultJobId: job.id,
        pendingResultJobIds,
      }
      : {
        ...previousConfig,
        resultAssetIds: [
          ...readStoredImageResultAssetIds(previousConfig.resultAssetIds, previousConfig.outputCount === 9 ? 9 : 4).filter((assetId) => !resultAssetIds(result).includes(assetId)),
          ...resultAssetIds(result),
        ].slice(previousConfig.outputCount === 9 ? -9 : -4),
        resultState: 'fresh',
        ...(typeof result.width === 'number' && Number.isFinite(result.width) && result.width > 0
          ? { resultWidth: result.width }
          : {}),
        ...(typeof result.height === 'number' && Number.isFinite(result.height) && result.height > 0
          ? { resultHeight: result.height }
          : {}),
        lastResultJobId: job.id,
        pendingResultJobIds,
      };
    const nextNode: CanvasNode = {
      ...sourceNode,
      data: {
        ...sourceNode.data,
        config: nextConfig,
        execution: { ...sourceNode.data.execution, state: 'completed' },
      },
    };
    return {
      resultNodeId: sourceNode.id,
      transaction: {
        id: `model-job-inline-result-${job.id}`,
        label: `Store ${isVideo ? 'video' : 'image'} generation result inline`,
        operations: [{ kind: 'canvas', operation: { kind: 'update_node', node: nextNode } }],
      },
    };
  }
  const resultNodeId = job.resultNodeId ?? `${isVideo ? 'video' : 'image'}-result-${job.id}`;
  const promptNode = project?.nodes.find((candidate) => candidate.id === job.promptNodeId);
  const node: CanvasNode = {
    id: resultNodeId,
    type: isVideo ? 'video_result' : 'image_result',
    position: resolveResultPosition(project, job.promptNodeId),
    data: {
      assetId: result.assetId,
      modelId: job.modelId,
      providerTaskId: job.providerTaskId,
      parentNodeIds: [job.promptNodeId],
      provider: job.provider,
      modelRoute: job.modelRoute,
      displayName: job.displayName,
      promptNodeId: job.promptNodeId,
      referenceAssetIds: job.referenceAssetIds,
      jobId: job.id,
      width: result.width,
      height: result.height,
      ...(isVideo && result.durationSeconds !== undefined ? { durationSeconds: result.durationSeconds } : {}),
    },
  };
  return {
    resultNodeId,
    transaction: {
      id: `model-job-result-${job.id}`,
      label: `Materialize model result ${job.id}`,
      operations: [
        { kind: 'canvas', operation: { kind: 'create_node', node } },
        {
          kind: 'canvas',
          operation: {
            kind: 'create_edge',
            edge: {
              id: `edge-${job.promptNodeId}-${resultNodeId}`,
              source: job.promptNodeId,
              ...(promptNode?.type === 'module' ? { sourcePortId: 'result' } : {}),
              target: resultNodeId,
              ...(promptNode?.type === 'module' ? { order: 0 } : {}),
              label: 'model-result',
            },
          },
        },
      ],
    },
  };
}

function readPendingResultJobIds(config: Record<string, unknown>): string[] {
  return Array.isArray(config.pendingResultJobIds)
    ? [...new Set(config.pendingResultJobIds.filter((value): value is string => typeof value === 'string' && value.length > 0))]
    : [];
}

function resultAssetIds(result: ModelJobResult): string[] {
  return [...new Set([result.assetId, ...(result.assetIds ?? [])])];
}

function normalizeLayeringResultRepresentation(value: unknown): ModelJobResult['resultRepresentation'] {
  return value === 'alpha-matte' || value === 'independent-rgba-candidate' || value === 'opaque-background-candidate'
    ? value
    : undefined;
}

async function putTerminalJob(
  storage: ModelJobStorage,
  putJob: (job: ModelJob) => Promise<void>,
  executor: ModelJobExecutor,
  job: ModelJob,
  status: 'completed' | 'failed' | 'cancelled',
  patch: Partial<ModelJob>,
  now: () => string,
): Promise<void> {
  const shouldAckProviderTerminal = Boolean(executor.ackTerminal && job.providerTaskId);
  const terminal = transitionModelJob(status === 'completed' ? { ...job, error: undefined } : job, status, {
    ...patch,
    providerAckPending: shouldAckProviderTerminal,
    terminalStatus: shouldAckProviderTerminal ? status : undefined,
  });
  await putJob(terminal);
  await acknowledgeTerminal(storage, putJob, executor, terminal, now);
}

async function ackPendingTerminalJobs(
  storage: ModelJobStorage,
  putJob: (job: ModelJob) => Promise<void>,
  executor: ModelJobExecutor,
  now: () => string,
): Promise<void> {
  const jobs = await storage.list();
  const pending = jobs.filter((job) => (
    isTerminalJob(job)
    && job.providerAckPending === true
    && job.terminalStatus === job.status
  ));
  await runLimited(pending, pending.length, async (job) => {
    await acknowledgeTerminal(storage, putJob, executor, job, now);
  });
}

async function acknowledgeTerminal(
  storage: ModelJobStorage,
  putJob: (job: ModelJob) => Promise<void>,
  executor: ModelJobExecutor,
  job: ModelJob,
  now: () => string,
): Promise<void> {
  if (!isTerminalJob(job)) {
    return;
  }
  if (!executor.ackTerminal || !job.providerTaskId) {
    if (job.providerAckPending !== true && job.terminalStatus === undefined) return;
    const latest = await storage.get(job.id);
    if (!isSameTerminalJob(latest, job)) return;
    await putJob({
      ...latest,
      providerAckPending: false,
      terminalStatus: undefined,
      updatedAt: now(),
    });
    return;
  }
  try {
    await waitForTerminalAcknowledgement(executor.ackTerminal(job), DEFAULT_TERMINAL_ACK_TIMEOUT_MS);
    const latest = await storage.get(job.id);
    if (!isSameTerminalJob(latest, job)) return;
    await putJob({
      ...latest,
      providerAckPending: false,
      terminalStatus: undefined,
      updatedAt: now(),
    });
  } catch {
    const latest = await storage.get(job.id);
    if (!isSameTerminalJob(latest, job)) return;
    await putJob({
      ...latest,
      providerAckPending: true,
      terminalStatus: job.status,
      updatedAt: now(),
    });
  }
}

class AsyncQueue {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly concurrency: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
      return;
    }
    this.active -= 1;
  }
}

async function runLimited<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(workers);
}

function isSameJobRun(candidate: ModelJob | undefined, expected: ModelJob): candidate is ModelJob {
  return candidate !== undefined
    && candidate.id === expected.id
    && candidate.retryCount === expected.retryCount
    && candidate.providerTaskId === expected.providerTaskId
    && candidate.confirmedAt === expected.confirmedAt
    && candidate.createdAt === expected.createdAt
    && candidate.projectId === expected.projectId
    && candidate.projectSessionId === expected.projectSessionId
    && candidate.layeringGroupId === expected.layeringGroupId
    && candidate.layeringLayerId === expected.layeringLayerId
    && candidate.layeringOutputContract === expected.layeringOutputContract
    && candidate.layeringConfirmationDigest === expected.layeringConfirmationDigest;
}

function isSameRunningJob(candidate: ModelJob | undefined, expected: ModelJob): candidate is ModelJob {
  return isSameJobRun(candidate, expected) && candidate.status === 'running';
}

function isTerminalJob(job: ModelJob): job is ModelJob & { status: 'completed' | 'failed' | 'cancelled' } {
  return job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';
}

function isSameTerminalJob(candidate: ModelJob | undefined, expected: ModelJob): candidate is ModelJob {
  return candidate !== undefined
    && isTerminalJob(candidate)
    && candidate.status === expected.status
    && candidate.retryCount === expected.retryCount
    && candidate.providerTaskId === expected.providerTaskId;
}

function findExistingResult(project: CanvasProject | undefined, job: ModelJob, result: ModelJobResult): CanvasNode | undefined {
  if (job.layeringGroupId !== undefined && job.layeringLayerId !== undefined) {
    return project?.nodes.find((candidate) => candidate.type === 'module'
      && candidate.id === job.promptNodeId && candidate.data.moduleType === 'image_layer'
      && candidate.data.config.groupId === job.layeringGroupId
      && candidate.data.config.layerId === job.layeringLayerId
      && candidate.data.config.jobId === job.id
      && candidate.data.config.resultJobId === job.id
      && (candidate.data.config.resultAssetId === result.assetId
        || (typeof candidate.data.config.resultAssetId === 'string'
          && candidate.data.config.pixelColorSpace === 'foreground'
          && candidate.data.config.maskSpace === 'source'
          && candidate.data.config.refinedFromAssetId === result.assetId)));
  }
  const sourceNode = findFormalGenerationSourceNode(project, job.promptNodeId, job.kind);
  if (sourceNode !== undefined) {
    const stored = job.kind === 'video'
      ? readStoredVideoResults(sourceNode.data.config.videoResults).some((item) => item.assetId === result.assetId)
      : resultAssetIds(result).every((assetId) => readStoredImageResultAssetIds(sourceNode.data.config.resultAssetIds, sourceNode.data.config.outputCount === 9 ? 9 : 4).includes(assetId));
    const settled = !readPendingResultJobIds(sourceNode.data.config).includes(job.id);
    return stored && settled ? sourceNode : undefined;
  }
  const expectedType = job.kind === 'video' ? 'video_result' : 'image_result';
  const defaultResultId = `${job.kind === 'video' ? 'video' : 'image'}-result-${job.id}`;
  return project?.nodes.find((node) => (
    node.type === expectedType
    && (node.id === (job.resultNodeId ?? defaultResultId) || node.data.jobId === job.id)
    && node.data.assetId === result.assetId
  ));
}

async function completeFromExistingResult(
  job: ModelJob,
  result: ModelJobResult,
  node: CanvasNode,
  storage: ModelJobStorage,
  putJob: (job: ModelJob) => Promise<void>,
  options: ModelJobStoreOptions,
  now: () => string,
): Promise<void> {
  const latest = await storage.get(job.id);
  if (!isSameRunningJob(latest, job)) return;
  const isOwnerRunning = async () => isSameRunningJob(await storage.get(latest.id), latest);
  if (options.canContinueResult !== undefined && !await options.canContinueResult(latest, isOwnerRunning)) return;
  await putTerminalJob(storage, putJob, options.executor, latest, 'completed', {
    completedAt: now(),
    progress: 1,
    resultAssetId: result.assetId,
    resultAssetIds: resultAssetIds(result),
    resultNodeId: node.id,
    updatedAt: now(),
  }, now);
}

function findFormalGenerationSourceNode(
  project: CanvasProject | undefined,
  promptNodeId: string,
  kind: ModelJobKind,
): Extract<CanvasNode, { type: 'module' }> | undefined {
  const source = project?.nodes.find((node) => node.id === promptNodeId);
  if (source?.type !== 'module') return undefined;
  if (kind === 'video') return source.data.moduleType === 'video_generation' ? source : undefined;
  return source.data.moduleType === 'image_generation' ? source : undefined;
}

function readStoredImageResultAssetIds(value: unknown, limit = 4): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((assetId): assetId is string => typeof assetId === 'string' && assetId.trim().length > 0))].slice(-limit);
}

function readStoredVideoResults(value: unknown): Array<{ assetId: string; durationMs: number; mediaType: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const record = candidate as Record<string, unknown>;
    return typeof record.assetId === 'string' && record.assetId.trim().length > 0
      ? [{
        assetId: record.assetId,
        durationMs: typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) && record.durationMs > 0 ? record.durationMs : 1,
        mediaType: typeof record.mediaType === 'string' && record.mediaType.startsWith('video/') ? record.mediaType : 'video/mp4',
      }]
      : [];
  }).slice(-4);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function requireJob(storage: ModelJobStorage, id: string): Promise<ModelJob> {
  const job = await storage.get(id);
  if (!job) throw new Error(`model job not found: ${id}`);
  return job;
}

function resolveResultPosition(project: CanvasProject | undefined, promptNodeId: string): { x: number; y: number } {
  const promptNode = project?.nodes.find((node) => node.id === promptNodeId);
  if (!promptNode) return { x: 0, y: 0 };
  return { x: promptNode.position.x + 320, y: promptNode.position.y + 40 };
}

function compareJobs(left: ModelJob, right: ModelJob): number {
  return (left.createdAt ?? left.confirmedAt ?? left.id).localeCompare(right.createdAt ?? right.confirmedAt ?? right.id)
    || (left.queueIndex ?? 0) - (right.queueIndex ?? 0)
    || left.id.localeCompare(right.id);
}

function cloneJob(job: ModelJob | undefined): ModelJob | undefined {
  return job ? cloneRequiredJob(job) : undefined;
}

function cloneRequiredJob(job: ModelJob): ModelJob {
  return {
    ...job,
    referenceAssetIds: [...job.referenceAssetIds],
  };
}
