import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsDrawer } from './SettingsDrawer';

const originalDesktop = window.novusDesktop;

afterEach(() => {
  cleanup();
  window.novusDesktop = originalDesktop;
});

describe('SettingsDrawer', () => {
  it('organizes settings into compact sections and checks connection without a paid job', async () => {
    const checkConnection = vi.fn(async () => ({
      checkedAt: '2026-07-21T12:00:00.000Z',
      status: 'connected' as const,
    }));
    const submitImageJob = vi.fn();
    window.novusDesktop = {
      history: {
        getCapacity: vi.fn(async () => ({
          activeBytes: 4096,
          activeCount: 2,
          missingOrCorruptCount: 1,
          trashBytes: 1024,
          trashCount: 1,
        })),
      },
      provider: {
        checkConnection,
        submitImageJob,
      },
    } as unknown as typeof window.novusDesktop;

    render(<SettingsDrawer
      providerStatus={{ configured: true, locked: false, encryption: 'safeStorage' }}
      onClose={vi.fn()}
      onProviderStatusChange={vi.fn()}
    />);

    expect(screen.getByText('模型与 API')).toBeVisible();
    expect(screen.getByText('模型覆盖')).toBeVisible();
    expect(screen.getByText('存储与缓存')).toBeVisible();
    expect(screen.getByText('知识库')).toBeVisible();
    expect(screen.getByText('通用设置')).toBeVisible();
    expect(await screen.findByText('1 条异常')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: '检查连接' }));
    await waitFor(() => expect(checkConnection).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('连接成功')).toBeVisible();
    expect(submitImageJob).not.toHaveBeenCalled();
  });
});
