export type OfflineVideoPreviewStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface OfflineVideoPreviewRequest {
  readonly taskId: string;
  readonly prompt: string;
  /** Opaque managed image identifiers only. The local mock never reads image bytes. */
  readonly referenceAssetIds: readonly string[];
  readonly durationSeconds: number;
  /** Test-only deterministic failure path. Never derived from user prompt. */
  readonly outcome?: 'complete' | 'fail';
}

export interface OfflineVideoPreviewTask {
  readonly id: string;
  readonly status: OfflineVideoPreviewStatus;
  readonly progress: number;
  readonly request: OfflineVideoPreviewRequest;
  readonly result?: {
    readonly assetId: string;
    readonly mediaType: 'video/mp4';
    readonly durationMs: number;
  };
  readonly error?: '模拟预览失败';
}

export function createOfflineVideoPreview(request: OfflineVideoPreviewRequest): OfflineVideoPreviewTask {
  return {
    id: request.taskId,
    status: 'queued',
    progress: 0,
    request: { ...request, outcome: request.outcome ?? 'complete' },
  };
}

export function advanceOfflineVideoPreview(task: OfflineVideoPreviewTask): OfflineVideoPreviewTask {
  if (task.status !== 'queued' && task.status !== 'running') return task;
  if (task.request.outcome === 'fail') {
    return { ...task, status: 'failed', progress: 0, error: '模拟预览失败' };
  }
  if (task.status === 'queued') return { ...task, status: 'running', progress: 0.5 };
  return {
    ...task,
    status: 'completed',
    progress: 1,
    result: {
      assetId: createOfflineVideoAssetId(task.request),
      mediaType: 'video/mp4',
      durationMs: task.request.durationSeconds * 1000,
    },
  };
}

export function cancelOfflineVideoPreview(task: OfflineVideoPreviewTask): OfflineVideoPreviewTask {
  if (task.status !== 'queued' && task.status !== 'running') return task;
  return { ...task, status: 'cancelled' };
}

function createOfflineVideoAssetId(request: OfflineVideoPreviewRequest): string {
  const payload = [
    request.taskId,
    request.prompt,
    ...request.referenceAssetIds,
    String(request.durationSeconds),
  ].join('|');
  return `${hash32(payload, 0x811c9dc5)}${hash32(payload, 0x9e3779b9)}`;
}

function hash32(value: string, seed: number): string {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
