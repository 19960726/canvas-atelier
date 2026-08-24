import path from 'node:path';
import { expect, test } from './helpers/e2e-test';
import { openEmptyApp } from './helpers/app';

const artifact = (name: string) => path.join(
  process.cwd(),
  'artifacts',
  '2026-08-10-complete-project-release',
  name,
);

test('shows a text-only recent project list, missing-state actions, and recovery versions as separate sections', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1050 });
  await page.addInitScript(() => localStorage.setItem('novus.theme.mode', 'dark'));
  await openEmptyApp(page);
  await page.evaluate(() => {
    const desktop = window.novusDesktop as typeof window.novusDesktop & Record<string, unknown>;
    if (desktop === undefined) throw new Error('E2E desktop bridge unavailable');
    desktop.recentProjects = {
      list: async () => [
        {
          recentProjectId: 'recent_0123456789abcdef01234567',
          projectId: 'project-recent-a',
          displayName: '商品主视觉项目',
          lastOpenedAt: '2026-08-10T08:00:00.000Z',
          lastSavedAt: '2026-08-10T07:55:00.000Z',
          availability: 'available',
          nodeCount: 8,
          imageCount: 4,
          videoCount: 2,
          previewUrl: '/__novus_e2e_asset/0000000000000001.svg',
        },
        {
          recentProjectId: 'recent_89abcdef0123456701234567',
          projectId: 'project-recent-missing',
          displayName: '已移动项目',
          lastOpenedAt: '2026-08-09T08:00:00.000Z',
          lastSavedAt: '2026-08-09T07:55:00.000Z',
          availability: 'missing',
          nodeCount: 3,
          imageCount: 1,
          videoCount: 0,
          previewUrl: null,
        },
      ],
      open: async () => null,
      relocate: async () => null,
      remove: async () => [],
    };
  });

  await page.getByRole('button', { name: '展开画布管理' }).click();
  const manager = page.getByRole('dialog', { name: '画布管理' });
  await expect(manager).toBeVisible();
  await expect(manager.getByText('最近保存的项目')).toBeVisible();
  await expect(manager.getByText('商品主视觉项目')).toBeVisible();
  await expect(manager.getByRole('img')).toHaveCount(0);
  await expect(manager.getByText('8 节点 · 4 图片 · 2 视频')).toBeVisible();
  await expect(manager.getByText('项目文件不存在')).toBeVisible();
  await expect(manager.getByRole('button', { name: '重新定位已移动项目' })).toBeVisible();
  await expect(manager.getByRole('button', { name: '从列表移除已移动项目' })).toBeVisible();
  await expect(manager.getByText('恢复版本')).toBeVisible();

  const geometry = await manager.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      bottom: rect.bottom,
      right: rect.right,
      width: rect.width,
    };
  });
  expect(geometry.width).toBeGreaterThanOrEqual(400);
  expect(geometry.bottom).toBeLessThanOrEqual(1050);
  expect(geometry.right).toBeLessThanOrEqual(1680);
  await page.screenshot({ path: artifact('05-project-manager-dark.png'), fullPage: true });
});
