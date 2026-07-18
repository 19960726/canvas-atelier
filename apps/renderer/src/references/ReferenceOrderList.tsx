import type { CSSProperties } from 'react';
import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react';
import { reorderReferences, type OrderedReference } from '@agent-canvas/domain';
import { isRenderableManagedImageUrl } from '../app/managed-image-url';

interface ReferenceOrderListProps {
  references: OrderedReference[];
  thumbnailEdge?: number;
  onPreviewOrder: (assetIds: string[]) => void;
  onCommitOrder: (assetIds: string[]) => void;
  resolveThumbnailUrl?: (assetId: string) => string;
}

export function ReferenceOrderList({
  references,
  thumbnailEdge = 96,
  onPreviewOrder,
  onCommitOrder,
  resolveThumbnailUrl,
}: ReferenceOrderListProps) {
  const [previewReferences, setPreviewReferences] = useState(references);
  const previewRef = useRef(references);
  const draggingAssetIdRef = useRef<string | null>(null);
  const dragBaselineRef = useRef<OrderedReference[] | null>(null);
  const thumbnailStyle: CSSProperties = { width: thumbnailEdge, height: thumbnailEdge };

  const cancelDrag = () => {
    const baseline = dragBaselineRef.current;
    if (!draggingAssetIdRef.current || !baseline) return;
    draggingAssetIdRef.current = null;
    dragBaselineRef.current = null;
    previewRef.current = baseline;
    setPreviewReferences(baseline);
    onPreviewOrder(baseline.map((reference) => reference.assetId));
  };

  useEffect(() => {
    previewRef.current = references;
    setPreviewReferences(references);
  }, [references]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      cancelDrag();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onPreviewOrder]);

  const publishPreview = (next: OrderedReference[]) => {
    previewRef.current = next;
    setPreviewReferences(next);
    onPreviewOrder(next.map((reference) => reference.assetId));
  };

  const previewBefore = (beforeAssetId?: string) => {
    const movingAssetId = draggingAssetIdRef.current;
    if (!movingAssetId) return previewRef.current;
    const next = reorderReferences(previewRef.current, movingAssetId, beforeAssetId);
    if (!sameAssetOrder(next, previewRef.current)) publishPreview(next);
    return next;
  };

  const moveByKeyboard = (assetId: string, direction: -1 | 1) => {
    const current = previewRef.current;
    const currentIndex = current.findIndex((reference) => reference.assetId === assetId);
    const nextIndex = currentIndex + direction;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= current.length) return;
    const beforeAssetId = direction < 0 ? current[nextIndex]?.assetId : current[currentIndex + 2]?.assetId;
    const next = reorderReferences(current, assetId, beforeAssetId);
    publishPreview(next);
    onCommitOrder(next.map((reference) => reference.assetId));
  };

  return (
    <section className="reference-order" aria-label="Agent 参考顺序" data-testid="reference-order">
      <header><span>参考顺序 / Reference order</span><b>{previewReferences.length}</b></header>
      <ol>
        {previewReferences.map((reference, index) => (
          <li key={reference.assetId} data-testid="reference-order-item" data-role={reference.role} data-asset-id={reference.assetId} data-position={index} draggable
            onDragStart={() => {
              dragBaselineRef.current = references.map((item) => ({ ...item }));
              draggingAssetIdRef.current = reference.assetId;
            }}
            onDragOver={(event) => { event.preventDefault(); previewBefore(reference.assetId); }}
            onDrop={(event) => {
              event.preventDefault();
              const next = previewBefore(reference.assetId);
              draggingAssetIdRef.current = null;
              dragBaselineRef.current = null;
              onCommitOrder(next.map((item) => item.assetId));
            }}
            onDragEnd={cancelDrag}
          >
            <GripVertical size={13} aria-hidden="true" />
            <div className="reference-order__thumb" aria-hidden="true" style={thumbnailStyle}>
              {renderThumbnail(resolveThumbnailUrl?.(reference.assetId), reference.label)}
            </div>
            <span className="reference-order__label">{reference.label}<small>{roleLabel(reference.role)}</small></span>
            <span className="reference-order__actions">
              <button type="button" aria-label={`上移 ${reference.label} / Move ${reference.label} up`} title={`上移 ${reference.label}`}
                disabled={index === 0} onClick={() => moveByKeyboard(reference.assetId, -1)}><ArrowUp size={13} /></button>
              <button type="button" aria-label={`下移 ${reference.label} / Move ${reference.label} down`} title={`下移 ${reference.label}`}
                disabled={index === previewReferences.length - 1} onClick={() => moveByKeyboard(reference.assetId, 1)}><ArrowDown size={13} /></button>
            </span>
          </li>
        ))}
      </ol>
      <div
        className="reference-order__end-drop"
        aria-label="放到参考顺序末尾 / Drop reference at end"
        onDragOver={(event) => { event.preventDefault(); previewBefore(); }}
        onDrop={(event) => {
          event.preventDefault();
          const next = previewBefore();
          draggingAssetIdRef.current = null;
          onCommitOrder(next.map((item) => item.assetId));
        }}
      />
    </section>
  );
}

function sameAssetOrder(left: OrderedReference[], right: OrderedReference[]): boolean {
  return left.length === right.length && left.every((reference, index) => reference.assetId === right[index]?.assetId);
}

function roleLabel(role: OrderedReference['role']): string {
  if (role === 'product_identity') return '产品 / Product';
  if (role === 'scene_composition') return '场景 / Scene';
  if (role === 'prop_reference') return '道具 / Prop';
  if (role === 'material_lighting') return '材质光照 / Material';
  return '摆放 / Placement';
}

function renderThumbnail(url: string | undefined, label: string) {
  if (isRenderableManagedImageUrl(url)) {
    return <img src={url} alt="" draggable={false} />;
  }
  return <span>{label.slice(0, 1).toUpperCase()}</span>;
}
