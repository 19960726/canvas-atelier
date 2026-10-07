import { createElement } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvasModuleNode, parseCanvasProject, type CanvasMcpRequest, type CanvasMcpResponse,
  type ModelJob } from '@agent-canvas/domain';
import type { ChatSkillBridgeResult, ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import { App, resetAppHydrationForTests } from './App';
import { createStarterProject, replaceKnowledgeClientForTests, replaceModelJobExecutorForTests,
  replaceModelJobStorageForTests, replaceProjectPersistenceClientForTests, resetAppStoreForTests, useAppStore } from './app-store';
import { createBrowserPersistenceClient, createDesktopPersistenceClient, type ProjectCommitRequest,
  type ProjectCommitResult, type SkillChatRequest } from './desktop-persistence';
import { mcpUiConfirmationStore } from './mcp-ui-confirmation-store';
import { updateMcpPermissions } from '../settings/mcp-permissions';
import * as jobStoreModule from '../jobs/job-store';

vi.mock('../canvas/CanvasWorkspace', () => ({ CanvasWorkspace: () => null }));

const originalDesktop = window.novusDesktop;
const sourceAssetId = 'a'.repeat(16);
const sessionId = 'app-layering-callback-session';
const profiles: ProviderBridgeProfile[] = [
  { provider: 'comfly', modelRoute: 'callback-vision', modelId: 'callback-vision', displayName: 'Vision fixture',
    capabilities: ['vision'], capabilityStatus: 'complete' },
  { provider: 'comfly', modelRoute: 'comfly-gpt-image-2', modelId: 'gpt-image-2', displayName: 'GPT Image 2',
    capabilities: ['image_generation', 'image_edit', 'async_tasks'], capabilityStatus: 'complete',
    constraints: { image: { resolutions: ['1K'] } } },
];
const sourceDrifts = ['source-summary-sha', 'same-project-reset', 'same-project-session'] as const;
const analysisPermissionDrifts = ['revoke-read', 'revoke-execution'] as const;
const startPermissionDrifts = [...analysisPermissionDrifts, 'revoke-edit'] as const;
type Drift = typeof sourceDrifts[number] | typeof startPermissionDrifts[number];
type RunRequest = Extract<CanvasMcpRequest, { tool: 'canvas_run_node' }>;
type RuntimeListener = (payload: { requestId: string; request: CanvasMcpRequest }) => void | Promise<void>;
type NativeChat = (input: SkillChatRequest, beforeProviderDispatch?: () => void) => Promise<ChatSkillBridgeResult>;

const createRealJobStore = jobStoreModule.createModelJobStore;

beforeEach(() => {
  delete window.novusDesktop;
  localStorage.clear();
  sessionStorage.clear();
  resetAppHydrationForTests();
  replaceProjectPersistenceClientForTests(createBrowserPersistenceClient());
  resetAppStoreForTests({ project: 'empty' });
  replaceKnowledgeClientForTests({ configure: async () => {}, start: async () => {}, stop: () => {},
    getLease: () => { throw new Error('Unexpected knowledge lease'); },
    prepareSkillCandidateReview: async () => { throw new Error('Unexpected skill review'); },
    review: async () => { throw new Error('Unexpected knowledge review'); } });
  vi.spyOn(jobStoreModule, 'createModelJobStore').mockImplementation(options => {
    const store = createRealJobStore(options);
    vi.spyOn(store, 'run').mockResolvedValue(undefined);
    return store;
  });
});

afterEach(() => {
  cleanup();
  resetAppHydrationForTests();
  resetAppStoreForTests({ project: 'empty' });
  replaceProjectPersistenceClientForTests(createBrowserPersistenceClient());
  mcpUiConfirmationStore.clear();
  vi.restoreAllMocks();
  window.novusDesktop = originalDesktop;
  localStorage.clear();
  sessionStorage.clear();
});

describe('real App MCP layering callbacks', () => {
  it('accepts the current source analysis and binds the approved generation exactly once', async () => {
    const f = await fixture();
    const analysisJobId = await f.analyzed();

    const startJobId = await f.approve(f.startRequest(analysisJobId));
    const result = await f.terminal(startJobId);

    expect(result).toMatchObject({ status: 'completed', result: { phase: 'dispatched', generationCompleted: false } });
    expect(f.providerChat).toHaveBeenCalledOnce();
    expect(f.providerChat.mock.calls[0]![0]).toMatchObject({ purpose: 'image_layering_analysis',
      sessionId, referenceAssetIds: [sourceAssetId] });
    expect(f.commit).toHaveBeenCalledTimes(2);
    expect([...f.jobs.values()]).toHaveLength(2);
    expect([...f.jobs.values()].every(job => job.status === 'queued')).toBe(true);
    expect(useAppStore.getState().project.nodes.filter(node => node.type === 'module'
      && node.data.moduleType === 'image_layer')).toHaveLength(2);
    expect(f.submit).not.toHaveBeenCalled();
  });

  it.each([...sourceDrifts, ...analysisPermissionDrifts])
  ('rejects %s during analysis catalog loading before the real provider chat', async drift => {
    const f = await fixture();
    f.changeDuringCatalog(drift);

    const jobId = await f.approve(f.analysisRequest());
    await f.restoreStatusAccess();

    expect(await f.terminal(jobId)).toMatchObject({ status: 'failed' });
    expect(f.providerChat).not.toHaveBeenCalled();
    f.expectNoGeneration();
  });

  it.each([...sourceDrifts, ...analysisPermissionDrifts])
  ('discards the old analysis plan after %s while the real chat response is pending', async drift => {
    const f = await fixture();
    const entered = deferred();
    const release = deferred();
    f.providerChat.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return f.analysisResponse;
    });

    const jobId = await f.approve(f.analysisRequest());
    await entered.promise;
    await act(async () => { f.change(drift); release.resolve(); });
    await f.restoreStatusAccess();
    const result = await f.terminal(jobId);

    expect(result).toMatchObject({ status: 'failed' });
    expect(result).not.toHaveProperty('plan');
    expect(f.providerChat).toHaveBeenCalledOnce();
    f.expectNoGeneration();
  });

  it.each([...sourceDrifts, ...analysisPermissionDrifts])
  ('blocks %s during the actual desktop chat session await before provider dispatch', async drift => {
    const f = await fixture();
    f.changeDuringNativeSessionAwait(drift);

    const jobId = await f.approve(f.analysisRequest());
    await f.restoreStatusAccess();

    expect(await f.terminal(jobId)).toMatchObject({ status: 'failed' });
    expect(f.chatSkill).toHaveBeenCalledOnce();
    expect(f.providerChat).not.toHaveBeenCalled();
    f.expectNoGeneration();
  });

  it.each(['catalog', 'desktop-session'] as const)
  ('cancels during the last %s await without sending a provider request', async stage => {
    const f = await fixture({ pauseNativeSession: stage === 'desktop-session' });
    const gate = stage === 'catalog' ? f.pauseCatalog() : f.nativeSessionGate;
    const jobId = await f.approve(f.analysisRequest());
    await gate.entered.promise;

    expect(await f.send({ tool: 'canvas_cancel_job', jobId })).toMatchObject({ ok: true,
      result: { cancelled: true, scope: 'discard_analysis_result', providerCancellationConfirmed: false } });
    await act(async () => { gate.release.resolve(); });
    await f.restoreStatusAccess();

    const result = await f.terminal(jobId);
    expect(result).toMatchObject({ status: 'cancelled' });
    expect(result).not.toHaveProperty('plan');
    expect(f.providerChat).not.toHaveBeenCalled();
    f.expectNoGeneration();

    const retriedJobId = await f.approve(f.analysisRequest());
    expect(retriedJobId).not.toBe(jobId);
    expect(await f.terminal(retriedJobId)).toMatchObject({ status: 'completed', plan: { sourceAssetId } });
    expect(f.providerChat).toHaveBeenCalledOnce();
    expect(await f.terminal(jobId)).toMatchObject({ status: 'cancelled' });
    expect(await f.terminal(jobId)).not.toHaveProperty('plan');
    f.expectNoGeneration();
  });

  it('keeps an in-flight cancelled analysis terminal while a newly approved analysis completes', async () => {
    const f = await fixture();
    const entered = deferred();
    const release = deferred();
    f.providerChat.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return f.analysisResponse;
    });

    const cancelledJobId = await f.approve(f.analysisRequest());
    await entered.promise;
    expect(await f.send({ tool: 'canvas_cancel_job', jobId: cancelledJobId })).toMatchObject({ ok: true,
      result: { cancelled: true, scope: 'discard_analysis_result', providerCancellationConfirmed: false } });

    const currentJobId = await f.approve(f.analysisRequest());
    expect(currentJobId).not.toBe(cancelledJobId);
    expect(await f.terminal(currentJobId)).toMatchObject({ status: 'completed', plan: { sourceAssetId } });
    await act(async () => { release.resolve(); });

    const cancelledResult = await f.terminal(cancelledJobId);
    expect(cancelledResult).toMatchObject({ status: 'cancelled' });
    expect(cancelledResult).not.toHaveProperty('plan');
    expect(cancelledResult).not.toHaveProperty('error');
    expect(f.providerChat).toHaveBeenCalledTimes(2);
    f.expectNoGeneration();
  });

  it.each([...sourceDrifts, ...startPermissionDrifts])
  ('refuses %s during generation catalog loading before group creation', async drift => {
    const f = await fixture();
    const analysisJobId = await f.analyzed();
    f.changeDuringCatalog(drift);

    const jobId = await f.approve(f.startRequest(analysisJobId));
    await f.restoreStatusAccess();

    expect(await f.terminal(jobId)).toMatchObject({ status: 'failed' });
    expect(f.providerChat).toHaveBeenCalledOnce();
    f.expectNoGeneration();
  });

  it.each([...sourceDrifts, ...startPermissionDrifts])
  ('refuses %s during the actual confirmation SHA before group creation', async drift => {
    const f = await fixture();
    const analysisJobId = await f.analyzed();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, bytes) => {
      const value = await digest(algorithm, bytes);
      f.change(drift);
      return value;
    });

    const jobId = await f.approve(f.startRequest(analysisJobId));
    await f.restoreStatusAccess();

    expect(await f.terminal(jobId)).toMatchObject({ status: 'failed' });
    expect(f.providerChat).toHaveBeenCalledOnce();
    f.expectNoGeneration();
  });
});

async function fixture(options: { pauseNativeSession?: boolean } = {}) {
  const sourceAsset = { assetId: sourceAssetId, byteSize: 16, extension: 'png' as const, height: 24, width: 24,
    label: 'Owned source fixture', mediaType: 'image/png' as const, origin: 'imported' as const, sha256: 'a'.repeat(64) };
  const sourceNode = createCanvasModuleNode('callback-source', 'image_input', { x: 0, y: 0 });
  sourceNode.data.config.assetId = sourceAssetId;
  const project = parseCanvasProject({ ...createStarterProject(), id: 'app-layering-callback-project',
    name: 'Layer callback fixture', nodes: [sourceNode], edges: [], assets: [sourceAsset] });
  const analysisResponse: ChatSkillBridgeResult = { modelRoute: 'callback-vision', sources: [], message: JSON.stringify({
    layers: [
      { layerId: 'background', kind: 'background', name: 'Kitchen background', description: 'Rebuild the kitchen only',
        included: true, elementIds: ['scene'] },
      { layerId: 'cup', kind: 'transparent', name: 'Steel cup', description: 'Visible steel cup only; exclude hands',
        included: true, elementIds: ['cup-visible'], sourceBounds: { x: .1, y: .1, width: .5, height: .5 } },
    ], elements: [
      { elementId: 'scene', name: 'Kitchen', layerId: 'background', kind: 'object' },
      { elementId: 'cup-visible', name: 'Steel cup', layerId: 'cup', kind: 'object',
        sourceBounds: { x: .1, y: .1, width: .5, height: .5 } },
    ],
  }) };
  let activeSessionId = sessionId;
  let catalogDrift: Drift | undefined;
  let catalogGate: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  const nativeSessionGate = { entered: deferred(), release: deferred() };
  let nativeSessionAwaitDrift: Drift | undefined;
  let listener: RuntimeListener | undefined;
  let requestSequence = 0;
  const jobs = new Map<string, ModelJob>();
  const respond = vi.fn((_payload: { requestId: string; response: CanvasMcpResponse }) => {});
  const onRequest = vi.fn((receive: RuntimeListener) => { listener = receive; return () => { listener = undefined; }; });
  const providerChat = vi.fn(async (_request: SkillChatRequest & { sessionId: string }) => analysisResponse);
  const nativeClient = createDesktopPersistenceClient({
    openProject: async () => ({ currentRevision: 7, mode: 'write', project, projectId: project.id,
      projectName: project.name, sessionId, stableSnapshotId: null, stableSnapshotRevision: 7 }),
    createProject: async () => {
      nativeSessionGate.entered.resolve();
      await nativeSessionGate.release.promise;
      return { currentRevision: 7, mode: 'write', project, projectId: project.id,
        projectName: project.name, sessionId, stableSnapshotId: null, stableSnapshotRevision: 7 };
    },
    closeProject: async () => {}, provider: { chat: providerChat }, projectImages: { list: async () => [] },
  } as never);
  if (!options.pauseNativeSession) await nativeClient.openProject?.();
  const nativeChat = nativeClient.chatSkill! as NativeChat;
  const chatSkill = vi.fn((input: SkillChatRequest, beforeProviderDispatch?: () => void) => {
    // The real desktop client has entered ensureWritableSession and yielded before chat dispatch.
    const pending = nativeChat(input, beforeProviderDispatch);
    if (nativeSessionAwaitDrift) { const drift = nativeSessionAwaitDrift; nativeSessionAwaitDrift = undefined; change(drift); }
    return pending;
  });
  const commit = vi.fn(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
    ok: true, project: request.nextProject, revision: request.baseRevision + 1,
  }));
  const submit = vi.fn(async (_job: ModelJob) => ({ providerTaskId: 'must-not-dispatch-from-callback-fixture' }));
  replaceModelJobStorageForTests({ get: async key => jobs.get(key), list: async () => [...jobs.values()],
    put: async job => { jobs.set(job.id, job); }, bulkPut: async batch => { for (const job of batch) jobs.set(job.id, job); } });
  replaceModelJobExecutorForTests({ submit, poll: async () => ({ status: 'running', progress: .1 }) });
  replaceProjectPersistenceClientForTests({ ...createBrowserPersistenceClient(), chatSkill, commit,
    hydrate: async () => ({ availableSnapshotIds: [], lifecycle: 'durable', mode: 'desktop', project,
      revision: 7, saveStatus: 'saved' }),
    ensureModelExecutionSession: async () => activeSessionId, getSessionId: () => activeSessionId,
    listProjectImages: async () => [{ ...sourceAsset, displayUrl: 'fixture-source', usageCount: 1 }],
  });
  updateMcpPermissions({ readCanvas: true, editCanvas: true, executeAiGeneration: true });
  window.novusDesktop = {
    provider: { getStatus: async () => ({ configured: true, locked: false, encryption: 'safeStorage' }),
      listProfiles: async (request?: { provider?: string }) => {
        if (request?.provider !== 'comfly') return [];
        if (catalogGate) { const gate = catalogGate; catalogGate = undefined; gate.entered.resolve(); await gate.release.promise; }
        if (catalogDrift) { const drift = catalogDrift; catalogDrift = undefined; change(drift); }
        return profiles;
      } },
    mcpRuntime: { onRequest, respond,
      getStatus: async () => ({ state: 'running', rendererConnected: true, serverVersion: 'fixture', toolCount: 14, lastError: null }) },
  } as never;
  render(createElement(App));
  await waitFor(() => {
    expect(onRequest).toHaveBeenCalledOnce();
    expect(useAppStore.getState()).toMatchObject({ desktopRevision: 7, project: { id: project.id }, persistenceReady: true });
  });

  function change(drift: Drift) {
    if (drift === 'source-summary-sha') {
      useAppStore.setState(state => ({ projectImages: state.projectImages.map(asset => asset.assetId === sourceAssetId
        ? { ...asset, sha256: 'b'.repeat(64) } : asset) }));
    } else if (drift === 'same-project-reset') {
      useAppStore.setState(state => ({ canvasDraftResetKey: state.canvasDraftResetKey + 1 }));
    } else if (drift === 'same-project-session') activeSessionId = 'replacement-callback-session';
    else if (drift === 'revoke-read') updateMcpPermissions({ readCanvas: false });
    else if (drift === 'revoke-edit') updateMcpPermissions({ editCanvas: false });
    else updateMcpPermissions({ executeAiGeneration: false });
  }

  async function send(request: CanvasMcpRequest): Promise<CanvasMcpResponse> {
    const requestId = `callback-runtime-${++requestSequence}`;
    if (!listener) throw new Error('MCP runtime listener is unavailable');
    await act(async () => { await listener!({ requestId, request }); });
    const reply = respond.mock.calls.find(([payload]) => payload.requestId === requestId)?.[0].response;
    if (!reply) throw new Error('MCP runtime did not respond');
    return reply;
  }

  async function approve(request: RunRequest): Promise<string> {
    expect(await send(request)).toMatchObject({ ok: false, error: { code: 'OPERATION_CONFIRMATION_REQUIRED' } });
    const pending = mcpUiConfirmationStore.getSnapshot().find(item => item.kind === 'layering_operation'
      && item.operation === request.operation);
    if (!pending) throw new Error('The exact layering UI approval was not published');
    const grant = mcpUiConfirmationStore.confirm(pending.id);
    const started = await send({ ...request, confirmationToken: grant.token });
    expect(started).toMatchObject({ ok: true, result: { started: true } });
    if (!started.ok) throw new Error('Approved layering runtime job was not created');
    return (started.result as { jobIds: string[] }).jobIds[0]!;
  }

  async function terminal(jobId: string) {
    let result: { status: string; plan?: unknown; result?: unknown } | undefined;
    await waitFor(async () => {
      const response = await send({ tool: 'canvas_get_job_status', jobId });
      expect(response).toMatchObject({ ok: true });
      if (!response.ok) throw new Error('Layer operation status is unavailable');
      result = response.result as typeof result;
      expect(result?.status).not.toBe('running');
    });
    return result!;
  }

  const analysisRequest = (): RunRequest => ({ tool: 'canvas_run_node', expectedRevision: 7, nodeId: sourceNode.id,
    operation: 'analyze_layering', analysis: { provider: 'comfly', modelRoute: 'callback-vision' } });
  return { project, jobs, providerChat, chatSkill, analysisResponse, submit, commit, change, analysisRequest, approve, terminal, send,
    nativeSessionGate,
    pauseCatalog: () => { const gate = { entered: deferred(), release: deferred() }; catalogGate = gate; return gate; },
    changeDuringCatalog: (drift: Drift) => { catalogDrift = drift; },
    changeDuringNativeSessionAwait: (drift: Drift) => { nativeSessionAwaitDrift = drift; },
    restoreStatusAccess: async () => {
      // Keep revoked permissions through the final callback continuation, then allow status reads.
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
      updateMcpPermissions({ readCanvas: true });
    },
    analyzed: async () => {
      const jobId = await approve(analysisRequest());
      expect(await terminal(jobId)).toMatchObject({ status: 'completed', plan: { sourceAssetId } });
      return jobId;
    },
    startRequest: (analysisJobId: string): RunRequest => ({ tool: 'canvas_run_node', expectedRevision: 7, nodeId: sourceNode.id,
      operation: 'start_layering', layering: { analysisJobId, provider: 'comfly', modelRoute: 'comfly-gpt-image-2', resolution: '1K' } }),
    expectNoGeneration: () => {
      expect(commit).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
      expect([...jobs.values()]).toHaveLength(0);
      expect(useAppStore.getState().project.nodes).toHaveLength(1);
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
