import { test, expect } from './helpers/e2e-test';
import {
  assertNoTrackedRegionsOverlap,
  captureLayoutScreenshot,
  e2eState,
  finishInteractionStallObserver,
  measureInteractionStalls,
  openAgentPanel,
  openApp,
  startInteractionStallObserver,
} from './helpers/app';

const viewports = [
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
];

for (const theme of ['light', 'dark'] as const) {
  for (const viewport of viewports) {
    test(`durable 300/500 canvas stays responsive at ${viewport.name} ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await openApp(page);
      await page.getByLabel('主题 Theme').selectOption(theme);
      await page.getByTestId('tool-modules').click();

      expect(await page.evaluate(() => window.__NOVUS_E2E__!.seedModuleStressGraph(300, 500))).toBe(true);
      await expect(page.getByTestId('canvas-stage')).toHaveAttribute('data-graph-node-count', '300');
      await expect(page.getByTestId('canvas-stage')).toHaveAttribute('data-graph-edge-count', '500');
      const graph = await e2eState(page);
      expect(graph.nodeCount).toBe(300);
      expect(graph.edgeCount).toBe(500);
      expect(graph.projectImages).toHaveLength(80);

      await expect(page.getByTestId('agent-panel')).toBeHidden();
      await openAgentPanel(page);
      await assertNoTrackedRegionsOverlap(page, ['module-library', 'agent-panel', 'job-strip']);
      await expect(page.getByTestId('module-library')).toBeVisible();
      await expect(page.getByTestId('agent-panel')).toBeVisible();
      await expect(page.locator('.react-flow__node')).not.toHaveCount(0);
      await expect(page.locator('.module-node__port-label').first()).toBeVisible();
      expect((await page.locator('.module-node__port-label').first().innerText()).trim().length).toBeGreaterThan(0);
      await expect(page.getByText('IMG', { exact: true })).toHaveCount(0);

      await startInteractionStallObserver(page);
      let commitCount = graph.commitCount;
      const node = page.locator('.react-flow__node[data-id="stress-image_input-1"]');
      await expect(node).toBeVisible();
      await measureInteractionStalls(page, 'selection', async () => {
        await node.click({ position: { x: 80, y: 24 } });
      });
      expect((await e2eState(page)).commitCount).toBe(commitCount);

      await measureInteractionStalls(page, 'drag-drop', async () => {
        const box = await node.boundingBox();
        expect(box).not.toBeNull();
        await page.mouse.move(box!.x + 80, box!.y + 24);
        await page.mouse.down();
        await page.mouse.move(box!.x + 124, box!.y + 58, { steps: 6 });
        expect((await e2eState(page)).commitCount).toBe(commitCount);
        await page.mouse.up();
      });
      await page.waitForFunction((previous) => window.__NOVUS_E2E__!.commitCount === previous + 1, commitCount);
      commitCount += 1;

      const pane = page.locator('.react-flow__pane');
      await page.getByTestId('tool-hand').click();
      await measureInteractionStalls(page, 'pan', async () => {
        const box = await pane.boundingBox();
        expect(box).not.toBeNull();
        await page.mouse.move(box!.x + box!.width * 0.55, box!.y + box!.height * 0.55);
        await page.mouse.down();
        await page.mouse.move(box!.x + box!.width * 0.62, box!.y + box!.height * 0.61, { steps: 6 });
        await page.mouse.up();
      });
      expect((await e2eState(page)).commitCount).toBe(commitCount);

      await measureInteractionStalls(page, 'zoom', async () => {
        await page.mouse.wheel(0, -180);
        await page.mouse.wheel(0, 120);
      });
      expect((await e2eState(page)).commitCount).toBe(commitCount);

      await page.getByTestId('tool-select').click();
      await measureInteractionStalls(page, 'connection-preview', async () => {
        const handle = node.locator('.react-flow__handle.source').first();
        const handleBox = await handle.boundingBox();
        const paneBox = await pane.boundingBox();
        expect(handleBox).not.toBeNull();
        expect(paneBox).not.toBeNull();
        await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
        await page.mouse.down();
        await page.mouse.move(paneBox!.x + paneBox!.width * 0.5, paneBox!.y + paneBox!.height * 0.35, { steps: 5 });
        await expect(page.locator('.react-flow__connection')).toHaveCount(1);
        expect((await e2eState(page)).commitCount).toBe(commitCount);
        await page.keyboard.press('Escape');
        await page.mouse.up();
      });
      await expect(page.locator('.react-flow__connection')).toHaveCount(0);
      expect((await e2eState(page)).commitCount).toBe(commitCount);

      await measureInteractionStalls(page, 'reference-reorder', async () => {
        const source = page.locator('[data-testid="reference-order-item"][data-asset-id="0000000000000002"]');
        const target = page.locator('[data-testid="reference-order-item"][data-asset-id="0000000000000001"]');
        await source.dispatchEvent('dragstart');
        await target.dispatchEvent('dragover');
        await expect(source).toHaveAttribute('data-position', '0');
        await expect(target).toHaveAttribute('data-position', '1');
        expect((await e2eState(page)).commitCount).toBe(commitCount);
        await target.dispatchEvent('drop');
      });
      await page.waitForFunction((previous) => window.__NOVUS_E2E__!.commitCount === previous + 1, commitCount);

      const evidence = await finishInteractionStallObserver(page, {
        edgeCount: 500,
        nodeCount: 300,
        theme,
        viewport: viewport.name,
      });
      expect(evidence).toHaveLength(6);
      for (const sample of evidence) {
        expect(sample.measurementSupported, `${sample.operation} observer support`).toBe(true);
        expect(sample.observerTypes.length, `${sample.operation} observer types`).toBeGreaterThan(0);
        expect(sample.sampleCount, `${sample.operation} sample count`).toBeGreaterThanOrEqual(0);
        expect(sample.zeroSample, `${sample.operation} zero-sample identity`).toBe(sample.sampleCount === 0);
        expect(sample.maxStallMs, `${sample.operation} max stall`).toBeLessThan(250);
      }
      await testInfo.attach(`stress-evidence-${viewport.name}-${theme}.json`, {
        body: JSON.stringify(evidence, null, 2),
        contentType: 'application/json',
      });
      console.log(`STRESS_EVIDENCE ${JSON.stringify(evidence)}`);
      await captureLayoutScreenshot(page, testInfo, `durable-canvas-stress-${viewport.name}-${theme}`);
    });
  }
}
