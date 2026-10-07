import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyProjectTransaction, createCanvasModuleNode, parseCanvasProject, type CanvasProject, type ModelJob } from '@agent-canvas/domain';
import { createBrowserPersistenceClient } from './desktop-persistence';
import { useAppStore, resetAppStoreForTests, replaceProjectPersistenceClientForTests, replaceModelJobStorageForTests, replaceModelJobExecutorForTests, replaceLayeringRouteEvidenceForTests, createStarterProject } from './app-store';
import { buildLayeringGraphTransaction } from './layering-graph';
import { confirmLayeringPlan, type LayeringPlan } from './layering-plan';

describe('MCP layering actual store dispatch guard', () => {
  beforeEach(() => { delete window.novusDesktop; localStorage.clear(); resetAppStoreForTests(); });
  afterEach(() => { delete window.novusDesktop; replaceLayeringRouteEvidenceForTests(null); resetAppStoreForTests(); });
  it('rejects a same-asset project switch during actual confirmation SHA before any graph commit', async () => {
    const assetId = 'a1b2c3d4e5f60718';
    const asset = { assetId, byteSize: 16, extension: 'png', height: 24, label: '原图', mediaType: 'image/png', origin: 'imported', sha256: `${assetId}${'b'.repeat(48)}`, width: 24 };
    const node = createCanvasModuleNode('source', 'image_input', { x: 0, y: 0 }); node.data.config.assetId = assetId;
    const plan: LayeringPlan = { sourceAssetId: assetId, canvasWidth: 24, canvasHeight: 24, pixelMode: 'source', layers: [
      { layerId: 'background', kind: 'background', name: '背景', description: '背景重建', included: true },
      { layerId: 'cup', kind: 'transparent', name: '杯子', description: '仅杯子', included: true, sourceBounds: { x: .1, y: .1, width: .5, height: .5 } },
    ] };
    const confirmation = await confirmLayeringPlan(plan, 'comfly', 'comfly-gpt-image-2', '1K', new Date().toISOString());
    const project = parseCanvasProject({ ...createStarterProject(), assets: [asset], nodes: [node], edges: [] });
    useAppStore.setState({ project, desktopRevision: 4, projectImages: [{ ...asset, displayUrl: 'source', usageCount: 1 } as never] });
    const commit = vi.fn(async (request: Parameters<ReturnType<typeof createBrowserPersistenceClient>['commit']>[0]) => ({ ok: true as const, project: request.nextProject, revision: request.baseRevision + 1 }));
    replaceProjectPersistenceClientForTests({ ...createBrowserPersistenceClient(), commit });
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
      const result = await digest(algorithm, data);
      useAppStore.setState({ project: { ...project, id: 'other-project' } });
      return result;
    });
    try {
      const result = await useAppStore.getState().createConfirmedLayeringGroup({ plan, confirmation, groupId: 'wrong-owner', sourceNodeId: 'source', executionGuard: () => useAppStore.getState().project.id === project.id && useAppStore.getState().desktopRevision === 4 } as never);
      expect(commit).not.toHaveBeenCalled(); expect(result).toBe(false);
      expect(useAppStore.getState().project.nodes).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });
  it.each(['catalog', 'session', 'enqueue', 'binding'] as const)('keeps real image dispatch at zero on %s ownership/plan drift', async phase => {
    const assetId = 'a1b2c3d4e5f60718';
    const asset = { assetId, byteSize: 16, extension: 'png', height: 24, label: '原图', mediaType: 'image/png', origin: 'imported', sha256: `${assetId}${'b'.repeat(48)}`, width: 24 };
    const node = createCanvasModuleNode('source', 'image_input', { x: 0, y: 0 }); node.data.config.assetId = assetId;
    const plan: LayeringPlan = { sourceAssetId: assetId, canvasWidth: 24, canvasHeight: 24, pixelMode: 'source', layers: [
      { layerId: 'background', kind: 'background', name: '背景', description: '背景重建', included: true },
      { layerId: 'cup', kind: 'transparent', name: '杯子', description: '仅杯子', included: true, sourceBounds: { x: .1, y: .1, width: .5, height: .5 } },
    ] };
    const confirmation = await confirmLayeringPlan(plan, 'comfly', 'comfly-gpt-image-2', '1K', new Date().toISOString());
    const project = parseCanvasProject({ ...createStarterProject(), assets: [asset], nodes: [node], edges: [] });
    const created = applyProjectTransaction(project, buildLayeringGraphTransaction(project, plan, confirmation, 'guard', 'source'));
    useAppStore.setState({ project: created, desktopRevision: 4, projectImages: [{ ...asset, displayUrl: 'source-pixels', usageCount: 1 } as never] });
    const fingerprint = JSON.stringify(created);
    const corrupt = () => useAppStore.setState(state => ({ project: { ...state.project, name: 'external edit' }, desktopRevision: state.desktopRevision + 1 }));
    const jobs = new Map<string, ModelJob>();
    replaceModelJobStorageForTests({ get: async key => jobs.get(key), list: async () => [...jobs.values()], put: async job => { jobs.set(job.id, job); }, bulkPut: async batch => { for (const job of batch) jobs.set(job.id, job); if (phase === 'enqueue' && batch.some(job => job.status === 'queued')) corrupt(); } });
    const submit = vi.fn(async () => ({ providerTaskId: 'should-never-dispatch' }));
    replaceModelJobExecutorForTests({ submit, poll: async () => ({ status: 'failed', error: 'fixture' }) });
    replaceLayeringRouteEvidenceForTests([{ provider: 'comfly', modelRoute: 'comfly-gpt-image-2', modelId: 'gpt-image-2', source: 'live_alpha_qa', verifiedAt: new Date().toISOString(), transparentBackground: true, outputFormat: 'png', resolutions: ['1K'] }]);
    const client = createBrowserPersistenceClient();
    replaceProjectPersistenceClientForTests({ ...client, ensureModelExecutionSession: async () => { if (phase === 'session') corrupt(); return 'guard-session'; }, commit: async request => ({ ok: true, project: phase === 'binding' ? { ...request.nextProject, name: 'external edit in ACK' } : request.nextProject, revision: request.baseRevision + 1 }) });
    window.novusDesktop = { provider: {
      getStatus: async () => ({ configured: true, locked: false, encryption: 'safeStorage' }),
      listProfiles: async () => { if (phase === 'catalog') corrupt(); return [{ provider: 'comfly', modelRoute: 'comfly-gpt-image-2', modelId: 'gpt-image-2', displayName: 'GPT Image 2', capabilities: ['image_generation', 'image_edit', 'async_tasks'], capabilityStatus: 'complete', constraints: { image: { resolutions: ['1K'] } } }]; },
    } } as never;
    const executionGuard = (binding?: { project: CanvasProject; revision: number }) => {
      const state = useAppStore.getState();
      return binding ? binding.revision === 5 && state.desktopRevision === binding.revision && JSON.stringify(state.project) === JSON.stringify(binding.project)
        : state.desktopRevision === 4 && JSON.stringify(state.project) === fingerprint;
    };
    const result = await useAppStore.getState().startConfirmedLayering({ plan, confirmation, groupId: 'guard', executionGuard } as never).catch(() => false);
    if (result) await vi.waitFor(() => expect(submit).toHaveBeenCalled());
    expect(submit).not.toHaveBeenCalled();
    expect(result).toBe(false);
    expect([...jobs.values()].filter(job => job.status === 'queued' || job.status === 'running')).toHaveLength(0);
  });
});
