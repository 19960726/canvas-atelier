import { useEffect, useState } from 'react';
import { Database, KeyRound, ShieldCheck, X } from 'lucide-react';
import type {
  GenerationHistoryCapacityBridgeResult,
  ProviderConfigurationStatus,
} from '@agent-canvas/desktop-core';

interface SettingsDrawerProps {
  providerStatus: ProviderConfigurationStatus | null;
  onClose: () => void;
  onProviderStatusChange: (status: ProviderConfigurationStatus) => void;
}

export function SettingsDrawer({
  providerStatus,
  onClose,
  onProviderStatusChange,
}: SettingsDrawerProps) {
  const [token, setToken] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [capacity, setCapacity] = useState<GenerationHistoryCapacityBridgeResult | null>(null);
  const bridge = window.novusDesktop;
  const provider = bridge?.provider;

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
              <strong id="provider-settings-title">模型服务</strong>
              <small>Provider credentials</small>
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

        <section className="settings-section" aria-labelledby="cache-settings-title">
          <header>
            <span><Database size={16} /></span>
            <div>
              <strong id="cache-settings-title">历史与缓存</strong>
              <small>History & cache</small>
            </div>
          </header>
          <dl className="settings-metrics">
            <div><dt>存储位置</dt><dd>应用安全管理</dd></div>
            <div><dt>已使用</dt><dd>{capacity ? formatBytes(capacity.activeBytes + capacity.trashBytes) : '不可用'}</dd></div>
            <div><dt>记录</dt><dd>{capacity ? `${capacity.activeCount + capacity.trashCount}` : '不可用'}</dd></div>
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

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / (1024 ** index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
