import { MAX_GENERATION_REFERENCES, type CanvasProject } from '@agent-canvas/domain';

export type ConnectedStoryboardReferences =
  | { readonly ok: true; readonly assetIds: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolves the storyboard's image-input edges into a stable, project-scoped
 * reference snapshot.  The renderer never gets to forward arbitrary asset
 * identifiers: every value must be owned by this project and be an image.
 */
export function resolveConnectedStoryboardReferences(input: {
  readonly project: CanvasProject;
  readonly nodeId: string;
}): ConnectedStoryboardReferences {
  const target = input.project.nodes.find((node) => node.id === input.nodeId);
  if (target?.type !== 'module' || target.data.moduleType !== 'storyboard_sheet') {
    return { ok: false, reason: 'Select a storyboard node before generating shots.' };
  }

  const nodesById = new Map(input.project.nodes.map((node) => [node.id, node]));
  const managedImageIds = new Set(
    (input.project.assets ?? [])
      .filter((asset) => asset.mediaType.startsWith('image/'))
      .map((asset) => asset.assetId),
  );
  const assetIds: string[] = [];
  const seenAssetIds = new Set<string>();
  const incomingImageEdges = input.project.edges
    .filter((edge) => edge.target === input.nodeId && edge.targetPortId === 'images')
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));

  for (const edge of incomingImageEdges) {
    const source = nodesById.get(edge.source);
    if (source?.type !== 'module') {
      return { ok: false, reason: 'Storyboard references must come from managed image modules.' };
    }

    const sourceAssetIds = readSourceImageAssetIds(source.data.moduleType, source.data.config, edge.sourcePortId);
    if (sourceAssetIds === null) {
      return { ok: false, reason: 'Only managed images can connect to the storyboard images input.' };
    }

    for (const assetId of sourceAssetIds) {
      if (!managedImageIds.has(assetId)) {
        return { ok: false, reason: 'A connected storyboard reference is not a managed project image.' };
      }
      if (seenAssetIds.has(assetId)) continue;
      seenAssetIds.add(assetId);
      assetIds.push(assetId);
      if (assetIds.length > MAX_GENERATION_REFERENCES) {
        return { ok: false, reason: `Storyboard references are limited to ${MAX_GENERATION_REFERENCES} managed images.` };
      }
    }
  }

  return { ok: true, assetIds };
}

function readSourceImageAssetIds(
  moduleType: string,
  config: Record<string, unknown>,
  sourcePortId: string | undefined,
): readonly string[] | null {
  if (moduleType === 'image_input' && sourcePortId === 'image') {
    const assetId = config.assetId;
    return isNonEmptyString(assetId) ? [assetId] : null;
  }
  if (moduleType === 'canvas_library' && sourcePortId === 'images') {
    const assetIds = config.assetIds;
    if (!Array.isArray(assetIds) || assetIds.length === 0) return null;
    return assetIds.every(isNonEmptyString) ? assetIds : null;
  }
  return null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
