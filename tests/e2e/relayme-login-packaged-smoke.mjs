import { _electron as electron } from 'playwright';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const executablePath = resolve(process.argv[2] ?? 'apps/desktop-modern/dist-builder/desktop-modern/win-unpacked/Canvas Atelier.exe');
const qaRoot = process.argv[3]
  ? resolve(process.argv[3])
  : resolve(tmpdir(), 'canvasforge-qa-relayme-login-1.6.83');
const messages = [];
let page;
const electronApp = await electron.launch({
  executablePath,
  env: {
    ...process.env,
    CANVASFORGE_QA_HIDDEN: '1',
    CANVASFORGE_QA_MODE: '1',
    CANVASFORGE_QA_USER_DATA_ROOT: qaRoot,
  },
});

try {
  page = await electronApp.firstWindow();
  page.on('console', (message) => messages.push(`${message.type().toUpperCase()} ${message.text()}`));
  page.on('pageerror', (error) => messages.push(`PAGEERROR ${error.stack ?? error.message}`));
  await page.waitForSelector('[data-testid="workspace"]', { timeout: 15_000 });
  await page.getByRole('button', { name: '打开设置' }).click();
  await page.getByTestId('settings-drawer').waitFor({ state: 'visible' });
  await page.getByRole('listitem', { name: /RelayMe/u }).click();
  const dialog = page.getByRole('dialog', { name: '登录 RelayMe' });
  if (!await dialog.isVisible()) {
    await page.getByRole('button', { name: '登录 RelayMe' }).first().click();
  }
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByLabel('RelayMe 账号').fill('packaged-smoke@example.invalid');
  await dialog.getByLabel('RelayMe 密码').fill('not-a-real-password');
  await dialog.getByRole('button', { name: '使用账号密码登录' }).click();
  const alert = dialog.getByRole('alert');
  await alert.waitFor({ state: 'visible', timeout: 40_000 });
  const result = {
    version: await electronApp.evaluate(({ app }) => app.getVersion()),
    alert: await alert.textContent(),
    passwordCleared: await dialog.getByLabel('RelayMe 密码').inputValue() === '',
    cancelEnabled: await dialog.getByRole('button', { name: '取消' }).isEnabled(),
    pageErrors: messages.filter((message) => message.startsWith('PAGEERROR')),
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.alert !== 'RelayMe 账号或密码错误' || !result.passwordCleared || !result.cancelEnabled || result.pageErrors.length > 0) {
    process.exitCode = 1;
  }
} catch (error) {
  process.stdout.write(`SMOKE_ERROR=${error.stack ?? error}\n`);
  process.stdout.write(`BODY=${(await page?.locator('body').innerText().catch(() => '') ?? '').slice(0, 8_000)}\n`);
  process.stdout.write(`${messages.join('\n')}\n`);
  throw error;
} finally {
  await electronApp.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
}
