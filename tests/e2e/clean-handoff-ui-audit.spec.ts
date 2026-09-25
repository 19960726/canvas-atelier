import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listCanvasModuleDefinitions, type CanvasNode } from '@agent-canvas/domain';
import { listDiscoverableModuleDefinitions } from '../../apps/renderer/src/canvas/module-catalog';
import { expect, test } from './helpers/e2e-test';
import { e2eState, openAgentPanel, openEmptyApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

const auditDirectory = path.join(process.cwd(), 'work', process.env.CANVAS_UI_AUDIT_DIR ?? 'qa-clean-handoff-2026-09-24-r5');

async function captureControls(locator: import('@playwright/test').Locator) {
  return locator.evaluate((root) => Array.from(root.querySelectorAll('button,input,textarea,select,[role="slider"],[contenteditable="true"]'))
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    })
    .map((element) => ({
      tag: element.tagName.toLowerCase(),
      name: element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent?.trim().replace(/\s+/gu, ' ').slice(0, 90) || '',
      value: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? element.value : element.getAttribute('contenteditable') === 'true' ? element.textContent : null,
      disabled: element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? element.disabled : false,
      pressed: element.getAttribute('aria-pressed'),
      options: element instanceof HTMLSelectElement ? Array.from(element.options, (option) => option.textContent?.trim() ?? '') : [],
    })));
}

test('records fresh screenshots and visible controls for every domain-registered module', async ({ page }) => {
  test.setTimeout(180_000);
  await mkdir(path.join(auditDirectory, 'registered-nodes'), { recursive: true });
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.addInitScript(() => localStorage.setItem('novus.theme.mode', 'light'));
  await openEmptyApp(page);
  const definitions = listCanvasModuleDefinitions();
  const discoverable = new Set(listDiscoverableModuleDefinitions().map((definition) => definition.type));
  const records = [];
  for (const [index, definition] of definitions.entries()) {
    await page.evaluate(async (type) => {
      await window.__NOVUS_E2E__!.resetEmpty();
      await window.__NOVUS_E2E__!.createModule(type, { x: 300, y: 160 });
    }, definition.type);
    const node = page.locator(`[data-module-type="${definition.type}"]`);
    await expect(node).toBeVisible();
    const controls = await captureControls(node);
    const text = (await node.innerText()).trim();
    const enabled = await node.locator('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)').all();
    let focusResult = 'no enabled visible control';
    for (const control of enabled) {
      if (!(await control.isVisible())) continue;
      const rect = await control.boundingBox();
      if (!rect || rect.width < 1 || rect.height < 1) continue;
      await control.focus();
      focusResult = await control.evaluate((element) => document.activeElement === element ? 'focused' : 'focus failed');
      break;
    }
    const screenshot = `registered-nodes/${String(index + 1).padStart(2, '0')}-${definition.type}.png`;
    await page.screenshot({ path: path.join(auditDirectory, screenshot), fullPage: true });
    records.push({
      type: definition.type,
      name: definition.primaryName,
      discoverable: discoverable.has(definition.type),
      visibleText: text,
      controls,
      interaction: focusResult,
      screenshot,
      unverified: 'Provider execution, media import, and persistent reopen are outside this single-node inventory pass.',
    });
  }
  await writeFile(path.join(auditDirectory, 'registered-nodes.json'), JSON.stringify(records, null, 2), 'utf8');
  expect(records).toHaveLength(definitions.length);
  expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
});

test('records that eight separately registered legacy canvas renderers are filtered from the current canvas', async ({ page }) => {
  await mkdir(path.join(auditDirectory, 'registered-canvas-types'), { recursive: true });
  await page.setViewportSize({ width: 1600, height: 1100 });
  await openEmptyApp(page);
  const position = { x: 420, y: 220 };
  const nodes: CanvasNode[] = [
    { id: 'audit-reference', type: 'reference', position, data: { assetId: 'missing-audit-asset', role: 'product_identity' } },
    { id: 'audit-prompt', type: 'prompt', position, data: { prompt: '本地提示词节点', requirementIds: [] } },
    { id: 'audit-placement', type: 'placement_preview', position, data: { board: { id: 'audit-board', aspectRatio: '4:5', width: 1080, height: 1350, safeAreas: [] }, objects: [] } },
    { id: 'audit-model-job', type: 'model_job', position, data: { job: { id: 'audit-job', kind: 'image', modelId: 'fixture-model', status: 'running', promptNodeId: 'audit-prompt', retryCount: 0, referenceAssetIds: [] } } },
    { id: 'audit-image-result', type: 'image_result', position, data: { assetId: 'missing-audit-asset', modelId: 'fixture-model', provider: 'comfly', modelRoute: 'fixture', displayName: '本地结果夹具', parentNodeIds: [], referenceAssetIds: [], promptNodeId: 'audit-prompt', jobId: 'audit-job', width: 320, height: 240 } },
    { id: 'audit-review', type: 'review', position, data: { keep: ['保留主体'], change: ['调整光线'], never: ['禁止自动生成'] } },
    { id: 'audit-memory-diff', type: 'memory_diff', position, data: { diffId: 'audit-diff', status: 'pending_review' } },
    { id: 'audit-agent-plan', type: 'agent_plan', position, data: { plan: { id: 'audit-plan', state: 'waiting_for_confirmation', proposedOperationIds: [], requiresModelConfirmation: true } } },
  ];
  const records = [];
  for (const [index, node] of nodes.entries()) {
    await page.evaluate((item) => window.__NOVUS_E2E__!.seedCanvasNodeForAudit(item), node);
    const visible = page.locator(`.react-flow__node[data-id="${node.id}"]`);
    await expect(visible).toHaveCount(0);
    const screenshot = `registered-canvas-types/${String(index + 1).padStart(2, '0')}-${node.type}.png`;
    records.push({ type: node.type, visibleText: null, controls: [], screenshot, interaction: 'Registered renderer is filtered from the module-first canvas; no visible controls to exercise.', unverified: 'Legacy persisted-project migration and historical rendering.' });
    await page.screenshot({ path: path.join(auditDirectory, screenshot), fullPage: true });
  }
  await writeFile(path.join(auditDirectory, 'registered-canvas-types.json'), JSON.stringify(records, null, 2), 'utf8');
  expect(records).toHaveLength(8);
});

test('keeps large-canvas navigation optional and available on demand', async ({ page }) => {
  await mkdir(auditDirectory, { recursive: true });
  await page.setViewportSize({ width: 1600, height: 1100 });
  await openEmptyApp(page);
  await page.getByTestId('tool-modules').click();
  expect(await page.evaluate(() => window.__NOVUS_E2E__!.seedModuleStressGraph(300, 500))).toBe(true);
  await expect(page.locator('.react-flow__node')).not.toHaveCount(0);
  await expect(page.getByTestId('rf__minimap')).toHaveCount(0);
  const toggle = page.getByRole('button', { name: '显示大型画布导航地图' });
  await expect(toggle).toBeVisible();
  await page.screenshot({ path: path.join(auditDirectory, 'large-canvas-minimap-hidden.png'), fullPage: true });
  await toggle.click();
  const miniMap = page.getByTestId('rf__minimap');
  await expect(miniMap).toBeVisible();
  const miniMapNodeCount = await page.locator('.react-flow__minimap-node').count();
  expect(miniMapNodeCount).toBeGreaterThan(250);
  await page.screenshot({ path: path.join(auditDirectory, 'large-canvas-minimap-visible.png'), fullPage: true });
  await page.getByRole('button', { name: '隐藏大型画布导航地图' }).click();
  await expect(miniMap).toHaveCount(0);
  await writeFile(path.join(auditDirectory, 'large-canvas-minimap.json'), JSON.stringify({ nodeCount: 300, miniMapNodeCount, visibleByDefault: false, optInToggle: true }, null, 2), 'utf8');
});

test('checks local AI layering stages without a provider submission', async ({ page }) => {
  test.setTimeout(120_000);
  await mkdir(auditDirectory, { recursive: true });
  await page.setViewportSize({ width: 1600, height: 1100 });
  await openEmptyApp(page);
  const externalRequests: string[] = [];
  page.on('request', (request) => {
    if (!/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//u.test(request.url())
      && /^https?:/u.test(request.url())) externalRequests.push(request.url());
  });
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('image_input', { x: 80, y: 260 });
    await window.__NOVUS_E2E__!.createModule('image_generation', { x: 470, y: 110 });
  });
  await queueProjectImageImport(page, makeReferenceImage('fresh-layer-source.png', [108, 156, 188, 255], { width: 320, height: 240 }), { preservePixels: true });
  await page.locator('[data-module-type="image_input"]').getByRole('button', { name: /Import image/u }).click();
  const sourceAssetId = (await e2eState(page)).projectImages.at(-1)!.assetId;
  await page.evaluate(async (assetId) => window.__NOVUS_E2E__!.configureModule('image_generation', {
    config: { resultState: 'fresh', resultAssetIds: [assetId] },
    execution: { state: 'completed' },
  }), sourceAssetId);
  const generation = page.locator('[data-module-type="image_generation"]');
  await generation.getByRole('button', { name: 'Open image generation editor' }).click();
  const layeringEntry = generation.getByRole('button', { name: 'AI 分层' });
  const entryHit = await layeringEntry.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return { button: rect.toJSON(), hitTag: hit?.tagName ?? null, hitClass: hit?.getAttribute('class') ?? null, reachable: hit === element || element.contains(hit) };
  });
  await writeFile(path.join(auditDirectory, 'layering-entry-hit.json'), JSON.stringify(entryHit, null, 2), 'utf8');
  await page.screenshot({ path: path.join(auditDirectory, 'layering-entry-before-click.png'), fullPage: true });
  expect(entryHit.reachable).toBe(true);
  await generation.getByRole('button', { name: 'AI 分层' }).click();
  const dialog = page.getByRole('dialog', { name: 'AI 图片分层' });
  await expect(dialog.getByRole('combobox', { name: '视觉分析模型' })).toBeVisible();
  await writeFile(path.join(auditDirectory, 'layering-stage-1.json'), JSON.stringify(await captureControls(dialog), null, 2), 'utf8');
  await page.screenshot({ path: path.join(auditDirectory, 'layering-stage-1-analysis.png'), fullPage: true });
  await page.evaluate(() => window.__NOVUS_E2E__!.queueLayeringAnalysisReply(JSON.stringify({ layers: [
    { layerId: 'background', kind: 'background', name: '浅色墙面与台面', description: '墙面和台面作为连续背景；不包含产品、摆件及投影像素。', included: true },
    { layerId: 'coffee-machine', kind: 'transparent', name: '咖啡机主体', description: '保留咖啡机外壳、玻璃壶和按钮；不包含接触阴影。', included: true },
    { layerId: 'machine-shadow', kind: 'transparent', name: '咖啡机接触阴影', description: '单独保留机器底部落在台面上的接触阴影，不包含机器像素。', included: true },
    { layerId: 'ceramic-cup', kind: 'transparent', name: '左侧陶瓷杯', description: '只保留咖啡机左侧的陶瓷杯，保持杯口和把手完整。', included: true },
    { layerId: 'cup-shadow', kind: 'transparent', name: '陶瓷杯投影', description: '单独保留陶瓷杯在台面上的投影，不包含杯体像素。', included: true },
    { layerId: 'wood-tray', kind: 'transparent', name: '右侧木质托盘与咖啡豆', description: '保留托盘和其中咖啡豆；与背景、投影分开。', included: true },
    { layerId: 'tray-shadow', kind: 'transparent', name: '托盘投影', description: '单独保留托盘下方投影，不包含托盘和咖啡豆像素。', included: true },
  ] })));
  await dialog.getByRole('button', { name: '分析图片' }).click();
  const layerList = dialog.getByRole('list', { name: '可编辑分层方案' });
  await expect(layerList.getByRole('listitem')).toHaveCount(7);
  await expect(layerList.getByRole('textbox', { name: '图层名称 咖啡机主体' })).toBeVisible();
  await expect(layerList.getByRole('textbox', { name: '图层名称 咖啡机接触阴影' })).toBeVisible();
  await expect(layerList.getByRole('textbox', { name: '图层名称 左侧陶瓷杯' })).toBeVisible();
  await expect(layerList.getByRole('textbox', { name: '图层名称 陶瓷杯投影' })).toBeVisible();
  await dialog.getByRole('button', { name: '排除图层 托盘投影' }).click();
  await expect(dialog.getByText('6 个图层')).toBeVisible();
  await writeFile(path.join(auditDirectory, 'layering-semantic-plan.json'), JSON.stringify({
    layerNames: await layerList.getByRole('textbox', { name: /^图层名称/u }).evaluateAll((elements) => elements.map((element) => (element as HTMLInputElement).value)),
    includedLayers: 6,
    shadowsKeptSeparate: ['咖啡机接触阴影', '陶瓷杯投影'],
    localFixtureOnly: true,
  }, null, 2), 'utf8');
  await page.screenshot({ path: path.join(auditDirectory, 'layering-stage-2-edit.png'), fullPage: true });
  await dialog.getByRole('button', { name: '下一步：确认生成' }).click();
  await expect(dialog.getByRole('region', { name: '生成确认摘要' })).toBeVisible();
  const confirmGeneration = dialog.getByRole('button', { name: '确认生成 6 层' });
  await expect(confirmGeneration).toBeDisabled();
  await confirmGeneration.scrollIntoViewIfNeeded();
  await writeFile(path.join(auditDirectory, 'layering-stage-3.json'), JSON.stringify(await captureControls(dialog), null, 2), 'utf8');
  await page.screenshot({ path: path.join(auditDirectory, 'layering-stage-3-blocked-review.png'), fullPage: true });
  await dialog.getByRole('button', { name: '关闭 AI 图片分层' }).click();
  expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
  expect(externalRequests).toEqual([]);
  await page.evaluate(async (assetId) => window.__NOVUS_E2E__!.seedImageLayeringGroup(assetId, 320, 240, [
    { layerId: 'background', kind: 'background', name: '浅色墙面与台面', description: '墙面和台面作为连续背景。', included: true },
    { layerId: 'coffee-machine', kind: 'transparent', name: '咖啡机主体', description: '保留咖啡机本体像素，不包含阴影。', included: true },
    { layerId: 'machine-shadow', kind: 'transparent', name: '咖啡机接触阴影', description: '机器底部阴影单独一层，不包含机器像素。', included: true },
    { layerId: 'ceramic-cup', kind: 'transparent', name: '左侧陶瓷杯', description: '仅保留陶瓷杯本体。', included: true },
    { layerId: 'cup-shadow', kind: 'transparent', name: '陶瓷杯投影', description: '杯体投影单独一层，不包含杯子像素。', included: true },
    { layerId: 'wood-tray', kind: 'transparent', name: '右侧木质托盘与咖啡豆', description: '托盘和咖啡豆单独于背景。', included: true },
  ]), sourceAssetId);
  await expect(page.locator('[data-module-type="image_layer"]')).toHaveCount(6);
  await expect(page.locator('[data-module-type="image_layering"]')).toHaveCount(1);
  await page.locator('.react-flow__controls-fitview').evaluate((button) => (button as HTMLButtonElement).click());
  await page.screenshot({ path: path.join(auditDirectory, 'layering-local-seeded-graph.png'), fullPage: true });
});

test('checks Agent dialog, image generation, and video parameters with fresh screenshots', async ({ page }) => {
  await mkdir(auditDirectory, { recursive: true });
  await page.setViewportSize({ width: 1600, height: 1100 });
  await openEmptyApp(page);
  await openAgentPanel(page);
  const agent = page.getByTestId('agent-panel');
  await agent.getByLabel('Agent 模式').selectOption('chat');
  await agent.getByTestId('agent-composer-input').fill('本地未发送的界面检查草稿');
  await agent.getByRole('button', { name: '历史对话', exact: true }).click();
  await expect(agent.getByRole('dialog', { name: '历史对话' })).toBeVisible();
  await page.screenshot({ path: path.join(auditDirectory, 'agent-chat-history.png'), fullPage: true });
  await agent.getByRole('button', { name: '关闭历史对话' }).click();
  await agent.getByLabel('Agent 模式').selectOption('original');
  await page.screenshot({ path: path.join(auditDirectory, 'agent-creation-tab.png'), fullPage: true });
  await agent.getByLabel('Agent 模式').selectOption('codex');
  await page.screenshot({ path: path.join(auditDirectory, 'agent-codex-tab.png'), fullPage: true });
  await writeFile(path.join(auditDirectory, 'agent-controls.json'), JSON.stringify(await captureControls(agent), null, 2), 'utf8');
  await agent.getByRole('button', { name: '关闭 Novus Agent' }).click();
  await page.evaluate(async () => window.__NOVUS_E2E__!.createModule('image_generation', { x: 350, y: 90 }));
  const image = page.locator('[data-module-type="image_generation"]');
  await image.getByRole('button', { name: 'Open image generation editor' }).click();
  await image.getByRole('combobox', { name: 'Image generation model route' }).selectOption({ label: 'GPT Image 2' });
  await image.getByRole('textbox', { name: 'Image generation prompt' }).fill('本地参数检查，不生成图片');
  await writeFile(path.join(auditDirectory, 'image-generation-controls.json'), JSON.stringify(await captureControls(image), null, 2), 'utf8');
  await page.screenshot({ path: path.join(auditDirectory, 'image-generation-expanded.png'), fullPage: true });
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.resetEmpty();
    await window.__NOVUS_E2E__!.createModule('video_generation', { x: 350, y: 90 });
  });
  const video = page.locator('[data-module-type="video_generation"]');
  await video.getByRole('button', { name: 'Open video generation editor' }).click();
  await video.getByRole('button', { name: '打开视频参数设置' }).click();
  const settings = video.getByRole('dialog', { name: '视频生成参数' });
  const audio = settings.getByRole('button', { name: '生成音频' });
  const row = audio.locator('xpath=../..');
  const [rowBox, buttonBox] = await Promise.all([row.boundingBox(), audio.boundingBox()]);
  const centerDelta = Math.abs((buttonBox!.x + buttonBox!.width / 2) - (rowBox!.x + rowBox!.width / 2));
  expect(centerDelta).toBeLessThanOrEqual(1);
  await audio.click();
  await expect(audio).toHaveAttribute('aria-pressed', 'false');
  await audio.click();
  await expect(audio).toHaveAttribute('aria-pressed', 'true');
  const duration = settings.getByRole('slider', { name: '视频时长' });
  await duration.focus();
  const beforeDuration = Number.parseInt((await settings.locator('output').innerText()), 10);
  await duration.press('ArrowRight');
  const afterDuration = Number.parseInt((await settings.locator('output').innerText()), 10);
  expect(afterDuration).toBeGreaterThan(beforeDuration);
  await expect(duration).toHaveAttribute('aria-valuetext', `${afterDuration}秒`);
  await writeFile(path.join(auditDirectory, 'video-parameters.json'), JSON.stringify({ centerDelta, controls: await captureControls(settings) }, null, 2), 'utf8');
  await page.screenshot({ path: path.join(auditDirectory, 'video-settings-expanded.png'), fullPage: true });
  expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
});
