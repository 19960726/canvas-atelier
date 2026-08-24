import type { ReactNode } from 'react';
import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { CanvasNode } from '@agent-canvas/domain';
import type { LucideIcon } from 'lucide-react';
import {
  Box,
  Check,
  History,
  Image as ImageIcon,
  LayoutTemplate,
  MessageSquare,
  Play,
  Sparkles,
} from 'lucide-react';

export type CanvasNodeTone = 'teal' | 'blue' | 'amber' | 'slate' | 'red';

export interface CanvasNodePresentation {
  kind: CanvasNode['type'];
  tone: CanvasNodeTone;
  eyebrow: string;
  title: string;
  subtitle: string;
  status: string;
  resultAssetId?: string;
}

interface CanvasNodeCardProps extends CanvasNodePresentation {
  selected?: boolean;
  inputConnected?: boolean;
  outputConnected?: boolean;
  children?: ReactNode;
}

const iconByKind: Record<CanvasNode['type'], LucideIcon> = {
  reference: ImageIcon,
  placement_preview: LayoutTemplate,
  prompt: MessageSquare,
  model_job: Play,
  image_result: ImageIcon,
  video_result: Play,
  review: Check,
  memory_diff: History,
  agent_plan: Sparkles,
  module: Box,
};

export const CanvasNodeCard = memo(function CanvasNodeCard({
  kind,
  tone,
  eyebrow,
  title,
  subtitle,
  status,
  selected = false,
  inputConnected = false,
  outputConnected = false,
  children,
}: CanvasNodeCardProps) {
  const Icon = iconByKind[kind];

  return (
    <div
      className={`canvas-node${kind === 'image_result' ? '' : ' canvas-node--compact'} tone-${tone}${selected ? ' is-selected' : ''}`}
      data-testid="canvas-node-card"
      data-node-kind={kind}
      data-tone={tone}
    >
      <Handle
        type="target"
        position={Position.Left}
        data-port-direction="input"
        data-port-connected={inputConnected ? 'true' : undefined}
      />
      <header className="canvas-node__header">
        <span className="canvas-node__type-icon" aria-hidden="true">
          <Icon size={15} />
        </span>
        <span className="canvas-node__heading">
          <span className="canvas-node__eyebrow">{eyebrow}</span>
          <strong className="canvas-node__title">{title}</strong>
        </span>
      </header>
      <div className="canvas-node__body">{children ?? <p className="canvas-node__meta">{subtitle}</p>}</div>
      <footer className="canvas-node__footer">
        <span>{subtitle}</span>
        <b>{status}</b>
      </footer>
      <Handle
        type="source"
        position={Position.Right}
        data-port-direction="output"
        data-port-connected={outputConnected ? 'true' : undefined}
      />
    </div>
  );
});
