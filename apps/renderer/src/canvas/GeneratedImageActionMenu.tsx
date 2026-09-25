import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Download, Image as ImageIcon, Images, Send } from 'lucide-react';
import type { ProjectImageAssetSummary } from '@agent-canvas/desktop-core';
import { getActiveProjectSessionId } from '../app/desktop-persistence';
import { getPhotoshopImportAvailability, importGeneratedImageToPhotoshop, photoshopImportMessage } from '../app/photoshop-import';
import { renderImageColorCorrectionBlob, type ImageColorCorrection } from '../app/image-color-correction';
import { copyProjectImageToClipboard } from './image-clipboard';
export function GeneratedImageActionMenu({
  asset,
  colorCorrection,
  left,
  top,
  onSendToAgent,
  onClose,
  onSendToCanvas,
  portalTarget,
}: {
  asset: ProjectImageAssetSummary;
  colorCorrection: ImageColorCorrection;
  left: number;
  top: number;
  onSendToAgent: (asset: ProjectImageAssetSummary) => void;
  onClose: () => void;
  onSendToCanvas?: () => void;
  portalTarget?: HTMLElement | null;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [position, setPosition] = useState({ left, top });
  useLayoutEffect(() => {
    const box = menuRef.current?.getBoundingClientRect();
    if (box) setPosition({ left: Math.max(8, Math.min(left, innerWidth - box.width - 8)), top: Math.max(8, Math.min(top, innerHeight - box.height - 8)) });
  }, [left, top]);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const dismiss = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) closeRef.current(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeRef.current(); } };
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('pointerdown', dismiss, true); window.removeEventListener('keydown', escape, true); if (opener?.isConnected) opener.focus(); };
  }, []);
  const [photoshopBusy, setPhotoshopBusy] = useState(false);
  const [photoshopResult, setPhotoshopResult] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
  const [copyError, setCopyError] = useState(false);
  const [downloadError, setDownloadError] = useState(false);
  const photoshopAvailability = getPhotoshopImportAvailability(asset, getActiveProjectSessionId());
  const copyImage = async () => {
    const copied = await copyProjectImageToClipboard(asset, colorCorrection);
    if (copied) {
      onClose();
      return;
    }
    setCopyError(true);
    window.dispatchEvent(new CustomEvent('novus:clipboard-image-error'));
  };
  const downloadImage = async () => {
    if (colorCorrection.mode === 'original') {
      const link = document.createElement('a');
      link.href = asset.displayUrl;
      link.download = `${asset.label || 'generated-image'}.${asset.extension}`;
      link.click();
      onClose();
      return;
    }
    try {
      const blob = await renderImageColorCorrectionBlob(asset.displayUrl, colorCorrection);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${asset.label || 'generated-image'}-corrected.png`;
      link.click();
      URL.revokeObjectURL(url);
      onClose();
    } catch {
      setDownloadError(true);
    }
  };
  const importToPhotoshop = async () => {
    if (photoshopBusy || !photoshopAvailability.available) return;
    setPhotoshopBusy(true);
    setPhotoshopResult(null);
    const result = await importGeneratedImageToPhotoshop(asset, getActiveProjectSessionId(), colorCorrection);
    setPhotoshopBusy(false);
    setPhotoshopResult({
      kind: result.ok ? 'success' : 'error',
      message: photoshopImportMessage(result),
    });
  };
  const menu = (
    <div ref={menuRef} className="generated-image-action-menu" role="menu" aria-label="Generated image actions" style={position} onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }}>
      <strong>图片操作</strong>
      <button type="button" role="menuitem" className="is-featured" onClick={() => { onSendToAgent(asset); onClose(); }}><Send aria-hidden="true" size={17} />发送到 AI 对话</button>
      <button type="button" role="menuitem" onClick={() => {
        window.dispatchEvent(new CustomEvent('novus:generated-image-to-canvas', { detail: { assetId: asset.assetId } }));
        onClose();
        onSendToCanvas?.();
      }}><Images aria-hidden="true" size={17} />发送到画布</button>
      <button
        type="button"
        role="menuitem"
        disabled={photoshopBusy || !photoshopAvailability.available}
        title={photoshopAvailability.available ? undefined : photoshopImportMessage({ ok: false, code: photoshopAvailability.code ?? 'desktop_bridge_unavailable' })}
        onClick={() => { void importToPhotoshop(); }}
      >
        <ImageIcon aria-hidden="true" size={17} />
        {photoshopBusy ? '正在导入…' : '导入 Photoshop（智能对象）'}
      </button>
      <button type="button" role="menuitem" onClick={() => { void copyImage(); }}><Copy aria-hidden="true" size={17} />复制图片</button>
      <button type="button" role="menuitem" onClick={() => { void downloadImage(); }}><Download aria-hidden="true" size={17} />下载图片</button>
      {photoshopResult !== null && (
        <p className={`generated-image-action-menu__notice is-${photoshopResult.kind}`} role={photoshopResult.kind === 'success' ? 'status' : 'alert'}>
          {photoshopResult.message}
        </p>
      )}
      {copyError && <p className="generated-image-action-menu__notice is-error" role="alert">无法复制图片，请检查系统剪贴板权限</p>}
      {downloadError && <p className="generated-image-action-menu__notice is-error" role="alert">图片下载失败，请重试。</p>}
    </div>
  );
  return typeof document === 'undefined' ? menu : createPortal(menu, portalTarget ?? document.body);
}
