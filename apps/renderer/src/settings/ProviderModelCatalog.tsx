import { useEffect, useState } from 'react';
import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import { Eye, Image, MessageSquare, ScanSearch, Video, WandSparkles } from 'lucide-react';
import { dedupeProviderProfilesByVisibleName } from '../app/provider-profiles';


type CatalogCapability = 'image_generation' | 'video_generation' | 'chat' | 'reverse_prompt' | 'vision' | 'video_understanding';

type ProviderModelCatalogProps = {
  readonly profiles: readonly ProviderBridgeProfile[];
  readonly enabledProfileKeys?: readonly string[];
  readonly defaultProfileKeys?: Partial<Record<CatalogCapability, string>>;
  readonly onConfigure?: () => void;
  readonly configureLabel?: string;
  readonly onRetry?: () => void;
  readonly onToggleProfile?: (profile: ProviderBridgeProfile) => void;
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
  return dedupeProviderProfilesByVisibleName(profiles.filter((profile) => profile.capabilities.includes(capability)));
}

export function ProviderModelCatalog({
  profiles,
  enabledProfileKeys,
  defaultProfileKeys,
  onConfigure,
  configureLabel = '配置模型密钥',
  onRetry,
  onToggleProfile,
  onDefaultProfileChange,
}: ProviderModelCatalogProps) {
  const enabled = new Set(enabledProfileKeys ?? profiles.map(createProviderProfileKey));
  const populatedGroups = MODEL_GROUPS.map((group) => ({
    ...group,
    profiles: profilesForCapability(profiles, group.capability),
  })).filter((group) => group.profiles.length > 0);
  const [activeCapability, setActiveCapability] = useState<CatalogCapability>(() => populatedGroups[0]?.capability ?? 'image_generation');
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
      <span>{profiles.length} 个模型 · {enabled.size} 个启用</span>
    </header>
    <nav className="settings-model-tabs" role="tablist" aria-label="模型能力分类">
      {populatedGroups.map((group) => {
        const selected = group.capability === activeCapability;
        return <button key={group.capability} type="button" role="tab" aria-selected={selected} className={selected ? 'is-active' : undefined} onClick={() => setActiveCapability(group.capability)}>
          <group.Icon size={16} strokeWidth={1.8} aria-hidden="true" />
          <span>{group.label}</span>
          <b>{group.profiles.length}</b>
        </button>;
      })}
    </nav>
    {populatedGroups.filter((group) => group.capability === activeCapability).map((group) => {
      const groupProfiles = group.profiles;
      const enabledProfiles = groupProfiles.filter((profile) => enabled.has(createProviderProfileKey(profile)));
      return <section key={group.capability} className="settings-model-group settings-model-group--active" aria-label={group.label} data-capability={group.capability}>
        <header>
          <i aria-hidden="true"><group.Icon size={18} strokeWidth={1.8} /></i>
          <div><strong>{group.label}</strong><small>{groupProfiles.length} 个可用 · {enabledProfiles.length} 个已启用</small></div>
        </header>
        <div className="settings-model-list" role="list" aria-label={`${group.label}列表`}>
          {groupProfiles.map((profile) => {
            const key = createProviderProfileKey(profile);
            const isEnabled = enabled.has(key);
            const isDefault = defaultProfileKeys?.[group.capability] === key;
            return <article key={key} role="listitem" className={isEnabled ? 'is-enabled' : undefined}>
              <label className="settings-model-enabled">
                <input
                  type="checkbox"
                  aria-label={`启用 ${profile.displayName}`}
                  checked={isEnabled}
                  disabled={onToggleProfile === undefined}
                  onChange={() => onToggleProfile?.(profile)}
                />
              </label>
              <span className="settings-model-identity">
                <strong>{profile.displayName}</strong>
                <small>{isDefault ? '当前默认模型' : '可用于此画布能力'}</small>
              </span>
              {isDefault && <em>默认</em>}
            </article>;
          })}
        </div>
        {onDefaultProfileChange && <label className="settings-model-default">
          <span>{group.defaultLabel}</span>
          <select
            aria-label={group.defaultLabel}
            value={defaultProfileKeys?.[group.capability] ?? ''}
            onChange={(event) => onDefaultProfileChange(group.capability, event.target.value)}
          >
            <option value="">未选择默认模型</option>
            {enabledProfiles.map((profile) => {
              const key = createProviderProfileKey(profile);
              return <option key={key} value={key}>{profile.displayName}</option>;
            })}
          </select>
        </label>}
      </section>;
    })}
  </section>;
}

export type { CatalogCapability, ProviderModelCatalogProps };
