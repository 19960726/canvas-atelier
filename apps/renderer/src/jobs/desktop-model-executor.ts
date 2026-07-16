import { sanitizeModelJobError, type ModelJob } from '@agent-canvas/domain';
import type { ModelJobExecutor, ModelJobPollResult, ModelJobSubmission } from './job-store';

type ProviderPollResult = Awaited<ReturnType<NonNullable<Window['novusDesktop']>['provider']['pollImageJob']>>;
type ProviderCancelResult = Awaited<ReturnType<NonNullable<Window['novusDesktop']>['provider']['cancelImageJob']>>;

export function createDesktopModelJobExecutor(): ModelJobExecutor {
  return {
    async submit(job) {
      return getProviderBridge().submitImageJob(toSubmitRequest(job));
    },
    async poll(job) {
      if (!job.providerTaskId) {
        throw new Error('Provider task id is required before polling');
      }
      let result: ProviderPollResult;
      try {
        result = await getProviderBridge().pollImageJob({
          provider: requireProviderField(job.provider),
          providerTaskId: job.providerTaskId,
        });
      } catch (error) {
        if (isCredentialsLocked(error)) {
          return { status: 'running', blockedReason: 'credentials_locked', progress: undefined };
        }
        throw error;
      }
      return sanitizePollResult(result);
    },
    async cancel(job) {
      if (!job.providerTaskId) return;
      const result = await getProviderBridge().cancelImageJob({
        provider: requireProviderField(job.provider),
        providerTaskId: job.providerTaskId,
      });
      return sanitizePollResult(result);
    },
    async ackTerminal(job) {
      if (!job.providerTaskId || (job.status !== 'completed' && job.status !== 'failed' && job.status !== 'cancelled')) {
        return;
      }
      await getProviderBridge().ackImageJobTerminal({
        provider: requireProviderField(job.provider),
        providerTaskId: job.providerTaskId,
        status: job.status,
      });
    },
  };
}

function getProviderBridge() {
  const provider = globalThis.window?.novusDesktop?.provider;
  if (provider === undefined) {
    throw new Error(sanitizeModelJobError('Provider bridge unavailable'));
  }
  return provider;
}

function toSubmitRequest(job: ModelJob) {
  return {
    jobId: job.id,
    provider: requireProviderField(job.provider),
    modelRoute: requireJobField(job.modelRoute, 'modelRoute'),
    prompt: requireJobField(job.prompt, 'prompt'),
    conversationId: requireJobField(job.conversationId, 'conversationId'),
    referenceAssetIds: [...job.referenceAssetIds],
  };
}

function sanitizePollResult(result: ProviderPollResult | ProviderCancelResult): ModelJobPollResult {
  if (result.status === 'running') {
    return {
      status: 'running',
      progress: result.progress,
      blockedReason: result.blockedReason,
    };
  }
  if (result.status === 'failed') {
    return { status: 'failed', error: result.error };
  }
  if (result.status === 'cancelled') {
    return { status: 'cancelled' };
  }
  return {
    status: 'completed',
    progress: result.progress,
    result: {
      assetId: result.result.assetId,
      width: result.result.width,
      height: result.result.height,
    },
  };
}

function isCredentialsLocked(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'CREDENTIALS_LOCKED';
}

function requireJobField(value: string | undefined, fieldName: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${fieldName} is required for provider job execution`);
  }
  return value;
}

function requireProviderField(value: string | undefined): 'comfly' {
  const provider = requireJobField(value, 'provider');
  if (provider !== 'comfly') {
    throw new Error('provider is required for provider job execution');
  }
  return provider;
}
