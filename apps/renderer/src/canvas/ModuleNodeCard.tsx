import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import {
  Box,
  FileSearch,
  FileText,
  Image,
  Library,
  MessageSquare,
  Pencil,
  Search,
  Sparkles,
  Upload,
  Video,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  getCanvasModuleDefinition,
  type CanvasModuleDefinition,
  type CanvasModuleNodeData,
  type CanvasModulePortDefinition,
  type CanvasModuleType,
} from '@agent-canvas/domain';

const moduleIconByType: Record<CanvasModuleType, LucideIcon> = {
  image_input: Image,
  upload_image: Upload,
  video_input: Video,
  canvas_library: Library,
  text_prompt: MessageSquare,
  image_generation_v1: Sparkles,
  image_generation_v2: Sparkles,
  image_editor: Pencil,
  openpose: Search,
  reverse_agent: Search,
  skill_agent: Sparkles,
  detail_page_agent: FileSearch,
  video_analysis: Video,
  line_art_material: FileText,
  result_output: Box,
};

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

function resolveModuleIcon(iconKey: string): LucideIcon {
  return moduleIconByType[iconKey as CanvasModuleType] ?? Box;
}

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

export const ModuleNodeCard = memo(function ModuleNodeCard({ data, selected }: ModuleNodeCardProps) {
  const definition = getCanvasModuleDefinition(data.moduleType);
  const Icon = resolveModuleIcon(definition.iconKey);
  const inputs = definition.ports.filter((port) => port.direction === 'input');
  const outputs = definition.ports.filter((port) => port.direction === 'output');

  return (
    <article
      className={`module-node${selected ? ' is-selected' : ''}`}
      data-testid="module-node-card"
      data-module-type={definition.type}
    >
      <header className="module-node__header">
        <span className="module-node__icon" aria-hidden="true"><Icon size={16} /></span>
        <span className="module-node__heading">
          <small>{categoryLabels[definition.category]}</small>
          <strong>{definition.displayName}</strong>
        </span>
      </header>
      <div className="module-node__summary">{summarizeModuleConfig(data.config)}</div>
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
