import { randomBytes } from 'node:crypto';

import {
  ComflyClient,
  mergeComflyModelRegistries,
  type ComflyFetch,
  type ComflyModelRegistration,
} from '@agent-canvas/provider-comfly';

import type { FileSystem } from './file-system.js';
import {
  createSecureProviderCredentialStore,
  type ProviderCredentialStore,
  type SafeStorageAdapter,
} from './provider-credential-vault.js';
import {
  createProviderTaskMappingStore,
  type ProviderTaskMappingRecord,
} from './provider-task-ledger.js';
import { createElectronNetComflyFetch } from './electron-net-fetch.js';
import type { ProviderBridgeHandlers, ProviderIpcMainLike, ProviderService } from './provider-service-types.js';
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
  createElectronNetComflyFetch,
  createSecureProviderCredentialStore,
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
export type { ProviderCredentialStore, SafeStorageAdapter } from './provider-credential-vault.js';

const DEFAULT_COMFLY_BASE_URL = 'https://api.comfly.chat';
const DEFAULT_TERMINAL_TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const DEFAULT_PROVIDER_PROFILES: ProviderBridgeProfile[] = [];

export type { ProviderBridgeHandlers, ProviderIpcMainLike, ProviderService } from './provider-service-types.js';

interface ConfigurationSnapshot {
  readonly baseUrl: string;
  readonly profiles: readonly ProviderBridgeProfile[];
}

interface RuntimeSnapshot extends ConfigurationSnapshot {
  readonly token: string;
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
  let configuration = {
    profiles: sanitizeProfiles(options.profiles ?? DEFAULT_PROVIDER_PROFILES),
    baseUrl: options.baseUrl ?? DEFAULT_COMFLY_BASE_URL,
  };
  let configureTail: Promise<void> = Promise.resolve();
  const nowMs = options.now ?? Date.now;
  const terminalTombstoneTtlMs = options.terminalTombstoneTtlMs ?? DEFAULT_TERMINAL_TOMBSTONE_TTL_MS;
  const providerTaskMappings = createProviderTaskMappingStore({
    appDataRoot: options.appDataRoot,
    fileSystem: options.fileSystem,
    secretSupplier: () => options.credentialStore.getMappingSecrets(),
  });

  const createClient = (snapshot: RuntimeSnapshot) => new ComflyClient({
    baseUrl: snapshot.baseUrl,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
    tokenSupplier: async () => snapshot.token,
  });

  return {
    getStatus() {
      return options.credentialStore.getStatus();
    },
    configure(request) {
      return enqueueConfigure(async () => {
        const validated = validateConfigureRequest(request);
        const nextProfiles = validated.profiles === undefined ? undefined : validateConfiguredProfiles(validated.profiles);
        await options.credentialStore.configure({ token: validated.token, passphrase: validated.passphrase });
        configuration = {
          baseUrl: validated.baseUrl ?? configuration.baseUrl,
          profiles: nextProfiles ?? configuration.profiles,
        };
        await gcTerminalTombstones();
        return options.credentialStore.getStatus();
      });
    },
    async unlock(request) {
      const validated = validateUnlockRequest(request);
      await options.credentialStore.unlock(validated);
      await gcTerminalTombstones();
      return options.credentialStore.getStatus();
    },
    async listProfiles() {
      const snapshot = await captureConfigurationSnapshot();
      await gcTerminalTombstones();
      return sanitizeProfiles(mergeComflyModelRegistries({
        providerModels: options.providerModels ?? [],
        profileModels: snapshot.profiles,
      }));
    },
    async submitImageJob(request) {
      await gcTerminalTombstones();
      const validated = validateSubmitImageJobRequest(request);
      const snapshot = await captureRuntimeSnapshot();
      const profile = selectProfile(snapshot.profiles, validated.provider, validated.modelRoute);
      const response = await translateProviderCall(() => createClient(snapshot).generateImage({
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
    },
    async pollImageJob(request) {
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
      const snapshot = await captureRuntimeSnapshot();
      let response: unknown;
      try {
        response = await translateProviderCall(
          () => createClient(snapshot).getImageTask(task.rawTaskId),
          { publicTaskId: validated.providerTaskId, rawTaskId: task.rawTaskId, request: 'poll' },
        );
      } catch (error) {
        if (isCredentialsLocked(error)) return blockedCredentialsPollResult();
        throw error;
      }
      const result = mapImageTaskPollResult(validated.provider, validated.providerTaskId, task.rawTaskId, response);
      if (result.status === 'completed' || result.status === 'failed') {
        const terminal = await providerTaskMappings.markTerminal(validated.providerTaskId, result, nowIso());
        return terminal === undefined ? result : terminalMappingToPollResult(terminal);
      }
      if (result.status === 'cancelled') {
        const terminal = await providerTaskMappings.markCancelled(validated.providerTaskId, nowIso());
        return terminal === undefined ? result : terminalMappingToPollResult(terminal);
      }
      return result;
    },
    async cancelImageJob(request) {
      await gcTerminalTombstones();
      const validated = validateCancelImageJobRequest(request);
      assertSupportedProvider(validated.provider);
      const terminal = await providerTaskMappings.markCancelled(validated.providerTaskId, nowIso());
      if (terminal === undefined || terminal.provider !== validated.provider) {
        throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider job handle is unavailable');
      }
      return terminalMappingToCancelResult(terminal);
    },
    async ackImageJobTerminal(request) {
      const validated = validateAckImageJobTerminalRequest(request);
      assertSupportedProvider(validated.provider);
      await providerTaskMappings.ackTerminal(validated.providerTaskId, validated.status);
      return { acknowledged: true };
    },
  };

  function enqueueConfigure<T>(operation: () => Promise<T>): Promise<T> {
    const run = configureTail.then(operation, operation);
    configureTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async function captureRuntimeSnapshot(): Promise<RuntimeSnapshot> {
    const snapshot = await captureConfigurationSnapshot();
    return {
      ...snapshot,
      token: await options.credentialStore.getToken(),
    };
  }

  async function captureConfigurationSnapshot(): Promise<ConfigurationSnapshot> {
    await configureTail.catch(() => undefined);
    return {
      baseUrl: configuration.baseUrl,
      profiles: configuration.profiles.map((profile) => ({
        ...profile,
        capabilities: [...profile.capabilities],
      })),
    };
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
  if (value.status === 'cancelled') {
    expectStrictRecord(value, ['status']);
    return { status: 'cancelled' };
  }
  throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image job result');
}

function validateCancelImageJobResult(value: unknown): CancelImageJobBridgeResult {
  const result = validatePollImageJobResult(value);
  if (result.status === 'running') {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid cancel result');
  }
  return result;
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
  if (status === 'cancelled' || status === 'canceled') {
    return { status: 'cancelled' };
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
    return { status: 'cancelled' };
  }
  throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider job handle is unavailable');
}

function terminalMappingToCancelResult(record: ProviderTaskMappingRecord): CancelImageJobBridgeResult {
  const result = terminalMappingToPollResult(record);
  if (result.status === 'running') {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider job handle is unavailable');
  }
  return result;
}

function assertProviderResponsePayload(value: unknown): void {
  for (const text of collectStrings(value)) {
    if (containsProtectedProviderText(text)) {
      throw createProviderBridgeError('PROTECTED_PAYLOAD', 'Provider returned a protected payload');
    }
  }
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
