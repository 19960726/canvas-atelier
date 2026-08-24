import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, RectangleHorizontal, RectangleVertical, Scan, Square } from 'lucide-react';

interface GenerationParameterPopoverProps {
  readonly ariaLabel: string;
  readonly value: string;
  readonly options: readonly string[];
  readonly onChange: (value: string) => void;
}

export function AspectRatioPopover(props: GenerationParameterPopoverProps) {
  return <GenerationParameterPopover {...props} layout="ratio-grid" renderIcon={renderAspectRatioIcon} />;
}

export function ClarityPopover(props: GenerationParameterPopoverProps) {
  return <GenerationParameterPopover {...props} layout="clarity-list" />;
}

function GenerationParameterPopover({
  ariaLabel,
  layout,
  onChange,
  options,
  renderIcon,
  value,
}: GenerationParameterPopoverProps & {
  readonly layout: 'ratio-grid' | 'clarity-list';
  readonly renderIcon?: (value: string) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  const [menuCenterOffset, setMenuCenterOffset] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    return () => {
      document.removeEventListener('mousedown', closeOutside);
      document.removeEventListener('keydown', closeEscape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setMenuCenterOffset(null);
      return;
    }
    const updateMenuCenter = () => {
      const root = rootRef.current;
      const trigger = triggerRef.current;
      if (!root || !trigger) return;
      const rootRect = root.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();
      setMenuCenterOffset(triggerRect.left - rootRect.left + triggerRect.width / 2);
    };
    updateMenuCenter();
    window.addEventListener('resize', updateMenuCenter);
    return () => window.removeEventListener('resize', updateMenuCenter);
  }, [layout, open, options.length, value]);

  return <div
    className={`generation-parameter-popover generation-parameter-popover--${layout} nodrag nopan`}
    ref={rootRef}
    onPointerDown={(event) => event.stopPropagation()}
    style={{ position: 'relative', display: 'block' }}
  >
    <button
      ref={triggerRef}
      type="button"
      className="generation-parameter-popover__trigger"
      aria-label={ariaLabel}
      aria-controls={menuId}
      aria-expanded={open}
      aria-haspopup="menu"
      value={value}
      onClick={() => setOpen((current) => !current)}
    >
      {renderIcon?.(value)}
      <span>{normalizeDisplayValue(value)}</span>
      <ChevronDown size={15} aria-hidden="true" />
    </button>
    {open && <div
      id={menuId}
      className="generation-parameter-popover__menu"
      role="menu"
      aria-label={`${ariaLabel} options`}
      data-layout={layout}
      style={menuCenterOffset === null ? undefined : { left: `${menuCenterOffset}px`, right: 'auto', transform: 'translateX(-50%)' }}
    >
      {options.map((option) => {
        const selected = option === value;
        return <button
          key={option}
          type="button"
          className={selected ? 'is-selected' : undefined}
          role="menuitemradio"
          aria-checked={selected}
          aria-label={normalizeDisplayValue(option)}
          onClick={() => {
            onChange(option);
            setOpen(false);
          }}
        >
          {renderIcon?.(option)}
          <span>{normalizeDisplayValue(option)}</span>
          {selected && layout === 'clarity-list' && <Check size={15} aria-hidden="true" data-testid="generation-option-check" />}
        </button>;
      })}
    </div>}
  </div>;
}

function normalizeDisplayValue(value: string): string {
  if (/^\d+p$/i.test(value)) return value.toUpperCase();
  return value === 'Auto' || value === '自由比例' ? 'AUTO' : value;
}

function renderAspectRatioIcon(value: string): ReactNode {
  const displayValue = normalizeDisplayValue(value);
  if (displayValue === 'AUTO') return <Scan size={17} aria-hidden="true" />;
  if (displayValue === '1:1') return <Square size={17} aria-hidden="true" />;
  const [width = 1, height = 1] = displayValue.split(':').map(Number);
  return width >= height
    ? <RectangleHorizontal size={17} aria-hidden="true" />
    : <RectangleVertical size={17} aria-hidden="true" />;
}
