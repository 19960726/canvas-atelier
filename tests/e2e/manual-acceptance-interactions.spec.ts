import { expect, test } from './helpers/e2e-test';
import { e2eState, openEmptyApp } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

test('manual acceptance keeps model, storage, and Agent controls interactive', async ({ page }) => {
  await openEmptyApp(page, '/?novusHarness=novus-e2e-codex-ui-gate');

  await page.getByTestId('settings-toggle').click();
  const settings = page.getByTestId('settings-drawer');
  await expect(settings).toBeVisible();
  await settings.getByRole('tab').nth(0).click();
  const modelGroups = settings.locator('.settings-model-group');
  await expect(modelGroups).toHaveCount(5);
  await expect(modelGroups.nth(0).locator('.settings-model-list article')).not.toHaveCount(0);
  await expect(modelGroups.nth(4).locator('.settings-model-list article')).not.toHaveCount(0);
  const defaultImage = settings.getByLabel('生图默认模型');
  const imageModelValue = await defaultImage.locator('option').evaluateAll((options) => (
    options.map((option) => (option as HTMLOptionElement).value).find((value) => value.length > 0) ?? ''
  ));
  expect(imageModelValue).not.toBe('');
  await defaultImage.selectOption(imageModelValue);
  await expect(defaultImage).toHaveValue(imageModelValue);

  await settings.getByRole('tab').nth(1).click();
  const storageActions = settings.locator('.settings-cache-directory-actions button');
  await expect(storageActions).toHaveCount(3);
  await expect(storageActions.nth(1)).toBeEnabled();
  await storageActions.nth(1).click();
  const cachePath = settings.locator('.settings-cache-directory-field input');
  await expect(cachePath).toHaveValue('Browser acceptance custom cache');
  await storageActions.nth(2).click();
  await expect(cachePath).toHaveValue('Browser acceptance cache');
  await settings.getByTestId('settings-drawer-close').click();

  await page.getByTestId('agent-toggle').click();
  const composer = page.getByTestId('agent-composer-input');
  await expect(composer).toBeVisible();
  await page.getByRole('tab', { name: '对话' }).click();
  await page.getByTestId('agent-model-trigger').click();
  await page.locator('.skill-chat-workbench__sheet button').filter({ hasText: 'gpt-5.6-sol' }).first().click();
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.locator('.skill-chat-workbench__composer-footer > button').first().click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({ name: 'agent-reference.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) });
  await expect(page.locator('.skill-chat-workbench__image-tags img')).toBeVisible();
  const send = page.locator('.skill-chat-workbench__composer button[type="submit"]');
  await composer.fill('Test Agent message');
  await expect(send).toBeEnabled();
  expect((await send.innerText()).trim()).toBe('');
  await page.getByTestId('knowledge-base-trigger').click();
  await expect(page.locator('.skill-chat-workbench__sheet')).toBeVisible();
});
test('manual canvas upload renders the selected image bytes in input and connected generation slots', async ({ page }) => {
  await openEmptyApp(page, '/?novusHarness=novus-e2e-codex-ui-gate');
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('image_input', { x: 180, y: 220 });
    await window.__NOVUS_E2E__!.createModule('image_generation', { x: 620, y: 180 });
  });

  const fixture = makeReferenceImage('manual-real-reference.png', [36, 172, 146, 255], { width: 640, height: 480 });
  const imageInput = page.locator('[data-module-type="image_input"]');
  const imageGeneration = page.locator('[data-module-type="image_generation"]');
  const chooserPromise = page.waitForEvent('filechooser');
  await imageInput.getByRole('button', { name: /Import image/ }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: fixture.name, mimeType: fixture.mimeType, buffer: fixture.buffer });

  const importedImage = imageInput.locator('img');
  await expect(importedImage).toBeVisible();
  await expect.poll(async () => importedImage.getAttribute('src')).toMatch(/^data:image\/png;base64,/u);

  await imageInput.locator('[data-port-id="image"].react-flow__handle').dragTo(imageGeneration.locator('[data-port-id="references"].react-flow__handle'));
  await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(1);
  const connectedThumbnail = imageGeneration.getByLabel('Image generation reference slots').locator('img');
  await expect(connectedThumbnail).toBeVisible();
  await expect.poll(async () => connectedThumbnail.getAttribute('src')).toMatch(/^data:image\/png;base64,/u);
});
