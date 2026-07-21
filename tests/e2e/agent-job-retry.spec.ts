import { test, expect } from './helpers/e2e-test';
import {
  e2eState,
  failNextModelJobEnqueue,
  openAgentPanel,
  openApp,
  waitForModelSubmissions,
} from './helpers/app';

test('Agent model queue failure stays visible and retries without another canvas commit', async ({ page }) => {
  await openApp(page);
  await failNextModelJobEnqueue(page);
  await openAgentPanel(page);

  await page.getByTestId('model-route-image-generation').click();
  await page.getByTestId('agent-composer-input').fill('Queue failure should retry only model jobs');
  await page.getByTestId('agent-send').click();
  await page.getByTestId('plan-approve-models').check();
  await page.getByTestId('plan-confirm').click();

  await expect(page.getByTestId('plan-job-retry-state')).toBeVisible();
  await expect(page.getByTestId('plan-retry-jobs')).toContainText(/重试模型任务|Retry model tasks/i);
  let state = await e2eState(page);
  expect(state.commitCount).toBe(1);
  expect(state.modelJobs).toHaveLength(0);
  expect(state.modelSubmissions).toHaveLength(0);

  await page.getByTestId('plan-retry-jobs').dblclick();

  state = await waitForModelSubmissions(page, 1);
  expect(state.commitCount).toBe(1);
  expect(state.modelJobs).toHaveLength(1);
  expect(state.modelSubmissions).toHaveLength(1);
  expect(state.modelSubmissions[0]).toMatchObject({
    conversationId: 'agent-conversation-shared',
    modelRoute: 'image-generation',
  });
});
