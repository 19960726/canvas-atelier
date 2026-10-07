import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvasModuleNode, parseCanvasProject, type CanvasModuleNode, type CanvasProject, type ModelJob } from '@agent-canvas/domain';
import { createBrowserPersistenceClient } from './desktop-persistence';
import { createInMemoryModelJobStorage } from '../jobs/job-store';
import { replaceModelJobExecutorForTests, replaceModelJobStorageForTests, replaceProjectPersistenceClientForTests,
  resetAppStoreForTests, useAppStore } from './app-store';

const originalDesktop = window.novusDesktop;
const submit = vi.fn(async (job: ModelJob) => ({ providerTaskId: `fixture-${job.id}` }));

function installProject(count = 3, connected = true) {
  const assets = Array.from({ length: count }, (_, index) => ({
    assetId: (index + 1).toString(16).padStart(16, '0'), sha256: (index + 1).toString(16).padStart(16, '0').repeat(4),
    byteSize: 42, extension: 'png' as const, mediaType: 'image/png' as const, origin: 'imported' as const,
    width: 800, height: 600, label: `Owned reference ${index + 1}`,
  }));
  const library = createCanvasModuleNode('library', 'canvas_library', { x: 100, y: 100 });
  library.data.config.assetIds = assets.slice(0, -1).map(asset => asset.assetId);
  const single = createCanvasModuleNode('single', 'image_input', { x: 100, y: 500 });
  single.data.config.assetId = assets[count - 1]!.assetId;
  const target = createCanvasModuleNode('target', 'video_generation', { x: 700, y: 100 });
  target.data.config = { ...target.data.config, prompt: 'Preserve the ordered original materials.', modelRoute: 'fixture/video-library' };
  const project = parseCanvasProject({ version: 1, graphVersion: 2, id: 'video-library-project', name: 'Library references',
    nodes: [library, single, target], assets, edges: connected ? [
      { id: 'group', source: library.id, sourcePortId: 'images', target: target.id, targetPortId: 'media', order: 0 },
      { id: 'single', source: single.id, sourcePortId: 'image', target: target.id, targetPortId: 'media', order: 1 },
    ] : [] });
  replaceProjectPersistenceClientForTests(Object.assign(createBrowserPersistenceClient(), {
    ensureModelExecutionSession: async () => 'library-fixture-session', getSessionId: () => 'library-fixture-session',
    commit: async (request: { nextProject: CanvasProject; baseRevision: number }) => ({ ok: true as const,
      project: parseCanvasProject(request.nextProject), revision: request.baseRevision + 1 }),
    stablePoint: async () => ({ project: useAppStore.getState().project, revision: useAppStore.getState().desktopRevision,
      availableSnapshotIds: [], lifecycle: 'durable' as const }),
  }));
  useAppStore.setState({ project, projectLifecycle: 'durable', saveStatus: 'saved', desktopRevision: 7 });
  return { project, assets, library, single, target };
}

function runVideo() {
  return useAppStore.getState().runVideoPreviewNode('target', { prompt: 'Preserve the ordered original materials.',
    modelRoute: 'fixture/video-library', referenceAssetIds: [], aspectRatio: '16:9', keyframe: 'auto',
    durationSeconds: 5, resolution: '720p', outputCount: 1, audioEnabled: false });
}

beforeEach(() => {
  localStorage.clear();
  resetAppStoreForTests({ project: 'empty' });
  submit.mockClear();
  replaceModelJobStorageForTests(createInMemoryModelJobStorage());
  replaceModelJobExecutorForTests({ submit, poll: async () => ({ status: 'running', progress: 0.1 }), cancel: async () => {} });
  window.novusDesktop = { provider: {
    getStatus: async () => ({ configured: true, locked: false, encryption: 'safeStorage' }),
    listProfiles: async () => [{ provider: 'comfly', modelRoute: 'fixture/video-library', modelId: 'veo2-fast-components',
      displayName: 'Fixture video', capabilities: ['video_generation', 'async_tasks'] }],
  } } as unknown as typeof window.novusDesktop;
});

afterEach(() => {
  resetAppStoreForTests({ project: 'empty' });
  replaceProjectPersistenceClientForTests(createBrowserPersistenceClient());
  window.novusDesktop = originalDesktop;
  localStorage.clear();
});

describe('shared library video generation dispatch', () => {
  it('creates real compatible connections before dispatching the entire owned library group', async () => {
    const fixture = installProject(3, false);
    expect(await useAppStore.getState().connectModulePorts({ source: 'library', sourceHandle: 'images', target: 'target', targetHandle: 'media' })).toBe(true);
    expect(await useAppStore.getState().connectModulePorts({ source: 'single', sourceHandle: 'image', target: 'target', targetHandle: 'media' })).toBe(true);
    expect(await runVideo()).toBe(true);
    const referenceAssetIds = fixture.assets.map(asset => asset.assetId);
    expect(useAppStore.getState().modelJobs[0]).toMatchObject({ referenceAssetIds, kind: 'video' });
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({ referenceAssetIds })));
    const current = useAppStore.getState().project;
    expect(current.nodes.find(node => node.id === 'library')).toEqual(fixture.project.nodes[0]);
    expect(current.assets).toEqual(fixture.assets);
  });

  it('uses edge order and preserves member order when the independent image moves ahead of the group', async () => {
    const fixture = installProject();
    expect(await useAppStore.getState().reorderModuleInput('target', 'media', ['single', 'group'])).toBe(true);
    expect(await runVideo()).toBe(true);
    const referenceAssetIds = [fixture.assets[2]!.assetId, fixture.assets[0]!.assetId, fixture.assets[1]!.assetId];
    expect(useAppStore.getState().modelJobs[0]).toMatchObject({ referenceAssetIds });
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({ referenceAssetIds })));
    expect(useAppStore.getState().project.assets).toEqual(fixture.assets);
  });

  it('accepts a single library edge with two images without a cached assetId', async () => {
    const fixture = installProject();
    useAppStore.setState({ project: { ...fixture.project, edges: [fixture.project.edges[0]!] } });
    expect(await runVideo()).toBe(true);
    expect(useAppStore.getState().modelJobs[0]).toMatchObject({ referenceAssetIds: fixture.assets.slice(0, 2).map(asset => asset.assetId) });
  });

  it.each(['empty', 'missing', 'non-image', 'duplicate member', 'duplicate edge asset', 'wrong port'] as const)
  ('rejects %s library references before creating or submitting a job', async fault => {
    const fixture = installProject();
    const project = structuredClone(fixture.project);
    const library = project.nodes.find(node => node.id === 'library') as CanvasModuleNode;
    if (fault === 'empty') library.data.config.assetIds = [];
    if (fault === 'missing') library.data.config.assetIds = ['f'.repeat(16)];
    if (fault === 'non-image') project.assets![0] = { ...project.assets![0]!, mediaType: 'video/mp4', extension: 'mp4', origin: 'imported', durationMs: 1000 };
    if (fault === 'duplicate member') library.data.config.assetIds = [fixture.assets[0]!.assetId, fixture.assets[0]!.assetId];
    if (fault === 'duplicate edge asset') library.data.config.assetIds = [fixture.assets[0]!.assetId, fixture.assets[2]!.assetId];
    if (fault === 'wrong port') project.edges[0]!.sourcePortId = 'image';
    useAppStore.setState({ project });
    expect(await runVideo()).toBe(false);
    expect(useAppStore.getState().modelJobs).toHaveLength(0);
    expect(submit).not.toHaveBeenCalled();
  });

  it('checks provider capability after resolving exactly twenty owned references', async () => {
    installProject(20);
    await expect(runVideo()).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(useAppStore.getState().modelJobs).toHaveLength(0);
    expect(submit).not.toHaveBeenCalled();
  });

  it('rejects twenty-one flattened references across two edges before provider capability selection', async () => {
    installProject(21);
    expect(await runVideo()).toBe(false);
    expect(useAppStore.getState().modelJobs).toHaveLength(0);
    expect(submit).not.toHaveBeenCalled();
  });
});
