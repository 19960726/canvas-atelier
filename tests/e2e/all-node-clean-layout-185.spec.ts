import { listCanvasModuleDefinitions } from '@agent-canvas/domain';
import { expect, test } from './helpers/e2e-test';
import { e2eState, openEmptyApp } from './helpers/app';

// This is a visual/layout inventory. It never treats an empty-node screenshot
// as evidence that a provider operation or a saved-project workflow succeeded.
for (const theme of ['light', 'dark'] as const) {
  test(`all registered node layouts keep visible text and controls clean in ${theme}`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1600, height: 1800 });
    await page.addInitScript(value => localStorage.setItem('novus.theme.mode', value), theme);
    await openEmptyApp(page);
    const inventory = [];
    for (const definition of listCanvasModuleDefinitions()) {
      expect(await page.evaluate(async type => {
        await window.__NOVUS_E2E__!.resetEmpty();
        return window.__NOVUS_E2E__!.createModule(type, { x: 300, y: 150 });
      }, definition.type)).toBe(true);
      const node = page.locator(`[data-module-type="${definition.type}"]`);
      await expect(node).toBeVisible();
      if (definition.type === 'image_generation' || definition.type === 'video_generation') {
        await node.getByRole('button', { name: definition.type === 'image_generation' ? 'Open image generation editor' : 'Open video generation editor' }).click();
        // A dispatched React event can return before the editor commit. Do not
        // measure the collapsed shell as if it were the expanded editor.
        await expect(node.locator('.module-node__summary--generation')).toHaveAttribute('data-editor-expanded', 'true');
        await expect(node.getByRole('textbox', { name: definition.type === 'image_generation' ? 'Image generation prompt' : 'Video preview prompt' })).toBeVisible();
        await expect(node).toHaveCSS('width', '704px');
      }
      const result = await node.evaluate(root => {
        const card = root.getBoundingClientRect();
        const visible = (element: Element) => {
          const rect = element.getBoundingClientRect();
          const css = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && css.visibility !== 'hidden' && css.display !== 'none';
        };
        const controls = Array.from(root.querySelectorAll('button,input,textarea,select,[contenteditable="true"]')).filter(visible);
        const name = (element: Element) => element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent?.trim() || element.tagName;
        const violations = controls.flatMap(element => {
          const rect = element.getBoundingClientRect();
          return rect.left < card.left - 2 || rect.right > card.right + 2 || rect.top < card.top - 2 || rect.bottom > card.bottom + 2
            ? [`outside card: ${name(element)}`] : [];
        });
        const buttons = controls.filter(element => element.tagName === 'BUTTON');
        for (let index = 0; index < buttons.length; index++) {
          const first = buttons[index]!;
          const a = first.getBoundingClientRect();
          for (const second of buttons.slice(index + 1)) {
            if (first.contains(second) || second.contains(first)) continue;
            const b = second.getBoundingClientRect();
            if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) {
              violations.push(`overlapping buttons: ${name(first)} / ${name(second)}`);
            }
          }
        }
        const text = (root as HTMLElement).innerText;
        if (/[\uFFFD]|·\s*·|IMAGE OUTPUT|VIDEO OUTPUT/u.test(text)) violations.push('broken glyph or redundant output label');
        return {
          text,
          size: { width: card.width, height: card.height },
          controls: controls.map(element => ({ name: name(element), tag: element.tagName, disabled: 'disabled' in element ? Boolean(element.disabled) : false })),
          violations,
        };
      });
      inventory.push({ type: definition.type, primaryName: definition.primaryName, ...result });
      await node.screenshot({ path: testInfo.outputPath(`${definition.type}-${theme}.png`) });
      expect.soft(result.violations, `${definition.type} actual visible layout`).toEqual([]);
      // Compact empty video inputs are intentionally 138px wide. Judge their
      // real text/control geometry above instead of forcing a universal width.
      expect.soft(result.size.width).toBeGreaterThan(0);
      expect.soft(result.size.height).toBeGreaterThan(30);
    }
    await testInfo.attach(`all-node-layout-${theme}`, { body: JSON.stringify(inventory, null, 2), contentType: 'application/json' });
    expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
  });
}
