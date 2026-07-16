import Dexie, { type Table } from 'dexie';
import type { CanvasNode, CanvasProject, ModelJob, ProjectTransaction } from '@agent-canvas/domain';
import {
  assertPublicModelJobPayload,
  createConfirmedModelJob,
  sanitizeModelJobError,
  transitionModelJob,
} from '@agent-canvas/domain';

const POLL_CONCURRENCY = 4;
const MATERIALIZE_CONCURRENCY = 2;

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
  | { status: 'running'; progress?: number }
  | { status: 'completed'; progress?: number; result: ModelJobResult }
  | { status: 'failed'; error: unknown };

export interface ModelJobExecutor {
  submit(job: ModelJob): Promise<ModelJobSubmission>;
  poll(job: ModelJob): Promise<ModelJobPollResult>;
  cancel?(job: ModelJob): Promise<void>;
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
  now?: () => string;
}

export interface ModelJobStore {
  enqueueConfirmedJobs(input: EnqueueConfirmedJobsInput): Promise<ModelJob[]>;
  recover(): Promise<void>;
  processQueue(): Promise<void>;
  pollActiveJobs(): Promise<void>;
  retryJob(id: string): Promise<void>;
  cancelQueuedJob(id: string): Promise<void>;
  listJobs(): Promise<ModelJob[]>;
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
      await storage.bulkPut(jobs);
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
      await storage.bulkPut(recovered);
    },
    processQueue: async () => {
      const queued = (await storage.list()).filter((job) => job.status === 'queued');
      await runLimited(queued, POLL_CONCURRENCY, async (job) => {
        let current = transitionModelJob(job, 'submitting', { updatedAt: now(), error: undefined });
        await storage.put(current);
        try {
          const submitted = await options.executor.submit(current);
          current = transitionModelJob(current, 'running', {
            providerTaskId: submitted.providerTaskId,
            startedAt: now(),
            updatedAt: now(),
          });
          await storage.put(current);
        } catch (error) {
          await storage.put(transitionModelJob(current, 'failed', {
            error: sanitizeModelJobError(error),
            updatedAt: now(),
          }));
        }
      });
    },
    pollActiveJobs: async () => {
      const running = (await storage.list()).filter((job) => job.status === 'running');
      await runLimited(running, POLL_CONCURRENCY, async (job) => {
        try {
          const result = await options.executor.poll(job);
          if (result.status === 'running') {
            await storage.put({ ...job, progress: result.progress, updatedAt: now() });
            return;
          }
          if (result.status === 'failed') {
            await storage.put(transitionModelJob(job, 'failed', {
              error: sanitizeModelJobError(result.error),
              updatedAt: now(),
            }));
            return;
          }
          await materializeResult(job, result.result, options, storage, now);
        } catch (error) {
          await storage.put(transitionModelJob(job, 'failed', {
            error: sanitizeModelJobError(error),
            updatedAt: now(),
          }));
        }
      });
    },
    retryJob: async (id) => {
      const job = await requireJob(storage, id);
      if (job.status !== 'failed' && job.status !== 'cancelled') {
        throw new Error(`model job cannot be retried from ${job.status}`);
      }
      await storage.put(transitionModelJob(job, 'queued', { updatedAt: now(), progress: undefined }));
    },
    cancelQueuedJob: async (id) => {
      const job = await requireJob(storage, id);
      if (job.status === 'queued') {
        await storage.put(transitionModelJob(job, 'cancelled', { updatedAt: now() }));
        return;
      }
      if ((job.status === 'submitting' || job.status === 'running') && options.executor.cancel) {
        await options.executor.cancel(job);
        await storage.put(transitionModelJob(job, 'cancelled', { updatedAt: now() }));
        return;
      }
      throw new Error(`model job cannot be cancelled from ${job.status}`);
    },
    listJobs: async () => storage.list(),
  };
}

async function materializeResult(
  job: ModelJob,
  result: ModelJobResult,
  options: ModelJobStoreOptions,
  storage: ModelJobStorage,
  now: () => string,
): Promise<void> {
  await resultDecodeQueue.run(async () => {
    await result.decode?.();
  });
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
  if (!committed) return;
  await storage.put(transitionModelJob(job, 'completed', {
    completedAt: now(),
    progress: 1,
    resultAssetId: result.assetId,
    resultNodeId,
    updatedAt: now(),
  }));
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

const resultDecodeQueue = new AsyncQueue(MATERIALIZE_CONCURRENCY);

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
