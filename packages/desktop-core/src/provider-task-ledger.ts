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
  type PollImageJobBridgeResult,
  type ProviderBridgeError,
  type ProviderImageJobResult,
  type ProviderImageJobTerminalStatus,
} from './provider-contracts.js';
import type { ProviderMappingSecrets } from './provider-credential-vault.js';

const scrypt = promisify(scryptCallback);

export type ProviderTaskMappingState = 'running' | ProviderImageJobTerminalStatus;

export interface ProviderTaskMappingRecord {
  readonly provider: 'comfly';
  readonly publicTaskId: string;
  readonly rawTaskId: string;
  readonly historyId?: string;
  readonly state: ProviderTaskMappingState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalAt?: string;
  readonly result?: ProviderImageJobResult;
  readonly error?: ProviderBridgeError;
}

export interface ProviderTaskMappingStore {
  ackTerminal(publicTaskId: string, status: ProviderImageJobTerminalStatus): Promise<void>;
  findByHistoryId(historyId: string): Promise<ProviderTaskMappingRecord | undefined>;
  gcTerminalTombstones(expireBeforeMs: number): Promise<void>;
  get(publicTaskId: string): Promise<ProviderTaskMappingRecord | undefined>;
  markCancelled(publicTaskId: string, now: string): Promise<ProviderTaskMappingRecord | undefined>;
  markTerminal(
    publicTaskId: string,
    result: Extract<PollImageJobBridgeResult, { status: 'completed' | 'failed' }>,
    now: string,
  ): Promise<ProviderTaskMappingRecord | undefined>;
  reserveSubmission(input: {
    readonly currentIdentity: boolean;
    readonly historyId: string;
  }): Promise<boolean>;
  set(record: ProviderTaskMappingRecord): Promise<void>;
}

interface ProviderTaskMappingEnvelope {
  readonly version: 1;
  readonly saltHex: string;
  readonly ivHex: string;
  readonly authTagHex: string;
  readonly ciphertextHex: string;
}

interface ProviderTaskMappingPayload {
  readonly legacySubmissionBarrier: boolean;
  readonly mappings: readonly ProviderTaskMappingRecord[];
  readonly submissionReservations: readonly string[];
  readonly version: 1 | 2 | 3 | 4 | 5;
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
    ackTerminal: (publicTaskId, status) => enqueue(async () => {
      await withMappingLock(async () => {
        const state = await readMappingsUnlocked();
        const { mappings, submissionReservations } = state;
        const record = mappings.get(publicTaskId);
        if (record === undefined) {
          if (state.needsRewrite) await writeMappingsUnlocked(state);
          return;
        }
        if (record.state === 'running' || record.state !== status) {
          throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider terminal ACK status does not match');
        }
        mappings.delete(publicTaskId);
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
        ...(result.status === 'completed' ? { result: result.result } : { error: result.error }),
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
      await withMappingLock(async () => {
        const state = await readMappingsUnlocked();
        const { mappings } = state;
        mappings.set(record.publicTaskId, record);
        await writeMappingsUnlocked(state);
      });
    }),
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
        legacySubmissionBarrier: parsed.legacySubmissionBarrier,
        mappings: new Map(parsed.mappings.map((record) => [record.publicTaskId, record])),
        needsRewrite: decrypted.usedFallback || parsed.version !== 5,
        submissionReservations: new Set(parsed.submissionReservations),
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        return {
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
    readonly legacySubmissionBarrier: boolean;
    readonly mappings: ReadonlyMap<string, ProviderTaskMappingRecord>;
    readonly submissionReservations: ReadonlySet<string>;
  }): Promise<void> {
    await fileSystem.mkdir(options.appDataRoot, { recursive: true });
    await assertConfinedProviderTaskPathForWrite(fileSystem, options.appDataRoot, targetPath);
    const secret = await options.secretSupplier();
    const envelope = await encryptSerializedPayload(JSON.stringify({
      version: 5,
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

function parseTaskMappingPayload(value: unknown): ProviderTaskMappingPayload {
  const record = expectStrictRecord(value, [
    'version',
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
    )
    || !Array.isArray(record.mappings)
    || ((record.version === 4 || record.version === 5) && !Array.isArray(record.submissionReservations))
    || (record.version < 4 && record.submissionReservations !== undefined)
    || (record.version === 5 && typeof record.legacySubmissionBarrier !== 'boolean')
    || (record.version !== 5 && record.legacySubmissionBarrier !== undefined)
  ) {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Provider task mapping is unavailable');
  }
  const mappings = record.mappings.map((entry) => {
    const item = expectStrictRecord(entry, [
      'provider',
      'publicTaskId',
      'rawTaskId',
      'historyId',
      'state',
      'createdAt',
      'updatedAt',
      'terminalAt',
      'result',
      'error',
    ]);
    const state = item.state === undefined ? 'running' : parseMappingState(item.state);
    const createdAt = item.createdAt === undefined ? new Date(0).toISOString() : parseIsoTimestamp(item.createdAt, 'createdAt');
    const updatedAt = item.updatedAt === undefined ? createdAt : parseIsoTimestamp(item.updatedAt, 'updatedAt');
    const terminalAt = item.terminalAt === undefined ? undefined : parseIsoTimestamp(item.terminalAt, 'terminalAt');
    return {
      provider: parseProvider(item.provider),
      publicTaskId: parseNonEmptyString(item.publicTaskId, 'publicTaskId'),
      rawTaskId: parseNonEmptyString(item.rawTaskId, 'rawTaskId'),
      ...(item.historyId === undefined ? {} : { historyId: parseHistoryId(item.historyId) }),
      state,
      createdAt,
      updatedAt,
      ...(terminalAt === undefined ? {} : { terminalAt }),
      ...(item.result === undefined ? {} : { result: validateProviderImageJobResult(item.result) }),
      ...(item.error === undefined ? {} : { error: validateProviderError(item.error) }),
    };
  });
  const submissionReservations = record.version >= 4
    ? (record.submissionReservations as unknown[]).map(parseHistoryId)
    : mappings.flatMap((mapping) => mapping.historyId === undefined ? [] : [mapping.historyId]);
  if (new Set(submissionReservations).size !== submissionReservations.length) {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Provider task mapping is unavailable');
  }
  return {
    version: record.version,
    legacySubmissionBarrier: record.version < 5
      ? true
      : record.legacySubmissionBarrier as boolean,
    mappings,
    submissionReservations,
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

function validateProviderError(value: unknown): ProviderBridgeError {
  const record = expectStrictRecord(value, ['code', 'message', 'retryable']);
  if (!isProviderBridgeErrorCode(record.code) || typeof record.retryable !== 'boolean') {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Provider task mapping is unavailable');
  }
  return normalizeProviderBridgeError({
    code: record.code,
    message: parseNonEmptyString(record.message, 'message'),
    retryable: record.retryable,
  });
}

function validateProviderImageJobResult(value: unknown): ProviderImageJobResult {
  const record = expectStrictRecord(value, ['assetId', 'width', 'height']);
  return {
    assetId: parseNonEmptyString(record.assetId, 'assetId'),
    ...(record.width === undefined ? {} : { width: parseFiniteNumber(record.width, 'width') }),
    ...(record.height === undefined ? {} : { height: parseFiniteNumber(record.height, 'height') }),
  };
}

function parseProvider(value: unknown): 'comfly' {
  if (value === 'comfly') return value;
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
