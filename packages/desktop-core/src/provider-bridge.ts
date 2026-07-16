import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import {
  ComflyClient,
  mergeComflyModelRegistries,
  type ComflyFetch,
  type ComflyModelRegistration,
} from '@agent-canvas/provider-comfly';

import { NodeFileSystem, type FileSystem, writeAtomic } from './file-system.js';
import { acquireConfinedFileLock, releaseConfinedFileLock } from './confined-file-lock.js';
import {
  PROVIDER_BRIDGE_CHANNELS,
  createProviderBridgeError,
  isProviderBridgeErrorCode,
  normalizeProviderBridgeError,
  type AckImageJobTerminalBridgeRequest,
  type AckImageJobTerminalBridgeResult,
  type CancelImageJobBridgeRequest,
  type CancelImageJobBridgeResult,
  type ConfigureProviderBridgeRequest,
  type ProviderBridgeBlockedReason,
  type PollImageJobBridgeRequest,
  type PollImageJobBridgeResult,
  type ProviderBridgeCapability,
  type ProviderBridgeError,
  type ProviderBridgeException,
  type ProviderBridgeProfile,
  type ProviderConfigurationStatus,
  type ProviderImageJobResult,
  type SubmitImageJobBridgeRequest,
  type SubmitImageJobBridgeResult,
  type UnlockProviderBridgeRequest,
} from './provider-contracts.js';

export type { ComflyFetch } from '@agent-canvas/provider-comfly';
export {
  PROVIDER_BRIDGE_CHANNELS,
  createProviderBridgeError,
  normalizeProviderBridgeError,
};
export type {
  AckImageJobTerminalBridgeRequest,
  AckImageJobTerminalBridgeResult,
  CancelImageJobBridgeRequest,
  CancelImageJobBridgeResult,
  ConfigureProviderBridgeRequest,
  PollImageJobBridgeRequest,
  PollImageJobBridgeResult,
  ProviderBridgeBlockedReason,
  ProviderBridgeChannel,
  ProviderBridgeCapability,
  ProviderBridgeError,
  ProviderBridgeErrorCode,
  ProviderBridgeException,
  ProviderBridgeProfile,
  ProviderConfigurationStatus,
  ProviderImageJobResult,
  SubmitImageJobBridgeRequest,
  SubmitImageJobBridgeResult,
  UnlockProviderBridgeRequest,
} from './provider-contracts.js';

const scrypt = promisify(scryptCallback);
const CREDENTIALS_FILE = 'provider-credentials.json';
const TASK_MAPPINGS_FILE = 'provider-task-mappings.json';
const CREDENTIALS_LOCK_FILE = `${CREDENTIALS_FILE}.lock`;
const TASK_MAPPINGS_LOCK_FILE = `${TASK_MAPPINGS_FILE}.lock`;
const DEFAULT_COMFLY_BASE_URL = 'https://api.comfly.chat';
const DEFAULT_TERMINAL_TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const DEFAULT_PROVIDER_PROFILES: ProviderBridgeProfile[] = [];

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Uint8Array;
  decryptString(value: Uint8Array): string;
}

export interface ProviderCredentialStore {
  configure(request: { token: string; passphrase?: string }): Promise<void>;
  unlock(request: { passphrase: string }): Promise<void>;
  getStatus(): Promise<ProviderConfigurationStatus>;
  getToken(): Promise<string>;
  getMappingKey(): Promise<string>;
}

export interface ProviderService {
  getStatus(): Promise<ProviderConfigurationStatus>;
  configure(request: ConfigureProviderBridgeRequest): Promise<ProviderConfigurationStatus>;
  unlock(request: UnlockProviderBridgeRequest): Promise<ProviderConfigurationStatus>;
  listProfiles(): Promise<ProviderBridgeProfile[]>;
  submitImageJob(request: SubmitImageJobBridgeRequest): Promise<SubmitImageJobBridgeResult>;
  pollImageJob(request: PollImageJobBridgeRequest): Promise<PollImageJobBridgeResult>;
  cancelImageJob(request: CancelImageJobBridgeRequest): Promise<CancelImageJobBridgeResult>;
  ackImageJobTerminal(request: AckImageJobTerminalBridgeRequest): Promise<AckImageJobTerminalBridgeResult>;
}

export interface ProviderBridgeHandlers {
  getStatus(event: unknown, request: unknown): Promise<ProviderConfigurationStatus>;
  configure(event: unknown, request: unknown): Promise<ProviderConfigurationStatus>;
  unlock(event: unknown, request: unknown): Promise<ProviderConfigurationStatus>;
  listProfiles(event: unknown, request: unknown): Promise<ProviderBridgeProfile[]>;
  submitImageJob(event: unknown, request: unknown): Promise<SubmitImageJobBridgeResult>;
  pollImageJob(event: unknown, request: unknown): Promise<PollImageJobBridgeResult>;
  cancelImageJob(event: unknown, request: unknown): Promise<CancelImageJobBridgeResult>;
  ackImageJobTerminal(event: unknown, request: unknown): Promise<AckImageJobTerminalBridgeResult>;
}

export interface ProviderIpcMainLike {
  handle(channel: string, listener: (event: unknown, request: unknown) => Promise<unknown>): void;
}

type ProviderCredentialEnvelope =
  | {
    readonly version: 1 | 2;
    readonly kind: 'safeStorage';
    readonly ciphertextHex: string;
  }
  | {
    readonly version: 1 | 2;
    readonly kind: 'passphrase';
    readonly kdf: 'scrypt';
    readonly saltHex: string;
    readonly ivHex: string;
    readonly authTagHex: string;
    readonly ciphertextHex: string;
  };

interface ProviderCredentialPayload {
  readonly token: string;
  readonly mappingKey: string;
}

interface ProviderTaskMappingEnvelope {
  readonly version: 1;
  readonly saltHex: string;
  readonly ivHex: string;
  readonly authTagHex: string;
  readonly ciphertextHex: string;
}

interface ProviderTaskMappingRecord {
  readonly provider: 'comfly';
  readonly publicTaskId: string;
  readonly rawTaskId: string;
  readonly state: 'running' | 'completed' | 'failed' | 'cancelled';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalAt?: string;
  readonly result?: ProviderImageJobResult;
  readonly error?: ProviderBridgeError;
}

interface ProviderTaskMappingStore {
  ackTerminal(publicTaskId: string, status: ProviderTaskMappingRecord['state']): Promise<void>;
  gcTerminalTombstones(expireBeforeMs: number): Promise<void>;
  get(publicTaskId: string): Promise<ProviderTaskMappingRecord | undefined>;
  markCancelled(publicTaskId: string, now: string): Promise<void>;
  markTerminal(publicTaskId: string, result: Extract<PollImageJobBridgeResult, { status: 'completed' | 'failed' }>, now: string): Promise<void>;
  set(record: ProviderTaskMappingRecord): Promise<void>;
}

export function parseProviderBridgeRequest(channel: string, request: unknown): unknown {
  switch (channel) {
    case PROVIDER_BRIDGE_CHANNELS.getStatus:
    case PROVIDER_BRIDGE_CHANNELS.listProfiles:
      expectNoPayload(request);
      return undefined;
    case PROVIDER_BRIDGE_CHANNELS.configure:
      return validateConfigureRequest(request);
    case PROVIDER_BRIDGE_CHANNELS.unlock:
      return validateUnlockRequest(request);
    case PROVIDER_BRIDGE_CHANNELS.submitImageJob:
      return validateSubmitImageJobRequest(request);
    case PROVIDER_BRIDGE_CHANNELS.pollImageJob:
      return validatePollImageJobRequest(request);
    case PROVIDER_BRIDGE_CHANNELS.cancelImageJob:
      return validateCancelImageJobRequest(request);
    case PROVIDER_BRIDGE_CHANNELS.ackImageJobTerminal:
      return validateAckImageJobTerminalRequest(request);
    default:
      throw createProviderBridgeError('INVALID_REQUEST', 'Unknown provider channel');
  }
}

export function createSecureProviderCredentialStore(options: {
  readonly appDataRoot: string;
  readonly fileSystem?: FileSystem;
  readonly safeStorage?: SafeStorageAdapter;
}): ProviderCredentialStore {
  const fileSystem = options.fileSystem ?? new NodeFileSystem();
  const safeStorage = options.safeStorage;
  const targetPath = confinedCredentialsPath(options.appDataRoot);
  const lockPath = confinedCredentialsLockPath(options.appDataRoot);
  let unlockedCredentials: ProviderCredentialPayload | null = null;
  let operationTail: Promise<void> = Promise.resolve();

  return {
    async configure(request) {
      await enqueueCredentialOperation(async () => {
        const token = parseSecretString(request.token, 'token');
        await withCredentialLock(async () => {
          const existing = await readEnvelopeUnlocked();
          const existingPayload = await readExistingCredentialPayloadForRotation(existing, request.passphrase);
          const nextPayload = {
            token,
            mappingKey: existingPayload?.mappingKey ?? createMappingKey(),
          };
          await writeEnvelopeUnlocked(await encryptCredentialPayload(nextPayload, request.passphrase));
          unlockedCredentials = nextPayload;
        });
      });
    },
    async unlock(request) {
      await enqueueCredentialOperation(async () => {
        await withCredentialLock(async () => {
          const envelope = await readEnvelopeUnlocked();
          if (envelope === null) {
            throw createProviderBridgeError('CREDENTIALS_LOCKED', 'Provider credentials are not configured');
          }
          const decoded = await decryptCredentialEnvelope(envelope, request.passphrase);
          unlockedCredentials = decoded.payload;
          if (decoded.needsMigration) {
            await writeEnvelopeUnlocked(await encryptCredentialPayload(decoded.payload, request.passphrase));
          }
        });
      });
    },
    async getStatus() {
      return enqueueCredentialOperation(async () => withCredentialLock(async () => {
        const envelope = await readEnvelopeUnlocked();
        if (envelope === null) {
          return {
            configured: false,
            locked: true,
            encryption: safeStorage?.isEncryptionAvailable() === true ? 'safeStorage' : 'unavailable',
          };
        }
        return {
          configured: true,
          locked: unlockedCredentials === null,
          encryption: envelope.kind === 'safeStorage' ? 'safeStorage' : 'passphrase',
        };
      }));
    },
    async getToken() {
      return (await getUnlockedCredentials()).token;
    },
    async getMappingKey() {
      return (await getUnlockedCredentials()).mappingKey;
    },
  };

  function enqueueCredentialOperation<T>(operation: () => Promise<T>): Promise<T> {
    const run = operationTail.then(operation, operation);
    operationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async function getUnlockedCredentials(): Promise<ProviderCredentialPayload> {
    if (unlockedCredentials !== null) return unlockedCredentials;
    await enqueueCredentialOperation(async () => {
      if (unlockedCredentials !== null) return;
      await withCredentialLock(async () => {
        const envelope = await readEnvelopeUnlocked();
        if (envelope?.kind !== 'safeStorage' || safeStorage?.isEncryptionAvailable() !== true) {
          throw createProviderBridgeError('CREDENTIALS_LOCKED', 'Provider credentials are locked', true);
        }
        const decoded = await decryptCredentialEnvelope(envelope, '');
        unlockedCredentials = decoded.payload;
        if (decoded.needsMigration) {
          await writeEnvelopeUnlocked(await encryptCredentialPayload(decoded.payload, ''));
        }
      });
    });
    if (unlockedCredentials !== null) return unlockedCredentials;
    throw createProviderBridgeError('CREDENTIALS_LOCKED', 'Provider credentials are locked', true);
  }

  async function readExistingCredentialPayloadForRotation(
    envelope: ProviderCredentialEnvelope | null,
    passphrase: string | undefined,
  ): Promise<ProviderCredentialPayload | null> {
    if (envelope === null) return null;
    if (unlockedCredentials !== null && envelope.kind === 'passphrase' && passphrase === undefined) {
      return unlockedCredentials;
    }
    const decoded = await decryptCredentialEnvelope(envelope, passphrase ?? '');
    if (decoded.needsMigration) {
      await writeEnvelopeUnlocked(await encryptCredentialPayload(decoded.payload, passphrase));
    }
    return decoded.payload;
  }

  async function readEnvelopeUnlocked(): Promise<ProviderCredentialEnvelope | null> {
    try {
      await assertConfinedCredentialPathForRead();
      return parseCredentialEnvelope(JSON.parse(await fileSystem.readFile(targetPath, 'utf8')) as unknown);
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw createProviderBridgeError('CREDENTIALS_LOCKED', 'Provider credential metadata is unavailable');
    }
  }

  async function writeEnvelopeUnlocked(envelope: ProviderCredentialEnvelope): Promise<void> {
    await fileSystem.mkdir(options.appDataRoot, { recursive: true });
    await assertConfinedCredentialPathForWrite();
    await writeAtomic(fileSystem, targetPath, `${JSON.stringify(envelope)}\n`);
  }

  async function withCredentialLock<T>(operation: () => Promise<T>): Promise<T> {
    await fileSystem.mkdir(options.appDataRoot, { recursive: true });
    const lock = await acquireConfinedFileLock(lockPath, {
      fileSystem,
      assertPathForRead: (path) => assertConfinedAppDataPathForRead(
        fileSystem,
        options.appDataRoot,
        path,
        'CREDENTIALS_LOCKED',
        'Provider credential metadata path is invalid',
      ),
      assertPathForWrite: (path) => assertConfinedAppDataPathForWrite(
        fileSystem,
        options.appDataRoot,
        path,
        'CREDENTIALS_LOCKED',
        'Provider credential metadata path is invalid',
      ),
      timeoutMessage: 'Timed out waiting for provider credential lock',
    });
    try {
      return await operation();
    } finally {
      await releaseConfinedFileLock(lock);
    }
  }

  async function encryptCredentialPayload(
    payload: ProviderCredentialPayload,
    passphrase: string | undefined,
  ): Promise<ProviderCredentialEnvelope> {
    const serialized = JSON.stringify({ schemaVersion: 2, ...payload });
    if (safeStorage?.isEncryptionAvailable() === true) {
      return {
        version: 2,
        kind: 'safeStorage',
        ciphertextHex: Buffer.from(safeStorage.encryptString(serialized)).toString('hex'),
      };
    }
    if (passphrase === undefined || passphrase.length === 0) {
      throw createProviderBridgeError(
        'CREDENTIALS_LOCKED',
        'Provider credentials require system encryption or a passphrase',
      );
    }
    return encryptWithPassphrase(serialized, passphrase);
  }

  async function decryptCredentialEnvelope(
    envelope: ProviderCredentialEnvelope,
    passphrase: string,
  ): Promise<{ payload: ProviderCredentialPayload; needsMigration: boolean }> {
    try {
      const plaintext = envelope.kind === 'safeStorage'
        ? decryptSafeStorageEnvelope(envelope)
        : await decryptWithPassphrase(envelope, passphrase);
      return parseCredentialPayload(plaintext, envelope.version);
    } catch (error) {
      if (isProviderBridgeError(error)) throw error;
      throw createProviderBridgeError('CREDENTIALS_LOCKED', 'Provider credentials are locked', true);
    }
  }

  function decryptSafeStorageEnvelope(envelope: Extract<ProviderCredentialEnvelope, { kind: 'safeStorage' }>): string {
    if (safeStorage?.isEncryptionAvailable() !== true) {
      throw createProviderBridgeError('CREDENTIALS_LOCKED', 'Provider credentials are locked', true);
    }
    return safeStorage.decryptString(Buffer.from(envelope.ciphertextHex, 'hex'));
  }

  async function assertConfinedCredentialPathForWrite(): Promise<void> {
    await assertConfinedAppDataPathForWrite(
      fileSystem,
      options.appDataRoot,
      targetPath,
      'CREDENTIALS_LOCKED',
      'Provider credential metadata path is invalid',
    );
  }

  async function assertConfinedCredentialPathForRead(): Promise<void> {
    await assertConfinedAppDataPathForRead(
      fileSystem,
      options.appDataRoot,
      targetPath,
      'CREDENTIALS_LOCKED',
      'Provider credential metadata path is invalid',
    );
  }
}

export function createComflyProviderService(options: {
  readonly appDataRoot: string;
  readonly credentialStore: ProviderCredentialStore;
  readonly fetch: ComflyFetch;
  readonly fileSystem?: FileSystem;
  readonly profiles?: readonly ProviderBridgeProfile[];
  readonly providerModels?: readonly ProviderBridgeProfile[];
  readonly baseUrl?: string;
  readonly now?: () => number;
  readonly terminalTombstoneTtlMs?: number;
  readonly timeoutMs?: number;
}): ProviderService {
  const fileSystem = options.fileSystem ?? new NodeFileSystem();
  let profiles = sanitizeProfiles(options.profiles ?? DEFAULT_PROVIDER_PROFILES);
  let baseUrl = options.baseUrl ?? DEFAULT_COMFLY_BASE_URL;
  let serviceTail: Promise<void> = Promise.resolve();
  const nowMs = options.now ?? Date.now;
  const terminalTombstoneTtlMs = options.terminalTombstoneTtlMs ?? DEFAULT_TERMINAL_TOMBSTONE_TTL_MS;
  const providerTaskMappings = createProviderTaskMappingStore({
    appDataRoot: options.appDataRoot,
    fileSystem,
    secretSupplier: () => options.credentialStore.getMappingKey(),
  });

  const getClient = () => new ComflyClient({
    baseUrl,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
    tokenSupplier: () => options.credentialStore.getToken(),
  });

  return {
    getStatus() {
      return enqueueServiceOperation(() => options.credentialStore.getStatus());
    },
    configure(request) {
      return enqueueServiceOperation(async () => {
        const validated = validateConfigureRequest(request);
        const nextProfiles = validated.profiles === undefined ? undefined : validateConfiguredProfiles(validated.profiles);
        await options.credentialStore.configure({ token: validated.token, passphrase: validated.passphrase });
        if (validated.baseUrl !== undefined) baseUrl = validated.baseUrl;
        if (nextProfiles !== undefined) profiles = nextProfiles;
        await gcTerminalTombstones();
        return options.credentialStore.getStatus();
      });
    },
    async unlock(request) {
      return enqueueServiceOperation(async () => {
        const validated = validateUnlockRequest(request);
        await options.credentialStore.unlock(validated);
        await gcTerminalTombstones();
        return options.credentialStore.getStatus();
      });
    },
    async listProfiles() {
      return enqueueServiceOperation(async () => {
        await gcTerminalTombstones();
        return sanitizeProfiles(mergeComflyModelRegistries({
          providerModels: options.providerModels ?? [],
          profileModels: profiles,
        }));
      });
    },
    async submitImageJob(request) {
      return enqueueServiceOperation(async () => {
        await gcTerminalTombstones();
        const validated = validateSubmitImageJobRequest(request);
        const profile = selectProfile(profiles, validated.provider, validated.modelRoute);
        const response = await translateProviderCall(() => getClient().generateImage({
          model: profile.modelId ?? profile.modelRoute,
          prompt: validated.prompt,
          async: true,
        }));
        const parsed = parseImageTaskResponse(response);
        const publicTaskId = createPublicProviderTaskId();
        const timestamp = nowIso();
        await providerTaskMappings.set({
          provider: 'comfly',
          publicTaskId,
          rawTaskId: parsed.taskId,
          state: 'running',
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        return { providerTaskId: publicTaskId };
      });
    },
    async pollImageJob(request) {
      return enqueueServiceOperation(async () => {
        await gcTerminalTombstones();
        const validated = validatePollImageJobRequest(request);
        assertSupportedProvider(validated.provider);
        let task: ProviderTaskMappingRecord | undefined;
        try {
          task = await providerTaskMappings.get(validated.providerTaskId);
        } catch (error) {
          if (isCredentialsLocked(error)) return blockedCredentialsPollResult();
          throw error;
        }
        if (task === undefined || task.provider !== validated.provider) {
          throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider job handle is unavailable');
        }
        if (task.state !== 'running') {
          return terminalMappingToPollResult(task);
        }
        let response: unknown;
        try {
          response = await translateProviderCall(
            () => getClient().getImageTask(task.rawTaskId),
            { publicTaskId: validated.providerTaskId, rawTaskId: task.rawTaskId, request: 'poll' },
          );
        } catch (error) {
          if (isCredentialsLocked(error)) return blockedCredentialsPollResult();
          throw error;
        }
        const result = mapImageTaskPollResult(validated.provider, validated.providerTaskId, task.rawTaskId, response);
        if (result.status === 'completed' || result.status === 'failed') {
          await providerTaskMappings.markTerminal(validated.providerTaskId, result, nowIso());
        }
        return result;
      });
    },
    async cancelImageJob(request) {
      return enqueueServiceOperation(async () => {
        await gcTerminalTombstones();
        const validated = validateCancelImageJobRequest(request);
        assertSupportedProvider(validated.provider);
        await providerTaskMappings.markCancelled(validated.providerTaskId, nowIso());
        return { status: 'local-only', remoteCancelled: false, reason: 'unsupported' };
      });
    },
    async ackImageJobTerminal(request) {
      return enqueueServiceOperation(async () => {
        const validated = validateAckImageJobTerminalRequest(request);
        assertSupportedProvider(validated.provider);
        await providerTaskMappings.ackTerminal(validated.providerTaskId, validated.status);
        return { acknowledged: true };
      });
    },
  };

  function enqueueServiceOperation<T>(operation: () => Promise<T>): Promise<T> {
    const run = serviceTail.then(operation, operation);
    serviceTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async function gcTerminalTombstones(): Promise<void> {
    try {
      await providerTaskMappings.gcTerminalTombstones(nowMs() - terminalTombstoneTtlMs);
    } catch (error) {
      if (!isCredentialsLocked(error)) throw error;
    }
  }

  function nowIso(): string {
    return new Date(nowMs()).toISOString();
  }
}

export function createProviderBridgeHandlers(service: ProviderService): ProviderBridgeHandlers {
  return {
    getStatus: async (_event, request) => {
      parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.getStatus, request);
      return validateProviderConfigurationStatus(await service.getStatus());
    },
    configure: async (_event, request) => validateProviderConfigurationStatus(await service.configure(
      parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.configure, request) as ConfigureProviderBridgeRequest,
    )),
    unlock: async (_event, request) => validateProviderConfigurationStatus(await service.unlock(
      parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.unlock, request) as UnlockProviderBridgeRequest,
    )),
    listProfiles: async (_event, request) => {
      parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.listProfiles, request);
      return validateProviderProfiles(await service.listProfiles());
    },
    submitImageJob: async (_event, request) => validateSubmitImageJobResult(await service.submitImageJob(
      parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.submitImageJob, request) as SubmitImageJobBridgeRequest,
    )),
    pollImageJob: async (_event, request) => validatePollImageJobResult(await service.pollImageJob(
      parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.pollImageJob, request) as PollImageJobBridgeRequest,
    )),
    cancelImageJob: async (_event, request) => validateCancelImageJobResult(await service.cancelImageJob(
      parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.cancelImageJob, request) as CancelImageJobBridgeRequest,
    )),
    ackImageJobTerminal: async (_event, request) => validateAckImageJobTerminalResult(await service.ackImageJobTerminal(
      parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.ackImageJobTerminal, request) as AckImageJobTerminalBridgeRequest,
    )),
  };
}

export function registerProviderBridgeHandlers(
  ipcMain: ProviderIpcMainLike,
  handlers: ProviderBridgeHandlers,
): void {
  ipcMain.handle(PROVIDER_BRIDGE_CHANNELS.getStatus, handlers.getStatus);
  ipcMain.handle(PROVIDER_BRIDGE_CHANNELS.configure, handlers.configure);
  ipcMain.handle(PROVIDER_BRIDGE_CHANNELS.unlock, handlers.unlock);
  ipcMain.handle(PROVIDER_BRIDGE_CHANNELS.listProfiles, handlers.listProfiles);
  ipcMain.handle(PROVIDER_BRIDGE_CHANNELS.submitImageJob, handlers.submitImageJob);
  ipcMain.handle(PROVIDER_BRIDGE_CHANNELS.pollImageJob, handlers.pollImageJob);
  ipcMain.handle(PROVIDER_BRIDGE_CHANNELS.cancelImageJob, handlers.cancelImageJob);
  ipcMain.handle(PROVIDER_BRIDGE_CHANNELS.ackImageJobTerminal, handlers.ackImageJobTerminal);
}

async function translateProviderCall<T>(
  call: () => Promise<T>,
  context?: { readonly publicTaskId: string; readonly rawTaskId: string; readonly request: 'poll' },
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (isProviderBridgeError(error)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error ?? 'Provider request failed');
    if (/invalid comfly response/i.test(message)) {
      throw createProviderBridgeError(
        'PROVIDER_INVALID_RESPONSE',
        context === undefined ? 'Provider returned an invalid response' : 'Provider returned an invalid image task response',
      );
    }
    if (context !== undefined && /request failed with status/i.test(message)) {
      throw createProviderBridgeError('PROVIDER_ERROR', 'Provider image task request failed', /network|fetch/i.test(message));
    }
    if (context !== undefined && /timed out|timeout/i.test(message)) {
      throw createProviderBridgeError('PROVIDER_ERROR', 'Provider image task request timed out', true);
    }
    if (context !== undefined) {
      throw createProviderBridgeError('PROVIDER_ERROR', 'Provider image task request failed', /network|fetch/i.test(message));
    }
    throw createProviderBridgeError('PROVIDER_ERROR', message, /timed out|timeout|network|fetch/i.test(message));
  }
}

function validateConfigureRequest(value: unknown): ConfigureProviderBridgeRequest {
  const record = expectStrictRecord(value, ['token', 'passphrase', 'baseUrl', 'profiles']);
  const request: ConfigureProviderBridgeRequest = {
    token: parseSecretString(record.token, 'token'),
    ...(record.passphrase === undefined ? {} : { passphrase: parseSecretString(record.passphrase, 'passphrase') }),
    ...(record.baseUrl === undefined ? {} : { baseUrl: parseNonEmptyString(record.baseUrl, 'baseUrl') }),
    ...(record.profiles === undefined ? {} : { profiles: parseProfiles(record.profiles) }),
  };
  assertPublicProviderPayload({ ...request, token: '[redacted]', passphrase: request.passphrase === undefined ? undefined : '[redacted]' });
  return request;
}

function validateUnlockRequest(value: unknown): UnlockProviderBridgeRequest {
  const record = expectStrictRecord(value, ['passphrase']);
  return { passphrase: parseSecretString(record.passphrase, 'passphrase') };
}

function validateSubmitImageJobRequest(value: unknown): SubmitImageJobBridgeRequest {
  const record = expectStrictRecord(value, [
    'jobId',
    'provider',
    'modelRoute',
    'prompt',
    'conversationId',
    'referenceAssetIds',
  ]);
  const request = {
    jobId: parseNonEmptyString(record.jobId, 'jobId'),
    provider: parseProvider(record.provider),
    modelRoute: parseNonEmptyString(record.modelRoute, 'modelRoute'),
    prompt: parseNonEmptyString(record.prompt, 'prompt'),
    conversationId: parseNonEmptyString(record.conversationId, 'conversationId'),
    referenceAssetIds: parseStringArray(record.referenceAssetIds, 'referenceAssetIds'),
  };
  assertPublicProviderPayload(request);
  return request;
}

function validatePollImageJobRequest(value: unknown): PollImageJobBridgeRequest {
  const record = expectStrictRecord(value, ['provider', 'providerTaskId']);
  const request = {
    provider: parseProvider(record.provider),
    providerTaskId: parseNonEmptyString(record.providerTaskId, 'providerTaskId'),
  };
  assertPublicProviderPayload(request);
  return request;
}

function validateCancelImageJobRequest(value: unknown): CancelImageJobBridgeRequest {
  return validatePollImageJobRequest(value);
}

function validateAckImageJobTerminalRequest(value: unknown): AckImageJobTerminalBridgeRequest {
  const record = expectStrictRecord(value, ['provider', 'providerTaskId', 'status']);
  const status = parseNonEmptyString(record.status, 'status');
  if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') {
    throw createProviderBridgeError('INVALID_REQUEST', 'status must be a terminal provider job state');
  }
  const request = {
    provider: parseProvider(record.provider),
    providerTaskId: parseNonEmptyString(record.providerTaskId, 'providerTaskId'),
    status: status as AckImageJobTerminalBridgeRequest['status'],
  };
  assertPublicProviderPayload(request);
  return request;
}

function expectNoPayload(value: unknown): void {
  if (value === undefined) return;
  const record = expectStrictRecord(value, []);
  if (Object.keys(record).length > 0) {
    throw createProviderBridgeError('INVALID_REQUEST', 'Request contains unknown key');
  }
}

function expectStrictRecord(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw createProviderBridgeError('INVALID_REQUEST', 'Request payload must be an object');
  }
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw createProviderBridgeError('INVALID_REQUEST', 'Request contains unknown key');
    }
  }
  return value;
}

function parseProfiles(value: unknown): ProviderBridgeProfile[] {
  if (!Array.isArray(value)) {
    throw createProviderBridgeError('INVALID_REQUEST', 'profiles must be an array');
  }
  return validateConfiguredProfiles(value.map((item) => {
    const record = expectStrictRecord(item, ['provider', 'modelRoute', 'displayName', 'modelId', 'capabilities']);
    return {
      provider: parseProvider(record.provider),
      modelRoute: parseNonEmptyString(record.modelRoute, 'modelRoute'),
      displayName: parseNonEmptyString(record.displayName, 'displayName'),
      ...(record.modelId === undefined ? {} : { modelId: parseNonEmptyString(record.modelId, 'modelId') }),
      capabilities: parseCapabilities(record.capabilities),
    };
  }));
}

function parseCapabilities(value: unknown): ProviderBridgeCapability[] {
  if (!Array.isArray(value)) {
    throw createProviderBridgeError('INVALID_REQUEST', 'capabilities must be an array');
  }
  const allowed = new Set<ProviderBridgeCapability>([
    'chat',
    'vision',
    'image_generation',
    'image_edit',
    'responses',
    'gemini_native',
    'async_tasks',
  ]);
  return value.map((item) => {
    if (typeof item !== 'string' || !allowed.has(item as ProviderBridgeCapability)) {
      throw createProviderBridgeError('INVALID_REQUEST', 'capabilities contains an unsupported value');
    }
    return item as ProviderBridgeCapability;
  });
}

function parseProvider(value: unknown): 'comfly' {
  const provider = parseNonEmptyString(value, 'provider');
  assertSupportedProvider(provider);
  return provider;
}

function validateConfiguredProfiles(value: readonly ProviderBridgeProfile[]): ProviderBridgeProfile[] {
  return value.map((profile) => {
    const sanitized = {
      provider: parseProvider(profile.provider),
      modelRoute: parseNonEmptyString(profile.modelRoute, 'modelRoute'),
      displayName: parseNonEmptyString(profile.displayName, 'displayName'),
      ...(profile.modelId === undefined ? {} : { modelId: parseNonEmptyString(profile.modelId, 'modelId') }),
      capabilities: parseCapabilities(profile.capabilities),
    };
    assertPublicProviderPayload(sanitized);
    return sanitized;
  });
}

function sanitizeProfiles(value: readonly ComflyModelRegistration[]): ProviderBridgeProfile[] {
  return value.flatMap((profile) => {
    if (profile.provider !== 'comfly') return [];
    const sanitized = {
      provider: parseProvider(profile.provider),
      modelRoute: parseNonEmptyString(profile.modelRoute, 'modelRoute'),
      displayName: parseNonEmptyString(profile.displayName, 'displayName'),
      ...(profile.modelId === undefined ? {} : { modelId: parseNonEmptyString(profile.modelId, 'modelId') }),
      capabilities: parseCapabilities(profile.capabilities),
    };
    assertPublicProviderPayload(sanitized);
    return [sanitized];
  });
}

function validateProviderConfigurationStatus(value: unknown): ProviderConfigurationStatus {
  const record = expectStrictRecord(value, ['configured', 'locked', 'encryption']);
  if (typeof record.configured !== 'boolean' || typeof record.locked !== 'boolean') {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid status response');
  }
  if (record.encryption !== 'safeStorage' && record.encryption !== 'passphrase' && record.encryption !== 'unavailable') {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid status response');
  }
  return {
    configured: record.configured,
    locked: record.locked,
    encryption: record.encryption,
  };
}

function validateProviderProfiles(value: unknown): ProviderBridgeProfile[] {
  if (!Array.isArray(value)) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid profile inventory');
  }
  return value.map((profile) => {
    const record = expectStrictRecord(profile, ['provider', 'modelRoute', 'displayName', 'modelId', 'capabilities']);
    if (parseNonEmptyString(record.provider, 'provider') !== 'comfly') {
      throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid profile inventory');
    }
    const sanitized = {
      provider: 'comfly' as const,
      modelRoute: parseNonEmptyString(record.modelRoute, 'modelRoute'),
      displayName: parseNonEmptyString(record.displayName, 'displayName'),
      ...(record.modelId === undefined ? {} : { modelId: parseNonEmptyString(record.modelId, 'modelId') }),
      capabilities: parseCapabilities(record.capabilities),
    };
    assertPublicProviderPayload(sanitized);
    return sanitized;
  });
}

function validateSubmitImageJobResult(value: unknown): SubmitImageJobBridgeResult {
  const record = expectStrictRecord(value, ['providerTaskId']);
  const providerTaskId = parseNonEmptyString(record.providerTaskId, 'providerTaskId');
  if (!providerTaskId.startsWith('provider-job-')) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image job handle');
  }
  assertPublicProviderPayload({ providerTaskId });
  return { providerTaskId };
}

function validatePollImageJobResult(value: unknown): PollImageJobBridgeResult {
  if (!isPlainRecord(value) || typeof value.status !== 'string') {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image job result');
  }
  if (value.status === 'running') {
    const record = expectStrictRecord(value, ['status', 'progress', 'blockedReason']);
    const blockedReason = record.blockedReason === undefined ? undefined : parseBlockedReason(record.blockedReason);
    return {
      status: 'running',
      ...(record.progress === undefined ? {} : { progress: parseProgress(record.progress) }),
      ...(blockedReason === undefined ? {} : { blockedReason }),
    };
  }
  if (value.status === 'failed') {
    const record = expectStrictRecord(value, ['status', 'error']);
    return {
      status: 'failed',
      error: validateProviderError(record.error),
    };
  }
  if (value.status === 'completed') {
    const record = expectStrictRecord(value, ['status', 'progress', 'result']);
    return {
      status: 'completed',
      ...(record.progress === undefined ? {} : { progress: parseProgress(record.progress) }),
      result: validateProviderImageJobResult(record.result),
    };
  }
  throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image job result');
}

function validateCancelImageJobResult(value: unknown): CancelImageJobBridgeResult {
  const record = expectStrictRecord(value, ['status', 'remoteCancelled', 'reason']);
  if (record.status !== 'local-only' || record.remoteCancelled !== false || record.reason !== 'unsupported') {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid cancel result');
  }
  return {
    status: 'local-only',
    remoteCancelled: false,
    reason: 'unsupported',
  };
}

function validateAckImageJobTerminalResult(value: unknown): AckImageJobTerminalBridgeResult {
  const record = expectStrictRecord(value, ['acknowledged']);
  if (record.acknowledged !== true) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid ACK result');
  }
  return { acknowledged: true };
}

function validateProviderError(value: unknown): ProviderBridgeError {
  const record = expectStrictRecord(value, ['code', 'message', 'retryable']);
  if (!isProviderBridgeErrorCode(record.code) || typeof record.retryable !== 'boolean') {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image job error');
  }
  const normalized = normalizeProviderBridgeError({
    code: record.code,
    message: parseNonEmptyString(record.message, 'message'),
    retryable: record.retryable,
  });
  if (containsRawProviderTaskIdentifier(normalized.message)) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image job error');
  }
  return normalized;
}

function validateProviderImageJobResult(value: unknown): ProviderImageJobResult {
  const record = expectStrictRecord(value, ['assetId', 'width', 'height']);
  const assetId = parseNonEmptyString(record.assetId, 'assetId');
  const result = {
    assetId,
    ...(record.width === undefined ? {} : { width: parseFiniteNumber(record.width, 'width') }),
    ...(record.height === undefined ? {} : { height: parseFiniteNumber(record.height, 'height') }),
  };
  assertPublicProviderPayload(result);
  return result;
}

function selectProfile(
  profiles: readonly ProviderBridgeProfile[],
  provider: 'comfly',
  modelRoute: string,
): ProviderBridgeProfile {
  assertSupportedProvider(provider);
  const profile = profiles.find((item) => item.provider === provider && item.modelRoute === modelRoute);
  if (profile === undefined || !profile.capabilities.includes('image_generation')) {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Requested image model profile is unavailable');
  }
  return profile;
}

function assertSupportedProvider(provider: string): asserts provider is 'comfly' {
  if (provider !== 'comfly') {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Provider is unavailable');
  }
}

function parseImageTaskResponse(value: unknown): { taskId: string; status: string; data?: unknown } {
  assertProviderResponsePayload(value);
  if (!isPlainRecord(value) || typeof value.taskId !== 'string' || value.taskId.length === 0 || typeof value.status !== 'string') {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image task response');
  }
  return {
    taskId: value.taskId,
    status: value.status,
    data: value.data,
  };
}

function mapImageTaskPollResult(
  provider: string,
  publicTaskId: string,
  rawTaskId: string,
  value: unknown,
): PollImageJobBridgeResult {
  const task = parseImageTaskResponse(value);
  if (task.taskId !== rawTaskId) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image task response');
  }
  const status = task.status.toLowerCase();
  if (status === 'queued' || status === 'pending' || status === 'running' || status === 'processing') {
    return { status: 'running', progress: undefined };
  }
  if (status === 'failed' || status === 'error') {
    return {
      status: 'failed',
      error: normalizeProviderBridgeError(createProviderBridgeError('PROVIDER_ERROR', 'Provider image task failed', true)),
    };
  }
  if (status !== 'succeeded' && status !== 'completed' && status !== 'success') {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image task status');
  }
  const data = Array.isArray(task.data) ? task.data : [];
  const first = data[0];
  if (!isPlainRecord(first)) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned no image result');
  }
  if (typeof first.b64_json === 'string') {
    throw createProviderBridgeError('PROTECTED_PAYLOAD', 'Provider returned a protected image payload');
  }
  return {
    status: 'completed',
    progress: 1,
    result: {
      assetId: `provider:${provider}:${publicTaskId}:0`,
      ...(first.width === undefined ? {} : { width: parseFiniteNumber(first.width, 'width') }),
      ...(first.height === undefined ? {} : { height: parseFiniteNumber(first.height, 'height') }),
    },
  };
}

function createPublicProviderTaskId(): string {
  return `provider-job-${randomBytes(16).toString('hex')}`;
}

function blockedCredentialsPollResult(): PollImageJobBridgeResult {
  return {
    status: 'running',
    blockedReason: 'credentials_locked',
    progress: undefined,
  };
}

function terminalMappingToPollResult(record: ProviderTaskMappingRecord): PollImageJobBridgeResult {
  if (record.state === 'completed' && record.result !== undefined) {
    return {
      status: 'completed',
      progress: 1,
      result: record.result,
    };
  }
  if (record.state === 'failed' && record.error !== undefined) {
    return {
      status: 'failed',
      error: record.error,
    };
  }
  if (record.state === 'cancelled') {
    return {
      status: 'failed',
      error: normalizeProviderBridgeError(createProviderBridgeError('PROVIDER_ERROR', 'Provider image task cancelled')),
    };
  }
  throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider job handle is unavailable');
}

function createProviderTaskMappingStore(options: {
  readonly appDataRoot: string;
  readonly fileSystem: FileSystem;
  readonly secretSupplier: () => Promise<string>;
}): ProviderTaskMappingStore {
  const targetPath = confinedProviderTaskMappingsPath(options.appDataRoot);
  const lockPath = confinedProviderTaskMappingsLockPath(options.appDataRoot);
  let operationTail: Promise<void> = Promise.resolve();

  return {
    ackTerminal: (publicTaskId, status) => enqueue(async () => {
      await withMappingLock(async () => {
        const mappings = await readMappingsUnlocked();
        const record = mappings.get(publicTaskId);
        if (record === undefined) return;
        if (record.state === status || (status === 'cancelled' && record.state === 'cancelled')) {
          mappings.delete(publicTaskId);
          await writeMappingsUnlocked(mappings);
        }
      });
    }),
    gcTerminalTombstones: (expireBeforeMs) => enqueue(async () => {
      await withMappingLock(async () => {
        const mappings = await readMappingsUnlocked();
        let changed = false;
        for (const [publicTaskId, record] of mappings) {
          if (record.state === 'running' || record.terminalAt === undefined) continue;
          const terminalAt = Date.parse(record.terminalAt);
          if (Number.isFinite(terminalAt) && terminalAt < expireBeforeMs) {
            mappings.delete(publicTaskId);
            changed = true;
          }
        }
        if (changed) await writeMappingsUnlocked(mappings);
      });
    }),
    get: async (publicTaskId) => {
      const mappings = await readMappingsUnlocked();
      return mappings.get(publicTaskId);
    },
    markCancelled: (publicTaskId, now) => enqueue(async () => {
      await withMappingLock(async () => {
        const mappings = await readMappingsUnlocked();
        const record = mappings.get(publicTaskId);
        if (record === undefined) return;
        if (record.state !== 'running') return;
        mappings.set(publicTaskId, {
          ...record,
          state: 'cancelled',
          updatedAt: now,
          terminalAt: now,
        });
        await writeMappingsUnlocked(mappings);
      });
    }),
    markTerminal: (publicTaskId, result, now) => enqueue(async () => {
      await withMappingLock(async () => {
        const mappings = await readMappingsUnlocked();
        const record = mappings.get(publicTaskId);
        if (record === undefined || record.state !== 'running') return;
        mappings.set(publicTaskId, {
          ...record,
          state: result.status,
          updatedAt: now,
          terminalAt: now,
          ...(result.status === 'completed' ? { result: result.result } : { error: result.error }),
        });
        await writeMappingsUnlocked(mappings);
      });
    }),
    set: (record) => enqueue(async () => {
      await withMappingLock(async () => {
        const mappings = await readMappingsUnlocked();
        mappings.set(record.publicTaskId, record);
        await writeMappingsUnlocked(mappings);
      });
    }),
  };

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = operationTail.then(operation, operation);
    operationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async function withMappingLock<T>(operation: () => Promise<T>): Promise<T> {
    await options.fileSystem.mkdir(options.appDataRoot, { recursive: true });
    const lock = await acquireConfinedFileLock(lockPath, {
      fileSystem: options.fileSystem,
      assertPathForRead: (path) => assertConfinedAppDataPathForRead(
        options.fileSystem,
        options.appDataRoot,
        path,
        'PROVIDER_UNAVAILABLE',
        'Provider task mapping path is invalid',
      ),
      assertPathForWrite: (path) => assertConfinedAppDataPathForWrite(
        options.fileSystem,
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

  async function readMappingsUnlocked(): Promise<Map<string, ProviderTaskMappingRecord>> {
    try {
      await assertConfinedProviderTaskPathForRead(options.fileSystem, options.appDataRoot, targetPath);
      const serialized = await options.fileSystem.readFile(targetPath, 'utf8');
      const envelope = parseTaskMappingEnvelope(JSON.parse(serialized) as unknown);
      const secret = await options.secretSupplier();
      const plaintext = await decryptSerializedPayload(envelope, secret);
      const parsed = parseTaskMappingPayload(JSON.parse(plaintext) as unknown);
      return new Map(parsed.map((record) => [record.publicTaskId, record]));
    } catch (error) {
      if (isMissingFileError(error)) {
        return new Map();
      }
      if (isProviderBridgeError(error)) {
        throw error;
      }
      throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Provider task mapping is unavailable');
    }
  }

  async function writeMappingsUnlocked(mappings: Map<string, ProviderTaskMappingRecord>): Promise<void> {
    await options.fileSystem.mkdir(options.appDataRoot, { recursive: true });
    await assertConfinedProviderTaskPathForWrite(options.fileSystem, options.appDataRoot, targetPath);
    const secret = await options.secretSupplier();
    const envelope = await encryptSerializedPayload(JSON.stringify({
      version: 2,
      mappings: [...mappings.values()],
    }), secret);
    await writeAtomic(options.fileSystem, targetPath, `${JSON.stringify(envelope)}\n`);
  }
}

function assertProviderResponsePayload(value: unknown): void {
  for (const text of collectStrings(value)) {
    if (containsProtectedProviderText(text)) {
      throw createProviderBridgeError('PROTECTED_PAYLOAD', 'Provider returned a protected payload');
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

function parseTaskMappingPayload(value: unknown): ProviderTaskMappingRecord[] {
  const record = expectStrictRecord(value, ['version', 'mappings']);
  if ((record.version !== 1 && record.version !== 2) || !Array.isArray(record.mappings)) {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Provider task mapping is unavailable');
  }
  return record.mappings.map((entry) => {
    const item = expectStrictRecord(entry, [
      'provider',
      'publicTaskId',
      'rawTaskId',
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
      state,
      createdAt,
      updatedAt,
      ...(terminalAt === undefined ? {} : { terminalAt }),
      ...(item.result === undefined ? {} : { result: validateProviderImageJobResult(item.result) }),
      ...(item.error === undefined ? {} : { error: validateProviderError(item.error) }),
    };
  });
}

function parseMappingState(value: unknown): ProviderTaskMappingRecord['state'] {
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

function parseCredentialEnvelope(value: unknown): ProviderCredentialEnvelope {
  if (!isPlainRecord(value) || (value.version !== 1 && value.version !== 2)) {
    throw createProviderBridgeError('CREDENTIALS_LOCKED', 'Provider credential metadata is invalid');
  }
  if (value.kind === 'safeStorage' && typeof value.ciphertextHex === 'string') {
    return { version: value.version, kind: 'safeStorage', ciphertextHex: value.ciphertextHex };
  }
  if (
    value.kind === 'passphrase' &&
    value.kdf === 'scrypt' &&
    typeof value.saltHex === 'string' &&
    typeof value.ivHex === 'string' &&
    typeof value.authTagHex === 'string' &&
    typeof value.ciphertextHex === 'string'
  ) {
    return {
      version: value.version,
      kind: 'passphrase',
      kdf: 'scrypt',
      saltHex: value.saltHex,
      ivHex: value.ivHex,
      authTagHex: value.authTagHex,
      ciphertextHex: value.ciphertextHex,
    };
  }
  throw createProviderBridgeError('CREDENTIALS_LOCKED', 'Provider credential metadata is invalid');
}

function parseCredentialPayload(plaintext: string, envelopeVersion: 1 | 2): { payload: ProviderCredentialPayload; needsMigration: boolean } {
  try {
    const value = JSON.parse(plaintext) as unknown;
    if (isPlainRecord(value) && value.schemaVersion === 2) {
      return {
        payload: {
          token: parseSecretString(value.token, 'token'),
          mappingKey: parseSecretString(value.mappingKey, 'mappingKey'),
        },
        needsMigration: envelopeVersion !== 2,
      };
    }
  } catch {
    // Version 1 envelopes stored only the provider token string.
  }
  const legacyToken = parseSecretString(plaintext, 'token');
  return {
    payload: {
      token: legacyToken,
      mappingKey: createMappingKey(),
    },
    needsMigration: true,
  };
}

function createMappingKey(): string {
  return randomBytes(32).toString('hex');
}

async function encryptWithPassphrase(plaintext: string, passphrase: string): Promise<ProviderCredentialEnvelope> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    version: 2,
    kind: 'passphrase',
    kdf: 'scrypt',
    saltHex: salt.toString('hex'),
    ivHex: iv.toString('hex'),
    authTagHex: authTag.toString('hex'),
    ciphertextHex: ciphertext.toString('hex'),
  };
}

async function decryptWithPassphrase(envelope: Extract<ProviderCredentialEnvelope, { kind: 'passphrase' }>, passphrase: string): Promise<string> {
  const key = await deriveKey(passphrase, Buffer.from(envelope.saltHex, 'hex'));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(envelope.authTagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertextHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
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

async function decryptSerializedPayload(envelope: ProviderTaskMappingEnvelope, secret: string): Promise<string> {
  try {
    const key = await deriveKey(secret, Buffer.from(envelope.saltHex, 'hex'));
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(envelope.authTagHex, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertextHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Provider task mapping is unavailable');
  }
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<Buffer> {
  return await scrypt(passphrase, salt, 32) as Buffer;
}

async function rejectSymlinkTarget(
  fileSystem: FileSystem,
  targetPath: string,
  errorCode: 'CREDENTIALS_LOCKED' | 'PROVIDER_UNAVAILABLE',
  errorMessage: string,
): Promise<void> {
  if (fileSystem.lstat === undefined) return;
  try {
    const stat = await fileSystem.lstat(targetPath);
    if (stat.isSymbolicLink?.() === true) {
      throw createProviderBridgeError(errorCode, errorMessage);
    }
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }
}

async function assertConfinedProviderTaskPathForWrite(
  fileSystem: FileSystem,
  appDataRoot: string,
  targetPath: string,
): Promise<void> {
  await assertConfinedAppDataPathForWrite(
    fileSystem,
    appDataRoot,
    targetPath,
    'PROVIDER_UNAVAILABLE',
    'Provider task mapping path is invalid',
  );
}

async function assertConfinedProviderTaskPathForRead(
  fileSystem: FileSystem,
  appDataRoot: string,
  targetPath: string,
): Promise<void> {
  await assertConfinedAppDataPathForRead(
    fileSystem,
    appDataRoot,
    targetPath,
    'PROVIDER_UNAVAILABLE',
    'Provider task mapping path is invalid',
  );
}

async function assertConfinedAppDataPathForWrite(
  fileSystem: FileSystem,
  appDataRoot: string,
  targetPath: string,
  errorCode: 'CREDENTIALS_LOCKED' | 'PROVIDER_UNAVAILABLE',
  errorMessage: string,
): Promise<void> {
  await rejectSymlinkTarget(fileSystem, appDataRoot, errorCode, errorMessage);
  await rejectSymlinkTarget(fileSystem, targetPath, errorCode, errorMessage);
  if (fileSystem.realpath === undefined) return;
  const realRoot = normalizeRealPath(await fileSystem.realpath(resolve(appDataRoot)));
  const realParent = normalizeRealPath(await fileSystem.realpath(dirname(targetPath)));
  if (realParent !== realRoot) {
    throw createProviderBridgeError(errorCode, errorMessage);
  }
}

async function assertConfinedAppDataPathForRead(
  fileSystem: FileSystem,
  appDataRoot: string,
  targetPath: string,
  errorCode: 'CREDENTIALS_LOCKED' | 'PROVIDER_UNAVAILABLE',
  errorMessage: string,
): Promise<void> {
  await rejectSymlinkTarget(fileSystem, appDataRoot, errorCode, errorMessage);
  await rejectSymlinkTarget(fileSystem, targetPath, errorCode, errorMessage);
  if (fileSystem.realpath === undefined) return;
  const realRoot = normalizeRealPath(await fileSystem.realpath(resolve(appDataRoot)));
  try {
    const realTarget = normalizeRealPath(await fileSystem.realpath(targetPath));
    if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${sep}`)) {
      throw createProviderBridgeError(errorCode, errorMessage);
    }
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    const realParent = normalizeRealPath(await fileSystem.realpath(dirname(targetPath)));
    if (realParent !== realRoot) {
      throw createProviderBridgeError(errorCode, errorMessage);
    }
  }
}

function confinedCredentialsPath(appDataRoot: string): string {
  return confinedAppDataPath(appDataRoot, CREDENTIALS_FILE, 'CREDENTIALS_LOCKED', 'Provider credential path is invalid');
}

function confinedCredentialsLockPath(appDataRoot: string): string {
  return confinedAppDataPath(appDataRoot, CREDENTIALS_LOCK_FILE, 'CREDENTIALS_LOCKED', 'Provider credential path is invalid');
}

function confinedProviderTaskMappingsPath(appDataRoot: string): string {
  return confinedAppDataPath(appDataRoot, TASK_MAPPINGS_FILE, 'PROVIDER_UNAVAILABLE', 'Provider task mapping path is invalid');
}

function confinedProviderTaskMappingsLockPath(appDataRoot: string): string {
  return confinedAppDataPath(appDataRoot, TASK_MAPPINGS_LOCK_FILE, 'PROVIDER_UNAVAILABLE', 'Provider task mapping path is invalid');
}

function confinedAppDataPath(
  appDataRoot: string,
  fileName: string,
  errorCode: 'CREDENTIALS_LOCKED' | 'PROVIDER_UNAVAILABLE',
  errorMessage: string,
): string {
  const root = resolve(appDataRoot);
  const target = resolve(root, fileName);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw createProviderBridgeError(errorCode, errorMessage);
  }
  return target;
}

function normalizeRealPath(path: string): string {
  return normalize(resolve(path));
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

function parseProgress(value: unknown): number {
  const progress = parseFiniteNumber(value, 'progress');
  if (progress < 0 || progress > 1) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'progress must be between 0 and 1');
  }
  return progress;
}

function parseBlockedReason(value: unknown): ProviderBridgeBlockedReason {
  if (value === 'credentials_locked') return value;
  throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid blocked reason');
}

function parseSecretString(value: unknown, fieldName: string): string {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  throw createProviderBridgeError('INVALID_REQUEST', `${fieldName} must be a non-empty string`);
}

function parseStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw createProviderBridgeError('INVALID_REQUEST', `${fieldName} must be an array`);
  }
  return value.map((item) => parseNonEmptyString(item, fieldName));
}

function assertPublicProviderPayload(value: unknown): void {
  for (const text of collectStrings(value)) {
    if (containsProtectedProviderText(text)) {
      throw createProviderBridgeError('PROTECTED_PAYLOAD', 'Provider bridge payload contains protected payload');
    }
  }
}

function containsProtectedProviderText(value: string): boolean {
  return /authorization\s*:/iu.test(value)
    || /\bbearer\s+[a-z0-9._~+/=\-]{8,}/iu.test(value)
    || /\b(?:api[_ -]?key|token|secret|password)\s*[:=]\s*\S{4,}/iu.test(value)
    || /\bsk-[a-z0-9_-]{8,}\b/iu.test(value)
    || /data:image\/[a-z0-9.+-]+;base64,/iu.test(value)
    || /base64,[a-z0-9+/=]{16,}/iu.test(value)
    || /[A-Za-z]:\\/u.test(value)
    || /\\\\[^\\\s]+\\/u.test(value)
    || /(?:^|\s)\/(?:Users|home|var|etc|opt|tmp|private)\//u.test(value);
}

function containsRawProviderTaskIdentifier(value: string): boolean {
  return /\braw-[a-z0-9._:-]+\b/iu.test(value)
    || /\/v1\/images\/tasks\//iu.test(value);
}

function sanitizeProviderMessage(value: string): string {
  const sanitized = value
    .replace(/authorization\s*:\s*\S+(?:\s+\S+)?/giu, '[redacted]')
    .replace(/\bbearer\s+[a-z0-9._~+/=\-]+/giu, '[redacted]')
    .replace(/\bsk-[a-z0-9_-]{8,}\b/giu, '[redacted]')
    .replace(/\b(?:api[_ -]?key|token|secret|password)\s*[:=]\s*\S{4,}/giu, '[redacted]')
    .replace(/data:image\/[^;]+;base64,[a-z0-9+/=]+/giu, '[redacted]')
    .replace(/[A-Za-z]:[\\/][^\s"'`]+/gu, '[redacted]')
    .replace(/\\\\[^\\\s]+\\[^\s"'`]+/gu, '[redacted]')
    .replace(/(?:^|\s)\/(?:Users|home|var|opt|tmp|private)\/[^\s"'`]+/gu, ' [redacted]')
    .replace(/\s+/gu, ' ')
    .trim();
  return (sanitized || 'Provider request failed').slice(0, 180);
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (isRecord(value)) return Object.values(value).flatMap(collectStrings);
  return [];
}

function isProviderBridgeError(error: unknown): error is ProviderBridgeException {
  return isRecord(error)
    && typeof error.code === 'string'
    && typeof error.message === 'string'
    && typeof error.retryable === 'boolean';
}

function isCredentialsLocked(error: unknown): boolean {
  return isProviderBridgeError(error) && error.code === 'CREDENTIALS_LOCKED';
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
