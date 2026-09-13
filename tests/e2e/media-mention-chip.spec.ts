import { expect, test } from './helpers/e2e-test';
import { openAgentPanel, openEmptyApp, queueProjectImageImport, queueProjectVideoImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

for (const theme of ['light', 'dark'] as const) {
  test(`managed images render as previewable Agent chips while project videos stay unavailable in ${theme}`, async ({ page }, testInfo) => {
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
    const menu = panel.getByRole('menu', { name: 'Reference images' });
    await menu.getByRole('button', { name: '浏览项目图片' }).click();
    await expect(menu.getByRole('menuitem', { name: 'Mention Chip product' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Mention Chip motion' })).toHaveCount(0);
    await expect(menu).not.toContainText('Chip motion');
    await menu.getByRole('menuitem', { name: 'Mention Chip product' }).click();
    await expect(input).toContainText('图片1');
    await expect(input).not.toContainText('@');

    const imageChip = input.locator('[data-media-mention="image"]', { hasText: '图片1' });
    await expect(imageChip).toBeVisible();
    await expect(imageChip.locator('img')).toBeVisible();
    await imageChip.hover();
    const imagePreview = panel.getByRole('tooltip', { name: '图片1 素材预览' });
    await expect(imagePreview).toContainText('Chip product');
    await expect(imagePreview.getByRole('img', { name: 'Chip product' })).toBeVisible();

    await expect(input.locator('[data-media-mention="video"]')).toHaveCount(0);
    const geometry = await input.evaluate((element) => ({
      editorWhiteSpace: getComputedStyle(element).whiteSpace,
      chips: [...element.querySelectorAll<HTMLElement>('.media-mention-textarea__chip')].map((chip) => {
        const box = chip.getBoundingClientRect();
        const media = chip.querySelector<HTMLElement>('img, video')?.getBoundingClientRect();
        return {
          display: getComputedStyle(chip).display,
          height: box.height,
          width: box.width,
          mediaHeight: media?.height ?? 0,
          mediaWidth: media?.width ?? 0,
        };
      }),
    }));
    expect(geometry.editorWhiteSpace).toBe('pre-wrap');
    expect(geometry.chips).toHaveLength(1);
    for (const chip of geometry.chips) {
      expect(chip.display).toBe('inline-flex');
      expect(chip.height).toBe(24);
      expect(chip.width).toBeLessThan(220);
      expect(chip.mediaWidth).toBe(16);
      expect(chip.mediaHeight).toBe(16);
    }
    await page.screenshot({ path: testInfo.outputPath(`media-mention-chip-${theme}.png`), fullPage: true });
  });
}
