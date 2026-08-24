import path from 'node:path';
import { expect, test } from './helpers/e2e-test';
import { openAgentPanel, openEmptyApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

const artifact = (name: string) => path.join(process.cwd(), 'artifacts', '2026-08-06-agent-multimedia', name);

for (const theme of ['light', 'dark'] as const) {
  test(`Agent chat shows the managed thumbnail @图片1 picker below the composer in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1680, height: 1050 });
    await page.addInitScript((nextTheme) => localStorage.setItem('novus.theme.mode', nextTheme), theme);
    await openEmptyApp(page);
    await page.evaluate(async () => {
      await window.__NOVUS_E2E__!.createModule('image_input', { x: 180, y: 420 });
    });
    const imageNode = page.locator('[data-module-type="image_input"]');
    await queueProjectImageImport(page, makeReferenceImage('Agent citation.png', [28, 124, 110, 255], { width: 900, height: 1200 }));
    await imageNode.getByRole('button', { name: '导入图像 / Import image' }).click();

    await openAgentPanel(page);
    const panel = page.getByTestId('agent-panel');
    await panel.getByTestId('agent-model-trigger').click();
    await panel.getByRole('button', { name: '使用 Gemini Vision' }).first().click();
    await panel.getByTestId('agent-composer-input').fill('@');
    const menu = panel.getByRole('menu', { name: 'Reference images' });
    await expect(menu).toBeVisible();
    const item = menu.getByRole('menuitem', { name: 'Mention Agent citation' });
    await expect(item.getByRole('img')).toBeVisible();
    await expect(item).toContainText('@图片1');
    await page.screenshot({ path: artifact(`agent-chat-image-picker-${theme}.png`), fullPage: true });

    await item.click();
    await expect(panel.getByTestId('agent-composer-input')).toHaveValue('@图片1');
    const presentation = panel.getByTestId('media-mention-presentation');
    await expect(presentation.locator('mark[data-media-mention="image"]')).toHaveText('图片1');
    await expect(presentation).not.toContainText('@');
    await expect(panel.getByLabel('Selected image references')).toContainText('Agent citation');
  });
}
