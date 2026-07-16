import { test, expect } from './helpers/e2e-test';
import {
  dragPlacementObject,
  e2eState,
  openApp,
  uploadReference,
  waitForModelSubmissions,
} from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

test('reference placement and Agent plan require explicit canvas and model confirmations', async ({ page }) => {
  await openApp(page);

  await page.getByTestId('tool-placement').click();
  await uploadReference(page, 'upload-product', makeReferenceImage('product.png', [20, 132, 108, 255]));
  await uploadReference(page, 'upload-scene', makeReferenceImage('scene.png', [49, 75, 132, 255]));
  await uploadReference(page, 'upload-prop', makeReferenceImage('prop.png', [198, 92, 40, 255]));

  const placedObjects = page.locator('.placement-object[data-user-reference="true"]');
  await expect(placedObjects).toHaveCount(3);
  await expect(page.locator('.placement-object[data-role="product_identity"][data-user-reference="true"]')).toHaveCount(1);
  await expect(page.locator('.placement-object[data-role="scene_composition"][data-user-reference="true"]')).toHaveCount(1);
  await expect(page.locator('.placement-object[data-role="prop_reference"][data-user-reference="true"]')).toHaveCount(1);

  const rolesInOrder = await page.getByTestId('reference-order-item').evaluateAll((elements) => elements.map((element) => element.getAttribute('data-role')));
  expect(rolesInOrder).toEqual(['product_identity', 'scene_composition', 'prop_reference']);

  const boardBox = await page.getByTestId('placement-board').boundingBox();
  expect(boardBox).not.toBeNull();
  expect(boardBox!.width / boardBox!.height).toBeCloseTo(0.8, 1);

  const commitCountBeforeDrag = (await e2eState(page)).commitCount;
  await dragPlacementObject(page, page.locator('.placement-object[data-role="product_identity"][data-user-reference="true"]').first());
  expect((await e2eState(page)).commitCount).toBe(commitCountBeforeDrag);
  await page.mouse.up();
  await page.waitForFunction((before) => window.__NOVUS_E2E__!.getState().commitCount > before, commitCountBeforeDrag);

  await page.getByTestId('agent-tab-conversation').click();
  await page.getByTestId('image-mention-toggle').click();
  await page.locator('[data-testid="image-mention-item"][data-role="product_identity"]').click();
  await expect(page.getByTestId('agent-composer-input')).toHaveValue(/@/);
  await page.getByTestId('agent-composer-input').pressSequentially(' build a premium 4:5 product scene');
  await page.getByTestId('model-route-image-generation').click();
  await page.getByTestId('agent-send').click();

  await expect(page.getByTestId('plan-preview')).toBeVisible();
  await expect(page.getByTestId('plan-model-route')).toContainText('GPT Image');
  await expect(page.locator('.react-flow__node.agent-ghost-node')).toHaveCount(1);
  await expect(page.locator('.react-flow__edge.agent-ghost-edge')).toHaveCount(1);
  await expect(page.locator('.react-flow__edge.agent-ghost-edge .react-flow__edge-path')).toHaveCSS('stroke-dasharray', /7px, 5px|7 5/);
  expect((await e2eState(page)).modelSubmissions).toHaveLength(0);

  await page.getByTestId('plan-confirm').click();
  await page.waitForFunction(() => window.__NOVUS_E2E__!.getState().projectNodeTypes.includes('review'));
  expect((await e2eState(page)).modelJobs).toHaveLength(0);
  expect((await e2eState(page)).modelSubmissions).toHaveLength(0);

  await page.getByTestId('toolbar-undo').click();
  await page.waitForFunction(() => !window.__NOVUS_E2E__!.getState().projectNodeTypes.includes('review'));

  await page.getByTestId('agent-tab-conversation').click();
  await page.getByTestId('image-mention-toggle').click();
  await page.locator('[data-testid="image-mention-item"][data-role="scene_composition"]').click();
  await page.getByTestId('agent-composer-input').pressSequentially(' regenerate after undo with model approval');
  await page.getByTestId('agent-send').click();
  await page.getByTestId('plan-approve-models').check();
  await page.getByTestId('plan-confirm').click();

  const state = await waitForModelSubmissions(page, 1);
  expect(state.modelSubmissions[0]).toMatchObject({
    conversationId: 'agent-conversation-shared',
    modelRoute: 'image-generation',
  });
});
