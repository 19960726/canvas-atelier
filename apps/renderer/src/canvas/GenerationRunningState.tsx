import { LoaderCircle } from 'lucide-react';
import type { ModelJob } from '@agent-canvas/domain';

/** Only presents stages recorded by the task; it does not own timers or actions. */
export function GenerationRunningState({ kind, status, hasPreviousResult = false, referenceUrl, onReferenceDimensions }: {
  kind: 'image' | 'video';
  status?: ModelJob['status'];
  hasPreviousResult?: boolean;
  referenceUrl?: string;
  onReferenceDimensions?: (dimensions: { width: number; height: number }) => void;
}) {
  if (status !== 'queued' && status !== 'submitting' && status !== 'running') return null;
  const media = kind === 'image' ? '图片' : '视频';
  const label = status === 'queued' ? '等待提交'
    : status === 'submitting' ? '正在提交任务'
      : kind === 'image' ? '正在生成' : '正在生成视频';
  const detail = status === 'queued' ? '等待任务调度'
    : status === 'submitting' ? `正在发送${media}请求`
      : `等待模型返回${media}`;
  return <div
    className={`module-node__running-state${hasPreviousResult ? ' module-node__running-state--preserved' : ' module-node__running-state--empty'}${referenceUrl && !hasPreviousResult ? ' module-node__running-state--reference' : ''}`}
    role="status" aria-label={`${media}生成进度`} aria-live="polite" aria-atomic="true"
    data-task-phase={status}
  >
    {referenceUrl && !hasPreviousResult && <>
      <img className="module-node__running-reference" src={referenceUrl} alt="本次任务参考素材" decoding="async" onLoad={event => onReferenceDimensions?.({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
      <span className="module-node__running-reference-label">参考素材</span>
    </>}
    <div className="module-node__running-panel">
      <span className="module-node__running-indicator" aria-hidden="true"><LoaderCircle size={28} strokeWidth={1.4} /></span>
      <strong>{label}</strong>
      <p>{detail}</p>
      {hasPreviousResult && <small>{kind === 'image' ? '上一张结果保留' : '上一段视频保留'}</small>}
    </div>
  </div>;
}
