import { randomBytes } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { join } from 'node:path';
import { RelayMeClient, loginRelayMeAccount, type RelayMeFetch } from '@agent-canvas/provider-relayme';
import { parseReverseProviderResponse } from './reverse-provider-response.js';
import { NodeFileSystem, type FileSystem } from './file-system.js';
import type { GenerationHistoryProviderSinkContract } from './generation-history-provider-sink.js';
import {
  createProviderConfigurationStore,
  type PersistedProviderConfigurationState,
} from './provider-configuration-store.js';
import type { ProviderCredentialStore } from './provider-credential-vault.js';
import { buildRelayMeModelProfiles, buildRelayMeWorkflowModelProfiles, cloneProviderProfile } from './provider-model-catalog.js';
import { ManagedKnowledgeStore } from './managed-knowledge-store.js';
import { buildProfessionalReverseRequest } from './professional-reverse-analysis.js';
import { readPinnedReverseKnowledge } from './provider-reverse-knowledge.js';
import type { ProviderService } from './provider-service-types.js';
import { createProviderTaskMappingStore, type ProviderTaskMappingRecord } from './provider-task-ledger.js';
import {
  PROVIDER_BRIDGE_CHANNELS,
  createProviderBridgeError,
  normalizeProviderBridgeError,
  parseProviderBridgeProfiles,
  parseProviderBridgeRequest,
  parseProviderBridgeResponse,
  type AckImageJobTerminalBridgeRequest,
  type AckVideoJobTerminalBridgeRequest,
  type AnalyzeReversePromptBridgeRequest,
  type CancelImageJobBridgeRequest,
  type CancelImageJobBridgeResult,
  type CancelVideoJobBridgeRequest,
  type CancelVideoJobBridgeResult,
  type ChatSkillBridgeRequest,
  type ConfigureProviderBridgeRequest,
  type PollImageJobBridgeRequest,
  type PollImageJobBridgeResult,
  type PollVideoJobBridgeRequest,
  type PollVideoJobBridgeResult,
  type LoginRelayMeBridgeRequest,
  type ListProviderTasksBridgeRequest,
  type ListProviderTasksBridgeResult,
  type ProviderBridgeException,
  type ProviderBridgeProfile,
  type ProviderImageJobResult,
  type ProviderVideoJobResult,
  type SubmitImageJobBridgeRequest,
  type SubmitVideoJobBridgeRequest,
  type UnlockProviderBridgeRequest,
  type UpdateProviderProfilesBridgeRequest,
} from './provider-contracts.js';

const DEFAULT_RELAYME_BASE_URL = 'https://www.ml.relayme.uk/api/ai-tools/v1';
const RELAYME_LOGIN_BASE_URL = DEFAULT_RELAYME_BASE_URL;

type RelayTask =
  | { readonly historyId?: string; readonly kind: 'image'; readonly rawTaskId: string; readonly sessionId: string; state: 'running' | 'completed' | 'failed' | 'cancelled'; result?: ProviderImageJobResult; error?: ReturnType<typeof normalizeProviderBridgeError> }
  | { readonly historyId?: string; readonly kind: 'video'; readonly rawTaskId: string; readonly sessionId: string; state: 'running' | 'completed' | 'failed' | 'cancelled'; result?: ProviderVideoJobResult; error?: ReturnType<typeof normalizeProviderBridgeError> };

interface ConfigurationSnapshot {
  readonly baseUrl: string;
  readonly profiles: readonly ProviderBridgeProfile[];
}

export interface RelayMeProviderServiceOptions {
  readonly appDataRoot: string;
  readonly credentialStore: ProviderCredentialStore;
  readonly fetch: RelayMeFetch;
  readonly fileSystem?: FileSystem;
  readonly historySink?: GenerationHistoryProviderSinkContract;
  readonly baseUrl?: string;
  readonly profiles?: readonly ProviderBridgeProfile[];
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly resolveResultHost?: (hostname: string) => Promise<readonly string[]>;
  readonly readManagedReverseMedia?: (sessionId: string, media: AnalyzeReversePromptBridgeRequest['media']) => Promise<readonly { readonly bytes: Uint8Array; readonly mediaType: string }[]>;
  readonly storeGeneratedImage?: (sessionId: string, bytes: Uint8Array, mediaType: string) => Promise<{ readonly assetId: string; readonly width?: number | null; readonly height?: number | null }>;
  readonly storeGeneratedVideo?: (sessionId: string, bytes: Uint8Array, mediaType: 'video/mp4') => Promise<{ readonly assetId: string; readonly width?: number | null; readonly height?: number | null }>;
  readonly loginAccount?: (request: LoginRelayMeBridgeRequest & { readonly baseUrl: string }) => Promise<string>;
  readonly loginWebAccount?: () => Promise<string>;
}

export function createRelayMeProviderService(options: RelayMeProviderServiceOptions): ProviderService {
  let configurationCache: ConfigurationSnapshot = {
    baseUrl: options.baseUrl ?? DEFAULT_RELAYME_BASE_URL,
    profiles: sanitizeProfiles(options.profiles ?? []),
  };
  let discoveredProfiles: ProviderBridgeProfile[] | null = null;
  let loginValidatedProfiles: ProviderBridgeProfile[] | null = null;
  let configureTail: Promise<void> = Promise.resolve();
  const tasks = new Map<string, RelayTask>();
  const now = options.now ?? Date.now;
  const managedKnowledgeStore = new ManagedKnowledgeStore({ appDataRoot: options.appDataRoot, fileSystem: options.fileSystem });
  const configurationStore = createProviderConfigurationStore({
    appDataRoot: options.appDataRoot,
    provider: 'relayme',
    fileSystem: options.fileSystem,
  });
  const taskMappings = createProviderTaskMappingStore({
    appDataRoot: join(options.appDataRoot, 'providers', 'relayme'),
    fileSystem: options.fileSystem,
    secretSupplier: () => options.credentialStore.getMappingSecrets(),
  });
  const fileSystem = options.fileSystem ?? new NodeFileSystem();

  return {
    async loginRelayMe(request) {
      const validated = parseProviderBridgeRequest(
        PROVIDER_BRIDGE_CHANNELS.loginRelayMe,
        request,
      ) as LoginRelayMeBridgeRequest;
      const configuration = await readLoginConfigurationSnapshot();
      let token: string;
      try {
        token = await (options.loginAccount === undefined
          ? loginRelayMeAccount({ baseUrl: RELAYME_LOGIN_BASE_URL, fetch: options.fetch }, validated)
          : options.loginAccount({ ...validated, baseUrl: configuration.baseUrl }));
      } catch (error) {
        throw translateRelayMeLoginError(error);
      }
      await enqueueConfigure(() => validateAndPersistLoginToken(token));
    },
    ...(options.loginWebAccount === undefined ? {} : {
      async loginRelayMeWeb() {
        let token: string;
        try {
          token = await options.loginWebAccount!();
        } catch (error) {
          throw translateRelayMeWebLoginError(error);
        }
        await enqueueConfigure(() => validateAndPersistLoginToken(token));
      },
    }),
    async logoutRelayMe() {
      await options.credentialStore.clear();
      tasks.clear();
      discoveredProfiles = null;
      loginValidatedProfiles = null;
      configurationCache = { baseUrl: options.baseUrl ?? DEFAULT_RELAYME_BASE_URL, profiles: [] };
      await configurationStore.replace(null);
      await fileSystem.rm(join(options.appDataRoot, 'providers', 'relayme'), { force: true, recursive: true });
    },
    getStatus: () => options.credentialStore.getStatus(),
    async revealCredential() {
      return { token: await options.credentialStore.getPrimaryToken() };
    },
    async checkConnection() {
      const checkedAt = new Date(now()).toISOString();
      const status = await options.credentialStore.getStatus();
      if (!status.configured) return { checkedAt, status: 'unconfigured' };
      if (status.locked) return { checkedAt, status: 'service_limited' };
      try {
        await createClient(await captureConfiguration()).checkConnection();
        return { checkedAt, status: 'connected' };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/\b(?:401|403)\b/u.test(message)) return { checkedAt, status: 'authentication_failed' };
        if (/\b(?:429|5\d\d)\b/u.test(message)) return { checkedAt, status: 'service_limited' };
        return { checkedAt, status: 'network_unavailable' };
      }
    },
    configure(request) {
      return enqueueConfigure(async () => {
        const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.configure, request) as ConfigureProviderBridgeRequest;
        assertRelayMeProvider(validated.provider ?? 'relayme');
        const current = await readConfigurationSnapshot();
        const next: ConfigurationSnapshot = {
          baseUrl: validated.baseUrl ?? current.baseUrl,
          profiles: validated.profiles === undefined ? current.profiles : sanitizeProfiles(validated.profiles),
        };
        if (validated.token !== undefined) {
          throw createProviderBridgeError('INVALID_REQUEST', 'RelayMe 仅支持账号登录，不接受独立 API 密钥');
        }
        await requireUnlockedCredentials();
        await configurationStore.write(next);
        configurationCache = cloneConfiguration(next);
        discoveredProfiles = null;
        loginValidatedProfiles = null;
        return options.credentialStore.getStatus();
      });
    },
    updateProfiles(request) {
      return enqueueConfigure(async () => {
        const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.updateProfiles, request) as UpdateProviderProfilesBridgeRequest;
        assertRelayMeProvider(validated.provider ?? 'relayme');
        await requireUnlockedCredentials();
        const current = await readConfigurationSnapshot();
        const next = { ...current, profiles: sanitizeProfiles(validated.profiles) };
        await configurationStore.write(next);
        configurationCache = cloneConfiguration(next);
        discoveredProfiles = null;
        loginValidatedProfiles = null;
        return options.credentialStore.getStatus();
      });
    },
    async unlock(request) {
      const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.unlock, request) as UnlockProviderBridgeRequest;
      assertRelayMeProvider(validated.provider ?? 'relayme');
      await options.credentialStore.unlock(validated);
      return options.credentialStore.getStatus();
    },
    async listAvailableModelIds() {
      return (await listProfiles()).flatMap((profile) => profile.modelId === undefined ? [] : [profile.modelId]);
    },
    listProfiles,
    async listTasks(request: ListProviderTasksBridgeRequest): Promise<ListProviderTasksBridgeResult> {
      await requireUnlockedCredentials();
      const result = await translateRelayMeCall(
        () => createClientFromCredentials().then((client) => client.listTasks(request.page, request.size)),
        'RelayMe 任务清单读取失败',
      );
      return {
        tasks: result.tasks.map((task) => ({
          taskId: task.taskId,
          type: task.type,
          status: task.status,
          ...(task.createdAt === undefined ? {} : { createdAt: task.createdAt }),
          ...(task.error === undefined ? {} : { error: task.error }),
        })),
        total: result.total,
        page: result.page,
        totalPages: result.totalPages,
      };
    },
    async analyzeReversePrompt(request) {
      const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.analyzeReversePrompt, request) as AnalyzeReversePromptBridgeRequest;
      assertRelayMeProvider(validated.provider);
      const profile = await selectProfile(validated.run.agentConfig?.modelRoute ?? '', 'reverse_prompt');
      if (validated.run.orderedMedia.some((item) => item.kind === 'video')) {
        throw createProviderBridgeError('CAPABILITY_UNSUPPORTED', 'RelayMe 当前没有公开可验证的视频反推消息格式');
      }
      if (options.readManagedReverseMedia === undefined) {
        throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '受管反推素材不可用');
      }
      const media = await options.readManagedReverseMedia(validated.sessionId, validated.media);
      const knowledge = await readPinnedReverseKnowledge(managedKnowledgeStore, validated.run.knowledgeLease.snapshots);
      const reverseRequest = buildProfessionalReverseRequest(validated.run, knowledge);
      const response = await translateRelayMeCall(
        () => createClientFromCredentials().then((client) => client.chat({
          model: profile.modelId ?? profile.modelRoute,
          messages: [
            { role: 'system', content: 'Return only valid ReversePromptResult JSON.' },
            { role: 'user', content: [
              { type: 'text', text: JSON.stringify(reverseRequest) },
              ...media.map((item) => ({
                type: 'image_url',
                image_url: { url: `data:${item.mediaType};base64,${Buffer.from(item.bytes).toString('base64')}` },
              })),
            ] },
          ],
        })),
        'RelayMe 反推请求失败',
      );
      const choice = response.choices[0];
      const responseText = extractChatText(choice?.message?.content);
      const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined;
      return parseReverseProviderResponse({ text: responseText ?? undefined, finishReason }, validated.run);
    },    async chat(request) {
      const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.chat, request) as ChatSkillBridgeRequest;
      assertRelayMeProvider(validated.provider);
      if ((validated.referenceAssetIds?.length ?? 0) > 0) {
        throw createProviderBridgeError('CAPABILITY_UNSUPPORTED', 'RelayMe 当前聊天接口尚未公开可验证的图片或视频引用字段');
      }
      const profile = await selectProfile(validated.modelRoute, 'chat');
      const response = await translateRelayMeCall(
        () => createClientFromCredentials().then((client) => client.chat({ model: profile.modelId ?? profile.modelRoute, messages: validated.messages })),
        'RelayMe 对话请求失败',
      );
      const content = response.choices[0]?.message?.content;
      const message = extractChatText(content);
      if (message === null) throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'RelayMe 返回了无效的对话结果');
      return { message, modelRoute: validated.modelRoute, sources: [] };
    },
    async submitImageJob(request) {
      const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.submitImageJob, request) as SubmitImageJobBridgeRequest;
      assertRelayMeProvider(validated.provider);
      if (validated.referenceAssetIds.length > 0) {
        throw createProviderBridgeError('CAPABILITY_UNSUPPORTED', 'RelayMe 当前生图接口尚未公开可验证的素材引用字段');
      }
      const profile = await selectProfile(validated.modelRoute, 'image_generation');
      const historyId = options.historySink === undefined
        ? undefined
        : (await options.historySink.reserveSubmission({
          jobId: validated.jobId,
          kind: 'image',
          modelDisplayName: profile.displayName,
          provider: 'relayme',
        })).historyId;
      try {
        const response = await translateRelayMeCall(
          () => createClientFromCredentials().then((client) => client.generateImage({
            model: profile.modelId ?? profile.modelRoute,
            messages: [{ role: 'user', content: validated.prompt }],
            ...(validated.aspectRatio === undefined ? {} : { imageAspectRatio: validated.aspectRatio }),
            ...(validated.resolution === undefined ? {} : { imageSampleSize: validated.resolution }),
            imageQuality: 'medium',
            ...(validated.outputCount === undefined ? {} : { n: validated.outputCount }),
          })),
          'RelayMe 生图任务提交失败',
        );
        const registered = await registerTask('image', response.taskId, validated.sessionId ?? validated.conversationId, historyId);
        if (historyId !== undefined) await options.historySink!.running(historyId);
        return registered;
      } catch (error) {
        await markRelayMeHistoryFailed(historyId, options.historySink, error);
        throw error;
      }
    },
    async pollImageJob(request) {
      const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.pollImageJob, request) as PollImageJobBridgeRequest;
      assertRelayMeProvider(validated.provider);
      const task = await requireTask(validated.providerTaskId, 'image');
      if (task.state !== 'running') return imageTerminalResult(task);
      try {
        const response = await pollTask(task.rawTaskId, '图片');
        const result = await mapTaskState(validated.providerTaskId, response, 'image', (content, item) => persistGeneratedResult(task.sessionId, content, 'image', task.historyId, item));
        updateTaskFromPoll(task, result);
        await persistRelayMeHistoryTerminal(task.historyId, options.historySink, result);
        await persistPolledTask(validated.providerTaskId, result);
        return result;
      } catch (error) {
        await markRelayMeHistoryFailed(task.historyId, options.historySink, error);
        throw error;
      }
    },
    async cancelImageJob(request) {
      const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.cancelImageJob, request) as CancelImageJobBridgeRequest;
      assertRelayMeProvider(validated.provider);
      const task = await requireTask(validated.providerTaskId, 'image');
      if (task.state !== 'running') return imageCancelTerminalResult(task);
      await cancelTask(task.rawTaskId);
      task.state = 'cancelled';
      await taskMappings.markCancelled(validated.providerTaskId, new Date(now()).toISOString());
      return { status: 'cancelled' };
    },
    async ackImageJobTerminal(request) {
      const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.ackImageJobTerminal, request) as AckImageJobTerminalBridgeRequest;
      assertRelayMeProvider(validated.provider);
      await acknowledgeTask(validated.providerTaskId, 'image', validated.status);
      return { acknowledged: true };
    },
    async submitVideoJob(request) {
      const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.submitVideoJob, request) as SubmitVideoJobBridgeRequest;
      assertRelayMeProvider(validated.provider);
      if (validated.referenceAssetIds.length > 0) {
        throw createProviderBridgeError('CAPABILITY_UNSUPPORTED', 'RelayMe 当前视频接口尚未公开可验证的素材引用字段');
      }
      const profile = await selectProfile(validated.modelRoute, 'video_generation');
      const historyId = options.historySink === undefined
        ? undefined
        : (await options.historySink.reserveSubmission({
          jobId: validated.jobId,
          kind: 'video',
          modelDisplayName: profile.displayName,
          provider: 'relayme',
        })).historyId;
      try {
        const response = await translateRelayMeCall(
          () => createClientFromCredentials().then((client) => client.generateVideo({
            model: profile.modelId ?? profile.modelRoute,
            messages: [{ role: 'user', content: validated.prompt }],
            ...(validated.aspectRatio === undefined ? {} : { videoAspectRatio: validated.aspectRatio }),
            ...(validated.resolution === undefined ? {} : { videoResolution: validated.resolution }),
            ...(validated.durationSeconds === undefined ? {} : { videoSeconds: validated.durationSeconds }),
            ...(validated.outputCount === undefined ? {} : { n: validated.outputCount }),
            ...(validated.audioEnabled === undefined ? {} : { videoGenerateAudio: validated.audioEnabled }),
          })),
          'RelayMe 视频任务提交失败',
        );
        const registered = await registerTask('video', response.taskId, validated.sessionId ?? validated.conversationId, historyId);
        if (historyId !== undefined) await options.historySink!.running(historyId);
        return registered;
      } catch (error) {
        await markRelayMeHistoryFailed(historyId, options.historySink, error);
        throw error;
      }
    },
    async pollVideoJob(request) {
      const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.pollVideoJob, request) as PollVideoJobBridgeRequest;
      assertRelayMeProvider(validated.provider);
      const task = await requireTask(validated.providerTaskId, 'video');
      if (task.state !== 'running') return videoTerminalResult(task);
      try {
        const response = await pollTask(task.rawTaskId, '视频');
        const result = await mapTaskState(validated.providerTaskId, response, 'video', (content, item) => persistGeneratedResult(task.sessionId, content, 'video', task.historyId, item));
        updateTaskFromPoll(task, result);
        await persistRelayMeHistoryTerminal(task.historyId, options.historySink, result);
        await persistPolledTask(validated.providerTaskId, result);
        return result;
      } catch (error) {
        await markRelayMeHistoryFailed(task.historyId, options.historySink, error);
        throw error;
      }
    },
    async cancelVideoJob(request) {
      const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.cancelVideoJob, request) as CancelVideoJobBridgeRequest;
      assertRelayMeProvider(validated.provider);
      const task = await requireTask(validated.providerTaskId, 'video');
      if (task.state !== 'running') return videoCancelTerminalResult(task);
      await cancelTask(task.rawTaskId);
      task.state = 'cancelled';
      await taskMappings.markCancelled(validated.providerTaskId, new Date(now()).toISOString());
      return { status: 'cancelled' };
    },
    async ackVideoJobTerminal(request) {
      const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.ackVideoJobTerminal, request) as AckVideoJobTerminalBridgeRequest;
      assertRelayMeProvider(validated.provider);
      await acknowledgeTask(validated.providerTaskId, 'video', validated.status);
      return { acknowledged: true };
    },
  };

  async function listProfiles(): Promise<ProviderBridgeProfile[]> {
    await requireUnlockedCredentials();
    if (discoveredProfiles !== null) return discoveredProfiles.map(cloneProfile);
    const configured = (await captureConfiguration()).profiles;
    const client = await createClientFromCredentials();
    let modelProfiles = loginValidatedProfiles;
    if (modelProfiles === null) {
      try {
        modelProfiles = buildRelayMeModelProfiles(await translateRelayMeCall(
          () => client.listModels(),
          'RelayMe 模型目录读取失败',
        ));
      } catch (error) {
        if (configured.length === 0) throw error;
        discoveredProfiles = configured.map(cloneProfile);
        return discoveredProfiles.map(cloneProfile);
      }
    }
    const workflowModelProfiles = buildRelayMeWorkflowModelProfiles(await loadWorkflows(client));
    discoveredProfiles = mergeProfiles(mergeDiscoveredModelProfiles([
      ...workflowModelProfiles,
      ...modelProfiles,
    ]), configured);
    loginValidatedProfiles = null;
    return discoveredProfiles.map(cloneProfile);
  }

  async function validateAndPersistLoginToken(
    token: string,
  ): Promise<void> {
    if (!isBoundedRelayMeLoginToken(token)) {
      throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'RelayMe 网页登录未返回有效会话');
    }
    const previousConfiguration = await configurationStore.readPersisted();
    const configuration = loginConfigurationFromPersisted(previousConfiguration);
    const models = await translateRelayMeCall(
      () => new RelayMeClient({
        baseUrl: configuration.baseUrl,
        fetch: options.fetch,
        timeoutMs: options.timeoutMs,
        tokenSupplier: async () => token,
      }).listModels(),
      'RelayMe 登录成功，但模型目录读取失败，请稍后重试',
    );
    const profiles = buildRelayMeModelProfiles(models);
    if (profiles.length === 0) {
      throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'RelayMe 登录成功，但账号没有可用模型');
    }
    const nextConfiguration = {
      ...configuration,
      profiles: mergeProfiles(profiles, configuration.profiles),
    };
    await configurationStore.write(nextConfiguration);
    try {
      await options.credentialStore.configure({ token });
    } catch (error) {
      await rollbackLoginConfiguration(previousConfiguration);
      throw error;
    }
    loginValidatedProfiles = profiles;
    configurationCache = cloneConfiguration(nextConfiguration);
    discoveredProfiles = null;
  }

  async function loadWorkflows(client: RelayMeClient) {
    try {
      const summaries = await client.listWorkflows();
      return await Promise.all(summaries.map(async (workflow) => (
        Array.isArray(workflow.data?.nodes) ? workflow : client.getWorkflow(workflow.id)
      )));
    } catch {
      return [];
    }
  }

  async function selectProfile(modelRoute: string, capability: ProviderBridgeProfile['capabilities'][number]) {
    const profile = (await listProfiles()).find((item) => item.modelRoute === modelRoute
      && item.capabilityStatus === 'complete'
      && item.capabilities.includes(capability));
    if (profile === undefined) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '所选 RelayMe 模型不可用或能力不匹配');
    return profile;
  }

  async function createClientFromCredentials() {
    const configuration = await captureConfiguration();
    await requireUnlockedCredentials();
    return createClient(configuration);
  }

  function createClient(configuration: ConfigurationSnapshot) {
    return new RelayMeClient({
      baseUrl: configuration.baseUrl,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      tokenSupplier: () => options.credentialStore.getToken('language'),
    });
  }

  async function requireUnlockedCredentials() {
    const status = await options.credentialStore.getStatus();
    if (!status.configured) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '请先登录 RelayMe 账号');
    if (status.locked) throw createProviderBridgeError('CREDENTIALS_LOCKED', 'RelayMe 登录凭据已锁定，请重新登录', true);
  }

  async function captureConfiguration() {
    await configureTail.catch(() => undefined);
    return readConfigurationSnapshot();
  }

  async function readLoginConfigurationSnapshot(): Promise<ConfigurationSnapshot> {
    const persisted = await configurationStore.readPersisted();
    return loginConfigurationFromPersisted(persisted);
  }

  function loginConfigurationFromPersisted(
    persisted: PersistedProviderConfigurationState,
  ): ConfigurationSnapshot {
    const snapshot = persisted.exists ? persisted.snapshot : configurationCache;
    return cloneConfiguration(isRetiredRelayMeBaseUrl(snapshot.baseUrl)
      ? { ...snapshot, baseUrl: DEFAULT_RELAYME_BASE_URL }
      : snapshot);
  }

  async function rollbackLoginConfiguration(
    persisted: PersistedProviderConfigurationState,
  ): Promise<void> {
    await configurationStore.replace(persisted.exists ? persisted.snapshot : null);
  }

  async function readConfigurationSnapshot() {
    configurationCache = await configurationStore.read(configurationCache);
    if (isRetiredRelayMeBaseUrl(configurationCache.baseUrl)) {
      configurationCache = { ...configurationCache, baseUrl: DEFAULT_RELAYME_BASE_URL };
      await configurationStore.write(configurationCache);
    }
    return cloneConfiguration(configurationCache);
  }

  function enqueueConfigure<T>(operation: () => Promise<T>): Promise<T> {
    const run = configureTail.then(operation, operation);
    configureTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async function registerTask(kind: RelayTask['kind'], rawTaskId: string, sessionId: string, historyId?: string) {
    if (typeof rawTaskId !== 'string' || rawTaskId.length === 0) {
      throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'RelayMe 返回了无效的任务标识');
    }
    const providerTaskId = `provider-job-${randomBytes(16).toString('hex')}`;
    const task = { kind, rawTaskId, sessionId, state: 'running', ...(historyId === undefined ? {} : { historyId }) } as RelayTask;
    const timestamp = new Date(now()).toISOString();
    await taskMappings.set({
      provider: 'relayme', publicTaskId: providerTaskId, rawTaskId, kind, sessionId,
      ...(historyId === undefined ? {} : { historyId }),
      state: 'running', createdAt: timestamp, updatedAt: timestamp,
    });
    tasks.set(providerTaskId, task);
    return { providerTaskId };
  }

  async function requireTask<K extends RelayTask['kind']>(providerTaskId: string, kind: K): Promise<Extract<RelayTask, { kind: K }>> {
    let task = tasks.get(providerTaskId);
    if (task === undefined) {
      const record = await taskMappings.get(providerTaskId);
      if (record?.provider === 'relayme' && record.kind === kind && record.sessionId !== undefined) {
        task = relayTaskFromMapping(record);
        tasks.set(providerTaskId, task);
      }
    }
    if (task === undefined || task.kind !== kind) throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'RelayMe 任务句柄不可用');
    return task as Extract<RelayTask, { kind: K }>;
  }

  async function persistPolledTask(
    providerTaskId: string,
    result: PollImageJobBridgeResult | PollVideoJobBridgeResult,
  ): Promise<void> {
    const timestamp = new Date(now()).toISOString();
    if (result.status === 'completed' || result.status === 'failed') {
      await taskMappings.markTerminal(providerTaskId, result, timestamp);
    } else if (result.status === 'cancelled') {
      await taskMappings.markCancelled(providerTaskId, timestamp);
    }
  }

  async function pollTask(rawTaskId: string, label: string) {
    return translateRelayMeCall(
      () => createClientFromCredentials().then((client) => client.getTask(rawTaskId)),
      `RelayMe ${label}任务轮询失败`,
    );
  }

  async function persistGeneratedResult(
    sessionId: string,
    content: string,
    kind: RelayTask['kind'],
    historyId: string | undefined,
    resultItem: Record<string, unknown>,
  ): Promise<{ readonly assetId: string; readonly width?: number | null; readonly height?: number | null }> {
    if (sessionId.length === 0) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '当前项目会话不可用');
    const bytes = await readRelayMeResultBytes(content, options.fetch, options.resolveResultHost);
    const mediaType = detectRelayMeGeneratedMediaType(bytes);
    if (kind === 'image') {
      if (!mediaType.startsWith('image/')) throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'RelayMe 返回的生图结果不是受支持的图片');
      if (options.storeGeneratedImage === undefined) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '生成图片存储不可用');
      const stored = await options.storeGeneratedImage(sessionId, bytes, mediaType);
      if (historyId !== undefined) {
        await options.historySink!.succeeded(historyId, bytes, {
          height: isFinitePositive(resultItem.height) ? resultItem.height : stored.height ?? undefined,
          width: isFinitePositive(resultItem.width) ? resultItem.width : stored.width ?? undefined,
        });
      }
      return stored;
    }
    if (mediaType !== 'video/mp4') throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'RelayMe 返回的视频结果不是受支持的 MP4');
    if (options.storeGeneratedVideo === undefined) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '生成视频存储不可用');
    const stored = await options.storeGeneratedVideo(sessionId, bytes, mediaType);
    if (historyId !== undefined) {
      await options.historySink!.succeeded(historyId, bytes, {
        durationSeconds: isFinitePositive(resultItem.durationSeconds) ? resultItem.durationSeconds : undefined,
        height: isFinitePositive(resultItem.height) ? resultItem.height : stored.height ?? undefined,
        width: isFinitePositive(resultItem.width) ? resultItem.width : stored.width ?? undefined,
      });
    }
    return stored;
  }
  async function cancelTask(rawTaskId: string): Promise<never> {
    try {
      return await createClientFromCredentials().then((client) => client.cancelTask(rawTaskId));
    } catch (error) {
      if (isCapabilityUnsupported(error)) {
        throw createProviderBridgeError('CAPABILITY_UNSUPPORTED', 'RelayMe 当前没有公开可验证的任务取消接口');
      }
      throw translateRelayMeError(error, 'RelayMe 取消任务失败');
    }
  }

  async function acknowledgeTask(providerTaskId: string, kind: RelayTask['kind'], status: 'completed' | 'failed' | 'cancelled') {
    const task = await requireTask(providerTaskId, kind);
    if (task.state !== status) throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'RelayMe 任务终态确认不匹配');
    await taskMappings.ackTerminal(providerTaskId, status);
    tasks.delete(providerTaskId);
  }
}

function relayTaskFromMapping(record: ProviderTaskMappingRecord): RelayTask {
  const shared = {
    rawTaskId: record.rawTaskId,
    sessionId: record.sessionId!,
    state: record.state,
    ...(record.historyId === undefined ? {} : { historyId: record.historyId }),
    ...(record.result === undefined ? {} : { result: record.result }),
    ...(record.error === undefined ? {} : { error: record.error }),
  };
  return record.kind === 'video'
    ? { ...shared, kind: 'video' } as RelayTask
    : { ...shared, kind: 'image' } as RelayTask;
}

function isRetiredRelayMeBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname.toLowerCase() === 'api.relayme.ai';
  } catch {
    return false;
  }
}

type RelayTaskStateResponse = {
  readonly status: string;
  readonly taskId?: string;
  readonly result?: unknown;
  readonly data?: unknown;
  readonly imageContent?: string;
  readonly videoContent?: string;
  readonly error?: string;
  readonly width?: number;
  readonly height?: number;
  readonly durationSeconds?: number;
};

async function markRelayMeHistoryFailed(historyId: string | undefined, sink: GenerationHistoryProviderSinkContract | undefined, _error: unknown): Promise<void> {
  // The provider task may already be terminal; the history sink is idempotent and
  // must still be closed when a poll/download error prevents a normal terminal map.
  if (historyId === undefined) return;
  if (sink === undefined) return;
  await sink.failed(historyId, 'provider_failed').catch(() => undefined);
}

async function persistRelayMeHistoryTerminal(
  historyId: string | undefined,
  sink: GenerationHistoryProviderSinkContract | undefined,
  result: PollImageJobBridgeResult | PollVideoJobBridgeResult,
): Promise<void> {
  if (historyId === undefined || sink === undefined) return;
  if (result.status === 'failed') await sink.failed(historyId, 'provider_failed');
  if (result.status === 'cancelled') await sink.cancelled(historyId, 'cancelled_by_system');
}

async function mapTaskState(
  _publicTaskId: string,
  response: RelayTaskStateResponse,
  kind: RelayTask['kind'],
  persist: (content: string, item: Record<string, unknown>) => Promise<{ readonly assetId: string; readonly width?: number | null; readonly height?: number | null }>,
): Promise<PollImageJobBridgeResult | PollVideoJobBridgeResult> {
  const status = response.status.toLowerCase();
  if (['queued', 'pending', 'running', 'processing'].includes(status)) return { status: 'running', progress: undefined };
  if (status === 'cancelled' || status === 'canceled') return { status: 'cancelled' };
  if (status === 'failed' || status === 'error') {
    return { status: 'failed', error: normalizeProviderBridgeError(createProviderBridgeError('PROVIDER_ERROR', response.error ?? `RelayMe ${kind === 'image' ? '图片' : '视频'}任务失败`, true)) };
  }
  if (!['completed', 'success', 'succeeded'].includes(status)) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'RelayMe 返回了未知任务状态');
  }
  const items = resultItems(response.result ?? response.data ?? response, kind)
    .slice(0, kind === 'image' ? 4 : 1);
  const storedResults = [] as Array<{ readonly assetId: string; readonly width?: number | null; readonly height?: number | null }>;
  for (const item of items) {
    assertSafeResultItem(item, kind);
    storedResults.push(await persist(resultContent(item, kind), item));
  }
  const stored = storedResults[0];
  if (stored === undefined) throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'RelayMe 没有返回可用的生成结果');
  const dimensions = finiteDimensions(items[0]!, stored);
  if (kind === 'image') {
    return { status: 'completed', progress: 1, result: {
      assetId: stored.assetId,
      ...(storedResults.length > 1 ? { assetIds: storedResults.map((item) => item.assetId) } : {}),
      ...dimensions,
    } };
  }
  return { status: 'completed', progress: 1, result: {
    assetId: stored.assetId,
    ...dimensions,
    ...(isFinitePositive(items[0]?.durationSeconds) ? { durationSeconds: items[0]!.durationSeconds } : {}),
  } };
}
function updateTaskFromPoll(task: RelayTask, result: PollImageJobBridgeResult | PollVideoJobBridgeResult): void {
  if (result.status === 'running') return;
  task.state = result.status;
  if (result.status === 'completed') task.result = result.result as ProviderImageJobResult & ProviderVideoJobResult;
  if (result.status === 'failed') task.error = result.error;
}

function imageTerminalResult(task: Extract<RelayTask, { kind: 'image' }>): PollImageJobBridgeResult {
  if (task.state === 'completed' && task.result !== undefined) return { status: 'completed', progress: 1, result: task.result };
  if (task.state === 'failed' && task.error !== undefined) return { status: 'failed', error: task.error };
  if (task.state === 'cancelled') return { status: 'cancelled' };
  throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'RelayMe 图片任务句柄不可用');
}

function videoTerminalResult(task: Extract<RelayTask, { kind: 'video' }>): PollVideoJobBridgeResult {
  if (task.state === 'completed' && task.result !== undefined) return { status: 'completed', progress: 1, result: task.result };
  if (task.state === 'failed' && task.error !== undefined) return { status: 'failed', error: task.error };
  if (task.state === 'cancelled') return { status: 'cancelled' };
  throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'RelayMe 视频任务句柄不可用');
}

function imageCancelTerminalResult(task: Extract<RelayTask, { kind: 'image' }>): CancelImageJobBridgeResult {
  const result = imageTerminalResult(task);
  if (result.status === 'running') throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'RelayMe 图片任务句柄不可用');
  return result;
}

function videoCancelTerminalResult(task: Extract<RelayTask, { kind: 'video' }>): CancelVideoJobBridgeResult {
  const result = videoTerminalResult(task);
  if (result.status === 'running') throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'RelayMe 视频任务句柄不可用');
  return result;
}
function resultItems(value: unknown, kind: RelayTask['kind']): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap((item) => resultItems(item, kind));
  const candidate = value;
  if (typeof candidate === 'string' && candidate.trim().length > 0) return [{ url: candidate.trim() }];
  if (isPlainRecord(candidate)) {
    if (Array.isArray(candidate.data)) return resultItems(candidate.data, kind);
    if (Array.isArray(candidate.images)) return resultItems(candidate.images, kind);
    if (Array.isArray(candidate.videos)) return resultItems(candidate.videos, kind);
    const urlKey = kind === 'image' ? 'image_url' : 'video_url';
    if (typeof candidate[urlKey] === 'string' && candidate[urlKey].trim().length > 0) return [candidate];
    if (Array.isArray(candidate.result_urls)) return resultItems(candidate.result_urls, kind);
    if (isPlainRecord(candidate.result) || Array.isArray(candidate.result)) return resultItems(candidate.result, kind);
    const contentKey = kind === 'image' ? 'imageContent' : 'videoContent';
    if (typeof candidate[contentKey] === 'string' && candidate[contentKey].trim().length > 0) return [candidate];
    if (typeof candidate.url === 'string' && candidate.url.trim().length > 0) return [candidate];
    return [candidate];
  }
  throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'RelayMe 没有返回可用的生成结果');
}
function resultContent(value: Record<string, unknown>, kind: RelayTask['kind']): string {
  const contentKey = kind === 'image' ? 'imageContent' : 'videoContent';
  const urlKey = kind === 'image' ? 'image_url' : 'video_url';
  const content = value[contentKey] ?? value.url ?? value[urlKey];
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'RelayMe 没有返回可用的生成结果');
  }
  return content.trim();
}

function assertSafeResultItem(value: Record<string, unknown>, kind: RelayTask['kind']) {
  const contentKey = kind === 'image' ? 'imageContent' : 'videoContent';
  for (const [key, item] of Object.entries(value)) {
    if (key === contentKey || key === 'url') continue;
    if (typeof item === 'string' && (/authorization|bearer|api[_ -]?key|token|secret|password/iu.test(item) || /[A-Za-z]:\\/u.test(item))) {
      throw createProviderBridgeError('PROTECTED_PAYLOAD', 'RelayMe 返回了受保护的生成载荷');
    }
  }
}

function finiteDimensions(
  value: Record<string, unknown>,
  stored: { readonly width?: number | null; readonly height?: number | null },
) {
  const width = isFinitePositive(value.width) ? value.width : isFinitePositive(stored.width) ? stored.width : undefined;
  const height = isFinitePositive(value.height) ? value.height : isFinitePositive(stored.height) ? stored.height : undefined;
  return {
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  };
}
function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

const MAX_RELAYME_RESULT_BYTES = 64 * 1024 * 1024;
const relayMeResultAddressBlockList = createRelayMeResultAddressBlockList();

type RelayMeGeneratedMediaType = 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp' | 'video/mp4';

async function readRelayMeResultBytes(
  content: string,
  fetch: RelayMeFetch,
  resolveResultHost: ((hostname: string) => Promise<readonly string[]>) | undefined,
): Promise<Uint8Array> {
  if (content.startsWith('data:')) return decodeRelayMeDataUrl(content);
  if (/^[A-Za-z0-9+/]+={0,2}$/u.test(content) && content.length % 4 === 0) {
    return validateRelayMeResultBytes(Buffer.from(content, 'base64'));
  }
  const url = parseSafeRelayMeResultUrl(content);
  if (resolveResultHost === undefined) throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'RelayMe 生成结果地址无法安全验证');
  let addresses: readonly string[];
  try {
    addresses = await resolveResultHost(url.hostname);
  } catch {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'RelayMe 生成结果地址无法安全验证');
  }
  if (addresses.length === 0 || addresses.some((address) => !isPublicRelayMeResultAddress(address))) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'RelayMe 生成结果地址无法安全验证');
  }
  const response = await fetch(url.toString(), { method: 'GET', trustedResolvedAddress: addresses[0] });
  if (!response.ok || response.arrayBuffer === undefined) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'RelayMe 生成结果下载失败');
  }
  return validateRelayMeResultBytes(new Uint8Array(await response.arrayBuffer()));
}

function decodeRelayMeDataUrl(content: string): Uint8Array {
  const match = /^data:(?:image\/(?:gif|jpeg|png|webp)|video\/mp4);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(content);
  if (match === null || match[1]!.length % 4 !== 0) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'RelayMe 返回了无效的内联生成结果');
  }
  return validateRelayMeResultBytes(Buffer.from(match[1]!, 'base64'));
}

function validateRelayMeResultBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_RELAYME_RESULT_BYTES) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'RelayMe 生成结果大小无效');
  }
  return bytes;
}

function detectRelayMeGeneratedMediaType(bytes: Uint8Array): RelayMeGeneratedMediaType {
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 16));
  if (header.length >= 12 && header.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4';
  if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (header.subarray(0, 6).toString('ascii') === 'GIF87a' || header.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'RelayMe 返回了不受支持的生成结果格式');
}

function parseSafeRelayMeResultUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'RelayMe 返回了无效的生成结果地址');
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '').replace(/^\[|\]$/gu, '');
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || isIP(hostname) !== 0
  ) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'RelayMe 返回了无效的生成结果地址');
  }
  return url;
}

function isPublicRelayMeResultAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 4) return isPublicRelayMeIpv4Address(address);
  return !relayMeResultAddressBlockList.check(address, 'ipv6');
}

function createRelayMeResultAddressBlockList(): BlockList {
  const blockList = new BlockList();
  for (const [address, prefix] of [
    ['::', 96], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
    ['fc00::', 7], ['fec0::', 10], ['fe80::', 10], ['ff00::', 8],
  ] as const) blockList.addSubnet(address, prefix, 'ipv6');
  return blockList;
}

function isPublicRelayMeIpv4Address(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [first, second, third] = octets as [number, number, number, number];
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && (second === 0 || second === 168)) return false;
  if (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100))) return false;
  if (first === 203 && second === 0 && third === 113) return false;
  return true;
}
function extractChatText(content: unknown): string | null {
  if (typeof content === 'string' && content.trim().length > 0) return content.trim();
  if (Array.isArray(content)) {
    const text = content.flatMap((item) => {
      const extracted = extractChatText(item);
      return extracted === null ? [] : [extracted];
    }).join('\n').trim();
    return text.length > 0 ? text : null;
  }
  if (isPlainRecord(content)) {
    for (const field of ['text', 'output_text', 'value', 'parts', 'content'] as const) {
      const extracted = extractChatText(content[field]);
      if (extracted !== null) return extracted;
    }
  }
  return null;
}

async function translateRelayMeCall<T>(call: () => Promise<T>, fallback: string): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw translateRelayMeError(error, fallback);
  }
}

function translateRelayMeLoginError(error: unknown): ProviderBridgeException {
  const rawCode = error !== null && typeof error === 'object' && 'code' in error && typeof (error as { readonly code?: unknown }).code === 'string'
    ? (error as { readonly code: string }).code
    : '';
  const rawMessage = error !== null && typeof error === 'object' && 'message' in error && typeof (error as { readonly message?: unknown }).message === 'string'
    ? (error as { readonly message: string }).message
    : error instanceof Error ? error.message : String(error ?? '');
  if (rawCode === 'INVALID_CREDENTIALS' || /username or password is invalid|用户名或密码错误/iu.test(rawMessage)) {
    return createProviderBridgeError('CREDENTIALS_LOCKED', 'RelayMe 账号或密码错误');
  }
  if (rawCode === 'ACCOUNT_RESTRICTED' || /account.*(?:restricted|disabled|locked|suspended)|账号|账户.*(?:受限|禁用|锁定|停用)/iu.test(rawMessage)) {
    return createProviderBridgeError('PROVIDER_UNAVAILABLE', 'RelayMe 账号已受限，请前往工作台确认账号状态');
  }
  if (rawCode === 'NETWORK_ERROR') {
    return createProviderBridgeError('PROVIDER_ERROR', 'RelayMe 登录网络请求失败，请检查网络后重试', true);
  }
  if (rawCode === 'SERVICE_UNAVAILABLE') {
    return createProviderBridgeError('PROVIDER_UNAVAILABLE', 'RelayMe 登录服务暂时不可用，请稍后重试', true);
  }
  if (rawCode === 'TOKEN_MISSING') {
    return createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'RelayMe 登录响应缺少有效令牌，请联系 RelayMe 检查接口');
  }
  if (rawCode === 'INVALID_RESPONSE') {
    return createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'RelayMe 登录响应格式无效，请稍后重试');
  }
  if (rawCode === 'CROSS_ORIGIN_REDIRECT') {
    return createProviderBridgeError('PROVIDER_UNAVAILABLE', 'RelayMe 登录被重定向到非官方地址，已停止登录');
  }
  if (rawCode === 'INVALID_REQUEST' || rawCode === 'INVALID_BASE_URL') {
    return createProviderBridgeError('INVALID_REQUEST', rawMessage);
  }
  if (isProviderBridgeException(error)) {
    return createProviderBridgeError(error.code, error.message, error.retryable);
  }
  return translateRelayMeError(error, 'RelayMe 登录失败，请检查账号和密码');
}

function translateRelayMeWebLoginError(error: unknown): ProviderBridgeException {
  const rawCode = error !== null && typeof error === 'object' && 'code' in error
    && typeof (error as { readonly code?: unknown }).code === 'string'
    ? (error as { readonly code: string }).code
    : '';
  const rawMessage = error instanceof Error ? error.message : '';
  if (rawCode === 'WEB_LOGIN_CANCELLED' || rawMessage === 'RelayMe 网页登录已取消') {
    return createProviderBridgeError('WEB_LOGIN_CANCELLED', 'RelayMe 网页登录已取消');
  }
  if (rawCode === 'WEB_LOGIN_TIMEOUT' || rawMessage === 'RelayMe 网页登录超时，请重试') {
    return createProviderBridgeError('WEB_LOGIN_TIMEOUT', 'RelayMe 网页登录超时，请重试', true);
  }
  if (rawCode === 'PROVIDER_INVALID_RESPONSE') {
    return createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'RelayMe 网页登录未返回有效会话');
  }
  if (rawCode === 'PROVIDER_UNAVAILABLE' || rawCode === 'CROSS_ORIGIN_REDIRECT') {
    return createProviderBridgeError('PROVIDER_UNAVAILABLE', 'RelayMe 网页登录服务暂时不可用，请稍后重试', true);
  }
  const retryable = error !== null && typeof error === 'object' && 'retryable' in error
    && (error as { readonly retryable?: unknown }).retryable === true;
  return createProviderBridgeError('PROVIDER_ERROR', 'RelayMe 网页登录失败，请重试', retryable);
}

function isBoundedRelayMeLoginToken(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 16_384
    && value === value.trim();
}

function translateRelayMeError(error: unknown, fallback: string): ProviderBridgeException {
  if (isProviderBridgeException(error)) return error;
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/\b(?:401|403)\b/u.test(message)) {
    return createProviderBridgeError('CREDENTIALS_LOCKED', 'RelayMe 登录已失效，请重新登录', true);
  }
  if (/quota|额度|余额|rate[ -]?limit|too many requests|\b429\b/iu.test(message)) {
    return createProviderBridgeError('PROVIDER_ERROR', 'RelayMe 当前额度或请求频率受限，请稍后重试', true);
  }
  if (/响应格式|invalid.*response/iu.test(message)) {
    return createProviderBridgeError('PROVIDER_INVALID_RESPONSE', fallback);
  }
  if (/unsupported|not supported|不支持|model.*(?:invalid|not found|不存在)|模型.*(?:不可用|不存在)/iu.test(message)) {
    return createProviderBridgeError('CAPABILITY_UNSUPPORTED', 'RelayMe 当前模型不支持此生图能力');
  }
  if (/timed out|timeout|network|fetch/iu.test(message)) return createProviderBridgeError('PROVIDER_ERROR', `${fallback}，请检查网络后重试`, true);
  return createProviderBridgeError('PROVIDER_ERROR', fallback, false);
}

function sanitizeProfiles(profiles: readonly ProviderBridgeProfile[]) {
  return parseProviderBridgeProfiles(profiles
    .filter((profile) => profile.provider === 'relayme')
    .map((profile) => ({ ...profile, capabilityStatus: 'complete' as const })));
}

function mergeDiscoveredModelProfiles(profiles: readonly ProviderBridgeProfile[]): ProviderBridgeProfile[] {
  const merged = new Map<string, ProviderBridgeProfile>();
  for (const profile of profiles) {
    const key = `${profile.provider}:${profile.modelId ?? profile.modelRoute}`.toLocaleLowerCase();
    const current = merged.get(key);
    if (current === undefined) {
      merged.set(key, cloneProfile(profile));
      continue;
    }
    const preferred = current.capabilityStatus === 'complete' || profile.capabilityStatus !== 'complete' ? current : profile;
    const secondary = preferred === current ? profile : current;
    merged.set(key, cloneProfile({
      ...secondary,
      ...preferred,
      capabilities: [...new Set([...preferred.capabilities, ...secondary.capabilities])],
      constraints: preferred.constraints ?? secondary.constraints,
    }));
  }
  return [...merged.values()];
}

function mergeProfiles(discovered: readonly ProviderBridgeProfile[], configured: readonly ProviderBridgeProfile[]) {
  const configuredByModel = new Map(configured.map((profile) => [profile.modelId ?? profile.modelRoute, profile]));
  return discovered.map((profile) => {
    const override = configuredByModel.get(profile.modelId ?? profile.modelRoute);
    return override === undefined ? cloneProfile(profile) : cloneProfile({ ...profile, modelRoute: override.modelRoute, displayName: override.displayName });
  });
}

function cloneConfiguration(value: ConfigurationSnapshot): ConfigurationSnapshot {
  return { baseUrl: value.baseUrl, profiles: value.profiles.map(cloneProfile) };
}

function cloneProfile(profile: ProviderBridgeProfile): ProviderBridgeProfile {
  return cloneProviderProfile(profile);
}

function assertRelayMeProvider(provider: string): asserts provider is 'relayme' {
  if (provider !== 'relayme') throw createProviderBridgeError('INVALID_REQUEST', 'RelayMe 服务收到错误的供应商请求');
}

function isCapabilityUnsupported(value: unknown): value is { readonly code: 'CAPABILITY_UNSUPPORTED' } {
  return isRecord(value) && value.code === 'CAPABILITY_UNSUPPORTED';
}

function isProviderBridgeException(value: unknown): value is ProviderBridgeException {
  return value instanceof Error && isRecord(value) && typeof value.code === 'string' && typeof value.retryable === 'boolean';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
