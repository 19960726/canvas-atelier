import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSolidPng } from '../../../packages/desktop-core/src/test/png-fixture';
import { fixturePng } from '../../renderer/src/test/rgba-png-fixture';
import { decodeLayerPng } from '../../renderer/src/app/layer-png-codec';
import { inspectPreparedLayerPng, validatePreparedLayerImportRequest } from './prepared-layer-import';

const target = { projectId: 'project', nodeId: 'body', groupId: 'group', layerId: 'body',
  sourceAssetId: 'source', expectedResultAssetId: null, expectedRevision: 0 };
const rgba = new Uint8Array([37,83,129,0,100,150,200,32,20,30,40,64,5,6,7,255]);
const png = Buffer.from(fixturePng(rgba, 2, 2).split(',')[1]!, 'base64');

describe('strict prepared PNG byte validation', () => {
  it('validates stored straight RGBA without changing zero/low-alpha RGB or original bytes', () => {
    const original = Buffer.from(png);
    expect(inspectPreparedLayerPng(png)).toEqual({ width: 2, height: 2,
      sha256: createHash('sha256').update(original).digest('hex'), hasTransparentPixel: true, hasNonzeroPixel: true, opaque: false });
    expect(png).toEqual(original);
    expect(decodeLayerPng(png)?.rgba).toEqual(rgba);
  });
  it('reports fully opaque and fully empty PNGs for the native role gate', () => {
    expect(inspectPreparedLayerPng(createSolidPng())).toMatchObject({ opaque: true, hasTransparentPixel: false, hasNonzeroPixel: true });
    expect(inspectPreparedLayerPng(createSolidPng(1, 1, [37,83,129,0]))).toMatchObject({ opaque: false, hasTransparentPixel: true, hasNonzeroPixel: false });
  });
  it.each(['truncated', 'crc', 'corrupt-idat'])('rejects %s PNG data despite a valid signature and size header', kind => {
    const bytes = Buffer.from(png);
    if (kind === 'truncated') expect(() => inspectPreparedLayerPng(bytes.subarray(0, 33))).toThrow();
    else {
      bytes[45] = bytes[45]! ^ 0xff;
      if (kind === 'corrupt-idat') {
        bytes[41] = 0; // A valid-CRC chunk with an invalid zlib CMF byte.
        const length = bytes.readUInt32BE(33); bytes.writeUInt32BE(crc32(bytes.subarray(37, 41 + length)), 41 + length);
      }
      expect(() => inspectPreparedLayerPng(bytes)).toThrow();
    }
  });
  it.each(['acTL', 'fcTL', 'fdAT'])('rejects APNG %s chunks instead of silently accepting one frame', type => {
    const bytes = Buffer.concat([png.subarray(0, 33), chunk(type, Buffer.alloc(type === 'acTL' ? 8 : 26)), png.subarray(33)]);
    expect(() => inspectPreparedLayerPng(bytes)).toThrow(/动画|APNG/);
  });
  it('rejects an oversized decoded canvas before allocating its pixels', () => {
    const bytes = Buffer.from(png); bytes.writeUInt32BE(8192, 16); bytes.writeUInt32BE(8192, 20);
    bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
    expect(() => inspectPreparedLayerPng(bytes)).toThrow(/尺寸/);
  });
});

describe('prepared import optional target request', () => {
  it('keeps legacy in-memory refinement imports compatible', () => {
    expect(validatePreparedLayerImportRequest({ sessionId: 'session', bytes: png })).toEqual({ sessionId: 'session', bytes: png });
  });
  it('accepts a complete strict target and keeps its nullable old result', () => {
    expect(validatePreparedLayerImportRequest({ sessionId: 'session', bytes: png, layerTarget: target }).layerTarget).toEqual(target);
  });
  it.each([
    { ...target, expectedRevision: -1 }, { ...target, expectedRevision: .5 }, { ...target, projectId: '' },
    { ...target, expectedResultAssetId: undefined }, { ...target, sourcePath: 'C:/forged.png' }, { ...target, nodeId: 7 },
  ])('rejects an incomplete, forged or invalid target %#', layerTarget => {
    expect(() => validatePreparedLayerImportRequest({ sessionId: 'session', bytes: png, layerTarget })).toThrow();
  });
  it('rejects request extras and non-byte PNG data', () => {
    expect(() => validatePreparedLayerImportRequest({ sessionId: 'session', bytes: png, approved: true })).toThrow();
    expect(() => validatePreparedLayerImportRequest({ sessionId: 'session', bytes: [...png], layerTarget: target })).toThrow();
  });
});

function chunk(type: string, data: Buffer): Buffer {
  const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length, 0); bytes.write(type, 4, 'ascii'); data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, 8 + data.length)), 8 + data.length); return bytes;
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
