import type { CanvasProject } from '@agent-canvas/domain';
import type { ProjectImageAssetSummary } from '@agent-canvas/desktop-core';

export function resolveMcpLayeringSource(project: CanvasProject, assets: readonly ProjectImageAssetSummary[], nodeId: string) {
  let node = project.nodes.find(candidate => candidate.id === nodeId && candidate.type === 'module');
  if (node?.type !== 'module') throw new Error('LAYERING_SOURCE_UNAVAILABLE');
  if (node.data.moduleType === 'result_output') {
    const incoming = project.edges.filter(edge => edge.target === nodeId && edge.targetPortId === 'result' && edge.sourcePortId === 'result');
    if (incoming.length !== 1) throw new Error(incoming.length ? 'LAYERING_SOURCE_AMBIGUOUS' : 'LAYERING_SOURCE_UNAVAILABLE');
    node = project.nodes.find(candidate => candidate.id === incoming[0]!.source && candidate.type === 'module');
    if (node?.type !== 'module' || node.data.moduleType !== 'image_generation') throw new Error('LAYERING_SOURCE_TYPE_UNSUPPORTED');
  }
  if (!['image_input', 'upload_image', 'image_generation'].includes(node.data.moduleType)) throw new Error('LAYERING_SOURCE_TYPE_UNSUPPORTED');
  const config = node.data.config;
  const resultIds = node.data.moduleType === 'image_generation' ? [...new Set(Array.isArray(config.resultAssetIds)
    ? config.resultAssetIds.filter((value): value is string => typeof value === 'string' && !!value)
    : typeof config.resultAssetId === 'string' ? [config.resultAssetId] : [])] : [];
  if (resultIds.length > 1) throw new Error('LAYERING_SOURCE_AMBIGUOUS');
  const assetId = node.data.moduleType === 'image_generation' ? resultIds[0] : config.assetId;
  const owned = project.assets?.find(asset => asset.assetId === assetId && asset.mediaType.startsWith('image/'));
  const asset = assets.find(candidate => candidate.assetId === owned?.assetId);
  if (!asset || !owned || !Number.isInteger(asset.width) || !Number.isInteger(asset.height) || !asset.width || !asset.height
    || asset.width < 1 || asset.height < 1 || asset.width > 8192 || asset.height > 8192 || asset.width * asset.height * 4 > 128 * 1024 * 1024
    || asset.width !== owned.width || asset.height !== owned.height) throw new Error('LAYERING_SOURCE_UNAVAILABLE');
  return { asset, sourceNodeId: node.id };
}
