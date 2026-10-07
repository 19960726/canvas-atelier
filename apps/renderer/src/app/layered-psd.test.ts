import { describe, expect, it } from 'vitest';
import { initializeCanvas, readPsd } from 'ag-psd';
import { encodeLayeredPsd, trimTransparentLayer, validateLayeredDocument, type LayeredPsdDocument } from './layered-psd';

const rgba = (...pixels: number[][]) => Uint8Array.from(pixels.flat());
initializeCanvas(() => { throw new Error('Canvas decode is not used by this test'); },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as ImageData);

const fourLayers: LayeredPsdDocument = {
  width: 2,
  height: 2,
  layers: [
    { id: 'base', kind: 'background', name: 'Background', x: 0, y: 0, width: 2, height: 2, visible: true, opacity: 1, rgba: rgba([255, 255, 255, 255], [255, 255, 255, 255], [255, 255, 255, 255], [255, 255, 255, 255]) },
    { id: 'subject', kind: 'transparent', name: 'Subject', x: 0, y: 0, width: 2, height: 1, visible: true, opacity: 1, rgba: rgba([255, 0, 0, 255], [0, 0, 0, 0]) },
    { id: 'glass', kind: 'transparent', name: 'Glass', x: 0, y: 0, width: 2, height: 1, visible: true, opacity: 1, rgba: rgba([0, 0, 255, 128], [0, 0, 0, 0]) },
    { id: 'hidden', kind: 'transparent', name: 'Hidden logo', x: 0, y: 1, width: 2, height: 1, visible: false, opacity: 0.75, rgba: rgba([0, 255, 0, 255], [0, 0, 0, 0]) },
  ],
};

describe('layered PSD export', () => {
  it('retains isolated low-alpha pixels and attached soft edges in their native coordinates', () => {
    const width = 10, height = 10, pixels = new Uint8Array(width * height * 4);
    pixels.set([120, 30, 50, 1], (1 * width + 1) * 4);
    pixels.set([210, 80, 20, 255], (4 * width + 4) * 4);
    pixels.set([200, 90, 30, 1], (4 * width + 3) * 4);
    pixels.set([180, 70, 40, 8], (4 * width + 5) * 4);
    pixels.set([40, 70, 140, 1], (8 * width + 8) * 4);
    const trimmed = trimTransparentLayer({ ...fourLayers.layers[1]!, x: 2, y: 3, width, height, rgba: pixels });
    expect([trimmed.x, trimmed.y, trimmed.width, trimmed.height]).toEqual([2, 3, 10, 10]);
    expect(trimmed.rgba).toEqual(pixels);
    const bytes = encodeLayeredPsd({ width: 12, height: 13, layers: [
      { ...fourLayers.layers[0]!, width: 12, height: 13, rgba: new Uint8Array(12 * 13 * 4).fill(255) }, trimmed,
    ] });
    const foreground = readPsd(bytes, { useImageData: true, skipThumbnail: true }).children![1]!;
    expect([foreground.left, foreground.top]).toEqual([2, 3]);
    expect(Array.from(foreground.imageData!.data)).toEqual(Array.from(pixels));
  });

  it('rejects a full-frame ten-layer editable draft over 256 MiB without clipping faint contents', () => {
    const width = 2880, height = 2880;
    const original = new Uint8Array(width * height * 4).fill(255);
    const returned = new Uint8Array(original.length);
    returned.set([120, 40, 80, 1], 0);
    returned.set([240, 100, 30, 255], (1500 * width + 1500) * 4);
    returned.set([90, 70, 50, 1], returned.length - 4);
    const foreground = trimTransparentLayer({ ...fourLayers.layers[1]!, x: 0, y: 0, width, height, rgba: returned });
    expect([foreground.x, foreground.y, foreground.width, foreground.height]).toEqual([0, 0, width, height]);
    const document: LayeredPsdDocument = { width, height, layers: [
      { ...fourLayers.layers[0]!, id: 'original', width, height, rgba: original },
      { ...fourLayers.layers[0]!, id: 'background-candidate', kind: 'alternate-background', width, height, visible: false, rgba: original },
      ...Array.from({ length: 9 }, (_, index) => ({ ...foreground, id: `returned-${index}`, visible: false })),
    ] };
    expect(document.layers.reduce((sum, layer) => sum + layer.rgba.length, 0)).toBe(364_953_600);
    expect(() => encodeLayeredPsd(document)).toThrow(/256 MiB/u);
    expect(Array.from(returned.subarray(0, 4))).toEqual([120, 40, 80, 1]);
    expect(Array.from(returned.subarray(returned.length - 4))).toEqual([90, 70, 50, 1]);
  });

  it('preserves native pixels and placement while dropping empty transparent margins from 4K layer stacks', () => {
    const width = 2880, height = 2880;
    const pixels = new Uint8Array(width * height * 4);
    pixels.set([255, 30, 10, 255], (100 * width + 200) * 4);
    const transparent = { ...fourLayers.layers[1]!, x: 0, y: 0, width, height, rgba: pixels };
    const trimmed = trimTransparentLayer(transparent);
    expect([trimmed.x, trimmed.y, trimmed.width, trimmed.height]).toEqual([199, 99, 3, 3]);
    expect(Array.from(trimmed.rgba.slice(16, 20))).toEqual([255, 30, 10, 255]);
    const background = { ...fourLayers.layers[0]!, width, height, rgba: pixels };
    expect(() => validateLayeredDocument({ width, height, layers: [background, ...Array.from({ length: 12 }, (_, i) => ({ ...trimmed, id: `subject-${i}` }))] })).not.toThrow();
    const cornerPixels = new Uint8Array(16 * 4); cornerPixels.set([10, 20, 30, 255]);
    const corner = trimTransparentLayer({ ...transparent, width: 4, height: 4, rgba: cornerPixels });
    expect([corner.x, corner.y, corner.width, corner.height]).toEqual([0, 0, 2, 2]);
    expect(corner.rgba[7]).toBe(0);
  });
  it('writes Photoshop PSD v1 with four independent RGBA layers and a matching composite', () => {
    const bytes = encodeLayeredPsd(fourLayers);
    expect(Buffer.from(bytes.subarray(0, 4)).toString('ascii')).toBe('8BPS');
    expect(new DataView(bytes.buffer, bytes.byteOffset).getUint16(4)).toBe(1);
    const psd = readPsd(bytes, { useImageData: true, skipThumbnail: true });
    expect({ width: psd.width, height: psd.height, bitsPerChannel: psd.bitsPerChannel }).toEqual({ width: 2, height: 2, bitsPerChannel: 8 });
    // ag-psd children are bottom to top; Photoshop presents the reverse order.
    expect(psd.children?.map(layer => layer.name)).toEqual(['Background', 'Subject', 'Glass', 'Hidden logo']);
    expect(psd.children?.map(layer => [layer.left, layer.top, layer.right, layer.bottom, layer.hidden, layer.opacity])).toEqual([
      [0, 0, 2, 2, false, 1],
      [0, 0, 2, 1, false, 1],
      [0, 0, 2, 1, false, 1],
      [0, 1, 2, 2, true, 191 / 255],
    ]);
    expect(Array.from(psd.children![2]!.imageData!.data)).toEqual(Array.from(fourLayers.layers[2]!.rgba));
    expect(Array.from(psd.imageData!.data.slice(0, 4))).toEqual([127, 0, 128, 255]);
    expect(Array.from(psd.imageData!.data.slice(4, 8))).toEqual([255, 255, 255, 255]);
  });

  it('rejects fake opaque overlays, missing background, and layers outside the canvas', () => {
    expect(() => encodeLayeredPsd({ ...fourLayers, layers: fourLayers.layers.slice(1) })).toThrow(/background/iu);
    expect(() => encodeLayeredPsd({ ...fourLayers, layers: [fourLayers.layers[0]!, { ...fourLayers.layers[1]!, rgba: rgba([255, 0, 0, 255], [255, 0, 0, 255]) }] })).toThrow(/alpha/iu);
    expect(() => encodeLayeredPsd({ ...fourLayers, layers: [fourLayers.layers[0]!, { ...fourLayers.layers[1]!, x: 2 }] })).toThrow(/bounds/iu);
  });
});
