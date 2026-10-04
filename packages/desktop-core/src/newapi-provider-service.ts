import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

import {
  createNewApiClient,
  type NewApiFetch,
} from './newapi-client.js';
import {
  buildAuthenticatedNewApiCatalog,
  isAudited4daiGeminiImageModel,
  type NewApiModelProfile,
  type NewApiProviderId,
} from './newapi-model-catalog.js';
import { NEW_API_PROVIDER_SEEDS } from './newapi-provider-seeds.js';
import { getJulunVideoModelSpec } from './julun-video-model-spec.js';
import { deriveGenerationHistoryId, type GenerationHistoryProviderSinkContract } from './generation-history-provider-sink.js';
import type { GenerationProjectBinding } from './generation-project-binding.js';
import { NodeFileSystem, type FileSystem } from './file-system.js';
import { assertConfinedAppDataPathForRead, assertConfinedAppDataPathForWrite, deleteConfinedAppDataFile, writeConfinedAtomicUpdate } from './provider-file-confinement.js';
import { isPublicProviderAddress, parseSafeProviderResultUrl } from './provider-result-security.js';
import type { ProviderTaskMappingStore } from './provider-task-ledger.js';
import type { ProviderService } from './provider-service-types.js';
import type {
  AnalyzeReversePromptBridgeRequest,
  AnalyzeReversePromptBridgeResult,
  ChatSkillBridgeRequest,
  ChatSkillBridgeResult,
  ProviderBridgeProfile,
  ProviderBridgeErrorCode,
  ProviderConfigurationStatus,
} from './provider-contracts.js';
import { buildProfessionalReverseRequest } from './professional-reverse-analysis.js';
import { parseReverseProviderResponse } from './reverse-provider-response.js';
import { resolveReverseAnalysisBudget } from './reverse-analysis-budget.js';

type ImageAspectRatio = '1:1' | '2:3' | '3:2' | '4:3' | '3:4' | '16:9' | '9:16';
type VideoAspectRatio = ImageAspectRatio | '4:5' | '5:4' | '21:9';
type ImageResolution = '1K' | '2K' | '4K';

export interface NewApiServiceConfigurationStore {
  read(fallback: { readonly baseUrl: string; readonly profiles: readonly ProviderBridgeProfile[] }): Promise<{ readonly baseUrl: string; readonly profiles: readonly ProviderBridgeProfile[] }>;
  write(snapshot: { readonly baseUrl: string; readonly profiles: readonly ProviderBridgeProfile[] }): Promise<void>;
}

export interface NewApiServiceTaskStore {
  read(publicTaskId: string): Promise<NewApiPrivateTask | undefined>;
  write(publicTaskId: string, task: NewApiPrivateTask, allowCreate?: boolean): Promise<void>;
  delete(publicTaskId: string): Promise<void>;
}

type TerminalImageTask = { readonly kind: 'image'; readonly state: 'completed'; readonly assetId: string; readonly historyId?: string };
type TerminalVideoTask = { readonly kind: 'video'; readonly state: 'completed'; readonly assetId: string; readonly historyId?: string };
type NewApiPrivateTask =
  | TerminalImageTask
  | TerminalVideoTask
  | { readonly kind: 'image' | 'video'; readonly state: 'remote'; readonly rawTaskId: string; readonly sessionId: string; readonly projectBinding?: GenerationProjectBinding; readonly historyId?: string }
  | { readonly kind: 'image' | 'video'; readonly state: 'pending'; readonly resultHash: string; readonly sessionId: string; readonly projectBinding?: GenerationProjectBinding; readonly assetId?: string; readonly historyId?: string }
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
  chat(request: ChatSkillBridgeRequest): Promise<ChatSkillBridgeResult>;
  analyzeReversePrompt(request: AnalyzeReversePromptBridgeRequest): Promise<AnalyzeReversePromptBridgeResult>;
}

export type ProviderCompatibleNewApiService = NewApiProviderService & ProviderService;

interface NewApiImageJobRequest {
  readonly jobId?: string;
  readonly projectId?: string;
  readonly provider: NewApiProviderId;
  readonly modelRoute: string;
  readonly prompt: string;
  readonly sessionId?: string;
  readonly referenceAssetIds: readonly string[];
  readonly aspectRatio?: ImageAspectRatio;
  readonly resolution?: ImageResolution;
  readonly quality?: 'auto' | 'low' | 'medium' | 'high';
  readonly imageOutputFormat?: 'png' | 'jpeg' | 'webp';
  readonly imageBackground?: 'auto' | 'opaque' | 'transparent';
  readonly outputCount?: 1 | 2 | 3 | 4;
}
interface NewApiVideoJobRequest {
  readonly jobId?: string;
  readonly projectId?: string;
  readonly provider: NewApiProviderId;
  readonly modelRoute: string;
  readonly prompt: string;
  readonly sessionId?: string;
  readonly referenceAssetIds: readonly string[];
  readonly aspectRatio?: VideoAspectRatio;
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
  readonly appDataRoot?: string;
  readonly fileSystem?: FileSystem;
  readonly verifiedVisionModelIds?: readonly string[];
  readonly bindGenerationProject?: (sessionId: string, expectedProjectId?: string) => Promise<GenerationProjectBinding>;
  readonly storeGeneratedImageForProject?: (binding: GenerationProjectBinding, bytes: Uint8Array, mediaType: string) => Promise<{ readonly assetId: string }>;
  readonly storeGeneratedVideoForProject?: (binding: GenerationProjectBinding, bytes: Uint8Array, mediaType: 'video/mp4') => Promise<{ readonly assetId: string }>;
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
  const pendingMedia = createPendingMediaStore(options.appDataRoot, options.fileSystem);
  const unpersistedAccepted = new Map<string, {
    readonly publicTaskId: string;
    readonly task: Extract<NewApiPrivateTask, { state: 'remote' | 'pending' }>;
    readonly bytes?: Uint8Array;
  }>();
  let accessibleModelIds: readonly string[] = [];
  let discoveredProfiles: readonly NewApiModelProfile[] | null = null;
  const fallbackConfiguration = {
    baseUrl: options.provider === 'julun' ? 'https://julun.cc/v1' : 'https://api.4dai.cc/v1',
    profiles: options.provider === 'julun'
      ? NEW_API_PROVIDER_SEEDS.julun.map(profile => ({ ...profile, enabled: false }))
      : NEW_API_PROVIDER_SEEDS[options.provider],
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
        return options.provider === 'julun' ? { ...verified, enabled: true } : verified;
      });
      const profiles = options.provider === 'julun'
        ? retainUnselectedJulunProfiles(selected, current.profiles, discoveredProfiles ?? [])
        : selected;
      await options.configurationStore.write({ baseUrl: current.baseUrl, profiles });
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
      const selectedProfiles = options.provider === 'julun'
        ? refreshJulunSelections(profiles, current.profiles)
        : current.profiles.length === 0 ? profiles : selectRefreshedProfiles(profiles, current.profiles);
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
      const visible = discoveredProfiles === null
        ? [...current.profiles]
        : markSelectedProfiles(discoveredProfiles, current.profiles);
      if (options.provider !== 'julun') return visible;
      const visibleIds = new Set(visible.map(profile => profile.modelId));
      const visibleRoutes = new Set(visible.map(profile => profile.modelRoute));
      const previews = NEW_API_PROVIDER_SEEDS.julun.filter(profile => !visibleIds.has(profile.modelId)).map(profile => {
        const modelRoute = visibleRoutes.has(profile.modelRoute)
          ? `${profile.modelRoute}-${createHash('sha256').update(profile.modelId).digest('hex').slice(0, 12)}`
          : profile.modelRoute;
        visibleRoutes.add(modelRoute);
        return { ...profile, modelRoute, capabilityStatus: 'incomplete' as const, enabled: false };
      });
      return [...visible, ...previews];
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
      const projectBinding = await bindProject(options, request.sessionId, request.projectId);
      const heldImage = request.jobId === undefined ? undefined : unpersistedAccepted.get(request.jobId);
      if (heldImage !== undefined) {
        if (heldImage.task.kind !== 'image') throw invalidRequest('Generation job kind is invalid');
        assertExistingProjectBinding(heldImage.task.projectBinding, projectBinding);
        try { await recoverAcceptedTask(tasks, pendingMedia, heldImage); }
        catch (error) { throw uncertainPaidSubmission(error); }
        unpersistedAccepted.delete(request.jobId!);
        await finishPendingTask(tasks, pendingMedia, heldImage.publicTaskId, options);
        return { providerTaskId: heldImage.publicTaskId };
      }
      const submission = await prepareSubmission(options, request.jobId, 'image', profile.displayName, projectBinding);
      if (submission.existingPublicTaskId !== undefined) return { providerTaskId: submission.existingPublicTaskId };
      const historyId = submission.historyId;
      let providerAccepted = false;
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
            ...(request.imageOutputFormat === undefined || request.imageOutputFormat === 'png' ? {} : { output_format: request.imageOutputFormat }),
            ...(request.imageBackground === undefined || request.imageBackground === 'auto' ? {} : { background: request.imageBackground }),
            ...(size === undefined ? {} : { size }),
          });
        providerAccepted = true;
        const publicTaskId = createPublicTaskId();
        if (generated.kind === 'remote') {
          const remoteTask = {
            kind: 'image', state: 'remote', rawTaskId: generated.url, sessionId: request.sessionId,
            ...(projectBinding === undefined ? {} : { projectBinding }),
            ...(historyId === undefined ? {} : { historyId }),
          } as const;
          if (request.jobId !== undefined) unpersistedAccepted.set(request.jobId, { publicTaskId, task: remoteTask });
          await persistAcceptedTask(tasks, publicTaskId, remoteTask);
          if (request.jobId !== undefined) unpersistedAccepted.delete(request.jobId);
          return { providerTaskId: publicTaskId };
        }
        const resultHash = createHash('sha256').update(generated.bytes).digest('hex');
        const pendingTask = {
          kind: 'image', state: 'pending', resultHash, sessionId: request.sessionId,
          ...(projectBinding === undefined ? {} : { projectBinding }),
          ...(historyId === undefined ? {} : { historyId }),
        } as const;
        if (request.jobId !== undefined) unpersistedAccepted.set(request.jobId, { publicTaskId, task: pendingTask, bytes: generated.bytes });
        await recoverAcceptedTask(tasks, pendingMedia, { publicTaskId, task: pendingTask, bytes: generated.bytes });
        if (request.jobId !== undefined) unpersistedAccepted.delete(request.jobId);
        await finishPendingTask(tasks, pendingMedia, publicTaskId, options);
        return { providerTaskId: publicTaskId };
      } catch (error) {
        // A paid result may already exist. Preserve its reservation instead of
        // making a transient local write failure look like provider failure.
        throw providerAccepted ? uncertainPaidSubmission(error) : error;
      }
    },
    async pollImageJob(request) {
      assertProvider(request.provider, options.provider);
      const task = await reconcileDurableCancellation(tasks, request.providerTaskId,
        await requireTask(tasks, request.providerTaskId, 'image'), options);
      if (task.state === 'pending') {
        await finishPendingTask(tasks, pendingMedia, request.providerTaskId, options);
        return imagePoll(await requireTask(tasks, request.providerTaskId, 'image'));
      }
      if (task.state !== 'remote') return imagePoll(task);
      if (options.bindGenerationProject !== undefined && task.projectBinding === undefined) {
        await failIrrecoverableTask(tasks, pendingMedia, request.providerTaskId, task, options,
          serviceError('PROVIDER_UNAVAILABLE', 'Legacy generation project destination cannot be verified', false));
        return imagePoll(await requireTask(tasks, request.providerTaskId, 'image'));
      }
      let media: Awaited<ReturnType<typeof downloadRemoteImage>>;
      try {
        media = await downloadRemoteImage(task.rawTaskId, options);
      } catch (error) {
        const normalized = normalizeImageServiceFailure(error);
        if (normalized.retryable) return { status: 'running' };
        await failIrrecoverableTask(tasks, pendingMedia, request.providerTaskId, task, options,
          serviceError(normalized.code, normalized.message, false));
        return imagePoll(await requireTask(tasks, request.providerTaskId, 'image'));
      }
      try {
        const resultHash = await pendingMedia.stage(request.providerTaskId, 'image', media.bytes);
        await tasks.write(request.providerTaskId, { ...task, state: 'pending', resultHash });
        await finishPendingTask(tasks, pendingMedia, request.providerTaskId, options);
        return imagePoll(await requireTask(tasks, request.providerTaskId, 'image'));
      } catch {
        const current = await tasks.read(request.providerTaskId);
        if (current === undefined) {
          try { await pendingMedia.remove(request.providerTaskId); } catch { /* Preserve the missing handle error. */ }
          throw invalidRequest('Provider task was not found');
        }
        return imagePoll(current);
      }
    },
    async cancelImageJob(request) {
      assertProvider(request.provider, options.provider);
      const task = await requireTask(tasks, request.providerTaskId, 'image');
      if (task.state === 'completed' || task.state === 'failed' || task.state === 'cancelled') return imagePoll(task);
      return imagePoll(await cancelTaskWithDurableHistory(tasks, request.providerTaskId, task, options));
    },
    async ackImageJobTerminal(request) {
      assertProvider(request.provider, options.provider);
      const task = await requireTask(tasks, request.providerTaskId, 'image');
      if (task.state === 'remote' || task.state === 'pending') throw invalidRequest('Provider task is not terminal');
      await pendingMedia.remove(request.providerTaskId);
      await tasks.delete(request.providerTaskId);
      return { acknowledged: true };
    },
    async submitVideoJob(request) {
      assertProvider(request.provider, options.provider);
      if (options.provider !== 'julun') throw capabilityError('4D video generation is disabled');
      if (request.sessionId === undefined) throw invalidRequest('Video generation requires a project session');
      const projectBinding = await bindProject(options, request.sessionId, request.projectId);
      const heldVideo = request.jobId === undefined ? undefined : unpersistedAccepted.get(request.jobId);
      if (heldVideo !== undefined) {
        if (heldVideo.task.kind !== 'video') throw invalidRequest('Generation job kind is invalid');
        assertExistingVideoIdentity(heldVideo.task, request.sessionId, projectBinding);
        try { await recoverAcceptedTask(tasks, pendingMedia, heldVideo); }
        catch (error) { throw uncertainPaidSubmission(error); }
        unpersistedAccepted.delete(request.jobId!);
        return { providerTaskId: heldVideo.publicTaskId };
      }
      if (request.jobId !== undefined && request.jobId.length > 0 && options.providerTaskMappings !== undefined) {
        const historyId = deriveGenerationHistoryId(request.jobId);
        const existing = await options.providerTaskMappings.findByHistoryId(historyId);
        if (existing !== undefined) {
          if (existing.provider !== options.provider || existing.historyId !== historyId || existing.kind !== 'video') {
            throw serviceError('PROVIDER_INVALID_RESPONSE', 'Generation job provider or task identity is invalid', false);
          }
          assertExistingVideoIdentity(existing, request.sessionId, projectBinding);
          return { providerTaskId: existing.publicTaskId };
        }
      }
      if ((request.outputCount ?? 1) !== 1) throw capabilityError('Julun video generation currently submits one output per task');
      const profile = await assertRunnableProfile(readConfiguration, request.modelRoute, 'video_generation');
      const videoParameters = resolveJulunVideoParameters(profile, request);
      if (request.referenceAssetIds.length > 1) throw capabilityError('Julun accepts one input reference');
      const inputReference = request.referenceAssetIds[0] === undefined
        ? undefined
        : await requireReference(options, request.sessionId, request.referenceAssetIds[0]);
      const submission = await prepareSubmission(options, request.jobId, 'video', profile.displayName, projectBinding, request.sessionId);
      if (submission.existingPublicTaskId !== undefined) return { providerTaskId: submission.existingPublicTaskId };
      const historyId = submission.historyId;
      let providerAccepted = false;
      try {
        const remote = await (await getClient()).createVideo({
          model: profile.modelId,
          prompt: request.prompt,
          ...videoParameters,
          ...(inputReference === undefined ? {} : { inputReference }),
        });
        providerAccepted = true;
        const publicTaskId = createPublicTaskId();
        const remoteTask = { kind: 'video', state: 'remote', rawTaskId: remote.id, sessionId: request.sessionId,
          ...(projectBinding === undefined ? {} : { projectBinding }), ...(historyId === undefined ? {} : { historyId }) } as const;
        if (request.jobId !== undefined) unpersistedAccepted.set(request.jobId, { publicTaskId, task: remoteTask });
        await persistAcceptedTask(tasks, publicTaskId, remoteTask);
        if (request.jobId !== undefined) unpersistedAccepted.delete(request.jobId);
        await notifyHistory(options.historySink, (sink) => historyId === undefined ? undefined : sink.running(historyId));
        return { providerTaskId: publicTaskId };
      } catch (error) {
        // The provider may have accepted this paid request. Keep the reservation
        // as a barrier against a duplicate submission.
        throw providerAccepted ? uncertainPaidSubmission(error) : error;
      }
    },
    async pollVideoJob(request) {
      assertProvider(request.provider, options.provider);
      const task = await reconcileDurableCancellation(tasks, request.providerTaskId,
        await requireTask(tasks, request.providerTaskId, 'video'), options);
      if (task.state === 'pending') {
        await finishPendingTask(tasks, pendingMedia, request.providerTaskId, options);
        return videoPoll(await requireTask(tasks, request.providerTaskId, 'video'));
      }
      if (task.state !== 'remote') return videoPoll(task);
      if (options.bindGenerationProject !== undefined && task.projectBinding === undefined) {
        await failIrrecoverableTask(tasks, pendingMedia, request.providerTaskId, task, options,
          serviceError('PROVIDER_UNAVAILABLE', 'Legacy generation project destination cannot be verified', false));
        return videoPoll(await requireTask(tasks, request.providerTaskId, 'video'));
      }
      const client = await getClient();
      const remote = await client.getVideo(task.rawTaskId);
      if (isRemoteCompleted(remote.status)) {
        try {
          const bytes = await client.getVideoContent(task.rawTaskId);
          assertMp4(bytes);
          const resultHash = await pendingMedia.stage(request.providerTaskId, 'video', bytes);
          await tasks.write(request.providerTaskId, { ...task, state: 'pending', resultHash });
          await finishPendingTask(tasks, pendingMedia, request.providerTaskId, options);
          return videoPoll(await requireTask(tasks, request.providerTaskId, 'video'));
        } catch (error) {
          const normalized = normalizeServiceFailure(error);
          if (normalized.retryable) throw error;
          if (!isTypedServiceFailure(error) || error.code !== 'PROVIDER_INVALID_RESPONSE') {
            const current = await tasks.read(request.providerTaskId);
            if (current === undefined) {
              try { await pendingMedia.remove(request.providerTaskId); } catch { /* Preserve the missing handle error. */ }
              throw invalidRequest('Provider task was not found');
            }
            return videoPoll(current);
          }
          await failIrrecoverableTask(tasks, pendingMedia, request.providerTaskId, task, options,
            serviceError(normalized.code, normalized.message, false));
          return videoPoll(await requireTask(tasks, request.providerTaskId, 'video'));
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
        return videoPoll(await requireTask(tasks, request.providerTaskId, 'video'));
      }
      if (isRemoteFailed(remote.status)) {
        await failIrrecoverableTask(tasks, pendingMedia, request.providerTaskId, task, options,
          serviceError('PROVIDER_ERROR', 'Julun video generation failed', false));
        return videoPoll(await requireTask(tasks, request.providerTaskId, 'video'));
      }
      return { status: 'running', ...(remote.progress === undefined ? {} : { progress: normalizeProgress(remote.progress) }) };
    },
    async cancelVideoJob(request) {
      assertProvider(request.provider, options.provider);
      const task = await requireTask(tasks, request.providerTaskId, 'video');
      if (task.state === 'completed' || task.state === 'failed' || task.state === 'cancelled') return videoPoll(task);
      return videoPoll(await cancelTaskWithDurableHistory(tasks, request.providerTaskId, task, options));
    },
    async ackVideoJobTerminal(request) {
      assertProvider(request.provider, options.provider);
      const task = await requireTask(tasks, request.providerTaskId, 'video');
      if (task.state === 'remote' || task.state === 'pending') throw invalidRequest('Provider task is not terminal');
      await pendingMedia.remove(request.providerTaskId);
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
      const reverseBudget = request.visualAnalysis === true
        ? resolveReverseAnalysisBudget(request.reverseAnalysisDepth)
        : undefined;
      const message = await (await getClient()).createChatCompletion({
        model: profile.modelId,
        messages,
        ...(reverseBudget === undefined ? {} : { max_tokens: reverseBudget.maxOutputTokens }),
      }, reverseBudget?.timeoutMs);
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
      const reverseBudget = resolveReverseAnalysisBudget(request.run.agentConfig?.analysisDepth);
      const text = await (await getClient()).createChatCompletion({
        model: profile.modelId,
        max_tokens: reverseBudget.maxOutputTokens,
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
      }, reverseBudget.timeoutMs);
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
  if (profile === undefined || profile.capabilityStatus !== 'complete' || !profile.capabilities.includes(capability)
    || 'enabled' in profile && profile.enabled === false) {
    throw capabilityError('Selected model is not verified for this capability');
  }
  return profile;
}

function selectRefreshedProfiles(
  available: readonly NewApiModelProfile[],
  selected: readonly NewApiModelProfile[],
): NewApiModelProfile[] {
  const selectedRoutes = new Set<string>();
  return selected.flatMap(profile => {
    if ('enabled' in profile && profile.enabled === false) return [];
    const refreshed = available.find(candidate => candidate.provider === profile.provider
      && candidate.modelId === profile.modelId);
    if (refreshed === undefined || selectedRoutes.has(refreshed.modelRoute)) return [];
    selectedRoutes.add(refreshed.modelRoute);
    return [refreshed];
  });
}

function refreshJulunSelections(
  available: readonly NewApiModelProfile[],
  stored: readonly NewApiModelProfile[],
): NewApiModelProfile[] {
  const storedIds = new Set(stored.map(profile => profile.modelId));
  const refreshed = stored.map(profile => {
    const current = available.find(candidate => candidate.modelId === profile.modelId);
    return current === undefined
      ? { ...profile, capabilityStatus: 'incomplete' as const, enabled: false }
      : { ...current, ...('enabled' in profile ? { enabled: profile.enabled } : {}) };
  });
  return [...refreshed, ...available.filter(profile => !storedIds.has(profile.modelId))
    .map(profile => ({ ...profile, enabled: false }))];
}

function retainUnselectedJulunProfiles(
  selected: readonly NewApiModelProfile[],
  stored: readonly NewApiModelProfile[],
  available: readonly NewApiModelProfile[],
): NewApiModelProfile[] {
  const selectedIds = new Set(selected.map(profile => profile.modelId));
  const known = new Map(stored.map(profile => [profile.modelId, profile]));
  for (const profile of available) known.set(profile.modelId, profile);
  return [...selected, ...[...known.values()].filter(profile => !selectedIds.has(profile.modelId))
    .map(profile => ({ ...profile, enabled: false }))];
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
  const julunSpec = provider === 'julun' ? getJulunVideoModelSpec(profile.modelId) : undefined;
  return {
    provider,
    modelRoute: profile.modelRoute,
    displayName: profile.displayName,
    modelId: profile.modelId,
    capabilities: [...profile.capabilities],
    capabilityStatus: provider !== 'julun' ? profile.capabilityStatus
      : profile.capabilityStatus === 'complete' && julunSpec?.kind === 'generation' && julunSpec.parameterEvidenceComplete
        ? 'complete' : 'incomplete',
    ...(provider !== 'julun'
      ? profile.constraints === undefined ? {} : { constraints: profile.constraints }
      : julunSpec === undefined ? {} : { constraints: { video: julunSpec.constraints } }),
    ...(provider === 'julun' && profile.enabled !== undefined ? { enabled: profile.enabled } : {}),
  };
}

async function bindProject(
  options: Parameters<typeof createNewApiProviderService>[0],
  sessionId: string,
  projectId: string | undefined,
): Promise<GenerationProjectBinding | undefined> {
  if (options.bindGenerationProject === undefined) {
    if (projectId !== undefined) throw invalidRequest('Generation project binding is unavailable');
    return undefined;
  }
  const binding = await options.bindGenerationProject(sessionId, projectId);
  if (projectId !== undefined && binding.projectId !== projectId) {
    throw invalidRequest('Generation project does not match the active session');
  }
  return binding;
}

function createPendingMediaStore(appDataRoot: string | undefined, suppliedFileSystem?: FileSystem) {
  const fileSystem = suppliedFileSystem ?? new NodeFileSystem();
  const memory = new Map<string, Uint8Array>();
  const pathFor = (taskId: string) => {
    if (!/^provider-job-[a-f0-9]{32}$/u.test(taskId)) throw invalidRequest('Provider task id is invalid');
    return join(appDataRoot!, `newapi-pending-${taskId}.bin`);
  };
  const invalid = () => serviceError('PROVIDER_UNAVAILABLE', 'Pending provider result is unavailable', true);
  return {
    async stage(taskId: string, kind: 'image' | 'video', bytes: Uint8Array): Promise<string> {
      const maxBytes = kind === 'image' ? 256 * 1024 * 1024 : 512 * 1024 * 1024;
      if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
        throw serviceError('PROVIDER_INVALID_RESPONSE', 'Provider result size is invalid', false);
      }
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (appDataRoot === undefined) {
        memory.set(taskId, Uint8Array.from(bytes));
        return hash;
      }
      const path = pathFor(taskId);
      try {
        await fileSystem.mkdir(appDataRoot, { recursive: true });
        await writeConfinedAtomicUpdate(fileSystem, {
          appDataRoot, targetPath: path, data: bytes,
          assertPathForRead: () => assertConfinedAppDataPathForRead(fileSystem, appDataRoot, path, 'PROVIDER_UNAVAILABLE', 'Pending provider result path is invalid'),
          assertPathForWrite: () => assertConfinedAppDataPathForWrite(fileSystem, appDataRoot, path, 'PROVIDER_UNAVAILABLE', 'Pending provider result path is invalid'),
          errorCode: 'PROVIDER_UNAVAILABLE', errorMessage: 'Pending provider result path is invalid',
        });
      } catch { throw invalid(); }
      return hash;
    },
    async read(taskId: string, kind: 'image' | 'video', expectedHash: string): Promise<Uint8Array> {
      if (!/^[a-f0-9]{64}$/u.test(expectedHash)) throw invalid();
      let bytes: Uint8Array;
      if (appDataRoot === undefined) {
        const stored = memory.get(taskId);
        if (stored === undefined) throw missingPaidResult();
        bytes = stored;
      } else {
        const path = pathFor(taskId);
        if (fileSystem.readFileBuffer === undefined) throw invalid();
        try {
          await assertConfinedAppDataPathForRead(fileSystem, appDataRoot, path, 'PROVIDER_UNAVAILABLE', 'Pending provider result path is invalid');
          bytes = await fileSystem.readFileBuffer(path);
        } catch (error) {
          if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
            throw missingPaidResult();
          }
          if (isTypedServiceFailure(error) && error.code === 'PROVIDER_UNAVAILABLE' && !error.retryable) {
            throw serviceError('PROVIDER_INVALID_RESPONSE',
              '提交状态不确定：已付费生成结果的本地暂存路径未通过安全校验，请勿创建新的付费任务', false);
          }
          throw invalid();
        }
      }
      const maxBytes = kind === 'image' ? 256 * 1024 * 1024 : 512 * 1024 * 1024;
      if (bytes.byteLength === 0 || bytes.byteLength > maxBytes
        || createHash('sha256').update(bytes).digest('hex') !== expectedHash) {
        throw serviceError('PROVIDER_INVALID_RESPONSE',
          '提交状态不确定：已付费生成结果的本地暂存未通过完整性校验，请勿创建新的付费任务', false);
      }
      return bytes;
    },
    async remove(taskId: string): Promise<void> {
      if (appDataRoot === undefined) { memory.delete(taskId); return; }
      const path = pathFor(taskId);
      await deleteConfinedAppDataFile(fileSystem, {
        appDataRoot, targetPath: path, errorCode: 'PROVIDER_UNAVAILABLE', errorMessage: 'Pending provider result path is invalid',
      });
    },
  };
}

function missingPaidResult(): Error & { code: ProviderBridgeErrorCode; retryable: boolean } {
  return serviceError('PROVIDER_INVALID_RESPONSE',
    '提交状态不确定：已付费生成结果的本地暂存文件缺失，请勿创建新的付费任务', false);
}

async function finishPendingTask(
  tasks: NewApiServiceTaskStore,
  pendingMedia: ReturnType<typeof createPendingMediaStore>,
  publicTaskId: string,
  options: Parameters<typeof createNewApiProviderService>[0],
): Promise<void> {
  const initial = await tasks.read(publicTaskId);
  if (initial?.state !== 'pending') return;
  try {
    const bytes = await pendingMedia.read(publicTaskId, initial.kind, initial.resultHash);
    let pending = initial;
    if (pending.assetId === undefined) {
      // A legacy mapping has only an ephemeral session id. Once bound storage
      // is available, never guess that a newly opened project with the same id
      // is the paid result's original destination.
      if (options.bindGenerationProject !== undefined && pending.projectBinding === undefined) {
        throw serviceError('PROVIDER_UNAVAILABLE', 'Legacy generation project destination cannot be verified', false);
      }
      let assetId: string;
      if (pending.kind === 'image') {
        const mediaType = detectSecureImageMediaType(bytes);
        if (pending.projectBinding !== undefined) {
          if (options.storeGeneratedImageForProject === undefined) throw invalidRequest('Bound image storage is unavailable');
          assetId = (await options.storeGeneratedImageForProject(pending.projectBinding, bytes, mediaType)).assetId;
        } else {
          if (options.storeGeneratedImage === undefined) throw invalidRequest('Generated image storage is unavailable');
          const stored = await options.storeGeneratedImage(pending.sessionId, bytes, mediaType);
          assetId = typeof stored === 'string' ? stored : stored.assetId;
        }
      } else {
        assertMp4(bytes);
        if (pending.projectBinding !== undefined) {
          if (options.storeGeneratedVideoForProject === undefined) throw invalidRequest('Bound video storage is unavailable');
          assetId = (await options.storeGeneratedVideoForProject(pending.projectBinding, bytes, 'video/mp4')).assetId;
        } else {
          if (options.storeGeneratedVideo === undefined) throw invalidRequest('Generated video storage is unavailable');
          const stored = await options.storeGeneratedVideo(pending.sessionId, bytes, 'video/mp4');
          assetId = typeof stored === 'string' ? stored : stored.assetId;
        }
      }
      if (typeof assetId !== 'string' || assetId.length === 0) throw invalidRequest('Generated asset id is invalid');
      pending = { ...pending, assetId };
      await tasks.write(publicTaskId, pending);
    }
    if (pending.historyId !== undefined && options.historySink !== undefined) {
      const terminal = await options.historySink.succeeded(pending.historyId, bytes);
      if (terminal.status !== 'succeeded') throw serviceError('PROVIDER_UNAVAILABLE', 'Generation history is temporarily unavailable', true);
    }
    await tasks.write(publicTaskId, {
      kind: pending.kind, state: 'completed', assetId: pending.assetId!,
      ...(pending.historyId === undefined ? {} : { historyId: pending.historyId }),
    });
    try { await pendingMedia.remove(publicTaskId); } catch { /* ACK retries cleanup. */ }
  } catch (error) {
    if (await tasks.read(publicTaskId) === undefined) {
      try { await pendingMedia.remove(publicTaskId); } catch { /* The orphan file can be collected later. */ }
      return;
    }
    const failure = error instanceof Error && error.message === 'Generated result was invalid'
      ? serviceError('PROVIDER_INVALID_RESPONSE', error.message, false)
      : error;
    if (isTypedServiceFailure(failure) && !failure.retryable
      && (failure.code === 'PROVIDER_INVALID_RESPONSE' || failure.code === 'PROVIDER_UNAVAILABLE')) {
      await failIrrecoverableTask(tasks, pendingMedia, publicTaskId, initial, options, failure);
    }
    // Transient project, history, or media IO faults preserve the paid bytes.
  }
}

async function failIrrecoverableTask(
  tasks: NewApiServiceTaskStore,
  pendingMedia: ReturnType<typeof createPendingMediaStore>,
  publicTaskId: string,
  task: Extract<NewApiPrivateTask, { state: 'remote' | 'pending' }>,
  options: Parameters<typeof createNewApiProviderService>[0],
  error: Error & { readonly code: ProviderBridgeErrorCode; readonly retryable: boolean },
): Promise<void> {
  try {
    const history = task.historyId === undefined || options.historySink === undefined
      ? null
      : await options.historySink.failed(task.historyId,
        error.code === 'PROVIDER_INVALID_RESPONSE' ? 'invalid_result'
          : error.code === 'PROVIDER_UNAVAILABLE' ? 'provider_unavailable' : 'provider_failed');
    if (history?.status === 'succeeded') {
      if (task.state !== 'pending' || task.assetId === undefined) return;
      await tasks.write(publicTaskId, { kind: task.kind, state: 'completed', assetId: task.assetId, historyId: task.historyId });
    } else if (history?.status === 'cancelled') {
      await tasks.write(publicTaskId, { kind: task.kind, state: 'cancelled', ...(task.historyId === undefined ? {} : { historyId: task.historyId }) });
    } else {
      await tasks.write(publicTaskId, { kind: task.kind, state: 'failed', code: error.code,
        message: error.message, retryable: false,
        ...(task.historyId === undefined ? {} : { historyId: task.historyId }) });
    }
    try { await pendingMedia.remove(publicTaskId); } catch { /* Terminal ACK retries cleanup. */ }
  } catch {
    // History or mapping IO is still unavailable; retry terminalization on poll.
  }
}

async function cancelTaskWithDurableHistory(
  tasks: NewApiServiceTaskStore,
  publicTaskId: string,
  task: Extract<NewApiPrivateTask, { state: 'remote' | 'pending' }>,
  options: Parameters<typeof createNewApiProviderService>[0],
): Promise<NewApiPrivateTask> {
  let terminal: Awaited<ReturnType<NonNullable<typeof options.historySink>['cancelled']>> | null = null;
  if (task.historyId !== undefined && options.historySink !== undefined) {
    try { terminal = await options.historySink.cancelled(task.historyId, 'cancelled_by_user'); }
    catch { throw serviceError('PROVIDER_UNAVAILABLE', '提交状态不确定：生成历史暂不可用，请保留原任务等待恢复', true); }
    if (terminal.status === 'succeeded') {
      throw serviceError('PROVIDER_UNAVAILABLE', '提交状态不确定：生成结果已写入历史，请保留原任务等待恢复', true);
    }
  }
  const next: NewApiPrivateTask = terminal?.status === 'failed'
    ? { kind: task.kind, state: 'failed', code: 'PROVIDER_ERROR', message: 'Generation history already failed',
      retryable: false, ...(task.historyId === undefined ? {} : { historyId: task.historyId }) }
    : { kind: task.kind, state: 'cancelled', ...(task.historyId === undefined ? {} : { historyId: task.historyId }) };
  try {
    await tasks.write(publicTaskId, next);
    return await requireTask(tasks, publicTaskId, task.kind);
  } catch {
    throw serviceError('PROVIDER_UNAVAILABLE', '提交状态不确定：取消结果暂无法写入本地任务记录，请保留原任务等待恢复', true);
  }
}

async function reconcileDurableCancellation(
  tasks: NewApiServiceTaskStore,
  publicTaskId: string,
  task: NewApiPrivateTask,
  options: Parameters<typeof createNewApiProviderService>[0],
): Promise<NewApiPrivateTask> {
  if ((task.state !== 'remote' && task.state !== 'pending')
    || task.historyId === undefined || options.historySink === undefined) return task;
  let terminal: Awaited<ReturnType<NonNullable<typeof options.historySink>['getTerminal']>>;
  try { terminal = await options.historySink.getTerminal(task.historyId); }
  catch { throw serviceError('PROVIDER_UNAVAILABLE', '提交状态不确定：生成历史暂不可用，请保留原任务等待恢复', true); }
  if (terminal?.status !== 'cancelled') return task;
  try {
    await tasks.write(publicTaskId, { kind: task.kind, state: 'cancelled', historyId: task.historyId });
    return await requireTask(tasks, publicTaskId, task.kind);
  } catch {
    throw serviceError('PROVIDER_UNAVAILABLE', '提交状态不确定：取消结果暂无法写入本地任务记录，请保留原任务等待恢复', true);
  }
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
  projectBinding?: GenerationProjectBinding,
  videoSessionId?: string,
): Promise<{ readonly historyId?: string; readonly existingPublicTaskId?: string }> {
  if (options.providerTaskMappings === undefined || jobId === undefined || jobId.length === 0) {
    return { historyId: await reserveHistory(options.historySink, jobId, kind, modelDisplayName, options.provider) };
  }
  const historyId = deriveGenerationHistoryId(jobId);
  const existing = await options.providerTaskMappings.findByHistoryId(historyId);
  if (existing !== undefined) {
    if (existing.provider !== options.provider) throw serviceError('PROVIDER_INVALID_RESPONSE', 'Generation job provider identity is invalid', false);
    if (kind === 'video') {
      if (existing.historyId !== historyId || existing.kind !== 'video' || videoSessionId === undefined) {
        throw serviceError('PROVIDER_INVALID_RESPONSE', 'Generation job task identity is invalid', false);
      }
      assertExistingVideoIdentity(existing, videoSessionId, projectBinding);
    }
    assertExistingProjectBinding(existing.projectBinding, projectBinding);
    return { historyId, existingPublicTaskId: existing.publicTaskId };
  }
  if (options.historySink !== undefined) {
    const reservation = await options.historySink.reserveSubmission({ jobId, kind, modelDisplayName, provider: options.provider });
    if (reservation.historyId !== historyId) {
      throw serviceError('PROVIDER_INVALID_RESPONSE', 'Generation history reservation identity is invalid', false);
    }
    if (reservation.terminal !== null) {
      throw serviceError('PROVIDER_INVALID_RESPONSE', 'Generation history is already terminal', false);
    }
  }
  const created = await options.providerTaskMappings.reserveSubmission({
    currentIdentity: jobId.startsWith('model-job-v2-'),
    historyId,
  });
  if (!created) {
    const raced = await options.providerTaskMappings.findByHistoryId(historyId);
    if (raced !== undefined && raced.provider === options.provider) {
      if (kind === 'video') {
        if (raced.historyId !== historyId || raced.kind !== 'video' || videoSessionId === undefined) {
          throw serviceError('PROVIDER_INVALID_RESPONSE', 'Generation job task identity is invalid', false);
        }
        assertExistingVideoIdentity(raced, videoSessionId, projectBinding);
      }
      assertExistingProjectBinding(raced.projectBinding, projectBinding);
      return { historyId, existingPublicTaskId: raced.publicTaskId };
    }
    throw serviceError('PROVIDER_INVALID_RESPONSE', 'Generation job is already reserved; create a new run to submit again', false);
  }
  return { historyId };
}

function assertExistingProjectBinding(
  existing: GenerationProjectBinding | undefined,
  requested: GenerationProjectBinding | undefined,
): void {
  if (existing !== undefined && requested !== undefined
    && (existing.projectId !== requested.projectId || existing.rootFingerprint !== requested.rootFingerprint)) {
    throw invalidRequest('Generation job belongs to a different project');
  }
}

function assertExistingVideoIdentity(
  existing: { readonly sessionId?: string; readonly projectBinding?: GenerationProjectBinding },
  sessionId: string,
  projectBinding: GenerationProjectBinding | undefined,
): void {
  if ((existing.projectBinding === undefined) !== (projectBinding === undefined)) {
    throw invalidRequest('Generation job project binding cannot be verified');
  }
  if (projectBinding !== undefined) assertExistingProjectBinding(existing.projectBinding, projectBinding);
  else if (existing.sessionId !== sessionId) throw invalidRequest('Generation job belongs to a different project session');
}

async function requireReference(options: Parameters<typeof createNewApiProviderService>[0], sessionId: string, assetId: string) {
  if (options.readReferenceImage === undefined) throw invalidRequest('Reference image storage is unavailable');
  return options.readReferenceImage(sessionId, assetId);
}

async function persistAcceptedTask(
  tasks: NewApiServiceTaskStore,
  publicTaskId: string,
  task: NewApiPrivateTask,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { await tasks.write(publicTaskId, task, true); return; }
    catch (error) {
      if (attempt === 2) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, attempt === 0 ? 50 : 150));
    }
  }
}

async function recoverAcceptedTask(
  tasks: NewApiServiceTaskStore,
  pendingMedia: ReturnType<typeof createPendingMediaStore>,
  accepted: {
    readonly publicTaskId: string;
    readonly task: Extract<NewApiPrivateTask, { state: 'remote' | 'pending' }>;
    readonly bytes?: Uint8Array;
  },
): Promise<void> {
  if (accepted.task.state === 'pending') {
    if (accepted.bytes === undefined) throw invalidRequest('Accepted image bytes are unavailable');
    let staged = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const hash = await pendingMedia.stage(accepted.publicTaskId, accepted.task.kind, accepted.bytes);
        if (hash !== accepted.task.resultHash) throw invalidRequest('Accepted image bytes changed');
        staged = true;
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, attempt === 0 ? 50 : 150));
      }
    }
    if (!staged) throw serviceError('PROVIDER_UNAVAILABLE', 'Accepted image staging is unavailable', true);
  }
  await persistAcceptedTask(tasks, accepted.publicTaskId, accepted.task);
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
        const pending = /^newapi-pending-(image|video):([a-f0-9]{64})$/u.exec(record.rawTaskId);
        if (pending !== null) {
          if (pending[1] !== kind) return undefined;
          return {
            kind, state: 'pending', resultHash: pending[2]!, sessionId: record.sessionId,
            ...(record.projectBinding === undefined ? {} : { projectBinding: record.projectBinding }),
            ...(record.result?.assetId === undefined ? {} : { assetId: record.result.assetId }),
            ...(record.historyId === undefined ? {} : { historyId: record.historyId }),
          };
        }
        return {
          kind, state: 'remote', rawTaskId: record.rawTaskId, sessionId: record.sessionId,
          ...(record.projectBinding === undefined ? {} : { projectBinding: record.projectBinding }),
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
    async write(id, task, allowCreate = false) {
      const current = await ledger.get(id);
      if (current === undefined && !allowCreate) throw invalidRequest('Provider task was not found');
      const timestamp = now().toISOString();
      const base = {
        provider,
        publicTaskId: id,
        rawTaskId: task.state === 'remote' ? task.rawTaskId
          : task.state === 'pending' ? `newapi-pending-${task.kind}:${task.resultHash}`
          : current?.rawTaskId ?? `${provider}-synchronous`,
        kind: task.kind,
        ...(task.state === 'remote' || task.state === 'pending' ? {
          sessionId: task.sessionId,
          ...(task.projectBinding === undefined ? {} : { projectBinding: task.projectBinding }),
          ...(task.historyId === undefined ? {} : { historyId: task.historyId }),
        } : {
          ...(current?.sessionId === undefined ? {} : { sessionId: current.sessionId }),
          ...(current?.projectBinding === undefined ? {} : { projectBinding: current.projectBinding }),
          ...((task.historyId ?? current?.historyId) === undefined ? {} : { historyId: task.historyId ?? current?.historyId }),
        }),
        createdAt: current?.createdAt ?? timestamp,
        updatedAt: timestamp,
      } as const;
      if (task.state === 'remote' || task.state === 'pending') {
        const result = task.state === 'pending' && task.assetId !== undefined
          ? task.kind === 'image' ? { assetId: task.assetId, assetIds: [task.assetId] } : { assetId: task.assetId }
          : undefined;
        if (current === undefined) {
          await ledger.set({ ...base, state: 'running', ...(result === undefined ? {} : { result }) });
        } else {
          const updated = await ledger.updateRunning(id, {
            expectedRawTaskId: current.rawTaskId,
            ...(current.rawTaskId === base.rawTaskId ? {} : { rawTaskId: base.rawTaskId }),
            ...(result === undefined ? {} : { result }),
          }, timestamp);
          if (updated?.state !== 'running' || updated.rawTaskId !== base.rawTaskId
            || (result !== undefined && updated.result?.assetId !== result.assetId)) {
            throw serviceError('PROVIDER_UNAVAILABLE', 'Provider task changed while saving its result', true);
          }
        }
      } else if (task.state === 'completed') {
        const result = task.kind === 'image'
          ? { assetId: task.assetId, assetIds: [task.assetId] }
          : { assetId: task.assetId };
        const updated = await ledger.markTerminal(id, { status: 'completed', progress: 1, result }, timestamp);
        if (updated === undefined) throw serviceError('PROVIDER_UNAVAILABLE', 'Provider task mapping is unavailable', true);
      } else if (task.state === 'failed') {
        const updated = await ledger.markTerminal(id, { status: 'failed',
          error: serviceError(task.code ?? 'PROVIDER_ERROR', task.message, task.retryable) }, timestamp);
        if (updated === undefined) throw serviceError('PROVIDER_UNAVAILABLE', 'Provider task mapping is unavailable', true);
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

function resolveJulunVideoParameters(profile: NewApiModelProfile, request: NewApiVideoJobRequest) {
  const spec = getJulunVideoModelSpec(profile.modelId);
  if (spec === undefined || spec.kind === 'editing' || !spec.parameterEvidenceComplete) {
    throw capabilityError('Selected Julun model requires an unverified video request protocol or parameter contract');
  }
  const constraints = profile.constraints?.video;
  const publicConstraints = spec.constraints;
  const aspectRatio = request.aspectRatio ?? constraints?.aspectRatios?.[0] ?? publicConstraints.aspectRatios?.[0];
  const resolution = request.resolution ?? constraints?.resolutions?.[0] ?? publicConstraints.resolutions?.[0];
  const durationConstraint = constraints?.duration ?? publicConstraints?.duration;
  const duration = request.durationSeconds ?? durationConstraint?.defaultValue
    ?? (durationConstraint?.mode === 'options' ? durationConstraint.options[0] : durationConstraint?.min);
  if (aspectRatio === undefined || resolution === undefined || duration === undefined) {
    throw capabilityError('Selected Julun video parameters are not verified');
  }
  for (const allowed of [constraints, publicConstraints]) {
    if (allowed?.aspectRatios !== undefined && !allowed.aspectRatios.includes(aspectRatio)) {
      throw capabilityError('Selected Julun video model does not support the requested aspect ratio');
    }
    if (allowed?.resolutions !== undefined && !allowed.resolutions.includes(resolution)) {
      throw capabilityError('Selected Julun video model does not support the requested resolution');
    }
    const range = allowed?.duration;
    if (range?.mode === 'options' && !range.options.includes(duration)
      || range?.mode === 'range' && (duration < range.min || duration > range.max
        || Math.abs((duration - range.min) / range.step - Math.round((duration - range.min) / range.step)) > 1e-6)) {
      throw capabilityError('Selected Julun video model does not support the requested duration');
    }
  }
  if (!Number.isFinite(duration) || duration <= 0) throw capabilityError('Julun video duration is invalid');
  const durationMaximum = spec?.durationMaxByResolution?.[resolution];
  if (durationMaximum !== undefined && duration > durationMaximum) {
    throw capabilityError('Selected Julun resolution does not support the requested duration');
  }
  const exactSize = spec?.dimensionGrid?.find(entry => entry.resolution === resolution && entry.aspectRatio === aspectRatio);
  if (spec?.dimensionGrid !== undefined && exactSize === undefined) {
    throw capabilityError('Selected Julun video size is not verified');
  }
  const [width, height] = exactSize === undefined
    ? mapNewApiVideoSize(aspectRatio, resolution).split('x').map(Number) as [number, number]
    : [exactSize.width, exactSize.height];
  return { duration, width, height };
}

export function mapNewApiVideoSize(aspectRatio: VideoAspectRatio, resolution: string): string {
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
function uncertainPaidSubmission(error: unknown): Error & { code: ProviderBridgeErrorCode; retryable: boolean } {
  if (isTypedServiceFailure(error) && !error.retryable
    && (error.code === 'INVALID_REQUEST' || error.code === 'PROVIDER_INVALID_RESPONSE')) return error;
  return serviceError('PROVIDER_UNAVAILABLE',
    '提交状态不确定：供应商已接受生成任务，但本地任务记录暂不可用；请保留原任务，不要创建新的付费任务', true);
}
function serviceError(code: ProviderBridgeErrorCode, message: string, retryable: boolean): Error & { code: ProviderBridgeErrorCode; retryable: boolean } {
  return Object.assign(new Error(message), { code, retryable });
}
