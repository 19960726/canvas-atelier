import { describe, expect, it, vi } from 'vitest';
import type { ModelJob, ProjectTransaction } from '@agent-canvas/domain';
import { applyProjectTransaction } from '@agent-canvas/domain';
import { createStarterProject } from '../app/app-store';
import {
  createInMemoryModelJobStorage,
  createModelJobStore,
  type ModelJobExecutor,
  type ModelJobRequest,
} from './job-store';

const confirmedAt = '2026-07-16T08:00:00.000Z';

describe('persistent model job store', () => {
  it('persists queued jobs across store instances before execution', async () => {
    const storage = createInMemoryModelJobStorage();
    const executor = createExecutor();
    const first = createModelJobStore({ storage, executor, commitProjectTransaction: vi.fn(), now: fixedNow });

    await first.enqueueConfirmedJobs({
      conversationId: 'agent-conversation-shared',
      confirmedAt,
      requests: [request({ id: 'job-restart' })],
    });

    const restarted = createModelJobStore({ storage, executor, commitProjectTransaction: vi.fn(), now: fixedNow });

    expect(await restarted.listJobs()).toMatchObject([
      { id: 'job-restart', status: 'queued', conversationId: 'agent-conversation-shared' },
    ]);
  });

  it('polls running jobs repeatedly until a terminal result', async () => {
    const storage = createInMemoryModelJobStorage();
    let project = createStarterProject();
    const commitProjectTransaction = vi.fn(async (transaction: ProjectTransaction) => {
      project = applyProjectTransaction(project, transaction);
      return true;
    });
    const executor = createExecutor({
      poll: vi.fn()
        .mockResolvedValueOnce({ status: 'running' as const, progress: 0.25 })
        .mockResolvedValueOnce({ status: 'running' as const, progress: 0.75 })
        .mockResolvedValueOnce({
          status: 'completed' as const,
          progress: 1,
          result: { assetId: 'asset-job-repeat' },
        }),
    });
    const store = createModelJobStore({
      storage,
      executor,
      commitProjectTransaction,
      getProject: () => project,
      now: fixedNow,
      pollIntervalMs: 0,
    });

    await store.enqueueConfirmedJobs({
      conversationId: 'agent-conversation-shared',
      confirmedAt,
      requests: [request({ id: 'job-repeat' })],
    });
    await store.run();

    expect(executor.poll).toHaveBeenCalledTimes(3);
    expect(await storage.get('job-repeat')).toMatchObject({
      status: 'completed',
      progress: 1,
      resultAssetId: 'asset-job-repeat',
    });
  });

  it('restart recovery submits queued jobs and continues polling running jobs', async () => {
    const storage = createInMemoryModelJobStorage();
    let project = createStarterProject();
    const commitProjectTransaction = vi.fn(async (transaction: ProjectTransaction) => {
      project = applyProjectTransaction(project, transaction);
      return true;
    });
    const executor = createExecutor({
      submit: vi.fn(async (job) => ({ providerTaskId: `task-${job.id}` })),
      poll: vi.fn(async (job) => ({
        status: 'completed' as const,
        result: { assetId: `asset-${job.id}` },
      })),
    });
    const first = createModelJobStore({ storage, executor, commitProjectTransaction: vi.fn(), now: fixedNow });
    await first.enqueueConfirmedJobs({
      conversationId: 'agent-conversation-shared',
      confirmedAt,
      requests: [request({ id: 'job-queued' }), request({ id: 'job-running' })],
    });
    await storage.put({
      ...(await storage.get('job-running'))!,
      status: 'running',
      providerTaskId: 'task-job-running',
    });

    const restarted = createModelJobStore({
      storage,
      executor,
      commitProjectTransaction,
      getProject: () => project,
      now: fixedNow,
      pollIntervalMs: 0,
    });
    await restarted.recover();

    expect(executor.submit).toHaveBeenCalledTimes(1);
    expect(executor.submit).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-queued' }));
    expect(executor.poll).toHaveBeenCalledTimes(2);
    expect(await restarted.listJobs()).toMatchObject([
      { id: 'job-queued', status: 'completed' },
      { id: 'job-running', status: 'completed' },
    ]);
  });

  it('runs submit and poll with bounded concurrency', async () => {
    const storage = createInMemoryModelJobStorage();
    const submitGate = createGate();
    const executor = createExecutor({
      submit: vi.fn(async (job) => {
        submitGate.enter(job.id);
        await submitGate.wait();
        return { providerTaskId: `task-${job.id}` };
      }),
      poll: vi.fn(async () => ({ status: 'running' as const, progress: 0.25 })),
    });
    const store = createModelJobStore({ storage, executor, commitProjectTransaction: vi.fn(), now: fixedNow });
    await store.enqueueConfirmedJobs({
      conversationId: 'agent-conversation-shared',
      confirmedAt,
      requests: Array.from({ length: 6 }, (_, index) => request({ id: `job-${index}` })),
    });

    const submitting = store.processQueue();
    await submitGate.untilEntered(4);

    expect(submitGate.activeCount()).toBe(4);
    submitGate.releaseAll();
    await submitting;
    expect(executor.submit).toHaveBeenCalledTimes(6);
  });

  it('limits result materialization to two concurrent decodes and creates provenance nodes', async () => {
    const storage = createInMemoryModelJobStorage();
    const decodeGate = createGate();
    let project = createStarterProject();
    const commits: ProjectTransaction[] = [];
    const commitProjectTransaction = vi.fn(async (transaction: ProjectTransaction) => {
      commits.push(transaction);
      project = applyProjectTransaction(project, transaction);
      return true;
    });
    const executor = createExecutor({
      submit: vi.fn(async (job) => ({ providerTaskId: `task-${job.id}` })),
      poll: vi.fn(async (job) => ({
        status: 'completed' as const,
        progress: 1,
        result: {
          assetId: `asset-${job.id}`,
          width: 1024,
          height: 1024,
          decode: async () => {
            decodeGate.enter(job.id);
            await decodeGate.wait();
          },
        },
      })),
    });
    const store = createModelJobStore({
      storage,
      executor,
      commitProjectTransaction,
      getProject: () => project,
      now: fixedNow,
    });
    await store.enqueueConfirmedJobs({
      conversationId: 'agent-conversation-shared',
      confirmedAt,
      requests: Array.from({ length: 3 }, (_, index) => request({ id: `job-result-${index}` })),
    });
    await store.processQueue();

    const polling = store.pollActiveJobs();
    await decodeGate.untilEntered(2);

    expect(decodeGate.activeCount()).toBe(2);
    decodeGate.releaseAll();
    await polling;
    expect(commitProjectTransaction).toHaveBeenCalledTimes(3);
    expect(project.nodes.filter((node) => node.type === 'image_result')).toHaveLength(3);
    expect(project.nodes.filter((node) => node.type === 'image_result')[0]).toMatchObject({
      data: {
        modelId: 'dynamic-model-id',
        modelRoute: 'gpt-image',
        provider: 'comfly',
        providerTaskId: 'task-job-result-0',
        promptNodeId: 'prompt-start',
        referenceAssetIds: ['starter-product'],
      },
    });
  });

  it('coalesces overlapping run calls and keeps submit and decode concurrency bounded', async () => {
    const storage = createInMemoryModelJobStorage();
    const submitGate = createGate();
    const decodeGate = createGate();
    let project = createStarterProject();
    const commitProjectTransaction = vi.fn(async (transaction: ProjectTransaction) => {
      project = applyProjectTransaction(project, transaction);
      return true;
    });
    const executor = createExecutor({
      submit: vi.fn(async (job) => {
        submitGate.enter(job.id);
        await submitGate.wait();
        return { providerTaskId: `task-${job.id}` };
      }),
      poll: vi.fn(async (job) => ({
        status: 'completed' as const,
        result: {
          assetId: `asset-${job.id}`,
          decode: async () => {
            decodeGate.enter(job.id);
            await decodeGate.wait();
          },
        },
      })),
    });
    const store = createModelJobStore({
      storage,
      executor,
      commitProjectTransaction,
      getProject: () => project,
      now: fixedNow,
      pollIntervalMs: 0,
    });
    await store.enqueueConfirmedJobs({
      conversationId: 'agent-conversation-shared',
      confirmedAt,
      requests: Array.from({ length: 6 }, (_, index) => request({ id: `job-overlap-${index}` })),
    });

    const runs = [store.run(), store.run(), store.processQueue(), store.pollActiveJobs()];
    await submitGate.untilEntered(4);
    expect(submitGate.activeCount()).toBe(4);
    submitGate.releaseAll();
    await decodeGate.untilEntered(2);
    expect(decodeGate.activeCount()).toBe(2);
    decodeGate.releaseAll();
    await Promise.all(runs);

    expect(executor.submit).toHaveBeenCalledTimes(6);
    expect(commitProjectTransaction).toHaveBeenCalledTimes(6);
    expect(project.nodes.filter((node) => node.type === 'image_result')).toHaveLength(6);
  });

  it('keeps cancellation during submit or poll from being overwritten by stale workers', async () => {
    const storage = createInMemoryModelJobStorage();
    const submitGate = createGate();
    const pollGate = createGate();
    const executor = createExecutor({
      submit: vi.fn(async (job) => {
        submitGate.enter(job.id);
        await submitGate.wait();
        return { providerTaskId: `task-${job.id}` };
      }),
      poll: vi.fn(async (job) => {
        pollGate.enter(job.id);
        await pollGate.wait();
        return { status: 'completed' as const, result: { assetId: `asset-${job.id}` } };
      }),
    });
    const store = createModelJobStore({
      storage,
      executor,
      commitProjectTransaction: vi.fn(async () => true),
      now: fixedNow,
      pollIntervalMs: 0,
    });
    await store.enqueueConfirmedJobs({
      conversationId: 'agent-conversation-shared',
      confirmedAt,
      requests: [request({ id: 'job-submit-cancel' }), request({ id: 'job-poll-cancel' })],
    });
    await storage.put({
      ...(await storage.get('job-poll-cancel'))!,
      status: 'running',
      providerTaskId: 'task-job-poll-cancel',
    });

    const running = store.run();
    await submitGate.untilEntered(1);
    await store.cancelQueuedJob('job-submit-cancel');
    submitGate.releaseAll();
    await pollGate.untilEntered(1);
    await store.cancelQueuedJob('job-poll-cancel');
    pollGate.releaseAll();
    await running;

    expect(await storage.get('job-submit-cancel')).toMatchObject({ status: 'cancelled' });
    expect(await storage.get('job-poll-cancel')).toMatchObject({ status: 'cancelled' });
  });

  it('does not duplicate materialization after commit false, retry, or existing result', async () => {
    const storage = createInMemoryModelJobStorage();
    let project = createStarterProject();
    const commitProjectTransaction = vi.fn(async (transaction: ProjectTransaction) => {
      if (commitProjectTransaction.mock.calls.length === 1) return false;
      project = applyProjectTransaction(project, transaction);
      return true;
    });
    const executor = createExecutor({
      poll: vi.fn(async (job) => ({
        status: 'completed' as const,
        result: { assetId: `asset-${job.id}` },
      })),
    });
    const store = createModelJobStore({
      storage,
      executor,
      commitProjectTransaction,
      getProject: () => project,
      now: fixedNow,
      pollIntervalMs: 0,
    });
    await store.enqueueConfirmedJobs({
      conversationId: 'agent-conversation-shared',
      confirmedAt,
      requests: [request({ id: 'job-idempotent' })],
    });
    await storage.put({
      ...(await storage.get('job-idempotent'))!,
      status: 'running',
      providerTaskId: 'task-job-idempotent',
    });

    await store.pollActiveJobs();
    expect(await storage.get('job-idempotent')).toMatchObject({ status: 'running' });

    await store.pollActiveJobs();
    await store.pollActiveJobs();

    expect(commitProjectTransaction).toHaveBeenCalledTimes(2);
    expect(project.nodes.filter((node) => node.id === 'image-result-job-idempotent')).toHaveLength(1);
    expect(await storage.get('job-idempotent')).toMatchObject({ status: 'completed' });
  });

  it('notifies subscribers with sanitized clones for live progress and action errors', async () => {
    const storage = createInMemoryModelJobStorage();
    const snapshots: ModelJob[][] = [];
    const executor = createExecutor({
      poll: vi.fn(async () => ({ status: 'running' as const, progress: 0.4 })),
      cancel: vi.fn(async () => {
        throw new Error('Authorization: Bearer secret-token from C:\\Users\\private\\image.png');
      }),
    });
    const store = createModelJobStore({
      storage,
      executor,
      commitProjectTransaction: vi.fn(),
      now: fixedNow,
      pollIntervalMs: 0,
    });
    const unsubscribe = store.subscribe((jobs) => {
      snapshots.push(jobs);
      jobs[0]?.referenceAssetIds.push('mutated-subscriber-copy');
    });
    await store.enqueueConfirmedJobs({
      conversationId: 'agent-conversation-shared',
      confirmedAt,
      requests: [request({ id: 'job-subscribe' })],
    });
    await storage.put({
      ...(await storage.get('job-subscribe'))!,
      status: 'running',
      providerTaskId: 'task-job-subscribe',
    });
    await store.pollActiveJobs();
    await expect(store.cancelQueuedJob('job-subscribe')).resolves.toBeUndefined();
    unsubscribe();

    expect(snapshots.some((jobs) => jobs[0]?.status === 'queued')).toBe(true);
    expect(snapshots.some((jobs) => jobs[0]?.progress === 0.4)).toBe(true);
    const current = (await store.listJobs())[0]!;
    expect(current.referenceAssetIds).toEqual(['starter-product']);
    expect(current.error).toContain('[redacted]');
    expect(JSON.stringify(snapshots)).not.toMatch(/Authorization|secret-token|C:\\\\Users/i);
  });

  it('retries failed jobs, cancels queued jobs, and stores compact sanitized errors', async () => {
    const storage = createInMemoryModelJobStorage();
    const cancel = vi.fn(async () => {});
    const store = createModelJobStore({
      storage,
      executor: createExecutor({ cancel }),
      commitProjectTransaction: vi.fn(),
      now: fixedNow,
    });
    await store.enqueueConfirmedJobs({
      conversationId: 'agent-conversation-shared',
      confirmedAt,
      requests: [request({ id: 'job-fail' }), request({ id: 'job-cancel' })],
    });
    await storage.put({
      ...(await storage.get('job-fail'))!,
      status: 'failed',
      error: 'Authorization: Bearer secret from C:\\Users\\private\\image.png',
    });

    await store.retryJob('job-fail');
    await store.cancelQueuedJob('job-cancel');

    expect(await storage.get('job-fail')).toMatchObject({ status: 'queued', retryCount: 1 });
    expect(await storage.get('job-cancel')).toMatchObject({ status: 'cancelled' });
    expect(JSON.stringify(await store.listJobs())).not.toMatch(/Authorization|C:\\\\Users|secret/i);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('keeps one conversation while jobs use different dynamic routes', async () => {
    const storage = createInMemoryModelJobStorage();
    const executor = createExecutor();
    const store = createModelJobStore({ storage, executor, commitProjectTransaction: vi.fn(), now: fixedNow });

    await store.enqueueConfirmedJobs({
      conversationId: 'agent-conversation-shared',
      confirmedAt,
      requests: [
        request({ id: 'job-gpt', modelRoute: 'gpt-image', displayName: 'GPT image', modelId: 'inventory-gpt' }),
        request({ id: 'job-banana', modelRoute: 'nano-banana-2', displayName: 'Nano Banana 2', modelId: 'inventory-banana' }),
      ],
    });
    await store.processQueue();

    expect(executor.submit).toHaveBeenCalledWith(expect.objectContaining({
      id: 'job-gpt',
      conversationId: 'agent-conversation-shared',
      modelRoute: 'gpt-image',
    }));
    expect(executor.submit).toHaveBeenCalledWith(expect.objectContaining({
      id: 'job-banana',
      conversationId: 'agent-conversation-shared',
      modelRoute: 'nano-banana-2',
    }));
    expect(await store.listJobs()).toMatchObject([
      { id: 'job-gpt', conversationId: 'agent-conversation-shared', modelId: 'inventory-gpt' },
      { id: 'job-banana', conversationId: 'agent-conversation-shared', modelId: 'inventory-banana' },
    ]);
  });

  it('rejects enqueues without confirmedAt and does not persist protected payloads', async () => {
    const storage = createInMemoryModelJobStorage();
    const store = createModelJobStore({ storage, executor: createExecutor(), commitProjectTransaction: vi.fn(), now: fixedNow });

    await expect(store.enqueueConfirmedJobs({
      conversationId: 'agent-conversation-shared',
      requests: [request({ id: 'job-unconfirmed' })],
    })).rejects.toThrow(/confirmedAt/i);
    await expect(store.enqueueConfirmedJobs({
      conversationId: 'agent-conversation-shared',
      confirmedAt,
      requests: [request({
        id: 'job-unsafe',
        prompt: 'Use data:image/png;base64,AAAAAAAAAAAAAAAAAAAA from C:\\Users\\private\\source.png',
      })],
    })).rejects.toThrow(/protected payload/i);

    expect(await store.listJobs()).toEqual([]);
  });
});

function request(overrides: Partial<ModelJobRequest> = {}): ModelJobRequest {
  return {
    id: overrides.id ?? 'job-1',
    promptNodeId: overrides.promptNodeId ?? 'prompt-start',
    prompt: overrides.prompt ?? 'Generate a product image',
    provider: overrides.provider ?? 'comfly',
    modelRoute: overrides.modelRoute ?? 'gpt-image',
    displayName: overrides.displayName ?? 'GPT image',
    modelId: overrides.modelId ?? 'dynamic-model-id',
    referenceAssetIds: overrides.referenceAssetIds ?? ['starter-product'],
  };
}

function fixedNow() {
  return '2026-07-16T08:05:00.000Z';
}

function createExecutor(overrides: Partial<ModelJobExecutor> = {}): ModelJobExecutor {
  return {
    submit: overrides.submit ?? vi.fn(async (job) => ({ providerTaskId: `task-${job.id}` })),
    poll: overrides.poll ?? vi.fn(async () => ({ status: 'running' as const, progress: 0.5 })),
    cancel: overrides.cancel ?? vi.fn(async () => {}),
  };
}

function createGate() {
  const active = new Set<string>();
  let release: (() => void) | null = null;
  let enteredResolver: (() => void) | null = null;
  const waitPromise = new Promise<void>((resolve) => { release = resolve; });

  return {
    activeCount: () => active.size,
    enter: (id: string) => {
      active.add(id);
      enteredResolver?.();
    },
    releaseAll: () => {
      release?.();
    },
    untilEntered: async (count: number) => {
      while (active.size < count) {
        await new Promise<void>((resolve) => { enteredResolver = resolve; });
      }
    },
    wait: async () => {
      await waitPromise;
      active.clear();
    },
  };
}
