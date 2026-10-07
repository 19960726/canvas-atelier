import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvasModuleNode, type CanvasModuleNode, type CanvasProject } from '@agent-canvas/domain';
import type { LocalMattingRequest, LocalMattingResult } from '@agent-canvas/desktop-core/preload-api';
import type { ProjectImageAssetSummary } from '@agent-canvas/desktop-core';
import { createStarterProject, replaceProjectPersistenceClientForTests, resetAppStoreForTests, useAppStore } from './app-store';
import { createBrowserPersistenceClient, type ProjectCommitRequest, type ProjectCommitResult, type ProjectPersistenceClient } from './desktop-persistence';
import { decodeLayerPng, encodeLayerPng } from './layer-png-codec';

const encoding = vi.hoisted(() => ({ completed: undefined as (() => void) | undefined }));

vi.mock('./managed-layer-pixels', async importOriginal => {
  const actual = await importOriginal<typeof import('./managed-layer-pixels')>();
  return { ...actual, layerPixelsUrl: async (...args: Parameters<typeof actual.layerPixelsUrl>) => {
    const url = await actual.layerPixelsUrl(...args);
    // Let the real save continuation enqueue its import before the test resumes.
    queueMicrotask(() => encoding.completed?.());
    return url;
  } };
});

const digest = 'a'.repeat(64);
const groupId = 'queued-native-import-group';
const bounds = { x: 0, y: 0, width: 1, height: 1 };
const regions: LocalMattingRequest['regions'] = [{ mode: 'glass', box: { x: 0, y: 0, width: .5, height: 1 } }];

beforeEach(() => {
  delete window.novusDesktop;
  localStorage.clear();
  sessionStorage.clear();
  replaceProjectPersistenceClientForTests(createBrowserPersistenceClient());
  resetAppStoreForTests({ project: 'empty' });
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('File', NodeFile);
  vi.stubGlobal('Worker', undefined);
  encoding.completed = undefined;
});

afterEach(() => {
  encoding.completed = undefined;
  resetAppStoreForTests({ project: 'empty' });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.novusDesktop;
});

describe('native refinement imports waiting behind a real durable commit', () => {
  it('imports and binds the native PNG after a position commit without changing its source coordinates', async () => {
    const f = fixture();
    const pending = f.apply();
    await f.nativeEntered.promise;
    const blocker = useAppStore.getState().commitNodePosition(f.group.id, { x: 77, y: 88 });
    const request = await f.commitEntered.promise;
    f.nativeRelease.resolve(f.result);
    await f.encoded.promise;
    const importsWhileBlocked = f.imported.mock.calls.length;
    f.commitRelease.resolve({ ok: true, project: request.nextProject, revision: request.baseRevision + 1 });
    await expect(blocker).resolves.toBe(true);
    await expect(pending).resolves.toBeUndefined();

    expect(importsWhileBlocked).toBe(0);
    expect(f.imported).toHaveBeenCalledOnce();
    expect(f.commit).toHaveBeenCalledTimes(2);
    expect(f.paidSubmit).not.toHaveBeenCalled();
    const target = f.target();
    expect(target.data.config).toMatchObject({ sourceAssetId: f.source.assetId, sourceBounds: bounds,
      previousResultAssetId: f.previous.assetId, pixelMode: 'source', maskSpace: 'source',
      resultWidth: 2, resultHeight: 2, needsReconfirm: true });
    expect(decodeLayerPng(f.records.get(String(target.data.config.resultAssetId))!)?.rgba).toEqual(f.result.rgba);
    expect(useAppStore.getState().project.nodes.find(node => node.id === f.group.id)?.position).toEqual({ x: 77, y: 88 });
    expect(useAppStore.getState().project.assets?.some(asset => asset.assetId === f.previous.assetId)).toBe(true);
  });

  it.each(['source', 'group', 'session'] as const)
  ('rejects %s drift while the encoded native PNG import is queued, before persisting any new asset', async boundary => {
    const f = fixture();
    const outcome = settle(f.apply());
    await f.nativeEntered.promise;
    const blocker = useAppStore.getState().commitNodePosition(f.group.id, { x: 77, y: 88 });
    const request = await f.commitEntered.promise;
    f.nativeRelease.resolve(f.result);
    await f.encoded.promise;
    const importsWhileBlocked = f.imported.mock.calls.length;
    const acknowledged = f.drift(boundary, request.nextProject);
    f.commitRelease.resolve({ ok: true, project: acknowledged, revision: request.baseRevision + 1 });
    const blockerSaved = await blocker;
    const result = await outcome;

    expect(blockerSaved).toBe(true);
    expect(importsWhileBlocked).toBe(0);
    expect(f.imported).not.toHaveBeenCalled();
    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.paidSubmit).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/项目|图层|原图|素材|会话|确认|变更|保存/);
    expect(useAppStore.getState().project).toEqual(acknowledged);
    expect(f.target().data.config.resultAssetId).toBe(f.previous.assetId);
    expect(useAppStore.getState().projectImages).toHaveLength(2);
  });
});

function fixture() {
  const records = new Map<string, Uint8Array>();
  const summary = (rgba: Uint8Array): ProjectImageAssetSummary => {
    const bytes = encodeLayerPng(rgba, 2, 2), sha256 = createHash('sha256').update(bytes).digest('hex');
    const assetId = sha256.slice(0, 16);
    records.set(assetId, bytes);
    return { assetId, sha256, width: 2, height: 2, byteSize: bytes.length, extension: 'png',
      mediaType: 'image/png', origin: 'imported', label: assetId, usageCount: 1,
      displayUrl: 'data:image/png;base64,' + Buffer.from(bytes).toString('base64') };
  };
  const source = summary(Uint8Array.from([70, 71, 72, 255, 90, 91, 92, 255, 100, 101, 102, 255, 110, 111, 112, 255]));
  const previous = summary(Uint8Array.from([255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 0]));
  const managed = ({ displayUrl: _url, usageCount: _count, ...asset }: ProjectImageAssetSummary) => asset;
  const proof = { semanticReviewAccepted: true, semanticReviewDigest: 'b'.repeat(64), assemblyConfirmationDigest: 'b'.repeat(64),
    needsReconfirm: false, qualityStatus: 'passed', formatQualityStatus: 'passed', qualityValidationVersion: 2, status: 'completed' };
  const plans = [
    { layerId: 'background', kind: 'background', name: 'Background', description: 'Complete background', order: 0 },
    { layerId: 'cup', kind: 'transparent', name: 'Cup', description: 'Only cup pixels', sourceBounds: bounds, order: 1 },
  ];
  const group = createCanvasModuleNode('queued-native-composite', 'image_layering', { x: 0, y: 0 });
  group.data.config = { ...proof, groupId, sourceAssetId: source.assetId, canvasWidth: 2, canvasHeight: 2,
    pixelMode: 'source', layerSelection: { mode: 'whole' }, resultState: 'ready', planLayers: plans,
    layeringConfirmationDigest: digest, confirmationDigest: digest, foregroundOutputContract: 'source-alpha-matte-v1' };
  const layers = plans.map(plan => {
    const node = createCanvasModuleNode('queued-native-' + plan.layerId, 'image_layer', { x: 0, y: 0 });
    node.data.config = { ...proof, ...plan, groupId, layerKind: plan.kind, sourceAssetId: source.assetId,
      resultAssetId: previous.assetId, resultWidth: 2, resultHeight: 2, canvasWidth: 2, canvasHeight: 2,
      pixelMode: 'source', maskSpace: 'source', layerSelection: { mode: 'whole' },
      layeringConfirmationDigest: digest, confirmationDigest: digest, foregroundOutputContract: 'source-alpha-matte-v1',
      layeringOutputContract: plan.kind === 'background' ? 'opaque-background-v2' : 'source-alpha-matte-v1',
      resultRepresentation: plan.kind === 'background' ? 'background-image' : 'alpha-matte',
      jobId: 'previous-queued-native-' + plan.layerId + '-job', qualityFormatCheckedAssetId: previous.assetId };
    return node;
  });
  const layer = layers[1]!;
  const project: CanvasProject = { ...createStarterProject(), id: 'queued-native-owner-project',
    nodes: [group, ...layers], edges: [], assets: [managed(source), managed(previous)] };
  const nativeEntered = deferred<void>(), nativeRelease = deferred<LocalMattingResult>(), encoded = deferred<void>();
  const commitEntered = deferred<ProjectCommitRequest>(), commitRelease = deferred<ProjectCommitResult>();
  encoding.completed = () => encoded.resolve();
  const native = vi.fn(async (_request: LocalMattingRequest) => { nativeEntered.resolve(); return nativeRelease.promise; });
  const result: LocalMattingResult = { width: 2, height: 2,
    rgba: Uint8Array.from([19, 87, 201, 128, 0, 0, 0, 0, 180, 110, 70, 255, 0, 0, 0, 0]) };
  const paidSubmit = vi.fn();
  let sessionId = 'queued-native-original-session';
  const commit = vi.fn(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => ({ ok: true,
    project: request.nextProject, revision: request.baseRevision + 1 }));
  commit.mockImplementationOnce(async request => { commitEntered.resolve(request); return commitRelease.promise; });
  const imported = vi.fn<ProjectPersistenceClient['importProjectImage']>(async (_target, file) => {
    const bytes = new Uint8Array(await file!.arrayBuffer()), decoded = decodeLayerPng(bytes);
    if (!decoded || decoded.width !== 2 || decoded.height !== 2) throw new Error('Invalid queued native PNG');
    const asset = summary(decoded.rgba), current = useAppStore.getState();
    return { asset, project: { ...current.project, assets: [...(current.project.assets ?? []).filter(a => a.assetId !== asset.assetId), managed(asset)] },
      revision: current.desktopRevision + 1 };
  });
  replaceProjectPersistenceClientForTests({ ...createBrowserPersistenceClient(), commit, importProjectImage: imported,
    getSessionId: () => sessionId, ensureModelExecutionSession: async () => sessionId });
  window.novusDesktop = { projectImages: { importPreparedLayer: vi.fn(), refineLocalLayer: native },
    provider: { submitImageJob: paidSubmit } } as never;
  useAppStore.setState({ project, projectLifecycle: 'durable', persistenceMode: 'desktop', desktopRevision: 4,
    saveStatus: 'saved', projectImages: [source, previous] });
  return { project, group, layer, source, previous, records, result, nativeEntered, nativeRelease, encoded,
    commitEntered, commitRelease, native, imported, commit, paidSubmit,
    apply: () => useAppStore.getState().refineImageLayer(layer.id, project.id, regions),
    target: () => useAppStore.getState().project.nodes.find((node): node is CanvasModuleNode => node.type === 'module' && node.id === layer.id)!,
    drift: (boundary: 'source' | 'group' | 'session', acknowledged: CanvasProject) => {
      if (boundary === 'session') { sessionId = 'queued-native-replacement-session'; return acknowledged; }
      if (boundary === 'group') return { ...acknowledged, nodes: acknowledged.nodes.map(node => node.id === group.id && node.type === 'module'
        ? { ...node, data: { ...node.data, config: { ...node.data.config, layeringConfirmationDigest: 'f'.repeat(64) } } } : node) };
      useAppStore.setState(state => ({ projectImages: state.projectImages.map(asset => asset.assetId === source.assetId
        ? { ...asset, sha256: 'f'.repeat(64) } : asset) }));
      return { ...acknowledged, assets: acknowledged.assets?.map(asset => asset.assetId === source.assetId
        ? { ...asset, sha256: 'f'.repeat(64) } : asset) };
    },
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
