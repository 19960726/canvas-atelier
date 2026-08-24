import path from 'node:path';
import { expect, test } from './helpers/e2e-test';
import { openEmptyApp } from './helpers/app';

const artifact = (name: string) => path.join(process.cwd(), 'artifacts', '2026-08-08-multi-provider', name);

for (const theme of ['light', 'dark'] as const) {
  test(`Comfly and RelayMe keep separate credentials and capability catalogs in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1680, height: 1050 });
    await page.addInitScript((value) => localStorage.setItem('novus.theme.mode', value), theme);
    await openEmptyApp(page);
    await page.getByTestId('settings-toggle').click();
    const settings = page.getByTestId('settings-drawer');
    await expect(settings).toBeVisible();

    const providers = settings.getByRole('list', { name: '模型供应商' });
    await expect(providers.getByRole('listitem')).toHaveCount(2);
    await expect(providers.getByRole('listitem', { name: /Comfly/u })).toBeEnabled();
    await expect(providers.getByRole('listitem', { name: /RelayMe/u })).toBeEnabled();
    await expect(providers.getByRole('listitem', { name: /GLM/u })).toHaveCount(0);

    await expect(settings.getByRole('region', { name: '生图模型' })).toContainText('GPT Image 2');
    await expect(settings.getByRole('region', { name: '生图模型' })).toContainText('Seedream 5 Pro');
    await expect(settings.getByRole('region', { name: '视频模型' })).toContainText('Veo 3.1 Fast');
    await expect(settings.getByRole('region', { name: '视频模型' })).toContainText('Kling 3');
    await expect(settings.getByRole('region', { name: '反推模型' })).toContainText('Gemini 3.1 Pro');

    await providers.getByRole('listitem', { name: /RelayMe/u }).click();
    await expect(settings.getByLabel('API 服务地址（Base URL）')).toHaveValue('https://api.relayme.ai/api/ai-tools/v1');
    await expect(settings.getByRole('region', { name: '生图模型' })).toContainText('GPT Image 2');
    await expect(settings.getByRole('region', { name: '生图模型' })).not.toContainText('Gemini Image');
    await expect(settings.getByRole('region', { name: '视频模型' })).toContainText('Kling');
    await expect(settings.getByRole('region', { name: '对话模型' })).toContainText('Gemini Vision');
    await expect(settings.getByRole('region', { name: '反推模型' })).toContainText('GPT Vision');
    await expect(settings.getByRole('region', { name: '生图模型' })).not.toContainText('2K / 4K');
    await expect(settings.getByRole('region', { name: '视频模型' })).not.toContainText('4/6/8 秒');

    await settings.getByRole('button', { name: '检测连接' }).click();
    await expect(settings.getByText('连接成功', { exact: true })).toBeVisible();
    await page.screenshot({ path: artifact(`settings-${theme}.png`), fullPage: true });
  });
}
