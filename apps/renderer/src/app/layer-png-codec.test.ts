import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeLayerPng, encodeLayerPng } from './layer-png-codec';

// Independent PNG fixture writer and Node zlib reader. Expectations are the
// stored straight RGBA literals, including colors at zero/low alpha.
function crc(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); body.copy(bytes, 4); bytes.writeUInt32BE(crc(body), bytes.length - 4);
  return bytes;
}
function png(scanlines: Uint8Array, options: { width?: number; height?: number; depth?: number; color?: number; interlace?: number; extra?: Buffer[] } = {}): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(options.width ?? 2); header.writeUInt32BE(options.height ?? 2, 4);
  header[8] = options.depth ?? 8; header[9] = options.color ?? 6; header[12] = options.interlace ?? 0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), ...(options.extra ?? []), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
}
const rgba = new Uint8Array([37,83,129,32,100,150,200,64,20,30,40,0,5,6,7,255]);
const filters = [
  [0,37,83,129,32,100,150,200,64,0,20,30,40,0,5,6,7,255],
  [1,37,83,129,32,63,67,71,32,1,20,30,40,0,241,232,223,255],
  [2,37,83,129,32,100,150,200,64,2,239,203,167,224,161,112,63,191],
  [3,37,83,129,32,82,109,136,48,3,2,245,232,240,201,172,143,223],
  [4,37,83,129,32,63,67,71,32,4,239,203,167,224,161,179,134,223],
];
describe('straight RGBA layer PNG bytes', () => {
  it.each(filters.map((bytes, filter) => ({ bytes, filter })))('decodes filter $filter without premultiplying zero or low alpha', ({ bytes }) => {
    expect(decodeLayerPng(png(new Uint8Array(bytes)))).toEqual({ width: 2, height: 2, rgba });
  });
  it('encodes exact channels independently readable by Node zlib', () => {
    const encoded = Buffer.from(encodeLayerPng(rgba, 2, 2));
    expect([...encoded.subarray(0, 8)]).toEqual([137,80,78,71,13,10,26,10]);
    const payloads: Buffer[] = [];
    for (let offset = 8; offset < encoded.length;) {
      const length = encoded.readUInt32BE(offset), type = encoded.toString('ascii', offset + 4, offset + 8);
      const body = encoded.subarray(offset + 4, offset + 8 + length);
      expect(encoded.readUInt32BE(offset + 8 + length)).toBe(crc(body));
      if (type === 'IHDR') expect([...body.subarray(4)]).toEqual([0,0,0,2,0,0,0,2,8,6,0,0,0]);
      if (type === 'IDAT') payloads.push(encoded.subarray(offset + 8, offset + 8 + length));
      offset += length + 12;
    }
    expect([...inflateSync(Buffer.concat(payloads))]).toEqual(filters[0]);
  });
  it('decodes Adam7 pass placement back to original source coordinates', () => {
    const scan = new Uint8Array([0,37,83,129,32,0,100,150,200,64,0,20,30,40,0,5,6,7,255]);
    expect(decodeLayerPng(png(scan, { interlace: 1 }))).toEqual({ width: 2, height: 2, rgba });
  });
  it.each([
    { name: 'RGB8 with transparent color key', color: 2, depth: 8, width: 2, scan: [0,37,83,129,100,150,200], extra: [chunk('tRNS', new Uint8Array([0,37,0,83,0,129]))], want: [37,83,129,0,100,150,200,255] },
    { name: 'gray8', color: 0, depth: 8, width: 2, scan: [0,37,100], extra: [], want: [37,37,37,255,100,100,100,255] },
    { name: 'gray1', color: 0, depth: 1, width: 2, scan: [0,64], extra: [], want: [0,0,0,255,255,255,255,255] },
    { name: 'gray2', color: 0, depth: 2, width: 4, scan: [0,27], extra: [], want: [0,0,0,255,85,85,85,255,170,170,170,255,255,255,255,255] },
    { name: 'gray4', color: 0, depth: 4, width: 2, scan: [0,39], extra: [], want: [34,34,34,255,119,119,119,255] },
    { name: 'gray alpha8', color: 4, depth: 8, width: 2, scan: [0,37,32,100,64], extra: [], want: [37,37,37,32,100,100,100,64] },
    { name: 'gray transparent key', color: 0, depth: 8, width: 2, scan: [0,37,100], extra: [chunk('tRNS', new Uint8Array([0,37]))], want: [37,37,37,0,100,100,100,255] },
    { name: 'palette2 with low alpha', color: 3, depth: 2, width: 4, scan: [0,27], extra: [chunk('PLTE', new Uint8Array([37,83,129,100,150,200,20,30,40,5,6,7])), chunk('tRNS', new Uint8Array([0,32,64,255]))], want: [37,83,129,0,100,150,200,32,20,30,40,64,5,6,7,255] },
  ])('decodes $name using stored channels', ({ color, depth, width, scan, extra, want }) => {
    expect(decodeLayerPng(png(new Uint8Array(scan), { color, depth, width, height: 1, extra }))).toEqual({ width, height: 1, rgba: new Uint8Array(want) });
  });
  it('returns null explicitly for a non-PNG or supported-container 16-bit format', () => {
    expect(decodeLayerPng(new Uint8Array([255,216,255,224]))).toBeNull();
    expect(decodeLayerPng(png(new Uint8Array(9), { width: 1, height: 1, depth: 16 }))).toBeNull();
  });
  it('rejects CRC corruption and truncated chunks', () => {
    const valid = png(new Uint8Array(filters[0]!)); const corrupt = Buffer.from(valid); corrupt[45]! ^= 1;
    expect(() => decodeLayerPng(corrupt)).toThrow(/CRC/);
    expect(() => decodeLayerPng(valid.subarray(0, valid.length - 1))).toThrow();
  });
  it('rejects inflated streams shorter or longer than exact expected scanlines', () => {
    expect(() => decodeLayerPng(png(new Uint8Array(4), { width: 1, height: 1 }))).toThrow(/长度/);
    expect(() => decodeLayerPng(png(new Uint8Array(6), { width: 1, height: 1 }))).toThrow(/长度|范围/);
  });
  it('aborts an inflated zip bomb at the header-derived small length', () => {
    const bomb = png(new Uint8Array(8 * 1024 * 1024), { width: 1, height: 1 });
    expect(() => decodeLayerPng(bomb)).toThrow(/长度|范围/);
  });
  it.each([{ width: 8193, height: 1 }, { width: 8192, height: 8192 }, { width: 0, height: 1 }])('rejects dimensions before pixel allocations: $width x $height', ({ width, height }) => {
    expect(() => decodeLayerPng(png(new Uint8Array(), { width, height }))).toThrow(/尺寸|范围/);
    expect(() => encodeLayerPng(new Uint8Array(), width, height)).toThrow(/尺寸|范围/);
  });
  it('rejects an encoder byte count mismatch and an unknown PNG filter', () => {
    expect(() => encodeLayerPng(rgba.subarray(1), 2, 2)).toThrow(/长度/);
    expect(() => decodeLayerPng(png(new Uint8Array([5,1,2,3,4]), { width: 1, height: 1 }))).toThrow(/过滤/);
  });
  it('rejects a palette index outside its actual table', () => {
    expect(() => decodeLayerPng(png(new Uint8Array([0,1]), { width: 1, height: 1, color: 3, extra: [chunk('PLTE', new Uint8Array([1,2,3]))] }))).toThrow(/调色板/);
  });
});
