import { isProviderRegistry, type ProviderRegistry } from './provider-registry.js';
import type { ProviderActiveStateStore, ProviderBridgeHandlers, ProviderService } from './provider-service-types.js';
import {
  PROVIDER_BRIDGE_CHANNELS,
  createProviderBridgeError,
  parseProviderBridgeRequest,
  parseProviderBridgeResponse,
  type AckImageJobTerminalBridgeRequest,
  type AckImageJobTerminalBridgeResult,
  type AckVideoJobTerminalBridgeRequest,
  type AckVideoJobTerminalBridgeResult,
  type AnalyzeReversePromptBridgeRequest,
  type AnalyzeReversePromptBridgeResult,
  type CancelImageJobBridgeRequest,
  type CancelImageJobBridgeResult,
  type CancelVideoJobBridgeRequest,
  type CancelVideoJobBridgeResult,
  type ChatSkillBridgeRequest,
  type ChatSkillBridgeResult,
  type ConfigureProviderBridgeRequest,
  type GenerateStoryboardBridgeRequest,
  type GenerateStoryboardBridgeResult,
  type PollImageJobBridgeRequest,
  type PollImageJobBridgeResult,
  type PollVideoJobBridgeRequest,
  type PollVideoJobBridgeResult,
  type ProviderBridgeProfile,
  type ProviderActiveState,
  type LoginRelayMeBridgeRequest,
  type ProviderConfigurationStatus,
  type ProviderConnectionCheckResult,
  type RevealProviderCredentialBridgeResult,
  type ProviderSelectionBridgeRequest,
  type SubmitImageJobBridgeRequest,
  type SubmitImageJobBridgeResult,
  type SubmitVideoJobBridgeRequest,
  type SubmitVideoJobBridgeResult,
  type SetActiveProviderBridgeRequest,
  type UnlockProviderBridgeRequest,
  type UpdateProviderProfilesBridgeRequest,
} from './provider-contracts.js';

export function createProviderBridgeHandlers(
  source: ProviderService | ProviderRegistry,
  options?: { readonly activeStore?: ProviderActiveStateStore },
): ProviderBridgeHandlers {
  return {
    getActiveProvider: async (_event, request) => {
      parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.getActiveProvider, request);
      return parseProviderBridgeResponse(
        PROVIDER_BRIDGE_CHANNELS.getActiveProvider,
        await requireActiveStore(options).getActiveProvider(),
      ) as ProviderActiveState;
    },
    setActiveProvider: async (_event, request) => {
      const parsed = parseProviderBridgeRequest(
        PROVIDER_BRIDGE_CHANNELS.setActiveProvider,
        request,
      ) as SetActiveProviderBridgeRequest;
      const activeStore = requireActiveStore(options);
      if (parsed.activeProvider !== null) {
        const status = await selectService(source, parsed.activeProvider).getStatus();
        if (!status.configured || status.locked) {
          throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Selected provider is not configured');
        }
      }
      return parseProviderBridgeResponse(
        PROVIDER_BRIDGE_CHANNELS.setActiveProvider,
        await activeStore.setActiveProvider(parsed.activeProvider),
      ) as ProviderActiveState;
    },
    loginRelayMe: async (_event, request) => {
      const parsed = parseProviderBridgeRequest(
        PROVIDER_BRIDGE_CHANNELS.loginRelayMe,
        request,
      ) as LoginRelayMeBridgeRequest;
      const service = selectService(source, 'relayme');
      if (service.loginRelayMe === undefined) {
        throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'RelayMe account login is unavailable');
      }
      await service.loginRelayMe(parsed);
      return parseProviderBridgeResponse(
        PROVIDER_BRIDGE_CHANNELS.loginRelayMe,
        await requireActiveStore(options).setActiveProvider('relayme'),
      ) as ProviderActiveState;
    },
    logoutRelayMe: async (_event, request) => {
      parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.logoutRelayMe, request);
      const service = selectService(source, 'relayme');
      if (service.logoutRelayMe === undefined) {
        throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'RelayMe account logout is unavailable');
      }
      await service.logoutRelayMe();
      const activeStore = requireActiveStore(options);
      const active = await activeStore.getActiveProvider();
      const next = active.activeProvider === 'relayme'
        ? await activeStore.setActiveProvider(null)
        : active;
      return parseProviderBridgeResponse(PROVIDER_BRIDGE_CHANNELS.logoutRelayMe, next) as ProviderActiveState;
    },
    getStatus: async (_event, request) => {
      const parsed = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.getStatus, request) as ProviderSelectionBridgeRequest;
      const service = selectService(source, parsed.provider);
      return parseProviderBridgeResponse(PROVIDER_BRIDGE_CHANNELS.getStatus, await service.getStatus()) as ProviderConfigurationStatus;
    },
    revealCredential: async (_event, request) => {
      const parsed = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.revealCredential, request) as ProviderSelectionBridgeRequest;
      return parseProviderBridgeResponse(
        PROVIDER_BRIDGE_CHANNELS.revealCredential,
        await selectService(source, parsed.provider).revealCredential(),
      ) as RevealProviderCredentialBridgeResult;
    },
    checkConnection: async (_event, request) => {
      const parsed = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.checkConnection, request) as ProviderSelectionBridgeRequest;
      const service = selectService(source, parsed.provider);
      return parseProviderBridgeResponse(PROVIDER_BRIDGE_CHANNELS.checkConnection, await service.checkConnection()) as ProviderConnectionCheckResult;
    },
    configure: async (_event, request) => {
      const parsed = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.configure, request) as ConfigureProviderBridgeRequest;
      return parseProviderBridgeResponse(PROVIDER_BRIDGE_CHANNELS.configure, await selectService(source, parsed.provider ?? 'comfly').configure(parsed)) as ProviderConfigurationStatus;
    },
    updateProfiles: async (_event, request) => {
      const parsed = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.updateProfiles, request) as UpdateProviderProfilesBridgeRequest;
      const service = selectService(source, parsed.provider ?? 'comfly');
      if (service.updateProfiles === undefined) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Model route configuration is unavailable');
      return parseProviderBridgeResponse(PROVIDER_BRIDGE_CHANNELS.updateProfiles, await service.updateProfiles(parsed)) as ProviderConfigurationStatus;
    },
    unlock: async (_event, request) => {
      const parsed = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.unlock, request) as UnlockProviderBridgeRequest;
      return parseProviderBridgeResponse(PROVIDER_BRIDGE_CHANNELS.unlock, await selectService(source, parsed.provider ?? 'comfly').unlock(parsed)) as ProviderConfigurationStatus;
    },
    listAvailableModelIds: async (_event, request) => {
      const parsed = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.listAvailableModelIds, request) as ProviderSelectionBridgeRequest;
      return executeProviderCallWithExpiry(source, options?.activeStore, parsed.provider, async () => (
        parseProviderBridgeResponse(PROVIDER_BRIDGE_CHANNELS.listAvailableModelIds, await selectService(source, parsed.provider).listAvailableModelIds()) as string[]
      ));
    },
    listProfiles: async (_event, request) => {
      const parsed = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.listProfiles, request) as ProviderSelectionBridgeRequest;
      return executeProviderCallWithExpiry(source, options?.activeStore, parsed.provider, async () => (
        parseProviderBridgeResponse(PROVIDER_BRIDGE_CHANNELS.listProfiles, await selectService(source, parsed.provider).listProfiles()) as ProviderBridgeProfile[]
      ));
    },
    submitImageJob: async (_event, request) => {
      const parsed = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.submitImageJob, request) as SubmitImageJobBridgeRequest;
      return executeActiveProviderCall(source, options?.activeStore, parsed.provider, async () => (
        parseProviderBridgeResponse(
          PROVIDER_BRIDGE_CHANNELS.submitImageJob,
          await selectService(source, parsed.provider).submitImageJob(parsed),
        ) as SubmitImageJobBridgeResult
      ));
    },
    pollImageJob: async (_event, request) => {
      const parsed = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.pollImageJob, request) as PollImageJobBridgeRequest;
      await assertExecutionProvider(options?.activeStore, parsed.provider);
      return executeProviderCallWithExpiry(source, options?.activeStore, parsed.provider, async () => (
        parseProviderBridgeResponse(PROVIDER_BRIDGE_CHANNELS.pollImageJob, await selectService(source, parsed.provider).pollImageJob(parsed)) as PollImageJobBridgeResult
      ));
    },
    cancelImageJob: async (_event, request) => {
      const parsed = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.cancelImageJob, request) as CancelImageJobBridgeRequest;
      await assertExecutionProvider(options?.activeStore, parsed.provider);
      return executeProviderCallWithExpiry(source, options?.activeStore, parsed.provider, async () => (
        parseProviderBridgeResponse(PROVIDER_BRIDGE_CHANNELS.cancelImageJob, await selectService(source, parsed.provider).cancelImageJob(parsed)) as CancelImageJobBridgeResult
      ));
    },
    ackImageJobTerminal: async (_event, request) => {
      const parsed = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.ackImageJobTerminal, request) as AckImageJobTerminalBridgeRequest;
      await assertExecutionProvider(options?.activeStore, parsed.provider);
      return executeProviderCallWithExpiry(source, options?.activeStore, parsed.provider, async () => (
        parseProviderBridgeResponse(PROVIDER_BRIDGE_CHANNELS.ackImageJobTerminal, await selectService(source, parsed.provider).ackImageJobTerminal(parsed)) as AckImageJobTerminalBridgeResult
      ));
    },
    submitVideoJob: async (_event, request) => {
      const parsed = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.submitVideoJob, request) as SubmitVideoJobBridgeRequest;
      return executeActiveProviderCall(source, options?.activeStore, parsed.provider, async () => {
        const service = selectService(source, parsed.provider);
        if (service.submitVideoJob === undefined) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '视频生成暂不可用');
        return parseProviderBridgeResponse(PROVIDER_BRIDGE_CHANNELS.submitVideoJob, await service.submitVideoJob(parsed)) as SubmitVideoJobBridgeResult;
      });
    },
    pollVideoJob: async (_event, request) => {
      const parsed = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.pollVideoJob, request) as PollVideoJobBridgeRequest;
      await assertExecutionProvider(options?.activeStore, parsed.provider);
      const service = selectService(source, parsed.provider);
      if (service.pollVideoJob === undefined) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '视频生成暂不可用');
      return executeProviderCallWithExpiry(source, options?.activeStore, parsed.provider, async () => (
        parseProviderBridgeResponse(PROVIDER_BRIDGE_CHANNELS.pollVideoJob, await service.pollVideoJob!(parsed)) as PollVideoJobBridgeResult
      ));
    },
    cancelVideoJob: async (_event, request) => {
      const parsed = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.cancelVideoJob, request) as CancelVideoJobBridgeRequest;
      await assertExecutionProvider(options?.activeStore, parsed.provider);
      const service = selectService(source, parsed.provider);
      if (service.cancelVideoJob === undefined) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '视频生成暂不可用');
      return executeProviderCallWithExpiry(source, options?.activeStore, parsed.provider, async () => (
        parseProviderBridgeResponse(PROVIDER_BRIDGE_CHANNELS.cancelVideoJob, await service.cancelVideoJob!(parsed)) as CancelVideoJobBridgeResult
      ));
    },
    ackVideoJobTerminal: async (_event, request) => {
      const parsed = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.ackVideoJobTerminal, request) as AckVideoJobTerminalBridgeRequest;
      await assertExecutionProvider(options?.activeStore, parsed.provider);
      const service = selectService(source, parsed.provider);
      if (service.ackVideoJobTerminal === undefined) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '视频生成暂不可用');
      return executeProviderCallWithExpiry(source, options?.activeStore, parsed.provider, async () => (
        parseProviderBridgeResponse(PROVIDER_BRIDGE_CHANNELS.ackVideoJobTerminal, await service.ackVideoJobTerminal!(parsed)) as AckVideoJobTerminalBridgeResult
      ));
    },
    analyzeReversePrompt: async (_event, request) => {
      const parsed = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.analyzeReversePrompt, request) as AnalyzeReversePromptBridgeRequest;
      return executeActiveProviderCall(source, options?.activeStore, parsed.provider, async () => {
        const service = selectService(source, parsed.provider);
        if (service.analyzeReversePrompt === undefined) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '反推分析暂不可用');
        return parseProviderBridgeResponse(PROVIDER_BRIDGE_CHANNELS.analyzeReversePrompt, await service.analyzeReversePrompt(parsed)) as AnalyzeReversePromptBridgeResult;
      });
    },
    chat: async (_event, request) => {
      const parsed = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.chat, request) as ChatSkillBridgeRequest;
      return executeActiveProviderCall(source, options?.activeStore, parsed.provider, async () => {
        const service = selectService(source, parsed.provider);
        if (service.chat === undefined) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Agent 对话暂不可用');
        return parseProviderBridgeResponse(PROVIDER_BRIDGE_CHANNELS.chat, await service.chat(parsed)) as ChatSkillBridgeResult;
      });
    },
    generateStoryboard: async (_event, request) => {
      const parsed = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.generateStoryboard, request) as GenerateStoryboardBridgeRequest;
      return executeActiveProviderCall(source, options?.activeStore, parsed.provider, async () => {
        const service = selectService(source, parsed.provider);
        if (service.generateStoryboard === undefined) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '分镜生成暂不可用');
        return parseProviderBridgeResponse(PROVIDER_BRIDGE_CHANNELS.generateStoryboard, await service.generateStoryboard(parsed)) as GenerateStoryboardBridgeResult;
      });
    },
  };
}

function requireActiveStore(options: { readonly activeStore?: ProviderActiveStateStore } | undefined): ProviderActiveStateStore {
  if (options?.activeStore === undefined) {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Active provider state is unavailable');
  }
  return options.activeStore;
}

async function assertExecutionProvider(
  activeStore: ProviderActiveStateStore | undefined,
  requestedProvider: 'comfly' | 'relayme',
): Promise<void> {
  if (activeStore === undefined) return;
  const { activeProvider } = await activeStore.getActiveProvider();
  if (activeProvider !== requestedProvider) {
    throw createProviderBridgeError('PROVIDER_INACTIVE', 'Requested provider is not active');
  }
}

async function executeActiveProviderCall<T>(
  source: ProviderService | ProviderRegistry,
  activeStore: ProviderActiveStateStore | undefined,
  requestedProvider: 'comfly' | 'relayme',
  operation: () => Promise<T>,
): Promise<T> {
  await assertExecutionProvider(activeStore, requestedProvider);
  return executeProviderCallWithExpiry(source, activeStore, requestedProvider, operation);
}

async function executeProviderCallWithExpiry<T>(
  source: ProviderService | ProviderRegistry,
  activeStore: ProviderActiveStateStore | undefined,
  requestedProvider: 'comfly' | 'relayme',
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isRelayMeAuthenticationExpiry(error) || requestedProvider !== 'relayme' || activeStore === undefined) throw error;
    const active = await activeStore.getActiveProvider();
    if (active.activeProvider !== 'relayme') throw error;
    const relayme = selectService(source, 'relayme');
    if (relayme.logoutRelayMe !== undefined) await relayme.logoutRelayMe();
    await activeStore.setActiveProvider(null);
    throw error;
  }
}

function isRelayMeAuthenticationExpiry(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'authenticationExpired' in error
    && error.authenticationExpired === true;
}

function selectService(source: ProviderService | ProviderRegistry, provider: 'comfly' | 'relayme'): ProviderService {
  return isProviderRegistry(source) ? source.get(provider) : source;
}
