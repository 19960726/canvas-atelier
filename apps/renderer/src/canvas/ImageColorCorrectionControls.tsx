import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Columns2, Palette, RotateCcw, WandSparkles } from 'lucide-react';
import {
  AUTO_IMAGE_COLOR_CORRECTION,
  NANO_BANANA_IMAGE_COLOR_CORRECTION,
  ORIGINAL_IMAGE_COLOR_CORRECTION,
  imageColorCorrectionLabel,
  type ImageColorCorrection,
} from '../app/image-color-correction';

type FloatingPanelPosition = { left: number; top: number; side: 'left' | 'right' | 'overlay' };

function getFloatingPanelPosition(trigger: HTMLElement): FloatingPanelPosition {
  const viewportGutter = 12;
  const panelWidth = Math.min(400, window.innerWidth - viewportGutter * 2);
  const node = trigger.closest<HTMLElement>('[data-module-type="image_generation"]');
  const nodeBounds = node?.getBoundingClientRect() ?? trigger.getBoundingClientRect();
  const triggerBounds = trigger.getBoundingClientRect();
  const roomLeft = nodeBounds.left - viewportGutter;
  const roomRight = window.innerWidth - nodeBounds.right - viewportGutter;
  let side: FloatingPanelPosition['side'];
  let left: number;
  if (roomRight >= panelWidth) {
    side = 'right';
    left = nodeBounds.right + viewportGutter;
  } else if (roomLeft >= panelWidth) {
    side = 'left';
    left = nodeBounds.left - viewportGutter - panelWidth;
  } else {
    side = 'overlay';
    left = Math.max(viewportGutter, Math.min(triggerBounds.left, window.innerWidth - panelWidth - viewportGutter));
  }
  const maxTop = Math.max(viewportGutter, window.innerHeight - 420 - viewportGutter);
  const top = Math.max(viewportGutter, Math.min(triggerBounds.top, maxTop));
  return { left, top, side };
}

export function ImageColorCorrectionControls({
  value,
  comparingOriginal,
  onChange,
  onCompareChange,
  placement = 'node',
  comparisonPresentation = 'toggle',
  analysisStatus,
}: {
  value: ImageColorCorrection;
  comparingOriginal: boolean;
  onChange: (value: ImageColorCorrection) => void;
  onCompareChange: (showOriginal: boolean) => void;
  placement?: 'node' | 'lightbox';
  comparisonPresentation?: 'toggle' | 'split';
  analysisStatus?: 'loading' | 'applied' | 'unchanged' | 'unavailable';
}) {
  const [open, setOpen] = useState(false);
  const [panelPosition, setPanelPosition] = useState<FloatingPanelPosition | null>(null);
  const label = imageColorCorrectionLabel(value);
  const nano = value.mode === 'auto' && value.profile === 'nano-banana';
  const analysisMessage = value.mode !== 'auto' ? undefined : {
    loading: '正在分析图片颜色…',
    applied: nano ? '已减轻检测到的红、紫或黄偏色。请对比产品与场景颜色，按需调整强度。' : '已中和检测到的偏色，可拖动对比线查看效果。',
    unchanged: nano ? (value.strength === 0 ? '强度为 0，当前保留原图颜色。' : '没有足够的红、紫或黄偏色依据，已保留原图。可手动调整色温和洋红绿色。') : '未检测到明显偏色，已保留原图颜色。可使用下方滑块手动调整。',
    unavailable: '暂时无法读取图片颜色，请再次点击校正选项重试。',
  }[analysisStatus ?? 'loading'];
  const statusLabel = value.mode !== 'auto' ? label : `${nano ? 'Nano Banana · ' : ''}${{ loading: '分析中…', applied: '已中和', unchanged: value.strength === 0 ? '强度 0' : '无明显偏色', unavailable: '分析失败' }[analysisStatus ?? 'loading']}`;
  const update = (patch: Partial<ImageColorCorrection>) => onChange({ ...value, ...patch, mode: 'custom' });
  const reset = () => {
    onCompareChange(false);
    onChange(ORIGINAL_IMAGE_COLOR_CORRECTION);
  };

  useEffect(() => {
    if (value.mode === 'original' && comparingOriginal) onCompareChange(false);
  }, [comparingOriginal, onCompareChange, value.mode]);

  const panel = open && <div
    className={`module-node__color-correction-panel${placement === 'node' ? ' module-node__color-correction-panel--floating' : ''}`}
    role="dialog"
    aria-label="图片颜色校正"
    style={placement === 'node' && panelPosition ? { left: panelPosition.left, top: panelPosition.top } : undefined}
  >
    <header><strong>颜色校正</strong><span>预览调整 · 不改原图</span></header>
    <div className="module-node__color-correction-presets">
      <button type="button" className={value.mode === 'original' ? 'is-selected' : ''} onClick={reset}>原图</button>
      <button type="button" className={value.mode === 'auto' && !nano ? 'is-selected' : ''} aria-label="自动中和偏色" onClick={() => { if (comparisonPresentation === 'toggle') onCompareChange(false); onChange({ ...AUTO_IMAGE_COLOR_CORRECTION }); }}><WandSparkles size={13} aria-hidden="true" />自动</button>
      <button type="button" className={nano ? 'is-selected' : ''} aria-label="Nano Banana 去偏色" onClick={() => { if (comparisonPresentation === 'toggle') onCompareChange(false); onChange({ ...NANO_BANANA_IMAGE_COLOR_CORRECTION }); }}>Nano Banana</button>
      <button type="button" className={value.mode === 'custom' ? 'is-selected' : ''} aria-label="自定义颜色校正" onClick={() => { if (comparisonPresentation === 'toggle') onCompareChange(false); onChange({ ...value, mode: 'custom' }); }}>自定义</button>
    </div>
    {analysisMessage && <p className="module-node__color-correction-status" role="status">{analysisMessage}</p>}
    <div className="module-node__color-correction-adjustments-heading"><span>更多调节</span><small>微调色温、饱和度与明暗</small></div>
    <div className="module-node__color-correction-sliders">
      {nano && <label>
        <span>去偏色强度<output>{value.strength ?? 60}%</output></span>
        <input type="range" aria-label="去偏色强度" min={0} max={100} value={value.strength ?? 60} onChange={(event) => {
          if (comparisonPresentation === 'toggle') onCompareChange(false);
          onChange({ ...value, strength: Number(event.target.value) });
        }} />
      </label>}
      {([
        ['temperature', '色温', -30, 30, value.temperature],
        ['tint', '洋红绿色', -30, 30, value.tint],
        ['saturation', '饱和度', 70, 130, value.saturation],
        ['contrast', '对比度', 85, 120, value.contrast],
        ['brightness', '亮度', 85, 120, value.brightness],
      ] as const).map(([key, text, min, max, current]) => (
        <label key={key}>
          <span>{text}<output>{current}</output></span>
          <input type="range" aria-label={text} min={min} max={max} value={current} onChange={(event) => { if (comparisonPresentation === 'toggle') onCompareChange(false); update({ [key]: Number(event.target.value) } as Partial<ImageColorCorrection>); }} />
        </label>
      ))}
    </div>
  </div>;

  return (
    <div
      className={`module-node__color-correction module-node__color-correction--${placement}`}
      data-panel-side={placement === 'node' ? panelPosition?.side : undefined}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="module-node__color-correction-bar">
        <button type="button" className="module-node__color-correction-trigger" aria-label="图片颜色校正" title={`颜色校正 · ${statusLabel}`} aria-expanded={open} onClick={(event) => {
          if (!open && placement === 'node') setPanelPosition(getFloatingPanelPosition(event.currentTarget));
          setOpen((current) => !current);
        }}>
          <Palette size={15} aria-hidden="true" />
          <span>颜色校正</span>
          <small title={analysisMessage}>{statusLabel}</small>
        </button>
        <button
          type="button"
          className="module-node__color-correction-compare"
          aria-label="切换原图对比"
          aria-pressed={comparingOriginal}
          title={comparisonPresentation === 'split'
            ? (comparingOriginal ? '关闭前后对比' : '拖动分割线对比原图与校正后')
            : (comparingOriginal ? '正在查看原图，点击返回校正后' : '点击查看原图')}
          disabled={value.mode === 'original'}
          onClick={() => onCompareChange(!comparingOriginal)}
        ><Columns2 size={14} aria-hidden="true" /><span>{comparisonPresentation === 'split' ? (comparingOriginal ? '关闭对比' : '前后对比') : (comparingOriginal ? '返回校正后' : '原图对比')}</span></button>
        <button type="button" className="module-node__color-correction-reset" aria-label="恢复原图颜色" title="恢复原图颜色" disabled={value.mode === 'original'} onClick={reset}><RotateCcw size={14} aria-hidden="true" /><span>恢复原图</span></button>
      </div>
      {placement === 'node' && panel && panelPosition ? createPortal(
        <div className="module-node__color-correction-portal workspace--canvas-layout">
          {panel}
        </div>,
        document.body,
      ) : panel}
    </div>
  );
}
