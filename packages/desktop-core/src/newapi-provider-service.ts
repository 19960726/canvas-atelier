import { randomBytes } from 'node:crypto';

import {
  createNewApiClient,
  type NewApiFetch,
  type NewApiGeneratedImage,
} from './newapi-client.js';
import {
  buildAuthenticatedNewApiCatalog,
  isAudited4daiGeminiImageModel,
  type NewApiModelProfile,
  type NewApiProviderId,
} from './newapi-model-catalog.js';
import { NEW_API_PROVIDER_SEEDS } from './newapi-provider-seeds.js';
import { deriveGenerationHistoryId, type GenerationHistoryProviderSinkContract } from './generation-history-provider-sink.js';
import { isPublicProviderAddress, parseSafeProviderResultUrl } from './provider-result-security.js';
import type { ProviderTaskMappingStore } from './provider-task-ledger.js';
import type { ProviderService } from './provider-service-types.js';
import type {
  AnalyzeReversePromptBridgeRequest,
  AnalyzeReversePromptBridgeResult,
  ProviderBridgeProfile,
  ProviderBridgeErrorCode,
  ProviderConfigurationStatus,
} from './provider-contracts.js';
import { buildProfessionalReverseRequest } from './professional-reverse-analysis.js';
import { parseReverseProviderResponse } from './reverse-provider-response.js';

type ImageAspectRatio = '1:1' | '2:3' | '3:2' | '4:3' | '3:4' | '16:9' | '9:16';
type ImageResolution = '1K' | '2K' | '4K';

export interface NewApiServiceConfigurationStore {
  read(fallback: { readonly baseUrl: string; readonly profiles: readonly ProviderBridgeProfile[] }): Promise<{ readonly baseUrl: string; readonly profiles: readonly ProviderBridgeProfile[] }>;
  write(snapshot: { readonly baseUrl: string; readonly profiles: readonly ProviderBridgeProfile[] }): Promise<void>;
}

export interface NewApiServiceTaskStore {
  read(publicTaskId: string): Promise<NewApiPrivateTask | undefined>;
  write(publicTaskId: string, task: NewApiPrivateTask): Promise<void>;
  delete(publicTaskId: string): Promise<void>;
}

type TerminalImageTask = { readonly kind: 'image'; readonly state: 'completed'; readonly assetId: string; readonly historyId?: string };
type TerminalVideoTask = { readonly kind: 'video'; readonly state: 'completed'; readonly assetId: string; readonly historyId?: string };
type NewApiPrivateTask =
  | TerminalImageTask
  | TerminalVideoTask
  | { readonly kind: 'image'; readonly state: 'remote'; readonly rawTaskId: string; readonly sessionId: string; readonly historyId?: string }
  | { readonly kind: 'video'; readonly state: 'remote'; readonly rawTaskId: string; readonly sessionId: string; readonly historyId?: string }
  | { readonly kind: 'image' | 'video'; readonly state: 'cancelled'; readonly historyId?: string }
  | { readonly kind: 'image' | 'video'; readonly state: 'failed'; readonly code?: ProviderBridgeErrorCode; readonly message: string; readonly retryable: boolean; readonly historyId?: string };

export interface NewApiProviderService {
  revealCredential(): Promise<{ readonly token: string }>;
  configure(request: { readonly provider?: NewApiProviderId; readonly token?: string; readonly passphrase?: string; readonly baseUrl?: string }): Promise<ProviderConfigurationStatus>;
  updateProfiles(request: { readonly provider?: NewApiProviderId; readonly profiles: readonly NewApiModelProfile[] }): Promise<ProviderConfigurationStatus>;
  unlock(request: { readonly provider?: NewApiProviderId; readonly passphrase: string }): Promise<ProviderConfigurationStatus>;
  getStatus(): Promise<ProviderConfigurationStatus>;
  checkConnection(): Promise<{ checkedAt: string; status: 'connected' | 'unconfigured' | 'authentication_failed' | 'network_unavailable' | 'service_limited' }>;
  refreshCatalog(): Promise<NewApiModelProfile[]>;
  listAvailableModelIds(): Promise<string[]>;
  listProfiles(): Promise<NewApiModelProfile[]>;
  submitImageJob(request: NewApiImageJobRequest): Promise<{ providerTaskId: string }>;
  pollImageJob(request: NewApiTaskRequest): Promise<NewApiImagePollResult>;
  cancelImageJob(request: NewApiTaskRequest): Promise<NewApiImagePollResult>;
  ackImageJobTerminal(request: NewApiTaskRequest): Promise<{ acknowledged: true }>;
  submitVideoJob(request: NewApiVideoJobRequest): Promise<{ providerTaskId: string }>;
  pollVideoJob(request: NewApiTaskRequest): Promise<NewApiVideoPollResult>;
  cancelVideoJob(request: NewApiTaskRequest): Promise<NewApiVideoPollResult>;
  ackVideoJobTerminal(request: NewApiTaskRequest): Promise<{ acknowledged: true }>;
  chat(request: {
    readonly provider: NewApiProviderId;
    readonly modelRoute: string;
    readonly sessionId?: string;
    readonly referenceAssetIds?: readonly string[];
    readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[];
  }): Promise<{ readonly message: string; readonly modelRoute: string; readonly sources: readonly [] }>;
  analyzeReversePrompt(request: AnalyzeReversePromptBridgeRequest): Promise<AnalyzeReversePromptBridgeResult>;
}

export type ProviderCompatibleNewApiService = NewApiProviderService & ProviderService;

interface NewApiImageJobRequest {
  readonly jobId?: string;
  readonly provider: NewApiProviderId;
  readonly modelRoute: string;
  readonly prompt: string;
  readonly sessionId?: string;
  readonly referenceAssetIds: readonly string[];
  readonly aspectRatio?: ImageAspectRatio;
  readonly resolution?: ImageResolution;
  readonly quality?: 'low' | 'medium' | 'high';
  readonly outputCount?: 1 | 2 | 3 | 4;
}
interface NewApiVideoJobRequest {
  readonly jobId?: string;
  readonly provider: NewApiProviderId;
  readonly modelRoute: string;
  readonly prompt: string;
  readonly sessionId?: string;
  readonly referenceAssetIds: readonly string[];
  readonly aspectRatio?: ImageAspectRatio;
  readonly resolution?: '360p' | '480p' | '512p' | '540p' | '720p' | '768p' | '1080p' | '2K' | '4K';
  readonly durationSeconds?: number;
  readonly outputCount?: 1 | 2 | 3 | 4;
}
interface NewApiTaskRequest { readonly provider: NewApiProviderId; readonly providerTaskId: string }
type NewApiImagePollResult =
  | { readonly status: 'running'; readonly progress?: number }
  | { readonly status: 'completed'; readonly progress: 1; readonly result: { readonly assetId: string; readonly assetIds: readonly string[] } }
  | { readonly status: 'failed'; readonly error: ReturnType<typeof serviceError> }
  | { readonly status: 'cancelled' };
type NewApiVideoPollResult =
  | { readonly status: 'running'; readonly progress?: number }
  | { readonly status: 'completed'; readonly progress: 1; readonly result: { readonly assetId: string } }
  | { readonly status: 'failed'; readonly error: ReturnType<typeof serviceError> }
  | { readonly status: 'cancelled' };

export function createNewApiProviderService(options: {
  readonly provider: NewApiProviderId;
  readonly credentialStore: {
    configure(request: { token: string; passphrase?: string }): Promise<void>;
    unlock(request: { passphrase: string }): Promise<void>;
    getStatus(): Promise<{ configured: boolean; locked: boolean; encryption: 'safeStorage' | 'passphrase' | 'unavailable' }>;
    getPrimaryToken(): Promise<string>;
  };
  readonly configurationStore: NewApiServiceConfigurationStore;
  readonly fetch: NewApiFetch;
  readonly taskStore?: NewApiServiceTaskStore;
  readonly providerTaskMappings?: ProviderTaskMappingStore;
  readonly historySink?: GenerationHistoryProviderSinkContract;
  readonly verifiedVisionModelIds?: readonly string[];
  readonly storeGeneratedImage?: (sessionId: string, bytes: Uint8Array, mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp') => Promise<string | { readonly assetId: string }>;
  readonly storeGeneratedVideo?: (sessionId: string, bytes: Uint8Array, mediaType: 'video/mp4') => Promise<string | { readonly assetId: string }>;
  readonly resolveResultHost?: (hostname: string) => Promise<readonly string[]>;
  readonly readReferenceImage?: (sessionId: string, assetId: string) => Promise<{ readonly bytes: Uint8Array; readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' }>;
  readonly readManagedReverseMedia?: (
    sessionId: string,
    media: AnalyzeReversePromptBridgeRequest['media'],
  ) => Promise<readonly { readonly bytes: Uint8Array; readonly mediaType: string }[]>;
  readonly resolveReverseKnowledge?: (request: AnalyzeReversePromptBridgeRequest) => Promise<unknown>;
  readonly now?: () => Date;
}): ProviderCompatibleNewApiService {
  const tasks = options.taskStore
    ?? (options.providerTaskMappings === undefined
      ? memoryTaskStore()
      : ledgerTaskStore(options.providerTaskMappings, options.provider, options.now ?? (() => new Date())));
  let accessibleModelIds: readonly string[] = [];
  let discoveredProfiles: readonly NewApiModelProfile[] | null = null;
  const fallbackConfiguration = {
    baseUrl: options.provider === 'julun' ? 'https://julun.cc/v1' : 'https://api.4dai.cc/v1',
    profiles: NEW_API_PROVIDER_SEEDS[options.provider],
  };
  const readConfiguration = async () => {
    const snapshot = await options.configurationStore.read(fallbackConfiguration);
    return {
      baseUrl: snapshot.baseUrl,
      profiles: snapshot.profiles.map((profile) => parseStoredNewApiProfile(profile, options.provider)),
    };
  };
  const getClient = async () => {
    const configuration = await readConfiguration();
    return createNewApiClient({
      provider: options.provider,
      apiBaseUrl: configuration.baseUrl,
      tokenSupplier: () => options.credentialStore.getPrimaryToken(),
      fetch: options.fetch,
    });
  };
  const getConfigurationStatus = async (): Promise<ProviderConfigurationStatus> => {
    const configuration = await readConfiguration();
    return { ...(await options.credentialStore.getStatus()), baseUrl: configuration.baseUrl };
  };

  const service: NewApiProviderService = {
    getStatus: getConfigurationStatus,
    async revealCredential() {
      return { token: await options.credentialStore.getPrimaryToken() };
    },
    async configure(request) {
      if (request.provider !== undefined) assertProvider(request.provider, options.provider);
      if (request.token !== undefined) {
        await options.credentialStore.configure({
          token: request.token,
          ...(request.passphrase === undefined ? {} : { passphrase: request.passphrase }),
        });
      }
      if (request.baseUrl !== undefined) {
        createNewApiClient({
          provider: options.provider,
          apiBaseUrl: request.baseUrl,
          tokenSupplier: () => options.credentialStore.getPrimaryToken(),
          fetch: options.fetch,
        });
        const current = await readConfiguration();
        await options.configurationStore.write({ baseUrl: request.baseUrl, profiles: current.profiles });
      }
      return getConfigurationStatus();
    },
    async updateProfiles(request) {
      if (request.provider !== undefined) assertProvider(request.provider, options.provider);
      const status = await options.credentialStore.getStatus();
      if (!status.configured || status.locked) {
        throw serviceError(
          status.locked ? 'CREDENTIALS_LOCKED' : 'PROVIDER_UNAVAILABLE',
          'Configure and unlock the provider before saving model routes',
          false,
        );
      }
      const current = await readConfiguration();
      const verifiedByRoute = new Map((discoveredProfiles ?? current.profiles)
        .map((profile) => [profile.modelRoute, profile]));
      const selected = request.profiles.map((requested) => {
        const verified = verifiedByRoute.get(requested.modelRoute);
        if (
          requested.provider !== options.provider
          || verified?.provider !== options.provider
          || verified.capabilityStatus !== 'complete'
        ) {
          throw capabilityError('Selected model is not verified for this provider');
        }
        return verified;
      });
      await options.configurationStore.write({ baseUrl: current.baseUrl, profiles: selected });
      return getConfigurationStatus();
    },
    async unlock(request) {
      if (request.provider !== undefined) assertProvider(request.provider, options.provider);
      await options.credentialStore.unlock({ passphrase: request.passphrase });
      return getConfigurationStatus();
    },
    async checkConnection() {
      const status = await options.credentialStore.getStatus();
      if (!status.configured) return { checkedAt: (options.now ?? (() => new Date()))().toISOString(), status: 'unconfigured' };
      if (status.locked) return { checkedAt: (options.now ?? (() => new Date()))().toISOString(), status: 'service_limited' };
      try {
        await service.refreshCatalog();
        return { checkedAt: (options.now ?? (() => new Date()))().toISOString(), status: 'connected' };
      } catch (error) {
        const statusCode = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 0;
        return {
          checkedAt: (options.now ?? (() => new Date()))().toISOString(),
          status: statusCode === 401 || statusCode === 403 ? 'authentication_failed' : statusCode === 429 ? 'service_limited' : 'network_unavailable',
        };
      }
    },
    async refreshCatalog() {
      const client = await getClient();
      const modelIds = await client.listModelIds();
      const pricing = await client.listPublicPricing();
      accessibleModelIds = modelIds;
      const current = await readConfiguration();
      const profiles = buildAuthenticatedNewApiCatalog({
        provider: options.provider,
        accessibleModelIds: modelIds,
        pricing,
        verifiedVisionModelIds: options.verifiedVisionModelIds,
        persistedProfiles: current.profiles,
      });
      const selectedProfiles = current.profiles.length === 0
        ? profiles
        : selectRefreshedProfiles(profiles, current.profiles);
      await options.configurationStore.write({ baseUrl: current.baseUrl, profiles: selectedProfiles });
      discoveredProfiles = profiles;
      return markSelectedProfiles(profiles, selectedProfiles);
    },
    async listAvailableModelIds() {
      if (accessibleModelIds.length > 0) return [...accessibleModelIds];
      return (await service.refreshCatalog()).map((profile) => profile.modelId);
    },
    async listProfiles() {
      const current = await readConfiguration();
      return discoveredProfiles === null
        ? [...current.profiles]
        : markSelectedProfiles(discoveredProfiles, current.profiles);
    },
    async submitImageJob(request) {
      assertProvider(request.provider, options.provider);
      if (options.provider !== '4dai') throw capabilityError('Julun only supports video generation');
      if ((request.outputCount ?? 1) !== 1) throw capabilityError('4D image generation currently submits one output per task');
      const profile = await assertRunnableProfile(readConfiguration, request.modelRoute, 'image_generation');
      const usesGeminiNativeImage = isAudited4daiGeminiImageModel(profile.modelId);
      if (request.referenceAssetIds.length > 0 && (!usesGeminiNativeImage || !profile.capabilities.includes('image_edit'))) {
        throw capabilityError('Selected 4D image model does not support managed reference images');
      }
      if (request.referenceAssetIds.length > 14) throw capabilityError('4D Nano Banana accepts at most 14 reference images');
      const aspectRatio = request.aspectRatio ?? '1:1';
      const profileResolutions = profile.constraints?.image?.resolutions;
      const resolution = request.resolution ?? (profileResolutions?.length === 1 ? profileResolutions[0]! : '1K');
      assertProfileAllowsImageRequest(profile, aspectRatio, resolution);
      if (!usesGeminiNativeImage) assertSupportedOpenAiImageRequest(profile.modelId, aspectRatio, resolution);
      if (request.sessionId === undefined) throw invalidRequest('Image generation requires a project session');
      const references = usesGeminiNativeImage
        ? await Promise.all(request.referenceAssetIds.map((assetId) => requireReference(options, request.sessionId!, assetId)))
        : [];
      const verifiedImageModelIds = usesGeminiNativeImage
        ? []
        : (discoveredProfiles ?? [])
          .filter((candidate) => candidate.capabilityStatus === 'complete' && candidate.capabilities.includes('image_generation'))
          .map((candidate) => candidate.modelId);
      const model = usesGeminiNativeImage
        ? profile.modelId
        : select4daiGptImageModel(profile.modelId, resolution, verifiedImageModelIds);
      const size = usesGeminiNativeImage ? undefined : mapOpenAiImageSize(model, aspectRatio, resolution);
      const submission = await prepareSubmission(options, request.jobId, 'image', profile.displayName);
      if (submission.existingPublicTaskId !== undefined) return { providerTaskId: submission.existingPublicTaskId };
      const historyId = submission.historyId;
      try {
        await notifyHistory(options.historySink, (sink) => historyId === undefined ? undefined : sink.running(historyId));
        const client = await getClient();
        const generated = usesGeminiNativeImage
          ? await client.generateGeminiImage({
            model,
            prompt: request.prompt,
            aspectRatio,
            imageSize: resolution,
            ...(references.length === 0 ? {} : { references }),
          })
          : await client.generateImage({
            model,
            prompt: request.prompt,
            n: 1,
            ...(request.quality === undefined ? {} : { quality: request.quality }),
            ...(size === undefined ? {} : { size }),
          });
        const publicTaskId = createPublicTaskId();
        if (generated.kind === 'remote') {
          await tasks.write(publicTaskId, {
            kind: 'image', state: 'remote', rawTaskId: generated.url, sessionId: request.sessionId,
            ...(historyId === undefined ? {} : { historyId }),
          });
          return { providerTaskId: publicTaskId };
        }
        const stored = await storeImage(generated, request.sessionId, options);
        await tasks.write(publicTaskId, { kind: 'image', state: 'completed', assetId: stored.assetId, ...(historyId === undefined ? {} : { historyId }) });
        await notifyHistory(options.historySink, (sink) => historyId === undefined ? undefined : sink.succeeded(historyId, stored.bytes));
        return { providerTaskId: publicTaskId };
      } catch (error) {
        await notifyHistory(options.historySink, (sink) => historyId === undefined ? undefined : sink.failed(historyId, 'provider_failed'));
        throw error;
      }
    },
    async pollImageJob(request) {
      assertProvider(request.provider, options.provider);
      const task = await requireTask(tasks, request.providerTaskId, 'image');
      if (task.state !== 'remote') return imagePoll(task);
      try {
        const stored = await storeImage({ kind: 'remote', url: task.rawTaskId }, task.sessionId, options);
        const completed = {
          kind: 'image', state: 'completed', assetId: stored.assetId,
          ...(task.historyId === undefined ? {} : { historyId: task.historyId }),
        } as const;
        await tasks.write(request.providerTaskId, completed);
        await notifyHistory(options.historySink, (sink) => task.historyId === undefined ? undefined : sink.succeeded(task.historyId, stored.bytes));
        return imagePoll(completed);
      } catch (error) {
        const normalized = normalizeImageServiceFailure(error);
        if (normalized.retryable) return { status: 'running' };
        const failed = {
          kind: 'image', state: 'failed', code: normalized.code, message: normalized.message, retryable: false,
          ...(task.historyId === undefined ? {} : { historyId: task.historyId }),
        } as const;
        await tasks.write(request.providerTaskId, failed);
        await notifyHistory(options.historySink, (sink) => task.historyId === undefined
          ? undefined
          : sink.failed(task.historyId, normalized.code === 'PROVIDER_INVALID_RESPONSE' ? 'invalid_result' : 'provider_failed'));
        return imagePoll(failed);
      }
    },
    async cancelImageJob(request) {
      assertProvider(request.provider, options.provider);
      const task = await requireTask(tasks, request.providerTaskId, 'image');
      if (task.state === 'completed' || task.state === 'failed' || task.state === 'cancelled') return imagePoll(task);
      const cancelled = {
        kind: 'image', state: 'cancelled', ...(task.historyId === undefined ? {} : { historyId: task.historyId }),
      } as const;
      await tasks.write(request.providerTaskId, cancelled);
      await notifyHistory(options.historySink, (sink) => task.historyId === undefined ? undefined : sink.cancelled(task.historyId, 'cancelled_by_user'));
      return imagePoll(cancelled);
    },
    async ackImageJobTerminal(request) {
      assertProvider(request.provider, options.provider);
      await requireTask(tasks, request.providerTaskId, 'image');
      await tasks.delete(request.providerTaskId);
      return { acknowledged: true };
    },
    async submitVideoJob(request) {
      assertProvider(request.provider, options.provider);
      if (options.provider !== 'julun') throw capabilityError('4D video generation is disabled');
      if ((request.outputCount ?? 1) !== 1) throw capabilityError('Julun video generation currently submits one output per task');
      const profile = await assertRunnableProfile(readConfiguration, request.modelRoute, 'video_generation');
      if (request.sessionId === undefined) throw invalidRequest('Video generation requires a project session');
      if (request.referenceAssetIds.length > 1) throw capabilityError('Julun accepts one input reference');
      const inputReference = request.referenceAssetIds[0] === undefined
        ? undefined
        : await requireReference(options, request.sessionId, request.referenceAssetIds[0]);
      const submission = await prepareSubmission(options, request.jobId, 'video', profile.displayName);
      if (submission.existingPublicTaskId !== undefined) return { providerTaskId: submission.existingPublicTaskId };
      const historyId = submission.historyId;
      try {
        const [width, height] = mapNewApiVideoSize(request.aspectRatio ?? '16:9', request.resolution ?? '720p').split('x').map(Number) as [number, number];
        const remote = await (await getClient()).createVideo({
          model: profile.modelId,
          prompt: request.prompt,
          duration: request.durationSeconds ?? 10,
          width,
          height,
          ...(inputReference === undefined ? {} : { inputReference }),
        });
        const publicTaskId = createPublicTaskId();
        await tasks.write(publicTaskId, { kind: 'video', state: 'remote', rawTaskId: remote.id, sessionId: request.sessionId, ...(historyId === undefined ? {} : { historyId }) });
        await notifyHistory(options.historySink, (sink) => historyId === undefined ? undefined : sink.running(historyId));
        return { providerTaskId: publicTaskId };
      } catch (error) {
        await notifyHistory(options.historySink, (sink) => historyId === undefined ? undefined : sink.failed(historyId, 'provider_failed'));
        throw error;
      }
    },
    async pollVideoJob(request) {
      assertProvider(request.provider, options.provider);
      const task = await requireTask(tasks, request.providerTaskId, 'video');
      if (task.state !== 'remote') return videoPoll(task);
      const client = await getClient();
      const remote = await client.getVideo(task.rawTaskId);
      if (isRemoteCompleted(remote.status)) {
        try {
          if (options.storeGeneratedVideo === undefined) throw invalidRequest('Generated video storage is unavailable');
          const bytes = await client.getVideoContent(task.rawTaskId);
          assertMp4(bytes);
          const stored = await options.storeGeneratedVideo(task.sessionId, bytes, 'video/mp4');
          const completed = {
            kind: 'video', state: 'completed', assetId: typeof stored === 'string' ? stored : stored.assetId,
            ...(task.historyId === undefined ? {} : { historyId: task.historyId }),
          } as const;
          await tasks.write(request.providerTaskId, completed);
          await notifyHistory(options.historySink, (sink) => task.historyId === undefined ? undefined : sink.succeeded(task.historyId, bytes));
          return videoPoll(completed);
        } catch (error) {
          const normalized = normalizeServiceFailure(error);
          if (normalized.retryable) throw error;
          const failed = {
            kind: 'video', state: 'failed', code: normalized.code, message: normalized.message, retryable: false,
            ...(task.historyId === undefined ? {} : { historyId: task.historyId }),
          } as const;
          await tasks.write(request.providerTaskId, failed);
          await notifyHistory(options.historySink, (sink) => task.historyId === undefined
            ? undefined
            : sink.failed(task.historyId, normalized.code === 'PROVIDER_INVALID_RESPONSE' ? 'invalid_result' : 'provider_failed'));
          return videoPoll(failed);
        }
      }
      if (isRemoteCancelled(remote.status)) {
        const cancelled = {
          kind: 'video', state: 'cancelled', ...(task.historyId === undefined ? {} : { historyId: task.historyId }),
        } as const;
        await tasks.write(request.providerTaskId, cancelled);
        await notifyHistory(options.historySink, (sink) => task.historyId === undefined
          ? undefined
          : sink.cancelled(task.historyId, 'cancelled_by_system'));
        return videoPoll(cancelled);
      }
      if (isRemoteFailed(remote.status)) {
        const failed = {
          kind: 'video', state: 'failed', code: 'PROVIDER_ERROR', message: 'Julun video generation failed', retryable: false,
          ...(task.historyId === undefined ? {} : { historyId: task.historyId }),
        } as const;
        await tasks.write(request.providerTaskId, failed);
        await notifyHistory(options.historySink, (sink) => task.historyId === undefined ? undefined : sink.failed(task.historyId, 'provider_failed'));
        return videoPoll(failed);
      }
      return { status: 'running', ...(remote.progress === undefined ? {} : { progress: normalizeProgress(remote.progress) }) };
    },
    async cancelVideoJob(request) {
      assertProvider(request.provider, options.provider);
      const task = await requireTask(tasks, request.providerTaskId, 'video');
      if (task.state === 'completed' || task.state === 'failed' || task.state === 'cancelled') return videoPoll(task);
      const cancelled = {
        kind: 'video', state: 'cancelled', ...(task.historyId === undefined ? {} : { historyId: task.historyId }),
      } as const;
      await tasks.write(request.providerTaskId, cancelled);
      await notifyHistory(options.historySink, (sink) => task.historyId === undefined ? undefined : sink.cancelled(task.historyId, 'cancelled_by_user'));
      return videoPoll(cancelled);
    },
    async ackVideoJobTerminal(request) {
      assertProvider(request.provider, options.provider);
      await requireTask(tasks, request.providerTaskId, 'video');
      await tasks.delete(request.providerTaskId);
      return { acknowledged: true };
    },
    async chat(request) {
      assertProvider(request.provider, options.provider);
      if (options.provider !== '4dai') throw capabilityError('Julun does not support chat');
      const referenceAssetIds = request.referenceAssetIds ?? [];
      const requiredCapability = referenceAssetIds.length > 0 ? 'vision' : 'chat';
      const profile = await assertRunnableProfile(readConfiguration, request.modelRoute, requiredCapability);
      if (request.messages.length === 0) throw invalidRequest('Chat requires at least one message');
      const messages: unknown[] = request.messages.map((message) => ({ ...message }));
      if (referenceAssetIds.length > 0) {
        if (request.sessionId === undefined) throw invalidRequest('Visual chat requires a project session');
        if (options.readReferenceImage === undefined) throw invalidRequest('Reference image storage is unavailable');
        const images = await Promise.all(referenceAssetIds.map((assetId) => options.readReferenceImage!(request.sessionId!, assetId)));
        const lastUserIndex = messages.map((entry) => (entry as { role: string }).role).lastIndexOf('user');
        if (lastUserIndex < 0) throw invalidRequest('Visual chat requires a user message');
        const user = messages[lastUserIndex] as { role: 'user'; content: string };
        messages[lastUserIndex] = {
          role: 'user',
          content: [
            { type: 'text', text: user.content },
            ...images.map((image) => ({
              type: 'image_url',
              image_url: { url: `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString('base64')}` },
            })),
          ],
        };
      }
      const message = await (await getClient()).createChatCompletion({ model: profile.modelId, messages });
      return { message, modelRoute: request.modelRoute, sources: [] };
    },
    async analyzeReversePrompt(request) {
      assertProvider(request.provider, options.provider);
      if (options.provider !== '4dai') throw capabilityError('Julun does not support reverse prompting');
      const modelRoute = request.run.agentConfig?.modelRoute ?? '';
      const profile = await assertRunnableProfile(readConfiguration, modelRoute, 'reverse_prompt');
      if (!profile.capabilities.includes('chat')) {
        throw capabilityError('4D reverse prompting requires a verified chat-completions model');
      }
      if (request.run.orderedMedia.some((item) => item.kind === 'video')) {
        throw capabilityError('4D video reverse prompting is not verified');
      }
      if (options.readManagedReverseMedia === undefined) throw invalidRequest('Managed reverse media is unavailable');
      const media = await options.readManagedReverseMedia(request.sessionId, request.media);
      const knowledge = options.resolveReverseKnowledge === undefined ? [] : await options.resolveReverseKnowledge(request);
      const text = await (await getClient()).createChatCompletion({
        model: profile.modelId,
        messages: [
          { role: 'system', content: 'Return only valid ReversePromptResult JSON.' },
          {
            role: 'user',
            content: [
              { type: 'text', text: JSON.stringify(buildProfessionalReverseRequest(request.run, knowledge)) },
              ...media.map((item) => ({
                type: 'image_url',
                image_url: { url: `data:${item.mediaType};base64,${Buffer.from(item.bytes).toString('base64')}` },
              })),
            ],
          },
        ],
      });
      return parseReverseProviderResponse({ text }, request.run);
    },
  };
  return service as ProviderCompatibleNewApiService;
}

export function select4daiGptImageModel(
  selectedModel: string,
  resolution: ImageResolution,
  accessibleModelIds: readonly string[],
): string {
  if (!/^gpt-image-2(?:-(?:2k|4k))?$/iu.test(selectedModel)) return selectedModel;
  const suffix = resolution === '2K' ? '-2k' : resolution === '4K' ? '-4k' : '';
  if (suffix === '') return selectedModel;
  const candidate = `gpt-image-2${suffix}`;
  return accessibleModelIds.includes(candidate) ? candidate : selectedModel;
}

export function mapGptImage2ExactSize(aspectRatio: ImageAspectRatio, resolution: ImageResolution): string {
  if (aspectRatio === '16:9' && resolution === '2K') return '2560x1440';
  if (aspectRatio === '16:9' && resolution === '4K') return '3824x2144';
  if (aspectRatio === '9:16' && resolution === '2K') return '1440x2560';
  if (aspectRatio === '9:16' && resolution === '4K') return '2144x3824';
  const [rw, rh] = aspectRatio.split(':').map(Number) as [number, number];
  const area = resolution === '1K' ? 1_048_576 : resolution === '2K' ? 3_686_400 : 8_198_656;
  let width = round16(Math.sqrt(area * rw / rh));
  let height = round16(width * rh / rw);
  while (width >= 3840 || height >= 3840 || width * height > 8_294_400) {
    const scale = Math.min(3824 / width, 3824 / height, Math.sqrt(8_294_400 / (width * height))) * 0.999;
    width = floor16(width * scale);
    height = floor16(height * scale);
  }
  while (width * height < 655_360) {
    width += 16;
    height = round16(width * rh / rw);
  }
  return `${width}x${height}`;
}

export function mapOpenAiImageSize(
  model: string,
  aspectRatio: ImageAspectRatio,
  resolution: ImageResolution,
): string | undefined {
  if (isGptImage2(model)) return mapGptImage2ExactSize(aspectRatio, resolution);
  if (!/^gpt-image-1(?:\.5)?$/iu.test(model)) {
    return aspectRatio === '1:1' && resolution === '1K' ? '1024x1024' : undefined;
  }
  const [widthRatio, heightRatio] = aspectRatio.split(':').map(Number) as [number, number];
  if (widthRatio === heightRatio) return '1024x1024';
  return widthRatio > heightRatio ? '1536x1024' : '1024x1536';
}

function assertProfileAllowsImageRequest(
  profile: NewApiModelProfile,
  aspectRatio: ImageAspectRatio,
  resolution: ImageResolution,
): void {
  const constraints = profile.constraints?.image;
  if (constraints?.aspectRatios !== undefined && !constraints.aspectRatios.includes(aspectRatio)) {
    throw capabilityError('Selected 4D image model does not support the requested aspect ratio');
  }
  if (constraints?.resolutions !== undefined && !constraints.resolutions.includes(resolution)) {
    throw capabilityError('Selected 4D image model does not support the requested resolution');
  }
}

function assertSupportedOpenAiImageRequest(
  model: string,
  aspectRatio: ImageAspectRatio,
  resolution: ImageResolution,
): void {
  if (/^gpt-image-1(?:\.5)?$/iu.test(model) && resolution !== '1K') {
    throw capabilityError('GPT Image 1 and 1.5 only support the 1K resolution tier');
  }
  if (!/^gpt-image-1(?:\.5)?$/iu.test(model)
    && !isGptImage2(model)
    && (aspectRatio !== '1:1' || resolution !== '1K')) {
    throw capabilityError('This 4D image model is verified only for square 1K generation');
  }
}

async function assertRunnableProfile(
  readConfiguration: () => Promise<{ readonly baseUrl: string; readonly profiles: readonly NewApiModelProfile[] }>,
  modelRoute: string,
  capability: 'chat' | 'vision' | 'reverse_prompt' | 'image_generation' | 'video_generation',
) {
  const profile = (await readConfiguration()).profiles.find((entry) => entry.modelRoute === modelRoute);
  if (profile === undefined || profile.capabilityStatus !== 'complete' || !profile.capabilities.includes(capability)) {
    throw capabilityError('Selected model is not verified for this capability');
  }
  return profile;
}

function selectRefreshedProfiles(
  available: readonly NewApiModelProfile[],
  selected: readonly NewApiModelProfile[],
): NewApiModelProfile[] {
  const selectedIdentities = new Set(selected.flatMap((profile) => [
    `${profile.provider}:route:${profile.modelRoute}`,
    `${profile.provider}:model:${profile.modelId}`,
  ]));
  return available.filter((profile) => selectedIdentities.has(`${profile.provider}:route:${profile.modelRoute}`)
    || selectedIdentities.has(`${profile.provider}:model:${profile.modelId}`));
}

function markSelectedProfiles(
  available: readonly NewApiModelProfile[],
  selected: readonly NewApiModelProfile[],
): Array<NewApiModelProfile & { readonly enabled: boolean }> {
  const selectedProfiles = new Set(selectRefreshedProfiles(available, selected).map((profile) => profile.modelRoute));
  return available.map((profile) => ({ ...profile, enabled: selectedProfiles.has(profile.modelRoute) }));
}

function parseStoredNewApiProfile(
  profile: ProviderBridgeProfile,
  provider: NewApiProviderId,
): NewApiModelProfile {
  if (
    profile.provider !== provider
    || profile.modelId === undefined
    || profile.capabilityStatus === undefined
  ) {
    throw serviceError('PROVIDER_INVALID_RESPONSE', 'Stored New API model profile is invalid', false);
  }
  return {
    provider,
    modelRoute: profile.modelRoute,
    displayName: profile.displayName,
    modelId: profile.modelId,
    capabilities: [...profile.capabilities],
    capabilityStatus: profile.capabilityStatus,
    ...(profile.constraints === undefined ? {} : { constraints: profile.constraints }),
  };
}

async function storeImage(
  generated: NewApiGeneratedImage,
  sessionId: string | undefined,
  options: Parameters<typeof createNewApiProviderService>[0],
): Promise<{ readonly assetId: string; readonly bytes: Uint8Array }> {
  if (sessionId === undefined) throw invalidRequest('Image generation requires a project session');
  if (options.storeGeneratedImage === undefined) throw invalidRequest('Generated image storage is unavailable');
  const media = generated.kind === 'inline'
    ? { bytes: generated.bytes, mediaType: generated.mediaType }
    : await downloadRemoteImage(generated.url, options);
  const stored = await options.storeGeneratedImage(sessionId, media.bytes, media.mediaType);
  return { assetId: typeof stored === 'string' ? stored : stored.assetId, bytes: media.bytes };
}

async function downloadRemoteImage(
  value: string,
  options: Parameters<typeof createNewApiProviderService>[0],
): Promise<{ readonly bytes: Uint8Array; readonly mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' }> {
  const url = parseSafeProviderResultUrl(value);
  if (url.port !== '') throw serviceError('PROVIDER_INVALID_RESPONSE', '4D returned an invalid image result address', false);
  if (options.resolveResultHost === undefined) throw serviceError('PROVIDER_INVALID_RESPONSE', '4D image result address could not be verified', false);
  let addresses: readonly string[];
  try {
    addresses = await options.resolveResultHost(url.hostname);
  } catch {
    throw serviceError('PROVIDER_ERROR', '4D image result address could not be resolved', true);
  }
  if (addresses.length === 0 || addresses.some((address) => !isPublicProviderAddress(address))) {
    throw serviceError('PROVIDER_INVALID_RESPONSE', '4D image result address could not be verified', false);
  }
  let response: Awaited<ReturnType<NewApiFetch>>;
  try {
    response = await options.fetch(url.toString(), {
      method: 'GET',
      trustedResolvedAddress: addresses[0],
      maxResponseBytes: 256 * 1024 * 1024,
      timeoutMs: 180_000,
    });
  } catch (error) {
    if (isTypedServiceFailure(error)) throw error;
    throw serviceError('PROVIDER_ERROR', '4D image result download failed', true);
  }
  if (!response.ok || response.arrayBuffer === undefined) {
    if (!response.ok && isRetryableHttpStatus(response.status)) {
      throw serviceError('PROVIDER_ERROR', `4D image result download failed (${response.status})`, true);
    }
    throw serviceError('PROVIDER_INVALID_RESPONSE', '4D image result download failed', false);
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    throw serviceError('PROVIDER_ERROR', '4D image result download failed', true);
  }
  if (bytes.byteLength === 0 || bytes.byteLength > 256 * 1024 * 1024) {
    throw serviceError('PROVIDER_INVALID_RESPONSE', '4D image result download failed', false);
  }
  return { bytes, mediaType: detectSecureImageMediaType(bytes) };
}

function detectSecureImageMediaType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' {
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 16));
  if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (header.subarray(0, 6).toString('ascii') === 'GIF87a' || header.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  throw serviceError('PROVIDER_INVALID_RESPONSE', '4D returned an unsupported image result', false);
}

async function reserveHistory(
  sink: GenerationHistoryProviderSinkContract | undefined,
  jobId: string | undefined,
  kind: 'image' | 'video',
  modelDisplayName: string,
  provider: NewApiProviderId,
): Promise<string | undefined> {
  if (sink === undefined) return undefined;
  if (jobId === undefined || jobId.length === 0) throw invalidRequest('Generation history requires a job id');
  return (await sink.reserveSubmission({ jobId, kind, modelDisplayName, provider })).historyId;
}

async function notifyHistory(
  sink: GenerationHistoryProviderSinkContract | undefined,
  notify: (sink: GenerationHistoryProviderSinkContract) => Promise<unknown> | undefined,
): Promise<void> {
  if (sink === undefined) return;
  try {
    await notify(sink);
  } catch {
    // Provider task/result persistence is authoritative; history is repaired independently.
  }
}

async function prepareSubmission(
  options: Parameters<typeof createNewApiProviderService>[0],
  jobId: string | undefined,
  kind: 'image' | 'video',
  modelDisplayName: string,
): Promise<{ readonly historyId?: string; readonly existingPublicTaskId?: string }> {
  if (options.providerTaskMappings === undefined || jobId === undefined || jobId.length === 0) {
    return { historyId: await reserveHistory(options.historySink, jobId, kind, modelDisplayName, options.provider) };
  }
  const historyId = deriveGenerationHistoryId(jobId);
  const existing = await options.providerTaskMappings.findByHistoryId(historyId);
  if (existing !== undefined) {
    if (existing.provider !== options.provider) throw serviceError('PROVIDER_INVALID_RESPONSE', 'Generation job provider identity is invalid', false);
    return { historyId, existingPublicTaskId: existing.publicTaskId };
  }
  const created = await options.providerTaskMappings.reserveSubmission({
    currentIdentity: jobId.startsWith('model-job-v2-'),
    historyId,
  });
  if (!created) {
    const raced = await options.providerTaskMappings.findByHistoryId(historyId);
    if (raced !== undefined && raced.provider === options.provider) {
      return { historyId, existingPublicTaskId: raced.publicTaskId };
    }
    throw serviceError('PROVIDER_INVALID_RESPONSE', 'Generation job is already reserved; create a new run to submit again', false);
  }
  if (options.historySink !== undefined) {
    const reservation = await options.historySink.reserveSubmission({ jobId, kind, modelDisplayName, provider: options.provider });
    if (reservation.historyId !== historyId) {
      throw serviceError('PROVIDER_INVALID_RESPONSE', 'Generation history reservation identity is invalid', false);
    }
    if (!reservation.created) {
      const raced = await options.providerTaskMappings.findByHistoryId(historyId);
      if (raced !== undefined && raced.provider === options.provider) {
        return { historyId, existingPublicTaskId: raced.publicTaskId };
      }
      throw serviceError('PROVIDER_INVALID_RESPONSE', 'Generation job history is already reserved; create a new run to submit again', false);
    }
  }
  return { historyId };
}

async function requireReference(options: Parameters<typeof createNewApiProviderService>[0], sessionId: string, assetId: string) {
  if (options.readReferenceImage === undefined) throw invalidRequest('Reference image storage is unavailable');
  return options.readReferenceImage(sessionId, assetId);
}

async function requireTask(store: NewApiServiceTaskStore, publicTaskId: string, kind: 'image' | 'video'): Promise<NewApiPrivateTask> {
  if (!/^provider-job-[a-f0-9]{32}$/u.test(publicTaskId)) throw invalidRequest('Provider task id is invalid');
  const task = await store.read(publicTaskId);
  if (task === undefined || task.kind !== kind) throw invalidRequest('Provider task was not found');
  return task;
}

function memoryTaskStore(): NewApiServiceTaskStore {
  const values = new Map<string, NewApiPrivateTask>();
  return {
    read: async (id) => values.get(id),
    write: async (id, task) => { values.set(id, task); },
    delete: async (id) => { values.delete(id); },
  };
}

function ledgerTaskStore(
  ledger: ProviderTaskMappingStore,
  provider: NewApiProviderId,
  now: () => Date,
): NewApiServiceTaskStore {
  return {
    async read(id) {
      const record = await ledger.get(id);
      if (record === undefined || record.provider !== provider) return undefined;
      const kind = record.kind ?? 'image';
      if (record.state === 'running') {
        if (record.sessionId === undefined) return undefined;
        return {
          kind, state: 'remote', rawTaskId: record.rawTaskId, sessionId: record.sessionId,
          ...(record.historyId === undefined ? {} : { historyId: record.historyId }),
        } as Extract<NewApiPrivateTask, { state: 'remote' }>;
      }
      if (record.state === 'cancelled') return { kind, state: 'cancelled', ...(record.historyId === undefined ? {} : { historyId: record.historyId }) };
      if (record.state === 'failed') return {
        kind, state: 'failed', code: record.error?.code, message: record.error?.message ?? 'Provider generation failed',
        retryable: record.error?.retryable ?? false, ...(record.historyId === undefined ? {} : { historyId: record.historyId }),
      };
      const assetId = record.result?.assetId;
      if (assetId === undefined) return undefined;
      return { kind, state: 'completed', assetId, ...(record.historyId === undefined ? {} : { historyId: record.historyId }) } as TerminalImageTask | TerminalVideoTask;
    },
    async write(id, task) {
      const current = await ledger.get(id);
      const timestamp = now().toISOString();
      const base = {
        provider,
        publicTaskId: id,
        rawTaskId: task.state === 'remote' ? task.rawTaskId : current?.rawTaskId ?? `${provider}-synchronous`,
        kind: task.kind,
        ...(task.state === 'remote' ? { sessionId: task.sessionId, ...(task.historyId === undefined ? {} : { historyId: task.historyId }) } : {
          ...(current?.sessionId === undefined ? {} : { sessionId: current.sessionId }),
          ...((task.historyId ?? current?.historyId) === undefined ? {} : { historyId: task.historyId ?? current?.historyId }),
        }),
        createdAt: current?.createdAt ?? timestamp,
        updatedAt: timestamp,
      } as const;
      if (task.state === 'remote') {
        await ledger.set({ ...base, state: 'running' });
      } else if (task.state === 'completed') {
        const result = task.kind === 'image'
          ? { assetId: task.assetId, assetIds: [task.assetId] }
          : { assetId: task.assetId };
        await ledger.set({ ...base, state: 'completed', terminalAt: timestamp, result });
      } else if (task.state === 'failed') {
        await ledger.set({
          ...base,
          state: 'failed',
          terminalAt: timestamp,
          error: { code: task.code ?? 'PROVIDER_ERROR', message: task.message, retryable: task.retryable },
        });
      } else if (current !== undefined) {
        await ledger.markCancelled(id, timestamp);
      } else {
        await ledger.set({ ...base, state: 'cancelled', terminalAt: timestamp });
      }
    },
    async delete(id) {
      const record = await ledger.get(id);
      if (record === undefined || record.state === 'running') throw invalidRequest('Provider task is not terminal');
      await ledger.ackTerminal(id, record.state);
    },
  };
}

function imagePoll(task: NewApiPrivateTask): NewApiImagePollResult {
  if (task.kind !== 'image') throw invalidRequest('Provider task kind is invalid');
  if (task.state === 'completed') return { status: 'completed', progress: 1, result: { assetId: task.assetId, assetIds: [task.assetId] } };
  if (task.state === 'cancelled') return { status: 'cancelled' };
  if (task.state === 'failed') return { status: 'failed', error: serviceError(task.code ?? 'PROVIDER_ERROR', task.message, task.retryable) };
  return { status: 'running' };
}

function videoPoll(task: NewApiPrivateTask): NewApiVideoPollResult {
  if (task.kind !== 'video') throw invalidRequest('Provider task kind is invalid');
  if (task.state === 'completed') return { status: 'completed', progress: 1, result: { assetId: task.assetId } };
  if (task.state === 'cancelled') return { status: 'cancelled' };
  if (task.state === 'failed') return { status: 'failed', error: serviceError(task.code ?? 'PROVIDER_ERROR', task.message, task.retryable) };
  return { status: 'running' };
}

export function mapNewApiVideoSize(aspectRatio: ImageAspectRatio, resolution: string): string {
  const short = resolution === '2K' ? 1440 : resolution === '4K' ? 2160 : Number.parseInt(resolution, 10);
  const height = Number.isFinite(short) && short > 0 ? short : 720;
  const [rw, rh] = aspectRatio.split(':').map(Number) as [number, number];
  return rw >= rh ? `${round16(height * rw / rh)}x${height}` : `${height}x${round16(height * rh / rw)}`;
}
function isGptImage2(model: string): boolean {
  return /^gpt-image-2(?:-(?:2k|4k)|\.5-(?:flare|sunburst))?$/iu.test(model);
}
function isRemoteCompleted(status: string): boolean { return /^(?:completed|succeeded|success)$/iu.test(status); }
function isRemoteCancelled(status: string): boolean { return /^(?:cancelled|canceled)$/iu.test(status); }
function isRemoteFailed(status: string): boolean { return /^(?:failed|error)$/iu.test(status); }
function normalizeProgress(value: number): number { return Math.max(0, Math.min(1, value > 1 ? value / 100 : value)); }
function round16(value: number): number { return Math.max(16, Math.round(value / 16) * 16); }
function floor16(value: number): number { return Math.max(16, Math.floor(value / 16) * 16); }
function createPublicTaskId(): string { return `provider-job-${randomBytes(16).toString('hex')}`; }
function assertProvider(actual: string, expected: NewApiProviderId): void {
  if (actual !== expected) throw invalidRequest('Provider request was routed to the wrong service');
}
function assertMp4(bytes: Uint8Array): void {
  if (bytes.byteLength < 8 || Buffer.from(bytes.buffer, bytes.byteOffset + 4, 4).toString('ascii') !== 'ftyp') {
    throw serviceError('PROVIDER_INVALID_RESPONSE', 'Julun returned an invalid video result', false);
  }
}
function normalizeServiceFailure(error: unknown): { code: ProviderBridgeErrorCode; message: string; retryable: boolean } {
  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown; retryable?: unknown };
    const code = candidate.code;
    if (isProviderErrorCode(code)) {
      return { code, message: error.message, retryable: candidate.retryable === true };
    }
  }
  return { code: 'PROVIDER_ERROR', message: 'Julun video result processing failed', retryable: false };
}
function normalizeImageServiceFailure(error: unknown): { code: ProviderBridgeErrorCode; message: string; retryable: boolean } {
  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown; retryable?: unknown };
    if (isProviderErrorCode(candidate.code)) {
      return { code: candidate.code, message: error.message, retryable: candidate.retryable === true };
    }
  }
  return { code: 'PROVIDER_ERROR', message: '4D image result processing failed', retryable: false };
}
function isTypedServiceFailure(error: unknown): error is Error & { readonly code: ProviderBridgeErrorCode; readonly retryable: boolean } {
  return error instanceof Error
    && isProviderErrorCode((error as { code?: unknown }).code)
    && typeof (error as { retryable?: unknown }).retryable === 'boolean';
}
function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
function isProviderErrorCode(value: unknown): value is ProviderBridgeErrorCode {
  return typeof value === 'string' && [
    'CAPABILITY_UNSUPPORTED', 'INVALID_REQUEST', 'CREDENTIALS_LOCKED', 'PROVIDER_INACTIVE', 'PROVIDER_UNAVAILABLE',
    'PROVIDER_INVALID_RESPONSE', 'PROTECTED_PAYLOAD', 'PROVIDER_ERROR', 'WEB_LOGIN_CANCELLED', 'WEB_LOGIN_TIMEOUT',
  ].includes(value);
}
function capabilityError(message: string): Error & { code: 'CAPABILITY_UNSUPPORTED'; retryable: false } {
  return serviceError('CAPABILITY_UNSUPPORTED', message, false) as Error & { code: 'CAPABILITY_UNSUPPORTED'; retryable: false };
}
function invalidRequest(message: string): Error & { code: 'INVALID_REQUEST'; retryable: false } {
  return serviceError('INVALID_REQUEST', message, false) as Error & { code: 'INVALID_REQUEST'; retryable: false };
}
function serviceError(code: string, message: string, retryable: boolean): Error & { code: string; retryable: boolean } {
  return Object.assign(new Error(message), { code, retryable });
}
