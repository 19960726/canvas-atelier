import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Copy, Maximize, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { ProjectImageAssetSummary } from '@agent-canvas/desktop-core';
import { ORIGINAL_IMAGE_COLOR_CORRECTION, type ImageColorCorrection } from '../app/image-color-correction';
import { useImageColorCorrectionState } from '../app/use-image-color-correction';
import { queueGeneratedImageForAgent } from '../agent/generated-image-agent-transfer';
import { ImageColorCorrectionControls } from './ImageColorCorrectionControls';
import { ImageColorCorrectionImage } from './ImageColorCorrectionImage';
import { GeneratedImageActionMenu } from './GeneratedImageActionMenu';
import { copyProjectImageToClipboard } from './image-clipboard';

export function ProjectImageLightbox({ asset, colorCorrection, colorCorrectionFilterId, onColorCorrectionChange, index, total, onClose, onPrevious, onNext }: {
  asset: ProjectImageAssetSummary;
  colorCorrection?: ImageColorCorrection;
  colorCorrectionFilterId?: string;
  onColorCorrectionChange?: (value: ImageColorCorrection) => void;
  index: number; total: number;
  onClose(): void; onPrevious(): void; onNext(): void;
}) {
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [mode, setMode] = useState<'fit' | 'manual'>('fit');
  const [natural, setNatural] = useState({ width: asset.width ?? 1, height: asset.height ?? 1 });
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [copyState, setCopyState] = useState('idle');
  const [comparing, setComparing] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const fitScale = useRef(1);
  const drag = useRef<{ pointerId: number; clientX: number; clientY: number; x: number; y: number } | null>(null);
  const width = asset.width ?? natural.width;
  const height = asset.height ?? natural.height;
  const { correction, analysisStatus } = useImageColorCorrectionState(asset.displayUrl, colorCorrection ?? ORIGINAL_IMAGE_COLOR_CORRECTION);
  const hasCorrection = colorCorrection !== undefined && onColorCorrectionChange !== undefined;

  const fit = () => { setMode('fit'); setView({ scale: fitScale.current, x: 0, y: 0 }); };
  const zoom = (scale: number, focalX = 0, focalY = 0) => {
    setMode('manual');
    setView(current => {
      const next = Math.max(Math.min(0.05, fitScale.current), Math.min(8, scale));
      const ratio = next / current.scale;
      return { scale: next, x: focalX - (focalX - current.x) * ratio, y: focalY - (focalY - current.y) * ratio };
    });
  };
  useEffect(() => {
    setMode('fit'); setMenu(null); setCopyState('idle'); setComparing(false); setDragging(false); drag.current = null;
    setNatural({ width: asset.width ?? 1, height: asset.height ?? 1 });
  }, [asset.assetId, asset.width, asset.height]);
  useLayoutEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      fitScale.current = Math.min(8, Math.max(1, rect.width) / Math.max(1, width), Math.max(1, rect.height) / Math.max(1, height));
      if (mode === 'fit') setView({ scale: fitScale.current, x: 0, y: 0 });
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [width, height, mode, asset.assetId]);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  // Wheel is deliberately non-passive so preview zoom never scrolls the canvas.
  const wheelHandler = useRef<(event: WheelEvent) => void>(() => {});
  wheelHandler.current = event => {
    event.preventDefault(); event.stopPropagation();
    const rect = stageRef.current!.getBoundingClientRect();
    zoom(view.scale * (event.deltaY < 0 ? (event.shiftKey ? 1.06 : 1.25) : (event.shiftKey ? 1 / 1.06 : 0.8)), event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2);
  };
  useEffect(() => {
    const stage = stageRef.current;
    const handle = (event: WheelEvent) => wheelHandler.current(event);
    stage?.addEventListener('wheel', handle, { passive: false });
    return () => stage?.removeEventListener('wheel', handle);
  }, []);
  const copy = async () => {
    if (copyState === 'copying') return;
    setCopyState('copying');
    const copied = await copyProjectImageToClipboard(asset, colorCorrection);
    setCopyState(copied ? '图片已复制，可直接粘贴使用' : '复制失败，请检查系统剪贴板权限');
  };
  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null; setDragging(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return createPortal(<div className="generated-image-lightbox immersive-image-preview" role="presentation">
    <section ref={dialogRef} className="generated-image-lightbox__dialog" role="dialog" aria-modal="true" aria-label="Generated image preview" tabIndex={-1}
      onPointerDownCapture={event => { if (!(event.target as Element).closest('.generated-image-action-menu')) setMenu(null); }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (menu) setMenu(null); else onClose(); return; }
        if (event.key === 'Tab') {
          const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input, [tabindex="0"]')].filter(element => element.getBoundingClientRect().width > 0);
          const current = controls.indexOf(document.activeElement as HTMLElement);
          if (event.shiftKey && current <= 0) { event.preventDefault(); controls[controls.length - 1]?.focus(); }
          else if (!event.shiftKey && (current === controls.length - 1 || current === -1)) { event.preventDefault(); controls[0]?.focus(); }
          return;
        }
        if ((event.target as Element).closest('input, textarea, select, [role="menu"]')) return;
        if (['+', '=', 'ArrowUp', '-', 'ArrowDown', '0', '1', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
          event.preventDefault(); event.stopPropagation();
          if (['+', '=', 'ArrowUp'].includes(event.key)) zoom(view.scale * (event.shiftKey ? 1.06 : 1.25));
          else if (['-', 'ArrowDown'].includes(event.key)) zoom(view.scale / (event.shiftKey ? 1.06 : 1.25));
          else if (event.key === '0') fit();
          else if (event.key === '1') { setMode('manual'); setView({ scale: 1, x: 0, y: 0 }); }
          else if (total > 1) { if (event.key === 'ArrowLeft') onPrevious(); else onNext(); }
        }
      }}>
      <header className="immersive-image-preview__tools">
        <span aria-label="图片尺寸">{width > 1 && height > 1 ? width + ' × ' + height + ' px' : '尺寸不可用'}</span>
        <output aria-label="Generated image zoom level">{Math.round(view.scale * 100)}%</output>
        <button type="button" aria-label="原始尺寸 1:1" title="原始尺寸 · 1" onClick={() => { setMode('manual'); setView({ scale: 1, x: 0, y: 0 }); }}>1:1</button>
        <button type="button" aria-label="Reset generated image zoom" title="适应窗口 · 0" onClick={fit}><Maximize size={18} /></button>
        <button type="button" aria-label="复制图片" title="复制图片" disabled={copyState === 'copying'} onClick={() => void copy()}><Copy size={18} /></button>
        <button type="button" aria-label="Close generated image preview" title="关闭 · Esc" onClick={onClose}><X size={21} /></button>
      </header>
      {hasCorrection && <div className="generated-image-lightbox__correction-toolbar">
        <ImageColorCorrectionControls analysisStatus={analysisStatus} value={correction} comparingOriginal={comparing} onChange={onColorCorrectionChange} onCompareChange={setComparing} placement="lightbox" />
      </div>}
      <div ref={stageRef} className="generated-image-lightbox__stage" aria-label="Generated image detail viewer" tabIndex={0}
        data-zoomed={view.scale > fitScale.current + 0.001 ? 'true' : 'false'} data-dragging={dragging ? 'true' : 'false'}
        onDoubleClick={event => {
          if ((event.target as Element).tagName !== 'IMG') return;
          if (mode === 'fit') { setMode('manual'); setView({ scale: 1, x: 0, y: 0 }); } else fit();
        }}
        onPointerDown={event => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          drag.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: view.x, y: view.y };
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setDragging(true);
        }}
        onPointerMove={event => {
          const start = drag.current;
          if (!start || start.pointerId !== event.pointerId) return;
          setMode('manual');
          setView(current => ({ ...current, x: start.x + event.clientX - start.clientX, y: start.y + event.clientY - start.clientY }));
        }}
        onPointerUp={endDrag} onPointerCancel={endDrag}>
        <ImageColorCorrectionImage src={asset.displayUrl} correction={colorCorrection ?? ORIGINAL_IMAGE_COLOR_CORRECTION} comparingOriginal={comparing}
          filterId={colorCorrectionFilterId === undefined ? undefined : colorCorrectionFilterId + '-lightbox'}
          alt={'Generated image ' + (index + 1) + ' full preview'} draggable={false}
          onLoad={event => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          onContextMenu={event => { event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY }); }}
          style={{ width, height, transform: 'translate3d(' + view.x + 'px, ' + view.y + 'px, 0) scale(' + view.scale + ')' }} />
      </div>
      {total > 1 && <nav className="immersive-image-preview__pager" aria-label="图片浏览">
        <button type="button" aria-label="Previous generated image" onClick={onPrevious}><ChevronLeft size={22} /></button>
        <span>{index + 1} / {total}</span>
        <button type="button" aria-label="Next generated image" onClick={onNext}><ChevronRight size={22} /></button>
      </nav>}
      <footer className="immersive-image-preview__hint">
        <span>滚轮缩放 · Shift 精细缩放 · 拖动查看 · ↑↓ 缩放 · Esc 关闭</span>
        <button type="button" aria-label="Zoom out generated image" title="缩小" onClick={() => zoom(view.scale * 0.8)}><ZoomOut size={17} /></button>
        <button type="button" aria-label="Zoom in generated image" title="放大" onClick={() => zoom(view.scale * 1.25)}><ZoomIn size={17} /></button>
      </footer>
      {copyState !== 'idle' && copyState !== 'copying' && <p className="immersive-image-preview__notice" role="status">{copyState}</p>}
      {menu && <GeneratedImageActionMenu asset={asset} colorCorrection={colorCorrection ?? ORIGINAL_IMAGE_COLOR_CORRECTION}
        left={menu.x} top={menu.y} portalTarget={dialogRef.current}
        onSendToAgent={image => { queueGeneratedImageForAgent(image.assetId); onClose(); }}
        onSendToCanvas={onClose} onClose={() => setMenu(null)} />}
    </section>
  </div>, document.body);
}
