import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import { X } from 'lucide-react';
import { IMAGE_QUALITY_OPTIONS, imageQualityLabel, normalizeImageQuality, supportsGptImageQuality } from '../app/image-generation-quality';
import { generationProfiles, type GenerationParameters, type GenerationPreferences } from './generation-preferences';

export function GenerationPreferencesSheet({ value, profiles, onChange, onClose }: {
  value: GenerationPreferences;
  profiles: readonly ProviderBridgeProfile[];
  onChange(value: GenerationPreferences): void;
  onClose(): void;
}) {
  const kind = value.kind;
  const preference = value[kind];
  const candidates = generationProfiles(profiles, kind);
  const profile = candidates.find((item) => item.modelRoute === preference.modelRoute);
  const constraints = profile?.constraints?.[kind];
  const hasGptImageQuality = kind === 'image' && supportsGptImageQuality(profile);
  const parameter = (key: keyof GenerationParameters, next: string) => onChange({ ...value, [kind]: { ...preference, parameters: { ...preference.parameters, [key]: next === '' ? undefined : ['outputCount', 'durationSeconds'].includes(key) ? Number(next) : next } } });
  const duration = kind === 'video' ? profile?.constraints?.video?.duration : undefined;
  return <section className="skill-chat-workbench__sheet generation-preferences" data-anchor="composer-footer" role="dialog" aria-label="生成偏好">
    <header><strong>生成偏好</strong><button type="button" aria-label="关闭生成偏好" title="关闭生成偏好" onClick={onClose}><X size={16} /></button></header>
    <div role="tablist" aria-label="生成类型">{(['image', 'video'] as const).map((item) => <button key={item} type="button" role="tab" aria-selected={kind === item} onClick={() => onChange({ ...value, kind: item })}>{item === 'image' ? '图片' : '视频'}</button>)}</div>
    <label>模型选择<select aria-label="生成模型选择方式" value={preference.mode} onChange={(event) => onChange({ ...value, [kind]: { ...preference, mode: event.target.value as 'auto' | 'fixed', modelRoute: preference.modelRoute ?? candidates[0]?.modelRoute } })}><option value="auto">自动选择</option><option value="fixed" disabled={candidates.length === 0}>固定模型与参数</option></select></label>
    {preference.mode === 'auto' ? <p>由方案选择可用的{kind === 'image' ? '图片' : '视频'}模型，执行前展示模型供确认。</p> : <>
      <label>生成模型<select aria-label="固定生成模型" value={preference.modelRoute ?? ''} onChange={(event) => onChange({ ...value, [kind]: { mode: 'fixed', modelRoute: event.target.value, parameters: {} } })}>
        {!profile && <option value={preference.modelRoute ?? ''}>请选择可用模型</option>}{candidates.map((item) => <option key={item.modelRoute} value={item.modelRoute}>{item.displayName}</option>)}
      </select></label>
      {([['aspectRatio', '画幅比例', constraints?.aspectRatios], ['resolution', '分辨率', constraints?.resolutions], ['outputCount', '生成数量', constraints?.outputCounts]] as const).map(([key, label, values]) => values?.length ? <label key={key}>{label}<select aria-label={`固定${label}`} value={preference.parameters[key] ?? ''} onChange={(event) => parameter(key, event.target.value)}><option value="">使用模型默认值</option>{values.map((item) => <option key={item} value={item}>{item}</option>)}</select></label> : null)}
      {hasGptImageQuality && <label>GPT 图片质量<select aria-label="固定 GPT 图片质量" value={normalizeImageQuality(preference.parameters.imageQuality) ?? 'medium'} onChange={(event) => parameter('imageQuality', event.target.value)}>{IMAGE_QUALITY_OPTIONS.map((quality) => <option key={quality} value={quality}>{imageQualityLabel(quality)}</option>)}</select></label>}
      {duration?.mode === 'options' && <label>视频时长<select aria-label="固定视频时长" value={preference.parameters.durationSeconds ?? ''} onChange={(event) => parameter('durationSeconds', event.target.value)}><option value="">使用模型默认值</option>{duration.options.map((item) => <option key={item} value={item}>{item}秒</option>)}</select></label>}
      {duration?.mode === 'range' && <label>视频时长<input aria-label="固定视频时长" type="number" min={duration.min} max={duration.max} step={duration.step} value={preference.parameters.durationSeconds ?? ''} onChange={(event) => parameter('durationSeconds', event.target.value)} /></label>}
    </>}
    {candidates.length === 0 && <p role="alert">请先在设置中配置{kind === 'image' ? '图片' : '视频'}生成模型。</p>}
  </section>;
}
