import { createHash } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './helpers/e2e-test';
import { e2eState, openEmptyApp } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

async function readReferenceGraph(page: Page, targetId: string, input: string) {
  return page.evaluate(async ({ targetId, input }) => {
    const modulePath = '/src/app/app-store.ts';
    const { useAppStore } = await import(modulePath) as typeof import('../../apps/renderer/src/app/app-store');
    const state = useAppStore.getState();
    const edges = state.project.edges
      .filter(edge => edge.target === targetId && edge.targetPortId === input)
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
    const references = edges.flatMap(edge => {
      const source = state.project.nodes.find(node => node.id === edge.source);
      if (source?.type !== 'module') throw new Error('Reference source is not a module');
      const ids = source.data.moduleType === 'canvas_library'
        ? source.data.config.assetIds : [source.data.config.assetId];
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('Reference source has no asset selection');
      return ids.map((assetId: string) => {
        const asset = state.project.assets?.find(asset => asset.assetId === assetId);
        const summary = state.projectImages.find(asset => asset.assetId === assetId);
        if (!asset || !summary) throw new Error('Reference is not owned by the current project');
        return { edgeId: edge.id, sourceId: source.id, assetId, order: edge.order ?? 0,
          label: summary.label, sha256: asset.sha256, width: asset.width, height: asset.height,
          byteSize: asset.byteSize, displayUrl: summary.displayUrl };
      });
    });
    return { projectId: state.project.id, edges, references, assets: state.project.assets,
      sources: state.project.nodes.filter(node => node.type === 'module'
        && ['image_input', 'canvas_library'].includes(node.data.moduleType))
        .map(node => ({ id: node.id, position: node.position, config: node.type === 'module' ? node.data.config : {} })) };
  }, { targetId, input });
}

async function readThumbnails(tray: Locator) {
  return tray.locator('[data-slot-index] img').evaluateAll(async images => Promise.all(images.map(async element => {
    const image = element as HTMLImageElement;
    const source = image.currentSrc || image.src;
    if (!source.startsWith('data:image/png;base64,')) throw new Error('Imported thumbnail is not the original PNG data URL');
    const decoded = atob(source.slice(source.indexOf(',') + 1));
    const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return { label: image.alt, src: image.getAttribute('src'), complete: image.complete,
      width: image.naturalWidth, height: image.naturalHeight, fit: getComputedStyle(image).objectFit,
      pngSha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') };
  })));
}

for (const theme of ['light', 'dark'] as const) {
  for (const moduleType of ['image_generation', 'video_generation'] as const) {
    test(`${moduleType} saves an atomic shared-library reference group move in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 2000, height: 1500 });
      await page.addInitScript(theme => localStorage.setItem('novus.theme.mode', theme), theme);
      await openEmptyApp(page, '/?novusHarness=novus-e2e-codex-canvas-layout');
      const fixtures = [
        makeReferenceImage('Group front.png', [45, 132, 96, 255], { width: 480, height: 360 }),
        makeReferenceImage('Group scene.png', [123, 76, 158, 255], { width: 640, height: 400 }),
        makeReferenceImage('Single detail.png', [173, 117, 56, 255], { width: 512, height: 512 }),
      ];
      const pngHashes = fixtures.map(fixture => createHash('sha256').update(fixture.buffer).digest('hex'));
      expect(new Set(pngHashes).size).toBe(3);
      await page.evaluate(async () => {
        for (const y of [100, 500, 900]) await window.__NOVUS_E2E__!.createModule('image_input', { x: 140, y });
      });
      const sources = page.locator('[data-module-type="image_input"]');
      for (const [index, fixture] of fixtures.entries()) {
        const picker = page.waitForEvent('filechooser');
        await sources.nth(index).getByRole('button', { name: /Import image/u }).click();
        await (await picker).setFiles({ name: fixture.name, mimeType: fixture.mimeType, buffer: fixture.buffer });
        await expect(sources.nth(index).locator('img')).toBeVisible();
        await expect.poll(async () => (await e2eState(page)).projectImages.length).toBe(index + 1);
      }
      const imported = (await e2eState(page)).projectImages;
      await page.evaluate(async moduleType => {
        await window.__NOVUS_E2E__!.createModule('canvas_library', { x: 560, y: 110 });
        await window.__NOVUS_E2E__!.createModule(moduleType, { x: 1100, y: 110 });
      }, moduleType);
      const library = page.locator('[data-module-type="canvas_library"]');
      for (const asset of imported.slice(0, 2)) {
        await library.getByRole('checkbox', { name: new RegExp(`/ Select ${asset.label}$`, 'u') }).check();
      }
      const target = page.locator(`[data-module-type="${moduleType}"]`);
      const input = moduleType === 'image_generation' ? 'references' : 'media';
      const targetPort = target.locator(`.react-flow__handle[data-port-id="${input}"]`);
      await library.locator('.react-flow__handle[data-port-id="images"]').dragTo(targetPort);
      await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(1);
      await sources.nth(2).locator('.react-flow__handle[data-port-id="image"]').dragTo(targetPort);
      await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(2);
      const targetId = (await target.locator('xpath=..').getAttribute('data-id'))!;
      await target.getByRole('button', { name: moduleType === 'image_generation'
        ? 'Open image generation editor' : 'Open video generation editor' }).click();
      const tray = target.getByLabel(moduleType === 'image_generation'
        ? 'Image generation reference slots' : 'Connected video media editor', { exact: true });
      await expect(tray.locator('[data-slot-index]')).toHaveCount(3);
      await expect.poll(async () => (await e2eState(page)).saveStatus).toBe('saved');
      const original = await readReferenceGraph(page, targetId, input);
      expect(original.references.map(reference => reference.assetId)).toEqual(imported.map(asset => asset.assetId));
      expect(original.references.map(reference => reference.order)).toEqual([0, 0, 1]);
      expect(original.references[0]!.edgeId).toBe(original.references[1]!.edgeId);
      expect(original.references[2]!.edgeId).not.toBe(original.references[0]!.edgeId);
      expect(original.edges).toHaveLength(2);
      expect(new Set(original.references.map(reference => reference.sha256)).size).toBe(3);
      expect(original.references.map(reference => ({ width: reference.width, height: reference.height, byteSize: reference.byteSize })))
        .toEqual(fixtures.map(fixture => ({ width: fixture.width, height: fixture.height, byteSize: fixture.buffer.byteLength })));
      const expectedThumbnails = original.references.map((reference, index) => ({ label: reference.label,
        src: reference.displayUrl, complete: true, width: fixtures[index]!.width,
        height: fixtures[index]!.height, fit: 'contain', pngSha256: pngHashes[index] }));
      await expect.poll(() => readThumbnails(tray)).toEqual(expectedThumbnails);
      const beforeMoveCommits = (await e2eState(page)).commitCount;
      await tray.getByRole('button', { name: `Move ${imported[2]!.label} left` }).click();
      await expect.poll(() => tray.locator('[data-slot-index] img').evaluateAll(images => images.map(image => image.getAttribute('alt'))))
        .toEqual([imported[2]!.label, imported[0]!.label, imported[1]!.label]);
      await page.locator('.save-project-control__main').click();
      await expect.poll(async () => (await e2eState(page)).saveStatus).toBe('saved');
      expect((await e2eState(page)).commitCount).toBe(beforeMoveCommits + 1);
      const reordered = await readReferenceGraph(page, targetId, input);
      expect(reordered.edges).toEqual([{ ...original.edges[1]!, order: 0 }, { ...original.edges[0]!, order: 1 }]);
      expect(reordered.references).toEqual([
        { ...original.references[2]!, order: 0 }, { ...original.references[0]!, order: 1 }, { ...original.references[1]!, order: 1 },
      ]);
      expect(reordered.assets).toEqual(original.assets);
      expect(reordered.sources).toEqual(original.sources);
      await expect.poll(() => readThumbnails(tray)).toEqual([expectedThumbnails[2], expectedThumbnails[0], expectedThumbnails[1]]);
      await tray.screenshot({ path: testInfo.outputPath(`shared-group-reordered-${moduleType}-${theme}.png`) });
      await page.evaluate(() => window.__NOVUS_E2E__!.reopenProject());
      const openEditor = target.getByRole('button', { name: moduleType === 'image_generation'
        ? 'Open image generation editor' : 'Open video generation editor' });
      if (await openEditor.isVisible()) await openEditor.click();
      await expect(tray.locator('[data-slot-index]')).toHaveCount(3);
      await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(2);
      const reopened = await readReferenceGraph(page, targetId, input);
      expect(reopened).toEqual(reordered);
      await expect.poll(() => readThumbnails(tray)).toEqual([expectedThumbnails[2], expectedThumbnails[0], expectedThumbnails[1]]);
      await tray.screenshot({ path: testInfo.outputPath(`shared-group-reopened-${moduleType}-${theme}.png`) });
      const finalState = await e2eState(page);
      expect(finalState.modelSubmissions).toHaveLength(0);
      expect(finalState.reverseAnalysisRequests).toHaveLength(0);
      await testInfo.attach('shared-library-group-ownership', { contentType: 'application/json',
        body: JSON.stringify({ original, reordered, reopened, pngHashes }, null, 2) });
    });
  }
}
