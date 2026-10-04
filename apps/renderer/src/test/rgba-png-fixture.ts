import { deflateSync } from 'node:zlib';

/** Independent test PNG bytes from the physical pixel oracle, never Canvas or
 * the product PNG codec. */
export function fixturePng(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number): string {
  const chunk = (type: string, data: Buffer) => {
    const output = Buffer.alloc(data.length + 12); output.writeUInt32BE(data.length, 0);
    output.write(type, 4, 'ascii'); data.copy(output, 8);
    let crc = 0xffffffff;
    for (const byte of output.subarray(4, data.length + 8)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8); return output;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rows.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}
