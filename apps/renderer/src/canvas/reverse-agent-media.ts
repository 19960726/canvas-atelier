import {
  MAX_GENERATION_REFERENCES,
  MAX_REVERSE_PROMPT_MP4_BYTES,
  type CanvasProject,
  type OrderedAgentMediaItem,
  type OrderedReference,
} from '@agent-canvas/domain';

export interface ManagedReverseMediaIdentity {
  readonly kind: 'image' | 'video';
  readonly assetId: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly mediaType: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp' | 'video/mp4';
}

interface ManagedImage {
  readonly assetId: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly mediaType: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';
  readonly label?: string;
}

interface ManagedVideo {
  readonly assetId: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly durationMs: number | null;
  readonly extension: 'mp4';
  readonly height: number | null;
  readonly label: string;
  readonly mediaType: string;
  readonly origin: 'imported';
  readonly width: number | null;
}

export type ConnectedReverseMedia =
  | {
      readonly ok: true;
      readonly references: readonly OrderedReference[];
      readonly media: readonly ManagedReverseMediaIdentity[];
      readonly orderedMedia: readonly OrderedAgentMediaItem[];
      readonly edgeIds: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

export function mergeReverseCitationImages(
  connected: Extract<ConnectedReverseMedia, { readonly ok: true }>,
  citationAssetIds: readonly string[],
  images: readonly ManagedImage[],
): ConnectedReverseMedia {
  const imagesById = new Map(images.map((asset) => [asset.assetId, asset]));
  const seenAssetIds = new Set(connected.media.map((asset) => asset.assetId));
  const citedImages: ManagedImage[] = [];

  for (const assetId of citationAssetIds) {
    if (seenAssetIds.has(assetId)) continue;
    const image = imagesById.get(assetId);
    if (!image) return { ok: false, reason: 'Referenced image is no longer available in this project.' };
    seenAssetIds.add(assetId);
    citedImages.push(image);
  }

  if (connected.media.length + citedImages.length > MAX_GENERATION_REFERENCES) {
    return { ok: false, reason: `Agent reverse supports at most ${MAX_GENERATION_REFERENCES} connected or cited media items.` };
  }

  const references = [...connected.references];
  const media = [...connected.media];
  const orderedMedia = [...connected.orderedMedia];
  for (const image of citedImages) {
    const label = image.label ?? image.assetId;
    references.push({ assetId: image.assetId, label, position: references.length, role: 'scene_composition' });
    media.push({ kind: 'image', assetId: image.assetId, sha256: image.sha256, byteSize: image.byteSize, mediaType: image.mediaType });
    orderedMedia.push({
      kind: 'image',
      assetId: image.assetId,
      sha256: image.sha256,
      byteSize: image.byteSize,
      label,
      mediaType: image.mediaType,
      order: orderedMedia.length,
      role: 'scene_composition',
    });
  }

  return { ok: true, references, media, orderedMedia, edgeIds: connected.edgeIds };
}
export function resolveConnectedReverseMedia(input: {
  readonly project: CanvasProject;
  readonly nodeId: string;
  readonly images: readonly ManagedImage[];
  readonly videos: readonly ManagedVideo[];
}): ConnectedReverseMedia {
  const node = input.project.nodes.find((candidate) => candidate.id === input.nodeId);
  if (node?.type !== 'module' || node.data.moduleType !== 'reverse_agent') {
    return { ok: false, reason: '请选择一个 Agent 反推节点。' };
  }

  const imagesById = new Map(input.images.map((asset) => [asset.assetId, asset]));
  const videosById = new Map(input.videos.map((asset) => [asset.assetId, asset]));
  const nodesById = new Map(input.project.nodes.map((candidate) => [candidate.id, candidate]));
  const inboundEdges = [...input.project.edges]
    .filter((edge) => edge.target === input.nodeId && (edge.targetPortId === 'references' || edge.targetPortId === 'video'))
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
  if (inboundEdges.length > MAX_GENERATION_REFERENCES) {
    return { ok: false, reason: `Agent 反推最多连接 ${MAX_GENERATION_REFERENCES} 个图片或视频素材。` };
  }

  const references: OrderedReference[] = [];
  const media: ManagedReverseMediaIdentity[] = [];
  const orderedMedia: OrderedAgentMediaItem[] = [];
  const edgeIds: string[] = [];
  const seenAssetIds = new Set<string>();

  for (const edge of inboundEdges) {
    const source = nodesById.get(edge.source);
    if (source?.type !== 'module') continue;
    const assetId = typeof source.data.config.assetId === 'string' ? source.data.config.assetId : null;

    if (source.data.moduleType === 'video_input' && edge.sourcePortId === 'video') {
      const video = assetId === null ? undefined : videosById.get(assetId);
      if (!isUsableManagedVideo(video)) {
        return { ok: false, reason: '所选 Agent 连接了不可用的受管 MP4。' };
      }
      if (seenAssetIds.has(video.assetId)) return { ok: false, reason: 'Agent 反推不能重复连接同一个素材。' };
      seenAssetIds.add(video.assetId);
      edgeIds.push(edge.id);
      media.push({ kind: 'video', assetId: video.assetId, sha256: video.sha256, byteSize: video.byteSize, mediaType: 'video/mp4' });
      orderedMedia.push({
        kind: 'video',
        assetId: video.assetId,
        sha256: video.sha256,
        byteSize: video.byteSize,
        durationMs: video.durationMs,
        extension: video.extension,
        height: video.height,
        label: video.label,
        mediaType: 'video/mp4',
        order: orderedMedia.length,
        origin: video.origin,
        width: video.width,
      });
      continue;
    }

    if (
      edge.targetPortId !== 'references'
      || (source.data.moduleType !== 'image_input' && source.data.moduleType !== 'upload_image')
      || edge.sourcePortId !== 'image'
    ) {
      return { ok: false, reason: 'Selected Agent is connected to an invalid managed media source.' };
    }
    const image = assetId === null ? undefined : imagesById.get(assetId);
    if (!image) return { ok: false, reason: '所选 Agent 连接了不可用的受管图片。' };
    if (seenAssetIds.has(image.assetId)) return { ok: false, reason: 'Agent 反推不能重复连接同一个素材。' };
    seenAssetIds.add(image.assetId);
    const label = image.label ?? image.assetId;
    references.push({ assetId: image.assetId, label, position: references.length, role: 'scene_composition' });
    edgeIds.push(edge.id);
    media.push({ kind: 'image', assetId: image.assetId, sha256: image.sha256, byteSize: image.byteSize, mediaType: image.mediaType });
    orderedMedia.push({
      kind: 'image',
      assetId: image.assetId,
      sha256: image.sha256,
      byteSize: image.byteSize,
      label,
      mediaType: image.mediaType,
      order: orderedMedia.length,
      role: 'scene_composition',
    });
  }

  if (orderedMedia.length === 0) return { ok: false, reason: '所选 Agent 未连接受管媒体。' };
  return { ok: true, references, media, orderedMedia, edgeIds };
}

function isUsableManagedVideo(video: ManagedVideo | undefined): video is ManagedVideo & {
  readonly durationMs: number;
  readonly height: number;
  readonly mediaType: 'video/mp4';
  readonly width: number;
} {
  return video !== undefined
    && video.durationMs !== null
    && video.height !== null
    && video.width !== null
    && video.mediaType === 'video/mp4'
    && video.byteSize <= MAX_REVERSE_PROMPT_MP4_BYTES;
}