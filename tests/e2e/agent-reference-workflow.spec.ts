import { test, expect } from './helpers/e2e-test';
import {
  e2eState,
  openAgentPanel,
  openEmptyApp,
  queueProjectImageImport,
} from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

test('managed canvas images can be mentioned in a vision Skill chat without changing the canvas', async ({ page }) => {
  await openEmptyApp(page);
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('image_input', { x: 120, y: 100 });
    await window.__NOVUS_E2E__!.createModule('image_input', { x: 460, y: 100 });
    await window.__NOVUS_E2E__!.createModule('image_input', { x: 800, y: 100 });
  });
  const imageNodes = page.locator('[data-module-type="image_input"]');
  for (const [index, fixture] of [
    makeReferenceImage('product.png', [20, 132, 108, 255]),
    makeReferenceImage('scene.png', [49, 75, 132, 255]),
    makeReferenceImage('prop.png', [198, 92, 40, 255]),
  ].entries()) {
    await queueProjectImageImport(page, fixture);
    await imageNodes.nth(index).getByRole('button', { name: /Import image/u }).click();
  }
  await expect(imageNodes).toHaveCount(3);
  await expect(imageNodes.getByRole('img')).toHaveCount(3);

  const canvasCommitCount = (await e2eState(page)).commitCount;

  await openAgentPanel(page);
  const panel = page.getByTestId('agent-panel');
  await panel.getByTestId('agent-model-trigger').click();
  const modelOption = panel.getByRole('listitem').first().getByRole('button');
  await expect(modelOption).toBeVisible();
  await modelOption.click();
  const selectedModel = await panel.getByTestId('agent-model-trigger').getAttribute('data-selected-model');
  expect(selectedModel).toBeTruthy();
  await panel.getByTestId('agent-composer-input').pressSequentially('@');
  await panel.getByRole('menuitem').first().click();
  await expect(panel.getByTestId('agent-composer-input')).toHaveText(/图片1/);
  await panel.getByTestId('agent-composer-input').pressSequentially(' describe the composition');
  await panel.getByTestId('agent-composer-input').press('Enter');

  await expect(page.getByLabel(`知识库请求: ${selectedModel}`)).toHaveCount(0);
  await expect(panel.getByText('知识库请求', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Mock Skill reply:/)).toBeVisible();
  expect((await e2eState(page)).commitCount).toBe(canvasCommitCount);
  expect((await e2eState(page)).modelJobs).toHaveLength(0);
  expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
});
