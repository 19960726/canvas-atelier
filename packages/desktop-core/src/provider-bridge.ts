import { randomBytes } from 'node:crypto';
import {
  ComflyClient,
  mergeComflyModelRegistries,
  type ComflyFetch,
  type ComflyModelRegistration,
} from '@agent-canvas/provider-comfly';
import type { FileSystem } from './file-system.js';
import { createSecureProviderCredentialStore, type ProviderCredentialStore, type SafeStorageAdapter } from './provider-credential-vault.js';
import {
  createProviderTaskMappingStore,
  type ProviderTaskMappingRecord,
} from './provider-task-ledger.js';
import { createProviderConfigurationStore } from './provider-configuration-store.js';
import { createElectronNetComflyFetch } from './electron-net-fetch.js';
import { ManagedKnowledgeStore } from './managed-knowledge-store.js';
import { readPinnedReverseKnowledge } from './provider-reverse-knowledge.js';
import {
  executeSkillChat,
  type ManagedSkillChatImageResolver,
  type ProjectMemoryContextResolver,
} from './provider-skill-chat.js';
import { createStoryboardService } from './storyboard-service.js';
import { buildProfessionalReverseRequest } from './professional-reverse-analysis.js';
import type {
  GenerationHistoryDurableTerminal,
  GenerationHistoryFailureCode,
  GenerationHistoryProviderSinkContract,
} from './generation-history-provider-sink.js';
import { deriveGenerationHistoryId } from './generation-history-provider-sink.js';
import { buildComflyModelProfiles, cloneProviderProfile, mergeProviderModelProfiles } from './provider-model-catalog.js';
import { createComflyVideoJobHandlers } from './comfly-video-jobs.js';
import { isPublicProviderAddress, parseSafeProviderResultUrl } from './provider-result-security.js';
import type { ProviderService } from './provider-service-types.js';
import { decodeProviderInlineImage } from './provider-inline-image.js';
import { detectGeneratedImageMediaType, findFirstProviderImageResult, parseDirectProviderImageResponse } from './provider-image-result.js';
import { extractGeminiReverseText } from './reverse-provider-result.js';
import { parseReverseProviderResponse } from './reverse-provider-response.js';
import {
  PROVIDER_BRIDGE_CHANNELS,
  createProviderBridgeError,
  normalizeProviderBridgeError,
  parseProviderBridgeProfiles,
  parseProviderBridgeRequest, parseProviderBridgeResponse,
  type AckImageJobTerminalBridgeRequest,
  type AckImageJobTerminalBridgeResult,
  type AckVideoJobTerminalBridgeRequest,
  type AckVideoJobTerminalBridgeResult,
  type AnalyzeReversePromptBridgeRequest,
  type CancelImageJobBridgeRequest,
  type CancelImageJobBridgeResult,
  type CancelVideoJobBridgeRequest,
  type CancelVideoJobBridgeResult,
  type ConfigureProviderBridgeRequest,
  type UpdateProviderProfilesBridgeRequest,
  type GenerateStoryboardBridgeRequest,
  type GenerateStoryboardBridgeResult,
  type PollImageJobBridgeRequest,
  type PollImageJobBridgeResult,
  type PollVideoJobBridgeRequest,
  type PollVideoJobBridgeResult,
  type ProviderBridgeException,
  type ProviderBridgeProfile,
  type ProviderBridgeProvider,
  type ProviderConfigurationStatus,
  type ProviderConnectionCheckResult,
  type SubmitImageJobBridgeRequest,
  type SubmitImageJobBridgeResult,
  type SubmitVideoJobBridgeRequest,
  type SubmitVideoJobBridgeResult,
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
  parseProviderBridgeResponse,
};
export type { AckImageJobTerminalBridgeRequest, AckImageJobTerminalBridgeResult, AnalyzeReversePromptBridgeRequest, AnalyzeReversePromptBridgeResult, ChatSkillBridgeRequest, ChatSkillBridgeResult, CancelImageJobBridgeRequest, CancelImageJobBridgeResult, ConfigureProviderBridgeRequest, UpdateProviderProfilesBridgeRequest, ListProviderTasksBridgeRequest, ListProviderTasksBridgeResult, PollImageJobBridgeRequest, PollImageJobBridgeResult, ProviderBridgeBlockedReason, ProviderBridgeChannel, ProviderBridgeCapability, ProviderBridgeError, ProviderBridgeErrorCode, ProviderBridgeException, ProviderBridgeProfile, ProviderConfigurationStatus, ProviderConnectionCheckResult, ProviderImageJobResult, ManagedReversePromptMediaIdentity, RevealProviderCredentialBridgeResult, SubmitImageJobBridgeRequest, SubmitImageJobBridgeResult, UnlockProviderBridgeRequest } from './provider-contracts.js';
export type { ProviderCredentialStore, SafeStorageAdapter } from './provider-credential-vault.js';
const DEFAULT_COMFLY_BASE_URL = 'https://ai.comfly.org'; const DEFAULT_TERMINAL_TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CURRENT_GENERATION_JOB_ID_PREFIX = 'model-job-v2-';
const REVERSE_PROVIDER_TIMEOUT_MS = 300_000;
export const DEFAULT_PROVIDER_PROFILES: ProviderBridgeProfile[] = [];
export type { ProviderBridgeHandlers, ProviderIpcMainLike, ProviderService } from './provider-service-types.js';
export { registerProviderBridgeHandlers } from './provider-ipc-registration.js';
export { createProviderBridgeHandlers } from './provider-ipc-handlers.js';
interface ConfigurationSnapshot {
  readonly baseUrl: string;
  readonly profiles: readonly ProviderBridgeProfile[];
}
type RuntimeSnapshot = ConfigurationSnapshot & { readonly token: string; readonly imageToken: string; readonly languageToken: string };
export function createComflyProviderService(options: {
  readonly appDataRoot: string;
  readonly credentialStore: ProviderCredentialStore;
  readonly fetch: ComflyFetch; readonly discoverModelCatalog?: boolean;
  readonly fileSystem?: FileSystem;
  readonly profiles?: readonly ProviderBridgeProfile[];
  readonly providerModels?: readonly ProviderBridgeProfile[];
  readonly baseUrl?: string;
  readonly now?: () => number;
  readonly terminalTombstoneTtlMs?: number;
  readonly timeoutMs?: number;
  readonly historySink?: GenerationHistoryProviderSinkContract;
  readonly resolveResultHost?: (hostname: string) => Promise<readonly string[]>;
  readonly readManagedReverseMedia?: (sessionId: string, media: AnalyzeReversePromptBridgeRequest['media']) => Promise<readonly { readonly bytes: Uint8Array; readonly mediaType: string }[]>;
  readonly projectMemoryContextResolver?: ProjectMemoryContextResolver;
  readonly readManagedSkillChatImages?: ManagedSkillChatImageResolver['readManagedSkillChatImages'];
  readonly readManagedGenerationImages?: (
    sessionId: string,
    referenceAssetIds: readonly string[],
  ) => Promise<readonly {
    readonly bytes: Uint8Array;
    readonly mediaType: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';
  }[]>;
  readonly storeGeneratedImage?: (sessionId: string, bytes: Uint8Array, mediaType: string) => Promise<{ readonly assetId: string; readonly width?: number | null; readonly height?: number | null }>;
  readonly storeGeneratedVideo?: (sessionId: string, bytes: Uint8Array, mediaType: 'video/mp4') => Promise<{ readonly assetId: string; readonly width?: number | null; readonly height?: number | null }>;
}): ProviderService {
  let configurationCache: ConfigurationSnapshot = {
    profiles: sanitizeProfiles(options.profiles ?? DEFAULT_PROVIDER_PROFILES),
    baseUrl: options.baseUrl ?? DEFAULT_COMFLY_BASE_URL,
  };
  let configureTail: Promise<void> = Promise.resolve();
  let configurationOverride: ConfigurationSnapshot | null = null;
  let discoveredProfileCache: ProviderBridgeProfile[] | null = null;
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
  const managedKnowledgeStore = new ManagedKnowledgeStore({
    appDataRoot: options.appDataRoot,
    fileSystem: options.fileSystem,
  });
  const createClient = (snapshot: RuntimeSnapshot, role: 'image' | 'language' = 'language') => new ComflyClient({
    baseUrl: snapshot.baseUrl,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
    tokenSupplier: async () => role === 'image' ? snapshot.imageToken : snapshot.languageToken,
  });
  const videoJobs = createComflyVideoJobHandlers({
    mappings: providerTaskMappings,
    listProfiles: async () => (await captureRuntimeSnapshot()).profiles,
    submitProvider: async (input) => {
      const snapshot = await captureRuntimeSnapshot();
      return translateProviderCall(() => createClient(snapshot, 'image').generateVideo(input));
    },
    pollProvider: async (rawTaskId, publicTaskId) => {
      const snapshot = await captureRuntimeSnapshot();
      return translateProviderCall(
        () => createClient(snapshot, 'image').getVideoTask(rawTaskId),
        { publicTaskId, rawTaskId, request: 'poll' },
      );
    },
    downloadResult: async (url) => downloadProviderResult(url),
    historySink: options.historySink,
    storeGeneratedVideo: options.storeGeneratedVideo,
    createPublicTaskId: createPublicProviderTaskId,
    nowIso,
  });  return {
    getStatus() {
      return options.credentialStore.getStatus();
    },
    async revealCredential() { return { token: await options.credentialStore.getPrimaryToken() }; },
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
        const updatesCredentials = validated.token !== undefined;
        if (!updatesCredentials) {
          const credentialStatus = await options.credentialStore.getStatus();
          if (!credentialStatus.configured || credentialStatus.locked) throw createProviderBridgeError(credentialStatus.locked ? 'CREDENTIALS_LOCKED' : 'PROVIDER_UNAVAILABLE', 'Configure and unlock provider credentials before updating the API endpoint');
        }
        await providerConfiguration.write(nextConfiguration);
        try {
          if (updatesCredentials) await options.credentialStore.configure({ token: validated.token!, ...(validated.imageToken === undefined ? {} : { imageToken: validated.imageToken }), ...(validated.languageToken === undefined ? {} : { languageToken: validated.languageToken }), ...(validated.imageTokens === undefined ? {} : { imageTokens: validated.imageTokens }), ...(validated.reverseTokens === undefined ? {} : { reverseTokens: validated.reverseTokens }), passphrase: validated.passphrase });
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
        discoveredProfileCache = null;
        await gcTerminalTombstones();
        return options.credentialStore.getStatus();
  });
    },
    updateProfiles(request) {
      return enqueueConfigure(async () => {
        const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.updateProfiles, request) as UpdateProviderProfilesBridgeRequest;
        const status = await options.credentialStore.getStatus();
        if (!status.configured || status.locked) throw createProviderBridgeError(status.locked ? 'CREDENTIALS_LOCKED' : 'PROVIDER_UNAVAILABLE', 'Configure and unlock the provider before saving model routes');
        const persisted = await providerConfiguration.readPersisted();
        const currentConfiguration = persisted.exists ? persisted.snapshot : configurationCache;
        const nextConfiguration: ConfigurationSnapshot = { baseUrl: currentConfiguration.baseUrl, profiles: mergeUpdatedProfiles(currentConfiguration.profiles, parseProviderBridgeProfiles(validated.profiles)) };
        await providerConfiguration.write(nextConfiguration);
        configurationOverride = null;
        configurationCache = cloneConfiguration(nextConfiguration);
        discoveredProfileCache = null;
        return options.credentialStore.getStatus();
      });
    },
    async unlock(request) {
      const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.unlock, request) as UnlockProviderBridgeRequest;
      await options.credentialStore.unlock(validated);
      await gcTerminalTombstones();
      return options.credentialStore.getStatus();
    },
    async listAvailableModelIds() {
      const snapshot = await captureRuntimeSnapshot();
      return createClient(snapshot, 'language').listModelIds();
    },
    async listProfiles() {
      await gcTerminalTombstones();
      const configuration = await captureConfigurationSnapshot();
      const configuredProfiles = configuredProfilesFor(configuration);
      if (options.discoverModelCatalog !== true) return configuredProfiles;
      const status = await options.credentialStore.getStatus();
      if (!status.configured || status.locked) return configuredProfiles;
      return (await captureRuntimeSnapshot()).profiles.map(cloneProfile);
    },
    async submitImageJob(request) {
      await gcTerminalTombstones();
      const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.submitImageJob, request) as SubmitImageJobBridgeRequest;
      const snapshot = await captureRuntimeSnapshot();
      const profile = selectProfile(snapshot.profiles, validated.provider, validated.modelRoute);
      const historyId = deriveGenerationHistoryId(validated.jobId);
      const existingMapping = await providerTaskMappings.findByHistoryId(historyId);
      if (existingMapping !== undefined) return { providerTaskId: existingMapping.publicTaskId };
      const references = validated.referenceAssetIds.length === 0
        ? []
        : await requireManagedGenerationImages(validated, profile, options.readManagedGenerationImages);
      const prompt = buildGenerationReferencePrompt(validated.prompt, references.length);
      if (references.length > 0 && !profile.capabilities.includes('image_edit')
        && !profile.capabilities.includes('gemini_native')) {
        throw createProviderBridgeError(
          'CAPABILITY_UNSUPPORTED',
          'Selected image model does not support reference images',
        );
      }
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
      if (profile.capabilities.includes('gemini_native') && profile.capabilities.includes('image_generation')) {
        if (options.storeGeneratedImage === undefined) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Generated image storage is unavailable');
        try {
          const image = await translateProviderCall(() => createClient(snapshot, 'image').generateGeminiImage({
            model: profile.modelId ?? profile.modelRoute,
            prompt,
            images: references,
          }));
          const stored = await options.storeGeneratedImage(validated.sessionId ?? validated.conversationId, image.bytes, image.mimeType);
          const publicTaskId = createPublicProviderTaskId();
          const timestamp = nowIso();
          await providerTaskMappings.set({ provider: 'comfly', publicTaskId, rawTaskId: `gemini-inline-${publicTaskId}`, historyId, state: 'completed', createdAt: timestamp, updatedAt: timestamp, terminalAt: timestamp, result: { assetId: stored.assetId, ...(stored.width === null || stored.width === undefined ? {} : { width: stored.width }), ...(stored.height === null || stored.height === undefined ? {} : { height: stored.height }) } });
          if (options.historySink !== undefined) await options.historySink.succeeded(historyId, image.bytes);
          return { providerTaskId: publicTaskId };
        } catch (error) { if (options.historySink !== undefined) await options.historySink.failed(historyId, historyFailureCode(error)); throw error; }
      }
      try {
        const response = await translateProviderCall(() => createClient(snapshot, 'image').generateImage({
          model: profile.modelId ?? profile.modelRoute,
          prompt,
          image: references.map((item) =>
            `data:${item.mediaType};base64,${Buffer.from(item.bytes).toString('base64')}`),
          ...(profile.capabilities.includes('async_tasks') ? { async: true } : {}),
          ...(validated.aspectRatio === undefined ? {} : { aspect_ratio: validated.aspectRatio }),
          ...(validated.resolution === undefined ? {} : { size: validated.resolution }),
          ...(validated.outputCount === undefined ? {} : { n: validated.outputCount as 1 | 2 | 3 | 4 }),
        }));
        assertProviderResponsePayload(response);
        let directResult = profile.capabilities.includes('async_tasks') ? undefined : parseDirectProviderImageResponse(response);
        let parsed: ReturnType<typeof parseImageTaskResponse> | undefined;
        if (directResult === undefined) {
          try {
            parsed = parseImageTaskResponse(response);
          } catch (taskError) {
            directResult = parseDirectProviderImageResponse(response);
            if (directResult === undefined) throw taskError;
          }
        }
        if (directResult !== undefined) {
          if (options.storeGeneratedImage === undefined) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Generated image storage is unavailable');
          const bytes = directResult.inlineBytes ?? await downloadProviderResult(directResult.resultUrl);
          const mediaType = detectGeneratedImageMediaType(bytes);
          const stored = await options.storeGeneratedImage(validated.sessionId ?? validated.conversationId, bytes, mediaType);
          const publicTaskId = createPublicProviderTaskId();
          const timestamp = nowIso();
          await providerTaskMappings.set({
            provider: 'comfly',
            publicTaskId,
            rawTaskId: `direct-image-${publicTaskId}`,
            historyId,
            state: 'completed',
            createdAt: timestamp,
            updatedAt: timestamp,
            terminalAt: timestamp,
            result: {
              assetId: stored.assetId,
              ...(stored.width === null || stored.width === undefined ? {} : { width: stored.width }),
              ...(stored.height === null || stored.height === undefined ? {} : { height: stored.height }),
            },
          });
          if (options.historySink !== undefined) await options.historySink.succeeded(historyId, bytes);
          return { providerTaskId: publicTaskId };
        }
        if (parsed === undefined) throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image task response');
        const publicTaskId = createPublicProviderTaskId();
        const timestamp = nowIso();
        await providerTaskMappings.set({
          provider: 'comfly',
          publicTaskId,
          rawTaskId: parsed.taskId, sessionId: validated.sessionId ?? validated.conversationId, historyId,
          state: 'running',
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        if (options.historySink !== undefined) await options.historySink.running(historyId);
        return { providerTaskId: publicTaskId };
      } catch (error) {
        if (options.historySink !== undefined) {
          await options.historySink?.failed(historyId, historyFailureCode(error));
        }
        throw error;
      }
    },
    submitVideoJob: videoJobs.submitVideoJob,
    pollVideoJob: videoJobs.pollVideoJob,
    cancelVideoJob: videoJobs.cancelVideoJob,
    ackVideoJobTerminal: videoJobs.ackVideoJobTerminal,
    async analyzeReversePrompt(request) {
      const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.analyzeReversePrompt, request) as AnalyzeReversePromptBridgeRequest;
      const snapshot = await captureRuntimeSnapshot();
      const profile = snapshot.profiles.find((item) => item.provider === validated.provider && item.modelRoute === validated.run.agentConfig?.modelRoute);
      const hasVideo = validated.run.orderedMedia.some((item) => item.kind === 'video');
      const usesGeminiNative = profile?.capabilities.includes('gemini_native') === true;
      const usesVisionChat = profile?.capabilities.includes('chat') === true && profile.capabilities.includes('vision');
      if (profile === undefined || !profile.capabilities.includes('reverse_prompt') || (!usesGeminiNative && !usesVisionChat) || (hasVideo && (!usesGeminiNative || !profile.capabilities.includes('video_understanding')))) {
        throw createProviderBridgeError(
          'PROVIDER_UNAVAILABLE',
          profile === undefined
            ? 'Requested reverse-analysis model profile is unavailable'
            : hasVideo && !profile.capabilities.includes('video_understanding')
              ? 'Selected reverse model does not support video understanding'
              : 'Selected model does not declare reverse_prompt and vision capabilities',
        );
      }
      if (options.readManagedReverseMedia === undefined) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Managed reverse-analysis media is unavailable');
      const media = await options.readManagedReverseMedia(validated.sessionId, validated.media);
      const knowledge = await readPinnedReverseKnowledge(managedKnowledgeStore, validated.run.knowledgeLease.snapshots);
      const reverseRequest = buildProfessionalReverseRequest(validated.run, knowledge);
      let responseText: string | undefined;
      let finishReason: string | undefined;
      if (usesGeminiNative) {
        const response = await createClient(snapshot, 'language').generateGeminiContent({
          model: profile.modelId ?? profile.modelRoute,
          generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 16_384 },
          contents: [{ role: 'user', parts: [
            { text: JSON.stringify(reverseRequest) },
            ...media.map((item) => ({ inlineData: { mimeType: item.mediaType, data: Buffer.from(item.bytes).toString('base64') } })),
          ] }],
        }, REVERSE_PROVIDER_TIMEOUT_MS);
        const candidate = response.candidates[0];
        finishReason = candidate?.finishReason;
        responseText = extractGeminiReverseText(candidate?.content?.parts);
      } else {
        const response = await createClient(snapshot, 'language').chat({
          model: profile.modelId ?? profile.modelRoute,
          messages: [{ role: 'system', content: `${reverseRequest.systemRole} Return only valid ReversePromptResult JSON that follows every required section and evidence rule.` }, { role: 'user', content: [
            { type: 'text', text: JSON.stringify(reverseRequest) },
            ...media.map((item) => ({ type: 'image_url', image_url: { url: `data:${item.mediaType};base64,${Buffer.from(item.bytes).toString('base64')}` } })),
          ] }],
        }, REVERSE_PROVIDER_TIMEOUT_MS);
        const choice = response.choices[0];
        const content = choice?.message?.content;
        finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined;
        responseText = typeof content === 'string' ? content : undefined;
      }
      return parseReverseProviderResponse({ text: responseText, finishReason }, validated.run);
    },
    async chat(request) {
      return executeSkillChat({
        request,
        captureRuntimeSnapshot,
        createClient,
        managedKnowledgeStore,
        projectMemoryContextResolver: options.projectMemoryContextResolver,
        managedSkillChatImageResolver: options.readManagedSkillChatImages === undefined
          ? undefined
          : { readManagedSkillChatImages: options.readManagedSkillChatImages },
      });
    },
    async generateStoryboard(request) {
      const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.generateStoryboard, request) as GenerateStoryboardBridgeRequest;
      const service = createStoryboardService({
        listProfiles: async () => (await captureRuntimeSnapshot()).profiles,
        runStructuredChat: async (input) => {
          const snapshot = await captureRuntimeSnapshot();
          const profile = snapshot.profiles.find((item) => item.provider === validated.provider && item.modelRoute === input.modelRoute);
          if (profile === undefined) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Requested storyboard model profile is unavailable');
          const response = await createClient(snapshot, 'language').chat({
            model: profile.modelId ?? profile.modelRoute,
            messages: [{
              role: 'system',
              content: 'Return only JSON: {"shots":[{"id":"shot-1","order":1,"title":"...","composition":"...","durationSeconds":4,"referenceAssetIds":[]}]} . Do not include paths, URLs, base64, credentials, or any canvas mutation.',
            }, {
              role: 'user',
              content: JSON.stringify({ script: input.script, shotCount: input.shotCount, referenceAssetIds: input.referenceAssetIds }),
            }],
          });
          const content = response.choices[0]?.message?.content;
          if (typeof content !== 'string') throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid storyboard response');
          return content;
        },
      });
      return service.generate(validated) as Promise<GenerateStoryboardBridgeResult>;
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
      if (task.state !== 'running') return terminalMappingToPollResult(task);
      if (task.historyId !== undefined && options.historySink !== undefined) {
        const durableTerminal = await options.historySink.getTerminal(task.historyId);
        if (durableTerminal !== null && durableTerminal.status !== 'succeeded') return await commitHistoryTerminal(validated.providerTaskId, durableTerminal);
      }
      const snapshot = await captureRuntimeSnapshot();
      let response: unknown;
      try {
        response = await translateProviderCall(
          () => createClient(snapshot, 'image').getImageTask(task.rawTaskId),
          { publicTaskId: validated.providerTaskId, rawTaskId: task.rawTaskId, request: 'poll' },
        );
      } catch (error) {
        if (isCredentialsLocked(error)) return blockedCredentialsPollResult();
        throw error;
      }
      const mapped = mapImageTaskPollResult(validated.provider, validated.providerTaskId, task.rawTaskId, response);
      let result = mapped.publicResult;
      if (result.status === 'completed' && options.storeGeneratedImage !== undefined && task.sessionId !== undefined) {
        try {
          const bytes = mapped.inlineBytes ?? await downloadProviderResult(mapped.resultUrl);
          const stored = await options.storeGeneratedImage(task.sessionId, bytes, detectGeneratedImageMediaType(bytes));
          result = { status: 'completed', progress: 1, result: { assetId: stored.assetId, ...(stored.width === null || stored.width === undefined ? {} : { width: stored.width }), ...(stored.height === null || stored.height === undefined ? {} : { height: stored.height }) } };
          if (task.historyId !== undefined && options.historySink !== undefined) await options.historySink.succeeded(task.historyId, bytes);
        } catch {
          if (task.historyId !== undefined && options.historySink !== undefined) await options.historySink.failed(task.historyId, 'invalid_result');
          result = { status: 'failed', error: createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image result') };
        }
      } else if (task.historyId !== undefined && options.historySink !== undefined) {
        let effective: GenerationHistoryDurableTerminal | null = null;
        if (result.status === 'completed') {
          try {
            const bytes = mapped.inlineBytes ?? await downloadProviderResult(mapped.resultUrl);
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
    const runtime: RuntimeSnapshot = {
      ...snapshot,
      token: await options.credentialStore.getToken('language'),
      imageToken: await options.credentialStore.getToken('image'),
      languageToken: await options.credentialStore.getToken('language'),
    };
    if (options.discoverModelCatalog !== true) {
      return { ...runtime, profiles: configuredProfilesFor(snapshot) };
    }
    if (discoveredProfileCache !== null) {
      return { ...runtime, profiles: discoveredProfileCache.map(cloneProfile) };
    }
    try {
      discoveredProfileCache = mergeProviderModelProfiles([
        ...buildComflyModelProfiles(await createClient(runtime, 'language').listAccessibleModelCatalog()),
        ...configuredProfilesFor(snapshot),
      ]);
      return { ...runtime, profiles: discoveredProfileCache.map(cloneProfile) };
    } catch {
      return { ...runtime, profiles: configuredProfilesFor(snapshot) };
    }
  }
  function configuredProfilesFor(snapshot: ConfigurationSnapshot): ProviderBridgeProfile[] {
    return sanitizeProfiles(mergeComflyModelRegistries({
      providerModels: options.providerModels ?? [],
      profileModels: snapshot.profiles,
    }));
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
function mergeUpdatedProfiles(existing: readonly ProviderBridgeProfile[], updates: readonly ProviderBridgeProfile[]): ProviderBridgeProfile[] {
  const updatesByRoute = new Map(updates.map((profile) => [profile.modelRoute, profile]));
  return parseProviderBridgeProfiles([...existing.filter((profile) => !updatesByRoute.has(profile.modelRoute)), ...updates]);
}
function selectProfile(
  profiles: readonly ProviderBridgeProfile[],
  provider: ProviderBridgeProvider,
  modelRoute: string,
): ProviderBridgeProfile {
  assertSupportedProvider(provider);
  const profile = profiles.find((item) => item.provider === provider && item.modelRoute === modelRoute);
  if (profile === undefined || !profile.capabilities.includes('image_generation')) {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Requested image model profile is unavailable');
  }
  return profile;
}
function buildGenerationReferencePrompt(prompt: string, count: number): string {
  if (count === 0) return prompt;
  const contract = [
    '@1 is the authoritative scene: preserve its composition, camera, lighting, and background.',
  ];
  if (count >= 2) {
    contract.push(
      '@2 is the authoritative replacement product: preserve its identity, proportions, material, color, and logo.',
      'Replace only the primary subject in @1 with @2. Do not blend, duplicate, or redesign the scene.',
    );
  }
  if (count > 2) contract.push('@3 and later images are supplemental references only.');
  return [...contract, prompt].join('\n');
}
async function requireManagedGenerationImages(
  request: SubmitImageJobBridgeRequest,
  _profile: ProviderBridgeProfile,
  reader: ((
    sessionId: string,
    referenceAssetIds: readonly string[],
  ) => Promise<readonly {
    readonly bytes: Uint8Array;
    readonly mediaType: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';
  }[]>) | undefined,
) {
  if (request.referenceAssetIds.length > 0 && request.sessionId === undefined) {
    throw createProviderBridgeError(
      'INVALID_REQUEST',
      'Reference image generation requires an open desktop project',
    );
  }
  if (reader === undefined) {
    throw createProviderBridgeError(
      'PROVIDER_UNAVAILABLE',
      'Managed reference images are unavailable',
    );
  }
  const images = await reader(request.sessionId!, request.referenceAssetIds);
  if (images.length !== request.referenceAssetIds.length) {
    throw createProviderBridgeError(
      'INVALID_REQUEST',
      'Managed reference images are unavailable',
    );
  }
  return images;
}
function assertSupportedProvider(provider: string): asserts provider is 'comfly' {
  if (provider !== 'comfly') {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Provider is unavailable');
  }
}
function parseImageTaskResponse(value: unknown): { taskId: string; status: string; data?: unknown } {
  assertProviderResponsePayload(value);
  const envelope = isPlainRecord(value) && isPlainRecord(value.data)
    && (typeof value.data.taskId === 'string' || typeof value.data.task_id === 'string')
    && typeof value.data.status === 'string'
    ? value.data
    : value;
  if (!isPlainRecord(envelope)) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image task response');
  }
  const taskId = typeof envelope.taskId === 'string' ? envelope.taskId : envelope.task_id;
  if (typeof taskId !== 'string' || taskId.length === 0 || typeof envelope.status !== 'string') {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image task response');
  }
  return {
    taskId,
    status: envelope.status,
    data: envelope.data ?? envelope.output ?? envelope.result,
  };
}

function mapImageTaskPollResult(
  provider: string,
  publicTaskId: string,
  rawTaskId: string,
  value: unknown,
): { readonly publicResult: PollImageJobBridgeResult; readonly resultUrl?: string; readonly inlineBytes?: Uint8Array; readonly inlineMediaType?: string } {
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
  const first = findFirstProviderImageResult(task.data);
  if (!isPlainRecord(first)) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned no image result');
  }
  const inlineBytes = decodeProviderInlineImage(first.b64_json);
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
    ...(inlineBytes === undefined ? {} : { inlineBytes, inlineMediaType: 'image/png' }),
  };
}

function historyFailureCode(error: unknown): GenerationHistoryFailureCode {
  if (isProviderBridgeError(error) && (error.code === 'PROVIDER_INVALID_RESPONSE' || error.code === 'PROTECTED_PAYLOAD')) {
    return 'invalid_result';
  }
  return 'provider_unavailable';
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

function cloneProfile(profile: ProviderBridgeProfile): ProviderBridgeProfile {
  return cloneProviderProfile(profile);
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
