import { describe, expect, it } from 'vitest';
import { createCanvasModuleNode } from '@agent-canvas/domain';
import * as layeringProof from './layering-proof';
import { invalidateLayeringProof, isLayeringProofCurrent } from './layering-proof';

describe('layering proof invalidation', () => {
  it('keeps the returned bytes and representation while removing stale review proof', () => {
    const next = invalidateLayeringProof({
      layerKind: 'image_layer', resultAssetId: 'returned', qualityStatus: 'passed',
      layeringConfirmationDigest: 'a'.repeat(64), semanticReviewAccepted: true,
      semanticReviewDigest: 'c'.repeat(64), assemblyConfirmationDigest: 'c'.repeat(64),
      foregroundProvenance: 'local', preparedRgb: true, layerPrepared: true, pixelColorSpace: 'foreground',
      refinedFromAssetId: 'old', mattingRegions: [{ mode: 'glass' }],
      formatQualityStatus: 'passed', qualityFormatCheckedAssetId: 'returned',
      qualityValidationVersion: 2,
    });
    expect(next.resultAssetId).toBe('returned');
    expect(next.needsReconfirm).toBe(true);
    expect(next.qualityStatus).toBe('pending');
    expect(next.status).toBe('validating');
    expect(next.layeringConfirmationDigest).toBe('a'.repeat(64));
    expect(next.semanticReviewAccepted).toBeUndefined();
    expect(next.semanticReviewDigest).toBeUndefined();
    expect(next.assemblyConfirmationDigest).toBeUndefined();
    expect(next.preparedRgb).toBe(true);
    expect(next.layerPrepared).toBe(true);
    expect(next.pixelColorSpace).toBe('foreground');
    expect(next.refinedFromAssetId).toBe('old');
    expect(next.mattingRegions).toEqual([{ mode: 'glass' }]);
    expect(next.formatQualityStatus).toBe('passed');
    expect(next.qualityFormatCheckedAssetId).toBe('returned');
    expect(next.qualityValidationVersion).toBe(2);
  });

  it('accepts only an explicit current proof', () => {
    expect(isLayeringProofCurrent({ qualityStatus: 'passed', layeringConfirmationDigest: 'b'.repeat(64), semanticReviewAccepted: true })).toBe(true);
    expect(isLayeringProofCurrent({ qualityStatus: 'passed', layeringConfirmationDigest: 'b'.repeat(64) })).toBe(true);
    expect(isLayeringProofCurrent({ qualityStatus: 'passed', layeringConfirmationDigest: 'b'.repeat(64), needsReconfirm: true })).toBe(false);
    expect(isLayeringProofCurrent({ qualityStatus: 'passed', layeringConfirmationDigest: 'B'.repeat(64), semanticReviewAccepted: true })).toBe(false);
  });
});

describe('local layering review snapshot', () => {
  const digest = (config: Readonly<Record<string, unknown>>, children: ReturnType<typeof createCanvasModuleNode>[]) =>
    (layeringProof as unknown as { buildLayeringReviewDigest: (config: Readonly<Record<string, unknown>>, children: ReturnType<typeof createCanvasModuleNode>[]) => Promise<string> })
      .buildLayeringReviewDigest(config, children);
  const fixture = () => {
    const child = createCanvasModuleNode('actual-child', 'image_layer', { x: 0, y: 0 });
    child.data.config = { groupId: 'group', sourceAssetId: 'source', layerId: 'subject', name: 'cup', description: 'metal cup',
      sourceBounds: { x: .2, y: .1, width: .5, height: .7 }, order: 1, resultAssetId: 'result', layeringOutputContract: 'source-independent-rgba-v2',
      resultRepresentation: 'independent-rgba-candidate', preparedRgb: false, layerPrepared: false, pixelColorSpace: null };
    return { config: { groupId: 'group', sourceAssetId: 'source', canvasWidth: 2, canvasHeight: 2,
      layerSelection: { mode: 'whole' }, planLayers: [{ layerId: 'subject', name: 'cup', description: 'metal cup', kind: 'transparent', order: 1 }] }, child };
  };
  it('binds exact child IDs, current plan, result bytes and physical representation', async () => {
    const { config, child } = fixture();
    const original = await digest(config, [child]);
    expect(original).toMatch(/^[a-f0-9]{64}$/u);
    for (const change of [{ resultAssetId: 'new-result' }, { sourceBounds: { x: .1, y: .1, width: .5, height: .7 } },
      { order: 2 }, { name: 'another' }, { description: 'plastic cup' }, { preparedRgb: true },
      { layerPrepared: true }, { pixelColorSpace: 'foreground' }, { resultRepresentation: 'alpha-matte' }, { layeringOutputContract: 'source-alpha-matte-v1' }]) {
      expect(await digest(config, [{ ...child, data: { ...child.data, config: { ...child.data.config, ...change } } }])).not.toBe(original);
    }
    expect(await digest(config, [{ ...child, id: 'replaced-child' }])).not.toBe(original);
    expect(await digest({ ...config, sourceAssetId: 'new-source' }, [child])).not.toBe(original);
    expect(await digest({ ...config, planLayers: [{ ...config.planLayers[0], description: 'changed plan' }] }, [child])).not.toBe(original);
  });
  it('ignores inspection visibility, volatile status and its own proof markers', async () => {
    const { config, child } = fixture();
    const original = await digest(config, [child]);
    expect(await digest({ ...config, status: 'completed', needsReconfirm: false, assemblyConfirmationDigest: original }, [
      { ...child, data: { ...child.data, config: { ...child.data.config, status: 'completed', visible: false,
        semanticReviewAccepted: true, semanticReviewDigest: original, assemblyConfirmationDigest: original } } },
    ])).toBe(original);
  });
  it('invalidates local review when the planned foreground representation changes', async () => {
    const { config, child } = fixture();
    const independent = { ...config, foregroundOutputContract: 'source-independent-rgba-v2' };
    const original = await digest(independent, [child]);
    expect(await digest({ ...independent, foregroundOutputContract: 'source-alpha-matte-v1' }, [child])).not.toBe(original);
    expect(await digest(config, [child])).not.toBe(original);
  });
});
