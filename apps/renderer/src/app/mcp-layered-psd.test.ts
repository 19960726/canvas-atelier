import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvasModuleNode, type CanvasProject, type CanvasModuleNode } from '@agent-canvas/domain';
import type { DesktopProjectImageBridgeApi, ProjectImageAssetSummary } from '@agent-canvas/desktop-core';
import { exportMcpLayeredPsd } from './mcp-layered-psd';
import * as pixels from './managed-layer-pixels';
import { buildLayeringReviewDigest } from './layering-proof';

afterEach(() => vi.restoreAllMocks());
function fixture(duplicate = false) {
  const width = 24, height = 24;
  const sourceId = 'a'.repeat(16), bgId = 'b'.repeat(16), cupId = 'c'.repeat(16), duplicateId = 'd'.repeat(16);
  const asset = (assetId: string, displayUrl: string) => ({ assetId, width, height, displayUrl, mediaType: 'image/png' as const, byteSize: 16, extension: 'png' as const, label: displayUrl, origin: 'imported' as const, sha256: assetId + 'f'.repeat(48), usageCount: 1 });
  const assets = [asset(sourceId, 'source'), asset(bgId, 'background'), asset(cupId, 'cup'), ...(duplicate ? [asset(duplicateId, 'duplicate')] : [])];
  const group = createCanvasModuleNode('group', 'image_layering', { x: 0, y: 0 });
  const bounds = { x: .1, y: .1, width: .5, height: .5 };
  group.data.config = { groupId: 'owned', sourceAssetId: sourceId, pixelMode: 'source', canvasWidth: width, canvasHeight: height, planLayers: [
    { layerId: 'background', kind: 'background', name: '背景' }, { layerId: 'cup', kind: 'transparent', name: '杯子', sourceBounds: bounds }, ...(duplicate ? [{ layerId: 'duplicate', kind: 'transparent', name: '重复杯子', sourceBounds: bounds }] : []),
  ] };
  const nodes = [group, ...assets.slice(1).map((record, order) => {
    const node = createCanvasModuleNode(record.displayUrl, 'image_layer', { x: 0, y: 0 });
    node.data.config = { groupId: 'owned', layerId: record.displayUrl, layerKind: order ? 'transparent' : 'background', name: order > 1 ? '重复杯子' : order ? '杯子' : '背景',
      sourceAssetId: sourceId, resultAssetId: record.assetId, qualityStatus: 'passed', maskSpace: 'source', sourceBounds: bounds, order, status: 'completed' };
    return node;
  })];
  const project = { version: 1, graphVersion: 2, id: 'owned-project', name: 'Export', assets, nodes, edges: [], projectMemory: [], skillPromotionCandidates: [] } as unknown as CanvasProject;
  const background = new Uint8Array(width * height * 4);
  for (let i = 0; i < background.length; i += 4) background.set([20,40,60,255], i);
  const source = background.slice();
  for (let y = 4; y < 10; y++) for (let x = 4; x < 10; x++) source.set([180,80,30,255], (y * width + x) * 4);
  const matte = new Uint8Array(background.length);
  for (let y = 4; y < 10; y++) for (let x = 4; x < 10; x++) matte.set([255,255,255, duplicate ? 64 : 255], (y * width + x) * 4);
  vi.spyOn(pixels, 'decodeLayerPixels').mockImplementation(async url => url === 'source' ? source.slice()
    : url === 'cup' || url === 'duplicate' ? matte.slice() : background.slice());
  const save = vi.fn(async (_bytes: Uint8Array) => ({ ok: true, saved: true }));
  const open = vi.fn(async (_bytes: Uint8Array) => ({ ok: true }));
  const bridge = { saveLayeredPsd: save, openLayeredPsdInPhotoshop: open } as unknown as DesktopProjectImageBridgeApi;
  const input = { nodeId: 'group', openPhotoshop: false, getProject: () => project, getRevision: () => 7, getAssets: () => assets as ProjectImageAssetSummary[], bridge };
  return { project, group, nodes, assets, save, open, input };
}

describe('MCP formal PSD uses actual source pixel gates', () => {
  it('rejects stale local assembly proof even when its strings still match', async () => {
    const f = fixture();
    const children = f.nodes.slice(1) as CanvasModuleNode[];
    const digest = await buildLayeringReviewDigest(f.group.data.config, children);
    f.group.data.config.assemblyConfirmationDigest = digest;
    for (const child of children) child.data.config.assemblyConfirmationDigest = digest;
    children[1]!.data.config.name = '已修改未复核';
    await expect(exportMcpLayeredPsd(f.input)).rejects.toThrow('PSD_EXPORT_REVIEW_CHANGED');
    expect(f.save).not.toHaveBeenCalled();
  });
  it('encodes a real layered PSD through the formal source helper and saves only once', async () => {
    const f = fixture();
    await expect(exportMcpLayeredPsd(f.input)).resolves.toEqual({ ok: true, saved: true, opened: false });
    expect(f.save).toHaveBeenCalledTimes(1); expect(f.open).not.toHaveBeenCalled();
    const bytes = f.save.mock.calls[0]![0] as unknown as Uint8Array;
    expect([...bytes.slice(0, 6)]).toEqual([0x38,0x42,0x50,0x53,0,1]);
    expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(18, false)).toBe(24);
  });
  it('rejects an actual low-alpha duplicated returned object before any save dialog', async () => {
    const f = fixture(true);
    await expect(exportMcpLayeredPsd(f.input)).rejects.toThrow(/杯子.*重复杯子.*透明贡献.*独立颜色/u);
    expect(f.save).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
  });
  it('requires every layer quality gate and managed source catalog ownership', async () => {
    const f = fixture(); (f.nodes[2] as CanvasModuleNode).data.config.qualityStatus = 'failed';
    await expect(exportMcpLayeredPsd(f.input)).rejects.toThrow('PSD_EXPORT_QUALITY_OR_POSITION_NOT_READY');
    expect(f.save).not.toHaveBeenCalled();
    (f.nodes[2] as CanvasModuleNode).data.config.qualityStatus = 'passed'; f.project.assets = [];
    await expect(exportMcpLayeredPsd(f.input)).rejects.toThrow('PSD_EXPORT_QUALITY_OR_POSITION_NOT_READY');
  });
  it('returns an explicit unsupported boundary for generated groups', async () => {
    const f = fixture(); f.group.data.config.pixelMode = 'generated';
    await expect(exportMcpLayeredPsd(f.input)).rejects.toThrow('PSD_EXPORT_UNSUPPORTED_GENERATED_GROUP');
    expect(f.save).not.toHaveBeenCalled();
  });
  it('refuses a PSD after layer order or bounds changed until reconfirmed', async () => {
    const f = fixture(); f.group.data.config.needsReconfirm = true;
    await expect(exportMcpLayeredPsd(f.input)).rejects.toThrow('PSD_EXPORT_RECONFIRM_REQUIRED');
    expect(f.save).not.toHaveBeenCalled();
  });
  it('rejects project/revision changes during real pixel preparation before saving', async () => {
    const f = fixture();
    const decode = vi.mocked(pixels.decodeLayerPixels).getMockImplementation()!;
    vi.spyOn(pixels, 'decodeLayerPixels').mockImplementation(async (...args) => { f.project.name = 'changed'; return decode(...args); });
    await expect(exportMcpLayeredPsd(f.input)).rejects.toThrow('PSD_EXPORT_CANVAS_CHANGED');
    expect(f.save).not.toHaveBeenCalled();
  });
  it('opens Photoshop only for an explicit flag and keeps saved-but-open-failed truthful', async () => {
    const f = fixture(); f.open.mockResolvedValueOnce({ ok: false, code: 'open_failed', saved: true } as never);
    await expect(exportMcpLayeredPsd({ ...f.input, openPhotoshop: true })).resolves.toEqual({ ok: false, code: 'open_failed', saved: true, opened: false });
    expect(f.open).toHaveBeenCalledTimes(1); expect(f.save).not.toHaveBeenCalled();
  });
});
