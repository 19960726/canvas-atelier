import type { CanvasProject, ModelJob } from '@agent-canvas/domain';

/** A completed provider result may be retried only while its current layer rejects it. */
export function isRejectedLayerResult(
  project: CanvasProject | undefined,
  job: ModelJob,
  assetId: string | undefined,
): boolean {
  if (!project || job.projectId !== project.id || job.status !== 'completed' || job.kind !== 'image'
    || !job.layeringGroupId || !job.layeringLayerId || !assetId || job.resultAssetId !== assetId
    || !job.modelRoute || !job.provider || !job.resolution) return false;

  const sourceAssetId = job.referenceAssetIds[0];
  if (!sourceAssetId) return false;
  const layer = project.nodes.find((node) => node.id === job.promptNodeId);
  if (layer?.type !== 'module' || layer.data.moduleType !== 'image_layer') return false;
  const config = layer.data.config;
  if (config.groupId !== job.layeringGroupId || config.layerId !== job.layeringLayerId
    || config.sourceAssetId !== sourceAssetId || config.jobId !== job.id || config.resultJobId !== job.id
    || config.resultAssetId !== assetId || config.qualityStatus !== 'failed'
    || config.modelRoute !== job.modelRoute || config.provider !== job.provider || config.resolution !== job.resolution) return false;

  return project.nodes.some((node) => node.type === 'module' && node.data.moduleType === 'image_layering'
    && node.data.config.groupId === job.layeringGroupId && node.data.config.sourceAssetId === sourceAssetId);
}
