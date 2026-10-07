import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent } from 'react';
import { ChevronLeft, ChevronRight, Image as ImageIcon, Plus, Video } from 'lucide-react';
import { MAX_GENERATION_REFERENCES } from '@agent-canvas/domain';
import { CONNECTED_MEDIA_DRAG_MIME, encodeConnectedMediaDragPayload } from './connected-media-drag';

export interface ConnectedAgentMediaSlotItem {
  readonly edgeId?: string;
  readonly kind: 'image' | 'video';
  readonly assetId: string;
  readonly label: string;
  readonly previewUrl?: string;
  readonly width?: number;
  readonly height?: number;
}

interface ConnectedAgentMediaSlotsProps {
  readonly ariaLabel: string;
  readonly operationOwnerKey?: string;
  readonly media: readonly ConnectedAgentMediaSlotItem[];
  readonly title?: string;
  readonly onReorder?: (media: ConnectedAgentMediaSlotItem[]) => void | boolean | Promise<void | boolean>;
  readonly onRemove?: (item: ConnectedAgentMediaSlotItem) => void;
  readonly onPreview?: (item: ConnectedAgentMediaSlotItem, index: number) => void;
  readonly onVisibleMediaChange?: (media: readonly ConnectedAgentMediaSlotItem[]) => void;
  readonly onAdd?: () => void;
  readonly slotRowAriaLabel?: string;
  readonly emptySlotKind?: 'image' | 'video';
  readonly emptySlotAriaLabel?: string;
  readonly showAddPlaceholder?: boolean;
  readonly addAriaLabel?: string;
  readonly addDisabled?: boolean;
  readonly preserveOverflow?: boolean;
}

interface MediaDragSource {
  readonly itemId: string;
  readonly mediaSignature: string;
  readonly preserveOverflow: boolean;
  readonly operationOwnerKey: string;
}

interface PointerMediaDragSource extends MediaDragSource {
  readonly pointerId: number;
}

export function ConnectedAgentMediaSlots({
  ariaLabel,
  operationOwnerKey = '',
  media,
  title = '已连接素材',
  onReorder,
  onRemove,
  onPreview,
  onVisibleMediaChange,
  onAdd,
  slotRowAriaLabel,
  emptySlotKind,
  emptySlotAriaLabel = 'Media reference slot pending',
  showAddPlaceholder = false,
  addAriaLabel = '添加素材',
  addDisabled = false,
  preserveOverflow = false,
}: ConnectedAgentMediaSlotsProps) {
  const mediaSignature = JSON.stringify(media.map(mediaItemIdentity));
  const mediaPresentationSignature = JSON.stringify(media.map((item) => [item.edgeId, item.kind, item.assetId, item.label, item.previewUrl, item.width, item.height]));
  const [orderedMedia, setOrderedMedia] = useState(() => preserveOverflow ? [...media] : media.slice(0, MAX_GENERATION_REFERENCES));
  const previousExternalMediaSignature = useRef(mediaSignature);
  const previousPreserveOverflow = useRef(preserveOverflow);
  const previousOperationOwnerKey = useRef(operationOwnerKey);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const pointerDragSource = useRef<PointerMediaDragSource | null>(null);
  const nativeDragSource = useRef<MediaDragSource | null>(null);
  const nativeDragActiveRef = useRef(false);
  const reorderSequence = useRef(0);
  const [reorderError, setReorderError] = useState(false);
  useEffect(() => {
    const nextMedia = preserveOverflow ? [...media] : media.slice(0, MAX_GENERATION_REFERENCES);
    const externalOrderChanged = previousExternalMediaSignature.current !== mediaSignature
      || previousPreserveOverflow.current !== preserveOverflow
      || previousOperationOwnerKey.current !== operationOwnerKey;
    previousExternalMediaSignature.current = mediaSignature;
    previousPreserveOverflow.current = preserveOverflow;
    previousOperationOwnerKey.current = operationOwnerKey;
    if (externalOrderChanged) {
      pointerDragSource.current = null;
      nativeDragSource.current = null;
      nativeDragActiveRef.current = false;
      setDropIndex(null);
      reorderSequence.current++;
      setReorderError(false);
    }
    setOrderedMedia((current) => externalOrderChanged
      ? nextMedia
      : hydrateMediaPresentation(current, nextMedia));
  }, [mediaSignature, mediaPresentationSignature, preserveOverflow, operationOwnerKey]);
  const visibleMedia = orderedMedia;
  useEffect(() => { onVisibleMediaChange?.(visibleMedia); }, [visibleMedia, onVisibleMediaChange]);
  const { groups: mediaGroups, groupIndexBySlot } = useMemo(() => collectMediaGroups(visibleMedia), [visibleMedia]);
  const hasOverflow = visibleMedia.length > 7;
  const latestMedia = useRef(media);
  latestMedia.current = media;
  const latestOperationOwnerKey = useRef(operationOwnerKey);
  latestOperationOwnerKey.current = operationOwnerKey;
  const trayRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const cancelPointerDrag = (event: Event) => {
      if (event.type !== 'blur' && (!pointerDragSource.current
        || (event as globalThis.PointerEvent).pointerId !== pointerDragSource.current.pointerId)) return;
      if (event.type === 'pointerup' && event.target instanceof Element
        && event.target.closest('.connected-agent-media-slots__item')
        && trayRef.current?.contains(event.target)) return;
      if (event.type === 'blur') {
        nativeDragActiveRef.current = false;
        nativeDragSource.current = null;
      }
      pointerDragSource.current = null;
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
    const fromGroupIndex = groupIndexBySlot[fromIndex]!;
    const toGroupIndex = groupIndexBySlot[toIndex]!;
    if (fromGroupIndex === toGroupIndex) return;
    const nextGroups = [...mediaGroups];
    const [group] = nextGroups.splice(fromGroupIndex, 1);
    if (!group) return;
    nextGroups.splice(toGroupIndex, 0, group);
    const next = nextGroups.flatMap((entry) => entry.items);
    setOrderedMedia(next);
    setReorderError(false);
    const sequence = ++reorderSequence.current;
    const rollback = () => {
      if (sequence !== reorderSequence.current || latestOperationOwnerKey.current !== operationOwnerKey) return;
      setOrderedMedia(preserveOverflow ? [...latestMedia.current] : latestMedia.current.slice(0, MAX_GENERATION_REFERENCES));
      setReorderError(true);
    };
    try {
      Promise.resolve(onReorder(next)).then((accepted) => { if (accepted === false) rollback(); }, rollback);
    } catch { rollback(); }
  };
  const neighboringGroupIndex = (index: number, direction: -1 | 1) => {
    const groupIndex = groupIndexBySlot[index]!;
    return mediaGroups[groupIndex + direction]?.indexes[0] ?? -1;
  };
  const dragSourceIndex = (source: MediaDragSource | null) => {
    if (!source || source.mediaSignature !== mediaSignature || source.preserveOverflow !== preserveOverflow
      || source.operationOwnerKey !== operationOwnerKey) return -1;
    return visibleMedia.findIndex((item, index) => mediaItemId(item, index) === source.itemId);
  };
  const finishDrop = (event: DragEvent<HTMLElement>, toIndex: number) => {
    event.preventDefault();
    const fromIndex = dragSourceIndex(nativeDragSource.current);
    reorder(fromIndex, Math.min(toIndex, Math.max(0, visibleMedia.length - 1)));
    nativeDragActiveRef.current = false;
    nativeDragSource.current = null;
    pointerDragSource.current = null;
    setDropIndex(null);
  };
  const stopPointer = (event: PointerEvent<HTMLElement>) => event.stopPropagation();
  const scrollRowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = scrollRowRef.current;
    if (!element) return;
    const scrollSlots = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
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
    <section ref={trayRef} className="module-node__agent-media-slots module-node__unified-media-slots connected-agent-media-slots nodrag nopan" aria-label={ariaLabel} data-thumbnail-sizing="uniform" onPointerDown={stopPointer} onPointerCancel={stopPointer}>
      <header><span>{title}</span><b>{visibleMedia.length} / {MAX_GENERATION_REFERENCES}</b></header>
      {reorderError && <span role="alert">换位未保存，已恢复原顺序，请重试。</span>}
      <div
        className="module-node__agent-media-slot-row connected-agent-media-slots__row nowheel"
        aria-label={slotRowAriaLabel}
        data-overflow={hasOverflow ? 'true' : undefined}
        data-layout="single-row"
        style={{ '--media-columns': Math.max(1, visibleMedia.length) } as CSSProperties}
        ref={scrollRowRef}
      >
        {visibleMedia.map((item, index) => (
          <div
            key={mediaItemId(item, index)}
            className={`module-node__agent-media-slot connected-agent-media-slots__item is-${item.kind}${dropIndex === index ? ' is-drop-target' : ''}`}
            data-slot-index={index + 1}
            aria-label={`Agent media slot ${index + 1}`}
            title={`${index + 1}. ${item.label}`}
            tabIndex={item.kind === 'image' && onPreview ? 0 : undefined}
            draggable={onReorder !== undefined}
            onPointerDown={(event) => {
              stopPointer(event);
              if (nativeDragActiveRef.current) return;
              if (pointerDragSource.current && pointerDragSource.current.pointerId !== event.pointerId) return;
              if (!onReorder || event.button !== 0) return;
              nativeDragActiveRef.current = false;
              nativeDragSource.current = null;
              pointerDragSource.current = { itemId: mediaItemId(item, index), mediaSignature, preserveOverflow, operationOwnerKey, pointerId: event.pointerId };
            }}
            onPointerEnter={(event) => {
              if (pointerDragSource.current && pointerDragSource.current.pointerId === event.pointerId) setDropIndex(index);
            }}
            onPointerUp={(event) => {
              stopPointer(event);
              if (nativeDragActiveRef.current || !pointerDragSource.current
                || pointerDragSource.current.pointerId !== event.pointerId) return;
              reorder(dragSourceIndex(pointerDragSource.current), index);
              pointerDragSource.current = null;
              setDropIndex(null);
            }}
            onPointerCancel={(event) => {
              if (!pointerDragSource.current || pointerDragSource.current.pointerId !== event.pointerId) return;
              pointerDragSource.current = null;
              setDropIndex(null);
            }}
            onDragStart={(event) => {
              nativeDragActiveRef.current = true;
              pointerDragSource.current = null;
              const itemId = mediaItemId(item, index);
              if (event.dataTransfer) {
                event.dataTransfer.setData('text/plain', itemId);
                event.dataTransfer.setData(CONNECTED_MEDIA_DRAG_MIME, encodeConnectedMediaDragPayload(item));
                event.dataTransfer.effectAllowed = 'copyMove';
              }
              nativeDragSource.current = { itemId, mediaSignature, preserveOverflow, operationOwnerKey };
            }}
            onDragEnd={() => { nativeDragActiveRef.current = false; nativeDragSource.current = null; setDropIndex(null); }}
            onDragOver={(event) => { event.preventDefault(); setDropIndex(index); }}
            onDrop={(event) => finishDrop(event, index)}
            onDoubleClick={(event) => {
              if (item.kind !== 'image' || !onPreview) return;
              if (event.target instanceof Element && event.target.closest('button')) return;
              event.preventDefault();
              event.stopPropagation();
              onPreview(item, index);
            }}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget || item.kind !== 'image' || !onPreview
                || (event.key !== 'Enter' && event.key !== ' ')) return;
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
                <button type="button" className="nodrag nopan" aria-label={`Move ${item.label} left`} title={`Move ${item.label} left`} disabled={neighboringGroupIndex(index, -1) === -1} onPointerDown={stopPointer} onClick={(event) => { event.stopPropagation(); reorder(index, neighboringGroupIndex(index, -1)); }}><ChevronLeft size={10} /></button>
                <button type="button" className="nodrag nopan" aria-label={`Move ${item.label} right`} title={`Move ${item.label} right`} disabled={neighboringGroupIndex(index, 1) === -1} onPointerDown={stopPointer} onClick={(event) => { event.stopPropagation(); reorder(index, neighboringGroupIndex(index, 1)); }}><ChevronRight size={10} /></button>
              </span>
            )}
            {onRemove && <button type="button" className="connected-agent-media-slots__remove nodrag nopan" aria-label={`Remove ${item.label}`} onPointerDown={stopPointer} onClick={() => onRemove(item)}>×</button>}
          </div>
        ))}
        {visibleMedia.length === 0 && emptySlotKind && <div className={`module-node__agent-media-slot connected-agent-media-slots__item is-${emptySlotKind}`} aria-label={emptySlotAriaLabel}>
          {emptySlotKind === 'video' ? <Video size={16} aria-hidden="true" /> : <ImageIcon size={16} aria-hidden="true" />}
          <small className="connected-agent-media-slots__index" aria-label="图槽编号 1">1</small>
        </div>}
        {onAdd && <button type="button" className="module-node__agent-media-add nodrag nopan" aria-label={addAriaLabel} title={addAriaLabel} disabled={addDisabled || visibleMedia.length >= MAX_GENERATION_REFERENCES} onPointerDown={stopPointer} onClick={onAdd}><Plus size={16} aria-hidden="true" /></button>}
        {!onAdd && showAddPlaceholder && <span className="module-node__agent-media-add" aria-hidden="true">+</span>}
      </div>
    </section>
  );
}

function mediaItemId(item: ConnectedAgentMediaSlotItem, index: number): string {
  const identity = mediaItemIdentity(item);
  return item.edgeId === undefined ? `${identity}:${index}` : identity;
}

function mediaItemIdentity(item: ConnectedAgentMediaSlotItem): string {
  return JSON.stringify([item.edgeId ?? null, item.kind, item.assetId]);
}

function collectMediaGroups(media: readonly ConnectedAgentMediaSlotItem[]) {
  const groups: { items: ConnectedAgentMediaSlotItem[]; indexes: number[] }[] = [];
  const groupIndexByIdentity = new Map<string, number>();
  const groupIndexBySlot: number[] = [];
  media.forEach((item, index) => {
    const identity = item.edgeId === undefined ? JSON.stringify(['item', index]) : JSON.stringify(['edge', item.edgeId]);
    let groupIndex = groupIndexByIdentity.get(identity);
    if (groupIndex === undefined) {
      groupIndex = groups.length;
      groups.push({ items: [], indexes: [] });
      groupIndexByIdentity.set(identity, groupIndex);
    }
    const group = groups[groupIndex]!;
    group.items.push(item);
    group.indexes.push(index);
    groupIndexBySlot[index] = groupIndex;
  });
  return { groups, groupIndexBySlot };
}

function hydrateMediaPresentation(
  current: readonly ConnectedAgentMediaSlotItem[],
  incoming: readonly ConnectedAgentMediaSlotItem[],
): ConnectedAgentMediaSlotItem[] {
  const incomingByIdentity = new Map<string, ConnectedAgentMediaSlotItem[]>();
  for (const item of incoming) {
    const identity = mediaItemIdentity(item);
    const matches = incomingByIdentity.get(identity) ?? [];
    matches.push(item);
    incomingByIdentity.set(identity, matches);
  }
  return current.map((item) => {
    const identity = mediaItemIdentity(item);
    const matches = incomingByIdentity.get(identity);
    return matches?.shift() ?? item;
  });
}
