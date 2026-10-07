import { writePsdUint8Array, type Layer, type LayerRawDataChannel } from 'ag-psd';
import { deflate } from 'pako';
import type { LayeredPsdLayer } from './layered-psd';

const MAX_RGBA_BYTES = 128 * 1024 * 1024;
const MAX_COMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;

/** Incremental encoding for editable drafts only: the original is visible and
 * every returned candidate is hidden. Never certifies a semantic composite.
 * append consumes each layer synchronously and retains only ZIP channel bytes,
 * plus the original composite. The caller can release its RGBA before loading
 * the next layer. No alpha threshold or premultiplied Canvas conversion. */
export class DraftPsdEncoder {
  private readonly children: Layer[] = [];
  private readonly ids = new Set<string>();
  private composite?: Uint8Array;
  private compressedBytes = 0;
  private foregrounds = 0;
  private alternates = 0;
  private finished = false;

  constructor(private readonly width: number, private readonly height: number) {
    if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= 8192)
      || width * height * 4 > MAX_RGBA_BYTES) throw new Error('原图尺寸超出当前分层处理范围');
  }

  append(layer: LayeredPsdLayer): void {
    if (this.finished) throw new Error('待修整 PSD 编码已结束');
    if (!layer.id || this.ids.has(layer.id) || !layer.name.trim() || layer.name.length > 4096)
      throw new Error('待修整 PSD 图层名称或身份无效');
    if (![layer.width, layer.height].every(value => Number.isInteger(value) && value > 0)
      || !Number.isInteger(layer.x) || !Number.isInteger(layer.y) || layer.x < 0 || layer.y < 0
      || layer.x + layer.width > this.width || layer.y + layer.height > this.height
      || layer.rgba.length !== layer.width * layer.height * 4) throw new Error('待修整 PSD 图层像素或位置无效');
    const first = this.children.length === 0;
    if (!Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1
      || (layer.kind !== 'transparent' && layer.opacity !== 1)) throw new Error('待修整 PSD 图层透明度无效');
    if (layer.visible !== first
      || (first ? layer.kind !== 'background' : !['alternate-background', 'transparent'].includes(layer.kind)))
      throw new Error('待修整 PSD 仅原图可见，返图必须隐藏');
    if (layer.kind !== 'transparent' && (layer.x !== 0 || layer.y !== 0 || layer.width !== this.width || layer.height !== this.height))
      throw new Error('待修整 PSD 原图和背景必须覆盖完整画布');
    if (layer.kind === 'alternate-background' && (++this.alternates > 1 || this.children.length !== 1))
      throw new Error('待修整 PSD 背景候选顺序无效');
    if (layer.kind === 'transparent' && (++this.foregrounds > 16 || this.alternates !== 1))
      throw new Error('待修整 PSD 需要 1–16 个前景和一个背景候选');
    let hasTransparency = false;
    for (let index = 3; index < layer.rgba.length; index += 4) if (layer.rgba[index] !== 255) { hasTransparency = true; break; }
    if (first && hasTransparency) throw new Error('待修整 PSD 需要不透明原图');
    if (layer.kind === 'transparent' && !hasTransparency) throw new Error('待修整 PSD 前景没有透明通道');
    const channels: LayerRawDataChannel[] = [];
    const plane = new Uint8Array(layer.width * layer.height);
    for (const channel of [-1, 0, 1, 2] as const) {
      const offset = channel === -1 ? 3 : channel;
      for (let pixel = 0; pixel < plane.length; pixel++) plane[pixel] = layer.rgba[pixel * 4 + offset]!;
      const data = deflate(plane);
      this.compressedBytes += data.length + 2;
      if (this.compressedBytes > MAX_COMPRESSED_BYTES) throw new Error('待修整 PSD 压缩数据超过安全内存范围，请减少本次导出的图层');
      channels.push({ id: channel, compression: 2, data });
    }
    if (first) this.composite = layer.rgba.slice();
    this.children.push({ name: layer.name, left: layer.x, top: layer.y,
      right: layer.x + layer.width, bottom: layer.y + layer.height, opacity: layer.opacity, hidden: !first,
      rawData: { colorMode: 3, bitsPerChannel: 8, large: false, channels } });
    this.ids.add(layer.id);
  }

  finish(): Uint8Array {
    if (this.finished || !this.composite || this.foregrounds < 1 || this.alternates !== 1)
      throw new Error('待修整 PSD 缺少原图、背景候选或前景');
    this.finished = true;
    // Worst-case PackBits composite (three channels) plus channel/name records.
    const compositeBound = 3 * this.height * (this.width + Math.ceil(this.width / 128) + 2);
    const metadataBound = 65536 + this.children.reduce((sum, layer) => sum + 1024 + (layer.name?.length ?? 0) * 2, 0);
    if (this.compressedBytes + compositeBound + metadataBound > MAX_FILE_BYTES)
      throw new Error('待修整 PSD 文件超出当前保存范围（256 MiB）');
    try {
      const bytes = writePsdUint8Array({ width: this.width, height: this.height, bitsPerChannel: 8,
        children: this.children, imageData: { width: this.width, height: this.height, data: this.composite } },
      { noBackground: true, trimImageData: false });
      if (bytes.length > MAX_FILE_BYTES) throw new Error('待修整 PSD 文件超出当前保存范围（256 MiB）');
      return bytes;
    } finally { this.children.length = 0; this.composite = undefined; }
  }
}
