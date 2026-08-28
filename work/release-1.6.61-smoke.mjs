import { _electron as electron } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const executablePath = resolve('apps/desktop-modern/dist-builder/desktop-modern/win-unpacked/Canvas Atelier.exe');
const qaRoot = await mkdtemp(join(tmpdir(), 'canvasforge-qa-1.6.61-'));

const launch = () => electron.launch({
  executablePath,
  env: {
    ...process.env,
    CANVASFORGE_QA_HIDDEN: '1',
    CANVASFORGE_QA_MODE: '1',
    CANVASFORGE_QA_USER_DATA_ROOT: qaRoot,
  },
});

const messages = [];
let firstApp;
let secondApp;
try {
  firstApp = await launch();
  const page = await firstApp.firstWindow();
  page.on('pageerror', (error) => messages.push(error.stack ?? error.message));
  await page.waitForSelector('[data-testid="workspace"]', { timeout: 20_000 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: '新建项目' }).click();
  const newProjectDialog = page.getByRole('dialog', { name: '确认新建项目' });
  if (await newProjectDialog.isVisible().catch(() => false)) {
    await newProjectDialog.getByRole('button', { name: '不保存并新建' }).click();
    await newProjectDialog.waitFor({ state: 'hidden' });
  }
  await page.getByTestId('tool-modules').click();
  const moduleSearch = page.getByRole('searchbox', { name: '搜索模块' });
  await moduleSearch.fill('image generation');
  await page.getByRole('button', { name: '查看 图片生成 / Image Generation' }).dblclick();
  const imageNode = page.locator('[data-module-type="image_generation"]');
  await imageNode.getByRole('button', { name: 'Open image generation editor' }).click();
  await page.getByRole('button', { name: '保存项目' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="save-state"]')?.getAttribute('data-save-state') === 'saved', null, { timeout: 20_000 });
  const toolbar = imageNode.locator('.module-node__generation-control-bar');
  await toolbar.waitFor({ state: 'visible', timeout: 20_000 });
  const toolbarControls = await toolbar.locator('button, select').evaluateAll((elements) => elements.map((element) => ({
    ariaLabel: element.getAttribute('aria-label'),
    height: Math.round(element.getBoundingClientRect().height),
    visible: element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0,
  })));
  const firstVersion = await firstApp.evaluate(({ app }) => app.getVersion());
  await firstApp.close();
  firstApp = undefined;

  secondApp = await launch();
  const reopened = await secondApp.firstWindow();
  reopened.on('pageerror', (error) => messages.push(error.stack ?? error.message));
  await reopened.waitForSelector('[data-testid="workspace"]', { timeout: 20_000 });
  await reopened.locator('[data-module-type="image_generation"]').first().waitFor({ state: 'attached', timeout: 20_000 }).catch(() => undefined);
  const restoredImageNodes = await reopened.locator('[data-module-type="image_generation"]').count();
  const fatalAlertCount = await reopened.locator('[role="alert"].renderer-failure, .renderer-failure__summary').count();
  const title = await reopened.title();
  const secondVersion = await secondApp.evaluate(({ app }) => app.getVersion());
  process.stdout.write(`${JSON.stringify({
    canvasVisible: true,
    fatalAlertCount,
    firstVersion,
    pageErrors: messages,
    restoredImageNodes,
    secondVersion,
    title,
    toolbarControls,
  })}\n`);
} finally {
  await firstApp?.close().catch(() => undefined);
  await secondApp?.close().catch(() => undefined);
  await rm(qaRoot, { recursive: true, force: true });
}
