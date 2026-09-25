import { useRef, type CSSProperties, type PointerEvent } from 'react';

export function ImageComparisonDivider({
  position,
  onChange,
}: {
  position: number;
  onChange: (position: number) => void;
}) {
  const clampedPosition = Math.min(100, Math.max(0, Math.round(position)));
  const dividerStyle = { left: `${clampedPosition}%` } satisfies CSSProperties;
  const inputRef = useRef<HTMLInputElement>(null);
  const activePointer = useRef<number | null>(null);
  const updatePointer = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
    if (bounds && bounds.width > 0) onChange(Math.min(100, Math.max(0, Math.round((event.clientX - bounds.left) / bounds.width * 100))));
  };

  return <>
    <input
      ref={inputRef}
      className="module-node__image-comparison-range nodrag nopan"
      type="range"
      min={0}
      max={100}
      step={1}
      value={clampedPosition}
      aria-label="原图与校正后对比线"
      aria-valuetext={`原图 ${clampedPosition}%，校正后 ${100 - clampedPosition}%`}
      onChange={(event) => onChange(Number(event.target.value))}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    />
    <div
      className="module-node__image-comparison-hit-target nodrag nopan"
      style={dividerStyle}
      aria-hidden="true"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        activePointer.current = event.pointerId;
        inputRef.current?.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        updatePointer(event);
      }}
      onPointerMove={(event) => {
        if (activePointer.current !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        updatePointer(event);
      }}
      onPointerUp={(event) => {
        if (activePointer.current !== event.pointerId) return;
        updatePointer(event);
        activePointer.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        event.stopPropagation();
      }}
      onPointerCancel={() => { activePointer.current = null; }}
      onLostPointerCapture={() => { activePointer.current = null; }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
    />
    <div className="module-node__image-comparison-divider" style={dividerStyle} aria-hidden="true">
      <span className="module-node__image-comparison-label module-node__image-comparison-label--original">原图</span>
      <span className="module-node__image-comparison-label module-node__image-comparison-label--corrected">校正后</span>
      <span className="module-node__image-comparison-handle" />
    </div>
  </>;
}
