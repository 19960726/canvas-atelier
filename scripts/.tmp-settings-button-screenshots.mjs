import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';

const profilePath = await mkdtemp(join(tmpdir(), 'canvas-settings-buttons-'));
const storageShot = resolve('.tmp-settings-buttons-storage-final.png');
const diagnosticsShot = resolve('.tmp-settings-buttons-diagnostics-final.png');
let app;

const buttonGeometry = (page, selector) => page.locator(selector).evaluate((button, evaluatedSelector) => {
  const icon = button.querySelector('svg');
  const buttonRect = button.getBoundingClientRect();
  const iconRect = icon?.getBoundingClientRect();
  const style = getComputedStyle(button);
  const iconStyle = icon ? getComputedStyle(icon) : null;
  return {
    selector: evaluatedSelector,
    label: button.textContent?.trim(),
    flexDirection: style.flexDirection,
    alignItems: style.alignItems,
    justifyContent: style.justifyContent,
    gap: style.gap,
    height: buttonRect.height,
    width: buttonRect.width,
    iconCenterY: iconRect ? iconRect.top + iconRect.height / 2 - buttonRect.top : null,
    buttonCenterY: buttonRect.height / 2,
    iconStyle: iconStyle ? {
      position: iconStyle.position,
      display: iconStyle.display,
      alignSelf: iconStyle.alignSelf,
      margin: iconStyle.margin,
      transform: iconStyle.transform,
      width: iconStyle.width,
      height: iconStyle.height,
    } : null,
  };
}, selector);

try {
  app = await electron.launch({
    executablePath: resolve('node_modules', 'electron', 'dist', 'electron.exe'),
    args: [resolve('apps', 'desktop-modern'), `--user-data-dir=${profilePath}`],
  });
  const page = await app.firstWindow({ timeout: 30_000 });
  await page.setViewportSize({ width: 1180, height: 840 });
  await page.getByRole('button', { name: '打开设置' }).click();
  await page.getByRole('tab', { name: '存储与备份' }).click();
  await page.locator('.settings-local-storage').waitFor({ state: 'visible' });
  await page.screenshot({ path: storageShot });
  const storage = await buttonGeometry(page, '.settings-storage-refresh');
  const lowerRightLayers = await page.evaluate(() => [
    [1010, 735],
    [1060, 775],
    [1110, 800],
  ].map(([x, y]) => ({
    x,
    y,
    layers: document.elementsFromPoint(x, y).slice(0, 8).map((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName,
        className: element.className?.toString() ?? '',
        testId: element.getAttribute('data-testid'),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        position: style.position,
        zIndex: style.zIndex,
        background: style.backgroundColor,
        boxShadow: style.boxShadow,
        filter: style.filter,
        backdropFilter: style.backdropFilter,
        overflow: style.overflow,
      };
    }),
  })));

  await page.getByRole('tab', { name: '同步' }).click();
  await page.getByText('高级故障排查', { exact: true }).click();
  await page.locator('.settings-diagnostics-grid').waitFor({ state: 'visible' });
  await page.screenshot({ path: diagnosticsShot });
  const connection = await buttonGeometry(page, '.settings-connection-check');
  const update = await buttonGeometry(page, '.settings-update-action');

  console.log(JSON.stringify({ storageShot, diagnosticsShot, buttons: [storage, connection, update], lowerRightLayers }));
} finally {
  if (app) await app.close();
  await rm(profilePath, { recursive: true, force: true });
}
