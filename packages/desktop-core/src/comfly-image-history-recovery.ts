import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { NodeFileSystem, type FileSystem } from './file-system.js';
import type { GenerationHistoryDurableTerminal, GenerationHistoryProviderSinkContract } from './generation-history-provider-sink.js';
import { deriveGenerationHistoryId } from './generation-history-provider-sink.js';
import {
  assertConfinedAppDataPathForRead,
  assertConfinedAppDataPathForWrite,
  deleteConfinedAppDataFile,
  writeConfinedAtomicUpdate,
} from './provider-file-confinement.js';
import { createProviderBridgeError } from './provider-contracts.js';
import { detectGeneratedImageMediaType } from './provider-image-result.js';
import type { GenerationProjectBinding } from './generation-project-binding.js';
import { parseGenerationProjectBinding } from './generation-project-binding.js';
import type { ProviderMappingSecrets } from './provider-credential-vault.js';
import type { ProviderImageJobResult, SubmitImageJobBridgeResult } from './provider-contracts.js';
import type { ProviderTaskMappingStore } from './provider-task-ledger.js';
import type { ProviderTaskMappingRecord } from './provider-task-ledger.js';
import { persistPaidProviderMapping, persistPaidProviderMappingIfAbsent } from './provider-task-ledger.js';

const HISTORY_ID = /^history_[a-f0-9]{48}$/u;
const PENDING_TASK = /^pending-image-history:([a-f0-9]{64})$/u;
const MAX_IMAGE_BYTES = 256 * 1024 * 1024;
const ERROR_MESSAGE = 'Pending image history is unavailable';
const INTEGRITY_ERROR_MESSAGE = '提交状态不确定：已付费图片暂存损坏，无法安全恢复，请保留原任务';
interface PendingImageIntent {
  readonly version: 1;
  readonly provider: 'comfly';
  readonly kind: 'image';
  readonly historyId: string;
  readonly jobId: string;
  readonly publicTaskId: string;
  readonly sessionId: string;
  readonly projectBinding?: GenerationProjectBinding;
  readonly mediaType: string;
  readonly hash: string;
}

export function pendingImageHistoryHash(rawTaskId: string): string | null {
  return PENDING_TASK.exec(rawTaskId)?.[1] ?? null;
}

export function createComflyImageHistoryRecovery(options: {
  readonly appDataRoot: string;
  readonly fileSystem?: FileSystem;
  readonly historySink?: GenerationHistoryProviderSinkContract;
  readonly mappings: ProviderTaskMappingStore;
  readonly nowIso: () => string;
  readonly storeGeneratedImage?: (sessionId: string, bytes: Uint8Array, mediaType: string) => Promise<{
    readonly assetId: string; readonly width?: number | null; readonly height?: number | null;
  }>;
  readonly storeGeneratedImageForProject?: (binding: GenerationProjectBinding, bytes: Uint8Array, mediaType: string) => Promise<{
    readonly assetId: string; readonly width?: number | null; readonly height?: number | null;
  }>;
  readonly allowLegacyStorage?: boolean;
  readonly secretSupplier?: () => Promise<ProviderMappingSecrets>;
}) {
  const fileSystem = options.fileSystem ?? new NodeFileSystem();
  const pathFor = (historyId: string) => {
    if (!HISTORY_ID.test(historyId)) throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', ERROR_MESSAGE);
    return join(options.appDataRoot, `provider-image-pending-${historyId}.bin`);
  };
  const intentPathFor = (historyId: string) => join(options.appDataRoot, `provider-image-intent-${HISTORY_ID.test(historyId) ? historyId : 'invalid'}.json`);
  const handlePathFor = (publicTaskId: string) => {
    if (!/^provider-job-[a-f0-9]{32}$/u.test(publicTaskId)) throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Pending image handle is invalid');
    return join(options.appDataRoot, `provider-image-handle-${publicTaskId}.json`);
  };
  const assertRead = (path: string) => assertConfinedAppDataPathForRead(
    fileSystem, options.appDataRoot, path, 'PROVIDER_UNAVAILABLE', ERROR_MESSAGE,
  );
  const assertWrite = (path: string) => assertConfinedAppDataPathForWrite(
    fileSystem, options.appDataRoot, path, 'PROVIDER_UNAVAILABLE', ERROR_MESSAGE,
  );

  return {
    async recoverByHandle(publicTaskId: string, finish = true): Promise<ProviderTaskMappingRecord | null> {
      const path = handlePathFor(publicTaskId);
      await assertRead(path);
      let raw: string;
      try { raw = await fileSystem.readFile(path, 'utf8'); }
      catch (error) {
        if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
        throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Pending image handle is temporarily unavailable', true);
      }
      if (raw.length > 4096) throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', INTEGRITY_ERROR_MESSAGE);
      let value: unknown;
      try { value = JSON.parse(raw); } catch { throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', INTEGRITY_ERROR_MESSAGE); }
      if (value === null || typeof value !== 'object' || !('historyId' in value)
        || typeof value.historyId !== 'string' || !HISTORY_ID.test(value.historyId)) {
        throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', INTEGRITY_ERROR_MESSAGE);
      }
      const intent = await this.readIntent(value.historyId);
      if (intent === null || intent.publicTaskId !== publicTaskId) throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', INTEGRITY_ERROR_MESSAGE);
      await this.recoverUnmapped(intent.historyId, intent.projectBinding, finish);
      return (await options.mappings.get(publicTaskId)) ?? null;
    },
    async writeIntent(intent: PendingImageIntent): Promise<void> {
      if (options.secretSupplier === undefined) return;
      const path = intentPathFor(intent.historyId);
      let secret: string;
      try { secret = (await options.secretSupplier()).primary; }
      catch { throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Pending image signing key is unavailable', true); }
      const payload = JSON.stringify(intent);
      const signed = JSON.stringify({ ...intent, mac: createHmac('sha256', secret).update(payload).digest('hex') });
      try {
        await writeConfinedAtomicUpdate(fileSystem, { appDataRoot: options.appDataRoot, targetPath: path, data: signed,
          assertPathForRead: () => assertRead(path), assertPathForWrite: () => assertWrite(path),
          errorCode: 'PROVIDER_UNAVAILABLE', errorMessage: ERROR_MESSAGE });
        const handlePath = handlePathFor(intent.publicTaskId);
        await writeConfinedAtomicUpdate(fileSystem, { appDataRoot: options.appDataRoot, targetPath: handlePath, data: signed,
          assertPathForRead: () => assertRead(handlePath), assertPathForWrite: () => assertWrite(handlePath),
          errorCode: 'PROVIDER_UNAVAILABLE', errorMessage: ERROR_MESSAGE });
      } catch { throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Pending image intent is unavailable', true); }
    },
    async readIntent(historyId: string): Promise<PendingImageIntent | null> {
      if (options.secretSupplier === undefined || !HISTORY_ID.test(historyId)) return null;
      const path = intentPathFor(historyId);
      await assertRead(path);
      let raw: string;
      try { raw = await fileSystem.readFile(path, 'utf8'); }
      catch (error) {
        if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
        throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Pending image intent is temporarily unavailable', true);
      }
      if (raw.length > 4096) throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', INTEGRITY_ERROR_MESSAGE);
      let value: unknown;
      try { value = JSON.parse(raw); } catch { throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', INTEGRITY_ERROR_MESSAGE); }
      const intent = parsePendingImageIntent(value, historyId);
      let secrets: ProviderMappingSecrets;
      try { secrets = await options.secretSupplier(); }
      catch { throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Pending image signing key is unavailable', true); }
      const payload = JSON.stringify(intent);
      const mac = (value as { mac: string }).mac;
      if (![secrets.primary, ...secrets.fallback].some((secret) => {
        const expected = Buffer.from(createHmac('sha256', secret).update(payload).digest('hex'), 'hex');
        return timingSafeEqual(expected, Buffer.from(mac, 'hex'));
      })) throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', INTEGRITY_ERROR_MESSAGE);
      return intent;
    },
    async recoverUnmapped(historyId: string, expectedBinding?: GenerationProjectBinding, finish = true): Promise<SubmitImageJobBridgeResult | null> {
      const intent = await this.readIntent(historyId);
      if (intent === null) return null;
      if (JSON.stringify(intent.projectBinding) !== JSON.stringify(expectedBinding)) {
        throw createProviderBridgeError('INVALID_REQUEST', 'Pending image belongs to another project');
      }
      const timestamp = options.nowIso();
      const record: ProviderTaskMappingRecord = { provider: 'comfly', publicTaskId: intent.publicTaskId,
        rawTaskId: `pending-image-history:${intent.hash}`, kind: 'image', sessionId: intent.sessionId,
        historyId, projectBinding: intent.projectBinding, state: 'running', createdAt: timestamp, updatedAt: timestamp };
      let committed: ProviderTaskMappingRecord;
      try { committed = await persistPaidProviderMappingIfAbsent(options.mappings, record); }
      catch (error) {
        if (isNonRetryableProviderError(error)) throw error;
        throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Pending image task mapping is temporarily unavailable', true);
      }
      if (committed.state !== 'running') return { providerTaskId: intent.publicTaskId };
      if (committed.rawTaskId !== record.rawTaskId || JSON.stringify(committed.projectBinding) !== JSON.stringify(intent.projectBinding)) {
        throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Pending image task mapping changed');
      }
      const stillPresent = await this.readIntent(historyId);
      if (stillPresent?.publicTaskId !== intent.publicTaskId) {
        const cancelled = await options.mappings.markCancelled(intent.publicTaskId, options.nowIso());
        if (cancelled?.state === 'cancelled') await options.mappings.ackTerminal(intent.publicTaskId, 'cancelled');
        throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Pending image task was already acknowledged');
      }
      if (finish) {
        try { await this.recoverPending(committed, intent.hash); }
        catch (error) { if (!isRetryableProviderError(error)) throw error; }
      }
      return { providerTaskId: intent.publicTaskId };
    },
    async stageProviderImage(task: ProviderTaskMappingRecord, bytes: Uint8Array): Promise<ProviderTaskMappingRecord> {
      if (task.historyId === undefined) throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider image history is unavailable');
      const marker = await this.stage(task.historyId, bytes);
      let updated: ProviderTaskMappingRecord | undefined;
      try { updated = await options.mappings.updateRunning(task.publicTaskId, { expectedRawTaskId: task.rawTaskId, rawTaskId: marker }, options.nowIso()); }
      catch { throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Pending image task mapping is temporarily unavailable', true); }
      if (updated === undefined) throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider job handle is unavailable');
      if (updated.state !== 'running') return updated;
      const hash = pendingImageHistoryHash(updated.rawTaskId);
      if (hash === null) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Pending image task mapping changed', true);
      return this.recoverPending(updated, hash);
    },
    async recoverPending(task: ProviderTaskMappingRecord, expectedHash: string): Promise<ProviderTaskMappingRecord> {
      if (task.historyId === undefined) {
        throw createProviderBridgeError('PROVIDER_UNAVAILABLE', ERROR_MESSAGE, true);
      }
      let bytes: Uint8Array;
      try { bytes = await this.read(task.historyId, expectedHash); }
      catch (error) {
        if (!isPendingCorruption(error)) throw error;
        let terminal: GenerationHistoryDurableTerminal | undefined;
        try { terminal = await options.historySink?.failed(task.historyId, 'invalid_result'); }
        catch { throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Generation history is temporarily unavailable', true); }
        try {
          const committed = terminal?.status === 'cancelled'
            ? await options.mappings.markCancelled(task.publicTaskId, options.nowIso())
            : await options.mappings.markTerminal(task.publicTaskId, terminal?.status === 'succeeded' && task.result !== undefined
              ? { status: 'completed', progress: 1, result: task.result }
              : { status: 'failed', error: createProviderBridgeError('PROVIDER_INVALID_RESPONSE', INTEGRITY_ERROR_MESSAGE) }, options.nowIso());
          if (committed === undefined) throw new Error('Pending image task mapping disappeared');
          return committed;
        } catch { throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Pending image task mapping is temporarily unavailable', true); }
      }
      let result = task.result;
      if (result === undefined) {
        let stored: { readonly assetId: string; readonly width?: number | null; readonly height?: number | null };
        try {
          const mediaType = detectGeneratedImageMediaType(bytes);
          if (task.projectBinding !== undefined) {
            if (options.storeGeneratedImageForProject === undefined) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Bound image storage is unavailable', true);
            stored = await options.storeGeneratedImageForProject(task.projectBinding, bytes, mediaType);
          } else {
            if (options.allowLegacyStorage === false || options.storeGeneratedImage === undefined || task.sessionId === undefined) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Original project binding is unavailable', true);
            stored = await options.storeGeneratedImage(task.sessionId, bytes, mediaType);
          }
        } catch (error) {
          if (isNonRetryableProviderError(error)) throw error;
          throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Generated image storage is temporarily unavailable', true);
        }
        const attached = await this.attachStoredResult(task.publicTaskId, {
          assetId: stored.assetId, ...(stored.width == null ? {} : { width: stored.width }),
          ...(stored.height == null ? {} : { height: stored.height }),
        });
        if (attached.state !== 'running') return attached;
        result = attached.result;
        if (result === undefined) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Stored image result is temporarily unavailable', true);
      }
      await this.record(task.historyId, bytes);
      let committed: ProviderTaskMappingRecord | undefined;
      try { committed = await options.mappings.markTerminal(task.publicTaskId, { status: 'completed', progress: 1, result }, options.nowIso()); }
      catch { throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Pending image task mapping is temporarily unavailable', true); }
      if (committed === undefined) throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider job handle is unavailable');
      await this.cleanupAfterTerminal(task.historyId, task.publicTaskId);
      return committed;
    },
    async attachStoredResult(publicTaskId: string, result: ProviderImageJobResult): Promise<ProviderTaskMappingRecord> {
      let attached: ProviderTaskMappingRecord | undefined;
      try { attached = await options.mappings.attachStoredImageResult(publicTaskId, result, options.nowIso()); }
      catch { throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Stored image task mapping is temporarily unavailable', true); }
      if (attached === undefined) throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider job handle is unavailable');
      return attached;
    },
    async getTerminal(historyId: string): Promise<GenerationHistoryDurableTerminal | null> {
      if (options.historySink === undefined) return null;
      try { return await options.historySink.getTerminal(historyId); }
      catch (error) {
        if (isExplicitInvalidHistoryError(error)) {
          throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Generation history record is invalid');
        }
        if (isNonRetryableProviderError(error)) throw error;
        throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Generation history is temporarily unavailable', true);
      }
    },
    async storeInlineImage(historyId: string, sessionId: string, bytes: Uint8Array, mediaType: string, projectBinding?: GenerationProjectBinding, jobId?: string): Promise<SubmitImageJobBridgeResult> {
      if (projectBinding === undefined && options.storeGeneratedImage === undefined) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Generated image storage is unavailable');
      const publicTaskId = `provider-job-${randomBytes(16).toString('hex')}`;
      const timestamp = options.nowIso();
      const pending = options.historySink !== undefined || projectBinding !== undefined;
      let rawTaskId = `inline-image-${publicTaskId}`;
      const finishWithoutOutbox = async (): Promise<SubmitImageJobBridgeResult> => {
        const stored = projectBinding === undefined
          ? await options.storeGeneratedImage!(sessionId, bytes, mediaType)
          : await options.storeGeneratedImageForProject!(projectBinding, bytes, mediaType);
        await this.record(historyId, bytes);
        const result: ProviderImageJobResult = { assetId: stored.assetId,
          ...(stored.width == null ? {} : { width: stored.width }), ...(stored.height == null ? {} : { height: stored.height }) };
        await persistPaidProviderMapping(options.mappings, { provider: 'comfly', publicTaskId, rawTaskId, historyId, projectBinding,
          state: 'completed', createdAt: timestamp, updatedAt: timestamp, terminalAt: timestamp, result });
        await this.cleanupAfterTerminal(historyId, publicTaskId);
        return { providerTaskId: publicTaskId };
      };
      if (pending) {
        let intentStored = false;
        if (jobId !== undefined && options.secretSupplier !== undefined) {
          try {
            await this.writeIntent({ version: 1, provider: 'comfly', kind: 'image', historyId, jobId, publicTaskId, sessionId, projectBinding,
              mediaType, hash: createHash('sha256').update(bytes).digest('hex') });
            intentStored = true;
          } catch { /* Mapping and project/history storage remain independent recovery paths. */ }
        }
        try { rawTaskId = await this.stage(historyId, bytes); }
        catch {
          try { return await finishWithoutOutbox(); }
          catch { /* The stage error remains retryable and must not mark paid history failed. */ }
          throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '提交状态不确定：付费图片已返回但本地暂存不可用，请保留原任务等待恢复', true);
        }
        try {
          await persistPaidProviderMapping(options.mappings, { provider: 'comfly', publicTaskId, rawTaskId, historyId,
            kind: 'image', sessionId, projectBinding, state: 'running', createdAt: timestamp, updatedAt: timestamp });
        } catch {
          if (!intentStored) { try { return await finishWithoutOutbox(); } catch { /* Preserve the staged bytes. */ } }
          if (intentStored) return { providerTaskId: publicTaskId };
          throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '提交状态不确定：付费图片已返回但本地任务记录暂不可用，请保留原任务等待恢复', true);
        }
      }
      if (!pending) {
        const stored = await options.storeGeneratedImage!(sessionId, bytes, mediaType);
        const result: ProviderImageJobResult = { assetId: stored.assetId, ...(stored.width == null ? {} : { width: stored.width }), ...(stored.height == null ? {} : { height: stored.height }) };
        await persistPaidProviderMapping(options.mappings, { provider: 'comfly', publicTaskId, rawTaskId, historyId,
          state: 'completed', createdAt: timestamp, updatedAt: timestamp, terminalAt: timestamp, result });
        return { providerTaskId: publicTaskId };
      }
      try { await this.recoverPending((await options.mappings.get(publicTaskId))!, pendingImageHistoryHash(rawTaskId)!); }
      catch (error) { if (!isRetryableProviderError(error)) throw error; }
      return { providerTaskId: publicTaskId };
    },
    async stage(historyId: string, bytes: Uint8Array): Promise<string> {
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
        throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Generated result was invalid');
      }
      const path = pathFor(historyId);
      try {
        await writeConfinedAtomicUpdate(fileSystem, {
          appDataRoot: options.appDataRoot, targetPath: path, data: bytes,
          assertPathForRead: () => assertRead(path), assertPathForWrite: () => assertWrite(path),
          errorCode: 'PROVIDER_UNAVAILABLE', errorMessage: ERROR_MESSAGE,
        });
      } catch {
        throw createProviderBridgeError('PROVIDER_UNAVAILABLE', ERROR_MESSAGE, true);
      }
      return `pending-image-history:${createHash('sha256').update(bytes).digest('hex')}`;
    },
    async read(historyId: string, expectedHash: string): Promise<Uint8Array> {
      const path = pathFor(historyId);
      if (!/^[a-f0-9]{64}$/u.test(expectedHash) || fileSystem.readFileBuffer === undefined) {
        throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', ERROR_MESSAGE);
      }
      await assertRead(path);
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await fileSystem.readFileBuffer(path));
      } catch (error) {
        if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
          throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', INTEGRITY_ERROR_MESSAGE);
        }
        throw createProviderBridgeError('PROVIDER_UNAVAILABLE', ERROR_MESSAGE, true);
      }
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES
        || createHash('sha256').update(bytes).digest('hex') !== expectedHash) {
        throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', INTEGRITY_ERROR_MESSAGE);
      }
      return bytes;
    },
    async remove(historyId: string, publicTaskId?: string): Promise<void> {
      if (publicTaskId !== undefined) await deleteConfinedAppDataFile(fileSystem, {
        appDataRoot: options.appDataRoot, targetPath: handlePathFor(publicTaskId),
        errorCode: 'PROVIDER_UNAVAILABLE', errorMessage: ERROR_MESSAGE,
      });
      await deleteConfinedAppDataFile(fileSystem, {
        appDataRoot: options.appDataRoot, targetPath: pathFor(historyId),
        errorCode: 'PROVIDER_UNAVAILABLE', errorMessage: ERROR_MESSAGE,
      });
      await deleteConfinedAppDataFile(fileSystem, {
        appDataRoot: options.appDataRoot, targetPath: intentPathFor(historyId),
        errorCode: 'PROVIDER_UNAVAILABLE', errorMessage: ERROR_MESSAGE,
      });
    },
    async cleanupAfterTerminal(historyId: string, publicTaskId?: string): Promise<void> {
      try { await this.remove(historyId, publicTaskId); }
      catch { /* Terminal ACK retries cleanup before deleting the mapping. */ }
    },
    async record(historyId: string, bytes: Uint8Array): Promise<void> {
      if (options.historySink === undefined) return;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          if ((await options.historySink.succeeded(historyId, bytes)).status !== 'succeeded') {
            throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider image history is terminal');
          }
          return;
        } catch (error) {
          if (isNonRetryableProviderError(error)
            || (error instanceof Error && error.message === 'Generated result was invalid')) throw error;
        }
      }
      throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Generation history is temporarily unavailable', true);
    },
  };
}

function isNonRetryableProviderError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  return 'code' in error && typeof error.code === 'string'
    && 'retryable' in error && error.retryable === false;
}

function isRetryableProviderError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  return 'code' in error && typeof error.code === 'string'
    && 'retryable' in error && error.retryable === true;
}

function isExplicitInvalidHistoryError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  return 'code' in error && typeof error.code === 'string' && error.code.startsWith('HISTORY_')
    && 'retryable' in error && error.retryable === false;
}

function isPendingCorruption(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error
    && error.code === 'PROVIDER_INVALID_RESPONSE';
}

function parsePendingImageIntent(value: unknown, historyId: string): PendingImageIntent {
  const invalid = () => createProviderBridgeError('PROVIDER_INVALID_RESPONSE', INTEGRITY_ERROR_MESSAGE);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const record = value as Record<string, unknown>;
  const expected = ['version', 'provider', 'kind', 'historyId', 'jobId', 'publicTaskId', 'sessionId',
    'mediaType', 'hash', 'mac', ...(record.projectBinding === undefined ? [] : ['projectBinding'])];
  if (Object.keys(record).length !== expected.length || expected.some((key) => !Object.prototype.hasOwnProperty.call(record, key))) throw invalid();
  if (record.version !== 1 || record.provider !== 'comfly' || record.kind !== 'image' || record.historyId !== historyId
    || typeof record.jobId !== 'string' || record.jobId.length === 0 || record.jobId.length > 512
    || deriveGenerationHistoryId(record.jobId) !== historyId
    || typeof record.publicTaskId !== 'string' || !/^provider-job-[a-f0-9]{32}$/u.test(record.publicTaskId)
    || typeof record.sessionId !== 'string' || record.sessionId.length === 0 || record.sessionId.length > 512
    || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(record.mediaType as string)
    || typeof record.hash !== 'string' || !/^[a-f0-9]{64}$/u.test(record.hash)
    || typeof record.mac !== 'string' || !/^[a-f0-9]{64}$/u.test(record.mac)) throw invalid();
  let projectBinding: GenerationProjectBinding | undefined;
  try { projectBinding = record.projectBinding === undefined ? undefined : parseGenerationProjectBinding(record.projectBinding); }
  catch { throw invalid(); }
  return { version: 1, provider: 'comfly', kind: 'image', historyId,
    jobId: record.jobId, publicTaskId: record.publicTaskId, sessionId: record.sessionId,
    projectBinding, mediaType: record.mediaType as string, hash: record.hash };
}
