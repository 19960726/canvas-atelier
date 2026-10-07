import { MAX_GENERATION_REFERENCES, type CanvasProject } from '@agent-canvas/domain';

export interface ConnectedGenerationMedia {
  edgeId: string; kind: 'image' | 'video'; assetId: string; label: string; ranges: never[];
}

export function resolveConnectedGenerationMedia(
  project: CanvasProject,
  nodeId: string,
  targetPortId: 'media' | 'references' | 'reverse',
): ConnectedGenerationMedia[] {
  const nodesById = new Map(project.nodes.map((node) => [node.id, node]));
  const media: ConnectedGenerationMedia[] = [];
  const seen = new Set<string>();
  const append = (kind: 'image' | 'video', assetId: string, edgeId: string, label = assetId) => {
    if (assetId.trim().length === 0 || seen.has(assetId) || media.length >= MAX_GENERATION_REFERENCES) return;
    seen.add(assetId);
    media.push({ edgeId, kind, assetId, label, ranges: [] });
  };

  project.edges
    .filter((edge) => edge.target === nodeId && (targetPortId === 'reverse'
      ? ['references', 'video', 'line_art'].includes(edge.targetPortId ?? '')
      : targetPortId === 'media' ? ['media', 'firstFrame', 'lastFrame'].includes(edge.targetPortId ?? '')
      : edge.targetPortId === targetPortId))
    .sort((left, right) => targetPortId === 'media' && (left.targetPortId !== 'media' || right.targetPortId !== 'media')
      ? Number(left.targetPortId === 'lastFrame') - Number(right.targetPortId === 'lastFrame')
      : (left.order ?? 0) - (right.order ?? 0))
    .forEach((edge) => {
      const source = nodesById.get(edge.source);
      if (source?.type === 'image_result' && edge.sourcePortId === 'image') {
        append('image', source.data.assetId, edge.id);
        return;
      }
      if (source?.type !== 'module') return;
      if (edge.sourcePortId === 'image' && ['image_generation', 'result_output'].includes(source.data.moduleType)) {
        let config = source.data.config;
        if (source.data.moduleType === 'result_output') {
          const incoming = project.edges.filter(candidate => candidate.target === source.id && candidate.targetPortId === 'result');
          if (incoming.length !== 1 || incoming[0]!.sourcePortId !== 'result') return;
          const producer = project.nodes.find(candidate => candidate.id === incoming[0]!.source);
          if (producer?.type !== 'module' || producer.data.moduleType !== 'image_generation') return;
          config = producer.data.config;
        }
        readStringArray(config.resultAssetIds).forEach(assetId => {
          if (project.assets?.some(asset => asset.assetId === assetId && asset.mediaType.startsWith('image/'))) append('image', assetId, edge.id);
        });
        return;
      }
      const assetId = typeof source.data.config.assetId === 'string' ? source.data.config.assetId : undefined;
      if (source.data.moduleType === 'video_input' && edge.sourcePortId === 'video' && assetId !== undefined) {
        append('video', assetId, edge.id);
        return;
      }
      if (
        (source.data.moduleType === 'image_input' || source.data.moduleType === 'upload_image')
        && edge.sourcePortId === 'image'
        && assetId !== undefined
      ) {
        append('image', assetId, edge.id);
        return;
      }
      if (source.data.moduleType === 'canvas_library' && edge.sourcePortId === 'images') {
        readStringArray(source.data.config.assetIds).forEach((id) => append('image', id, edge.id));
      }
    });

  return media;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
