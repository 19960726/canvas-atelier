import { describe, expect, it } from 'vitest';
import {
  validateIndependentLayerGroup,
  type IndependentLayer,
} from './independent-layer-validation';

const W = 3;
const H = 1;

function rgba(...pixels: Array<[number, number, number, number]>): Uint8Array {
  return Uint8Array.from(pixels.flat());
}

function layer(id: string, pixels: Uint8Array, options: Partial<IndependentLayer> = {}): IndependentLayer {
  return { id, name: id, role: 'foreground', source: 'raw', rgba: pixels, ...options };
}

describe('independent layer group validation', () => {
  it('accepts physically independent opaque layers and reports exact opaque source RGB', () => {
    const background = rgba([240, 240, 240, 255], [240, 240, 240, 255], [240, 240, 240, 255]);
    const red = rgba([255, 0, 0, 255], [0, 0, 0, 0], [0, 0, 0, 0]);
    const blue = rgba([0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 255, 255]);
    const result = validateIndependentLayerGroup({
      width: W,
      height: H,
      source: rgba([255, 0, 0, 255], [240, 240, 240, 255], [0, 0, 255, 255]),
      background,
      foregrounds: [layer('red', red), layer('blue', blue)],
    });
    expect(result.status).toBe('pass');
    expect(result.composite.maxChannelError).toBe(0);
    expect(result.groups.map(item => item.physicalIndependentRGBA)).toEqual([true, true]);
    expect(result.groups.every(item => item.exactOpaqueSourceRgb)).toBe(true);
  });

  it('rejects a raw foreground duplicated into a strong carrier layer', () => {
    const background = new Uint8Array(16 * 4);
    for (let pixel = 0; pixel < 16; pixel += 1) background.set([250, 250, 250, 255], pixel * 4);
    const cup = new Uint8Array(16 * 4);
    const duplicate = new Uint8Array(16 * 4);
    for (let pixel = 0; pixel < 16; pixel += 1) {
      cup.set([120, 80, 30, 255], pixel * 4);
      duplicate.set([120, 80, 30, 255], pixel * 4);
    }
    const source = cup.slice();
    const result = validateIndependentLayerGroup({
      width: 16,
      height: H,
      source,
      background,
      foregrounds: [layer('cup', cup), layer('carrier', duplicate, { role: 'carrier' })],
    });
    expect(result.status).toBe('reject');
    expect(result.groups.some(item => item.diagnostics.some(diagnostic => /重叠|载体|duplicate/u.test(diagnostic)))).toBe(true);
  });

  it('requires review when an opaque pixel is covered by a partial optical upper layer', () => {
    const background = rgba([255, 255, 255, 255]);
    const lower = rgba([20, 40, 60, 255]);
    const upper = rgba([240, 240, 240, 64]);
    const source = rgba([75, 90, 105, 255]);
    const result = validateIndependentLayerGroup({
      width: 1,
      height: 1,
      source,
      background,
      foregrounds: [layer('lower', lower), layer('upper', upper, { role: 'shadow' })],
    });
    expect(result.composite.matchesSource).toBe(true);
    expect(result.groups.find(item => item.id === 'lower')?.exactOpaqueSourceRgb).toBe(false);
    expect(result.status).toBe('review-required');
  });

  it('requires review when the source cannot prove hidden RGB ownership', () => {
    const result = validateIndependentLayerGroup({
      width: 1,
      height: 1,
      source: rgba([100, 100, 100, 255]),
      background: rgba([100, 100, 100, 255]),
      foregrounds: [layer('unknown-hidden', rgba([200, 0, 0, 0]), { source: 'prepared' })],
    });
    expect(result.status).toBe('review-required');
    expect(result.groups[0]?.physicalIndependentRGBA).toBe(false);
    expect(result.groups[0]?.diagnostics.join(' ')).toMatch(/隐藏|可见像素|RGB/u);
  });

  it('rejects stale or malformed dimensions before reading pixels', () => {
    expect(() => validateIndependentLayerGroup({
      width: W,
      height: H,
      source: rgba([0, 0, 0, 255]),
      background: rgba([0, 0, 0, 255]),
      foregrounds: [layer('bad', rgba([0, 0, 0, 0]))],
    })).toThrow(/尺寸|像素/u);
  });

  it('retains source-color uncertainty for a prepared opaque body beneath known independent optical RGBA', () => {
    const background = rgba([240,240,240,255], [240,240,240,255], [240,240,240,255]);
    const body = rgba([100,80,60,255], [100,80,60,255], [0,0,0,0]);
    const water = rgba([200,220,240,128], [0,0,0,0], [200,220,240,128]);
    const result = validateIndependentLayerGroup({ width: 3, height: 1, background,
      source: rgba([150,150,150,255], [100,80,60,255], [220,230,240,255]),
      foregrounds: [layer('body', body, { source: 'prepared' }), layer('water', water, { source: 'prepared' })] });
    expect(result.composite).toEqual({ matchesSource: true, maxChannelError: 0, maxAlphaError: 0, changedPixels: 0 });
    expect(result.groups.find(group => group.id === 'body')?.exactOpaqueSourceRgb).toBe(false);
    expect(result.groups.find(group => group.id === 'body')?.changedPixelsWhenHidden).toBe(2);
    expect(result.groups.find(group => group.id === 'body')).toHaveProperty('diagnosticCodes', ['opaque-source-under-partial']);
    expect(result).toHaveProperty('diagnosticCodes', []);
    expect(result.status).toBe('review-required');
  });

  it('requires review for a fully hidden prepared entity even when all prepared RGBA recomposes exactly', () => {
    const background = rgba([240,240,240,255], [240,240,240,255]);
    const body = rgba([100,80,60,255], [0,0,0,0]);
    const copy = rgba([100,80,60,255], [200,220,240,128]);
    const result = validateIndependentLayerGroup({ width: 2, height: 1, background,
      source: rgba([100,80,60,255], [220,230,240,255]),
      foregrounds: [layer('body', body, { source: 'prepared' }), layer('copy', copy, { source: 'prepared' })] });
    expect(result.composite.matchesSource).toBe(true);
    const hiddenBody = result.groups.find(group => group.id === 'body')!;
    expect(hiddenBody.changedPixelsWhenHidden).toBe(0);
    expect(hiddenBody.physicalIndependentRGBA).toBe(false);
    expect(hiddenBody.diagnostics.join(' ')).toMatch(/隐藏.*不发生变化/u);
    expect(hiddenBody).toHaveProperty('diagnosticCodes', ['no-independent-contribution']);
    expect(result.status).toBe('review-required');
  });

  it('rejects strong raw carrier duplication even when both raw entities retain some independently visible pixels', () => {
    const background = Uint8Array.from(Array.from({ length: 20 }, () => [240,240,240,255]).flat());
    const body = new Uint8Array(background.length), duplicate = new Uint8Array(background.length);
    for (let pixel = 0; pixel < 19; pixel += 1) body.set([100,80,60,255], pixel * 4);
    for (let pixel = 1; pixel < 20; pixel += 1) duplicate.set([100,80,60,255], pixel * 4);
    const result = validateIndependentLayerGroup({ width: 20, height: 1, background,
      source: Uint8Array.from(Array.from({ length: 20 }, () => [100,80,60,255]).flat()),
      foregrounds: [layer('body', body), layer('duplicate', duplicate)] });
    expect(result.composite.matchesSource).toBe(true);
    expect(result.groups.every(group => group.changedPixelsWhenHidden > 0)).toBe(true);
    expect(result.status).toBe('reject');
    expect(result.diagnostics.join(' ')).toMatch(/重叠.*95%|95%.*重叠/u);
    expect(result).toHaveProperty('diagnosticCodes', ['strong-raw-overlap']);
  });

  it('identifies a source composite mismatch separately from optical source-color review', () => {
    const result = validateIndependentLayerGroup({ width: 2, height: 1,
      source: rgba([100,80,60,255], [240,240,240,255]),
      background: rgba([240,240,240,255], [200,240,240,255]),
      foregrounds: [layer('body', rgba([100,80,60,255], [0,0,0,0]), { source: 'prepared' })] });
    expect(result.status).toBe('reject');
    expect(result.composite.maxChannelError).toBe(40);
    expect(result).toHaveProperty('diagnosticCodes', ['source-composite-mismatch']);
    expect(result.groups[0]).toHaveProperty('diagnosticCodes', []);
  });
});
