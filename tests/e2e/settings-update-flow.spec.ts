import { expect, test } from './helpers/e2e-test';
import { openEmptyApp } from './helpers/app';

test('shows the explicit local desktop update flow without automatic install', async ({ page }) => {
  await openEmptyApp(page);
  await page.getByTestId('settings-toggle').click();
  const settings = page.getByTestId('settings-drawer');
  await settings.getByRole('tab', { name: '同步' }).click();
  await settings.getByText('高级故障排查').click();

  await settings.getByRole('button', { name: 'Check for updates' }).click();
  const dialog = page.getByRole('dialog', { name: '应用更新' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('发现新版本 1.6.63')).toBeVisible();
  await expect(dialog.getByText('本地 E2E 更新说明')).toBeVisible();

  await dialog.getByRole('button', { name: '下载更新' }).click();
  await expect(dialog.getByText('下载进度 42%')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__NOVUS_E2E__?.getState().updateRestartCount)).toBe(0);

  await page.evaluate(() => window.__NOVUS_E2E__?.publishUpdateState({
    status: 'ready_to_restart',
    version: '1.6.63',
    progress: 1,
  }));
  await expect(dialog.getByRole('button', { name: '重启并安装' })).toBeVisible();
  await dialog.getByRole('button', { name: '重启并安装' }).click();
  await expect.poll(() => page.evaluate(() => window.__NOVUS_E2E__?.getState().updateRestartCount)).toBe(1);
});
