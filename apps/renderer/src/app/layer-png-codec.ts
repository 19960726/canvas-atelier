import { deflate, Inflate } from 'pako';

const MAX_SIDE = 8192;
const MAX_RGBA_BYTES = 128 * 1024 * 1024;
const MAX_PNG_BYTES = MAX_RGBA_BYTES + 1024 * 1024;
const SIGNATURE = new Uint8Array([137,80,78,71,13,10,26,10]);
const PASSES = [[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]] as const;
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
export interface DecodedLayerPng { width: number; height: number; rgba: Uint8Array }
function isByteArray(value: Uint8Array): boolean {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]';
}

function dimensions(width: number, height: number): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE
    || width * height * 4 > MAX_RGBA_BYTES) throw new Error('PNG 尺寸超出当前分层处理范围');
  return width * height * 4;
}
function crc(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = value >>> 8 ^ crcTable[(value ^ byte) & 255]!;
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(data.length + 12), view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index++) bytes[index + 4] = type.charCodeAt(index);
  bytes.set(data, 8); view.setUint32(data.length + 8, crc(bytes.subarray(4, data.length + 8)));
  return bytes;
}
function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

/** Encode stored straight RGBA8 bytes, including RGB at alpha zero, without Canvas. */
export function encodeLayerPng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const expected = dimensions(width, height);
  if (!isByteArray(rgba) || rgba.length !== expected) throw new Error('PNG 像素长度与尺寸不一致');
  const rowBytes = width * 4, scan = new Uint8Array(expected + height);
  for (let row = 0; row < height; row++) scan.set(rgba.subarray(row * rowBytes, (row + 1) * rowBytes), row * (rowBytes + 1) + 1);
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height); header[8] = 8; header[9] = 6;
  return concatenate([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflate(scan, { level: 3 })), chunk('IEND', new Uint8Array())]);
}

function inflateBounded(bytes: Uint8Array, expected: number): Uint8Array {
  // PNG uses exactly one zlib stream, without preset dictionary or gzip.
  if (bytes.length < 6 || bytes[0]! % 16 !== 8 || bytes[0]! >>> 4 > 7
    || ((bytes[0]! << 8) | bytes[1]!) % 31 !== 0 || (bytes[1]! & 32) !== 0) throw new Error('PNG 压缩数据无效');
  const result = new Uint8Array(expected);
  const inflater = new Inflate({ windowBits: 15, chunkSize: Math.min(expected + 1, 64 * 1024) });
  let written = 0;
  inflater.onData = (data: Uint8Array) => {
    if (written + data.length > expected) throw new Error('PNG 解压长度超出尺寸范围');
    result.set(data, written); written += data.length;
  };
  if (!inflater.push(bytes, true) || inflater.err || !inflater.ended) throw new Error('PNG 压缩数据损坏');
  if (written !== expected) throw new Error('PNG 解压长度与尺寸不一致');
  return result;
}
function paeth(left: number, up: number, upperLeft: number): number {
  const prediction = left + up - upperLeft;
  const a = Math.abs(prediction - left), b = Math.abs(prediction - up), c = Math.abs(prediction - upperLeft);
  return a <= b && a <= c ? left : b <= c ? up : upperLeft;
}

/**
 * Decode stored channels with no premultiplication or gamma/ICC conversion.
 * Non-PNG, valid 16-bit formats and unknown critical extensions return null.
 * Malformed supported PNGs throw; callers must not silently accept corruption.
 */
export function decodeLayerPng(bytes: Uint8Array): DecodedLayerPng | null {
  if (!isByteArray(bytes) || bytes.length < 8 || !SIGNATURE.every((byte, index) => bytes[index] === byte)) return null;
  if (bytes.length > MAX_PNG_BYTES) throw new Error('PNG 数据超出当前分层处理范围');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0, height = 0, depth = 0, color = -1, interlace = 0, rgbaBytes = 0;
  let headerSeen = false, ended = false, dataSeen = false, dataEnded = false, unsupported = false;
  let palette: Uint8Array | null = null, transparency: Uint8Array | null = null;
  const compressed: Uint8Array[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error('PNG 数据块长度不完整');
    const length = view.getUint32(offset), start = offset + 8, end = start + length;
    if (end + 4 > bytes.length) throw new Error('PNG 数据块长度不完整');
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{4}$/u.test(type) || type[2] !== type[2]!.toUpperCase()) throw new Error('PNG 数据块类型无效');
    if (view.getUint32(end) !== crc(bytes.subarray(offset + 4, end))) throw new Error('PNG CRC 校验失败');
    const data = bytes.subarray(start, end);
    if (!headerSeen && type !== 'IHDR') throw new Error('PNG 缺少首个 IHDR');
    if (type === 'IHDR') {
      if (headerSeen || length !== 13) throw new Error('PNG IHDR 无效');
      width = view.getUint32(start); height = view.getUint32(start + 4); rgbaBytes = dimensions(width, height);
      depth = data[8]!; color = data[9]!; interlace = data[12]!;
      if (data[10] !== 0 || data[11] !== 0 || interlace > 1) throw new Error('PNG 编码方式无效');
      const validDepth = color === 0 ? [1,2,4,8,16].includes(depth) : color === 3 ? [1,2,4,8].includes(depth)
        : [2,4,6].includes(color) && [8,16].includes(depth);
      if (!validDepth) throw new Error('PNG 颜色格式无效');
      unsupported = depth === 16; headerSeen = true;
    } else if (type === 'PLTE') {
      if (palette || dataSeen || !length || length % 3 !== 0 || length > 768 || color === 0 || color === 4
        || (color === 3 && length / 3 > 2 ** depth)) throw new Error('PNG 调色板无效');
      palette = data;
    } else if (type === 'tRNS') {
      if (transparency || dataSeen || ![0,2,3].includes(color)
        || (color === 0 && length !== 2) || (color === 2 && length !== 6)
        || (color === 3 && (!palette || length > palette.length / 3))) throw new Error('PNG 透明数据无效');
      transparency = data;
    } else if (type === 'IDAT') {
      if (dataEnded || (color === 3 && !palette)) throw new Error('PNG 图像数据顺序无效');
      dataSeen = true; compressed.push(data);
    } else if (type === 'IEND') {
      if (length !== 0 || !dataSeen || end + 4 !== bytes.length) throw new Error('PNG IEND 无效');
      ended = true; break;
    } else if (type[0] === type[0]!.toUpperCase()) unsupported = true;
    if (dataSeen && type !== 'IDAT') dataEnded = true;
    offset = end + 4;
  }
  if (!ended || !headerSeen || !dataSeen) throw new Error('PNG 图像数据不完整');
  if (unsupported) return null;
  const channels = color === 0 || color === 3 ? 1 : color === 2 ? 3 : color === 4 ? 2 : 4;
  const bits = channels * depth, filterBytes = Math.max(1, Math.ceil(bits / 8));
  const passes = (interlace ? PASSES : [[0,0,1,1] as const]).map(([x,y,dx,dy]) => ({ x,y,dx,dy,
    width: x < width ? Math.ceil((width - x) / dx) : 0,
    height: y < height ? Math.ceil((height - y) / dy) : 0 }));
  const expected = passes.reduce((total, pass) => total + (pass.width && pass.height ? (Math.ceil(pass.width * bits / 8) + 1) * pass.height : 0), 0);
  // The header bound is checked before allocation and every emitted inflate
  // chunk is checked before copying. A tiny header cannot allocate a zip bomb.
  const scan = inflateBounded(concatenate(compressed), expected), rgba = new Uint8Array(rgbaBytes);
  const sampleMax = 2 ** depth - 1;
  const key = transparency && color !== 3 ? new DataView(transparency.buffer, transparency.byteOffset, transparency.byteLength) : null;
  if (key && Array.from({ length: color === 2 ? 3 : 1 }, (_, index) => key.getUint16(index * 2)).some(value => value > sampleMax)) throw new Error('PNG 透明值超出颜色范围');
  let scanOffset = 0;
  for (const pass of passes) {
    if (!pass.width || !pass.height) continue;
    const rowBytes = Math.ceil(pass.width * bits / 8);
    let previous = new Uint8Array(rowBytes), row = new Uint8Array(rowBytes);
    for (let y = 0; y < pass.height; y++) {
      const filter = scan[scanOffset++]!;
      if (filter > 4) throw new Error('PNG 过滤器无效');
      for (let index = 0; index < rowBytes; index++) {
        const left = index >= filterBytes ? row[index - filterBytes]! : 0, up = previous[index]!;
        const upperLeft = index >= filterBytes ? previous[index - filterBytes]! : 0;
        const correction = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up
          : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, upperLeft);
        row[index] = scan[scanOffset++]! + correction;
      }
      for (let x = 0; x < pass.width; x++) {
        const target = ((pass.y + y * pass.dy) * width + pass.x + x * pass.dx) * 4;
        if (color === 0 || color === 3) {
          const bit = x * depth, sample = row[bit >>> 3]! >>> (8 - depth - (bit & 7)) & sampleMax;
          if (color === 3) {
            if (!palette || sample * 3 + 2 >= palette.length) throw new Error('PNG 调色板索引无效');
            rgba.set(palette.subarray(sample * 3, sample * 3 + 3), target); rgba[target + 3] = transparency?.[sample] ?? 255;
          } else {
            const gray = Math.round(sample * 255 / sampleMax);
            rgba[target] = gray; rgba[target + 1] = gray; rgba[target + 2] = gray;
            rgba[target + 3] = key?.getUint16(0) === sample ? 0 : 255;
          }
        } else if (color === 4) {
          const index = x * 2, gray = row[index]!;
          rgba[target] = gray; rgba[target + 1] = gray; rgba[target + 2] = gray; rgba[target + 3] = row[index + 1]!;
        } else {
          const index = x * channels;
          rgba.set(row.subarray(index, index + 3), target);
          rgba[target + 3] = color === 6 ? row[index + 3]! : key && [0,1,2].every(channel => row[index + channel] === key.getUint16(channel * 2)) ? 0 : 255;
        }
      }
      [previous, row] = [row, previous];
    }
  }
  return { width, height, rgba };
}
