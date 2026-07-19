import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { inflateSync } from 'node:zlib';

import {
  GENERATION_HISTORY_SCHEMA_VERSION,
  parseGenerationHistoryRecord,
  type GenerationHistoryRecord,
} from '@agent-canvas/domain';

import { GenerationHistoryStore } from './generation-history-store.js';

const HISTORY_PROMPT_SUMMARY = 'Image generation request';
const HISTORY_CAPABILITY_REVISION = 'image-generation-v1';
const MAX_PROVIDER_HISTORY_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_DECODED_IMAGE_BYTES = 256 * 1024 * 1024;

export type GenerationHistoryFailureCode =
  | 'provider_failed'
  | 'provider_unavailable'
  | 'invalid_result';

export type GenerationHistoryDurableTerminal =
  | { readonly status: 'succeeded'; readonly width: number; readonly height: number }
  | { readonly status: 'failed' }
  | { readonly status: 'cancelled' };

export interface GenerationHistoryProviderSinkContract {
  queued(input: {
    readonly jobId: string;
    readonly modelDisplayName: string;
  }): Promise<string>;
  running(historyId: string): Promise<void>;
  getTerminal(historyId: string): Promise<GenerationHistoryDurableTerminal | null>;
  failed(historyId: string, code: GenerationHistoryFailureCode): Promise<GenerationHistoryDurableTerminal>;
  cancelled(historyId: string, code?: 'cancelled_by_user' | 'cancelled_by_system'): Promise<GenerationHistoryDurableTerminal>;
  succeeded(historyId: string, bytes: Uint8Array): Promise<GenerationHistoryDurableTerminal>;
}

export interface ElectronNativeImageLike {
  createFromBuffer(buffer: Buffer): {
    readonly isEmpty: () => boolean;
    readonly getSize: () => { readonly width: number; readonly height: number };
  };
}

export type TrustedImageDecoder = (bytes: Uint8Array, image: InspectedImage) => boolean | Promise<boolean>;

export class GenerationHistoryProviderSink implements GenerationHistoryProviderSinkContract {
  private readonly now: () => number;
  private readonly store: GenerationHistoryStore;
  private readonly trustedImageDecoder: TrustedImageDecoder;

  constructor(options: {
    readonly now?: () => number;
    readonly store: GenerationHistoryStore;
    readonly trustedImageDecoder?: TrustedImageDecoder;
  }) {
    this.now = options.now ?? Date.now;
    this.store = options.store;
    this.trustedImageDecoder = options.trustedImageDecoder ?? trustedImageDecoderUnavailable;
  }

  async queued(input: {
    readonly jobId: string;
    readonly modelDisplayName: string;
  }): Promise<string> {
    const identities = deriveHistoryIdentities(input.jobId);
    const existing = await this.getRecord(identities.historyId);
    if (existing !== undefined) return identities.historyId;
    const timestamp = this.nowIso();
    const record = parseGenerationHistoryRecord({
      schemaVersion: GENERATION_HISTORY_SCHEMA_VERSION,
      id: identities.historyId,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
      project: null,
      job: { jobId: identities.jobId },
      status: 'queued',
      provider: {
        displayName: 'Comfly',
        modelDisplayName: input.modelDisplayName,
        capabilityRevision: HISTORY_CAPABILITY_REVISION,
      },
      promptSummary: HISTORY_PROMPT_SUMMARY,
      parameters: {},
      output: null,
      favorite: false,
      tags: [],
      projectReferenceCount: 0,
      projectReferences: [],
      trash: null,
      termination: null,
    });
    await this.store.upsertMetadata({
      operationId: operationId(identities.historyId, 'queued'),
      record,
    });
    return identities.historyId;
  }

  async running(historyId: string): Promise<void> {
    const existing = await this.requireRecord(historyId);
    if (existing.status !== 'queued') return;
    await this.store.upsertMetadata({
      operationId: operationId(historyId, 'running'),
      record: parseGenerationHistoryRecord({
        ...existing,
        updatedAt: this.nowIso(),
        completedAt: null,
        status: 'running',
        output: null,
        termination: null,
      }),
    });
  }

  async getTerminal(historyId: string): Promise<GenerationHistoryDurableTerminal | null> {
    return terminalFromRecord(await this.requireRecord(historyId));
  }

  async failed(historyId: string, code: GenerationHistoryFailureCode): Promise<GenerationHistoryDurableTerminal> {
    const existing = await this.requireRecord(historyId);
    const prior = terminalFromRecord(existing);
    if (prior !== null) return prior;
    const timestamp = this.nowIso();
    const stored = await this.store.upsertMetadata({
      operationId: operationId(historyId, `failed-${code}`),
      record: parseGenerationHistoryRecord({
        ...existing,
        updatedAt: timestamp,
        completedAt: timestamp,
        status: 'failed',
        output: null,
        termination: {
          code,
          message: failureMessage(code),
        },
      }),
    });
    return terminalFromRecord(stored) ?? { status: 'failed' };
  }

  async cancelled(
    historyId: string,
    code: 'cancelled_by_user' | 'cancelled_by_system' = 'cancelled_by_user',
  ): Promise<GenerationHistoryDurableTerminal> {
    const existing = await this.requireRecord(historyId);
    const prior = terminalFromRecord(existing);
    if (prior !== null) return prior;
    const timestamp = this.nowIso();
    const stored = await this.store.upsertMetadata({
      operationId: operationId(historyId, code),
      record: parseGenerationHistoryRecord({
        ...existing,
        updatedAt: timestamp,
        completedAt: timestamp,
        status: 'cancelled',
        output: null,
        termination: {
          code,
          message: 'Generation cancelled',
        },
      }),
    });
    return terminalFromRecord(stored) ?? { status: 'cancelled' };
  }

  async succeeded(historyId: string, rawBytes: Uint8Array): Promise<GenerationHistoryDurableTerminal> {
    const existing = await this.requireRecord(historyId);
    const prior = terminalFromRecord(existing);
    if (prior !== null) return prior;
    const bytes = Buffer.from(rawBytes);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_PROVIDER_HISTORY_ASSET_BYTES) {
      throw new Error('Generated result was invalid');
    }
    const image = inspectImage(bytes);
    if (!await this.trustedImageDecoder(bytes, image)) {
      throw new Error('Generated result was invalid');
    }
    const timestamp = this.nowIso();
    const identityHash = historyId.replace(/^history_/u, '');
    const record = parseGenerationHistoryRecord({
      ...existing,
      updatedAt: timestamp,
      completedAt: timestamp,
      job: {
        ...existing.job,
        resultId: `historyresult_${identityHash}`,
      },
      status: 'succeeded',
      output: {
        width: image.width,
        height: image.height,
        format: image.format,
        mediaType: image.mediaType,
        byteSize: bytes.byteLength,
        availability: 'available',
        historyAssetId: `historyasset_${identityHash}`,
        sha256: sha256(bytes),
      },
      termination: null,
    });
    const stored = await this.store.ingest({
      operationId: operationId(historyId, 'succeeded'),
      record,
      source: Readable.from([bytes]),
    });
    return terminalFromRecord(stored) ?? { status: 'succeeded', width: image.width, height: image.height };
  }

  private async getRecord(historyId: string): Promise<GenerationHistoryRecord | undefined> {
    try {
      return (await this.store.getRecords([historyId]))[0];
    } catch (error) {
      if (isHistoryRecordUnavailable(error)) return undefined;
      throw error;
    }
  }

  private async requireRecord(historyId: string): Promise<GenerationHistoryRecord> {
    const record = await this.getRecord(historyId);
    if (record === undefined) throw new Error('Generation history record is unavailable');
    return record;
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }
}

export function createElectronTrustedImageDecoder(nativeImage: ElectronNativeImageLike): TrustedImageDecoder {
  return (bytes, image) => {
    const decoded = nativeImage.createFromBuffer(Buffer.from(bytes));
    if (decoded.isEmpty()) return false;
    const size = decoded.getSize();
    return size.width === image.width && size.height === image.height;
  };
}

function terminalFromRecord(record: GenerationHistoryRecord): GenerationHistoryDurableTerminal | null {
  if (record.status === 'succeeded' && record.output !== null) {
    return { status: 'succeeded', width: record.output.width, height: record.output.height };
  }
  if (record.status === 'failed') return { status: 'failed' };
  if (record.status === 'cancelled') return { status: 'cancelled' };
  return null;
}

function isHistoryRecordUnavailable(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'HISTORY_INVALID_REQUEST';
}

function deriveHistoryIdentities(jobId: string): {
  readonly historyId: string;
  readonly jobId: string;
} {
  const digest = createHash('sha256')
    .update('novus-generation-history-job\0', 'utf8')
    .update(jobId, 'utf8')
    .digest('hex')
    .slice(0, 48);
  return {
    historyId: `history_${digest}`,
    jobId: `historyjob_${digest}`,
  };
}

function operationId(historyId: string, transition: string): string {
  const digest = createHash('sha256')
    .update('novus-generation-history-operation\0', 'utf8')
    .update(historyId, 'utf8')
    .update('\0', 'utf8')
    .update(transition, 'utf8')
    .digest('hex')
    .slice(0, 48);
  return `historyop_${digest}`;
}

function failureMessage(code: GenerationHistoryFailureCode): string {
  if (code === 'provider_failed') return 'Generation failed';
  if (code === 'provider_unavailable') return 'Provider unavailable';
  return 'Generated result was invalid';
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface InspectedImage {
  readonly format: 'gif' | 'jpg' | 'png' | 'webp';
  readonly mediaType: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';
  readonly width: number;
  readonly height: number;
}

function inspectImage(bytes: Buffer): InspectedImage {
  const image = inspectPng(bytes) ?? inspectGif(bytes) ?? inspectJpeg(bytes) ?? inspectWebp(bytes);
  if (image === null || image.width <= 0 || image.height <= 0 || image.width > 32_768 || image.height > 32_768) {
    throw new Error('Generated result was invalid');
  }
  return image;
}

function inspectPng(bytes: Buffer): InspectedImage | null {
  if (
    bytes.byteLength < 45
    || !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let seenHeader = false;
  let seenPalette = false;
  let seenData = false;
  const compressed: Buffer[] = [];
  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) return null;
    const length = bytes.readUInt32BE(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > bytes.byteLength) return null;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (crc32(bytes.subarray(offset + 4, dataEnd)) !== bytes.readUInt32BE(dataEnd)) return null;
    if (!seenHeader && type !== 'IHDR') return null;
    if (type === 'IHDR') {
      if (seenHeader || length !== 13) return null;
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      bitDepth = bytes[dataStart + 8]!;
      colorType = bytes[dataStart + 9]!;
      if (
        bytes[dataStart + 10] !== 0
        || bytes[dataStart + 11] !== 0
        || bytes[dataStart + 12] !== 0
        || !isValidPngColorDepth(colorType, bitDepth)
      ) return null;
      seenHeader = true;
    } else if (type === 'PLTE') {
      if (!seenHeader || seenData || length === 0 || length % 3 !== 0 || length > 768) return null;
      seenPalette = true;
    } else if (type === 'IDAT') {
      if (!seenHeader || length === 0) return null;
      seenData = true;
      compressed.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      if (length !== 0 || !seenHeader || !seenData || chunkEnd !== bytes.byteLength) return null;
      if (colorType === 3 && !seenPalette) return null;
      const rowBytes = pngRowBytes(width, colorType, bitDepth);
      const decodedBytes = (rowBytes + 1) * height;
      if (!Number.isSafeInteger(decodedBytes) || decodedBytes <= 0 || decodedBytes > MAX_DECODED_IMAGE_BYTES) return null;
      let decoded: Buffer;
      try {
        decoded = inflateSync(Buffer.concat(compressed), { maxOutputLength: decodedBytes });
      } catch {
        return null;
      }
      if (decoded.byteLength !== decodedBytes) return null;
      for (let row = 0; row < height; row += 1) {
        if (decoded[row * (rowBytes + 1)]! > 4) return null;
      }
      return { format: 'png', mediaType: 'image/png', width, height };
    } else if (/^[A-Z]/u.test(type)) {
      return null;
    }
    offset = chunkEnd;
  }
  return null;
}

function inspectGif(bytes: Buffer): InspectedImage | null {
  if (bytes.byteLength < 14 || !/^GIF8[79]a$/u.test(bytes.toString('ascii', 0, 6))) return null;
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  const packed = bytes[10]!;
  let offset = 13;
  if ((packed & 0x80) !== 0) offset += 3 * (2 ** ((packed & 0x07) + 1));
  if (offset > bytes.byteLength) return null;
  let sawImage = false;
  while (offset < bytes.byteLength) {
    const marker = bytes[offset++]!;
    if (marker === 0x3b) {
      return sawImage && offset === bytes.byteLength
        ? { format: 'gif', mediaType: 'image/gif', width, height }
        : null;
    }
    if (marker === 0x21) {
      if (offset >= bytes.byteLength) return null;
      offset += 1;
      offset = skipGifSubBlocks(bytes, offset);
      if (offset < 0) return null;
      continue;
    }
    if (marker !== 0x2c || offset + 9 > bytes.byteLength) return null;
    const left = bytes.readUInt16LE(offset);
    const top = bytes.readUInt16LE(offset + 2);
    const imageWidth = bytes.readUInt16LE(offset + 4);
    const imageHeight = bytes.readUInt16LE(offset + 6);
    const imagePacked = bytes[offset + 8]!;
    offset += 9;
    if (imageWidth === 0 || imageHeight === 0 || left + imageWidth > width || top + imageHeight > height) return null;
    if ((imagePacked & 0x80) !== 0) offset += 3 * (2 ** ((imagePacked & 0x07) + 1));
    if (offset >= bytes.byteLength || bytes[offset]! < 2 || bytes[offset]! > 8) return null;
    offset += 1;
    const imageDataStart = offset;
    offset = skipGifSubBlocks(bytes, offset);
    if (offset < 0 || offset <= imageDataStart + 1) return null;
    sawImage = true;
  }
  return null;
}

function inspectJpeg(bytes: Buffer): InspectedImage | null {
  if (
    bytes.byteLength < 8
    || bytes[0] !== 0xff
    || bytes[1] !== 0xd8
    || bytes[bytes.byteLength - 2] !== 0xff
    || bytes[bytes.byteLength - 1] !== 0xd9
  ) return null;
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawScanData = false;
  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) return null;
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0xd9) {
      return offset === bytes.byteLength && width > 0 && height > 0 && sawScanData
        ? { format: 'jpg', mediaType: 'image/jpeg', width, height }
        : null;
    }
    if (marker === 0xd8 || marker === 0x00) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.byteLength) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.byteLength) return null;
    if (isJpegStartOfFrame(marker)) {
      if (length < 7) return null;
      width = bytes.readUInt16BE(offset + 5);
      height = bytes.readUInt16BE(offset + 3);
    }
    offset += length;
    if (marker === 0xda) {
      const scanDataStart = offset;
      while (offset < bytes.byteLength) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const next = bytes[offset + 1];
        if (next === undefined) return null;
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          offset += 2;
          continue;
        }
        break;
      }
      sawScanData = offset > scanDataStart;
    }
  }
  return null;
}

function trustedImageDecoderUnavailable(): boolean {
  return true;
}

function isJpegStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function inspectWebp(bytes: Buffer): InspectedImage | null {
  if (
    bytes.byteLength < 20
    || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 12) !== 'WEBP'
  ) return null;
  if (bytes.readUInt32LE(4) + 8 !== bytes.byteLength) return null;
  let offset = 12;
  let canvas: { width: number; height: number } | null = null;
  let image: { width: number; height: number } | null = null;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) return null;
    const kind = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + (length % 2);
    if (dataEnd < dataStart || chunkEnd > bytes.byteLength) return null;
    if (kind === 'VP8X') {
      if (canvas !== null || length !== 10 || (bytes[dataStart]! & 0xc3) !== 0) return null;
      canvas = { width: readUInt24LE(bytes, dataStart + 4) + 1, height: readUInt24LE(bytes, dataStart + 7) + 1 };
    } else if (kind === 'VP8 ') {
      if (image !== null || length < 10 || !bytes.subarray(dataStart + 3, dataStart + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) return null;
      image = { width: bytes.readUInt16LE(dataStart + 6) & 0x3fff, height: bytes.readUInt16LE(dataStart + 8) & 0x3fff };
    } else if (kind === 'VP8L') {
      if (image !== null || length < 5 || bytes[dataStart] !== 0x2f) return null;
      const packed = bytes.readUInt32LE(dataStart + 1);
      image = { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
    }
    offset = chunkEnd;
  }
  if (offset !== bytes.byteLength || image === null) return null;
  if (canvas !== null && (canvas.width !== image.width || canvas.height !== image.height)) return null;
  return { format: 'webp', mediaType: 'image/webp', width: image.width, height: image.height };
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function pngRowBytes(width: number, colorType: number, bitDepth: number): number {
  const channels = colorType === 0 || colorType === 3 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
  return Math.ceil(width * channels * bitDepth / 8);
}

function isValidPngColorDepth(colorType: number, bitDepth: number): boolean {
  if (colorType === 0) return bitDepth === 1 || bitDepth === 2 || bitDepth === 4 || bitDepth === 8 || bitDepth === 16;
  if (colorType === 2 || colorType === 4 || colorType === 6) return bitDepth === 8 || bitDepth === 16;
  return colorType === 3 && (bitDepth === 1 || bitDepth === 2 || bitDepth === 4 || bitDepth === 8);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb88320);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function skipGifSubBlocks(bytes: Buffer, initialOffset: number): number {
  let offset = initialOffset;
  while (offset < bytes.byteLength) {
    const length = bytes[offset++]!;
    if (length === 0) return offset;
    offset += length;
    if (offset > bytes.byteLength) return -1;
  }
  return -1;
}
