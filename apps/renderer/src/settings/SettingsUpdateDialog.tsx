import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';
import { AlertCircle, CheckCircle2, Download, LoaderCircle, RefreshCw, RotateCw, X } from 'lucide-react';
import type { UpdateState } from '@agent-canvas/desktop-core';
import '../styles/settings-update-dialog.css';

interface SettingsUpdateDialogProps {
  state: UpdateState;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  onDownload: () => void;
  onRetry: () => void;
  onRestart: () => void;
}

const clampProgress = (value: number | undefined): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
};

const updateStatusText = (state: UpdateState): string => {
  switch (state.status) {
    case 'checking': return '正在检查更新…';
    case 'available': return `发现新版本 ${state.version ?? ''}`.trim();
    case 'downloading': return `正在下载 ${state.version ?? '新版本'}`;
    case 'ready_to_restart': return `版本 ${state.version ?? ''} 已准备好`.trim();
    case 'error': return '更新暂时不可用';
    case 'idle': return state.message === 'No updates are available.' ? '当前已是最新版本' : '等待检查更新';
    default: return '等待检查更新';
  }
};

export function SettingsUpdateDialog({ state, returnFocusRef, onClose, onDownload, onRetry, onRestart }: SettingsUpdateDialogProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const openerAtMountRef = useRef<HTMLElement | null>(null);
  const progress = clampProgress(state.progress);
  const statusText = updateStatusText(state);
  const hasNotes = state.status !== 'checking' && state.status !== 'idle' && Boolean(state.notes?.trim());
  const StatusIcon = state.status === 'error' ? AlertCircle
    : state.status === 'checking' ? LoaderCircle
      : state.status === 'available' || state.status === 'downloading' ? Download : CheckCircle2;

  useEffect(() => {
    openerAtMountRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    return () => {
      const opener = openerAtMountRef.current;
      const preferred = returnFocusRef?.current;
      const target = preferred && !preferred.hasAttribute('disabled') && preferred.isConnected ? preferred : opener;
      if (target && target.isConnected && !target.hasAttribute('disabled')) target.focus();
    };
  }, [returnFocusRef]);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return <div className="canvas-update-backdrop" role="presentation" onMouseDown={onClose}>
    <section
      className="canvas-update-modal"
      role="dialog"
      aria-modal="true"
      aria-label="应用更新"
      data-update-status={state.status}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
      <header className="canvas-update-header">
        <div>
          <small>桌面版本更新</small>
          <h2>应用更新</h2>
        </div>
        <button ref={closeButtonRef} type="button" className="canvas-update-close" aria-label="关闭更新弹窗" title="关闭更新弹窗" onClick={onClose}><X size={18} /></button>
      </header>
      <div className="canvas-update-body" data-testid="update-dialog-scroll">
        <div className="canvas-update-summary">
          <StatusIcon className={state.status === 'checking' ? 'canvas-update-spinner' : undefined} size={24} aria-hidden="true" />
          <div>
            <p className="canvas-update-status" role="status">{statusText}</p>
            {(state.version ?? state.currentVersion) && <dl className="canvas-update-versions">
              {state.currentVersion && state.version && state.currentVersion !== state.version && <div><dt>当前版本</dt><dd>v{state.currentVersion}</dd></div>}
              <div><dt>{state.version ? '更新版本' : '当前版本'}</dt><dd>v{state.version ?? state.currentVersion}</dd></div>
            </dl>}
          </div>
        </div>
        {state.status === 'downloading' && <div className="canvas-update-progress">
          <progress aria-label="更新下载进度" max={1} value={progress} />
          <span>下载进度 {Math.round(progress * 100)}%</span>
        </div>}
        {hasNotes && <section className="canvas-update-notes" role="region" aria-label="更新说明">
          <header><strong>更新内容</strong><span>本次更新</span></header>
          <p>{state.notes}</p>
        </section>}
        {!hasNotes && state.status === 'available' && <p className="canvas-update-empty-notes">此版本暂无详细更新说明。</p>}
        {state.status === 'error' && <p className="canvas-update-error" role="alert">更新检查失败，请检查网络后重试。</p>}
      </div>
      <footer className="canvas-update-actions">
        <button type="button" className="canvas-update-action" onClick={onClose}>{state.status === 'ready_to_restart' ? '稍后安装' : '稍后'}</button>
        {state.status === 'available' && <button type="button" className="canvas-update-action canvas-update-action--primary" aria-label="下载更新" onClick={onDownload}><Download size={16} />下载更新</button>}
        {state.status === 'ready_to_restart' && <button type="button" className="canvas-update-action canvas-update-action--primary" aria-label="重启并安装" onClick={onRestart}><RotateCw size={16} />重启并安装</button>}
        {state.status === 'error' && <button type="button" className="canvas-update-action canvas-update-action--primary" aria-label="重新检查更新" onClick={onRetry}><RefreshCw size={16} />重新检查</button>}
      </footer>
    </section>
  </div>;
}
