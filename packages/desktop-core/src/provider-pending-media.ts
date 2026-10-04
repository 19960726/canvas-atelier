import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

import { NodeFileSystem, type FileSystem } from './file-system.js';
import type { GenerationProjectBinding } from './generation-project-binding.js';
import { parseGenerationProjectBinding } from './generation-project-binding.js';
import type { ProviderMappingSecrets } from './provider-credential-vault.js';
import { createProviderBridgeError } from './provider-contracts.js';
import type { ProviderTaskMappingRecord } from './provider-task-ledger.js';
import { detectGeneratedImageMediaType } from './provider-image-result.js';
import {
  assertConfinedAppDataPathForRead, assertConfinedAppDataPathForWrite,
  deleteConfinedAppDataFile, writeConfinedAtomicUpdate,
} from './provider-file-confinement.js';

const HANDLE = /^provider-job-[a-f0-9]{32}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const STAGED_TASK = /^pending-media:[a-f0-9]{64}$/u;
const INTEGRITY_ERROR = '提交状态不确定：已付费媒体暂存损坏，无法安全恢复，请保留原任务';
const IO_ERROR = '提交状态不确定：已付费媒体暂存暂时不可用，请保留原任务';
export type PendingMediaType = 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp' | 'video/mp4';
export interface PendingMediaEntry {
  readonly hash: string;
  readonly mediaType: PendingMediaType;
  readonly width?: number;
  readonly height?: number;
  readonly durationSeconds?: number;
}
export interface PendingMediaManifest {
  readonly version: 1;
  readonly provider: 'comfly' | 'relayme';
  readonly kind: 'image' | 'video';
  readonly publicTaskId: string;
  readonly rawTaskId: string;
  readonly historyId?: string;
  readonly projectBinding?: GenerationProjectBinding;
  readonly entries: readonly PendingMediaEntry[];
}

export function pendingMediaTaskMarker(manifest: PendingMediaManifest): string {
  return `pending-media:${createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}`;
}

export function createProviderPendingMediaStore(options: {
  readonly appDataRoot: string;
  readonly fileSystem?: FileSystem;
  readonly secretSupplier: () => Promise<ProviderMappingSecrets>;
}) {
  const fileSystem = options.fileSystem ?? new NodeFileSystem();
  const pathFor = (handle: string, index?: number) => {
    if (!HANDLE.test(handle) || (index !== undefined && (!Number.isInteger(index) || index < 0 || index > 3))) {
      throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', INTEGRITY_ERROR);
    }
    return join(options.appDataRoot, `provider-pending-media-${handle}${index === undefined ? '.json' : `-${index}.bin`}`);
  };
  const assertRead = async (path: string) => {
    try { await assertConfinedAppDataPathForRead(fileSystem, options.appDataRoot, path, 'PROVIDER_UNAVAILABLE', IO_ERROR); }
    catch (error) {
      if (isConfinementRejection(error)) throw integrityError();
      throw createProviderBridgeError('PROVIDER_UNAVAILABLE', IO_ERROR, true);
    }
  };
  const assertWrite = async (path: string) => {
    try { await assertConfinedAppDataPathForWrite(fileSystem, options.appDataRoot, path, 'PROVIDER_UNAVAILABLE', IO_ERROR); }
    catch (error) {
      if (isConfinementRejection(error)) throw integrityError();
      throw createProviderBridgeError('PROVIDER_UNAVAILABLE', IO_ERROR, true);
    }
  };
  const atomicWrite = async (path: string, data: Uint8Array | string) => {
    try {
      await writeConfinedAtomicUpdate(fileSystem, {
        appDataRoot: options.appDataRoot, targetPath: path, data,
        assertPathForRead: () => assertRead(path), assertPathForWrite: () => assertWrite(path),
        errorCode: 'PROVIDER_UNAVAILABLE', errorMessage: IO_ERROR,
      });
    } catch (error) {
      if (isIntegrityError(error)) throw error;
      throw createProviderBridgeError('PROVIDER_UNAVAILABLE', IO_ERROR, true);
    }
  };
  return {
    async writeItem(record: ProviderTaskMappingRecord, index: number, bytes: Uint8Array, metadata: Omit<PendingMediaEntry, 'hash' | 'mediaType'> = {}): Promise<PendingMediaEntry> {
      const mediaType = validMedia(bytes, record.kind === 'video' ? 'video' : 'image');
      const path = pathFor(record.publicTaskId, index);
      await atomicWrite(path, bytes);
      return { hash: createHash('sha256').update(bytes).digest('hex'), mediaType, ...metadata };
    },
    async seal(record: ProviderTaskMappingRecord, entries: readonly PendingMediaEntry[]): Promise<void> {
      if ((record.provider !== 'comfly' && record.provider !== 'relayme') || !['image', 'video'].includes(record.kind ?? '')
        || entries.length < 1 || entries.length > (record.kind === 'image' ? 4 : 1)) {
        throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', INTEGRITY_ERROR);
      }
      const manifest: PendingMediaManifest = { version: 1, provider: record.provider, kind: record.kind!,
        publicTaskId: record.publicTaskId, rawTaskId: record.rawTaskId,
        ...(record.historyId === undefined ? {} : { historyId: record.historyId }),
        ...(record.projectBinding === undefined ? {} : { projectBinding: record.projectBinding }), entries };
      const secret = await getSecrets(options.secretSupplier);
      const signed = JSON.stringify({ ...manifest, mac: createHmac('sha256', secret.primary).update(JSON.stringify(manifest)).digest('hex') });
      await atomicWrite(pathFor(record.publicTaskId), signed);
    },
    async read(record: ProviderTaskMappingRecord): Promise<PendingMediaManifest | null> {
      const path = pathFor(record.publicTaskId);
      await assertRead(path);
      let raw: string;
      try { raw = await fileSystem.readFile(path, 'utf8'); }
      catch (error) {
        if (isMissing(error)) {
          if (STAGED_TASK.test(record.rawTaskId)) throw integrityError();
          return null;
        }
        throw createProviderBridgeError('PROVIDER_UNAVAILABLE', IO_ERROR, true);
      }
      if (raw.length > 4096) throw integrityError();
      let value: unknown;
      try { value = JSON.parse(raw); } catch { throw integrityError(); }
      const manifest = parseManifest(value);
      if (manifest.publicTaskId !== record.publicTaskId
        || manifest.historyId !== record.historyId || manifest.provider !== record.provider || manifest.kind !== record.kind
        || JSON.stringify(manifest.projectBinding) !== JSON.stringify(record.projectBinding)) throw integrityError();
      if (STAGED_TASK.test(record.rawTaskId)
        ? pendingMediaTaskMarker(manifest) !== record.rawTaskId : manifest.rawTaskId !== record.rawTaskId) throw integrityError();
      const secrets = await getSecrets(options.secretSupplier);
      const mac = Buffer.from((value as { mac: string }).mac, 'hex');
      if (![secrets.primary, ...secrets.fallback].some((secret) => timingSafeEqual(
        Buffer.from(createHmac('sha256', secret).update(JSON.stringify(manifest)).digest('hex'), 'hex'), mac,
      ))) throw integrityError();
      return manifest;
    },
    async readItem(manifest: PendingMediaManifest, index: number): Promise<Uint8Array> {
      const entry = manifest.entries[index];
      if (entry === undefined || fileSystem.readFileBuffer === undefined) throw integrityError();
      const path = pathFor(manifest.publicTaskId, index);
      await assertRead(path);
      let bytes: Uint8Array;
      try { bytes = new Uint8Array(await fileSystem.readFileBuffer(path)); }
      catch (error) {
        if (isMissing(error)) throw integrityError();
        throw createProviderBridgeError('PROVIDER_UNAVAILABLE', IO_ERROR, true);
      }
      if (createHash('sha256').update(bytes).digest('hex') !== entry.hash || validMedia(bytes, manifest.kind) !== entry.mediaType) throw integrityError();
      return bytes;
    },
    async remove(publicTaskId: string): Promise<void> {
      for (let index = 0; index < 4; index += 1) await deleteConfinedAppDataFile(fileSystem, {
        appDataRoot: options.appDataRoot, targetPath: pathFor(publicTaskId, index), errorCode: 'PROVIDER_UNAVAILABLE', errorMessage: IO_ERROR,
      });
      await deleteConfinedAppDataFile(fileSystem, {
        appDataRoot: options.appDataRoot, targetPath: pathFor(publicTaskId), errorCode: 'PROVIDER_UNAVAILABLE', errorMessage: IO_ERROR,
      });
    },
  };
}

function parseManifest(value: unknown): PendingMediaManifest {
  if (!plain(value) || !exactKeys(value, ['version', 'provider', 'kind', 'publicTaskId', 'rawTaskId', 'historyId', 'projectBinding', 'entries', 'mac'])
    || value.version !== 1 || !['comfly', 'relayme'].includes(String(value.provider))
    || (value.kind !== 'image' && value.kind !== 'video') || typeof value.publicTaskId !== 'string' || !HANDLE.test(value.publicTaskId)
    || typeof value.rawTaskId !== 'string' || value.rawTaskId.length < 1 || value.rawTaskId.length > 512
    || (value.historyId !== undefined && (typeof value.historyId !== 'string' || !/^history_[a-f0-9]{48}$/u.test(value.historyId)))
    || !Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > (value.kind === 'image' ? 4 : 1)
    || typeof value.mac !== 'string' || !HASH.test(value.mac)) throw integrityError();
  let projectBinding: GenerationProjectBinding | undefined;
  try { if (value.projectBinding !== undefined) projectBinding = parseGenerationProjectBinding(value.projectBinding); }
  catch { throw integrityError(); }
  const entries = value.entries.map((entry: unknown) => {
    if (!plain(entry) || !exactKeys(entry, ['hash', 'mediaType', 'width', 'height', 'durationSeconds'])
      || typeof entry.hash !== 'string' || !HASH.test(entry.hash)
      || !['image/gif', 'image/jpeg', 'image/png', 'image/webp', 'video/mp4'].includes(String(entry.mediaType))
      || (value.kind === 'image' ? !String(entry.mediaType).startsWith('image/') : entry.mediaType !== 'video/mp4')
      || ['width', 'height', 'durationSeconds'].some((key) => entry[key] !== undefined && (typeof entry[key] !== 'number' || !Number.isFinite(entry[key]) || entry[key] <= 0))) throw integrityError();
    return { hash: entry.hash, mediaType: entry.mediaType,
      ...(entry.width === undefined ? {} : { width: entry.width }), ...(entry.height === undefined ? {} : { height: entry.height }),
      ...(entry.durationSeconds === undefined ? {} : { durationSeconds: entry.durationSeconds }) } as PendingMediaEntry;
  });
  return { version: 1, provider: value.provider as 'comfly' | 'relayme', kind: value.kind,
    publicTaskId: value.publicTaskId, rawTaskId: value.rawTaskId,
    ...(value.historyId === undefined ? {} : { historyId: value.historyId as string }),
    ...(projectBinding === undefined ? {} : { projectBinding }), entries };
}

function validMedia(bytes: Uint8Array, kind: 'image' | 'video'): PendingMediaType {
  const limit = kind === 'image' ? 256 * 1024 * 1024 : 512 * 1024 * 1024;
  if (bytes.byteLength < 1 || bytes.byteLength > limit) throw integrityError();
  if (kind === 'video') {
    if (bytes.byteLength < 12 || Buffer.from(bytes.buffer, bytes.byteOffset + 4, 4).toString('ascii') !== 'ftyp') throw integrityError();
    return 'video/mp4';
  }
  try { return detectGeneratedImageMediaType(bytes) as PendingMediaType; }
  catch { throw integrityError(); }
}

async function getSecrets(supplier: () => Promise<ProviderMappingSecrets>): Promise<ProviderMappingSecrets> {
  try { return await supplier(); }
  catch { throw createProviderBridgeError('PROVIDER_UNAVAILABLE', IO_ERROR, true); }
}
function integrityError() { return createProviderBridgeError('PROVIDER_INVALID_RESPONSE', INTEGRITY_ERROR); }
function isConfinementRejection(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'PROVIDER_UNAVAILABLE'
    && 'retryable' in error && error.retryable === false;
}
function isIntegrityError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'PROVIDER_INVALID_RESPONSE';
}
function isMissing(error: unknown): boolean { return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }
function plain(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
