import { useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { reconcileConnectedMentions, type ConnectedMentionItem } from './media-mention-model';

/** Graph commits also update stored text; apply the same binding to live edits. */
export function useConnectedMentionDraft(
  catalog: readonly ConnectedMentionItem[],
  externalValue: string,
  setValue: Dispatch<SetStateAction<string>>,
  enabled = true,
): void {
  const previous = useRef({ catalog, externalValue });
  const key = JSON.stringify(catalog.map(item => [item.kind, item.assetId]));
  useLayoutEffect(() => {
    const old = previous.current;
    previous.current = { catalog, externalValue };
    const oldKey = JSON.stringify(old.catalog.map(item => [item.kind, item.assetId]));
    if (!enabled || oldKey === key) return;
    setValue(current => current === externalValue && old.externalValue !== externalValue
      ? current
      : reconcileConnectedMentions(old.catalog, catalog, current));
  }, [key, externalValue, enabled, setValue]);
}
