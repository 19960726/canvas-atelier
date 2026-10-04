import { createProviderBridgeError } from './provider-contracts.js';
import type { GenerationHistoryDurableTerminal, GenerationHistoryProviderSinkContract } from './generation-history-provider-sink.js';
import type { GenerationProjectBinding } from './generation-project-binding.js';
import { assertMatchingProjectBinding, type ProviderTaskMappingStore } from './provider-task-ledger.js';

type HistorySubmission = Parameters<GenerationHistoryProviderSinkContract['reserveSubmission']>[0];

export async function reserveComflyImageSubmission(options: {
  readonly jobId: string;
  readonly historyId: string;
  readonly historySubmission: HistorySubmission;
  readonly historySink?: GenerationHistoryProviderSinkContract;
  readonly mappings: ProviderTaskMappingStore;
  readonly projectBinding?: GenerationProjectBinding;
}): Promise<{ readonly publicTaskId: string } | { readonly terminal: GenerationHistoryDurableTerminal } | null> {
  const { historyId, historySink, mappings, projectBinding } = options;
  let reservation;
  try {
    reservation = await historySink?.reserveSubmission(options.historySubmission);
  } catch (error) {
    if (!isHistoryReservationConflict(error)) throw error;
    throw alreadyReserved();
  }
  if (reservation !== undefined && reservation.historyId !== historyId) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Generation history reservation identity is invalid');
  }
  if (reservation?.terminal !== null && reservation?.terminal !== undefined) {
    if (projectBinding !== undefined) throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Generation job project identity is unavailable');
    return { terminal: reservation.terminal };
  }
  if (reservation !== undefined && !reservation.created) {
    const existing = await mappings.findByHistoryId(historyId);
    if (existing !== undefined) {
      assertMatchingProjectBinding(projectBinding, existing);
      return { publicTaskId: existing.publicTaskId };
    }
    throw alreadyReserved();
  }
  const created = await mappings.reserveSubmission({
    currentIdentity: options.jobId.startsWith('model-job-v2-'), historyId,
  });
  if (created) return null;
  const existing = await mappings.findByHistoryId(historyId);
  if (existing !== undefined) {
    assertMatchingProjectBinding(projectBinding, existing);
    return { publicTaskId: existing.publicTaskId };
  }
  let terminal: GenerationHistoryDurableTerminal | null = null;
  try {
    terminal = await historySink?.getTerminal(historyId) ?? null;
  } catch {
    // The paid-submission tombstone remains authoritative after history deletion.
  }
  if (terminal !== null) {
    if (projectBinding !== undefined) throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Generation job project identity is unavailable');
    return { terminal };
  }
  throw alreadyReserved();
}

function isHistoryReservationConflict(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'HISTORY_INVALID_REQUEST';
}

function alreadyReserved(): Error {
  return createProviderBridgeError('PROVIDER_INVALID_RESPONSE', '该任务提交状态无法确认；请保留原任务并检查供应商记录，勿新建付费任务');
}
