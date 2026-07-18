import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Image as ImageIcon, RotateCw } from 'lucide-react';
import type { PlacementBoard as PlacementBoardValue, PlacementObject } from '@agent-canvas/domain';
import { normalizePlacementObject } from '@agent-canvas/domain';
import { isRenderableManagedImageUrl } from '../app/managed-image-url';

const minimumPlacementSize = 0.02;

interface PlacementBoardProps {
  value: PlacementBoardValue;
  selectedObjectId?: string;
  targetFps?: number;
  disableShadowsWhileInteracting?: boolean;
  onChange: (value: PlacementBoardValue) => void;
  onCommit?: (value: PlacementBoardValue) => void;
  onSelect: (objectId: string) => void;
  resolveAssetUrl?: (assetId: string) => string;
}

type ResizeDirection = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
type Interaction =
  | { mode: 'move'; object: PlacementObject; startX: number; startY: number }
  | { mode: 'resize'; direction: ResizeDirection; object: PlacementObject; startX: number; startY: number }
  | { mode: 'rotate'; object: PlacementObject };

const resizeDirections: ResizeDirection[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function PlacementBoard({
  value,
  selectedObjectId,
  targetFps = 60,
  disableShadowsWhileInteracting = false,
  onChange,
  onCommit,
  onSelect,
  resolveAssetUrl,
}: PlacementBoardProps) {
  const boardRef = useRef<HTMLDivElement>(null);
  const interactionRef = useRef<Interaction | null>(null);
  const pendingValueRef = useRef<PlacementBoardValue | null>(null);
  const lastFrameAtRef = useRef(Number.NEGATIVE_INFINITY);
  const [isInteracting, setIsInteracting] = useState(false);
  const aspectRatio = `${value.board.width} / ${value.board.height}`;
  const interactionFrameMs = Math.max(1, Math.floor(1000 / Math.max(1, targetFps)));

  const beginMove = (event: ReactPointerEvent, object: PlacementObject) => {
    event.stopPropagation();
    onSelect(object.id);
    if (object.locked) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    interactionRef.current = { mode: 'move', object, startX: event.clientX, startY: event.clientY };
    lastFrameAtRef.current = Number.NEGATIVE_INFINITY;
    setIsInteracting(true);
  };

  const beginResize = (event: ReactPointerEvent, object: PlacementObject, direction: ResizeDirection) => {
    event.stopPropagation();
    if (object.locked) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    interactionRef.current = { mode: 'resize', direction, object, startX: event.clientX, startY: event.clientY };
    lastFrameAtRef.current = Number.NEGATIVE_INFINITY;
    setIsInteracting(true);
  };

  const beginRotate = (event: ReactPointerEvent, object: PlacementObject) => {
    event.stopPropagation();
    if (object.locked) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    interactionRef.current = { mode: 'rotate', object };
    lastFrameAtRef.current = Number.NEGATIVE_INFINITY;
    setIsInteracting(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const interaction = interactionRef.current;
    const rect = boardRef.current?.getBoundingClientRect();
    if (!interaction || !rect || rect.width === 0 || rect.height === 0) return;

    let nextObject: PlacementObject;
    if (interaction.mode === 'rotate') {
      const centerX = rect.left + (interaction.object.x + interaction.object.w / 2) * rect.width;
      const centerY = rect.top + (interaction.object.y + interaction.object.h / 2) * rect.height;
      const angle = Math.atan2(event.clientY - centerY, event.clientX - centerX) * 180 / Math.PI + 90;
      nextObject = normalizePlacementObject({ ...interaction.object, rotation: angle });
    } else {
      const dx = (event.clientX - interaction.startX) / rect.width;
      const dy = (event.clientY - interaction.startY) / rect.height;
      nextObject = interaction.mode === 'move'
        ? normalizePlacementObject({ ...interaction.object, x: interaction.object.x + dx, y: interaction.object.y + dy })
        : resizeObject(interaction.object, dx, dy, interaction.direction);
    }

    const nextValue = {
      ...value,
      objects: value.objects.map((object) => object.id === nextObject.id ? nextObject : object),
    };
    pendingValueRef.current = nextValue;
    const frameNow = globalThis.performance?.now?.() ?? Date.now();
    if (frameNow - lastFrameAtRef.current < interactionFrameMs) {
      return;
    }
    lastFrameAtRef.current = frameNow;
    onChange(nextValue);
  };

  const finishInteraction = () => {
    if (!interactionRef.current) return;
    interactionRef.current = null;
    const committedValue = pendingValueRef.current;
    pendingValueRef.current = null;
    lastFrameAtRef.current = Number.NEGATIVE_INFINITY;
    setIsInteracting(false);
    if (committedValue) {
      onChange(committedValue);
      onCommit?.(committedValue);
    }
  };

  return (
    <div
      ref={boardRef}
      className={`placement-board nodrag${disableShadowsWhileInteracting && isInteracting ? ' is-no-shadow' : ''}`}
      data-testid="placement-board"
      style={{ aspectRatio }}
      onPointerMove={handlePointerMove}
      onPointerUp={finishInteraction}
      onPointerCancel={finishInteraction}
    >
      <div className="placement-guide is-third-x-1" />
      <div className="placement-guide is-third-x-2" />
      <div className="placement-guide is-third-y-1" />
      <div className="placement-guide is-third-y-2" />
      {value.board.safeAreas.map((area) => (
        <div
          key={area.id}
          className={`placement-safe-area is-${area.purpose}`}
          style={{ left: `${area.x * 100}%`, top: `${area.y * 100}%`, width: `${area.w * 100}%`, height: `${area.h * 100}%` }}
        >
          {area.purpose === 'copy_safe' ? '文案安全区' : '安全区'}
        </div>
      ))}
      {value.objects.filter((object) => object.visible).sort((a, b) => a.zIndex - b.zIndex).map((object) => {
        const selected = object.id === selectedObjectId;
        const imageSource = resolveAssetUrl?.(object.assetId) ?? object.assetId;
        const canRenderImage = isRenderableManagedImageUrl(imageSource);
        return (
          <div
            key={object.id}
            className={`placement-object role-${object.role}${selected ? ' is-selected' : ''}${object.locked ? ' is-locked' : ''}`}
            data-testid={`placement-object-${object.id}`}
            data-asset-id={object.assetId}
            data-object-id={object.id}
            data-role={object.role}
            data-user-reference={object.assetId.startsWith('starter-') ? 'false' : 'true'}
            style={{
              left: `${object.x * 100}%`,
              top: `${object.y * 100}%`,
              width: `${object.w * 100}%`,
              height: `${object.h * 100}%`,
              zIndex: object.zIndex,
              transform: `rotate(${object.rotation}deg) scaleX(${object.flipX ? -1 : 1}) scaleY(${object.flipY ? -1 : 1})`,
            }}
            onPointerDown={(event) => beginMove(event, object)}
          >
            {canRenderImage ? <img src={imageSource} alt={object.name ?? object.role} draggable={false} /> : <ImageIcon size={22} />}
            <span>{object.name ?? object.role}</span>
            {selected && !object.locked && resizeDirections.map((direction) => (
              <button
                key={direction}
                type="button"
                className={`placement-handle is-${direction}`}
                aria-label={direction === 'se' ? `缩放${object.name ?? object.role}` : `从${direction}缩放${object.name ?? object.role}`}
                onPointerDown={(event) => beginResize(event, object, direction)}
              />
            ))}
            {selected && !object.locked && (
              <button type="button" className="placement-rotate" aria-label={`旋转${object.name ?? object.role}`} onPointerDown={(event) => beginRotate(event, object)}>
                <RotateCw size={12} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function resizeObject(object: PlacementObject, boardDx: number, boardDy: number, direction: ResizeDirection): PlacementObject {
  const radians = object.rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = boardDx * cos + boardDy * sin;
  const dy = -boardDx * sin + boardDy * cos;
  const right = object.x + object.w;
  const bottom = object.y + object.h;
  let { x, y, w, h } = object;

  if (direction.includes('e')) {
    w = clamp(object.w + dx, minimumPlacementSize, 1 - object.x);
  }
  if (direction.includes('s')) {
    h = clamp(object.h + dy, minimumPlacementSize, 1 - object.y);
  }
  if (direction.includes('w')) {
    x = clamp(object.x + dx, 0, right - minimumPlacementSize);
    w = right - x;
  }
  if (direction.includes('n')) {
    y = clamp(object.y + dy, 0, bottom - minimumPlacementSize);
    h = bottom - y;
  }

  return normalizePlacementObject({ ...object, x, y, w, h });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
