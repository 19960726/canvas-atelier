import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuickInsert } from './QuickInsert';

afterEach(cleanup);

describe('QuickInsert activation', () => {
  it('closes after an accepted creation even when the callback returns void', async () => {
    const onCreate = vi.fn();
    const onClose = vi.fn();

    render(<QuickInsert anchor={{ x: 20, y: 20 }} onCreate={onCreate} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: /插入 图片输入/ }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('image_input'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes immediately after an asynchronous creation request is accepted', () => {
    let finishCreation: ((created: boolean) => void) | undefined;
    const onCreate = vi.fn(() => new Promise<boolean>((resolve) => {
      finishCreation = resolve;
    }));
    const onClose = vi.fn();

    render(<QuickInsert anchor={{ x: 20, y: 20 }} onCreate={onCreate} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: /插入 图片输入/ }));

    expect(onCreate).toHaveBeenCalledWith('image_input');
    expect(onClose).toHaveBeenCalledOnce();
    finishCreation?.(true);
  });

  it('keeps the menu open when creation is synchronously rejected', () => {
    const onCreate = vi.fn(() => false);
    const onClose = vi.fn();

    render(<QuickInsert anchor={{ x: 20, y: 20 }} onCreate={onCreate} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: /插入 图片输入/ }));

    expect(onCreate).toHaveBeenCalledWith('image_input');
    expect(onClose).not.toHaveBeenCalled();
  });
});
