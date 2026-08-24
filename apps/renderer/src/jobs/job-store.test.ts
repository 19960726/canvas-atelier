import { describe, expect, it, vi } from 'vitest';
import type { CanvasNode, CanvasProject, ModelJob, ProjectTransaction } from '@agent-canvas/domain';
import { applyProjectTransaction, createCanvasModuleNode } from '@agent-canvas/domain';
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
    const commitProjectTransaction = vi.fn(async (build) => {
      const materialization = build(project);
      project = applyProjectTransaction(project, materialization.transaction);
      return { committed: true, resultNodeId: materialization.resultNodeId };
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

  it('restart recovery stops queued and running jobs without calling the provider', async () => {
    const storage = createInMemoryModelJobStorage();
    let project = createStarterProject();
    const commitProjectTransaction = vi.fn(async (build) => {
      const materialization = build(project);
      project = applyProjectTransaction(project, materialization.transaction);
      return { committed: true, resultNodeId: materialization.resultNodeId };
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

    expect(executor.submit).not.toHaveBeenCalled();
    expect(executor.poll).not.toHaveBeenCalled();
    expect(await restarted.listJobs()).toMatchObject([
      { id: 'job-queued', status: 'cancelled' },
      { id: 'job-running', status: 'cancelled' },
    ]);
  });

  it('restart recovery preserves only a running job still owned by its active source node', async () => {
    const storage = createInMemoryModelJobStorage();
    const executor = createExecutor();
    const first = createModelJobStore({
      storage,
      executor,
      commitProjectTransaction: vi.fn(),
      now: fixedNow,
    });
    await first.enqueueConfirmedJobs({
      conversationId: 'owned-restart-recovery',
      confirmedAt,
      requests: [
        request({ id: 'job-running-owned' }),
        request({ id: 'job-running-stale' }),
      ],
    });
    for (const id of ['job-running-owned', 'job-running-stale']) {
      await storage.put({
        ...(await storage.get(id))!,
        status: 'running',
        providerTaskId: `task-${id}`,
      });
    }
    const canRecoverRunningJob = vi.fn(async (job: ModelJob) => job.id === 'job-running-owned');
    const restarted = createModelJobStore({
      storage,
      executor,
      canRecoverRunningJob,
      commitProjectTransaction: vi.fn(),
      now: fixedNow,
      pollIntervalMs: 0,
    });

    await restarted.recover();

    expect(canRecoverRunningJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-running-owned', status: 'running' }),
    );
    expect(await restarted.listJobs()).toMatchObject([
      { id: 'job-running-owned', status: 'running' },
      { id: 'job-running-stale', status: 'cancelled' },
    ]);
  });

  it('repairs a completed result into its original generation node without resuming the provider job', async () => {
    const source = createCanvasModuleNode('repair-inline-source', 'image_generation', { x: 0, y: 0 });
    let project: CanvasProject = {
      ...createStarterProject(),
      nodes: [source],
      edges: [],
    };
    const completedJob = {
      ...request({ id: 'repair-inline-job', promptNodeId: source.id, referenceAssetIds: [] }),
      conversationId: 'agent-conversation-shared',
      confirmedAt,
      createdAt: confirmedAt,
      updatedAt: confirmedAt,
      completedAt: confirmedAt,
      kind: 'image' as const,
      status: 'completed' as const,
      retryCount: 0,
      resultAssetId: 'asset-repair-inline',
      projectSessionId: 'retired-session',
    } satisfies ModelJob;
    const storage = createInMemoryModelJobStorage([completedJob]);
    const executor = createExecutor();
    const repairCompletedProjectTransaction = vi.fn(async (build) => {
      const materialization = build(project);
      project = applyProjectTransaction(project, materialization.transaction);
      return { committed: true, resultNodeId: materialization.resultNodeId };
    });
    const store = createModelJobStore({
      storage,
      executor,
      commitProjectTransaction: vi.fn(async () => ({ committed: false, resultNodeId: source.id })),
      repairCompletedProjectTransaction,
      getProject: () => project,
      now: fixedNow,
      pollIntervalMs: 0,
    });

    await store.recover();

    expect(executor.submit).not.toHaveBeenCalled();
    expect(executor.poll).not.toHaveBeenCalled();
    expect(repairCompletedProjectTransaction).toHaveBeenCalledOnce();
    expect(project.nodes.find((node) => node.id === source.id)).toMatchObject({
      data: {
        config: { resultAssetIds: ['asset-repair-inline'], resultState: 'fresh' },
        execution: { state: 'completed' },
      },
    });
    expect(project.nodes.some((node) => node.type === 'image_result')).toBe(false);
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
    const commitProjectTransaction = vi.fn(async (build) => {
      const materialization = build(project);
      commits.push(materialization.transaction);
      project = applyProjectTransaction(project, materialization.transaction);
      return { committed: true, resultNodeId: materialization.resultNodeId };
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

  it('stores a generated result inside its formal image module', async () => {
    const storage = createInMemoryModelJobStorage();
    const imageModule = createCanvasModuleNode('image-module', 'image_generation', { x: 120, y: 80 });
    let project: CanvasProject = { ...createStarterProject(), nodes: [imageModule], edges: [] };
    const commitProjectTransaction = vi.fn(async (build) => {
      const materialization = build(project);
      project = applyProjectTransaction(project, materialization.transaction);
      return { committed: true, resultNodeId: materialization.resultNodeId };
    });
    const store = createModelJobStore({
      storage,
      executor: createExecutor({
        poll: vi.fn(async () => ({
          status: 'completed' as const,
          progress: 1,
          result: { assetId: '0123456789abcdef', width: 1408, height: 768 },
        })),
      }),
      commitProjectTransaction,
      getProject: () => project,
      now: fixedNow,
      pollIntervalMs: 0,
    });

    await store.enqueueConfirmedJobs({
      conversationId: 'formal-image-module',
      confirmedAt,
      requests: [request({ id: 'job-formal-image', promptNodeId: imageModule.id, referenceAssetIds: [] })],
    });
    await store.run();

    expect(await storage.get('job-formal-image')).toMatchObject({
      status: 'completed',
      resultAssetId: '0123456789abcdef',
      resultNodeId: imageModule.id,
    });
    expect(project.nodes.find((node) => node.id === imageModule.id)).toMatchObject({
      type: 'module',
      data: {
        config: expect.objectContaining({
          resultAssetIds: ['0123456789abcdef'],
          resultState: 'fresh',
        }),
        execution: expect.objectContaining({ state: 'completed' }),
      },
    });
    expect(project.nodes.some((node) => node.type === 'image_result')).toBe(false);
    expect(project.edges).toEqual([]);
  });

  it('does not mark a provider result completed when source-node persistence fails', async () => {
    const imageNode = createCanvasModuleNode('image-node', 'image_generation', { x: 0, y: 0 });
    const project = { ...createStarterProject(), nodes: [imageNode], edges: [] };
    const runningJob = {
      ...request({ id: 'job-result-write-failed', promptNodeId: imageNode.id }),
      conversationId: 'conversation-result-write',
      confirmedAt,
      createdAt: confirmedAt,
      updatedAt: confirmedAt,
      status: 'running' as const,
      retryCount: 0,
      providerTaskId: 'provider-job-result-write-failed',
    } as ModelJob;
    const storage = createInMemoryModelJobStorage([runningJob]);
    const store = createModelJobStore({
      storage,
      executor: createExecutor({
        poll: vi.fn(async () => ({ status: 'completed' as const, result: { assetId: 'a'.repeat(16) } })),
      }),
      getProject: () => project,
      commitProjectTransaction: vi.fn(async () => ({ committed: false, resultNodeId: imageNode.id })),
      now: fixedNow,
      pollIntervalMs: 0,
    });

    await store.pollActiveJobs();

    expect(await storage.get('job-result-write-failed')).toMatchObject({ status: 'running' });
    expect(await storage.get('job-result-write-failed')).not.toHaveProperty('resultAssetId');
  });

  it('does not trust a successful commit response until the source node contains the generated asset', async () => {
    const imageNode = createCanvasModuleNode('image-node-unverified-commit', 'image_generation', { x: 0, y: 0 });
    imageNode.data.config = { ...imageNode.data.config, resultAssetIds: [] };
    let project: CanvasProject = {
      ...createStarterProject(),
      nodes: [imageNode],
      edges: [],
      assets: [{
        assetId: 'b'.repeat(16),
        label: 'Generated image',
        width: 1024,
        height: 1024,
        mediaType: 'image/jpeg',
        byteSize: 2048,
        sha256: 'b'.repeat(64),
        extension: 'jpg',
        origin: 'generated',
      }],
    };
    const runningJob = {
      ...request({ id: 'job-result-unverified-commit', promptNodeId: imageNode.id }),
      conversationId: 'conversation-result-unverified-commit',
      confirmedAt,
      createdAt: confirmedAt,
      updatedAt: confirmedAt,
      status: 'running' as const,
      retryCount: 0,
      providerTaskId: 'provider-job-result-unverified-commit',
    } as ModelJob;
    const storage = createInMemoryModelJobStorage([runningJob]);
    const commitProjectTransaction = vi.fn(async (build) => {
      const materialization = build(project);
      expect(materialization.transaction.id).toBe(`model-job-inline-result-${runningJob.id}`);
      return { committed: true, resultNodeId: materialization.resultNodeId };
    });
    const store = createModelJobStore({
      storage,
      executor: createExecutor({
        poll: vi.fn(async () => ({ status: 'completed' as const, result: { assetId: 'b'.repeat(16) } })),
      }),
      getProject: () => project,
      commitProjectTransaction,
      now: fixedNow,
      pollIntervalMs: 0,
    });

    await store.pollActiveJobs();

    expect(commitProjectTransaction).toHaveBeenCalledOnce();
    expect(await storage.get(runningJob.id)).toMatchObject({ status: 'running' });
    expect(await storage.get(runningJob.id)).not.toHaveProperty('resultAssetId');
    expect(project.nodes[0]).toMatchObject({ data: { config: { resultAssetIds: [] } } });
  });

  it('exposes a running-job guard and does not complete after the owner job changes', async () => {
    const imageNode = createCanvasModuleNode('image-node-running-guard', 'image_generation', { x: 0, y: 0 });
    const project = { ...createStarterProject(), nodes: [imageNode], edges: [] };
    const runningJob = {
      ...request({ id: 'job-running-guard', promptNodeId: imageNode.id }),
      conversationId: 'conversation-running-guard',
      confirmedAt,
      createdAt: confirmedAt,
      updatedAt: confirmedAt,
      status: 'running' as const,
      retryCount: 0,
      providerTaskId: 'provider-job-running-guard',
    } as ModelJob;
    const storage = createInMemoryModelJobStorage([runningJob]);
    const entered = deferred<void>();
    const release = deferred<void>();
    let guardType = 'missing';
    let ownerStillRunning = true;
    const store = createModelJobStore({
      storage,
      executor: createExecutor({
        poll: vi.fn(async () => ({ status: 'completed' as const, result: { assetId: 'c'.repeat(16) } })),
      }),
      getProject: () => project,
      commitProjectTransaction: vi.fn(async (_build, _owner, isOwnerRunning) => {
        guardType = typeof isOwnerRunning;
        entered.resolve();
        await release.promise;
        ownerStillRunning = await isOwnerRunning();
        return { committed: ownerStillRunning, resultNodeId: imageNode.id };
      }),
      now: fixedNow,
      pollIntervalMs: 0,
    });

    const polling = store.pollActiveJobs();
    await entered.promise;
    await storage.put({ ...runningJob, status: 'cancelled', updatedAt: fixedNow() });
    release.resolve();
    await polling;

    expect(guardType).toBe('function');
    expect(ownerStillRunning).toBe(false);
    expect(await storage.get(runningJob.id)).toMatchObject({ status: 'cancelled' });
    expect(await storage.get(runningJob.id)).not.toHaveProperty('resultAssetId');
  });

  it('does not complete a provider result when the project commit throws', async () => {
    const imageNode = createCanvasModuleNode('image-node-commit-throws', 'image_generation', { x: 0, y: 0 });
    const project = { ...createStarterProject(), nodes: [imageNode], edges: [] };
    const runningJob = {
      ...request({ id: 'job-commit-throws', promptNodeId: imageNode.id }),
      conversationId: 'conversation-commit-throws',
      confirmedAt,
      createdAt: confirmedAt,
      updatedAt: confirmedAt,
      status: 'running' as const,
      retryCount: 0,
      providerTaskId: 'provider-job-commit-throws',
    } as ModelJob;
    const storage = createInMemoryModelJobStorage([runningJob]);
    const store = createModelJobStore({
      storage,
      executor: createExecutor({
        poll: vi.fn(async () => ({ status: 'completed' as const, result: { assetId: 'd'.repeat(16) } })),
      }),
      getProject: () => project,
      commitProjectTransaction: vi.fn(async () => { throw new Error('commit failed'); }),
      now: fixedNow,
      pollIntervalMs: 0,
    });

    await store.pollActiveJobs();

    expect(await storage.get(runningJob.id)).toMatchObject({ status: 'failed' });
    expect(await storage.get(runningJob.id)).not.toHaveProperty('resultAssetId');
  });

  it('builds the result transaction from the source node current at commit time', async () => {
    const imageNode = createCanvasModuleNode('image-node-current', 'image_generation', { x: 0, y: 0 });
    const runningJob = {
      ...request({ id: 'job-result-current-node', promptNodeId: imageNode.id }),
      conversationId: 'conversation-result-current-node',
      confirmedAt,
      createdAt: confirmedAt,
      updatedAt: confirmedAt,
      status: 'running' as const,
      retryCount: 0,
      providerTaskId: 'provider-job-result-current-node',
    } as ModelJob;
    const storage = createInMemoryModelJobStorage([runningJob]);
    let project: CanvasProject = {
      ...createStarterProject(),
      nodes: [{
        ...imageNode,
        data: { ...imageNode.data, config: { ...imageNode.data.config, prompt: 'new local prompt' } },
      }],
      edges: [],
    };
    const store = createModelJobStore({
      storage,
      executor: createExecutor({
        poll: vi.fn(async () => ({ status: 'completed' as const, result: { assetId: 'b'.repeat(16) } })),
      }),
      getProject: () => project,
      commitProjectTransaction: vi.fn(async (build: unknown) => {
        expect(typeof build).toBe('function');
        const materialization = (build as (latest: CanvasProject) => {
          resultNodeId: string;
          transaction: ProjectTransaction;
        })(project);
        project = applyProjectTransaction(project, materialization.transaction);
        return { committed: true, resultNodeId: materialization.resultNodeId };
      }),
      now: fixedNow,
      pollIntervalMs: 0,
    });

    await store.pollActiveJobs();

    expect(project.nodes.find((node) => node.id === imageNode.id)).toMatchObject({
      data: { config: { prompt: 'new local prompt', resultAssetIds: ['b'.repeat(16)] } },
    });
  });

  it('merges concurrent formal image results into one capped source-node gallery', async () => {
    const storage = createInMemoryModelJobStorage();
    const imageModule = createCanvasModuleNode('image-module-multi', 'image_generation', { x: 120, y: 80 });
    let project: CanvasProject = { ...createStarterProject(), nodes: [imageModule], edges: [] };
    const store = createModelJobStore({
      storage,
      executor: createExecutor({
        poll: vi.fn(async (job) => ({
          status: 'completed' as const,
          progress: 1,
          result: { assetId: `asset-${job.id}`, width: 1024, height: 1024 },
        })),
      }),
      commitProjectTransaction: async (build) => {
        const materialization = build(project);
        project = applyProjectTransaction(project, materialization.transaction);
        return { committed: true, resultNodeId: materialization.resultNodeId };
      },
      getProject: () => project,
      now: fixedNow,
      pollIntervalMs: 0,
    });

    await store.enqueueConfirmedJobs({
      conversationId: 'formal-image-module-multi',
      confirmedAt,
      requests: Array.from({ length: 4 }, (_, index) => request({
        id: `formal-image-${index + 1}`,
        promptNodeId: imageModule.id,
        referenceAssetIds: [],
      })),
    });
    await store.run();

    const updated = project.nodes.find((node) => node.id === imageModule.id);
    expect(updated?.type === 'module' ? updated.data.config.resultAssetIds : undefined).toEqual([
      'asset-formal-image-1',
      'asset-formal-image-2',
      'asset-formal-image-3',
      'asset-formal-image-4',
    ]);
    expect(project.nodes.some((node) => node.type === 'image_result')).toBe(false);
  });

  it('stores a generated video inside its formal video module', async () => {
    const storage = createInMemoryModelJobStorage();
    const videoModule = createCanvasModuleNode('video-module', 'video_generation', { x: 120, y: 80 });
    let project: CanvasProject = { ...createStarterProject(), nodes: [videoModule], edges: [] };
    const commitProjectTransaction = vi.fn(async (build) => {
      const materialization = build(project);
      project = applyProjectTransaction(project, materialization.transaction);
      return { committed: true, resultNodeId: materialization.resultNodeId };
    });
    const store = createModelJobStore({
      storage,
      executor: createExecutor({
        poll: vi.fn(async () => ({
          status: 'completed' as const,
          progress: 1,
          result: { assetId: 'fedcba9876543210', width: 1920, height: 1080, durationSeconds: 8 },
        })),
      }),
      commitProjectTransaction,
      getProject: () => project,
      now: fixedNow,
      pollIntervalMs: 0,
    });

    await store.enqueueConfirmedJobs({
      conversationId: 'formal-video-module',
      confirmedAt,
      requests: [request({
        id: 'job-formal-video', kind: 'video', promptNodeId: videoModule.id,
        provider: 'relayme', modelRoute: 'relayme-video', displayName: 'Relay video', modelId: 'relay-video',
        referenceAssetIds: [], aspectRatio: '16:9', videoResolution: '1080p', durationSeconds: 8, audioEnabled: true,
      })],
    });
    await store.run();

    expect(await storage.get('job-formal-video')).toMatchObject({
      status: 'completed',
      resultAssetId: 'fedcba9876543210',
      resultNodeId: videoModule.id,
    });
    expect(project.nodes.find((node) => node.id === videoModule.id)).toMatchObject({
      type: 'module',
      data: {
        config: expect.objectContaining({
          resultState: 'fresh',
          videoResults: [expect.objectContaining({
            assetId: 'fedcba9876543210',
            durationMs: 8000,
            mediaType: 'video/mp4',
          })],
        }),
        execution: expect.objectContaining({ state: 'completed' }),
      },
    });
    expect(project.nodes.some((node) => node.type === 'video_result')).toBe(false);
    expect(project.edges).toEqual([]);
  });

  it('materializes completed video jobs as video result nodes', async () => {
    const storage = createInMemoryModelJobStorage();
    let project = createStarterProject();
    const commitProjectTransaction = vi.fn(async (build) => {
      const materialization = build(project);
      project = applyProjectTransaction(project, materialization.transaction);
      return { committed: true, resultNodeId: materialization.resultNodeId };
    });
    const store = createModelJobStore({
      storage,
      executor: createExecutor({
        poll: vi.fn(async () => ({
          status: 'completed' as const,
          progress: 1,
          result: { assetId: 'fedcba9876543210', width: 1920, height: 1080, durationSeconds: 8 },
        })),
      }),
      commitProjectTransaction,
      getProject: () => project,
      now: fixedNow,
      pollIntervalMs: 0,
    });

    await store.enqueueConfirmedJobs({
      conversationId: 'video-conversation',
      confirmedAt,
      requests: [request({
        id: 'video-job-result', kind: 'video', provider: 'relayme', modelRoute: 'relayme-video',
        displayName: 'Relay video', modelId: 'relay-video', referenceAssetIds: [],
        aspectRatio: '16:9', videoResolution: '1080p', durationSeconds: 8, audioEnabled: true,
      })],
    });
    await store.run();

    expect((await storage.get('video-job-result'))?.error).toBeUndefined();
    expect(await storage.get('video-job-result')).toMatchObject({ status: 'completed' });
    expect(project.nodes.find((node) => node.type === 'video_result' && node.data.jobId === 'video-job-result')).toMatchObject({
      id: 'video-result-video-job-result',
      data: {
        assetId: 'fedcba9876543210', durationSeconds: 8, width: 1920, height: 1080,
        provider: 'relayme', modelRoute: 'relayme-video', promptNodeId: 'prompt-start',
      },
    });
    expect(await storage.get('video-job-result')).toMatchObject({
      status: 'completed', resultAssetId: 'fedcba9876543210', resultNodeId: 'video-result-video-job-result',
    });
  });

  it('coalesces overlapping run calls and keeps submit and decode concurrency bounded', async () => {
    const storage = createInMemoryModelJobStorage();
    const submitGate = createGate();
    const decodeGate = createGate();
    let project = createStarterProject();
    const commitProjectTransaction = vi.fn(async (build) => {
      const materialization = build(project);
      project = applyProjectTransaction(project, materialization.transaction);
      return { committed: true, resultNodeId: materialization.resultNodeId };
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

  it('accepts runtime-profile poll and decode concurrency overrides instead of hard-coding 4 and 2', async () => {
    const storage = createInMemoryModelJobStorage();
    const submitGate = createGate();
    const decodeGate = createGate();
    let project = createStarterProject();
    const commitProjectTransaction = vi.fn(async (build) => {
      const materialization = build(project);
      project = applyProjectTransaction(project, materialization.transaction);
      return { committed: true, resultNodeId: materialization.resultNodeId };
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
      pollConcurrency: 2,
      decodeConcurrency: 1,
    });
    await store.enqueueConfirmedJobs({
      conversationId: 'agent-conversation-shared',
      confirmedAt,
      requests: Array.from({ length: 3 }, (_, index) => request({ id: `job-profile-${index}` })),
    });

    const running = store.run();
    await submitGate.untilEntered(2);
    expect(submitGate.activeCount()).toBe(2);
    submitGate.releaseAll();
    await decodeGate.untilEntered(1);
    expect(decodeGate.activeCount()).toBe(1);
    decodeGate.releaseAll();
    await running;
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
      commitProjectTransaction: vi.fn(async () => ({ committed: true, resultNodeId: '' })),
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

  it('finishes local cancellation when the provider cancel call never settles', async () => {
    vi.useFakeTimers();
    try {
      const storage = createInMemoryModelJobStorage();
      const executor = createExecutor({
        cancel: vi.fn(() => new Promise<never>(() => undefined)),
        ackTerminal: vi.fn(() => new Promise<never>(() => undefined)),
      });
      const store = createModelJobStore({
        storage,
        executor,
        commitProjectTransaction: vi.fn(async () => ({ committed: true, resultNodeId: '' })),
        now: fixedNow,
      });
      await store.enqueueConfirmedJobs({
        conversationId: 'agent-conversation-shared',
        confirmedAt,
        requests: [request({ id: 'job-cancel-provider-hang' })],
      });
      await storage.put({
        ...(await storage.get('job-cancel-provider-hang'))!,
        status: 'running',
        providerTaskId: 'task-job-cancel-provider-hang',
      });

      const cancellation = store.cancelQueuedJob('job-cancel-provider-hang');
      let settled = false;
      void cancellation.then(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.resolve();

      expect(settled).toBe(true);
      expect(await storage.get('job-cancel-provider-hang')).toMatchObject({ status: 'cancelled' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not duplicate materialization after commit false, retry, or existing result', async () => {
    const storage = createInMemoryModelJobStorage();
    let project = createStarterProject();
    const commitProjectTransaction = vi.fn(async (build) => {
      const materialization = build(project);
      if (commitProjectTransaction.mock.calls.length === 1) {
        return { committed: false, resultNodeId: materialization.resultNodeId };
      }
      project = applyProjectTransaction(project, materialization.transaction);
      return { committed: true, resultNodeId: materialization.resultNodeId };
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

  it('repairs a completed job whose durable canvas result is missing during recovery', async () => {
    const storage = createInMemoryModelJobStorage();
    let project = createStarterProject();
    const commitProjectTransaction = vi.fn(async (build, owner: ModelJob) => {
      expect(owner).toMatchObject({ id: 'job-repair-completed', projectSessionId: 'desktop-session-a' });
      const materialization = build(project);
      project = applyProjectTransaction(project, materialization.transaction);
      return { committed: true, resultNodeId: materialization.resultNodeId };
    });
    const first = createModelJobStore({
      storage,
      executor: createExecutor(),
      commitProjectTransaction,
      getProject: () => project,
      now: fixedNow,
      pollIntervalMs: 0,
    });
    await first.enqueueConfirmedJobs({
      conversationId: 'repair-completed-result',
      projectSessionId: 'desktop-session-a',
      confirmedAt,
      requests: [request({ id: 'job-repair-completed' })],
    });
    const queued = (await storage.get('job-repair-completed'))!;
    await storage.put({
      ...queued,
      status: 'completed',
      providerTaskId: 'provider-repair-completed',
      completedAt: fixedNow(),
      progress: 1,
      resultAssetId: 'asset-job-repair-completed',
      resultNodeId: 'image-result-job-repair-completed',
    });

    await first.recover();

    expect(commitProjectTransaction).toHaveBeenCalledTimes(1);
    expect(project.nodes).toContainEqual(expect.objectContaining({
      id: 'image-result-job-repair-completed',
      type: 'image_result',
      data: expect.objectContaining({ assetId: 'asset-job-repair-completed', jobId: 'job-repair-completed' }),
    }));
  });

  it('migrates a legacy result node back into its formal generation source during recovery', async () => {
    const storage = createInMemoryModelJobStorage();
    const source = createCanvasModuleNode('legacy-inline-source', 'image_generation', { x: 0, y: 0 });
    const legacyResult: CanvasNode = {
      id: 'image-result-legacy-inline-job',
      type: 'image_result',
      position: { x: 320, y: 40 },
      data: {
        assetId: 'asset-legacy-inline',
        displayName: 'Legacy image model',
        jobId: 'legacy-inline-job',
        modelId: 'legacy-image-model',
        modelRoute: 'legacy-image-route',
        parentNodeIds: [source.id],
        promptNodeId: source.id,
        provider: 'comfly',
        providerTaskId: 'provider-legacy-inline',
        referenceAssetIds: [],
      },
    };
    let project: CanvasProject = {
      ...createStarterProject(),
      nodes: [source, legacyResult],
      edges: [{ id: 'legacy-result-edge', source: source.id, sourcePortId: 'result', target: legacyResult.id }],
    };
    const commitProjectTransaction = vi.fn(async (build) => {
      const materialization = build(project);
      project = applyProjectTransaction(project, materialization.transaction);
      return { committed: true, resultNodeId: materialization.resultNodeId };
    });
    const store = createModelJobStore({
      storage,
      executor: createExecutor(),
      commitProjectTransaction,
      getProject: () => project,
      now: fixedNow,
      pollIntervalMs: 0,
    });
    await store.enqueueConfirmedJobs({
      conversationId: 'legacy-inline-recovery',
      confirmedAt,
      requests: [request({ id: 'legacy-inline-job', promptNodeId: source.id, referenceAssetIds: [] })],
    });
    const queued = (await storage.get('legacy-inline-job'))!;
    await storage.put({
      ...queued,
      status: 'completed',
      providerTaskId: 'provider-legacy-inline',
      completedAt: fixedNow(),
      progress: 1,
      resultAssetId: legacyResult.data.assetId,
      resultNodeId: legacyResult.id,
    });

    await store.recover();

    expect(project.nodes.find((node) => node.id === source.id)).toMatchObject({
      type: 'module',
      data: {
        config: expect.objectContaining({ resultAssetIds: ['asset-legacy-inline'], resultState: 'fresh' }),
        execution: expect.objectContaining({ state: 'completed' }),
      },
    });
    expect(project.nodes.find((node) => node.id === legacyResult.id)).toEqual(legacyResult);
  });

  it('acks completed provider terminals only after project result and terminal job are durable', async () => {
    const storage = createInMemoryModelJobStorage();
    let project = createStarterProject();
    const commitProjectTransaction = vi.fn(async (build) => {
      const materialization = build(project);
      project = applyProjectTransaction(project, materialization.transaction);
      return { committed: true, resultNodeId: materialization.resultNodeId };
    });
    const ackTerminal = vi.fn(async (job: ModelJob) => {
      expect(await storage.get(job.id)).toMatchObject({
        status: 'completed',
        resultAssetId: `asset-${job.id}`,
      });
      expect(project.nodes.some((node) => node.type === 'image_result' && node.data.jobId === job.id)).toBe(true);
    });
    const store = createModelJobStore({
      storage,
      executor: createExecutor({
        poll: vi.fn(async (job) => ({
          status: 'completed' as const,
          result: {
            assetId: `asset-${job.id}`,
            url: 'https://assets.example/generated.png?redirect=http://169.254.169.254/latest/meta-data',
          },
        })),
        ackTerminal,
      } as Partial<ModelJobExecutor>),
      commitProjectTransaction,
      getProject: () => project,
      now: fixedNow,
      pollIntervalMs: 0,
    });
    await store.enqueueConfirmedJobs({
      conversationId: 'agent-conversation-shared',
      confirmedAt,
      requests: [request({ id: 'job-ack-complete' })],
    });
    await storage.put({
      ...(await storage.get('job-ack-complete'))!,
      status: 'running',
      providerTaskId: 'provider-job-ack-complete',
    });

    await store.pollActiveJobs();

    expect(ackTerminal).toHaveBeenCalledWith(expect.objectContaining({
      id: 'job-ack-complete',
      providerTaskId: 'provider-job-ack-complete',
      status: 'completed',
    }));
    expect(JSON.stringify(project)).not.toMatch(/https?:\/\/|169\.254|redirect|generated\.png/i);
    expect(JSON.stringify(await storage.get('job-ack-complete'))).not.toMatch(/https?:\/\/|169\.254|redirect|generated\.png/i);
  });

  it('keeps locked jobs running and acks failed/cancelled terminals after durable terminal writes', async () => {
    const storage = createInMemoryModelJobStorage();
    const ackedStatuses: string[] = [];
    const ackTerminal = vi.fn(async (job: ModelJob) => {
      expect(await storage.get(job.id)).toMatchObject({ status: job.status });
      ackedStatuses.push(job.status);
    });
    const executor = createExecutor({
      poll: vi.fn()
        .mockResolvedValueOnce({ status: 'running' as const, blockedReason: 'credentials_locked' })
        .mockResolvedValueOnce({ status: 'failed' as const, error: { code: 'PROVIDER_ERROR', message: 'failed', retryable: false } })
        .mockResolvedValue({ status: 'running' as const, progress: 0.2 }),
      cancel: vi.fn(async () => {}),
      ackTerminal,
    } as Partial<ModelJobExecutor>);
    const store = createModelJobStore({
      storage,
      executor,
      commitProjectTransaction: vi.fn(async () => ({ committed: true, resultNodeId: '' })),
      now: fixedNow,
      pollIntervalMs: 0,
    });
    await store.enqueueConfirmedJobs({
      conversationId: 'agent-conversation-shared',
      confirmedAt,
      requests: [
        request({ id: 'job-locked-running' }),
        request({ id: 'job-failed-ack' }),
        request({ id: 'job-cancelled-ack' }),
      ],
    });
    await storage.put({ ...(await storage.get('job-locked-running'))!, status: 'running', providerTaskId: 'provider-job-locked-running' });
    await storage.put({ ...(await storage.get('job-failed-ack'))!, status: 'running', providerTaskId: 'provider-job-failed-ack' });
    await storage.put({ ...(await storage.get('job-cancelled-ack'))!, status: 'running', providerTaskId: 'provider-job-cancelled-ack' });

    await store.pollActiveJobs();
    await store.pollActiveJobs();
    await store.cancelQueuedJob('job-cancelled-ack');

    const lockedJob = await storage.get('job-locked-running');
    expect(lockedJob?.status).toBe('running');
    expect(lockedJob).not.toHaveProperty('error');
    expect(await storage.get('job-failed-ack')).toMatchObject({ status: 'failed' });
    expect(await storage.get('job-cancelled-ack')).toMatchObject({ status: 'cancelled' });
    expect(ackedStatuses.sort()).toEqual(['cancelled', 'failed']);
  });

  it('keeps provider ACK pending after failures and replays it on recovery', async () => {
    const storage = createInMemoryModelJobStorage();
    let project = createStarterProject();
    const commitProjectTransaction = vi.fn(async (build) => {
      const materialization = build(project);
      project = applyProjectTransaction(project, materialization.transaction);
      return { committed: true, resultNodeId: materialization.resultNodeId };
    });
    const ackTerminal = vi.fn()
      .mockRejectedValueOnce(new Error('temporary ACK outage'))
      .mockResolvedValueOnce(undefined);
    const executor = createExecutor({
      poll: vi.fn(async (job) => ({
        status: 'completed' as const,
        result: { assetId: `asset-${job.id}` },
      })),
      ackTerminal,
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
      requests: [request({ id: 'job-ack-replay' })],
    });
    await storage.put({
      ...(await storage.get('job-ack-replay'))!,
      status: 'running',
      providerTaskId: 'provider-job-ack-replay',
    });

    await store.pollActiveJobs();
    expect(await storage.get('job-ack-replay')).toMatchObject({
      status: 'completed',
      providerAckPending: true,
      terminalStatus: 'completed',
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

    expect(ackTerminal).toHaveBeenCalledTimes(2);
    expect(await storage.get('job-ack-replay')).toMatchObject({
      status: 'completed',
      providerAckPending: false,
    });
  });

  it('does not mark terminal jobs ACK pending when the executor has no ACK channel', async () => {
    const storage = createInMemoryModelJobStorage();
    let project = createStarterProject();
    const commitProjectTransaction = vi.fn(async (build) => {
      const materialization = build(project);
      project = applyProjectTransaction(project, materialization.transaction);
      return { committed: true, resultNodeId: materialization.resultNodeId };
    });
    const store = createModelJobStore({
      storage,
      executor: createExecutor({
        poll: vi.fn(async (job) => ({
          status: 'completed' as const,
          result: { assetId: `asset-${job.id}` },
        })),
      }),
      commitProjectTransaction,
      getProject: () => project,
      now: fixedNow,
      pollIntervalMs: 0,
    });
    await store.enqueueConfirmedJobs({
      conversationId: 'agent-conversation-shared',
      confirmedAt,
      requests: [request({ id: 'job-no-ack-channel' })],
    });
    await storage.put({
      ...(await storage.get('job-no-ack-channel'))!,
      status: 'running',
      providerTaskId: 'provider-job-no-ack-channel',
    });

    await store.pollActiveJobs();

    expect(await storage.get('job-no-ack-channel')).toMatchObject({
      status: 'completed',
      resultAssetId: 'asset-job-no-ack-channel',
    });
    expect(await storage.get('job-no-ack-channel')).not.toMatchObject({
      providerAckPending: true,
      terminalStatus: 'completed',
    });
  });

  it('clears stale ACK-pending terminal markers during recovery when no ACK channel is available', async () => {
    const storage = createInMemoryModelJobStorage([{
      ...request({ id: 'job-stale-ack-pending' }),
      conversationId: 'agent-conversation-shared',
      confirmedAt,
      createdAt: confirmedAt,
      updatedAt: confirmedAt,
      status: 'completed',
      retryCount: 0,
      providerTaskId: 'provider-job-stale-ack-pending',
      resultAssetId: 'asset-job-stale-ack-pending',
      providerAckPending: true,
      terminalStatus: 'completed',
    } as ModelJob]);
    const store = createModelJobStore({
      storage,
      executor: createExecutor({ ackTerminal: undefined }),
      commitProjectTransaction: vi.fn(async () => ({ committed: true, resultNodeId: '' })),
      now: fixedNow,
      pollIntervalMs: 0,
    });

    await store.recover();

    expect(await storage.get('job-stale-ack-pending')).toMatchObject({
      status: 'completed',
      providerAckPending: false,
      terminalStatus: undefined,
    });
  });

  it('honors provider terminal returned from cancel instead of overwriting first terminal', async () => {
    const storage = createInMemoryModelJobStorage();
    let project = createStarterProject();
    const commitProjectTransaction = vi.fn(async (build) => {
      const materialization = build(project);
      project = applyProjectTransaction(project, materialization.transaction);
      return { committed: true, resultNodeId: materialization.resultNodeId };
    });
    const ackTerminal = vi.fn(async () => undefined);
    const executor = createExecutor({
      cancel: vi.fn(async (job) => ({
        status: 'completed' as const,
        progress: 1,
        result: { assetId: `asset-${job.id}` },
      })),
      ackTerminal,
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
      requests: [request({ id: 'job-cancel-completed-race' })],
    });
    await storage.put({
      ...(await storage.get('job-cancel-completed-race'))!,
      status: 'running',
      providerTaskId: 'provider-job-cancel-completed-race',
    });

    await store.cancelQueuedJob('job-cancel-completed-race');

    expect(await storage.get('job-cancel-completed-race')).toMatchObject({
      status: 'completed',
      resultAssetId: 'asset-job-cancel-completed-race',
    });
    expect(project.nodes.some((node) => node.type === 'image_result' && node.data.jobId === 'job-cancel-completed-race')).toBe(true);
    expect(ackTerminal).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed',
      providerTaskId: 'provider-job-cancel-completed-race',
    }));
  });

  it('cancels a stale running job when its provider result cannot be committed to the active project', async () => {
    const storage = createInMemoryModelJobStorage();
    const executor = createExecutor({
      cancel: vi.fn(async (job) => ({
        status: 'completed' as const,
        progress: 1,
        result: { assetId: `asset-${job.id}` },
      })),
    });
    const store = createModelJobStore({
      storage,
      executor,
      canContinueResult: vi.fn(async () => false),
      commitProjectTransaction: vi.fn(async () => ({ committed: false, resultNodeId: '' })),
      now: fixedNow,
      pollIntervalMs: 0,
    });
    await store.enqueueConfirmedJobs({
      conversationId: 'agent-conversation-shared',
      confirmedAt,
      requests: [request({ id: 'job-cancel-stale-completed' })],
    });
    await storage.put({
      ...(await storage.get('job-cancel-stale-completed'))!,
      status: 'running',
      providerTaskId: 'provider-job-cancel-stale-completed',
    });

    await store.cancelQueuedJob('job-cancel-stale-completed');

    expect(await storage.get('job-cancel-stale-completed')).toMatchObject({ status: 'cancelled' });
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
    const submit = vi.fn(async (job: ModelJob) => ({ providerTaskId: `task-${job.id}` }));
    const executor = createExecutor({ cancel, submit });
    const store = createModelJobStore({
      storage,
      executor,
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
    await store.retryJob('job-cancel');

    const jobs = await store.listJobs();
    const retries = jobs.filter((job) => job.id !== 'job-fail' && job.id !== 'job-cancel');
    expect(await storage.get('job-fail')).toMatchObject({ status: 'failed', retryCount: 0 });
    expect(await storage.get('job-cancel')).toMatchObject({ status: 'cancelled' });
    expect(retries).toHaveLength(2);
    expect(new Set(retries.map((job) => job.id)).size).toBe(2);
    expect(retries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: expect.stringMatching(/^model-job-v2-[a-f0-9]{32}$/u),
        prompt: 'Generate a product image',
        queueIndex: 0,
        retryCount: 1,
        status: 'queued',
      }),
      expect.objectContaining({
        id: expect.stringMatching(/^model-job-v2-[a-f0-9]{32}$/u),
        queueIndex: 1,
        retryCount: 1,
        status: 'queued',
      }),
    ]));
    expect(JSON.stringify(jobs)).not.toMatch(/Authorization|C:\\\\Users|secret/i);
    expect(cancel).not.toHaveBeenCalled();

    await store.processQueue();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls.map(([job]) => job.id).sort()).toEqual(retries.map((job) => job.id).sort());
  });

  it('coalesces concurrent retries from the same terminal job into one paid run identity', async () => {
    const baseStorage = createInMemoryModelJobStorage();
    let blockRetryWrite = false;
    let releaseRetryWrite!: () => void;
    let markRetryWriteEntered!: () => void;
    const retryWriteEntered = new Promise<void>((resolve) => { markRetryWriteEntered = resolve; });
    const retryWriteGate = new Promise<void>((resolve) => { releaseRetryWrite = resolve; });
    const storage = {
      ...baseStorage,
      bulkPut: async (jobs: ModelJob[]) => {
        if (blockRetryWrite) {
          blockRetryWrite = false;
          markRetryWriteEntered();
          await retryWriteGate;
        }
        await baseStorage.bulkPut(jobs);
      },
    };
    const submit = vi.fn(async (job: ModelJob) => ({ providerTaskId: `task-${job.id}` }));
    const store = createModelJobStore({
      storage,
      executor: createExecutor({ submit }),
      commitProjectTransaction: vi.fn(),
      now: fixedNow,
    });
    await store.enqueueConfirmedJobs({
      conversationId: 'agent-conversation-shared',
      confirmedAt,
      requests: [request({ id: 'job-concurrent-retry' })],
    });
    await baseStorage.put({ ...(await baseStorage.get('job-concurrent-retry'))!, status: 'failed' });
    blockRetryWrite = true;

    const first = store.retryJob('job-concurrent-retry');
    await retryWriteEntered;
    const second = store.retryJob('job-concurrent-retry');
    releaseRetryWrite();
    await Promise.all([first, second]);

    const retries = (await store.listJobs()).filter((job) => job.id !== 'job-concurrent-retry');
    expect(retries).toHaveLength(1);
    expect(retries[0]?.id).toMatch(/^model-job-v2-[a-f0-9]{32}$/u);
    await store.processQueue();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ id: retries[0]?.id }));
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
    ...overrides,
  };
}

function fixedNow() {
  return '2026-07-16T08:05:00.000Z';
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function createExecutor(overrides: Partial<ModelJobExecutor> = {}): ModelJobExecutor {
  return {
    submit: overrides.submit ?? vi.fn(async (job) => ({ providerTaskId: `task-${job.id}` })),
    poll: overrides.poll ?? vi.fn(async () => ({ status: 'running' as const, progress: 0.5 })),
    cancel: overrides.cancel ?? vi.fn(async () => {}),
    ackTerminal: overrides.ackTerminal,
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
