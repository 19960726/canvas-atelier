import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createComflyVideoJobHandlers, type ComflyVideoTaskState } from './comfly-video-jobs.js';
import { deriveGenerationHistoryId, GenerationHistoryProviderSink } from './generation-history-provider-sink.js';
import { GenerationHistoryStore } from './generation-history-store.js';
import { createProviderTaskMappingStore } from './provider-task-ledger.js';
import { confinedProviderTaskMappingsPath } from './provider-file-confinement.js';
import { createProviderBridgeError } from './provider-contracts.js';
import type { GenerationProjectBinding } from './generation-project-binding.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createVideoFixture(name: string, bound?: {
  bindGenerationProject?: (sessionId: string, projectId?: string) => Promise<GenerationProjectBinding>;
  storeGeneratedVideoForProject?: (binding: GenerationProjectBinding, bytes: Uint8Array, mediaType: 'video/mp4') => Promise<{ assetId: string; width: number; height: number }>;
  storeGeneratedVideo?: () => Promise<{ assetId: string; width: number; height: number }>;
  pollProvider?: () => Promise<ComflyVideoTaskState>;
}) {
  const appDataRoot = await mkdtemp(join(tmpdir(), 'comfly-video-history-'));
  temporaryRoots.push(appDataRoot);
  const now = Date.parse('2026-09-28T08:00:00.000Z');
  const nowIso = () => new Date(now).toISOString();
  const mappings = createProviderTaskMappingStore({
    appDataRoot,
    secretSupplier: async () => ({ primary: 'fixture-mapping-secret', fallback: [] }),
  });
  const historyStore = new GenerationHistoryStore({
    historyRoot: join(appDataRoot, 'generation-history'), ownedRoot: appDataRoot, now: () => now,
  });
  const historySink = new GenerationHistoryProviderSink({
    store: historyStore, trustedImageDecoder: async () => true, now: () => now,
  });
  const mp4 = Uint8Array.from([
    0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
    0, 0, 0, 9, 0x6d, 0x6f, 0x6f, 0x76, 0,
    0, 0, 0, 9, 0x6d, 0x64, 0x61, 0x74, 0,
  ]);
  const submitProvider = vi.fn(async () => ({ taskId: 'paid-provider-task-1' }));
  const downloadResult = vi.fn(async () => mp4);
  const publicTaskId = `provider-job-${'a'.repeat(32)}`;
  const createHandlers = () => createComflyVideoJobHandlers({
    appDataRoot,
    secretSupplier: async () => ({ primary: 'fixture-mapping-secret', fallback: [] }),
    mappings,
    listProfiles: async () => [{
      provider: 'comfly', modelRoute: 'veo-video', modelId: 'veo3.1',
      displayName: 'Veo 3.1', capabilities: ['video_generation', 'async_tasks'],
    }],
    submitProvider,
    pollProvider: bound?.pollProvider ?? (async () => ({
      taskId: 'paid-provider-task-1', status: 'SUCCESS',
      data: { output: 'https://assets.example/video.mp4', duration: 8 },
    })),
    downloadResult,
    historySink,
    storeGeneratedVideo: bound?.storeGeneratedVideo ?? (async () => ({ assetId: 'fedcba9876543210', width: 1920, height: 1080 })),
    bindGenerationProject: bound?.bindGenerationProject,
    storeGeneratedVideoForProject: bound?.storeGeneratedVideoForProject,
    createPublicTaskId: () => publicTaskId,
    nowIso,
  });
  const handlers = createHandlers();
  const request = {
    jobId: `model-job-v2-video-${name}`, provider: 'comfly' as const,
    modelRoute: 'veo-video', prompt: 'A product rotates on a clean studio table',
    conversationId: `video-session-${name}`, referenceAssetIds: [],
  };
  return { appDataRoot, handlers, createHandlers, historySink, historyStore, mappings, request, submitProvider, downloadResult, publicTaskId, mp4 };
}

describe('Comfly video submission history recovery', () => {
  it('retries the same video job when history reservation fails before the paid POST', async () => {
    const { handlers, historySink, mappings, request, submitProvider, publicTaskId } = await createVideoFixture('history-reserve-retry');
    vi.spyOn(historySink, 'reserveSubmission').mockRejectedValueOnce(new Error('history volume temporarily unavailable'));

    await expect(handlers.submitVideoJob(request)).rejects.toThrow('history volume temporarily unavailable');
    expect(submitProvider).not.toHaveBeenCalled();
    await expect(mappings.findByHistoryId(deriveGenerationHistoryId(request.jobId))).resolves.toBeUndefined();

    await expect(handlers.submitVideoJob(request)).resolves.toEqual({ providerTaskId: publicTaskId });
    expect(submitProvider).toHaveBeenCalledOnce();
  });

  it('fails closed after a history reservation when the ledger reservation fails before the paid POST', async () => {
    const { handlers, historyStore, mappings, request, submitProvider } = await createVideoFixture('ledger-reserve-retry');
    vi.spyOn(mappings, 'reserveSubmission').mockRejectedValueOnce(new Error('ledger volume temporarily unavailable'));

    await expect(handlers.submitVideoJob(request)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE', retryable: true, message: expect.stringMatching(/^提交状态不确定/u),
    });
    expect(submitProvider).not.toHaveBeenCalled();
    await expect(historyStore.getRecords([deriveGenerationHistoryId(request.jobId)]))
      .resolves.toEqual([expect.objectContaining({ status: 'queued' })]);

    await expect(handlers.submitVideoJob(request)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE', retryable: true, message: expect.stringMatching(/^提交状态不确定/u),
    });
    expect(submitProvider).not.toHaveBeenCalled();
  });

  it('does not submit a second paid video after the mapping ledger is lost while history is running', async () => {
    const fixture = await createVideoFixture('history-running-ledger-lost');
    await fixture.handlers.submitVideoJob(fixture.request);
    expect(fixture.submitProvider).toHaveBeenCalledOnce();
    await expect(fixture.historyStore.getRecords([deriveGenerationHistoryId(fixture.request.jobId)]))
      .resolves.toEqual([expect.objectContaining({ status: 'running' })]);

    await rm(confinedProviderTaskMappingsPath(fixture.appDataRoot));
    await expect(fixture.createHandlers().submitVideoJob(fixture.request)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE', retryable: true, message: expect.stringMatching(/^提交状态不确定/u),
    });
    expect(fixture.submitProvider).toHaveBeenCalledOnce();
  });

  it('allows only one paid POST when two submits race on the same video job', async () => {
    let releaseProvider!: () => void;
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const fixture = await createVideoFixture('parallel-submit');
    fixture.submitProvider.mockImplementation(async () => { providerStarted(); await gate; return { taskId: 'paid-provider-task-1' }; });

    const first = fixture.handlers.submitVideoJob(fixture.request);
    await started;
    await expect(fixture.handlers.submitVideoJob(fixture.request)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE', retryable: true, message: expect.stringMatching(/^提交状态不确定/u),
    });
    releaseProvider();
    await expect(first).resolves.toEqual({ providerTaskId: fixture.publicTaskId });
    await expect(fixture.handlers.submitVideoJob(fixture.request)).resolves.toEqual({ providerTaskId: fixture.publicTaskId });
    expect(fixture.submitProvider).toHaveBeenCalledOnce();
  });

  it('preserves a completed video when cancellation races after durable history success', async () => {
    let releaseTerminal!: () => void;
    let terminalStarted!: () => void;
    const started = new Promise<void>((resolve) => { terminalStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseTerminal = resolve; });
    const fixture = await createVideoFixture('cancel-after-history-success');
    const originalMarkTerminal = fixture.mappings.markTerminal.bind(fixture.mappings);
    vi.spyOn(fixture.mappings, 'markTerminal').mockImplementationOnce(async (...args) => {
      terminalStarted(); await gate; return originalMarkTerminal(...args);
    });
    await fixture.handlers.submitVideoJob(fixture.request);
    const poll = fixture.handlers.pollVideoJob({ provider: 'comfly', providerTaskId: fixture.publicTaskId });
    await started;

    await expect(fixture.handlers.cancelVideoJob({ provider: 'comfly', providerTaskId: fixture.publicTaskId }))
      .resolves.toMatchObject({ status: 'completed', result: { assetId: 'fedcba9876543210' } });
    releaseTerminal();
    await expect(poll).resolves.toMatchObject({ status: 'completed' });
    await expect(fixture.mappings.get(fixture.publicTaskId)).resolves.toMatchObject({ state: 'completed' });
    expect(fixture.submitProvider).toHaveBeenCalledOnce();
  });

  it('keeps a failed durable history terminal when the user requests cancellation', async () => {
    const fixture = await createVideoFixture('cancel-after-history-failure');
    await fixture.handlers.submitVideoJob(fixture.request);
    await fixture.historySink.failed(deriveGenerationHistoryId(fixture.request.jobId), 'provider_failed');

    await expect(fixture.handlers.cancelVideoJob({ provider: 'comfly', providerTaskId: fixture.publicTaskId }))
      .resolves.toMatchObject({ status: 'failed' });
    await expect(fixture.mappings.get(fixture.publicTaskId)).resolves.toMatchObject({ state: 'failed' });
  });

  it('reports a transient duplicate-submission ledger read as retryable uncertainty', async () => {
    const fixture = await createVideoFixture('duplicate-ledger-read');
    await fixture.handlers.submitVideoJob(fixture.request);
    vi.spyOn(fixture.mappings, 'findByHistoryId').mockRejectedValueOnce(new Error('ledger read temporarily unavailable'));
    await expect(fixture.handlers.submitVideoJob(fixture.request)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE', retryable: true, message: expect.stringMatching(/^提交状态不确定/u),
    });
    expect(fixture.submitProvider).toHaveBeenCalledOnce();
  });

  it('keeps durable cancellation when a late provider poll reports failure', async () => {
    const fixture = await createVideoFixture('provider-failure-after-cancel', {
      pollProvider: async () => ({ taskId: 'paid-provider-task-1', status: 'FAILURE', failReason: 'late provider result' }),
    });
    await fixture.handlers.submitVideoJob(fixture.request);
    await fixture.historySink.cancelled(deriveGenerationHistoryId(fixture.request.jobId));

    await expect(fixture.handlers.pollVideoJob({ provider: 'comfly', providerTaskId: fixture.publicTaskId }))
      .resolves.toEqual({ status: 'cancelled' });
    await expect(fixture.mappings.get(fixture.publicTaskId)).resolves.toMatchObject({ state: 'cancelled' });
  });

  it('keeps a recorded completed video when a late provider poll reports failure', async () => {
    const fixture = await createVideoFixture('provider-failure-after-success', {
      pollProvider: async () => ({ taskId: 'paid-provider-task-1', status: 'FAILURE', failReason: 'late provider result' }),
    });
    await fixture.handlers.submitVideoJob(fixture.request);
    await fixture.mappings.updateRunning(fixture.publicTaskId, { result: { assetId: 'fedcba9876543210', width: 1920, height: 1080 } }, '2026-09-28T08:00:00.000Z');
    await fixture.historySink.succeeded(deriveGenerationHistoryId(fixture.request.jobId), fixture.mp4, { width: 1920, height: 1080, durationSeconds: 8 });

    await expect(fixture.handlers.pollVideoJob({ provider: 'comfly', providerTaskId: fixture.publicTaskId }))
      .resolves.toMatchObject({ status: 'completed', result: { assetId: 'fedcba9876543210' } });
    await expect(fixture.mappings.get(fixture.publicTaskId)).resolves.toMatchObject({ state: 'completed' });
  });

  it('keeps a paid video running through a transient provider poll failure without inviting a new paid run', async () => {
    let providerReadable = false;
    const fixture = await createVideoFixture('transient-provider-poll', {
      pollProvider: async () => {
        if (!providerReadable) throw new Error('provider gateway temporarily unavailable');
        return { taskId: 'paid-provider-task-1', status: 'SUCCESS', data: { output: 'https://assets.example/video.mp4', duration: 8 } };
      },
    });
    await fixture.handlers.submitVideoJob(fixture.request);

    await expect(fixture.handlers.pollVideoJob({ provider: 'comfly', providerTaskId: fixture.publicTaskId }))
      .rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true, message: expect.stringMatching(/^提交状态不确定/u) });
    await expect(fixture.mappings.get(fixture.publicTaskId)).resolves.toMatchObject({ state: 'running' });
    providerReadable = true;
    await expect(fixture.handlers.pollVideoJob({ provider: 'comfly', providerTaskId: fixture.publicTaskId }))
      .resolves.toMatchObject({ status: 'completed', result: { assetId: 'fedcba9876543210' } });
    expect(fixture.submitProvider).toHaveBeenCalledOnce();
  });

  it('recovers staged video after restart when the CDN expires after a transient project commit failure', async () => {
    let writable = false;
    const store = vi.fn(async (_binding: GenerationProjectBinding, bytes: Uint8Array) => {
      expect(bytes.subarray(4, 8)).toEqual(Uint8Array.from([0x66, 0x74, 0x79, 0x70]));
      if (!writable) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Project temporarily unavailable', true);
      return { assetId: 'fedcba9876543210', width: 1920, height: 1080 };
    });
    const fixture = await createVideoFixture('expired-cdn', {
      bindGenerationProject: async () => ({ projectId: 'video-project', rootFingerprint: 'f'.repeat(64) }),
      storeGeneratedVideoForProject: store,
    });
    const { handlers, createHandlers, request, publicTaskId, downloadResult, submitProvider } = fixture;
    await handlers.submitVideoJob({ ...request, projectId: 'video-project', sessionId: 'video-session' });
    await expect(handlers.pollVideoJob({ provider: 'comfly', providerTaskId: publicTaskId }))
      .rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    writable = true;
    downloadResult.mockRejectedValue(new Error('CDN URL expired'));
    await expect(createHandlers().pollVideoJob({ provider: 'comfly', providerTaskId: publicTaskId }))
      .resolves.toMatchObject({ status: 'completed', result: { assetId: 'fedcba9876543210' } });
    expect(downloadResult).toHaveBeenCalledOnce();
    expect(submitProvider).toHaveBeenCalledOnce();
  });

  it.each(['corrupt', 'missing'] as const)('terminates a %s staged paid video visibly and blocks a fresh paid retry', async (damage) => {
    const fixture = await createVideoFixture(`${damage}-staged-video`, {
      storeGeneratedVideo: async () => { throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Project temporarily unavailable', true); },
    });
    const { appDataRoot, handlers, createHandlers, request, publicTaskId, downloadResult, submitProvider, historyStore } = fixture;
    await handlers.submitVideoJob(request);
    await expect(handlers.pollVideoJob({ provider: 'comfly', providerTaskId: publicTaskId }))
      .rejects.toMatchObject({ retryable: true });
    if (damage === 'corrupt') await writeFile(join(appDataRoot, `provider-pending-media-${publicTaskId}-0.bin`), 'tampered');
    else await rm(join(appDataRoot, `provider-pending-media-${publicTaskId}.json`));
    downloadResult.mockRejectedValue(new Error('CDN expired'));
    await expect(createHandlers().pollVideoJob({ provider: 'comfly', providerTaskId: publicTaskId }))
      .resolves.toMatchObject({ status: 'failed', error: { code: 'PROVIDER_INVALID_RESPONSE', message: expect.stringMatching(/^提交状态不确定/u) } });
    await expect(historyStore.getRecords([deriveGenerationHistoryId(request.jobId)]))
      .resolves.toEqual([expect.objectContaining({ status: 'failed' })]);
    expect(downloadResult).toHaveBeenCalledOnce();
    expect(submitProvider).toHaveBeenCalledOnce();
  });
  it('rejects a mismatched project before submitting paid video', async () => {
    const bindGenerationProject = vi.fn(async () => { throw createProviderBridgeError('INVALID_REQUEST', 'Project mismatch'); });
    const fixture = await createVideoFixture('cross-project-preflight', { bindGenerationProject });
    await expect(fixture.handlers.submitVideoJob({ ...fixture.request, projectId: 'expected-project', sessionId: 'active-session' }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(bindGenerationProject).toHaveBeenCalledWith('active-session', 'expected-project');
    expect(fixture.submitProvider).not.toHaveBeenCalled();
  });

  it('retains a paid video job while bound project storage is unavailable and resumes without a second submission', async () => {
    const binding = { projectId: 'video-project', rootFingerprint: 'b'.repeat(64) };
    let activeBinding = binding;
    let writable = false;
    const boundStore = vi.fn(async (actual: GenerationProjectBinding) => {
      expect(actual).toEqual(binding);
      if (!writable) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Bound project is closed', true);
      return { assetId: 'fedcba9876543210', width: 1920, height: 1080 };
    });
    const legacyStore = vi.fn(async () => { throw new Error('Legacy session must not receive bound video'); });
    const fixture = await createVideoFixture('bound-project-recovery', {
      bindGenerationProject: async () => activeBinding,
      storeGeneratedVideoForProject: boundStore,
      storeGeneratedVideo: legacyStore,
    });
    const { handlers, mappings, request, publicTaskId, submitProvider } = fixture;
    await handlers.submitVideoJob({ ...request, projectId: binding.projectId, sessionId: 'old-session' });
    await expect(mappings.get(publicTaskId)).resolves.toMatchObject({ projectBinding: binding });
    activeBinding = { ...binding, rootFingerprint: 'c'.repeat(64) };
    await expect(handlers.submitVideoJob({ ...request, projectId: binding.projectId, sessionId: 'copied-session' }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(handlers.pollVideoJob({ provider: 'comfly', providerTaskId: publicTaskId }))
      .rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    await expect(mappings.get(publicTaskId)).resolves.toMatchObject({ state: 'running' });
    writable = true;
    await expect(handlers.pollVideoJob({ provider: 'comfly', providerTaskId: publicTaskId }))
      .resolves.toMatchObject({ status: 'completed', result: { assetId: 'fedcba9876543210' } });
    expect(submitProvider).toHaveBeenCalledOnce();
    expect(legacyStore).not.toHaveBeenCalled();
    expect(boundStore).toHaveBeenCalledTimes(2);
  });

  it('uses the durable cancellation when video history was cancelled during storage', async () => {
    const fixture = await createVideoFixture('cancelled-history-during-store');
    const { handlers, historySink, mappings, request, publicTaskId } = fixture;
    vi.spyOn(historySink, 'succeeded').mockResolvedValueOnce({ status: 'cancelled' });
    await handlers.submitVideoJob(request);
    await expect(handlers.pollVideoJob({ provider: 'comfly', providerTaskId: publicTaskId }))
      .resolves.toEqual({ status: 'cancelled' });
    await expect(mappings.get(publicTaskId)).resolves.toMatchObject({ state: 'cancelled' });
  });

  it('does not report completed after a cancelled video task was ACKed during project storage', async () => {
    let release!: () => void;
    let started!: () => void;
    const storageStarted = new Promise<void>((resolve) => { started = resolve; });
    const storageGate = new Promise<void>((resolve) => { release = resolve; });
    const fixture = await createVideoFixture('ack-during-project-store', { storeGeneratedVideo: async () => {
      started(); await storageGate;
      return { assetId: 'fedcba9876543210', width: 1920, height: 1080 };
    } });
    const { appDataRoot, handlers, mappings, request, publicTaskId } = fixture;
    await handlers.submitVideoJob(request);
    const poll = handlers.pollVideoJob({ provider: 'comfly', providerTaskId: publicTaskId });
    await storageStarted;
    await mappings.markCancelled(publicTaskId, '2026-09-28T08:00:01.000Z');
    await mappings.ackTerminal(publicTaskId, 'cancelled');
    release();
    await expect(poll).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
    await expect(readFile(join(appDataRoot, `provider-pending-media-${publicTaskId}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(appDataRoot, `provider-pending-media-${publicTaskId}-0.bin`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps staged paid video bytes when a premature terminal ACK is rejected during project storage', async () => {
    let release!: () => void;
    let started!: () => void;
    const storageStarted = new Promise<void>((resolve) => { started = resolve; });
    const storageGate = new Promise<void>((resolve) => { release = resolve; });
    const fixture = await createVideoFixture('premature-ack-during-project-store', { storeGeneratedVideo: async () => {
      started(); await storageGate;
      return { assetId: 'fedcba9876543210', width: 1920, height: 1080 };
    } });
    const { appDataRoot, handlers, request, publicTaskId } = fixture;
    await handlers.submitVideoJob(request);
    const poll = handlers.pollVideoJob({ provider: 'comfly', providerTaskId: publicTaskId });
    await storageStarted;

    await expect(handlers.ackVideoJobTerminal({ provider: 'comfly', providerTaskId: publicTaskId, status: 'completed' }))
      .rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
    await expect(readFile(join(appDataRoot, `provider-pending-media-${publicTaskId}.json`)))
      .resolves.toBeInstanceOf(Buffer);
    release();
    await expect(poll).resolves.toMatchObject({ status: 'completed' });
    await expect(handlers.ackVideoJobTerminal({ provider: 'comfly', providerTaskId: publicTaskId, status: 'completed' }))
      .resolves.toEqual({ acknowledged: true });
    await expect(readFile(join(appDataRoot, `provider-pending-media-${publicTaskId}.json`)))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('keeps a durably registered task usable when recording running history fails', async () => {
    const fixture = await createVideoFixture('running-history-write-failure');
    const { handlers, historySink, historyStore, mappings, request, submitProvider, publicTaskId } = fixture;
    vi.spyOn(historySink, 'running').mockRejectedValueOnce(new Error('temporary history write failure'));

    await expect(handlers.submitVideoJob(request)).resolves.toEqual({ providerTaskId: publicTaskId });
    const historyId = deriveGenerationHistoryId(request.jobId);
    await expect(mappings.get(publicTaskId)).resolves.toMatchObject({ rawTaskId: 'paid-provider-task-1', state: 'running' });
    await expect(historyStore.getRecords([historyId])).resolves.toEqual([expect.objectContaining({ status: 'queued' })]);
    await expect(handlers.submitVideoJob(request)).resolves.toEqual({ providerTaskId: publicTaskId });
    expect(submitProvider).toHaveBeenCalledOnce();

    await expect(handlers.pollVideoJob({ provider: 'comfly', providerTaskId: publicTaskId })).resolves.toEqual({
      status: 'completed', progress: 1,
      result: { assetId: 'fedcba9876543210', width: 1920, height: 1080, durationSeconds: 8 },
    });
    await expect(historyStore.getRecords([historyId])).resolves.toEqual([expect.objectContaining({
      status: 'succeeded', output: expect.objectContaining({ mediaType: 'video/mp4' }),
    })]);
  });

  it('keeps a stored video task recoverable when recording succeeded history fails once', async () => {
    const fixture = await createVideoFixture('success-history-write-failure');
    const { handlers, historySink, historyStore, mappings, request, submitProvider, downloadResult, publicTaskId } = fixture;
    vi.spyOn(historySink, 'succeeded').mockRejectedValueOnce(new Error('temporary history write failure'));
    const submitted = await handlers.submitVideoJob(request);
    const historyId = deriveGenerationHistoryId(request.jobId);

    await expect(handlers.pollVideoJob({ provider: 'comfly', providerTaskId: publicTaskId }))
      .rejects.toMatchObject({ code: 'PROVIDER_ERROR', retryable: true });
    await expect(mappings.get(publicTaskId)).resolves.toMatchObject({ state: 'running' });
    await expect(historyStore.getRecords([historyId])).resolves.toEqual([expect.objectContaining({ status: 'running' })]);
    await expect(handlers.submitVideoJob(request)).resolves.toEqual(submitted);
    expect(submitProvider).toHaveBeenCalledOnce();
    downloadResult.mockRejectedValue(new Error('CDN expired'));
    await expect(handlers.pollVideoJob({ provider: 'comfly', providerTaskId: publicTaskId })).resolves.toMatchObject({
      status: 'completed', result: { assetId: 'fedcba9876543210' },
    });
    expect(downloadResult).toHaveBeenCalledOnce();
    await expect(historyStore.getRecords([historyId])).resolves.toEqual([expect.objectContaining({ status: 'succeeded' })]);
  });

  it('keeps an invalid video result terminal when history validation rejects its media', async () => {
    const fixture = await createVideoFixture('invalid-history-media');
    const { handlers, historySink, historyStore, mappings, request, downloadResult, publicTaskId } = fixture;
    vi.spyOn(historySink, 'succeeded').mockRejectedValueOnce(new Error('Generated result was invalid'));
    await handlers.submitVideoJob(request);
    const historyId = deriveGenerationHistoryId(request.jobId);

    await expect(handlers.pollVideoJob({ provider: 'comfly', providerTaskId: publicTaskId })).resolves.toMatchObject({
      status: 'failed', error: { code: 'PROVIDER_INVALID_RESPONSE', retryable: false },
    });
    await expect(mappings.get(publicTaskId)).resolves.toMatchObject({ state: 'failed' });
    await expect(historyStore.getRecords([historyId])).resolves.toEqual([expect.objectContaining({ status: 'failed' })]);
    await expect(handlers.pollVideoJob({ provider: 'comfly', providerTaskId: publicTaskId })).resolves.toMatchObject({
      status: 'failed', error: { code: 'PROVIDER_INVALID_RESPONSE' },
    });
    expect(downloadResult).toHaveBeenCalledOnce();
  });
});
