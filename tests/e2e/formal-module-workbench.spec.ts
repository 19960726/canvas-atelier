import { test, expect } from './helpers/e2e-test';
import {
  assertLocatorInside,
  captureLayoutScreenshot,
  e2eState,
  openAgentPanel,
  openApp,
  openEmptyApp,
} from './helpers/app';

const viewports = [
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
];

for (const theme of ['light', 'dark'] as const) {
  test(`automatically opens the exact legacy starter as the Figma workbench in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript((nextTheme) => localStorage.setItem('novus.theme.mode', nextTheme), theme);
    await openApp(page);

    await expect(page.getByTestId('legacy-workbench-migration')).toBeHidden();
    await expect(page.getByRole('button', { name: '保存项目' })).toBeVisible();
    await expect(page.locator('[data-module-type="image_generation"]')).toHaveCount(1);
    await expect(page.locator('[data-module-type="reverse_result"]')).toHaveCount(1);
    await expect(page.locator('[data-module-type="video_result"]')).toHaveCount(1);
    await expect(page.locator('[data-node-kind="reference"], [data-node-kind="placement_preview"], [data-node-kind="prompt"]')).toHaveCount(0);
    const imageWorkbench = page.locator('[data-module-type="image_generation"]');
    expect((await imageWorkbench.boundingBox())?.x).toBe(340);
    await expect(page.getByTestId('toolrail')).toHaveJSProperty('offsetWidth', 60);
    await expect(page.getByTestId('toolrail')).toHaveJSProperty('offsetHeight', 390);
    await expect(page.getByTestId('toolrail')).toHaveCSS('left', '52px');
    expect((await page.getByTestId('toolrail').boundingBox())?.y).toBe(142);
    await openAgentPanel(page);
    await expect(page.getByTestId('agent-panel')).toBeVisible();
    expect((await e2eState(page)).projectNodeTypes).toEqual(['module', 'module', 'module', 'module', 'module', 'module', 'module']);

    await captureLayoutScreenshot(page, testInfo, `legacy-to-figma-workbench-${theme}`);
  });
}

for (const theme of ['light', 'dark'] as const) {
  for (const viewport of viewports) {
    test(`unified module workbench is contained at ${viewport.name} ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.addInitScript((nextTheme) => localStorage.setItem('novus.theme.mode', nextTheme), theme);
      await openEmptyApp(page);
      await page.evaluate(async () => {
        const harness = window.__NOVUS_E2E__;
        await harness?.createModule('image_input', { x: 0, y: 520 });
        await harness?.createModule('image_generation', { x: 420, y: 0 });
        await harness?.createModule('reverse_agent', { x: 420, y: 540 });
        await harness?.createModule('video_generation', { x: 1120, y: 0 });
        await harness?.createModule('reverse_result', { x: 1120, y: 540 });
        await harness?.createModule('video_result', { x: 1850, y: 0 });
        await harness?.connectModules('image_input', 'image', 'image_generation', 'references');
        await harness?.connectModules('image_input', 'image', 'reverse_agent', 'references');
        await harness?.connectModules('image_input', 'image', 'video_generation', 'media');
        await harness?.connectModules('reverse_agent', 'analysis', 'reverse_result', 'analysis');
        await harness?.connectModules('video_generation', 'result', 'video_result', 'video');
      });

      const configured = await page.evaluate(async () => {
        const harness = window.__NOVUS_E2E__ as typeof window.__NOVUS_E2E__ & {
          configureModule?: (
            moduleType: 'image_generation' | 'reverse_agent',
            patch: { config: Record<string, unknown>; execution: { state: 'failed' | 'completed'; latestExecutionId: string } },
          ) => Promise<boolean>;
        };
        if (!harness?.configureModule) return false;
        const generation = await harness.configureModule('image_generation', {
          config: {
            routeDisplayName: 'Compatible Image Route',
            enabledInputCapabilities: ['references', 'mask'],
            referenceAssetIds: ['0123456789abcdef'],
            resultState: 'stale',
            error: { title: '模型不可用', action: '选择兼容模型' },
          },
          execution: { state: 'failed', latestExecutionId: 'generation-e2e-1' },
        });
        const reverse = await harness.configureModule('reverse_agent', {
          config: {
            orderedMedia: [
              { kind: 'image', assetId: '0123456789abcdef', label: '产品正面' },
              { kind: 'video', assetId: 'managed-video-1', label: '广告片', ranges: [{ startMs: 1500, endMs: 6250 }] },
            ],
            skillName: '产品商业片',
            mode: '多模态兼容',
            knowledgeVersion: 7,
            resultState: 'fresh',
            routeDisplayName: 'Vision Composite',
          },
          execution: { state: 'completed', latestExecutionId: 'reverse-e2e-1' },
        });
        return generation && reverse;
      });
      expect(configured).toBe(true);

      await page.locator('.react-flow__controls-fitview').evaluate((button) => (button as HTMLButtonElement).click());
      await page.getByTestId('tool-modules').click();

      const library = page.getByTestId('module-library');
      const canvas = page.getByTestId('canvas-stage');
      const representativeTypes = [
        'image_input',
        'image_generation',
        'reverse_agent',
        'video_generation',
        'reverse_result',
        'video_result',
      ];
      for (const moduleType of representativeTypes) {
        const node = page.locator(`[data-module-type="${moduleType}"]`);
        await expect(node).toHaveCount(1);
        await assertLocatorInside(canvas, node, `${moduleType} node ${viewport.name} ${theme}`);
      }
      const nodeBoxes = await Promise.all(representativeTypes.map(async (moduleType) => ({
        moduleType,
        box: await page.locator(`[data-module-type="${moduleType}"]`).boundingBox(),
      })));
      for (let index = 0; index < nodeBoxes.length; index += 1) {
        const current = nodeBoxes[index];
        expect(current.box, `${current.moduleType} should be measurable`).not.toBeNull();
        for (const other of nodeBoxes.slice(index + 1)) {
          expect(other.box, `${other.moduleType} should be measurable`).not.toBeNull();
          const overlaps = current.box!.x < other.box!.x + other.box!.width
            && current.box!.x + current.box!.width > other.box!.x
            && current.box!.y < other.box!.y + other.box!.height
            && current.box!.y + current.box!.height > other.box!.y;
          expect(overlaps, `${current.moduleType} should not overlap ${other.moduleType}`).toBe(false);
        }
      }
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('.react-flow__edge')).toHaveCount(5);
      await expect(page.locator('[data-module-type="image_generation_v1"], [data-module-type="image_generation_v2"], [data-module-type="video_analysis"]')).toHaveCount(0);
      await assertLocatorInside(canvas, library, `module library ${viewport.name} ${theme}`);
      const generationNode = page.locator('[data-module-type="image_generation"]');
      const reverseNode = page.locator('[data-module-type="reverse_agent"]');
      const allNodes = representativeTypes.map((moduleType) => page.locator(`[data-module-type="${moduleType}"]`));
      await expect(generationNode.locator('.module-node__port-row[data-port-id="references"][data-port-direction="input"] .react-flow__handle')).toBeVisible();
      await expect(generationNode.locator('.module-node__port-row[data-port-id="result"][data-port-direction="output"] .react-flow__handle')).toBeVisible();
      await expect(reverseNode.locator('.module-node__port-row[data-port-id="references"][data-port-direction="input"] .react-flow__handle')).toBeVisible();
      await expect(reverseNode.locator('.module-node__port-row[data-port-id="analysis"][data-port-direction="output"] .react-flow__handle')).toBeVisible();
      for (const node of allNodes) {
        const handles = node.locator('.react-flow__handle');
        expect(await handles.count()).toBeGreaterThan(0);
        for (let handleIndex = 0; handleIndex < await handles.count(); handleIndex += 1) {
          await expect(handles.nth(handleIndex)).toBeVisible();
        }
      }
      await expect(generationNode).toContainText('Image Generation');
      await expect(generationNode.getByRole('alert')).toContainText('模型不可用');
      await expect(reverseNode).toContainText('Gemini 3.1 Pro');
      // UI Gate media slots are populated only from a real graph edge, rather
      // than from stale node configuration retained by the test harness.
      await expect(reverseNode.locator('.module-node__agent-media-slots')).toHaveCount(0);
      const before = await canvas.boundingBox();
      await expect(page.getByTestId('agent-panel')).toBeHidden();
      await openAgentPanel(page);
      const after = await canvas.boundingBox();
      expect(after!.width).toBeCloseTo(before!.width, 0);
      await expect(library).toBeHidden();
      // The former job strip belongs to the retired workbench shell.  The UI Gate
      // keeps the Agent panel as the only auxiliary surface, so do not require a
      // hidden legacy region merely to make this layout audit pass.
      await assertLocatorInside(page.locator('body'), page.getByTestId('agent-panel'), `agent panel ${viewport.name} ${theme}`);
      await page.getByTestId('agent-panel').getByRole('button', { name: '关闭 Codex Agent' }).click();
      await expect(page.getByTestId('agent-panel')).toBeHidden();
      await openAgentPanel(page);

      await captureLayoutScreenshot(page, testInfo, `formal-module-workbench-${viewport.name}-${theme}`);
    });
  }
}
