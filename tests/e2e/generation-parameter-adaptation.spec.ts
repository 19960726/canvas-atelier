import path from 'node:path';
import { expect, test } from './helpers/e2e-test';
import { e2eState, openEmptyApp } from './helpers/app';

const artifact = (name: string) => path.join(
  process.cwd(),
  'artifacts',
  '2026-08-10-complete-project-release',
  name,
);

test('image and video generation expose the final ratio and clarity controls without submitting a paid task', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1050 });
  await page.addInitScript(() => localStorage.setItem('novus.theme.mode', 'dark'));
  await openEmptyApp(page);
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('image_generation', { x: 500, y: 180 });
  });

  const imageNode = page.locator('[data-module-type="image_generation"]');
  await imageNode.getByRole('button', { name: 'Open image generation editor' }).click();

  const imageRatio = imageNode.getByRole('button', { name: 'Image generation aspect ratio' });
  await expect(imageRatio.locator('svg')).toHaveCount(2);
  const imageRailLayout = await imageNode.evaluate((node) => {
    const model = node.querySelector<HTMLElement>('select[aria-label="Image generation model route"]');
    const ratio = node.querySelector<HTMLElement>('button[aria-label="Image generation aspect ratio"]');
    const quantity = node.querySelector<HTMLElement>('select[aria-label="Image generation quantity"]');
    const modelRect = model?.getBoundingClientRect();
    const ratioRect = ratio?.getBoundingClientRect();
    const quantityRect = quantity?.getBoundingClientRect();
    return {
      modelWidth: modelRect?.width ?? 0,
      ratioWidth: ratioRect?.width ?? 0,
      quantityWidth: quantityRect?.width ?? 0,
      modelToRatioGap: modelRect === undefined || ratioRect === undefined
        ? Number.POSITIVE_INFINITY
        : ratioRect.left - modelRect.right,
    };
  });
  expect(imageRailLayout.modelWidth).toBeLessThanOrEqual(350);
  expect(imageRailLayout.ratioWidth).toBeGreaterThanOrEqual(80);
  expect(imageRailLayout.ratioWidth).toBeLessThanOrEqual(116);
  expect(imageRailLayout.quantityWidth).toBeGreaterThanOrEqual(90);
  expect(imageRailLayout.modelToRatioGap).toBeGreaterThanOrEqual(8);
  expect(imageRailLayout.modelToRatioGap).toBeLessThanOrEqual(12);
  await imageRatio.click();
  const imageRatioMenu = imageNode.getByRole('menu', { name: 'Image generation aspect ratio options' });
  await expect(imageRatioMenu.getByRole('menuitemradio', { name: 'AUTO' })).toBeVisible();
  await expect(imageRatioMenu.getByRole('menuitemradio', { name: '1:1' })).toBeVisible();
  await expect(imageRatioMenu.getByRole('menuitemradio', { name: '16:9' })).toBeVisible();
  const imageRatioMenuLayout = await imageRatio.evaluate((trigger) => {
    const root = trigger.parentElement;
    const node = trigger.closest<HTMLElement>('[data-module-type="image_generation"]');
    const menu = root?.querySelector<HTMLElement>('.generation-parameter-popover__menu');
    const nodeRect = node?.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu?.getBoundingClientRect();
    return {
      centeredAboveTrigger: menuRect !== undefined
        ? Math.abs((menuRect.left + menuRect.width / 2) - (triggerRect.left + triggerRect.width / 2)) <= 2
        : false,
      insideNode: nodeRect !== undefined && menuRect !== undefined
        ? menuRect.left >= nodeRect.left && menuRect.right <= nodeRect.right
        : false,
    };
  });
  expect(imageRatioMenuLayout.centeredAboveTrigger).toBe(true);
  expect(imageRatioMenuLayout.insideNode).toBe(true);
  await page.screenshot({ path: artifact('01-image-ratio-dark.png'), fullPage: true });
  await imageRatioMenu.getByRole('menuitemradio', { name: 'AUTO' }).click();
  await expect(imageRatio).toHaveAttribute('value', 'AUTO');

  const imageClarity = imageNode.getByRole('button', { name: 'Image generation resolution' });
  const imageClarityTriggerWidth = await imageClarity.evaluate((trigger) => trigger.getBoundingClientRect().width);
  expect(imageClarityTriggerWidth).toBeGreaterThanOrEqual(74);
  expect(imageClarityTriggerWidth).toBeLessThanOrEqual(116);
  await imageClarity.click();
  const clarityOptions = imageNode
    .getByRole('menu', { name: 'Image generation resolution options' })
    .getByRole('menuitemradio');
  await expect(clarityOptions).toHaveText(['2K', '4K']);
  await page.screenshot({ path: artifact('02-image-clarity-dark.png'), fullPage: true });
  await clarityOptions.filter({ hasText: '4K' }).click();
  await expect(imageClarity).toHaveAttribute('value', '4K');

  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.resetEmpty();
    await window.__NOVUS_E2E__!.createModule('video_generation', { x: 500, y: 180 });
  });

  const videoNode = page.locator('[data-module-type="video_generation"]');
  await videoNode.getByRole('button', { name: 'Open video generation editor' }).click();
  const videoAction = videoNode.locator('.module-node__video-control-bar .module-node__run-generation');
  await expect(videoAction).toBeVisible();
  const actionBox = await videoAction.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const bar = button.parentElement?.getBoundingClientRect();
    const node = button.closest('[data-module-type="video_generation"]')?.getBoundingClientRect();
    return {
      rightWithinBar: bar !== undefined ? rect.right <= bar.right - 2 : false,
      barInsideNode: bar !== undefined && node !== undefined ? bar.left >= node.left && bar.right <= node.right : false,
    };
  });
  expect(actionBox.rightWithinBar).toBe(true);
  expect(actionBox.barInsideNode).toBe(true);
  const videoRatio = videoNode.getByRole('button', { name: 'Video preview aspect ratio' });
  await expect(videoRatio.locator('svg')).toHaveCount(2);
  await videoRatio.click();
  const videoRatioMenu = videoNode.getByRole('menu', { name: 'Video preview aspect ratio options' });
  await expect(videoRatioMenu.getByRole('menuitemradio')).toHaveText([
    'AUTO', '1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9',
  ]);
  await expect(videoRatioMenu.locator('svg').first()).toBeVisible();
  const videoRatioLayout = await videoRatio.evaluate((trigger) => {
    const menu = trigger.parentElement?.querySelector<HTMLElement>('.generation-parameter-popover__menu');
    const label = trigger.querySelector<HTMLElement>('span');
    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu?.getBoundingClientRect();
    return {
      triggerWidth: triggerRect.width,
      labelFits: label !== null && label.scrollWidth <= label.clientWidth,
      menuGap: menuRect === undefined ? Number.POSITIVE_INFINITY : triggerRect.top - menuRect.bottom,
    };
  });
  expect(videoRatioLayout.triggerWidth).toBeGreaterThanOrEqual(108);
  expect(videoRatioLayout.triggerWidth).toBeLessThanOrEqual(116);
  expect(videoRatioLayout.labelFits).toBe(true);
  expect(videoRatioLayout.menuGap).toBeGreaterThanOrEqual(4);
  expect(videoRatioLayout.menuGap).toBeLessThanOrEqual(12);

  const videoQuantity = videoNode.getByRole('combobox', { name: 'Video preview quantity' });
  await expect(videoQuantity).toBeVisible();
  await expect(videoQuantity).toHaveValue('1');

  const videoResolution = videoNode.getByRole('button', { name: 'Video preview resolution' });
  await expect(videoResolution.locator('svg')).toHaveCount(1);
  await videoResolution.click();
  await expect(videoNode.getByRole('menu', { name: 'Video preview resolution options' }).getByRole('menuitemradio')).toHaveText(['480P', '720P', '1080P']);
  await page.screenshot({ path: artifact('03-video-ratio-dark.png'), fullPage: true });

  expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
});

test('captures the image ratio control in light theme without submitting a paid task', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1050 });
  await page.addInitScript(() => localStorage.setItem('novus.theme.mode', 'light'));
  await openEmptyApp(page);
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('image_generation', { x: 500, y: 180 });
  });

  const imageNode = page.locator('[data-module-type="image_generation"]');
  await imageNode.getByRole('button', { name: 'Open image generation editor' }).click();
  await imageNode.getByRole('button', { name: 'Image generation aspect ratio' }).click();
  await expect(imageNode.getByRole('menu', { name: 'Image generation aspect ratio options' })).toBeVisible();
  await page.screenshot({ path: artifact('04-image-ratio-light.png'), fullPage: true });

  expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
});
