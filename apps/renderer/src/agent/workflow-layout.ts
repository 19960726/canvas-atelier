import type { CanvasProject } from '@agent-canvas/domain';

// Reserve the expanded editor width even when an existing card is collapsed.
// The fallback also covers legacy nodes that have no module geometry metadata.
export function nextWorkflowColumnX(project: CanvasProject): number {
  if (project.nodes.length === 0) return 120;
  return Math.max(...project.nodes.map(node => {
    const moduleType = node.type === 'module' ? node.data.moduleType : undefined;
    const width = moduleType === 'image_generation' || moduleType === 'video_generation' ? 704
      : moduleType === 'reverse_result' ? 520
        : moduleType === 'reverse_agent' ? 426 : 760;
    return node.position.x + width + 80;
  }));
}

export function materialNodeRowStep(asset: { width?: number | null; height?: number | null } | undefined): number {
  const ratio = mediaHeightRatio(asset);
  // 272px intrinsic-ratio preview, 80px heading/controls, 48px clear gap.
  return (ratio === null ? 326 : 80 + 272 * ratio) + 48;
}

export function generationVariantRowStep(project: CanvasProject, assetIds: readonly string[], aspectRatio?: string): number {
  const ratios = assetIds.flatMap(assetId => {
    const ratio = mediaHeightRatio(project.assets?.find(asset => asset.assetId === assetId));
    return ratio === null ? [] : [ratio];
  });
  const [width, height] = (aspectRatio ?? '').split(':').map(Number);
  if (Number.isFinite(width) && Number.isFinite(height) && width! > 0 && height! > 0) ratios.push(height! / width!);
  // Allow the square default, complete media, GPT quality controls, a second
  // material row and a gap. Existing user nodes are never repositioned.
  return Math.max(1000, 676 * Math.max(1, ...ratios) + 464 + 60 + 80);
}

function mediaHeightRatio(asset: { width?: number | null; height?: number | null } | undefined): number | null {
  return typeof asset?.width === 'number' && Number.isFinite(asset.width) && asset.width > 0
    && typeof asset.height === 'number' && Number.isFinite(asset.height) && asset.height > 0
    ? asset.height / asset.width : null;
}
