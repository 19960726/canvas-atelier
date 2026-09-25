import { useEffect, useState } from 'react';
import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import { Eye, Image, MessageSquare, ScanSearch, Video, WandSparkles } from 'lucide-react';
import { imageModelFamilyDisplayName, imageResolutionFamilyKey } from '../app/image-resolution-routing';


type CatalogCapability = 'image_generation' | 'video_generation' | 'chat' | 'reverse_prompt' | 'vision' | 'video_understanding';

type ProviderModelCatalogProps = {
  readonly profiles: readonly ProviderBridgeProfile[];
  readonly enabledProfileKeys?: readonly string[];
  readonly defaultProfileKeys?: Partial<Record<CatalogCapability, string>>;
  readonly onConfigure?: () => void;
  readonly configureLabel?: string;
  readonly onRetry?: () => void;
  readonly onToggleProfile?: (profile: ProviderBridgeProfile) => void;
  readonly onToggleFamily?: (profiles: readonly ProviderBridgeProfile[], enabled: boolean) => void;
  readonly onDefaultProfileChange?: (capability: CatalogCapability, profileKey: string) => void;
};

const MODEL_GROUPS: readonly {
  readonly capability: CatalogCapability;
  readonly label: string;
  readonly defaultLabel: string;
  readonly Icon: typeof Image;
}[] = [
  { capability: 'image_generation', label: '生图模型', defaultLabel: '生图默认模型', Icon: Image },
  { capability: 'video_generation', label: '视频模型', defaultLabel: '视频默认模型', Icon: Video },
  { capability: 'chat', label: '对话模型', defaultLabel: '对话默认模型', Icon: MessageSquare },
  { capability: 'reverse_prompt', label: '反推模型', defaultLabel: '反推默认模型', Icon: WandSparkles },
  { capability: 'vision', label: '视觉模型', defaultLabel: '视觉默认模型', Icon: Eye },
  { capability: 'video_understanding', label: '视频理解模型', defaultLabel: '视频理解默认模型', Icon: ScanSearch },
];

export function createProviderProfileKey(profile: Pick<ProviderBridgeProfile, 'provider' | 'modelRoute'>): string {
  return `${profile.provider}:${profile.modelRoute}`;
}

export function profilesForCapability(
  profiles: readonly ProviderBridgeProfile[],
  capability: CatalogCapability,
): ProviderBridgeProfile[] {
  return profileFamiliesForCapability(profiles, capability).map((family) => family.profile);
}

function profileFamiliesForCapability(profiles: readonly ProviderBridgeProfile[], capability: CatalogCapability) {
  const visibleProfiles = new Map<string, { profile: ProviderBridgeProfile; members: ProviderBridgeProfile[] }>();
  for (const profile of profiles) {
    if (!profile.capabilities.includes(capability)) continue;
    const visibleName = capability === 'image_generation'
      ? `${profile.provider}:${imageResolutionFamilyKey(profile)}`
      : `${profile.provider}:${profile.displayName.trim().toLocaleLowerCase()}`;
    const family = visibleProfiles.get(visibleName);
    if (family === undefined) visibleProfiles.set(visibleName, { profile, members: [profile] });
    else {
      family.members.push(profile);
      const currentName = family.profile.displayName;
      if ((family.profile.capabilityStatus === 'incomplete' && profile.capabilityStatus !== 'incomplete')
        || (currentName !== imageModelFamilyDisplayName(family.profile) && profile.displayName === imageModelFamilyDisplayName(profile))) {
        family.profile = profile;
      }
    }
  }
  return [...visibleProfiles.values()];
}

export function isProviderProfileCatalogRunnable(profile: ProviderBridgeProfile): boolean {
  return profile.capabilityStatus !== 'incomplete';
}

export function ProviderModelCatalog({
  profiles,
  enabledProfileKeys,
  defaultProfileKeys,
  onConfigure,
  configureLabel = '配置模型密钥',
  onRetry,
  onToggleProfile,
  onToggleFamily,
  onDefaultProfileChange,
}: ProviderModelCatalogProps) {
  const enabled = new Set(enabledProfileKeys ?? profiles
    .filter((profile) => profile.enabled !== false)
    .map(createProviderProfileKey));
  const populatedGroups = MODEL_GROUPS.map((group) => ({
    ...group,
    families: profileFamiliesForCapability(profiles, group.capability),
  })).filter((group) => group.families.length > 0);
  const [activeCapability, setActiveCapability] = useState<CatalogCapability>(() => populatedGroups[0]?.capability ?? 'image_generation');
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (!populatedGroups.some((group) => group.capability === activeCapability)) {
      setActiveCapability(populatedGroups[0]?.capability ?? 'image_generation');
    }
  }, [activeCapability, populatedGroups]);

  if (profiles.length === 0) {
    return <section className="settings-section settings-model-catalog settings-model-catalog--empty" aria-label="模型选择列表">
      <header className="settings-model-catalog__summary">
        <div><strong>模型目录</strong><small>当前供应商尚未加载模型</small></div>
        <span>0 个</span>
      </header>
      <section className="settings-model-catalog__empty-state" role="region" aria-label="模型目录为空">
        <strong>暂未发现可用模型</strong>
        <p>请先保存当前供应商密钥，然后重新检测模型目录。</p>
        <div>
          {onConfigure && <button type="button" onClick={onConfigure}>{configureLabel}</button>}
          {onRetry && <button type="button" onClick={onRetry}>重新检测模型</button>}
        </div>
      </section>
    </section>;
  }

  return <section className="settings-section settings-model-catalog" aria-label="模型选择列表">
    <header className="settings-model-catalog__summary">
      <div><strong>模型目录</strong><small>按用途启用模型并设置默认项</small></div>
      <span>{profileFamiliesForCapability(profiles, 'image_generation').length + profiles.filter((profile) => !profile.capabilities.includes('image_generation')).length} 个模型系列</span>
    </header>
    <nav className="settings-model-tabs" role="tablist" aria-label="模型能力分类">
      {populatedGroups.map((group) => {
        const selected = group.capability === activeCapability;
        return <button key={group.capability} type="button" role="tab" aria-selected={selected} className={selected ? 'is-active' : undefined} onClick={() => { setActiveCapability(group.capability); setQuery(''); }}>
          <group.Icon size={16} strokeWidth={1.8} aria-hidden="true" />
          <span>{group.label}</span>
          <b>{group.families.length}</b>
        </button>;
      })}
    </nav>
    {populatedGroups.filter((group) => group.capability === activeCapability).map((group) => {
      const groupFamilies = group.families;
      const enabledFamilies = groupFamilies.filter((family) => family.members.some((profile) => isProviderProfileCatalogRunnable(profile)
        && enabled.has(createProviderProfileKey(profile))));
      const visibleFamilies = groupFamilies.filter((family) => family.members.some((profile) => `${profile.displayName} ${profile.modelId ?? ''} ${profile.modelRoute}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
      const defaultFamily = enabledFamilies.find((family) => family.members.some((member) => createProviderProfileKey(member) === defaultProfileKeys?.[group.capability]));
      return <section key={group.capability} className="settings-model-group settings-model-group--active" aria-label={group.label} data-capability={group.capability}>
        <header>
          <i aria-hidden="true"><group.Icon size={18} strokeWidth={1.8} /></i>
          <div><strong>{group.label}</strong><small>{groupFamilies.length} 个可用 · {enabledFamilies.length} 个已启用</small></div>
        </header>
        <label className="settings-model-search">
          <span>搜索当前分类</span>
          <input type="search" aria-label="搜索当前分类模型" placeholder="搜索模型名称或 ID" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <div className="settings-model-list" role="list" aria-label={`${group.label}列表`}>
          {visibleFamilies.map(({ profile, members }) => {
            const key = createProviderProfileKey(profile);
            const runnableMembers = members.filter(isProviderProfileCatalogRunnable);
            const runnable = runnableMembers.length > 0;
            const isEnabled = runnable && runnableMembers.every((member) => enabled.has(createProviderProfileKey(member)));
            const isDefault = runnable && members.some((member) => defaultProfileKeys?.[group.capability] === createProviderProfileKey(member));
            const displayName = group.capability === 'image_generation' ? imageModelFamilyDisplayName(profile) : profile.displayName;
            return <article key={key} role="listitem" aria-disabled={!runnable} className={[
              runnable ? (isEnabled ? 'is-enabled' : '') : 'is-incomplete',
              isDefault ? 'is-default' : '',
            ].filter(Boolean).join(' ')}>
              <label className="settings-model-enabled">
                <input
                  type="checkbox"
                  aria-label={`启用 ${displayName}`}
                  checked={isEnabled}
                  disabled={(onToggleFamily === undefined && onToggleProfile === undefined) || !runnable}
                  onChange={() => onToggleFamily ? onToggleFamily(runnableMembers, !isEnabled) : onToggleProfile?.(profile)}
                />
              </label>
              <span className="settings-model-identity">
                <strong>{displayName}</strong>
                <small>{!runnable ? '协议待验证' : isDefault ? '当前默认模型' : '可用于此画布能力'}</small>
              </span>
              {isDefault && <em>默认</em>}
            </article>;
          })}
          {visibleFamilies.length === 0 && <p className="settings-model-no-results">没有匹配的模型，试试其他名称。</p>}
        </div>
        {onDefaultProfileChange && <label className="settings-model-default">
          <span>{group.defaultLabel}</span>
          <select
            aria-label={group.defaultLabel}
            value={defaultFamily ? createProviderProfileKey(defaultFamily.profile) : ''}
            onChange={(event) => onDefaultProfileChange(group.capability, event.target.value)}
          >
            <option value="">未选择默认模型</option>
            {enabledFamilies.map(({ profile }) => {
              const key = createProviderProfileKey(profile);
              return <option key={key} value={key}>{group.capability === 'image_generation' ? imageModelFamilyDisplayName(profile) : profile.displayName}</option>;
            })}
          </select>
        </label>}
      </section>;
    })}
  </section>;
}

export type { CatalogCapability, ProviderModelCatalogProps };
