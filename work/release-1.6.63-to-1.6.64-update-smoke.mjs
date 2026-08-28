import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { _electron as electron } from 'playwright';

const execFileAsync = promisify(execFile);
const workspaceRoot = resolve('.');
const workRoot = resolve('work');
const releaseRoot = resolve('apps/desktop-modern/dist-builder/desktop-modern');
const oldInstaller = join(releaseRoot, 'CanvasAtelier-Win10-11-x64-1.6.63.exe');
const newInstaller = join(releaseRoot, 'CanvasAtelier-Win10-11-x64-1.6.64.exe');
const newBlockmap = `${newInstaller}.blockmap`;
const latestYml = join(releaseRoot, 'latest.yml');
const sevenZip = resolve('node_modules/7zip-bin/win/x64/7za.exe');
const useGithubRelease = process.argv.includes('--github') || process.env.UPDATE_SMOKE_USE_GITHUB === '1';
const screenshotPath = process.env.UPDATE_SMOKE_SCREENSHOT
  ? resolve(process.env.UPDATE_SMOKE_SCREENSHOT)
  : resolve('work/release-1.6.63-to-1.6.64-update-ready.png');

const tempRoot = await mkdtemp(join(workRoot, 'update-smoke-'));
if (!tempRoot.startsWith(`${workRoot}${sep}`)) throw new Error(`Unsafe temporary path: ${tempRoot}`);
const runtimeRoot = join(tempRoot, 'runtime-1.6.63');
const qaRoot = join(tempRoot, 'canvasforge-qa-update-1.6.63');
const qaLocalAppData = join(tempRoot, 'local-app-data');
const qaRoamingAppData = join(tempRoot, 'roaming-app-data');
const updaterCacheRoot = join(
  qaLocalAppData,
  useGithubRelease ? '@agent-canvasdesktop-modern-updater' : 'canvas-atelier-updater-smoke',
);
const requests = [];
const pageErrors = [];
const serverErrors = [];
const electronLogs = [];
let electronApp;
let server;
let page;
let dialog;

try {
  await execFileAsync(sevenZip, ['x', oldInstaller, `-o${runtimeRoot}`, '-y'], {
    cwd: workspaceRoot,
    windowsHide: true,
  });

  if (!useGithubRelease) {
    const assets = new Map([
      ['/latest.yml', latestYml],
      [`/${basename(newInstaller)}`, newInstaller],
      [`/${basename(newBlockmap)}`, newBlockmap],
      [`/${basename(oldInstaller)}.blockmap`, `${oldInstaller}.blockmap`],
    ]);
    server = createServer(async (request, response) => {
      try {
        const requestPath = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
        const assetPath = assets.get(requestPath);
        if (!assetPath) {
          requests.push({ method: request.method, path: requestPath, status: 404 });
          response.writeHead(404).end();
          return;
        }
        const fileStat = await stat(assetPath);
        const range = parseRange(request.headers.range, fileStat.size);
        const status = range ? 206 : 200;
        const length = range ? range.end - range.start + 1 : fileStat.size;
        requests.push({ method: request.method, path: requestPath, status, bytes: length, range: request.headers.range ?? null });
        response.setHeader('Accept-Ranges', 'bytes');
        response.setHeader('Content-Length', length);
        response.setHeader('Content-Type', requestPath.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream');
        if (range) response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${fileStat.size}`);
        response.writeHead(status);
        if (request.method === 'HEAD') response.end();
        else createReadStream(assetPath, range ?? undefined).pipe(response);
      } catch (error) {
        serverErrors.push(error instanceof Error ? error.message : String(error));
        response.writeHead(500).end();
      }
    });
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Local update server did not expose a TCP port.');

    await writeFile(
      join(runtimeRoot, 'resources', 'app-update.yml'),
      `provider: generic\nurl: http://127.0.0.1:${address.port}/\nupdaterCacheDirName: canvas-atelier-updater-smoke\n`,
      'utf8',
    );
  }

  electronApp = await electron.launch({
    executablePath: join(runtimeRoot, 'Canvas Atelier.exe'),
    env: {
      ...process.env,
      APPDATA: qaRoamingAppData,
      CANVASFORGE_QA_HIDDEN: '1',
      CANVASFORGE_QA_MODE: '1',
      CANVASFORGE_QA_USER_DATA_ROOT: qaRoot,
      LOCALAPPDATA: qaLocalAppData,
    },
  });
  electronApp.process().stdout?.on('data', (chunk) => electronLogs.push(`stdout: ${String(chunk).trim()}`));
  electronApp.process().stderr?.on('data', (chunk) => electronLogs.push(`stderr: ${String(chunk).trim()}`));
  page = await electronApp.firstWindow();
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  await page.waitForSelector('[data-testid="workspace"]', { timeout: 30_000 });
  await page.setViewportSize({ width: 1440, height: 900 });
  const runningVersion = await electronApp.evaluate(({ app }) => app.getVersion());
  if (runningVersion !== '1.6.63') throw new Error(`Expected old runtime 1.6.63, received ${runningVersion}.`);

  await page.getByTestId('settings-toggle').click();
  const settings = page.getByTestId('settings-drawer');
  await settings.getByRole('tab', { name: '同步' }).click();
  await settings.getByText('高级故障排查', { exact: true }).click();
  await settings.getByRole('button', { name: 'Check for updates' }).click();
  dialog = page.getByRole('dialog', { name: '应用更新' });
  await dialog.waitFor({ state: 'visible', timeout: 30_000 });
  await dialog.getByText('发现新版本 1.6.64', { exact: true }).waitFor({ timeout: 30_000 });
  await dialog.getByRole('button', { name: '下载更新' }).click();
  const restartButton = dialog.getByRole('button', { name: '重启并安装' });
  await page.waitForFunction(() => {
    const text = document.querySelector('[role="dialog"][aria-label="应用更新"]')?.textContent ?? '';
    return text.includes('重启并安装') || text.includes('更新暂时不可用');
  }, null, { timeout: 180_000 });
  if (!(await restartButton.isVisible())) throw new Error(`Update download failed in the UI: ${await dialog.innerText()}`);

  const expectedInstallerSize = (await stat(newInstaller)).size;
  const cachedInstaller = await findDownloadedInstaller(updaterCacheRoot, null, expectedInstallerSize).catch(() => null);
  let screenshotCaptured = false;
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 10_000 });
    screenshotCaptured = true;
  } catch (error) {
    electronLogs.push(`screenshot: ${error instanceof Error ? error.message : String(error)}`);
    screenshotCaptured = await stat(screenshotPath).then((value) => value.size > 0).catch(() => false);
  }
  const result = {
    availableVersion: '1.6.64',
    cachedInstaller: cachedInstaller ? {
      bytes: (await stat(cachedInstaller)).size,
      sha256: await sha256(cachedInstaller),
    } : null,
    downloaded: true,
    newInstaller: {
      bytes: (await stat(newInstaller)).size,
      sha256: await sha256(newInstaller),
    },
    oldInstaller: {
      bytes: (await stat(oldInstaller)).size,
      sha256: await sha256(oldInstaller),
    },
    pageErrors,
    requests,
    serverErrors,
    restartInvoked: false,
    runningVersion,
    updateSource: useGithubRelease ? 'github-release' : 'local-http',
    screenshotCaptured,
    screenshotPath,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const dialogText = dialog === undefined ? null : await dialog.innerText().catch(() => null);
  if (page !== undefined) await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 5_000 }).catch(() => undefined);
  process.stderr.write(`${JSON.stringify({
    dialogText,
    electronLogs: electronLogs.slice(-100),
    error: error instanceof Error ? error.stack ?? error.message : String(error),
    pageErrors,
    requests,
    serverErrors,
    screenshotPath,
  })}\n`);
  throw error;
} finally {
  await electronApp?.close().catch(() => undefined);
  await new Promise((resolveClose) => server?.close(() => resolveClose(undefined)) ?? resolveClose(undefined));
  await rm(tempRoot, { recursive: true, force: true });
}

function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const match = /^bytes=(\d+)-(\d*)$/u.exec(header);
  if (!match) return null;
  const start = Number(match[1]);
  const requestedEnd = match[2] === '' ? size - 1 : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size) return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

async function sha256(path) {
  const hash = createHash('sha256');
  const bytes = await readFile(path);
  hash.update(bytes);
  return hash.digest('hex').toUpperCase();
}

async function findDownloadedInstaller(root, excludedRoot, expectedSize) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (excludedRoot !== null && path === excludedRoot) continue;
    if (entry.isDirectory()) {
      const nested = await findDownloadedInstaller(path, excludedRoot, expectedSize);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.exe') && (await stat(path)).size === expectedSize) {
      return path;
    }
  }
  return null;
}
