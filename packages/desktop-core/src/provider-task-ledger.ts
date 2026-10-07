import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';

import { acquireConfinedFileLock, releaseConfinedFileLock } from './confined-file-lock.js';
import { NodeFileSystem, type FileSystem } from './file-system.js';
import {
  assertConfinedAppDataPathForRead,
  assertConfinedAppDataPathForWrite,
  assertConfinedProviderTaskPathForRead,
  assertConfinedProviderTaskPathForWrite,
  confinedProviderTaskMappingsLockPath,
  confinedProviderTaskMappingsPath,
  writeConfinedAtomicUpdate,
} from './provider-file-confinement.js';
import {
  createProviderBridgeError,
  isProviderBridgeErrorCode,
  normalizeProviderBridgeError,
  ProviderIdSchema,
  type PollImageJobBridgeResult,
  type PollVideoJobBridgeResult,
  type ProviderBridgeError,
  type ProviderBridgeProvider,
  type ProviderImageJobResult,
  type ProviderVideoJobResult,
  type ProviderImageJobTerminalStatus,
} from './provider-contracts.js';
import type { ProviderMappingSecrets } from './provider-credential-vault.js';
import { parseGenerationProjectBinding, type GenerationProjectBinding } from './generation-project-binding.js';

const scrypt = promisify(scryptCallback);

export type ProviderTaskMappingState = 'running' | ProviderImageJobTerminalStatus;

export interface ProviderTaskMappingRecord {
  readonly provider: ProviderBridgeProvider;
  readonly publicTaskId: string;
  readonly rawTaskId: string;
  readonly kind?: 'image' | 'video';
  readonly sessionId?: string;
  readonly historyId?: string;
  readonly projectBinding?: GenerationProjectBinding;
  readonly state: ProviderTaskMappingState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalAt?: string;
  readonly result?: ProviderImageJobResult | ProviderVideoJobResult;
  readonly error?: ProviderBridgeError;
}

export interface ProviderTaskMappingStore {
  ackTerminal(publicTaskId: string, status: ProviderImageJobTerminalStatus): Promise<void>;
  attachStoredImageResult(publicTaskId: string, result: ProviderImageJobResult, now: string): Promise<ProviderTaskMappingRecord | undefined>;
  findByHistoryId(historyId: string): Promise<ProviderTaskMappingRecord | undefined>;
  gcTerminalTombstones(expireBeforeMs: number): Promise<void>;
  get(publicTaskId: string): Promise<ProviderTaskMappingRecord | undefined>;
  markCancelled(publicTaskId: string, now: string): Promise<ProviderTaskMappingRecord | undefined>;
  markTerminal(
    publicTaskId: string,
    result: Extract<PollImageJobBridgeResult | PollVideoJobBridgeResult, { status: 'completed' | 'failed' }>,
    now: string,
  ): Promise<ProviderTaskMappingRecord | undefined>;
  reserveSubmission(input: {
    readonly currentIdentity: boolean;
    readonly historyId: string;
  }): Promise<boolean>;
  set(record: ProviderTaskMappingRecord): Promise<void>;
  setIfAbsent(record: ProviderTaskMappingRecord): Promise<ProviderTaskMappingRecord>;
  updateRunning(publicTaskId: string, update: {
    readonly expectedRawTaskId?: string;
    readonly rawTaskId?: string;
    readonly result?: ProviderImageJobResult | ProviderVideoJobResult;
  }, now: string): Promise<ProviderTaskMappingRecord | undefined>;
}

export async function persistPaidProviderMapping(store: ProviderTaskMappingStore, record: ProviderTaskMappingRecord): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { await store.set(record); return; }
    catch (error) { lastError = error; }
  }
  throw lastError;
}

export async function persistPaidProviderMappingIfAbsent(store: ProviderTaskMappingStore, record: ProviderTaskMappingRecord): Promise<ProviderTaskMappingRecord> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await store.setIfAbsent(record); }
    catch (error) {
      if (isProviderBridgeError(error) && !error.retryable) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

export function assertMatchingProjectBinding(expected: GenerationProjectBinding | undefined, record: ProviderTaskMappingRecord): void {
  if (expected === undefined) return;
  if (record.projectBinding?.projectId !== expected.projectId
    || record.projectBinding.rootFingerprint !== expected.rootFingerprint) {
    throw createProviderBridgeError('INVALID_REQUEST', 'Generation job belongs to another project');
  }
}

interface ProviderTaskMappingEnvelope {
  readonly version: 1;
  readonly saltHex: string;
  readonly ivHex: string;
  readonly authTagHex: string;
  readonly ciphertextHex: string;
}

interface ProviderTaskMappingPayload {
  readonly acknowledgedTaskIds: readonly string[];
  readonly legacySubmissionBarrier: boolean;
  readonly mappings: readonly ProviderTaskMappingRecord[];
  readonly submissionReservations: readonly string[];
  readonly version: 1 | 2 | 3 | 4 | 5 | 6;
}

export function createProviderTaskMappingStore(options: {
  readonly appDataRoot: string;
  readonly fileSystem?: FileSystem;
  readonly secretSupplier: () => Promise<ProviderMappingSecrets>;
}): ProviderTaskMappingStore {
  const fileSystem = options.fileSystem ?? new NodeFileSystem();
  const targetPath = confinedProviderTaskMappingsPath(options.appDataRoot);
  const lockPath = confinedProviderTaskMappingsLockPath(options.appDataRoot);
  let operationTail: Promise<void> = Promise.resolve();

  return {
    updateRunning: (publicTaskId, update, now) => enqueue(async () => withMappingLock(async () => {
      const state = await readMappingsUnlocked();
      const record = state.mappings.get(publicTaskId);
      if (record === undefined || record.state !== 'running'
        || (update.expectedRawTaskId !== undefined && record.rawTaskId !== update.expectedRawTaskId)) return record;
      const updated: ProviderTaskMappingRecord = {
        ...record, updatedAt: now,
        rawTaskId: update.rawTaskId === undefined ? record.rawTaskId : parseNonEmptyString(update.rawTaskId, 'rawTaskId'),
        result: record.result ?? update.result,
      };
      state.mappings.set(publicTaskId, updated);
      await writeMappingsUnlocked(state);
      return updated;
    })),
    attachStoredImageResult: (publicTaskId, result, now) => enqueue(async () => withMappingLock(async () => {
      const state = await readMappingsUnlocked();
      const record = state.mappings.get(publicTaskId);
      if (record === undefined || record.state !== 'running' || record.result !== undefined) return record;
      const updated: ProviderTaskMappingRecord = { ...record, result, updatedAt: now };
      state.mappings.set(publicTaskId, updated);
      await writeMappingsUnlocked(state);
      return updated;
    })),
    ackTerminal: (publicTaskId, status) => enqueue(async () => {
      await withMappingLock(async () => {
        const state = await readMappingsUnlocked();
        const { mappings, acknowledgedTaskIds } = state;
        const record = mappings.get(publicTaskId);
        if (record === undefined) {
          if (state.needsRewrite) await writeMappingsUnlocked(state);
          return;
        }
        if (record.state === 'running' || record.state !== status) {
          throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider terminal ACK status does not match');
        }
        mappings.delete(publicTaskId);
        acknowledgedTaskIds.add(publicTaskId);
        await writeMappingsUnlocked(state);
      });
    }),
    findByHistoryId: (historyId) => enqueue(async () => withMappingLock(async () => {
      const state = await readMappingsUnlocked();
      const { mappings } = state;
      if (state.needsRewrite) await writeMappingsUnlocked(state);
      return [...mappings.values()]
        .filter((record) => record.historyId === historyId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    })),
    gcTerminalTombstones: () => enqueue(async () => {
      await withMappingLock(async () => {
        const state = await readMappingsUnlocked();
        if (state.needsRewrite) await writeMappingsUnlocked(state);
      });
    }),
    get: (publicTaskId) => enqueue(async () => withMappingLock(async () => {
      const state = await readMappingsUnlocked();
      if (state.needsRewrite) await writeMappingsUnlocked(state);
      const { mappings } = state;
      return mappings.get(publicTaskId);
    })),
    markCancelled: (publicTaskId, now) => enqueue(async () => withMappingLock(async () => {
      const state = await readMappingsUnlocked();
      const { mappings } = state;
      const record = mappings.get(publicTaskId);
      if (record === undefined) return undefined;
      if (record.state !== 'running') return record;
      const cancelled: ProviderTaskMappingRecord = {
        ...record,
        state: 'cancelled',
        updatedAt: now,
        terminalAt: now,
      };
      mappings.set(publicTaskId, cancelled);
      await writeMappingsUnlocked(state);
      return cancelled;
    })),
    markTerminal: (publicTaskId, result, now) => enqueue(async () => withMappingLock(async () => {
      const state = await readMappingsUnlocked();
      const { mappings } = state;
      const record = mappings.get(publicTaskId);
      if (record === undefined) return undefined;
      if (record.state !== 'running') return record;
      const terminal: ProviderTaskMappingRecord = {
        ...record,
        state: result.status,
        updatedAt: now,
        terminalAt: now,
        ...(result.status === 'completed' ? { result: result.result } : { error: normalizeProviderBridgeError(result.error) }),
      };
      mappings.set(publicTaskId, terminal);
      await writeMappingsUnlocked(state);
      return terminal;
    })),
    reserveSubmission: (input) => enqueue(async () => withMappingLock(async () => {
      const parsedHistoryId = parseHistoryId(input.historyId);
      const state = await readMappingsUnlocked();
      const { submissionReservations } = state;
      if (state.legacySubmissionBarrier && !input.currentIdentity) {
        if (state.needsRewrite) await writeMappingsUnlocked(state);
        throw createProviderBridgeError(
          'PROVIDER_INVALID_RESPONSE',
          'Legacy generation job identity cannot be submitted; create a new run',
        );
      }
      if (submissionReservations.has(parsedHistoryId)) return false;
      submissionReservations.add(parsedHistoryId);
      await writeMappingsUnlocked(state);
      return true;
    })),
    set: (record) => enqueue(async () => {
      const validated = record.projectBinding === undefined ? record : {
        ...record, projectBinding: parseGenerationProjectBinding(record.projectBinding),
      };
      await withMappingLock(async () => {
        const state = await readMappingsUnlocked();
        const { mappings } = state;
        mappings.set(validated.publicTaskId, validated);
        await writeMappingsUnlocked(state);
      });
    }),
    setIfAbsent: (record) => enqueue(async () => withMappingLock(async () => {
      const validated = record.projectBinding === undefined ? record : {
        ...record, projectBinding: parseGenerationProjectBinding(record.projectBinding),
      };
      const state = await readMappingsUnlocked();
      if (state.acknowledgedTaskIds.has(validated.publicTaskId)) {
        throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider task was already acknowledged');
      }
      const existing = state.mappings.get(validated.publicTaskId);
      if (existing !== undefined) return existing;
      state.mappings.set(validated.publicTaskId, validated);
      await writeMappingsUnlocked(state);
      return validated;
    })),
  };

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = operationTail.then(operation, operation);
    operationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async function withMappingLock<T>(operation: () => Promise<T>): Promise<T> {
    await fileSystem.mkdir(options.appDataRoot, { recursive: true });
    const lock = await acquireConfinedFileLock(lockPath, {
      fileSystem,
      assertPathForRead: (path) => assertConfinedAppDataPathForRead(
        fileSystem,
        options.appDataRoot,
        path,
        'PROVIDER_UNAVAILABLE',
        'Provider task mapping path is invalid',
      ),
      assertPathForWrite: (path) => assertConfinedAppDataPathForWrite(
        fileSystem,
        options.appDataRoot,
        path,
        'PROVIDER_UNAVAILABLE',
        'Provider task mapping path is invalid',
      ),
      timeoutMessage: 'Timed out waiting for provider task mapping lock',
    });
    try {
      return await operation();
    } finally {
      await releaseConfinedFileLock(lock);
    }
  }

  async function readMappingsUnlocked(): Promise<{
    acknowledgedTaskIds: Set<string>;
    legacySubmissionBarrier: boolean;
    mappings: Map<string, ProviderTaskMappingRecord>;
    needsRewrite: boolean;
    submissionReservations: Set<string>;
  }> {
    try {
      await assertConfinedProviderTaskPathForRead(fileSystem, options.appDataRoot, targetPath);
      const serialized = await fileSystem.readFile(targetPath, 'utf8');
      const envelope = parseTaskMappingEnvelope(JSON.parse(serialized) as unknown);
      const decrypted = await decryptWithMappingSecrets(envelope, await options.secretSupplier());
      const parsed = parseTaskMappingPayload(JSON.parse(decrypted.plaintext) as unknown);
      return {
        acknowledgedTaskIds: new Set(parsed.acknowledgedTaskIds),
        legacySubmissionBarrier: parsed.legacySubmissionBarrier,
        mappings: new Map(parsed.mappings.map((record) => [record.publicTaskId, record])),
        needsRewrite: decrypted.usedFallback || parsed.version !== 6 || parsed.repairedLegacyTerminalError,
        submissionReservations: new Set(parsed.submissionReservations),
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        return {
          acknowledgedTaskIds: new Set(),
          legacySubmissionBarrier: false,
          mappings: new Map(),
          needsRewrite: false,
          submissionReservations: new Set(),
        };
      }
      if (isProviderBridgeError(error)) {
        throw error;
      }
      throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Provider task mapping is unavailable');
    }
  }

  async function writeMappingsUnlocked(state: {
    readonly acknowledgedTaskIds: ReadonlySet<string>;
    readonly legacySubmissionBarrier: boolean;
    readonly mappings: ReadonlyMap<string, ProviderTaskMappingRecord>;
    readonly submissionReservations: ReadonlySet<string>;
  }): Promise<void> {
    await fileSystem.mkdir(options.appDataRoot, { recursive: true });
    await assertConfinedProviderTaskPathForWrite(fileSystem, options.appDataRoot, targetPath);
    const secret = await options.secretSupplier();
    const envelope = await encryptSerializedPayload(JSON.stringify({
      version: 6,
      acknowledgedTaskIds: [...state.acknowledgedTaskIds].sort(),
      legacySubmissionBarrier: state.legacySubmissionBarrier,
      mappings: [...state.mappings.values()],
      submissionReservations: [...state.submissionReservations].sort(),
    }), secret.primary);
    try {
      await writeConfinedAtomicUpdate(fileSystem, {
        appDataRoot: options.appDataRoot,
        targetPath,
        data: `${JSON.stringify(envelope)}\n`,
        assertPathForRead: () => assertConfinedProviderTaskPathForRead(fileSystem, options.appDataRoot, targetPath),
        assertPathForWrite: () => assertConfinedProviderTaskPathForWrite(fileSystem, options.appDataRoot, targetPath),
        errorCode: 'PROVIDER_UNAVAILABLE',
        errorMessage: 'Provider task mapping path is invalid',
      });
    } catch (error) {
      if (isProviderBridgeError(error)) throw error;
      throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Provider task mapping path is invalid');
    }
  }
}

function parseTaskMappingEnvelope(value: unknown): ProviderTaskMappingEnvelope {
  if (
    !isPlainRecord(value)
    || value.version !== 1
    || typeof value.saltHex !== 'string'
    || typeof value.ivHex !== 'string'
    || typeof value.authTagHex !== 'string'
    || typeof value.ciphertextHex !== 'string'
  ) {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Provider task mapping is unavailable');
  }
  return {
    version: 1,
    saltHex: value.saltHex,
    ivHex: value.ivHex,
    authTagHex: value.authTagHex,
    ciphertextHex: value.ciphertextHex,
  };
}

function parseTaskMappingPayload(value: unknown): ProviderTaskMappingPayload & { readonly repairedLegacyTerminalError: boolean } {
  const record = expectStrictRecord(value, [
    'version',
    'acknowledgedTaskIds',
    'legacySubmissionBarrier',
    'mappings',
    'submissionReservations',
  ]);
  if (
    (
      record.version !== 1
      && record.version !== 2
      && record.version !== 3
      && record.version !== 4
      && record.version !== 5
      && record.version !== 6
    )
    || !Array.isArray(record.mappings)
    || ((record.version === 4 || record.version === 5 || record.version === 6) && !Array.isArray(record.submissionReservations))
    || (record.version < 4 && record.submissionReservations !== undefined)
    || (record.version >= 5 && typeof record.legacySubmissionBarrier !== 'boolean')
    || (record.version < 5 && record.legacySubmissionBarrier !== undefined)
    || (record.version === 6 && !Array.isArray(record.acknowledgedTaskIds))
    || (record.version < 6 && record.acknowledgedTaskIds !== undefined)
  ) {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Provider task mapping is unavailable');
  }
  let repairedLegacyTerminalError = false;
  const mappings = record.mappings.map((entry) => {
    const item = expectStrictRecord(entry, [
      'provider',
      'publicTaskId',
      'rawTaskId',
      'kind',
      'sessionId',
      'historyId',
      'projectBinding',
      'state',
      'createdAt',
      'updatedAt',
      'terminalAt',
      'result',
      'error',
    ]);
    const state = item.state === undefined ? 'running' : parseMappingState(item.state);
    const provider = parseProvider(item.provider);
    const createdAt = item.createdAt === undefined ? new Date(0).toISOString() : parseIsoTimestamp(item.createdAt, 'createdAt');
    const updatedAt = item.updatedAt === undefined ? createdAt : parseIsoTimestamp(item.updatedAt, 'updatedAt');
    const terminalAt = item.terminalAt === undefined ? undefined : parseIsoTimestamp(item.terminalAt, 'terminalAt');
    const missingLegacyErrorMessage = (record.version === 4 || record.version === 5 || record.version === 6)
      && state === 'failed'
      && terminalAt !== undefined
      && isPlainRecord(item.error)
      && !Object.prototype.hasOwnProperty.call(item.error, 'message');
    if (missingLegacyErrorMessage) repairedLegacyTerminalError = true;
    return {
      provider,
      publicTaskId: parseNonEmptyString(item.publicTaskId, 'publicTaskId'),
      rawTaskId: parseNonEmptyString(item.rawTaskId, 'rawTaskId'),
      kind: item.kind === 'video' ? 'video' as const : 'image' as const,
      ...(item.sessionId === undefined ? {} : { sessionId: parseNonEmptyString(item.sessionId, 'sessionId') }),
      ...(item.historyId === undefined ? {} : {
        historyId: provider === 'relayme'
          ? parseNonEmptyString(item.historyId, 'historyId')
          : parseHistoryId(item.historyId),
      }),
      ...(item.projectBinding === undefined ? {} : { projectBinding: parseGenerationProjectBinding(item.projectBinding) }),
      state,
      createdAt,
      updatedAt,
      ...(terminalAt === undefined ? {} : { terminalAt }),
      ...(item.result === undefined ? {} : { result: validateProviderJobResult(item.result, item.kind === 'video' ? 'video' : 'image') }),
      ...(item.error === undefined ? {} : { error: validateProviderError(item.error, missingLegacyErrorMessage) }),
    };
  });
  const submissionReservations = record.version >= 4
    ? (record.submissionReservations as unknown[]).map(parseHistoryId)
    : mappings.flatMap((mapping) => mapping.historyId === undefined ? [] : [mapping.historyId]);
  if (new Set(submissionReservations).size !== submissionReservations.length) {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Provider task mapping is unavailable');
  }
  const acknowledgedTaskIds = record.version === 6
    ? (record.acknowledgedTaskIds as unknown[]).map((value) => parseNonEmptyString(value, 'acknowledgedTaskId'))
    : [];
  if (new Set(acknowledgedTaskIds).size !== acknowledgedTaskIds.length) {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Provider task mapping is unavailable');
  }
  return {
    version: record.version,
    repairedLegacyTerminalError,
    legacySubmissionBarrier: record.version < 5
      ? true
      : record.legacySubmissionBarrier as boolean,
    mappings,
    submissionReservations,
    acknowledgedTaskIds,
  };
}

function parseHistoryId(value: unknown): string {
  const historyId = parseNonEmptyString(value, 'historyId');
  if (!/^history_[a-f0-9]{48}$/u.test(historyId)) {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Provider task mapping is unavailable');
  }
  return historyId;
}

function parseMappingState(value: unknown): ProviderTaskMappingState {
  if (value === 'running' || value === 'completed' || value === 'failed' || value === 'cancelled') {
    return value;
  }
  throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Provider task mapping is unavailable');
}

function parseIsoTimestamp(value: unknown, fieldName: string): string {
  const timestamp = parseNonEmptyString(value, fieldName);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Provider task mapping is unavailable');
  }
  return timestamp;
}

async function encryptSerializedPayload(value: string, secret: string): Promise<ProviderTaskMappingEnvelope> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(secret, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    version: 1,
    saltHex: salt.toString('hex'),
    ivHex: iv.toString('hex'),
    authTagHex: authTag.toString('hex'),
    ciphertextHex: ciphertext.toString('hex'),
  };
}

async function decryptWithMappingSecrets(
  envelope: ProviderTaskMappingEnvelope,
  secrets: ProviderMappingSecrets,
): Promise<{ plaintext: string; usedFallback: boolean }> {
  try {
    return { plaintext: await decryptSerializedPayload(envelope, secrets.primary), usedFallback: false };
  } catch {
    for (const fallback of secrets.fallback) {
      try {
        return { plaintext: await decryptSerializedPayload(envelope, fallback), usedFallback: true };
      } catch {
        // Try the next protected legacy mapping key.
      }
    }
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Provider task mapping is unavailable');
  }
}

async function decryptSerializedPayload(envelope: ProviderTaskMappingEnvelope, secret: string): Promise<string> {
  const key = await deriveKey(secret, Buffer.from(envelope.saltHex, 'hex'));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(envelope.authTagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertextHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<Buffer> {
  return await scrypt(passphrase, salt, 32) as Buffer;
}

function validateProviderError(value: unknown, allowLegacyMissingMessage = false): ProviderBridgeError {
  const record = expectStrictRecord(value, ['code', 'message', 'retryable']);
  if (!isProviderBridgeErrorCode(record.code) || typeof record.retryable !== 'boolean') {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Provider task mapping is unavailable');
  }
  return normalizeProviderBridgeError({
    code: record.code,
    message: allowLegacyMissingMessage && record.message === undefined
      ? 'Provider task failed'
      : parseNonEmptyString(record.message, 'message'),
    retryable: record.retryable,
  });
}

function validateProviderJobResult(value: unknown, kind: 'image' | 'video'): ProviderImageJobResult | ProviderVideoJobResult {
  const record = expectStrictRecord(value, ['assetId', 'assetIds', 'width', 'height', 'durationSeconds']);
  return {
    assetId: parseNonEmptyString(record.assetId, 'assetId'),
    ...(record.assetIds === undefined ? {} : { assetIds: parseAssetIds(record.assetIds) }),
    ...(record.width === undefined ? {} : { width: parseFiniteNumber(record.width, 'width') }),
    ...(record.height === undefined ? {} : { height: parseFiniteNumber(record.height, 'height') }),
    ...(kind === 'video' && record.durationSeconds !== undefined ? { durationSeconds: parseFiniteNumber(record.durationSeconds, 'durationSeconds') } : {}),
  };
}

function parseAssetIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Provider task mapping is unavailable');
  }
  return value.map((item) => parseNonEmptyString(item, 'assetIds'));
}

function parseProvider(value: unknown): ProviderBridgeProvider {
  const parsed = ProviderIdSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Provider task mapping is unavailable');
}

function expectStrictRecord(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Provider task mapping is unavailable');
  }
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Provider task mapping is unavailable');
    }
  }
  return value;
}

function parseNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  throw createProviderBridgeError('INVALID_REQUEST', `${fieldName} must be a non-empty string`);
}

function parseFiniteNumber(value: unknown, fieldName: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', `${fieldName} must be a finite number`);
}

function isProviderBridgeError(error: unknown): error is { readonly code: string; readonly message: string; readonly retryable: boolean } {
  return isRecord(error)
    && typeof error.code === 'string'
    && typeof error.message === 'string'
    && typeof error.retryable === 'boolean';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
