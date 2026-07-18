import { memo, useMemo, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Image as ImageIcon } from 'lucide-react';
import {
  getCanvasModuleDefinition,
  MAX_GENERATION_REFERENCES,
  type CanvasModuleDefinition,
  type CanvasModuleNodeData,
  type CanvasModulePortDefinition,
} from '@agent-canvas/domain';
import type { ProjectImageAssetSummary } from '@agent-canvas/desktop-core';
import { resolveCanvasModuleIcon } from './module-icons';
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

const executionModeLabels: Record<CanvasModuleDefinition['executionMode'], string> = {
  local: '本地 / Local',
  provider: '模型服务 / Provider',
  agent: 'Agent',
  composite: '组合 / Composite',
};

function formatExecutionState(state: CanvasModuleNodeData['execution']['state']): string {
  return executionStateLabels[state];
}

function summarizeModuleConfig(config: Record<string, unknown>): string {
  const entries = Object.entries(config).filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (entries.length === 0) return '默认配置 / Default configuration';
  return entries.slice(0, 2).map(([key, value]) => `${key}: ${formatConfigValue(value)}`).join('  |  ');
}

function formatConfigValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `${value.length} 项`;
  return '已配置';
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
      <span className="module-node__port-label">
        {port.primaryLabel}
        <small>{port.secondaryLabel}</small>
        {port.required ? null : <small aria-label="可选 / optional">可选</small>}
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
  data: CanvasModuleNodeData;
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
  const [libraryQuery, setLibraryQuery] = useState('');
  const hasImageControls = data.moduleType === 'image_input'
    || data.moduleType === 'upload_image'
    || data.moduleType === 'canvas_library';
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

  return (
    <article
      className={`module-node${hasImageControls ? ' module-node--image-controls' : ''}${isProfessionalWorkbench ? ' module-node--workbench' : ''}${selected ? ' is-selected' : ''}`}
      data-testid="module-node-card"
      data-module-type={definition.type}
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
          <small>{definition.categoryDisplay.primaryName} / {definition.categoryDisplay.secondaryName}</small>
          <strong>{definition.primaryName}</strong>
          <span>{definition.secondaryName}</span>
        </span>
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
        <ImageGenerationSummary config={data.config} definition={definition} />
      ) : data.moduleType === 'reverse_agent' ? (
        <ReverseAgentSummary config={data.config} definition={definition} />
      ) : data.moduleType === 'music_generation' || data.moduleType === 'speech_generation' ? (
        <UnavailableCapabilitySummary definition={definition} />
      ) : (
        <GenericModuleSummary config={data.config} definition={definition} />
      )}
      <div className="module-node__ports" aria-label="模块端口 / Module ports">
        <div className="module-node__ports-column module-node__ports-column--inputs">
          {inputs.map((port) => <ModulePort key={`${port.direction}:${port.id}`} port={port} />)}
        </div>
        <div className="module-node__ports-column module-node__ports-column--outputs">
          {outputs.map((port) => <ModulePort key={`${port.direction}:${port.id}`} port={port} />)}
        </div>
      </div>
      <footer className="module-node__footer">
        <span>{executionModeLabels[definition.executionMode]} · {formatRoute(data.config)}</span>
        <b data-execution-state={data.execution.state}>{formatExecutionState(data.execution.state)}</b>
      </footer>
      <ModuleError config={data.config} />
    </article>
  );
});

function ImageGenerationSummary({ config, definition }: { config: Record<string, unknown>; definition: CanvasModuleDefinition }) {
  const enabled = readStringArray(config.enabledInputCapabilities);
  const referenceCount = readStringArray(config.referenceAssetIds).length;
  return (
    <section className="module-node__summary module-node__summary--structured" aria-label="生成能力槽位 / Generation capability slots">
      <div className="module-node__meta-line"><strong>能力</strong><span>{formatCapabilities(definition)}</span></div>
      <div className="module-node__slot-grid">
        <CapabilitySlot label="提示词 / Prompt" state="required" />
        <CapabilitySlot label={`参考图 ${referenceCount} / References`} state={enabled.includes('references') ? 'available' : 'unsupported'} />
        <CapabilitySlot label="蒙版 / Mask" state={enabled.includes('mask') ? 'available' : 'unsupported'} />
        <CapabilitySlot label="姿态 / Pose" state={enabled.includes('pose') ? 'available' : 'unsupported'} />
      </div>
      <ResultFreshness value={config.resultState} />
    </section>
  );
}

function CapabilitySlot({ label, state }: { label: string; state: 'required' | 'available' | 'unsupported' }) {
  const stateLabel = state === 'required'
    ? '必需 / Required'
    : state === 'available'
      ? '可用 / Available'
      : '当前模型不支持 / Unsupported';
  return <span className={`module-node__slot is-${state}`}><b>{label}</b><small>{stateLabel}</small></span>;
}

function ReverseAgentSummary({ config, definition }: { config: Record<string, unknown>; definition: CanvasModuleDefinition }) {
  const media = readOrderedMedia(config.orderedMedia);
  const skillName = readNonEmptyString(config.skillName) ?? '自动识别';
  const mode = readNonEmptyString(config.mode) ?? 'auto';
  const knowledgeVersion = typeof config.knowledgeVersion === 'number' ? `知识 v${config.knowledgeVersion}` : '知识未绑定';
  return (
    <section className="module-node__summary module-node__summary--structured" aria-label="反推媒体摘要 / Reverse media summary">
      <div className="module-node__meta-line"><strong>Skill / 模式</strong><span>{skillName} · {mode}</span></div>
      <div className="module-node__meta-line"><strong>能力 / 知识</strong><span>{formatCapabilities(definition)} · {knowledgeVersion}</span></div>
      <div className="module-node__media-strip">
        {media.length === 0 ? <small>等待图片、视频、文本任务或线稿输入</small> : media.map((item, index) => (
          <span className={`module-node__media-item is-${item.kind}`} key={`${item.assetId}-${index}`}>
            <b>{String(index + 1).padStart(2, '0')}</b>
            <span>{item.label}</span>
            {item.ranges.map((range) => <small key={`${range.startMs}-${range.endMs}`}>{formatRange(range.startMs, range.endMs)}</small>)}
          </span>
        ))}
      </div>
      <ResultFreshness value={config.resultState} />
    </section>
  );
}

function UnavailableCapabilitySummary({ definition }: { definition: CanvasModuleDefinition }) {
  return (
    <section className="module-node__summary module-node__summary--structured">
      <div className="module-node__meta-line"><strong>能力</strong><span>{formatCapabilities(definition)}</span></div>
      <div className="module-node__unavailable" role="status">需要配置兼容模型 / Compatible model required</div>
      <small>本节点仅声明安全合同；未配置路线时不会创建运行任务。</small>
    </section>
  );
}

function GenericModuleSummary({ config, definition }: { config: Record<string, unknown>; definition: CanvasModuleDefinition }) {
  return (
    <section className="module-node__summary module-node__summary--structured">
      <div className="module-node__meta-line"><strong>配置</strong><span>{summarizeModuleConfig(config)}</span></div>
      <div className="module-node__meta-line"><strong>能力</strong><span>{formatCapabilities(definition)}</span></div>
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
  if (value === 'stale') return <span className="module-node__freshness is-stale">结果已过期 / Stale result</span>;
  if (value === 'fresh') return <span className="module-node__freshness is-fresh">结果为最新 / Fresh result</span>;
  return <span className="module-node__freshness">暂无结果 / No result</span>;
}

function formatCapabilities(definition: CanvasModuleDefinition): string {
  const labels: Readonly<Record<string, string>> = {
    chat: '对话',
    comfy_workflow: '受控 Comfy',
    image_edit: '图片编辑',
    image_generation: '图片生成',
    line_art_material: '线稿材质',
    local_redraw: '局部重绘',
    mask_edit: '蒙版',
    music_generation: '音乐',
    pose: '姿态',
    speech_synthesis: '语音',
    storyboard: '分镜',
    structured_comparison: '结构化对比',
    structured_output: '结构化输出',
    video_understanding: '视频理解',
    vision: '视觉',
  };
  return definition.capabilities.map((capability) => labels[capability] ?? capability).join(' · ') || '本地';
}

function formatRoute(config: Record<string, unknown>): string {
  return readNonEmptyString(config.routeDisplayName) ?? readNonEmptyString(config.route) ?? '未选择路线';
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
  const previewUrl = isRenderableManagedImageUrl(asset?.displayUrl) ? asset.displayUrl : null;
  return (
    <div className="module-node__image-control nodrag nopan" onPointerDown={(event) => event.stopPropagation()}>
      <div className="module-node__asset-preview">
        {previewUrl
          ? <img src={previewUrl} alt="" draggable={false} />
          : <span className="module-node__asset-icon" aria-hidden="true"><ImageIcon size={19} /></span>}
        <span className="module-node__asset-copy">
          <strong>{asset?.label ?? '暂无受管图像'}</strong>
          <small>{asset ? formatAssetDimensions(asset) : '选择或导入项目图像 / Choose or import'}</small>
        </span>
      </div>
      {moduleType === 'image_input' && assets.length > 0 && (
        <select aria-label="选择项目图像 / Choose project image" value={assetId ?? ''} onChange={(event) => onSelect(event.target.value)}>
          <option value="" disabled>项目素材库 / Project library</option>
          {assets.map((candidate) => <option key={candidate.assetId} value={candidate.assetId}>{candidate.label}</option>)}
        </select>
      )}
      <button type="button" aria-label={asset ? '更换图像 / Replace image' : '导入图像 / Import image'} disabled={importing} onClick={onImport}>
        {importing ? '正在导入…' : asset ? '更换图像' : '导入图像'}
      </button>
      {error && <small className="module-node__asset-error" role="status">{error}</small>}
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
      <input
        type="search"
        aria-label="搜索项目图像 / Search project images"
        placeholder={`搜索 ${allAssetCount} 张图像`}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
      />
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
