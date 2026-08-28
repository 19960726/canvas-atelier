import { describe, expect, it } from 'vitest';
import {
  attachPastedReference,
  createPasteImportState,
  hasSendablePasteText,
  invalidatePasteImportState,
  isPasteGenerationCurrent,
  isPasteImportBusy,
  reducePasteComposer,
  resolveSelectedPasteReferences,
  startPasteImport,
  stripPendingPasteMarkers,
  upsertPasteReferenceByAssetId,
  finishPasteImport,
  type PasteReference,
} from './agent-chat-paste-state';

const image = (assetId: string, label: string, mentionPosition: number): PasteReference => ({
  assetId,
  label,
  kind: 'image',
  mentionPosition,
});

describe('agent chat paste state', () => {
  it('matches complete mention tokens so 图片10 does not retain 图片1', () => {
    const references = [image('a', 'A', 0), image('b', 'B', 9)];
    const reduced = reducePasteComposer({
      text: '@图片10',
      citations: [{ assetId: 'a', label: 'A' }, { assetId: 'b', label: 'B' }],
    }, '@图片10', references);

    expect(reduced.citations).toEqual([{ assetId: 'b', label: 'B' }]);
  });

  it('keeps sequential A and B citations and send mappings from latest canonical references', () => {
    const markerA = '\u2063A\u2064';
    const markerB = '\u2063B\u2064';
    const a = image('a', 'A', 0);
    const b = image('b', 'B', 1);
    const afterA = attachPastedReference({ text: `first ${markerA}`, citations: [] }, a, markerA, [a]);
    const latestReferences = upsertPasteReferenceByAssetId([a], b);
    const afterB = attachPastedReference({ text: `${afterA.text} second ${markerB}`, citations: afterA.citations }, b, markerB, latestReferences);
    const final = reducePasteComposer(afterB, stripPendingPasteMarkers(afterB.text, [markerA, markerB]), latestReferences);

    expect(final.citations).toEqual([{ assetId: 'a', label: 'A' }, { assetId: 'b', label: 'B' }]);
    expect(resolveSelectedPasteReferences(final.citations, latestReferences)).toEqual([
      { assetId: 'a', label: 'A', mention: '@图片1' },
      { assetId: 'b', label: 'B', mention: '@图片2' },
    ]);
  });

  it('inserts refreshed A at its batch marker while deduplicating citations by asset id', () => {
    const marker = '\u2063refresh\u2064';
    const refreshed = image('a', 'A refreshed', 0);
    const next = attachPastedReference({
      text: `inspect ${marker}`,
      citations: [{ assetId: 'a', label: 'A old' }],
    }, refreshed, marker, [refreshed]);

    expect(next.text).toBe(`inspect @图片1${marker}`);
    expect(next.citations).toEqual([{ assetId: 'a', label: 'A refreshed' }]);
  });

  it('scopes manual and pasted import busy state to the current generation', () => {
    const initial = startPasteImport(createPasteImportState(), { token: 'manual-1', kind: 'manual' });
    const invalidated = invalidatePasteImportState(initial);
    const current = startPasteImport(invalidated, { token: 'paste-2', kind: 'pasted' });
    const settledCurrent = finishPasteImport(current, 'paste-2');

    expect(isPasteImportBusy(initial)).toBe(true);
    expect(isPasteGenerationCurrent(invalidated, 0)).toBe(false);
    expect(isPasteImportBusy(invalidated)).toBe(false);
    expect(isPasteImportBusy(current)).toBe(true);
    expect(isPasteImportBusy(settledCurrent)).toBe(false);
    expect(finishPasteImport(settledCurrent, 'manual-1').imports).toEqual([]);
  });

  it('treats marker-only text as unsendable and strips it while invalidating the batch', () => {
    const marker = '\u2063\u2064\u200B\u2064\u2063';
    const importing = startPasteImport(createPasteImportState(), { token: marker, kind: 'pasted' });
    const cleaned = stripPendingPasteMarkers(marker, [marker]);
    const invalidated = invalidatePasteImportState(importing);

    expect(hasSendablePasteText(marker, [marker])).toBe(false);
    expect(cleaned).toBe('');
    expect(isPasteGenerationCurrent(invalidated, importing.generation)).toBe(false);
    expect(isPasteImportBusy(invalidated)).toBe(false);
  });
});
