import type { CanvasNode, CanvasProject, ProjectTransaction } from '@agent-canvas/domain';

export function buildLegacyOrphanedImageResultRepair(
  stableProject: CanvasProject,
  currentProject: CanvasProject,
): ProjectTransaction | null {
  if (stableProject.id !== currentProject.id) return null;

  const stableAssetIds = new Set((stableProject.assets ?? []).map((asset) => asset.assetId));
  const referencedAssetIds = collectReferencedAssetIds(currentProject.nodes);
  const addedGeneratedImages = (currentProject.assets ?? []).filter((asset) => (
    !stableAssetIds.has(asset.assetId)
    && asset.origin === 'generated'
    && asset.mediaType.startsWith('image/')
    && !referencedAssetIds.has(asset.assetId)
  ));
  if (addedGeneratedImages.length !== 1) return null;

  const candidates = currentProject.nodes.filter((node): node is Extract<CanvasNode, { type: 'module' }> => {
    if (node.type !== 'module' || node.data.moduleType !== 'image_generation') return false;
    const jobId = readNonEmptyString(node.data.config.lastResultJobId);
    if (jobId === null || node.data.config.resultState !== 'pending') return false;
    if (readStringArray(node.data.config.resultAssetIds).length !== 0) return false;
    if (node.data.execution.state !== 'queued' && node.data.execution.state !== 'running') return false;
    const stableNode = stableProject.nodes.find((candidate) => candidate.id === node.id);
    return stableNode?.type === 'module'
      && stableNode.data.moduleType === 'image_generation'
      && stableNode.data.config.lastResultJobId === jobId
      && stableNode.data.config.resultState === 'pending'
      && readStringArray(stableNode.data.config.resultAssetIds).length === 0;
  });
  if (candidates.length !== 1) return null;

  const sourceNode = candidates[0];
  const resultAsset = addedGeneratedImages[0];
  if (sourceNode === undefined || resultAsset === undefined) return null;
  const jobId = readNonEmptyString(sourceNode.data.config.lastResultJobId);
  if (jobId === null) return null;
  const repairedNode: typeof sourceNode = {
    ...sourceNode,
    data: {
      ...sourceNode.data,
      config: {
        ...sourceNode.data.config,
        resultAssetIds: [resultAsset.assetId],
        ...(resultAsset.height === null || resultAsset.height === undefined ? {} : { resultHeight: resultAsset.height }),
        resultState: 'fresh',
        ...(resultAsset.width === null || resultAsset.width === undefined ? {} : { resultWidth: resultAsset.width }),
      },
      execution: { ...sourceNode.data.execution, state: 'completed' },
    },
  };
  return {
    id: `repair-orphaned-image-result-${jobId}`,
    label: 'Repair orphaned image generation result',
    operations: [{ kind: 'canvas', operation: { kind: 'update_node', node: repairedNode } }],
  };
}

function collectReferencedAssetIds(nodes: readonly CanvasNode[]): Set<string> {
  const assetIds = new Set<string>();
  for (const node of nodes) {
    if (node.type === 'image_result' || node.type === 'video_result') {
      assetIds.add(node.data.assetId);
      continue;
    }
    if (node.type !== 'module') continue;
    const directAssetId = readNonEmptyString(node.data.config.assetId);
    if (directAssetId !== null) assetIds.add(directAssetId);
    for (const assetId of readStringArray(node.data.config.resultAssetIds)) assetIds.add(assetId);
    const videoResults = Array.isArray(node.data.config.videoResults) ? node.data.config.videoResults : [];
    for (const result of videoResults) {
      if (typeof result !== 'object' || result === null) continue;
      const assetId = readNonEmptyString((result as { assetId?: unknown }).assetId);
      if (assetId !== null) assetIds.add(assetId);
    }
  }
  return assetIds;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}
