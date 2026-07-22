import { useEffect, useState } from 'react';
import { BookOpen, Database, KeyRound, Layers3, RefreshCw, Settings2, ShieldCheck, X } from 'lucide-react';
import type {
  GenerationHistoryCapacityBridgeResult,
  ProviderConfigurationStatus,
} from '@agent-canvas/desktop-core';

interface SettingsDrawerProps {
  providerStatus: ProviderConfigurationStatus | null;
  onClose: () => void;
  onProviderStatusChange: (status: ProviderConfigurationStatus) => void;
}

type ConnectionStatus = 'unconfigured' | 'connected' | 'authentication_failed' | 'network_unavailable' | 'service_limited';

export function SettingsDrawer({
  providerStatus,
  onClose,
  onProviderStatusChange,
}: SettingsDrawerProps) {
  const [token, setToken] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<'idle' | 'checking' | ConnectionStatus>('idle');
  const [capacity, setCapacity] = useState<GenerationHistoryCapacityBridgeResult | null>(null);
  const bridge = window.novusDesktop;
  const provider = bridge?.provider as (NonNullable<typeof bridge>['provider'] & {
    checkConnection?: () => Promise<{ readonly status: ConnectionStatus }>;
  }) | undefined;

  useEffect(() => {
    let cancelled = false;
    bridge?.history?.getCapacity()
      .then((result) => {
        if (!cancelled) setCapacity(result);
      })
      .catch(() => {
        if (!cancelled) setCapacity(null);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge?.history]);

  const saveProvider = async () => {
    const normalizedToken = token.trim();
    if (!provider || normalizedToken.length === 0 || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const status = await provider.configure({
        token: normalizedToken,
        ...(passphrase.length > 0 ? { passphrase } : {}),
      });
      setToken('');
      setPassphrase('');
      onProviderStatusChange(status);
      setMessage('API 密钥已保存到系统安全存储');
    } catch {
      setMessage('保存失败，请检查密钥或本机安全存储状态');
    } finally {
      setSaving(false);
    }
  };

  const unlockProvider = async () => {
    if (!provider || passphrase.length === 0 || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const status = await provider.unlock({ passphrase });
      setPassphrase('');
      onProviderStatusChange(status);
      setMessage('模型服务已解锁');
    } catch {
      setMessage('解锁失败，请检查本机保护密码');
    } finally {
      setSaving(false);
    }
  };

  const checkProviderConnection = async () => {
    if (!provider?.checkConnection || connectionState === 'checking') return;
    setConnectionState('checking');
    try {
      const result = await provider.checkConnection();
      setConnectionState(result.status);
    } catch {
      setConnectionState('network_unavailable');
    }
  };

  return (
    <aside className="settings-drawer" aria-label="设置 / Settings" data-testid="settings-drawer">
      <header className="settings-drawer__header">
        <div>
          <strong>设置</strong>
          <span>Settings</span>
        </div>
        <button className="icon-button" type="button" aria-label="关闭设置" title="关闭设置" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className="settings-drawer__body">
        <section className="settings-section" aria-labelledby="provider-settings-title">
          <header>
            <span><KeyRound size={16} /></span>
            <div>
              <strong id="provider-settings-title">模型与 API</strong>
              <small>Models & API</small>
            </div>
            <b data-provider-state={providerStatus?.configured ? 'configured' : 'missing'}>
              {providerStatus?.configured ? (providerStatus.locked ? '已锁定' : '已配置') : '未配置'}
            </b>
          </header>
          <label>
            <span>API 密钥</span>
            <input
              type="password"
              autoComplete="new-password"
              aria-label="API 密钥"
              placeholder={providerStatus?.configured ? '输入新密钥以替换' : '输入 API 密钥'}
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <label>
            <span>本机保护密码 <small>可选</small></span>
            <input
              type="password"
              autoComplete="new-password"
              aria-label="本机保护密码"
              placeholder="仅在系统安全存储不可用时使用"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </label>
          <div className="settings-section__security">
            <ShieldCheck size={14} />
            <span>{formatEncryption(providerStatus)}</span>
          </div>
          <button
            className="settings-section__primary"
            type="button"
            disabled={!provider || token.trim().length === 0 || saving}
            onClick={() => { void saveProvider(); }}
          >
            {saving ? '正在保存…' : '保存密钥'}
          </button>
          <div className="settings-connection-row">
            <button
              className="settings-section__secondary"
              type="button"
              disabled={!provider?.checkConnection || connectionState === 'checking'}
              onClick={() => { void checkProviderConnection(); }}
            >
              <RefreshCw size={14} className={connectionState === 'checking' ? 'is-spinning' : undefined} />
              {connectionState === 'checking' ? '检查中' : '检查连接'}
            </button>
            <span data-connection-state={connectionState}>{connectionLabel(connectionState)}</span>
          </div>
          {providerStatus?.configured && providerStatus.locked && (
            <button
              className="settings-section__secondary"
              type="button"
              disabled={!provider || passphrase.length === 0 || saving}
              onClick={() => { void unlockProvider(); }}
            >
              {saving ? '正在解锁…' : '解锁模型服务'}
            </button>
          )}
          {message && <p role="status">{message}</p>}
        </section>

        <section className="settings-section settings-section--compact" aria-labelledby="model-override-title">
          <header>
            <span><Layers3 size={16} /></span>
            <div><strong id="model-override-title">模型覆盖</strong><small>Model overrides</small></div>
          </header>
          <dl className="settings-metrics">
            <div><dt>生图路线</dt><dd>跟随能力清单</dd></div>
            <div><dt>反推路线</dt><dd>项目冻结版本</dd></div>
          </dl>
        </section>

        <section className="settings-section settings-section--compact" aria-labelledby="cache-settings-title">
          <header>
            <span><Database size={16} /></span>
            <div>
              <strong id="cache-settings-title">存储与缓存</strong>
              <small>Storage & cache</small>
            </div>
          </header>
          <dl className="settings-metrics">
            <div><dt>存储位置</dt><dd>应用安全管理</dd></div>
            <div><dt>活动容量</dt><dd>{capacity ? formatBytes(capacity.activeBytes) : '不可用'}</dd></div>
            <div><dt>回收站</dt><dd>{capacity ? formatBytes(capacity.trashBytes) : '不可用'}</dd></div>
            <div><dt>完整性</dt><dd>{capacity ? `${capacity.missingOrCorruptCount} 条异常` : '不可用'}</dd></div>
          </dl>
          <button className="settings-section__secondary" type="button" disabled={!capacity}>10GB 清理预览</button>
        </section>

        <section className="settings-section settings-section--compact" aria-labelledby="knowledge-settings-title">
          <header>
            <span><BookOpen size={16} /></span>
            <div><strong id="knowledge-settings-title">知识库</strong><small>Knowledge</small></div>
          </header>
          <div className="settings-source-list">
            <span><i aria-hidden="true" />电商详情页知识库</span>
            <span><i aria-hidden="true" />场景 Skill</span>
          </div>
        </section>

        <section className="settings-section settings-section--compact" aria-labelledby="general-settings-title">
          <header>
            <span><Settings2 size={16} /></span>
            <div><strong id="general-settings-title">通用设置</strong><small>General</small></div>
          </header>
          <dl className="settings-metrics">
            <div><dt>界面语言</dt><dd>中文主名</dd></div>
            <div><dt>抽屉行为</dt><dd>单面板覆盖</dd></div>
          </dl>
        </section>
      </div>
    </aside>
  );
}

function formatEncryption(status: ProviderConfigurationStatus | null): string {
  if (!status) return '桌面安全存储不可用';
  if (status.encryption === 'safeStorage') return '由操作系统安全存储加密';
  if (status.encryption === 'passphrase') return status.locked ? '需要本机保护密码解锁' : '已使用本机保护密码加密';
  return '当前系统不支持凭据存储';
}

function connectionLabel(state: 'idle' | 'checking' | ConnectionStatus): string {
  return ({
    idle: '未检查',
    checking: '检查中',
    unconfigured: '未配置',
    connected: '连接成功',
    authentication_failed: '认证失败',
    network_unavailable: '网络不可用',
    service_limited: '服务受限',
  })[state];
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / (1024 ** index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
