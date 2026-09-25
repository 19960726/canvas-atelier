import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './helpers/e2e-test';
import { openEmptyApp } from './helpers/app';

const output = path.join(process.cwd(), 'work', process.env.CANVAS_SETTINGS_AUDIT_DIR ?? 'qa-settings-atelier-20260925');

test('model directory uses the page scroll and keeps search, default and save reachable', async ({ page }) => {
  fs.mkdirSync(output, { recursive: true });
  await page.setViewportSize({ width: 1680, height: 900 });
  await page.addInitScript(() => localStorage.setItem('novus.theme.mode', 'dark'));
  await openEmptyApp(page);
  await page.getByTestId('settings-toggle').click();
  const drawer = page.getByTestId('settings-drawer');
  const list = drawer.locator('.settings-model-list').first();
  await expect(list.locator('article')).not.toHaveCount(0);
  const size = await list.evaluate((element) => ({ client: element.clientHeight, scroll: element.scrollHeight, overflow: getComputedStyle(element).overflowY }));
  expect(size.scroll - size.client, JSON.stringify(size)).toBeLessThanOrEqual(2);
  expect(size.overflow).not.toBe('auto');
  await drawer.getByRole('searchbox', { name: '搜索当前分类模型' }).fill('GPT Image');
  await expect(list.locator('article')).not.toHaveCount(0);
  await drawer.getByRole('searchbox', { name: '搜索当前分类模型' }).fill('gpt-image-2.5-flare');
  await expect(list.locator('article')).toHaveCount(1);
  await expect(list.locator('article').first()).toContainText('GPT Image 2.5 Flare');
  await expect(list.locator('article').first()).not.toContainText(/(?:2K|4K)$/iu);
  await expect(drawer.getByLabel('生图默认模型')).toBeVisible();
  const save = drawer.locator('.settings-model-save');
  await save.scrollIntoViewIfNeeded();
  const saveBox = (await save.boundingBox())!;
  const bodyBox = (await drawer.locator('.settings-drawer__body').boundingBox())!;
  expect(saveBox.x).toBeGreaterThan(bodyBox.x + bodyBox.width / 2);
  await drawer.screenshot({ path: path.join(output, '1680-dark-model-search.png') });
});

for (const width of [1680, 1024, 480]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`settings visual audit ${width}px ${theme}`, async ({ page }) => {
      fs.mkdirSync(output, { recursive: true });
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem('novus.theme.mode', value), theme);
      await openEmptyApp(page);
      await page.getByTestId('settings-toggle').click();
      const drawer = page.getByTestId('settings-drawer');
      await expect(drawer).toBeVisible();
      const navigation = drawer.getByRole('tablist', { name: '设置分类' });
      const body = drawer.locator('.settings-drawer__body');
      const navBox = (await navigation.boundingBox())!;
      const bodyBox = (await body.boundingBox())!;
      const navAlignment = await navigation.getByRole('tab').first().evaluate((element) => {
        const icon = element.querySelector('svg')!.getBoundingClientRect();
        const label = element.querySelector('span')!.getBoundingClientRect();
        return { display: getComputedStyle(element).display, direction: getComputedStyle(element).flexDirection, gap: Math.abs(icon.top + icon.height / 2 - label.top - label.height / 2) };
      });
      expect(navAlignment.gap, JSON.stringify(navAlignment)).toBeLessThanOrEqual(3);
      if (width >= 1024) {
        expect(navBox.width).toBeLessThan(200);
        expect(navBox.x + navBox.width).toBeLessThanOrEqual(bodyBox.x + 1);
      } else {
        expect(navBox.y + navBox.height).toBeLessThanOrEqual(bodyBox.y + 1);
      }
      if (width === 480) {
        const surfaceAtRail = await page.evaluate(() => {
          const rail = document.querySelector('.toolrail--floating');
          if (!rail) return false;
          const box = rail.getBoundingClientRect();
          return Boolean(document.elementFromPoint(box.left + box.width / 2, box.top + 40)?.closest('.settings-drawer'));
        });
        expect(surfaceAtRail).toBe(true);
      }
      const measures: Record<string, unknown> = {};
      for (const [tab, name] of [['API 与模型', 'api'], ['存储与备份', 'storage'], ['MCP 联动', 'mcp'], ['同步', 'sync']] as const) {
        await drawer.getByRole('tab', { name: tab }).click();
        await expect(drawer.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', `settings-tab-${name}`);
        await expect(drawer.locator('.settings-page-heading h2')).toBeVisible();
        await drawer.screenshot({ path: path.join(output, `${width}-${theme}-${name}.png`) });
        if (name === 'api' || name === 'mcp') {
          await drawer.locator('.settings-drawer__body').evaluate((body) => { body.scrollTop = body.scrollHeight; });
          await drawer.screenshot({ path: path.join(output, `${width}-${theme}-${name}-bottom.png`) });
          await drawer.locator('.settings-drawer__body').evaluate((body) => { body.scrollTop = 0; });
        }
        measures[name] = await drawer.evaluate((element) => {
          const body = element.querySelector('.settings-drawer__body')!;
          const overflowing = [...body.querySelectorAll('button, input, select, article, section')]
            .filter((node) => {
              const rect = node.getBoundingClientRect();
              const bounds = body.getBoundingClientRect();
              return rect.right > bounds.right + 2 || rect.left < bounds.left - 2;
            })
            .slice(0, 12)
            .map((node) => ({ tag: node.tagName, className: node.className, text: node.textContent?.slice(0, 40) }));
          const visibleText = [...body.querySelectorAll('.settings-section p, .settings-section small, .settings-section button')]
            .filter((node) => node.getBoundingClientRect().height > 0)
            .map((node) => ({ text: node.textContent?.slice(0, 32), fontSize: Number.parseFloat(getComputedStyle(node).fontSize) }));
          return { width: element.getBoundingClientRect().width, bodyWidth: body.getBoundingClientRect().width, scrollWidth: body.scrollWidth, overflowing, visibleText };
        });
      }
      fs.writeFileSync(path.join(output, `${width}-${theme}-metrics.json`), JSON.stringify(measures, null, 2));
      for (const result of Object.values(measures) as { scrollWidth: number; bodyWidth: number; overflowing: unknown[]; visibleText: { fontSize: number }[] }[]) {
        expect(result.scrollWidth).toBeLessThanOrEqual(result.bodyWidth + 2);
        expect(result.overflowing).toHaveLength(0);
        expect(Math.min(...result.visibleText.map((item) => item.fontSize))).toBeGreaterThanOrEqual(11);
      }
    });
  }
}

test('credential dialog stays above the settings drawer on a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 900 });
  await openEmptyApp(page);
  await page.getByTestId('settings-toggle').click();
  await page.getByRole('button', { name: '配置隐藏密钥' }).click();
  const dialog = page.getByRole('dialog', { name: '配置隐藏密钥' });
  await expect(dialog).toBeVisible();
  const hitDialog = await dialog.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
  });
  expect(hitDialog).toBe(true);
  await dialog.screenshot({ path: path.join(output, '480-credential-dialog.png') });
});

test('settings action icons align with their labels and save has breathing room', async ({ page }) => {
  await openEmptyApp(page);
  await page.getByTestId('settings-toggle').click();
  const button = page.getByRole('button', { name: '检测连接' });
  const alignment = await button.evaluate((element) => {
    const icon = element.querySelector('svg')!.getBoundingClientRect();
    const text = [...element.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
    const range = document.createRange();
    range.selectNodeContents(text!);
    const label = range.getBoundingClientRect();
    return Math.abs(icon.top + icon.height / 2 - label.top - label.height / 2);
  });
  expect(alignment).toBeLessThanOrEqual(4);
  const saveSpacing = await page.locator('.settings-model-save').evaluate((element) => {
    const next = element.parentElement?.nextElementSibling;
    return next ? next.getBoundingClientRect().top - element.getBoundingClientRect().bottom : 0;
  });
  expect(saveSpacing).toBeGreaterThanOrEqual(12);
});
