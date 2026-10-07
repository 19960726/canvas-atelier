import type { CanvasModuleNode, CanvasProject } from '@agent-canvas/domain';
import { resolveConnectedGenerationMedia } from '../canvas/connected-generation-media';
import { buildConnectedMentionCatalog, reconcileConnectedMentions } from '../mentions/media-mention-model';

/** Keep stored prompts bound even when their node editor is not mounted. */
export function reconcileProjectMentionNodes(before: CanvasProject, next: CanvasProject): CanvasModuleNode[] {
  if (before.nodes === next.nodes && before.edges === next.edges) return [];
  const previousNodes = new Map(before.nodes.map(node => [node.id, node]));
  const summaries = (project: CanvasProject, kind: 'image' | 'video') => (project.assets ?? [])
    .filter(asset => typeof asset.mediaType === 'string' && asset.mediaType.startsWith(`${kind}/`))
    .map(asset => ({ assetId: asset.assetId, label: asset.label ?? asset.assetId }));
  const oldImages = summaries(before, 'image'); const oldVideos = summaries(before, 'video');
  const images = summaries(next, 'image'); const videos = summaries(next, 'video');
  const updates: CanvasModuleNode[] = [];
  for (const node of next.nodes) {
    if (node.type !== 'module') continue;
    const type = node.data.moduleType;
    if (!['image_generation', 'video_generation', 'reverse_agent'].includes(type)) continue;
    const previous = previousNodes.get(node.id);
    if (previous?.type !== 'module' || previous.data.moduleType !== type) continue;
    const field = type === 'reverse_agent' ? 'task' : 'prompt';
    // An explicitly replaced prompt already belongs to the new graph. A shared
    // upstream text node has no single target catalog, so never rewrite it here.
    if (node.data.config[field] !== previous.data.config[field]
      || next.edges.some(edge => edge.target === node.id && edge.targetPortId === field)) continue;
    const port = type === 'video_generation' ? 'media' : type === 'reverse_agent' ? 'reverse' : 'references';
    const oldCatalog = buildConnectedMentionCatalog(resolveConnectedGenerationMedia(before, node.id, port), oldImages, oldVideos);
    const catalog = buildConnectedMentionCatalog(resolveConnectedGenerationMedia(next, node.id, port), images, videos);
    if (JSON.stringify(oldCatalog.map(item => [item.kind, item.assetId])) === JSON.stringify(catalog.map(item => [item.kind, item.assetId]))) continue;
    const text = node.data.config[field];
    const remapped = typeof text === 'string' ? reconcileConnectedMentions(oldCatalog, catalog, text) : text;
    const references = node.data.config.referenceAssetIds;
    const removed = new Set(oldCatalog.filter(item => !catalog.some(nextItem => nextItem.assetId === item.assetId)).map(item => item.assetId));
    const retained = Array.isArray(references) ? references.filter(id => !removed.has(id)) : references;
    if (text === remapped && (!Array.isArray(references) || (retained as unknown[]).length === references.length)) continue;
    updates.push({ ...node, data: { ...node.data, config: { ...node.data.config,
      ...(text === remapped ? {} : { [field]: remapped }),
      ...(Array.isArray(references) ? { referenceAssetIds: retained } : {}),
    } } });
  }
  return updates;
}
