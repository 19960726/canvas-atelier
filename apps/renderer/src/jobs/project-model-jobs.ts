import type { CanvasModuleNode, CanvasProject, ModelJob } from '@agent-canvas/domain';

export interface GenerationJobDraftIdentity {
  readonly kind: 'image' | 'video';
  readonly prompt?: unknown;
  readonly modelRoute?: unknown;
  readonly aspectRatio?: unknown;
  readonly resolution?: unknown;
  readonly imageQuality?: unknown;
  readonly imageOutputFormat?: unknown;
  readonly imageBackground?: unknown;
  readonly durationSeconds?: unknown;
  readonly audioEnabled?: unknown;
}

export function modelJobMatchesGenerationDraft(
  job: ModelJob,
  draft: GenerationJobDraftIdentity,
): boolean {
  const kind = job.kind ?? 'image';
  if (kind !== draft.kind) return false;
  if (!sameExplicitString(job.prompt, draft.prompt)) return false;
  if (!sameExplicitString(job.modelRoute ?? job.modelId, draft.modelRoute)) return false;
  if (!sameExplicitString(job.aspectRatio, draft.aspectRatio)) return false;

  const jobResolution = kind === 'video' ? job.videoResolution : job.resolution;
  if (!sameExplicitResolution(jobResolution, draft.resolution, kind)) return false;
  if (kind === 'image' && !sameExplicitString(job.imageQuality, draft.imageQuality)) return false;
  if (kind === 'image' && !sameExplicitString(job.imageOutputFormat, draft.imageOutputFormat)) return false;
  if (kind === 'image' && !sameExplicitString(job.imageBackground, draft.imageBackground)) return false;
  if (kind === 'video') {
    if (!sameExplicitNumber(job.durationSeconds, draft.durationSeconds)) return false;
    if (!sameExplicitBoolean(job.audioEnabled, draft.audioEnabled)) return false;
  }
  return true;
}

export function formalGenerationJobMatchesNodeDraft(
  job: ModelJob,
  sourceNode: CanvasModuleNode,
): boolean {
  const moduleType = sourceNode.data.moduleType;
  if (moduleType !== 'image_generation' && moduleType !== 'video_generation') return false;
  const config = sourceNode.data.config;
  return modelJobMatchesGenerationDraft(job, {
    kind: moduleType === 'video_generation' ? 'video' : 'image',
    prompt: config.prompt,
    modelRoute: config.modelRoute,
    aspectRatio: config.aspectRatio,
    resolution: config.resolution,
    imageQuality: config.imageQuality,
    imageOutputFormat: config.imageOutputFormat,
    imageBackground: config.imageBackground,
    durationSeconds: config.durationSeconds,
    audioEnabled: config.audioEnabled,
  });
}

export function modelJobBelongsToProject(
  job: ModelJob,
  project: CanvasProject,
  activeProjectSessionId: string | null,
): boolean {
  // New queue records carry a stable project id. It remains authoritative
  // after renderer reload, project reopen, and application restart, when the
  // desktop bridge necessarily replaces its temporary session id.
  if (job.projectId !== undefined) return job.projectId === project.id;

  if (projectDurablyOwnsLegacyJob(project, job)) return true;
  return job.projectSessionId !== undefined
    && activeProjectSessionId !== null
    && job.projectSessionId === activeProjectSessionId;
}

export function filterModelJobsForProject(
  jobs: readonly ModelJob[],
  project: CanvasProject,
  activeProjectSessionId: string | null,
): ModelJob[] {
  return jobs.filter((job) => modelJobBelongsToProject(job, project, activeProjectSessionId));
}

export function filterModelJobsForTaskStrip(
  jobs: readonly ModelJob[],
  project: CanvasProject,
  activeProjectSessionId: string | null,
): ModelJob[] {
  return filterModelJobsForProject(jobs, project, activeProjectSessionId).filter((job) => {
    if (job.status === 'queued' || job.status === 'submitting' || job.status === 'running') return true;
    if (job.status === 'completed') return false;

    const sourceNode = project.nodes.find((node) => node.id === job.promptNodeId);
    if (sourceNode === undefined) return false;
    if (sourceNode.type !== 'module') return true;

    const kind = job.kind ?? 'image';
    const isFormalGenerationSource = kind === 'video'
      ? sourceNode.data.moduleType === 'video_generation'
      : sourceNode.data.moduleType === 'image_generation';
    if (!isFormalGenerationSource) {
      return sourceNode.data.moduleType !== 'image_generation'
        && sourceNode.data.moduleType !== 'video_generation';
    }
    const isAnchored = sourceNode.data.config.lastResultJobId === job.id
      || (Array.isArray(sourceNode.data.config.pendingResultJobIds)
        && sourceNode.data.config.pendingResultJobIds.includes(job.id));
    return isAnchored && formalGenerationJobMatchesNodeDraft(job, sourceNode);
  });
}

function sameExplicitString(jobValue: unknown, draftValue: unknown): boolean {
  if (typeof jobValue !== 'string' || typeof draftValue !== 'string') return true;
  return jobValue.trim() === draftValue.trim();
}

function sameExplicitResolution(jobValue: unknown, draftValue: unknown, kind: 'image' | 'video'): boolean {
  if (typeof jobValue !== 'string' || typeof draftValue !== 'string') return true;
  return normalizeResolution(jobValue, kind) === normalizeResolution(draftValue, kind);
}

function normalizeResolution(value: string, kind: 'image' | 'video'): string {
  const normalized = value.trim().toLowerCase();
  if (kind === 'image') {
    if (normalized === '1024x1024') return '1k';
    if (normalized === '1536x1024' || normalized === '1024x1536') return '2k';
  }
  return normalized;
}

function sameExplicitNumber(jobValue: unknown, draftValue: unknown): boolean {
  return typeof jobValue !== 'number' || typeof draftValue !== 'number' || jobValue === draftValue;
}

function sameExplicitBoolean(jobValue: unknown, draftValue: unknown): boolean {
  return typeof jobValue !== 'boolean' || typeof draftValue !== 'boolean' || jobValue === draftValue;
}

function projectDurablyOwnsLegacyJob(project: CanvasProject, job: ModelJob): boolean {
  const sourceNode = project.nodes.find((node) => node.id === job.promptNodeId);
  if (sourceNode?.type !== 'module') return false;
  const kind = job.kind ?? 'image';
  if (kind === 'video') {
    if (sourceNode.data.moduleType !== 'video_generation') return false;
  } else if (sourceNode.data.moduleType !== 'image_generation') {
    return false;
  }

  if (sourceNode.data.config.lastResultJobId === job.id) return true;
  if (Array.isArray(sourceNode.data.config.pendingResultJobIds)
    && sourceNode.data.config.pendingResultJobIds.includes(job.id)) return true;
  if (job.status !== 'completed') return false;

  const durableAssetIds = readDurableResultAssetIds(sourceNode.data.config);
  return [job.resultAssetId, ...(job.resultAssetIds ?? [])]
    .some((assetId) => assetId !== undefined && durableAssetIds.has(assetId));
}

function readDurableResultAssetIds(config: Record<string, unknown>): Set<string> {
  const assetIds = new Set<string>();
  if (typeof config.resultAssetId === 'string' && config.resultAssetId.length > 0) {
    assetIds.add(config.resultAssetId);
  }
  if (Array.isArray(config.resultAssetIds)) {
    for (const assetId of config.resultAssetIds) {
      if (typeof assetId === 'string' && assetId.length > 0) assetIds.add(assetId);
    }
  }
  if (Array.isArray(config.videoResults)) {
    for (const result of config.videoResults) {
      if (typeof result === 'object' && result !== null && 'assetId' in result
        && typeof result.assetId === 'string' && result.assetId.length > 0) {
        assetIds.add(result.assetId);
      }
    }
  }
  return assetIds;
}
