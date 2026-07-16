import { test, expect } from './helpers/e2e-test';
import {
  assertNoTrackedRegionsOverlap,
  captureLayoutScreenshot,
  expectVisibleMainRegion,
  medianPanZoomFrameInterval,
  openApp,
} from './helpers/app';

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
    const medianFrameMs = await medianPanZoomFrameInterval(page);

    await page.getByTestId('tool-placement').click();
    await assertNoTrackedRegionsOverlap(page, [
      'topbar',
      'toolrail',
      'agent-panel',
      'job-strip',
      'placement-workbench',
    ]);
    await expect(page.getByTestId('placement-workbench')).toBeVisible();
    await captureLayoutScreenshot(page, testInfo, `renderer-layout-${viewport.name}`);

    await testInfo.attach(`pan-zoom-median-${viewport.name}.txt`, {
      body: `medianFrameMs=${medianFrameMs.toFixed(2)}\nruntimeProfileTarget=renderer-local-ci\n`,
      contentType: 'text/plain',
    });
    expect(medianFrameMs).toBeGreaterThanOrEqual(0);
    expect(medianFrameMs).toBeLessThan(150);
  });
}
