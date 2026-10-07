import type { Locator, Page } from '@playwright/test';
import { expect, test } from './helpers/e2e-test';
import { e2eState, openEmptyApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';
import type { CanvasModuleType } from '@agent-canvas/domain';

async function actualZoom(page: Page) {
  return page.locator('.react-flow__viewport').evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).a);
}

async function socketPoint(socket: Locator, outer = false) {
  const box = (await socket.boundingBox())!;
  const direction = await socket.getAttribute('data-port-direction');
  return { x: box.x + box.width * (outer ? direction === 'input' ? 0.2 : 0.8 : 0.5), y: box.y + box.height / 2 };
}

async function dragSocket(page: Page, source: Locator, target: Locator, outer = false) {
  const start = await socketPoint(source, outer), end = await socketPoint(target, outer);
  const hits = await page.evaluate(({ start, end }) => [start, end].map(point => document.elementFromPoint(point.x, point.y)?.classList.contains('react-flow__handle') ?? false), { start, end });
  expect(hits, 'The visible socket outer half is a real connection hit target').toEqual([true, true]);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 18 });
  await page.mouse.up();
}

for (const theme of ['dark', 'light'] as const) {
  test(`wheel overview retains media and allows locked/unselected connections in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1680, height: 1100 });
    await page.addInitScript(mode => localStorage.setItem('novus.theme.mode', mode), theme);
    await openEmptyApp(page);
    await page.evaluate(async () => {
      await window.__NOVUS_E2E__!.createModule('image_input', { x: 160, y: 140 });
      await window.__NOVUS_E2E__!.createModule('image_input', { x: 160, y: 550 });
      await window.__NOVUS_E2E__!.createModule('image_generation', { x: 650, y: 170 });
    });
    const sources = page.locator('[data-module-type="image_input"]');
    for (let index = 0; index < 2; index++) {
      await queueProjectImageImport(page, makeReferenceImage(`overview-${index}.png`, [60 + index * 100, 130, 80, 255], { width: 480, height: 600 }), { preservePixels: true });
      await sources.nth(index).getByRole('button', { name: /Import image/u }).click();
      await expect(sources.nth(index).locator('img')).toBeVisible();
    }
    const firstSourceId = await sources.first().locator('xpath=..').getAttribute('data-id');
    const generation = page.locator('[data-module-type="image_generation"]');
    const generationId = await generation.locator('xpath=..').getAttribute('data-id');
    await generation.getByRole('button', { name: '锁定位置 / Lock position', exact: true }).click();
    await expect(generation.getByRole('button', { name: '解锁位置 / Unlock position', exact: true })).toBeVisible();
    await page.mouse.click(1500, 900);
    const initial = await sources.first().boundingBox();
    const targetInitial = await generation.boundingBox();
    const initialZoom = await actualZoom(page);
    const sourceBefore = (await e2eState(page)).modulePositions.find(node => node.id === firstSourceId);
    const targetBefore = (await e2eState(page)).modulePositions.find(node => node.id === generationId);
    await page.mouse.move(900, 750);
    await page.mouse.wheel(0, 780);
    await expect.poll(() => actualZoom(page)).toBeLessThan(0.45);
    for (const source of [sources.first(), sources.last()]) {
      await expect(source).toHaveAttribute('data-render-detail', 'overview');
      await expect(source.locator('img'), 'Zooming out keeps the actual image').toBeVisible();
      expect(await source.locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 480)).toBe(true);
    }
    const zoom = await actualZoom(page), compact = (await sources.first().boundingBox())!;
    expect(compact.width / zoom).toBeCloseTo(initial!.width / initialZoom, 0);
    expect(compact.height / zoom).toBeCloseTo(initial!.height / initialZoom, 0);
    const targetCompact = (await generation.boundingBox())!;
    expect(targetCompact.width / zoom).toBeCloseTo(targetInitial!.width / initialZoom, 0);
    expect(targetCompact.height / zoom).toBeCloseTo(targetInitial!.height / initialZoom, 0);
    await page.screenshot({ path: testInfo.outputPath(`overview-media-${theme}.png`) });
    await dragSocket(page, sources.first().locator('.react-flow__handle[data-port-id="image"]'), generation.locator('.react-flow__handle[data-port-id="references"]'), true);
    await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(1);
    await dragSocket(page, sources.last().locator('.react-flow__handle[data-port-id="image"]'), generation.locator('.react-flow__handle[data-port-id="references"]'), true);
    await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(2);
    expect((await e2eState(page)).modulePositions.find(node => node.id === firstSourceId)).toEqual(sourceBefore);
    expect((await e2eState(page)).modulePositions.find(node => node.id === generationId)).toEqual(targetBefore);
    await page.mouse.move(900, 750);
    await page.mouse.wheel(0, -780);
    await expect.poll(() => actualZoom(page)).toBeGreaterThan(0.6);
    await expect(sources.first()).toHaveAttribute('data-render-detail', 'full');
    await expect(page.locator('.react-flow__edge-path')).toHaveCount(2);
    await page.evaluate(() => window.__NOVUS_E2E__!.reopenProject());
    await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(2);
    expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
    expect((await e2eState(page)).reverseAnalysisRequests).toHaveLength(0);
  });

  test(`visible sockets resolve prompt and timeline ports in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 2000, height: 1400 });
    await page.addInitScript(mode => localStorage.setItem('novus.theme.mode', mode), theme);
    await openEmptyApp(page);
    const connectPrompt = async (moduleType: CanvasModuleType, mainInput: string, reverseDrag: boolean) => {
      await page.evaluate(async moduleType => {
        await window.__NOVUS_E2E__!.createModule('text_prompt', { x: 100, y: 120 });
        await window.__NOVUS_E2E__!.createModule(moduleType, { x: 700, y: 120 });
      }, moduleType);
      const source = page.locator('[data-module-type="text_prompt"]');
      const target = page.locator(`[data-module-type="${moduleType}"]`);
      await page.mouse.click(1850, 1200);
      await page.mouse.move(900, 900);
      await page.mouse.wheel(0, 780);
      await expect.poll(() => actualZoom(page)).toBeLessThan(0.45);
      await expect(target).toHaveAttribute('data-render-detail', 'overview');
      const output = source.locator('.react-flow__handle[data-port-id="prompt"]');
      const input = target.locator(`.react-flow__handle[data-port-id="${mainInput}"]`);
      await dragSocket(page, reverseDrag ? input : output, reverseDrag ? output : input, true);
      await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(1);
      const response = await page.evaluate(() => (window.__NOVUS_E2E__ as unknown as {
        invokeMcp(request: { tool: 'canvas_read_workflow' }): Promise<{ ok: boolean; result: { edges: Array<{ sourcePortId: string; targetPortId: string }> } }>;
      }).invokeMcp({ tool: 'canvas_read_workflow' }));
      expect(response.ok).toBe(true);
      expect(response.result.edges).toEqual([expect.objectContaining({ sourcePortId: 'prompt', targetPortId: moduleType === 'reverse_agent' ? 'task' : 'prompt' })]);
      await page.screenshot({ path: testInfo.outputPath(`visible-${moduleType}-${theme}.png`) });
      expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
      expect((await e2eState(page)).reverseAnalysisRequests).toHaveLength(0);
    };
    await connectPrompt('image_generation', 'references', false);
    await page.reload();
    await openEmptyApp(page);
    await connectPrompt('video_generation', 'media', true);
    await page.reload();
    await openEmptyApp(page);
    await connectPrompt('reverse_agent', 'references', false);
    await page.evaluate(() => window.__NOVUS_E2E__!.createModule('storyboard_sheet', { x: 1350, y: 120 }));
    await page.mouse.click(1850, 1200);
    const reverse = page.locator('[data-module-type="reverse_agent"]');
    const storyboard = page.locator('[data-module-type="storyboard_sheet"]');
    await dragSocket(page, reverse.locator('.react-flow__handle[data-port-id="analysis"]'), storyboard.locator('.react-flow__handle[data-port-id="timeline"]'), true);
    await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(2);
    const timeline = await page.evaluate(() => (window.__NOVUS_E2E__ as unknown as {
      invokeMcp(request: { tool: 'canvas_read_workflow' }): Promise<{ ok: boolean; result: { edges: Array<{ sourcePortId: string; targetPortId: string }> } }>;
    }).invokeMcp({ tool: 'canvas_read_workflow' }));
    expect(timeline.ok).toBe(true);
    expect(timeline.result.edges).toEqual(expect.arrayContaining([expect.objectContaining({ sourcePortId: 'timeline', targetPortId: 'timeline' })]));
    await page.screenshot({ path: testInfo.outputPath(`visible-timeline-${theme}.png`) });
    expect((await e2eState(page)).reverseAnalysisRequests).toHaveLength(0);
  });
}
