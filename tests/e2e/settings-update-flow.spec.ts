import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './helpers/e2e-test';
import { openEmptyApp } from './helpers/app';

const artifactDirectory = path.join(process.cwd(), 'work', process.env.CANVAS_UPDATE_AUDIT_DIR ?? 'qa-settings-update');
const artifact = (name: string) => path.join(artifactDirectory, name);

test('shows the explicit local desktop update flow without automatic install', async ({ page }) => {
  fs.mkdirSync(artifactDirectory, { recursive: true });
  await openEmptyApp(page);
  await page.getByTestId('settings-toggle').click();
  const settings = page.getByTestId('settings-drawer');
  await settings.getByRole('tab', { name: '同步' }).click();
  const recovery = settings.getByTestId('settings-sync-diagnostics-layer');
  await expect(recovery).toHaveJSProperty('open', false);
  await expect(settings.getByRole('region', { name: '连接与恢复' })).toBeHidden();
  const updates = settings.getByRole('region', { name: '应用更新', exact: true });
  await expect(updates).toBeVisible();
  const checkUpdate = updates.getByRole('button', { name: 'Check for updates' });
  await expect(checkUpdate).toBeEnabled();

  await checkUpdate.click();
  const dialog = page.getByRole('dialog', { name: '应用更新' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('发现新版本 1.6.63')).toBeVisible();
  await expect(dialog.getByText('本地 E2E 更新说明')).toBeVisible();
  await dialog.screenshot({ path: artifact('update-announcement-light.png') });

  await dialog.getByRole('button', { name: '下载更新' }).click();
  await expect(dialog.getByText('下载进度 42%')).toBeVisible();
  await expect(checkUpdate).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.__NOVUS_E2E__?.getState().updateRestartCount)).toBe(0);

  await page.evaluate(() => window.__NOVUS_E2E__?.publishUpdateState({
    status: 'error',
    version: '1.6.63',
    message: 'E2E controlled download interruption',
  }));
  await expect(dialog.getByRole('alert')).toHaveText('更新检查失败，请检查网络后重试。');
  await expect(checkUpdate).toBeEnabled();
  await expect(recovery).toHaveJSProperty('open', false);
  await expect(dialog.getByRole('button', { name: '重启并安装' })).toHaveCount(0);
  await dialog.getByRole('button', { name: '重新检查更新' }).click();
  await expect(dialog.getByText('发现新版本 1.6.63')).toBeVisible();
  await dialog.getByRole('button', { name: '下载更新' }).click();
  await expect(dialog.getByText('下载进度 42%')).toBeVisible();
  await expect(checkUpdate).toBeDisabled();
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
