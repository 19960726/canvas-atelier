import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyProjectTransaction, createCanvasModuleNode, parseCanvasProject, type CanvasProject, type ModelJob } from '@agent-canvas/domain';
import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import * as jobStoreModule from '../jobs/job-store';
import {
  createStarterProject, replaceLayeringRouteEvidenceForTests, replaceModelJobExecutorForTests,
  replaceModelJobStorageForTests, replaceProjectPersistenceClientForTests, resetAppStoreForTests, useAppStore,
} from './app-store';
import { createBrowserPersistenceClient, type ProjectCommitRequest, type ProjectCommitResult } from './desktop-persistence';
import { buildLayeringGraphTransaction } from './layering-graph';
import { confirmLayeringPlan, type LayeringPlan } from './layering-plan';

const createRealJobStore = jobStoreModule.createModelJobStore;
const sourceDrifts = [['summary', 'sha256'], ['managed', 'sha256'], ['summary', 'width'], ['managed', 'width']] as const;
const profiles: ProviderBridgeProfile[] = [
  { provider: 'comfly', modelRoute: 'fixture-vision', modelId: 'fixture-vision', displayName: 'Vision fixture',
    capabilities: ['vision'], capabilityStatus: 'complete' },
  { provider: 'comfly', modelRoute: 'comfly-gpt-image-2', modelId: 'gpt-image-2', displayName: 'GPT Image 2',
    capabilities: ['image_generation', 'image_edit', 'async_tasks'], capabilityStatus: 'complete',
    constraints: { image: { resolutions: ['1K'] } } },
];

beforeEach(() => {
  delete window.novusDesktop;
  localStorage.clear();
  sessionStorage.clear();
  replaceProjectPersistenceClientForTests(createBrowserPersistenceClient());
  resetAppStoreForTests({ project: 'empty' });
  vi.spyOn(jobStoreModule, 'createModelJobStore').mockImplementation(options => {
    const store = createRealJobStore(options);
    vi.spyOn(store, 'run').mockResolvedValue(undefined);
    return store;
  });
});

afterEach(() => {
  resetAppStoreForTests({ project: 'empty' });
  vi.restoreAllMocks();
  delete window.novusDesktop;
});

describe('ordinary UI layering owner boundaries', () => {
  it.each(['other-project', 'same-project-reset'] as const)
  ('does not create an old confirmation after %s while its actual SHA is awaited', async boundary => {
    const f = await fixture();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, bytes) => {
      const result = await digest(algorithm, bytes);
      if (boundary === 'other-project') f.switchProject();
      else f.resetSameProject();
      return result;
    });

    const result = await changedOwnerResult(f.create());

    expect(f.commit).not.toHaveBeenCalled();
    expect(result).toBe(false);
    expect(useAppStore.getState().project.nodes).toHaveLength(1);
    expect(useAppStore.getState().project.id).toBe(boundary === 'other-project' ? 'same-asset-other-project' : f.project.id);
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.chat).not.toHaveBeenCalled();
  });

  it.each(['other-project', 'same-project-reset', 'same-project-session'] as const)
  ('does not request visual analysis after %s during catalog loading', async boundary => {
    const f = await fixture();
    f.catalog.mockImplementationOnce(async () => {
      if (boundary === 'other-project') f.switchProject();
      else if (boundary === 'same-project-reset') f.resetSameProject();
      else f.changeSession();
      return profiles;
    });

    await expect(f.analyze()).rejects.toThrow(/project|source|changed|session|项目|素材|会话|变更/iu);
    expect(f.chat).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  it.each(['same-project-reset', 'same-project-session'] as const)
  ('rejects the old visual analysis result after %s while the response is pending', async boundary => {
    const f = await fixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    f.chat.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return f.response;
    });
    const analysis = f.analyze();
    await entered.promise;
    if (boundary === 'same-project-reset') f.resetSameProject();
    else f.changeSession();
    release.resolve();

    await expect(analysis).rejects.toThrow(/project|source|changed|session|项目|素材|会话|变更/iu);
    expect(f.chat).toHaveBeenCalledOnce();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  it.each(['same-project-reset', 'same-project-session'] as const)
  ('does not bind confirmed work after %s while the generation catalog is pending', async boundary => {
    const f = await fixture(true);
    const original = useAppStore.getState().project;
    f.catalog.mockImplementationOnce(async () => {
      if (boundary === 'same-project-reset') f.resetSameProject();
      else f.changeSession();
      return profiles;
    });

    const result = await changedOwnerResult(f.start());

    expect(f.commit).not.toHaveBeenCalled();
    expect(result).toBe(false);
    expect(useAppStore.getState().project).toEqual(original);
    expect([...f.jobs.values()].filter(job => ['queued', 'submitting', 'running'].includes(job.status))).toHaveLength(0);
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.chat).not.toHaveBeenCalled();
  });

  it('adopts the first execution session when the owner has no session yet', async () => {
    const f = await fixture(true);
    f.adoptNewSession();

    await expect(f.start()).resolves.toBe(true);

    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.submit).not.toHaveBeenCalled();
    expect([...f.jobs.values()]).toHaveLength(2);
    expect([...f.jobs.values()].every(job => job.projectSessionId === 'adopted-owner-session')).toBe(true);
  });

  it('refuses replacement of an established session during execution session initialization', async () => {
    const f = await fixture(true);
    f.replaceSessionOnEnsure();

    expect(await changedOwnerResult(f.start())).toBe(false);

    expect(f.commit).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
    expect([...f.jobs.values()]).toHaveLength(0);
  });

  it.each(sourceDrifts)('does not create a confirmation after source %s %s changes during SHA', async (owner, field) => {
    const f = await fixture();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, bytes) => {
      const value = await digest(algorithm, bytes);
      f.changeSource(owner, field);
      return value;
    });

    expect(await changedOwnerResult(f.create())).toBe(false);

    expect(f.commit).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
    expect(useAppStore.getState().project.nodes).toHaveLength(1);
  });

  it.each(sourceDrifts)('does not analyze after source %s %s changes during catalog loading', async (owner, field) => {
    const f = await fixture();
    f.catalog.mockImplementationOnce(async () => { f.changeSource(owner, field); return profiles; });

    await expect(f.analyze()).rejects.toThrow(/project|source|changed|session|项目|素材|会话|变更/iu);

    expect(f.chat).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  it.each(sourceDrifts)('rejects old analysis after source %s %s changes while its response waits', async (owner, field) => {
    const f = await fixture(), entered = deferred<void>(), release = deferred<void>();
    f.chat.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return f.response; });
    const analysis = f.analyze();
    await entered.promise;
    f.changeSource(owner, field);
    release.resolve();

    await expect(analysis).rejects.toThrow(/project|source|changed|session|项目|素材|会话|变更/iu);

    expect(f.chat).toHaveBeenCalledOnce();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  it.each(sourceDrifts)('does not bind work after source %s %s changes during the start catalog wait', async (owner, field) => {
    const f = await fixture(true);
    f.catalog.mockImplementationOnce(async () => { f.changeSource(owner, field); return profiles; });

    expect(await changedOwnerResult(f.start())).toBe(false);

    expect(f.commit).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
    expect([...f.jobs.values()].filter(job => ['queued', 'submitting', 'running'].includes(job.status))).toHaveLength(0);
    expect(useAppStore.getState().project.nodes.filter(node => node.type === 'module'
      && node.data.config.groupId === 'owner-boundary').every(node => node.type === 'module' && node.data.config.status === 'planned')).toBe(true);
  });

  it('accepts analysis after a source display label and URL refresh leaves its immutable identity unchanged', async () => {
    const f = await fixture();
    f.catalog.mockImplementationOnce(async () => { f.refreshSourcePresentation(); return profiles; });

    await expect(f.analyze()).resolves.toMatchObject({ sourceAssetId: f.sourceAssetId, canvasWidth: 24, canvasHeight: 24 });

    expect(f.chat).toHaveBeenCalledOnce();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  it('accepts start after a source display label and URL refresh leaves its immutable identity unchanged', async () => {
    const f = await fixture(true);
    f.catalog.mockImplementationOnce(async () => { f.refreshSourcePresentation(); return profiles; });

    await expect(f.start()).resolves.toBe(true);

    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.submit).not.toHaveBeenCalled();
    expect([...f.jobs.values()]).toHaveLength(2);
  });
});

async function changedOwnerResult(operation: Promise<boolean>) {
  try { return await operation; }
  catch (error) {
    expect(error instanceof Error ? error.message : String(error)).toMatch(/project|source|changed|session|项目|素材|会话|变更/iu);
    return false;
  }
}

async function fixture(withGroup = false) {
  const sourceAssetId = 'e'.repeat(16);
  const asset = { assetId: sourceAssetId, byteSize: 16, extension: 'png' as const, height: 24, width: 24,
    label: 'Same source fixture', mediaType: 'image/png' as const, origin: 'imported' as const, sha256: 'e'.repeat(64) };
  const source = createCanvasModuleNode('same-source-node', 'image_input', { x: 0, y: 0 });
  source.data.config.assetId = sourceAssetId;
  const plan: LayeringPlan = { sourceAssetId, canvasWidth: 24, canvasHeight: 24, pixelMode: 'source', layers: [
    { layerId: 'background', kind: 'background', name: 'Background', description: 'Restore background', included: true },
    { layerId: 'cup', kind: 'transparent', name: 'Cup', description: 'Only cup pixels', included: true,
      sourceBounds: { x: .1, y: .1, width: .5, height: .5 } },
  ] };
  const groupId = 'owner-boundary';
  const confirmation = await confirmLayeringPlan(plan, 'comfly', 'comfly-gpt-image-2', '1K', '2026-10-06T03:00:00.000Z');
  const baseProject = parseCanvasProject({ ...createStarterProject(), id: 'same-asset-owner-project',
    nodes: [source], edges: [], assets: [asset] });
  const project = withGroup
    ? applyProjectTransaction(baseProject, buildLayeringGraphTransaction(baseProject, plan, confirmation, groupId, source.id))
    : baseProject;
  const response = { modelRoute: 'fixture-vision', sources: [], message: JSON.stringify({ layers: [
    { ...plan.layers[0], elementIds: ['scene'] }, { ...plan.layers[1], elementIds: ['cup-object'] },
  ], elements: [
    { elementId: 'scene', name: 'Scene', layerId: 'background', kind: 'object' },
    { elementId: 'cup-object', name: 'Cup', layerId: 'cup', kind: 'object' },
  ] }) };
  const chat = vi.fn(async () => response);
  const submit = vi.fn(async () => ({ providerTaskId: 'must-not-submit' }));
  const commit = vi.fn(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> =>
    ({ ok: true, project: request.nextProject, revision: request.baseRevision + 1 }));
  const catalog = vi.fn(async () => profiles);
  const jobs = new Map<string, ModelJob>();
  let session: string | null = 'initial-owner-session';
  let ensuredSession: string | null = session;
  const installRuntime = () => {
    replaceProjectPersistenceClientForTests({ ...createBrowserPersistenceClient(), commit, chatSkill: chat,
      getSessionId: () => session, ensureModelExecutionSession: async () => { session = ensuredSession; return session; } });
    replaceModelJobStorageForTests({ get: async id => jobs.get(id), list: async () => [...jobs.values()],
      put: async job => { jobs.set(job.id, job); }, bulkPut: async batch => { for (const job of batch) jobs.set(job.id, job); } });
    replaceModelJobExecutorForTests({ submit, poll: async () => ({ status: 'failed', error: 'must-not-poll' }) });
    replaceLayeringRouteEvidenceForTests([{ provider: 'comfly', modelRoute: 'comfly-gpt-image-2', modelId: 'gpt-image-2',
      source: 'live_alpha_qa', verifiedAt: confirmation.confirmedAt, transparentBackground: true, outputFormat: 'png', resolutions: ['1K'] }]);
    window.novusDesktop = { provider: { getStatus: async () => ({ configured: true, locked: false, encryption: 'safeStorage' }),
      listProfiles: catalog } } as never;
  };
  const setOwnedProject = (next: CanvasProject) => useAppStore.setState({ project: next, projectLifecycle: 'durable',
    persistenceMode: 'desktop', desktopRevision: 4, saveStatus: 'saved',
    projectImages: [{ ...asset, displayUrl: 'same-owned-fixture', usageCount: 1 }] });
  installRuntime();
  setOwnedProject(project);
  return { project, response, commit, chat, submit, catalog, jobs, sourceAssetId,
    create: () => useAppStore.getState().createConfirmedLayeringGroup({ plan, confirmation, groupId, sourceNodeId: source.id }),
    start: () => useAppStore.getState().startConfirmedLayering({ plan, confirmation, groupId }),
    analyze: () => useAppStore.getState().analyzeImageLayering({ sourceAssetId, provider: 'comfly',
      modelRoute: 'fixture-vision', width: 24, height: 24 }),
    switchProject: () => setOwnedProject({ ...project, id: 'same-asset-other-project' }),
    changeSession: () => { session = 'replacement-owner-session'; ensuredSession = session; },
    adoptNewSession: () => { session = null; ensuredSession = 'adopted-owner-session'; },
    replaceSessionOnEnsure: () => { ensuredSession = 'replacement-owner-session'; },
    changeSource: (owner: typeof sourceDrifts[number][0], field: typeof sourceDrifts[number][1]) => {
      const patch: { sha256?: string; width?: number } = field === 'sha256' ? { sha256: sourceAssetId + 'f'.repeat(48) } : { width: 25 };
      useAppStore.setState(state => owner === 'summary' ? {
        projectImages: state.projectImages.map(value => value.assetId === sourceAssetId ? { ...value, ...patch } : value),
      } : { project: { ...state.project, assets: state.project.assets?.map(value => value.assetId === sourceAssetId
        ? { ...value, ...patch } : value) } });
    },
    refreshSourcePresentation: () => useAppStore.setState(state => ({ projectImages: state.projectImages.map(value =>
      value.assetId === sourceAssetId ? { ...value, label: 'Updated display label', displayUrl: 'refreshed-owned-source-url', usageCount: 2 } : value) })),
    resetSameProject: () => {
      resetAppStoreForTests({ project: 'empty' });
      session = 'replacement-owner-session';
      ensuredSession = session;
      installRuntime();
      setOwnedProject(structuredClone(project));
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
