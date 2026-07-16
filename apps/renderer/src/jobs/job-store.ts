import Dexie, { type Table } from 'dexie';
import type { CanvasNode, CanvasProject, ModelJob, ProjectTransaction } from '@agent-canvas/domain';
import {
  assertPublicModelJobPayload,
  createConfirmedModelJob,
  sanitizeModelJobError,
  transitionModelJob,
} from '@agent-canvas/domain';

const DEFAULT_POLL_CONCURRENCY = 4;
const DEFAULT_MATERIALIZE_CONCURRENCY = 2;

export interface ModelJobRequest {
  id: string;
  promptNodeId: string;
  prompt: string;
  provider: string;
  modelRoute: string;
  displayName: string;
  modelId: string;
  referenceAssetIds: string[];
}

export interface EnqueueConfirmedJobsInput {
  conversationId: string;
  confirmedAt?: string;
  requests: ModelJobRequest[];
}

export interface ModelJobSubmission {
  providerTaskId: string;
}

export interface ModelJobResult {
  assetId: string;
  width?: number;
  height?: number;
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

export interface ModelJobStoreOptions {
  storage?: ModelJobStorage;
  executor: ModelJobExecutor;
  commitProjectTransaction: (transaction: ProjectTransaction) => Promise<boolean>;
  getProject?: () => CanvasProject;
  pollConcurrency?: number;
  decodeConcurrency?: number;
  now?: () => string;
  pollIntervalMs?: number;
}

export interface ModelJobStore {
  enqueueConfirmedJobs(input: EnqueueConfirmedJobsInput): Promise<ModelJob[]>;
  recover(): Promise<void>;
  run(): Promise<void>;
  stop(): void;
  processQueue(): Promise<void>;
  pollActiveJobs(): Promise<void>;
  retryJob(id: string): Promise<void>;
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
  const submittingJobs = new Set<string>();
  const pollingJobs = new Set<string>();
  const materializingJobs = new Set<string>();
  let activeRun: Promise<void> | null = null;
  let stopped = false;

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

  const runOnce = async (optionsForRun: { poll: 'once' | 'until-terminal'; submitQueued: boolean }) => {
    await ackPendingTerminalJobs(storage, putJob, options.executor, now);

    if (optionsForRun.submitQueued) {
      const queued = (await storage.list()).filter((job) => job.status === 'queued');
      await runLimited(queued, queued.length, async (job) => {
        await submitJob(job.id, storage, putJob, options.executor, providerQueue, now, submittingJobs);
      });
    }

    const running = (await storage.list()).filter((job) => job.status === 'running');
    await runLimited(running, running.length, async (job) => {
      await pollJob(job.id, storage, putJob, options, providerQueue, resultDecodeQueue, now, pollingJobs, materializingJobs);
    });
  };

  const runUntilTerminal = async () => {
    stopped = false;
    while (!stopped) {
      await runOnce({ poll: 'once', submitQueued: true });
      if (stopped) return;
      const jobs = await storage.list();
      if (!jobs.some((job) => job.status === 'queued' || job.status === 'submitting' || job.status === 'running')) return;
      await delay(pollIntervalMs);
    }
  };

  const coalescedRun = () => {
    if (!activeRun) {
      activeRun = runUntilTerminal().finally(() => {
        activeRun = null;
      });
    }
    return activeRun;
  };

  return {
    enqueueConfirmedJobs: async (input) => {
      if (!input.confirmedAt) throw new Error('confirmedAt is required before enqueueing model jobs');
      assertPublicModelJobPayload(input);
      const jobs = input.requests.map((request, queueIndex) => createConfirmedModelJob({
        ...request,
        confirmedAt: input.confirmedAt,
        conversationId: input.conversationId,
        createdAt: now(),
        queueIndex,
      }));
      await bulkPutJobs(jobs);
      return jobs.map(cloneRequiredJob);
    },
    recover: async () => {
      const jobs = await storage.list();
      const recovered = jobs.map((job) => {
        if (job.status !== 'submitting') return job;
        return {
          ...job,
          status: 'queued' as const,
          updatedAt: now(),
          error: undefined,
        };
      });
      await bulkPutJobs(recovered);
      await ackPendingTerminalJobs(storage, putJob, options.executor, now);
      await coalescedRun();
    },
    run: () => coalescedRun(),
    stop: () => {
      stopped = true;
    },
    processQueue: async () => {
      if (activeRun) return activeRun;
      const queued = (await storage.list()).filter((job) => job.status === 'queued');
      await runLimited(queued, queued.length, async (job) => {
        await submitJob(job.id, storage, putJob, options.executor, providerQueue, now, submittingJobs);
      });
    },
    pollActiveJobs: async () => {
      if (activeRun) return activeRun;
      const running = (await storage.list()).filter((job) => job.status === 'running');
      await runLimited(running, running.length, async (job) => {
        await pollJob(job.id, storage, putJob, options, providerQueue, resultDecodeQueue, now, pollingJobs, materializingJobs);
      });
    },
    retryJob: async (id) => {
      const job = await requireJob(storage, id);
      if (job.status !== 'failed' && job.status !== 'cancelled') {
        throw new Error(`model job cannot be retried from ${job.status}`);
      }
      await putJob(transitionModelJob(job, 'queued', { updatedAt: now(), progress: undefined }));
    },
    cancelQueuedJob: async (id) => {
      const job = await requireJob(storage, id);
      if (job.status === 'queued') {
        await putJob(transitionModelJob(job, 'cancelled', { updatedAt: now() }));
        return;
      }
      if ((job.status === 'submitting' || job.status === 'running') && options.executor.cancel) {
        try {
          const cancelResult = await options.executor.cancel(job);
          const latest = await storage.get(id);
          if (latest && (latest.status === 'submitting' || latest.status === 'running')) {
            if (cancelResult?.status === 'completed' && latest.status === 'running') {
              await materializeResult(latest, cancelResult.result, options, storage, putJob, resultDecodeQueue, now, materializingJobs);
              return;
            }
            if (cancelResult?.status === 'failed') {
              await putTerminalJob(storage, putJob, options.executor, latest, 'failed', {
                error: sanitizeModelJobError(cancelResult.error),
                updatedAt: now(),
              }, now);
              return;
            }
            await putTerminalJob(storage, putJob, options.executor, latest, 'cancelled', { updatedAt: now() }, now);
          }
        } catch (error) {
          const latest = await storage.get(id);
          if (latest) {
            const errorPatch = { error: sanitizeModelJobError(error), updatedAt: now() };
            if (latest.status === 'running' || latest.status === 'submitting') {
              await putJob(transitionModelJob(latest, 'failed', errorPatch));
            } else {
              await putJob({ ...latest, ...errorPatch });
            }
          }
        }
        return;
      }
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
}

async function submitJob(
  id: string,
  storage: ModelJobStorage,
  putJob: (job: ModelJob) => Promise<void>,
  executor: ModelJobExecutor,
  providerQueue: AsyncQueue,
  now: () => string,
  submittingJobs: Set<string>,
): Promise<void> {
  if (submittingJobs.has(id)) return;
  submittingJobs.add(id);
  try {
    const queued = await storage.get(id);
    if (!queued || queued.status !== 'queued') return;
    const submitting = transitionModelJob(queued, 'submitting', { updatedAt: now(), error: undefined });
    await putJob(submitting);
    try {
      const submitted = await providerQueue.run(() => executor.submit(submitting));
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
      await putJob(transitionModelJob(latest, 'failed', {
        error: sanitizeModelJobError(error),
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
  now: () => string,
  pollingJobs: Set<string>,
  materializingJobs: Set<string>,
): Promise<void> {
  if (pollingJobs.has(id)) return;
  pollingJobs.add(id);
  try {
    const job = await storage.get(id);
    if (!job || job.status !== 'running') return;
    try {
      const result = await providerQueue.run(() => options.executor.poll(job));
      const latest = await storage.get(id);
      if (!isSameRunningJob(latest, job)) return;
      if (result.status === 'running') {
        await putJob({ ...latest, progress: result.progress, updatedAt: now() });
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
      await materializeResult(latest, result.result, options, storage, putJob, resultDecodeQueue, now, materializingJobs);
    } catch (error) {
      const latest = await storage.get(id);
      if (!isSameRunningJob(latest, job)) return;
      await putJob(transitionModelJob(latest, 'failed', {
        error: sanitizeModelJobError(error),
        updatedAt: now(),
      }));
    }
  } finally {
    pollingJobs.delete(id);
  }
}

async function materializeResult(
  job: ModelJob,
  result: ModelJobResult,
  options: ModelJobStoreOptions,
  storage: ModelJobStorage,
  putJob: (job: ModelJob) => Promise<void>,
  resultDecodeQueue: AsyncQueue,
  now: () => string,
  materializingJobs: Set<string>,
): Promise<void> {
  if (materializingJobs.has(job.id)) return;
  materializingJobs.add(job.id);
  try {
    const existingBeforeDecode = findExistingResult(options.getProject?.(), job, result);
    if (existingBeforeDecode) {
      await completeFromExistingResult(job, existingBeforeDecode, storage, putJob, options.executor, now);
      return;
    }
    const beforeDecode = await storage.get(job.id);
    if (!isSameRunningJob(beforeDecode, job)) return;
    await resultDecodeQueue.run(async () => {
      await result.decode?.();
    });
    const latest = await storage.get(job.id);
    if (!isSameRunningJob(latest, job)) return;
    const existingAfterDecode = findExistingResult(options.getProject?.(), latest, result);
    if (existingAfterDecode) {
      await completeFromExistingResult(latest, existingAfterDecode, storage, putJob, options.executor, now);
      return;
    }
    const resultNodeId = job.resultNodeId ?? `image-result-${job.id}`;
    const node: CanvasNode = {
      id: resultNodeId,
      type: 'image_result',
      position: resolveResultPosition(options.getProject?.(), job.promptNodeId),
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
      },
    };
    const transaction: ProjectTransaction = {
      id: `model-job-result-${job.id}`,
      label: `Materialize model result ${job.id}`,
      operations: [
        { kind: 'canvas', operation: { kind: 'create_node', node } },
        {
          kind: 'canvas',
          operation: {
            kind: 'create_edge',
            edge: { id: `edge-${job.promptNodeId}-${resultNodeId}`, source: job.promptNodeId, target: resultNodeId, label: 'model-result' },
          },
        },
      ],
    };
    const committed = await options.commitProjectTransaction(transaction);
    const afterCommit = await storage.get(job.id);
    if (!isSameRunningJob(afterCommit, latest)) return;
    if (!committed) return;
    await putTerminalJob(storage, putJob, options.executor, afterCommit, 'completed', {
      completedAt: now(),
      progress: 1,
      resultAssetId: result.assetId,
      resultNodeId,
      updatedAt: now(),
    }, now);
  } finally {
    materializingJobs.delete(job.id);
  }
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
  const terminal = transitionModelJob(job, status, {
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
    await executor.ackTerminal(job);
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

function isSameRunningJob(candidate: ModelJob | undefined, expected: ModelJob): candidate is ModelJob {
  return candidate !== undefined
    && candidate.status === 'running'
    && candidate.retryCount === expected.retryCount
    && candidate.providerTaskId === expected.providerTaskId;
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
  return project?.nodes.find((node) => (
    node.type === 'image_result'
    && (node.id === (job.resultNodeId ?? `image-result-${job.id}`) || node.data.jobId === job.id)
    && node.data.assetId === result.assetId
  ));
}

async function completeFromExistingResult(
  job: ModelJob,
  node: CanvasNode,
  storage: ModelJobStorage,
  putJob: (job: ModelJob) => Promise<void>,
  executor: ModelJobExecutor,
  now: () => string,
): Promise<void> {
  const latest = await storage.get(job.id);
  if (!isSameRunningJob(latest, job)) return;
  await putTerminalJob(storage, putJob, executor, latest, 'completed', {
    completedAt: now(),
    progress: 1,
    resultAssetId: node.type === 'image_result' ? node.data.assetId : undefined,
    resultNodeId: node.id,
    updatedAt: now(),
  }, now);
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
