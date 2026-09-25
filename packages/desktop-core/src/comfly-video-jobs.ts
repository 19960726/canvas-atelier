import type { ComflyVideoGenerationRequest } from '@agent-canvas/provider-comfly';
import {
  hasVerifiedComflyVideoSubmissionContract,
  supportsVerifiedComflyVideoInputMode,
} from '@agent-canvas/domain';
import type { ProviderTaskMappingRecord, ProviderTaskMappingStore } from './provider-task-ledger.js';
import {
  deriveGenerationHistoryId,
  type GenerationHistoryProviderSinkContract,
} from './generation-history-provider-sink.js';
import {
  PROVIDER_BRIDGE_CHANNELS,
  createProviderBridgeError,
  normalizeProviderBridgeError,
  parseProviderBridgeRequest,
  type AckVideoJobTerminalBridgeRequest,
  type AckVideoJobTerminalBridgeResult,
  type CancelVideoJobBridgeRequest,
  type CancelVideoJobBridgeResult,
  type PollVideoJobBridgeRequest,
  type PollVideoJobBridgeResult,
  type ProviderBridgeProfile,
  type SubmitVideoJobBridgeRequest,
  type SubmitVideoJobBridgeResult,
} from './provider-contracts.js';

const CURRENT_GENERATION_JOB_ID_PREFIX = 'model-job-v2-';

export interface ComflyVideoTaskState {
  readonly taskId: string;
  readonly status: string;
  readonly progress?: number;
  readonly failReason?: string;
  readonly data?: { readonly output?: string; readonly duration?: number };
}

interface ManagedComflyVideoImage {
  readonly bytes: Uint8Array;
  readonly mediaType: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';
}

export function createComflyVideoJobHandlers(options: {
  readonly mappings: ProviderTaskMappingStore;
  readonly listProfiles: () => Promise<readonly ProviderBridgeProfile[]>;
  readonly submitProvider: (input: ComflyVideoGenerationRequest) => Promise<{ readonly taskId: string }>;
  readonly pollProvider: (rawTaskId: string, publicTaskId: string) => Promise<ComflyVideoTaskState>;
  readonly readManagedGenerationImages?: (
    sessionId: string,
    referenceAssetIds: readonly string[],
  ) => Promise<readonly ManagedComflyVideoImage[]>;
  readonly downloadResult: (url: string) => Promise<Uint8Array>;
  readonly historySink?: GenerationHistoryProviderSinkContract;
  readonly storeGeneratedVideo?: (sessionId: string, bytes: Uint8Array, mediaType: 'video/mp4') => Promise<{ readonly assetId: string; readonly width?: number | null; readonly height?: number | null }>;
  readonly createPublicTaskId: () => string;
  readonly nowIso: () => string;
}) {
  return {
    async submitVideoJob(request: SubmitVideoJobBridgeRequest): Promise<SubmitVideoJobBridgeResult> {
      const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.submitVideoJob, request) as SubmitVideoJobBridgeRequest;
      assertComfly(validated.provider);
      const profile = (await options.listProfiles()).find((item) => item.provider === 'comfly'
        && item.modelRoute === validated.modelRoute
        && item.enabled !== false
        && item.capabilityStatus !== 'incomplete'
        && item.capabilities.includes('video_generation'));
      if (profile === undefined) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Requested video model profile is unavailable');
      if ((validated.outputCount ?? 1) !== 1) throw createProviderBridgeError('CAPABILITY_UNSUPPORTED', 'Comfly video jobs must be submitted one result at a time');
      assertComflyVideoInputMode(profile.modelId ?? profile.modelRoute, validated.referenceAssetIds.length);
      const references = await resolveManagedVideoImages(validated, options.readManagedGenerationImages);
      const historyId = deriveGenerationHistoryId(validated.jobId);
      const created = await options.mappings.reserveSubmission({ currentIdentity: validated.jobId.startsWith(CURRENT_GENERATION_JOB_ID_PREFIX), historyId });
      if (!created) {
        const existing = await options.mappings.findByHistoryId(historyId);
        if (existing?.kind === 'video') return { providerTaskId: existing.publicTaskId };
        throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Video job is already reserved; create a new run to submit again');
      }
      try {
        const reservation = await options.historySink?.reserveSubmission({
          jobId: validated.jobId,
          kind: 'video',
          modelDisplayName: profile.displayName,
          provider: 'comfly',
        });
        if (reservation !== undefined && reservation.historyId !== historyId) {
          throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Generation history reservation identity is invalid');
        }
        const response = await options.submitProvider(mapVideoGenerationRequest(validated, profile, references));
        const publicTaskId = options.createPublicTaskId();
        const timestamp = options.nowIso();
        await options.mappings.set({
          provider: 'comfly', publicTaskId, rawTaskId: response.taskId, kind: 'video',
          sessionId: validated.sessionId ?? validated.conversationId, historyId,
          state: 'running', createdAt: timestamp, updatedAt: timestamp,
        });
        if (options.historySink !== undefined) await options.historySink.running(historyId);
        return { providerTaskId: publicTaskId };
      } catch (error) {
        if (options.historySink !== undefined) await options.historySink.failed(historyId, 'provider_unavailable');
        throw error;
      }
    },

    async pollVideoJob(request: PollVideoJobBridgeRequest): Promise<PollVideoJobBridgeResult> {
      const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.pollVideoJob, request) as PollVideoJobBridgeRequest;
      assertComfly(validated.provider);
      const task = await options.mappings.get(validated.providerTaskId);
      if (task === undefined || task.kind !== 'video') throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider video job handle is unavailable');
      if (task.state !== 'running') return terminalToPoll(task);
      const mapped = mapTaskState(await options.pollProvider(task.rawTaskId, validated.providerTaskId));
      let result: PollVideoJobBridgeResult;
      if (mapped.status === 'provider_completed') {
        if (options.storeGeneratedVideo === undefined || task.sessionId === undefined) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Generated video storage is unavailable');
        const bytes = await options.downloadResult(mapped.resultUrl);
        if (!hasMp4Signature(bytes)) {
          result = { status: 'failed', error: normalizeProviderBridgeError(
            createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid video result'),
          ) };
        } else {
          const stored = await options.storeGeneratedVideo(task.sessionId, bytes, 'video/mp4');
          if (options.historySink !== undefined && task.historyId !== undefined) {
            await options.historySink.succeeded(task.historyId, bytes, {
              ...(stored.width == null ? {} : { width: stored.width }),
              ...(stored.height == null ? {} : { height: stored.height }),
              ...(mapped.durationSeconds === undefined ? {} : { durationSeconds: mapped.durationSeconds }),
            });
          }
          result = { status: 'completed', progress: 1, result: {
            assetId: stored.assetId,
            ...(stored.width == null ? {} : { width: stored.width }),
            ...(stored.height == null ? {} : { height: stored.height }),
            ...(mapped.durationSeconds === undefined ? {} : { durationSeconds: mapped.durationSeconds }),
          } };
        }
      } else result = mapped;
      if (result.status === 'failed' && options.historySink !== undefined && task.historyId !== undefined) {
        await options.historySink.failed(task.historyId, 'provider_failed');
      }
      if (result.status === 'completed' || result.status === 'failed') {
        const terminal = await options.mappings.markTerminal(validated.providerTaskId, result, options.nowIso());
        return terminal === undefined ? result : terminalToPoll(terminal);
      }
      return result;
    },

    async cancelVideoJob(request: CancelVideoJobBridgeRequest): Promise<CancelVideoJobBridgeResult> {
      const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.cancelVideoJob, request) as CancelVideoJobBridgeRequest;
      assertComfly(validated.provider);
      const current = await options.mappings.get(validated.providerTaskId);
      if (current === undefined || current.kind !== 'video') throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider video job handle is unavailable');
      if (current.state !== 'running') return terminalToCancel(current);
      if (options.historySink !== undefined && current.historyId !== undefined) {
        await options.historySink.cancelled(current.historyId, 'cancelled_by_user');
      }
      const terminal = await options.mappings.markCancelled(validated.providerTaskId, options.nowIso());
      if (terminal === undefined) throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider video job handle is unavailable');
      return terminalToCancel(terminal);
    },

    async ackVideoJobTerminal(request: AckVideoJobTerminalBridgeRequest): Promise<AckVideoJobTerminalBridgeResult> {
      const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.ackVideoJobTerminal, request) as AckVideoJobTerminalBridgeRequest;
      assertComfly(validated.provider);
      await options.mappings.ackTerminal(validated.providerTaskId, validated.status);
      return { acknowledged: true };
    },
  };
}

type MappedVideoTaskState =
  | { readonly status: 'running'; readonly progress?: number }
  | { readonly status: 'failed'; readonly error: ReturnType<typeof normalizeProviderBridgeError> }
  | { readonly status: 'provider_completed'; readonly resultUrl: string; readonly durationSeconds?: number };

function mapTaskState(value: ComflyVideoTaskState): MappedVideoTaskState {
  const status = value.status.trim().toUpperCase();
  const progress = value.progress === undefined ? undefined : Math.max(0, Math.min(1, value.progress > 1 ? value.progress / 100 : value.progress));
  if (status === 'NOT_START' || status === 'IN_PROGRESS') return { status: 'running', progress };
  if (status === 'FAILURE') {
    const reason = value.failReason?.trim();
    const message = reason === undefined || reason.length === 0
      ? 'Provider video task failed'
      : `Provider video task failed: ${reason}`;
    return { status: 'failed', error: normalizeProviderBridgeError(createProviderBridgeError('PROVIDER_ERROR', message, true)) };
  }
  if (status !== 'SUCCESS' || typeof value.data?.output !== 'string') {
    return { status: 'failed', error: normalizeProviderBridgeError(
      createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid video task response'),
    ) };
  }
  return { status: 'provider_completed', resultUrl: value.data.output, ...(typeof value.data.duration === 'number' && value.data.duration > 0 ? { durationSeconds: value.data.duration } : {}) };
}

function terminalToPoll(record: ProviderTaskMappingRecord): PollVideoJobBridgeResult {
  if (record.state === 'completed' && record.result !== undefined) return { status: 'completed', progress: 1, result: record.result } as PollVideoJobBridgeResult;
  if (record.state === 'failed' && record.error !== undefined) return { status: 'failed', error: record.error };
  if (record.state === 'cancelled') return { status: 'cancelled' };
  return { status: 'running', progress: undefined };
}

function terminalToCancel(record: ProviderTaskMappingRecord): CancelVideoJobBridgeResult {
  const result = terminalToPoll(record);
  if (result.status === 'running') throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider video job handle is unavailable');
  return result;
}

function hasMp4Signature(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 12 && Buffer.from(bytes.buffer, bytes.byteOffset + 4, 4).toString('ascii') === 'ftyp';
}

function assertComfly(provider: string): asserts provider is 'comfly' {
  if (provider !== 'comfly') throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Provider is unavailable');
}

export {
  hasVerifiedComflyVideoSubmissionContract,
  supportsVerifiedComflyVideoInputMode,
} from '@agent-canvas/domain';

function assertComflyVideoInputMode(model: string, referenceCount: number): void {
  const normalizedModel = model.trim().toLocaleLowerCase();
  if (supportsVerifiedComflyVideoInputMode(normalizedModel, referenceCount)) return;
  if (normalizedModel.startsWith('wan')) {
    throw createProviderBridgeError(
      'CAPABILITY_UNSUPPORTED',
      'The selected Comfly Wan model does not support this reference-image mode',
    );
  }
  if (normalizedModel.includes('seedance')) {
    if (!hasVerifiedComflyVideoSubmissionContract(normalizedModel)) {
      throw createProviderBridgeError(
        'CAPABILITY_UNSUPPORTED',
        'The selected Comfly Seedance model has no verified video submission contract',
      );
    }
    throw createProviderBridgeError(
      'CAPABILITY_UNSUPPORTED',
      'The selected Comfly Seedance model does not support this reference-image mode',
    );
  }
  if (normalizedModel.startsWith('veo')) {
    if (referenceCount === 0) {
      throw createProviderBridgeError(
        'CAPABILITY_UNSUPPORTED',
        'The selected Comfly Veo model requires a verified reference image',
      );
    }
    if (!supportsVerifiedComflyVideoInputMode(normalizedModel, 1)) {
      throw createProviderBridgeError(
        'CAPABILITY_UNSUPPORTED',
        'The selected Comfly Veo model does not support reference images',
      );
    }
    throw createProviderBridgeError(
      'CAPABILITY_UNSUPPORTED',
      'The selected Comfly Veo model does not support this many reference images',
    );
  }
  throw createProviderBridgeError(
    'CAPABILITY_UNSUPPORTED',
    'The selected Comfly video model has no verified submission contract',
  );
}

async function resolveManagedVideoImages(
  request: SubmitVideoJobBridgeRequest,
  reader: ((sessionId: string, referenceAssetIds: readonly string[]) => Promise<readonly ManagedComflyVideoImage[]>) | undefined,
): Promise<readonly ManagedComflyVideoImage[]> {
  if (request.referenceAssetIds.length === 0) return [];
  if (request.sessionId === undefined) {
    throw createProviderBridgeError('INVALID_REQUEST', 'Reference video generation requires an open desktop project');
  }
  if (reader === undefined) {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Managed video reference images are unavailable');
  }
  let images: readonly ManagedComflyVideoImage[];
  try {
    images = await reader(request.sessionId, request.referenceAssetIds);
  } catch {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Managed video reference images are unavailable');
  }
  if (
    images.length !== request.referenceAssetIds.length
    || images.some((image) => image.bytes.byteLength === 0)
  ) {
    throw createProviderBridgeError('INVALID_REQUEST', 'Managed video reference images are unavailable');
  }
  return images;
}

function mapVideoGenerationRequest(
  request: SubmitVideoJobBridgeRequest,
  profile: ProviderBridgeProfile,
  references: readonly ManagedComflyVideoImage[],
): ComflyVideoGenerationRequest {
  const model = profile.modelId ?? profile.modelRoute;
  const images = references.map((image) =>
    `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString('base64')}`);
  const normalizedModel = model.toLocaleLowerCase();
  if (normalizedModel.includes('seedance')) {
    return {
      model,
      prompt: request.prompt,
      ...(images.length === 0 ? {} : { images }),
      ...(request.aspectRatio === undefined ? {} : { ratio: request.aspectRatio }),
      ...(request.resolution === undefined ? {} : { resolution: normalizeVideoResolution(request.resolution) }),
      ...(request.durationSeconds === undefined ? {} : { duration: request.durationSeconds }),
      ...(request.audioEnabled === undefined ? {} : { generate_audio: request.audioEnabled }),
    };
  }
  if (normalizedModel.startsWith('wan')) {
    if (images.length > 0) {
      return {
        model,
        prompt: request.prompt,
        images,
        ...(request.resolution === undefined ? {} : { resolution: normalizeWanImageResolution(request.resolution) }),
        ...(request.durationSeconds === undefined ? {} : { duration: request.durationSeconds }),
      };
    }
    const size = mapWanTextVideoSize(request.resolution, request.aspectRatio);
    return {
      model,
      prompt: request.prompt,
      ...(size === undefined ? {} : { size }),
      ...(request.durationSeconds === undefined ? {} : { duration: request.durationSeconds }),
    };
  }
  if (normalizedModel.startsWith('veo') || normalizedModel.startsWith('omni_')) {
    return {
      model,
      prompt: request.prompt,
      ...(images.length === 0 ? {} : { images }),
      ...(request.aspectRatio === undefined ? {} : { aspect_ratio: request.aspectRatio }),
    };
  }
  return {
    model,
    prompt: request.prompt,
    ...(images.length === 0 ? {} : { images }),
    ...(request.aspectRatio === undefined ? {} : { aspect_ratio: request.aspectRatio }),
    ...(request.resolution === undefined ? {} : { resolution: normalizeVideoResolution(request.resolution) }),
    ...(request.durationSeconds === undefined ? {} : { duration: request.durationSeconds }),
    ...(request.audioEnabled === undefined ? {} : { audio: request.audioEnabled }),
  };
}

function normalizeVideoResolution(value: NonNullable<SubmitVideoJobBridgeRequest['resolution']>) {
  return value === '4K' ? '4k' : value === '2K' ? '2k' : value;
}

function normalizeWanImageResolution(
  value: NonNullable<SubmitVideoJobBridgeRequest['resolution']>,
): ComflyVideoGenerationRequest['resolution'] {
  if (value === '2K' || value === '4K') return value;
  if (value === '480p' || value === '720p' || value === '1080p') return value.toUpperCase() as '480P' | '720P' | '1080P';
  return undefined;
}

function mapWanTextVideoSize(
  resolution: SubmitVideoJobBridgeRequest['resolution'],
  aspectRatio: SubmitVideoJobBridgeRequest['aspectRatio'],
): string | undefined {
  if (resolution === undefined || resolution === '2K' || resolution === '4K') return undefined;
  const sizes: Readonly<Record<string, Readonly<Partial<Record<NonNullable<SubmitVideoJobBridgeRequest['aspectRatio']>, string>>>>> = {
    '480p': { '16:9': '832x480', '9:16': '480x832', '1:1': '624x624' },
    '720p': { '16:9': '1280x720', '9:16': '720x1280', '1:1': '960x960', '4:3': '1088x832', '3:4': '832x1088' },
    '1080p': { '16:9': '1920x1080', '9:16': '1080x1920', '1:1': '1440x1440', '4:3': '1632x1248', '3:4': '1248x1632' },
  };
  return sizes[resolution]?.[aspectRatio ?? '16:9'];
}
