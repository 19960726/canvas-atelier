import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from 'react';
import { ChevronRight, RotateCcw, SlidersHorizontal, Zap } from 'lucide-react';
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
  readonly hideTrigger?: boolean;
  readonly onChange: (value: CodexReasoningEffort) => void;
  readonly onToggle: () => void;
  readonly onClose: () => void;
  readonly onSelectModel: () => void;
  readonly modelPicker?: ReactNode;
  readonly generationKind?: 'image' | 'video';
  readonly onOpenGeneration?: () => void;
  readonly reverseDepth?: {
    readonly value: 'fast' | 'standard' | 'deep';
    readonly disabled?: boolean;
    readonly onChange: (value: 'fast' | 'standard' | 'deep') => void;
  };
}

const reverseDepthOptions = [
  { value: 'fast', label: '快速反推', title: '提取主体、构图、光线和可执行提示词，适合快速尝试' },
  { value: 'standard', label: '标准反推', title: '完整分析并说明关键取舍，适合日常创作' },
  { value: 'deep', label: '深度反推', title: '展开素材证据、空间材质和复现步骤，耗时更长' },
] as const;

export function CodexReasoningPopover({ modelLabel, efforts, value, defaultValue, open, disabled, hideTrigger, onChange, onToggle, onClose, onSelectModel, modelPicker, generationKind, onOpenGeneration, reverseDepth }: CodexReasoningPopoverProps) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  // Catalogs may arrive out of order. Never turn xhigh, max and ultra into aliases.
  const levels = effortOrder.filter((effort) => efforts.includes(effort));
  const fallback = defaultValue && levels.includes(defaultValue) ? defaultValue : levels.includes('medium') ? 'medium' : levels[0];
  const selected = levels.includes(value) ? value : fallback;
  const index = selected ? levels.indexOf(selected) : 0;
  const label = selected ? effortLabels[selected] : '不可用';
  const progress = levels.length > 1 ? index / (levels.length - 1) : 0;
  const ultra = selected === 'ultra';
  const reverseLabel = reverseDepthOptions.find((option) => option.value === reverseDepth?.value)?.label;
  const reverseShortLabel = reverseLabel?.replace('反推', '');
  const triggerLabel = reverseDepth ? `反推强度：${reverseLabel}` : `思考能力：${label}`;

  useEffect(() => {
    if (open) (sliderRef.current ?? popupRef.current?.querySelector<HTMLInputElement>('input[type="search"]'))?.focus({ preventScroll: true });
  }, [open]);

  return <div className="codex-reasoning" data-trigger-hidden={hideTrigger || undefined} data-ultra={ultra || undefined}
    onBlur={(event) => {
      if (open && event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) onClose();
    }}
    onKeyDown={(event) => {
      if (open && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        (triggerRef.current ?? event.currentTarget.parentElement?.querySelector<HTMLButtonElement>('[data-testid="agent-model-trigger"]'))?.focus();
      }
    }}>
    {!hideTrigger && <button ref={triggerRef} type="button" className="codex-reasoning__trigger" aria-label={triggerLabel}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      disabled={disabled || (levels.length === 0 && !reverseDepth)} onClick={onToggle} title={triggerLabel}>
      <Zap size={14} aria-hidden="true" /><span>{reverseDepth ? reverseShortLabel : label}</span>
    </button>}
    {open && <div ref={popupRef} id={id} role="dialog" aria-label={hideTrigger ? '模型设置' : reverseDepth ? '模型与反推强度设置' : '思考能力设置'} className="codex-reasoning__popover" data-density="compact">
      {!hideTrigger && <div className="codex-reasoning__heading">
        <Zap className="codex-reasoning__bolt" size={19} fill="currentColor" aria-hidden="true" />
        <button type="button" className="codex-reasoning__model" aria-label="切换思考模型" onClick={onSelectModel}>
          <span className="codex-reasoning__level">{reverseDepth ? reverseLabel : label}<ChevronRight size={16} aria-hidden="true" /></span>
          <span className="codex-reasoning__model-name" title={modelLabel}>{modelLabel}</span>
        </button>
        <button type="button" className="codex-reasoning__reset" aria-label={reverseDepth ? '恢复默认反推强度' : '恢复默认思考能力'}
          title={reverseDepth ? '恢复默认：标准反推' : `恢复默认：${fallback ? effortLabels[fallback] : '不可用'}`}
          disabled={reverseDepth ? reverseDepth.disabled : !fallback}
          onClick={() => { if (reverseDepth) reverseDepth.onChange('standard'); else if (fallback) onChange(fallback); }}><RotateCcw size={18} aria-hidden="true" /></button>
      </div>}
      {!hideTrigger && (levels.length > 0 || !reverseDepth) && <div className="codex-reasoning__track" style={{ '--reasoning-progress': progress } as CSSProperties}>
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
      </div>}
      {reverseDepth && <div className="codex-reasoning__reverse-depth" role="group" aria-label="反推强度">
        {reverseDepthOptions.map((option) => <button key={option.value} type="button" aria-pressed={reverseDepth.value === option.value}
          disabled={reverseDepth.disabled} title={option.title} className={reverseDepth.value === option.value ? 'is-active' : undefined}
          onClick={() => reverseDepth.onChange(option.value)}>{option.label}</button>)}
      </div>}
      {onOpenGeneration && <button type="button" className="codex-reasoning__generation" aria-label="生成偏好" onClick={onOpenGeneration}>
        <SlidersHorizontal size={14} aria-hidden="true" />
        <span>生成偏好</span>
        <small>{generationKind === 'video' ? '视频工作流' : '图片工作流'}</small>
        <ChevronRight size={14} aria-hidden="true" />
      </button>}
      {modelPicker}
    </div>}
  </div>;
}
