import { _electron as electron } from 'playwright';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const executablePath = resolve(process.argv[2] ?? 'apps/desktop-modern/dist-builder/desktop-modern/win-unpacked/Canvas Atelier.exe');
const qaRoot = process.argv[3]
  ? resolve(process.argv[3])
  : resolve(tmpdir(), 'canvasforge-qa-relayme-live-final-1.6.83');
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
  const page = await electronApp.firstWindow();
  await page.waitForSelector('[data-testid="workspace"]', { timeout: 20_000 });
  const result = await page.evaluate(async () => {
    const bridge = window.novusDesktop;
    if (!bridge) throw new Error('Desktop bridge is unavailable');
    const recent = await bridge.recentProjects.list();
    const target = recent.find((item) => item.displayName === 'RelayMe live acceptance' && item.imageCount > 0);
    if (!target) throw new Error('Generated QA project is unavailable');
    const session = await bridge.recentProjects.open({ recentProjectId: target.recentProjectId, mode: 'write' });
    if (!session) throw new Error('Generated QA project could not be opened');
    const images = await bridge.projectImages.list({ sessionId: session.sessionId });
    const image = images.find((item) => item.origin === 'generated');
    if (!image) throw new Error('Generated QA image is unavailable');
    return bridge.projectImages.importToPhotoshop({ sessionId: session.sessionId, assetId: image.assetId });
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
} finally {
  await electronApp.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
}
