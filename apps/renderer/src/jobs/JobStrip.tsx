import type { ModelJob } from '@agent-canvas/domain';
import { Loader2, RotateCcw, XCircle } from 'lucide-react';

interface JobStripProps {
  jobs: ModelJob[];
  saveLabel: string;
  onRetry: (jobId: string) => void;
  onCancel: (jobId: string) => void;
}

const activeStatuses = new Set<ModelJob['status']>(['queued', 'submitting', 'running']);

export function JobStrip({ jobs, saveLabel, onRetry, onCancel }: JobStripProps) {
  const activeJobs = jobs.filter((job) => activeStatuses.has(job.status));
  const queuedJobs = activeJobs.filter((job) => job.status === 'queued');
  const visibleJobs = jobs
    .filter((job) => job.status !== 'completed')
    .slice(0, 4);

  return (
    <footer className="job-strip" aria-label="任务队列">
      <span className="job-strip__label">
        <span className={`status-dot ${activeJobs.length === 0 ? 'is-idle' : ''}`} />
        任务队列
      </span>
      <span className="job-strip__summary">
        {activeJobs.length === 0
          ? '0 个任务运行中'
          : queuedJobs.length === activeJobs.length
            ? `${queuedJobs.length} 个已确认任务待排队`
            : `${activeJobs.length} 个任务运行中`}
      </span>
      <div className="job-strip__jobs" aria-live="polite">
        {visibleJobs.map((job) => (
          <div className={`job-chip is-${job.status}`} key={job.id}>
            {activeStatuses.has(job.status) && <Loader2 className="job-chip__spin" size={13} />}
            <span className="job-chip__model">{job.displayName ?? job.modelRoute ?? job.modelId}</span>
            <span>{statusLabel(job)}</span>
            {job.progress !== undefined && <span>{Math.round(job.progress * 100)}%</span>}
            {job.retryCount > 0 && <span>{job.retryCount} 次重试</span>}
            {job.error && <span className="job-chip__error" title={job.error}>{job.error}</span>}
            {(job.status === 'failed' || job.status === 'cancelled') && (
              <button type="button" aria-label={`重试 ${job.displayName ?? job.id}`} title="重试" onClick={() => onRetry(job.id)}>
                <RotateCcw size={13} />
              </button>
            )}
            {activeStatuses.has(job.status) && (
              <button type="button" aria-label={`取消 ${job.displayName ?? job.id}`} title="取消" onClick={() => onCancel(job.id)}>
                <XCircle size={13} />
              </button>
            )}
          </div>
        ))}
      </div>
      <span className="job-strip__spacer" />
      <span>{saveLabel}</span>
    </footer>
  );
}

function statusLabel(job: ModelJob): string {
  switch (job.status) {
    case 'queued': return '排队';
    case 'submitting': return '提交';
    case 'running': return '生成';
    case 'completed': return '完成';
    case 'failed': return '失败';
    case 'cancelled': return '已取消';
  }
}
