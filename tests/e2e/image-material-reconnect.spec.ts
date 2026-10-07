import type { Locator, Page } from '@playwright/test';
import { expect, test } from './helpers/e2e-test';
import { e2eState, openEmptyApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

async function dragPort(page: Page, source: Locator, target: Locator) {
  const start = (await source.boundingBox())!, end = (await target.boundingBox())!;
  const points = [{ x: start.x + start.width / 2, y: start.y + start.height / 2 }, { x: end.x + end.width / 2, y: end.y + end.height / 2 }];
  expect(await page.evaluate(points => points.map(point => document.elementFromPoint(point.x, point.y)?.classList.contains('react-flow__handle')), points)).toEqual([true, true]);
  await page.mouse.move(points[0]!.x, points[0]!.y);
  await page.mouse.down();
  await page.mouse.move(points[1]!.x, points[1]!.y, { steps: 18 });
  await page.mouse.up();
}

type MultiReference = { edgeId: string; sourceId: string; assetId: string; order: number; label: string;
  sha256: string; width: number; height: number; displayUrl: string };

async function readMultiGraph(page: Page, targetId: string, input: string) {
  return page.evaluate(async ({ targetId, input }) => {
    const modulePath = '/src/app/app-store.ts';
    const { useAppStore } = await import(modulePath) as typeof import('../../apps/renderer/src/app/app-store');
    const state = useAppStore.getState();
    const references = state.project.edges.filter(edge => edge.target === targetId && edge.targetPortId === input)
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0)).map(edge => {
        const source = state.project.nodes.find(node => node.id === edge.source)!;
        const assetId = source.type === 'module' ? String(source.data.config.assetId) : '';
        const asset = state.project.assets!.find(asset => asset.assetId === assetId)!;
        const summary = state.projectImages.find(asset => asset.assetId === assetId)!;
        return { edgeId: edge.id, sourceId: source.id, assetId, order: edge.order ?? 0, label: summary.label,
          sha256: asset.sha256, width: asset.width!, height: asset.height!, displayUrl: summary.displayUrl };
      });
    return { projectId: state.project.id, references, edges: state.project.edges,
      sources: state.project.nodes.filter(node => node.type === 'module' && node.data.moduleType === 'image_input')
        .map(node => ({ id: node.id, assetId: node.type === 'module' ? node.data.config.assetId : undefined })),
      assets: state.project.assets };
  }, { targetId, input });
}

async function disconnectEdge(page: Page, edgeId: string, remaining: number) {
  const path = page.locator(`[data-testid="rf__edge-${edgeId}"] path[stroke="transparent"]`);
  await expect(path).toBeVisible();
  const midpoint = await path.evaluate((element: SVGPathElement) => {
    const point = element.getPointAtLength(element.getTotalLength() / 2);
    return new DOMPoint(point.x, point.y).matrixTransform(element.getScreenCTM()!).toJSON();
  });
  await page.mouse.move(midpoint.x, midpoint.y);
  await page.getByRole('button', { name: '断开连接', exact: true }).click();
  await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(remaining);
  await expect.poll(async () => (await e2eState(page)).saveStatus).toBe('saved');
}

async function expectReferenceOrder(target: Locator, moduleType: 'image_generation' | 'video_generation' | 'reverse_agent',
  references: readonly MultiReference[]) {
  if (moduleType === 'image_generation') {
    const open = target.getByRole('button', { name: 'Open image generation editor', exact: true });
    if (await open.isVisible()) await open.click();
  }
  const label = moduleType === 'image_generation' ? 'Image generation reference slots'
    : moduleType === 'video_generation' ? 'Connected video media' : 'Connected reverse media slots';
  const slots = target.getByLabel(label, { exact: true });
  await expect(slots).toContainText(`${references.length} / 20`);
  await expect(slots.locator('img')).toHaveCount(references.length);
  await expect.poll(() => slots.locator('img').evaluateAll(images => images.map(image => image.getAttribute('alt'))))
    .toEqual(references.map(reference => reference.label));
  await expect.poll(() => slots.locator('img').evaluateAll(images => images.map(image => {
    const img = image as HTMLImageElement;
    return { complete: img.complete, width: img.naturalWidth, height: img.naturalHeight, src: img.getAttribute('src') };
  }))).toEqual(references.map(reference => ({ complete: true, width: reference.width,
    height: reference.height, src: reference.displayUrl })));
}

for (const theme of ['light', 'dark'] as const) {
  for (const [moduleType, input] of [['image_generation', 'references'], ['video_generation', 'media'], ['reverse_agent', 'references']] as const) {
    test(`preserves three owned materials across middle disconnects, overview and reopen in ${moduleType} ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 2000, height: 1500 });
      await page.addInitScript(theme => localStorage.setItem('novus.theme.mode', theme), theme);
      await openEmptyApp(page);
      await page.evaluate(async moduleType => {
        for (const y of [100, 470, 840]) await window.__NOVUS_E2E__!.createModule('image_input', { x: 160, y });
        await window.__NOVUS_E2E__!.createModule(moduleType, { x: 700, y: 420 });
      }, moduleType);
      const sources = page.locator('[data-module-type="image_input"]');
      const target = page.locator(`[data-module-type="${moduleType}"]`);
      const dimensions = [{ width: 48, height: 72 }, { width: 80, height: 45 }, { width: 64, height: 64 }];
      for (let index = 0; index < 3; index++) {
        await queueProjectImageImport(page, makeReferenceImage(`multi-reconnect-${index + 1}.png`,
          [45 + index * 70, 125 - index * 25, 70 + index * 50, 255], dimensions[index]!), { preservePixels: true });
        await sources.nth(index).getByRole('button', { name: /Import image/u }).click();
        await expect(sources.nth(index).locator('img')).toBeVisible();
        await dragPort(page, sources.nth(index).locator('.react-flow__handle[data-port-id="image"]'),
          target.locator(`.react-flow__handle[data-port-id="${input}"]`));
        await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(index + 1);
        await expect.poll(async () => (await e2eState(page)).saveStatus).toBe('saved');
      }
      const targetId = (await target.locator('xpath=..').getAttribute('data-id'))!;
      const original = await readMultiGraph(page, targetId, input);
      const positions = (await e2eState(page)).modulePositions;
      expect(original.references.map(reference => reference.order)).toEqual([0, 1, 2]);
      expect(new Set(original.references.map(reference => reference.assetId)).size).toBe(3);
      expect(new Set(original.references.map(reference => reference.sha256)).size).toBe(3);
      await expectReferenceOrder(target, moduleType, original.references);
      const evidence: Array<Awaited<ReturnType<typeof readMultiGraph>>> = [original];
      let previous = original;
      for (const [cycle, detail] of ['full', 'overview', 'full'].entries()) {
        if (detail === 'overview' && moduleType === 'image_generation') {
          await target.getByRole('button', { name: '折叠图片生成节点', exact: true }).click();
        }
        await page.mouse.click(1800, 1400);
        await page.mouse.move(1350, 1280);
        if (detail === 'overview') await page.mouse.wheel(0, 780);
        else if (cycle > 0) await page.mouse.wheel(0, -780);
        await expect(target).toHaveAttribute('data-render-detail', detail);
        for (let index = 0; index < 3; index++) {
          await expect(sources.nth(index).locator('img')).toBeVisible();
          await expect.poll(() => sources.nth(index).locator('img').evaluate((image: HTMLImageElement) =>
            image.complete && image.naturalWidth > 0)).toBe(true);
        }
        const removed = previous.references[1]!;
        const keptEdges = previous.edges.filter(edge => edge.id !== removed.edgeId);
        await disconnectEdge(page, removed.edgeId, 2);
        const disconnected = await readMultiGraph(page, targetId, input);
        expect(disconnected.edges).toEqual(keptEdges);
        expect(disconnected.references.map(reference => reference.assetId)).toEqual(previous.references
          .filter(reference => reference.edgeId !== removed.edgeId).map(reference => reference.assetId));
        expect(disconnected.assets).toEqual(original.assets);
        expect(disconnected.sources).toEqual(original.sources);
        if (detail === 'full') await expectReferenceOrder(target, moduleType, disconnected.references);
        const source = page.locator(`.react-flow__node[data-id="${removed.sourceId}"]`);
        await dragPort(page, source.locator('.react-flow__handle[data-port-id="image"]'),
          target.locator(`.react-flow__handle[data-port-id="${input}"]`));
        await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(3);
        await expect.poll(async () => (await e2eState(page)).saveStatus).toBe('saved');
        const reconnected = await readMultiGraph(page, targetId, input);
        expect(reconnected.edges.filter(edge => edge.source !== removed.sourceId)).toEqual(keptEdges);
        const newReference = reconnected.references.find(reference => reference.sourceId === removed.sourceId)!;
        expect(newReference).toMatchObject({ assetId: removed.assetId, sha256: removed.sha256,
          order: Math.max(...keptEdges.map(edge => edge.order ?? 0)) + 1 });
        expect(newReference.edgeId).not.toBe(removed.edgeId);
        expect(reconnected.references.map(reference => reference.assetId)).toEqual([...disconnected.references
          .map(reference => reference.assetId), removed.assetId]);
        expect(reconnected.assets).toEqual(original.assets);
        expect(reconnected.sources).toEqual(original.sources);
        expect((await e2eState(page)).modulePositions).toEqual(positions);
        if (detail === 'full') await expectReferenceOrder(target, moduleType, reconnected.references);
        await page.screenshot({ path: testInfo.outputPath(`multi-reconnect-${cycle + 1}-${detail}-${moduleType}-${theme}.png`) });
        evidence.push(disconnected, reconnected);
        previous = reconnected;
      }
      await page.evaluate(() => window.__NOVUS_E2E__!.reopenProject());
      await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(3);
      const reopened = await readMultiGraph(page, targetId, input);
      expect(reopened).toEqual(previous);
      await expectReferenceOrder(target, moduleType, reopened.references);
      expect((await e2eState(page)).modulePositions).toEqual(positions);
      expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
      expect((await e2eState(page)).reverseAnalysisRequests).toHaveLength(0);
      await testInfo.attach('multi-material-ownership-order', { body: JSON.stringify([...evidence, reopened], null, 2),
        contentType: 'application/json' });
    });
  }
}

async function disconnect(page: Page) {
  const midpoint = await page.locator('.react-flow__edge path[stroke="transparent"]').evaluate((element: SVGPathElement) => {
    const point = element.getPointAtLength(element.getTotalLength() / 2);
    return new DOMPoint(point.x, point.y).matrixTransform(element.getScreenCTM()!).toJSON();
  });
  await page.mouse.move(midpoint.x, midpoint.y);
  await page.getByRole('button', { name: '断开连接', exact: true }).click();
  await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(0);
}

for (const theme of ['light', 'dark'] as const) {
  for (const [moduleType, input] of [['image_generation', 'references'], ['video_generation', 'media'], ['reverse_agent', 'references']] as const) {
    test(`reconnects imported material to ${moduleType} in full and overview in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1680, height: 1100 });
      await page.addInitScript(theme => localStorage.setItem('novus.theme.mode', theme), theme);
      await openEmptyApp(page);
      await page.evaluate(async moduleType => {
        await window.__NOVUS_E2E__!.createModule('image_input', { x: 160, y: 140 });
        await window.__NOVUS_E2E__!.createModule(moduleType, { x: 650, y: 170 });
      }, moduleType);
      const source = page.locator('[data-module-type="image_input"]');
      const target = page.locator(`[data-module-type="${moduleType}"]`);
      await queueProjectImageImport(page, makeReferenceImage('reconnect-material.png', [54, 134, 98, 255], { width: 480, height: 600 }), { preservePixels: true });
      await source.getByRole('button', { name: /Import image/u }).click();
      await expect(source.locator('img')).toBeVisible();
      const beforePositions = (await e2eState(page)).modulePositions;
      const sourcePort = source.locator('.react-flow__handle[data-port-id="image"]');
      const targetPort = target.locator(`.react-flow__handle[data-port-id="${input}"]`);
      const connect = async () => {
        await dragPort(page, sourcePort, targetPort);
        await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(1);
        await expect.poll(async () => (await e2eState(page)).saveStatus).toBe('saved');
      };
      await connect();
      const readGraph = () => page.evaluate(async () => {
        const modulePath = '/src/app/app-store.ts';
        const { useAppStore } = await import(modulePath);
        return useAppStore.getState().project.edges;
      });
      const initialEdges = await readGraph();
      const transactionIds = () => e2eState(page).then(state => state.recentTransactionLabels.filter(transaction => transaction.label === 'Connect module ports').map(transaction => transaction.id));
      const firstTransaction = (await transactionIds())[0]!;
      expect(firstTransaction).toBeTruthy();
      await disconnect(page);
      await connect();
      expect(await readGraph()).toEqual(initialEdges);
      const secondTransaction = (await transactionIds()).at(-1)!;
      expect(secondTransaction).not.toBe(firstTransaction);
      await page.mouse.move(900, 750);
      await page.mouse.wheel(0, 780);
      await expect(source).toHaveAttribute('data-render-detail', 'overview');
      await expect(target).toHaveAttribute('data-render-detail', 'overview');
      await expect(source.locator('img')).toBeVisible();
      await disconnect(page);
      await connect();
      const thirdTransaction = (await transactionIds()).at(-1)!;
      expect(new Set([firstTransaction, secondTransaction, thirdTransaction]).size).toBe(3);
      expect(await readGraph()).toEqual(initialEdges);
      await page.screenshot({ path: testInfo.outputPath(`material-reconnect-${moduleType}-${theme}.png`) });
      await page.evaluate(() => window.__NOVUS_E2E__!.reopenProject());
      await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(1);
      expect(await readGraph()).toEqual(initialEdges);
      expect((await e2eState(page)).modulePositions).toEqual(beforePositions);
      expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
      expect((await e2eState(page)).reverseAnalysisRequests).toHaveLength(0);
    });
  }
}
