import path from 'node:path';
import { expect, test } from './helpers/e2e-test';
import { e2eState, openEmptyApp, waitForModelSubmissions } from './helpers/app';

const artifact = (name: string) => path.join(
  process.cwd(),
  'artifacts',
  '2026-08-10-complete-project-release',
  name,
);

test('GPT image mode persists its dedicated quality choice and submits high quality at 4K', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1050 });
  await page.addInitScript(() => localStorage.setItem('novus.theme.mode', 'dark'));
  await openEmptyApp(page);
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('image_generation', { x: 500, y: 180 });
  });

  let imageNode = page.locator('[data-module-type="image_generation"]');
  await imageNode.getByRole('button', { name: 'Open image generation editor' }).click();
  const commitsBeforeDraft = (await e2eState(page)).commitCount;
  const model = imageNode.getByRole('combobox', { name: 'Image generation model route' });
  await model.selectOption({ label: 'GPT Image 2' });
  const selectedModelRoute = await model.inputValue();
  expect(selectedModelRoute).toMatch(/^comfly-gpt-image-2/u);
  const quality = imageNode.getByRole('button', { name: 'Image generation quality' });
  await expect(quality).toBeVisible();
  await expect(imageNode.locator('.module-node__generation-control-bar > *:visible')).toHaveCount(8);
  await expect(quality).toHaveAttribute('value', '中');
  await quality.click();
  await imageNode
    .getByRole('menu', { name: 'Image generation quality options' })
    .getByRole('menuitemradio', { name: '高', exact: true })
    .click();

  const resolution = imageNode.getByRole('button', { name: 'Image generation resolution' });
  await resolution.click();
  await imageNode
    .getByRole('menu', { name: 'Image generation resolution options' })
    .getByRole('menuitemradio', { name: '4K' })
    .click();
  await expect(quality).toHaveAttribute('value', '高');
  await expect(resolution).toHaveAttribute('value', '4K');
  const controlTops = await imageNode
    .locator('.module-node__generation-control-bar > *:visible')
    .evaluateAll((controls) => controls.map((control) => Math.round(control.getBoundingClientRect().top)));
  expect(new Set(controlTops).size).toBe(2);
  expect(controlTops.slice(0, 4).every((top) => top === controlTops[0])).toBe(true);
  expect(controlTops.slice(4).every((top) => top === controlTops[4])).toBe(true);
  expect(controlTops[4]! - controlTops[0]!).toBeGreaterThanOrEqual(42);
  const geometry = await imageNode.evaluate((node) => {
    const prompt = node.querySelector('.module-node__prompt-workspace')!.getBoundingClientRect();
    const rail = node.querySelector('.module-node__generation-control-bar')!.getBoundingClientRect();
    const bounds = node.getBoundingClientRect();
    return { promptBottom: prompt.bottom, railTop: rail.top, railBottom: rail.bottom, nodeBottom: bounds.bottom };
  });
  expect(geometry.promptBottom).toBeLessThanOrEqual(geometry.railTop);
  expect(geometry.railBottom).toBeLessThanOrEqual(geometry.nodeBottom + 1);
  await page.screenshot({ path: artifact('10-gpt-quality-high-4k-dark.png'), fullPage: true });

  await expect.poll(async () => {
    const state = await e2eState(page);
    return state.durableImageGenerationConfigs[0];
  }).toMatchObject({
    modelRoute: selectedModelRoute,
    imageQuality: 'high',
    resolution: '4K',
  });
  await expect.poll(async () => (await e2eState(page)).commitCount).toBeGreaterThan(commitsBeforeDraft);
  await page.evaluate(() => window.__NOVUS_E2E__!.reopenProject());
  const reopenedState = await e2eState(page);
  expect(reopenedState.durableNodeCount).toBeGreaterThan(0);
  expect(reopenedState.nodeCount).toBe(reopenedState.durableNodeCount);

  imageNode = page.locator('[data-module-type="image_generation"]');
  const reopenedEditorButton = imageNode.getByRole('button', { name: 'Open image generation editor' });
  if (await reopenedEditorButton.isVisible()) await reopenedEditorButton.click();
  await expect(imageNode.getByRole('combobox', { name: 'Image generation model route' })).toHaveValue(selectedModelRoute);
  await expect(imageNode.getByRole('button', { name: 'Image generation quality' })).toHaveAttribute('value', '高');
  await expect(imageNode.getByRole('button', { name: 'Image generation resolution' })).toHaveAttribute('value', '4K');

  await imageNode.getByRole('textbox', { name: 'Image generation prompt' }).fill('Premium studio product shot');
  await imageNode.getByRole('button', { name: 'Generate image' }).click();
  const submitted = await waitForModelSubmissions(page, 1);
  expect(submitted.modelSubmissions[0]).toMatchObject({
    provider: 'comfly',
    modelRoute: selectedModelRoute,
    imageQuality: 'high',
    resolution: '4K',
  });
});

test('GPT screenshot controls expose complete menus and persist format and background', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.addInitScript(() => localStorage.setItem('novus.theme.mode', 'light'));
  await openEmptyApp(page);
  await page.evaluate(async () => { await window.__NOVUS_E2E__!.createModule('image_generation', { x: 220, y: 120 }); });
  const node = page.locator('[data-module-type="image_generation"]');
  await node.getByRole('button', { name: 'Open image generation editor' }).click();
  await node.getByRole('combobox', { name: 'Image generation model route' }).selectOption({ label: 'GPT Image 2' });
  for (const [name, option] of [
    ['aspect ratio', '3:4'], ['resolution', '4K'], ['batch count', '2张'],
    ['quality', '自动'], ['format', 'WEBP'], ['background', '透明'],
  ]) {
    await node.getByRole('button', { name: `Image generation ${name}`, exact: true }).click();
    const menu = node.getByRole('menu', { name: `Image generation ${name} options` });
    await expect(menu).toBeVisible();
    await page.screenshot({ path: artifact(`gpt-controls-${name!.replaceAll(' ', '-')}-light.png`) });
    await menu.getByRole('menuitemradio', { name: option!, exact: true }).click();
  }
  await expect.poll(async () => (await e2eState(page)).durableImageGenerationConfigs[0]).toMatchObject({
    aspectRatio: '3:4', resolution: '4K', outputCount: 2, imageQuality: 'auto', imageOutputFormat: 'webp', imageBackground: 'transparent',
  });
  await page.screenshot({ path: artifact('gpt-controls-complete-light.png') });
  await page.evaluate(() => window.__NOVUS_E2E__!.reopenProject());
  const expand = node.getByRole('button', { name: 'Open image generation editor' });
  if (await expand.isVisible()) await expand.click();
  await expect(node.getByRole('button', { name: 'Image generation format' })).toHaveAttribute('value', 'WEBP');
  await expect(node.getByRole('button', { name: 'Image generation background' })).toHaveAttribute('value', '透明');
});

test('image and video generation expose the final ratio and clarity controls without submitting a paid task', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1050 });
  await page.addInitScript(() => localStorage.setItem('novus.theme.mode', 'dark'));
  await openEmptyApp(page);
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('image_generation', { x: 500, y: 180 });
  });

  const imageNode = page.locator('[data-module-type="image_generation"]');
  await imageNode.getByRole('button', { name: 'Open image generation editor' }).click();
  const imageAction = imageNode.locator('.module-node__generation-control-bar .module-node__run-generation');
  const imageActionWidth = await imageAction.evaluate((button) => button.getBoundingClientRect().width);
  expect(imageActionWidth).toBeGreaterThan(0);
  await expect(imageNode.locator('.module-node__generation-control-bar > *:visible'), 'Image generation keeps exactly model, ratio, clarity, quantity, and generate visible').toHaveCount(5);
  await expect(imageNode.locator('.module-node__video-model-picker')).toHaveCSS('border-top-width', '0px');

  const imageRatio = imageNode.getByRole('button', { name: 'Image generation aspect ratio' });
  await expect(imageRatio.locator('svg')).toHaveCount(2);
  const imageRailLayout = await imageNode.evaluate((node) => {
    const model = node.querySelector<HTMLElement>('select[aria-label="Image generation model route"]');
    const ratio = node.querySelector<HTMLElement>('button[aria-label="Image generation aspect ratio"]');
    const quantity = node.querySelector<HTMLElement>('button[aria-label="Image generation batch count"]');
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
  await expect(clarityOptions).toHaveText(['1K', '2K', '4K']);
  await page.screenshot({ path: artifact('02-image-clarity-dark.png'), fullPage: true });
  await clarityOptions.filter({ hasText: '4K' }).click();
  await expect(imageClarity).toHaveAttribute('value', '4K');
  await page.screenshot({ path: artifact('05-image-node-compact-dark.png'), fullPage: true });

  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.resetEmpty();
    await window.__NOVUS_E2E__!.createModule('video_generation', { x: 500, y: 180 });
  });

  const videoNode = page.locator('[data-module-type="video_generation"]');
  await videoNode.getByRole('button', { name: 'Open video generation editor' }).click();
  const videoAction = videoNode.locator('.module-node__video-control-bar .module-node__run-generation');
  await expect(videoAction).toBeVisible();
  await expect(videoNode.locator('.module-node__video-control-bar > *:visible'), 'Video generation keeps exactly model, mode, combined settings, and generate visible').toHaveCount(4);
  for (const selector of ['.module-node__video-model-picker', '.module-node__video-mode-picker', '.module-node__video-settings-picker']) {
    await expect(videoNode.locator(selector)).toHaveCSS('border-top-width', '0px');
    await expect(videoNode.locator(selector)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  }
  const videoActionWidth = await videoAction.evaluate((button) => button.getBoundingClientRect().width);
  // The final rail names the action explicitly so it cannot be mistaken for a
  // generic send button, while preserving the compact four-column layout.
  await expect(videoAction).toHaveText('生成视频');
  expect(videoActionWidth).toBeGreaterThanOrEqual(104);
  expect(videoActionWidth).toBeLessThanOrEqual(116);
  const actionBox = await videoAction.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const bar = button.parentElement?.getBoundingClientRect();
    const node = button.closest('[data-module-type="video_generation"]')?.getBoundingClientRect();
    return {
      rightWithinBar: bar !== undefined ? rect.right <= bar.right + 1 : false,
      barInsideNode: bar !== undefined && node !== undefined ? bar.left >= node.left && bar.right <= node.right : false,
    };
  });
  expect(actionBox.rightWithinBar).toBe(true);
  expect(actionBox.barInsideNode).toBe(true);
  const videoSettings = videoNode.getByRole('button', { name: '打开视频参数设置' });
  await expect(videoSettings).toContainText('16:9');
  await expect(videoSettings).toContainText('1080P');
  await videoSettings.click();
  const videoSettingsMenu = videoNode.getByRole('dialog', { name: '视频生成参数' });
  await expect(videoSettingsMenu.getByRole('menuitemradio', { name: 'AUTO' })).toBeVisible();
  await expect(videoSettingsMenu.getByRole('menuitemradio', { name: '16:9' })).toBeVisible();
  const videoSettingsLayout = await videoSettings.evaluate((trigger) => {
    const menu = trigger.parentElement?.querySelector<HTMLElement>('.module-node__video-settings-menu');
    const label = trigger.querySelector<HTMLElement>('.module-node__video-settings-summary');
    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu?.getBoundingClientRect();
    return {
      triggerWidth: triggerRect.width,
      labelFits: label !== null && label.scrollWidth <= label.clientWidth,
      menuInsideNode: menuRect !== undefined
        ? (() => {
          const nodeRect = trigger.closest<HTMLElement>('[data-module-type="video_generation"]')?.getBoundingClientRect();
          return nodeRect !== undefined && menuRect.left >= nodeRect.left && menuRect.right <= nodeRect.right;
        })()
        : false,
    };
  });
  expect(videoSettingsLayout.triggerWidth).toBeGreaterThanOrEqual(220);
  expect(videoSettingsLayout.labelFits).toBe(true);
  expect(videoSettingsLayout.menuInsideNode).toBe(true);
  const videoSettingsColors = await videoSettingsMenu.evaluate((menu) => {
    const node = menu.closest<HTMLElement>('[data-module-type="video_generation"]');
    if (node === null) return { actual: '', expected: '' };
    const probe = document.createElement('span');
    probe.style.position = 'absolute';
    probe.style.backgroundColor = 'var(--gate-card)';
    node.append(probe);
    const expected = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { actual: getComputedStyle(menu).backgroundColor, expected };
  });
  expect(videoSettingsColors.actual, 'The video settings popover must use the same themed surface as the node').toBe(videoSettingsColors.expected);

  const videoQuantity = videoNode.getByRole('combobox', { name: 'Video preview quantity' });
  await expect(videoQuantity).toBeHidden();
  await expect(videoNode.getByRole('combobox', { name: 'Video preview duration' })).toBeHidden();

  const videoResolutionOptions = videoSettingsMenu
    .getByRole('menuitemradio');
  await expect(videoResolutionOptions).toContainText(['720P', '1080P', '2K', '4K']);
  await page.screenshot({ path: artifact('03-video-ratio-dark.png'), fullPage: true });
  await videoResolutionOptions.filter({ hasText: '1080P' }).click();
  await expect(videoSettings).toContainText('1080P');
  await videoSettings.click();
  await expect(videoSettingsMenu).toBeHidden();
  await page.screenshot({ path: artifact('06-video-node-compact-dark.png'), fullPage: true });

  expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
});

test('captures the final image and video controls in light theme without submitting a paid task', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1050 });
  await page.addInitScript(() => localStorage.setItem('novus.theme.mode', 'light'));
  await openEmptyApp(page);
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('image_generation', { x: 500, y: 180 });
  });

  const imageNode = page.locator('[data-module-type="image_generation"]');
  await imageNode.getByRole('button', { name: 'Open image generation editor' }).click();
  await expect(imageNode.locator('.module-node__generation-control-bar > *:visible')).toHaveCount(5);
  await page.screenshot({ path: artifact('07-image-node-compact-light.png'), fullPage: true });
  await imageNode.getByRole('button', { name: 'Image generation aspect ratio' }).click();
  await expect(imageNode.getByRole('menu', { name: 'Image generation aspect ratio options' })).toBeVisible();
  await page.screenshot({ path: artifact('04-image-ratio-light.png'), fullPage: true });

  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.resetEmpty();
    await window.__NOVUS_E2E__!.createModule('video_generation', { x: 500, y: 180 });
  });
  const videoNode = page.locator('[data-module-type="video_generation"]');
  await videoNode.getByRole('button', { name: 'Open video generation editor' }).click();
  await expect(videoNode.locator('.module-node__video-control-bar > *:visible')).toHaveCount(4);
  for (const selector of ['.module-node__video-model-picker', '.module-node__video-mode-picker', '.module-node__video-settings-picker']) {
    await expect(videoNode.locator(selector)).toHaveCSS('border-top-width', '0px');
    await expect(videoNode.locator(selector)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  }
  await page.screenshot({ path: artifact('08-video-node-compact-light.png'), fullPage: true });

  const videoSettings = videoNode.getByRole('button', { name: '打开视频参数设置' });
  await videoSettings.click();
  const videoSettingsMenu = videoNode.getByRole('dialog', { name: '视频生成参数' });
  await expect(videoSettingsMenu).toBeVisible();
  const lightSettingsColors = await videoSettingsMenu.evaluate((menu) => {
    const node = menu.closest<HTMLElement>('[data-module-type="video_generation"]');
    if (node === null) return { actual: '', expected: '' };
    const probe = document.createElement('span');
    probe.style.position = 'absolute';
    probe.style.backgroundColor = 'var(--gate-card)';
    node.append(probe);
    const expected = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { actual: getComputedStyle(menu).backgroundColor, expected };
  });
  expect(lightSettingsColors.actual).toBe(lightSettingsColors.expected);
  await page.screenshot({ path: artifact('09-video-settings-light.png'), fullPage: true });

  expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
});
