import type { ModelJob } from '@agent-canvas/domain';

export const UNCERTAIN_EXTERNAL_SUBMISSION_ERROR = '提交状态不确定：供应商可能已接收任务，为避免重复扣费，请先检查供应商任务记录。';

export function isExternalProviderJob(job: Pick<ModelJob, 'provider'>): boolean {
  return job.provider === 'julun' || job.provider === '4dai';
}

export function isUncertainExternalSubmission(job: Pick<ModelJob, 'provider' | 'status' | 'error'>): boolean {
  return job.status === 'cancelled'
    && isExternalProviderJob(job)
    && job.error?.startsWith('提交状态不确定') === true;
}

export function canRetryModelJob(job: Pick<ModelJob, 'provider' | 'status' | 'error'>): boolean {
  return (job.status === 'failed' || job.status === 'cancelled')
    && !isUncertainExternalSubmission(job);
}
