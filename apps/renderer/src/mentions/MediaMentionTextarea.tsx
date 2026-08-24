import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type CompositionEvent,
  type CSSProperties,
  type FormEvent,
  type InputEvent as ReactInputEvent,
  type KeyboardEvent,
  type TextareaHTMLAttributes,
} from 'react';
import { parseCanonicalMentions, type ConnectedMentionItem } from './media-mention-model';

export type MediaMentionPreview = Omit<ConnectedMentionItem, 'assetId'> & { readonly assetId?: string };

export interface MediaMentionTextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value'> {
  readonly value: string;
  readonly mentions?: readonly MediaMentionPreview[];
}

type CanonicalSelection = {
  readonly start: number;
  readonly end: number;
};

const BLOCK_ELEMENTS = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'FOOTER', 'HEADER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'MAIN', 'NAV', 'P', 'PRE', 'SECTION']);

export function MediaMentionTextarea({
  value,
  mentions = [],
  className,
  onChange,
  onInput,
  onPaste,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
  placeholder,
  disabled = false,
  readOnly = false,
  rows = 2,
  style,
  tabIndex,
  ...textareaAttributes
}: MediaMentionTextareaProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const lastEmittedValueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const disabledRef = useRef(disabled);
  const readOnlyRef = useRef(readOnly);
  onChangeRef.current = onChange;
  disabledRef.current = disabled;
  readOnlyRef.current = readOnly;
  const [activeToken, setActiveToken] = useState<string | null>(null);
  const segments = useMemo(() => parseCanonicalMentions(value), [value]);
  const previews = useMemo(() => new Map(mentions.map((mention) => [mention.token, mention])), [mentions]);
  const previewsRef = useRef(previews);
  previewsRef.current = previews;
  const activePreview = activeToken === null ? undefined : previews.get(activeToken);
  const activeSegment = activeToken === null ? undefined : segments.find((segment) => segment.kind !== 'text' && segment.token === activeToken);
  const editorStyle = {
    ...style,
    '--media-mention-rows': String(rows),
  } as CSSProperties;
  const compatibleAttributes = textareaAttributes as unknown as React.HTMLAttributes<HTMLDivElement>;

  useLayoutEffect(() => {
    const editor = editorRef.current;
    lastEmittedValueRef.current = value;
    if (editor === null || composingRef.current || serializeEditor(editor) === value) return;
    const selection = captureCanonicalSelection(editor);
    rebuildEditor(editor, value, previews, setActiveToken);
    if (selection !== null) restoreCanonicalSelection(editor, selection);
  }, [value]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (editor === null) return;
    const handleChange = () => {
      if (disabledRef.current || readOnlyRef.current || composingRef.current) return;
      const nextValue = serializeEditor(editor);
      if (nextValue === lastEmittedValueRef.current) return;
      lastEmittedValueRef.current = nextValue;
      emitTextareaChange(onChangeRef.current, nextValue);
    };
    Object.defineProperty(editor, 'value', {
      configurable: true,
      get: () => serializeEditor(editor),
      set: (nextValue: unknown) => {
        const canonicalValue = String(nextValue ?? '');
        if (serializeEditor(editor) === canonicalValue) return;
        const selection = captureCanonicalSelection(editor);
        rebuildEditor(editor, canonicalValue, previewsRef.current, setActiveToken);
        if (selection !== null) restoreCanonicalSelection(editor, selection);
      },
    });
    editor.addEventListener('change', handleChange);
    return () => {
      editor.removeEventListener('change', handleChange);
      delete (editor as HTMLDivElement & { value?: string }).value;
    };
  }, []);

  const emitValue = (editor: HTMLDivElement) => {
    const nextValue = serializeEditor(editor);
    if (nextValue === lastEmittedValueRef.current) return;
    lastEmittedValueRef.current = nextValue;
    emitTextareaChange(onChange, nextValue);
  };

  const handleInput = (event: FormEvent<HTMLDivElement>) => {
    onInput?.(event as unknown as ReactInputEvent<HTMLTextAreaElement>);
    if (disabled || readOnly || composingRef.current) return;
    emitValue(event.currentTarget);
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    onPaste?.(event as unknown as ClipboardEvent<HTMLTextAreaElement>);
    if (event.defaultPrevented || disabled || readOnly) return;
    event.preventDefault();
    insertPlainText(event.currentTarget, event.clipboardData.getData('text/plain'));
    emitValue(event.currentTarget);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event as unknown as KeyboardEvent<HTMLTextAreaElement>);
    if (event.defaultPrevented || disabled || readOnly || composingRef.current) return;
    if (event.key !== 'Backspace' && event.key !== 'Delete') return;
    const chip = adjacentChip(event.currentTarget, event.key === 'Backspace' ? 'before' : 'after');
    if (chip === null) return;
    event.preventDefault();
    removeChip(event.currentTarget, chip);
    emitValue(event.currentTarget);
  };

  const handleCompositionStart = (event: CompositionEvent<HTMLDivElement>) => {
    composingRef.current = true;
    onCompositionStart?.(event as unknown as CompositionEvent<HTMLTextAreaElement>);
  };

  const handleCompositionEnd = (event: CompositionEvent<HTMLDivElement>) => {
    composingRef.current = false;
    onCompositionEnd?.(event as unknown as CompositionEvent<HTMLTextAreaElement>);
    if (!disabled && !readOnly) emitValue(event.currentTarget);
  };

  return <div className="media-mention-textarea" onMouseLeave={() => setActiveToken(null)}>
    <div
      {...compatibleAttributes}
      ref={editorRef}
      role="textbox"
      aria-multiline="true"
      aria-disabled={disabled || undefined}
      aria-readonly={readOnly || undefined}
      contentEditable={!disabled && !readOnly}
      suppressContentEditableWarning
      className={`media-mention-textarea__editor${className ? ` ${className}` : ''}`}
      data-placeholder={placeholder}
      style={editorStyle}
      tabIndex={disabled ? -1 : tabIndex}
      onInput={handleInput}
      onPaste={handlePaste}
      onKeyDown={handleKeyDown}
      onWheel={(event) => event.stopPropagation()}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
    />
    {activePreview !== undefined && activeSegment !== undefined && <aside className="media-mention-textarea__preview" role="tooltip" aria-label={`${activeSegment.text} 素材预览`}>
      {activePreview.displayUrl && (activePreview.kind === 'video'
        ? <video src={activePreview.displayUrl} aria-label={`${activePreview.label} 视频预览`} muted playsInline preload="metadata" />
        : <img src={activePreview.displayUrl} alt={activePreview.label} />)}
      <span><strong>{activeSegment.text}</strong><small>{activePreview.label}</small></span>
    </aside>}
  </div>;
}

function emitTextareaChange(
  onChange: MediaMentionTextareaProps['onChange'],
  value: string,
): void {
  if (onChange === undefined) return;
  const target = { value } as HTMLTextAreaElement;
  // Contenteditable has no honest textarea ChangeEvent; keep the established callback contract at this one boundary.
  onChange({ currentTarget: target, target } as ChangeEvent<HTMLTextAreaElement>);
}

function rebuildEditor(
  editor: HTMLDivElement,
  value: string,
  previews: ReadonlyMap<string, MediaMentionPreview>,
  setActiveToken: (token: string | null) => void,
): void {
  const nodes = parseCanonicalMentions(value).map((segment) => {
    if (segment.kind === 'text') return document.createTextNode(segment.text);
    const chip = document.createElement('span');
    chip.className = 'media-mention-textarea__chip';
    chip.setAttribute('contenteditable', 'false');
    chip.dataset.token = segment.token;
    chip.dataset.mediaMention = segment.kind;
    chip.append(createPinIcon());
    const preview = previews.get(segment.token);
    if (preview?.displayUrl !== undefined) {
      const media = segment.kind === 'video'
        ? document.createElement('video')
        : document.createElement('img');
      media.src = preview.displayUrl;
      if (media instanceof HTMLImageElement) media.alt = '';
      media.setAttribute('aria-hidden', 'true');
      if (media instanceof HTMLVideoElement) {
        media.muted = true;
        media.playsInline = true;
        media.preload = 'metadata';
      }
      chip.append(media);
    }
    chip.append(document.createTextNode(segment.text));
    chip.addEventListener('mouseenter', () => setActiveToken(segment.token));
    chip.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      editor.focus();
      const range = document.createRange();
      range.setStartAfter(chip);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    return chip;
  });
  editor.replaceChildren(...nodes);
}

function createPinIcon(): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '10');
  svg.setAttribute('height', '10');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(namespace, 'path');
  path.setAttribute('d', 'M10.9 1.8 14.2 5l-1.4 1.4-1-.3-2.5 2.5.2 2-1 1-2.1-2.1-3.7 3.7-.9-.9 3.7-3.7-2.1-2.1 1-1 2 .2 2.5-2.5-.3-1z');
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  return svg;
}

function serializeEditor(editor: HTMLElement): string {
  return serializeChildren(editor).replace(/\r\n?/gu, '\n');
}

function serializeChildren(parent: Node): string {
  let value = '';
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      value += node.textContent ?? '';
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const element = node as HTMLElement;
    const token = element.dataset.token;
    if (token !== undefined) {
      value += token;
      continue;
    }
    if (element.tagName === 'BR') {
      value += '\n';
      continue;
    }
    const content = serializeChildren(element);
    if (BLOCK_ELEMENTS.has(element.tagName) && value.length > 0 && !value.endsWith('\n')) value += '\n';
    value += content;
  }
  return value;
}

function insertPlainText(editor: HTMLDivElement, text: string): void {
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : document.createRange();
  if (!selection?.rangeCount || !editor.contains(range.commonAncestorContainer)) {
    range.selectNodeContents(editor);
    range.collapse(false);
  }
  range.deleteContents();
  const textNode = document.createTextNode(text.replace(/\r\n?/gu, '\n'));
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function adjacentChip(editor: HTMLDivElement, direction: 'before' | 'after'): HTMLElement | null {
  const selection = window.getSelection();
  if (selection === null || !selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer) && range.startContainer !== editor) return null;
  const { startContainer, startOffset } = range;

  if (startContainer === editor) {
    const index = direction === 'before' ? startOffset - 1 : startOffset;
    return mentionChip(editor.childNodes[index]);
  }

  const child = directChildOf(editor, startContainer);
  if (child === null) return null;
  if (startContainer.nodeType === Node.TEXT_NODE) {
    const length = startContainer.textContent?.length ?? 0;
    if (direction === 'before' && startOffset !== 0) return null;
    if (direction === 'after' && startOffset !== length) return null;
  }
  return mentionChip(direction === 'before' ? child.previousSibling : child.nextSibling);
}

function directChildOf(editor: HTMLElement, node: Node): Node | null {
  let current: Node | null = node;
  while (current !== null && current.parentNode !== editor) current = current.parentNode;
  return current;
}

function mentionChip(node: Node | undefined | null): HTMLElement | null {
  return node instanceof HTMLElement && node.dataset.token !== undefined ? node : null;
}

function removeChip(editor: HTMLDivElement, chip: HTMLElement): void {
  const parent = chip.parentNode;
  if (parent === null) return;
  const index = Array.from(parent.childNodes).indexOf(chip);
  chip.remove();
  const range = document.createRange();
  range.setStart(parent, Math.max(0, index));
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  editor.focus();
}

function captureCanonicalSelection(editor: HTMLDivElement): CanonicalSelection | null {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  if (!editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) return null;
  return {
    start: canonicalOffsetToPoint(editor, selection.anchorNode, selection.anchorOffset),
    end: canonicalOffsetToPoint(editor, selection.focusNode, selection.focusOffset),
  };
}

function canonicalOffsetToPoint(editor: HTMLDivElement, node: Node | null, offset: number): number {
  if (node === null) return 0;
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.setEnd(node, offset);
  const fragment = range.cloneContents();
  const holder = document.createElement('div');
  holder.append(fragment);
  return serializeEditor(holder).length;
}

function restoreCanonicalSelection(editor: HTMLDivElement, selection: CanonicalSelection): void {
  const start = pointAtCanonicalOffset(editor, selection.start);
  const end = pointAtCanonicalOffset(editor, selection.end);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  const browserSelection = window.getSelection();
  browserSelection?.removeAllRanges();
  browserSelection?.addRange(range);
}

function pointAtCanonicalOffset(editor: HTMLDivElement, requestedOffset: number): { node: Node; offset: number } {
  let canonicalOffset = 0;
  const children = Array.from(editor.childNodes);
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child === undefined) continue;
    if (child.nodeType === Node.TEXT_NODE) {
      const length = child.textContent?.length ?? 0;
      if (requestedOffset <= canonicalOffset + length) {
        return { node: child, offset: Math.max(0, requestedOffset - canonicalOffset) };
      }
      canonicalOffset += length;
      continue;
    }
    const tokenLength = mentionChip(child)?.dataset.token?.length ?? serializeChildren(child).length;
    if (requestedOffset <= canonicalOffset) return { node: editor, offset: index };
    if (requestedOffset < canonicalOffset + tokenLength) return { node: editor, offset: index + 1 };
    canonicalOffset += tokenLength;
  }
  return { node: editor, offset: children.length };
}
