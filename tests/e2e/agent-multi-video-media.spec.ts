import path from 'node:path';
import { expect, test } from './helpers/e2e-test';
import { e2eState, openEmptyApp, queueProjectImageImport, queueProjectVideoImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

const artifact = (name: string) => path.join(process.cwd(), 'artifacts', '2026-08-06-agent-multimedia', name);

for (const theme of ['light', 'dark'] as const) {
  test(`reverse Agent preserves and reorders mixed image and multiple video slots in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1680, height: 1050 });
    await page.addInitScript((nextTheme) => localStorage.setItem('novus.theme.mode', nextTheme), theme);
    await openEmptyApp(page);
    await page.evaluate(async () => {
      await window.__NOVUS_E2E__!.createModule('image_input', { x: 180, y: 80 });
      await window.__NOVUS_E2E__!.createModule('video_input', { x: 180, y: 350 });
      await window.__NOVUS_E2E__!.createModule('video_input', { x: 180, y: 620 });
      await window.__NOVUS_E2E__!.createModule('reverse_agent', { x: 520, y: 160 });
    });

    const imageNode = page.locator('[data-module-type="image_input"]');
    const videoNodes = page.locator('[data-module-type="video_input"]');
    const reverse = page.locator('[data-module-type="reverse_agent"]');
    await queueProjectImageImport(page, makeReferenceImage('Product reference.png', [22, 128, 112, 255], { width: 960, height: 720 }));
    await imageNode.getByRole('button', { name: '导入图像 / Import image' }).click();
    await queueProjectVideoImport(page, { label: 'Opening motion.mp4' });
    await videoNodes.nth(0).getByRole('button', { name: /Import video/u }).click();
    await queueProjectVideoImport(page, { label: 'Detail motion.mp4' });
    await videoNodes.nth(1).getByRole('button', { name: /Import video/u }).click();

    const target = reverse.locator('[data-port-id="references"].react-flow__handle');
    await imageNode.locator('[data-port-id="image"].react-flow__handle').dragTo(target);
    await videoNodes.nth(0).locator('[data-port-id="video"].react-flow__handle').dragTo(target);
    await videoNodes.nth(1).locator('[data-port-id="video"].react-flow__handle').dragTo(target);
    await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(3);

    const slots = reverse.getByLabel('Connected reverse media slots');
    await expect(slots.getByLabel(/Agent media slot/u)).toHaveCount(3);
    await expect(slots).toContainText('3 / 20');
    await expect(slots.getByRole('img', { name: 'Product reference' })).toBeVisible();
    await expect(slots.locator('video[aria-label^="Opening motion"]')).toBeVisible();
    await expect(slots.locator('video[aria-label^="Detail motion"]')).toBeVisible();

    await slots.getByRole('button', { name: 'Move Detail motion left' }).click();
    await expect(slots.getByLabel('Agent media slot 2')).toHaveAttribute('title', /Detail motion/u);
    await expect(slots.getByLabel('Agent media slot 3')).toHaveAttribute('title', /Opening motion/u);
    await page.screenshot({ path: artifact(`reverse-multi-video-reordered-${theme}.png`), fullPage: true });
  });

  test(`reverse Agent uses the thumbnail @图片1 picker and citation-only execution in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1680, height: 1050 });
    await page.addInitScript((nextTheme) => localStorage.setItem('novus.theme.mode', nextTheme), theme);
    await openEmptyApp(page);
    await page.evaluate(async () => {
      await window.__NOVUS_E2E__!.createModule('image_input', { x: 180, y: 160 });
      await window.__NOVUS_E2E__!.createModule('reverse_agent', { x: 520, y: 120 });
      await window.__NOVUS_E2E__!.createModule('reverse_result', { x: 1040, y: 220 });
      await window.__NOVUS_E2E__!.connectModules('reverse_agent', 'analysis', 'reverse_result', 'analysis');
      await window.__NOVUS_E2E__!.configureModule('reverse_agent', {
        config: {
          modelRoute: 'reverse/e2e-gemini-native',
          role: 'Commercial visual analyst',
          task: 'Analyze the managed image.',
          knowledgeBaseIds: [],
        },
      });
    });
    const imageNode = page.locator('[data-module-type="image_input"]');
    const reverse = page.locator('[data-module-type="reverse_agent"]');
    await queueProjectImageImport(page, makeReferenceImage('Citation product.png', [38, 118, 102, 255], { width: 1024, height: 1024 }));
    await imageNode.getByRole('button', { name: '导入图像 / Import image' }).click();

    await reverse.getByLabel('Role positioning').fill('Commercial visual analyst');
    await reverse.getByLabel('Analysis task').fill('@');
    const picker = reverse.getByRole('menu', { name: 'Select reference image' });
    await expect(picker).toBeVisible();
    const item = picker.getByRole('menuitem', { name: 'Citation product' });
    await expect(item.getByRole('img', { name: 'Citation product' })).toBeVisible();
    await expect(item).toContainText('@图片1');
    await page.screenshot({ path: artifact(`reverse-image-picker-${theme}.png`), fullPage: true });
    await item.click();
    await expect(reverse.getByLabel('Analysis task')).toHaveValue('@图片1');
    const presentation = reverse.getByTestId('media-mention-presentation');
    await expect(presentation.locator('mark[data-media-mention="image"]')).toHaveText('图片1');
    await expect(presentation).not.toContainText('@');

    await reverse.getByRole('button', { name: 'Start reverse analysis' }).click();
    const reverseResult = page.locator('[data-module-type="reverse_result"]');
    await expect(reverseResult.getByText(/Cinematic commercial product still/u)).toBeVisible();
    await page.screenshot({ path: artifact(`reverse-citation-result-${theme}.png`), fullPage: true });
  });
}
