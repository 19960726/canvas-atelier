import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import { dedupeProviderProfilesByVisibleName } from '../app/provider-profiles';


type CatalogCapability = 'image_generation' | 'video_generation' | 'chat' | 'reverse_prompt' | 'vision' | 'video_understanding';

type ProviderModelCatalogProps = {
  readonly profiles: readonly ProviderBridgeProfile[];
  readonly enabledProfileKeys?: readonly string[];
  readonly defaultProfileKeys?: Partial<Record<CatalogCapability, string>>;
  readonly onConfigure?: () => void;
  readonly onRetry?: () => void;
  readonly onToggleProfile?: (profile: ProviderBridgeProfile) => void;
  readonly onDefaultProfileChange?: (capability: CatalogCapability, profileKey: string) => void;
};

const MODEL_GROUPS: readonly {
  readonly capability: CatalogCapability;
  readonly label: string;
  readonly defaultLabel: string;
}[] = [
  { capability: 'image_generation', label: '生图模型', defaultLabel: '生图默认模型' },
  { capability: 'video_generation', label: '视频模型', defaultLabel: '视频默认模型' },
  { capability: 'chat', label: '对话模型', defaultLabel: '对话默认模型' },
  { capability: 'reverse_prompt', label: '反推模型', defaultLabel: '反推默认模型' },
  { capability: 'vision', label: '视觉模型', defaultLabel: '视觉默认模型' },
  { capability: 'video_understanding', label: '视频理解模型', defaultLabel: '视频理解默认模型' },
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
  onRetry,
  onToggleProfile,
  onDefaultProfileChange,
}: ProviderModelCatalogProps) {
  const enabled = new Set(enabledProfileKeys ?? profiles.map(createProviderProfileKey));
  const populatedGroups = MODEL_GROUPS.map((group) => ({
    ...group,
    profiles: profilesForCapability(profiles, group.capability),
  })).filter((group) => group.profiles.length > 0);

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
          {onConfigure && <button type="button" onClick={onConfigure}>配置模型密钥</button>}
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
    {populatedGroups.map((group) => {
      const groupProfiles = group.profiles;
      const enabledProfiles = groupProfiles.filter((profile) => enabled.has(createProviderProfileKey(profile)));
      return <section key={group.capability} className="settings-model-group" aria-label={group.label}>
        <header>
          <div><strong>{group.label}</strong><small>{groupProfiles.length} 个已配置，{enabledProfiles.length} 个已启用</small></div>
        </header>
        <div className="settings-model-list" role="list" aria-label={`${group.label}列表`}>
          {groupProfiles.map((profile) => {
            const key = createProviderProfileKey(profile);
            const isEnabled = enabled.has(key);
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
              </span>
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
