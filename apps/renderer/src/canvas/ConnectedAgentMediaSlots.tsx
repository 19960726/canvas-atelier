import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent } from 'react';
import { ChevronLeft, ChevronRight, Image as ImageIcon, Video } from 'lucide-react';
import { MAX_GENERATION_REFERENCES } from '@agent-canvas/domain';
import { CONNECTED_MEDIA_DRAG_MIME, encodeConnectedMediaDragPayload } from './connected-media-drag';

export interface ConnectedAgentMediaSlotItem {
  readonly edgeId?: string;
  readonly kind: 'image' | 'video';
  readonly assetId: string;
  readonly label: string;
  readonly previewUrl?: string;
}

interface ConnectedAgentMediaSlotsProps {
  readonly ariaLabel: string;
  readonly media: readonly ConnectedAgentMediaSlotItem[];
  readonly title?: string;
  readonly onReorder?: (media: ConnectedAgentMediaSlotItem[]) => void | boolean | Promise<void | boolean>;
  readonly onRemove?: (item: ConnectedAgentMediaSlotItem) => void;
  readonly onPreview?: (item: ConnectedAgentMediaSlotItem, index: number) => void;
  readonly onAdd?: () => void;
  readonly slotRowAriaLabel?: string;
  readonly emptySlotKind?: 'image' | 'video';
  readonly emptySlotAriaLabel?: string;
  readonly showAddPlaceholder?: boolean;
  readonly addAriaLabel?: string;
  readonly preserveOverflow?: boolean;
}

export function ConnectedAgentMediaSlots({
  ariaLabel,
  media,
  title = '已连接素材',
  onReorder,
  onRemove,
  onPreview,
  onAdd,
  slotRowAriaLabel,
  emptySlotKind,
  emptySlotAriaLabel = 'Media reference slot pending',
  showAddPlaceholder = false,
  addAriaLabel = '添加素材',
  preserveOverflow = false,
}: ConnectedAgentMediaSlotsProps) {
  const mediaSignature = media.map((item) => `${item.edgeId ?? ''}:${item.kind}:${item.assetId}`).join('|');
  const mediaPresentationSignature = JSON.stringify(media.map((item) => [item.edgeId, item.kind, item.assetId, item.label, item.previewUrl]));
  const [orderedMedia, setOrderedMedia] = useState(() => preserveOverflow ? [...media] : media.slice(0, MAX_GENERATION_REFERENCES));
  const previousExternalMediaSignature = useRef(mediaSignature);
  const previousPreserveOverflow = useRef(preserveOverflow);
  useEffect(() => {
    const nextMedia = preserveOverflow ? [...media] : media.slice(0, MAX_GENERATION_REFERENCES);
    const externalOrderChanged = previousExternalMediaSignature.current !== mediaSignature
      || previousPreserveOverflow.current !== preserveOverflow;
    previousExternalMediaSignature.current = mediaSignature;
    previousPreserveOverflow.current = preserveOverflow;
    setOrderedMedia((current) => externalOrderChanged
      ? nextMedia
      : hydrateMediaPresentation(current, nextMedia));
  }, [mediaSignature, mediaPresentationSignature, preserveOverflow]);
  const visibleMedia = orderedMedia;
  const hasOverflow = visibleMedia.length > 7;
  const [draggedItemId, setDraggedItemId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [pointerDragIndex, setPointerDragIndex] = useState<number | null>(null);
  const nativeDragActiveRef = useRef(false);
  const latestMedia = useRef(media);
  latestMedia.current = media;
  const reorderSequence = useRef(0);
  const [reorderError, setReorderError] = useState(false);
  const trayRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const cancelPointerDrag = (event: Event) => {
      if (event.type === 'pointerup' && event.target instanceof Element
        && event.target.closest('.connected-agent-media-slots__item')
        && trayRef.current?.contains(event.target)) return;
      setPointerDragIndex(null);
      setDropIndex(null);
    };
    window.addEventListener('pointerup', cancelPointerDrag, true);
    window.addEventListener('pointercancel', cancelPointerDrag, true);
    window.addEventListener('blur', cancelPointerDrag);
    return () => {
      window.removeEventListener('pointerup', cancelPointerDrag, true);
      window.removeEventListener('pointercancel', cancelPointerDrag, true);
      window.removeEventListener('blur', cancelPointerDrag);
    };
  }, []);

  const reorder = (fromIndex: number, toIndex: number) => {
    if (!onReorder || fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= visibleMedia.length || toIndex >= visibleMedia.length) return;
    const next = [...visibleMedia];
    const [item] = next.splice(fromIndex, 1);
    if (!item) return;
    next.splice(toIndex, 0, item);
    setOrderedMedia(next);
    setReorderError(false);
    const sequence = ++reorderSequence.current;
    const rollback = () => {
      if (sequence !== reorderSequence.current) return;
      setOrderedMedia(preserveOverflow ? [...latestMedia.current] : latestMedia.current.slice(0, MAX_GENERATION_REFERENCES));
      setReorderError(true);
    };
    try {
      Promise.resolve(onReorder(next)).then((accepted) => { if (accepted === false) rollback(); }, rollback);
    } catch { rollback(); }
  };
  const finishDrop = (event: DragEvent<HTMLElement>, toIndex: number) => {
    event.preventDefault();
    const fromIndex = visibleMedia.findIndex((item, index) => mediaItemId(item, index) === draggedItemId);
    reorder(fromIndex, Math.min(toIndex, Math.max(0, visibleMedia.length - 1)));
    setDraggedItemId(null);
    setDropIndex(null);
  };
  const stopPointer = (event: PointerEvent<HTMLElement>) => event.stopPropagation();
  const scrollRowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = scrollRowRef.current;
    if (!element) return;
    const scrollSlots = (event: WheelEvent) => {
      if (element.scrollWidth <= element.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      event.stopPropagation();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1);
      element.scrollLeft += delta;
    };
    // React delegates wheel as passive; cancellation needs an explicit native listener.
    element.addEventListener('wheel', scrollSlots, { passive: false });
    return () => element.removeEventListener('wheel', scrollSlots);
  }, []);

  return (
    <section ref={trayRef} className="module-node__agent-media-slots module-node__unified-media-slots connected-agent-media-slots nodrag nopan" aria-label={ariaLabel} onPointerDown={stopPointer}>
      <header><span>{title}</span><b>{visibleMedia.length} / {MAX_GENERATION_REFERENCES}</b></header>
      {reorderError && <span role="alert">换位未保存，已恢复原顺序，请重试。</span>}
      <div
        className="module-node__agent-media-slot-row connected-agent-media-slots__row nowheel"
        aria-label={slotRowAriaLabel}
        data-overflow={hasOverflow ? 'true' : undefined}
        data-layout={visibleMedia.length > 12 ? 'two-rows' : 'single-row'}
        style={{ '--media-columns': Math.max(1, visibleMedia.length > 12 ? Math.ceil(visibleMedia.length / 2) : visibleMedia.length) } as CSSProperties}
        ref={scrollRowRef}
      >
        {visibleMedia.map((item, index) => (
          <div
            key={mediaItemId(item, index)}
            className={`module-node__agent-media-slot connected-agent-media-slots__item is-${item.kind}${dropIndex === index ? ' is-drop-target' : ''}`}
            data-slot-index={index + 1}
            aria-label={`Agent media slot ${index + 1}`}
            title={`${index + 1}. ${item.label}`}
            draggable={onReorder !== undefined}
            onPointerDown={(event) => {
              stopPointer(event);
              nativeDragActiveRef.current = false;
              if (!onReorder || event.button !== 0) return;
              setPointerDragIndex(index);
            }}
            onPointerEnter={() => { if (pointerDragIndex !== null) setDropIndex(index); }}
            onPointerUp={(event) => {
              stopPointer(event);
              if (nativeDragActiveRef.current) return;
              if (pointerDragIndex !== null) reorder(pointerDragIndex, index);
              setPointerDragIndex(null);
              setDropIndex(null);
            }}
            onPointerCancel={() => { setPointerDragIndex(null); setDropIndex(null); }}
            onDragStart={(event) => {
              nativeDragActiveRef.current = true;
              setPointerDragIndex(null);
              const itemId = mediaItemId(item, index);
              if (event.dataTransfer) {
                event.dataTransfer.setData('text/plain', itemId);
                event.dataTransfer.setData(CONNECTED_MEDIA_DRAG_MIME, encodeConnectedMediaDragPayload(item));
                event.dataTransfer.effectAllowed = 'copyMove';
              }
              setDraggedItemId(itemId);
            }}
            onDragEnd={() => { nativeDragActiveRef.current = false; setDraggedItemId(null); setDropIndex(null); }}
            onDragOver={(event) => { event.preventDefault(); setDropIndex(index); }}
            onDrop={(event) => finishDrop(event, index)}
            onDoubleClick={(event) => {
              if (item.kind !== 'image' || !onPreview) return;
              event.preventDefault();
              event.stopPropagation();
              onPreview(item, index);
            }}
          >
            {item.kind === 'image'
              ? item.previewUrl ? <img src={item.previewUrl} alt={item.label} draggable={false} /> : <ImageIcon size={16} aria-hidden="true" />
              : item.previewUrl
                ? <video src={item.previewUrl} aria-label={`${item.label} 视频封面`} draggable={false} muted playsInline preload="metadata" />
                : <Video size={16} aria-hidden="true" />}
            <small className="connected-agent-media-slots__index" aria-label={`图槽编号 ${index + 1}`}>{index + 1}</small>
            {onReorder && (
              <span className="connected-agent-media-slots__reorder" aria-label={`调整第 ${index + 1} 个素材槽位`}>
                <button type="button" className="nodrag nopan" aria-label={`Move ${item.label} left`} disabled={index === 0} onPointerDown={stopPointer} onClick={(event) => { event.stopPropagation(); reorder(index, index - 1); }}><ChevronLeft size={10} /></button>
                <button type="button" className="nodrag nopan" aria-label={`Move ${item.label} right`} disabled={index === visibleMedia.length - 1} onPointerDown={stopPointer} onClick={(event) => { event.stopPropagation(); reorder(index, index + 1); }}><ChevronRight size={10} /></button>
              </span>
            )}
            {onRemove && <button type="button" className="connected-agent-media-slots__remove nodrag nopan" aria-label={`Remove ${item.label}`} onPointerDown={stopPointer} onClick={() => onRemove(item)}>×</button>}
          </div>
        ))}
        {visibleMedia.length === 0 && emptySlotKind && <div className={`module-node__agent-media-slot connected-agent-media-slots__item is-${emptySlotKind}`} aria-label={emptySlotAriaLabel}>
          {emptySlotKind === 'video' ? <Video size={16} aria-hidden="true" /> : <ImageIcon size={16} aria-hidden="true" />}
          <small className="connected-agent-media-slots__index" aria-label="图槽编号 1">1</small>
        </div>}
        {onAdd && <button type="button" className="module-node__agent-media-add nodrag nopan" aria-label={addAriaLabel} disabled={visibleMedia.length >= MAX_GENERATION_REFERENCES} onPointerDown={stopPointer} onClick={onAdd}>+</button>}
        {!onAdd && showAddPlaceholder && <span className="module-node__agent-media-add" aria-hidden="true">+</span>}
      </div>
    </section>
  );
}

function mediaItemId(item: ConnectedAgentMediaSlotItem, index: number): string {
  return item.edgeId ?? `${item.kind}:${item.assetId}:${index}`;
}

function hydrateMediaPresentation(
  current: readonly ConnectedAgentMediaSlotItem[],
  incoming: readonly ConnectedAgentMediaSlotItem[],
): ConnectedAgentMediaSlotItem[] {
  const incomingByIdentity = new Map<string, ConnectedAgentMediaSlotItem[]>();
  for (const item of incoming) {
    const identity = item.edgeId ?? `${item.kind}:${item.assetId}`;
    const matches = incomingByIdentity.get(identity) ?? [];
    matches.push(item);
    incomingByIdentity.set(identity, matches);
  }
  return current.map((item) => {
    const identity = item.edgeId ?? `${item.kind}:${item.assetId}`;
    const matches = incomingByIdentity.get(identity);
    return matches?.shift() ?? item;
  });
}
