import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModuleLibrary, MODULE_DRAG_MIME } from './ModuleLibrary';

afterEach(() => cleanup());

describe('ModuleLibrary', () => {
  it('filters by display name and alias and creates by keyboard', () => {
    const onCreate = vi.fn();
    render(<ModuleLibrary onCreate={onCreate} />);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search modules' }), { target: { value: 'pose' } });

    const openPose = screen.getByRole('button', { name: 'Add OpenPose' });
    expect(openPose).toBeVisible();
    expect(openPose.querySelector('.module-library__item-icon')).toHaveAttribute('data-icon-category', 'editing');
    expect(openPose.querySelector('.module-library__item-icon svg')).toHaveAttribute('width', '17');
    expect(screen.queryByRole('button', { name: 'Add Text Prompt' })).toBeNull();

    fireEvent.click(openPose);

    expect(onCreate).toHaveBeenCalledWith('openpose');
  });

  it('provides roving category tabs and moves focus with keyboard navigation', () => {
    render(<ModuleLibrary onCreate={vi.fn()} />);

    const all = screen.getByRole('tab', { name: 'All' });
    const input = screen.getByRole('tab', { name: 'Input' });
    const output = screen.getByRole('tab', { name: 'Output' });
    expect(all).toHaveAttribute('id', 'module-category-tab-all');
    expect(all).toHaveAttribute('aria-controls', 'module-category-panel');
    expect(all).toHaveAttribute('tabindex', '0');
    expect(input).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tabpanel', { name: 'All' })).toHaveAttribute('id', 'module-category-panel');

    fireEvent.keyDown(all, { key: 'ArrowRight' });
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-selected', 'true');
    expect(all).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(input, { key: 'End' });
    expect(output).toHaveFocus();
    fireEvent.keyDown(output, { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'Analysis' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Analysis' }), { key: 'Home' });
    expect(all).toHaveFocus();
  });

  it('activates a module row once for realistic Enter and Space keyboard activation', () => {
    const onCreate = vi.fn();
    render(<ModuleLibrary onCreate={onCreate} />);
    const button = screen.getByRole('button', { name: 'Add Text Prompt' });

    pressKeyboard(button, 'Enter');
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenLastCalledWith('text_prompt');

    onCreate.mockClear();
    pressKeyboard(button, ' ');
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenLastCalledWith('text_prompt');
  });

  it('writes only the module type to the drag payload', () => {
    const setData = vi.fn();
    render(<ModuleLibrary onCreate={vi.fn()} />);

    fireEvent.dragStart(screen.getByRole('button', { name: 'Add Text Prompt' }), {
      dataTransfer: { setData, effectAllowed: 'none' },
    });

    expect(setData).toHaveBeenCalledWith(MODULE_DRAG_MIME, 'text_prompt');
    expect(JSON.stringify(setData.mock.calls)).not.toMatch(/path|token|Authorization|base64/i);
  });
});

function pressKeyboard(element: HTMLElement, key: 'Enter' | ' '): void {
  element.focus();
  const keyDown = createEvent.keyDown(element, { key });
  fireEvent(element, keyDown);
  if (!keyDown.defaultPrevented) fireEvent.click(element);
  fireEvent.keyUp(element, { key });
}
