import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReactFlowProvider } from '@xyflow/react';
import { createCanvasModuleNode } from '@agent-canvas/domain';
import { resetAppStoreForTests, useAppStore } from '../app/app-store';
import { ModuleNodeCard } from './ModuleNodeCard';

const image = {
  assetId: '0123456789abcdef',
  byteSize: 42,
  displayUrl: 'novus-asset://project/session/0123456789abcdef',
  extension: 'png' as const,
  height: 3,
  label: 'Product front',
  mediaType: 'image/png' as const,
  origin: 'imported' as const,
  sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  usageCount: 1,
  width: 2,
};

beforeEach(() => resetAppStoreForTests());
afterEach(() => cleanup());

function setCaret(node: Node, offset: number): void {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function inputAtCaret(editor: HTMLElement, value: string, caret = value.length): void {
  editor.textContent = value;
  setCaret(editor.firstChild!, caret);
  fireEvent.input(editor, { inputType: 'insertText' });
}

function picker(): HTMLElement | null {
  return screen.queryByRole('menu', { name: 'Select reference image' });
}

describe.each([
  ['image_generation', 'Image generation prompt', 'Open image generation editor', 'references'],
  ['video_generation', 'Video preview prompt', 'Open video generation editor', 'media'],
  ['reverse_agent', 'Analysis task', null, 'references'],
] as const)('%s mention dismissal', (moduleType, editorLabel, openLabel, targetPortId) => {
  function renderEditor(): HTMLElement {
    const source = createCanvasModuleNode('mention-source', 'image_input', { x: 0, y: 0 });
    source.data.config = { assetId: image.assetId };
    const node = createCanvasModuleNode('mention-target', moduleType, { x: 420, y: 0 });
    useAppStore.setState({
      projectImages: [image],
      project: {
        ...useAppStore.getState().project,
        nodes: [source, node],
        edges: [{ id: 'mention-edge', source: source.id, sourcePortId: 'image', target: node.id, targetPortId, order: 0 }],
      },
    });
    const data = {
      ...node.data,
      imageGenerationRoutes: [{ provider: 'comfly', modelRoute: 'image-gen', displayName: 'Image Gen', modelId: 'image-gen', capabilities: ['image_generation', 'image_edit'] }],
      videoGenerationRoutes: [{ provider: 'comfly', modelRoute: 'video-gen', displayName: 'Video Gen', modelId: 'video-gen', capabilities: ['video_generation'] }],
      reverseAgentRoutes: [{ provider: 'comfly', modelRoute: 'reverse-gemini', displayName: 'Reverse Gemini', modelId: 'reverse-gemini', capabilities: ['reverse_prompt', 'gemini_native'] }],
    } as typeof node.data;
    render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={data} selected={false} /></ReactFlowProvider>);
    if (openLabel !== null) fireEvent.click(screen.getByRole('button', { name: openLabel }));
    return screen.getByRole('textbox', { name: editorLabel });
  }

  it('keeps the picker dismissed after selected text normalizes and the caret moves to an older query', () => {
    const editor = renderEditor();
    inputAtCaret(editor, '@稍后处理  @');
    fireEvent.click(screen.getByRole('menuitem', { name: image.label }));
    expect(editor).toHaveValue('@稍后处理  @图片1');
    expect(picker()).toBeNull();

    // Contenteditable can normalize whitespace and restore a different selection
    // after the selected reference is rendered as a non-editable chip.
    inputAtCaret(editor, '@稍后处理\n@图片1', '@稍后处理'.length);

    expect(editor).toHaveValue('@稍后处理\n@图片1');
    expect(picker()).toBeNull();
  });

  it.each(['Escape', 'blur', 'outside'] as const)('keeps an old query dismissed after %s and whitespace normalization', (reason) => {
    const editor = renderEditor();
    inputAtCaret(editor, '@稍后处理');
    expect(picker()).toBeVisible();
    if (reason === 'Escape') fireEvent.keyDown(editor, { key: 'Escape' });
    else if (reason === 'blur') fireEvent.blur(editor);
    else fireEvent.pointerDown(document.body);
    expect(picker()).toBeNull();

    inputAtCaret(editor, '\n@稍后处理');

    expect(picker()).toBeNull();
  });

  it('does not reopen an older query while prose is typed after a selected chip', () => {
    const editor = renderEditor();
    inputAtCaret(editor, '@稍后处理 @');
    fireEvent.click(screen.getByRole('menuitem', { name: image.label }));
    editor.append(document.createTextNode('继续描述产品'));
    setCaret(editor, editor.childNodes.length);

    fireEvent.input(editor, { inputType: 'insertText', data: '继续描述产品' });

    expect(editor).toHaveValue('@稍后处理 @图片1继续描述产品');
    expect(picker()).toBeNull();
  });

  it('opens a fresh @ at a caret before existing references after dismissal', () => {
    const editor = renderEditor();
    inputAtCaret(editor, '@稍后处理 @');
    fireEvent.click(screen.getByRole('menuitem', { name: image.label }));
    setCaret(editor.firstChild!, 0);
    fireEvent.keyDown(editor, { key: '@' });
    inputAtCaret(editor, '@，@稍后处理 @图片1', 1);

    expect(picker()).toBeVisible();
    fireEvent.click(screen.getByRole('menuitem', { name: image.label }));
    expect(editor).toHaveValue('@图片1，@稍后处理 @图片1');
    expect(picker()).toBeNull();
  });

  it('opens a pasted @ query after dismissal without needing a keyboard @ event', () => {
    const editor = renderEditor();
    inputAtCaret(editor, '@');
    fireEvent.click(screen.getByRole('menuitem', { name: image.label }));
    setCaret(editor, editor.childNodes.length);

    fireEvent.paste(editor, { clipboardData: { getData: () => '，@Product' } });

    expect(picker()).toBeVisible();
    fireEvent.click(screen.getByRole('menuitem', { name: image.label }));
    expect(editor).toHaveValue('@图片1，@图片1');
    expect(picker()).toBeNull();
  });

  it('reopens a dismissed query when its query text is edited', () => {
    const editor = renderEditor();
    inputAtCaret(editor, '@Pro');
    fireEvent.keyDown(editor, { key: 'Escape' });
    inputAtCaret(editor, '@Prod');

    expect(picker()).toBeVisible();
    inputAtCaret(editor, '@Product');
    expect(screen.getByRole('menuitem', { name: image.label })).toBeVisible();
    fireEvent.click(screen.getByRole('menuitem', { name: image.label }));
    expect(editor).toHaveValue('@图片1');
    expect(picker()).toBeNull();
  });

  it('opens another pasted query even when its text matches a dismissed query', () => {
    const editor = renderEditor();
    inputAtCaret(editor, '@Product');
    fireEvent.keyDown(editor, { key: 'Escape' });
    setCaret(editor, editor.childNodes.length);

    fireEvent.paste(editor, { clipboardData: { getData: () => ' @Product' } });

    expect(picker()).toBeVisible();
    fireEvent.click(screen.getByRole('menuitem', { name: image.label }));
    expect(editor).toHaveValue('@Product @图片1');
    expect(picker()).toBeNull();
  });
});
