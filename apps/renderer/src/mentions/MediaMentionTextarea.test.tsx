import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaMentionTextarea } from './MediaMentionTextarea';

afterEach(() => cleanup());

function eventValue(callback: ReturnType<typeof vi.fn>, call = callback.mock.calls.length - 1): string {
  return callback.mock.calls[call]?.[0]?.currentTarget?.value as string;
}

function setCaret(container: Node, offset: number): void {
  const selection = window.getSelection();
  const range = document.createRange();
  range.setStart(container, offset);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function canonicalLength(node: Node): number {
  if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).dataset.token !== undefined) {
    return ((node as HTMLElement).dataset.token ?? '').length;
  }
  if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0;
  return Array.from(node.childNodes).reduce((length, child) => length + canonicalLength(child), 0);
}

function canonicalCaretOffset(editor: HTMLElement): number {
  const selection = window.getSelection();
  const focusNode = selection?.focusNode;
  const focusOffset = selection?.focusOffset ?? 0;
  if (focusNode === null || focusNode === undefined) return -1;

  let offset = 0;
  const visit = (node: Node): boolean => {
    if (node === focusNode) {
      if (node.nodeType === Node.TEXT_NODE) offset += focusOffset;
      else {
        for (let index = 0; index < focusOffset; index += 1) {
          const child = node.childNodes[index];
          if (child !== undefined) offset += canonicalLength(child);
        }
      }
      return true;
    }
    if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).dataset.token !== undefined) {
      offset += ((node as HTMLElement).dataset.token ?? '').length;
      return false;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      offset += node.textContent?.length ?? 0;
      return false;
    }
    for (const child of Array.from(node.childNodes)) {
      if (visit(child)) return true;
    }
    return false;
  };

  visit(editor);
  return offset;
}

describe('MediaMentionTextarea', () => {
  it('renders canonical mentions as inline chips without a visible @', () => {
    const { container } = render(<MediaMentionTextarea
      aria-label="Prompt"
      value="参考 @图片1 后继续"
      onChange={vi.fn()}
    />);

    const editor = screen.getByRole('textbox', { name: 'Prompt' });
    expect(editor).toHaveTextContent('参考 图片1 后继续');
    expect(editor).not.toHaveTextContent('@图片1');
    const chip = screen.getByText('图片1');
    expect(chip).toHaveAttribute('contenteditable', 'false');
    expect(chip).toHaveAttribute('data-token', '@图片1');
    expect(chip).toHaveAttribute('data-media-mention', 'image');
    expect(chip.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('.media-mention-textarea__presentation')).toBeNull();
  });

  it('uses one contenteditable multiline textbox surface', () => {
    render(<MediaMentionTextarea aria-label="Prompt" value="" onChange={vi.fn()} />);

    const editor = screen.getByRole('textbox', { name: 'Prompt' });
    expect(editor).toHaveAttribute('contenteditable', 'true');
    expect(editor).toHaveAttribute('aria-multiline', 'true');
  });

  it('keeps wheel scrolling inside the multiline editor instead of bubbling to the canvas', () => {
    const onCanvasWheel = vi.fn();
    render(<div onWheel={onCanvasWheel}>
      <MediaMentionTextarea aria-label="Prompt" value={'长文本\n'.repeat(40)} onChange={vi.fn()} />
    </div>);

    fireEvent.wheel(screen.getByRole('textbox', { name: 'Prompt' }), { deltaY: 120 });

    expect(onCanvasWheel).not.toHaveBeenCalled();
  });

  it('emits typed text immediately after the third chip in canonical order', () => {
    const onChange = vi.fn();
    render(<MediaMentionTextarea
      aria-label="Prompt"
      value="@图片1@视频1@图片2"
      onChange={onChange}
    />);
    const editor = screen.getByRole('textbox', { name: 'Prompt' });
    editor.append(document.createTextNode('后续'));

    fireEvent.input(editor);

    expect(eventValue(onChange)).toBe('@图片1@视频1@图片2后续');
  });

  it('pastes plain text and strips supplied rich HTML', () => {
    const onChange = vi.fn();
    render(<MediaMentionTextarea aria-label="Prompt" value="" onChange={onChange} />);
    const editor = screen.getByRole('textbox', { name: 'Prompt' });
    setCaret(editor, 0);

    fireEvent.paste(editor, {
      clipboardData: {
        getData: (type: string) => type === 'text/plain' ? '纯文本' : '<b>纯文本</b>',
      },
    });

    expect(editor).toHaveTextContent('纯文本');
    expect(editor.querySelector('b')).toBeNull();
    expect(eventValue(onChange)).toBe('纯文本');
  });

  it('keeps Ctrl+Z usable across controlled contenteditable refreshes', () => {
    const onChange = vi.fn();
    const { rerender } = render(<MediaMentionTextarea aria-label="Prompt" value="原文" onChange={onChange} />);
    const editor = screen.getByRole('textbox', { name: 'Prompt' });
    setCaret(editor.firstChild ?? editor, 2);

    editor.textContent = '原文新';
    fireEvent.input(editor, { inputType: 'insertText', data: '新' });
    rerender(<MediaMentionTextarea aria-label="Prompt" value="原文新" onChange={onChange} />);

    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true });

    expect(eventValue(onChange)).toBe('原文');
    expect(editor).toHaveTextContent('原文');
  });

  it('does not emit during composition and emits once on composition end', () => {
    const onChange = vi.fn();
    render(<MediaMentionTextarea aria-label="Prompt" value="" onChange={onChange} />);
    const editor = screen.getByRole('textbox', { name: 'Prompt' });

    fireEvent.compositionStart(editor);
    editor.textContent = '图';
    fireEvent.input(editor);
    expect(onChange).not.toHaveBeenCalled();

    editor.textContent = '图片';
    fireEvent.compositionEnd(editor);
    fireEvent.input(editor);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(eventValue(onChange)).toBe('图片');
  });

  it.each([
    ['Backspace', 'after'],
    ['Delete', 'before'],
  ] as const)('%s beside a chip removes exactly one canonical token', (key, side) => {
    const onChange = vi.fn();
    render(<MediaMentionTextarea
      aria-label="Prompt"
      value="A@图片1B@视频1C"
      onChange={onChange}
    />);
    const editor = screen.getByRole('textbox', { name: 'Prompt' });
    const chip = screen.getByText('图片1');
    const index = Array.from(editor.childNodes).indexOf(chip);
    const caretOffset = index < 0 ? 0 : side === 'after' ? index + 1 : index;
    setCaret(editor, caretOffset);

    fireEvent.keyDown(editor, { key });

    expect(eventValue(onChange)).toBe('AB@视频1C');
    expect(screen.queryByText('图片1')).toBeNull();
    expect(screen.getByText('视频1')).toBeInTheDocument();
  });

  it('serializes block and br line breaks without duplicates', () => {
    const onChange = vi.fn();
    render(<MediaMentionTextarea aria-label="Prompt" value="" onChange={onChange} />);
    const editor = screen.getByRole('textbox', { name: 'Prompt' });
    editor.innerHTML = '第一行<div>第二行<br>第三行</div><div><br></div><div>第四行</div>';

    fireEvent.input(editor);

    expect(eventValue(onChange)).toBe('第一行\n第二行\n第三行\n\n第四行');
  });

  it('restores the canonical caret offset after an external value refresh', async () => {
    const { rerender } = render(<MediaMentionTextarea
      aria-label="Prompt"
      value="前@图片1中@视频1"
      onChange={vi.fn()}
    />);
    const editor = screen.getByRole('textbox', { name: 'Prompt' });
    setCaret(editor, editor.childNodes.length);
    const expectedOffset = '前@图片1中@视频1'.length;

    rerender(<MediaMentionTextarea
      aria-label="Prompt"
      value="前@图片1中@视频1后"
      onChange={vi.fn()}
    />);

    await waitFor(() => expect(canonicalCaretOffset(editor)).toBe(expectedOffset));
  });

  it('renders the managed thumbnail inside 图片20 and shows the larger preview on hover', () => {
    render(<MediaMentionTextarea
      aria-label="Prompt"
      value="分析@图片20"
      mentions={[{
        token: '@图片20',
        assetId: 'image-20',
        label: '商品背面.png',
        displayUrl: 'novus-project://asset/image-20',
        kind: 'image',
      }]}
      onChange={vi.fn()}
    />);

    const chip = screen.getByText('图片20');
    expect(chip.querySelector('img')).toHaveAttribute('src', 'novus-project://asset/image-20');
    expect(chip.querySelector('img')).toHaveAttribute('alt', '');
    fireEvent.mouseEnter(chip);

    expect(screen.getByRole('tooltip', { name: '图片20 素材预览' })).toHaveTextContent('商品背面.png');
    expect(screen.getByRole('img', { name: '商品背面.png' })).toHaveAttribute('src', 'novus-project://asset/image-20');
  });
});
