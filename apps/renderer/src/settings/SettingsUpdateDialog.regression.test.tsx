import type { UpdateState } from '@agent-canvas/desktop-core';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsDrawer } from './SettingsDrawer';

const originalDesktop = window.novusDesktop;

afterEach(() => {
  cleanup();
  window.novusDesktop = originalDesktop;
});

function renderUpdate(initialState: UpdateState) {
  let publish: (state: UpdateState) => void = () => { throw new Error('Updater is not subscribed'); };
  const restart = vi.fn(async () => ({ accepted: true }));
  const download = vi.fn(async () => ({ state: { status: 'downloading' as const, progress: 0 } }));
  const retry = vi.fn(async () => ({ state: { status: 'checking' as const } }));
  const check = vi.fn(async () => ({ state: { status: 'checking' as const } }));
  const onClose = vi.fn();
  window.novusDesktop = { updates: {
    getState: vi.fn(async () => initialState),
    subscribeState: vi.fn((listener: typeof publish) => { publish = listener; return vi.fn(); }),
    check, download, restart, retry, defer: vi.fn(),
  } } as unknown as typeof window.novusDesktop;
  const result = render(<>
    <button type="button">外部焦点</button>
    <SettingsDrawer providerStatus={null} onClose={onClose} onProviderStatusChange={vi.fn()} />
  </>);
  return { ...result, restart, download, retry, check, onClose,
    publish: (state: UpdateState) => act(() => { publish(state); }) };
}

describe('Settings update dialog regressions', () => {
  it('shows only a live checking status until release details are available', async () => {
    const api = renderUpdate({ status: 'checking', currentVersion: '1.6.185' });
    const dialog = await screen.findByRole('dialog', { name: '应用更新' });
    expect(within(dialog).getByRole('status')).toHaveTextContent('正在检查更新…');
    expect(within(dialog).queryByRole('region', { name: '更新说明' })).not.toBeInTheDocument();
    expect(within(dialog).queryByText('暂无详细更新说明。')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '关闭更新弹窗' })).toHaveFocus();
    expect(api.download).not.toHaveBeenCalled();
    expect(api.restart).not.toHaveBeenCalled();
  });

  it('replaces checking with an explicit latest state without an empty notes panel', async () => {
    const api = renderUpdate({ status: 'checking', currentVersion: '1.6.185' });
    const dialog = await screen.findByRole('dialog', { name: '应用更新' });
    api.publish({ status: 'idle', currentVersion: '1.6.185', message: 'No updates are available.' });
    expect(within(dialog).getByRole('status')).toHaveTextContent('当前已是最新版本');
    expect(within(dialog).getByText('v1.6.185')).toBeVisible();
    expect(within(dialog).queryByRole('region', { name: '更新说明' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: '下载更新' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: '重启并安装' })).not.toBeInTheDocument();
    expect(api.download).not.toHaveBeenCalled();
    expect(api.restart).not.toHaveBeenCalled();
  });

  it('keeps keyboard focus inside the modal and restores the opener on Escape', async () => {
    const api = renderUpdate({ status: 'idle' });
    await waitFor(() => expect(api.check).not.toHaveBeenCalled());
    const opener = screen.getByRole('button', { name: '外部焦点' });
    opener.focus();
    api.publish({ status: 'available', version: '1.6.186', notes: '修复更新布局' });
    const dialog = await screen.findByRole('dialog', { name: '应用更新' });
    const close = within(dialog).getByRole('button', { name: '关闭更新弹窗' });
    const download = within(dialog).getByRole('button', { name: '下载更新' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(download).toHaveFocus();
    fireEvent.keyDown(download, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '应用更新' })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(api.onClose).not.toHaveBeenCalled();
    expect(api.download).not.toHaveBeenCalled();
    expect(api.restart).not.toHaveBeenCalled();
  });

  it.each([
    [-0.5, '下载进度 0%', '0'],
    [1.4, '下载进度 100%', '1'],
    [Number.NaN, '下载进度 0%', '0'],
    [Number.POSITIVE_INFINITY, '下载进度 0%', '0'],
  ])('keeps download progress in the supported range for %s', async (progress, label, value) => {
    renderUpdate({ status: 'downloading', version: '1.6.186', progress });
    const dialog = await screen.findByRole('dialog', { name: '应用更新' });
    expect(within(dialog).getByText(label)).toBeVisible();
    expect(within(dialog).getByRole('progressbar', { name: '更新下载进度' })).toHaveAttribute('value', value);
  });

  it('retains multiline release notes and each explicit action through the updater lifecycle', async () => {
    const api = renderUpdate({ status: 'available', currentVersion: '1.6.185', version: '1.6.186', notes: '第一项修复\n第二项修复' });
    const dialog = await screen.findByRole('dialog', { name: '应用更新' });
    expect(within(dialog).getByRole('region', { name: '更新说明' })).toHaveTextContent('第一项修复 第二项修复');
    fireEvent.click(within(dialog).getByRole('button', { name: '下载更新' }));
    await waitFor(() => expect(api.download).toHaveBeenCalledTimes(1));
    api.publish({ status: 'error', message: 'Controlled failure' });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('更新检查失败，请检查网络后重试。');
    fireEvent.click(within(dialog).getByRole('button', { name: '重新检查更新' }));
    await waitFor(() => expect(api.retry).toHaveBeenCalledTimes(1));
    api.publish({ status: 'ready_to_restart', version: '1.6.186', progress: 1 });
    expect(api.restart).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '稍后安装' }));
    expect(screen.queryByRole('dialog', { name: '应用更新' })).not.toBeInTheDocument();
    expect(api.restart).not.toHaveBeenCalled();
  });
});
