import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import type { UpdateState } from '@agent-canvas/desktop-core';
import { expect, test } from './helpers/e2e-test';
import { openEmptyApp } from './helpers/app';

const artifactDirectory = path.join(process.cwd(), 'work', process.env.CANVAS_UPDATE_AUDIT_DIR ?? 'repair-185/update-dialog-browser-r8-20261006');
const publishUpdate = async (page: Page, state: UpdateState) => page.evaluate((nextState) => window.__NOVUS_E2E__.publishUpdateState(nextState), state);

async function expectModalInsideViewport(page: Page, dialog: Locator) {
  const layout = await dialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const body = element.querySelector('.canvas-update-body')!;
    const footer = element.querySelector('.canvas-update-actions')!;
    const footerBounds = footer.getBoundingClientRect();
    return { x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom,
      width: innerWidth, height: innerHeight, scrollWidth: body.scrollWidth, clientWidth: body.clientWidth,
      footerTop: footerBounds.top, footerBottom: footerBounds.bottom };
  });
  expect(layout.x).toBeGreaterThanOrEqual(0);
  expect(layout.y).toBeGreaterThanOrEqual(0);
  expect(layout.right).toBeLessThanOrEqual(layout.width);
  expect(layout.bottom).toBeLessThanOrEqual(layout.height);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
  expect(layout.footerTop).toBeGreaterThanOrEqual(layout.y);
  expect(layout.footerBottom).toBeLessThanOrEqual(layout.bottom);
  for (const button of await dialog.getByRole('button').all()) {
    const radius = await button.evaluate((element) => Number.parseFloat(getComputedStyle(element).borderRadius));
    expect(radius).toBeLessThanOrEqual(8);
  }
  await expect.poll(() => page.evaluate(() => window.__NOVUS_E2E__.getState().updateRestartCount)).toBe(0);
  await expect.poll(() => page.evaluate(() => window.__NOVUS_E2E__.getState().modelSubmissions.length)).toBe(0);
}

for (const theme of ['light', 'dark'] as const) {
  test(`keeps updater status, keyboard, and long notes usable in ${theme}`, async ({ page }) => {
    fs.mkdirSync(artifactDirectory, { recursive: true });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript((mode) => localStorage.setItem('novus.theme.mode', mode), theme);
    await openEmptyApp(page);
    await page.getByTestId('settings-toggle').click();
    const settings = page.getByTestId('settings-drawer');
    await settings.getByRole('tab', { name: '同步' }).click();
    const check = settings.getByRole('button', { name: 'Check for updates' });
    await check.click();
    const dialog = page.getByRole('dialog', { name: '应用更新' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: '关闭更新弹窗' })).toBeFocused();

    await publishUpdate(page, { status: 'checking', currentVersion: '1.6.185' });
    await expect(dialog.getByRole('status')).toHaveText('正在检查更新…');
    await expect(dialog.getByRole('region', { name: '更新说明' })).toHaveCount(0);
    await expectModalInsideViewport(page, dialog);
    const checkingBounds = await dialog.boundingBox();
    expect(checkingBounds?.height).toBeLessThan(340);
    await dialog.screenshot({ path: path.join(artifactDirectory, `${theme}-checking-desktop.png`) });

    await publishUpdate(page, { status: 'idle', currentVersion: '1.6.185', message: 'No updates are available.' });
    await expect(dialog.getByRole('status')).toHaveText('当前已是最新版本');
    await expect(dialog.getByRole('region', { name: '更新说明' })).toHaveCount(0);
    await dialog.screenshot({ path: path.join(artifactDirectory, `${theme}-latest-desktop.png`) });

    await publishUpdate(page, { status: 'available', currentVersion: '1.6.185', version: '1.6.186', notes: '本地 UI 更新说明\n修复缩略图、连线与更新弹窗。' });
    await expectModalInsideViewport(page, dialog);
    await dialog.screenshot({ path: path.join(artifactDirectory, `${theme}-available-desktop.png`) });
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: '下载更新' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: '关闭更新弹窗' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(settings).toBeVisible();
    await expect(check).toBeFocused();
    await check.click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('status')).toHaveText('发现新版本 1.6.63');
    await dialog.getByRole('button', { name: '下载更新' }).click();
    await expect(dialog.getByText('下载进度 42%')).toBeVisible();
    await dialog.screenshot({ path: path.join(artifactDirectory, `${theme}-downloading-desktop.png`) });
    await publishUpdate(page, { status: 'error', message: 'Controlled local error' });
    await expect(dialog.getByRole('alert')).toHaveText('更新检查失败，请检查网络后重试。');
    await dialog.screenshot({ path: path.join(artifactDirectory, `${theme}-error-desktop.png`) });
    await dialog.getByRole('button', { name: '重新检查更新' }).click();
    await expect(dialog.getByRole('status')).toHaveText('发现新版本 1.6.63');

    const longNotes = Array.from({ length: 48 }, (_, index) => `修复项 ${index + 1}：画布素材与节点保存状态。`).join('\n');
    for (const viewport of [{ name: 'narrow', width: 360, height: 640 }, { name: 'short', width: 920, height: 320 }]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await publishUpdate(page, { status: 'available', currentVersion: '1.6.185', version: '1.6.186', notes: `${longNotes}\n${'release_long_word_'.repeat(32)}` });
      await expectModalInsideViewport(page, dialog);
      const body = dialog.getByTestId('update-dialog-scroll');
      const scroll = await body.evaluate((element) => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
      expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
      await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await expect(dialog.getByRole('button', { name: '下载更新' })).toBeVisible();
      await dialog.screenshot({ path: path.join(artifactDirectory, `${theme}-long-notes-${viewport.name}.png`) });
    }

    await publishUpdate(page, { status: 'ready_to_restart', currentVersion: '1.6.185', version: '1.6.186', progress: 1 });
    await expectModalInsideViewport(page, dialog);
    await dialog.screenshot({ path: path.join(artifactDirectory, `${theme}-ready-short.png`) });
    await dialog.getByRole('button', { name: '稍后安装' }).click();
    await expect(dialog).toBeHidden();
    await expect(settings).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__NOVUS_E2E__.getState().updateRestartCount)).toBe(0);
  });
}
