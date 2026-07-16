import { test, expect } from './helpers/e2e-test';
import { e2eState, openApp, waitForModelSubmissions } from './helpers/app';

test('Agent conversation keeps one model conversation while switching GPT Image and Nano Banana 2', async ({ page }) => {
  await openApp(page);

  await expect(page.getByTestId('model-route-image-generation')).toContainText('GPT Image');
  await expect(page.getByTestId('model-route-nano-banana-2-actual-route')).toContainText('Nano Banana 2');
  await expect(page.getByTestId('model-route-gpt-image')).toHaveCount(0);

  await page.getByTestId('model-route-image-generation').click();
  await page.getByTestId('agent-composer-input').fill('Draft route check without model execution');
  await page.getByTestId('agent-send').click();
  await expect(page.getByTestId('plan-model-route')).toContainText('GPT Image');
  await page.getByTestId('plan-cancel').click();
  expect((await e2eState(page)).modelSubmissions).toHaveLength(0);

  await page.getByTestId('agent-tab-conversation').click();
  await page.getByTestId('model-route-nano-banana-2-actual-route').click();
  await page.getByTestId('agent-composer-input').fill('Queue the Nano Banana 2 route only after confirmation');
  await page.getByTestId('agent-send').click();
  await expect(page.getByTestId('plan-model-route')).toContainText('Nano Banana 2');
  expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
  await page.getByTestId('plan-approve-models').check();
  await page.getByTestId('plan-confirm').click();

  await waitForModelSubmissions(page, 1);
  await expect(page.getByTestId('job-chip').first()).toHaveAttribute('data-status', /running|submitting/);
  await page.getByTestId('job-cancel').first().click();
  await page.waitForFunction(() => window.__NOVUS_E2E__!.getState().modelJobs.some((job) => job.status === 'cancelled'));
  await page.getByTestId('job-retry').first().click();
  await waitForModelSubmissions(page, 2);

  await page.getByTestId('agent-tab-conversation').click();
  await page.getByTestId('model-route-image-generation').click();
  await page.getByTestId('agent-composer-input').fill('Switch back to GPT Image in the same Agent conversation');
  await page.getByTestId('agent-send').click();
  await page.getByTestId('plan-approve-models').check();
  await page.getByTestId('plan-confirm').click();

  const state = await waitForModelSubmissions(page, 3);
  expect(new Set(state.modelSubmissions.map((submission) => submission.conversationId))).toEqual(new Set(['agent-conversation-shared']));
  expect(state.modelSubmissions.map((submission) => submission.modelRoute)).toEqual([
    'nano-banana-2-actual-route',
    'nano-banana-2-actual-route',
    'image-generation',
  ]);
  expect(state.modelSubmissions[1]?.id).toBe(state.modelSubmissions[0]?.id);
  expect(state.modelJobs.some((job) => job.status === 'running' && job.modelRoute === 'nano-banana-2-actual-route')).toBe(true);
});
