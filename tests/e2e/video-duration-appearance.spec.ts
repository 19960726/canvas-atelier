import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './helpers/e2e-test';
import { openEmptyApp } from './helpers/app';

const evidenceDirectory = path.join(process.cwd(), 'work', process.env.CANVAS_VIDEO_DURATION_AUDIT_DIR ?? 'qa-duration-appearance-2026-09-24-r6');

test('captures video duration appearance before focus, during keyboard input, and after blur in light theme', async ({ page }) => {
  await mkdir(evidenceDirectory, { recursive: true });
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.addInitScript(() => localStorage.setItem('novus.theme.mode', 'light'));
  await openEmptyApp(page);
  await page.evaluate(() => window.__NOVUS_E2E__!.createModule('video_generation', { x: 350, y: 90 }));
  const video = page.locator('[data-module-type="video_generation"]');
  await video.getByRole('button', { name: 'Open video generation editor' }).click();
  await video.getByRole('button', { name: '打开视频参数设置' }).click();
  const settings = video.getByRole('dialog', { name: '视频生成参数' });
  const duration = settings.getByRole('slider', { name: '视频时长' });
  const select = settings.getByRole('button', { name: '视频比例' });
  const selectAppearance = await select.evaluate((element) => {
    const style = getComputedStyle(element);
    return { width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height, cssHeight: style.height, minHeight: style.minHeight, maxHeight: style.maxHeight, backgroundColor: style.backgroundColor, borderWidth: style.borderWidth, borderRadius: style.borderRadius,
      rowClass: element.closest('.module-node__video-settings-row')?.className,
      matchedMinHeightRules: Array.from(document.styleSheets).flatMap((sheet, sheetIndex) => {
        try { return Array.from(sheet.cssRules).filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
          .filter((rule) => { try { return element.matches(rule.selectorText) && !!rule.style.getPropertyValue('min-height'); } catch { return false; } })
          .map((rule) => ({ sheetIndex, source: sheet.href ?? sheet.ownerNode?.getAttribute('data-vite-dev-id'), selector: rule.selectorText, value: rule.style.getPropertyValue('min-height'), priority: rule.style.getPropertyPriority('min-height'), height: rule.style.getPropertyValue('height'), maxHeight: rule.style.getPropertyValue('max-height') })); } catch { return []; }
      }),
    };
  });
  const appearance = () => duration.evaluate((element) => {
    const style = getComputedStyle(element);
    const parent = getComputedStyle(element.parentElement!);
    return {
      active: document.activeElement === element,
      value: (element as HTMLInputElement).value,
      rect: element.getBoundingClientRect().toJSON(),
      borderWidth: style.borderWidth,
      outline: style.outline,
      boxShadow: style.boxShadow,
      border: style.border,
      borderRadius: style.borderRadius,
      minHeight: style.minHeight,
      maxHeight: style.maxHeight,
      padding: style.padding,
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      parentOutline: parent.outline,
      parentBorder: parent.border,
      parentBoxShadow: parent.boxShadow,
      matchedMinHeightRules: Array.from(document.styleSheets).flatMap((sheet) => {
        try { return Array.from(sheet.cssRules); } catch { return []; }
      }).filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
        .filter((rule) => { try { return element.matches(rule.selectorText) && !!rule.style.getPropertyValue('min-height'); } catch { return false; } })
        .map((rule) => ({ selector: rule.selectorText, value: rule.style.getPropertyValue('min-height'), priority: rule.style.getPropertyPriority('min-height') })),
    };
  });
  const before = await appearance();
  await settings.screenshot({ path: path.join(evidenceDirectory, 'before-focus.png') });
  await duration.focus();
  await duration.press('ArrowRight');
  const focused = await appearance();
  await settings.screenshot({ path: path.join(evidenceDirectory, 'keyboard-focused.png') });
  await settings.locator('.module-node__video-settings-menu-header').click();
  const blurred = await appearance();
  await settings.screenshot({ path: path.join(evidenceDirectory, 'after-blur.png') });
  await writeFile(path.join(evidenceDirectory, 'appearance.json'), JSON.stringify({ select: selectAppearance, before, focused, blurred }, null, 2), 'utf8');
  expect(before.rect.height).toBe(selectAppearance.height);
  expect(before.rect.width).toBe(selectAppearance.width);
  const outputBox = await settings.locator('output').boundingBox();
  expect(outputBox).not.toBeNull();
  expect(outputBox!.x).toBeGreaterThan(before.rect.x);
  expect(outputBox!.x + outputBox!.width).toBeLessThanOrEqual(before.rect.right);
  expect(before.minHeight).toBe('30px');
  expect(before.maxHeight).toBe('30px');
  expect(before.backgroundColor).toBe(selectAppearance.backgroundColor);
  expect(before.borderWidth).toBe(selectAppearance.borderWidth);
  expect(before.borderRadius).toBe(selectAppearance.borderRadius);
  expect(focused.outline).toContain('solid 2px');
  expect(Number.parseInt((await settings.locator('output').textContent())!, 10)).toBeGreaterThan(Number.parseInt(before.value, 10));
  expect(before.active).toBe(false);
  expect(focused.active).toBe(true);
  expect(blurred.active).toBe(false);
});
