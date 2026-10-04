import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './helpers/e2e-test';
import { openEmptyApp } from './helpers/app';

const output = path.join(process.cwd(), 'work', 'repair-185', 'settings-ui-r8');
const defaults = ['生图默认模型', '视频默认模型', '对话默认模型', '反推默认模型', '视觉默认模型', '视频理解默认模型'];
const panes = [['API 与模型', 'api'], ['存储与备份', 'storage'], ['MCP 联动', 'mcp'], ['同步', 'sync']] as const;

async function openSettings(page: Page, theme: 'light' | 'dark' = 'light', width = 1600) {
  await page.setViewportSize({ width, height: width === 1600 ? 1000 : 800 });
  await page.addInitScript(value => localStorage.setItem('novus.theme.mode', value), theme);
  await openEmptyApp(page);
  await page.getByTestId('settings-toggle').click();
  const drawer = page.getByTestId('settings-drawer');
  await expect(drawer).toBeVisible();
  return drawer;
}

async function expectFolded(details: Locator) {
  await expect(details).toBeVisible({ timeout: 1500 });
  await expect(details).toHaveJSProperty('open', false);
}

test('all six default models remain usable while the model catalogue is folded', async ({ page }) => {
  const drawer = await openSettings(page);
  for (const label of defaults) {
    await expect.soft(drawer.getByRole('combobox', { name: label, exact: true })).toBeVisible({ timeout: 1500 });
  }
  const catalogue = drawer.locator('.settings-catalog-details');
  await expectFolded(catalogue);
  await expect(drawer.getByRole('searchbox', { name: '搜索当前分类模型' })).toBeHidden();
  await expect(drawer.locator('.settings-model-save')).toBeVisible();
  await catalogue.locator('summary').click();
  await expect(drawer.getByRole('searchbox', { name: '搜索当前分类模型' })).toBeVisible();
  await drawer.getByRole('searchbox', { name: '搜索当前分类模型' }).fill('gpt-image-2.5-flare');
  await expect(drawer.locator('.settings-model-list article')).toHaveCount(1);
  await catalogue.locator('summary').click();
  for (const label of defaults) await expect(drawer.getByRole('combobox', { name: label, exact: true })).toBeVisible();
  await expectFolded(drawer.locator('.settings-api-diagnostics'));
});

test('MCP connection controls stay visible while capability diagnostics and extra permissions are folded', async ({ page }) => {
  const drawer = await openSettings(page);
  await drawer.getByRole('tab', { name: 'MCP 联动', exact: true }).click();
  await expect.soft(drawer.getByRole('region', { name: 'Codex 与 MCP 能力诊断' })).toBeHidden({ timeout: 1500 });
  for (const client of ['Codex', 'WorkBuddy']) {
    await expect(drawer.getByRole('button', { name: `Connect ${client}`, exact: true })).toBeVisible();
    await expect(drawer.getByRole('button', { name: `Test ${client} connection`, exact: true })).toBeVisible();
    await expect(drawer.getByRole('button', { name: `Copy ${client} config`, exact: true })).toBeVisible();
  }
  await expectFolded(drawer.locator('.settings-mcp-capability-details'));
  await expectFolded(drawer.locator('.settings-mcp-more-permissions'));
  await drawer.locator('.settings-mcp-capability-details > summary').click();
  await expect(drawer.getByRole('region', { name: 'Codex 与 MCP 能力诊断' })).toBeVisible();
});

test('application updates are directly reachable without opening advanced diagnostics', async ({ page }) => {
  const drawer = await openSettings(page);
  await drawer.getByRole('tab', { name: '同步', exact: true }).click();
  await expectFolded(drawer.locator('.settings-advanced-diagnostics'));
  const update = drawer.getByRole('region', { name: '应用更新', exact: true });
  await expect(update).toBeVisible({ timeout: 1500 });
  await expect(update.getByRole('button', { name: 'Check for updates', exact: true })).toBeVisible();
  await expect(drawer.getByRole('region', { name: '连接与恢复', exact: true })).toBeHidden();
  await update.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '应用更新', exact: true })).toBeVisible();
});

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1600, 1100]) {
    test(`four compact settings pages fit ${width}px ${theme} with inherited surfaces and reachable controls`, async ({ page }) => {
      fs.mkdirSync(output, { recursive: true });
      const drawer = await openSettings(page, theme, width);
      const header = drawer.locator('.settings-drawer__header');
      const rail = drawer.locator('.settings-navigation');
      const body = drawer.locator('.settings-drawer__body');
      const panel = (await drawer.boundingBox())!;
      expect.soft(panel.width).toBeLessThanOrEqual(1122);
      expect.soft((await header.boundingBox())!.height).toBeGreaterThanOrEqual(60);
      expect.soft((await header.boundingBox())!.height).toBeLessThanOrEqual(64);
      expect.soft((await rail.boundingBox())!.width).toBeGreaterThanOrEqual(178);
      expect.soft((await rail.boundingBox())!.width).toBeLessThanOrEqual(182);
      const surface = theme === 'dark' ? 'rgb(32, 37, 35)' : 'rgb(253, 253, 251)';
      const railSurface = theme === 'dark' ? 'rgb(25, 30, 28)' : 'rgb(238, 240, 235)';
      await expect.soft(header).toHaveCSS('background-color', surface);
      await expect.soft(body).toHaveCSS('background-color', surface);
      await expect.soft(rail).toHaveCSS('background-color', railSurface);
      await expect.soft(drawer.locator('.settings-page-heading > span')).toHaveCount(0);
      await expect.soft(drawer.locator('.settings-navigation__caption')).toHaveCount(0);

      const metrics: Record<string, unknown> = {};
      for (const [label, pane] of panes) {
        await drawer.getByRole('tab', { name: label, exact: true }).click();
        await expect(body).toHaveAttribute('aria-labelledby', `settings-tab-${pane}`);
        await expect(body.locator('.settings-page-heading h2')).toHaveCount(1);
        await body.evaluate(element => { element.scrollTop = 0; });
        metrics[pane] = await body.evaluate(element => {
          const bounds = element.getBoundingClientRect();
          const controls = [...element.querySelectorAll('button, input, select')].filter(control => control.getBoundingClientRect().height > 0);
          const outside = controls.filter(control => {
            const rect = control.getBoundingClientRect();
            return rect.left < bounds.left - 1 || rect.right > bounds.right + 1;
          }).map(control => ({ className: control.className, text: control.textContent?.slice(0, 45) }));
          const sections = [...element.querySelectorAll('.settings-page-heading, .settings-provider-switch, .settings-provider-panel, .settings-key-heading, .settings-provider-endpoint, .settings-credential-row, .settings-credential-summary, .settings-provider-links, .settings-connection-actions, .settings-model-defaults-section, .settings-model-defaults, .settings-model-save-row, .settings-catalog-details, .settings-sync-update-area')].map(section => {
            const style = getComputedStyle(section);
            const rect = section.getBoundingClientRect();
            return { className: section.className, y: rect.y, height: rect.height, display: style.display, gap: style.gap, margin: style.margin, padding: style.padding, border: style.borderWidth };
          });
          return { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, overflow: getComputedStyle(element).overflowY, outside, sections };
        });
        const measure = metrics[pane] as { clientWidth: number; scrollWidth: number; overflow: string; outside: unknown[] };
        expect.soft(measure.scrollWidth, `${pane}: ${JSON.stringify(measure)}`).toBeLessThanOrEqual(measure.clientWidth + 1);
        expect.soft(measure.outside, `${pane}: ${JSON.stringify(measure)}`).toHaveLength(0);
        expect.soft(measure.overflow).toBe('auto');
        if (pane === 'api') {
          const save = (await drawer.locator('.settings-model-save').boundingBox())!;
          const bounds = (await body.boundingBox())!;
          expect.soft(save.y + save.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
          await expect.soft(drawer.locator('.settings-provider-endpoint input')).toHaveCSS('background-color', theme === 'dark' ? 'rgb(39, 45, 42)' : 'rgb(243, 244, 241)');
        }
        if (pane === 'storage') await expectFolded(drawer.locator('.settings-storage-details'));
        if (pane === 'sync') {
          const update = drawer.getByRole('button', { name: 'Check for updates', exact: true });
          await expect.soft(update).toBeVisible({ timeout: 1500 });
          const box = await update.boundingBox();
          const bounds = (await body.boundingBox())!;
          if (box) expect.soft(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
        }
        await drawer.screenshot({ path: path.join(output, `${theme}-${width}-${pane}.png`) });
      }
      fs.writeFileSync(path.join(output, `${theme}-${width}-metrics.json`), JSON.stringify(metrics, null, 2));
    });
  }
}
