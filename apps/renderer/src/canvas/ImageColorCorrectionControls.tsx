import { useEffect, useState } from 'react';
import { ChevronDown, Eye, Palette, WandSparkles } from 'lucide-react';
import {
  AUTO_IMAGE_COLOR_CORRECTION,
  DEFAULT_IMAGE_COLOR_CORRECTION,
  imageColorCorrectionLabel,
  type ImageColorCorrection,
} from '../app/image-color-correction';

export function ImageColorCorrectionControls({
  value,
  comparingOriginal,
  onChange,
  onCompareChange,
  placement = 'node',
}: {
  value: ImageColorCorrection;
  comparingOriginal: boolean;
  onChange: (value: ImageColorCorrection) => void;
  onCompareChange: (showOriginal: boolean) => void;
  placement?: 'node' | 'lightbox';
}) {
  const [open, setOpen] = useState(false);
  const label = imageColorCorrectionLabel(value);
  const update = (patch: Partial<ImageColorCorrection>) => onChange({ ...value, ...patch, mode: 'custom' });
  const reset = () => {
    onCompareChange(false);
    onChange(DEFAULT_IMAGE_COLOR_CORRECTION);
  };

  useEffect(() => {
    if (value.mode === 'original' && comparingOriginal) onCompareChange(false);
  }, [comparingOriginal, onCompareChange, value.mode]);

  return (
    <div
      className={`module-node__color-correction module-node__color-correction--${placement}`}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="module-node__color-correction-bar">
        <button type="button" className="module-node__color-correction-trigger" aria-label="图片颜色校正" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
          <Palette size={15} aria-hidden="true" />
          <span>颜色校正</span>
          <small>{label}</small>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="module-node__color-correction-compare"
          aria-label="切换原图对比"
          aria-pressed={comparingOriginal}
          title={comparingOriginal ? '正在查看原图，点击返回校正后' : '点击查看原图'}
          disabled={value.mode === 'original'}
          onClick={() => onCompareChange(!comparingOriginal)}
        ><Eye size={14} aria-hidden="true" /><span>{comparingOriginal ? '返回校正后' : '原图对比'}</span></button>
        {value.mode !== 'original' && <button type="button" className="module-node__color-correction-reset" aria-label="恢复原图颜色" title="恢复原图颜色" onClick={reset}>恢复原图</button>}
      </div>
      {open && <div className="module-node__color-correction-panel" role="dialog" aria-label="图片颜色校正">
        <header><strong>颜色校正</strong><span>同步到预览、复制与下载，不覆盖原始文件</span></header>
        <div className="module-node__color-correction-presets">
          <button type="button" className={value.mode === 'original' ? 'is-selected' : ''} onClick={reset}>原图</button>
          <button type="button" className={value.mode === 'auto' ? 'is-selected' : ''} aria-label="自动中和红紫偏色" onClick={() => { onCompareChange(false); onChange(AUTO_IMAGE_COLOR_CORRECTION); }}><WandSparkles size={13} aria-hidden="true" />自动中和</button>
          <button type="button" className={value.mode === 'custom' ? 'is-selected' : ''} aria-label="自定义颜色校正" onClick={() => { onCompareChange(false); onChange({ ...value, mode: 'custom' }); }}>自定义</button>
        </div>
        <div className="module-node__color-correction-sliders">
          {([
            ['temperature', '色温', -30, 30, value.temperature],
            ['tint', '洋红绿色', -30, 30, value.tint],
            ['saturation', '饱和度', 70, 130, value.saturation],
            ['contrast', '对比度', 85, 120, value.contrast],
            ['brightness', '亮度', 85, 120, value.brightness],
          ] as const).map(([key, text, min, max, current]) => (
            <label key={key}>
              <span>{text}<output>{current}</output></span>
              <input type="range" aria-label={text} min={min} max={max} value={current} onChange={(event) => { onCompareChange(false); update({ [key]: Number(event.target.value) } as Partial<ImageColorCorrection>); }} />
            </label>
          ))}
        </div>
      </div>}
    </div>
  );
}
