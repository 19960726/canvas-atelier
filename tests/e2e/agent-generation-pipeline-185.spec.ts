import { expect, test } from './helpers/e2e-test';
import { e2eState, openEmptyApp, queueProjectImageImport, queueProjectVideoImport, waitForModelSubmissions } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

const missingHandleWarnings = new WeakMap<object, string[]>();
test.beforeEach(async ({ page }) => {
  const warnings: string[] = [];
  missingHandleWarnings.set(page, warnings);
  page.on('console', message => {
    if (/Couldn't create edge|reactflow\.dev\/error#008/iu.test(message.text())) warnings.push(message.text());
  });
});
test.afterEach(async ({ page }, testInfo) => {
  const warnings = missingHandleWarnings.get(page) ?? [];
  await testInfo.attach('missing-handle-warnings', { body: JSON.stringify(warnings, null, 2), contentType: 'application/json' });
  expect(warnings, 'Real typed workflow edges must have mounted source and target handles').toEqual([]);
});

for (const theme of ['light', 'dark'] as const) {
  for (const kind of ['image_generation', 'video_generation'] as const) {
    test(`editable Agent ${kind} pipeline uses an unblurred source and shows the typed result in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 2600, height: 1400 });
      await page.addInitScript(mode => localStorage.setItem('novus.theme.mode', mode), theme);
      await openEmptyApp(page);
      const placement = await page.evaluate(async kind => {
        const modulePath = '/src/app/app-store.ts';
        const { useAppStore } = await import(modulePath);
        return useAppStore.getState().ensureAgentGenerationNode('confirmed-pipeline', kind, [], { prompt: '' });
      }, kind);
      expect(placement).toEqual({ generationNodeId: 'confirmed-pipeline', workflowNodeIds: ['confirmed-pipeline-prompt', 'confirmed-pipeline', 'confirmed-pipeline-output'] });
      for (const edgeId of ['confirmed-pipeline-prompt-edge', 'confirmed-pipeline-output-edge']) {
        // Custom curves retain React Flow's edge wrapper identity; test the
        // actual visible SVG path rather than only the durable edge DTO.
        const path = page.locator(`[data-testid="rf__edge-${edgeId}"] .react-flow__edge-path`);
        await expect(path).toHaveAttribute('d', /^M/u);
        await expect(path).toBeVisible();
      }
      const generation = page.locator(`[data-module-type="${kind}"]`);
      await generation.getByRole('button', { name: kind === 'image_generation' ? 'Open image generation editor' : 'Open video generation editor' }).click();
      const source = page.getByRole('textbox', { name: 'Text prompt' });
      const run = generation.getByRole('button', { name: kind === 'image_generation' ? 'Generate image' : '生成视频' });
      await expect(run).toBeDisabled();
      const fullPrompt = `真实可编辑 ${theme} 提示词：保持原产品结构、替换背景、避开旧文字，并检查完整约束。`;
      await source.fill(fullPrompt);
      await expect(source).toBeFocused();
      const prompt = generation.getByRole('textbox', { name: kind === 'image_generation' ? 'Image generation prompt' : 'Video preview prompt' });
      await expect(prompt).toHaveText(fullPrompt);
      await expect(prompt).toHaveAttribute('aria-readonly', 'true');
      await run.click();
      await waitForModelSubmissions(page, 1);
      const job = await page.evaluate(async () => {
        const modulePath = '/src/app/app-store.ts';
        const { useAppStore } = await import(modulePath);
        const state = useAppStore.getState();
        return { prompt: state.modelJobs[0]?.prompt, source: state.project.nodes.find((n: { id: string }) => n.id === 'confirmed-pipeline-prompt').data.config.prompt };
      });
      expect(job).toEqual({ prompt: fullPrompt, source: fullPrompt });
      await generation.getByRole('button', { name: '停止生成' }).click();
      if (kind === 'image_generation') {
        expect(await page.evaluate(() => window.__NOVUS_E2E__!.seedGeneratedImageResult(2))).toBe(true);
        const assetIds = (await e2eState(page)).projectImages.map(asset => asset.assetId);
        expect(await page.evaluate(async assetIds => window.__NOVUS_E2E__!.configureModule('image_generation', { config: { resultAssetIds: assetIds, resultState: 'fresh' }, execution: { state: 'completed' } }), assetIds)).toBe(true);
        const output = page.locator('[data-module-type="result_output"]');
        await expect(output.getByRole('img', { name: /Connected generated image/ })).toHaveCount(2);
        const image = output.getByRole('img', { name: 'Connected generated image 1' });
        expect(await image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
        await image.click({ button: 'right' });
        await expect(page.getByRole('menuitem', { name: '复制图片' })).toBeEnabled();
        await page.keyboard.press('Escape');
      } else {
        await page.evaluate(() => window.__NOVUS_E2E__!.createModule('video_input', { x: 100, y: 800 }));
        await queueProjectVideoImport(page, { label: '受控生成结果.mp4' });
        await page.locator('[data-module-type="video_input"]').getByRole('button', { name: 'Import video' }).click();
        const assetId = (await e2eState(page)).projectVideos.at(-1)!.assetId;
        expect(await page.evaluate(async assetId => window.__NOVUS_E2E__!.configureModule('video_generation', { config: { resultState: 'fresh', videoResults: [{ assetId, mediaType: 'video/mp4', durationMs: 5000 }] }, execution: { state: 'completed' } }), assetId)).toBe(true);
        await expect(page.getByLabel('Generated video playback video')).toHaveAttribute('src', /(?:^blob:|^novus-asset:|\/__novus_e2e_asset\/[a-f0-9]{16}\.mp4$)/u);
      }
      await page.screenshot({ path: testInfo.outputPath(`actual-pipeline-${kind}-${theme}.png`), fullPage: true });
    });
  }
}

test('a new Agent pipeline clears existing full generation cards and all newly created material cards', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 3800, height: 1900 });
  await openEmptyApp(page);
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('image_generation', { x: 120, y: 160 });
    await window.__NOVUS_E2E__!.createModule('image_input', { x: 100, y: 1100 });
  });
  const importNode = page.locator('[data-module-type="image_input"]');
  for (const [index, color] of [[42, 112, 152, 255], [155, 82, 33, 255]].entries()) {
    await queueProjectImageImport(page, makeReferenceImage(`material-${index}.png`, color as [number, number, number, number], { width: 1200, height: 800 }));
    await importNode.getByRole('button', { name: index === 0 ? /Import image/u : /Replace image/u }).click();
  }
  const assets = (await e2eState(page)).projectAssetIds;
  expect(assets).toHaveLength(2);
  const placement = await page.evaluate(async assets => {
    const modulePath = '/src/app/app-store.ts';
    const { useAppStore } = await import(modulePath);
    const state = useAppStore.getState();
    await state.deleteCanvasNodes(state.project.nodes.filter((n: { type: string; data: { moduleType?: string } }) => n.type === 'module' && n.data.moduleType === 'image_input').map((n: { id: string }) => n.id));
    return useAppStore.getState().ensureAgentGenerationNode('new-layout-pipeline', 'image_generation', assets, { prompt: '布局回归中的完整提示词' });
  }, assets);
  expect(placement).toBeTruthy();
  const cards = page.locator('[data-testid="module-node-card"]');
  await page.locator('[data-module-type="image_generation"]').first().getByRole('button', { name: 'Open image generation editor' }).click();
  const existingFull = await page.locator('[data-module-type="image_generation"]').first().boundingBox();
  const source = await page.locator('[data-module-type="text_prompt"]').boundingBox();
  const references = await page.locator('[data-module-type="image_input"]').all();
  const referenceBounds = await Promise.all(references.map(node => node.boundingBox()));
  await testInfo.attach('actual-factory-layout-bounds', { body: JSON.stringify({ existingFull, source, referenceBounds, positions: (await e2eState(page)).modulePositions }, null, 2), contentType: 'application/json' });
  await page.screenshot({ path: testInfo.outputPath('pipeline-existing-and-reference-bounds.png'), fullPage: true });
  expect(await cards.count()).toBe(placement.workflowNodeIds.length + 1);
  expect(source!.x, 'New prompt clears the existing full generation card').toBeGreaterThan(existingFull!.x + existingFull!.width);
  for (const bounds of referenceBounds) expect(bounds!.x, 'New reference clears the existing full generation card').toBeGreaterThan(existingFull!.x + existingFull!.width);
  for (let index = 1; index < referenceBounds.length; index++) expect(referenceBounds[index]!.y, 'New reference cards do not overlap vertically').toBeGreaterThan(referenceBounds[index - 1]!.y + referenceBounds[index - 1]!.height);
});

test('the applied pure reverse plan leaves its actual result, prompt and material cards unobstructed', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 3800, height: 1900 });
  await openEmptyApp(page);
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('image_generation', { x: 120, y: 160 });
    await window.__NOVUS_E2E__!.createModule('image_input', { x: 100, y: 1100 });
  });
  const input = page.locator('[data-module-type="image_input"]');
  for (const [index, color] of [[72, 145, 122, 255], [99, 82, 163, 255]].entries()) {
    await queueProjectImageImport(page, makeReferenceImage(`reverse-material-${index}.png`, color as [number, number, number, number], { width: 1200, height: 800 }));
    await input.getByRole('button', { name: index === 0 ? /Import image/u : /Replace image/u }).click();
  }
  expect(await page.evaluate(async () => {
    const storePath = '/src/app/app-store.ts';
    const planPath = '/src/agent/reverse-workflow-proposal.ts';
    const { useAppStore } = await import(storePath);
    const { buildReverseAgentCanvasPlan } = await import(planPath);
    const state = useAppStore.getState();
    await state.deleteCanvasNodes(state.project.nodes.filter((node: { type: string; data: { moduleType?: string } }) => node.type === 'module' && node.data.moduleType === 'image_input').map((node: { id: string }) => node.id));
    const current = useAppStore.getState();
    const analysis = {
      intent: { deliverable: '产品海报', useCase: '详情页', defaults: [], missing: [] }, referenceDuties: [],
      visual: { subject: '主体', environment: '环境', material: '材质', lighting: '灯光', camera: '镜头', depth: '景深', composition: '构图', perspective: '透视', layers: '前中后景' },
      prompts: { zh: '中文提示词', en: 'English prompt', negative: ['水印'] },
      variants: ['faithful', 'balanced', 'exploratory'].map(id => ({ id, name: id, change: '保留结构', prompt: 'A complete controlled result.' })), checklist: [], missing: [], runnable: true,
    };
    const plan = buildReverseAgentCanvasPlan({ project: current.project, persistenceGeneration: 1, modelRoute: 'chat/vision', references: current.project.assets.map((asset: { assetId: string; label: string }, index: number) => ({ assetId: asset.assetId, mention: `@图片${index + 1}`, label: asset.label })), analysis });
    return current.commitProjectTransaction({ ...plan.transaction, operations: plan.transaction.operations.map((operation: unknown) => ({ kind: 'canvas', operation })) });
  })).toBe(true);
  const result = page.locator('[data-module-type="reverse_result"]');
  const prompt = page.locator('[data-module-type="text_prompt"]').first();
  const refs = await page.locator('[data-module-type="image_input"]').all();
  const resultBox = (await result.boundingBox())!;
  const promptBox = (await prompt.boundingBox())!;
  const refBoxes = await Promise.all(refs.map(node => node.boundingBox()));
  const evidence = { resultBox, promptBox, refBoxes, positions: (await e2eState(page)).modulePositions };
  await testInfo.attach('actual-reverse-plan-bounds', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  await page.screenshot({ path: testInfo.outputPath('actual-reverse-plan-bounds.png'), fullPage: true });
  const separated = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
  expect.soft(separated(resultBox, promptBox), 'Reverse result does not cover the actual editable variant prompt').toBe(true);
  for (let index = 1; index < refBoxes.length; index++) expect.soft(separated(refBoxes[index - 1]!, refBoxes[index]!), 'New reverse materials do not overlap').toBe(true);
  await page.locator('[data-module-type="image_generation"]').first().getByRole('button', { name: 'Open image generation editor' }).click();
  const existing = (await page.locator('[data-module-type="image_generation"]').first().boundingBox())!;
  for (const box of refBoxes) expect.soft(separated(existing, box!), 'Reverse material clears the existing full generation card').toBe(true);
});
