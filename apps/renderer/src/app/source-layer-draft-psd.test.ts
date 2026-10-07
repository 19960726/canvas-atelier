import { createHash } from 'node:crypto';
import { initializeCanvas, readPsd } from 'ag-psd';
import { describe, expect, it } from 'vitest';
import * as sourceDocuments from './source-layer-document';

initializeCanvas(() => { throw new Error('PSD readback must not rasterize layers'); },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as ImageData);
type Input = Parameters<typeof sourceDocuments.buildDraftSourceLayerDocument>[0];
const hash = (pixels: ArrayBufferView) => createHash('sha256')
  .update(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength)).digest('hex');
const encode = sourceDocuments.encodeDraftSourceLayerPsd;
function fixture(width: number, height: number, count: number): Input {
  const source = new Uint8Array(width * height * 4).fill(255);
  return { width, height, source, selection: { mode: 'whole' }, layers: [
    { id: 'background', name: '背景候选', kind: 'background', visible: true, opacity: 1,
      load: async () => source.slice() },
    ...Array.from({ length: count }, (_, index) => ({ id: `foreground-${index}`, name: `前景 ${index} 阴影🫧`, kind: 'transparent' as const,
      visible: true, opacity: 1, bounds: { x: 0, y: 0, width: 1, height: 1 }, preparedRgb: true,
      load: async () => {
        const pixels = new Uint8Array(source.length);
        pixels.set([120 + index, 30, 50, 1]);
        pixels.set([60, 70 + index, 80, 0], 4);
        pixels.set([210, 90, 30 + index, 255], Math.floor(width * height / 2) * 4);
        pixels.set([50, 40 + index, 90, 1], pixels.length - 4);
        return pixels;
      } })),
  ] };
}

describe('incremental editable draft PSD', () => {
  it('retains a hidden foreground opacity adjusted by the user', async () => {
    const input = fixture(4, 3, 1);
    input.layers[1]!.opacity = .75;
    const bytes = await encode(input);
    const psd = readPsd(bytes, { useImageData: true, skipThumbnail: true });
    expect(psd.children![2]!.hidden).toBe(true);
    expect(psd.children![2]!.opacity).toBe(191 / 255);
    expect(hash(psd.imageData!.data)).toBe(hash(input.source));
  });
  it('exports 11 full-frame layers over 256 MiB without deleting faint alpha or retaining all decoded layers', async () => {
    const input = fixture(2880, 2880, 9);
    expect(input.source.length * 11).toBe(364_953_600);
    const before = hash(input.source);
    const bytes = await encode(input);
    expect(bytes.length).toBeLessThan(256 * 1024 * 1024);
    const psd = readPsd(bytes, { useImageData: true, skipThumbnail: true });
    expect([psd.width, psd.height, psd.children?.length]).toEqual([2880, 2880, 11]);
    expect(hash(psd.imageData!.data)).toBe(before);
    for (const [index, layer] of psd.children!.entries()) {
      expect([layer.left, layer.top, layer.right, layer.bottom, !!layer.hidden, layer.opacity])
        .toEqual([0, 0, 2880, 2880, index !== 0, 1]);
      const expected = index === 0 ? input.source : await input.layers[index - 1]!.load();
      expect(hash(layer.imageData!.data)).toBe(hash(expected));
      if (index >= 2) expect(layer.name).toBe(`${input.layers[index - 1]!.name}（待修整）`);
    }
    expect(hash(input.source)).toBe(before);
  }, 120_000);

  it('stops reading later layers after the exporting snapshot changes', async () => {
    const input = fixture(4, 3, 3);
    let current = true, laterLoads = 0;
    const first = input.layers[1]!.load;
    input.layers[1]!.load = async () => { current = false; return first(); };
    const second = input.layers[2]!.load;
    input.layers[2]!.load = async () => { laterLoads++; return second(); };
    await expect(encode(input, () => { if (!current) throw new Error('stale draft'); })).rejects.toThrow('stale draft');
    expect(laterLoads).toBe(0);
  });

  it('keeps regional selection, original pixels and all hidden draft candidates', async () => {
    const input = fixture(6, 4, 2);
    input.selection = { mode: 'region', box: { x: 0, y: 0, width: .5, height: 1 } };
    const reference = await sourceDocuments.buildDraftSourceLayerDocument(input);
    const psd = readPsd(await encode(input), { useImageData: true, skipThumbnail: true });
    expect(psd.children?.map(layer => [layer.left, layer.top, layer.right, layer.bottom, !!layer.hidden, layer.name]))
      .toEqual(reference.layers.map(layer => [layer.x, layer.y, layer.x + layer.width, layer.y + layer.height, !layer.visible, layer.name]));
    for (const [index, layer] of psd.children!.entries()) expect(hash(layer.imageData!.data)).toBe(hash(reference.layers[index]!.rgba));
  });
});
