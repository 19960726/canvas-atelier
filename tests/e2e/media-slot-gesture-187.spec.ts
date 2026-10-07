import { createHash } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './helpers/e2e-test';
import { e2eState, openEmptyApp } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

async function readGraph(page: Page, targetId: string) {
  return page.evaluate(async nodeId => {
    const modulePath = '/src/app/app-store.ts';
    const { useAppStore } = await import(modulePath) as typeof import('../../apps/renderer/src/app/app-store');
    const state = useAppStore.getState();
    const edges = state.project.edges.filter(edge => edge.target === nodeId && edge.targetPortId === 'references')
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
    const references = await Promise.all(edges.map(async edge => {
      const source = state.project.nodes.find(node => node.id === edge.source);
      if (source?.type !== 'module' || typeof source.data.config.assetId !== 'string') throw new Error('Reference source has no selected image');
      const assetId = source.data.config.assetId;
      const owned = state.project.assets?.find(asset => asset.assetId === assetId);
      const image = state.projectImages.find(asset => asset.assetId === assetId);
      if (!owned || !image) throw new Error('Reference image is not owned by the project');
      if (!image.displayUrl.startsWith('data:image/png;base64,')) throw new Error('Reference is not the imported PNG');
      const decoded = atob(image.displayUrl.slice(image.displayUrl.indexOf(',') + 1));
      const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const pngSha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      return { edgeId: edge.id, sourceId: source.id, order: edge.order ?? 0, assetId,
        sha256: owned.sha256, pngSha256, label: image.label, width: image.width, height: image.height, displayUrl: image.displayUrl };
    }));
    return { edges, references, assets: state.project.assets,
      positions: state.project.nodes.map(node => ({ id: node.id, position: node.position })) };
  }, targetId);
}

async function expectSlots(tray: Locator, references: Awaited<ReturnType<typeof readGraph>>['references']) {
  await expect(tray.locator('[data-slot-index]')).toHaveCount(references.length);
  await expect.poll(() => tray.locator('[data-slot-index]').evaluateAll(elements => elements.map(element => {
    const image = element.querySelector('img')!;
    const box = element.getBoundingClientRect();
    return { label: image.alt, src: image.getAttribute('src'), complete: image.complete,
      width: image.naturalWidth, height: image.naturalHeight, frameWidth: box.width, frameHeight: box.height,
      fit: getComputedStyle(image).objectFit };
  }))).toEqual(references.map(reference => ({ label: reference.label, src: reference.displayUrl, complete: true,
    width: reference.width, height: reference.height, frameWidth: 54, frameHeight: 54, fit: 'contain' })));
}

async function disconnectThroughEdgeControl(page: Page, edgeId: string) {
  const path = page.locator(`[data-testid="rf__edge-${edgeId}"] path[stroke="transparent"]`);
  await expect(path).toBeVisible();
  const hitPoint = await path.evaluate((element: SVGPathElement) => {
    const transform = element.getScreenCTM()!;
    const length = element.getTotalLength();
    for (const fraction of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
      const point = element.getPointAtLength(length * fraction);
      const screen = new DOMPoint(point.x, point.y).matrixTransform(transform);
      const hit = document.elementFromPoint(screen.x, screen.y);
      if (hit?.closest('.react-flow__edge') === element.closest('.react-flow__edge')) return { x: screen.x, y: screen.y };
    }
    return null;
  });
  expect(hitPoint, 'The owned reference edge has an uncovered disconnect target').not.toBeNull();
  await page.mouse.move(hitPoint!.x, hitPoint!.y);
  await page.getByRole('button', { name: '断开连接', exact: true }).click();
}

async function settleWheel(row: Locator) {
  await row.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

for (const theme of ['light', 'dark'] as const) {
  test(`owned media gestures retain pointer identity, local wheel intent and reconnect state in ${theme}`, async ({ page }, testInfo) => {
    test.setTimeout(120000);
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.addInitScript(() => {
      const errors: string[] = [];
      (window as unknown as { mediaSlotGestureErrors: string[] }).mediaSlotGestureErrors = errors;
      window.addEventListener('error', event => errors.push(event.message));
    });
    await page.setViewportSize({ width: 2400, height: 1800 });
    await page.addInitScript(theme => localStorage.setItem('novus.theme.mode', theme), theme);
    await openEmptyApp(page, '/?novusHarness=novus-e2e-codex-canvas-layout');
    await page.evaluate(() => window.__NOVUS_E2E__!.createModule('reverse_agent', { x: 1500, y: 350 }));
    const target = page.locator('[data-module-type="reverse_agent"]');
    const port = target.locator('.react-flow__handle[data-port-id="references"]');
    const fixtures = Array.from({ length: 8 }, (_, index) => makeReferenceImage(`Gesture ${index + 1}.png`,
      [45 + index * 20, 150 - index * 10, 70 + index * 15, 255], index % 2 === 0
        ? { width: 48, height: 72 } : { width: 80, height: 45 }));
    const pngHashes = fixtures.map(fixture => createHash('sha256').update(fixture.buffer).digest('hex'));
    for (const [index, fixture] of fixtures.entries()) {
      await page.evaluate(point => window.__NOVUS_E2E__!.createModule('image_input', point),
        { x: 70 + index % 3 * 340, y: 100 + Math.floor(index / 3) * 550 });
      const source = page.locator('[data-module-type="image_input"]').last();
      const picker = page.waitForEvent('filechooser');
      await source.getByRole('button', { name: /Import image/u }).click();
      await (await picker).setFiles({ name: fixture.name, mimeType: fixture.mimeType, buffer: fixture.buffer });
      await expect(source.locator('img')).toBeVisible();
      await source.locator('.react-flow__handle[data-port-id="image"]').dragTo(port);
      await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(index + 1);
    }
    await expect.poll(async () => (await e2eState(page)).saveStatus).toBe('saved');
    const targetId = (await target.locator('xpath=..').getAttribute('data-id'))!;
    const original = await readGraph(page, targetId);
    expect(original.references.map(reference => reference.pngSha256)).toEqual(pngHashes);
    const tray = target.getByLabel('Connected reverse media slots', { exact: true });
    const row = tray.locator('.connected-agent-media-slots__row');
    await expect(tray).toHaveAttribute('data-thumbnail-sizing', 'uniform');
    await expect(row).toHaveClass(/nowheel/u);
    await expectSlots(tray, original.references);
    const initialZoom = await page.locator('.react-flow__viewport').evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).a);
    expect(initialZoom).toBe(1);
    expect(await row.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    await row.evaluate(element => {
      element.scrollLeft = 0;
      element.addEventListener('wheel', event => {
        const wheel = event as WheelEvent;
        (element as HTMLElement).dataset.lastSlotWheel = JSON.stringify({ ctrlKey: wheel.ctrlKey, metaKey: wheel.metaKey,
          defaultPrevented: wheel.defaultPrevented, deltaX: wheel.deltaX, deltaY: wheel.deltaY });
      });
    });
    for (const modifier of ['Control', 'Meta'] as const) {
      await row.hover();
      await page.keyboard.down(modifier);
      await page.mouse.wheel(0, 96);
      await page.keyboard.up(modifier);
      await settleWheel(row);
      expect(await row.evaluate(element => element.scrollLeft)).toBe(0);
      expect(await row.evaluate(element => JSON.parse((element as HTMLElement).dataset.lastSlotWheel!)))
        .toMatchObject({ ctrlKey: modifier === 'Control', metaKey: modifier === 'Meta', defaultPrevented: true });
      expect(await page.locator('.react-flow__viewport').evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).a)).toBe(initialZoom);
    }
    await row.hover();
    await page.mouse.wheel(0, 120);
    await expect.poll(() => row.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    await row.evaluate(element => { element.scrollLeft = 0; });
    await page.mouse.wheel(120, 0);
    await expect.poll(() => row.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    expect(await row.evaluate(element => JSON.parse((element as HTMLElement).dataset.lastSlotWheel!)))
      .toMatchObject({ defaultPrevented: false, deltaX: 120, deltaY: 0 });
    await row.evaluate(element => { element.scrollLeft = 0; });
    const slot = (index: number) => tray.getByLabel(`Agent media slot ${index}`, { exact: true });
    const pointer = (pointerId: number) => ({ pointerId, pointerType: 'touch', button: 0, buttons: 1 });
    await slot(2).dispatchEvent('pointerdown', pointer(71));
    await slot(3).dispatchEvent('pointerdown', pointer(72));
    await slot(1).dispatchEvent('pointerover', pointer(72));
    await expect(slot(1)).not.toHaveClass(/is-drop-target/u);
    await slot(1).dispatchEvent('pointerup', { ...pointer(72), buttons: 0 });
    expect(await readGraph(page, targetId)).toEqual(original);
    await slot(1).dispatchEvent('pointerover', pointer(71));
    await expect(slot(1)).toHaveClass(/is-drop-target/u);
    await slot(1).dispatchEvent('pointercancel', pointer(72));
    await expect(slot(1)).toHaveClass(/is-drop-target/u);
    expect(await readGraph(page, targetId)).toEqual(original);
    await slot(1).dispatchEvent('pointerup', { ...pointer(71), buttons: 0 });
    const expectedOrder = [original.references[1]!, original.references[0]!, ...original.references.slice(2)];
    await expect.poll(async () => (await readGraph(page, targetId)).references.map(reference => reference.assetId))
      .toEqual(expectedOrder.map(reference => reference.assetId));
    const reordered = await readGraph(page, targetId);
    expect(reordered.assets).toEqual(original.assets);
    expect(reordered.positions).toEqual(original.positions);
    await expectSlots(tray, reordered.references);
    const removed = reordered.references[1]!;
    await disconnectThroughEdgeControl(page, removed.edgeId);
    await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(7);
    const disconnected = await readGraph(page, targetId);
    expect(disconnected.references.map(reference => reference.assetId)).toEqual(reordered.references
      .filter(reference => reference.edgeId !== removed.edgeId).map(reference => reference.assetId));
    await expectSlots(tray, disconnected.references);
    const source = page.locator(`.react-flow__node[data-id="${removed.sourceId}"]`);
    await source.locator('.react-flow__handle[data-port-id="image"]').dragTo(port);
    await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(8);
    const reconnected = await readGraph(page, targetId);
    expect(reconnected.references.map(reference => reference.assetId)).toEqual([...disconnected.references.map(reference => reference.assetId), removed.assetId]);
    expect(reconnected.assets).toEqual(original.assets);
    expect(reconnected.positions).toEqual(original.positions);
    expect(reconnected.references.find(reference => reference.assetId === removed.assetId)!.sha256).toBe(removed.sha256);
    await expectSlots(tray, reconnected.references);
    await page.getByRole('button', { name: '保存项目', exact: true }).click();
    await expect.poll(async () => (await e2eState(page)).saveStatus).toBe('saved');
    await page.evaluate(() => window.__NOVUS_E2E__!.reopenProject());
    await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(8);
    const reopened = await readGraph(page, targetId);
    expect(reopened).toEqual(reconnected);
    await expectSlots(tray, reopened.references);
    await tray.screenshot({ path: testInfo.outputPath(`media-slot-gesture-reopened-${theme}.png`) });
    const state = await e2eState(page);
    expect(state.modelSubmissions).toHaveLength(0);
    expect(state.reverseAnalysisRequests).toHaveLength(0);
    expect(pageErrors).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { mediaSlotGestureErrors: string[] }).mediaSlotGestureErrors)).toEqual([]);
    await testInfo.attach('media-slot-gesture-ownership', { contentType: 'application/json',
      body: JSON.stringify({ original, reordered, disconnected, reconnected, reopened, pngHashes }, null, 2) });
  });
}
