import { memo, useEffect, useMemo, useRef, useState, type ClipboardEvent, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Handle, Position } from '@xyflow/react';
import { ChevronLeft, ChevronRight, Clapperboard, Copy, Download, Image as ImageIcon, ImageUp, Images, LockKeyhole, LockOpen, Play, Send, Video, X } from 'lucide-react';
import {
  getCanvasModuleDefinition,
  MAX_GENERATION_REFERENCES,
  reversePromptResultSchema,
  sanitizeModelJobError,
  type CanvasModuleDefinition,
  type CanvasModuleNodeData,
  type CanvasModulePortDefinition,
  type ModelJob,
  type ReverseAgentNodeConfig,
  type ReversePromptResult,
} from '@agent-canvas/domain';
import type { ProjectImageAssetSummary, ProjectVideoAssetSummary, ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import { resolveCanvasModuleIcon } from './module-icons';
import { formatMediaDisplayAspectRatio } from './media-display';
import { resolveConnectedReverseMedia } from './reverse-agent-media';
import { ConnectedAgentMediaSlots, type ConnectedAgentMediaSlotItem } from './ConnectedAgentMediaSlots';
import { useAppStore } from '../app/app-store';
import { isRenderableManagedImageUrl } from '../app/managed-image-url';
import { resolveMediaImportMode } from '../app/media-import-capability';
import { getActiveProjectSessionId } from '../app/desktop-persistence';
import {
  getPhotoshopImportAvailability,
  importGeneratedImageToPhotoshop,
  photoshopImportMessage,
} from '../app/photoshop-import';
import { readVideoGenerationResults } from './video-generation-results';
import { AspectRatioPopover, ClarityPopover } from './GenerationParameterPopover';
import { buildReverseResultSections } from './reverse-result-sections';
import { MediaMentionTextarea, type MediaMentionPreview } from '../mentions/MediaMentionTextarea';

const executionStateLabels: Record<CanvasModuleNodeData['execution']['state'], string> = {
  idle: '空闲',
  invalid: '无效',
  ready: '就绪',
  waiting_confirmation: '等待确认',
  queued: '已排队',
  running: '运行中',
  blocked: '已阻塞',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

function formatExecutionState(state: CanvasModuleNodeData['execution']['state']): string {
  return executionStateLabels[state];
}

interface ModulePortProps {
  port: CanvasModulePortDefinition;
  priority?: 'primary-media' | 'secondary';
  connected?: boolean;
}

const ModulePort = memo(function ModulePort({ port, priority, connected = false }: ModulePortProps) {
  const isInput = port.direction === 'input';
  const portShape = getPortShape(port.dataType);
  return (
    <div
      className={`module-node__port-row module-node__port-row--${port.direction}`}
      aria-label={`${port.primaryLabel} / ${port.secondaryLabel}`}
      data-port-id={port.id}
      data-port-direction={port.direction}
      data-port-type={port.dataType}
      data-port-shape={portShape}
      data-port-priority={priority}
    >
      {isInput && (
        <Handle
          id={port.id}
          type="target"
          position={Position.Left}
          data-port-id={port.id}
          data-port-direction={port.direction}
          data-port-type={port.dataType}
          data-port-shape={portShape}
          data-port-connected={connected ? 'true' : undefined}
          className={connected ? 'is-connected' : undefined}
        />
      )}
      <span aria-hidden="true" className="module-node__port-label" title={`${port.primaryLabel} / ${port.secondaryLabel}`}>
        {port.primaryLabel}
        {port.required ? null : <small className="module-node__port-optional" aria-label="可选 / optional">选</small>}
      </span>
      {!isInput && (
        <Handle
          id={port.id}
          type="source"
          position={Position.Right}
          data-port-id={port.id}
          data-port-direction={port.direction}
          data-port-type={port.dataType}
          data-port-shape={portShape}
          data-port-connected={connected ? 'true' : undefined}
          className={connected ? 'is-connected' : undefined}
        />
      )}
    </div>
  );
});

interface ModuleNodeCardProps {
  id: string;
  data: CanvasModuleNodeData & {
    locked?: boolean;
    imageGenerationRoutes?: readonly ImageGenerationRouteSummary[];
    videoGenerationRoutes?: readonly ImageGenerationRouteSummary[];
    reverseAgentRoutes?: readonly ReverseAgentRouteSummary[];
    storyboardRoutes?: readonly ReverseAgentRouteSummary[];
    onOpenReverseAgentSettings?: () => void;
    onGenerateImage?: (nodeId: string, input: { prompt: string; modelRoute?: string; aspectRatio?: string; resolution?: string; outputCount?: number; referenceAssetIds?: readonly string[] }) => Promise<boolean>;
    onReversePrompt?: (nodeId: string) => Promise<{ positivePrompt: string }>;
    onCancelJob?: (jobId: string) => Promise<void>;
    onGenerateStoryboard?: (nodeId: string, input: { modelRoute: string; script: string; shotCount: number; referenceAssetIds: readonly string[] }) => Promise<boolean>;
    resultOutputMenuOpen?: boolean;
    onResultOutputMenuChange?: (nodeId: string, open: boolean) => void;
    generationEditorExpanded?: boolean;
    onOpenGenerationEditor?: (nodeId: string) => void;
    onCloseGenerationEditor?: () => void;
    connectedPortIds?: readonly string[];
    connectedPortKeys?: readonly string[];
  };
  selected?: boolean;
}

interface ReverseAgentRouteSummary {
  readonly provider: string;
  readonly modelRoute: string;
  readonly displayName: string;
  readonly modelId?: string;
  readonly capabilities: readonly string[];
}

interface ImageGenerationRouteSummary {
  readonly provider: string;
  readonly modelRoute: string;
  readonly displayName: string;
  readonly modelId?: string;
  readonly capabilities: readonly string[];
  readonly capabilityStatus?: ProviderBridgeProfile['capabilityStatus'];
  readonly constraints?: ProviderBridgeProfile['constraints'];
}

const IMAGE_ASPECT_RATIO_OPTIONS = ['自由比例', '1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9'] as const;
const IMAGE_RESOLUTION_OPTIONS = ['2K', '4K'] as const;

function normalizeImageResolutionSelection(value: unknown): typeof IMAGE_RESOLUTION_OPTIONS[number] {
  if (value === 'Auto') return '2K';
  if (value === '1K') return '2K';
  if (value === '2K' || value === '1536x1024' || value === '1024x1536') return '2K';
  if (value === '4K') return '4K';
  return '2K';
}const REQUIRED_REVERSE_KNOWLEDGE_BASES = [
  { knowledgeBaseId: 'scene-skill', displayName: '场景 Skill', description: '产品场景、构图、材质与灯光规则' },
  { knowledgeBaseId: 'ecommerce-detail-knowledge', displayName: '电商详情页知识库', description: '详情页结构、卖点表达与视觉规范' },
] as const;

function resolveAutomaticImageAspectRatio(
  connectedMedia: readonly OrderedMediaSummary[],
  projectImages: readonly ProjectImageAssetSummary[],
): Exclude<typeof IMAGE_ASPECT_RATIO_OPTIONS[number], '自由比例'> | undefined {
  const connectedImage = connectedMedia.find((item) => item.kind === 'image');
  if (connectedImage === undefined) return undefined;
  const asset = projectImages.find((candidate) => candidate.assetId === connectedImage.assetId);
  const assetWidth = asset?.width;
  const assetHeight = asset?.height;
  if (typeof assetWidth !== 'number' || typeof assetHeight !== 'number' || assetWidth <= 0 || assetHeight <= 0) return undefined;
  const target = assetWidth / assetHeight;
  const candidates = IMAGE_ASPECT_RATIO_OPTIONS.filter((value): value is Exclude<typeof IMAGE_ASPECT_RATIO_OPTIONS[number], '自由比例'> => value !== '自由比例');
  return candidates.reduce((best, candidate) => {
    const [width, height] = candidate.split(':').map(Number);
    const [bestWidth, bestHeight] = best.split(':').map(Number);
    return Math.abs(Math.log((width! / height!) / target)) < Math.abs(Math.log((bestWidth! / bestHeight!) / target)) ? candidate : best;
  }, candidates[0]!);
}
export function resolveAutomaticVideoAspectRatio(
  connectedMedia: readonly OrderedMediaSummary[],
  projectImages: readonly ProjectImageAssetSummary[],
  projectVideos: readonly ProjectVideoAssetSummary[],
): Exclude<typeof VIDEO_ASPECT_RATIO_OPTIONS[number], 'Auto'> | undefined {
  const first = connectedMedia[0];
  if (first === undefined) return undefined;
  const asset = first.kind === 'image'
    ? projectImages.find((candidate) => candidate.assetId === first.assetId)
    : projectVideos.find((candidate) => candidate.assetId === first.assetId);
  const assetWidth = asset?.width;
  const assetHeight = asset?.height;
  if (typeof assetWidth !== 'number' || typeof assetHeight !== 'number' || assetWidth <= 0 || assetHeight <= 0) return undefined;
  const target = assetWidth / assetHeight;
  const candidates = VIDEO_ASPECT_RATIO_OPTIONS.filter((value): value is Exclude<typeof VIDEO_ASPECT_RATIO_OPTIONS[number], 'Auto'> => value !== 'Auto');
  return candidates.reduce((best, candidate) => {
    const [width, height] = candidate.split(':').map(Number);
    const [bestWidth, bestHeight] = best.split(':').map(Number);
    return Math.abs(Math.log((width! / height!) / target)) < Math.abs(Math.log((bestWidth! / bestHeight!) / target)) ? candidate : best;
  }, candidates[0]!);
}
function aspectRatioGlyphStyle(value: string): CSSProperties {
  const [width = Number.NaN, height = Number.NaN] = value.split(':').map(Number);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { aspectRatio: `${width} / ${height}` }
    : { aspectRatio: '1 / 1' };
}
const IMAGE_OUTPUT_COUNT_OPTIONS = [1, 2, 3, 4] as const;
const VIDEO_ASPECT_RATIO_OPTIONS = ['Auto', '1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9'] as const;
const VIDEO_RESOLUTION_OPTIONS = ['480p', '720p', '1080p'] as const;
const VIDEO_DURATION_OPTIONS = [4, 8, 12] as const;

function normalizeVideoResolutionSelection(value: unknown): typeof VIDEO_RESOLUTION_OPTIONS[number] {
  if (value === '480p' || value === '480P') return '480p';
  if (value === '1080p' || value === '1080P' || value === '2K' || value === '4K') return '1080p';
  return '720p';
}

function durationOptions(constraint: NonNullable<NonNullable<ProviderBridgeProfile['constraints']>['video']>['duration']): number[] {
  if (constraint === undefined) return [...VIDEO_DURATION_OPTIONS];
  if (constraint.mode === 'options') return [...constraint.options];
  const values: number[] = [];
  for (let value = constraint.min; value <= constraint.max && values.length < 60; value += constraint.step) values.push(value);
  return values.length > 0 ? values : [constraint.defaultValue ?? constraint.min];
}

export const ModuleNodeCard = memo(function ModuleNodeCard({ id, data, selected }: ModuleNodeCardProps) {
  const definition = getCanvasModuleDefinition(data.moduleType);
  const connectedPortIds = new Set(data.connectedPortIds ?? []);
  const connectedPortKeys = new Set(data.connectedPortKeys ?? []);
  const isPortConnected = (port: CanvasModulePortDefinition) => (
    data.connectedPortKeys === undefined
      ? connectedPortIds.has(port.id)
      : connectedPortKeys.has(`${port.direction}:${port.id}`)
  );
  const Icon = resolveCanvasModuleIcon(definition.type);
  const inputs = definition.ports.filter((port) => port.direction === 'input');
  const outputs = definition.ports.filter((port) => port.direction === 'output');
  const visibleInputs = data.moduleType === 'image_generation'
    ? inputs.filter((port) => port.id === 'references')
    : data.moduleType === 'video_generation'
      ? inputs.filter((port) => port.id === 'media')
      : data.moduleType === 'reverse_agent'
        ? inputs.filter((port) => port.id === 'references')
        : inputs;
  const visibleOutputs = data.moduleType === 'reverse_agent'
    ? outputs.filter((port) => port.id === 'analysis')
    : outputs;
  const projectImages = useAppStore((state) => state.projectImages);
  const projectVideos = useAppStore((state) => state.projectVideos);
  const projectImageError = useAppStore((state) => state.projectImageError);
  const importingNodeId = useAppStore((state) => state.projectImageImportingNodeId);
  const importImageForModule = useAppStore((state) => state.importImageForModule);
  const importVideoForModule = useAppStore((state) => state.importVideoForModule);
  const selectProjectImageForModule = useAppStore((state) => state.selectProjectImageForModule);
  const setCanvasLibrarySelection = useAppStore((state) => state.setCanvasLibrarySelection);
  const runImageGenerationNode = useAppStore((state) => state.runImageGenerationNode);
  const runVideoPreviewNode = useAppStore((state) => state.runVideoPreviewNode);
  const generateStoryboardNode = useAppStore((state) => state.generateStoryboardNode);
  const cancelModelJob = useAppStore((state) => state.cancelModelJob);
  const project = useAppStore((state) => state.project);
  const modelJobs = useAppStore((state) => state.modelJobs);
  const runReverseAgentNode = useAppStore((state) => state.runReverseAgentNode);
  const knowledgeBases = useAppStore((state) => state.knowledgeBases);
  const toggleNodeLock = useAppStore((state) => state.toggleNodeLock);
  const reorderModuleInput = useAppStore((state) => state.reorderModuleInput);
  const reorderModuleInputDurably = async (targetNodeId: string, targetPortId: string, edgeIds: string[]) => {
    if (await reorderModuleInput(targetNodeId, targetPortId, edgeIds)) return true;
    const current = useAppStore.getState();
    if (!current.canReloadDurableProject || !await current.reloadDurableProject()) return false;
    return useAppStore.getState().reorderModuleInput(targetNodeId, targetPortId, edgeIds);
  };
  const [libraryQuery, setLibraryQuery] = useState('');
  const hasImageControls = data.moduleType === 'image_input'
    || data.moduleType === 'upload_image'
    || data.moduleType === 'canvas_library';
  const hasMediaControls = hasImageControls || data.moduleType === 'video_input';
  const isFoundationNode = data.moduleType === 'image_input'
    || data.moduleType === 'upload_image'
    || data.moduleType === 'video_input'
    || data.moduleType === 'canvas_library'
    || data.moduleType === 'result_output'
    || data.moduleType === 'video_result'
    || data.moduleType === 'reverse_result';
  const isProfessionalWorkbench = data.moduleType === 'image_generation'
    || data.moduleType === 'video_generation'
    || data.moduleType === 'reverse_agent'
    || data.moduleType === 'storyboard_sheet'
    || data.moduleType === 'music_generation'
    || data.moduleType === 'speech_generation';
  const filteredProjectImages = useMemo(() => {
    const query = libraryQuery.trim().toLocaleLowerCase();
    return query.length === 0
      ? projectImages
      : projectImages.filter((asset) => asset.label.toLocaleLowerCase().includes(query));
  }, [libraryQuery, projectImages]);
  const selectedImage = hasImageControls && typeof data.config.assetId === 'string'
    ? projectImages.find((asset) => asset.assetId === data.config.assetId)
    : undefined;

  const hasSelectedImage = (data.moduleType === 'image_input' || data.moduleType === 'upload_image')
    && selectedImage !== undefined;
  const selectedVideo = data.moduleType === 'video_input' && typeof data.config.assetId === 'string'
    ? projectVideos.find((asset) => asset.assetId === data.config.assetId)
    : undefined;
  const hasSelectedVideo = data.moduleType === 'video_input' && selectedVideo !== undefined;
  const activeImageGenerationJob = data.moduleType === 'image_generation'
    ? modelJobs.find((job) => job.promptNodeId === id && ['queued', 'submitting', 'running'].includes(job.status))
    : undefined;
  const activeVideoGenerationJob = data.moduleType === 'video_generation'
    ? modelJobs.find((job) => job.promptNodeId === id && ['queued', 'submitting', 'running'].includes(job.status))
    : undefined;
  const isGenerationNode = data.moduleType === 'image_generation' || data.moduleType === 'video_generation';
  const [fallbackGenerationEditorOpen, setFallbackGenerationEditorOpen] = useState(false);
  const generationEditorExpanded = data.generationEditorExpanded ?? fallbackGenerationEditorOpen;
  const requestGenerationEditorOpen = () => {
    if (data.onOpenGenerationEditor) data.onOpenGenerationEditor(id);
    else setFallbackGenerationEditorOpen(true);
  };
  const requestGenerationEditorClose = () => {
    if (data.onCloseGenerationEditor) data.onCloseGenerationEditor();
    else setFallbackGenerationEditorOpen(false);
  };
  const handleGenerationCardClick = (event: MouseEvent<HTMLElement>) => {
    if (!isGenerationNode) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('.react-flow__handle, button, input, textarea, select, a, [role="button"], [role="menuitem"]')) return;
    requestGenerationEditorOpen();
  };
  const mediaNodeStyle = selectedImage
    ? { '--media-node-width': `${getMediaNodeWidth(selectedImage)}px` } as CSSProperties
    : undefined;
  const upstreamReverseResult = useMemo(() => {
    if (data.moduleType !== 'reverse_result') return null;
    const incoming = project.edges.find((edge) => edge.target === id && edge.targetPortId === 'analysis');
    if (incoming === undefined) return null;
    const source = project.nodes.find((candidate) => candidate.id === incoming.source);
    if (source?.type !== 'module' || source.data.moduleType !== 'reverse_agent') return null;
    return readReverseAgentResult(source.data.config.reverseAgentResult);
  }, [data.moduleType, id, project.edges, project.nodes]);
  const upstreamVideoResult = useMemo(() => {
    if (data.moduleType !== 'video_result') return null;
    const incoming = project.edges.find((edge) => edge.target === id && edge.targetPortId === 'video');
    if (incoming === undefined) return null;
    const source = project.nodes.find((candidate) => candidate.id === incoming.source);
    if (source?.type !== 'module' || source.data.moduleType !== 'video_generation' || incoming.sourcePortId !== 'result') return null;
    const generatedResult = readVideoGenerationResults(source.data.config)[0];
    if (generatedResult === undefined) return null;
    const posterAsset = generatedResult.posterAssetId === undefined
      ? undefined
      : projectImages.find((candidate) => candidate.assetId === generatedResult.posterAssetId);
    const posterUrl = isRenderableManagedImageUrl(generatedResult.posterUrl)
      ? generatedResult.posterUrl
      : isRenderableManagedImageUrl(posterAsset?.displayUrl, posterAsset?.assetId)
        ? posterAsset.displayUrl
        : null;
    return { posterUrl };
  }, [data.moduleType, id, project.edges, project.nodes, projectImages]);
  const connectedVideoMedia = data.moduleType === 'video_generation'
    ? resolveConnectedGenerationMedia(project, id, 'media')
    : [];
  const hasConnectedVideoMedia = data.moduleType === 'video_generation'
    && project.edges.some((edge) => edge.target === id && edge.targetPortId === 'media');
  const connectedImageGenerationMedia = data.moduleType === 'image_generation'
    ? resolveConnectedGenerationMedia(project, id, 'references')
    : [];
  const hasConnectedImageGenerationReference = data.moduleType === 'image_generation'
    && project.edges.some((edge) => edge.target === id && edge.targetPortId === 'references');
  const connectedReverseMedia: OrderedMediaSummary[] = (() => {
    if (data.moduleType !== 'reverse_agent') return [];
    const resolved = resolveConnectedReverseMedia({
      project,
      nodeId: id,
      images: projectImages,
      videos: projectVideos,
    });
    if (!resolved.ok) return [];
    return resolved.orderedMedia.map((item, index) => {
      const image = item.kind === 'image' ? projectImages.find((asset) => asset.assetId === item.assetId) : undefined;
      const video = item.kind === 'video' ? projectVideos.find((asset) => asset.assetId === item.assetId) : undefined;
      return {
        edgeId: resolved.edgeIds[index],
        kind: item.kind,
        assetId: item.assetId,
        label: image?.label ?? video?.label ?? item.label ?? item.assetId,
        previewUrl: image && isRenderableManagedImageUrl(image.displayUrl, image.assetId)
          ? image.displayUrl
          : video?.displayUrl,
        ranges: [],
      };
    });
  })();
  const displayPrimaryName = data.moduleType === 'reverse_agent' ? '反推anget' : definition.primaryName;
  const displaySecondaryName = data.moduleType === 'reverse_agent' ? 'Reverse Agent' : definition.secondaryName;
  return (
    <article
      className={`module-node nowheel${hasMediaControls ? ' module-node--media-controls' : ''}${hasImageControls ? ' module-node--image-controls' : ''}${hasSelectedImage || hasSelectedVideo ? ' module-node--has-media' : ''}${isFoundationNode ? ' module-node--foundation' : ''}${data.moduleType === 'reverse_agent' ? ' module-node--reverse-figma' : data.moduleType === 'image_generation' ? ' module-node--image-figma' : data.moduleType === 'video_generation' ? ' module-node--video-figma' : isProfessionalWorkbench ? ' module-node--workbench' : ''}${selected ? ' is-selected' : ''}`}
      data-testid="module-node-card"
      data-module-type={definition.type}
      data-port-label-mode={isProfessionalWorkbench ? 'interactive' : 'always'}
      style={mediaNodeStyle}
      onClick={handleGenerationCardClick}
    >
      <header className="module-node__header">
        <span
          className="module-node__icon"
          data-icon-category={definition.category}
          aria-hidden="true"
        >
          <Icon size={18} strokeWidth={1.8} />
        </span>
        <span className="module-node__heading">
          <strong>{displayPrimaryName}</strong>
          <small>{displaySecondaryName}</small>
        </span>
        <button
          type="button"
          className="module-node__lock nodrag"
          aria-label={data.locked ? '解锁位置 / Unlock position' : '锁定位置 / Lock position'}
          title={data.locked ? '解锁位置 / Unlock position' : '锁定位置 / Lock position'}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            void toggleNodeLock(id);
          }}
        >
          {data.locked ? <LockKeyhole size={14} /> : <LockOpen size={14} />}
        </button>
      </header>
      {data.moduleType === 'image_input' || data.moduleType === 'upload_image' ? (
        <ProjectImageControl
          assetId={typeof data.config.assetId === 'string' ? data.config.assetId : undefined}
          assets={projectImages}
          error={projectImageError}
          importing={importingNodeId === id}
          moduleType={data.moduleType}
          onImport={(file) => { void (file === undefined ? importImageForModule(id) : importImageForModule(id, file)); }}
          onSelect={(assetId) => { void selectProjectImageForModule(id, assetId); }}
        />
      ) : data.moduleType === 'video_input' ? (
        <VideoInputControl
          asset={selectedVideo}
          importing={importingNodeId === id}
          onImport={(file) => { void (file === undefined ? importVideoForModule(id) : importVideoForModule(id, file)); }}
        />
      ) : data.moduleType === 'canvas_library' ? (
        <CanvasLibraryControl
          assets={filteredProjectImages}
          allAssetCount={projectImages.length}
          assetIds={readAssetIds(data.config.assetIds)}
          error={projectImageError}
          query={libraryQuery}
          onQueryChange={setLibraryQuery}
          onSelectionChange={(assetIds) => { void setCanvasLibrarySelection(id, assetIds); }}
        />
      ) : data.moduleType === 'result_output' ? (
        <ResultOutputPreview
          menuOpen={data.onResultOutputMenuChange ? data.resultOutputMenuOpen : undefined}
          onMenuOpenChange={data.onResultOutputMenuChange ? (open) => data.onResultOutputMenuChange?.(id, open) : undefined}
        />
      ) : data.moduleType === 'video_result' ? (
        <VideoResultPreview result={upstreamVideoResult} />
      ) : data.moduleType === 'reverse_result' ? (
        <ReverseResultPreview result={upstreamReverseResult} />
      ) : data.moduleType === 'image_generation' ? (
        <ImageGenerationSummary
          id={id}
          config={data.config}
          projectImages={projectImages}
          projectVideos={projectVideos}
          connectedMedia={connectedImageGenerationMedia}
          hasConnectedReference={hasConnectedImageGenerationReference}
          routes={data.imageGenerationRoutes ?? []}
          executionState={data.execution.state}
          onRun={data.onGenerateImage ?? runImageGenerationNode}
          activeJobId={activeImageGenerationJob?.id}
          onCancel={data.onCancelJob ?? cancelModelJob}
          onReorderMedia={(edgeIds) => reorderModuleInputDurably(id, 'references', edgeIds)}
          expanded={generationEditorExpanded}
          onRequestExpand={requestGenerationEditorOpen}
          onRequestCollapse={requestGenerationEditorClose}
        />
      ) : data.moduleType === 'video_generation' ? (
        <VideoGenerationSummary
          id={id}
          config={data.config}
          projectImages={projectImages}
          projectVideos={projectVideos}
          connectedMedia={connectedVideoMedia}
          hasConnectedMedia={hasConnectedVideoMedia}
          routes={data.videoGenerationRoutes ?? []}
          executionState={data.execution.state}
          onRun={runVideoPreviewNode}
          activeJobId={activeVideoGenerationJob?.id}
          onCancel={data.onCancelJob ?? cancelModelJob}
          onReorderMedia={(edgeIds) => reorderModuleInputDurably(id, 'media', edgeIds)}
          expanded={generationEditorExpanded}
          onRequestExpand={requestGenerationEditorOpen}
          onRequestCollapse={requestGenerationEditorClose}
        />
      ) : data.moduleType === 'reverse_agent' ? (
        <ReverseAgentSummary
          id={id}
          config={data.config}
          projectImages={projectImages}
          projectVideos={projectVideos}
          connectedMedia={connectedReverseMedia}
          knowledgeBases={knowledgeBases}
          routes={data.reverseAgentRoutes ?? []}
          executionState={data.execution.state}
          onRun={data.onReversePrompt ?? runReverseAgentNode}
          onReorderMedia={(edgeIds) => reorderModuleInputDurably(id, 'references', edgeIds)}
          onOpenSettings={data.onOpenReverseAgentSettings}
        />
      ) : data.moduleType === 'storyboard_sheet' ? (
        <StoryboardSheetSummary
          id={id}
          config={data.config}
          routes={data.storyboardRoutes ?? []}
          onRun={data.onGenerateStoryboard ?? generateStoryboardNode}
          onGenerateImage={data.onGenerateImage ?? runImageGenerationNode}
        />
      ) : data.moduleType === 'music_generation' || data.moduleType === 'speech_generation' ? (
        <UnavailableCapabilitySummary />
      ) : (
        <GenericModuleSummary config={data.config} definition={definition} />
      )}
      <div
        className={`module-node__ports${visibleInputs.length > 0 ? ' has-inputs' : ''}${visibleOutputs.length > 0 ? ' has-outputs' : ''}`}
        aria-label="模块端口 / Module ports"
      >
        <div className="module-node__ports-column module-node__ports-column--inputs">
          {visibleInputs.map((port) => (
            <ModulePort
              key={`${port.direction}:${port.id}`}
              port={port}
              priority={portPriority(data.moduleType, port)}
              connected={isPortConnected(port)}
            />
          ))}
        </div>
        <div className="module-node__ports-column module-node__ports-column--outputs">
          {visibleOutputs.map((port) => <ModulePort key={`${port.direction}:${port.id}`} port={port} connected={isPortConnected(port)} />)}
        </div>
      </div>
      <footer className="module-node__footer">
        <span>{formatExecutionMode(definition.executionMode)}</span>
        <b data-execution-state={data.execution.state}>{formatExecutionState(data.execution.state)}</b>
      </footer>
      <ModuleError config={data.config} />
    </article>
  );
});

function portPriority(moduleType: CanvasModuleNodeData['moduleType'], port: CanvasModulePortDefinition): 'primary-media' | 'secondary' | undefined {
  if (port.direction !== 'input') return undefined;
  if (
    (moduleType === 'reverse_agent' && port.id === 'references')
    || (moduleType === 'image_generation' && port.id === 'references')
    || (moduleType === 'video_generation' && port.id === 'media')
  ) {
    return 'primary-media';
  }
  if (moduleType === 'reverse_agent' || moduleType === 'image_generation' || moduleType === 'video_generation') {
    return 'secondary';
  }
  return undefined;
}

function StoryboardSheetSummary({
  id,
  config,
  routes,
  onRun,
  onGenerateImage,
}: {
  id: string;
  config: Record<string, unknown>;
  routes: readonly ReverseAgentRouteSummary[];
  onRun: (nodeId: string, input: { readonly modelRoute: string; readonly script: string; readonly shotCount: number; readonly referenceAssetIds: readonly string[] }) => Promise<boolean>;
  onGenerateImage: (nodeId: string, input: { prompt: string; aspectRatio?: string; resolution?: string; outputCount?: number; referenceAssetIds?: readonly string[] }) => Promise<boolean>;
}) {
  const projectNodes = useAppStore((state) => state.project.nodes);
  const projectImages = useAppStore((state) => state.projectImages);
  const updateStoryboardShot = useAppStore((state) => state.updateStoryboardShot);
  const compatibleRoutes = dedupeVisibleModelRoutes(routes.filter((route) => route.capabilities.includes('chat') || route.capabilities.includes('vision')));
  const [expanded, setExpanded] = useState(false);
  const [script, setScript] = useState(readNonEmptyString(config.script) ?? '');
  const [modelRoute, setModelRoute] = useState(readNonEmptyString(config.modelRoute) ?? compatibleRoutes[0]?.modelRoute ?? '');
  const [shotCount, setShotCount] = useState(readPositiveInteger(config.shotCount) ?? 6);
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  const [targetImageNodeId, setTargetImageNodeId] = useState('');
  const [aspectRatio, setAspectRatio] = useState('16:9');
  const [resolution, setResolution] = useState('1024x1024');
  const [outputCount, setOutputCount] = useState(1);
  const [composition, setComposition] = useState('');
  const [referenceAssetIds, setReferenceAssetIds] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const shots = readStoryboardShots(config.shots);
  const selectedShot = shots.find((shot) => shot.id === selectedShotId) ?? null;
  const imageGenerationTargets = projectNodes.filter((node) => node.type === 'module' && node.data.moduleType === 'image_generation');
  const runStoryboard = () => {
    setIsGenerating(true);
    setRunError(null);
    void onRun(id, { modelRoute, script: script.trim(), shotCount, referenceAssetIds: [] })
      .then((success) => { if (!success) setRunError('Storyboard generation could not be completed. Check the selected route and try again.'); })
      .catch(() => setRunError('Storyboard generation could not be completed. Check the selected route and try again.'))
      .finally(() => setIsGenerating(false));
  };
  const editor = selectedShot && <div className="module-node__storyboard-editor nodrag nopan" onPointerDown={stopCanvasPointer}>
        <label>构图 / Composition<textarea aria-label="Shot composition" value={composition} onChange={(event) => setComposition(event.target.value)} rows={3} /></label>
        <label>比例 / Aspect ratio<select aria-label="Shot aspect ratio" value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}><option>16:9</option><option>1:1</option><option>9:16</option></select></label>
        <label>分辨率 / Resolution<select aria-label="Shot resolution" value={resolution} onChange={(event) => setResolution(event.target.value)}><option>1024x1024</option><option>1536x1024</option><option>1024x1536</option></select></label>
        <label>数量 / Count<select aria-label="Shot output count" value={outputCount} onChange={(event) => setOutputCount(Number(event.target.value))}><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option><option value={4}>4</option></select></label>
        <label>生图节点 / Image node<select aria-label="Target image-generation node" value={targetImageNodeId} onChange={(event) => setTargetImageNodeId(event.target.value)}><option value="">选择生图节点 / Select an image node</option>{imageGenerationTargets.map((node) => <option key={node.id} value={node.id}>{node.id}</option>)}</select></label>
        <fieldset aria-label="Shot managed references">{projectImages.map((asset) => {
          const selected = referenceAssetIds.includes(asset.assetId);
          return <label key={asset.assetId}><input type="checkbox" aria-label={`Use ${asset.label} for shot`} checked={selected} disabled={!selected && referenceAssetIds.length >= MAX_GENERATION_REFERENCES} onChange={() => setReferenceAssetIds((current) => selected ? current.filter((assetId) => assetId !== asset.assetId) : [...current, asset.assetId])} />{asset.label}</label>;
        })}</fieldset>
        <button type="button" aria-label="Save storyboard shot" onClick={() => { void updateStoryboardShot(id, selectedShot.id, { composition, aspectRatio, resolution, outputCount, referenceAssetIds }); }}>保存镜头 / Save</button>
        <button type="button" aria-label="Run selected storyboard shot" disabled={!targetImageNodeId} onClick={() => { if (targetImageNodeId) void onGenerateImage(targetImageNodeId, { prompt: composition, aspectRatio, resolution, outputCount, referenceAssetIds }); }}>交给生图节点运行</button>
        <button type="button" aria-label="Copy shot prompt" onClick={() => { void globalThis.navigator?.clipboard?.writeText(composition); }}>复制提示词 / Copy</button>
      </div>;
  return (
    <section className="module-node__summary module-node__summary--compact module-node__summary--storyboard" aria-label="Storyboard workbench">
      <ExecutableNodeWorkbench
        label="分镜表"
        status={isGenerating ? '正在生成' : shots.length > 0 ? '已生成镜头' : '等待脚本'}
        configuration={<>
          <button type="button" className="module-node__workbench-toggle nodrag nopan" aria-label="Open storyboard composer" onClick={() => setExpanded((value) => !value)}>
            {expanded ? '收起分镜编辑器 / Hide composer' : '打开分镜编辑器 / Open composer'}
          </button>
          {expanded && <div className="module-node__storyboard-composer nodrag nopan" onPointerDown={stopCanvasPointer}>
            <textarea aria-label="Storyboard script" rows={6} value={script} placeholder="输入场景脚本 / Write the scene script" onChange={(event) => setScript(event.target.value)} />
            <div className="module-node__parameter-row">
              <select aria-label="Storyboard model route" value={modelRoute} onChange={(event) => setModelRoute(event.target.value)}>
                {compatibleRoutes.length === 0 ? <option value="">未配置兼容路线 / No compatible route</option> : compatibleRoutes.map((route) => <option key={route.modelRoute} value={route.modelRoute}>{modelRouteOptionLabel(route, compatibleRoutes)}</option>)}
              </select>
              <select aria-label="Storyboard shot count" value={shotCount} onChange={(event) => setShotCount(Number(event.target.value))}>
                {[1, 2, 4, 6, 8, 12].map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
              <button type="button" aria-label="Generate storyboard" disabled={!modelRoute || script.trim().length === 0 || isGenerating} onClick={runStoryboard}>{isGenerating ? '正在生成分镜…' : '生成分镜 / Generate'}</button>
            </div>
          </div>}
          {isGenerating && <p role="status">正在生成分镜 / Storyboard generation running</p>}
          {runError !== null && <p role="alert">{runError}</p>}
        </>}
        result={<>
          {shots.length === 0 ? <p className="module-node__result-empty">尚未生成镜头 / No storyboard shots yet</p> : <div className="module-node__storyboard-grid" aria-label="Storyboard shots">
            {shots.map((shot) => <button key={shot.id} type="button" aria-label={`Select storyboard shot ${shot.title}`} className={selectedShot?.id === shot.id ? 'is-selected' : ''} onClick={() => { setSelectedShotId(shot.id); setComposition(shot.composition); setReferenceAssetIds(shot.referenceAssetIds); setAspectRatio(shot.aspectRatio); setResolution(shot.resolution); setOutputCount(shot.outputCount); }}>
              <b>{shot.order}. {shot.title}</b><small>{shot.durationSeconds}s</small>
            </button>)}
          </div>}
          {editor}
        </>}
      />
    </section>
  );
}

function VideoGenerationSummary({
  id,
  config,
  projectImages,
  projectVideos,
  connectedMedia,
  hasConnectedMedia,
  routes,
  executionState,
  onRun,
  activeJobId,
  onCancel,
  onReorderMedia,
  expanded,
  onRequestExpand,
  onRequestCollapse,
}: {
  id: string;
  config: Record<string, unknown>;
  projectImages: readonly ProjectImageAssetSummary[];
  projectVideos: readonly ProjectVideoAssetSummary[];
  connectedMedia: readonly OrderedMediaSummary[];
  hasConnectedMedia: boolean;
  routes: readonly ImageGenerationRouteSummary[];
  executionState: CanvasModuleNodeData['execution']['state'];
  onRun: (nodeId: string, input: {
    prompt: string;
    referenceAssetIds: readonly string[];
    modelRoute: string;
    aspectRatio: string;
    keyframe: string;
    durationSeconds: number;
    resolution: string;
    outputCount: 1 | 2 | 3 | 4;
    audioEnabled: boolean;
  }) => Promise<boolean>;
  activeJobId?: string;
  onCancel: (jobId: string) => Promise<void>;
  onReorderMedia: (edgeIds: string[]) => Promise<boolean>;
  expanded: boolean;
  onRequestExpand: () => void;
  onRequestCollapse: () => void;
}) {
  const connectedImages = useMemo(() => connectedMedia
    .filter((item) => item.kind === 'image')
    .map((item) => projectImages.find((asset) => asset.assetId === item.assetId))
    .filter((asset): asset is ProjectImageAssetSummary => asset !== undefined), [connectedMedia, projectImages]);
  const mentionPreviews = useMemo(() => buildMediaMentionPreviews(connectedImages, projectVideos.filter((asset) => connectedMedia.some((item) => item.kind === 'video' && item.assetId === asset.assetId))), [connectedImages, connectedMedia, projectVideos]);
  const [prompt, setPrompt] = useExternallyHydratedDraftState(readNonEmptyString(config.prompt) ?? '');
  const [runError, setRunError] = useState<string | null>(null);
  const [mentionPickerOpen, setMentionPickerOpen] = useState(false);
  const [mentionedReferenceAssetIds, setMentionedReferenceAssetIds] = useState<string[]>([]);
  const referenceAssetIds = connectedMedia.filter((item) => item.kind === 'image').map((item) => item.assetId);
  const sourceVideoAssetId = connectedMedia.find((item) => item.kind === 'video')?.assetId;
  const compatibleRoutes = useMemo(
    () => dedupeVisibleModelRoutes(routes.filter((route) => route.capabilities.includes('video_generation'))),
    [routes],
  );
  const [modelRoute, setModelRoute] = useExternallyHydratedDraftState(readNonEmptyString(config.modelRoute) ?? compatibleRoutes[0]?.modelRoute ?? '');
  const [aspectRatio, setAspectRatio] = useExternallyHydratedDraftState(readNonEmptyString(config.aspectRatio) ?? '16:9');
  const [keyframe, setKeyframe] = useExternallyHydratedDraftState(readNonEmptyString(config.keyframe) ?? 'auto');
  const [durationSeconds, setDurationSeconds] = useExternallyHydratedDraftState(readPositiveInteger(config.durationSeconds) ?? 4);
  const [resolution, setResolution] = useExternallyHydratedDraftState(normalizeVideoResolutionSelection(config.resolution));
  const [outputCount, setOutputCount] = useExternallyHydratedDraftState<1 | 2 | 3 | 4>(readSupportedImageCount(config.outputCount));
  const [audioEnabled, setAudioEnabled] = useExternallyHydratedDraftState(config.audioEnabled !== false);
  const draftGenerationNodeConfig = useAppStore((state) => state.draftGenerationNodeConfig);
  const selectedVideoRoute = compatibleRoutes.find((route) => route.modelRoute === modelRoute);
  const videoConstraints = selectedVideoRoute?.constraints?.video;
  const videoAspectRatioOptions: (typeof VIDEO_ASPECT_RATIO_OPTIONS[number])[] = [...VIDEO_ASPECT_RATIO_OPTIONS];

  const videoResolutionOptions = [...VIDEO_RESOLUTION_OPTIONS];
  const videoDurationOptions = durationOptions(videoConstraints?.duration);
  const videoOutputCountOptions: (1 | 2 | 3 | 4)[] = [...IMAGE_OUTPUT_COUNT_OPTIONS];
  const videoOptionsKey = [videoAspectRatioOptions.join('|'), videoResolutionOptions.join('|'), videoDurationOptions.join('|'), videoOutputCountOptions.join('|')].join('::');
  useEffect(() => {
    const nextReferenceAssetIds = readStringArray(config.referenceAssetIds);
    setMentionedReferenceAssetIds((current) => stringArraysEqual(current, nextReferenceAssetIds) ? current : nextReferenceAssetIds);
  }, [config.referenceAssetIds]);
  useEffect(() => {
    if (!videoAspectRatioOptions.includes(aspectRatio as never)) setAspectRatio(videoAspectRatioOptions[0] ?? 'Auto');
    if (!videoResolutionOptions.includes(resolution as never)) setResolution(videoResolutionOptions[0] ?? '720p');
    if (!videoDurationOptions.includes(durationSeconds)) setDurationSeconds(videoDurationOptions[0] ?? 4);
    if (!videoOutputCountOptions.includes(outputCount)) setOutputCount(videoOutputCountOptions[0] ?? 1);
  }, [modelRoute, videoOptionsKey]);
  useEffect(() => {
    if (compatibleRoutes.length === 0) return;
    setModelRoute((current) => compatibleRoutes.some((route) => route.modelRoute === current)
      ? current
      : compatibleRoutes[0]?.modelRoute ?? '');
  }, [compatibleRoutes]);
  useEffect(() => {
    const draft = {
      prompt,
      modelRoute,
      aspectRatio,
      keyframe,
      durationSeconds,
      resolution,
      outputCount,
      audioEnabled,
    };
    void persistDraftWithBoundaryRetry(() => draftGenerationNodeConfig(id, draft));
  }, [aspectRatio, audioEnabled, draftGenerationNodeConfig, durationSeconds, id, keyframe, modelRoute, outputCount, prompt, resolution]);
  const persistVideoPromptDraft = (nextPrompt: string) => persistDraftWithBoundaryRetry(() => draftGenerationNodeConfig(id, {
    prompt: nextPrompt,
    modelRoute,
    aspectRatio,
    keyframe,
    durationSeconds,
    resolution,
    outputCount,
    audioEnabled,
  }));
  const modelJobs = useAppStore((state) => state.modelJobs);
  const latestVideoJob = selectLatestGenerationJob(modelJobs, id, 'video');
  const failedVideoJobError = formatGenerationJobError(
    latestVideoJob?.status === 'failed' ? latestVideoJob : undefined,
    'video',
  );
  const liveVideoResults = useMemo(() => selectLatestCompletedGenerationJobs(modelJobs, id, 'video')
    .map((job) => projectVideos.find((asset) => asset.assetId === job.resultAssetId))
    .filter((asset): asset is ProjectVideoAssetSummary => asset !== undefined)
    .map((asset) => ({
      assetId: asset.assetId,
      mediaType: asset.mediaType,
      durationMs: asset.durationMs ?? 1,
      videoUrl: asset.displayUrl,
    })), [id, modelJobs, projectVideos]);
  const configuredVideoResults = useMemo(() => readVideoGenerationResults(config), [config]);
  const durableVideoResults = useMemo(() => configuredVideoResults.map((item) => {
    const asset = projectVideos.find((candidate) => candidate.assetId === item.assetId);
    return asset === undefined
      ? item
      : {
        ...item,
        durationMs: asset.durationMs ?? item.durationMs,
        mediaType: asset.mediaType,
        videoUrl: asset.displayUrl,
      };
  }), [configuredVideoResults, projectVideos]);
  const completedVideoResults = liveVideoResults.length > 0 ? liveVideoResults : durableVideoResults;
  const resolveVideoResultPoster = (item: (typeof completedVideoResults)[number]) => {
    if ('posterUrl' in item && isRenderableManagedImageUrl(item.posterUrl)) return item.posterUrl;
    const posterAsset = 'posterAssetId' in item && item.posterAssetId
      ? projectImages.find((asset) => asset.assetId === item.posterAssetId)
      : undefined;
    return isRenderableManagedImageUrl(posterAsset?.displayUrl, posterAsset?.assetId) ? posterAsset.displayUrl : undefined;
  };
  const resolveVideoResultUrl = (item: (typeof completedVideoResults)[number]) => 'videoUrl' in item ? item.videoUrl : undefined;
  const hasCompletedResult = completedVideoResults.length > 0;
  const videoTimingJob = selectGenerationTimingJob(modelJobs, id, 'video', durableVideoResults.length > 0);
  const result = hasCompletedResult ? '视频结果已就绪' : '等待生成';
  return (
    <section className="module-node__summary module-node__summary--compact module-node__summary--generation" data-editor-expanded={expanded ? 'true' : 'false'} aria-label="视频模拟预览">
      <TaskTimingBadge ariaLabel="Video generation task timing" job={videoTimingJob} />
      {!expanded && <section className="module-node__generation-collapsed-shell nodrag nopan" aria-label="Video generation preview">
        <button type="button" className="module-node__generation-collapsed-preview module-node__generation-collapsed-open nodrag nopan" aria-label="Open video generation editor" aria-expanded={expanded} title="点击展开" onPointerDown={stopCanvasPointer} onClick={() => onRequestExpand()}>
          <span className="module-node__generation-collapsed-title">视频生成</span>
          {hasCompletedResult ? <div className={`module-node__generation-preview-gallery module-node__generation-preview-gallery--${completedVideoResults.length} module-node__generation-preview-gallery--collapsed`}>
            {completedVideoResults.map((item, index) => (
              <div key={item.assetId} className="module-node__generation-preview-item" aria-label={`Generated video preview ${index + 1}`}>
                  {resolveVideoResultPoster(item)
                    ? <img src={resolveVideoResultPoster(item)} alt={`Generated video preview ${index + 1}`} draggable={false} loading="lazy" decoding="async" />
                  : resolveVideoResultUrl(item)
                    ? <video src={resolveVideoResultUrl(item)} aria-label={`Generated video preview ${index + 1} video`} muted playsInline preload="metadata" />
                    : <Video aria-hidden="true" size={24} strokeWidth={1.5} />}
                <span aria-hidden="true">{index + 1}</span>
                <span className="module-node__generation-preview-play" aria-hidden="true"><Play size={14} fill="currentColor" /></span>
              </div>
            ))}
          </div> : <Video aria-hidden="true" size={34} strokeWidth={1.4} />}
          <span className="module-node__generation-collapsed-play" aria-hidden="true"><Play size={18} fill="currentColor" /></span>
        </button>
        {!expanded && hasConnectedMedia && <ConnectedMediaSlots
          ariaLabel="Connected video media"
          slotRowAriaLabel="Video preview reference slots"
          media={connectedMedia}
          projectImages={projectImages}
          projectVideos={projectVideos}
          title="素材输入"
          showPending
          onReorder={(next) => {
            const edgeIds = next.flatMap((item) => item.edgeId ? [item.edgeId] : []);
            if (edgeIds.length === next.length) void onReorderMedia(edgeIds);
          }}
          pendingKind={sourceVideoAssetId === undefined ? 'image' : 'video'}
        />}
      </section>}
      {expanded && <button type="button" className="module-node__collapse-editor nodrag nopan" aria-label="折叠视频生成节点" onPointerDown={stopCanvasPointer} onClick={() => onRequestCollapse()}>收起</button>}
      {expanded && <ExecutableNodeWorkbench
        label="视频生成"
        status={result}
        resultBeforeConfiguration={hasCompletedResult}
        configuration={<section className="module-node__video-figma-composer nodrag nopan" aria-label="Video generation composer" onPointerDown={stopCanvasPointer}>
          {expanded && hasConnectedMedia && <ConnectedMediaSlots
            ariaLabel="Connected video media editor"
            slotRowAriaLabel="Video editor reference slots"
            media={connectedMedia}
            projectImages={projectImages}
            projectVideos={projectVideos}
            title="素材输入"
            showPending
            pendingKind={sourceVideoAssetId === undefined ? 'image' : 'video'}
          />}
          <section className="module-node__prompt-workspace nodrag nopan" aria-label="Video preview prompt workspace" onPointerDown={stopCanvasPointer}>
            <div className="module-node__video-prompt-header">
              <span>提示词</span>
              <div className="module-node__video-reference-tools" aria-label="Video generation reference tools">
                <button type="button" className="nodrag nopan">特效</button>
                <button type="button" className="nodrag nopan">运镜</button>
                <button type="button" className="nodrag nopan">角色库</button>
              </div>
            </div>
            <MediaMentionTextarea
              className="module-node__prompt-editor"
              aria-label="Video preview prompt"
              rows={5}
              value={prompt}
              mentions={mentionPreviews}
              placeholder="输入视频提示词…"
              onChange={(event) => {
                const nextPrompt = event.target.value;
                setPrompt(nextPrompt);
                void persistVideoPromptDraft(nextPrompt);
                setMentionedReferenceAssetIds((current) => retainMentionedAssetIds(current, nextPrompt, connectedImages));
                setMentionPickerOpen(isImageMentionQueryActive(nextPrompt, connectedImages));
              }}
              onKeyDown={(event) => {
                if (event.key === '@' && connectedImages.length > 0) setMentionPickerOpen(true);
                if (event.key === 'Escape') setMentionPickerOpen(false);
              }}
            />
            {mentionPickerOpen && <PromptImageMentionMenu images={connectedImages} prompt={prompt} onSelect={(asset, position) => {
              const token = imageMentionTokenAt(position);
              const nextPrompt = insertImageMention(prompt, token, connectedImages);
              setPrompt(nextPrompt);
              void persistVideoPromptDraft(nextPrompt);
              setMentionedReferenceAssetIds((current) => mergeAssetIds(current, [asset.assetId]));
              setMentionPickerOpen(false);
            }} />}
          </section>

          <div className="module-node__generation-control-bar module-node__video-control-bar" aria-label="Video preview parameter controls" onPointerDownCapture={clearBrowserSelection}>
            <select className="nodrag nopan" aria-label="Video preview model" value={modelRoute} disabled={compatibleRoutes.length === 0} onPointerDown={stopCanvasPointer} onChange={(event) => setModelRoute(event.target.value)}>
              {compatibleRoutes.length === 0 && <option value="">未配置视频模型</option>}
              {compatibleRoutes.map((route) => <option key={route.modelRoute} value={route.modelRoute}>{modelRouteOptionLabel(route, compatibleRoutes)}</option>)}
            </select>
            <select className="nodrag nopan" aria-label="Video preview mode" value={keyframe} onPointerDown={stopCanvasPointer} onChange={(event) => setKeyframe(event.target.value)}>
              {[
                { value: 'auto', label: '图生视频' },
                { value: 'first', label: '首帧视频' },
                { value: 'first_last', label: '首尾帧视频' },
              ].map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
            </select>
            <AspectRatioPopover
              ariaLabel="Video preview aspect ratio"
              value={aspectRatio === 'Auto' ? 'AUTO' : aspectRatio}
              options={videoAspectRatioOptions.map((value) => value === 'Auto' ? 'AUTO' : value)}
              onChange={(value) => setAspectRatio(value === 'AUTO' ? 'Auto' : value)}
            />
            <ClarityPopover
              ariaLabel="Video preview resolution"
              value={resolution}
              options={[...videoResolutionOptions]}
              onChange={(value) => setResolution(normalizeVideoResolutionSelection(value))}
            />
            <select className="nodrag nopan" aria-label="Video preview duration" value={durationSeconds} onPointerDown={stopCanvasPointer} onChange={(event) => setDurationSeconds(Number(event.target.value))}>
              {videoDurationOptions.map((value) => <option key={value} value={value}>{value === 0 ? '模型默认' : `${value}秒`}</option>)}
            </select>
            <select className="nodrag nopan" aria-label="Video preview audio" value={audioEnabled ? 'on' : 'off'} onPointerDown={stopCanvasPointer} onChange={(event) => setAudioEnabled(event.target.value === 'on')}>
              <option value="on">生成音频：开</option>
              <option value="off">生成音频：关</option>
            </select>
            <select className="nodrag nopan" aria-label="Video preview quantity" title="生成数量，最多 4 个视频" value={outputCount} onPointerDown={stopCanvasPointer} onChange={(event) => setOutputCount(readSupportedImageCount(Number(event.target.value)))}>
              {videoOutputCountOptions.map((value) => <option key={value} value={value}>{value} 个</option>)}
            </select>
            <button
              className={`module-node__run-generation nodrag nopan${activeJobId === undefined ? '' : ' is-cancelling'}`}
              type="button"
              aria-label={activeJobId === undefined ? '生成视频' : '停止生成'}
              disabled={activeJobId === undefined && (prompt.trim().length === 0 || modelRoute.length === 0)}
              onClick={() => {
                if (activeJobId !== undefined) {
                  void onCancel(activeJobId);
                  return;
                }
                setRunError(null);
                void onRun(id, {
                  prompt: prompt.trim(),
                  referenceAssetIds: mergeAssetIds(referenceAssetIds, mentionedReferenceAssetIds),
                  modelRoute,
                  aspectRatio: aspectRatio === 'Auto'
                    ? resolveAutomaticVideoAspectRatio(connectedMedia, projectImages, projectVideos) ?? 'Auto'
                    : aspectRatio,
                  keyframe,
                  durationSeconds,
                  resolution,
                  outputCount,
                  audioEnabled,
                }).then((started) => {
                  if (!started) setRunError('视频生成未启动，请检查模型、API 密钥和输入后重试。');
                }).catch(() => {
                  setRunError('视频生成未启动，请检查模型、API 密钥和输入后重试。');
                });
              }}
            >
              {activeJobId === undefined ? '生成视频' : '停止生成'}
            </button>
          </div>
          {(runError ?? failedVideoJobError) !== null && <p role="alert">{runError ?? failedVideoJobError}</p>}
        </section>}
        result={hasCompletedResult ? <div className="module-node__result-workspace module-node__video-result-workspace" aria-label="Video preview result workspace">
          <div className={`module-node__generation-preview-gallery module-node__generation-preview-gallery--${completedVideoResults.length}`} aria-label="Completed video results">
            {completedVideoResults.map((item, index) => (
              <div key={item.assetId} className="module-node__generation-preview-item module-node__video-result-stage" aria-label={`Completed video result ${index + 1}`} data-aspect-ratio="16:9">
                  {resolveVideoResultPoster(item)
                    ? <img src={resolveVideoResultPoster(item)} alt={`Completed video result ${index + 1}`} draggable={false} loading="lazy" decoding="async" />
                  : resolveVideoResultUrl(item)
                    ? <video src={resolveVideoResultUrl(item)} aria-label={`Completed video result ${index + 1} video`} muted playsInline preload="metadata" />
                    : <Video aria-hidden="true" size={24} strokeWidth={1.5} />}
                <span className="module-node__video-preview-play" role="img" aria-label={`Play completed video ${index + 1}`}><Play size={14} fill="currentColor" /></span>
              </div>
            ))}
          </div>
        </div> : undefined}
      />}
    </section>
  );
}

function ImageGenerationSummary({
  id,
  config,
  projectImages,
  projectVideos,
  connectedMedia,
  hasConnectedReference,
  routes,
  executionState,
  onRun,
  activeJobId,
  onCancel,
  onReorderMedia,
  expanded,
  onRequestExpand,
  onRequestCollapse,
}: {
  id: string;
  config: Record<string, unknown>;
  projectImages: readonly ProjectImageAssetSummary[];
  projectVideos: readonly ProjectVideoAssetSummary[];
  connectedMedia: readonly OrderedMediaSummary[];
  hasConnectedReference: boolean;
  routes: readonly ImageGenerationRouteSummary[];
  executionState: CanvasModuleNodeData['execution']['state'];
  onRun: (nodeId: string, input: { prompt: string; modelRoute?: string; aspectRatio?: string; resolution?: string; outputCount?: number; referenceAssetIds?: readonly string[] }) => Promise<boolean>;
  activeJobId?: string;
  onCancel: (jobId: string) => Promise<void>;
  onReorderMedia: (edgeIds: string[]) => Promise<boolean>;
  expanded: boolean;
  onRequestExpand: () => void;
  onRequestCollapse: () => void;
}) {
  const connectedImages = useMemo(() => connectedMedia
    .filter((item) => item.kind === 'image')
    .map((item) => projectImages.find((asset) => asset.assetId === item.assetId))
    .filter((asset): asset is ProjectImageAssetSummary => asset !== undefined), [connectedMedia, projectImages]);
  const mentionPreviews = useMemo(() => buildMediaMentionPreviews(connectedImages, projectVideos.filter((asset) => connectedMedia.some((item) => item.kind === 'video' && item.assetId === asset.assetId))), [connectedImages, connectedMedia, projectVideos]);
  const [prompt, setPrompt] = useExternallyHydratedDraftState(readNonEmptyString(config.prompt) ?? '');
  const [runError, setRunError] = useState<string | null>(null);
  const [mentionPickerOpen, setMentionPickerOpen] = useState(false);
  const [mentionedReferenceAssetIds, setMentionedReferenceAssetIds] = useState<string[]>([]);
  const connectedReferenceAssetIds = connectedMedia.filter((item) => item.kind === 'image').map((item) => item.assetId);
  // Generated results belong to the formal job store.  Reading them here keeps
  // the four-up Figma preview in sync with real completed jobs, rather than
  // relying on stale presentation metadata saved on the node.
  const modelJobs = useAppStore((state) => state.modelJobs);
  const latestImageJob = selectLatestGenerationJob(modelJobs, id, 'image');
  const agentPanelCollapsed = useAppStore((state) => state.agentPanelCollapsed);
  const toggleAgentPanel = useAppStore((state) => state.toggleAgentPanel);
  const compatibleRoutes = useMemo(
    () => dedupeVisibleModelRoutes(routes.filter((route) => route.capabilities.includes('image_generation'))),
    [routes],
  );
  const [localGenerationStartedAt, setLocalGenerationStartedAt] = useState<string | null>(null);
  const [modelRoute, setModelRoute] = useExternallyHydratedDraftState(
    readNonEmptyString(config.modelRoute) ?? preferredImageGenerationRoute(compatibleRoutes)?.modelRoute ?? '',
  );
  const [aspectRatio, setAspectRatio] = useExternallyHydratedDraftState(readSupportedImageString(config.aspectRatio, IMAGE_ASPECT_RATIO_OPTIONS, '1:1'));
  const [resolution, setResolution] = useExternallyHydratedDraftState(normalizeImageResolutionSelection(config.resolution));
  const [outputCount, setOutputCount] = useExternallyHydratedDraftState(readSupportedImageCount(config.outputCount));
  const draftGenerationNodeConfig = useAppStore((state) => state.draftGenerationNodeConfig);
  const selectedImageRoute = compatibleRoutes.find((route) => route.modelRoute === modelRoute);
  const imageConstraints = selectedImageRoute?.constraints?.image;
  const imageAspectRatioOptions: (typeof IMAGE_ASPECT_RATIO_OPTIONS[number])[] = imageConstraints?.aspectRatios?.length
    ? ['自由比例', ...imageConstraints.aspectRatios.filter((value): value is Exclude<typeof IMAGE_ASPECT_RATIO_OPTIONS[number], '自由比例'> => IMAGE_ASPECT_RATIO_OPTIONS.includes(value as never))]
    : [...IMAGE_ASPECT_RATIO_OPTIONS];
  const constrainedImageResolutions = imageConstraints?.resolutions?.filter((value): value is typeof IMAGE_RESOLUTION_OPTIONS[number] => IMAGE_RESOLUTION_OPTIONS.includes(value as never));
  const imageResolutionOptions: (typeof IMAGE_RESOLUTION_OPTIONS[number])[] = constrainedImageResolutions?.length
    ? constrainedImageResolutions
    : [...IMAGE_RESOLUTION_OPTIONS];
  const effectiveImageResolution = imageResolutionOptions.includes(resolution as never) ? resolution : imageResolutionOptions[0] ?? '2K';
  const imageOutputCountOptions: (1 | 2 | 3 | 4)[] = [...IMAGE_OUTPUT_COUNT_OPTIONS];
  const imageOptionsKey = [imageAspectRatioOptions.join('|'), imageResolutionOptions.join('|'), imageOutputCountOptions.join('|')].join('::');
  useEffect(() => {
    const nextReferenceAssetIds = readStringArray(config.referenceAssetIds);
    setMentionedReferenceAssetIds((current) => stringArraysEqual(current, nextReferenceAssetIds) ? current : nextReferenceAssetIds);
  }, [config.referenceAssetIds]);
  useEffect(() => {
    if (!imageAspectRatioOptions.includes(aspectRatio as never)) setAspectRatio(imageAspectRatioOptions[0] ?? '1:1');
    if (!imageResolutionOptions.includes(resolution)) setResolution('2K');
    if (!imageOutputCountOptions.includes(outputCount)) setOutputCount(imageOutputCountOptions[0] ?? 1);
  }, [modelRoute, imageOptionsKey]);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [previewActionMenu, setPreviewActionMenu] = useState<{ index: number; x: number; y: number } | null>(null);
  useEffect(() => {
    if (compatibleRoutes.length === 0) return;
    setModelRoute((current) => compatibleRoutes.some((route) => route.modelRoute === current)
      ? current
      : preferredImageGenerationRoute(compatibleRoutes)?.modelRoute ?? '');
  }, [compatibleRoutes]);
  useEffect(() => {
    if (activeJobId !== undefined) setLocalGenerationStartedAt(null);
  }, [activeJobId]);
  useEffect(() => {
    const draft = {
      prompt,
      modelRoute,
      aspectRatio,
      resolution: effectiveImageResolution,
      outputCount,
    };
    void persistDraftWithBoundaryRetry(() => draftGenerationNodeConfig(id, draft));
  }, [aspectRatio, draftGenerationNodeConfig, effectiveImageResolution, id, modelRoute, outputCount, prompt]);
  const persistImagePromptDraft = (nextPrompt: string) => persistDraftWithBoundaryRetry(() => draftGenerationNodeConfig(id, {
    prompt: nextPrompt,
    modelRoute,
    aspectRatio,
    resolution: effectiveImageResolution,
    outputCount,
  }));
  const statusLabel = activeJobId !== undefined
    ? '生成中'
    : executionState === 'completed' || config.resultState === 'fresh'
      ? '结果已就绪'
      : compatibleRoutes.length === 0 || prompt.trim().length === 0
        ? '待配置'
        : '等待生成';
  const failedJobError = formatGenerationJobError(selectLatestFailedGenerationJob(modelJobs, id, 'image', modelRoute));
  const generatedPreviewAssets = useMemo(() => selectLatestCompletedGenerationJobs(modelJobs, id, 'image')
    .map((job) => projectImages.find((asset) => asset.assetId === job.resultAssetId))
    .filter((asset): asset is ProjectImageAssetSummary => asset !== undefined && isRenderableManagedImageUrl(asset.displayUrl, asset.assetId)), [id, modelJobs, projectImages]);
  const durablePreviewAssets = useMemo(() => readStringArray(config.resultAssetIds)
    .slice(0, 4)
    .map((assetId) => projectImages.find((asset) => asset.assetId === assetId))
    .filter((asset): asset is ProjectImageAssetSummary => asset !== undefined && isRenderableManagedImageUrl(asset.displayUrl, asset.assetId)), [config.resultAssetIds, projectImages]);
  const previewItems = durablePreviewAssets.length > 0 ? durablePreviewAssets : generatedPreviewAssets;
  const hasCompletedImageResult = executionState === 'completed' || config.resultState === 'fresh' || generatedPreviewAssets.length > 0;
  const imageTimingJob = selectGenerationTimingJob(modelJobs, id, 'image', durablePreviewAssets.length > 0);
  const activePreviewAsset = previewIndex === null ? undefined : previewItems[previewIndex];
  const actionPreviewAsset = previewActionMenu === null ? undefined : previewItems[previewActionMenu.index];
  useEffect(() => {
    if (previewIndex !== null && previewItems[previewIndex] === undefined) setPreviewIndex(null);
  }, [previewIndex, previewItems]);
  useEffect(() => {
    if (previewIndex === null && previewActionMenu === null) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setPreviewIndex(null);
      setPreviewActionMenu(null);
    };
    globalThis.addEventListener('keydown', dismiss);
    return () => globalThis.removeEventListener('keydown', dismiss);
  }, [previewActionMenu, previewIndex]);
  const appendPromptSuggestion = (suggestion: string) => setPrompt((current) => (
    current.trim().length === 0 ? suggestion : `${current.trimEnd()}，${suggestion}`
  ));
  const sendPreviewToAgent = (asset: ProjectImageAssetSummary) => {
    if (agentPanelCollapsed) toggleAgentPanel();
    globalThis.dispatchEvent(new CustomEvent('novus:generated-image-to-agent', { detail: { assetId: asset.assetId } }));
  };
  return (
    <section className={`module-node__summary module-node__summary--compact module-node__summary--generation ${hasConnectedReference ? 'is-reference-connected' : 'is-reference-empty'}`} data-editor-expanded={expanded ? 'true' : 'false'} aria-label="生成摘要 / Generation summary">
      <TaskTimingBadge
        ariaLabel="Image generation task timing"
        job={imageTimingJob}
        status={localGenerationStartedAt === null ? undefined : 'queued'}
        startedAt={localGenerationStartedAt ?? undefined}
      />
      {!expanded && <section className="module-node__generation-collapsed-shell nodrag nopan" aria-label="Image generation preview">
        <button type="button" className="module-node__generation-collapsed-preview module-node__generation-collapsed-open nodrag nopan" aria-label="Open image generation editor" aria-expanded={expanded} title="点击展开" onPointerDown={stopCanvasPointer} onClick={() => onRequestExpand()} onContextMenu={(event) => {
          if (!hasCompletedImageResult || previewItems[0] === undefined) return;
          event.preventDefault();
          event.stopPropagation();
          setPreviewIndex(null);
          setPreviewActionMenu({ index: 0, x: event.clientX, y: event.clientY });
        }} onDoubleClick={(event) => {
          if (!hasCompletedImageResult || previewItems[0] === undefined) return;
          event.preventDefault();
          event.stopPropagation();
          setPreviewActionMenu(null);
          setPreviewIndex(0);
        }}>
          <span className="module-node__generation-collapsed-title">图片生成 V2</span>
          {hasCompletedImageResult && previewItems.length > 0 ? <div className={`module-node__generation-preview-gallery module-node__generation-preview-gallery--${Math.min(previewItems.length, 4)} module-node__generation-preview-gallery--collapsed`}>
            {previewItems.slice(0, 4).map((asset, index) => (
              <div key={asset.assetId} className="module-node__generation-preview-item" aria-label={`Generated image preview ${index + 1}`}>
                  <img src={asset.displayUrl} alt={`Generated image preview ${index + 1}`} draggable={false} loading="lazy" decoding="async" />
                <span aria-hidden="true">{index + 1}</span>
              </div>
            ))}
          </div> : <ImageIcon aria-hidden="true" size={34} strokeWidth={1.4} />}        </button>
        {!expanded && hasConnectedReference && <ConnectedMediaSlots
          ariaLabel="Image generation reference slots"
          media={connectedMedia}
          projectImages={projectImages}
          projectVideos={projectVideos}
          title="素材输入"
          showPending
          onReorder={(next) => {
            const edgeIds = next.flatMap((item) => item.edgeId ? [item.edgeId] : []);
            if (edgeIds.length === next.length) void onReorderMedia(edgeIds);
          }}
        />}
      </section>}
      {expanded && <button type="button" className="module-node__collapse-editor nodrag nopan" aria-label="折叠图片生成节点" onPointerDown={stopCanvasPointer} onClick={() => onRequestCollapse()}>收起</button>}
      {expanded && <ExecutableNodeWorkbench
        label="图片生成"
        status={statusLabel}
        configuration={<>
          {hasCompletedImageResult && previewItems.length > 0 && <section className="module-node__generation-editor-preview nodrag nopan" aria-label="Image generation preview" onPointerDown={stopCanvasPointer}>
            <div className={`module-node__generation-preview-gallery module-node__generation-preview-gallery--${Math.min(previewItems.length, 4)}`}>
              {previewItems.slice(0, 4).map((asset, index) => <button
                key={asset.assetId}
                className="module-node__generation-preview-item"
                type="button"
                aria-label={`Generated image ${index + 1}; double click to preview`}
                onPointerDown={stopCanvasPointer}
                onDoubleClick={() => { setPreviewActionMenu(null); setPreviewIndex(index); }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setPreviewIndex(null);
                  setPreviewActionMenu({ index, x: event.clientX, y: event.clientY });
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setPreviewActionMenu(null);
                    setPreviewIndex(index);
                  }
                  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                    event.preventDefault();
                    setPreviewIndex(null);
                    setPreviewActionMenu({ index, x: 0, y: 0 });
                  }
                }}
              >
                  <img src={asset.displayUrl} alt={`Generated image ${index + 1}`} draggable={false} loading="lazy" decoding="async" />
                <span aria-hidden="true">{index + 1}</span>
              </button>)}
            </div>
          </section>}          {hasConnectedReference && (
            <ConnectedMediaSlots
              ariaLabel="Image generation reference slots"
              media={connectedMedia}
              projectImages={projectImages}
              projectVideos={projectVideos}
              title="素材输入"
              showPending
              onReorder={(next) => {
                const edgeIds = next.flatMap((item) => item.edgeId ? [item.edgeId] : []);
                if (edgeIds.length === next.length) void onReorderMedia(edgeIds);
              }}
            />
          )}
          <section className="module-node__prompt-workspace nodrag nopan" aria-label="Image generation prompt workspace" onPointerDown={stopCanvasPointer}>
            <span>提示词</span>
            <MediaMentionTextarea
              className="module-node__prompt-editor"
              aria-label="Image generation prompt"
              rows={5}
              value={prompt}
              mentions={mentionPreviews}
              placeholder="输入提示词…"
              onChange={(event) => {
                const nextPrompt = event.target.value;
                setPrompt(nextPrompt);
                void persistImagePromptDraft(nextPrompt);
                 setMentionedReferenceAssetIds((current) => retainMentionedAssetIds(current, nextPrompt, connectedImages));
                setMentionPickerOpen(isImageMentionQueryActive(nextPrompt, connectedImages));
              }}
              onKeyDown={(event) => {
                if (event.key === '@' && connectedImages.length > 0) setMentionPickerOpen(true);
                if (event.key === 'Escape') setMentionPickerOpen(false);
              }}
            />
            {mentionPickerOpen && (
              <PromptImageMentionMenu
                images={connectedImages}
                prompt={prompt}
                onSelect={(asset, position) => {
                  const token = imageMentionTokenAt(position);
                  const nextPrompt = insertImageMention(prompt, token, connectedImages);
                  setPrompt(nextPrompt);
                  void persistImagePromptDraft(nextPrompt);
                  setMentionedReferenceAssetIds((current) => mergeAssetIds(current, [asset.assetId]));
                  setMentionPickerOpen(false);
                }}
              />
            )}
            <div className="module-node__prompt-suggestions" aria-label="Image prompt suggestions">
              {['产品角度固定', '多机位广告格', '剧情推进四宫格', '角色脸部三视图'].map((suggestion) => <button key={suggestion} type="button" onClick={() => appendPromptSuggestion(suggestion)}>{suggestion}</button>)}
            </div>
          </section>
          <div className="module-node__generation-control-bar nodrag nopan" aria-label="Image generation control bar" onPointerDown={stopCanvasPointer} onPointerDownCapture={clearBrowserSelection}>
            <select aria-label="Image generation model route" value={modelRoute} disabled={compatibleRoutes.length === 0} onChange={(event) => setModelRoute(event.target.value)}>
              {compatibleRoutes.length === 0 && <option value="">未配置模型</option>}
              {compatibleRoutes.map((route) => <option key={route.modelRoute} value={route.modelRoute}>{modelRouteOptionLabel(route, compatibleRoutes)}</option>)}
            </select>
            <AspectRatioPopover
              ariaLabel="Image generation aspect ratio"
              value={aspectRatio === '自由比例' ? 'AUTO' : aspectRatio}
              options={imageAspectRatioOptions.map((value) => value === '自由比例' ? 'AUTO' : value)}
              onChange={(value) => setAspectRatio(value === 'AUTO' ? '自由比例' : readSupportedImageString(value, IMAGE_ASPECT_RATIO_OPTIONS, aspectRatio))}
            />
            <ClarityPopover
              ariaLabel="Image generation resolution"
              value={effectiveImageResolution}
              options={imageResolutionOptions}
              onChange={(value) => setResolution(normalizeImageResolutionSelection(value))}
            />
            <select aria-label="Image generation quantity" value={outputCount} onChange={(event) => setOutputCount(readSupportedImageCount(Number(event.target.value)))}>
              {imageOutputCountOptions.map((value) => <option key={value} value={value}>{value} 张</option>)}
            </select>
            <button
              className={`module-node__run-generation${activeJobId === undefined ? '' : ' is-cancelling'}`}
              type="button"
              aria-label={activeJobId === undefined ? 'Generate image' : '停止生成'}
              disabled={activeJobId === undefined && (prompt.trim().length === 0 || modelRoute.length === 0)}
              onClick={() => {
                if (activeJobId !== undefined) {
                  void onCancel(activeJobId);
                  return;
                }
                setRunError(null);
                setLocalGenerationStartedAt(new Date().toISOString());
                const referenceAssetIds = mergeAssetIds(connectedReferenceAssetIds, mentionedReferenceAssetIds);
                const requestedAspectRatio = aspectRatio === '自由比例' ? resolveAutomaticImageAspectRatio(connectedMedia, projectImages) : aspectRatio;
                void onRun(id, { prompt: prompt.trim(), ...(modelRoute ? { modelRoute } : {}), ...(requestedAspectRatio ? { aspectRatio: requestedAspectRatio } : {}), resolution: effectiveImageResolution, outputCount, ...(referenceAssetIds.length > 0 ? { referenceAssetIds } : {}) }).then((started) => {
                  if (!started) {
                    setLocalGenerationStartedAt(null);
                    setRunError('生成未启动，请检查模型、API 密钥和输入后重试。');
                  }
                }).catch((error) => {
                  setLocalGenerationStartedAt(null);
                  setRunError(formatGenerationStartError(error, 'image'));
                });
              }}
            >
              {activeJobId === undefined ? '生成' : '停止生成'}
            </button>
          </div>
          {(runError ?? failedJobError) !== null && (
            <p className="module-node__generation-error" role="alert">
              {runError ?? failedJobError}
            </p>
          )}
          <details className="module-node__advanced nodrag nopan">
            <summary>高级参数</summary>
            <span>蒙版、姿态与参考顺序在完整工作台中配置</span>
          </details>
        </>}
        result={undefined}
        actions={undefined}
      />}
      {activePreviewAsset !== undefined && (
        <GeneratedImageLightbox
          asset={activePreviewAsset}
          index={previewIndex ?? 0}
          total={previewItems.length}
          onClose={() => setPreviewIndex(null)}
          onPrevious={() => setPreviewIndex((current) => current === null ? null : (current + previewItems.length - 1) % previewItems.length)}
          onNext={() => setPreviewIndex((current) => current === null ? null : (current + 1) % previewItems.length)}
        />
      )}
      {previewActionMenu !== null && actionPreviewAsset !== undefined && (
        <GeneratedImageActionMenu
          asset={actionPreviewAsset}
          left={previewActionMenu.x}
          top={previewActionMenu.y}
          onSendToAgent={sendPreviewToAgent}
          onClose={() => setPreviewActionMenu(null)}
        />
      )}
    </section>
  );
}

function GeneratedImageLightbox({
  asset,
  index,
  total,
  onClose,
  onPrevious,
  onNext,
}: {
  asset: ProjectImageAssetSummary;
  index: number;
  total: number;
  onClose: () => void;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const dialog = (
    <div className="generated-image-lightbox" role="presentation" onPointerDown={onClose}>
      <section
        className="generated-image-lightbox__dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Generated image preview"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="generated-image-lightbox__header">
          <div><strong>生成图片预览</strong><span>双击图片打开 · 原图比例显示</span></div>
          <button type="button" aria-label="Close generated image preview" onClick={onClose}><X aria-hidden="true" size={18} /></button>
        </header>
        <div className="generated-image-lightbox__stage">
          <img src={asset.displayUrl} alt={`Generated image ${index + 1} full preview`} draggable={false} />
        </div>
        <footer className="generated-image-lightbox__footer">
          <button type="button" aria-label="Previous generated image" disabled={total < 2} onClick={onPrevious}><ChevronLeft aria-hidden="true" size={20} /></button>
          <span>{index + 1} / {total}</span>
          <button type="button" aria-label="Next generated image" disabled={total < 2} onClick={onNext}><ChevronRight aria-hidden="true" size={20} /></button>
        </footer>
      </section>
    </div>
  );
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}

function GeneratedImageActionMenu({
  asset,
  left,
  top,
  onSendToAgent,
  onClose,
}: {
  asset: ProjectImageAssetSummary;
  left: number;
  top: number;
  onSendToAgent: (asset: ProjectImageAssetSummary) => void;
  onClose: () => void;
}) {
  const [photoshopBusy, setPhotoshopBusy] = useState(false);
  const [photoshopResult, setPhotoshopResult] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
  const photoshopAvailability = getPhotoshopImportAvailability(asset, getActiveProjectSessionId());
  const copyImage = async () => {
    try {
      try {
        const response = await fetch(asset.displayUrl);
        const blob = await response.blob();
        if (typeof ClipboardItem !== 'undefined' && globalThis.navigator?.clipboard?.write && blob.type.length > 0) {
          await globalThis.navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
          return;
        }
      } catch {
        // Fall through to a URL copy so copying still works when image
        // clipboard permissions or managed-asset fetches are unavailable.
      }
      await copyTextWithFallback(asset.displayUrl);
    } finally {
      onClose();
    }
  };
  const downloadImage = () => {
    const link = document.createElement('a');
    link.href = asset.displayUrl;
    link.download = `${asset.label || 'generated-image'}.png`;
    link.click();
    onClose();
  };
  const importToPhotoshop = async () => {
    if (photoshopBusy || !photoshopAvailability.available) return;
    setPhotoshopBusy(true);
    setPhotoshopResult(null);
    const result = await importGeneratedImageToPhotoshop(asset, getActiveProjectSessionId());
    setPhotoshopBusy(false);
    setPhotoshopResult({
      kind: result.ok ? 'success' : 'error',
      message: photoshopImportMessage(result),
    });
  };
  const menu = (
    <div className="generated-image-action-menu" role="menu" aria-label="Generated image actions" style={{ left, top }} onPointerDown={(event) => event.stopPropagation()}>
      <strong>图片操作</strong>
      <button type="button" role="menuitem" className="is-featured" onClick={() => { onSendToAgent(asset); onClose(); }}><Send aria-hidden="true" size={17} />发送到 AI 对话</button>
      <button type="button" role="menuitem" disabled title="画布图片输入桥接尚未配置">发送到画布</button>
      <button
        type="button"
        role="menuitem"
        disabled={photoshopBusy || !photoshopAvailability.available}
        title={photoshopAvailability.available ? undefined : photoshopImportMessage({ ok: false, code: photoshopAvailability.code ?? 'desktop_bridge_unavailable' })}
        onClick={() => { void importToPhotoshop(); }}
      >
        <ImageIcon aria-hidden="true" size={17} />
        {photoshopBusy ? '正在导入…' : '导入 Photoshop（智能对象）'}
      </button>
      <button type="button" role="menuitem" onClick={() => { void copyImage(); }}><Copy aria-hidden="true" size={17} />复制图片</button>
      <button type="button" role="menuitem" onClick={downloadImage}><Download aria-hidden="true" size={17} />下载图片</button>
      {photoshopResult !== null && (
        <p className={`generated-image-action-menu__notice is-${photoshopResult.kind}`} role={photoshopResult.kind === 'success' ? 'status' : 'alert'}>
          {photoshopResult.message}
        </p>
      )}
    </div>
  );
  return typeof document === 'undefined' ? menu : createPortal(menu, document.body);
}

function PromptImageMentionMenu({
  images,
  prompt,
  onSelect,
}: {
  images: readonly ProjectImageAssetSummary[];
  prompt: string;
  onSelect: (asset: ProjectImageAssetSummary, position: number) => void;
}) {
  const query = readImageMentionQuery(prompt, images);
  const filteredCandidates = images
    .map((asset, position) => ({ asset, position }))
    .filter(({ asset, position }) => query.length === 0
      || asset.label.toLocaleLowerCase().includes(query.toLocaleLowerCase())
      || imageMentionTokenAt(position).slice(1).includes(query))
    .slice(0, MAX_GENERATION_REFERENCES);
  // An @ typed in the middle of an existing Chinese sentence is not a search
  // query. Keep the picker usable even when the following prose does not match
  // an asset label; users can select the intended connected image directly.
  const candidates = filteredCandidates.length > 0 || query.length === 0
    ? filteredCandidates
    : images.slice(0, MAX_GENERATION_REFERENCES).map((asset, position) => ({ asset, position }));

  if (candidates.length === 0) return null;

  return <div className="module-node__image-mention-picker nowheel" role="menu" aria-label="Select reference image" onWheel={(event) => event.stopPropagation()}>
    {candidates.map(({ asset, position }) => <button key={asset.assetId} type="button" role="menuitem" aria-label={asset.label} onPointerDown={stopCanvasPointer} onClick={() => onSelect(asset, position)}>
        {isRenderableManagedImageUrl(asset.displayUrl, asset.assetId) && <img src={asset.displayUrl} alt={asset.label} loading="lazy" decoding="async" />}
      <span>{asset.label}</span><small>{imageMentionTokenAt(position)}</small>
    </button>)}
  </div>;
}

// Mentions may be typed anywhere in a sentence. Stop at whitespace or Chinese
// punctuation so `前文@，后文` is still an active empty-query mention.
const IMAGE_MENTION_CANDIDATE_PATTERN = /@[^\s@，。！？；：、（）【】《》“”‘’「」『』]*/gu;

function imageMentionCandidates(prompt: string): RegExpMatchArray[] {
  return Array.from(prompt.matchAll(IMAGE_MENTION_CANDIDATE_PATTERN));
}

function isImageMentionQueryActive(
  prompt: string,
  images: readonly ProjectImageAssetSummary[] = [],
): boolean {
  const canonicalTokens = new Set(images.map((_, position) => imageMentionTokenAt(position)));
  return imageMentionCandidates(prompt).some((match) => !canonicalTokens.has(match[0]));
}

function lastUnresolvedImageMentionCandidate(
  prompt: string,
  images: readonly ProjectImageAssetSummary[],
): RegExpMatchArray | undefined {
  const canonicalTokens = new Set(images.map((_, position) => imageMentionTokenAt(position)));
  const candidates = imageMentionCandidates(prompt).filter((match) => !canonicalTokens.has(match[0]));
  return candidates[candidates.length - 1];
}

function readImageMentionQuery(prompt: string, images: readonly ProjectImageAssetSummary[]): string {
  return lastUnresolvedImageMentionCandidate(prompt, images)?.[0].slice(1) ?? '';
}

function insertImageMention(
  prompt: string,
  mention: string,
  images: readonly ProjectImageAssetSummary[] = [],
): string {
  const token = mention.startsWith('@') ? mention : `@${mention}`;
  const match = lastUnresolvedImageMentionCandidate(prompt, images);
  if (!match || typeof match.index !== 'number') {
    const trimmed = prompt.trimEnd();
    return `${trimmed}${trimmed.length > 0 ? ' ' : ''}${token}`;
  }
  return `${prompt.slice(0, match.index)}${token}${prompt.slice(match.index + match[0].length)}`;
}

function imageMentionToken(images: readonly ProjectImageAssetSummary[], assetId: string): string {
  const index = images.findIndex((image) => image.assetId === assetId);
  return index < 0 ? '' : imageMentionTokenAt(index);
}

function imageMentionTokenAt(position: number): string {
  return `@图片${position + 1}`;
}

function buildMediaMentionPreviews(
  images: readonly ProjectImageAssetSummary[],
  videos: readonly ProjectVideoAssetSummary[],
): MediaMentionPreview[] {
  return [
    ...images.slice(0, MAX_GENERATION_REFERENCES).map((asset, position) => ({
      token: imageMentionTokenAt(position),
      label: asset.label,
      displayUrl: asset.displayUrl,
      kind: 'image' as const,
    })),
    ...videos.slice(0, MAX_GENERATION_REFERENCES).map((asset, position) => ({
      token: `@视频${position + 1}`,
      label: asset.label,
      displayUrl: asset.displayUrl,
      kind: 'video' as const,
    })),
  ];
}

function promptContainsImageMention(prompt: string, token: string): boolean {
  if (!token) return false;
  const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escapedToken}(?=$|\\s|[.,!?;:，。！？；：])`, 'u').test(prompt);
}

function mergeAssetIds(first: readonly string[], second: readonly string[]): string[] {
  return [...new Set([...first, ...second])].slice(0, MAX_GENERATION_REFERENCES);
}
function ReferenceSlotStrip({ label, assetIds, assets, onChange, inline = false, readOnly = false }: {
  label: string;
  assetIds: readonly string[];
  assets: readonly ProjectImageAssetSummary[];
  onChange: (assetIds: string[]) => void;
  inline?: boolean;
  readOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const selected = new Set(assetIds);
  const showSlotRow = readOnly || !inline || assetIds.length > 0;
  const add = (assetId: string) => {
    if (selected.has(assetId) || assetIds.length >= MAX_GENERATION_REFERENCES) return;
    onChange([...assetIds, assetId]); setOpen(false);
  };
  if (readOnly) {
    return <section className={`module-node__reference-slots${inline ? ' module-node__reference-slots--inline' : ''} nodrag nopan`} aria-label={label} onPointerDown={stopCanvasPointer}>
      <header><span>参考图片</span><b>{assetIds.length} / {MAX_GENERATION_REFERENCES}</b></header>
      <div className="module-node__reference-slot-row">
        {assetIds.map((assetId, index) => {
          const asset = assets.find((item) => item.assetId === assetId);
          return <span key={assetId} className="module-node__reference-thumb is-occupied" aria-label={`Reference slot ${index + 1}`}>
              {asset && isRenderableManagedImageUrl(asset.displayUrl, asset.assetId) ? <img src={asset.displayUrl} alt="" loading="lazy" decoding="async" /> : <ImageIcon size={16} />}
          </span>;
        })}
      </div>
      <p className="module-node__reference-slot-note">连接图片后显示缩略图，最多 {MAX_GENERATION_REFERENCES} 张。</p>
    </section>;
  }
  return <section className={`module-node__reference-slots${inline ? ' module-node__reference-slots--inline' : ''} nodrag nopan`} aria-label={label} onPointerDown={stopCanvasPointer}>
    <header><span>参考素材 / Reference</span><b>{assetIds.length} / {MAX_GENERATION_REFERENCES}</b></header>
    {showSlotRow && <div className="module-node__reference-slot-row">
      {assetIds.map((assetId, index) => {
        const asset = assets.find((item) => item.assetId === assetId);
        return <button
          key={assetId}
          type="button"
          className="module-node__reference-thumb is-occupied"
          aria-label={`Reference slot ${index + 1}`}
          draggable
          title={`移除 ${asset?.label ?? '参考图'}`}
          onDragStart={() => setDraggedIndex(index)}
          onDragOver={(event) => event.preventDefault()}
          onDragEnd={() => setDraggedIndex(null)}
          onDrop={() => {
            if (draggedIndex === null || draggedIndex === index) return;
            const next = [...assetIds];
            const draggedAssetId = next[draggedIndex];
            const targetAssetId = next[index];
            if (draggedAssetId === undefined || targetAssetId === undefined) return;
            next[draggedIndex] = targetAssetId;
            next[index] = draggedAssetId;
            onChange(next);
            setDraggedIndex(null);
          }}
          onClick={() => onChange(assetIds.filter((id) => id !== assetId))}
        >
            {asset && isRenderableManagedImageUrl(asset.displayUrl, asset.assetId) ? <img src={asset.displayUrl} alt="" loading="lazy" decoding="async" /> : <ImageIcon size={16} />}
        </button>;
      })}
      {!readOnly && (!inline || assetIds.length > 0) && Array.from({ length: Math.max(0, Math.min(4, MAX_GENERATION_REFERENCES) - assetIds.length) }, (_, index) => (
        <button
          key={`empty-reference-${index}`}
          type="button"
          className="module-node__reference-thumb module-node__reference-thumb--empty"
          aria-label={`Reference slot ${assetIds.length + index + 1} empty`}
          disabled={assets.length === 0}
          onClick={() => setOpen(true)}
        >
          <ImageIcon size={16} />
        </button>
      ))}
    </div>}
    <button type="button" className="module-node__reference-add" aria-label="Add image reference" disabled={assetIds.length >= MAX_GENERATION_REFERENCES} onClick={() => setOpen((value) => !value)}>{inline ? '@ 引用图片' : '添加图片'}</button>
    {open && <div className="module-node__reference-picker" role="menu" aria-label="Project managed images">
      {assets.filter((asset) => !selected.has(asset.assetId)).map((asset) => <button key={asset.assetId} type="button" role="menuitem" onClick={() => add(asset.assetId)}>{asset.label}</button>)}
      {assets.length === 0 && <p>暂无可引用的项目图片</p>}
    </div>}
  </section>;
}

function ConnectedVideoMediaSlots({
  ariaLabel = 'Connected video media',
  assetIds,
  assets,
  sourceVideoAssetId,
  hasConnectedMedia,
}: {
  ariaLabel?: string;
  assetIds: readonly string[];
  assets: readonly ProjectImageAssetSummary[];
  sourceVideoAssetId: string | undefined;
  hasConnectedMedia: boolean;
}) {
  if (!hasConnectedMedia) return null;
  const orderedMedia = [
    ...assetIds.slice(0, MAX_GENERATION_REFERENCES).map((assetId) => ({ kind: 'image' as const, assetId })),
    ...(sourceVideoAssetId === undefined || assetIds.length >= MAX_GENERATION_REFERENCES
      ? []
      : [{ kind: 'video' as const, assetId: sourceVideoAssetId }]),
  ];
  return <section className="module-node__agent-media-slots module-node__unified-media-slots nodrag nopan" aria-label={ariaLabel} onPointerDown={stopCanvasPointer}>
    <header><span>已连接素材 · 图片或视频 · 拖拽调整顺序</span><b>{orderedMedia.length} / {MAX_GENERATION_REFERENCES}</b></header>
    <div className="module-node__agent-media-slot-row" aria-label="Video preview reference slots">
      {orderedMedia.length > 0
        ? orderedMedia.map((item, index) => {
          const assetId = item.assetId;
          const asset = assets.find((candidate) => candidate.assetId === assetId);
          return <span key={assetId} className={`module-node__agent-media-slot is-${item.kind}`} aria-label={`Video preview reference slot ${index + 1}`}>
            {item.kind === 'video'
              ? <Video size={16} aria-hidden="true" />
                : asset && isRenderableManagedImageUrl(asset.displayUrl, asset.assetId) ? <img src={asset.displayUrl} alt="" loading="lazy" decoding="async" /> : <ImageIcon size={16} aria-hidden="true" />}
            <small>{index + 1}</small>
          </span>;
        })
        : <span className="module-node__agent-media-slot" aria-label="Video preview reference slot pending">
          {sourceVideoAssetId !== undefined ? <Video size={16} aria-hidden="true" /> : <ImageIcon size={16} aria-hidden="true" />}
          <small>1</small>
        </span>}
      <span className="module-node__connected-video-media-add" aria-hidden="true">+</span>
    </div>
  </section>;
}

function OutputSpecificationGroup<T extends string | number>({
  label,
  values,
  selected,
  onSelect,
  ariaLabel,
}: {
  label: string;
  values: readonly T[];
  selected: T;
  onSelect: (value: T) => void;
  ariaLabel: (value: T) => string;
}) {
  return <section className="module-node__output-specification-group" aria-label={label}>
    <span>{label}</span>
    <div>{values.map((value) => <button key={String(value)} type="button" aria-label={ariaLabel(value)} aria-pressed={value === selected} className={value === selected ? 'is-selected' : undefined} onClick={() => onSelect(value)}>{typeof value === 'number' ? `${value} 张` : value}</button>)}</div>
  </section>;
}

function readSupportedImageString<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  const candidate = readNonEmptyString(value);
  return candidate !== null && (options as readonly string[]).includes(candidate) ? candidate as T : fallback;
}

function readSupportedImageCount(value: unknown): typeof IMAGE_OUTPUT_COUNT_OPTIONS[number] {
  const candidate = readPositiveInteger(value);
  return candidate !== null && (IMAGE_OUTPUT_COUNT_OPTIONS as readonly number[]).includes(candidate)
    ? candidate as typeof IMAGE_OUTPUT_COUNT_OPTIONS[number]
    : 1;
}

function ExecutableNodeWorkbench({
  label,
  status,
  configuration,
  result,
  actions,
  resultBeforeConfiguration = false,
}: {
  label: string;
  status: string;
  configuration: ReactNode;
  result?: ReactNode;
  actions?: ReactNode;
  resultBeforeConfiguration?: boolean;
}) {
  return (
    <div className="module-node__workbench">
      <header className="module-node__workbench-header" aria-label={`${label} 节点状态`}>
        <span>{label}</span>
        <b>{status}</b>
      </header>
      {resultBeforeConfiguration && result !== undefined && <section className="module-node__result" aria-label={`${label} 节点结果`}>
        {result}
      </section>}
      <section className="module-node__configuration" aria-label={`${label} 节点配置`}>
        {configuration}
      </section>
      {!resultBeforeConfiguration && result !== undefined && <section className="module-node__result" aria-label={`${label} 节点结果`}>
        {result}
      </section>}
      {actions && <footer className="module-node__workbench-actions">{actions}</footer>}
    </div>
  );
}

function ReverseAgentSummary({
  id,
  config,
  projectImages,
  projectVideos,
  connectedMedia,
  knowledgeBases,
  routes,
  executionState,
  onRun,
  onReorderMedia,
  onOpenSettings,
}: {
  id: string;
  config: Record<string, unknown>;
  projectImages: readonly ProjectImageAssetSummary[];
  projectVideos: readonly ProjectVideoAssetSummary[];
  connectedMedia: readonly OrderedMediaSummary[];
  knowledgeBases: readonly { knowledgeBaseId: string; displayName: string | null; activeVersion: number | null; activeContentHash: string | null; status: string }[];
  routes: readonly ReverseAgentRouteSummary[];
  executionState: CanvasModuleNodeData['execution']['state'];
  onRun: (nodeId: string, config?: ReverseAgentNodeConfig) => Promise<{ positivePrompt: string }>;
  onReorderMedia: (edgeIds: string[]) => Promise<boolean>;
  onOpenSettings?: () => void;
}) {
  const connectedImages = useMemo(() => connectedMedia
    .filter((item) => item.kind === 'image')
    .map((item) => projectImages.find((asset) => asset.assetId === item.assetId))
    .filter((asset): asset is ProjectImageAssetSummary => asset !== undefined), [connectedMedia, projectImages]);
  const mentionPreviews = useMemo(() => buildMediaMentionPreviews(connectedImages, projectVideos.filter((asset) => connectedMedia.some((item) => item.kind === 'video' && item.assetId === asset.assetId))), [connectedImages, connectedMedia, projectVideos]);
  const [modelRoute, setModelRoute] = useState(readNonEmptyString(config.modelRoute) ?? '');
  const initialRole = readNonEmptyString(config.role) ?? '';
  const initialTask = readNonEmptyString(config.task) ?? '';
  const [role, setRole] = useState(initialRole);
  const [task, setTask] = useState(initialTask);
  const reverseTextEdited = useRef(false);
  const setRoleDraft: typeof setRole = (nextRole) => {
    reverseTextEdited.current = true;
    setRole(nextRole);
  };
  const setTaskDraft: typeof setTask = (nextTask) => {
    reverseTextEdited.current = true;
    setTask(nextTask);
  };
  const previousExternalText = useRef({ role: initialRole, task: initialTask });
  const [selectedIds, setSelectedIds] = useState(readStringArray(config.knowledgeBaseIds));
  const [mentionedReferenceAssetIds, setMentionedReferenceAssetIds] = useState(readStringArray(config.referenceAssetIds));
  const readyBases = useMemo(() => mergeReverseKnowledgeBases(knowledgeBases), [knowledgeBases]);
  const selected = useMemo(() => selectedIds.filter((id) => readyBases.some((base) => base.knowledgeBaseId === id)), [readyBases, selectedIds]);
  const compatibleRoutes = dedupeVisibleModelRoutes(routes.filter(isReverseAgentRoute));
  useEffect(() => {
    const nextModelRoute = readNonEmptyString(config.modelRoute) ?? '';
    setModelRoute((current) => current === nextModelRoute ? current : nextModelRoute);
  }, [config.modelRoute]);
  useEffect(() => {
    const nextKnowledgeBaseIds = readStringArray(config.knowledgeBaseIds);
    const nextReferenceAssetIds = readStringArray(config.referenceAssetIds);
    setSelectedIds((current) => stringArraysEqual(current, nextKnowledgeBaseIds) ? current : nextKnowledgeBaseIds);
    setMentionedReferenceAssetIds((current) => stringArraysEqual(current, nextReferenceAssetIds) ? current : nextReferenceAssetIds);
  }, [config.knowledgeBaseIds, config.referenceAssetIds]);
  useEffect(() => {
    const nextRole = readNonEmptyString(config.role) ?? '';
    const nextTask = readNonEmptyString(config.task) ?? '';
    const previousText = previousExternalText.current;
    if (!reverseTextEdited.current) {
      setRole((currentRole) => currentRole === previousText.role ? nextRole : currentRole);
      setTask((currentTask) => currentTask === previousText.task ? nextTask : currentTask);
    }
    previousExternalText.current = { role: nextRole, task: nextTask };
  }, [config.role, config.task]);
  useEffect(() => {
    if (compatibleRoutes.length === 0) return;
    setModelRoute((current) => compatibleRoutes.some((route) => route.modelRoute === current)
      ? current
      : preferredReverseAgentRoute(compatibleRoutes)?.modelRoute ?? '');
  }, [compatibleRoutes]);
  const routeAvailable = compatibleRoutes.some((route) => route.modelRoute === modelRoute);
  const ready = routeAvailable && role.trim().length > 0 && task.trim().length > 0;
  const draftReverseAgentConfig = useAppStore((state) => state.draftReverseAgentConfig);
  const draftConfig = useMemo<ReverseAgentNodeConfig>(() => ({
    modelRoute,
    role,
    task,
    knowledgeBaseIds: selected,
    referenceAssetIds: mentionedReferenceAssetIds,
  }), [mentionedReferenceAssetIds, modelRoute, role, selected, task]);
  const latestReverseDraftRef = useRef(draftConfig);
  latestReverseDraftRef.current = draftConfig;
  const reverseDraftWriteTailRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const lastQueuedReverseDraftKeyRef = useRef<string | null>(null);
  const persistReverseDraft = (nextConfig: ReverseAgentNodeConfig) => {
    latestReverseDraftRef.current = nextConfig;
    const draftKey = JSON.stringify(nextConfig);
    if (lastQueuedReverseDraftKeyRef.current === draftKey) return reverseDraftWriteTailRef.current;
    lastQueuedReverseDraftKeyRef.current = draftKey;
    const queuedWrite = reverseDraftWriteTailRef.current
      .catch(() => false)
      .then(() => persistDraftWithBoundaryRetry(() => draftReverseAgentConfig(id, nextConfig)))
      .then((saved) => {
        if (!saved && lastQueuedReverseDraftKeyRef.current === draftKey) lastQueuedReverseDraftKeyRef.current = null;
        return saved;
      });
    reverseDraftWriteTailRef.current = queuedWrite;
    return queuedWrite;
  };
  useEffect(() => {
    if (compatibleRoutes.length > 0 && !routeAvailable) return;
    void persistReverseDraft(draftConfig);
  }, [compatibleRoutes.length, draftConfig, draftReverseAgentConfig, id, routeAvailable]);
  const [isApplying, setIsApplying] = useState(false);
  const [isRunningLocally, setIsRunningLocally] = useState(false);
  const [mentionPickerOpen, setMentionPickerOpen] = useState(false);
  const [knowledgePickerOpen, setKnowledgePickerOpen] = useState(false);
  const [knowledgeQuery, setKnowledgeQuery] = useState('');
  const [knowledgeCategory, setKnowledgeCategory] = useState<'common' | 'favorite' | 'mine'>('common');
  const filteredReadyBases = useMemo(() => {
    const query = knowledgeQuery.trim().toLocaleLowerCase();
    if (!query) return readyBases;
    return readyBases.filter((base) => `${base.displayName ?? base.knowledgeBaseId} ${'description' in base ? base.description : ''}`.toLocaleLowerCase().includes(query));
  }, [knowledgeQuery, readyBases]);
  const [result, setResult] = useState<ReverseResultView | null>(() => readReverseAgentResult(config.reverseAgentResult));
  const selectableResultSections = useMemo(() => {
    const parsed = reversePromptResultSchema.safeParse(result);
    return parsed.success ? buildReverseResultSections(parsed.data) : [];
  }, [result]);
  const updateReverseAgentResult = useAppStore((state) => state.updateReverseAgentResult);
  const cancelReverseAgentNode = useAppStore((state) => state.cancelReverseAgentNode);
  const runSequenceRef = useRef(0);
  const [runError, setRunError] = useState<string | null>(() => readNonEmptyString(config.reverseAgentError));
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [localStartedAt, setLocalStartedAt] = useState<string | null>(null);
  const [localCompletedAt, setLocalCompletedAt] = useState<string | null>(null);
  const isRunning = isRunningLocally || config.reverseAgentRunState === 'running';
  useEffect(() => {
    setResult(readReverseAgentResult(config.reverseAgentResult));
  }, [config.reverseAgentResult]);
  useEffect(() => {
    setRunError(readNonEmptyString(config.reverseAgentError));
  }, [config.reverseAgentError]);
  const toggleKnowledge = (knowledgeBaseId: string) => setSelectedIds((current) => current.includes(knowledgeBaseId)
    ? current.filter((id) => id !== knowledgeBaseId)
    : [...current, knowledgeBaseId]);
  const statusLabel = isRunning
    ? '分析中'
    : runError !== null || executionState === 'failed'
      ? '需要处理'
      : result !== null || executionState === 'completed'
        ? '已完成'
        : '等待运行';

  // A visible tray reflects a durable canvas edge, never stale presentation
  // metadata saved on the node. This keeps the UI and executor in sync.
  const media = connectedMedia;
  const currentRoute = compatibleRoutes.find((route) => route.modelRoute === modelRoute);
  const updateResult = (patch: Partial<ReverseResultView>) => {
    if (result === null) return;
    const nextResult = { ...result, ...patch };
    setResult(nextResult);
    void updateReverseAgentResult(id, nextResult);
  };
  return (
    <section className="module-node__summary module-node__summary--compact module-node__summary--agent module-node__summary--agent-studio" aria-label="Agent task configuration">
      <TaskTimingBadge
        ariaLabel="Reverse task timing"
        status={isRunning ? 'running' : runError !== null ? 'failed' : result !== null ? 'completed' : undefined}
        startedAt={localStartedAt ?? readNonEmptyString(config.reverseAgentStartedAt) ?? undefined}
        completedAt={localCompletedAt ?? readNonEmptyString(config.reverseAgentCompletedAt) ?? undefined}
      />
      <ExecutableNodeWorkbench
        label="反推anget"
        status={statusLabel}
        configuration={<div className="module-node__agent-form-flow">
          <section className="module-node__agent-control-strip--figma" aria-label="Reverse model control strip">
          <p className="module-node__agent-media-label" aria-label="Reverse media input">素材输入 · {media.length} / {MAX_GENERATION_REFERENCES}</p>
          {media.length > 0 ? <section className="module-node__agent-media-region nodrag nopan" aria-label="Reverse media workspace" data-agent-region="media" onPointerDown={stopCanvasPointer}>
            <ConnectedAgentMediaSlots
              ariaLabel="Connected reverse media slots"
              media={media}
              title="已连接素材"
              onReorder={(next) => {
                const edgeIds = next.flatMap((item) => item.edgeId ? [item.edgeId] : []);
                if (edgeIds.length === next.length) void onReorderMedia(edgeIds);
              }}
              onAdd={() => setMentionPickerOpen((open) => !open)}
              addAriaLabel="添加反推素材"
            />
          </section> : <section className="module-node__agent-media-empty-hint nodrag nopan" aria-label="Reverse media workspace" data-agent-region="media-empty" onPointerDown={stopCanvasPointer}>
            <span>未连接素材 · 0 / {MAX_GENERATION_REFERENCES}</span>
          </section>}
          <section className="module-node__agent-route-region nodrag nopan" aria-label="Reverse model workspace" data-agent-region="route">
              <div className="module-node__agent-route">
                <span>语言模型</span>
                <label>
                  <select className="nodrag nopan" aria-label="Agent model route" value={routeAvailable ? modelRoute : ''} onPointerDown={stopCanvasPointer} onChange={(event) => setModelRoute(event.target.value)}>
                    <option value="" disabled>选择兼容模型</option>
                    {compatibleRoutes.map((route) => <option key={route.modelRoute} value={route.modelRoute}>{reverseModelRouteOptionLabel(route)}</option>)}
                  </select>
                </label>
                <small>{currentRoute ? '已配置反推路线' : readNonEmptyString(config.routeDisplayName) ?? '需要配置路线'}</small>
              </div>
          </section>
          </section>
          {!routeAvailable && modelRoute.length > 0 && <p className="module-node__agent-notice" role="status">当前模型路线不可用，请在设置中重新选择。</p>}
          {compatibleRoutes.length === 0 && <p className="module-node__agent-notice" role="status">未配置可用的反推模型，请先在设置中连接并保存模型。</p>}
          {compatibleRoutes.length === 0 && onOpenSettings && (
            <button className="module-node__settings-agent nodrag nopan" type="button" aria-label="打开设置检查连接" onClick={onOpenSettings}>打开设置</button>
          )}
          <section className="module-node__agent-task nodrag nopan" aria-label="Reverse task editor" data-agent-region="task" onPointerDown={stopCanvasPointer}>
            <label><span>角色</span><input aria-label="Role positioning" value={role} placeholder="例如：产品视觉分析师" onChange={(event) => {
              const nextRole = event.target.value;
              setRoleDraft(nextRole);
            }} /></label>
            <label><span>反推任务</span><MediaMentionTextarea aria-label="Analysis task" value={task} mentions={mentionPreviews} rows={5} placeholder="提取构图、材质、镜头与提示词" onChange={(event) => {
              const nextTask = event.target.value;
              setTaskDraft(nextTask);
              setMentionedReferenceAssetIds((current) => retainMentionedAssetIds(current, nextTask, connectedImages));
              setMentionPickerOpen(isImageMentionQueryActive(nextTask, connectedImages));
            }} onKeyDown={(event) => {
              if (event.key === '@' && connectedImages.length > 0) setMentionPickerOpen(true);
              if (event.key === 'Escape') setMentionPickerOpen(false);
            }} /></label>
             {mentionPickerOpen && (
               <PromptImageMentionMenu images={connectedImages} prompt={task} onSelect={(asset, position) => {
                  const token = imageMentionTokenAt(position);
                 const nextTask = insertImageMention(task, token, connectedImages);
                 const nextReferenceAssetIds = mergeAssetIds(mentionedReferenceAssetIds, [asset.assetId]);
                 setTaskDraft(nextTask);
                 setMentionedReferenceAssetIds(nextReferenceAssetIds);
                 setMentionPickerOpen(false);
               }} />
             )}
           </section>
            <section className="module-node__agent-knowledge nodrag nopan" aria-label="Reverse knowledge context" data-agent-region="knowledge" onPointerDown={stopCanvasPointer}>
              <span className="module-node__knowledge-label">知识库</span>
              <button
                type="button"
                className="module-node__knowledge-trigger"
                data-testid="reverse-knowledge-trigger"
                aria-label="Knowledge bases"
                aria-expanded={knowledgePickerOpen}
                onClick={() => setKnowledgePickerOpen((open) => !open)}
              >
                <span>{selected.length > 0 ? readyBases.filter((base) => selected.includes(base.knowledgeBaseId)).map((base) => base.displayName ?? base.knowledgeBaseId).join(' · ') : '未选择知识库'}</span>
                <b>{selected.length}</b>
              </button>
              {knowledgePickerOpen && <section
                className="module-node__knowledge-picker"
                role="dialog"
                aria-label="选择知识库"
                data-testid="reverse-knowledge-picker"
                data-anchor="reverse-agent-footer"
              >
                <header>
                  <div><strong>选择知识库</strong><p>Knowledge library · 可多选</p></div>
                  <button type="button" aria-label="关闭知识库" onClick={() => setKnowledgePickerOpen(false)}>×</button>
                </header>
                <label className="module-node__knowledge-search">
                  <span aria-hidden="true">⌕</span>
                  <input data-testid="knowledge-picker-search" aria-label="搜索知识库" value={knowledgeQuery} onChange={(event) => setKnowledgeQuery(event.target.value)} placeholder="搜索知识库或文件" />
                </label>
                <div className="module-node__knowledge-categories" role="tablist" aria-label="知识库分类">
                  {([['common', '常用'], ['favorite', '收藏'], ['mine', '我的']] as const).map(([category, label]) => <button key={category} type="button" role="tab" aria-selected={knowledgeCategory === category} className={knowledgeCategory === category ? 'is-active' : undefined} onClick={() => setKnowledgeCategory(category)}>{label}</button>)}
                </div>
                <span className="module-node__knowledge-count">选择 {selected.length} 个知识库</span>
                <div className="module-node__knowledge-options" role="menu" aria-label="Agent knowledge bases">
                  {filteredReadyBases.map((base) => {
                    const checked = selected.includes(base.knowledgeBaseId);
                    return <label key={base.knowledgeBaseId} role="button" aria-label={`knowledge-option-${base.knowledgeBaseId}`} aria-pressed={checked}>
                      <input type="checkbox" aria-label={`Use ${base.displayName ?? base.knowledgeBaseId}`} checked={checked} onChange={() => toggleKnowledge(base.knowledgeBaseId)} />
                      <i aria-hidden="true">{checked ? '✓' : ''}</i>
                      <span><strong>{base.displayName ?? base.knowledgeBaseId}</strong>{'description' in base && typeof base.description === 'string' ? <small>{base.description}</small> : null}</span>
                      {base.activeVersion === null || base.activeContentHash === null || base.status === 'empty' ? <em>待同步</em> : <em>已连接</em>}
                    </label>;
                  })}
                </div>
                <footer>选择后会作为当前反推任务的上下文。</footer>
              </section>}
          </section>
        </div>}
        result={<div className="module-node__agent-result-panel" data-agent-region="result">
          <header><span>反推结果 / Reverse result</span><ResultFreshness value={config.resultState} /></header>
          {isRunning && <p role="status">正在反推，请稍候…</p>}
          {runError !== null && <p role="alert">{runError}</p>}
          {result !== null ? <div className="module-node__agent-result-scroll">
            <label><strong>分析</strong><textarea className="nodrag nopan" aria-label="Reverse analysis" rows={3} value={result.analysis ?? ''} onPointerDown={stopCanvasPointer} onChange={(event) => updateResult({ analysis: event.target.value })} /></label>
            <label><strong>关键词</strong><input className="nodrag nopan" aria-label="Reverse keywords" value={(result.keywords ?? []).join(', ')} onPointerDown={stopCanvasPointer} onChange={(event) => updateResult({ keywords: parseEditableReverseList(event.target.value) })} /></label>
            <label><strong>反推提示词</strong><textarea className="module-node__agent-result nodrag nopan" aria-label="Reverse positive prompt" rows={4} value={result.positivePrompt} onPointerDown={stopCanvasPointer} onChange={(event) => updateResult({ positivePrompt: event.target.value })} /></label>
            {selectableResultSections.length > 0 && <article className="module-node__reverse-result-sections nodrag nopan" aria-label="Selectable reverse result" onPointerDown={stopCanvasPointer}>
              {selectableResultSections.map((section) => <section key={section.id} aria-label={section.title} data-result-kind={section.kind} data-send-target={section.sendTarget}>
                <header><strong>{section.title}</strong>{section.sendTarget !== 'none' && <small>{section.sendTarget === 'image_generation' ? '可用于生图' : section.sendTarget === 'video_generation' ? '可用于视频' : '可用于生成'}</small>}</header>
                <pre>{section.text}</pre>
              </section>)}
            </article>}
            <label><strong>负向约束</strong><textarea className="nodrag nopan" aria-label="Reverse negative constraints" rows={3} value={(result.negativeConstraints ?? []).join('\n')} onPointerDown={stopCanvasPointer} onChange={(event) => updateResult({ negativeConstraints: parseEditableReverseList(event.target.value) })} /></label>
            <label><strong>执行检查</strong><textarea className="nodrag nopan" aria-label="Reverse execution checklist" rows={3} value={(result.executionChecklist ?? []).join('\n')} onPointerDown={stopCanvasPointer} onChange={(event) => updateResult({ executionChecklist: parseEditableReverseList(event.target.value) })} /></label>
          </div> : <p className="module-node__result-empty">运行完成后，反推提示词与分析要点会保留在这里。</p>}
        </div>}
        actions={<div className="module-node__agent-actions nodrag nopan" aria-label="Reverse task actions" data-agent-region="actions" onPointerDown={stopCanvasPointer}>
            <button
              className="module-node__apply-agent"
              type="button"
              aria-label="Copy reverse result"
              disabled={result === null}
              onClick={() => {
                if (result === null) return;
                void copyTextWithFallback(formatReverseResultDocument(result))
                  .then((copied) => setCopyFeedback(copied ? '复制成功' : '复制失败'));
              }}
            >{copyFeedback ?? '复制结果'}</button>
            <button
              className="module-node__run-agent"
              type="button"
              aria-label={isRunning ? 'Stop reverse analysis' : 'Start reverse analysis'}
              disabled={!isRunning && (!ready || !routeAvailable || isApplying)}
              onClick={() => {
                if (isRunning) {
                  runSequenceRef.current += 1;
                  setIsApplying(false);
                  setIsRunningLocally(false);
                  setLocalCompletedAt(new Date().toISOString());
                  void cancelReverseAgentNode(id);
                  return;
                }
                const runSequence = ++runSequenceRef.current;
                const startedAt = new Date().toISOString();
                setRunError(null);
                setLocalStartedAt(startedAt);
                setLocalCompletedAt(null);
                setIsApplying(true);
                setIsRunningLocally(true);
                void onRun(id, { modelRoute: modelRoute.trim(), role: role.trim(), task: task.trim(), knowledgeBaseIds: selected, ...(mentionedReferenceAssetIds.length > 0 ? { referenceAssetIds: mentionedReferenceAssetIds } : {}) })
                  .then((value) => {
                    if (runSequenceRef.current !== runSequence) return;
                    setResult(value);
                    setLocalCompletedAt(new Date().toISOString());
                  })
                  .catch((error) => {
                    if (runSequenceRef.current !== runSequence) return;
                    setRunError(formatReverseRunError(error));
                    setLocalCompletedAt(new Date().toISOString());
                  })
                  .finally(() => {
                    if (runSequenceRef.current !== runSequence) return;
                    setIsApplying(false);
                    setIsRunningLocally(false);
                  });
              }}
            >
              {isRunning ? '停止反推' : result !== null ? '重新反推' : '开始反推'}
            </button>
            {copyFeedback !== null && <span className="visually-hidden" role="status" aria-live="polite">{copyFeedback}</span>}
          </div>}
      />
    </section>
  );
}

function mergeReverseKnowledgeBases(
  knowledgeBases: readonly { knowledgeBaseId: string; displayName: string | null; activeVersion: number | null; activeContentHash: string | null; status: string }[],
) {
  const byId = new Map(knowledgeBases.map((base) => [base.knowledgeBaseId, base]));
  const required = REQUIRED_REVERSE_KNOWLEDGE_BASES.map((base) => {
    const existing = byId.get(base.knowledgeBaseId);
    byId.delete(base.knowledgeBaseId);
    return {
      ...existing,
      knowledgeBaseId: base.knowledgeBaseId,
      displayName: base.displayName,
      description: base.description,
      activeVersion: existing?.activeVersion ?? null,
      activeContentHash: existing?.activeContentHash ?? null,
      status: existing?.status ?? 'empty',
    };
  });
  const readyProjectBases = [...byId.values()].filter((base) => (
    base.activeVersion !== null
    && base.activeContentHash !== null
    && base.status !== 'empty'
  ));
  return [...required, ...readyProjectBases];
}

function formatReverseRunError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : '';
  if (code === 'CREDENTIALS_LOCKED') return 'API 密钥已锁定，请重新解锁后再反推。';
  if (code === 'PROVIDER_UNAVAILABLE') return '所选反推模型当前不可用，请重新选择模型。';
  if (code === 'PROVIDER_INVALID_RESPONSE') return '模型已返回内容，但反推结果格式无效。';
  if (code === 'PROJECT_CONFIG_SAVE_FAILED' || code === 'PROJECT_SAVE_RETRY_REQUIRED') return '反推配置保存失败，请先确认画布可以保存后重试。';
  if (code === 'REVISION_CONFLICT' || code === 'CONCURRENT_WRITER') return '画布版本发生冲突，请重新载入项目后再反推。';
  if (code === 'RECOVERY_REQUIRED') return '画布需要先完成恢复，再运行反推。';
  if (code === 'PROJECT_READ_ONLY') return '当前画布是只读状态，无法保存反推配置。';
  const message = sanitizeModelJobError(error);
  if (/timed out|timeout|超时/iu.test(message)) return '反推等待超时，请重试或更换响应更快的模型。';
  if (/managed.*media|MISSING_ASSET|素材/iu.test(message)) return '反推素材读取失败，请重新连接素材。';
  return message || '反推失败，请重试。';
}

/**
 * Shared UI Gate media tray used by image and video generation.  Reverse uses
 * the same slot classes below, so all connected-media cards have identical
 * thumbnail geometry, numbering and counter treatment.
 */
function ConnectedMediaSlots({
  ariaLabel,
  media,
  projectImages,
  projectVideos = [],
  title,
  showPending = false,
  pendingKind = 'image',
  slotRowAriaLabel,
  onAddReference,
  onReorder,
}: {
  ariaLabel: string;
  media: readonly OrderedMediaSummary[];
  projectImages: readonly ProjectImageAssetSummary[];
  projectVideos?: readonly ProjectVideoAssetSummary[];
  title: string;
  showPending?: boolean;
  pendingKind?: 'image' | 'video';
  slotRowAriaLabel?: string;
  onAddReference?: () => void;
  onReorder?: (media: ConnectedAgentMediaSlotItem[]) => void;
}) {
  if (media.length === 0 && !showPending) return null;
  const items: ConnectedAgentMediaSlotItem[] = media.slice(0, MAX_GENERATION_REFERENCES).map((item) => {
    const image = item.kind === 'image' ? projectImages.find((asset) => asset.assetId === item.assetId) : undefined;
    const video = item.kind === 'video' ? projectVideos.find((asset) => asset.assetId === item.assetId) : undefined;
    return {
      edgeId: item.edgeId,
      kind: item.kind,
      assetId: item.assetId,
      label: image?.label ?? video?.label ?? item.label,
      previewUrl: image && isRenderableManagedImageUrl(image.displayUrl, image.assetId)
        ? image.displayUrl
        : video?.displayUrl,
    };
  });

  return <ConnectedAgentMediaSlots
    ariaLabel={ariaLabel}
    media={items}
    title={title}
    slotRowAriaLabel={slotRowAriaLabel}
    emptySlotKind={items.length === 0 && showPending ? pendingKind : undefined}
    emptySlotAriaLabel="Video preview reference slot pending"
    // The connected-material tray is a status/ordering surface.  A single
    // add affordance belongs to the node input itself; rendering another
    // decorative plus at the far right makes empty trays look like they have
    // two upload targets.
    showAddPlaceholder={false}
    onAdd={onAddReference}
    onReorder={onReorder}
  />;
}
function isReverseAgentRoute(route: ReverseAgentRouteSummary): boolean {
  return route.capabilities.includes('reverse_prompt') && (
    route.capabilities.includes('gemini_native')
    || (route.capabilities.includes('chat') && route.capabilities.includes('vision'))
  );
}

function dedupeVisibleModelRoutes<T extends { readonly displayName: string }>(routes: readonly T[]): T[] {
  const unique = new Map<string, T>();
  for (const route of routes) {
    const key = route.displayName.trim().toLocaleLowerCase().replace(/[\s_-]+/gu, ' ');
    if (!unique.has(key)) unique.set(key, route);
  }
  return [...unique.values()];
}

function selectLatestCompletedGenerationJobs(
  modelJobs: readonly ModelJob[],
  nodeId: string,
  kind: 'image' | 'video',
): ModelJob[] {
  const nodeJobs = modelJobs.filter((job) => job.promptNodeId === nodeId && (job.kind ?? 'image') === kind);
  const timestampedJobs = nodeJobs.filter((job) => job.confirmedAt !== undefined || job.createdAt !== undefined);
  const latestBatchTimestamp = timestampedJobs
    .map((job) => job.confirmedAt ?? job.createdAt ?? '')
    .sort((left, right) => right.localeCompare(left))[0];
  const currentBatch = latestBatchTimestamp === undefined
    ? nodeJobs
    : nodeJobs.filter((job) => (job.confirmedAt ?? job.createdAt) === latestBatchTimestamp);
  return currentBatch
    .filter((job) => job.status === 'completed' && typeof job.resultAssetId === 'string')
    .sort((left, right) => (left.queueIndex ?? 0) - (right.queueIndex ?? 0) || left.id.localeCompare(right.id))
    .slice(0, 4);
}

function selectLatestGenerationJob(
  modelJobs: readonly ModelJob[],
  nodeId: string,
  kind: 'image' | 'video',
): ModelJob | undefined {
  return modelJobs
    .filter((job) => job.promptNodeId === nodeId && (job.kind ?? 'image') === kind)
    .sort((left, right) => generationJobTimestamp(right).localeCompare(generationJobTimestamp(left)))[0];
}

function selectGenerationTimingJob(
  modelJobs: readonly ModelJob[],
  nodeId: string,
  kind: 'image' | 'video',
  hasDurableResult: boolean,
): ModelJob | undefined {
  const latest = selectLatestGenerationJob(modelJobs, nodeId, kind);
  if (!hasDurableResult || latest?.status !== 'cancelled' || latest.completedAt === undefined) return latest;
  return modelJobs
    .filter((job) => job.promptNodeId === nodeId
      && (job.kind ?? 'image') === kind
      && job.status === 'completed'
      && job.resultAssetId !== undefined)
    .sort((left, right) => generationJobTimestamp(right).localeCompare(generationJobTimestamp(left)))[0];
}

function selectLatestFailedGenerationJob(
  modelJobs: readonly ModelJob[],
  nodeId: string,
  kind: 'image' | 'video',
  modelRoute?: string,
): ModelJob | undefined {
  return modelJobs
    .filter((job) => job.promptNodeId === nodeId
      && (job.kind ?? 'image') === kind
      && job.status === 'failed'
      && (modelRoute === undefined || job.modelRoute === undefined || job.modelRoute === modelRoute))
    .sort((left, right) => generationJobTimestamp(right).localeCompare(generationJobTimestamp(left)))[0];
}

function generationJobTimestamp(job: ModelJob): string {
  return job.updatedAt ?? job.confirmedAt ?? job.createdAt ?? '';
}

function formatGenerationJobError(job: ModelJob | undefined, kind: 'image' | 'video' = 'image'): string | null {
  if (job === undefined) return null;
  const error = String(job.error ?? '').toLowerCase();
  if (error.includes('401') || error.includes('authentication') || error.includes('unauthorized')) {
    return 'API 密钥认证失败，请检查当前模型所属平台的密钥。';
  }
  if (error.includes('invalid_result')
    || error.includes('invalid result')
    || error.includes('generated result was invalid')
    || error.includes('invalid image result')
    || error.includes('returned no image result')
    || error.includes('无法识别')) {
    return '模型返回的图片格式无法解析，请更换兼容模型或重试。';
  }
  if (error.includes('429') || error.includes('rate limit') || error.includes('quota')) {
    return '请求过于频繁或账户额度受限，请稍后重试。';
  }
  if (error.includes('timeout') || error.includes('network') || error.includes('连接')) {
    return '无法连接模型服务，请检查网络或 API 地址后重试。';
  }
  return kind === 'video'
    ? '视频生成失败，请检查模型与 API 配置后重试。'
    : '图片生成失败，请检查模型与 API 配置后重试。';
}

function TaskTimingBadge({
  ariaLabel,
  job,
  status = job?.status,
  startedAt = job?.startedAt ?? job?.confirmedAt ?? job?.createdAt,
  completedAt = job?.completedAt ?? (job?.status === 'failed' || job?.status === 'cancelled' ? job.updatedAt : undefined),
}: {
  ariaLabel: string;
  job?: ModelJob;
  status?: ModelJob['status'];
  startedAt?: string;
  completedAt?: string;
}) {
  const running = status === 'queued' || status === 'submitting' || status === 'running';
  const seconds = useTaskElapsedSeconds(startedAt, completedAt, running);
  if (status === undefined || startedAt === undefined || seconds === null) return null;
  const label = running
    ? '生成中'
    : status === 'completed'
      ? '成功'
      : status === 'failed'
        ? '失败'
        : status === 'cancelled'
          ? '已取消'
          : '等待';
  return <span className="module-node__task-timing nodrag nopan" data-task-status={status} aria-label={ariaLabel}>{label} · {seconds}秒</span>;
}

function useTaskElapsedSeconds(startedAt: string | undefined, completedAt: string | undefined, running: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || startedAt === undefined) return undefined;
    setNow(Date.now());
    const timer = globalThis.setInterval(() => setNow(Date.now()), 1_000);
    return () => globalThis.clearInterval(timer);
  }, [running, startedAt]);
  if (startedAt === undefined) return null;
  const start = Date.parse(startedAt);
  const end = completedAt === undefined ? now : Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / 1_000));
}

function formatGenerationStartError(error: unknown, kind: 'image' | 'video'): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  if (code === 'MODEL_ROUTE_UNAVAILABLE') return '当前选择的模型已失效，请重新选择模型后再试。';
  if (code === 'PROVIDER_BRIDGE_UNAVAILABLE') return '模型服务尚未连接，请重启应用后再试。';
  if (code === 'GENERATION_PARAMETERS_UNSUPPORTED') return '当前模型不支持所选参数，请调整比例或清晰度后再试。';
  if (code === 'RECOVERY_REQUIRED') return '当前是受保护的恢复预览，请先恢复并继续当前项目，再开始生成。';
  if (code === 'PROJECT_COMMIT_FAILED') return '画布尚未保存成功，保存项目后再开始生成。';
  if (code === 'MODEL_SESSION_FAILED') return '无法建立模型任务会话，请重新打开项目后再试。';
  return kind === 'video'
    ? '视频生成未启动，请检查模型、API 密钥和输入后重试。'
    : '生成未启动，请检查模型、API 密钥和输入后重试。';
}

function modelRouteOptionLabel(
  route: Pick<ImageGenerationRouteSummary, 'provider' | 'displayName' | 'modelRoute'>,
  _routes: readonly Pick<ImageGenerationRouteSummary, 'provider' | 'displayName' | 'modelRoute'>[],
): string {
  return route.displayName;
}

function reverseModelRouteOptionLabel(
  route: Pick<ImageGenerationRouteSummary, 'displayName'>,
): string {
  return route.displayName;
}
function preferredImageGenerationRoute(routes: readonly ImageGenerationRouteSummary[]): ImageGenerationRouteSummary | undefined {
  return routes.find((route) => {
    const haystack = `${route.displayName} ${route.modelId ?? ''} ${route.modelRoute}`.toLowerCase();
    return haystack.includes('nano banana pro') || haystack.includes('nano-banana-pro');
  })
    ?? routes.find((route) => route.modelRoute === 'image-default')
    ?? routes[0];
}

function preferredReverseAgentRoute(routes: readonly ReverseAgentRouteSummary[]): ReverseAgentRouteSummary | undefined {
  return routes.find((route) => {
    const haystack = `${route.displayName} ${route.modelId ?? ''} ${route.modelRoute}`.toLowerCase();
    return haystack.includes('gemini 3.1 pro') || haystack.includes('gemini-3.1-pro');
  })
    ?? routes.find((route) => route.modelRoute === 'reverse-default')
    ?? routes[0];
}

function stopCanvasPointer(event: React.PointerEvent<HTMLElement>): void {
  event.stopPropagation();
}

function clearBrowserSelection(): void {
  globalThis.getSelection?.()?.removeAllRanges();
}

function ResultOutputPreview({
  menuOpen: controlledMenuOpen,
  onMenuOpenChange,
}: {
  menuOpen?: boolean;
  onMenuOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolledMenuOpen, setUncontrolledMenuOpen] = useState(false);
  const menuOpen = controlledMenuOpen ?? uncontrolledMenuOpen;
  const setMenuOpen = (open: boolean) => {
    if (onMenuOpenChange) onMenuOpenChange(open);
    else setUncontrolledMenuOpen(open);
  };

  const openMenuFromKeyboard = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setMenuOpen(false);
      return;
    }
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      setMenuOpen(true);
    }
  };

  return (
    <section
      className="module-node__output-preview nodrag nopan"
      aria-label="Generated image preview"
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      tabIndex={0}
      onPointerDown={stopCanvasPointer}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuOpen(true);
      }}
      onKeyDown={openMenuFromKeyboard}
    >
      <header className="module-node__output-heading">
        <strong>生成结果</strong>
        <span>IMAGE OUTPUT · 已完成</span>
      </header>
      <strong>生成图片预览</strong>
      <span>右键查看更多操作</span>
      {menuOpen && (
        <div className="module-node__output-action-menu" role="menu" aria-label="生成图片操作">
          <strong className="module-node__output-action-title">图片操作</strong>
          <button type="button" role="menuitem" disabled title="生成图片后才能发送到 AI 对话">发送到 AI 对话</button>
          <button type="button" role="menuitem" disabled title="生成图片后才能发送到画布">发送到画布</button>
          <button type="button" role="menuitem" disabled title="生成图片后才能导入 Photoshop">导入 Photoshop</button>
          <button type="button" role="menuitem" disabled title="生成图片后才能复制">复制图片</button>
          <button type="button" role="menuitem" disabled title="生成图片后才能下载">下载图片</button>
        </div>
      )}
    </section>
  );
}

function VideoResultPreview({ result }: { result: { posterUrl: string | null } | null }) {
  if (result !== null) {
    return (
      <section className="module-node__output-preview module-node__video-output-preview module-node__video-output-preview--connected nodrag nopan" aria-label="Generated video playback" onPointerDown={stopCanvasPointer}>
        <header className="module-node__video-output-heading">
          <strong>生成结果</strong>
          <span>已完成</span>
        </header>
        <div className="module-node__video-output-stage">
          {result.posterUrl !== null
             ? <img src={result.posterUrl} alt="Video result poster" draggable={false} loading="lazy" decoding="async" />
            : <Video aria-hidden="true" size={28} strokeWidth={1.5} />}
          <span className="module-node__video-output-play" role="img" aria-label="Play generated video"><Play size={16} fill="currentColor" /></span>
        </div>
        <div className="module-node__video-output-status"><span>00:00 / 00:05 · 1080p</span><i aria-hidden="true" /></div>
      </section>
    );
  }
  return (
    <section className="module-node__output-preview module-node__video-output-preview nodrag nopan" aria-label="Generated video preview" onPointerDown={stopCanvasPointer}>
      <Video aria-hidden="true" size={24} strokeWidth={1.5} />
      <strong>生成视频结果</strong>
      <span>连线后显示视频图槽</span>
    </section>
  );
}

function ReverseResultPreview({ result }: { result: ReverseResultView | null }) {
  return (
    <section className="module-node__output-preview module-node__reverse-result-preview nodrag nopan" aria-label="Reverse analysis result" onPointerDown={stopCanvasPointer}>
      <header><strong>AI 分析输出</strong></header>
      <p>{result === null ? '连接反推 Agent 后显示结构化分析' : formatReverseResultDocument(result)}</p>
    </section>
  );
}
function UnavailableCapabilitySummary() {
  return (
    <section className="module-node__summary module-node__summary--compact">
      <div className="module-node__compact-line">
        <span>兼容路线</span>
        <b className="module-node__unavailable" role="status" title="需要配置兼容模型 / Compatible model required">未配置模型</b>
      </div>
    </section>
  );
}

function GenericModuleSummary({ config, definition }: { config: Record<string, unknown>; definition: CanvasModuleDefinition }) {
  const configuredCount = Object.values(config).filter((value) => value !== undefined && value !== null && value !== '').length;
  return (
    <section className="module-node__summary module-node__summary--compact">
      <div className="module-node__compact-line">
        <span>{formatRoute(config)}</span>
        <b>{configuredCount > 0 ? `${configuredCount} 项` : '待配置'}</b>
      </div>
      <ResultFreshness value={config.resultState} />
    </section>
  );
}

function ModuleError({ config }: { config: Record<string, unknown> }) {
  const error = config.error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
  const title = readNonEmptyString((error as Record<string, unknown>).title);
  const action = readNonEmptyString((error as Record<string, unknown>).action);
  if (!title && !action) return null;
  return <div className="module-node__error" role="alert"><strong>{title ?? '模块需要处理'}</strong>{action && <span>{action}</span>}</div>;
}

function ResultFreshness({ value }: { value: unknown }) {
  if (value === 'stale') return <span className="module-node__freshness is-stale" title="结果已过期 / Stale result">已过期</span>;
  if (value === 'fresh') return <span className="module-node__freshness is-fresh" title="结果为最新 / Fresh result">最新</span>;
  return <span className="module-node__freshness" title="暂无结果 / No result">无结果</span>;
}

function formatRoute(config: Record<string, unknown>): string {
  return readNonEmptyString(config.routeDisplayName) ?? readNonEmptyString(config.route) ?? '未选择路线';
}

function formatExecutionMode(mode: CanvasModuleDefinition['executionMode']): string {
  if (mode === 'provider') return '模型';
  if (mode === 'agent') return 'Agent';
  if (mode === 'composite') return '组合';
  return '本地';
}

function getPortShape(_dataType: CanvasModulePortDefinition['dataType']): 'circle' {
  return 'circle';
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function retainMentionedAssetIds(
  current: string[],
  text: string,
  images: readonly ProjectImageAssetSummary[],
): string[] {
  const next = current.filter((assetId) => promptContainsImageMention(text, imageMentionToken(images, assetId)));
  return stringArraysEqual(current, next) ? current : next;
}

function readTrimmedStringArray(value: unknown): string[] {
  return readStringArray(value).map((item) => item.trim()).filter((item) => item.length > 0);
}

function resolveConnectedGenerationMedia(
  project: ReturnType<typeof useAppStore.getState>['project'],
  nodeId: string,
  targetPortId: 'media' | 'references',
): OrderedMediaSummary[] {
  const nodesById = new Map(project.nodes.map((node) => [node.id, node]));
  const media: OrderedMediaSummary[] = [];
  const seen = new Set<string>();
  const append = (kind: 'image' | 'video', assetId: string, edgeId: string, label = assetId) => {
    if (assetId.trim().length === 0 || seen.has(assetId) || media.length >= MAX_GENERATION_REFERENCES) return;
    seen.add(assetId);
    media.push({ edgeId, kind, assetId, label, ranges: [] });
  };

  project.edges
    .filter((edge) => edge.target === nodeId && edge.targetPortId === targetPortId)
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
    .forEach((edge) => {
      const source = nodesById.get(edge.source);
      if (source?.type === 'image_result' && edge.sourcePortId === 'image') {
        append('image', source.data.assetId, edge.id);
        return;
      }
      if (source?.type !== 'module') return;
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
function resolveConnectedVideoMedia(project: ReturnType<typeof useAppStore.getState>['project'], nodeId: string): {
  imageAssetIds: string[];
  sourceVideoAssetId: string | undefined;
} {
  const edges = project.edges
    .filter((candidate) => candidate.target === nodeId && candidate.targetPortId === 'media')
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
  const imageAssetIds: string[] = [];
  let sourceVideoAssetId: string | undefined;
  const seenAssetIds = new Set<string>();
  for (const edge of edges.slice(0, MAX_GENERATION_REFERENCES)) {
    const source = project.nodes.find((candidate) => candidate.id === edge.source);
    const assetId = source?.type === 'image_result'
      ? source.data.assetId
      : source?.type === 'module' && typeof source.data.config.assetId === 'string'
        ? source.data.config.assetId
        : undefined;
    if (!assetId || seenAssetIds.has(assetId)) continue;
    seenAssetIds.add(assetId);
    if ((source?.type === 'image_result' && edge.sourcePortId === 'image') || (
      source?.type === 'module'
      && (source.data.moduleType === 'image_input' || source.data.moduleType === 'upload_image')
      && edge.sourcePortId === 'image'
    )) {
      imageAssetIds.push(assetId);
      continue;
    }
    if (source?.type === 'module' && source.data.moduleType === 'video_input' && edge.sourcePortId === 'video' && sourceVideoAssetId === undefined) {
      sourceVideoAssetId = assetId;
    }
  }
  return { imageAssetIds, sourceVideoAssetId };
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function useExternallyHydratedDraftState<T>(externalValue: T) {
  const [value, setValue] = useState(externalValue);
  const locallyEdited = useRef(false);
  const previousExternalValue = useRef(externalValue);
  useEffect(() => {
    const previousValue = previousExternalValue.current;
    if (!locallyEdited.current) {
      setValue((currentValue) => Object.is(currentValue, previousValue) ? externalValue : currentValue);
    }
    previousExternalValue.current = externalValue;
  }, [externalValue]);
  const setDraftValue: typeof setValue = (nextValue) => {
    locallyEdited.current = true;
    setValue(nextValue);
  };
  return [value, setDraftValue] as const;
}

async function persistDraftWithBoundaryRetry(write: () => Promise<boolean>): Promise<boolean> {
  if (await write()) return true;
  return write();
}

type ReverseResultView = Partial<ReversePromptResult> & { readonly positivePrompt: string };

function readReverseAgentResult(value: unknown): ReverseResultView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const professional = reversePromptResultSchema.safeParse(value);
  if (professional.success) return professional.data;
  const record = value as Record<string, unknown>;
  const positivePrompt = readNonEmptyString(record.positivePrompt);
  const analysis = readNonEmptyString(record.analysis);
  return positivePrompt === null ? null : {
    ...(analysis === null ? {} : { analysis }),
    keywords: readStringArray(record.keywords),
    positivePrompt,
    negativeConstraints: readTrimmedStringArray(record.negativeConstraints),
    executionChecklist: readTrimmedStringArray(record.executionChecklist),
  };
}

function formatProfessionalReverseDetails(result: ReverseResultView): string | null {
  const sections = [
    result.mediaResponsibilities?.length
      ? `逐素材职责与纹理\n${result.mediaResponsibilities.map((item) => `- ${item.label ?? item.sourceId}｜${item.role}｜${item.priority}\n  继承：${item.inheritance.join('；') || '无'}\n  冲突：${item.conflicts.join('；') || '无'}\n  可用纹理/内容：${item.usableElements.join('；')}`).join('\n')}`
      : null,
    result.materialsAndTextures?.length
      ? `材质与纹理\n${result.materialsAndTextures.map((item) => `- ${item.object}：${item.material}；${item.roughnessReflectionTransmission}；${item.textureScaleAndDetail}；制作：${item.productionMethod}`).join('\n')}`
      : null,
    result.lightingAndColor
      ? `灯光与扫光\n${result.lightingAndColor.keyFillRimEnvironment.join('；')}\n扫光：${result.lightingAndColor.sweepLight}\n高级感：${result.lightingAndColor.premiumLookRationale.join('；')}`
      : null,
    result.effects?.length
      ? `特效\n${result.effects.map((item) => `- ${item.type}：${item.purpose}；制作：${item.recreation.join('；')}；产品适配：${item.productAdaptation}`).join('\n')}`
      : null,
    result.fluids?.length
      ? `流体\n${result.fluids.map((item) => `- ${item.type}：${item.purpose}；${item.physicalBehavior}；制作：${item.productionMethod.join('；')}；产品交互：${item.productInteraction}`).join('\n')}`
      : null,
    result.whiteBackgroundAdaptation
      ? `白底产品适配\n${[
        ...result.whiteBackgroundAdaptation.silhouetteProtection,
        ...result.whiteBackgroundAdaptation.grounding,
        ...result.whiteBackgroundAdaptation.contaminationPrevention,
        ...result.whiteBackgroundAdaptation.doNotCopy.map((item) => `禁止照搬：${item}`),
      ].map((item) => `- ${item}`).join('\n')}`
      : null,
    result.videoTimeline?.length
      ? `视频时间轴\n${result.videoTimeline.map((shot) => `- ${shot.timeRange}｜${shot.shotType}｜${shot.estimatedFocalLength}\n  运镜：${shot.cameraMovement}；速度/稳定：${shot.speedCurveAndStabilization}\n  扫光：${shot.lightingAndSweep}；转场：${shot.transition}；适配：${shot.productAdaptation}`).join('\n')}`
      : null,
    result.positivePromptZh ? `中文提示词\n${result.positivePromptZh}` : null,
    result.positivePromptEn ? `English Prompt\n${result.positivePromptEn}` : null,
  ].filter((section): section is string => section !== null);
  return sections.length > 0 ? sections.join('\n\n') : null;
}

function formatReverseResultDocument(result: ReverseResultView): string {
  const professionalDetails = formatProfessionalReverseDetails(result);
  const sections = [
    result.analysis ? `分析\n${result.analysis}` : null,
    (result.keywords?.length ?? 0) > 0 ? `关键词\n${result.keywords!.join(' · ')}` : null,
    `反推正向提示词\n${result.positivePrompt}`,
    (result.negativeConstraints?.length ?? 0) > 0 ? `负面约束\n${result.negativeConstraints!.map((item) => `- ${item}`).join('\n')}` : null,
    (result.executionChecklist?.length ?? 0) > 0 ? `执行检查清单\n${result.executionChecklist!.map((item, index) => `${index + 1}. ${item}`).join('\n')}` : null,
    professionalDetails,
  ];
  return sections.filter((section): section is string => section !== null).join('\n\n');
}

function parseEditableReverseList(value: string): string[] {
  return value.split(/[\n,]/u).map((item) => item.trim()).filter((item) => item.length > 0);
}

function readPastedImageFile(data: DataTransfer | null): File | null {
  if (data === null) return null;
  const file = Array.from(data.files ?? []).find((candidate) => candidate.type.startsWith('image/'));
  if (file) return file;
  for (const item of Array.from(data.items ?? [])) {
    if (!item.type.startsWith('image/')) continue;
    const itemFile = item.getAsFile();
    if (itemFile) return itemFile;
  }
  return null;
}

async function copyTextWithFallback(value: string): Promise<boolean> {
  const writeText = globalThis.navigator?.clipboard?.writeText;
  if (typeof writeText === 'function') {
    try {
      await writeText.call(globalThis.navigator.clipboard, value);
      return true;
    } catch {
      // Fall through to the synchronous browser fallback.
    }
  }
  if (typeof document === 'undefined' || document.body === null) return false;

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  textarea.style.position = 'fixed';
  document.body.append(textarea);
  textarea.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

function readStoryboardShots(value: unknown): Array<{ id: string; order: number; title: string; composition: string; durationSeconds: number; referenceAssetIds: string[]; aspectRatio: string; resolution: string; outputCount: number }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const record = candidate as Record<string, unknown>;
    const id = readNonEmptyString(record.id);
    const title = readNonEmptyString(record.title);
    const composition = readNonEmptyString(record.composition);
    const order = readPositiveInteger(record.order);
    const durationSeconds = readPositiveInteger(record.durationSeconds);
    if (!id || !title || !composition || order === null || durationSeconds === null) return [];
    return [{ id, title, composition, order, durationSeconds, referenceAssetIds: readStringArray(record.referenceAssetIds), aspectRatio: readNonEmptyString(record.aspectRatio) ?? '16:9', resolution: readNonEmptyString(record.resolution) ?? '1024x1024', outputCount: readPositiveInteger(record.outputCount) ?? 1 }];
  });
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

interface OrderedMediaSummary extends ConnectedAgentMediaSlotItem {
  readonly edgeId?: string;
  readonly kind: 'image' | 'video';
  readonly assetId: string;
  readonly label: string;
  readonly previewUrl?: string;
  readonly ranges: readonly { startMs: number; endMs: number }[];
}

function readOrderedMedia(value: unknown): OrderedMediaSummary[] {
  if (!Array.isArray(value)) return [];
  const media: OrderedMediaSummary[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    if (record.kind !== 'image' && record.kind !== 'video') continue;
    const assetId = readNonEmptyString(record.assetId);
    if (!assetId) continue;
    const ranges = Array.isArray(record.ranges) ? record.ranges.flatMap((range) => {
      if (!range || typeof range !== 'object' || Array.isArray(range)) return [];
      const startMs = (range as Record<string, unknown>).startMs;
      const endMs = (range as Record<string, unknown>).endMs;
      return typeof startMs === 'number' && typeof endMs === 'number' && startMs >= 0 && endMs > startMs
        ? [{ startMs, endMs }]
        : [];
    }) : [];
    media.push({ kind: record.kind, assetId, label: readNonEmptyString(record.label) ?? (record.kind === 'image' ? '图片' : '视频'), ranges });
  }
  return media;
}

function formatRange(startMs: number, endMs: number): string {
  return `${formatTimestamp(startMs)}–${formatTimestamp(endMs)}`;
}

function formatTimestamp(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const millis = Math.floor(milliseconds % 1_000);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function ProjectImageControl({
  assetId,
  assets,
  error,
  importing,
  moduleType,
  onImport,
  onSelect,
}: {
  assetId?: string;
  assets: readonly ProjectImageAssetSummary[];
  error: string | null;
  importing: boolean;
  moduleType: 'image_input' | 'upload_image';
  onImport: (file?: File) => void;
  onSelect: (assetId: string) => void;
}) {
  const asset = assets.find((candidate) => candidate.assetId === assetId);
  const previewUrl = isRenderableManagedImageUrl(asset?.displayUrl, asset?.assetId)
    || isBrowserPreviewUrl(asset?.displayUrl)
    ? asset?.displayUrl ?? null
    : null;
  const chooseFile = () => {
    const mode = resolveMediaImportMode({
      desktopBridge: globalThis.window?.novusDesktop,
      manualAcceptance: globalThis.window?.__NOVUS_MANUAL_ACCEPTANCE__ === true,
    });
    if (mode === 'desktop-managed') {
      onImport();
      return;
    }
    openBrowserFilePicker('image/png,image/jpeg,image/webp,image/gif', onImport);
  };
  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const file = readPastedImageFile(event.clipboardData);
    if (file === null) return;
    event.preventDefault();
    event.stopPropagation();
    onImport(file);
  };
  return (
    <div
      className="module-node__image-control nodrag nopan"
      role="group"
      tabIndex={0}
      aria-label="图片素材粘贴替换区域"
      title="点击此区域后按 Ctrl+V，可直接替换图片素材"
      onPointerDown={(event) => event.stopPropagation()}
      onPaste={handlePaste}
    >
      {previewUrl && asset ? (
        <div
          className="module-node__media-frame"
          style={{ aspectRatio: formatMediaDisplayAspectRatio(asset.width, asset.height) }}
        >
            <img src={previewUrl} alt={asset.label} draggable={false} loading="lazy" decoding="async" />
          <button
            type="button"
            className="module-node__media-action"
            title="更换图像 / Replace image"
            aria-label="更换图像 / Replace image"
            disabled={importing}
            onClick={chooseFile}
          >
            <ImageUp size={14} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="module-node__media-empty"
          title="导入图像 / Import image"
          aria-label="导入图像 / Import image"
          disabled={importing}
          onClick={chooseFile}
        >
          <span aria-hidden="true"><ImageIcon size={24} strokeWidth={1.6} /></span>
          <strong>{importing ? '正在导入…' : '添加图片素材'}</strong>
          <small>{importing ? '请稍候' : '上传'}</small>
        </button>
      )}
      {asset && (
        <div className="module-node__media-meta">
          <strong title={asset.label}>{asset.label}</strong>
          <span className="module-node__media-tools">
            <small>{formatAssetDimensions(asset)}</small>
            {moduleType === 'image_input' && assets.length > 0 && (
              <span className="module-node__media-picker" title="选择项目图像 / Choose project image">
                <Images size={13} aria-hidden="true" />
                <select aria-label="选择项目图像 / Choose project image" value={assetId ?? ''} onChange={(event) => onSelect(event.target.value)}>
                  <option value="" disabled>项目素材库 / Project library</option>
                  {assets.map((candidate) => <option key={candidate.assetId} value={candidate.assetId}>{candidate.label}</option>)}
                </select>
              </span>
            )}
          </span>
        </div>
      )}
      {error && <small className="module-node__asset-error" role="status">{error}</small>}
    </div>
  );
}

function VideoInputControl({
  asset,
  importing,
  onImport,
}: {
  asset?: ProjectVideoAssetSummary;
  importing: boolean;
  onImport: (file?: File) => void;
}) {
  const chooseFile = () => {
    const mode = resolveMediaImportMode({
      desktopBridge: globalThis.window?.novusDesktop,
      manualAcceptance: globalThis.window?.__NOVUS_MANUAL_ACCEPTANCE__ === true,
    });
    if (mode === 'desktop-managed') {
      onImport();
      return;
    }
    openBrowserFilePicker('video/mp4,video/*', onImport);
  };
  return (
    <div className="module-node__video-control nodrag nopan">
      {asset ? (
        <div className="module-node__media-frame is-video" style={{ aspectRatio: formatMediaDisplayAspectRatio(asset.width, asset.height) }}>
          <video aria-label={asset.label} controls preload="metadata" src={asset.displayUrl} />
        </div>
      ) : (
        <button
          type="button"
          className="module-node__media-empty is-video"
          aria-label="导入视频 / Import video"
          disabled={importing}
          onClick={chooseFile}
        >
          <span aria-hidden="true"><Video size={25} strokeWidth={1.6} /></span>
          <strong>{importing ? '正在导入' : '导入 MP4'}</strong>
          <small>受管视频 / Managed video</small>
        </button>
      )}
      <div className="module-node__media-meta">
        <strong>{asset?.label ?? '视频素材'}</strong>
        <small><Clapperboard size={11} aria-hidden="true" /> {asset ? formatBytes(asset.byteSize) : 'MP4'}</small>
      </div>
    </div>
  );
}

function formatBytes(byteSize: number): string {
  if (byteSize < 1024) return `${byteSize} B`;
  if (byteSize < 1024 * 1024) return `${Math.round(byteSize / 1024)} KB`;
  return `${(byteSize / (1024 * 1024)).toFixed(byteSize < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function isBrowserPreviewUrl(value: string | undefined): value is string {
  return value?.startsWith('blob:') === true || value?.startsWith('data:image/') === true;
}

function openBrowserFilePicker(accept: string, onImport: (file?: File) => void): void {
  if (typeof document === 'undefined') return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.style.display = 'none';
  const removeInput = () => {
    input.value = '';
    input.remove();
  };
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) onImport(file);
    removeInput();
  };
  input.addEventListener('cancel', removeInput, { once: true });
  document.body.appendChild(input);
  input.click();
}

function CanvasLibraryControl({
  allAssetCount,
  assets,
  assetIds,
  error,
  onQueryChange,
  onSelectionChange,
  query,
}: {
  allAssetCount: number;
  assets: readonly ProjectImageAssetSummary[];
  assetIds: string[];
  error: string | null;
  onQueryChange: (query: string) => void;
  onSelectionChange: (assetIds: string[]) => void;
  query: string;
}) {
  const selectedPositions = new Map(assetIds.map((assetId, index) => [assetId, index]));
  const move = (assetId: string, direction: -1 | 1) => {
    const index = assetIds.indexOf(assetId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= assetIds.length) return;
    const next = [...assetIds];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onSelectionChange(next);
  };
  return (
    <div className="module-node__library-control nodrag nopan" onPointerDown={(event) => event.stopPropagation()}>
      {allAssetCount > 0 && (
        <input
          type="search"
          aria-label="搜索项目图像 / Search project images"
          placeholder={`搜索 ${allAssetCount} 张图像`}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
      )}
      <div className="module-node__library-assets">
        {assets.length === 0 ? <small>暂无项目图像</small> : assets.map((asset) => {
          const position = selectedPositions.get(asset.assetId);
          const selected = position !== undefined;
          return (
            <div key={asset.assetId} className={selected ? 'is-selected' : ''}>
              <label>
                <input
                  type="checkbox"
                  aria-label={`选择 ${asset.label} / Select ${asset.label}`}
                  checked={selected}
                  disabled={!selected && assetIds.length >= MAX_GENERATION_REFERENCES}
                  onChange={(event) => onSelectionChange(event.target.checked
                    ? [...assetIds, asset.assetId]
                    : assetIds.filter((assetId) => assetId !== asset.assetId))}
                />
                <span>{asset.label}<small>{asset.origin} · {formatAssetDimensions(asset)}</small></span>
              </label>
              {selected && (
                <span className="module-node__library-order">
                  <small>{`参考 ${position + 1} / Reference ${position + 1}`}</small>
                  <button type="button" aria-label={`上移 ${asset.label} / Move ${asset.label} up`} disabled={position === 0} onClick={() => move(asset.assetId, -1)}>↑</button>
                  <button type="button" aria-label={`下移 ${asset.label} / Move ${asset.label} down`} disabled={position === assetIds.length - 1} onClick={() => move(asset.assetId, 1)}>↓</button>
                </span>
              )}
            </div>
          );
        })}
      </div>
      {error && <small className="module-node__asset-error" role="status">{error}</small>}
    </div>
  );
}

function readAssetIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((assetId): assetId is string => typeof assetId === 'string' && assetId.length > 0);
  return [...new Set(ids)].slice(0, MAX_GENERATION_REFERENCES);
}

function formatAssetDimensions(asset: ProjectImageAssetSummary): string {
  return asset.width === null || asset.height === null ? '尺寸不可用' : `${asset.width} × ${asset.height}`;
}

function getMediaNodeWidth(asset: ProjectImageAssetSummary): number {
  if (asset.width === null || asset.height === null) return 232;
  const ratio = asset.width / asset.height;
  if (ratio < 0.8) return 188;
  if (ratio > 1.45) return 260;
  return 232;
}
