import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvasModuleNode, createConfirmedModelJob, transitionModelJob, type CanvasModuleNode, type CanvasProject } from '@agent-canvas/domain';
import type { LocalMattingRequest, LocalMattingResult } from '@agent-canvas/desktop-core/preload-api';
import type { ProjectImageAssetSummary } from '@agent-canvas/desktop-core';
import {
  createStarterProject, replaceProjectPersistenceClientForTests, resetAppStoreForTests, useAppStore,
} from './app-store';
import { createBrowserPersistenceClient, type ProjectCommitRequest, type ProjectPersistenceClient } from './desktop-persistence';
import { decodeLayerPng, encodeLayerPng } from './layer-png-codec';

const digest = 'a'.repeat(64);
const changedDigest = 'f'.repeat(64);
const groupId = 'native-owner-group';
const bounds = { x: 0, y: 0, width: 1, height: 1 };
const corrections: LocalMattingRequest['regions'] = [{ mode: 'glass', box: { x: 0, y: 0, width: .5, height: 1 } }];

beforeEach(() => {
  delete window.novusDesktop;
  localStorage.clear();
  sessionStorage.clear();
  replaceProjectPersistenceClientForTests(createBrowserPersistenceClient());
  resetAppStoreForTests({ project: 'empty' });
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('File', NodeFile);
  vi.stubGlobal('Worker', undefined);
});

afterEach(() => {
  resetAppStoreForTests({ project: 'empty' });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.novusDesktop;
});

describe('native legacy layer refinement owner boundaries', () => {
  it('saves a controlled native RGBA result in original coordinates and invalidates the old semantic proof', async () => {
    const f = fixture();
    const pending = f.apply();
    await f.entered.promise;
    expect(f.native).toHaveBeenCalledWith(expect.objectContaining({ width: 2, height: 2, bounds,
      regions: corrections, rgba: f.sourcePixels }));
    expect(f.imported).not.toHaveBeenCalled();
    f.release.resolve(f.result);
    await expect(pending).resolves.toBeUndefined();

    expect(f.native).toHaveBeenCalledOnce();
    expect(f.imported).toHaveBeenCalledOnce();
    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.paidSubmit).not.toHaveBeenCalled();
    const layer = f.target();
    expect(layer.data.config).toMatchObject({ sourceAssetId: f.source.assetId, jobId: 'previous-native-cup-job',
      sourceBounds: bounds, canvasWidth: 2, canvasHeight: 2, previousResultAssetId: f.previous.assetId,
      resultWidth: 2, resultHeight: 2, pixelMode: 'source', maskSpace: 'source', pixelColorSpace: 'foreground',
      mattingRegions: corrections, formatQualityStatus: 'passed', qualityFormatCheckedAssetId: layer.data.config.resultAssetId,
      needsReconfirm: true, layeringConfirmationDigest: digest, confirmationDigest: digest });
    const saved = f.records.get(String(layer.data.config.resultAssetId));
    expect(saved).toBeDefined();
    expect(decodeLayerPng(saved!)?.rgba).toEqual(f.result.rgba);
    expect(f.imported.mock.calls[0]![2]).toMatchObject({ preparedLayer: true });
    expect(useAppStore.getState().project.assets?.some(asset => asset.assetId === f.previous.assetId)).toBe(true);
    for (const member of f.members()) {
      expect(member.data.config.needsReconfirm).toBe(true);
      for (const field of ['semanticReviewAccepted', 'semanticReviewDigest', 'assemblyConfirmationDigest']) {
        expect(member.data.config).not.toHaveProperty(field);
      }
    }
  });

  it.each(['same-project-reset', 'same-project-session', 'source-sha', 'source-dimensions', 'source-unowned'] as const)
  ('rejects the delayed old native result after %s without importing or replacing a layer', async boundary => {
    const f = fixture();
    const outcome = settle(f.apply());
    await f.entered.promise;
    if (boundary === 'same-project-reset') f.resetSameProject();
    else if (boundary === 'same-project-session') f.changeSession();
    else if (boundary === 'source-sha') f.changeSource({ sha256: f.source.assetId + 'f'.repeat(48) });
    else if (boundary === 'source-dimensions') f.changeSource({ width: 3 });
    else f.removeSourceOwnership();
    const current = structuredClone(useAppStore.getState().project);
    f.release.resolve(f.result);

    const result = await outcome;
    expect(f.imported).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/项目|图层|原图|素材|会话|确认|变更|归属/);
    expect(useAppStore.getState().project).toEqual(current);
    expect(f.target().data.config.resultAssetId).toBe(f.previous.assetId);
    expect(f.paidSubmit).not.toHaveBeenCalled();
  });

  it.each([
    ['group', 'layeringConfirmationDigest'], ['group', 'confirmationDigest'], ['group', 'foregroundOutputContract'],
    ['target', 'layeringConfirmationDigest'], ['target', 'confirmationDigest'], ['target', 'foregroundOutputContract'],
    ['sibling', 'layeringConfirmationDigest'], ['sibling', 'confirmationDigest'], ['sibling', 'foregroundOutputContract'],
  ] as const)('rejects %s %s drift during native inference without invalidating the new confirmation', async (owner, field) => {
    const f = fixture();
    const outcome = settle(f.apply());
    await f.entered.promise;
    const nodeId = owner === 'group' ? f.group.id : owner === 'target' ? f.layer.id : f.sibling.id;
    f.patchNode(nodeId, { [field]: field === 'foregroundOutputContract' ? 'source-independent-rgba-v2' : changedDigest });
    const current = structuredClone(useAppStore.getState().project);
    f.release.resolve(f.result);

    const result = await outcome;
    expect(f.imported).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(useAppStore.getState().project).toEqual(current);
    expect(f.target().data.config.resultAssetId).toBe(f.previous.assetId);
    expect(f.paidSubmit).not.toHaveBeenCalled();
  });

  it.each(['description', 'bounds', 'result'] as const)
  ('rejects changed sibling %s while a native result is pending', async field => {
    const f = fixture();
    const outcome = settle(f.apply());
    await f.entered.promise;
    f.patchNode(f.sibling.id, field === 'description' ? { description: 'Updated separate vase ownership' }
      : field === 'bounds' ? { sourceBounds: { x: .25, y: .25, width: .5, height: .5 } }
        : { resultAssetId: f.source.assetId });
    const current = structuredClone(useAppStore.getState().project);
    f.release.resolve(f.result);

    const result = await outcome;
    expect(f.imported).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(useAppStore.getState().project).toEqual(current);
    expect(f.paidSubmit).not.toHaveBeenCalled();
  });

  it('rejects an actual newly running job on a sibling even if the target and group statuses stay completed', async () => {
    const f = fixture();
    const outcome = settle(f.apply());
    await f.entered.promise;
    const queued = createConfirmedModelJob({ id: String(f.sibling.data.config.jobId), kind: 'image',
      projectId: f.project.id, projectSessionId: f.session(), promptNodeId: f.sibling.id, provider: 'comfly',
      modelRoute: 'fixture-layer-route', modelId: 'fixture-layer-model', displayName: 'Local fixture route',
      conversationId: 'native-group-tasks', referenceAssetIds: [f.source.assetId],
      layeringGroupId: groupId, layeringLayerId: 'vase', confirmedAt: '2026-10-06T05:00:00.000Z' });
    const running = transitionModelJob(transitionModelJob(queued, 'submitting'), 'running');
    useAppStore.setState({ modelJobs: [running] });
    const current = structuredClone(useAppStore.getState().project);
    expect(f.target().data.config.status).toBe('completed');
    f.release.resolve(f.result);

    const result = await outcome;
    expect(f.imported).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(useAppStore.getState().project).toEqual(current);
    expect(useAppStore.getState().modelJobs).toEqual([running]);
    expect(f.paidSubmit).not.toHaveBeenCalled();
  });
});

function fixture() {
  const sourcePixels = Uint8Array.from([70, 71, 72, 255, 90, 91, 92, 255, 100, 101, 102, 255, 110, 111, 112, 255]);
  const mattePixels = Uint8Array.from([255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 0]);
  const refinedPixels = Uint8Array.from([19, 87, 201, 128, 0, 0, 0, 0, 180, 110, 70, 255, 0, 0, 0, 0]);
  const records = new Map<string, Uint8Array>();
  const summary = (rgba: Uint8Array): ProjectImageAssetSummary => {
    const bytes = encodeLayerPng(rgba, 2, 2), sha256 = createHash('sha256').update(bytes).digest('hex');
    const assetId = sha256.slice(0, 16);
    records.set(assetId, bytes);
    return { assetId, sha256, width: 2, height: 2, byteSize: bytes.length, extension: 'png',
      mediaType: 'image/png', origin: 'imported', label: assetId, usageCount: 1,
      displayUrl: 'data:image/png;base64,' + Buffer.from(bytes).toString('base64') };
  };
  const source = summary(sourcePixels), previous = summary(mattePixels);
  const managed = ({ displayUrl: _url, usageCount: _count, ...asset }: ProjectImageAssetSummary) => asset;
  const proof = { semanticReviewAccepted: true, semanticReviewDigest: 'b'.repeat(64), assemblyConfirmationDigest: 'b'.repeat(64),
    needsReconfirm: false, qualityStatus: 'passed', formatQualityStatus: 'passed', qualityValidationVersion: 2, status: 'completed' };
  const group = createCanvasModuleNode('native-owner-composite', 'image_layering', { x: 0, y: 0 });
  const plans = [
    { layerId: 'background', kind: 'background', name: 'Background', description: 'Complete background', order: 0 },
    { layerId: 'cup', kind: 'transparent', name: 'Cup', description: 'Only cup pixels', sourceBounds: bounds, order: 1 },
    { layerId: 'vase', kind: 'transparent', name: 'Vase', description: 'Only vase pixels', sourceBounds: bounds, order: 2 },
  ];
  group.data.config = { ...proof, groupId, sourceAssetId: source.assetId, canvasWidth: 2, canvasHeight: 2,
    pixelMode: 'source', layerSelection: { mode: 'whole' }, resultState: 'ready', planLayers: plans,
    layeringConfirmationDigest: digest, confirmationDigest: digest, foregroundOutputContract: 'source-alpha-matte-v1' };
  const layers = plans.map(plan => {
    const node = createCanvasModuleNode('native-owner-' + plan.layerId, 'image_layer', { x: 0, y: 0 });
    node.data.config = { ...proof, ...plan, groupId, layerKind: plan.kind, sourceAssetId: source.assetId,
      resultAssetId: previous.assetId, resultWidth: 2, resultHeight: 2, canvasWidth: 2, canvasHeight: 2,
      pixelMode: 'source', maskSpace: 'source', layerSelection: { mode: 'whole' },
      layeringConfirmationDigest: digest, confirmationDigest: digest, foregroundOutputContract: 'source-alpha-matte-v1',
      layeringOutputContract: plan.kind === 'background' ? 'opaque-background-v2' : 'source-alpha-matte-v1',
      resultRepresentation: plan.kind === 'background' ? 'background-image' : 'alpha-matte',
      jobId: 'previous-native-' + plan.layerId + '-job', qualityFormatCheckedAssetId: previous.assetId };
    return node;
  });
  const layer = layers[1]!, sibling = layers[2]!;
  const project: CanvasProject = { ...createStarterProject(), id: 'native-refine-owner-project',
    nodes: [group, ...layers], edges: [], assets: [managed(source), managed(previous)] };
  const entered = deferred<void>(), release = deferred<LocalMattingResult>();
  const native = vi.fn(async (_request: LocalMattingRequest) => { entered.resolve(); return release.promise; });
  const paidSubmit = vi.fn();
  const result: LocalMattingResult = { width: 2, height: 2, rgba: refinedPixels };
  let sessionId = 'native-original-session';
  const commit = vi.fn(async (request: ProjectCommitRequest) => ({ ok: true as const,
    project: request.nextProject, revision: request.baseRevision + 1 }));
  const imported = vi.fn<ProjectPersistenceClient['importProjectImage']>(async (_target, file) => {
    const bytes = new Uint8Array(await file!.arrayBuffer()), decoded = decodeLayerPng(bytes);
    if (!decoded || decoded.width !== 2 || decoded.height !== 2) throw new Error('Invalid native fixture import');
    const asset = summary(decoded.rgba), current = useAppStore.getState();
    return { asset, project: { ...current.project, assets: [...(current.project.assets ?? []).filter(a => a.assetId !== asset.assetId), managed(asset)] },
      revision: current.desktopRevision + 1 };
  });
  const client = { ...createBrowserPersistenceClient(), commit, importProjectImage: imported,
    getSessionId: () => sessionId, ensureModelExecutionSession: async () => sessionId };
  replaceProjectPersistenceClientForTests(client);
  window.novusDesktop = { projectImages: { importPreparedLayer: vi.fn(), refineLocalLayer: native },
    provider: { submitImageJob: paidSubmit } } as never;
  const adopt = (next: CanvasProject = project) => useAppStore.setState({ project: next, projectLifecycle: 'durable',
    persistenceMode: 'desktop', desktopRevision: 4, saveStatus: 'saved', projectImages: [source, previous] });
  adopt();
  const members = () => useAppStore.getState().project.nodes.filter((node): node is CanvasModuleNode =>
    node.type === 'module' && node.data.config.groupId === groupId);
  const patchNode = (nodeId: string, patch: Record<string, unknown>) => useAppStore.setState(state => ({ project: {
    ...state.project, nodes: state.project.nodes.map(node => node.id === nodeId && node.type === 'module'
      ? { ...node, data: { ...node.data, config: { ...node.data.config, ...patch } } } : node),
  } }));
  return { project, group, layer, sibling, source, previous, records, sourcePixels, result, entered, release,
    native, paidSubmit, imported, commit, members, patchNode,
    target: () => members().find(node => node.id === layer.id)!,
    apply: () => useAppStore.getState().refineImageLayer(layer.id, project.id, corrections),
    session: () => sessionId,
    changeSession: () => { sessionId = 'native-replacement-session'; },
    resetSameProject: () => { resetAppStoreForTests({ project: 'empty' }); adopt(structuredClone(project)); },
    changeSource: (patch: Partial<ProjectImageAssetSummary>) => useAppStore.setState(state => ({
      projectImages: state.projectImages.map(asset => asset.assetId === source.assetId ? { ...asset, ...patch } : asset),
      project: { ...state.project, assets: state.project.assets?.map(asset => asset.assetId === source.assetId
        ? { ...asset, ...managed({ ...source, ...patch }) } : asset) },
    })),
    removeSourceOwnership: () => useAppStore.setState(state => ({ project: { ...state.project,
      assets: state.project.assets?.filter(asset => asset.assetId !== source.assetId) } })),
  };
}

function settle(operation: Promise<void>) {
  return operation.then(() => ({ ok: true, error: undefined }), error => ({ ok: false, error: error as Error }));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
