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
  idle: 'Idle',
  invalid: 'Invalid',
  ready: 'Ready',
  waiting_confirmation: 'Waiting confirmation',
  queued: 'Queued',
  running: 'Running',
  blocked: 'Blocked',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const categoryLabels: Record<CanvasModuleDefinition['category'], string> = {
  input: 'Input',
  generation: 'Generation',
  editing: 'Editing',
  analysis: 'Analysis',
  output: 'Output',
};

function formatExecutionState(state: CanvasModuleNodeData['execution']['state']): string {
  return executionStateLabels[state];
}

function summarizeModuleConfig(config: Record<string, unknown>): string {
  const entries = Object.entries(config).filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (entries.length === 0) return 'Default configuration';
  return entries.slice(0, 2).map(([key, value]) => `${key}: ${formatConfigValue(value)}`).join('  |  ');
}

function formatConfigValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `${value.length} items`;
  return 'Configured';
}

interface ModulePortProps {
  port: CanvasModulePortDefinition;
}

const ModulePort = memo(function ModulePort({ port }: ModulePortProps) {
  const isInput = port.direction === 'input';
  return (
    <div
      className={`module-node__port-row module-node__port-row--${port.direction}`}
      data-port-id={port.id}
      data-port-direction={port.direction}
      data-port-type={port.dataType}
    >
      {isInput && (
        <Handle
          id={port.id}
          type="target"
          position={Position.Left}
          data-port-id={port.id}
          data-port-direction={port.direction}
          data-port-type={port.dataType}
        />
      )}
      <span className="module-node__port-label">
        {port.label}
        {port.required ? null : <small aria-label="optional">Optional</small>}
      </span>
      {!isInput && (
        <Handle
          id={port.id}
          type="source"
          position={Position.Right}
          data-port-id={port.id}
          data-port-direction={port.direction}
          data-port-type={port.dataType}
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
  const filteredProjectImages = useMemo(() => {
    const query = libraryQuery.trim().toLocaleLowerCase();
    return query.length === 0
      ? projectImages
      : projectImages.filter((asset) => asset.label.toLocaleLowerCase().includes(query));
  }, [libraryQuery, projectImages]);

  return (
    <article
      className={`module-node${hasImageControls ? ' module-node--image-controls' : ''}${selected ? ' is-selected' : ''}`}
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
          <small>{categoryLabels[definition.category]}</small>
          <strong>{definition.displayName}</strong>
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
      ) : (
        <div className="module-node__summary">{summarizeModuleConfig(data.config)}</div>
      )}
      <div className="module-node__ports" aria-label="Module ports">
        <div className="module-node__ports-column module-node__ports-column--inputs">
          {inputs.map((port) => <ModulePort key={port.id} port={port} />)}
        </div>
        <div className="module-node__ports-column module-node__ports-column--outputs">
          {outputs.map((port) => <ModulePort key={port.id} port={port} />)}
        </div>
      </div>
      <footer className="module-node__footer">
        <span>{definition.executionMode}</span>
        <b>{formatExecutionState(data.execution.state)}</b>
      </footer>
    </article>
  );
});

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
          <strong>{asset?.label ?? 'No managed image'}</strong>
          <small>{asset ? formatAssetDimensions(asset) : 'Choose or import a project image'}</small>
        </span>
      </div>
      {moduleType === 'image_input' && assets.length > 0 && (
        <select aria-label="Choose project image" value={assetId ?? ''} onChange={(event) => onSelect(event.target.value)}>
          <option value="" disabled>Project library</option>
          {assets.map((candidate) => <option key={candidate.assetId} value={candidate.assetId}>{candidate.label}</option>)}
        </select>
      )}
      <button type="button" disabled={importing} onClick={onImport}>
        {importing ? 'Importing…' : asset ? 'Replace image' : 'Import image'}
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
        aria-label="Search project images"
        placeholder={`Search ${allAssetCount} images`}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
      />
      <div className="module-node__library-assets">
        {assets.length === 0 ? <small>No project images</small> : assets.map((asset) => {
          const position = selectedPositions.get(asset.assetId);
          const selected = position !== undefined;
          return (
            <div key={asset.assetId} className={selected ? 'is-selected' : ''}>
              <label>
                <input
                  type="checkbox"
                  aria-label={`Select ${asset.label}`}
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
                  <small>{`Reference ${position + 1}`}</small>
                  <button type="button" aria-label={`Move ${asset.label} up`} disabled={position === 0} onClick={() => move(asset.assetId, -1)}>↑</button>
                  <button type="button" aria-label={`Move ${asset.label} down`} disabled={position === assetIds.length - 1} onClick={() => move(asset.assetId, 1)}>↓</button>
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
  return asset.width === null || asset.height === null ? 'Dimensions unavailable' : `${asset.width} × ${asset.height}`;
}
