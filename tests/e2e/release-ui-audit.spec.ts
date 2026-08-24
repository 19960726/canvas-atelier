import { test, expect } from './helpers/e2e-test';
import {
  captureLayoutScreenshot,
  openAgentPanel,
  openEmptyApp,
  queueProjectImageImport,
} from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

async function captureSurface(
  page: Parameters<typeof openEmptyApp>[0],
  testInfo: Parameters<typeof captureLayoutScreenshot>[1],
  name: string,
): Promise<void> {
  await expect(page.getByTestId('workspace')).toBeVisible();
  await captureLayoutScreenshot(page, testInfo, name);
}

for (const theme of ['dark', 'light'] as const) {
  test(`keeps the Figma 408 reverse-agent form intact in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openEmptyApp(page);
    await page.getByLabel('主题 Theme').selectOption(theme);
    await page.evaluate(async () => {
      await window.__NOVUS_E2E__!.createModule('image_input', { x: 110, y: 320 });
      await window.__NOVUS_E2E__!.createModule('reverse_agent', { x: 300, y: 154 });
    });

    const reverse = page.locator('[data-module-type="reverse_agent"]');
    const emptyRail = reverse.getByLabel('Reverse media workspace');
    await expect(emptyRail).toBeVisible();
    await expect(emptyRail).toHaveClass(/module-node__agent-media-empty-hint/);
    await expect(emptyRail.locator('img')).toHaveCount(0);
    await captureSurface(page, testInfo, `reverse-agent-empty-${theme}`);

    const image = page.locator('[data-module-type="image_input"]');
    await queueProjectImageImport(page, makeReferenceImage('Reverse layout reference.png', [34, 120, 168, 255], { width: 640, height: 360 }));
    await image.getByRole('button', { name: '导入图像 / Import image' }).click();
    await expect(image.getByRole('img', { name: 'Reverse layout reference' })).toBeVisible();
    await page.evaluate(() => window.__NOVUS_E2E__!.connectModules('image_input', 'image', 'reverse_agent', 'references'));

    await expect(reverse).toHaveCSS('width', '426px');
    await expect(reverse).toHaveCSS('height', '646px');
    await expect(reverse.getByLabel('Agent model route')).toBeVisible();
    await expect(reverse.getByRole('button', { name: '添加反推素材' })).toBeVisible();
    await expect(reverse.getByRole('textbox', { name: 'Role positioning' })).toBeVisible();
    const analysisTask = reverse.getByRole('textbox', { name: 'Analysis task' });
    await expect(analysisTask).toBeVisible();
    await expect(reverse.getByRole('button', { name: '引用图片' })).toHaveCount(0);
    await analysisTask.fill('@');
    const mentionMenu = reverse.getByRole('menu', { name: 'Select reference image' });
    await expect(mentionMenu).toBeVisible();
    await mentionMenu.getByRole('menuitem', { name: /Reverse layout reference/u }).click();
    await expect(analysisTask).toHaveValue('@1');
    await expect(mentionMenu).toBeHidden();
    const knowledgeTrigger = reverse.getByLabel('Reverse knowledge context').getByRole('button');
    await expect(knowledgeTrigger).toHaveCSS('width', '390px');
    await expect(knowledgeTrigger).toHaveCSS('height', '50px');
    const [reverseBox, workbenchBox, mediaBox, routeBox, roleBox, taskBox, addReferenceBox, knowledgeBox, actionsBox] = await Promise.all([
      reverse.boundingBox(),
      reverse.locator('.module-node__workbench').boundingBox(),
      reverse.getByLabel('Reverse media workspace').boundingBox(),
      reverse.getByLabel('Agent model route').boundingBox(),
      reverse.getByRole('textbox', { name: 'Role positioning' }).boundingBox(),
      analysisTask.boundingBox(),
      reverse.getByRole('button', { name: '添加反推素材' }).boundingBox(),
      knowledgeTrigger.boundingBox(),
      reverse.getByLabel('Reverse task actions').boundingBox(),
    ]);
    expect([reverseBox, workbenchBox, mediaBox, routeBox, roleBox, taskBox, addReferenceBox, knowledgeBox, actionsBox].every(Boolean)).toBe(true);
    await testInfo.attach('reverse-agent-layout.json', {
      body: JSON.stringify({
        media: mediaBox!.y - reverseBox!.y,
        route: routeBox!.y - reverseBox!.y,
        role: roleBox!.y - reverseBox!.y,
        task: taskBox!.y - reverseBox!.y,
        knowledge: knowledgeBox!.y - reverseBox!.y,
        actions: actionsBox!.y - reverseBox!.y,
      }),
      contentType: 'application/json',
    });
    // React Flow can render the authored geometry at a viewport scale other
    // than 1.  Compare positions in Figma-card coordinates, not screen px.
    const canvasScale = reverseBox!.width / 426;
    expect(Math.abs(mediaBox!.y - reverseBox!.y - 88 * canvasScale)).toBeLessThanOrEqual(1.5);
    expect(addReferenceBox!.width).toBeGreaterThan(0);
    expect(Math.abs(routeBox!.y - reverseBox!.y - 157 * canvasScale)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(roleBox!.y - reverseBox!.y - 228 * canvasScale)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(taskBox!.y - reverseBox!.y - 360 * canvasScale)).toBeLessThanOrEqual(1.5);
    expect(actionsBox!.y + actionsBox!.height, 'Reverse task actions must remain inside the dedicated Figma workbench, not be clipped by a legacy shell').toBeLessThanOrEqual(workbenchBox!.y + workbenchBox!.height);
    expect(Math.abs(knowledgeBox!.y - reverseBox!.y - 529 * canvasScale)).toBeLessThanOrEqual(2);
    expect(Math.abs(actionsBox!.y - reverseBox!.y - 579 * canvasScale)).toBeLessThanOrEqual(1.5);
    expect(
      Math.abs((actionsBox!.x + actionsBox!.width / 2) - (reverseBox!.x + reverseBox!.width / 2)),
      'Reverse action buttons must stay centered on the Figma card midpoint in both themes',
    ).toBeLessThanOrEqual(1);
    await captureSurface(page, testInfo, `reverse-agent-${theme}`);
  });
}

test('captures the release UI audit set for dark and light themes', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openEmptyApp(page);
  await page.getByLabel('主题 Theme').selectOption('dark');
  await expect(page.getByTestId('workspace')).toHaveAttribute('data-secondary-surface', 'none');
  await expect(page.getByTestId('job-strip')).toBeHidden();
  await expect(page.locator('.react-flow__minimap')).toBeHidden();
  await expect(page.locator('.react-flow__controls')).toBeHidden();
  await expect(page.getByTestId('topbar')).toContainText('Canvas Atelier');
  await expect(page.getByTestId('topbar')).toContainText('保存项目');
  await expect(page.getByTestId('topbar')).toContainText('生图历史');
  const themeBounds = await page.locator('.theme-control').boundingBox();
  const closeBounds = await page.getByRole('button', { name: '关闭应用' }).boundingBox();
  const topbarBounds = await page.getByTestId('topbar').boundingBox();
  expect(themeBounds).toMatchObject({ width: 112, height: 36 });
  expect(Math.abs((themeBounds!.y + themeBounds!.height / 2) - (topbarBounds!.y + topbarBounds!.height / 2))).toBeLessThanOrEqual(0.5);
  expect(Math.abs((themeBounds!.y + themeBounds!.height / 2) - (closeBounds!.y + closeBounds!.height / 2))).toBeLessThanOrEqual(0.5);
  expect(themeBounds!.x + themeBounds!.width).toBeLessThan(closeBounds!.x);
  expect(closeBounds!.x - (themeBounds!.x + themeBounds!.width)).toBeLessThanOrEqual(12);
  await expect(page.locator('.model-status')).toHaveCount(0);

  await page.evaluate(async () => {
    await Promise.all([
      window.__NOVUS_E2E__.createModule('image_generation', { x: 100, y: 112 }),
      window.__NOVUS_E2E__.createModule('reverse_agent', { x: 1000, y: 88 }),
    ]);
  });
  await expect(page.locator('[data-module-type="image_generation"]')).toBeVisible();
  await expect(page.locator('[data-module-type="reverse_agent"]')).toBeVisible();
  await expect(page.locator('[data-module-type="result_output"]')).toHaveCount(0);
  await openAgentPanel(page);
  await page.locator('[data-module-type="image_generation"]').click({ position: { x: 200, y: 120 } });
  await expect(page.locator('[data-module-type="image_generation"] .module-node__summary--generation')).toHaveAttribute('data-editor-expanded', 'true');
  const imageNodeBounds = await page.locator('[data-module-type="image_generation"]').boundingBox();
  const reverseNodeBounds = await page.locator('[data-module-type="reverse_agent"]').boundingBox();
  expect(imageNodeBounds).toMatchObject({ x: 100, y: 112 });
  expect(reverseNodeBounds).toMatchObject({ x: 1000, y: 88 });
  const imagePromptBounds = await page.getByRole('textbox', { name: 'Image generation prompt' }).boundingBox();
  // Figma 411:2 uses the same generous prompt field as the reverse task,
  // rather than the earlier compact 58px generation prompt.
  expect(imagePromptBounds).toMatchObject({ width: 826, height: 104 });
  expect(Math.abs((imagePromptBounds!.x - imageNodeBounds!.x) - 39)).toBeLessThanOrEqual(1);
  expect(Math.abs((imagePromptBounds!.y - imageNodeBounds!.y) - 599)).toBeLessThanOrEqual(1);
  const reverseRoleBounds = await page.getByRole('textbox', { name: 'Role positioning' }).boundingBox();
  const reverseTaskBounds = await page.getByRole('textbox', { name: 'Analysis task' }).boundingBox();
  expect(reverseTaskBounds).toMatchObject({ width: 390, height: 130 });
  expect(reverseRoleBounds).toMatchObject({ width: 390, height: 96 });
  expect(reverseTaskBounds!.x - reverseNodeBounds!.x).toBe(18);
  expect(reverseTaskBounds!.y - reverseNodeBounds!.y).toBe(359);
  expect(reverseRoleBounds!.x - reverseNodeBounds!.x).toBe(18);
  expect(reverseRoleBounds!.y - reverseNodeBounds!.y).toBe(227);
  const reverseKnowledgeBounds = await page.getByLabel('Reverse knowledge context').boundingBox();
  expect(reverseKnowledgeBounds).toMatchObject({ width: 390, height: 58 });
  expect(reverseKnowledgeBounds!.x - reverseNodeBounds!.x).toBe(18);
  expect(reverseKnowledgeBounds!.y - reverseNodeBounds!.y).toBe(503);
  await expect(page.locator('[data-agent-region="result"]')).toBeHidden();
  const viewportTransform = await page.locator('.react-flow__viewport').evaluate((element) => element.getAttribute('style') ?? '');
  expect(viewportTransform).toContain('scale(1)');
  await expect(page.locator('[data-module-type="image_generation"]')).toHaveCSS('height', '830px');

  await captureSurface(page, testInfo, '01-canvas-dark');

  if (await page.getByTestId('agent-panel').isVisible()) {
    await page.getByTestId('agent-toggle').click();
  }
  await expect(page.getByTestId('agent-panel')).toBeHidden();
  await page.locator('.react-flow__pane').dblclick({ position: { x: 1300, y: 800 } });
  await expect(page.getByTestId('quick-insert')).toBeVisible();
  await expect(page.getByTestId('workspace')).toHaveAttribute('data-secondary-surface', 'quick-insert');
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute('style', /scale\(1\)/);
  await expect(page.getByTestId('quick-insert').locator('[data-module-type="reverse_agent"]')).toBeVisible();
  await captureSurface(page, testInfo, '01b-quick-insert-dark');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('quick-insert')).toBeHidden();

  await page.getByTestId('tool-modules').click();
  await expect(page.getByTestId('module-library')).toBeVisible();
  await expect(page.getByTestId('module-library')).toHaveAttribute('data-figma-surface', 'module-library');
  await expect(page.getByTestId('workspace')).toHaveAttribute('data-secondary-surface', 'module-library');
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute('style', /scale\(1\)/);
  await captureSurface(page, testInfo, '02-module-library-dark');

  await openAgentPanel(page);
  await expect(page.getByTestId('module-library')).toBeHidden();
  await expect(page.getByTestId('agent-panel')).toHaveAttribute('data-figma-surface', 'agent');
  await expect(page.getByTestId('workspace')).toHaveAttribute('data-secondary-surface', 'agent');
  const agentPanelBounds = await page.getByTestId('agent-panel').boundingBox();
  const toolrailBounds = await page.getByTestId('toolrail').boundingBox();
  expect(agentPanelBounds).not.toBeNull();
  expect(toolrailBounds).not.toBeNull();
  expect(agentPanelBounds).toMatchObject({ x: 1020, y: 142, width: 396, height: 710 });
  expect(toolrailBounds).toMatchObject({ x: 52, y: 142, width: 60, height: 390 });
  const newChatBounds = await page.getByTestId('agent-new-chat').boundingBox();
  const darkAgentTitleBounds = await page.getByTestId('agent-panel').locator('.agent-panel__header strong').boundingBox();
  const darkAgentCloseBounds = await page.getByTestId('agent-panel-close').boundingBox();
  const welcomeBounds = await page.locator('.skill-chat-workbench__figma-intro p').boundingBox();
  const suggestionBounds = await page.locator('.skill-chat-workbench__suggestions').boundingBox();
  const composerBounds = await page.locator('.skill-chat-workbench__composer').boundingBox();
  expect(newChatBounds).toMatchObject({ width: 360, height: 42 });
  expect(newChatBounds!.x - agentPanelBounds!.x).toBe(18);
  expect(darkAgentTitleBounds!.x - agentPanelBounds!.x).toBe(20);
  expect(darkAgentCloseBounds).toMatchObject({ width: 28, height: 28 });
  expect(agentPanelBounds!.x + agentPanelBounds!.width - (darkAgentCloseBounds!.x + darkAgentCloseBounds!.width)).toBe(20);
  expect(newChatBounds!.y).toBeGreaterThan(darkAgentTitleBounds!.y + darkAgentTitleBounds!.height);
  expect(welcomeBounds!.y).toBeGreaterThan(newChatBounds!.y + newChatBounds!.height);
  expect(suggestionBounds).toMatchObject({ width: 360, height: 110 });
  expect(suggestionBounds!.y).toBeGreaterThan(welcomeBounds!.y);
  expect(composerBounds).toMatchObject({ width: 360 });
  expect(composerBounds!.y).toBeGreaterThan(suggestionBounds!.y + suggestionBounds!.height);
  expect(composerBounds!.y + composerBounds!.height).toBeLessThanOrEqual(agentPanelBounds!.y + agentPanelBounds!.height - 24);
  const screenReaderOnlyControls = page.locator('.skill-chat-workbench__composer .sr-only');
  await expect(screenReaderOnlyControls).toHaveCount(2);
  await expect(screenReaderOnlyControls.nth(0)).toBeHidden();
  await expect(screenReaderOnlyControls.nth(1)).toBeHidden();
  const composerTools = page.locator('.skill-chat-workbench__composer-footer .skill-chat-workbench__tool');
  await expect(composerTools).toHaveCount(4);
  await expect(page.getByTestId('knowledge-base-trigger')).toBeVisible();
  await expect(page.getByTestId('agent-model-trigger')).toBeVisible();
  expect(await composerTools.nth(0).boundingBox()).toMatchObject({ width: 38, height: 38 });
  expect(await composerTools.nth(3).boundingBox()).toMatchObject({ width: 38, height: 38 });
  const submitBounds = await page.locator('.skill-chat-workbench__composer-footer button[type="submit"]').boundingBox();
  expect(submitBounds).toMatchObject({ width: 38, height: 38 });
  expect(submitBounds!.x + submitBounds!.width).toBeLessThanOrEqual(agentPanelBounds!.x + agentPanelBounds!.width - 18);
  await expect(page.getByTestId('agent-image-reference-affordance')).toHaveCount(0);
  await captureSurface(page, testInfo, '03-agent-dark');

  await page.getByRole('button', { name: '打开知识库' }).click();
  await expect(page.getByTestId('knowledge-library-toolbar')).toBeVisible();
  await captureSurface(page, testInfo, '03b-knowledge-selection-dark');
  await page.getByRole('button', { name: '关闭知识库' }).click();
  await expect(page.getByTestId('knowledge-library-toolbar')).toBeHidden();

  await page.getByTestId('history-toggle').click();
  await expect(page.getByTestId('history-drawer')).toBeVisible();
  await expect(page.getByTestId('workspace')).toHaveAttribute('data-secondary-surface', 'history');
  const historyBounds = await page.getByTestId('history-drawer').boundingBox();
  expect(historyBounds).not.toBeNull();
  expect(historyBounds!.width).toBeGreaterThanOrEqual(760);
  expect(historyBounds!.x).toBeGreaterThanOrEqual(52);
  expect(historyBounds!.x + historyBounds!.width).toBeLessThanOrEqual(1440);
  await captureSurface(page, testInfo, '04-history-dark');

  await page.getByTestId('settings-toggle').click();
  await expect(page.getByTestId('settings-drawer')).toBeVisible();
  await expect(page.getByTestId('workspace')).toHaveAttribute('data-secondary-surface', 'settings');
  expect(await page.getByTestId('settings-drawer').boundingBox()).toMatchObject({
    x: 696,
    y: 76,
    width: 720,
    height: 796,
  });
  const apiSettingsSection = page.getByTestId('settings-drawer').getByLabel('供应商设置');
  const hiddenCredentialButton = apiSettingsSection.getByRole('button', { name: '配置隐藏密钥' });
  const saveCredentialButton = apiSettingsSection.getByRole('button', { name: '保存接口设置' });
  const apiSectionBounds = await apiSettingsSection.boundingBox();
  expect(apiSectionBounds).not.toBeNull();
  expect(apiSectionBounds!.width).toBeGreaterThanOrEqual(680);
  await expect(hiddenCredentialButton).toBeVisible();
  await expect(saveCredentialButton).toBeVisible();
  await expect(saveCredentialButton).toBeEnabled();
  await expect(apiSettingsSection.getByText('API 服务地址（Base URL）')).toBeVisible();
  await expect(apiSettingsSection.getByRole('button', { name: '检测连接' })).toBeVisible();
  await expect(apiSettingsSection.getByText('安全存储')).toBeVisible();
  await captureSurface(page, testInfo, '05-settings-dark');
  await page.getByTestId('settings-drawer').getByRole('button', { name: '配置隐藏密钥' }).click();
  const hiddenKeyDialog = page.getByRole('dialog', { name: '配置隐藏密钥' });
  await expect(hiddenKeyDialog).toBeVisible();
  await expect(hiddenKeyDialog.locator('input[type="password"]')).toHaveCount(1);
  const hiddenKeyBounds = await hiddenKeyDialog.boundingBox();
  expect(hiddenKeyBounds).not.toBeNull();
  expect(hiddenKeyBounds!.width).toBeGreaterThanOrEqual(420);
  expect(hiddenKeyBounds!.x).toBeGreaterThan(0);
  expect(hiddenKeyBounds!.x + hiddenKeyBounds!.width).toBeLessThanOrEqual(1440);
  await captureSurface(page, testInfo, '05a-hidden-keys-dark');
  await hiddenKeyDialog.getByRole('button', { name: '关闭隐藏密钥配置' }).click();
  await expect(hiddenKeyDialog).toBeHidden();
  const settingsTabs = page.getByTestId('settings-drawer').locator('.settings-tabs');
  const apiTab = settingsTabs.locator('[role="tab"]').nth(0);
  const syncTab = settingsTabs.locator('[role="tab"]').nth(3);
  const expectedTabSurface = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.background = 'var(--surface)';
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
  const expectedSelectedTabSurface = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.background = 'var(--accent-soft)';
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
  await expect(apiTab).toHaveCSS('display', 'grid');
  await expect(apiTab).toHaveCSS('place-items', 'center');
  await expect(apiTab).toHaveCSS('justify-content', 'center');
  await expect(apiTab).toHaveCSS('text-align', 'center');
  await expect(apiTab).toHaveCSS('background-color', expectedSelectedTabSurface);
  await syncTab.click();
  await expect(syncTab).toHaveCSS('background-color', expectedSelectedTabSurface);
  await expect(apiTab).toHaveCSS('background-color', expectedTabSurface);

  await page.getByTestId('settings-drawer').getByRole('tab', { name: '同步' }).click();
  await captureSurface(page, testInfo, '05b-settings-sync-dark');

  await page.getByLabel('主题 Theme').selectOption('light');
  const expectedMutedSurface = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.background = 'var(--surface-muted)';
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
  await expect(page.getByTestId('settings-drawer').locator('.settings-tabs')).toHaveCSS('background-color', expectedMutedSurface);
  await captureSurface(page, testInfo, '06-settings-light');

  await page.getByTestId('settings-toggle').click();
  await openAgentPanel(page);
  // Figma UI Gate keeps the Agent geometry identical across themes;
  // only the token palette changes.
  expect(await page.getByTestId('agent-panel').boundingBox()).toMatchObject({
    x: 1020,
    y: 142,
    width: 396,
    height: 710,
  });
  expect(await page.getByTestId('agent-new-chat').boundingBox()).toMatchObject({ width: 360, height: 42 });
  expect(await page.getByTestId('agent-panel-close').boundingBox()).toMatchObject({ width: 28, height: 28 });
  await expect(page.getByTestId('knowledge-base-trigger')).toBeVisible();
  await expect(page.getByTestId('agent-model-trigger')).toBeVisible();
  await page.getByRole('button', { name: '打开知识库' }).click();
  await expect(page.getByTestId('knowledge-library-toolbar')).toBeVisible();
  await captureSurface(page, testInfo, '06a-knowledge-selection-light');
  await page.getByRole('button', { name: '关闭知识库' }).click();
  const lightAgentPanel = page.getByTestId('agent-panel');
  const lightAgentSurface = await lightAgentPanel.evaluate((element) => getComputedStyle(element).backgroundColor);
  const lightAgentText = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.color = 'var(--text)';
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  await expect(lightAgentPanel.locator('.agent-panel__header')).toHaveCSS('background-color', lightAgentSurface);
  await expect(lightAgentPanel.locator('.skill-chat-workbench__suggestions strong').first()).toHaveCSS('color', lightAgentText);
  await captureSurface(page, testInfo, '06b-agent-light');

  await page.getByTestId('tool-modules').click();
  await expect(page.getByTestId('module-library')).toBeVisible();
  await captureSurface(page, testInfo, '06c-module-library-light');

  await page.getByTestId('history-toggle').click();
  await expect(page.getByTestId('history-drawer')).toBeVisible();
  const lightHistoryDrawer = page.getByTestId('history-drawer');
  await expect(lightHistoryDrawer).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(lightHistoryDrawer.locator('.history-filters')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await captureSurface(page, testInfo, '06d-history-light');

  await page.getByTestId('history-toggle').click();
  await expect(page.getByTestId('history-drawer')).toBeHidden();
  // Keep the light-theme quick-insert gesture below the expanded reverse card.
  // The previous y=620 coordinate landed inside that node and correctly selected
  // it instead of opening the canvas-level insert menu.
  await page.locator('.react-flow__pane').dblclick({ position: { x: 1120, y: 800 } });
  await expect(page.getByTestId('quick-insert')).toBeVisible();
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute('style', /scale\(1\)/);
  await expect(page.getByTestId('quick-insert').locator('[data-module-type="reverse_agent"]')).toBeVisible();
  await captureSurface(page, testInfo, '06e-quick-insert-light');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('quick-insert')).toBeHidden();

  const expectedGateCard = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.background = 'var(--gate-card)';
    document.querySelector('[data-testid="workspace"]')?.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
  await expect(page.locator('[data-module-type="reverse_agent"]')).toHaveCSS('background-color', expectedGateCard);
  await captureSurface(page, testInfo, '07-canvas-light');
});

for (const theme of ['dark', 'light'] as const) {
  test(`captures visible image-input connections in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openEmptyApp(page);
    await page.locator('.theme-control select').selectOption(theme);
    await page.evaluate(async () => {
      await window.__NOVUS_E2E__!.createModule('image_input', { x: 110, y: 320 });
      await window.__NOVUS_E2E__!.createModule('reverse_agent', { x: 440, y: 70 });
      await window.__NOVUS_E2E__!.createModule('image_generation', { x: 920, y: 70 });
      await window.__NOVUS_E2E__!.createModule('video_generation', { x: 110, y: 650 });
    });

    await queueProjectImageImport(
      page,
      makeReferenceImage('Connected media reference.png', [34, 120, 168, 255], { width: 640, height: 360 }),
    );
    const imageNode = page.locator('[data-module-type="image_input"]');
    await imageNode.getByRole('button', { name: '导入图像 / Import image' }).click();
    await expect(imageNode.getByRole('img', { name: 'Connected media reference' })).toBeVisible();

    const imageOutput = page.locator('[data-module-type="image_input"] [data-port-id="image"].react-flow__handle');
    await expect(imageOutput).toBeVisible();
    const [expectedAccent, expectedPortSurface] = await page.evaluate(() => {
      const read = (property: 'background' | 'border-color') => {
        const probe = document.createElement('div');
        probe.style.setProperty(property, property === 'background' ? 'var(--accent)' : 'var(--border-strong)');
        document.body.append(probe);
        const value = property === 'background'
          ? getComputedStyle(probe).backgroundColor
          : getComputedStyle(probe).borderColor;
        probe.remove();
        return value;
      };
      const workspace = document.querySelector<HTMLElement>('.workspace--ui-gate');
      const surface = workspace === null
        ? 'rgba(0, 0, 0, 0)'
        : getComputedStyle(workspace).getPropertyValue('--gate-card').trim();
      const colorProbe = document.createElement('div');
      colorProbe.style.background = surface;
      document.body.append(colorProbe);
      const resolvedSurface = getComputedStyle(colorProbe).backgroundColor;
      colorProbe.remove();
      return [read('background'), resolvedSurface];
    });
    await expect(imageOutput).toHaveCSS('background-color', expectedPortSurface);
    await expect(imageOutput).toHaveCSS('border-color', expectedAccent);
    for (const { label, portAxis, target, node } of [
      {
        label: 'Reverse Agent primary media input',
        portAxis: 'card-center',
        node: page.locator('[data-module-type="reverse_agent"]'),
        target: page.locator('[data-module-type="reverse_agent"] [data-port-id="references"].react-flow__handle'),
      },
      {
        label: 'Image Generation primary media input',
        portAxis: 'card-center',
        node: page.locator('[data-module-type="image_generation"]'),
        target: page.locator('[data-module-type="image_generation"] [data-port-id="references"].react-flow__handle'),
      },
      {
        label: 'Video Generation primary media input',
        // Figma 332:2: node top=120 and the 16px input socket starts at
        // y=328, so its centre is 216px down the canonical 672×720 card.
        portAxis: 'video-preview-axis',
        node: page.locator('[data-module-type="video_generation"]'),
        target: page.locator('[data-module-type="video_generation"] [data-port-id="media"].react-flow__handle'),
      },
      {
        label: 'Video Generation result output',
        // Figma puts the result output on the same 216px preview axis.
        portAxis: 'video-preview-axis',
        node: page.locator('[data-module-type="video_generation"]'),
        target: page.locator('[data-module-type="video_generation"] [data-port-id="result"].react-flow__handle'),
      },
    ] as const) {
      await expect(target).toBeVisible();
      const [targetBox, nodeBox] = await Promise.all([
        target.boundingBox(),
        node.boundingBox(),
      ]);
      expect(targetBox).not.toBeNull();
      expect(nodeBox).not.toBeNull();
      expect(targetBox!.width).toBe(16);
      const targetCenterY = targetBox!.y + targetBox!.height / 2;
      const expectedCenterY = portAxis === 'video-preview-axis'
        ? nodeBox!.y + (216 / 720) * nodeBox!.height
        : nodeBox!.y + nodeBox!.height / 2;
      expect(
        Math.abs(targetCenterY - expectedCenterY),
        portAxis === 'video-preview-axis'
          ? `${label} must align with Figma's preview connection axis`
          : `${label} must remain on its card midpoint`,
      ).toBeLessThanOrEqual(16);
      await expect(target).toHaveCSS('background-color', expectedPortSurface);
      await expect(target).toHaveCSS('border-color', expectedAccent);
      if (label !== 'Video Generation result output') await imageOutput.dragTo(target);
    }

    const imageGeneration = page.locator('[data-module-type="image_generation"]');
    await imageGeneration.getByRole('button', { name: 'Open image generation editor' }).click();
    const imagePrompt = imageGeneration.getByRole('textbox', { name: 'Image generation prompt' });
    const imageReferenceSlots = imageGeneration.getByLabel('Image generation reference slots');
    await expect(imageReferenceSlots).toBeVisible();
    await expect(
      imageGeneration.getByLabel('Image generation connected references'),
      'The Figma image card uses a dedicated reference tray; the legacy managed-reference badge must not render as a second surface.',
    ).toBeHidden();
    const [imagePromptBox, imageReferenceSlotsBox] = await Promise.all([
      imagePrompt.boundingBox(),
      imageReferenceSlots.boundingBox(),
    ]);
    expect(imagePromptBox).not.toBeNull();
    expect(imageReferenceSlotsBox).not.toBeNull();
    expect(imageReferenceSlotsBox!.x).toBeLessThanOrEqual(imagePromptBox!.x);
    expect(imageReferenceSlotsBox!.x + imageReferenceSlotsBox!.width).toBeGreaterThanOrEqual(imagePromptBox!.x + imagePromptBox!.width);
    const firstImageReference = imageReferenceSlots.getByLabel('Agent media slot 1');
    const firstImageReferenceBox = await firstImageReference.boundingBox();
    expect(firstImageReferenceBox).not.toBeNull();
    expect(
      firstImageReferenceBox!.x,
      'Figma 411:2 pins connected image thumbnails to the tray start; legacy CSS must not center them.',
    ).toBeLessThanOrEqual(imageReferenceSlotsBox!.x + 12);
    expect(
      imageReferenceSlotsBox!.y + imageReferenceSlotsBox!.height,
      'Figma 411:2 places connected reference media in its own tray above the prompt, never inside the text area.',
    ).toBeLessThanOrEqual(imagePromptBox!.y);
    const resolutionTrigger = imageGeneration.getByRole('button', { name: 'Image generation resolution' });
    await expect(resolutionTrigger).toHaveAttribute('value', '2K');
    await resolutionTrigger.click();
    const resolutionOptions = imageGeneration
      .getByRole('menu', { name: 'Image generation resolution options' })
      .getByRole('menuitemradio');
    await expect(resolutionOptions).toHaveText(['2K', '4K']);
    await resolutionOptions.filter({ hasText: '4K' }).click();
    await expect(resolutionTrigger).toHaveAttribute('value', '4K');
    const generateImage = imageGeneration.getByRole('button', { name: 'Generate image' });
    await expect(generateImage).toHaveCSS('font-size', '12px');
    expect(await generateImage.evaluate((element) => getComputedStyle(element, '::after').content)).toBe('none');
    const imageGenerationResult = imageGeneration.locator('[data-port-id="result"][data-port-direction="output"] .react-flow__handle');
    const [generationBox, resultBox] = await Promise.all([
      imageGeneration.boundingBox(),
      imageGenerationResult.boundingBox(),
    ]);
    expect(generationBox).not.toBeNull();
    expect(resultBox).not.toBeNull();
    expect(
      Math.abs((resultBox!.y + resultBox!.height / 2) - (generationBox!.y + generationBox!.height / 2)),
      'Image Generation result endpoint must stay on the Figma card midpoint, never the top rail',
    ).toBeLessThanOrEqual(14);

    await expect(page.locator('.react-flow__edge')).toHaveCount(3);
    await expect.poll(async () => page.locator('.react-flow__edge-path').evaluateAll((paths) => (
      paths.every((path) => {
        const stroke = getComputedStyle(path).stroke;
        return stroke !== 'none' && stroke !== 'transparent' && stroke !== 'rgba(0, 0, 0, 0)';
      })
    ))).toBe(true);
    await expect.poll(async () => page.locator('.react-flow__edge-path').evaluateAll((paths, expectedAccent) => (
      paths.every((path) => {
        const style = getComputedStyle(path);
        return style.stroke === expectedAccent && Number.parseFloat(style.strokeWidth) === 2;
      })
    ), expectedAccent)).toBe(true);
    await captureSurface(page, testInfo, `image-input-connections-${theme}`);
  });

  test(`keeps reverse analysis in its dedicated result flow without an inline legacy result in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openEmptyApp(page);
    await page.locator('.theme-control select').selectOption(theme);
    await page.evaluate(async () => {
      await window.__NOVUS_E2E__!.createModule('image_input', { x: 160, y: 260 });
      await window.__NOVUS_E2E__!.createModule('reverse_agent', { x: 660, y: 160 });
    });

    const imageNode = page.locator('[data-module-type="image_input"]');
    const reverseNode = page.locator('[data-module-type="reverse_agent"]');
    await expect(imageNode).toBeVisible();
    await expect(reverseNode).toBeVisible();

    await queueProjectImageImport(
      page,
      makeReferenceImage('Reverse audit reference.png', [34, 120, 168, 255], { width: 640, height: 360 }),
    );
    await imageNode.locator('.module-node__media-empty').click();
    await expect(imageNode.getByRole('img', { name: 'Reverse audit reference' })).toBeVisible();
    await page.evaluate(() => window.__NOVUS_E2E__!.connectModules(
      'image_input',
      'image',
      'reverse_agent',
      'references',
    ));
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);

    await page.getByRole('textbox', { name: 'Role positioning' }).fill('Commercial visual analyst');
    await page.getByRole('textbox', { name: 'Analysis task' }).fill('Analyze the connected reference.');
    const route = page.getByLabel('Agent model route');
    await expect(route.locator('option:not([value=""])')).not.toHaveCount(0);
    await expect(route).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start reverse analysis' })).toBeEnabled();
    await page.evaluate(() => {
      const bridge = window.novusDesktop.provider;
      const analyzeReversePrompt = bridge.analyzeReversePrompt;
      bridge.analyzeReversePrompt = async (input) => {
        document.documentElement.dataset.e2eReverseProviderInvoked = 'true';
        const result = await analyzeReversePrompt(input);
        document.documentElement.dataset.e2eReverseProviderResolved = 'true';
        return result;
      };
    });
    await page.getByRole('button', { name: 'Start reverse analysis' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-e2e-reverse-provider-invoked', 'true');
    await expect(page.locator('html')).toHaveAttribute('data-e2e-reverse-provider-resolved', 'true');

    await expect(reverseNode.getByLabel('AI analysis output')).toHaveCount(0);
    await expect(reverseNode.getByRole('textbox', { name: 'Role positioning' })).toBeVisible();
    await expect(reverseNode.getByRole('textbox', { name: 'Analysis task' })).toBeVisible();
    const referenceInput = reverseNode.locator('[data-port-id="references"].react-flow__handle');
    const analysisOutput = reverseNode.locator('[data-port-id="analysis"].react-flow__handle');
    await expect(referenceInput).toHaveCount(1);
    await expect(referenceInput).toBeVisible();
    await expect(analysisOutput).toHaveCount(1);
    await expect(analysisOutput).toBeVisible();
    await expect(reverseNode).toHaveCSS('height', '646px');
    await captureSurface(page, testInfo, `reverse-agent-completed-${theme}`);
  });

  test(`keeps the reverse workbench and connects its completed analysis to a dedicated result in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openEmptyApp(page);
    await page.locator('.theme-control select').selectOption(theme);
    await page.evaluate(async () => {
      await window.__NOVUS_E2E__!.createModule('reverse_agent', { x: 300, y: 154 });
      await window.__NOVUS_E2E__!.createModule('reverse_result', { x: 760, y: 126 });
      await window.__NOVUS_E2E__!.configureModule('reverse_agent', {
        config: {
          modelRoute: 'reverse-default',
          role: 'Commercial visual analyst',
          task: 'Analyze the connected reference.',
          knowledgeBaseIds: [],
          reverseAgentResult: { positivePrompt: 'Structured reverse analysis from the dedicated result workflow.' },
          resultState: 'fresh',
        },
        execution: { state: 'completed' },
      });
    });

    const reverse = page.locator('[data-module-type="reverse_agent"]');
    const result = page.locator('[data-module-type="reverse_result"]');
    const source = reverse.locator('[data-port-id="analysis"].react-flow__handle');
    const target = result.locator('[data-port-id="analysis"][data-port-direction="input"].react-flow__handle');
    await expect(source).toBeVisible();
    await expect(target).toBeVisible();
    const [reverseBox, resultBox, sourceBox, targetBox] = await Promise.all([
      reverse.boundingBox(),
      result.boundingBox(),
      source.boundingBox(),
      target.boundingBox(),
    ]);
    expect(reverseBox).not.toBeNull();
    expect(resultBox).not.toBeNull();
    expect(sourceBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    expect(Math.abs((sourceBox!.x + sourceBox!.width / 2) - (reverseBox!.x + reverseBox!.width))).toBeLessThanOrEqual(1);
    expect(Math.abs((targetBox!.x + targetBox!.width / 2) - resultBox!.x)).toBeLessThanOrEqual(1);
    await source.dragTo(target);
    await expect.poll(async () => page.locator('.react-flow__edge').count()).toBe(1);
    await expect(source).toHaveAttribute('data-port-connected', 'true');
    await expect(target).toHaveAttribute('data-port-connected', 'true');
    await expect(result.locator('[data-port-id="analysis"][data-port-direction="output"].react-flow__handle')).not.toHaveAttribute('data-port-connected');
    await expect(reverse.getByRole('textbox', { name: 'Role positioning' })).toBeVisible();
    await expect(reverse.getByRole('textbox', { name: 'Analysis task' })).toBeVisible();
    await expect(result.getByLabel('Reverse analysis result')).toContainText('Structured reverse analysis from the dedicated result workflow.');
    await expect(result).toHaveCSS('width', '520px');
    await expect(result).toHaveCSS('height', '648px');
    await captureSurface(page, testInfo, `reverse-agent-dedicated-result-${theme}`);
  });

  test(`captures the result action menu in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openEmptyApp(page);
    await page.getByLabel('主题 Theme').selectOption(theme);
    const seeded = await page.evaluate(async () => {
      await window.__NOVUS_E2E__.createModule('image_generation', { x: 100, y: 112 });
      return await window.__NOVUS_E2E__.seedGeneratedImageResult?.() ?? false;
    });
    expect(seeded).toBe(true);
    const generation = page.locator('[data-module-type="image_generation"]');
    await generation.getByRole('button', { name: 'Open image generation editor' }).click();
    await generation.getByRole('button', { name: 'Generated image 1; double click to preview' }).click({ button: 'right' });
    await expect(page.getByRole('menu', { name: 'Generated image actions' })).toBeVisible();
    await captureSurface(page, testInfo, `result-action-menu-${theme}`);
  });
}
