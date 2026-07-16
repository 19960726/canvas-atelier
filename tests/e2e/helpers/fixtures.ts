import { deflateSync } from 'node:zlib';

export interface GeneratedImageFixture {
  name: string;
  mimeType: 'image/png';
  buffer: Buffer;
}

export function makeReferenceImage(name: string, rgba: [number, number, number, number]): GeneratedImageFixture {
  return {
    name,
    mimeType: 'image/png',
    buffer: makeSolidPng(48, 48, rgba),
  };
}

function makeSolidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const bytesPerPixel = 4;
  const scanlineLength = 1 + width * bytesPerPixel;
  const raw = Buffer.alloc(scanlineLength * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * scanlineLength;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * bytesPerPixel;
      raw[offset] = rgba[0];
      raw[offset + 1] = rgba[1];
      raw[offset + 2] = rgba[2];
      raw[offset + 3] = rgba[3];
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.concat([
      uint32(width),
      uint32(height),
      Buffer.from([8, 6, 0, 0, 0]),
    ])),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBytes, data]);
  return Buffer.concat([
    uint32(data.length),
    typeBytes,
    data,
    uint32(crc32(crcInput)),
  ]);
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
