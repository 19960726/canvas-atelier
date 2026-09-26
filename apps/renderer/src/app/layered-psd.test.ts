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
    expect(psd.children?.map(layer => layer.name)).toEqual(['Hidden logo', 'Glass', 'Subject', 'Background']);
    expect(psd.children?.map(layer => [layer.left, layer.top, layer.right, layer.bottom, layer.hidden, layer.opacity])).toEqual([
      [0, 1, 2, 2, true, 191 / 255],
      [0, 0, 2, 1, false, 1],
      [0, 0, 2, 1, false, 1],
      [0, 0, 2, 2, false, 1],
    ]);
    expect(Array.from(psd.children![1]!.imageData!.data)).toEqual(Array.from(fourLayers.layers[2]!.rgba));
    expect(Array.from(psd.imageData!.data.slice(0, 4))).toEqual([127, 0, 128, 255]);
    expect(Array.from(psd.imageData!.data.slice(4, 8))).toEqual([255, 255, 255, 255]);
  });

  it('rejects fake opaque overlays, missing background, and layers outside the canvas', () => {
    expect(() => encodeLayeredPsd({ ...fourLayers, layers: fourLayers.layers.slice(1) })).toThrow(/background/iu);
    expect(() => encodeLayeredPsd({ ...fourLayers, layers: [fourLayers.layers[0]!, { ...fourLayers.layers[1]!, rgba: rgba([255, 0, 0, 255], [255, 0, 0, 255]) }] })).toThrow(/alpha/iu);
    expect(() => encodeLayeredPsd({ ...fourLayers, layers: [fourLayers.layers[0]!, { ...fourLayers.layers[1]!, x: 2 }] })).toThrow(/bounds/iu);
  });
});
