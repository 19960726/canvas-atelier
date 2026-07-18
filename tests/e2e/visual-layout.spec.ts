import { test, expect } from './helpers/e2e-test';
import type { Locator } from '@playwright/test';
import {
  assertLocatorInside,
  assertNoTrackedRegionsOverlap,
  captureLayoutScreenshot,
  e2eState,
  expectVisibleMainRegion,
  medianPanZoomFrameInterval,
  openApp,
} from './helpers/app';

interface FocusStyleSnapshot {
  borderColor: string;
  boxShadow: string;
  outlineStyle: string;
  outlineWidth: number;
}

const viewports = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '1366x768', width: 1366, height: 768 },
];

for (const viewport of viewports) {
  test(`desktop layout has no overlaps and records pan/zoom frame marks at ${viewport.name}`, async ({ page }, testInfo) => {
    testInfo.annotations.push({
      type: 'runtime-profile-target',
      description: 'Renderer CI threshold only; physical Windows 7/10/11 FPS remains pending manual evidence.',
    });
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openApp(page);

    await assertNoTrackedRegionsOverlap(page, [
      'topbar',
      'toolrail',
      'agent-panel',
      'job-strip',
      'canvas-stage',
    ]);
    await expectVisibleMainRegion(page);
    const visibleNode = page.locator('[data-testid="canvas-node-card"]').first();
    await expect(visibleNode).toBeVisible();
    await expect(visibleNode).toHaveAttribute('data-node-kind', /.+/);
    await expect(visibleNode.locator('.canvas-node__footer')).toBeVisible();
    await assertLocatorInside(visibleNode, visibleNode.locator('.canvas-node__title'), `node title at ${viewport.name}`);
    await assertLocatorInside(visibleNode, visibleNode.locator('.canvas-node__footer'), `node footer at ${viewport.name}`);
    const focusableFlowNode = page.locator('.react-flow__node:not(.selected)', {
      has: page.locator('[data-testid="canvas-node-card"]'),
    }).first();
    await expect(focusableFlowNode).toBeVisible();
    await expectCanvasNodeFocusRing(focusableFlowNode, `canvas node focus at ${viewport.name}`);

    const knowledge = page.locator('[data-knowledge-status]').first();
    await expect(knowledge).toBeVisible();
    await expect(knowledge.getByTestId('knowledge-status-detail')).toBeVisible();

    await page.getByRole('button', { name: 'Modules' }).click();
    await assertNoTrackedRegionsOverlap(page, [
      'module-library',
      'agent-panel',
      'job-strip',
    ]);
    await page.evaluate(() => window.__NOVUS_E2E__?.createModule('image_generation_v2', { x: 440, y: 120 }));
    await expect(page.locator('[data-module-type="image_generation_v2"]')).toHaveCSS('width', '264px');

    await page.evaluate(() => window.__NOVUS_E2E__?.seedModuleStressGraph(100, 150));
    const stressState = await e2eState(page);
    expect(stressState.moduleTypes.filter((type) => type === 'image_input')).toHaveLength(50);
    expect(stressState.moduleTypes.filter((type) => type === 'reverse_agent')).toHaveLength(50);
    expect(stressState.edgeCount).toBeGreaterThanOrEqual(150);
    await expectVisibleMainRegion(page);
    expect(await page.locator('[data-module-type="image_input"], [data-module-type="reverse_agent"]').count())
      .toBeGreaterThan(1);
    expect(await page.locator('.react-flow__edge').count()).toBeGreaterThan(0);
    const moduleBox = await page.locator('[data-module-type="image_input"]').first().boundingBox();
    expect(moduleBox, `stress module geometry at ${viewport.name}`).not.toBeNull();
    expect(moduleBox!.width, `stress module width at ${viewport.name}`).toBeGreaterThan(200);
    const panZoomMetrics = await medianPanZoomFrameInterval(page);
    await captureLayoutScreenshot(page, testInfo, `renderer-module-stress-${viewport.name}`);

    await page.getByTestId('tool-placement').click();
    await assertNoTrackedRegionsOverlap(page, [
      'topbar',
      'toolrail',
      'agent-panel',
      'job-strip',
      'placement-workbench',
    ]);
    const placementWorkbench = page.getByTestId('placement-workbench');
    await expect(placementWorkbench).toBeVisible();
    await assertLocatorInside(
      placementWorkbench,
      page.getByTestId('placement-inspector'),
      `placement inspector at ${viewport.name}`,
    );
    const productUploadButton = page.getByTestId('upload-product');
    await expectPlacementUploadFocusRing(productUploadButton, productUploadButton, `placement upload focus at ${viewport.name}`);
    await captureLayoutScreenshot(page, testInfo, `renderer-layout-${viewport.name}`);

    await testInfo.attach(`pan-zoom-median-${viewport.name}.txt`, {
      body: `medianFrameMs=${panZoomMetrics.medianFrameMs.toFixed(2)}\nmarkCount=${panZoomMetrics.markCount}\nruntimeProfileTarget=renderer-local-ci\n`,
      contentType: 'text/plain',
    });
    expect(panZoomMetrics.medianFrameMs).toBeGreaterThanOrEqual(0);
    expect(panZoomMetrics.medianFrameMs).toBeLessThan(150);
    expect(panZoomMetrics.markCount).toBeGreaterThanOrEqual(4);
  });
}

async function expectCanvasNodeFocusRing(flowNode: Locator, label: string): Promise<void> {
  const card = flowNode.locator('[data-testid="canvas-node-card"]');
  const before = await focusStyleSnapshot(card);
  await flowNode.focus();
  await expect(flowNode, `${label} active element`).toBeFocused();
  const after = await focusStyleSnapshot(card);
  expect(hasVisibleFocusTreatment(before, after), label).toBe(true);
}

async function expectPlacementUploadFocusRing(input: Locator, label: Locator, message: string): Promise<void> {
  const before = await focusStyleSnapshot(label);
  await input.focus();
  await expect(input, `${message} active element`).toBeFocused();
  const after = await focusStyleSnapshot(label);
  expect(hasVisibleFocusTreatment(before, after), message).toBe(true);
}

async function focusStyleSnapshot(locator: Locator): Promise<FocusStyleSnapshot> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      borderColor: style.borderColor,
      boxShadow: style.boxShadow,
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth) || 0,
    };
  });
}

function hasVisibleFocusTreatment(before: FocusStyleSnapshot, after: FocusStyleSnapshot): boolean {
  const hasOutline = after.outlineStyle !== 'none' && after.outlineWidth >= 2;
  return hasOutline && (
    after.borderColor !== before.borderColor
    || after.boxShadow !== before.boxShadow
    || after.outlineWidth !== before.outlineWidth
  );
}
