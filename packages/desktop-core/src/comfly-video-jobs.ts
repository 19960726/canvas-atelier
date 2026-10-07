import type { ComflyVideoGenerationRequest } from '@agent-canvas/provider-comfly';
import {
  hasVerifiedComflyVideoSubmissionContract,
  supportsVerifiedComflyVideoInputMode,
} from '@agent-canvas/domain';
import type { ProviderTaskMappingRecord, ProviderTaskMappingStore } from './provider-task-ledger.js';
import { assertMatchingProjectBinding, persistPaidProviderMapping } from './provider-task-ledger.js';
import type { GenerationProjectBinding } from './generation-project-binding.js';
import type { FileSystem } from './file-system.js';
import type { ProviderMappingSecrets } from './provider-credential-vault.js';
import { createProviderPendingMediaStore, pendingMediaTaskMarker } from './provider-pending-media.js';
import {
  deriveGenerationHistoryId,
  type GenerationHistoryDurableTerminal,
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
  type ProviderVideoJobResult,
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
  readonly appDataRoot?: string;
  readonly fileSystem?: FileSystem;
  readonly secretSupplier?: () => Promise<ProviderMappingSecrets>;
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
  readonly bindGenerationProject?: (sessionId: string, expectedProjectId?: string) => Promise<GenerationProjectBinding>;
  readonly storeGeneratedVideoForProject?: (binding: GenerationProjectBinding, bytes: Uint8Array, mediaType: 'video/mp4') => Promise<{ readonly assetId: string; readonly width?: number | null; readonly height?: number | null }>;
  readonly createPublicTaskId: () => string;
  readonly nowIso: () => string;
}) {
  const pendingMedia = options.appDataRoot === undefined || options.secretSupplier === undefined ? undefined
    : createProviderPendingMediaStore({ appDataRoot: options.appDataRoot, fileSystem: options.fileSystem, secretSupplier: options.secretSupplier });
  const readPaidTask = async (publicTaskId: string) => {
    try { return await options.mappings.get(publicTaskId); }
    catch { throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '提交状态不确定：已付费视频任务记录暂不可用', true); }
  };
  const reconcileFailedHistory = async (
    task: ProviderTaskMappingRecord,
    durable: GenerationHistoryDurableTerminal,
    fallback: Extract<PollVideoJobBridgeResult, { status: 'failed' }>,
  ): Promise<Exclude<PollVideoJobBridgeResult, { status: 'running' }>> => {
    if (durable.status === 'failed') return fallback;
    const latest = await readPaidTask(task.publicTaskId);
    if (latest === undefined) throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider video job handle is unavailable');
    if (latest.state !== 'running') {
      const terminal = terminalToPoll(latest);
      if (terminal.status === (durable.status === 'succeeded' ? 'completed' : 'cancelled')) return terminal;
      throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '提交状态不确定：视频历史与任务终态暂不一致，请保留原任务', true);
    }
    if (durable.status === 'cancelled') return { status: 'cancelled' };
    if (latest.result === undefined) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '提交状态不确定：视频历史已完成，正在恢复任务结果，请保留原任务', true);
    return { status: 'completed', progress: 1, result: latest.result as ProviderVideoJobResult };
  };
  const persistVideoTerminal = async (
    publicTaskId: string,
    result: Exclude<PollVideoJobBridgeResult, { status: 'running' }>,
  ): Promise<PollVideoJobBridgeResult> => {
    let terminal: ProviderTaskMappingRecord | undefined;
    try {
      terminal = result.status === 'cancelled'
        ? await options.mappings.markCancelled(publicTaskId, options.nowIso())
        : await options.mappings.markTerminal(publicTaskId, result, options.nowIso());
    } catch { throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '提交状态不确定：已付费视频终态记录暂不可用', true); }
    if (terminal === undefined) {
      try { await pendingMedia?.remove(publicTaskId); } catch { /* Keep the ACK result authoritative. */ }
      throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider video job handle is unavailable');
    }
    if (terminal.state !== 'running') {
      try { await pendingMedia?.remove(publicTaskId); } catch { /* ACK retries confined cleanup. */ }
    }
    return terminalToPoll(terminal);
  };
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
      const projectBinding = options.bindGenerationProject === undefined ? undefined
        : await options.bindGenerationProject(validated.sessionId ?? '', validated.projectId);
      const references = await resolveManagedVideoImages(validated, options.readManagedGenerationImages);
      const historyId = deriveGenerationHistoryId(validated.jobId);
      const reservation = await options.historySink?.reserveSubmission({
        jobId: validated.jobId,
        kind: 'video',
        modelDisplayName: profile.displayName,
        provider: 'comfly',
      });
      if (reservation !== undefined && reservation.historyId !== historyId) {
        throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Generation history reservation identity is invalid');
      }
      if (reservation !== undefined && !reservation.created) {
        // History can outlive a lost mapping ledger. A queued history alone
        // cannot prove the provider POST never happened, so do not reserve a
        // fresh ledger entry and submit this paid job again.
        let existing: ProviderTaskMappingRecord | undefined;
        try { existing = await options.mappings.findByHistoryId(historyId); }
        catch { throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '提交状态不确定：已付费视频任务记录暂不可用，请保留原任务', true); }
        if (existing?.provider === 'comfly' && existing.kind === 'video') {
          assertMatchingProjectBinding(projectBinding, existing);
          return { providerTaskId: existing.publicTaskId };
        }
        throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '提交状态不确定：视频历史已预约但任务句柄不可确认，请保留原任务并检查供应商记录', true);
      }
      let created: boolean;
      try {
        created = await options.mappings.reserveSubmission({ currentIdentity: validated.jobId.startsWith(CURRENT_GENERATION_JOB_ID_PREFIX), historyId });
      } catch (error) {
        if (isKnownNonRetryableLedgerRejection(error)) throw error;
        throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '提交状态不确定：视频任务预留记录暂不可用，请使用原任务重试', true);
      }
      if (!created) {
        let existing: ProviderTaskMappingRecord | undefined;
        try { existing = await options.mappings.findByHistoryId(historyId); }
        catch { throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '提交状态不确定：已付费视频任务记录暂不可用', true); }
        if (existing?.provider === 'comfly' && existing.kind === 'video') { assertMatchingProjectBinding(projectBinding, existing); return { providerTaskId: existing.publicTaskId }; }
        throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '提交状态不确定：视频任务正在提交，请保留原任务等待恢复', true);
      }
      if (reservation?.terminal !== null && reservation?.terminal !== undefined) {
        throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '提交状态不确定：视频历史已结束但任务记录暂不可用，请保留原任务', true);
      }
      let providerAccepted = false;
      try {
        const response = await options.submitProvider(mapVideoGenerationRequest(validated, profile, references));
        providerAccepted = true;
        const publicTaskId = options.createPublicTaskId();
        const timestamp = options.nowIso();
        await persistPaidProviderMapping(options.mappings, {
          provider: 'comfly', publicTaskId, rawTaskId: response.taskId, kind: 'video',
          sessionId: validated.sessionId ?? validated.conversationId, historyId, projectBinding,
          state: 'running', createdAt: timestamp, updatedAt: timestamp,
        });
        try { await options.historySink?.running(historyId); } catch { /* The durable handle remains usable. */ }
        return { providerTaskId: publicTaskId };
      } catch (error) {
        if (providerAccepted) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '提交状态不确定：供应商已接受视频任务但本地任务记录暂不可用，请保留原任务等待恢复', true);
        if (!providerAccepted && options.historySink !== undefined) await options.historySink.failed(historyId, 'provider_unavailable');
        throw error;
      }
    },

    async pollVideoJob(request: PollVideoJobBridgeRequest): Promise<PollVideoJobBridgeResult> {
      const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.pollVideoJob, request) as PollVideoJobBridgeRequest;
      assertComfly(validated.provider);
      const task = await readPaidTask(validated.providerTaskId);
      if (task === undefined || task.kind !== 'video') throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider video job handle is unavailable');
      if (task.state !== 'running') return terminalToPoll(task);
      if (options.bindGenerationProject !== undefined && task.projectBinding === undefined) {
        const fallback: Extract<PollVideoJobBridgeResult, { status: 'failed' }> = { status: 'failed',
          error: normalizeProviderBridgeError(createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Original project identity cannot be verified; provider task remains recorded')) };
        let result: Exclude<PollVideoJobBridgeResult, { status: 'running' }> = fallback;
        try {
          if (task.historyId !== undefined && options.historySink !== undefined) {
            result = await reconcileFailedHistory(task, await options.historySink.failed(task.historyId, 'provider_unavailable'), fallback);
          }
        }
        catch { throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '提交状态不确定：已付费视频历史暂不可用，请保留原任务重试', true); }
        return persistVideoTerminal(task.publicTaskId, result);
      }
      try {
      let pending = await pendingMedia?.read(task);
      const mapped: MappedVideoTaskState = pending === undefined || pending === null
        ? mapTaskState(await options.pollProvider(task.rawTaskId, validated.providerTaskId))
        : { status: 'provider_completed', resultUrl: '', ...(pending.entries[0]?.durationSeconds === undefined ? {} : { durationSeconds: pending.entries[0].durationSeconds }) };
      let result: PollVideoJobBridgeResult;
      if (mapped.status === 'provider_completed') {
        if ((task.projectBinding === undefined && options.storeGeneratedVideo === undefined) || task.sessionId === undefined) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Generated video storage is unavailable', true);
        const bytes = pending === undefined || pending === null
          ? await options.downloadResult(mapped.resultUrl) : await pendingMedia!.readItem(pending, 0);
        if (!hasMp4Signature(bytes)) {
          result = { status: 'failed', error: normalizeProviderBridgeError(
            createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid video result'),
          ) };
        } else {
          if (pending === undefined || pending === null) {
            const entry = await pendingMedia?.writeItem(task, 0, bytes,
              mapped.durationSeconds === undefined ? {} : { durationSeconds: mapped.durationSeconds });
            if (entry !== undefined) {
              await pendingMedia!.seal(task, [entry]);
              pending = await pendingMedia!.read(task);
              if (pending === null) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '提交状态不确定：已付费视频暂存记录暂不可用', true);
            }
          }
          let current = await readPaidTask(task.publicTaskId);
          if (pending !== undefined && pending !== null && current?.state === 'running') {
            const marker = pendingMediaTaskMarker(pending);
            if (current.rawTaskId !== marker) {
              try { current = await options.mappings.updateRunning(task.publicTaskId, {
                expectedRawTaskId: task.rawTaskId, rawTaskId: marker,
              }, options.nowIso()); }
              catch { throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '提交状态不确定：已付费视频暂存状态暂不可用', true); }
            }
            if (current?.state === 'running' && current.rawTaskId !== marker) {
              throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '提交状态不确定：已付费视频暂存状态暂不可用', true);
            }
          }
          if (current === undefined) {
            try { await pendingMedia?.remove(task.publicTaskId); } catch { /* Keep the ACK result authoritative. */ }
            throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider video job handle is unavailable');
          }
          if (current.state !== 'running') {
            try { await pendingMedia?.remove(task.publicTaskId); } catch { /* ACK retries cleanup. */ }
            return terminalToPoll(current);
          }
          const stored = current.result === undefined
            ? task.projectBinding === undefined
              ? await options.storeGeneratedVideo!(task.sessionId, bytes, 'video/mp4')
              : await requireBoundVideoStore(options.storeGeneratedVideoForProject)(task.projectBinding, bytes, 'video/mp4')
            : current.result as ProviderVideoJobResult;
          const storedResult: ProviderVideoJobResult = {
            assetId: stored.assetId,
            ...(stored.width == null ? {} : { width: stored.width }),
            ...(stored.height == null ? {} : { height: stored.height }),
            ...(mapped.durationSeconds === undefined ? {} : { durationSeconds: mapped.durationSeconds }),
          };
          try { current = await options.mappings.updateRunning(task.publicTaskId, { result: storedResult }, options.nowIso()); }
          catch { throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '提交状态不确定：已付费视频结果记录暂不可用', true); }
          if (current === undefined) {
            try { await pendingMedia?.remove(task.publicTaskId); } catch { /* Keep the ACK result authoritative. */ }
            throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider video job handle is unavailable');
          }
          if (current.state !== 'running') {
            try { await pendingMedia?.remove(task.publicTaskId); } catch { /* ACK retries cleanup. */ }
            return terminalToPoll(current);
          }
          let invalidHistoryMedia = false;
          let historyCancelled = false;
          if (options.historySink !== undefined && task.historyId !== undefined) {
            try {
              const durable = await options.historySink.succeeded(task.historyId, bytes, {
                ...(stored.width == null ? {} : { width: stored.width }),
                ...(stored.height == null ? {} : { height: stored.height }),
                ...(mapped.durationSeconds === undefined ? {} : { durationSeconds: mapped.durationSeconds }),
              });
              historyCancelled = durable.status === 'cancelled';
              invalidHistoryMedia = durable.status === 'failed';
            } catch (error) {
              if (error instanceof Error && error.message === 'Generated result was invalid') invalidHistoryMedia = true;
              else throw createProviderBridgeError('PROVIDER_ERROR', 'Generated video history is temporarily unavailable', true);
            }
          }
          result = historyCancelled ? { status: 'cancelled' } : invalidHistoryMedia ? { status: 'failed', error: normalizeProviderBridgeError(
            createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid video result'),
          ) } : { status: 'completed', progress: 1, result: current.result as ProviderVideoJobResult };
        }
      } else result = mapped;
      if (result.status === 'failed' && options.historySink !== undefined && task.historyId !== undefined) {
        result = await reconcileFailedHistory(task, await options.historySink.failed(task.historyId, 'provider_failed'), result);
      }
      if (result.status !== 'running') return persistVideoTerminal(validated.providerTaskId, result);
      return result;
      } catch (error) {
        if (!isPaidMediaIntegrityFailure(error)) throw paidVideoPollError(error);
        const fallback: Extract<PollVideoJobBridgeResult, { status: 'failed' }> = { status: 'failed', error: normalizeProviderBridgeError(error) };
        let result: Exclude<PollVideoJobBridgeResult, { status: 'running' }> = fallback;
        try {
          if (task.historyId !== undefined && options.historySink !== undefined) {
            result = await reconcileFailedHistory(task, await options.historySink.failed(task.historyId, 'invalid_result'), fallback);
          }
        }
        catch { throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '提交状态不确定：已付费视频历史暂不可用', true); }
        return persistVideoTerminal(task.publicTaskId, result);
      }
    },

    async cancelVideoJob(request: CancelVideoJobBridgeRequest): Promise<CancelVideoJobBridgeResult> {
      const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.cancelVideoJob, request) as CancelVideoJobBridgeRequest;
      assertComfly(validated.provider);
      const current = await readPaidTask(validated.providerTaskId);
      if (current === undefined || current.kind !== 'video') throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider video job handle is unavailable');
      if (current.state !== 'running') return terminalToCancel(current);
      if (options.historySink !== undefined && current.historyId !== undefined) {
        let durable: Awaited<ReturnType<GenerationHistoryProviderSinkContract['cancelled']>>;
        try { durable = await options.historySink.cancelled(current.historyId, 'cancelled_by_user'); }
        catch { throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '提交状态不确定：视频历史暂不可用，请保留原任务重试', true); }
        if (durable.status !== 'cancelled') {
          const latest = await readPaidTask(validated.providerTaskId);
          if (latest === undefined) throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider video job handle is unavailable');
          if (latest.state !== 'running') return terminalToCancel(latest);
          if (durable.status === 'succeeded' && latest.result === undefined) {
            throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '提交状态不确定：视频历史已完成，正在恢复任务结果，请保留原任务重试', true);
          }
          const result: Extract<PollVideoJobBridgeResult, { status: 'completed' | 'failed' }> = durable.status === 'succeeded'
            ? { status: 'completed', progress: 1, result: latest.result as ProviderVideoJobResult }
            : { status: 'failed', error: normalizeProviderBridgeError(createProviderBridgeError('PROVIDER_ERROR', '视频任务历史已失败，请检查生成历史')) };
          let terminal: ProviderTaskMappingRecord | undefined;
          try { terminal = await options.mappings.markTerminal(validated.providerTaskId, result, options.nowIso()); }
          catch { throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '提交状态不确定：视频任务终态暂不可用，请保留原任务重试', true); }
          if (terminal === undefined) throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider video job handle is unavailable');
          try { await pendingMedia?.remove(validated.providerTaskId); } catch { /* ACK retries confined cleanup. */ }
          return terminalToCancel(terminal);
        }
      }
      let terminal: ProviderTaskMappingRecord | undefined;
      try { terminal = await options.mappings.markCancelled(validated.providerTaskId, options.nowIso()); }
      catch { throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '提交状态不确定：视频任务终态暂不可用，请保留原任务重试', true); }
      if (terminal === undefined) throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider video job handle is unavailable');
      try { await pendingMedia?.remove(validated.providerTaskId); } catch { /* ACK retries confined cleanup. */ }
      return terminalToCancel(terminal);
    },

    async ackVideoJobTerminal(request: AckVideoJobTerminalBridgeRequest): Promise<AckVideoJobTerminalBridgeResult> {
      const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.ackVideoJobTerminal, request) as AckVideoJobTerminalBridgeRequest;
      assertComfly(validated.provider);
      await options.mappings.ackTerminal(validated.providerTaskId, validated.status);
      await pendingMedia?.remove(validated.providerTaskId);
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

function isPaidMediaIntegrityFailure(error: unknown): error is { readonly code: 'PROVIDER_INVALID_RESPONSE'; readonly message: string } {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'PROVIDER_INVALID_RESPONSE'
    && 'message' in error && typeof error.message === 'string' && error.message.startsWith('提交状态不确定');
}

function isKnownNonRetryableLedgerRejection(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error
    && error.code === 'PROVIDER_INVALID_RESPONSE' && 'retryable' in error && error.retryable === false;
}

function paidVideoPollError(error: unknown): Error {
  if (error instanceof Error && 'retryable' in error && error.retryable === false) return error;
  if (error instanceof Error && error.message.startsWith('提交状态不确定')) return error;
  const code = error instanceof Error && 'code' in error && error.code === 'PROVIDER_ERROR'
    ? 'PROVIDER_ERROR' : 'PROVIDER_UNAVAILABLE';
  return createProviderBridgeError(code, '提交状态不确定：已付费视频任务暂不可用，请保留原任务并重试', true);
}

function requireBoundVideoStore(store: ((binding: GenerationProjectBinding, bytes: Uint8Array, mediaType: 'video/mp4') => Promise<{ readonly assetId: string; readonly width?: number | null; readonly height?: number | null }>) | undefined) {
  if (store === undefined) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Bound video storage is unavailable', true);
  return store;
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
