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
  const knownAssetIds = useMemo(() => new Set(references.map((reference) => reference.assetId)), [references]);

  const updateText = (text: string) => {
    const citations = value.citations.filter((citation) => (
      knownAssetIds.has(citation.assetId) && text.includes(`@${citation.label}`)
    ));
    onChange({ text, citations });
  };

  const mention = (reference: OrderedReference) => {
    setMentionOpen(false);
    if (value.citations.some((citation) => citation.assetId === reference.assetId)) return;
    const token = `@${reference.label}`;
    const text = value.text.trimEnd().length > 0 ? `${value.text.trimEnd()} ${token}` : token;
    onChange({
      text,
      citations: [...value.citations.filter((citation) => knownAssetIds.has(citation.assetId)), {
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

function roleLabel(role: OrderedReference['role']): string {
  if (role === 'product_identity') return 'product';
  if (role === 'scene_composition') return 'scene';
  if (role === 'prop_reference') return 'prop';
  if (role === 'material_lighting') return 'material';
  return 'placement';
}