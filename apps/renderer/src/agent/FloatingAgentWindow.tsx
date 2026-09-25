import { createContext, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { GripHorizontal, Maximize2, Minus, PanelRight, X } from 'lucide-react';

type Geometry = { x: number; y: number; width: number; height: number };
export type AgentWindowPresentationMode = 'floating' | 'docked';
export type AgentWindowControls = {
  readonly mode: AgentWindowPresentationMode;
  readonly minimized: boolean;
  readonly toggleMode: () => void;
  readonly toggleMinimized: () => void;
  readonly close: () => void;
  readonly dragPointerDown: (event: PointerEvent<HTMLElement>) => void;
  readonly dragPointerMove: (event: PointerEvent<HTMLElement>) => void;
  readonly dragPointerEnd: () => void;
  readonly dragKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
};
export const AgentWindowControlsContext = createContext<AgentWindowControls | null>(null);
const STORAGE_KEY = 'novus.agent-window.v1';
const PRESENTATION_MODE_KEY = 'novus.agent-window.presentation.v1';
export function clampAgentWindow(value: Geometry, viewportWidth: number, viewportHeight: number): Geometry {
  const width = Math.min(Math.max(360, value.width), Math.max(1, viewportWidth - 16));
  const height = Math.min(Math.max(440, value.height), Math.max(1, viewportHeight - 16));
  return { x: Math.max(8, Math.min(value.x, viewportWidth - width - 8)), y: Math.max(8, Math.min(value.y, viewportHeight - height - 8)), width, height };
}
function readGeometry(): Geometry {
  let result = { x: window.innerWidth - 464, y: Math.max(72, window.innerHeight - 790), width: 440, height: 720 };
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (saved && typeof saved === 'object' && ['x', 'y', 'width', 'height'].every((key) => typeof (saved as Record<string, unknown>)[key] === 'number' && Number.isFinite((saved as Record<string, unknown>)[key]))) result = saved as Geometry;
  } catch { /* A disabled or malformed preference must not prevent opening chat. */ }
  return clampAgentWindow(result, window.innerWidth, window.innerHeight);
}
function readPresentationMode(): AgentWindowPresentationMode {
  try { return localStorage.getItem(PRESENTATION_MODE_KEY) === 'docked' ? 'docked' : 'floating'; }
  catch { return 'floating'; }
}
const geometryStyle = (value: Geometry): CSSProperties => ({ '--agent-x': `${value.x}px`, '--agent-y': `${value.y}px`, '--agent-width': `${value.width}px`, '--agent-height': `${value.height}px` } as CSSProperties);

export function FloatingAgentWindow({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const [geometry, setGeometry] = useState(readGeometry);
  const [mode, setMode] = useState<AgentWindowPresentationMode>(readPresentationMode);
  const [minimized, setMinimized] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const latest = useRef(geometry);
  const frame = useRef<number | null>(null);
  const gesture = useRef<{ id: number; x: number; y: number; initial: Geometry; resize: boolean } | null>(null);
  const commit = (next: Geometry) => {
    latest.current = next;
    setGeometry(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* Position remains usable for this session. */ }
  };
  useEffect(() => {
    const resize = () => commit(clampAgentWindow(latest.current, window.innerWidth, window.innerHeight));
    window.addEventListener('resize', resize);
    return () => { window.removeEventListener('resize', resize); if (frame.current !== null) cancelAnimationFrame(frame.current); };
  }, []);
  useEffect(() => { if (open) setMinimized(false); }, [open]);
  const begin = (event: PointerEvent<HTMLElement>, resize = false) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault(); event.stopPropagation();
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, initial: latest.current, resize };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const active = gesture.current;
    if (!active || active.id !== event.pointerId) return;
    const dx = event.clientX - active.x, dy = event.clientY - active.y;
    latest.current = clampAgentWindow(active.resize
      ? { ...active.initial, width: active.initial.width + dx, height: active.initial.height + dy }
      : { ...active.initial, x: active.initial.x + dx, y: active.initial.y + dy }, window.innerWidth, window.innerHeight);
    // Move only this surface; do not rerender chat history or the canvas per pointer event.
    if (frame.current === null) frame.current = requestAnimationFrame(() => {
      frame.current = null;
      for (const [key, value] of Object.entries(geometryStyle(latest.current))) panel.current?.style.setProperty(key, String(value));
    });
  };
  const finish = () => {
    if (!gesture.current) return;
    gesture.current = null;
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
    commit(latest.current);
  };
  const toggleMode = () => setMode((current) => {
    const next = current === 'floating' ? 'docked' : 'floating';
    try { localStorage.setItem(PRESENTATION_MODE_KEY, next); } catch { /* Current-session mode still changes if storage is unavailable. */ }
    return next;
  });
  const toggleMinimized = () => setMinimized((current) => !current);
  const dragKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!direction) return;
    event.preventDefault(); event.stopPropagation();
    const step = event.shiftKey ? 40 : 16;
    commit(clampAgentWindow({ ...latest.current, x: latest.current.x + direction[0]!, y: latest.current.y + direction[1]! }, window.innerWidth, window.innerHeight));
  };
  const controls = useMemo(() => ({
    mode,
    minimized,
    toggleMode,
    toggleMinimized,
    close: onClose,
    dragPointerDown: begin,
    dragPointerMove: move,
    dragPointerEnd: finish,
    dragKeyDown,
  } satisfies AgentWindowControls), [mode, minimized, onClose]);
  return <aside ref={panel} className="agent-panel agent-panel--skill-chat agent-panel--floating" data-presentation-mode={mode} data-minimized={minimized} style={geometryStyle(geometry)} aria-label="Novus Agent 工作台" data-canvas-surface="agent" data-testid="agent-panel" hidden={!open}>
    <header className="floating-agent__header" hidden={mode === 'docked' && !minimized}>
      <button type="button" className="floating-agent__drag" aria-label="拖动 Agent 窗口" title="拖动移动 · 方向键微调位置" onPointerDown={begin} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish} onKeyDown={(event) => {
        dragKeyDown(event);
      }}><GripHorizontal size={15} /><strong>Agent 对话</strong></button>
      <button type="button" aria-label={mode === 'docked' ? '切换为浮窗' : '停靠到侧边'} title={mode === 'docked' ? '切换为浮窗' : '停靠到侧边'} data-testid="agent-presentation-toggle" onClick={toggleMode}><PanelRight size={15} /></button>
      <button type="button" aria-label={minimized ? '展开 Agent' : '最小化 Agent'} title={minimized ? '展开' : '最小化'} onClick={toggleMinimized}>{minimized ? <Maximize2 size={15} /> : <Minus size={15} />}</button>
      <button type="button" data-testid="agent-panel-close" aria-label="关闭 Novus Agent" title="关闭" onClick={onClose}><X size={15} /></button>
    </header>
    <div className="floating-agent__content" hidden={minimized}>
      <AgentWindowControlsContext.Provider value={controls}>{children}</AgentWindowControlsContext.Provider>
    </div>
    {!minimized && mode === 'floating' && <button className="floating-agent__resize" type="button" aria-label="调整 Agent 窗口大小" title="拖动调整大小 · 方向键微调" onPointerDown={(event) => begin(event, true)} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish} onKeyDown={(event) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      commit(clampAgentWindow({ ...latest.current, width: latest.current.width + (event.key === 'ArrowRight' ? 16 : event.key === 'ArrowLeft' ? -16 : 0), height: latest.current.height + (event.key === 'ArrowDown' ? 16 : event.key === 'ArrowUp' ? -16 : 0) }, window.innerWidth, window.innerHeight));
    }}>◢</button>}
  </aside>;
}
