import { _electron as electron } from 'playwright';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const executablePath = resolve(process.argv[2] ?? 'apps/desktop-modern/dist-builder/desktop-modern/win-unpacked/Canvas Atelier.exe');
const qaRoot = process.argv[3]
  ? resolve(process.argv[3])
  : resolve(tmpdir(), 'canvasforge-qa-relayme-web-login-1.6.84');
const pageErrors = [];
const electronApp = await electron.launch({
  executablePath,
  env: {
    ...process.env,
    CANVASFORGE_QA_MODE: '1',
    CANVASFORGE_QA_USER_DATA_ROOT: qaRoot,
  },
});

try {
  const canvasPage = await electronApp.firstWindow();
  canvasPage.on('pageerror', (error) => pageErrors.push(error.message));
  await canvasPage.waitForSelector('[data-testid="workspace"]', { timeout: 15_000 });
  await canvasPage.getByRole('button', { name: '打开设置' }).click();
  await canvasPage.getByRole('listitem', { name: /RelayMe/u }).click();
  const dialog = canvasPage.getByRole('dialog', { name: '登录 RelayMe' });
  if (!await dialog.isVisible()) await canvasPage.getByRole('button', { name: '登录 RelayMe' }).first().click();
  await dialog.waitFor({ state: 'visible' });

  const authWindowPromise = electronApp.waitForEvent('window');
  await dialog.getByRole('button', { name: '使用 RelayMe 网页登录' }).click();
  const authPage = await authWindowPromise;
  await authPage.waitForURL(/^https:\/\/www\.ml\.relayme\.uk\/(?:[?#].*)?$/u, { timeout: 30_000 });
  const loginUrl = authPage.url();
  await authPage.close();

  const alert = dialog.getByRole('alert');
  await alert.waitFor({ state: 'visible', timeout: 10_000 });
  const result = {
    version: await electronApp.evaluate(({ app }) => app.getVersion()),
    loginUrl,
    alert: await alert.textContent(),
    webLoginEnabled: await dialog.getByRole('button', { name: '使用 RelayMe 网页登录' }).isEnabled(),
    pageErrors,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.version !== '1.6.84'
    || !result.loginUrl.startsWith('https://www.ml.relayme.uk/')
    || result.alert !== '已取消 RelayMe 网页登录'
    || !result.webLoginEnabled
    || result.pageErrors.length > 0) process.exitCode = 1;
} finally {
  await electronApp.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
}
