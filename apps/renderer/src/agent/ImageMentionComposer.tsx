import { useMemo, useState } from 'react';
import { ImagePlus } from 'lucide-react';
import type { ImageCitation, OrderedReference } from '@agent-canvas/domain';

export interface ImageMentionValue {
  text: string;
  citations: ImageCitation[];
}

interface ImageMentionComposerProps {
  references: OrderedReference[];
  value: ImageMentionValue;
  onChange: (value: ImageMentionValue) => void;
  textareaLabel?: string;
  placeholder?: string;
  rows?: number;
}

export function ImageMentionComposer({
  references,
  value,
  onChange,
  textareaLabel = 'Message',
  placeholder,
  rows = 3,
}: ImageMentionComposerProps) {
  const [mentionOpen, setMentionOpen] = useState(false);
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
    onChange({
      text,
      citations: [...currentCitations, {
        assetId: reference.assetId,
        label: reference.label,
      }],
    });
  };

  return (
    <div className="image-mention-composer">
      <textarea aria-label={textareaLabel} placeholder={placeholder} rows={rows} value={value.text}
        onChange={(event) => updateText(event.target.value)} />
      <div className="image-mention-composer__control">
        <button type="button" aria-label="Mention image" title="Mention image" disabled={references.length === 0}
          aria-expanded={mentionOpen} onClick={() => setMentionOpen((open) => !open)}><ImagePlus size={15} /></button>
        {mentionOpen && (
          <div className="image-mention-menu" role="menu" aria-label="Reference images">
            {references.map((reference) => {
              const displayLabel = labelCounts.get(reference.label)! > 1
                ? `${reference.label} (${roleLabel(reference.role)})`
                : reference.label;
              return (
                <button key={reference.assetId} type="button" role="menuitem" aria-label={`Mention ${displayLabel}`}
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