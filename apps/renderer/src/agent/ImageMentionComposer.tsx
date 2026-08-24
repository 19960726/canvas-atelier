import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ImagePlus } from 'lucide-react';
import type { ImageCitation, OrderedReference } from '@agent-canvas/domain';

export interface ImageMentionValue {
  text: string;
  citations: ImageCitation[];
}

export interface MentionableImageReference extends OrderedReference {
  readonly displayUrl?: string;
}

interface ImageMentionComposerProps {
  references: MentionableImageReference[];
  value: ImageMentionValue;
  onChange: (value: ImageMentionValue) => void;
  textareaLabel?: string;
  placeholder?: string;
  rows?: number;
  mentionEnabled?: boolean;
  onMentionUnavailable?: () => void;
}

export function ImageMentionComposer({
  references,
  value,
  onChange,
  textareaLabel = 'Message',
  placeholder,
  rows = 3,
  mentionEnabled = true,
  onMentionUnavailable,
}: ImageMentionComposerProps) {
  const [mentionOpen, setMentionOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const labelCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const reference of references) counts.set(reference.label, (counts.get(reference.label) ?? 0) + 1);
    return counts;
  }, [references]);
  const updateText = (text: string) => {
    const citations = reconcileCitations(text, value.citations, references);
    onChange({ text, citations });
  };

  const mention = (reference: OrderedReference) => {
    setMentionOpen(false);
    const currentCitations = reconcileCitations(value.text, value.citations, references);
    if (currentCitations.some((citation) => citation.assetId === reference.assetId)) return;
    const token = `@${reference.label}`;
    const text = value.text.trimEnd().length > 0 ? `${value.text.trimEnd()} ${token}` : token;
    pendingCaretRef.current = text.length;
    onChange({
      text,
      citations: [...currentCitations, {
        assetId: reference.assetId,
        label: reference.label,
      }],
    });
  };
  useLayoutEffect(() => {
    const caret = pendingCaretRef.current;
    const textarea = textareaRef.current;
    if (caret === null || textarea === null || value.text.length < caret) return;
    pendingCaretRef.current = null;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
  }, [value.text]);
  const removeCitation = (citation: ImageCitation) => {
    const token = `@${citation.label}`;
    onChange({
      text: value.text.replace(token, '').replace(/\s{2,}/gu, ' ').trimStart(),
      citations: value.citations.filter((candidate) => candidate.assetId !== citation.assetId),
    });
  };
  const referencesById = useMemo(() => new Map(references.map((reference) => [reference.assetId, reference])), [references]);

  return (
    <div className="image-mention-composer">
      <textarea ref={textareaRef} data-testid="agent-composer-input" aria-label={textareaLabel} placeholder={placeholder} rows={rows} value={value.text}
        onChange={(event) => updateText(event.target.value)} />
      {value.citations.length > 0 && (
        <div className="image-mention-composer__citations" aria-label="Selected image references">
          {value.citations.map((citation) => {
            const reference = referencesById.get(citation.assetId);
            return <button key={citation.assetId} type="button" aria-label={`Remove ${citation.label} image reference`} onClick={() => removeCitation(citation)}>
              {reference?.displayUrl && <img src={reference.displayUrl} alt="" />}
              <span>@{citation.label}</span>
            </button>;
          })}
        </div>
      )}
      <div className="image-mention-composer__control">
        <button data-testid="image-mention-toggle" type="button" aria-label="Mention image" title="Mention image" disabled={references.length === 0}
          aria-expanded={mentionOpen} onClick={() => mentionEnabled ? setMentionOpen((open) => !open) : onMentionUnavailable?.()}><ImagePlus size={15} /></button>
        {mentionOpen && (
          <div className="image-mention-menu" role="menu" aria-label="Reference images">
            {references.map((reference) => {
              const displayLabel = labelCounts.get(reference.label)! > 1
                ? `${reference.label} (${roleLabel(reference.role)})`
                : reference.label;
              return (
                <button key={reference.assetId} data-testid="image-mention-item" data-role={reference.role} data-asset-id={reference.assetId} type="button" role="menuitem" aria-label={`Mention ${displayLabel}`}
                  onClick={() => mention(reference)}><span>{displayLabel}</span><small>{reference.position + 1}</small></button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function reconcileCitations(
  text: string,
  citations: ImageCitation[],
  references: OrderedReference[],
): ImageCitation[] {
  const referencesByAssetId = new Map(references.map((reference) => [reference.assetId, reference]));
  const remainingOccurrences = new Map<string, number>();
  const reconciled: ImageCitation[] = [];

  for (const citation of citations) {
    const reference = referencesByAssetId.get(citation.assetId);
    if (!reference || reference.label !== citation.label) continue;
    const remaining = remainingOccurrences.has(citation.label)
      ? remainingOccurrences.get(citation.label)!
      : countMentionTokens(text, citation.label);
    if (remaining < 1) continue;
    remainingOccurrences.set(citation.label, remaining - 1);
    reconciled.push(citation);
  }
  return reconciled;
}

function countMentionTokens(text: string, label: string): number {
  const token = `@${label}`;
  let count = 0;
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const index = text.indexOf(token, searchFrom);
    if (index < 0) break;
    const before = index === 0 ? '' : text[index - 1]!;
    const afterIndex = index + token.length;
    const after = afterIndex >= text.length ? '' : text[afterIndex]!;
    if ((before === '' || isMentionBoundary(before)) && (after === '' || isMentionBoundary(after))) count += 1;
    searchFrom = index + token.length;
  }
  return count;
}

function isMentionBoundary(character: string): boolean {
  return /[\s.,!?;:，。！？；：()[\]{}<>"']/u.test(character);
}
function roleLabel(role: OrderedReference['role']): string {
  if (role === 'product_identity') return 'product';
  if (role === 'scene_composition') return 'scene';
  if (role === 'prop_reference') return 'prop';
  if (role === 'material_lighting') return 'material';
  return 'placement';
}
