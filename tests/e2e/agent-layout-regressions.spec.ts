import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './helpers/e2e-test';
import { e2eState, openAgentPanel, openEmptyApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

const evidenceDirectory = path.join(process.cwd(), 'work', process.env.CANVAS_AGENT_LAYOUT_DIR ?? 'qa-agent-node-layout-20260924');

test('keeps the model chooser, reasoning control and image material preview compact and testable', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await mkdir(evidenceDirectory, { recursive: true });
  await page.setViewportSize({ width: 1680, height: 1050 });
  await page.addInitScript(() => {
    localStorage.setItem('novus.theme.mode', 'light');
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
        const existing = value.codexCli as Record<string, unknown> | undefined;
        bridge = { ...value, codexCli: { ...existing, listProfiles: async () => profiles } };
      },
    });
  });

  await openEmptyApp(page);
  await openAgentPanel(page);
  const panel = page.getByTestId('agent-panel');
  await panel.getByLabel('Agent 模式').selectOption('codex');
  await expect(panel.getByTestId('agent-model-trigger')).toHaveAttribute('data-selected-model', 'GPT-6 Astra');

  await panel.getByTestId('agent-model-trigger').click();
  const modelPicker = panel.getByRole('dialog', { name: '选择聊天模型' });
  const modelSearch = modelPicker.getByRole('searchbox', { name: '搜索聊天模型' });
  await expect(modelPicker.getByRole('button', { name: '使用 GPT-6 Astra' })).toBeVisible();
  await expect(modelPicker.getByRole('button', { name: '使用 GPT-6 Sol' })).toBeVisible();
  await expect(modelPicker.getByRole('button', { name: '使用 GPT-6 Luna' })).toBeVisible();
  await modelSearch.fill('gpt-6-luna');
  await expect(modelPicker.getByRole('button', { name: '使用 GPT-6 Luna' })).toBeVisible();
  await expect(modelPicker.getByRole('button', { name: '使用 GPT-6 Astra' })).toHaveCount(0);
  const modelSurface = await modelPicker.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const root = element.parentElement;
    const rootStyle = root ? getComputedStyle(root) : null;
    return { width: box.width, height: box.height, x: box.x, background: style.backgroundColor, position: style.position, inset: style.inset, left: style.left, right: style.right, transform: style.transform, rootClass: root?.className, rootPosition: rootStyle?.position, rootBackground: rootStyle?.backgroundColor };
  });
  console.log(`MODEL_PICKER_SURFACE ${JSON.stringify(modelSurface)}`);
  expect(modelSurface.width).toBeLessThanOrEqual(360);
  expect(modelSurface.height).toBeLessThan(500);
  // The nested model list shares the solid reasoning surface. Its own child
  // background may be transparent so the two controls read as one popover.
  expect(modelSurface.rootClass).toContain('codex-reasoning__popover');
  expect(modelSurface.rootBackground).toMatch(/^rgb\(/u);
  await page.screenshot({ path: testInfo.outputPath('model-picker-filtered.png'), fullPage: true });
  await modelPicker.getByRole('button', { name: '使用 GPT-6 Luna' }).click();
  await expect(panel.getByTestId('agent-model-trigger')).toHaveAttribute('data-selected-model', 'GPT-6 Luna');

  await panel.getByRole('button', { name: '思考能力：中' }).click();
  const reasoning = panel.getByRole('dialog', { name: '思考能力设置' });
  const reasoningSlider = reasoning.getByRole('slider', { name: '思考能力' });
  const reasoningBox = await reasoning.boundingBox();
  expect(reasoningBox).not.toBeNull();
  expect(reasoningBox!.width).toBeLessThanOrEqual(300);
  await expect(reasoningSlider).toHaveAttribute('aria-valuetext', '中');
  await page.screenshot({ path: testInfo.outputPath('reasoning-compact.png'), fullPage: true });
  await reasoningSlider.press('End');
  await expect(reasoningSlider).toHaveAttribute('aria-valuetext', 'Max');
  await page.keyboard.press('Escape');
  await expect(reasoning).toHaveCount(0);

  await panel.getByRole('button', { name: '关闭 Novus Agent' }).click();
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('image_input', { x: 180, y: 240 });
    await window.__NOVUS_E2E__!.createModule('image_generation', { x: 560, y: 160 });
    await window.__NOVUS_E2E__!.createModule('reverse_agent', { x: 1060, y: 200 });
    await window.__NOVUS_E2E__!.connectModules('image_input', 'image', 'image_generation', 'references');
    await window.__NOVUS_E2E__!.connectModules('image_input', 'image', 'reverse_agent', 'references');
  });
  const imageInput = page.locator('[data-module-type="image_input"]');
  const imageGeneration = page.locator('[data-module-type="image_generation"]');
  const reverse = page.locator('[data-module-type="reverse_agent"]');
  await queueProjectImageImport(page, makeReferenceImage('Material input preview.png', [24, 136, 121, 255], { width: 960, height: 720 }));
  await imageInput.getByRole('button', { name: '导入图像 / Import image' }).click();
  await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(2);

  await imageInput.locator('.module-node__media-frame img').dblclick();
  const inputPreview = page.getByRole('dialog', { name: 'Generated image preview' });
  await expect(inputPreview).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('image-input-double-click-preview.png'), fullPage: true });
  await inputPreview.getByRole('button', { name: 'Close generated image preview' }).click();

  const slotRow = reverse.getByLabel('Connected reverse media slots');
  await expect(slotRow.getByRole('img', { name: 'Material input preview' })).toBeVisible();
  const mediaGeometry = await slotRow.locator('.connected-agent-media-slots__row').evaluate((row) => {
    const rowBox = row.getBoundingClientRect();
    const item = row.querySelector<HTMLElement>('.connected-agent-media-slots__item');
    const itemBox = item?.getBoundingClientRect();
    return { rowWidth: rowBox.width, itemWidth: itemBox?.width ?? 0, rightSlack: itemBox ? rowBox.right - itemBox.right : 0, gap: getComputedStyle(row).gap };
  });
  console.log(`CONNECTED_MEDIA_GEOMETRY ${JSON.stringify(mediaGeometry)}`);
  await slotRow.getByLabel('Agent media slot 1').dblclick();
  await expect(page.getByRole('dialog', { name: 'Generated image preview' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('connected-material-double-click-preview.png'), fullPage: true });
  await page.getByRole('button', { name: 'Close generated image preview' }).click();

  const reverseDepthButtons = ['快速反推', '标准反推', '深度反推'] as const;
  for (const label of reverseDepthButtons) {
    const button = reverse.getByRole('button', { name: label });
    await expect(button).toBeVisible();
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    const selectedDepths = await reverse.locator('[aria-pressed="true"]').allTextContents();
    expect(selectedDepths).toContain(label);
  }
  const reverseDepthGeometry = await reverse.evaluate((element) => {
    const node = element.getBoundingClientRect();
    const buttons = [...element.querySelectorAll<HTMLElement>('button[aria-pressed]')]
      .filter((button) => ['快速反推', '标准反推', '深度反推'].some((label) => button.textContent?.includes(label)))
      .map((button) => {
        const rect = button.getBoundingClientRect();
        return { label: button.textContent?.trim(), x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
    return { node: { x: node.x, right: node.right, width: node.width }, buttons };
  });
  expect(reverseDepthGeometry.buttons).toHaveLength(3);
  expect(reverseDepthGeometry.node.right).toBeLessThanOrEqual(1680);
  await page.screenshot({ path: testInfo.outputPath('reverse-strength-deep.png'), fullPage: true });

  await page.mouse.move(0, 0);
  const auxiliaryImageOutput = imageGeneration.locator('.react-flow__handle[data-port-id="image"]');
  const resultOutput = imageGeneration.locator('.module-node__port-row[data-port-id="result"] .react-flow__handle[data-port-id="result"]');
  await expect(resultOutput).toBeVisible();
  await expect(imageGeneration.locator('.module-node__ports-column--outputs .module-node__port-row')).toHaveCount(1);
  await expect(auxiliaryImageOutput).toHaveAttribute('data-visual-alias', 'true');
  await imageGeneration.hover();
  await expect.poll(() => auxiliaryImageOutput.evaluate((element) => ({ opacity: getComputedStyle(element).opacity, pointerEvents: getComputedStyle(element).pointerEvents }))).toEqual({ opacity: '0', pointerEvents: 'none' });
  await page.screenshot({ path: testInfo.outputPath('generation-single-output-on-hover.png'), fullPage: true });

  const submissions = await page.evaluate(() => window.__NOVUS_E2E__!.getState().modelSubmissions.length);
  expect(submissions).toBe(0);
  expect(pageErrors).toEqual([]);
});

test('connects the one visible generation output to image and result consumers', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1680, height: 1050 });
  await openEmptyApp(page);
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('image_generation', { x: 180, y: 130 });
    await window.__NOVUS_E2E__!.createModule('image_layering', { x: 920, y: 130 });
    await window.__NOVUS_E2E__!.createModule('result_output', { x: 920, y: 670 });
  });
  const generation = page.locator('[data-module-type="image_generation"]');
  const source = generation.locator('.react-flow__handle[data-port-id="result"]');
  const hiddenAlias = generation.locator('.react-flow__handle[data-port-id="image"]');
  const destinations = [
    page.locator('[data-module-type="image_layering"] .react-flow__handle[data-port-id="image"]'),
    page.locator('[data-module-type="result_output"] .react-flow__handle[data-port-id="result"]'),
  ];
  await expect(generation.locator('.module-node__ports-column--outputs .module-node__port-row')).toHaveCount(1);
  for (const destination of destinations) {
    const start = await source.boundingBox();
    const end = await destination.boundingBox();
    expect(start).not.toBeNull();
    expect(end).not.toBeNull();
    await page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2);
    await page.mouse.down();
    await page.mouse.move(end!.x + end!.width / 2, end!.y + end!.height / 2, { steps: 14 });
    await page.mouse.up();
  }
  await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(2);
  await generation.hover();
  await expect.poll(() => hiddenAlias.evaluate((element) => getComputedStyle(element).opacity)).toBe('0');
  await page.screenshot({ path: testInfo.outputPath('generation-single-socket-two-typed-connections.png'), fullPage: true });
  expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
});

test('accepts reverse drags into the single generation socket for both result types', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1050 });
  await openEmptyApp(page);
  for (const [targetType, targetPort] of [['image_layering', 'image'], ['result_output', 'result']] as const) {
    await page.evaluate(async ([moduleType]) => {
      await window.__NOVUS_E2E__!.resetEmpty();
      await window.__NOVUS_E2E__!.createModule('image_generation', { x: 180, y: 130 });
      await window.__NOVUS_E2E__!.createModule(moduleType, { x: 920, y: 130 });
    }, [targetType, targetPort]);
    const source = page.locator('[data-module-type="image_generation"] .react-flow__handle[data-port-id="result"]');
    const destination = page.locator(`[data-module-type="${targetType}"] .react-flow__handle[data-port-id="${targetPort}"]`);
    const start = await destination.boundingBox();
    const end = await source.boundingBox();
    expect(start).not.toBeNull();
    expect(end).not.toBeNull();
    await page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2);
    await page.mouse.down();
    await page.mouse.move(end!.x + end!.width / 2, end!.y + end!.height / 2, { steps: 14 });
    await page.mouse.up();
    await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(1);
  }
  expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
});
