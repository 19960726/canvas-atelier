// The fixture intentionally resembles revision 572's missing format fields.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createCanvasModuleNode, createConfirmedModelJob, transitionModelJob, type CanvasModuleNode } from '@agent-canvas/domain';
import { createBrowserPersistenceClient, type ProjectPersistenceClient } from './desktop-persistence';
import { createStarterProject, replaceProjectPersistenceClientForTests, resetAppStoreForTests, useAppStore } from './app-store';
import { encodeLayerPng } from './layer-png-codec';
import { buildLayeringReviewDigest } from './layering-proof';
import * as managedLayerPixels from './managed-layer-pixels';

const roles = ['background', 'thermos-body', 'cup-lid', 'person-hands-arms', 'water-flow-and-splashes'];
const activeStatuses = ['queued', 'submitting', 'running'] as const;
const replace = (nodeId: string, projectId: string, file: File) => useAppStore.getState().replaceImageLayerAsset(nodeId, projectId, file);

function fixture() {
  const sourceId = '1'.repeat(16), oldId = '2'.repeat(16), digest = 'a'.repeat(64);
  const bounds = { x: 0, y: 0, width: 1, height: 1 };
  const group = createCanvasModuleNode('legacy-group', 'image_layering', { x: 0, y: 0 });
  const proof = { semanticReviewAccepted: true, semanticReviewDigest: digest, assemblyConfirmationDigest: digest,
    foregroundValidation: { ok: true }, needsReconfirm: false, qualityStatus: 'passed', qualityValidationVersion: 2 };
  const plans = roles.map((role, order) => ({ layerId: role, name: role,
    kind: order === 0 ? 'background' : 'transparent', order, ...(order ? { sourceBounds: bounds } : {}) }));
  group.data.config = { ...proof, groupId: 'legacy-five', sourceAssetId: sourceId, canvasWidth: 2, canvasHeight: 2,
    status: 'completed', resultState: 'ready', pixelMode: 'source', layerSelection: { mode: 'whole' }, layeringConfirmationDigest: digest, planLayers: plans };
  const layers = plans.map(plan => {
    const node = createCanvasModuleNode('legacy-' + plan.layerId, 'image_layer', { x: 0, y: 0 });
    node.data.config = { ...proof, groupId: 'legacy-five', layerId: plan.layerId, layerKind: plan.kind, name: plan.name,
      sourceAssetId: sourceId, resultAssetId: oldId, canvasWidth: 2, canvasHeight: 2, pixelMode: 'source', maskSpace: 'source',
      layerSelection: { mode: 'whole' }, sourceBounds: bounds, jobId: 'old-paid-' + plan.layerId,
      layeringConfirmationDigest: digest,
      resultRepresentation: plan.kind === 'background' ? 'background-image' : 'alpha-matte', status: 'completed', order: plan.order };
    // Deliberately no formatQualityStatus or qualityFormatCheckedAssetId.
    return node;
  });
  const pixels = Uint8Array.from([19, 87, 201, 1, 33, 44, 55, 0, 180, 110, 70, 255, 0, 0, 0, 0]);
  const makeFile = (rgba: Uint8Array) => {
    const bytes = encodeLayerPng(rgba, 2, 2);
    const file = { name: 'independent-hands.png', type: 'image/png', size: bytes.length,
      arrayBuffer: async () => bytes.slice().buffer } as File;
    return { file, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const first = makeFile(pixels), secondPixels = pixels.slice(); secondPixels[0] = 20;
  const second = makeFile(secondPixels);
  const summary = (assetId: string, sha256: string, byteSize: number) => ({ assetId, sha256, width: 2, height: 2,
    mediaType: 'image/png' as const, byteSize, extension: 'png' as const, origin: 'imported' as const, label: assetId,
    displayUrl: 'novus-asset://owned/' + assetId, usageCount: 1 });
  const managed = ({ displayUrl: _url, usageCount: _count, ...asset }: ReturnType<typeof summary>) => asset;
  const source = summary(sourceId, '1'.repeat(64), first.bytes.length), old = summary(oldId, '2'.repeat(64), first.bytes.length);
  const project = { ...createStarterProject(), nodes: [group, ...layers], edges: [], assets: [managed(source), managed(old)] };
  useAppStore.setState({ project, projectImages: [source, old], desktopRevision: 4, saveStatus: 'saved' });
  const imported = vi.fn<ProjectPersistenceClient['importProjectImage']>(async (_target, file) => {
    const bytes = new Uint8Array(await file!.arrayBuffer()), sha256 = createHash('sha256').update(bytes).digest('hex');
    const asset = summary(sha256.slice(0, 16), sha256, bytes.length), current = useAppStore.getState();
    return { asset, project: { ...current.project, assets: [...(current.project.assets ?? []), managed(asset)] }, revision: current.desktopRevision + 1 };
  });
  const commit = vi.fn(async (request: Parameters<ProjectPersistenceClient['commit']>[0]) =>
    ({ ok: true as const, project: request.nextProject, revision: request.baseRevision + 1 }));
  replaceProjectPersistenceClientForTests({ ...createBrowserPersistenceClient(), importProjectImage: imported, commit });
  return { project, group, layers, target: layers[3]!, first, second, imported, commit };
}

function boundJob(node: CanvasModuleNode, status: typeof activeStatuses[number], projectId?: string) {
  const queued = createConfirmedModelJob({ id: String(node.data.config.jobId), kind: 'image',
    promptNodeId: node.id, provider: 'comfly', modelRoute: 'local-test-layer-route', displayName: 'Local test layer route',
    modelId: 'local-test-layer-model', conversationId: 'legacy-five-jobs', ...(projectId ? { projectId } : {}),
    referenceAssetIds: [String(node.data.config.sourceAssetId)], layeringGroupId: String(node.data.config.groupId),
    layeringLayerId: String(node.data.config.layerId), confirmedAt: '2026-10-03T00:00:00.000Z' });
  if (status === 'queued') return queued;
  const submitting = transitionModelJob(queued, 'submitting');
  return status === 'submitting' ? submitting : transitionModelJob(submitting, 'running');
}

describe('legacy format checks following a local RGBA replacement', () => {
  beforeEach(() => {
    localStorage.clear(); replaceProjectPersistenceClientForTests(createBrowserPersistenceClient()); resetAppStoreForTests();
    window.novusDesktop = { projectImages: { importPreparedLayer: vi.fn() } } as never;
  });
  afterEach(() => { vi.restoreAllMocks(); delete window.novusDesktop; });
  async function replaceAndCheckLegacySiblings(f: ReturnType<typeof fixture>) {
    await replace(f.target.id, f.project.id, f.first.file);
    for (const node of f.layers.filter(node => node.id !== f.target.id)) {
      await useAppStore.getState().updateImageLayerQuality(node.id, f.project.id, String(node.data.config.resultAssetId), { ok: true });
    }
  }
  it('keeps an unaccepted group nongenerating and allows a second local replacement after legacy format success', async () => {
    const f = fixture(); await replaceAndCheckLegacySiblings(f);
    const nodes = useAppStore.getState().project.nodes as CanvasModuleNode[];
    const group = nodes.find(node => node.id === f.group.id)!;
    const target = nodes.find(node => node.id === f.target.id)!;
    expect.soft(activeStatuses).not.toContain(group.data.config.status);
    expect.soft(group.data.config.resultState).toBe('needs_review');
    expect(target.data.config).toMatchObject({ qualityStatus: 'pending', formatQualityStatus: 'passed', needsReconfirm: true });
    for (const node of nodes) {
      expect(node.data.config.needsReconfirm).toBe(true);
      for (const field of ['semanticReviewAccepted', 'semanticReviewDigest', 'assemblyConfirmationDigest', 'foregroundValidation']) {
        expect(node.data.config).not.toHaveProperty(field);
      }
    }
    expect(useAppStore.getState().modelJobs).toEqual([]);
    await expect(replace(f.target.id, f.project.id, f.second.file)).resolves.toBeUndefined();
    expect(f.imported).toHaveBeenCalledTimes(2);
    const latest = useAppStore.getState().project.nodes.find(node => node.id === f.target.id) as CanvasModuleNode;
    expect(latest.data.config).toMatchObject({ resultAssetId: f.second.sha256.slice(0, 16), previousResultAssetId: f.first.sha256.slice(0, 16),
      jobId: 'old-paid-person-hands-arms', qualityStatus: 'pending', needsReconfirm: true });
    expect(latest.data.config).not.toHaveProperty('layeringOutputContract');
  });
  it('keeps legacy format success in needs_review when the existing group requires reconfirmation', async () => {
    const f = fixture();
    const nodes = useAppStore.getState().project.nodes.map(node => {
      if (node.type !== 'module') return node;
      const config: Record<string, unknown> = { ...node.data.config, needsReconfirm: true };
      for (const field of ['semanticReviewAccepted', 'semanticReviewDigest', 'assemblyConfirmationDigest', 'foregroundValidation']) {
        delete config[field];
      }
      return { ...node, data: { ...node.data, config } };
    });
    useAppStore.setState({ project: { ...f.project, nodes } });
    for (const node of f.layers) {
      await useAppStore.getState().updateImageLayerQuality(node.id, f.project.id, String(node.data.config.resultAssetId), { ok: true });
    }
    const result = useAppStore.getState().project.nodes as CanvasModuleNode[];
    expect(result.find(node => node.id === f.group.id)!.data.config).toMatchObject({ status: 'validating', resultState: 'needs_review' });
    for (const layer of result.filter(node => node.data.moduleType === 'image_layer')) {
      expect(layer.data.config).toMatchObject({ qualityStatus: 'passed', formatQualityStatus: 'passed', needsReconfirm: true });
      for (const field of ['semanticReviewAccepted', 'semanticReviewDigest', 'assemblyConfirmationDigest', 'foregroundValidation']) {
        expect(layer.data.config).not.toHaveProperty(field);
      }
    }
  });
  it('ignores a foreign project active job with identical node/group IDs during format aggregation and replacement', async () => {
    const f = fixture(); await replaceAndCheckLegacySiblings(f);
    useAppStore.setState({ modelJobs: [boundJob(f.target, 'running', 'foreign-project')] });
    await useAppStore.getState().updateImageLayerQuality(f.layers[2]!.id, f.project.id,
      String(f.layers[2]!.data.config.resultAssetId), { ok: true });
    const group = useAppStore.getState().project.nodes.find(node => node.id === f.group.id) as CanvasModuleNode;
    expect.soft(activeStatuses).not.toContain(group.data.config.status);
    expect.soft(group.data.config.resultState).toBe('needs_review');
    await expect(replace(f.target.id, f.project.id, f.second.file)).resolves.toBeUndefined();
    expect(f.imported).toHaveBeenCalledTimes(2);
  });
  it('allows explicit review when only a foreign project active job reuses the same layer identifiers', async () => {
    const f = fixture(); await replaceAndCheckLegacySiblings(f);
    useAppStore.setState({ modelJobs: [boundJob(f.target, 'running', 'foreign-project')] });
    const nodes = useAppStore.getState().project.nodes as CanvasModuleNode[];
    const group = nodes.find(node => node.id === f.group.id)!;
    const children = nodes.filter(node => node.data.moduleType === 'image_layer');
    const snapshotDigest = await buildLayeringReviewDigest(group.data.config, children);
    await expect(useAppStore.getState().reviewImageLayeringGroup(group.id, f.project.id,
      { snapshotDigest, reviewedLayerIds: roles })).resolves.toBeUndefined();
    expect((useAppStore.getState().project.nodes.find(node => node.id === f.group.id) as CanvasModuleNode).data.config.resultState).toBe('ready');
  });
  it('allows local refinement when only a foreign project active job reuses the target node ID', async () => {
    const f = fixture();
    useAppStore.setState({ modelJobs: [boundJob(f.target, 'running', 'foreign-project')] });
    vi.spyOn(managedLayerPixels, 'decodeLayerPixels').mockResolvedValue(new Uint8Array(16));
    vi.spyOn(managedLayerPixels, 'layerPixelsUrl').mockResolvedValue('data:image/png;base64,' + Buffer.from(f.first.bytes).toString('base64'));
    const refine = vi.fn(async () => ({ width: 2, height: 2, rgba: new Uint8Array([19, 87, 201, 1, 33, 44, 55, 0, 180, 110, 70, 255, 0, 0, 0, 0]) }));
    window.novusDesktop = { projectImages: { importPreparedLayer: vi.fn(), refineLocalLayer: refine } } as never;
    await expect(useAppStore.getState().refineImageLayer(f.target.id, f.project.id, [])).resolves.toBeUndefined();
    expect(refine).toHaveBeenCalledOnce();
    expect(f.imported).toHaveBeenCalledOnce();
  });
  it('still blocks a durably bound legacy layer job without project/session fields', async () => {
    const f = fixture(); await replaceAndCheckLegacySiblings(f);
    useAppStore.setState({ modelJobs: [boundJob(f.target, 'running')] });
    const before = useAppStore.getState().project, commits = f.commit.mock.calls.length;
    await expect(replace(f.target.id, f.project.id, f.second.file)).rejects.toThrow(/尚未结束|等待/);
    expect(f.imported).toHaveBeenCalledOnce();
    expect(f.commit).toHaveBeenCalledTimes(commits);
    expect(useAppStore.getState().project).toEqual(before);
  });
  it.each(['current-project', 'bound-legacy'] as const)('keeps review and refinement blocked for a real %s layer job', async ownership => {
    const f = fixture(); await replaceAndCheckLegacySiblings(f);
    useAppStore.setState({ modelJobs: [boundJob(f.target, 'running', ownership === 'current-project' ? f.project.id : undefined)] });
    const before = useAppStore.getState().project, commits = f.commit.mock.calls.length;
    const nodes = before.nodes as CanvasModuleNode[];
    const group = nodes.find(node => node.id === f.group.id)!;
    const snapshotDigest = await buildLayeringReviewDigest(group.data.config,
      nodes.filter(node => node.data.moduleType === 'image_layer'));
    const refine = vi.fn();
    window.novusDesktop = { projectImages: { importPreparedLayer: vi.fn(), refineLocalLayer: refine } } as never;
    await expect(useAppStore.getState().reviewImageLayeringGroup(group.id, f.project.id,
      { snapshotDigest, reviewedLayerIds: roles })).rejects.toThrow(/尚未结束|等待/);
    await expect(useAppStore.getState().refineImageLayer(f.target.id, f.project.id, [])).rejects.toThrow(/尚未结束|等待/);
    expect(refine).not.toHaveBeenCalled();
    expect(f.imported).toHaveBeenCalledOnce();
    expect(f.commit).toHaveBeenCalledTimes(commits);
    expect(useAppStore.getState().project).toEqual(before);
  });
  it.each(activeStatuses)('still blocks a real %s generation after a returned-layer format check', async status => {
    const f = fixture(); await replaceAndCheckLegacySiblings(f);
    const group = useAppStore.getState().project.nodes.find(node => node.id === f.group.id) as CanvasModuleNode;
    // A false group running flag must not be the reason this guard test passes.
    expect(activeStatuses).not.toContain(group.data.config.status);
    useAppStore.setState({ modelJobs: [boundJob(f.layers[1]!, status, f.project.id)] });
    // Keep the group nongenerating here: the actual owned job itself must block replacement.
    await expect(replace(f.target.id, f.project.id, f.second.file)).rejects.toThrow(/尚未结束|等待/);
    expect(f.imported).toHaveBeenCalledOnce();
    await useAppStore.getState().updateImageLayerQuality(f.layers[2]!.id, f.project.id,
      String(f.layers[2]!.data.config.resultAssetId), { ok: true });
    const activeGroup = useAppStore.getState().project.nodes.find(node => node.id === f.group.id) as CanvasModuleNode;
    expect(activeGroup.data.config.status).toBe('running');
    expect(activeGroup.data.config.resultState).toBe('validating');
    const before = useAppStore.getState().project, commitCount = f.commit.mock.calls.length;
    await expect(replace(f.target.id, f.project.id, f.second.file)).rejects.toThrow(/尚未结束|等待/);
    expect(f.imported).toHaveBeenCalledOnce(); expect(f.commit).toHaveBeenCalledTimes(commitCount);
    expect(useAppStore.getState().project).toEqual(before);
  });
});
