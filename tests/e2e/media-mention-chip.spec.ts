import { expect, test } from './helpers/e2e-test';
import { openAgentPanel, openEmptyApp, queueProjectImageImport, queueProjectVideoImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

for (const theme of ['light', 'dark'] as const) {
  test(`managed image and video references render as previewable chips without @ in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1680, height: 1050 });
    await page.addInitScript((nextTheme) => localStorage.setItem('novus.theme.mode', nextTheme), theme);
    await openEmptyApp(page);
    await page.evaluate(async () => {
      await window.__NOVUS_E2E__!.createModule('image_input', { x: 180, y: 220 });
      await window.__NOVUS_E2E__!.createModule('video_input', { x: 680, y: 220 });
    });

    const imageNode = page.locator('[data-module-type="image_input"]');
    const videoNode = page.locator('[data-module-type="video_input"]');
    await queueProjectImageImport(page, makeReferenceImage('Chip product.png', [28, 124, 110, 255], { width: 900, height: 1200 }));
    await imageNode.getByRole('button', { name: '导入图像 / Import image' }).click();
    await queueProjectVideoImport(page, { label: 'Chip motion.mp4' });
    await videoNode.getByRole('button', { name: /Import video/u }).click();

    await openAgentPanel(page);
    const panel = page.getByTestId('agent-panel');
    await panel.getByRole('tab', { name: '对话' }).click();
    await panel.getByTestId('agent-model-trigger').click();
    await panel.getByRole('button', { name: '使用 gpt-5.6-sol' }).first().click();

    const input = panel.getByTestId('agent-composer-input');
    await input.fill('@');
    await panel.getByRole('menuitem', { name: 'Mention Chip product' }).click();
    await expect(input).toContainText('图片1');
    await expect(input).not.toContainText('@');

    const imageChip = input.locator('[data-media-mention="image"]', { hasText: '图片1' });
    await expect(imageChip).toBeVisible();
    await expect(imageChip.locator('img')).toBeVisible();
    await imageChip.hover();
    const imagePreview = panel.getByRole('tooltip', { name: '图片1 素材预览' });
    await expect(imagePreview).toContainText('Chip product');
    await expect(imagePreview.getByRole('img', { name: 'Chip product' })).toBeVisible();

    await input.focus();
    await input.press('End');
    await input.pressSequentially(' @');
    await panel.getByRole('menuitem', { name: 'Mention Chip motion' }).click();
    await expect(input).toContainText('图片1 视频1');
    await expect(input).not.toContainText('@');

    const videoChip = input.locator('[data-media-mention="video"]', { hasText: '视频1' });
    await expect(videoChip).toBeVisible();
    await expect(videoChip.locator('video')).toBeVisible();
    await videoChip.hover();
    const videoPreview = panel.getByRole('tooltip', { name: '视频1 素材预览' });
    await expect(videoPreview).toContainText('Chip motion');
    await expect(videoPreview.locator('video')).toBeVisible();

    await page.screenshot({ path: testInfo.outputPath(`media-mention-chip-${theme}.png`), fullPage: true });
  });
}
