import type { ComflyVideoGenerationRequest } from '@agent-canvas/provider-comfly';
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

export function createComflyVideoJobHandlers(options: {
  readonly mappings: ProviderTaskMappingStore;
  readonly listProfiles: () => Promise<readonly ProviderBridgeProfile[]>;
  readonly submitProvider: (input: ComflyVideoGenerationRequest) => Promise<{ readonly taskId: string }>;
  readonly pollProvider: (rawTaskId: string, publicTaskId: string) => Promise<ComflyVideoTaskState>;
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
        && item.capabilities.includes('video_generation'));
      if (profile === undefined) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Requested video model profile is unavailable');
      if (validated.referenceAssetIds.length > 0) throw createProviderBridgeError('CAPABILITY_UNSUPPORTED', 'Comfly managed video references require a verified upload bridge');
      if ((validated.outputCount ?? 1) !== 1) throw createProviderBridgeError('CAPABILITY_UNSUPPORTED', 'Comfly video jobs must be submitted one result at a time');
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
        const response = await options.submitProvider({
          model: profile.modelId ?? profile.modelRoute,
          prompt: validated.prompt,
          ...(validated.aspectRatio === undefined ? {} : { aspect_ratio: validated.aspectRatio }),
          ...(validated.resolution === undefined ? {} : { resolution: validated.resolution === '4K' ? '4k' : validated.resolution === '2K' ? '2k' : validated.resolution }),
          ...(validated.durationSeconds === undefined ? {} : { duration: validated.durationSeconds }),
          ...(validated.audioEnabled === undefined ? {} : { audio: validated.audioEnabled }),
        });
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
        assertMp4(bytes);
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
  const status = value.status.toUpperCase();
  const progress = value.progress === undefined ? undefined : Math.max(0, Math.min(1, value.progress > 1 ? value.progress / 100 : value.progress));
  if (status === 'NOT_START' || status === 'IN_PROGRESS') return { status: 'running', progress };
  if (status === 'FAILURE') return { status: 'failed', error: normalizeProviderBridgeError(createProviderBridgeError('PROVIDER_ERROR', 'Provider video task failed', true)) };
  if (status !== 'SUCCESS' || typeof value.data?.output !== 'string') throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid video task response');
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

function assertMp4(bytes: Uint8Array): void {
  if (bytes.byteLength < 12 || Buffer.from(bytes.buffer, bytes.byteOffset + 4, 4).toString('ascii') !== 'ftyp') throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid video result');
}

function assertComfly(provider: string): asserts provider is 'comfly' {
  if (provider !== 'comfly') throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Provider is unavailable');
}
