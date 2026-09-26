import { describe, expect, it } from 'vitest';
import { applyLayerSelection, compatibleLayerDimensions, readLayeringSelection } from './layering-selection';

describe('layering scope pixels', () => {
  const selection = { mode: 'region' as const, box: { x: .25, y: .25, width: .5, height: .5 } };
  it('keeps foreground pixels in position and replaces background outside with source pixels', () => {
    const generated = new Uint8Array(4 * 4 * 4).fill(200), source = new Uint8Array(generated.length).fill(80);
    const foreground = applyLayerSelection(generated, 4, 4, selection);
    const background = applyLayerSelection(generated, 4, 4, selection, source);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const i = (y * 4 + x) * 4, inside = x >= 1 && x < 3 && y >= 1 && y < 3;
      expect([...foreground.slice(i, i + 4)]).toEqual(Array(4).fill(inside ? 200 : 0));
      expect([...background.slice(i, i + 4)]).toEqual(Array(4).fill(inside ? 200 : 80));
    }
    expect(generated.every(value => value === 200)).toBe(true);
  });
  it('rejects missing, invalid or out of bounds boxes before model submission', () => {
    for (const value of [{ mode: 'objects' }, { ...selection, box: { ...selection.box, x: .8 } },
      { ...selection, box: { ...selection.box, width: NaN } }]) expect(() => readLayeringSelection(value)).toThrow();
    expect(readLayeringSelection(undefined)).toEqual({ mode: 'whole' });
  });
  it('accepts provider rounding but never converts an old square response into a portrait', () => {
    expect(compatibleLayerDimensions(2480, 3312, 750, 1000)).toBe(true);
    expect(compatibleLayerDimensions(2880, 2880, 2480, 3312)).toBe(false);
  });
});
