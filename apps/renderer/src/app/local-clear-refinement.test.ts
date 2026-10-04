import { afterEach, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { createHash } from 'node:crypto';
import { applyLocalClearRegions, planLocalClearRefinement, readLocalClearBaseline } from './local-clear-refinement';
import { encodeLayerPng } from './layer-png-codec';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const clear = { mode: 'clear' as const, box: { x: .5, y: 0, width: .5, height: .5 } };
it('copies every byte outside the explicit clear and does not mutate low-alpha or hidden baseline RGB', () => {
  const baseline = Uint8Array.from([19,87,201,1, 180,110,70,255, 33,44,55,0, 3,199,47,128]), before = baseline.slice();
  expect(applyLocalClearRegions(baseline, 2, 2, [clear])).toEqual(Uint8Array.from([19,87,201,1, 0,0,0,0, 33,44,55,0, 3,199,47,128]));
  expect(baseline).toEqual(before);
});
it('uses original pixel boundaries without clearing the neighboring column after normalization', () => {
  const baseline = new Uint8Array(2196 * 2 * 4).fill(255);
  const result = applyLocalClearRegions(baseline, 2196, 2, [{ mode: 'clear', box: { x: 970 / 2196, y: 0, width: 8 / 2196, height: .5 } }]);
  expect(result.slice(969 * 4, 970 * 4)).toEqual(Uint8Array.from([255,255,255,255]));
  expect(result.slice(970 * 4, 978 * 4)).toEqual(new Uint8Array(32));
  expect(result.slice(978 * 4, 979 * 4)).toEqual(Uint8Array.from([255,255,255,255]));
  expect(result.slice(2196 * 4)).toEqual(baseline.slice(2196 * 4));
});
it('does not treat keep/glass hints as pixel erasers or accept malformed clear bounds', () => {
  const rgba = new Uint8Array(16);
  expect(() => applyLocalClearRegions(rgba, 2, 2, [{ ...clear, mode: 'keep' }])).toThrow();
  expect(() => applyLocalClearRegions(rgba, 2, 2, [{ ...clear, mode: 'glass' }])).toThrow();
  expect(() => applyLocalClearRegions(rgba, 2, 2, [{ mode: 'clear', box: { x: .9, y: 0, width: .3, height: .5 } }])).toThrow();
});
const fixture = () => {
  const source = { assetId: 'b'.repeat(16), sha256: 'b'.repeat(64), width: 2, height: 2, mediaType: 'image/png' };
  const result = { assetId: 'a'.repeat(16), sha256: 'a'.repeat(64), width: 2, height: 2, mediaType: 'image/png' };
  const keep = { ...clear, mode: 'keep' as const };
  const config = { sourceAssetId: source.assetId, resultAssetId: result.assetId, canvasWidth: 2, canvasHeight: 2,
    layerKind: 'transparent', maskSpace: 'source', mattingRegions: [keep], layeringOutputContract: 'source-independent-rgba-v2',
    resultRepresentation: 'independent-rgba-candidate' };
  return { source, result, config, keep };
};
it('preserves initial matte keep/glass inference while protecting an existing independent candidate from a source-color rerun', () => {
  const f = fixture(), glass = { ...clear, mode: 'glass' as const };
  const legacy = { ...f.config, layeringOutputContract: 'source-alpha-matte-v1', resultRepresentation: 'alpha-matte' };
  expect(planLocalClearRefinement(legacy, f.source, f.result, [f.keep, glass])).toBeNull();
  expect(planLocalClearRefinement({ ...legacy, pixelColorSpace: 'foreground' }, f.source, f.result, [f.keep, glass])).toBeNull();
  expect(() => planLocalClearRefinement(f.config, f.source, f.result, [f.keep, glass])).toThrow(/独立 RGBA/);
});
it('binds the editable clears to the original independent result and keeps the initial region prefix immutable', () => {
  const f = fixture(), plan = planLocalClearRefinement(f.config, f.source, f.result, [f.keep, clear])!;
  expect(plan.history.baseline).toMatchObject(f.result);
  expect(plan.history.baselineRegions).toEqual([f.keep]); expect(plan.history.clearRegions).toEqual([clear]);
  expect(plan.previousClearRegions).toEqual([]);
  expect(() => planLocalClearRefinement(f.config, f.source, f.result, [clear])).toThrow(/原有/);
});
it('rejects obsolete source bindings and changed annotation history without choosing a new baseline', () => {
  const f = fixture(), plan = planLocalClearRefinement(f.config, f.source, f.result, [f.keep, clear])!;
  const current = { ...f.config, mattingRegions: [f.keep, clear], foregroundProvenance: { kind: 'local-rgba-import', version: 1,
    ...f.result, sourceAssetId: f.source.assetId, sourceSha256: f.source.sha256, localClear: { ...plan.history, sourceSha256: 'c'.repeat(64) } } };
  expect(() => planLocalClearRefinement(current, f.source, f.result, [f.keep])).toThrow(/基线|归属/);
  current.foregroundProvenance.localClear = plan.history;
  expect(() => planLocalClearRefinement({ ...current, mattingRegions: [f.keep] }, f.source, f.result, [f.keep])).toThrow(/基线|归属/);
});
it('checks actual PNG dimensions and stored SHA instead of resizing a mismatched baseline', async () => {
  vi.stubGlobal('Blob', NodeBlob);
  const bytes = encodeLayerPng(new Uint8Array([19,87,201,1, 33,44,55,0]), 2, 1);
  const sha256 = createHash('sha256').update(bytes).digest('hex'), displayUrl = 'data:image/png;base64,' + Buffer.from(bytes).toString('base64');
  const asset = { assetId: sha256.slice(0,16), sha256, width: 1, height: 1, mediaType: 'image/png' as const, displayUrl };
  await expect(readLocalClearBaseline(asset, () => {})).rejects.toThrow(/原尺寸/);
  await expect(readLocalClearBaseline({ ...asset, width: 2, sha256: 'e'.repeat(64) }, () => {})).rejects.toThrow(/摘要/);
});
