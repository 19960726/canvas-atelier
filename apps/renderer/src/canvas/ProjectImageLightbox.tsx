import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Copy, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { ProjectImageAssetSummary } from '@agent-canvas/desktop-core';
import { DEFAULT_IMAGE_COLOR_CORRECTION, imageColorCorrectionFilter, renderImageColorCorrectionBlob, type ImageColorCorrection } from '../app/image-color-correction';
import { ImageColorCorrectionControls } from './ImageColorCorrectionControls';

export async function copyProjectImageToClipboard(asset: ProjectImageAssetSummary, colorCorrection?: ImageColorCorrection): Promise<boolean> {
  try {
    const blob = colorCorrection === undefined
      ? await fetch(asset.displayUrl).then((response) => response.blob())
      : await renderImageColorCorrectionBlob(asset.displayUrl, colorCorrection);
    const nativeWrite = globalThis.window?.novusDesktop?.projectImages.writeClipboardImage;
    if (nativeWrite) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (await nativeWrite(bytes)) return true;
    }
    if (typeof ClipboardItem !== 'undefined' && globalThis.navigator?.clipboard?.write) {
      const mediaType = blob.type || asset.mediaType;
      await globalThis.navigator.clipboard.write([new ClipboardItem({ [mediaType]: blob })]);
      return true;
    }
  } catch {
    // The caller presents one consistent, sanitized failure state.
  }
  return false;
}

export function ProjectImageLightbox({
  asset,
  colorCorrection,
  colorCorrectionFilterId,
  onColorCorrectionChange,
  index,
  total,
  onClose,
  onPrevious,
  onNext,
}: {
  asset: ProjectImageAssetSummary;
  colorCorrection?: ImageColorCorrection;
  colorCorrectionFilterId?: string;
  onColorCorrectionChange?: (value: ImageColorCorrection) => void;
  index: number;
  total: number;
  onClose: () => void;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const [showOriginalForComparison, setShowOriginalForComparison] = useState(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const dragStart = useRef<{ pointerId: number; clientX: number; clientY: number; x: number; y: number } | null>(null);
  const resetView = () => setView({ scale: 1, x: 0, y: 0 });
  const setZoom = (nextScale: number, focalX = 0, focalY = 0) => {
    const clampedScale = Math.min(8, Math.max(1, Math.round(nextScale * 100) / 100));
    setView((current) => {
      if (clampedScale === 1) return { scale: 1, x: 0, y: 0 };
      if (clampedScale === current.scale) return current;
      const ratio = clampedScale / current.scale;
      return {
        scale: clampedScale,
        x: focalX - ((focalX - current.x) * ratio),
        y: focalY - ((focalY - current.y) * ratio),
      };
    });
  };

  useEffect(() => {
    setView({ scale: 1, x: 0, y: 0 });
    setDragging(false);
    setCopyState('idle');
    setShowOriginalForComparison(false);
    dragStart.current = null;
  }, [asset.assetId]);

  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    globalThis.addEventListener('keydown', onKeyDown);
    return () => {
      globalThis.removeEventListener('keydown', onKeyDown);
      restoreFocusRef.current?.focus();
    };
  }, [onClose]);

  const finishDragging = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragStart.current?.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    dragStart.current = null;
    setDragging(false);
  };

  const copyImage = async () => {
    if (copyState === 'copying') return;
    setCopyState('copying');
    const copied = await copyProjectImageToClipboard(asset, colorCorrection);
    setCopyState(copied ? 'copied' : 'failed');
    if (!copied) globalThis.window?.dispatchEvent(new CustomEvent('novus:clipboard-image-error'));
  };

  const dimensionLabel = asset.width === null || asset.height === null
    ? '尺寸不可用'
    : `${asset.width} × ${asset.height} px`;
  const previewColorCorrection = showOriginalForComparison ? DEFAULT_IMAGE_COLOR_CORRECTION : colorCorrection;
  const hasColorCorrectionControls = colorCorrection !== undefined && onColorCorrectionChange !== undefined;
  const dialog = (
    <div className="generated-image-lightbox" role="presentation" onPointerDown={onClose}>
      <section
        ref={dialogRef}
        className={`generated-image-lightbox__dialog${hasColorCorrectionControls ? ' has-color-correction' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Generated image preview"
        tabIndex={-1}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="generated-image-lightbox__header">
          <div><strong>图片细节预览</strong><span>滚轮缩放 · 放大后拖动查看细节</span></div>
          <div className="generated-image-lightbox__header-actions">
            <span className="generated-image-lightbox__dimensions" aria-label="图片尺寸">{dimensionLabel}</span>
            {copyState !== 'idle' && copyState !== 'copying' && (
              <span className={`generated-image-lightbox__copy-status is-${copyState}`} role="status" aria-live="polite">
                {copyState === 'copied' ? '图片已复制，可直接粘贴使用' : '复制失败，请检查系统剪贴板权限'}
              </span>
            )}
            <button type="button" className="generated-image-lightbox__copy" aria-label="复制图片" disabled={copyState === 'copying'} onClick={() => { void copyImage(); }}>
              <Copy aria-hidden="true" size={17} /><span>{copyState === 'copying' ? '复制中…' : '复制图片'}</span>
            </button>
            <button type="button" aria-label="Close generated image preview" onClick={onClose}><X aria-hidden="true" size={18} /></button>
          </div>
        </header>
        {hasColorCorrectionControls && <div className="generated-image-lightbox__correction-toolbar">
          <ImageColorCorrectionControls
            value={colorCorrection}
            comparingOriginal={showOriginalForComparison}
            onChange={onColorCorrectionChange}
            onCompareChange={setShowOriginalForComparison}
            placement="lightbox"
          />
        </div>}
        <div
          className="generated-image-lightbox__stage"
          aria-label="Generated image detail viewer"
          data-zoomed={view.scale > 1 ? 'true' : 'false'}
          data-dragging={dragging ? 'true' : 'false'}
          tabIndex={0}
          onWheel={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            const focalX = event.clientX - rect.left - (rect.width / 2);
            const focalY = event.clientY - rect.top - (rect.height / 2);
            setZoom(view.scale * (event.deltaY < 0 ? 1.25 : 0.8), focalX, focalY);
          }}
          onPointerDown={(event) => {
            if (view.scale <= 1 || event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.setPointerCapture?.(event.pointerId);
            dragStart.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: view.x, y: view.y };
            setDragging(true);
          }}
          onPointerMove={(event) => {
            const start = dragStart.current;
            if (start === null || start.pointerId !== event.pointerId) return;
            setView((current) => ({ ...current, x: start.x + event.clientX - start.clientX, y: start.y + event.clientY - start.clientY }));
          }}
          onPointerUp={finishDragging}
          onPointerCancel={finishDragging}
          onKeyDown={(event) => {
            if (event.key === '+' || event.key === '=') {
              event.preventDefault();
              setZoom(view.scale * 1.25);
            } else if (event.key === '-') {
              event.preventDefault();
              setZoom(view.scale * 0.8);
            } else if (event.key === '0') {
              event.preventDefault();
              resetView();
            }
          }}
        >
          <img
            src={asset.displayUrl}
            alt={`Generated image ${index + 1} full preview`}
            draggable={false}
            style={{
              filter: previewColorCorrection === undefined ? undefined : imageColorCorrectionFilter(previewColorCorrection, colorCorrectionFilterId),
              transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`,
            }}
          />
        </div>
        <footer className="generated-image-lightbox__footer">
          <div className="generated-image-lightbox__pager">
            <button type="button" aria-label="Previous generated image" disabled={total < 2} onClick={onPrevious}><ChevronLeft aria-hidden="true" size={20} /></button>
            <span>{index + 1} / {total}</span>
            <button type="button" aria-label="Next generated image" disabled={total < 2} onClick={onNext}><ChevronRight aria-hidden="true" size={20} /></button>
          </div>
          <div className="generated-image-lightbox__zoom-controls">
            <button type="button" aria-label="Zoom out generated image" disabled={view.scale <= 1} onClick={() => setZoom(view.scale * 0.8)}><ZoomOut aria-hidden="true" size={18} /></button>
            <output aria-label="Generated image zoom level">{Math.round(view.scale * 100)}%</output>
            <button type="button" aria-label="Zoom in generated image" disabled={view.scale >= 8} onClick={() => setZoom(view.scale * 1.25)}><ZoomIn aria-hidden="true" size={18} /></button>
            <button type="button" aria-label="Reset generated image zoom" disabled={view.scale === 1 && view.x === 0 && view.y === 0} onClick={resetView}><RotateCcw aria-hidden="true" size={17} /></button>
          </div>
        </footer>
      </section>
    </div>
  );
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}
