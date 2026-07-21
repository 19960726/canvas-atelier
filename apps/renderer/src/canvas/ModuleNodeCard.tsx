import { memo, useMemo, useState, type CSSProperties } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Clapperboard, Image as ImageIcon, ImageUp, Images, LockKeyhole, LockOpen, Video } from 'lucide-react';
import {
  getCanvasModuleDefinition,
  MAX_GENERATION_REFERENCES,
  type CanvasModuleDefinition,
  type CanvasModuleNodeData,
  type CanvasModulePortDefinition,
} from '@agent-canvas/domain';
import type { ProjectImageAssetSummary } from '@agent-canvas/desktop-core';
import { resolveCanvasModuleIcon } from './module-icons';
import { formatMediaDisplayAspectRatio } from './media-display';
import { useAppStore } from '../app/app-store';
import { isRenderableManagedImageUrl } from '../app/managed-image-url';

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
}

const ModulePort = memo(function ModulePort({ port }: ModulePortProps) {
  const isInput = port.direction === 'input';
  const portShape = getPortShape(port.dataType);
  return (
    <div
      className={`module-node__port-row module-node__port-row--${port.direction}`}
      data-port-id={port.id}
      data-port-direction={port.direction}
      data-port-type={port.dataType}
      data-port-shape={portShape}
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
        />
      )}
      <span className="module-node__port-label" title={`${port.primaryLabel} / ${port.secondaryLabel}`}>
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
        />
      )}
    </div>
  );
});

interface ModuleNodeCardProps {
  id: string;
  data: CanvasModuleNodeData & { locked?: boolean };
  selected?: boolean;
}

export const ModuleNodeCard = memo(function ModuleNodeCard({ id, data, selected }: ModuleNodeCardProps) {
  const definition = getCanvasModuleDefinition(data.moduleType);
  const Icon = resolveCanvasModuleIcon(definition.type);
  const inputs = definition.ports.filter((port) => port.direction === 'input');
  const outputs = definition.ports.filter((port) => port.direction === 'output');
  const projectImages = useAppStore((state) => state.projectImages);
  const projectImageError = useAppStore((state) => state.projectImageError);
  const importingNodeId = useAppStore((state) => state.projectImageImportingNodeId);
  const importImageForModule = useAppStore((state) => state.importImageForModule);
  const selectProjectImageForModule = useAppStore((state) => state.selectProjectImageForModule);
  const setCanvasLibrarySelection = useAppStore((state) => state.setCanvasLibrarySelection);
  const toggleNodeLock = useAppStore((state) => state.toggleNodeLock);
  const [libraryQuery, setLibraryQuery] = useState('');
  const hasImageControls = data.moduleType === 'image_input'
    || data.moduleType === 'upload_image'
    || data.moduleType === 'canvas_library';
  const hasMediaControls = hasImageControls || data.moduleType === 'video_input';
  const isProfessionalWorkbench = data.moduleType === 'image_generation'
    || data.moduleType === 'reverse_agent'
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
  const mediaNodeStyle = selectedImage
    ? { '--media-node-width': `${getMediaNodeWidth(selectedImage)}px` } as CSSProperties
    : undefined;

  return (
    <article
      className={`module-node${hasMediaControls ? ' module-node--media-controls' : ''}${hasImageControls ? ' module-node--image-controls' : ''}${isProfessionalWorkbench ? ' module-node--workbench' : ''}${selected ? ' is-selected' : ''}`}
      data-testid="module-node-card"
      data-module-type={definition.type}
      style={mediaNodeStyle}
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
          <strong>{definition.primaryName}</strong>
          <small>{definition.secondaryName}</small>
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
          onImport={() => { void importImageForModule(id); }}
          onSelect={(assetId) => { void selectProjectImageForModule(id, assetId); }}
        />
      ) : data.moduleType === 'video_input' ? (
        <VideoInputControl config={data.config} />
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
      ) : data.moduleType === 'image_generation' ? (
        <ImageGenerationSummary config={data.config} />
      ) : data.moduleType === 'reverse_agent' ? (
        <ReverseAgentSummary config={data.config} />
      ) : data.moduleType === 'music_generation' || data.moduleType === 'speech_generation' ? (
        <UnavailableCapabilitySummary />
      ) : (
        <GenericModuleSummary config={data.config} definition={definition} />
      )}
      <div
        className={`module-node__ports${inputs.length > 0 ? ' has-inputs' : ''}${outputs.length > 0 ? ' has-outputs' : ''}`}
        aria-label="模块端口 / Module ports"
      >
        <div className="module-node__ports-column module-node__ports-column--inputs">
          {inputs.map((port) => <ModulePort key={`${port.direction}:${port.id}`} port={port} />)}
        </div>
        <div className="module-node__ports-column module-node__ports-column--outputs">
          {outputs.map((port) => <ModulePort key={`${port.direction}:${port.id}`} port={port} />)}
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

function ImageGenerationSummary({ config }: { config: Record<string, unknown> }) {
  const referenceCount = readStringArray(config.referenceAssetIds).length;
  return (
    <section className="module-node__summary module-node__summary--compact" aria-label="生成摘要 / Generation summary">
      <div className="module-node__compact-line">
        <span title="模型路线 / Model route">{formatRoute(config)}</span>
        <b>参考 {referenceCount}</b>
      </div>
      <ResultFreshness value={config.resultState} />
    </section>
  );
}

function ReverseAgentSummary({ config }: { config: Record<string, unknown> }) {
  const media = readOrderedMedia(config.orderedMedia);
  const skillName = readNonEmptyString(config.skillName) ?? '自动识别';
  const mode = readNonEmptyString(config.mode) ?? 'auto';
  const knowledgeVersion = typeof config.knowledgeVersion === 'number' ? `知识 v${config.knowledgeVersion}` : '知识未绑定';
  return (
    <section
      className="module-node__summary module-node__summary--compact"
      aria-label="反推摘要 / Reverse summary"
      title={formatMediaTooltip(media)}
    >
      <div className="module-node__compact-line">
        <span>{skillName}</span>
        <b>{media.length} 项</b>
      </div>
      <div className="module-node__compact-subline">
        <span>{knowledgeVersion}</span>
        <span title={`模式 ${mode} / Mode ${mode}`}>{formatRoute(config)}</span>
      </div>
      <ResultFreshness value={config.resultState} />
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

function getPortShape(dataType: CanvasModulePortDefinition['dataType']): 'circle' | 'diamond' | 'square' {
  if (dataType === 'text_prompt' || dataType === 'voice_profile_id') return 'diamond';
  if (dataType.endsWith('_document') || dataType === 'storyboard_chart' || dataType === 'material_plan' || dataType === 'sanitized_workflow') return 'square';
  return 'circle';
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

interface OrderedMediaSummary {
  readonly kind: 'image' | 'video';
  readonly assetId: string;
  readonly label: string;
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

function formatMediaTooltip(media: readonly OrderedMediaSummary[]): string {
  if (media.length === 0) return '等待图片、视频、文本任务或线稿输入';
  return media.map((item, index) => {
    const ranges = item.ranges.map((range) => formatRange(range.startMs, range.endMs)).join(', ');
    return `${index + 1}. ${item.label}${ranges ? ` ${ranges}` : ''}`;
  }).join('\n');
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
  onImport: () => void;
  onSelect: (assetId: string) => void;
}) {
  const asset = assets.find((candidate) => candidate.assetId === assetId);
  const previewUrl = isRenderableManagedImageUrl(asset?.displayUrl, asset?.assetId) ? asset.displayUrl : null;
  return (
    <div className="module-node__image-control nodrag nopan" onPointerDown={(event) => event.stopPropagation()}>
      {previewUrl && asset ? (
        <div
          className="module-node__media-frame"
          style={{ aspectRatio: formatMediaDisplayAspectRatio(asset.width, asset.height) }}
        >
          <img src={previewUrl} alt={asset.label} draggable={false} />
          <button
            type="button"
            className="module-node__media-action"
            title="更换图像 / Replace image"
            aria-label="更换图像 / Replace image"
            disabled={importing}
            onClick={onImport}
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
          onClick={onImport}
        >
          <span aria-hidden="true"><ImageIcon size={24} strokeWidth={1.6} /></span>
          <strong>{importing ? '正在导入…' : '导入图片'}</strong>
          <small>PNG · JPEG · GIF · WebP</small>
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

function VideoInputControl({ config }: { config: Record<string, unknown> }) {
  const hasBoundAsset = readNonEmptyString(config.assetId) !== null;
  return (
    <div className="module-node__video-control nodrag nopan">
      <div className="module-node__media-empty is-video" role="status">
        <span aria-hidden="true"><Video size={25} strokeWidth={1.6} /></span>
        <strong>{hasBoundAsset ? '已绑定受管视频' : '视频预览'}</strong>
        <small>{hasBoundAsset ? '预览信息不可用' : 'MP4 导入尚未接入'}</small>
      </div>
      <div className="module-node__media-meta">
        <strong>{hasBoundAsset ? '旧项目视频资产' : '等待安全视频合同'}</strong>
        <small><Clapperboard size={11} aria-hidden="true" /> 00:00</small>
      </div>
    </div>
  );
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
