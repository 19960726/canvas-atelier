import path from 'node:path';
import { expect, test } from './helpers/e2e-test';
import { openEmptyApp } from './helpers/app';

const artifact = (name: string) => path.join(process.cwd(), 'artifacts', '2026-08-08-multi-provider', name);

for (const theme of ['light', 'dark'] as const) {
  test(`four API sites keep separate credentials and capability catalogs in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1680, height: 1050 });
    await page.addInitScript((value) => localStorage.setItem('novus.theme.mode', value), theme);
    await openEmptyApp(page);
    await page.getByTestId('settings-toggle').click();
    const settings = page.getByTestId('settings-drawer');
    await expect(settings).toBeVisible();

    const providers = settings.getByRole('list', { name: '模型供应商' });
    await expect(providers.getByRole('listitem')).toHaveCount(4);
    await expect(providers.getByRole('listitem', { name: /Comfly/u })).toBeEnabled();
    await expect(providers.getByRole('listitem', { name: /RelayMe/u })).toBeEnabled();
    await expect(providers.getByRole('listitem', { name: /巨轮 API/u })).toBeEnabled();
    await expect(providers.getByRole('listitem', { name: /4D AI/u })).toBeEnabled();
    await expect(providers.getByRole('listitem', { name: /GLM/u })).toHaveCount(0);

    await expect.poll(() => page.evaluate(async () => (
      (await window.novusDesktop?.provider.getActiveProvider?.())?.activeProvider
    ))).toBe('comfly');
    await page.evaluate(async () => {
      await window.novusDesktop?.provider.setActiveProvider?.({ activeProvider: 'relayme' });
      globalThis.dispatchEvent(new CustomEvent('novus:provider-catalog-changed'));
    });
    await expect.poll(() => page.evaluate(async () => (
      (await window.novusDesktop?.provider.getActiveProvider?.())?.activeProvider
    ))).toBe('relayme');

    const capabilityTabs = settings.getByRole('tablist', { name: '模型能力分类' });
    await expect(settings.getByRole('region', { name: '生图模型' })).toContainText('GPT Image 2');
    await expect(settings.getByRole('region', { name: '生图模型' })).toContainText('Seedream 5 Pro');
    await capabilityTabs.getByRole('tab', { name: /视频模型/u }).click();
    const comflyVideoModels = settings.getByRole('region', { name: '视频模型' });
    await expect(comflyVideoModels).toContainText('doubao-seedance-2.5');
    await expect(comflyVideoModels).toContainText('veo3.1');
    await expect(comflyVideoModels).toContainText('wan2.2-t2v-plus');
    await expect(comflyVideoModels).not.toContainText(/Grok|MiniMax|Kling/u);
    await capabilityTabs.getByRole('tab', { name: /反推模型/u }).click();
    await expect(settings.getByRole('region', { name: '反推模型' })).toContainText('Gemini 3.1 Pro');

    await providers.getByRole('listitem', { name: /RelayMe/u }).click();
    await expect(settings.getByLabel('API 服务地址（Base URL）')).toHaveValue('https://www.ml.relayme.uk/api/ai-tools/v1');
    await expect(settings.getByRole('button', { name: '配置隐藏密钥' })).toHaveCount(0);
    await expect(settings.getByText('画布只使用 RelayMe 账号登录令牌，不接受独立 API 密钥。')).toBeVisible();
    await capabilityTabs.getByRole('tab', { name: /生图模型/u }).click();
    await expect(settings.getByRole('region', { name: '生图模型' })).toContainText('GPT Image 2');
    await expect(settings.getByRole('region', { name: '生图模型' })).not.toContainText('Gemini Image');
    await capabilityTabs.getByRole('tab', { name: /视频模型/u }).click();
    await expect(settings.getByRole('region', { name: '视频模型' })).toContainText('Kling');
    await capabilityTabs.getByRole('tab', { name: /对话模型/u }).click();
    await expect(settings.getByRole('region', { name: '对话模型' })).toContainText('Gemini Vision');
    await capabilityTabs.getByRole('tab', { name: /反推模型/u }).click();
    await expect(settings.getByRole('region', { name: '反推模型' })).toContainText('GPT Vision');
    await capabilityTabs.getByRole('tab', { name: /生图模型/u }).click();
    await expect(settings.getByRole('region', { name: '生图模型' })).not.toContainText('2K / 4K');
    await capabilityTabs.getByRole('tab', { name: /视频模型/u }).click();
    await expect(settings.getByRole('region', { name: '视频模型' })).not.toContainText('4/6/8 秒');

    await providers.getByRole('listitem', { name: /巨轮 API/u }).click();
    await expect(settings.getByLabel('API 服务地址（Base URL）')).toHaveValue('https://julun.cc/v1');
    await capabilityTabs.getByRole('tab', { name: /视频模型/u }).click();
    await expect(settings.getByRole('region', { name: '视频模型' })).toContainText('seedance-2.0-fast-deal');
    await expect(capabilityTabs.getByRole('tab', { name: /生图模型/u })).toHaveCount(0);
    await expect(settings.getByRole('link', { name: '打开巨轮网站' })).toHaveAttribute('href', 'https://julun.cc');

    await providers.getByRole('listitem', { name: /4D AI/u }).click();
    await expect(settings.getByLabel('API 服务地址（Base URL）')).toHaveValue('https://api.4dai.cc/v1');
    await capabilityTabs.getByRole('tab', { name: /生图模型/u }).click();
    await expect(settings.getByRole('region', { name: '生图模型' })).toContainText('gpt-image-1.5');
    await capabilityTabs.getByRole('tab', { name: /反推模型/u }).click();
    await expect(settings.getByRole('region', { name: '反推模型' })).toContainText('gpt-6-astra');
    await expect(capabilityTabs.getByRole('tab', { name: /视频模型/u })).toHaveCount(0);
    await expect(settings.getByRole('link', { name: '打开 4D AI 网站' })).toHaveAttribute('href', 'https://api.4dai.cc');

    await settings.getByRole('button', { name: '设为优先供应商' }).click();
    await expect.poll(() => page.evaluate(async () => (
      (await window.novusDesktop?.provider.getActiveProvider?.())?.activeProvider
    ))).toBe('4dai');

    await settings.getByRole('button', { name: '检测连接' }).click();
    await expect(settings.getByTestId('settings-provider-layer').getByText('连接成功', { exact: true })).toBeVisible();
    await expect(settings.getByText('高级兼容方式')).toHaveCount(0);
    await expect(settings.getByRole('button', { name: '配置隐藏密钥' })).toBeVisible();
    await expect(settings.getByText('画布只使用 RelayMe 账号登录令牌，不接受独立 API 密钥。')).toHaveCount(0);
    const overview = settings.getByTestId('settings-api-status-layer');
    await overview.scrollIntoViewIfNeeded();
    await expect(overview.getByText('当前优先：4D AI')).toBeVisible();
    await settings.screenshot({ path: artifact(`settings-overview-${theme}.png`) });
    const catalog = settings.getByRole('region', { name: '模型选择列表' });
    await catalog.scrollIntoViewIfNeeded();
    await expect(catalog).toBeVisible();
    await catalog.screenshot({ path: artifact(`model-catalog-${theme}.png`) });
    await page.screenshot({ path: artifact(`settings-${theme}.png`), fullPage: true });
  });
}
