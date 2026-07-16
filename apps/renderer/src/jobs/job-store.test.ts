import { describe, expect, it, vi } from 'vitest';
import type { ProjectTransaction } from '@agent-canvas/domain';
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
  it('persists queued jobs and resumes them after restart', async () => {
    const storage = createInMemoryModelJobStorage();
    const executor = createExecutor();
    const first = createModelJobStore({ storage, executor, commitProjectTransaction: vi.fn(), now: fixedNow });

    await first.enqueueConfirmedJobs({
      conversationId: 'agent-conversation-shared',
      confirmedAt,
      requests: [request({ id: 'job-restart' })],
    });

    const restarted = createModelJobStore({ storage, executor, commitProjectTransaction: vi.fn(), now: fixedNow });
    await restarted.recover();

    expect(await restarted.listJobs()).toMatchObject([
      { id: 'job-restart', status: 'queued', conversationId: 'agent-conversation-shared' },
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
