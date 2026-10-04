import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './helpers/e2e-test';
import { openEmptyApp } from './helpers/app';

const output = path.join(process.cwd(), 'work', 'repair-185', 'navigation-audit', 'source');

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1600, 1100]) {
    test(`canvas navigation stays visible and usable at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 1600 ? 1000 : 800 });
      await page.addInitScript(value => localStorage.setItem('novus.theme.mode', value), theme);
      await openEmptyApp(page);
      fs.mkdirSync(output, { recursive: true });

      const topbar = page.getByTestId('topbar');
      const identity = topbar.locator('.topbar__identity');
      const project = topbar.getByRole('button', { name: '展开画布管理' });
      const save = topbar.getByRole('button', { name: '保存项目' });
      const create = topbar.getByRole('button', { name: '新建项目' });
      const ai = topbar.getByRole('button', { name: '打开 Agent 对话' });
      const themeControl = topbar.getByRole('combobox', { name: '主题 Theme' });
      const close = topbar.getByRole('button', { name: '关闭应用' });

      await expect(identity).toBeHidden();
      expect((await topbar.boundingBox())!.width).toBeLessThan(580);
      for (const control of [project, save, create, ai, themeControl, close]) await expect(control).toBeVisible();

      const boxes = await Promise.all([project, save, create, ai, themeControl, close].map(control => control.boundingBox()));
      for (const box of boxes) expect(box).not.toBeNull();
      expect(boxes[2]!.x + boxes[2]!.width).toBeLessThanOrEqual(boxes[3]!.x + 2);
      expect(boxes[5]!.x + boxes[5]!.width).toBeLessThanOrEqual(width - 12);
      for (const control of [project, save, create, ai, close]) {
        const box = await control.boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(40);
      }
      await page.screenshot({ path: path.join(output, `${theme}-${width}-canvas.png`) });

      await project.click();
      await expect(page.locator('.canvas-manager')).toBeVisible();
      await page.screenshot({ path: path.join(output, `${theme}-${width}-project-menu.png`) });
      await topbar.getByRole('button', { name: '收起画布管理' }).click();

      const rail = page.getByRole('navigation', { name: '画布工具' });
      const orb = rail.locator('.canvas-ai-orb--rail');
      const orbBox = (await orb.boundingBox())!;
      const orbButtonBox = (await orb.locator('xpath=ancestor::button').boundingBox())!;
      expect(Math.abs(orbBox.x + orbBox.width / 2 - orbButtonBox.x - orbButtonBox.width / 2)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(orbBox.y + orbBox.height / 2 - orbButtonBox.y - orbButtonBox.height / 2)).toBeLessThanOrEqual(0.5);
      await expect(rail.getByRole('group', { name: '画布编辑' }).getByRole('button')).toHaveCount(5);
      await expect(rail.getByRole('group', { name: '工作区' }).getByRole('button')).toHaveCount(2);
      await expect(rail.getByRole('group', { name: '应用' }).getByRole('button')).toHaveCount(1);
      const settings = page.getByTestId('settings-toggle');
      await settings.hover();
      await expect(settings.locator('.tool-button__hint')).toHaveCSS('opacity', '1');
      await expect(settings.locator('.tool-button__hint')).toHaveText('设置');
      await page.screenshot({ path: path.join(output, `${theme}-${width}-rail-hover.png`) });
      await settings.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      await expect(settings.locator('.tool-button__hint')).toHaveCSS('opacity', '1');
      await page.screenshot({ path: path.join(output, `${theme}-${width}-rail-focus.png`) });
      await settings.click();
      await expect(page.getByTestId('settings-drawer')).toBeVisible();
      await page.screenshot({ path: path.join(output, `${theme}-${width}-settings.png`) });

      if (width === 1100) {
        await page.getByTestId('settings-drawer-close').click();
        await ai.click();
        await expect(page.getByTestId('agent-panel')).toBeVisible();
        const topbarBox = (await topbar.boundingBox())!;
        const agentBox = (await page.getByTestId('agent-panel').boundingBox())!;
        expect(topbarBox.x).toBeGreaterThanOrEqual(0);
        expect(topbarBox.x + topbarBox.width).toBeLessThanOrEqual(agentBox.x + 2);
        for (const control of [project, save, create, topbar.locator('.topbar-agent-entry'), themeControl, close]) {
          await expect(control).toBeVisible();
          const box = (await control.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(topbarBox.x);
          expect(box.x + box.width).toBeLessThanOrEqual(topbarBox.x + topbarBox.width + 1);
        }
        await page.screenshot({ path: path.join(output, `${theme}-${width}-agent-open.png`) });
      }
    });
  }
}
