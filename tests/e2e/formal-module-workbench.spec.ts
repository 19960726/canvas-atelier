import { test, expect } from './helpers/e2e-test';
import {
  assertLocatorInside,
  assertNoTrackedRegionsOverlap,
  captureLayoutScreenshot,
  openEmptyApp,
} from './helpers/app';

const viewports = [
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
];

for (const theme of ['light', 'dark'] as const) {
  for (const viewport of viewports) {
    test(`unified module workbench is contained at ${viewport.name} ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await openEmptyApp(page);
      await page.getByLabel('主题 Theme').selectOption(theme);
      await page.evaluate(async () => {
        const harness = window.__NOVUS_E2E__;
        await harness?.createModule('text_prompt', { x: 0, y: 0 });
        await harness?.createModule('image_input', { x: 0, y: 360 });
        await harness?.createModule('image_generation', { x: 320, y: 0 });
        await harness?.createModule('reverse_agent', { x: 320, y: 360 });
        await harness?.createModule('result_output', { x: 640, y: 0 });
        await harness?.createModule('storyboard_sheet', { x: 640, y: 360 });
        await harness?.connectModules('text_prompt', 'prompt', 'image_generation', 'prompt');
        await harness?.connectModules('text_prompt', 'prompt', 'reverse_agent', 'task');
        await harness?.connectModules('image_input', 'image', 'image_generation', 'references');
        await harness?.connectModules('image_input', 'image', 'reverse_agent', 'references');
        await harness?.connectModules('image_generation', 'result', 'result_output', 'result');
        await harness?.connectModules('reverse_agent', 'analysis', 'storyboard_sheet', 'analysis');
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

      await page.locator('.react-flow__controls-fitview').click();
      await page.locator('.react-flow__controls-zoomout').click();
      await page.locator('.react-flow__controls-zoomout').click();
      const pane = page.locator('.react-flow__pane');
      const paneBox = await pane.boundingBox();
      expect(paneBox).not.toBeNull();
      await page.mouse.move(paneBox!.x + paneBox!.width / 2, paneBox!.y + paneBox!.height / 2);
      await page.mouse.down();
      await page.mouse.move(paneBox!.x + paneBox!.width / 2 + 165, paneBox!.y + paneBox!.height / 2, { steps: 8 });
      await page.mouse.up();
      await page.getByTestId('tool-modules').click();

      const library = page.getByTestId('module-library');
      const canvas = page.getByTestId('canvas-stage');
      const representativeTypes = [
        'text_prompt',
        'image_input',
        'image_generation',
        'reverse_agent',
        'result_output',
        'storyboard_sheet',
      ];
      for (const moduleType of representativeTypes) {
        const node = page.locator(`[data-module-type="${moduleType}"]`);
        await expect(node).toHaveCount(1);
        await assertLocatorInside(canvas, node, `${moduleType} node ${viewport.name} ${theme}`);
      }
      await expect(page.locator('.react-flow__edge')).toHaveCount(6);
      await expect(page.locator('[data-module-type="image_generation_v1"], [data-module-type="image_generation_v2"], [data-module-type="video_analysis"]')).toHaveCount(0);
      await assertLocatorInside(canvas, library, `module library ${viewport.name} ${theme}`);
      const generationNode = page.locator('[data-module-type="image_generation"]');
      const reverseNode = page.locator('[data-module-type="reverse_agent"]');
      await assertLocatorInside(generationNode, generationNode.locator('.module-node__port-row[data-port-id="prompt"][data-port-direction="input"]'), `generation prompt port ${viewport.name} ${theme}`);
      await assertLocatorInside(generationNode, generationNode.locator('.module-node__port-row[data-port-id="result"][data-port-direction="output"]'), `generation result port ${viewport.name} ${theme}`);
      await assertLocatorInside(reverseNode, reverseNode.locator('.module-node__port-row[data-port-id="references"][data-port-direction="input"]'), `reverse reference port ${viewport.name} ${theme}`);
      await assertLocatorInside(reverseNode, reverseNode.locator('.module-node__port-row[data-port-id="analysis"][data-port-direction="output"]'), `reverse analysis port ${viewport.name} ${theme}`);
      await expect(generationNode).toContainText('Compatible Image Route');
      await expect(generationNode).toContainText('结果已过期 / Stale result');
      await expect(generationNode.getByRole('alert')).toContainText('模型不可用');
      await expect(reverseNode).toContainText('Vision Composite');
      await expect(reverseNode).toContainText('结果为最新 / Fresh result');
      await expect(reverseNode).toContainText('00:01.500–00:06.250');
      await assertNoTrackedRegionsOverlap(page, ['module-library', 'agent-panel', 'job-strip']);

      const before = await canvas.boundingBox();
      await page.getByTestId('agent-panel').getByRole('button', { name: '折叠 Agent 面板' }).click();
      const after = await canvas.boundingBox();
      expect(after!.width).toBeGreaterThan(before!.width + 300);
      await page.getByTestId('toolrail').getByRole('button', { name: '展开 Agent 面板' }).click();

      await captureLayoutScreenshot(page, testInfo, `formal-module-workbench-${viewport.name}-${theme}`);
    });
  }
}
