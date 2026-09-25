import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './helpers/e2e-test';
import { openAgentPanel, openEmptyApp } from './helpers/app';

const evidence = path.join(process.cwd(), 'work', process.env.CANVAS_AGENT_POPOVER_AUDIT_DIR ?? 'qa-agent-popover-20260924/baseline');

test('keeps long context, model choice and the Codex composer inside a resized Agent window', async ({ page }) => {
  test.setTimeout(90_000);
  await mkdir(evidence, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('novus.theme.mode', 'light');
    localStorage.setItem('novus.agent-window.v1', JSON.stringify({ x: 200, y: 32, width: 620, height: 800 }));
    const profiles = [
      { provider: 'codex', modelRoute: 'codex/gpt-6-astra', modelId: 'gpt-6-astra', displayName: 'GPT-6 Astra', capabilities: ['responses', 'vision'], supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultReasoningEffort: 'medium' },
      { provider: 'codex', modelRoute: 'codex/gpt-6-sol', modelId: 'gpt-6-sol', displayName: 'GPT-6 Sol', capabilities: ['responses', 'vision'], supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultReasoningEffort: 'medium' },
      { provider: 'codex', modelRoute: 'codex/gpt-6-luna', modelId: 'gpt-6-luna', displayName: 'GPT-6 Luna', capabilities: ['responses', 'vision'], supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'medium' },
    ];
    let bridge: Record<string, unknown> | undefined;
    Object.defineProperty(window, 'novusDesktop', {
      configurable: true,
      get: () => bridge,
      set: (value: Record<string, unknown>) => {
        bridge = { ...value, codexCli: { ...(value.codexCli as Record<string, unknown> | undefined), listProfiles: async () => profiles } };
      },
    });
  });
  await openEmptyApp(page);
  await page.evaluate(async () => window.__NOVUS_E2E__!.seedModuleStressGraph(54, 0));
  await openAgentPanel(page);
  const panel = page.getByTestId('agent-panel');
  await panel.getByLabel('Agent 模式').selectOption('codex');
  await expect(panel.getByTestId('agent-model-trigger')).toHaveAttribute('data-selected-model', 'GPT-6 Astra');
  const footer = panel.locator('.skill-chat-workbench__composer-footer');
  const footerMetrics = await footer.evaluate((element) => {
    const entries = [...element.querySelectorAll<HTMLElement>(':scope > .skill-chat-workbench__mode-picker, :scope > .skill-chat-workbench__tool, :scope > .skill-chat-workbench__model-pill, :scope > .skill-chat-workbench__model-reasoning, :scope > .codex-reasoning, :scope > .skill-chat-workbench__composer-actions')];
    return entries.map((item) => ({ className: item.className, x: item.getBoundingClientRect().x, y: item.getBoundingClientRect().y, width: item.getBoundingClientRect().width, height: item.getBoundingClientRect().height }));
  });
  const modelReasoningMetrics = await footer.locator('.skill-chat-workbench__model-reasoning').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const model = element.querySelector<HTMLElement>('.skill-chat-workbench__model-pill')!.getBoundingClientRect();
    const reasoningContainer = element.querySelector<HTMLElement>('.codex-reasoning')!.getBoundingClientRect();
    const reasoning = element.querySelector<HTMLElement>('.codex-reasoning__trigger')!.getBoundingClientRect();
    return { width: rect.width, modelWidth: model.width, reasoningContainerWidth: reasoningContainer.width, reasoningWidth: reasoning.width,
      gapBeforeReasoning: reasoningContainer.left - model.right, gapAfterReasoning: rect.right - reasoningContainer.right };
  });
  const footerAlignment = await footer.evaluate((element) => ({
    footerRight: element.getBoundingClientRect().right,
    actionsRight: element.querySelector<HTMLElement>('.skill-chat-workbench__composer-actions')!.getBoundingClientRect().right,
    modelRight: element.querySelector<HTMLElement>('.skill-chat-workbench__model-reasoning')!.getBoundingClientRect().right,
    actionsLeft: element.querySelector<HTMLElement>('.skill-chat-workbench__composer-actions')!.getBoundingClientRect().left,
  }));
  await page.screenshot({ path: path.join(evidence, '01-codex-footer.png'), fullPage: true });

  const context = panel.getByRole('region', { name: '对话上下文' });
  await context.getByRole('button', { name: /展开上下文/u }).click();
  const contextMetrics = await panel.evaluate((element) => {
    const detail = element.querySelector<HTMLElement>('.skill-chat-workbench__context-detail')!;
    const contextButton = element.querySelector<HTMLElement>('.skill-chat-workbench__context > button')!;
    const composer = element.querySelector<HTMLElement>('.skill-chat-workbench__composer')!;
    const panel = element.getBoundingClientRect();
    const detailBox = detail.getBoundingClientRect();
    return { panelBottom: panel.bottom, contextButtonBottom: contextButton.getBoundingClientRect().bottom, detailTop: detailBox.top, detailBottom: detailBox.bottom, detailHeight: detailBox.height, detailClientHeight: detail.clientHeight, detailScrollHeight: detail.scrollHeight, composerTop: composer.getBoundingClientRect().top };
  });
  await page.screenshot({ path: path.join(evidence, '02-context-expanded.png'), fullPage: true });
  await context.getByRole('button', { name: '收起上下文' }).click();

  await panel.getByTestId('agent-model-trigger').click();
  const reasoningFromModel = panel.getByRole('dialog', { name: '思考能力设置' });
  const picker = reasoningFromModel.getByRole('dialog', { name: '选择聊天模型' });
  const modelMetrics = await panel.evaluate((element) => {
    const dialog = element.querySelector<HTMLElement>('[role="dialog"][aria-label="选择聊天模型"][data-anchor="reasoning"]')!;
    const composer = element.querySelector<HTMLElement>('.skill-chat-workbench__composer')!;
    const rect = dialog.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, height: rect.height, width: rect.width, composerTop: composer.getBoundingClientRect().top };
  });
  await page.screenshot({ path: path.join(evidence, '03-model-picker.png'), fullPage: true });
  await writeFile(path.join(evidence, 'geometry.json'), JSON.stringify({ footerMetrics, contextMetrics, modelMetrics }, null, 2));
  await picker.getByRole('button', { name: '关闭模型选择' }).click();
  await expect(reasoningFromModel).toHaveCount(0);
  await panel.getByRole('button', { name: '思考能力：中', exact: true }).click();
  await expect(panel.getByRole('dialog', { name: '选择聊天模型' })).toBeVisible();

  const reasoning = panel.getByRole('dialog', { name: '思考能力设置' });
  await writeFile(path.join(evidence, 'generation-style.json'), JSON.stringify(await reasoning.getByRole('button', { name: '生成偏好' }).evaluate((button) => {
    const style = getComputedStyle(button);
    return { display: style.display, background: style.backgroundColor, muted: style.getPropertyValue('--surface-muted'), color: style.color, fontSize: style.fontSize, grid: style.gridTemplateColumns, height: style.height,
      childStyles: [...button.children].map((child) => ({ text: child.textContent, color: getComputedStyle(child).color, width: getComputedStyle(child).width })) };
  }), null, 2));
  await reasoning.getByRole('button', { name: '切换思考模型' }).click();
  const nestedPicker = reasoning.getByRole('dialog', { name: '选择聊天模型' });
  const nestedMetrics = await reasoning.evaluate((element) => {
    const track = element.querySelector<HTMLElement>('.codex-reasoning__track')!.getBoundingClientRect();
    const picker = element.querySelector<HTMLElement>('.skill-chat-workbench__sheet[data-anchor="reasoning"]')!.getBoundingClientRect();
    return { trackBottom: track.bottom, pickerTop: picker.top, pickerBottom: picker.bottom };
  });
  await page.screenshot({ path: path.join(evidence, '04-reasoning-model-picker.png'), fullPage: true });
  await nestedPicker.getByRole('button', { name: '关闭模型选择' }).click();

  const footerY = footerMetrics.map((item) => item.y);
  expect(Math.max(...footerY) - Math.min(...footerY), 'all Codex controls should occupy one row').toBeLessThanOrEqual(3);
  expect(footerAlignment.actionsLeft - footerAlignment.modelRight, 'model and reasoning should use the available footer width').toBeLessThanOrEqual(12);
  expect(modelReasoningMetrics.width, 'model and reasoning should retain a readable width').toBeGreaterThanOrEqual(300);
  expect(modelReasoningMetrics.modelWidth, 'model name should keep a usable compact label area').toBeGreaterThanOrEqual(120);
  expect(modelReasoningMetrics.reasoningContainerWidth, 'the reasoning segment should fit its trigger without a blank strip').toBeLessThanOrEqual(66);
  expect(modelReasoningMetrics.gapBeforeReasoning, 'model and reasoning segments should meet').toBeLessThanOrEqual(2);
  expect(modelReasoningMetrics.gapAfterReasoning, 'the reasoning segment should reach the group edge').toBeLessThanOrEqual(2);
  expect(modelReasoningMetrics.reasoningWidth, 'reasoning control should keep its compact trigger').toBeLessThanOrEqual(60);
  expect(footerAlignment.footerRight - footerAlignment.actionsRight, 'send actions should align to the right edge of the composer').toBeLessThanOrEqual(8);
  expect(contextMetrics.detailTop, 'expanded context should stay below its toggle').toBeGreaterThanOrEqual(contextMetrics.contextButtonBottom - 1);
  expect(contextMetrics.detailBottom, 'long context should stop above the composer').toBeLessThan(contextMetrics.composerTop - 8);
  expect(contextMetrics.detailScrollHeight, 'long context should scroll inside its own panel').toBeGreaterThan(contextMetrics.detailClientHeight);
  expect(modelMetrics.height, 'model chooser should remain compact').toBeLessThanOrEqual(360);
  expect(modelMetrics.bottom, 'model chooser should stay inside the Agent window').toBeLessThan(contextMetrics.panelBottom - 8);
  expect(nestedMetrics.pickerTop, 'model choices should appear below the reasoning slider').toBeGreaterThan(nestedMetrics.trackBottom);
  expect(nestedMetrics.pickerBottom, 'reasoning model choices should stay inside the Agent window').toBeLessThan(contextMetrics.panelBottom - 8);
  await panel.locator('.codex-reasoning__trigger').click();

  for (const width of [440, 360]) {
    await panel.evaluate((element, nextWidth) => element.style.setProperty('--agent-width', `${nextWidth}px`), width);
    const narrowMetrics = await footer.evaluate((element) => {
      const rows = [...element.querySelectorAll<HTMLElement>(':scope > .skill-chat-workbench__mode-picker, :scope > .skill-chat-workbench__tool, :scope > .skill-chat-workbench__model-pill, :scope > .skill-chat-workbench__model-reasoning, :scope > .codex-reasoning, :scope > .skill-chat-workbench__composer-actions')]
        .filter((item) => getComputedStyle(item).display !== 'none')
        .map((item) => item.getBoundingClientRect().top);
      const trigger = element.querySelector<HTMLElement>('.codex-reasoning__trigger')!;
      const triggerRect = trigger.getBoundingClientRect();
      const actionLeft = element.querySelector<HTMLElement>('.skill-chat-workbench__composer-actions')!.getBoundingClientRect().left;
      const actionRight = element.querySelector<HTMLElement>('.skill-chat-workbench__composer-actions')!.getBoundingClientRect().right;
      const footerRight = element.getBoundingClientRect().right;
      const contentRight = Math.max(...[...trigger.children].map((child) => child.getBoundingClientRect().right));
      return { rows, triggerRight: triggerRect.right, contentRight, actionLeft, actionRight, footerRight };
    });
    await page.screenshot({ path: path.join(evidence, `05-codex-footer-${width}.png`), fullPage: true });
    expect(Math.max(...narrowMetrics.rows) - Math.min(...narrowMetrics.rows), `Codex controls should stay on one row at ${width}px`).toBeLessThanOrEqual(3);
    expect(narrowMetrics.contentRight, `reasoning content must fit inside its trigger at ${width}px`).toBeLessThanOrEqual(narrowMetrics.triggerRight - 2);
    expect(narrowMetrics.triggerRight, `reasoning trigger must not overlap actions at ${width}px`).toBeLessThanOrEqual(narrowMetrics.actionLeft);
    expect(narrowMetrics.footerRight - narrowMetrics.actionRight, `send actions should reach the right edge at ${width}px`).toBeLessThanOrEqual(8);
  }
  await panel.getByTestId('agent-model-trigger').click();
  const narrowPicker = panel.getByRole('dialog', { name: '思考能力设置' }).getByRole('dialog', { name: '选择聊天模型' });
  await narrowPicker.locator('.skill-chat-workbench__route-list').evaluate((list) => { list.scrollTop = list.scrollHeight; });
  await expect(narrowPicker.getByRole('button', { name: '使用 GPT-6 Luna' })).toBeInViewport();
});

test('shows image workflow models in a compact selectable sheet', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('novus.theme.mode', 'light');
    localStorage.setItem('novus.agent-window.v1', JSON.stringify({ x: 200, y: 32, width: 620, height: 800 }));
  });
  await openEmptyApp(page);
  await openAgentPanel(page);
  const panel = page.getByTestId('agent-panel');
  await panel.getByLabel('Agent 模式').selectOption('original');
  await panel.getByRole('button', { name: '生成偏好' }).click();

  const sheet = panel.getByRole('dialog', { name: '生成偏好' });
  const candidates = sheet.getByRole('list', { name: '可用图片模型' });
  await expect(candidates.locator('[role="listitem"]')).not.toHaveCount(0);
  const geometry = await sheet.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const panel = element.closest<HTMLElement>('.agent-panel')!.getBoundingClientRect();
    return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height, background: getComputedStyle(element).backgroundColor, panelX: panel.x, panelY: panel.y, panelRight: panel.right, panelBottom: panel.bottom };
  });
  expect(geometry.width).toBeLessThanOrEqual(520);
  expect(geometry.height).toBeLessThan(620);
  expect(geometry.x).toBeGreaterThan(geometry.panelX);
  expect(geometry.y).toBeGreaterThan(geometry.panelY);
  expect(geometry.right).toBeLessThan(geometry.panelRight);
  expect(geometry.bottom).toBeLessThan(geometry.panelBottom);
  expect(geometry.background, 'the generation sheet must hide conversation text behind it').toMatch(/^rgb\(/u);
  await sheet.screenshot({ path: path.join(evidence, '06-image-workflow-models.png') });

  const firstModel = candidates.getByRole('button', { name: /^固定使用 /u }).first();
  await firstModel.click();
  await expect(sheet.getByLabel('生成模型选择方式')).toHaveValue('fixed');
  await expect(sheet.getByLabel('固定生成模型')).toBeVisible();
});
