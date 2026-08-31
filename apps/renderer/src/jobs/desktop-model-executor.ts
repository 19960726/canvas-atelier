import { sanitizeModelJobError, type ModelJob } from '@agent-canvas/domain';
import type { ModelJobExecutor, ModelJobPollResult, ModelJobSubmission } from './job-store';

type ProviderPollResult = Awaited<ReturnType<NonNullable<Window['novusDesktop']>['provider']['pollImageJob']>>;
type ProviderCancelResult = Awaited<ReturnType<NonNullable<Window['novusDesktop']>['provider']['cancelImageJob']>>;
type ProviderVideoPollResult = Awaited<ReturnType<NonNullable<Window['novusDesktop']>['provider']['pollVideoJob']>>;
type ProviderVideoCancelResult = Awaited<ReturnType<NonNullable<Window['novusDesktop']>['provider']['cancelVideoJob']>>;

export function createDesktopModelJobExecutor(): ModelJobExecutor {
  return {
    async submit(job) {
      await assertJobProviderIsActive(job);
      return job.kind === 'video'
        ? getProviderBridge().submitVideoJob(toVideoSubmitRequest(job))
        : getProviderBridge().submitImageJob(toImageSubmitRequest(job));
    },
    async poll(job) {
      if (!job.providerTaskId) {
        throw new Error('Provider task id is required before polling');
      }
      let result: ProviderPollResult | ProviderVideoPollResult;
      try {
        const request = { provider: requireProviderField(job.provider), providerTaskId: job.providerTaskId };
        result = job.kind === 'video'
          ? await getProviderBridge().pollVideoJob(request)
          : await getProviderBridge().pollImageJob(request);
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
      const request = { provider: requireProviderField(job.provider), providerTaskId: job.providerTaskId };
      const result = job.kind === 'video'
        ? await getProviderBridge().cancelVideoJob(request)
        : await getProviderBridge().cancelImageJob(request);
      return sanitizePollResult(result);
    },
    async ackTerminal(job) {
      if (!job.providerTaskId || (job.status !== 'completed' && job.status !== 'failed' && job.status !== 'cancelled')) {
        return;
      }
      const request = {
        provider: requireProviderField(job.provider),
        providerTaskId: job.providerTaskId,
        status: job.status,
      };
      if (job.kind === 'video') await getProviderBridge().ackVideoJobTerminal(request);
      else await getProviderBridge().ackImageJobTerminal(request);
    },
  };
}

async function assertJobProviderIsActive(job: ModelJob): Promise<void> {
  const bridge = getProviderBridge();
  if (bridge.getActiveProvider === undefined) return;
  const requestedProvider = requireProviderField(job.provider);
  const { activeProvider } = await bridge.getActiveProvider();
  if (activeProvider === requestedProvider) return;
  const error = new Error('Selected provider is not active') as Error & { code: string; retryable: boolean };
  error.code = 'PROVIDER_INACTIVE';
  error.retryable = false;
  throw error;
}

function getProviderBridge() {
  const provider = globalThis.window?.novusDesktop?.provider;
  if (provider === undefined) {
    throw new Error(sanitizeModelJobError('Provider bridge unavailable'));
  }
  return provider;
}

function toImageSubmitRequest(job: ModelJob) {
  return {
    jobId: job.id,
    provider: requireProviderField(job.provider),
    modelRoute: requireJobField(job.modelRoute, 'modelRoute'),
    prompt: requireJobField(job.prompt, 'prompt'),
    conversationId: requireJobField(job.conversationId, 'conversationId'),
    ...(job.projectSessionId === undefined ? {} : { sessionId: job.projectSessionId }),
    referenceAssetIds: [...job.referenceAssetIds],
    ...(job.aspectRatio === undefined ? {} : { aspectRatio: job.aspectRatio }),
    ...(job.resolution === undefined ? {} : { resolution: job.resolution }),
    ...(job.outputCount === undefined ? {} : { outputCount: job.outputCount }),
  };
}

function toVideoSubmitRequest(job: ModelJob) {
  return {
    jobId: job.id,
    provider: requireProviderField(job.provider),
    modelRoute: requireJobField(job.modelRoute, 'modelRoute'),
    prompt: requireJobField(job.prompt, 'prompt'),
    conversationId: requireJobField(job.conversationId, 'conversationId'),
    ...(job.projectSessionId === undefined ? {} : { sessionId: job.projectSessionId }),
    referenceAssetIds: [...job.referenceAssetIds],
    ...(job.aspectRatio === undefined ? {} : { aspectRatio: job.aspectRatio }),
    ...(job.videoResolution === undefined ? {} : { resolution: job.videoResolution }),
    ...(job.durationSeconds === undefined ? {} : { durationSeconds: job.durationSeconds }),
    ...(job.outputCount === undefined ? {} : { outputCount: job.outputCount }),
    ...(job.audioEnabled === undefined ? {} : { audioEnabled: job.audioEnabled }),
  };
}

function sanitizePollResult(result: ProviderPollResult | ProviderCancelResult | ProviderVideoPollResult | ProviderVideoCancelResult): ModelJobPollResult {
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
      ...('assetIds' in result.result && result.result.assetIds !== undefined ? { assetIds: [...result.result.assetIds] } : {}),
      width: result.result.width,
      height: result.result.height,
      ...('durationSeconds' in result.result && result.result.durationSeconds !== undefined
        ? { durationSeconds: result.result.durationSeconds }
        : {}),
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

function requireProviderField(value: string | undefined): 'comfly' | 'relayme' {
  const provider = requireJobField(value, 'provider');
  if (provider !== 'comfly' && provider !== 'relayme') {
    throw new Error('provider is required for provider job execution');
  }
  return provider;
}
