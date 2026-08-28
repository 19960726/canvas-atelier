import path from 'node:path';
import { expect, test } from './helpers/e2e-test';
import { openEmptyApp } from './helpers/app';

const artifact = (name: string) => path.join(process.cwd(), 'artifacts', '2026-08-06-agent-multimedia', name);

async function openSettings(page: import('@playwright/test').Page) {
  await page.getByTestId('settings-toggle').click();
  await expect(page.getByTestId('settings-drawer')).toBeVisible();
  return page.getByTestId('settings-drawer');
}

async function expectFourSettingsTabs(settings: import('@playwright/test').Locator) {
  await expect(settings.getByRole('tab')).toHaveText([
    'API 与模型',
    '存储与备份',
    'MCP 联动',
    '同步',
  ]);
  await expect(settings.getByRole('tab', { name: '使用说明' })).toHaveCount(0);
  const renderedColumnCount = await settings.locator('.settings-tabs').evaluate((element) => (
    getComputedStyle(element).gridTemplateColumns.split(/\s+/u).filter(Boolean).length
  ));
  expect(renderedColumnCount).toBe(4);
}

test('captures the redesigned settings surfaces in dark theme', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1050 });
  await page.addInitScript(() => localStorage.setItem('novus.theme.mode', 'dark'));
  await openEmptyApp(page);
  const settings = await openSettings(page);
  await expectFourSettingsTabs(settings);

  await settings.getByRole('tab', { name: 'API 与模型' }).click();
  await expect(settings.getByRole('region', { name: 'API 与模型' })).toBeVisible();
  await expect(settings.getByRole('list', { name: '模型供应商' })).toBeVisible();
  await page.screenshot({ path: artifact('ui-check-settings-api-models-dark.png'), fullPage: true });

  await settings.getByRole('tab', { name: '存储与备份' }).click();
  await expect(settings.getByTestId('settings-storage-card')).toBeVisible();
  const cachePath = settings.getByLabel('当前缓存路径');
  await expect(cachePath).toHaveValue('Browser acceptance cache');
  await expect(settings.getByRole('button', { name: '打开缓存目录' })).toBeEnabled();
  const chooseCache = settings.getByRole('button', { name: '选择自定义缓存路径' });
  await expect(chooseCache).toBeEnabled();
  await chooseCache.click();
  await expect(cachePath).toHaveValue('Browser acceptance custom cache');
  const resetCache = settings.getByRole('button', { name: '恢复默认目录' });
  await expect(resetCache).toBeEnabled();
  await resetCache.click();
  await expect(cachePath).toHaveValue('Browser acceptance cache');
  await page.screenshot({ path: artifact('ui-check-settings-storage-dark.png'), fullPage: true });

  await settings.getByRole('tab', { name: '同步' }).click();
  await expect(settings.getByTestId('settings-sync-card')).toBeVisible();
  await expect(settings.getByRole('group', { name: '知识库同步列表' })).toBeVisible();
  await settings.getByText('高级故障排查').click();
  await expect(settings.getByRole('region', { name: '连接与恢复' })).toBeVisible();
  await expect(settings.getByRole('region', { name: '应用更新' })).toBeVisible();
  await settings.locator('.settings-diagnostics-grid').screenshot({ path: artifact('ui-check-settings-diagnostics-dark.png') });
  await page.screenshot({ path: artifact('ui-check-settings-sync-dark.png'), fullPage: true });

  await settings.getByRole('tab', { name: 'MCP 联动' }).click();
  await expect(settings.getByTestId('settings-mcp-card')).toBeVisible();
  await page.screenshot({ path: artifact('ui-check-settings-mcp-dark.png'), fullPage: true });
});

test('captures API and sync settings in light theme', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1050 });
  await page.addInitScript(() => localStorage.setItem('novus.theme.mode', 'light'));
  await openEmptyApp(page);
  const settings = await openSettings(page);
  await expectFourSettingsTabs(settings);

  await settings.getByRole('tab', { name: 'API 与模型' }).click();
  await expect(settings.getByRole('region', { name: 'API 与模型' })).toBeVisible();
  await page.screenshot({ path: artifact('ui-check-settings-api-models-light.png'), fullPage: true });

  await settings.getByRole('tab', { name: '同步' }).click();
  await settings.getByRole('tab').nth(1).click();
  await expect(settings.getByTestId('settings-storage-card')).toBeVisible();
  await page.screenshot({ path: artifact('ui-check-settings-storage-light.png'), fullPage: true });

  await settings.getByRole('tab').nth(2).click();
  await expect(settings.getByTestId('settings-mcp-card')).toBeVisible();
  await page.screenshot({ path: artifact('ui-check-settings-mcp-light.png'), fullPage: true });

  await settings.getByRole('tab').nth(3).click();  await expect(settings.getByTestId('settings-sync-card')).toBeVisible();
  await settings.getByText('高级故障排查').click();
  await expect(settings.getByRole('region', { name: '连接与恢复' })).toBeVisible();
  await expect(settings.getByRole('region', { name: '应用更新' })).toBeVisible();
  await settings.locator('.settings-diagnostics-grid').screenshot({ path: artifact('ui-check-settings-diagnostics-light.png') });
  await page.screenshot({ path: artifact('ui-check-settings-sync-light.png'), fullPage: true });
});
