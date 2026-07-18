import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModuleLibrary, MODULE_DRAG_MIME } from './ModuleLibrary';

afterEach(() => cleanup());

describe('ModuleLibrary', () => {
  it('shows Chinese-primary and English-secondary module discovery details', () => {
    render(<ModuleLibrary onCreate={vi.fn()} />);

    expect(screen.getByText('Agent 反推')).toBeVisible();
    expect(screen.getByText('Reverse Agent')).toBeVisible();
    expect(screen.getByText(/分析参考图并整理可执行的复现方向/)).toBeVisible();
  });

  it('matches the same module with Chinese and English search terms', () => {
    render(<ModuleLibrary onCreate={vi.fn()} />);
    const search = screen.getByRole('searchbox', { name: '搜索模块' });

    fireEvent.change(search, { target: { value: '反推' } });
    expect(screen.getByRole('button', { name: '查看 Agent 反推 / Reverse Agent' })).toBeVisible();

    fireEvent.change(search, { target: { value: 'reverse prompt' } });
    expect(screen.getByRole('button', { name: '查看 Agent 反推 / Reverse Agent' })).toBeVisible();
  });

  it('selects and describes on one click, then creates exactly once on double click', () => {
    const onCreate = vi.fn(async () => true);
    render(<ModuleLibrary onCreate={onCreate} />);
    const row = screen.getByRole('button', { name: '查看 文本提示词 / Text Prompt' });

    fireEvent.click(row);
    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByRole('region', { name: '模块详情' })).toHaveTextContent('用途');
    expect(screen.getByRole('region', { name: '模块详情' })).toHaveTextContent('输入');
    expect(screen.getByRole('region', { name: '模块详情' })).toHaveTextContent('输出');

    fireEvent.click(row);
    fireEvent.doubleClick(row);
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith('text_prompt');
  });

  it('creates once with Enter while Space only selects', () => {
    const onCreate = vi.fn(async () => true);
    render(<ModuleLibrary onCreate={onCreate} />);
    const row = screen.getByRole('button', { name: '查看 文本提示词 / Text Prompt' });

    pressKeyboard(row, ' ');
    expect(onCreate).not.toHaveBeenCalled();
    expect(row).toHaveAttribute('aria-selected', 'true');

    pressKeyboard(row, 'Enter');
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('keeps category and device-local favorite browsing outside project creation', () => {
    const onCreate = vi.fn();
    render(<ModuleLibrary onCreate={onCreate} />);

    fireEvent.click(screen.getByRole('tab', { name: '生成 / Generation' }));
    fireEvent.click(screen.getByRole('button', { name: '收藏 图像生成 v2 / Image Generation v2' }));
    fireEvent.click(screen.getByRole('tab', { name: '收藏 / Favorites' }));

    expect(screen.getByRole('button', { name: '查看 图像生成 v2 / Image Generation v2' })).toBeVisible();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('filters by display name and alias and creates by keyboard', () => {
    const onCreate = vi.fn();
    render(<ModuleLibrary onCreate={onCreate} />);

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索模块' }), { target: { value: 'pose' } });

    const openPose = screen.getByRole('button', { name: '查看 姿态提取 / OpenPose' });
    expect(openPose).toBeVisible();
    expect(openPose.querySelector('.module-library__item-icon')).toHaveAttribute('data-icon-category', 'editing');
    expect(openPose.querySelector('.module-library__item-icon svg')).toHaveAttribute('width', '17');
    expect(screen.queryByRole('button', { name: '查看 文本提示词 / Text Prompt' })).toBeNull();

    pressKeyboard(openPose, 'Enter');

    expect(onCreate).toHaveBeenCalledWith('openpose');
  });

  it('provides roving category tabs and moves focus with keyboard navigation', () => {
    render(<ModuleLibrary onCreate={vi.fn()} />);

    const all = screen.getByRole('tab', { name: '全部 / All' });
    const favorites = screen.getByRole('tab', { name: '收藏 / Favorites' });
    const input = screen.getByRole('tab', { name: '输入 / Input' });
    const output = screen.getByRole('tab', { name: '输出 / Output' });
    expect(all).toHaveAttribute('id', 'module-category-tab-all');
    expect(all).toHaveAttribute('aria-controls', 'module-category-panel');
    expect(all).toHaveAttribute('tabindex', '0');
    expect(input).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tabpanel', { name: '全部 / All' })).toHaveAttribute('id', 'module-category-panel');

    fireEvent.keyDown(all, { key: 'ArrowRight' });
    expect(favorites).toHaveFocus();
    expect(favorites).toHaveAttribute('aria-selected', 'true');
    expect(all).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(favorites, { key: 'End' });
    expect(output).toHaveFocus();
    fireEvent.keyDown(output, { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: '分析 / Analysis' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('tab', { name: '分析 / Analysis' }), { key: 'Home' });
    expect(all).toHaveFocus();
  });

  it('activates a module row once for realistic Enter and Space keyboard activation', () => {
    const onCreate = vi.fn();
    render(<ModuleLibrary onCreate={onCreate} />);
    const button = screen.getByRole('button', { name: '查看 文本提示词 / Text Prompt' });

    pressKeyboard(button, 'Enter');
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenLastCalledWith('text_prompt');

    onCreate.mockClear();
    pressKeyboard(button, ' ');
    expect(onCreate).not.toHaveBeenCalled();
    expect(button).toHaveAttribute('aria-selected', 'true');
  });

  it('writes only the module type to the drag payload', () => {
    const setData = vi.fn();
    render(<ModuleLibrary onCreate={vi.fn()} />);

    fireEvent.dragStart(screen.getByRole('button', { name: '查看 文本提示词 / Text Prompt' }), {
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
