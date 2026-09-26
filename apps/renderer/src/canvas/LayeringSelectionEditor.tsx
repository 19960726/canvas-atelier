import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { LayeringBox } from '../app/layering-selection';

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
type Point = { x: number; y: number };
export function LayeringSelectionEditor({ url, label, width, height, selecting, disabled, box, onChange }: {
  url: string; label: string; width: number; height: number; selecting: boolean; disabled: boolean;
  box: LayeringBox | null; onChange: (box: LayeringBox | null) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; start: Point; box: LayeringBox | null; handle: string } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const scale = Math.min(size.width / width, size.height / height);
  const imageWidth = width * scale, imageHeight = height * scale;
  const point = (event: PointerEvent<SVGSVGElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height) };
  };
  const updateDrag = (event: PointerEvent<SVGSVGElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId || disabled) return;
    const current = point(event), initial = state.box;
    if (state.handle === 'move' && initial) {
      onChange({ ...initial, x: clamp(initial.x + current.x - state.start.x, 0, 1 - initial.width),
        y: clamp(initial.y + current.y - state.start.y, 0, 1 - initial.height) });
    } else {
      const anchor = initial && state.handle !== 'draw'
        ? { x: state.handle.includes('w') ? initial.x + initial.width : initial.x,
          y: state.handle.includes('n') ? initial.y + initial.height : initial.y } : state.start;
      const next = { x: Math.min(current.x, anchor.x), y: Math.min(current.y, anchor.y),
        width: Math.abs(current.x - anchor.x), height: Math.abs(current.y - anchor.y) };
      if (next.width >= 1 / width && next.height >= 1 / height) onChange(next);
    }
  };
  return <div className="image-layering-dialog__source-stage" ref={container}>
    <img className="image-layering-selection__image" src={url} alt={`分层源图：${label}`} draggable={false} />
    {selecting && <svg className="image-layering-selection__overlay" role="group" aria-label="框选分层范围"
      aria-disabled={disabled} tabIndex={disabled ? -1 : 0} viewBox="0 0 1000 1000" preserveAspectRatio="none"
      style={{ width: imageWidth, height: imageHeight }}
      onPointerDown={event => {
        if (disabled || event.button !== 0 || drag.current) return;
        event.preventDefault(); event.stopPropagation(); event.currentTarget.focus();
        drag.current = { pointerId: event.pointerId, start: point(event), box,
          handle: (event.target as Element).getAttribute('data-handle') ?? 'draw' };
        event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerMove={updateDrag} onPointerUp={event => {
        if (drag.current?.pointerId !== event.pointerId) return;
        updateDrag(event); drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }} onPointerCancel={() => { if (drag.current) onChange(drag.current.box); drag.current = null; }}
      onLostPointerCapture={() => { drag.current = null; }}
      onKeyDown={event => {
        if (disabled) return;
        if (event.key === 'Delete' || event.key === 'Backspace' || event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation(); onChange(null); return;
        }
        if (!box || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const step = event.shiftKey ? 10 : 1;
        onChange({ ...box, x: clamp(box.x + (event.key === 'ArrowLeft' ? -step / width : event.key === 'ArrowRight' ? step / width : 0), 0, 1 - box.width),
          y: clamp(box.y + (event.key === 'ArrowUp' ? -step / height : event.key === 'ArrowDown' ? step / height : 0), 0, 1 - box.height) });
      }}>
      {box && <>
        <path d={`M0,0H1000V1000H0Z M${box.x * 1000},${box.y * 1000}v${box.height * 1000}h${box.width * 1000}v${-box.height * 1000}Z`} fill="rgba(0,0,0,.4)" fillRule="evenodd" pointerEvents="none" />
        <rect data-handle="move" x={box.x * 1000} y={box.y * 1000} width={box.width * 1000} height={box.height * 1000}
          fill="transparent" stroke="var(--gate-accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" style={{ cursor: 'move' }} />
        {(['nw', 'ne', 'se', 'sw'] as const).map(handle => <rect key={handle} data-handle={handle}
          x={(box.x + (handle.includes('e') ? box.width : 0)) * 1000 - 6 * 1000 / Math.max(imageWidth, 1)}
          y={(box.y + (handle.includes('s') ? box.height : 0)) * 1000 - 6 * 1000 / Math.max(imageHeight, 1)}
          width={12 * 1000 / Math.max(imageWidth, 1)} height={12 * 1000 / Math.max(imageHeight, 1)}
          fill="var(--gate-accent)" style={{ cursor: `${handle}-resize` }} />)}
      </>}
    </svg>}
    <div className="image-layering-dialog__source-stage-meta"><span>{selecting ? '拖动框选 · 拖框移动 · 拖角缩放' : '源图预览'}</span><small>原图保留</small></div>
  </div>;
}
