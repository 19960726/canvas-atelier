import { test, expect } from './helpers/e2e-test';
import {
  assertLocatorInside,
  assertNoTrackedRegionsOverlap,
  captureLayoutScreenshot,
  openApp,
} from './helpers/app';

const viewports = [
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
];

for (const theme of ['light', 'dark'] as const) {
  for (const viewport of viewports) {
    test(`unified module workbench is contained at ${viewport.name} ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await openApp(page);
      await page.getByLabel('主题 Theme').selectOption(theme);
      await page.getByTestId('tool-modules').click();
      await page.evaluate(async () => {
        await window.__NOVUS_E2E__?.createModule('image_generation', { x: 360, y: 80 });
        await window.__NOVUS_E2E__?.createModule('reverse_agent', { x: 680, y: 80 });
      });

      const library = page.getByTestId('module-library');
      const canvas = page.getByTestId('canvas-stage');
      await expect(page.locator('[data-module-type="image_generation"]')).toHaveCount(1);
      await expect(page.locator('[data-module-type="reverse_agent"]')).toHaveCount(1);
      await expect(page.locator('[data-module-type="image_generation_v1"], [data-module-type="image_generation_v2"], [data-module-type="video_analysis"]')).toHaveCount(0);
      await assertLocatorInside(canvas, library, `module library ${viewport.name} ${theme}`);
      await assertLocatorInside(canvas, page.locator('[data-module-type="image_generation"]'), `generation node ${viewport.name} ${theme}`);
      await assertLocatorInside(canvas, page.locator('[data-module-type="reverse_agent"]'), `reverse node ${viewport.name} ${theme}`);
      await assertNoTrackedRegionsOverlap(page, ['module-library', 'agent-panel', 'job-strip']);

      const before = await canvas.boundingBox();
      await page.getByTestId('agent-panel').getByRole('button', { name: '折叠 Agent 面板' }).click();
      const after = await canvas.boundingBox();
      expect(after!.width).toBeGreaterThan(before!.width + 300);
      await page.getByTestId('toolrail').getByRole('button', { name: '展开 Agent 面板' }).click();

      await captureLayoutScreenshot(page, testInfo, `formal-module-workbench-${viewport.name}-${theme}`);
    });
  }
}
