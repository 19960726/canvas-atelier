import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react';
import { reorderReferences, type OrderedReference } from '@agent-canvas/domain';

interface ReferenceOrderListProps {
  references: OrderedReference[];
  onPreviewOrder: (assetIds: string[]) => void;
  onCommitOrder: (assetIds: string[]) => void;
}

export function ReferenceOrderList({ references, onPreviewOrder, onCommitOrder }: ReferenceOrderListProps) {
  const [previewReferences, setPreviewReferences] = useState(references);
  const previewRef = useRef(references);
  const draggingAssetIdRef = useRef<string | null>(null);
  const dragBaselineRef = useRef<OrderedReference[] | null>(null);

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
    <section className="reference-order" aria-label="Agent reference order">
      <header><span>Reference order</span><b>{previewReferences.length}</b></header>
      <ol>
        {previewReferences.map((reference, index) => (
          <li key={reference.assetId} draggable
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
            <span className="reference-order__label">{reference.label}<small>{roleLabel(reference.role)}</small></span>
            <span className="reference-order__actions">
              <button type="button" aria-label={`Move ${reference.label} up`} title={`Move ${reference.label} up`}
                disabled={index === 0} onClick={() => moveByKeyboard(reference.assetId, -1)}><ArrowUp size={13} /></button>
              <button type="button" aria-label={`Move ${reference.label} down`} title={`Move ${reference.label} down`}
                disabled={index === previewReferences.length - 1} onClick={() => moveByKeyboard(reference.assetId, 1)}><ArrowDown size={13} /></button>
            </span>
          </li>
        ))}
      </ol>
      <div
        className="reference-order__end-drop"
        aria-label="Drop reference at end"
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
  if (role === 'product_identity') return 'product';
  if (role === 'scene_composition') return 'scene';
  if (role === 'prop_reference') return 'prop';
  if (role === 'material_lighting') return 'material';
  return 'placement';
}