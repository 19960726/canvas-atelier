import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createCanvasModuleNode, type CanvasModuleNode } from '@agent-canvas/domain';
import { createBrowserPersistenceClient, type ProjectPersistenceClient } from './desktop-persistence';
import { createStarterProject, replaceProjectPersistenceClientForTests, resetAppStoreForTests, useAppStore } from './app-store';
import { encodeLayerPng } from './layer-png-codec';

const replace = (nodeId: string, projectId: string, file: File) =>
  (useAppStore.getState() as unknown as { replaceImageLayerAsset(n: string, p: string, f: File): Promise<void> })
    .replaceImageLayerAsset(nodeId, projectId, file);

describe('local independent RGBA replacement', () => {
  beforeEach(() => {
    localStorage.clear();
    replaceProjectPersistenceClientForTests(createBrowserPersistenceClient());
    resetAppStoreForTests();
    window.novusDesktop = { projectImages: { importPreparedLayer: vi.fn() } } as never;
  });
  afterEach(() => { vi.restoreAllMocks(); delete window.novusDesktop; });
  const fixture = () => {
    const sourceId = '1'.repeat(16), oldId = '2'.repeat(16);
    const bounds = { x: .2, y: .1, width: .5, height: .7 };
    const group = createCanvasModuleNode('local-group-node', 'image_layering', { x: 0, y: 0 });
    const layer = createCanvasModuleNode('local-cup-node', 'image_layer', { x: 0, y: 0 });
    const background = createCanvasModuleNode('local-bg-node', 'image_layer', { x: 0, y: 0 });
    const proof = { semanticReviewAccepted: true, semanticReviewDigest: 'b'.repeat(64),
      assemblyConfirmationDigest: 'b'.repeat(64), needsReconfirm: false, qualityStatus: 'passed',
      formatQualityStatus: 'passed', qualityValidationVersion: 2 };
    group.data.config = { ...proof, groupId: 'owned-group', sourceAssetId: sourceId, canvasWidth: 2, canvasHeight: 2,
      pixelMode: 'source', layerSelection: { mode: 'whole' }, layeringConfirmationDigest: 'a'.repeat(64),
      planLayers: [{ layerId: 'background', kind: 'background', name: 'background', order: 0 },
        { layerId: 'cupbody', kind: 'transparent', name: 'cupbody', order: 1, sourceBounds: bounds }] };
    layer.data.config = { ...proof, groupId: 'owned-group', layerId: 'cupbody', layerKind: 'transparent',
      name: 'cupbody', sourceAssetId: sourceId, sourceBounds: bounds, canvasWidth: 2, canvasHeight: 2,
      pixelMode: 'source', layerSelection: { mode: 'whole' }, maskSpace: 'source', resultAssetId: oldId,
      qualityFormatCheckedAssetId: oldId, jobId: 'old-paid-job', status: 'completed',
      layeringOutputContract: 'source-alpha-matte-v1', layeringConfirmationDigest: 'a'.repeat(64),
      resultRepresentation: 'alpha-matte', foregroundProvenance: 'old-proof', foregroundValidation: { ok: true },
      mattingRegions: [{ mode: 'keep', box: bounds }], refinedFromAssetId: 'old-refinement', order: 1 };
    background.data.config = { ...proof, groupId: 'owned-group', layerId: 'background', layerKind: 'background',
      name: 'background', sourceAssetId: sourceId, resultAssetId: oldId, canvasWidth: 2, canvasHeight: 2,
      qualityFormatCheckedAssetId: oldId, status: 'completed', layeringConfirmationDigest: 'a'.repeat(64) };
    const pixels = Uint8Array.from([19, 87, 201, 1, 33, 44, 55, 0, 180, 110, 70, 255, 0, 0, 0, 0]);
    const png = encodeLayerPng(pixels, 2, 2);
    const importedSha = createHash('sha256').update(png).digest('hex'), newId = importedSha.slice(0,16);
    const summary = (assetId: string, sha256: string) => ({ assetId, sha256, width: 2, height: 2,
      mediaType: 'image/png' as const, byteSize: png.length, extension: 'png' as const, origin: 'imported' as const,
      label: assetId, displayUrl: 'novus-asset://owned/' + assetId, usageCount: 1 });
    const source = summary(sourceId, '1'.repeat(64)), old = summary(oldId, '2'.repeat(64));
    const importedAsset = summary(newId, importedSha);
    const managed = ({displayUrl:_url,usageCount:_count,...asset}:ReturnType<typeof summary>)=>asset;
    const project = { ...createStarterProject(), nodes: [group, background, layer], edges: [], assets: [managed(source), managed(old)] };
    useAppStore.setState({ project, projectImages: [source, old], desktopRevision: 4, saveStatus: 'saved' });
    const imported = vi.fn<ProjectPersistenceClient['importProjectImage']>(async () => ({ asset: importedAsset,
      project: { ...useAppStore.getState().project, assets: [...(useAppStore.getState().project.assets ?? []), managed(importedAsset)] }, revision: 5 }));
    const commit = vi.fn(async (request: Parameters<ProjectPersistenceClient['commit']>[0]) =>
      ({ ok: true as const, project: request.nextProject, revision: request.baseRevision + 1 }));
    replaceProjectPersistenceClientForTests({ ...createBrowserPersistenceClient(), importProjectImage: imported, commit });
    const file = { name: 'fixed-cupbody.png', size: png.length, type: 'image/png', arrayBuffer: async () => png.slice().buffer } as File;
    return { sourceId, oldId, newId, group, layer, background, source, importedAsset, project, file, imported, commit };
  };
  it('imports actual bytes through the guarded native path while keeping the original v1 job and requiring fresh review', async () => {
    const f = fixture();
    await replace(f.layer.id, f.project.id, f.file);
    expect(f.imported).toHaveBeenCalledOnce();
    expect(f.imported.mock.calls[0]![2]).toMatchObject({ preparedLayer: true, layerTarget: {
      projectId: f.project.id, nodeId: f.layer.id, groupId: 'owned-group', layerId: 'cupbody',
      sourceAssetId: f.sourceId, expectedResultAssetId: f.oldId, expectedRevision: 4 } });
    const current = useAppStore.getState().project.nodes.find(n => n.id === f.layer.id) as CanvasModuleNode;
    expect(current.data.config).toMatchObject({ resultAssetId: f.newId, previousResultAssetId: f.oldId, resultWidth: 2, resultHeight: 2,
      jobId: 'old-paid-job', layeringOutputContract: 'source-alpha-matte-v1', layeringConfirmationDigest: 'a'.repeat(64),
      sourceBounds: f.layer.data.config.sourceBounds, formatQualityStatus: 'passed', qualityFormatCheckedAssetId: f.newId,
      qualityStatus: 'pending', needsReconfirm: true, resultRepresentation: 'independent-rgba-candidate',
      foregroundProvenance: { kind: 'local-rgba-import', version: 1, assetId: f.newId, sha256: f.importedAsset.sha256,
        sourceAssetId: f.sourceId, sourceSha256: f.source.sha256, width: 2, height: 2 } });
    expect(current.data.config).not.toHaveProperty('semanticReviewAccepted');
    expect(current.data.config).not.toHaveProperty('foregroundValidation');
    expect(current.data.config).not.toHaveProperty('mattingRegions');
    for (const node of useAppStore.getState().project.nodes as CanvasModuleNode[]) {
      expect(node.data.config).not.toHaveProperty('assemblyConfirmationDigest');
      expect(node.data.config.needsReconfirm).toBe(true);
    }
    expect(useAppStore.getState().project.assets?.some(asset => asset.assetId === f.oldId)).toBe(true);
    expect(useAppStore.getState().modelJobs).toEqual([]);
  });
  it('rejects wrong full-canvas dimensions without native import or target mutation', async () => {
    const f = fixture(), bytes = encodeLayerPng(new Uint8Array([10, 20, 30, 255]), 1, 1);
    await expect(replace(f.layer.id, f.project.id, { arrayBuffer: async () => bytes.buffer, size: bytes.length } as File)).rejects.toThrow(/尺寸/);
    expect(f.imported).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled();
    expect(useAppStore.getState().project.nodes.find(n => n.id === f.layer.id)).toEqual(f.layer);
  });
  it('does not replace the latest target if an async file read changes its bounds', async () => {
    const f = fixture();
    const file = { ...f.file, arrayBuffer: async () => {
      const p = useAppStore.getState().project;
      useAppStore.setState({ project: { ...p, nodes: p.nodes.map(n => n.id === f.layer.id
        ? { ...f.layer, data: { ...f.layer.data, config: { ...f.layer.data.config, sourceBounds: { x: 0, y: 0, width: 1, height: 1 } } } } : n) } });
      return f.file.arrayBuffer();
    } } as File;
    await expect(replace(f.layer.id, f.project.id, file)).rejects.toThrow(/变更/);
    expect(f.imported).not.toHaveBeenCalled();
    expect((useAppStore.getState().project.nodes.find(n => n.id === f.layer.id) as CanvasModuleNode).data.config.resultAssetId).toBe(f.oldId);
  });
  it('keeps old bytes and old graph when the second phase cannot be committed', async () => {
    const f = fixture();
    f.commit.mockImplementation(async request => ({ ok: false, project: request.previousProject, revision: 5,
      code: 'DURABLE_WRITE_FAILED', retryable: true }) as never);
    await expect(replace(f.layer.id, f.project.id, f.file)).rejects.toThrow(/保存|替换/);
    expect(useAppStore.getState().project.nodes.find(n => n.id === f.layer.id)).toEqual(f.layer);
  });
  it.each(['empty','opaque','background-hole','running','unowned-source'] as const)('rejects %s without consuming the old result', async mode => {
    const f=fixture();
    if(mode==='running') useAppStore.setState({modelJobs:[{id:'active',kind:'image',modelId:'local-test-layer-model',retryCount:0,
      status:'running',projectId:f.project.id,promptNodeId:f.layer.id,layeringGroupId:'owned-group',layeringLayerId:'cupbody',
      referenceAssetIds:[f.sourceId]}]});
    if(mode==='unowned-source') useAppStore.setState({project:{...f.project,assets:[]}});
    const pixels=new Uint8Array(16);
    if(mode==='opaque') for(let p=0;p<4;p++)pixels.set([10,20,30,255],p*4);
    if(mode==='background-hole') {
      pixels.set([10,20,30,255],0);
      const config={...f.layer.data.config,layerKind:'background'};
      const groupConfig={...f.group.data.config,planLayers:[{layerId:'cupbody',kind:'background'}]};
      useAppStore.setState({project:{...f.project,nodes:[{...f.group,data:{...f.group.data,config:groupConfig}},
        {...f.layer,data:{...f.layer.data,config}}]}});
    }
    const png=encodeLayerPng(pixels,2,2);
    const file = mode === 'running' ? f.file : {arrayBuffer:async()=>png.buffer,size:png.length} as File;
    await expect(replace(f.layer.id,f.project.id,file)).rejects.toThrow(mode === 'running' ? /尚未结束|等待/ : undefined);
    expect(f.imported).not.toHaveBeenCalled();expect(f.commit).not.toHaveBeenCalled();
    expect((useAppStore.getState().project.nodes.find(n=>n.id===f.layer.id) as CanvasModuleNode).data.config.resultAssetId).toBe(f.oldId);
  });
  it('does not bind new material after a native import acknowledgement arrives in another project', async()=>{
    const f=fixture();
    f.imported.mockImplementation(async()=>{
      const next={...createStarterProject(),id:'another-project'};
      useAppStore.setState({project:next});
      return {asset:f.importedAsset,project:f.project,revision:5};
    });
    await expect(replace(f.layer.id,f.project.id,f.file)).rejects.toThrow(/保存|变更/);
    expect(useAppStore.getState().project.id).toBe('another-project');expect(f.commit).not.toHaveBeenCalled();
  });
});
