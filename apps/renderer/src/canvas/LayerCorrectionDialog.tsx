import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/** Portaled so canvas zoom never scales correction controls or pointer coordinates. */
export function LayerCorrectionDialog({ title, busy, onClose, children, className = '' }: {
  title: string; busy: boolean; onClose: () => void; children: ReactNode; className?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const state = useRef({ busy, onClose });
  state.current = { busy, onClose };
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!state.current.busy) state.current.onClose();
      }
      if (event.key === 'Tab') {
        const items = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? [])];
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => { document.removeEventListener('keydown', handleKey, true); previous?.focus(); };
  }, []);
  return createPortal(<div className="layer-correction-backdrop nodrag nopan nowheel" onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
    <div className={`layer-correction-dialog ${className}`} ref={panel} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} aria-busy={busy}>
      <header><div><strong>{title}</strong><span>保持原图大小与位置 · 本地处理</span></div>
        <button type="button" aria-label={`关闭${title}`} disabled={busy} onClick={onClose}><X size={18} /></button></header>
      <div className="layer-correction-dialog__body">{children}</div>
    </div>
  </div>, document.body);
}
