import { useState } from 'react';
import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import { X } from 'lucide-react';
import { IMAGE_QUALITY_OPTIONS, imageQualityLabel, normalizeImageQuality, supportsGptImageQuality } from '../app/image-generation-quality';
import { imageModelFamilyDisplayName, imageResolutionFamilyKey, listImageResolutionTiers, resolveImageResolutionRoute, type ImageResolutionTier } from '../app/image-resolution-routing';
import { generationProfiles, type GenerationParameters, type GenerationPreferences } from './generation-preferences';

export function GenerationPreferencesSheet({ value, profiles, onChange, onClose }: {
  value: GenerationPreferences;
  profiles: readonly ProviderBridgeProfile[];
  onChange(value: GenerationPreferences): void;
  onClose(): void;
}) {
  const kind = value.kind;
  const [modelQuery, setModelQuery] = useState('');
  const preference = value[kind];
  const candidates = generationProfiles(profiles, kind);
  const families = new Map<string, { profile: ProviderBridgeProfile; members: ProviderBridgeProfile[] }>();
  for (const candidate of candidates) {
    const key = kind === 'image' ? `${candidate.provider}:${imageResolutionFamilyKey(candidate)}` : candidate.modelRoute;
    const family = families.get(key);
    if (family === undefined) families.set(key, { profile: candidate, members: [candidate] });
    else family.members.push(candidate);
  }
  const displayedCandidates = [...families.values()];
  const query = modelQuery.trim().toLocaleLowerCase();
  const visibleCandidates = query ? displayedCandidates.filter((family) => family.members.some((item) => `${item.displayName} ${item.modelId ?? ''} ${item.modelRoute} ${item.provider}`.toLocaleLowerCase().includes(query))) : displayedCandidates;
  const profile = candidates.find((item) => item.modelRoute === preference.modelRoute);
  const constraints = profile?.constraints?.[kind];
  const imageResolutionOptions = kind === 'image' ? listImageResolutionTiers(candidates, profile) : [];
  const hasGptImageQuality = kind === 'image' && supportsGptImageQuality(profile);
  const parameter = (key: keyof GenerationParameters, next: string) => {
    const route = kind === 'image' && key === 'resolution' && next && profile
      ? resolveImageResolutionRoute(candidates, profile, next as ImageResolutionTier) : undefined;
    onChange({ ...value, [kind]: {
      ...preference,
      ...(route ? { modelRoute: route.modelRoute } : {}),
      parameters: { ...preference.parameters, [key]: next === '' ? undefined : ['outputCount', 'durationSeconds'].includes(key) ? Number(next) : next },
    } });
  };
  const duration = kind === 'video' ? profile?.constraints?.video?.duration : undefined;
  const kindLabel = kind === 'image' ? '图片' : '视频';
  const providerLabel = (provider: string) => provider === 'comfly' ? 'ComfyUI / Comfly' : provider === 'relayme' ? 'RelayMe' : provider === 'julun' ? '聚论' : provider;
  const selectModel = (modelRoute: string) => {
    const selected = candidates.find((candidate) => candidate.modelRoute === modelRoute);
    const sameFamily = kind === 'image' && selected && profile && selected.provider === profile.provider
      && imageResolutionFamilyKey(selected) === imageResolutionFamilyKey(profile);
    const parameters = preference.modelRoute === modelRoute || sameFamily ? preference.parameters : {};
    const routed = kind === 'image' && selected && parameters.resolution
      ? resolveImageResolutionRoute(candidates, selected, parameters.resolution as ImageResolutionTier) : undefined;
    onChange({ ...value, [kind]: { mode: 'fixed', modelRoute: routed?.modelRoute ?? modelRoute, parameters } });
  };
  return <section className="skill-chat-workbench__sheet generation-preferences" data-anchor="composer-footer" role="dialog" aria-label="生成偏好">
    <header><strong>生成偏好</strong><button type="button" aria-label="关闭生成偏好" title="关闭生成偏好" onClick={onClose}><X size={16} /></button></header>
    <div role="tablist" aria-label="生成类型">{(['image', 'video'] as const).map((item) => <button key={item} type="button" role="tab" aria-selected={kind === item} onClick={() => { setModelQuery(''); onChange({ ...value, kind: item }); }}>{item === 'image' ? '图片' : '视频'}</button>)}</div>
    <label>模型选择<select aria-label="生成模型选择方式" value={preference.mode} onChange={(event) => {
      if (event.target.value === 'fixed' && !profile && candidates[0]) selectModel(candidates[0].modelRoute);
      else onChange({ ...value, [kind]: { ...preference, mode: event.target.value as 'auto' | 'fixed' } });
    }}><option value="auto">自动选择</option><option value="fixed" disabled={candidates.length === 0}>固定模型与参数</option></select></label>
    {preference.mode === 'auto'
      ? <p className="generation-preferences__auto-note">由方案推荐可用模型，执行前确认。选择下方模型可切换为固定使用。</p>
      : <>
      <output aria-label="固定生成模型" className="generation-preferences__selection"><small>当前固定 · {kindLabel}</small><strong>{profile ? kind === 'image' ? imageModelFamilyDisplayName(profile) : profile.displayName : '模型不可用，请重新选择'}</strong>{profile && <small>{providerLabel(profile.provider)}{kind === 'video' ? ` · ${profile.modelId ?? profile.modelRoute}` : ''}</small>}</output>
      <details className="generation-preferences__parameter-details"><summary>模型参数 <small>{Object.values(preference.parameters).some((value) => value !== undefined) ? '已自定义' : '使用默认值'}</small></summary><div className="generation-preferences__parameters">
      {([['aspectRatio', '画幅比例', constraints?.aspectRatios], ['resolution', '分辨率', kind === 'image' ? imageResolutionOptions : constraints?.resolutions], ['outputCount', '生成数量', constraints?.outputCounts]] as const).map(([key, label, values]) => values?.length ? <label key={key}>{label}<select aria-label={`固定${label}`} value={preference.parameters[key] ?? ''} onChange={(event) => parameter(key, event.target.value)}><option value="">使用模型默认值</option>{values.map((item) => <option key={item} value={item}>{item}</option>)}</select></label> : null)}
      {hasGptImageQuality && <label>GPT 图片质量<select aria-label="固定 GPT 图片质量" value={normalizeImageQuality(preference.parameters.imageQuality) ?? 'medium'} onChange={(event) => parameter('imageQuality', event.target.value)}>{IMAGE_QUALITY_OPTIONS.map((quality) => <option key={quality} value={quality}>{imageQualityLabel(quality)}</option>)}</select></label>}
      {duration?.mode === 'options' && <label>视频时长<select aria-label="固定视频时长" value={preference.parameters.durationSeconds ?? ''} onChange={(event) => parameter('durationSeconds', event.target.value)}><option value="">使用模型默认值</option>{duration.options.map((item) => <option key={item} value={item}>{item}秒</option>)}</select></label>}
      {duration?.mode === 'range' && <label>视频时长<input aria-label="固定视频时长" type="number" min={duration.min} max={duration.max} step={duration.step} value={preference.parameters.durationSeconds ?? ''} onChange={(event) => parameter('durationSeconds', event.target.value)} /></label>}
    </div></details></>}
    {candidates.length > 0 && <div className="generation-preferences__candidate-picker">
      <div className="generation-preferences__candidates-heading"><strong>选择{kindLabel}模型</strong><span>{visibleCandidates.length} / {displayedCandidates.length}</span></div>
      <input className="generation-preferences__search" type="search" aria-label={`搜索${kindLabel}模型`} placeholder="搜索模型名称、ID 或服务商" value={modelQuery} onChange={(event) => setModelQuery(event.currentTarget.value)} />
      <div className="generation-preferences__candidates" role="list" aria-label={`可用${kindLabel}模型`}>
        {visibleCandidates.map(({ profile: item }) => {
          const selected = preference.mode === 'fixed' && profile && (kind === 'image'
            ? item.provider === profile.provider && imageResolutionFamilyKey(item) === imageResolutionFamilyKey(profile)
            : item.modelRoute === profile.modelRoute);
          const visibleName = kind === 'image' ? imageModelFamilyDisplayName(item) : item.displayName;
          const label = displayedCandidates.filter((candidate) => (kind === 'image' ? imageModelFamilyDisplayName(candidate.profile) : candidate.profile.displayName) === visibleName).length > 1
            ? `${visibleName} · ${providerLabel(item.provider)}` : visibleName;
          return <div key={item.modelRoute} role="listitem"><button type="button" className="generation-preferences__candidate" aria-label={`固定使用 ${label}`} aria-pressed={selected} onClick={() => selectModel(item.modelRoute)}>
            <span className="generation-preferences__candidate-copy"><strong>{visibleName}</strong><small>{providerLabel(item.provider)}{kind === 'video' ? ` · ${item.modelId ?? item.modelRoute}` : ''}</small></span>
            <span className="generation-preferences__candidate-state">{selected ? '已选' : '选择'}</span>
          </button></div>;
        })}
        {visibleCandidates.length === 0 && <p role="status">没有匹配的模型。</p>}
      </div>
    </div>}
    {candidates.length === 0 && <p role="alert">请先在设置中配置{kindLabel}生成模型。</p>}
  </section>;
}
