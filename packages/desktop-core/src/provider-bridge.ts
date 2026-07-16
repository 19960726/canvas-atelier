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
import { createProviderConfigurationStore } from './provider-configuration-store.js';
import { createElectronNetComflyFetch } from './electron-net-fetch.js';
import type { ProviderBridgeHandlers, ProviderIpcMainLike, ProviderService } from './provider-service-types.js';
import {
  PROVIDER_BRIDGE_CHANNELS,
  createProviderBridgeErrorEnvelope,
  createProviderBridgeSuccessEnvelope,
  createProviderBridgeError,
  normalizeProviderBridgeError,
  parseProviderBridgeProfiles,
  parseProviderBridgeRequest,
  parseProviderBridgeResponse,
  type AckImageJobTerminalBridgeRequest,
  type AckImageJobTerminalBridgeResult,
  type CancelImageJobBridgeRequest,
  type CancelImageJobBridgeResult,
  type ConfigureProviderBridgeRequest,
  type PollImageJobBridgeRequest,
  type PollImageJobBridgeResult,
  type ProviderBridgeException,
  type ProviderBridgeProfile,
  type ProviderConfigurationStatus,
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
  parseProviderBridgeRequest,
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
  let configurationCache: ConfigurationSnapshot = {
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
  const providerConfiguration = createProviderConfigurationStore({
    appDataRoot: options.appDataRoot,
    fileSystem: options.fileSystem,
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
        const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.configure, request) as ConfigureProviderBridgeRequest;
        const currentConfiguration = await providerConfiguration.read(configurationCache);
        const nextProfiles = validated.profiles === undefined ? undefined : parseProviderBridgeProfiles(validated.profiles);
        const nextConfiguration = {
          baseUrl: validated.baseUrl ?? currentConfiguration.baseUrl,
          profiles: nextProfiles ?? currentConfiguration.profiles,
        };
        await options.credentialStore.configure({ token: validated.token, passphrase: validated.passphrase });
        await providerConfiguration.write(nextConfiguration);
        configurationCache = cloneConfiguration(nextConfiguration);
        await gcTerminalTombstones();
        return options.credentialStore.getStatus();
      });
    },
    async unlock(request) {
      const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.unlock, request) as UnlockProviderBridgeRequest;
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
      const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.submitImageJob, request) as SubmitImageJobBridgeRequest;
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
      const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.pollImageJob, request) as PollImageJobBridgeRequest;
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
      const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.cancelImageJob, request) as CancelImageJobBridgeRequest;
      assertSupportedProvider(validated.provider);
      const terminal = await providerTaskMappings.markCancelled(validated.providerTaskId, nowIso());
      if (terminal === undefined || terminal.provider !== validated.provider) {
        throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider job handle is unavailable');
      }
      return terminalMappingToCancelResult(terminal);
    },
    async ackImageJobTerminal(request) {
      const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.ackImageJobTerminal, request) as AckImageJobTerminalBridgeRequest;
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
    configurationCache = await providerConfiguration.read(configurationCache);
    return cloneConfiguration(configurationCache);
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
      return parseProviderBridgeResponse(PROVIDER_BRIDGE_CHANNELS.getStatus, await service.getStatus()) as ProviderConfigurationStatus;
    },
    configure: async (_event, request) => parseProviderBridgeResponse(PROVIDER_BRIDGE_CHANNELS.configure, await service.configure(
      parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.configure, request) as ConfigureProviderBridgeRequest,
    )) as ProviderConfigurationStatus,
    unlock: async (_event, request) => parseProviderBridgeResponse(PROVIDER_BRIDGE_CHANNELS.unlock, await service.unlock(
      parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.unlock, request) as UnlockProviderBridgeRequest,
    )) as ProviderConfigurationStatus,
    listProfiles: async (_event, request) => {
      parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.listProfiles, request);
      return parseProviderBridgeResponse(PROVIDER_BRIDGE_CHANNELS.listProfiles, await service.listProfiles()) as ProviderBridgeProfile[];
    },
    submitImageJob: async (_event, request) => parseProviderBridgeResponse(PROVIDER_BRIDGE_CHANNELS.submitImageJob, await service.submitImageJob(
      parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.submitImageJob, request) as SubmitImageJobBridgeRequest,
    )) as SubmitImageJobBridgeResult,
    pollImageJob: async (_event, request) => parseProviderBridgeResponse(PROVIDER_BRIDGE_CHANNELS.pollImageJob, await service.pollImageJob(
      parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.pollImageJob, request) as PollImageJobBridgeRequest,
    )) as PollImageJobBridgeResult,
    cancelImageJob: async (_event, request) => parseProviderBridgeResponse(PROVIDER_BRIDGE_CHANNELS.cancelImageJob, await service.cancelImageJob(
      parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.cancelImageJob, request) as CancelImageJobBridgeRequest,
    )) as CancelImageJobBridgeResult,
    ackImageJobTerminal: async (_event, request) => parseProviderBridgeResponse(PROVIDER_BRIDGE_CHANNELS.ackImageJobTerminal, await service.ackImageJobTerminal(
      parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.ackImageJobTerminal, request) as AckImageJobTerminalBridgeRequest,
    )) as AckImageJobTerminalBridgeResult,
  };
}

export function registerProviderBridgeHandlers(
  ipcMain: ProviderIpcMainLike,
  handlers: ProviderBridgeHandlers,
): void {
  ipcMain.handle(PROVIDER_BRIDGE_CHANNELS.getStatus, wrapProviderIpcHandler(PROVIDER_BRIDGE_CHANNELS.getStatus, handlers.getStatus));
  ipcMain.handle(PROVIDER_BRIDGE_CHANNELS.configure, wrapProviderIpcHandler(PROVIDER_BRIDGE_CHANNELS.configure, handlers.configure));
  ipcMain.handle(PROVIDER_BRIDGE_CHANNELS.unlock, wrapProviderIpcHandler(PROVIDER_BRIDGE_CHANNELS.unlock, handlers.unlock));
  ipcMain.handle(PROVIDER_BRIDGE_CHANNELS.listProfiles, wrapProviderIpcHandler(PROVIDER_BRIDGE_CHANNELS.listProfiles, handlers.listProfiles));
  ipcMain.handle(PROVIDER_BRIDGE_CHANNELS.submitImageJob, wrapProviderIpcHandler(PROVIDER_BRIDGE_CHANNELS.submitImageJob, handlers.submitImageJob));
  ipcMain.handle(PROVIDER_BRIDGE_CHANNELS.pollImageJob, wrapProviderIpcHandler(PROVIDER_BRIDGE_CHANNELS.pollImageJob, handlers.pollImageJob));
  ipcMain.handle(PROVIDER_BRIDGE_CHANNELS.cancelImageJob, wrapProviderIpcHandler(PROVIDER_BRIDGE_CHANNELS.cancelImageJob, handlers.cancelImageJob));
  ipcMain.handle(PROVIDER_BRIDGE_CHANNELS.ackImageJobTerminal, wrapProviderIpcHandler(PROVIDER_BRIDGE_CHANNELS.ackImageJobTerminal, handlers.ackImageJobTerminal));
}

function wrapProviderIpcHandler(
  channel: string,
  handler: (event: unknown, request: unknown) => Promise<unknown>,
): (event: unknown, request: unknown) => Promise<unknown> {
  return async (event, request) => {
    try {
      return createProviderBridgeSuccessEnvelope(channel, await handler(event, request));
    } catch (error) {
      return createProviderBridgeErrorEnvelope(error);
    }
  };
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

function sanitizeProfiles(value: readonly ComflyModelRegistration[]): ProviderBridgeProfile[] {
  return parseProviderBridgeProfiles(value.flatMap((profile) => {
    if (profile.provider !== 'comfly') return [];
    return {
      provider: 'comfly' as const,
      modelRoute: profile.modelRoute,
      displayName: profile.displayName,
      ...(profile.modelId === undefined ? {} : { modelId: profile.modelId }),
      capabilities: [...profile.capabilities],
    };
  }));
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
      assetId: createProviderResultAssetId(provider, publicTaskId),
      ...(first.width === undefined ? {} : { width: parseFiniteNumber(first.width, 'width') }),
      ...(first.height === undefined ? {} : { height: parseFiniteNumber(first.height, 'height') }),
    },
  };
}

function createPublicProviderTaskId(): string {
  return `provider-job-${randomBytes(16).toString('hex')}`;
}

function createProviderResultAssetId(_provider: string, publicTaskId: string): string {
  if (!/^provider-job-[a-f0-9]{32}$/u.test(publicTaskId)) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider job handle is unavailable');
  }
  return `provider-result-${publicTaskId}`;
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

function cloneConfiguration(snapshot: ConfigurationSnapshot): ConfigurationSnapshot {
  return {
    baseUrl: snapshot.baseUrl,
    profiles: snapshot.profiles.map((profile) => ({
      ...profile,
      capabilities: [...profile.capabilities],
    })),
  };
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
