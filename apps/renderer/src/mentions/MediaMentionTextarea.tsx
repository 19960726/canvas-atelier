import {
  forwardRef,
  useLayoutEffect,
  useImperativeHandle,
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

export type MediaMentionSelection = {
  readonly start: number;
  readonly end: number;
};

export interface MediaMentionTextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value'> {
  readonly value: string;
  readonly mentions?: readonly MediaMentionPreview[];
  readonly onCanonicalSelectionChange?: (selection: MediaMentionSelection) => void;
}

export interface MediaMentionTextareaHandle {
  applyEdit(nextValue: string, selection?: MediaMentionSelection): void;
}

type CanonicalSelection = MediaMentionSelection;

const BLOCK_ELEMENTS = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'FOOTER', 'HEADER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'MAIN', 'NAV', 'P', 'PRE', 'SECTION']);

export const MediaMentionTextarea = forwardRef<MediaMentionTextareaHandle, MediaMentionTextareaProps>(function MediaMentionTextarea({
  value,
  mentions = [],
  onCanonicalSelectionChange,
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
}: MediaMentionTextareaProps, forwardedRef) {
  const editorRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const lastEmittedValueRef = useRef(value);
  const undoStackRef = useRef<string[]>([]);
  const onChangeRef = useRef(onChange);
  const disabledRef = useRef(disabled);
  const readOnlyRef = useRef(readOnly);
  const onCanonicalSelectionChangeRef = useRef(onCanonicalSelectionChange);
  const lastCanonicalSelectionRef = useRef<CanonicalSelection | null>(null);
  const renderedPreviewSignatureRef = useRef<string | null>(null);
  onChangeRef.current = onChange;
  disabledRef.current = disabled;
  readOnlyRef.current = readOnly;
  onCanonicalSelectionChangeRef.current = onCanonicalSelectionChange;
  const [activeToken, setActiveToken] = useState<string | null>(null);
  const segments = useMemo(() => parseCanonicalMentions(value), [value]);
  const previews = useMemo(() => new Map(mentions.map((mention) => [mention.token, mention])), [mentions]);
  const previewSignature = useMemo(() => JSON.stringify(mentions.map((mention) => [
    mention.token,
    mention.kind,
    mention.assetId ?? null,
    mention.label,
    mention.displayUrl ?? null,
  ])), [mentions]);
  const previewsRef = useRef(previews);
  previewsRef.current = previews;
  const activePreview = activeToken === null ? undefined : previews.get(activeToken);
  const activeSegment = activeToken === null ? undefined : segments.find((segment) => segment.kind !== 'text' && segment.token === activeToken);
  const editorStyle = {
    ...style,
    '--media-mention-rows': String(rows),
  } as CSSProperties;
  const compatibleAttributes = textareaAttributes as unknown as React.HTMLAttributes<HTMLDivElement>;
  const publishCanonicalSelection = (editor: HTMLDivElement) => {
    const selection = captureCanonicalSelection(editor);
    if (selection === null) return;
    lastCanonicalSelectionRef.current = selection;
    onCanonicalSelectionChangeRef.current?.(selection);
  };
  const pushUndoValue = (previousValue: string) => {
    if (undoStackRef.current[undoStackRef.current.length - 1] !== previousValue) undoStackRef.current.push(previousValue);
    if (undoStackRef.current.length > 100) undoStackRef.current.splice(0, undoStackRef.current.length - 100);
  };

  useImperativeHandle(forwardedRef, () => ({
    applyEdit(nextValue, requestedSelection) {
      const editor = editorRef.current;
      if (editor === null || disabledRef.current || readOnlyRef.current) return;
      const previousValue = lastEmittedValueRef.current;
      const selection = requestedSelection ?? { start: nextValue.length, end: nextValue.length };
      if (nextValue !== previousValue) pushUndoValue(previousValue);
      rebuildEditor(editor, nextValue, previewsRef.current, setActiveToken);
      lastEmittedValueRef.current = nextValue;
      editor.focus();
      restoreCanonicalSelection(editor, selection);
      publishCanonicalSelection(editor);
      if (nextValue !== previousValue) emitTextareaChange(onChangeRef.current, nextValue);
    },
  }), []);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (lastEmittedValueRef.current !== value) undoStackRef.current = [];
    lastEmittedValueRef.current = value;
    if (editor === null || composingRef.current) return;
    const previewChanged = renderedPreviewSignatureRef.current !== previewSignature;
    if (serializeEditor(editor) === value && !previewChanged) return;
    const editorHasFocus = document.activeElement === editor || editor.contains(document.activeElement);
    const selection = (editorHasFocus ? captureCanonicalSelection(editor) : null) ?? lastCanonicalSelectionRef.current;
    const focusedToken = mentionChip(document.activeElement)?.dataset.token;
    rebuildEditor(editor, value, previews, setActiveToken);
    renderedPreviewSignatureRef.current = previewSignature;
    if (selection !== null) restoreCanonicalSelection(editor, selection);
    if (focusedToken !== undefined) findMentionChip(editor, focusedToken)?.focus();
    if (editorHasFocus) publishCanonicalSelection(editor);
  }, [previewSignature, value]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (editor === null) return;
    const handleChange = () => {
      if (disabledRef.current || readOnlyRef.current || composingRef.current) return;
      const nextValue = serializeEditor(editor);
      if (nextValue === lastEmittedValueRef.current) return;
      publishCanonicalSelection(editor);
      lastEmittedValueRef.current = nextValue;
      emitTextareaChange(onChangeRef.current, nextValue);
    };
    const handleSelectionChange = () => {
      if (document.activeElement !== editor && !editor.contains(document.activeElement)) return;
      publishCanonicalSelection(editor);
    };
    Object.defineProperty(editor, 'value', {
      configurable: true,
      get: () => serializeEditor(editor),
      set: (nextValue: unknown) => {
        const canonicalValue = String(nextValue ?? '');
        if (serializeEditor(editor) === canonicalValue) return;
        const editorHasFocus = document.activeElement === editor || editor.contains(document.activeElement);
        const selection = (editorHasFocus ? captureCanonicalSelection(editor) : null) ?? lastCanonicalSelectionRef.current;
        rebuildEditor(editor, canonicalValue, previewsRef.current, setActiveToken);
        if (selection !== null) restoreCanonicalSelection(editor, selection);
      },
    });
    editor.addEventListener('change', handleChange);
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      editor.removeEventListener('change', handleChange);
      document.removeEventListener('selectionchange', handleSelectionChange);
      delete (editor as HTMLDivElement & { value?: string }).value;
    };
  }, []);

  const emitValue = (editor: HTMLDivElement, recordUndo = true) => {
    const nextValue = serializeEditor(editor);
    if (nextValue === lastEmittedValueRef.current) return;
    if (recordUndo) pushUndoValue(lastEmittedValueRef.current);
    lastEmittedValueRef.current = nextValue;
    emitTextareaChange(onChange, nextValue);
  };

  const handleInput = (event: FormEvent<HTMLDivElement>) => {
    onInput?.(event as unknown as ReactInputEvent<HTMLTextAreaElement>);
    if (disabled || readOnly || composingRef.current) return;
    publishCanonicalSelection(event.currentTarget);
    emitValue(event.currentTarget);
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    onPaste?.(event as unknown as ClipboardEvent<HTMLTextAreaElement>);
    if (event.defaultPrevented || disabled || readOnly) return;
    event.preventDefault();
    insertPlainText(event.currentTarget, event.clipboardData.getData('text/plain'));
    publishCanonicalSelection(event.currentTarget);
    emitValue(event.currentTarget);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event as unknown as KeyboardEvent<HTMLTextAreaElement>);
    if (event.defaultPrevented || disabled || readOnly || composingRef.current) return;
    const standardUndo = (event.ctrlKey || event.metaKey) && !event.altKey;
    const alternateUndo = event.altKey && !event.ctrlKey && !event.metaKey;
    if ((standardUndo || alternateUndo) && !event.shiftKey && event.key.toLocaleLowerCase() === 'z') {
      const previousValue = undoStackRef.current.pop();
      if (previousValue === undefined) return;
      event.preventDefault();
      rebuildEditor(event.currentTarget, previousValue, previewsRef.current, setActiveToken);
      restoreCanonicalSelection(event.currentTarget, { start: previousValue.length, end: previousValue.length });
      emitValue(event.currentTarget, false);
      return;
    }
    if (event.key !== 'Backspace' && event.key !== 'Delete') return;
    const focusedChip = event.target instanceof Node ? mentionChip(event.target) : null;
    const chip = focusedChip ?? adjacentChip(event.currentTarget, event.key === 'Backspace' ? 'before' : 'after');
    if (chip === null) return;
    event.preventDefault();
    removeChip(event.currentTarget, chip);
    publishCanonicalSelection(event.currentTarget);
    emitValue(event.currentTarget);
  };

  const handleCompositionStart = (event: CompositionEvent<HTMLDivElement>) => {
    composingRef.current = true;
    onCompositionStart?.(event as unknown as CompositionEvent<HTMLTextAreaElement>);
  };

  const handleCompositionEnd = (event: CompositionEvent<HTMLDivElement>) => {
    composingRef.current = false;
    onCompositionEnd?.(event as unknown as CompositionEvent<HTMLTextAreaElement>);
    if (!disabled && !readOnly) {
      publishCanonicalSelection(event.currentTarget);
      emitValue(event.currentTarget);
    }
  };

  return <div className="media-mention-textarea" onMouseLeave={() => setActiveToken(null)}>
    <div
      {...compatibleAttributes}
      ref={editorRef}
      role="textbox"
      aria-multiline="true"
      aria-disabled={disabled || undefined}
      aria-readonly={readOnly || undefined}
      aria-keyshortcuts="Control+Z Meta+Z Alt+Z"
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
});

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
    chip.setAttribute('role', 'button');
    chip.setAttribute('tabindex', '0');
    chip.setAttribute('aria-keyshortcuts', 'Backspace Delete');
    chip.dataset.token = segment.token;
    chip.dataset.mediaMention = segment.kind;
    chip.append(createPinIcon());
    const preview = previews.get(segment.token);
    const mediaKindLabel = segment.kind === 'video' ? '视频' : '图片';
    chip.setAttribute('aria-label', `${segment.text}，${preview?.label ?? segment.text}，${mediaKindLabel}引用。按退格键或删除键移除`);
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
    const label = document.createElement('span');
    label.className = 'media-mention-textarea__chip-label';
    label.textContent = segment.text;
    chip.append(label);
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

function serializeChildren(parent: Node, end?: { node: Node; offset: number }): string {
  let value = '';
  const children = Array.from(parent.childNodes);
  const limit = end?.node === parent ? end.offset : children.length;
  for (const node of children.slice(0, limit)) {
    if (node.nodeType === Node.TEXT_NODE) {
      value += end?.node === node ? (node.textContent ?? '').slice(0, end.offset) : node.textContent ?? '';
      if (end?.node === node) break;
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const element = node as HTMLElement;
    const token = element.dataset.token;
    if (token !== undefined) {
      value += token;
      if (end && element.contains(end.node)) break;
      continue;
    }
    if (element.tagName === 'BR') {
      value += '\n';
      continue;
    }
    const content = serializeChildren(element, end);
    if (BLOCK_ELEMENTS.has(element.tagName) && value.length > 0 && !value.endsWith('\n')) value += '\n';
    value += content;
    if (end && element.contains(end.node)) break;
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

function findMentionChip(editor: HTMLElement, token: string): HTMLElement | null {
  return Array.from(editor.children).find((child): child is HTMLElement => (
    child instanceof HTMLElement && child.dataset.token === token
  )) ?? null;
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
  const start = canonicalOffsetToPoint(editor, selection.anchorNode, selection.anchorOffset);
  return { start, end: selection.isCollapsed ? start : canonicalOffsetToPoint(editor, selection.focusNode, selection.focusOffset) };
}

function canonicalOffsetToPoint(editor: HTMLDivElement, node: Node | null, offset: number): number {
  if (node === null) return 0;
  // Reading a caret must not clone referenced media: cloned video/image nodes
  // allocate decoders and reload sources on every input and selectionchange.
  return serializeChildren(editor, { node, offset }).replace(/\r\n?/gu, '\n').length;
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
