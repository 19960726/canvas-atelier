import { test, expect } from './helpers/e2e-test';
import { e2eState, openApp, seedSkillSyncDivergence } from './helpers/app';

test('Skill sync stays guarded until explicit Chinese confirmation', async ({ page }) => {
  await openApp(page);
  await seedSkillSyncDivergence(page);

  await page.getByTestId('agent-tab-memory').click();
  await expect(page.getByTestId('skill-candidate-review')).toBeVisible();
  await expect(page.getByTestId('skill-sync-source')).toContainText('Source rule body: lock logo from local project memory.');
  await expect(page.getByTestId('skill-sync-managed')).toContainText('Managed rule body: keep the existing cool background lighting.');
  await expect(page.getByTestId('skill-sync-proposed')).toContainText('Proposed rule body: lock logo and prop spacing together.');
  const diffTexts = await Promise.all([
    page.getByTestId('skill-sync-source').innerText(),
    page.getByTestId('skill-sync-managed').innerText(),
    page.getByTestId('skill-sync-proposed').innerText(),
  ]);
  expect(new Set(diffTexts).size).toBe(3);
  expect((await e2eState(page)).skillSyncWrites).toHaveLength(0);

  await page.getByTestId('skill-approve').click();
  await expect(page.getByTestId('skill-sync-confirmation')).toBeVisible();
  expect((await e2eState(page)).skillSyncWrites).toHaveLength(0);

  await page.getByTestId('skill-confirm-sync').click();
  await page.waitForFunction(() => window.__NOVUS_E2E__!.getState().skillSyncWrites.length === 1);
  const writes = (await e2eState(page)).skillSyncWrites;
  expect(writes[0]).toMatchObject({
    candidateId: expect.stringMatching(/^skill-candidate-/),
    decision: 'approved',
    projectId: 'local-project',
  });
  await expect(page.getByTestId('skill-candidate-status')).toContainText('approved');
});
