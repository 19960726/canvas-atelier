import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyProjectTransaction, createCanvasModuleNode, type CanvasProject } from '@agent-canvas/domain';
import { createDesktopPersistenceClient, type ProjectCommitRequest, type ProjectCommitResult, type ProjectImageImportResult, type ProjectPersistenceClient, type ProjectVideoImportResult } from './desktop-persistence';
import { createStarterProject, replaceProjectPersistenceClientForTests, resetAppStoreForTests, useAppStore } from './app-store';
import { AUTOSAVE_IDLE_MS } from './autosave';
import { installRendererE2EHarness } from '../test-mode/e2e-harness';

beforeEach(() => { delete window.novusDesktop; vi.useFakeTimers(); resetAppStoreForTests(); });
afterEach(() => { resetAppStoreForTests(); vi.useRealTimers(); vi.restoreAllMocks(); delete window.novusDesktop; delete window.__NOVUS_E2E__; Reflect.deleteProperty(globalThis, '__NOVUS_E2E_INSTALLED__'); });

describe('media import and queued autosave boundary', () => {
  it.each(['image', 'video'] as const)('invalidates an old %s snapshot already queued behind its import ACK', async (kind) => {
    const fixture = setup(kind);
    const importing = fixture.importMedia();
    useAppStore.getState().setProject(fixture.base);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    fixture.finishImport();
    await expect(importing).resolves.toBe(true);
    await vi.runAllTimersAsync();
    expect(boundAsset(useAppStore.getState().project)).toBe(fixture.asset.assetId);
    expect(boundAsset(fixture.durable())).toBe(fixture.asset.assetId);
    expect(useAppStore.getState().project.assets).toHaveLength(1);
  });

  it('saves pending local edits before importing so a native import cannot replace them', async () => {
    const fixture = setup('image');
    useAppStore.getState().setProject({ ...fixture.base, nodes: fixture.base.nodes.map((node) => node.id === 'generation' ? { ...node, data: { ...node.data, config: { prompt: 'Already typed before import', resolution: '4K' } } } as typeof node : node) });
    const importing = fixture.importMedia();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.events).toEqual(['save', 'import']);
    fixture.finishImport();
    await expect(importing).resolves.toBe(true);
    expect(generation(fixture.durable()).data.config.prompt).toBe('Already typed before import');
    expect(boundAsset(fixture.durable())).toBe(fixture.asset.assetId);
  });

  it('preserves an edit during import and saves its snapshot without a later pointermove preview', async () => {
    const fixture = setup('image');
    const importing = fixture.importMedia();
    const edited = { ...fixture.base, nodes: fixture.base.nodes.map((node) => node.id === 'generation' ? { ...node, position: { x: 80, y: 90 }, data: { ...node.data, config: { prompt: 'New prompt while importing', resolution: '4K' } } } as typeof node : node) };
    useAppStore.getState().setProject(edited);
    const preview = { ...edited, nodes: edited.nodes.map((node) => node.id === 'generation' ? { ...node, position: { x: 999, y: 999 } } : node) };
    useAppStore.getState().setProject(preview, { schedulePersist: false });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    fixture.finishImport();
    await expect(importing).resolves.toBe(true);
    await vi.runAllTimersAsync();
    expect(generation(fixture.durable())).toMatchObject({ position: { x: 80, y: 90 }, data: { config: { prompt: 'New prompt while importing', resolution: '4K' } } });
    expect(boundAsset(fixture.durable())).toBe(fixture.asset.assetId);
    expect(fixture.events).toEqual(['import', 'save']);
  });

  it.each(['image', 'video'] as const)('keeps other-node edits immediately at the %s ACK before their save timer fires', async (kind) => {
    const fixture = setup(kind);
    const importing = fixture.importMedia();
    useAppStore.getState().setProject({ ...fixture.base, nodes: fixture.base.nodes.map((node) => node.id === 'generation' && node.type === 'module' ? { ...node, data: { ...node.data, config: { ...node.data.config, prompt: 'Edited during native import', resolution: '4K' } } } : node) });
    fixture.finishImport();
    await expect(importing).resolves.toBe(true);
    expect(generation(useAppStore.getState().project).data.config).toMatchObject({ prompt: 'Edited during native import', resolution: '4K' });
    expect(useAppStore.getState().saveStatus).toBe('pending');
    await vi.runAllTimersAsync();
    expect(generation(fixture.durable()).data.config).toMatchObject({ prompt: 'Edited during native import', resolution: '4K' });
    expect(boundAsset(fixture.durable())).toBe(fixture.asset.assetId);
  });

  it('does not import after the pending draft save fails', async () => {
    const fixture = setup('image', true);
    fixture.imported.mockResolvedValue(null as never);
    useAppStore.getState().setProject({ ...fixture.base, name: 'Unsaved edit' });
    await expect(fixture.importMedia()).resolves.toBe(false);
    expect(fixture.events).toEqual(['save']);
    expect(fixture.imported).not.toHaveBeenCalled();
    expect(useAppStore.getState().saveStatus).toBe('error');
  });

  it('does not retarget an import when the project changes while the pending save drains', async () => {
    const saveAck = deferred<ProjectCommitResult>();
    const fixture = setup('image');
    fixture.imported.mockResolvedValue(null as never);
    replaceProjectPersistenceClientForTests(client({ commit: () => saveAck.promise, importProjectImage: fixture.imported as never }));
    useAppStore.getState().setProject({ ...fixture.base, name: 'Saving before switch' });
    const importing = fixture.importMedia();
    await vi.advanceTimersByTimeAsync(0);
    useAppStore.getState().setProject({ ...fixture.base, id: 'another-project' }, { schedulePersist: false });
    saveAck.resolve({ ok: true, project: fixture.base, revision: 1 });
    await expect(importing).resolves.toBe(false);
    expect(fixture.imported).not.toHaveBeenCalled();
    expect(useAppStore.getState().project.id).toBe('another-project');
  });

  it('keeps a newer ordinary autosave draft after the previous autosave ACK advances the revision', async () => {
    const first = deferred<ProjectCommitResult>();
    const requests: ProjectCommitRequest[] = [];
    const commit = vi.fn(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => {
      requests.push(request);
      return requests.length === 1 ? first.promise : { ok: true, project: request.nextProject, revision: 2 };
    });
    replaceProjectPersistenceClientForTests(client({ commit }));
    const base = createStarterProject();
    useAppStore.getState().setProject({ ...base, name: 'First draft' });
    const flushed = useAppStore.getState().flushProjectSave('blur');
    useAppStore.getState().setProject({ ...base, name: 'New draft during ACK' });
    first.resolve({ ok: true, project: requests[0]!.nextProject, revision: 1 });
    await expect(flushed).resolves.toBe(true);
    expect(requests.map((request) => request.nextProject.name)).toEqual(['First draft', 'New draft during ACK']);
  });

  it('protects the actual desktop client transaction chain, not just the E2E whole-project sink', async () => {
    const fixture = setup('image');
    let nativeProject = fixture.base;
    let revision = 0;
    const bridge = {
      openProject: async () => ({ project: nativeProject, projectId: nativeProject.id, projectName: nativeProject.name, sessionId: 'local-import-session', mode: 'write', currentRevision: revision, stableSnapshotId: null, stableSnapshotRevision: revision }),
      getRecoveryPlan: async () => ({ action: 'auto_recover', candidates: [], issues: [], projectId: nativeProject.id, recoveredRevision: null, stableSnapshotId: null, targetRevision: revision }),
      projectImages: {
        importImage: async () => { const result = await fixture.imported(); nativeProject = result.project; revision = result.revision; return { project: nativeProject, currentRevision: revision, asset: result.asset }; },
        list: async () => [],
      },
      commit: async (request: { baseRevision: number; transaction: ProjectCommitRequest['transaction'] }) => {
        expect(request.baseRevision).toBe(revision);
        nativeProject = applyProjectTransaction(nativeProject, request.transaction); revision += 1;
        return { revision };
      },
    };
    const nativeClient = createDesktopPersistenceClient(bridge as never);
    await nativeClient.openProject?.();
    replaceProjectPersistenceClientForTests(nativeClient);
    const importing = useAppStore.getState().importImageForModule('source');
    useAppStore.getState().setProject(fixture.base);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    fixture.finishImport();
    await expect(importing).resolves.toBe(true);
    await vi.runAllTimersAsync();
    expect(nativeProject.assets).toHaveLength(1);
    expect(boundAsset(nativeProject)).toBe(fixture.asset.assetId);
    expect(boundAsset(useAppStore.getState().project)).toBe(fixture.asset.assetId);
  });

  it('retains an actual managed E2E image import across idle saves and reopen', async () => {
    installRendererE2EHarness();
    await window.__NOVUS_E2E__!.resetEmpty();
    await window.__NOVUS_E2E__!.createModule('image_input');
    const project = useAppStore.getState().project;
    const source = project.nodes[0]!;
    window.__NOVUS_E2E__!.queueProjectImageImport({ label: 'Isolated reference', mediaType: 'image/png', width: 8, height: 8, byteSize: 64 });
    useAppStore.getState().setProject({ ...project, name: 'Queued draft before image import' });
    await expect(useAppStore.getState().importImageForModule(source.id)).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    await window.__NOVUS_E2E__!.reopenProject();
    expect(useAppStore.getState().project.assets).toHaveLength(1);
    expect(useAppStore.getState().project.nodes[0]).toMatchObject({ data: { config: { assetId: '0000000000000001' } } });
    expect(useAppStore.getState().project.name).toBe('Queued draft before image import');
  });

  it.each(['image', 'video'] as const)('retains an actual Agent %s attachment across its old scheduled draft and reopen', async (kind) => {
    installRendererE2EHarness();
    await window.__NOVUS_E2E__!.resetEmpty();
    if (kind === 'image') window.__NOVUS_E2E__!.queueProjectImageImport({ label: 'Agent image', mediaType: 'image/png', width: 8, height: 8, byteSize: 64 });
    else window.__NOVUS_E2E__!.queueProjectVideoImport({ label: 'Agent video', mediaType: 'video/mp4', byteSize: 64 });
    useAppStore.getState().setProject({ ...useAppStore.getState().project, name: 'Queued Agent draft' });
    const asset = kind === 'image' ? await useAppStore.getState().importAgentReferenceImage() : await useAppStore.getState().importAgentReferenceVideo();
    expect(asset?.assetId).toBe('0000000000000001');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    await window.__NOVUS_E2E__!.reopenProject();
    expect(useAppStore.getState().project.assets).toHaveLength(1);
    expect(useAppStore.getState().project.assets?.[0]?.assetId).toBe(asset?.assetId);
  });

  it.each(['image', 'video'] as const)('keeps a user prompt edited during Agent %s import and requeues its save with the attachment', async (kind) => {
    const fixture = setup(kind, false, true);
    const importing = kind === 'image' ? useAppStore.getState().importAgentReferenceImage() : useAppStore.getState().importAgentReferenceVideo();
    useAppStore.getState().setProject({ ...fixture.base, nodes: fixture.base.nodes.map((node) => node.id === 'generation' && node.type === 'module' ? { ...node, data: { ...node.data, config: { ...node.data.config, prompt: 'Agent requirements edited during import', resolution: '4K' } } } : node) });
    fixture.finishImport();
    await expect(importing).resolves.toMatchObject({ assetId: fixture.asset.assetId });
    expect(generation(useAppStore.getState().project).data.config.prompt).toBe('Agent requirements edited during import');
    await vi.runAllTimersAsync();
    expect(generation(fixture.durable()).data.config.prompt).toBe('Agent requirements edited during import');
    expect(useAppStore.getState().project.assets?.[0]?.assetId).toBe(fixture.asset.assetId);
    expect(boundAsset(fixture.durable())).toBeUndefined();
  });
});

function setup(kind: 'image' | 'video', failSave = false, agentReference = false) {
  const source = createCanvasModuleNode('source', kind === 'image' ? 'image_input' : 'video_input', { x: 0, y: 0 });
  const output = createCanvasModuleNode('generation', 'image_generation', { x: 20, y: 30 });
  const base: CanvasProject = { ...createStarterProject(), nodes: [source, output], edges: [], assets: [] };
  const asset = { assetId: '0123456789abcdef', byteSize: 64, extension: kind === 'image' ? 'png' as const : 'mp4' as const, height: 8, label: 'Isolated media', mediaType: kind === 'image' ? 'image/png' as const : 'video/mp4' as const, origin: 'imported' as const, sha256: '0123456789abcdef'.repeat(4), width: 8, ...(kind === 'video' ? { durationMs: 1000 } : {}) };
  let durable = base as CanvasProject;
  let revision = 0;
  const ack = deferred<ProjectImageImportResult | ProjectVideoImportResult>();
  const events: string[] = [];
  const imported = vi.fn(async () => { events.push('import'); return ack.promise; });
  const commit = vi.fn(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => {
    events.push('save');
    if (failSave) return { ok: false, project: durable, revision, code: 'DURABLE_WRITE_FAILED', retryable: true };
    durable = applyProjectTransaction(durable, request.transaction); revision += 1;
    return { ok: true, project: durable, revision };
  });
  replaceProjectPersistenceClientForTests(client({ commit, importProjectImage: imported as never, importProjectVideo: imported as never, importAgentReferenceVideo: imported as never }));
  useAppStore.setState({ project: base, desktopRevision: revision, saveStatus: 'saved', projectLifecycle: 'durable' });
  return {
    base, asset, events, imported, durable: () => durable,
    importMedia: () => kind === 'image' ? useAppStore.getState().importImageForModule('source') : useAppStore.getState().importVideoForModule('source'),
    finishImport() {
      durable = { ...durable, assets: [...(durable.assets ?? []), asset] as CanvasProject['assets'], nodes: durable.nodes.map((node) => !agentReference && node.id === 'source' && node.type === 'module' ? { ...node, data: { ...node.data, config: { ...node.data.config, assetId: asset.assetId } } } : node) };
      revision += 1;
      ack.resolve({ asset: { ...asset, displayUrl: 'novus-asset://isolated/reference', usageCount: 1 }, project: durable, revision } as ProjectImageImportResult | ProjectVideoImportResult);
    },
  };
}
function client(overrides: Partial<ProjectPersistenceClient>): ProjectPersistenceClient {
  const project = createStarterProject();
  return { close: async () => {}, commit: async (request) => ({ ok: true, project: request.nextProject, revision: request.baseRevision + 1 }), hydrate: async () => ({ availableSnapshotIds: [], mode: 'browser', project, revision: 0, saveStatus: 'saved' }), importProjectImage: async () => null, listProjectImages: async () => [], pasteClipboardImage: async () => null, restore: async () => ({ availableSnapshotIds: [], project, revision: 0, saveStatus: 'saved' }), stablePoint: async () => ({ availableSnapshotIds: [], project: useAppStore.getState().project, revision: useAppStore.getState().desktopRevision }), ...overrides };
}
function boundAsset(project: CanvasProject) { const node = project.nodes.find((item) => item.id === 'source'); return node?.type === 'module' ? node.data.config.assetId : undefined; }
function generation(project: CanvasProject) { return project.nodes.find((node) => node.id === 'generation')! as ReturnType<typeof createCanvasModuleNode>; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
