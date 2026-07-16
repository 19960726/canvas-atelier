import { sanitizeModelJobError, type ModelJob } from '@agent-canvas/domain';
import type { ModelJobExecutor, ModelJobPollResult, ModelJobSubmission } from './job-store';

export function createDesktopModelJobExecutor(): ModelJobExecutor {
  return {
    async submit(job) {
      return getProviderBridge().submitImageJob(toSubmitRequest(job));
    },
    async poll(job) {
      if (!job.providerTaskId) {
        throw new Error('Provider task id is required before polling');
      }
      const result = await getProviderBridge().pollImageJob({
        provider: requireJobField(job.provider, 'provider'),
        providerTaskId: job.providerTaskId,
      });
      return sanitizePollResult(result);
    },
    async cancel(job) {
      if (!job.providerTaskId) return;
      await getProviderBridge().cancelImageJob({
        provider: requireJobField(job.provider, 'provider'),
        providerTaskId: job.providerTaskId,
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
    provider: requireJobField(job.provider, 'provider'),
    modelRoute: requireJobField(job.modelRoute, 'modelRoute'),
    prompt: requireJobField(job.prompt, 'prompt'),
    conversationId: requireJobField(job.conversationId, 'conversationId'),
    referenceAssetIds: [...job.referenceAssetIds],
  };
}

function sanitizePollResult(result: Awaited<ReturnType<NonNullable<Window['novusDesktop']>['provider']['pollImageJob']>>): ModelJobPollResult {
  if (result.status === 'running') {
    return { status: 'running', progress: result.progress };
  }
  if (result.status === 'failed') {
    return { status: 'failed', error: result.error };
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

function requireJobField(value: string | undefined, fieldName: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${fieldName} is required for provider job execution`);
  }
  return value;
}
