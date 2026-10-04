import { useState } from 'react';
import type { ProjectImageAssetSummary } from '@agent-canvas/desktop-core';
import { queueGeneratedImageForAgent } from '../agent/generated-image-agent-transfer';
import { ORIGINAL_IMAGE_COLOR_CORRECTION, type ImageColorCorrection } from '../app/image-color-correction';
import { GeneratedImageActionMenu } from './GeneratedImageActionMenu';
import { ProjectImageLightbox } from './ProjectImageLightbox';
import { ImageColorCorrectionImage } from './ImageColorCorrectionImage';

export function ConnectedImageOutputPreview({ assets, running, corrections, menuOpen, onMenuOpenChange }: { assets: readonly ProjectImageAssetSummary[]; running: boolean; corrections: Record<string, ImageColorCorrection>; menuOpen?: boolean; onMenuOpenChange?: (open: boolean) => void }) {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ index: number; x: number; y: number } | null>(null);
  const preview = previewIndex === null ? undefined : assets[previewIndex];
  const visibleMenu = menuOpen ?? menu !== null;
  const menuAsset = visibleMenu ? assets[menu?.index ?? 0] : undefined;
  const correctionFor = (assetId: string) => corrections[assetId] ?? ORIGINAL_IMAGE_COLOR_CORRECTION;
  const openMenu = (index: number, x: number, y: number) => { setMenu({ index, x, y }); onMenuOpenChange?.(true); };
  const closeMenu = () => { setMenu(null); onMenuOpenChange?.(false); };
  return <section className="module-node__output-preview module-node__connected-image-output nodrag nopan" aria-label="Generated image preview"
    onPointerDown={event => event.stopPropagation()} tabIndex={0}
    onContextMenu={event => { event.preventDefault(); openMenu(0, event.clientX, event.clientY); }}
    onKeyDown={event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); openMenu(0, 0, 0); } }}>
    <header className="module-node__output-heading"><strong>生成结果</strong><span>{running ? '正在生成' : '已完成'}</span></header>
    <div className="module-node__connected-output-images">{assets.map((asset, index) => <button type="button" key={asset.assetId}
      aria-label={`Open connected generated image ${index + 1}`} onDoubleClick={() => setPreviewIndex(index)}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setPreviewIndex(index); } }}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); openMenu(index, event.clientX, event.clientY); }}>
      <ImageColorCorrectionImage src={asset.displayUrl} alt={`Connected generated image ${index + 1}`} correction={correctionFor(asset.assetId)} loading="lazy" decoding="async" draggable={false} />
    </button>)}</div>
    <span>双击预览 · 右键查看更多操作</span>
    {preview !== undefined && <ProjectImageLightbox asset={preview} colorCorrection={correctionFor(preview.assetId)} index={previewIndex!} total={assets.length}
      onClose={() => setPreviewIndex(null)} onPrevious={() => setPreviewIndex((previewIndex! + assets.length - 1) % assets.length)} onNext={() => setPreviewIndex((previewIndex! + 1) % assets.length)} />}
    {menuAsset !== undefined && <GeneratedImageActionMenu asset={menuAsset} colorCorrection={correctionFor(menuAsset.assetId)}
      left={menu?.x ?? 0} top={menu?.y ?? 0} onSendToAgent={asset => queueGeneratedImageForAgent(asset.assetId)} onClose={closeMenu} />}
  </section>;
}
