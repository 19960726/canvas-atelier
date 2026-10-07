import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyProjectTransaction, createCanvasModuleNode, parseCanvasProject, type CanvasModuleNode, type ModelJob } from '@agent-canvas/domain';
import { JournalWriter, readValidJournal, replayJournal, resetJournalWriterRegistryForTests } from '../../../../packages/desktop-core/src/journal-writer';
import * as jobStoreModule from '../jobs/job-store';
import {
  createStarterProject, replaceLayeringRouteEvidenceForTests, replaceModelJobExecutorForTests,
  replaceModelJobStorageForTests, replaceProjectPersistenceClientForTests, resetAppStoreForTests, useAppStore,
} from './app-store';
import { createBrowserPersistenceClient, type ProjectCommitRequest, type ProjectCommitResult } from './desktop-persistence';
import { buildLayeringGraphTransaction } from './layering-graph';
import { confirmLayeringPlan, type LayeringPlan } from './layering-plan';

const createRealJobStore = jobStoreModule.createModelJobStore;
const groupId = 'bind-recovery';
const sessionId = 'bind-recovery-session';

beforeEach(() => {
  delete window.novusDesktop;
  localStorage.clear();
  sessionStorage.clear();
  resetJournalWriterRegistryForTests();
  replaceProjectPersistenceClientForTests(createBrowserPersistenceClient());
  resetAppStoreForTests({ project: 'empty' });
  // Exercise real enqueue, cancel, retry and persistence while keeping workers idle.
  vi.spyOn(jobStoreModule, 'createModelJobStore').mockImplementation(options => {
    const store = createRealJobStore(options);
    vi.spyOn(store, 'run').mockResolvedValue(undefined);
    return store;
  });
});

afterEach(() => {
  resetAppStoreForTests({ project: 'empty' });
  resetJournalWriterRegistryForTests();
  vi.restoreAllMocks();
  delete window.novusDesktop;
});

describe('durable image layering binding recovery', () => {
  it('preserves the confirmed planned graph when its held task binding cannot be saved', async () => {
    const f = await fixture();
    expect(await f.create()).toBe(true);
    const confirmed = useAppStore.getState().project;
    f.failNextBinding();

    expect(await f.start()).toBe(false);

    expect([...f.jobs.values()]).toHaveLength(2);
    expect([...f.jobs.values()].map(job => job.status)).toEqual(['cancelled', 'cancelled']);
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.poll).not.toHaveBeenCalled();
    expect(useAppStore.getState().project).toEqual(confirmed);
    expect(useAppStore.getState().canRetryProjectCommit).toBe(false);
    expect(f.members().map(node => node.data.config.status)).toEqual(['planned', 'planned', 'planned']);
    expect(f.layers().every(node => node.data.config.jobId === undefined)).toBe(true);
    expect((await f.replay()).project).toEqual(confirmed);
  });

  it('can start the same confirmation after a failed bind and the project save retry path', async () => {
    const f = await fixture();
    expect(await f.create()).toBe(true);
    f.failNextBinding();
    expect(await f.start()).toBe(false);
    const cancelledIds = [...f.jobs.keys()];
    const originalFailedBinding = f.commit.mock.calls[f.commit.mock.calls.length - 1]![0];

    // The public save retry must never durably restore a binding to cancelled work.
    await useAppStore.getState().retryFailedProjectCommit();
    const restarted = await f.start();

    expect(f.submit).not.toHaveBeenCalled();
    expect(f.poll).not.toHaveBeenCalled();
    expect(restarted).toBe(true);
    expect(f.layers()).toHaveLength(2);
    for (const layer of f.layers()) {
      const jobId = String(layer.data.config.jobId);
      expect(cancelledIds).not.toContain(jobId);
      expect(f.jobs.get(jobId)).toMatchObject({ status: 'queued', projectId: f.project.id,
        projectSessionId: sessionId, promptNodeId: layer.id, layeringGroupId: groupId,
        layeringLayerId: layer.data.config.layerId });
    }
    expect(useAppStore.getState().canRetryProjectCommit).toBe(false);
    expect(useAppStore.getState().saveStatus).toBe('saved');
    expect((await f.replay()).project).toEqual(useAppStore.getState().project);
    expect(f.journalFailures).toEqual([]);
    expect(f.commit.mock.calls.filter(([request]) => request === originalFailedBinding)).toHaveLength(1);
  });

  it('keeps the original failed layer and result retryable after a replacement task bind fails', async () => {
    const f = await fixture(true);
    const previous = f.layers().find(layer => layer.data.config.layerId === 'cup')!;
    const previousGroup = f.members().find(node => node.data.moduleType === 'image_layering')!;
    f.failNextBinding();

    await useAppStore.getState().retryModelJob(f.failedJob!.id);
    const rejectedRetry = [...f.jobs.values()].find(job => job.id !== f.failedJob!.id)!;
    expect(rejectedRetry).toMatchObject({ status: 'cancelled', retryCount: 1 });
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.poll).not.toHaveBeenCalled();
    expect.soft(f.layers().find(layer => layer.id === previous.id)).toEqual(previous);
    expect.soft(f.members().find(node => node.id === previousGroup.id)).toEqual(previousGroup);

    await useAppStore.getState().retryFailedProjectCommit();
    await useAppStore.getState().retryModelJob(f.failedJob!.id);

    const current = f.layers().find(layer => layer.id === previous.id)!;
    const replacement = f.jobs.get(String(current.data.config.jobId));
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.poll).not.toHaveBeenCalled();
    expect(current.data.config.jobId).not.toBe(rejectedRetry.id);
    expect(current.data.config).toMatchObject({ status: 'queued', qualityStatus: 'pending' });
    expect(replacement).toMatchObject({ status: 'queued', retryCount: 1, projectId: f.project.id,
      projectSessionId: sessionId, promptNodeId: previous.id, layeringGroupId: groupId, layeringLayerId: 'cup' });
    expect(f.jobs.get(f.failedJob!.id)).toMatchObject({ status: 'failed', resultAssetId: 'c'.repeat(16) });
    for (const key of ['resultAssetId', 'resultJobId', 'resultWidth', 'resultHeight', 'qualityReason']) {
      expect(current.data.config).not.toHaveProperty(key);
      expect(previous.data.config).toHaveProperty(key);
    }
    expect(useAppStore.getState().canRetryProjectCommit).toBe(false);
    expect(useAppStore.getState().saveStatus).toBe('saved');
    expect((await f.replay()).project).toEqual(useAppStore.getState().project);
    expect(f.journalFailures).toEqual([]);
  });
});

async function fixture(withFailedLayer = false) {
  const sourceAssetId = 'a'.repeat(16);
  const sourceAsset = { assetId: sourceAssetId, byteSize: 16, extension: 'png' as const, height: 24, width: 24,
    label: 'Source fixture', mediaType: 'image/png' as const, origin: 'imported' as const, sha256: 'a'.repeat(64) };
  const source = createCanvasModuleNode('bind-source', 'image_input', { x: 0, y: 0 });
  source.data.config.assetId = sourceAssetId;
  const plan: LayeringPlan = { sourceAssetId, canvasWidth: 24, canvasHeight: 24, pixelMode: 'source', layers: [
    { layerId: 'background', kind: 'background', name: 'Background', description: 'Restore the complete background', included: true },
    { layerId: 'cup', kind: 'transparent', name: 'Cup', description: 'Only the cup', included: true,
      sourceBounds: { x: .1, y: .1, width: .5, height: .5 } },
  ] };
  const confirmation = await confirmLayeringPlan(plan, 'comfly', 'comfly-gpt-image-2', '1K', '2026-10-06T02:00:00.000Z');
  const baseProject = parseCanvasProject({ ...createStarterProject(), id: 'bind-recovery-project', name: 'Layer binding recovery',
    nodes: [source], edges: [], assets: [sourceAsset] });
  const failedJob: ModelJob | undefined = withFailedLayer ? {
    id: 'original-failed-layer', kind: 'image', conversationId: `image-layering-${groupId}`, projectId: baseProject.id,
    projectSessionId: sessionId, promptNodeId: `image-layer-${groupId}-cup`, prompt: 'Retry fixture cup',
    displayName: 'GPT Image 2', modelId: 'gpt-image-2', modelRoute: 'comfly-gpt-image-2', provider: 'comfly',
    referenceAssetIds: [sourceAssetId], retryCount: 0, status: 'failed', resultAssetId: 'c'.repeat(16),
    layeringGroupId: groupId, layeringLayerId: 'cup', resolution: '1K', imageOutputFormat: 'png',
    imageBackground: 'transparent', outputCount: 1,
  } : undefined;
  const graph = withFailedLayer
    ? applyProjectTransaction(baseProject, buildLayeringGraphTransaction(baseProject, plan, confirmation, groupId, source.id))
    : baseProject;
  const project = withFailedLayer ? parseCanvasProject({ ...graph, nodes: graph.nodes.map(node => {
    if (node.type !== 'module' || node.data.config.groupId !== groupId) return node;
    if (node.data.moduleType === 'image_layering') return { ...node, data: { ...node.data, config: { ...node.data.config, status: 'failed' } } };
    if (node.data.config.layerId !== 'cup') return node;
    return { ...node, data: { ...node.data, config: { ...node.data.config, jobId: failedJob!.id, status: 'failed',
      qualityStatus: 'failed', qualityReason: 'dimensions', resultAssetId: failedJob!.resultAssetId,
      resultJobId: failedJob!.id, resultWidth: 12, resultHeight: 12 } } };
  }) }) : graph;
  const root = await mkdtemp(join(process.cwd(), 'work', 'repair-185', 'layering-bind-recovery-'));
  const journalPath = join(root, 'active.ndjson');
  await writeFile(journalPath, '', 'utf8');
  const writer = await JournalWriter.open({ activeJournalPath: journalPath, baseRevision: 0, nextSequence: 1, projectId: project.id });
  let rejectNextBinding = false;
  const journalFailures: Array<{ code: string; message: string }> = [];
  const commit = vi.fn(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => {
    const binding = /^(?:bind-image-layering-jobs-|retry-image-layer-)/u.test(request.transaction.id);
    if (binding && rejectNextBinding) {
      rejectNextBinding = false;
      return { ok: false, code: 'DURABLE_WRITE_FAILED', retryable: true,
        project: request.previousProject, revision: request.baseRevision };
    }
    try {
      const acknowledgement = await writer.commit(request);
      return { ok: true, project: request.nextProject, revision: acknowledgement.revision };
    } catch (error) {
      const failure = error as { code: 'INVALID_REQUEST'; message: string; retryable: boolean };
      journalFailures.push({ code: failure.code, message: failure.message });
      return { ok: false, code: failure.code, retryable: failure.retryable,
        project: request.previousProject, revision: request.baseRevision };
    }
  });
  const jobs = new Map<string, ModelJob>(failedJob ? [[failedJob.id, failedJob]] : []);
  replaceModelJobStorageForTests({ get: async id => jobs.get(id), list: async () => [...jobs.values()],
    put: async job => { jobs.set(job.id, job); }, bulkPut: async batch => { for (const job of batch) jobs.set(job.id, job); } });
  const submit = vi.fn(async () => ({ providerTaskId: 'must-not-submit' }));
  const poll = vi.fn(async () => ({ status: 'failed' as const, error: 'must-not-poll' }));
  replaceModelJobExecutorForTests({ submit, poll });
  replaceProjectPersistenceClientForTests({ ...createBrowserPersistenceClient(), commit,
    ensureModelExecutionSession: async () => sessionId, getSessionId: () => sessionId });
  replaceLayeringRouteEvidenceForTests([{ provider: 'comfly', modelRoute: 'comfly-gpt-image-2', modelId: 'gpt-image-2',
    source: 'live_alpha_qa', verifiedAt: confirmation.confirmedAt, transparentBackground: true, outputFormat: 'png', resolutions: ['1K'] }]);
  window.novusDesktop = { provider: {
    getStatus: async () => ({ configured: true, locked: false, encryption: 'safeStorage' }),
    listProfiles: async () => [{ provider: 'comfly', modelRoute: 'comfly-gpt-image-2', modelId: 'gpt-image-2',
      displayName: 'GPT Image 2', capabilities: ['image_generation', 'image_edit', 'async_tasks'], capabilityStatus: 'complete',
      constraints: { image: { resolutions: ['1K'] } } }],
  } } as never;
  useAppStore.setState({ project, desktopRevision: 0, projectLifecycle: 'durable', persistenceMode: 'desktop',
    saveStatus: 'saved', projectImages: [{ ...sourceAsset, displayUrl: 'source-fixture', usageCount: 1 }],
    modelJobs: failedJob ? [failedJob] : [] });
  const members = () => useAppStore.getState().project.nodes.filter((node): node is CanvasModuleNode =>
    node.type === 'module' && node.data.config.groupId === groupId);
  return { project, jobs, failedJob, submit, poll, commit, journalFailures, members,
    layers: () => members().filter(node => node.data.moduleType === 'image_layer'),
    create: () => useAppStore.getState().createConfirmedLayeringGroup({ plan, confirmation, groupId, sourceNodeId: source.id }),
    start: () => useAppStore.getState().startConfirmedLayering({ plan, confirmation, groupId }),
    failNextBinding: () => { rejectNextBinding = true; },
    replay: async () => replayJournal(project, 0, (await readValidJournal(journalPath)).records),
  };
}
