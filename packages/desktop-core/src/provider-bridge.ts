import { randomBytes } from 'node:crypto';
import { BlockList, isIP } from 'node:net';

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
import type {
  GenerationHistoryDurableTerminal,
  GenerationHistoryFailureCode,
  GenerationHistoryProviderSinkContract,
} from './generation-history-provider-sink.js';
import { deriveGenerationHistoryId } from './generation-history-provider-sink.js';
import type { ProviderBridgeHandlers, ProviderService } from './provider-service-types.js';
import {
  PROVIDER_BRIDGE_CHANNELS,
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
  type ProviderConnectionCheckResult,
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
  ProviderConnectionCheckResult,
  ProviderImageJobResult,
  SubmitImageJobBridgeRequest,
  SubmitImageJobBridgeResult,
  UnlockProviderBridgeRequest,
} from './provider-contracts.js';
export type { ProviderCredentialStore, SafeStorageAdapter } from './provider-credential-vault.js';
const DEFAULT_COMFLY_BASE_URL = 'https://api.comfly.chat';
const DEFAULT_TERMINAL_TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CURRENT_GENERATION_JOB_ID_PREFIX = 'model-job-v2-';
export const DEFAULT_PROVIDER_PROFILES: ProviderBridgeProfile[] = [];
export type { ProviderBridgeHandlers, ProviderIpcMainLike, ProviderService } from './provider-service-types.js';
export { registerProviderBridgeHandlers } from './provider-ipc-registration.js';
interface ConfigurationSnapshot {
  readonly baseUrl: string;
  readonly profiles: readonly ProviderBridgeProfile[];
}
type RuntimeSnapshot = ConfigurationSnapshot & { readonly token: string };

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
  readonly historySink?: GenerationHistoryProviderSinkContract;
  readonly resolveResultHost?: (hostname: string) => Promise<readonly string[]>;
}): ProviderService {
  let configurationCache: ConfigurationSnapshot = {
    profiles: sanitizeProfiles(options.profiles ?? DEFAULT_PROVIDER_PROFILES),
    baseUrl: options.baseUrl ?? DEFAULT_COMFLY_BASE_URL,
  };
  let configureTail: Promise<void> = Promise.resolve();
  let configurationOverride: ConfigurationSnapshot | null = null;
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
    async checkConnection(): Promise<ProviderConnectionCheckResult> {
      const checkedAt = new Date(nowMs()).toISOString();
      const status = await options.credentialStore.getStatus();
      if (!status.configured) return { checkedAt, status: 'unconfigured' };
      if (status.locked) return { checkedAt, status: 'service_limited' };
      try {
        const snapshot = await captureRuntimeSnapshot();
        await createClient(snapshot).checkConnection();
        return { checkedAt, status: 'connected' };
      } catch (error) {
        return { checkedAt, status: classifyConnectionCheckFailure(error) };
      }
    },
    configure(request) {
      return enqueueConfigure(async () => {
        const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.configure, request) as ConfigureProviderBridgeRequest;
        const persistedConfiguration = await providerConfiguration.readPersisted();
        const currentConfiguration = persistedConfiguration.exists
          ? cloneConfiguration(persistedConfiguration.snapshot)
          : cloneConfiguration(configurationCache);
        const nextProfiles = validated.profiles === undefined ? undefined : parseProviderBridgeProfiles(validated.profiles);
        const nextConfiguration: ConfigurationSnapshot = {
          baseUrl: validated.baseUrl ?? currentConfiguration.baseUrl,
          profiles: nextProfiles ?? currentConfiguration.profiles,
        };
        await providerConfiguration.write(nextConfiguration);
        try {
          await options.credentialStore.configure({ token: validated.token, passphrase: validated.passphrase });
        } catch (error) {
          try {
            await providerConfiguration.replace(persistedConfiguration.exists ? persistedConfiguration.snapshot : null);
            configurationOverride = null;
            configurationCache = cloneConfiguration(currentConfiguration);
          } catch (rollbackError) {
            configurationOverride = cloneConfiguration(currentConfiguration);
            configurationCache = cloneConfiguration(currentConfiguration);
            throw normalizeConfigurationRollbackFailure(rollbackError);
          }
          throw error;
        }
        configurationOverride = null;
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
      const historyId = deriveGenerationHistoryId(validated.jobId);
      const submissionCreated = await providerTaskMappings.reserveSubmission({
        currentIdentity: validated.jobId.startsWith(CURRENT_GENERATION_JOB_ID_PREFIX), historyId,
      });
      if (!submissionCreated) {
        const existingMapping = await providerTaskMappings.findByHistoryId(historyId);
        if (existingMapping !== undefined) return { providerTaskId: existingMapping.publicTaskId };
        let durableTerminal: GenerationHistoryDurableTerminal | null = null;
        try {
          durableTerminal = await options.historySink?.getTerminal(historyId) ?? null;
        } catch {
          // The provider submission tombstone remains authoritative after history deletion.
        }
        if (durableTerminal !== null) {
          const publicTaskId = createPublicProviderTaskId();
          await providerTaskMappings.set(createHistoryTerminalMappingRecord(
            publicTaskId,
            historyId,
            durableTerminal,
            nowIso(),
          ));
          return { providerTaskId: publicTaskId };
        }
        throw createProviderBridgeError(
          'PROVIDER_INVALID_RESPONSE',
          'Generation job is already reserved; create a new run to submit again',
        );
      }
      const reservation = await options.historySink?.reserveSubmission({
        jobId: validated.jobId,
        modelDisplayName: profile.displayName,
      });
      if (reservation !== undefined && reservation.historyId !== historyId) {
        throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Generation history reservation identity is invalid');
      }
      if (reservation !== undefined && !reservation.created) {
        const existingMapping = await providerTaskMappings.findByHistoryId(historyId);
        if (existingMapping !== undefined) return { providerTaskId: existingMapping.publicTaskId };
        if (reservation.terminal !== null) {
          const publicTaskId = createPublicProviderTaskId();
          await providerTaskMappings.set(createHistoryTerminalMappingRecord(
            publicTaskId,
            historyId,
            reservation.terminal,
            nowIso(),
          ));
          return { providerTaskId: publicTaskId };
        }
        throw createProviderBridgeError(
          'PROVIDER_INVALID_RESPONSE',
          'Generation job is already reserved; create a new run to submit again',
        );
      }
      let parsed: ReturnType<typeof parseImageTaskResponse>;
      try {
        const response = await translateProviderCall(() => createClient(snapshot).generateImage({
          model: profile.modelId ?? profile.modelRoute,
          prompt: validated.prompt,
          async: true,
        }));
        parsed = parseImageTaskResponse(response);
      } catch (error) {
        if (options.historySink !== undefined) {
          await options.historySink?.failed(historyId, historyFailureCode(error));
        }
        throw error;
      }
      const publicTaskId = createPublicProviderTaskId();
      const timestamp = nowIso();
      await providerTaskMappings.set({
        provider: 'comfly',
        publicTaskId,
        rawTaskId: parsed.taskId,
        historyId,
        state: 'running',
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      if (options.historySink !== undefined) await options.historySink.running(historyId);
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
      if (task.historyId !== undefined && options.historySink !== undefined) {
        const durableTerminal = await options.historySink.getTerminal(task.historyId);
        if (durableTerminal !== null) {
          return await commitHistoryTerminal(validated.providerTaskId, durableTerminal);
        }
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
      const mapped = mapImageTaskPollResult(validated.provider, validated.providerTaskId, task.rawTaskId, response);
      let result = mapped.publicResult;
      if (task.historyId !== undefined && options.historySink !== undefined) {
        let effective: GenerationHistoryDurableTerminal | null = null;
        if (result.status === 'completed') {
          try {
            const bytes = await downloadProviderResult(mapped.resultUrl);
            effective = await options.historySink.succeeded(task.historyId, bytes);
          } catch {
            effective = await options.historySink.failed(task.historyId, 'invalid_result');
          }
        } else if (result.status === 'failed') {
          effective = await options.historySink.failed(task.historyId, 'provider_failed');
        } else if (result.status === 'cancelled') {
          effective = await options.historySink.cancelled(task.historyId, 'cancelled_by_system');
        }
        if (effective !== null) result = historyTerminalToPollResult(validated.provider, validated.providerTaskId, effective);
      }
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
      const current = await providerTaskMappings.get(validated.providerTaskId);
      if (current === undefined || current.provider !== validated.provider) {
        throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider job handle is unavailable');
      }
      if (current.state !== 'running') return terminalMappingToCancelResult(current);
      if (current.historyId !== undefined && options.historySink !== undefined) {
        const prior = await options.historySink.getTerminal(current.historyId);
        const effective = prior ?? await options.historySink.cancelled(current.historyId, 'cancelled_by_user');
        return terminalMappingToCancelResult(await commitHistoryTerminalRecord(validated.providerTaskId, effective));
      }
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
    if (configurationOverride !== null) {
      return cloneConfiguration(configurationOverride);
    }
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

  async function downloadProviderResult(rawUrl: string | undefined): Promise<Uint8Array> {
    const url = parseSafeProviderResultUrl(rawUrl);
    if (options.resolveResultHost === undefined) {
      throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image result');
    }
    let addresses: readonly string[];
    try {
      addresses = await options.resolveResultHost(url.hostname);
    } catch {
      throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image result');
    }
    if (addresses.length === 0 || addresses.some((address) => !isPublicProviderAddress(address))) {
      throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image result');
    }
    const response = await options.fetch(url.toString(), { trustedResolvedAddress: addresses[0] });
    if (!response.ok || response.arrayBuffer === undefined) {
      throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image result');
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async function commitHistoryTerminal(
    publicTaskId: string,
    terminal: GenerationHistoryDurableTerminal,
  ): Promise<PollImageJobBridgeResult> {
    return terminalMappingToPollResult(await commitHistoryTerminalRecord(publicTaskId, terminal));
  }

  async function commitHistoryTerminalRecord(
    publicTaskId: string,
    terminal: GenerationHistoryDurableTerminal,
  ): Promise<ProviderTaskMappingRecord> {
    if (terminal.status === 'cancelled') {
      const committed = await providerTaskMappings.markCancelled(publicTaskId, nowIso());
      if (committed === undefined) throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider job handle is unavailable');
      return committed;
    }
    const result = historyTerminalToPollResult('comfly', publicTaskId, terminal);
    if (result.status !== 'completed' && result.status !== 'failed') {
      throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider job handle is unavailable');
    }
    const committed = await providerTaskMappings.markTerminal(publicTaskId, result, nowIso());
    if (committed === undefined) throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider job handle is unavailable');
    return committed;
  }

  function createHistoryTerminalMappingRecord(
    publicTaskId: string,
    historyId: string,
    terminal: GenerationHistoryDurableTerminal,
    now: string,
  ): ProviderTaskMappingRecord {
    if (terminal.status === 'cancelled') {
      return {
        provider: 'comfly',
        publicTaskId,
        rawTaskId: `history-terminal-${publicTaskId}`,
        historyId,
        state: 'cancelled',
        createdAt: now,
        updatedAt: now,
        terminalAt: now,
      };
    }
    const result = historyTerminalToPollResult('comfly', publicTaskId, terminal);
    if (result.status === 'completed') {
      return {
        provider: 'comfly',
        publicTaskId,
        rawTaskId: `history-terminal-${publicTaskId}`,
        historyId,
        state: 'completed',
        createdAt: now,
        updatedAt: now,
        terminalAt: now,
        result: result.result,
      };
    }
    if (result.status !== 'failed') {
      throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider job handle is unavailable');
    }
    return {
      provider: 'comfly',
      publicTaskId,
      rawTaskId: `history-terminal-${publicTaskId}`,
      historyId,
      state: 'failed',
      createdAt: now,
      updatedAt: now,
      terminalAt: now,
      error: result.error,
    };
  }
}

function classifyConnectionCheckFailure(error: unknown): ProviderConnectionCheckResult['status'] {
  const message = error instanceof Error ? error.message : String(error);
  if (/status (?:401|403)\b/u.test(message)) return 'authentication_failed';
  if (/status (?:429|5\d\d)\b/u.test(message) || /CREDENTIALS_LOCKED/u.test(message)) return 'service_limited';
  return 'network_unavailable';
}

export function createProviderBridgeHandlers(service: ProviderService): ProviderBridgeHandlers {
  return {
    getStatus: async (_event, request) => {
      parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.getStatus, request);
      return parseProviderBridgeResponse(PROVIDER_BRIDGE_CHANNELS.getStatus, await service.getStatus()) as ProviderConfigurationStatus;
    },
    checkConnection: async (_event, request) => {
      parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.checkConnection, request);
      return parseProviderBridgeResponse(
        PROVIDER_BRIDGE_CHANNELS.checkConnection,
        await service.checkConnection(),
      ) as ProviderConnectionCheckResult;
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
): { readonly publicResult: PollImageJobBridgeResult; readonly resultUrl?: string } {
  const task = parseImageTaskResponse(value);
  if (task.taskId !== rawTaskId) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image task response');
  }
  const status = task.status.toLowerCase();
  if (status === 'queued' || status === 'pending' || status === 'running' || status === 'processing') {
    return { publicResult: { status: 'running', progress: undefined } };
  }
  if (status === 'failed' || status === 'error') {
    return { publicResult: {
      status: 'failed',
      error: normalizeProviderBridgeError(createProviderBridgeError('PROVIDER_ERROR', 'Provider image task failed', true)),
    } };
  }
  if (status === 'cancelled' || status === 'canceled') {
    return { publicResult: { status: 'cancelled' } };
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
    publicResult: {
      status: 'completed',
      progress: 1,
      result: {
        assetId: createProviderResultAssetId(provider, publicTaskId),
        ...(first.width === undefined ? {} : { width: parseFiniteNumber(first.width, 'width') }),
        ...(first.height === undefined ? {} : { height: parseFiniteNumber(first.height, 'height') }),
      },
    },
    ...(typeof first.url === 'string' ? { resultUrl: first.url } : {}),
  };
}

function historyFailureCode(error: unknown): GenerationHistoryFailureCode {
  if (isProviderBridgeError(error) && (error.code === 'PROVIDER_INVALID_RESPONSE' || error.code === 'PROTECTED_PAYLOAD')) {
    return 'invalid_result';
  }
  return 'provider_unavailable';
}

function parseSafeProviderResultUrl(value: string | undefined): URL {
  if (value === undefined) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image result');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image result');
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '').replace(/^\[|\]$/gu, '');
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || isIpLiteral(hostname)
  ) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image result');
  }
  return url;
}

function isIpLiteral(hostname: string): boolean {
  if (hostname.includes(':')) return true;
  const parts = hostname.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
}

const providerResultAddressBlockList = createProviderResultAddressBlockList();

function isPublicProviderAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 4) return isPublicIpv4Address(address);
  return !providerResultAddressBlockList.check(address, 'ipv6');
}

function createProviderResultAddressBlockList(): BlockList {
  const blockList = new BlockList();
  for (const [address, prefix] of [
    ['::', 96],
    ['::1', 128],
    ['::ffff:0:0', 96],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['fc00::', 7],
    ['fec0::', 10],
    ['fe80::', 10],
    ['ff00::', 8],
  ] as const) blockList.addSubnet(address, prefix, 'ipv6');
  return blockList;
}

function isPublicIpv4Address(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [first, second] = octets as [number, number, number, number];
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && (second === 0 || second === 168)) return false;
  if (first === 198 && (second === 18 || second === 19)) return false;
  return true;
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

function historyTerminalToPollResult(
  provider: string,
  publicTaskId: string,
  terminal: GenerationHistoryDurableTerminal,
): PollImageJobBridgeResult {
  if (terminal.status === 'succeeded') {
    return {
      status: 'completed',
      progress: 1,
      result: {
        assetId: createProviderResultAssetId(provider, publicTaskId),
        width: terminal.width,
        height: terminal.height,
      },
    };
  }
  if (terminal.status === 'failed') {
    return {
      status: 'failed',
      error: normalizeProviderBridgeError(createProviderBridgeError('PROVIDER_ERROR', 'Provider image task failed', true)),
    };
  }
  return { status: 'cancelled' };
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

function normalizeConfigurationRollbackFailure(error: unknown): ProviderBridgeException {
  const normalized = normalizeProviderBridgeError(error);
  return createProviderBridgeError(
    normalized.code === 'PROVIDER_ERROR' ? 'PROVIDER_UNAVAILABLE' : normalized.code,
    normalized.message,
    normalized.retryable,
  );
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
