import { useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react';

export const CANVAS_BEZIER_EDGE_TYPE = 'canvas-bezier';

interface CanvasBezierPathParams {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
}

/**
 * One connector language for every durable canvas flow.  The small vertical
 * lift keeps even horizontally aligned ports visibly curved rather than
 * collapsing into a straight segment.
 */
export function getCanvasBezierPath({
  sourceX,
  sourceY,
  targetX,
  targetY,
}: CanvasBezierPathParams): string {
  const horizontalDistance = Math.abs(targetX - sourceX);
  const verticalDistance = Math.abs(targetY - sourceY);
  const direction = targetX >= sourceX ? 1 : -1;
  const controlDistance = Math.max(28, horizontalDistance * 0.34, Math.min(112, verticalDistance * 0.35));
  const arc = Math.min(28, Math.max(12, horizontalDistance * 0.1));

  return `M ${sourceX},${sourceY} C ${sourceX + direction * controlDistance},${sourceY - arc} ${targetX - direction * controlDistance},${targetY - arc} ${targetX},${targetY}`;
}

export function getCanvasBezierMidpoint({ sourceX, sourceY, targetX, targetY }: CanvasBezierPathParams): { x: number; y: number } {
  const horizontalDistance = Math.abs(targetX - sourceX);
  const verticalDistance = Math.abs(targetY - sourceY);
  const direction = targetX >= sourceX ? 1 : -1;
  const controlDistance = Math.max(28, horizontalDistance * 0.34, Math.min(112, verticalDistance * 0.35));
  const arc = Math.min(28, Math.max(12, horizontalDistance * 0.1));
  const firstControl = { x: sourceX + direction * controlDistance, y: sourceY - arc };
  const secondControl = { x: targetX - direction * controlDistance, y: targetY - arc };
  return {
    x: (sourceX + (3 * firstControl.x) + (3 * secondControl.x) + targetX) / 8,
    y: (sourceY + (3 * firstControl.y) + (3 * secondControl.y) + targetY) / 8,
  };
}

interface CanvasBezierEdgeData {
  readonly onCancel?: () => void;
}

export function shouldShowCanvasEdgeCancel({
  hasCancelHandler,
  hovered,
}: {
  hasCancelHandler: boolean;
  hovered: boolean;
}): boolean {
  return hasCancelHandler && hovered;
}

export function CanvasBezierEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  style,
  data,
}: EdgeProps) {
  const [hovered, setHovered] = useState(false);
  const midpoint = getCanvasBezierMidpoint({ sourceX, sourceY, targetX, targetY });
  const onCancel = (data as CanvasBezierEdgeData | undefined)?.onCancel;
  const path = getCanvasBezierPath({ sourceX, sourceY, targetX, targetY });
  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={markerEnd}
        style={style}
      />
      {onCancel !== undefined && (
        <path
          d={path}
          fill="none"
          stroke="transparent"
          strokeWidth={20}
          pointerEvents="stroke"
          aria-hidden="true"
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={(event) => {
            const relatedTarget = event.relatedTarget;
            if (relatedTarget instanceof Element && relatedTarget.closest('.canvas-edge__cancel') !== null) return;
            setHovered(false);
          }}
        />
      )}
      {shouldShowCanvasEdgeCancel({ hasCancelHandler: onCancel !== undefined, hovered }) && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="canvas-edge__cancel nodrag nopan"
            aria-label="断开连接"
            title="断开连接"
            style={{ transform: `translate(-50%, -50%) translate(${midpoint.x}px, ${midpoint.y}px)` }}
            onPointerEnter={() => setHovered(true)}
            onPointerLeave={() => setHovered(false)}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onCancel?.();
            }}
          >
            ×
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
