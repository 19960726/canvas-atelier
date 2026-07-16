import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { isIP } from 'node:net';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import {
  ComflyClient,
  mergeComflyModelRegistries,
  type ComflyFetch,
  type ComflyModelRegistration,
} from '@agent-canvas/provider-comfly';

import { NodeFileSystem, type FileSystem, writeAtomic } from './file-system.js';
import {
  PROVIDER_BRIDGE_CHANNELS,
  createProviderBridgeError,
  normalizeProviderBridgeError,
  type CancelImageJobBridgeRequest,
  type CancelImageJobBridgeResult,
  type ConfigureProviderBridgeRequest,
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
  CancelImageJobBridgeRequest,
  CancelImageJobBridgeResult,
  ConfigureProviderBridgeRequest,
  PollImageJobBridgeRequest,
  PollImageJobBridgeResult,
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
const DEFAULT_COMFLY_BASE_URL = 'https://api.comfly.chat';

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
}

export interface ProviderService {
  getStatus(): Promise<ProviderConfigurationStatus>;
  configure(request: ConfigureProviderBridgeRequest): Promise<ProviderConfigurationStatus>;
  unlock(request: UnlockProviderBridgeRequest): Promise<ProviderConfigurationStatus>;
  listProfiles(): Promise<ProviderBridgeProfile[]>;
  submitImageJob(request: SubmitImageJobBridgeRequest): Promise<SubmitImageJobBridgeResult>;
  pollImageJob(request: PollImageJobBridgeRequest): Promise<PollImageJobBridgeResult>;
  cancelImageJob(request: CancelImageJobBridgeRequest): Promise<CancelImageJobBridgeResult>;
}

export interface ProviderBridgeHandlers {
  getStatus(event: unknown, request: unknown): Promise<ProviderConfigurationStatus>;
  configure(event: unknown, request: unknown): Promise<ProviderConfigurationStatus>;
  unlock(event: unknown, request: unknown): Promise<ProviderConfigurationStatus>;
  listProfiles(event: unknown, request: unknown): Promise<ProviderBridgeProfile[]>;
  submitImageJob(event: unknown, request: unknown): Promise<SubmitImageJobBridgeResult>;
  pollImageJob(event: unknown, request: unknown): Promise<PollImageJobBridgeResult>;
  cancelImageJob(event: unknown, request: unknown): Promise<CancelImageJobBridgeResult>;
}

export interface ProviderIpcMainLike {
  handle(channel: string, listener: (event: unknown, request: unknown) => Promise<unknown>): void;
}

type ProviderCredentialEnvelope =
  | {
    readonly version: 1;
    readonly kind: 'safeStorage';
    readonly ciphertextHex: string;
  }
  | {
    readonly version: 1;
    readonly kind: 'passphrase';
    readonly kdf: 'scrypt';
    readonly saltHex: string;
    readonly ivHex: string;
    readonly authTagHex: string;
    readonly ciphertextHex: string;
  };

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
}

interface ProviderTaskMappingStore {
  clear(): Promise<void>;
  delete(publicTaskId: string): Promise<void>;
  get(publicTaskId: string): Promise<ProviderTaskMappingRecord | undefined>;
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
  let unlockedToken: string | null = null;
  let operationTail: Promise<void> = Promise.resolve();

  return {
    async configure(request) {
      await enqueueCredentialOperation(async () => {
        const token = parseSecretString(request.token, 'token');
        if (safeStorage?.isEncryptionAvailable() === true) {
          await writeEnvelope({
            version: 1,
            kind: 'safeStorage',
            ciphertextHex: Buffer.from(safeStorage.encryptString(token)).toString('hex'),
          });
          unlockedToken = token;
          return;
        }
        if (request.passphrase === undefined || request.passphrase.length === 0) {
          throw createProviderBridgeError(
            'CREDENTIALS_LOCKED',
            'Provider credentials require system encryption or a passphrase',
          );
        }
        await writeEnvelope(await encryptWithPassphrase(token, request.passphrase));
        unlockedToken = token;
      });
    },
    async unlock(request) {
      await enqueueCredentialOperation(async () => {
        const envelope = await readEnvelope();
        if (envelope === null) {
          throw createProviderBridgeError('CREDENTIALS_LOCKED', 'Provider credentials are not configured');
        }
        try {
          if (envelope.kind === 'safeStorage') {
            if (safeStorage?.isEncryptionAvailable() !== true) {
              throw new Error('System encryption is unavailable');
            }
            unlockedToken = safeStorage.decryptString(Buffer.from(envelope.ciphertextHex, 'hex'));
            return;
          }
          unlockedToken = await decryptWithPassphrase(envelope, request.passphrase);
        } catch {
          throw createProviderBridgeError('CREDENTIALS_LOCKED', 'Provider credentials are locked');
        }
      });
    },
    async getStatus() {
      const envelope = await readEnvelope();
      if (envelope === null) {
        return {
          configured: false,
          locked: true,
          encryption: safeStorage?.isEncryptionAvailable() === true ? 'safeStorage' : 'unavailable',
        };
      }
      return {
        configured: true,
        locked: unlockedToken === null,
        encryption: envelope.kind === 'safeStorage' ? 'safeStorage' : 'passphrase',
      };
    },
    async getToken() {
      if (unlockedToken !== null) {
        return unlockedToken;
      }
      const status = await this.getStatus();
      if (status.configured && status.encryption === 'safeStorage') {
        await this.unlock({ passphrase: '' });
        if (unlockedToken !== null) return unlockedToken;
      }
      throw createProviderBridgeError('CREDENTIALS_LOCKED', 'Provider credentials are locked');
    },
  };

  function enqueueCredentialOperation<T>(operation: () => Promise<T>): Promise<T> {
    const run = operationTail.then(operation, operation);
    operationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async function readEnvelope(): Promise<ProviderCredentialEnvelope | null> {
    try {
      await assertConfinedCredentialPathForRead();
      return parseCredentialEnvelope(JSON.parse(await fileSystem.readFile(targetPath, 'utf8')) as unknown);
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw createProviderBridgeError('CREDENTIALS_LOCKED', 'Provider credential metadata is unavailable');
    }
  }

  async function writeEnvelope(envelope: ProviderCredentialEnvelope): Promise<void> {
    await fileSystem.mkdir(options.appDataRoot, { recursive: true });
    await assertConfinedCredentialPathForWrite();
    await writeAtomic(fileSystem, targetPath, `${JSON.stringify(envelope)}\n`);
  }

  async function assertConfinedCredentialPathForWrite(): Promise<void> {
    await rejectSymlinkTarget(fileSystem, options.appDataRoot);
    await rejectSymlinkTarget(fileSystem, targetPath);
    if (fileSystem.realpath === undefined) return;
    const realRoot = normalizeRealPath(await fileSystem.realpath(resolve(options.appDataRoot)));
    const realParent = normalizeRealPath(await fileSystem.realpath(dirname(targetPath)));
    if (realParent !== realRoot) {
      throw createProviderBridgeError('CREDENTIALS_LOCKED', 'Provider credential metadata path is invalid');
    }
  }

  async function assertConfinedCredentialPathForRead(): Promise<void> {
    await rejectSymlinkTarget(fileSystem, options.appDataRoot);
    await rejectSymlinkTarget(fileSystem, targetPath);
    if (fileSystem.realpath === undefined) return;
    const realRoot = normalizeRealPath(await fileSystem.realpath(resolve(options.appDataRoot)));
    const realTarget = normalizeRealPath(await fileSystem.realpath(targetPath));
    if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${sep}`)) {
      throw createProviderBridgeError('CREDENTIALS_LOCKED', 'Provider credential metadata path is invalid');
    }
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
  readonly timeoutMs?: number;
}): ProviderService {
  const fileSystem = options.fileSystem ?? new NodeFileSystem();
  let profiles = sanitizeProfiles(options.profiles ?? DEFAULT_PROVIDER_PROFILES);
  let baseUrl = options.baseUrl ?? DEFAULT_COMFLY_BASE_URL;
  let configureTail: Promise<void> = Promise.resolve();
  const providerTaskMappings = createProviderTaskMappingStore({
    appDataRoot: options.appDataRoot,
    fileSystem,
    secretSupplier: () => options.credentialStore.getToken(),
  });

  const getClient = () => new ComflyClient({
    baseUrl,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
    tokenSupplier: () => options.credentialStore.getToken(),
  });

  return {
    getStatus() {
      return options.credentialStore.getStatus();
    },
    configure(request) {
      return enqueueConfigure(async () => {
        const validated = validateConfigureRequest(request);
        await options.credentialStore.configure({ token: validated.token, passphrase: validated.passphrase });
        await providerTaskMappings.clear();
        if (validated.baseUrl !== undefined) baseUrl = validated.baseUrl;
        if (validated.profiles !== undefined) profiles = validateConfiguredProfiles(validated.profiles);
        return options.credentialStore.getStatus();
      });
    },
    async unlock(request) {
      const validated = validateUnlockRequest(request);
      await options.credentialStore.unlock(validated);
      return options.credentialStore.getStatus();
    },
    async listProfiles() {
      return sanitizeProfiles(mergeComflyModelRegistries({
        providerModels: options.providerModels ?? [],
        profileModels: profiles,
      }));
    },
    async submitImageJob(request) {
      const validated = validateSubmitImageJobRequest(request);
      const profile = selectProfile(profiles, validated.provider, validated.modelRoute);
      const response = await translateProviderCall(() => getClient().generateImage({
        model: profile.modelId ?? profile.modelRoute,
        prompt: validated.prompt,
        async: true,
      }));
      const parsed = parseImageTaskResponse(response);
      const publicTaskId = createPublicProviderTaskId();
      await providerTaskMappings.set({
        provider: 'comfly',
        publicTaskId,
        rawTaskId: parsed.taskId,
      });
      return { providerTaskId: publicTaskId };
    },
    async pollImageJob(request) {
      const validated = validatePollImageJobRequest(request);
      assertSupportedProvider(validated.provider);
      const task = await resolveProviderTask(providerTaskMappings, validated);
      const response = await translateProviderCall(
        () => getClient().getImageTask(task.rawTaskId),
        { publicTaskId: validated.providerTaskId, rawTaskId: task.rawTaskId, request: 'poll' },
      );
      const result = mapImageTaskPollResult(validated.provider, validated.providerTaskId, task.rawTaskId, response);
      if (result.status === 'completed' || result.status === 'failed') {
        await providerTaskMappings.delete(validated.providerTaskId);
      }
      return result;
    },
    async cancelImageJob(request) {
      const validated = validateCancelImageJobRequest(request);
      assertSupportedProvider(validated.provider);
      await providerTaskMappings.delete(validated.providerTaskId);
      return { status: 'local-only', remoteCancelled: false, reason: 'unsupported' };
    },
  };

  function enqueueConfigure<T>(operation: () => Promise<T>): Promise<T> {
    const run = configureTail.then(operation, operation);
    configureTail = run.then(() => undefined, () => undefined);
    return run;
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
    const record = expectStrictRecord(value, ['status', 'progress']);
    if (record.progress !== undefined && typeof record.progress !== 'number') {
      throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image job result');
    }
    return {
      status: 'running',
      ...(record.progress === undefined ? {} : { progress: record.progress }),
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
    if (record.progress !== undefined && typeof record.progress !== 'number') {
      throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image job result');
    }
    return {
      status: 'completed',
      ...(record.progress === undefined ? {} : { progress: record.progress }),
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

function validateProviderError(value: unknown): ProviderBridgeError {
  const record = expectStrictRecord(value, ['code', 'message', 'retryable']);
  if (typeof record.code !== 'string' || typeof record.retryable !== 'boolean') {
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
  const record = expectStrictRecord(value, ['assetId', 'url', 'width', 'height']);
  const assetId = parseNonEmptyString(record.assetId, 'assetId');
  const result = {
    assetId,
    ...(record.url === undefined ? {} : { url: parseSafeResultUrl(record.url) }),
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
  const url = first.url === undefined ? undefined : parseSafeResultUrl(first.url);
  return {
    status: 'completed',
    progress: 1,
    result: {
      assetId: `provider:${provider}:${publicTaskId}:0`,
      ...(url === undefined ? {} : { url }),
      ...(typeof first.width === 'number' ? { width: first.width } : {}),
      ...(typeof first.height === 'number' ? { height: first.height } : {}),
    },
  };
}

function parseSafeResultUrl(value: unknown): string {
  const url = parseNonEmptyString(value, 'url');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw createProviderBridgeError('PROTECTED_PAYLOAD', 'Provider returned an unsafe result URL');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username.length > 0
    || parsed.password.length > 0
    || containsProtectedProviderText(url)
    || isPrivateResultHost(parsed.hostname)
  ) {
    throw createProviderBridgeError('PROTECTED_PAYLOAD', 'Provider returned an unsafe result URL');
  }
  return parsed.toString();
}

function createPublicProviderTaskId(): string {
  return `provider-job-${randomBytes(16).toString('hex')}`;
}

async function resolveProviderTask(
  providerTasks: ProviderTaskMappingStore,
  request: PollImageJobBridgeRequest,
): Promise<{ provider: 'comfly'; rawTaskId: string }> {
  const task = await providerTasks.get(request.providerTaskId);
  if (task === undefined || task.provider !== request.provider) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider job handle is unavailable');
  }
  return task;
}

function createProviderTaskMappingStore(options: {
  readonly appDataRoot: string;
  readonly fileSystem: FileSystem;
  readonly secretSupplier: () => Promise<string>;
}): ProviderTaskMappingStore {
  const targetPath = confinedProviderTaskMappingsPath(options.appDataRoot);
  let cache: Map<string, ProviderTaskMappingRecord> | null = null;
  let operationTail: Promise<void> = Promise.resolve();

  return {
    clear: () => enqueue(async () => {
      const mappings = await readMappings();
      mappings.clear();
      await writeMappings(mappings);
    }),
    delete: (publicTaskId) => enqueue(async () => {
      const mappings = await readMappings();
      mappings.delete(publicTaskId);
      await writeMappings(mappings);
    }),
    get: async (publicTaskId) => {
      const mappings = await readMappings();
      return mappings.get(publicTaskId);
    },
    set: (record) => enqueue(async () => {
      const mappings = await readMappings();
      mappings.set(record.publicTaskId, record);
      await writeMappings(mappings);
    }),
  };

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = operationTail.then(operation, operation);
    operationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async function readMappings(): Promise<Map<string, ProviderTaskMappingRecord>> {
    if (cache !== null) return cache;
    try {
      await assertConfinedProviderTaskPathForRead(options.fileSystem, options.appDataRoot, targetPath);
      const serialized = await options.fileSystem.readFile(targetPath, 'utf8');
      const envelope = parseTaskMappingEnvelope(JSON.parse(serialized) as unknown);
      const secret = await options.secretSupplier();
      const plaintext = await decryptSerializedPayload(envelope, secret);
      const parsed = parseTaskMappingPayload(JSON.parse(plaintext) as unknown);
      cache = new Map(parsed.map((record) => [record.publicTaskId, record]));
      return cache;
    } catch (error) {
      if (isMissingFileError(error)) {
        cache = new Map();
        return cache;
      }
      if (isProviderBridgeError(error)) {
        throw error;
      }
      throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Provider task mapping is unavailable');
    }
  }

  async function writeMappings(mappings: Map<string, ProviderTaskMappingRecord>): Promise<void> {
    await options.fileSystem.mkdir(options.appDataRoot, { recursive: true });
    await assertConfinedProviderTaskPathForWrite(options.fileSystem, options.appDataRoot, targetPath);
    const secret = await options.secretSupplier();
    const envelope = await encryptSerializedPayload(JSON.stringify({
      version: 1,
      mappings: [...mappings.values()],
    }), secret);
    await writeAtomic(options.fileSystem, targetPath, `${JSON.stringify(envelope)}\n`);
    cache = new Map(mappings);
  }
}

function assertProviderResponsePayload(value: unknown): void {
  for (const text of collectStrings(value)) {
    if (containsProtectedProviderText(text)) {
      throw createProviderBridgeError('PROTECTED_PAYLOAD', 'Provider returned a protected payload');
    }
  }
}

function isPrivateResultHost(hostname: string): boolean {
  const host = hostname.replace(/^\[/u, '').replace(/\]$/u, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const ipVersion = isIP(host);
  if (ipVersion === 4) return isPrivateIpv4(host);
  if (ipVersion === 6) return isPrivateIpv6(host);
  return false;
}

function isPrivateIpv4(host: string): boolean {
  const octets = host.split('.').map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [first, second] = octets as [number, number, number, number];
  return first === 10
    || first === 127
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 169 && second === 254)
    || first === 0;
}

function isPrivateIpv6(host: string): boolean {
  const normalizedHost = host.toLowerCase();
  if (normalizedHost === '::1') return true;
  const firstGroup = normalizedHost.split(':')[0] ?? '';
  const first = Number.parseInt(firstGroup, 16);
  if (!Number.isFinite(first)) return true;
  return (first & 0xfe00) === 0xfc00
    || (first & 0xffc0) === 0xfe80;
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
  if (record.version !== 1 || !Array.isArray(record.mappings)) {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Provider task mapping is unavailable');
  }
  return record.mappings.map((entry) => {
    const item = expectStrictRecord(entry, ['provider', 'publicTaskId', 'rawTaskId']);
    return {
      provider: parseProvider(item.provider),
      publicTaskId: parseNonEmptyString(item.publicTaskId, 'publicTaskId'),
      rawTaskId: parseNonEmptyString(item.rawTaskId, 'rawTaskId'),
    };
  });
}

function parseCredentialEnvelope(value: unknown): ProviderCredentialEnvelope {
  if (!isPlainRecord(value) || value.version !== 1) {
    throw createProviderBridgeError('CREDENTIALS_LOCKED', 'Provider credential metadata is invalid');
  }
  if (value.kind === 'safeStorage' && typeof value.ciphertextHex === 'string') {
    return { version: 1, kind: 'safeStorage', ciphertextHex: value.ciphertextHex };
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
      version: 1,
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

async function encryptWithPassphrase(token: string, passphrase: string): Promise<ProviderCredentialEnvelope> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    version: 1,
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

async function rejectSymlinkTarget(fileSystem: FileSystem, targetPath: string): Promise<void> {
  if (fileSystem.lstat === undefined) return;
  try {
    const stat = await fileSystem.lstat(targetPath);
    if (stat.isSymbolicLink?.() === true) {
      throw createProviderBridgeError('CREDENTIALS_LOCKED', 'Provider credential metadata path is invalid');
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
  await rejectSymlinkTarget(fileSystem, appDataRoot);
  await rejectSymlinkTarget(fileSystem, targetPath);
  if (fileSystem.realpath === undefined) return;
  const realRoot = normalizeRealPath(await fileSystem.realpath(resolve(appDataRoot)));
  const realParent = normalizeRealPath(await fileSystem.realpath(dirname(targetPath)));
  if (realParent !== realRoot) {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Provider task mapping path is invalid');
  }
}

async function assertConfinedProviderTaskPathForRead(
  fileSystem: FileSystem,
  appDataRoot: string,
  targetPath: string,
): Promise<void> {
  await rejectSymlinkTarget(fileSystem, appDataRoot);
  await rejectSymlinkTarget(fileSystem, targetPath);
  if (fileSystem.realpath === undefined) return;
  const realRoot = normalizeRealPath(await fileSystem.realpath(resolve(appDataRoot)));
  const realTarget = normalizeRealPath(await fileSystem.realpath(targetPath));
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${sep}`)) {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Provider task mapping path is invalid');
  }
}

function confinedCredentialsPath(appDataRoot: string): string {
  return confinedAppDataPath(appDataRoot, CREDENTIALS_FILE, 'CREDENTIALS_LOCKED', 'Provider credential path is invalid');
}

function confinedProviderTaskMappingsPath(appDataRoot: string): string {
  return confinedAppDataPath(appDataRoot, TASK_MAPPINGS_FILE, 'PROVIDER_UNAVAILABLE', 'Provider task mapping path is invalid');
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
