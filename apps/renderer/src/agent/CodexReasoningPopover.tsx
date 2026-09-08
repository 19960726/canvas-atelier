import { useEffect, useId, useRef, type CSSProperties } from 'react';
import { ChevronDown, ChevronRight, RotateCcw, Zap } from 'lucide-react';
import type { CodexReasoningEffort } from '@agent-canvas/desktop-core';

const effortLabels: Record<CodexReasoningEffort, string> = {
  low: '轻度', medium: '中', high: '高', xhigh: '极高', max: 'Max', ultra: 'Ultra',
};
const effortOrder = Object.keys(effortLabels) as CodexReasoningEffort[];

interface CodexReasoningPopoverProps {
  readonly modelLabel: string;
  readonly efforts: readonly CodexReasoningEffort[];
  readonly value: CodexReasoningEffort;
  readonly defaultValue?: CodexReasoningEffort;
  readonly open: boolean;
  readonly disabled?: boolean;
  readonly onChange: (value: CodexReasoningEffort) => void;
  readonly onToggle: () => void;
  readonly onClose: () => void;
  readonly onSelectModel: () => void;
}

export function CodexReasoningPopover({ modelLabel, efforts, value, defaultValue, open, disabled, onChange, onToggle, onClose, onSelectModel }: CodexReasoningPopoverProps) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  // Catalogs may arrive out of order. Never turn xhigh, max and ultra into aliases.
  const levels = effortOrder.filter((effort) => efforts.includes(effort));
  const fallback = defaultValue && levels.includes(defaultValue) ? defaultValue : levels.includes('medium') ? 'medium' : levels[0];
  const selected = levels.includes(value) ? value : fallback;
  const index = selected ? levels.indexOf(selected) : 0;
  const label = selected ? effortLabels[selected] : '不可用';
  const progress = levels.length > 1 ? index / (levels.length - 1) : 0;
  const ultra = selected === 'ultra';

  useEffect(() => {
    if (open) sliderRef.current?.focus({ preventScroll: true });
  }, [open]);

  return <div className="codex-reasoning" data-ultra={ultra || undefined}
    onBlur={(event) => {
      if (open && event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) onClose();
    }}
    onKeyDown={(event) => {
      if (open && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        triggerRef.current?.focus();
      }
    }}>
    <button ref={triggerRef} type="button" className="codex-reasoning__trigger" aria-label={`思考能力：${label}`}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      disabled={disabled || levels.length === 0} onClick={onToggle} title={`思考能力：${label}`}>
      <Zap size={14} aria-hidden="true" /><span>{label}</span><ChevronDown size={13} aria-hidden="true" />
    </button>
    {open && <div id={id} role="dialog" aria-label="思考能力设置" className="codex-reasoning__popover">
      <div className="codex-reasoning__heading">
        <Zap className="codex-reasoning__bolt" size={19} fill="currentColor" aria-hidden="true" />
        <button type="button" className="codex-reasoning__model" aria-label="切换思考模型" onClick={onSelectModel}>
          <span className="codex-reasoning__level">{label}<ChevronRight size={16} aria-hidden="true" /></span>
          <span className="codex-reasoning__model-name" title={modelLabel}>{modelLabel}</span>
        </button>
        <button type="button" className="codex-reasoning__reset" aria-label="恢复默认思考能力"
          title={`恢复默认：${fallback ? effortLabels[fallback] : '不可用'}`} disabled={!fallback}
          onClick={() => { if (fallback) onChange(fallback); }}><RotateCcw size={18} aria-hidden="true" /></button>
      </div>
      <div className="codex-reasoning__track" style={{ '--reasoning-progress': progress } as CSSProperties}>
        <div className="codex-reasoning__fill" data-empty={index === 0 || undefined} aria-hidden="true" />
        <div className="codex-reasoning__stops" aria-hidden="true">
          {levels.map((effort, stop) => <span key={effort} data-filled={stop < index || undefined} />)}
        </div>
        <input ref={sliderRef} type="range" min={0} max={Math.max(0, levels.length - 1)} step={1} value={index}
          aria-label="思考能力" aria-valuetext={label} disabled={levels.length < 2}
          onChange={(event) => {
            const effort = levels[Number(event.currentTarget.value)];
            if (effort) onChange(effort);
          }} />
      </div>
    </div>}
  </div>;
}
