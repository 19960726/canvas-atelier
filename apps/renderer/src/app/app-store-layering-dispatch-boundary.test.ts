import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyProjectTransaction, createCanvasModuleNode, parseCanvasProject, type CanvasModuleNode, type CanvasProject, type ModelJob } from '@agent-canvas/domain';
import * as jobStoreModule from '../jobs/job-store';
import type { ModelJobStore } from '../jobs/job-store';
import {
  createStarterProject, replaceLayeringRouteEvidenceForTests, replaceModelJobExecutorForTests,
  replaceModelJobStorageForTests, replaceProjectPersistenceClientForTests, resetAppStoreForTests, useAppStore,
} from './app-store';
import { createBrowserPersistenceClient, type ProjectCommitRequest, type ProjectCommitResult } from './desktop-persistence';
import { buildLayeringGraphTransaction } from './layering-graph';
import { confirmLayeringPlan, type LayeringPlan } from './layering-plan';

const realCreateJobStore = jobStoreModule.createModelJobStore;
const groupId = 'dispatch-boundary';
const sessionId = 'dispatch-boundary-session';
const sourceAssetId = 'a'.repeat(16);
const changedDigest = 'b'.repeat(64);
let ownedStore: ModelJobStore | undefined;
let fixtureJobGate: ((job: ModelJob) => boolean) | undefined;
const dispatchDrifts = ['source-summary-sha', 'managed-source-sha', 'same-project-session', 'same-project-reset',
  'group-digest', 'layer-digest', 'group-contract', 'layer-contract', 'child-name', 'child-bounds',
  'child-elements', 'sibling-contract', 'group-elements'] as const;
type DispatchDrift = typeof dispatchDrifts[number] | 'child-job-id';
const requestDrifts = ['prompt', 'provider', 'modelRoute', 'modelId', 'referenceAssetIds', 'aspectRatio', 'resolution',
  'imageQuality', 'imageOutputFormat', 'imageBackground', 'outputCount'] as const;
type RequestDrift = typeof requestDrifts[number];

beforeEach(() => {
  delete window.novusDesktop;
  localStorage.clear();
  sessionStorage.clear();
  replaceProjectPersistenceClientForTests(createBrowserPersistenceClient());
  resetAppStoreForTests({ project: 'empty' });
  ownedStore = undefined;
  fixtureJobGate = undefined;
  vi.spyOn(jobStoreModule, 'createModelJobStore').mockImplementation(options => {
    const shouldProcessJob = options.shouldProcessJob;
    ownedStore = realCreateJobStore({ ...options, shouldProcessJob: job =>
      shouldProcessJob?.(job) !== false && fixtureJobGate?.(job) !== false });
    return ownedStore;
  });
});

afterEach(() => {
  ownedStore?.stop();
  resetAppStoreForTests({ project: 'empty' });
  vi.restoreAllMocks();
  delete window.novusDesktop;
});

describe('actual layering provider dispatch boundary', () => {
  it('allows the exact own binding ACK and completes each normal confirmed task once', async () => {
    const f = await fixture();
    const guard = f.executionGuard();

    expect(await f.start(guard)).toBe(true);
    await f.settle();

    expect(f.submittingWrites()).toBe(2);
    expect(f.submit).toHaveBeenCalledTimes(2);
    expect(f.poll).toHaveBeenCalledTimes(2);
    for (const layerId of ['background', 'cup']) {
      expect(f.submit.mock.calls.filter(([job]) => job.layeringLayerId === layerId)).toHaveLength(1);
      expect([...f.jobs.values()].find(job => job.layeringLayerId === layerId)).toMatchObject({
        status: 'completed', layeringConfirmationDigest: f.confirmation.digest,
      });
    }
    expect(f.commit.mock.calls[0]![0].transaction.id).toBe(`bind-image-layering-jobs-${groupId}`);
    expect(f.allowed()).toBe(true);
  });

  it('stops paid dispatch when authorization is revoked by the real submitting storage write', async () => {
    const f = await fixture({ revokeOnSubmitting: true });
    const guard = f.executionGuard();

    expect(await f.start(guard)).toBe(true);
    await f.settle();

    expect(f.submittingWrites()).toBeGreaterThan(0);
    expect(f.allowed()).toBe(false);
    expect(f.commit.mock.calls[0]![0].transaction.id).toBe(`bind-image-layering-jobs-${groupId}`);
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.poll).not.toHaveBeenCalled();
    expect([...f.jobs.values()]).toHaveLength(2);
    expect([...f.jobs.values()].every(job => job.status === 'cancelled')).toBe(true);
    expect(f.layers().every(layer => f.jobs.get(String(layer.data.config.jobId))?.status === 'cancelled')).toBe(true);
  });

  it.each(dispatchDrifts)('stops all provider calls after %s changes in the actual submitting write', async drift => {
    const f = await fixture({ driftOnSubmitting: drift });

    expect(await f.start(f.executionGuard())).toBe(true);
    await f.settle();

    expect(f.submittingWrites()).toBeGreaterThan(0);
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.poll).not.toHaveBeenCalled();
    expect([...f.jobs.values()]).toHaveLength(2);
    expect([...f.jobs.values()].every(job => job.status === 'cancelled')).toBe(true);
    const writes = f.submittingWrites();
    await f.settle();
    expect(f.submittingWrites()).toBe(writes);
    expect(f.submit).not.toHaveBeenCalled();
  });

  it.each(requestDrifts)('rejects %s mutation in the actual queued request before provider dispatch', async drift => {
    const f = await fixture({ requestDriftOnSubmitting: drift });

    expect(await f.start(f.executionGuard())).toBe(true);
    await f.settle();

    expect(f.submittingWrites()).toBe(2);
    expect(f.requestMutationWrites()).toBe(2);
    expect(f.allowed()).toBe(true);
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.poll).not.toHaveBeenCalled();
    expect([...f.jobs.values()]).toHaveLength(2);
    expect([...f.jobs.values()].every(job => job.status === 'cancelled')).toBe(true);
    expect(f.layers().every(layer => f.jobs.get(String(layer.data.config.jobId))?.status === 'cancelled')).toBe(true);
    const writes = f.submittingWrites();
    await f.settle();
    expect(f.submittingWrites()).toBe(writes);
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.poll).not.toHaveBeenCalled();
  });

  it('finishes both confirmed tasks after successful dialog closure invalidates its old execution guard', async () => {
    const f = await fixture({ closeDialogOnSubmitting: true });
    const executionGuard = f.executionGuard();

    expect(await f.start(executionGuard)).toBe(true);
    await f.settle();

    expect(f.dialogOpen()).toBe(false);
    expect(executionGuard()).toBe(false);
    expect(f.allowed()).toBe(true);
    expect(f.submit).toHaveBeenCalledTimes(2);
    expect(f.poll).toHaveBeenCalledTimes(2);
    expect([...f.jobs.values()].every(job => job.status === 'completed')).toBe(true);
  });

  it('submits the second layer after the first completes and legitimately changes group review state', async () => {
    const f = await fixture({ serialLayers: true });

    expect(await f.start(f.executionGuard())).toBe(true);
    await f.settle();

    expect(f.submit).toHaveBeenCalledTimes(2);
    expect(f.submit.mock.calls.map(([job]) => job.layeringLayerId)).toEqual(['background', 'cup']);
    expect(f.dispatchObservations[1]).toMatchObject({ layerId: 'cup', backgroundStatus: 'completed',
      groupNeedsReconfirm: true, groupResultState: 'needs_review' });
    expect(f.poll).toHaveBeenCalledTimes(2);
    expect([...f.jobs.values()].every(job => job.status === 'completed')).toBe(true);
  });

  it('blocks a task after its own layer job binding changes while preserving its valid sibling', async () => {
    const f = await fixture({ driftOnSubmitting: 'child-job-id', serialLayers: true });

    expect(await f.start(f.executionGuard())).toBe(true);
    await f.settle();

    expect(f.submit.mock.calls.map(([job]) => job.layeringLayerId)).toEqual(['background']);
    expect(f.poll.mock.calls.map(([job]) => job.layeringLayerId)).toEqual(['background']);
    expect([...f.jobs.values()].find(job => job.layeringLayerId === 'background')?.status).toBe('completed');
    expect(f.layer().data.config.jobId).toBe('unconfirmed-replacement-job');
  });

  it('preserves a queued sibling through a failed layer retry and later dispatches it once', async () => {
    const f = await fixture({ failFirstCup: true, holdBackground: true });
    expect(await f.start(f.executionGuard())).toBe(true);
    await f.settle();
    const failed = [...f.jobs.values()].find(job => job.layeringLayerId === 'cup')!;
    const sibling = [...f.jobs.values()].find(job => job.layeringLayerId === 'background')!;
    expect(failed.status).toBe('failed');
    expect(sibling.status).toBe('queued');
    useAppStore.setState(state => ({ project: { ...state.project, nodes: state.project.nodes.map(node =>
      node.type === 'module' && node.data.moduleType === 'image_layer' && node.data.config.layerId === 'background'
        ? { ...node, data: { ...node.data, config: { ...node.data.config,
          semanticReviewAccepted: true, semanticReviewDigest: f.confirmation.digest,
          assemblyConfirmationDigest: f.confirmation.digest } } } : node) } }));

    const binding = f.pauseRetryBinding();
    const retryPending = useAppStore.getState().retryModelJob(failed.id);
    await binding.entered.promise;
    expect(f.jobs.get(sibling.id)?.status).toBe('queued');
    expect(f.layers().find(node => node.data.config.layerId === 'background')?.data.config.status).toBe('queued');
    expect(f.submit.mock.calls.filter(([job]) => job.layeringLayerId === 'background')).toHaveLength(0);
    binding.release.resolve();
    await retryPending;
    await f.settle();

    const retry = [...f.jobs.values()].find(job => job.layeringLayerId === 'cup' && job.id !== failed.id)!;
    expect(retry.status).toBe('completed');
    expect(f.jobs.get(sibling.id)?.status).toBe('queued');
    expect(f.layers().find(node => node.data.config.layerId === 'background')?.data.config).toMatchObject({
      status: 'queued', needsReconfirm: true,
    });
    expect(f.layers().find(node => node.data.config.layerId === 'background')?.data.config)
      .not.toHaveProperty('semanticReviewAccepted');

    f.releaseBackground();
    await f.settle();

    expect(f.jobs.get(sibling.id)?.status).toBe('completed');
    expect(f.submit.mock.calls.filter(([job]) => job.id === retry.id)).toHaveLength(1);
    expect(f.submit.mock.calls.filter(([job]) => job.id === sibling.id)).toHaveLength(1);
    expect(f.poll.mock.calls.filter(([job]) => job.id === retry.id)).toHaveLength(1);
    expect(f.poll.mock.calls.filter(([job]) => job.id === sibling.id)).toHaveLength(1);
  });
});

describe.each(['failed', 'completed'] as const)('current layering retry contract (%s provider task)', originalStatus => {
  it('retries the same independent RGBA confirmation once while local review is still required', async () => {
    const f = await fixture({ failedLayer: true, originalStatus });
    const original = f.failedJob!;
    expect(original.status).toBe(originalStatus);
    expect(f.layer().data.config.needsReconfirm).toBe(true);

    await useAppStore.getState().retryModelJob(original.id);
    await f.settle();

    expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.poll).toHaveBeenCalledOnce();
    expect(f.submit.mock.calls[0]![0]).toMatchObject({
      layeringOutputContract: 'source-independent-rgba-v2', layeringConfirmationDigest: f.confirmation.digest,
      referenceAssetIds: [sourceAssetId],
    });
    expect([...f.jobs.values()].find(job => job.id !== original.id)).toMatchObject({ status: 'completed' });
    expect(f.layer().data.config.resultRepresentation).toBe('independent-rgba-candidate');
    expect(f.layer().data.config.needsReconfirm).toBe(true);
  });

  it('coalesces concurrent retries of one layer into one bound provider task', async () => {
    const f = await fixture({ failedLayer: true, originalStatus });

    await Promise.all([
      useAppStore.getState().retryModelJob(f.failedJob!.id),
      useAppStore.getState().retryModelJob(f.failedJob!.id),
    ]);
    await f.settle();

    const retries = [...f.jobs.values()].filter(job => job.id !== f.failedJob!.id);
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ status: 'completed', retryCount: 1 });
    expect(f.layer().data.config.jobId).toBe(retries[0]!.id);
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.poll).toHaveBeenCalledTimes(1);
  });

  it('keeps local corrected pixels but refuses the original request after source bounds change before retry', async () => {
    const f = await fixture({ failedLayer: true, originalStatus });
    const bounds = { x: .1, y: .1, width: .7, height: .5 };
    const resultAssetId = f.layer().data.config.resultAssetId;
    await useAppStore.getState().alignSourceLayers(`image-layering-${groupId}`, f.project.id, { cup: bounds });
    const corrected = useAppStore.getState().project;
    expect(f.layer().data.config).toMatchObject({ sourceBounds: bounds, resultAssetId,
      jobId: f.failedJob!.id, needsReconfirm: true });

    await useAppStore.getState().retryModelJob(f.failedJob!.id);
    await f.settle();

    expect(f.submit).not.toHaveBeenCalled();
    expect(f.poll).not.toHaveBeenCalled();
    expect([...f.jobs.values()]).toEqual([f.failedJob]);
    expect(useAppStore.getState().project).toEqual(corrected);
    expect(f.commit).toHaveBeenCalledTimes(1);
  });

  it.each(['layer-digest', 'group-digest', 'layer-contract', 'group-contract', 'group-source'] as const)(
    'rejects an old task when the current %s has changed', async drift => {
      const f = await fixture({ failedLayer: true, originalStatus });
      const previous = useAppStore.getState().project;
      const next = { ...previous, nodes: previous.nodes.map(node => {
        if (node.type !== 'module' || node.data.config.groupId !== groupId) return node;
        const config = { ...node.data.config };
        if (node.data.moduleType === 'image_layer' && node.data.config.layerId === 'cup') {
          if (drift === 'layer-digest') config.layeringConfirmationDigest = changedDigest;
          if (drift === 'layer-contract') config.layeringOutputContract = 'source-alpha-matte-v1';
        }
        if (node.data.moduleType === 'image_layering') {
          if (drift === 'group-digest') config.layeringConfirmationDigest = changedDigest;
          if (drift === 'group-contract') config.foregroundOutputContract = 'source-alpha-matte-v1';
          if (drift === 'group-source') config.sourceAssetId = 'b'.repeat(16);
        }
        return { ...node, data: { ...node.data, config } };
      }) };
      useAppStore.setState({ project: next });

      await useAppStore.getState().retryModelJob(f.failedJob!.id).catch(() => undefined);
      await f.settle();

      expect(f.submit).not.toHaveBeenCalled();
      expect(f.poll).not.toHaveBeenCalled();
      expect([...f.jobs.values()]).toHaveLength(1);
      expect(f.commit).not.toHaveBeenCalled();
      expect(useAppStore.getState().project).toEqual(next);
    },
  );

  it.each(['child-name', 'child-bounds', 'child-elements', 'group-elements'] as const)(
    'does not retry an old proposal after %s changes while the model catalog is pending', async drift => {
      const f = await fixture({ failedLayer: true, originalStatus });
      const bridge = window.novusDesktop!.provider;
      const listProfiles = bridge.listProfiles.bind(bridge);
      vi.spyOn(bridge, 'listProfiles').mockImplementationOnce(async input => {
        applyDispatchDrift(drift, () => undefined);
        return listProfiles(input);
      });

      await useAppStore.getState().retryModelJob(f.failedJob!.id);
      await f.settle();

      expect(f.submit).not.toHaveBeenCalled();
      expect(f.poll).not.toHaveBeenCalled();
      expect([...f.jobs.values()]).toHaveLength(1);
      expect(f.commit).not.toHaveBeenCalled();
    },
  );
});

it('still retries the unchanged failed request after applying the same original bounds for local review', async () => {
  const f = await fixture({ failedLayer: true });
  const bounds = f.layer().data.config.sourceBounds as LayeringPlan['layers'][number]['sourceBounds'];
  await useAppStore.getState().alignSourceLayers(`image-layering-${groupId}`, f.project.id, { cup: bounds! });

  await useAppStore.getState().retryModelJob(f.failedJob!.id);
  await f.settle();

  expect(f.submit).toHaveBeenCalledTimes(1);
  expect(f.poll).toHaveBeenCalledTimes(1);
  expect([...f.jobs.values()].find(job => job.id !== f.failedJob!.id)).toMatchObject({ status: 'completed' });
});

async function fixture(options: { revokeOnSubmitting?: boolean; failedLayer?: boolean; originalStatus?: 'failed' | 'completed';
  driftOnSubmitting?: DispatchDrift; requestDriftOnSubmitting?: RequestDrift;
  closeDialogOnSubmitting?: boolean; serialLayers?: boolean; failFirstCup?: boolean; holdBackground?: boolean } = {}) {
  const sourceAsset = { assetId: sourceAssetId, byteSize: 16, extension: 'png' as const, height: 24, width: 24,
    label: 'Source fixture', mediaType: 'image/png' as const, origin: 'imported' as const, sha256: 'a'.repeat(64) };
  const source = createCanvasModuleNode('dispatch-source', 'image_input', { x: 0, y: 0 });
  source.data.config.assetId = sourceAssetId;
  const plan: LayeringPlan = { sourceAssetId, canvasWidth: 24, canvasHeight: 24, pixelMode: 'source',
    foregroundOutputContract: 'source-independent-rgba-v2', layers: [
      { layerId: 'background', kind: 'background', name: 'Background', description: 'Restore the complete background', included: true,
        elementIds: ['scene'] },
      { layerId: 'cup', kind: 'transparent', name: 'Cup', description: 'Only the cup', included: true,
        sourceBounds: { x: .1, y: .1, width: .5, height: .5 }, elementIds: ['cup-visible'] },
    ], elements: [
      { elementId: 'scene', name: 'Scene', layerId: 'background', kind: 'object' },
      { elementId: 'cup-visible', name: 'Visible cup', layerId: 'cup', kind: 'object', sourceBounds: { x: .1, y: .1, width: .5, height: .5 } },
    ] };
  const confirmation = await confirmLayeringPlan(plan, 'comfly', 'comfly-gpt-image-2', '1K', '2026-10-06T02:00:00.000Z');
  const baseProject = parseCanvasProject({ ...createStarterProject(), id: 'dispatch-boundary-project', name: 'Layer dispatch fixture',
    nodes: [source], edges: [], assets: [sourceAsset] });
  const graph = applyProjectTransaction(baseProject, buildLayeringGraphTransaction(baseProject, plan, confirmation, groupId, source.id));
  const failedJob: ModelJob | undefined = options.failedLayer ? {
    id: 'original-failed-layer', kind: 'image', conversationId: `image-layering-${groupId}`, projectId: graph.id,
    projectSessionId: sessionId, promptNodeId: `image-layer-${groupId}-cup`, prompt: 'Only the cup from the approved source',
    displayName: 'GPT Image 2', modelId: 'gpt-image-2', modelRoute: 'comfly-gpt-image-2', provider: 'comfly',
    referenceAssetIds: [sourceAssetId], retryCount: 0, status: options.originalStatus ?? 'failed', resultAssetId: 'c'.repeat(16),
    layeringGroupId: groupId, layeringLayerId: 'cup', resolution: '1K', imageOutputFormat: 'png',
    imageBackground: 'transparent', outputCount: 1, layeringOutputContract: 'source-independent-rgba-v2',
    layeringConfirmationDigest: confirmation.digest,
  } : undefined;
  const project = failedJob ? parseCanvasProject({ ...graph, nodes: graph.nodes.map(node => {
    if (node.type !== 'module' || node.data.config.groupId !== groupId) return node;
    if (node.data.moduleType === 'image_layering') return { ...node, data: { ...node.data, config: { ...node.data.config, status: 'failed', needsReconfirm: true } } };
    if (node.data.config.layerId !== 'cup') return node;
    return { ...node, data: { ...node.data, config: { ...node.data.config, jobId: failedJob.id, status: 'failed',
      qualityStatus: 'failed', needsReconfirm: true, qualityReason: 'dimensions', resultAssetId: failedJob.resultAssetId,
      resultJobId: failedJob.id, resultWidth: 12, resultHeight: 12 } } };
  }) }) : graph;
  const jobs = new Map<string, ModelJob>(failedJob ? [[failedJob.id, failedJob]] : []);
  let authorized = true;
  let dialogOpen = true;
  let activeSessionId = sessionId;
  let submittingWrites = 0;
  let requestMutationWrites = 0;
  let backgroundHeld = options.holdBackground === true;
  let retryBinding: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  const dispatchObservations: Array<{ layerId: string | undefined; backgroundStatus: string | undefined;
    groupNeedsReconfirm: unknown; groupResultState: unknown }> = [];
  if (options.serialLayers) fixtureJobGate = job => job.layeringLayerId !== 'cup' || job.status !== 'queued'
    || [...jobs.values()].some(candidate => candidate.layeringLayerId === 'background' && candidate.status === 'completed');
  if (options.holdBackground) fixtureJobGate = job => !backgroundHeld || job.layeringLayerId !== 'background';
  const expectedSubmissionCount = failedJob ? 1 : 2;
  let releaseSubmissions!: () => void;
  const allSubmitted = new Promise<void>(resolve => { releaseSubmissions = resolve; });
  replaceModelJobStorageForTests({ get: async id => jobs.get(id), list: async () => [...jobs.values()],
    put: async job => {
      jobs.set(job.id, job);
      if (job.status === 'submitting') {
        submittingWrites++;
        if (options.requestDriftOnSubmitting) {
          jobs.set(job.id, mutateDispatchRequest(job, options.requestDriftOnSubmitting));
          requestMutationWrites++;
        }
        if (options.revokeOnSubmitting) authorized = false;
        if (options.closeDialogOnSubmitting) dialogOpen = false;
        if (submittingWrites === 1 && options.driftOnSubmitting) applyDispatchDrift(options.driftOnSubmitting,
          () => { activeSessionId = 'replacement-same-project-session'; });
      }
    },
    bulkPut: async batch => { for (const job of batch) jobs.set(job.id, job); },
  });
  let submitCount = 0;
  const submit = vi.fn(async (job: ModelJob) => {
    const group = useAppStore.getState().project.nodes.find(node => node.type === 'module' && node.data.moduleType === 'image_layering');
    dispatchObservations.push({ layerId: job.layeringLayerId,
      backgroundStatus: [...jobs.values()].find(candidate => candidate.layeringLayerId === 'background')?.status,
      groupNeedsReconfirm: group?.type === 'module' ? group.data.config.needsReconfirm : undefined,
      groupResultState: group?.type === 'module' ? group.data.config.resultState : undefined });
    submitCount++;
    if (submitCount >= expectedSubmissionCount) releaseSubmissions();
    return { providerTaskId: `fixture-task-${job.id}` };
  });
  const poll = vi.fn(async (job: ModelJob) => {
    if (options.failFirstCup && job.layeringLayerId === 'cup' && job.retryCount === 0) {
      return { status: 'failed' as const, error: 'Controlled first foreground failure' };
    }
    if (!options.serialLayers) await allSubmitted;
    return { status: 'completed' as const, result: { assetId: job.layeringLayerId === 'background' ? 'd'.repeat(16) : 'e'.repeat(16),
      width: 24, height: 24, resultRepresentation: job.layeringLayerId === 'background'
        ? 'opaque-background-candidate' as const : 'independent-rgba-candidate' as const } };
  });
  const commit = vi.fn(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => {
    if (request.transaction.id.startsWith('retry-image-layer-') && retryBinding) {
      const gate = retryBinding; retryBinding = undefined; gate.entered.resolve(); await gate.release.promise;
    }
    return { ok: true, project: request.nextProject, revision: request.baseRevision + 1 };
  });
  replaceModelJobExecutorForTests({ submit, poll });
  replaceProjectPersistenceClientForTests({ ...createBrowserPersistenceClient(), commit,
    listProjectImages: async () => [{ ...sourceAsset, displayUrl: 'fixture-source', usageCount: 1 }],
    ensureModelExecutionSession: async () => activeSessionId, getSessionId: () => activeSessionId });
  replaceLayeringRouteEvidenceForTests([{ provider: 'comfly', modelRoute: 'comfly-gpt-image-2', modelId: 'gpt-image-2',
    source: 'live_alpha_qa', verifiedAt: confirmation.confirmedAt, transparentBackground: true, outputFormat: 'png', resolutions: ['1K'] }]);
  window.novusDesktop = { provider: {
    getStatus: async () => ({ configured: true, locked: false, encryption: 'safeStorage' }),
    listProfiles: async () => [{ provider: 'comfly', modelRoute: 'comfly-gpt-image-2', modelId: 'gpt-image-2',
      displayName: 'GPT Image 2', capabilities: ['image_generation', 'image_edit', 'async_tasks'], capabilityStatus: 'complete',
      constraints: { image: { resolutions: ['1K'] } } }],
  } } as never;
  useAppStore.setState({ project, desktopRevision: 4, projectLifecycle: 'durable', persistenceMode: 'desktop',
    saveStatus: 'saved', projectImages: [{ ...sourceAsset, displayUrl: 'fixture-source', usageCount: 1 }],
    modelJobs: failedJob ? [failedJob] : [] });
  const layers = () => useAppStore.getState().project.nodes.filter((node): node is CanvasModuleNode =>
    node.type === 'module' && node.data.moduleType === 'image_layer' && node.data.config.groupId === groupId);
  return { plan, confirmation, project, jobs, failedJob, submit, poll, commit, layers, dispatchObservations,
    pauseRetryBinding: () => { const gate = { entered: deferred(), release: deferred() }; retryBinding = gate; return gate; },
    releaseBackground: () => { backgroundHeld = false; },
    layer: () => layers().find(node => node.data.config.layerId === 'cup')!,
    allowed: () => authorized,
    dialogOpen: () => dialogOpen,
    submittingWrites: () => submittingWrites,
    requestMutationWrites: () => requestMutationWrites,
    executionGuard: () => {
      const created = useAppStore.getState();
      const createdRevision = created.desktopRevision;
      const createdSnapshot = JSON.stringify(created.project);
      return (binding?: { readonly project: CanvasProject; readonly revision: number }) => {
        const state = useAppStore.getState();
        if (!authorized || !dialogOpen || state.project.id !== project.id || !state.projectImages.some(asset => asset.assetId === sourceAssetId)) return false;
        return binding ? binding.revision === createdRevision + 1 && state.desktopRevision === binding.revision
          && JSON.stringify(state.project) === JSON.stringify(binding.project)
          : state.desktopRevision === createdRevision && JSON.stringify(state.project) === createdSnapshot;
      };
    },
    start: (executionGuard: (binding?: { readonly project: CanvasProject; readonly revision: number }) => boolean) =>
      useAppStore.getState().startConfirmedLayering({ plan, confirmation, groupId, executionGuard, ...{ dispatchGuard: () => authorized } }),
    settle: async () => {
      for (let attempt = 0; ownedStore && attempt < 10; attempt++) {
        await ownedStore.run();
        await new Promise(resolve => setTimeout(resolve, 0));
        if (![...jobs.values()].some(job => ['queued', 'submitting', 'running'].includes(job.status))) return;
      }
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function mutateDispatchRequest(job: ModelJob, drift: RequestDrift): ModelJob {
  switch (drift) {
    case 'prompt': return { ...job, prompt: `${job.prompt} Unconfirmed extra object.` };
    case 'provider': return { ...job, provider: 'relayme' };
    case 'modelRoute': return { ...job, modelRoute: 'unconfirmed-image-route' };
    case 'modelId': return { ...job, modelId: 'unconfirmed-image-model' };
    // Keep the owned source first so project ownership still passes at the worker boundary.
    case 'referenceAssetIds': return { ...job, referenceAssetIds: [...job.referenceAssetIds, 'b'.repeat(16)] };
    case 'aspectRatio': return { ...job, aspectRatio: job.aspectRatio === '16:9' ? '9:16' : '16:9' };
    case 'resolution': return { ...job, resolution: '2K' };
    case 'imageQuality': return { ...job, imageQuality: job.imageQuality === 'high' ? 'low' : 'high' };
    case 'imageOutputFormat': return { ...job, imageOutputFormat: 'webp' };
    case 'imageBackground': return { ...job, imageBackground: job.imageBackground === 'opaque' ? 'transparent' : 'opaque' };
    case 'outputCount': return { ...job, outputCount: 2 };
  }
}

function applyDispatchDrift(drift: DispatchDrift, changeSession: () => void): void {
  const state = useAppStore.getState();
  if (drift === 'same-project-session') { changeSession(); return; }
  if (drift === 'same-project-reset') {
    useAppStore.setState({ canvasDraftResetKey: state.canvasDraftResetKey + 1 });
    return;
  }
  if (drift === 'source-summary-sha') {
    useAppStore.setState({ projectImages: state.projectImages.map(asset => asset.assetId === sourceAssetId
      ? { ...asset, sha256: changedDigest } : asset) });
    return;
  }
  if (drift === 'managed-source-sha') {
    useAppStore.setState({ project: { ...state.project, assets: state.project.assets?.map(asset => asset.assetId === sourceAssetId
      ? { ...asset, sha256: changedDigest } : asset) } });
    return;
  }
  const nodes = state.project.nodes.map(node => {
    if (node.type !== 'module' || node.data.config.groupId !== groupId) return node;
    const config = { ...node.data.config };
    if (node.data.moduleType === 'image_layering') {
      if (drift === 'group-digest') config.layeringConfirmationDigest = changedDigest;
      if (drift === 'group-contract') config.foregroundOutputContract = 'source-alpha-matte-v1';
      if (drift === 'group-elements') config.planElements = (config.planElements as Array<Record<string, unknown>>)
        .map(element => element.elementId === 'cup-visible' ? { ...element, name: 'Changed visible object' } : element);
    }
    if (node.data.moduleType === 'image_layer' && config.layerId === 'cup') {
      if (drift === 'layer-digest') config.layeringConfirmationDigest = changedDigest;
      if (drift === 'layer-contract') config.layeringOutputContract = 'source-alpha-matte-v1';
      if (drift === 'child-name') config.name = 'Cup and hand';
      if (drift === 'child-bounds') config.sourceBounds = { x: .1, y: .1, width: .6, height: .5 };
      if (drift === 'child-elements') config.elementIds = ['scene'];
      if (drift === 'child-job-id') config.jobId = 'unconfirmed-replacement-job';
    }
    if (node.data.moduleType === 'image_layer' && config.layerId === 'background' && drift === 'sibling-contract') {
      config.layeringOutputContract = 'source-independent-rgba-v2';
    }
    return { ...node, data: { ...node.data, config } };
  });
  useAppStore.setState({ project: { ...state.project, nodes } });
}
