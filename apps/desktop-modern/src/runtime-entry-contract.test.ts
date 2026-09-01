import { spawnSync } from 'node:child_process';
import { access, cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { resolveRendererHtmlPath } from './renderer-path';

const workspaceRoot = process.cwd();

type DesktopShell = {
  appDir: string;
  label: string;
  packageName: string;
};

type BuildPackageJson = {
  main: string;
  scripts: { build: string };
  type?: string;
  version: string;
};

const desktopShells: DesktopShell[] = [
  {
    appDir: 'apps/desktop-modern',
    label: 'modern',
    packageName: '@agent-canvas/desktop-modern',
  },
  {
    appDir: 'apps/desktop-legacy',
    label: 'legacy',
    packageName: '@agent-canvas/desktop-legacy',
  },
];

function runWorkspaceBuild(packageName: string) {
  if (process.platform === 'win32') {
    const command = `npm run build -w ${packageName}`;
    return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], {
      cwd: workspaceRoot,
      encoding: 'utf8',
    });
  }

  return spawnSync('npm', ['run', 'build', '-w', packageName], {
    cwd: workspaceRoot,
    encoding: 'utf8',
  });
}

function createElectronStubCjs(options: { whenReadyFailureMessage?: string }) {
  const failure = options.whenReadyFailureMessage === undefined
    ? ''
    : `return Promise.reject(new Error(${JSON.stringify(options.whenReadyFailureMessage)}));`;

  return `'use strict';
const { EventEmitter } = require('node:events');

class StubApp extends EventEmitter {
  commandLine = { appendSwitch() {} };

  requestSingleInstanceLock() {
    return true;
  }

  whenReady() {
    ${failure || 'return new Promise(() => {});'}
  }

  quit() {}

  exit(code) {
    process.exitCode = code;
  }

  getPath() {
    return 'C:/tmp/canvas-agent-vitest-user-data';
  }

  setPath() {}
}

class StubBrowserWindow extends EventEmitter {
  static getAllWindows() {
    return [];
  }

  isMinimized() {
    return false;
  }

  restore() {}

  focus() {}

  isDestroyed() {
    return false;
  }

  loadFile() {
    return Promise.resolve();
  }

  destroy() {}

  close() {}

  show() {}

  once() {
    return this;
  }

  on() {
    return this;
  }

  get webContents() {
    return {
      isCrashed() {
        return false;
      },
      on() {},
      send() {},
    };
  }
}

const ipcRenderer = {
  invoke() {
    return Promise.resolve(undefined);
  },
  on() {},
  removeListener() {},
  send() {},
};

const moduleExports = {
  app: new StubApp(),
  BrowserWindow: StubBrowserWindow,
  contextBridge: {
    exposeInMainWorld() {},
  },
  dialog: {
    showErrorBox() {},
    showMessageBox: async () => ({ response: 0 }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
  },
  ipcMain: {
    handle() {},
    on() {},
    removeHandler() {},
  },
  ipcRenderer,
  webUtils: {
    getPathForFile() {
      return '';
    },
  },
  net: {
    isOnline() {
      return true;
    },
  },
  safeStorage: {
    decryptString(value) {
      return String(value);
    },
    encryptString(value) {
      return Buffer.from(String(value));
    },
    isEncryptionAvailable() {
      return false;
    },
  },
  shell: {
    openPath: async () => '',
    openExternal: async () => undefined,
  },
};

module.exports = moduleExports;
`;
}

const electronStubMjs = `import cjsModule from './index.cjs';

export const app = cjsModule.app;
export const BrowserWindow = cjsModule.BrowserWindow;
export const contextBridge = cjsModule.contextBridge;
export const dialog = cjsModule.dialog;
export const ipcMain = cjsModule.ipcMain;
export const ipcRenderer = cjsModule.ipcRenderer;
export const net = cjsModule.net;
export const safeStorage = cjsModule.safeStorage;
export const shell = cjsModule.shell;
export const webUtils = cjsModule.webUtils;
export default cjsModule;
`;

const loadEntryScript = `
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const entryPath = process.argv[1];

global.window = {
  addEventListener() {},
  removeEventListener() {},
};

(async () => {
  if (path.extname(entryPath) === '.cjs') {
    require(entryPath);
  } else {
    await import(pathToFileURL(entryPath).href);
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
`;

async function readPackageJson(shell: DesktopShell): Promise<BuildPackageJson> {
  return JSON.parse(await readFile(join(workspaceRoot, shell.appDir, 'package.json'), 'utf8')) as BuildPackageJson;
}

async function seedStaleDistArtifacts(shell: DesktopShell): Promise<void> {
  const seedResult = spawnSync(
    process.execPath,
    [
      '-e',
      `
const { mkdir, writeFile } = require('node:fs/promises');
const { resolve } = require('node:path');

const workspaceRoot = process.argv[1];
const appDir = process.argv[2];
const label = process.argv[3];

(async () => {
  const distRoot = resolve(workspaceRoot, appDir, 'dist');
  await mkdir(resolve(distRoot, 'nested'), { recursive: true });
  await writeFile(resolve(distRoot, 'main.js'), 'stale ' + label + ' desktop main', 'utf8');
  await writeFile(resolve(distRoot, 'nested', 'stale.js'), 'stale ' + label + ' nested file', 'utf8');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
      `,
      workspaceRoot,
      shell.appDir,
      shell.label,
    ],
    {
      cwd: workspaceRoot,
      encoding: 'utf8',
    },
  );

  expect(seedResult.status, `${seedResult.stderr}\n${seedResult.stdout}`).toBe(0);
}

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

async function expectPresent(path: string): Promise<void> {
  await expect(access(path)).resolves.toBeUndefined();
}

async function withTempPackage(
  shell: DesktopShell,
  packageJson: BuildPackageJson,
  electronStubCjs: string,
  callback: (packageRoot: string) => Promise<void>,
): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), `canvas-agent-${shell.label}-runtime-`));
  const packageRoot = join(tempRoot, basename(shell.appDir));
  try {
    await mkdir(join(packageRoot, 'dist'), { recursive: true });
    await mkdir(join(packageRoot, 'node_modules', 'electron'), { recursive: true });
    await cp(join(workspaceRoot, shell.appDir, 'dist'), join(packageRoot, 'dist'), { recursive: true });
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({ type: packageJson.type ?? 'commonjs' }, null, 2),
      'utf8',
    );
    await writeFile(
      join(packageRoot, 'node_modules', 'electron', 'package.json'),
      JSON.stringify(
        {
          name: 'electron',
          type: 'module',
          exports: {
            '.': {
              import: './index.mjs',
              require: './index.cjs',
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(join(packageRoot, 'node_modules', 'electron', 'index.cjs'), electronStubCjs, 'utf8');
    await writeFile(join(packageRoot, 'node_modules', 'electron', 'index.mjs'), electronStubMjs, 'utf8');
    await callback(packageRoot);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function spawnArtifactLoad(entryPath: string) {
  return spawnSync(
    process.execPath,
    ['-e', loadEntryScript, entryPath],
    {
      cwd: resolve(entryPath, '..', '..'),
      encoding: 'utf8',
    },
  );
}

describe('desktop runtime entry contract', () => {
  it('modern 1.6.86 resolves only the modern renderer entry', async () => {
    const shell = desktopShells[0]!;
    const packageJson = await readPackageJson(shell);
    const rendererEntry = resolveRendererHtmlPath(join(workspaceRoot, shell.appDir, 'dist'));

    expect(packageJson.version).toBe('1.6.86');
    expect(rendererEntry).toBe(resolve(workspaceRoot, 'apps', 'renderer', 'dist', 'index.html'));
    expect(rendererEntry).not.toContain('desktop-legacy');
  });

  it('modern packages CommonJS preload entries with a .cjs extension', async () => {
    const shell = desktopShells[0]!;
    const packageJson = await readPackageJson(shell);
    const mainSource = await readFile(join(workspaceRoot, shell.appDir, 'src', 'main.ts'), 'utf8');

    expect(packageJson.type).toBe('module');
    expect(packageJson.scripts.build).toContain('--format=cjs --outfile=dist/preload.cjs');
    expect(packageJson.scripts.build).toContain('--format=cjs --outfile=dist/safe-preload.cjs');
    expect(mainSource).toContain("join(currentDir, 'preload.cjs')");
    expect(mainSource).toContain("join(currentDir, 'safe-preload.cjs')");
  });

  it('modern disables Windows GPU acceleration before startup without exposing Node to the renderer', async () => {
    const mainSource = await readFile(join(workspaceRoot, 'apps', 'desktop-modern', 'src', 'main.ts'), 'utf8');
    const gpuCompatibilityIndex = mainSource.indexOf("app.commandLine.appendSwitch('disable-gpu')");
    const lockIndex = mainSource.indexOf('app.requestSingleInstanceLock()');
    const readyIndex = mainSource.indexOf('app.whenReady()');

    expect(gpuCompatibilityIndex).toBeGreaterThanOrEqual(0);
    expect(gpuCompatibilityIndex).toBeLessThan(lockIndex);
    expect(gpuCompatibilityIndex).toBeLessThan(readyIndex);
    expect(mainSource).not.toContain("app.commandLine.appendSwitch('in-process-gpu')");
    expect(mainSource).toContain("sandbox: process.platform !== 'win32'");
    expect(mainSource).toContain('contextIsolation: true');
    expect(mainSource).toContain('nodeIntegration: false');
  });

  it('uses the real electron updater in packaged production and gates the mock feed to an explicit environment flag', async () => {
    const mainSource = await readFile(join(workspaceRoot, 'apps', 'desktop-modern', 'src', 'main.ts'), 'utf8');

    expect(mainSource).toContain('createElectronUpdaterDriver');
    expect(mainSource).toMatch(/app\.isPackaged[\s\S]+new UpdateClient\(\{\s*driver:/u);
    expect(mainSource).toContain('NOVUS_MOCK_UPDATE_VERSION');
    expect(mainSource.indexOf('app.isPackaged')).toBeLessThan(mainSource.indexOf('NOVUS_MOCK_UPDATE_VERSION'));
  });

  it('refuses redirected shell and dist directories without deleting external sentinels', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'canvas-agent-dist-confinement-'));
    try {
      for (const redirect of ['shell', 'dist'] as const) {
        const fixtureRoot = join(tempRoot, redirect, 'repo');
        const externalRoot = join(tempRoot, redirect, 'external');
        const cleanerPath = join(fixtureRoot, 'scripts', 'clean-desktop-dist.mjs');
        const shellRoot = join(fixtureRoot, 'apps', 'desktop-modern');
        await mkdir(join(fixtureRoot, 'scripts'), { recursive: true });
        await mkdir(join(fixtureRoot, 'apps'), { recursive: true });
        await cp(join(workspaceRoot, 'scripts', 'clean-desktop-dist.mjs'), cleanerPath);

        const sentinelPath = redirect === 'shell'
          ? join(externalRoot, 'dist', 'sentinel.txt')
          : join(externalRoot, 'sentinel.txt');
        await mkdir(resolve(sentinelPath, '..'), { recursive: true });
        await writeFile(sentinelPath, 'must survive redirected cleanup', 'utf8');

        if (redirect === 'shell') {
          await symlink(externalRoot, shellRoot, process.platform === 'win32' ? 'junction' : 'dir');
        } else {
          await mkdir(shellRoot, { recursive: true });
          await symlink(externalRoot, join(shellRoot, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
        }

        const result = spawnSync(process.execPath, [cleanerPath, 'desktop-modern'], {
          cwd: fixtureRoot,
          encoding: 'utf8',
        });
        expect(result.status, `${result.stderr}\n${result.stdout}`).not.toBe(0);
        await expectPresent(sentinelPath);
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  for (const shell of desktopShells) {
    it(`${shell.label} cleans stale dist artifacts before building desktop outputs`, async () => {
      await seedStaleDistArtifacts(shell);

      const buildResult = runWorkspaceBuild(shell.packageName);
      expect(buildResult.status, buildResult.stderr || buildResult.stdout).toBe(0);

      await expectMissing(join(workspaceRoot, shell.appDir, 'dist', 'main.js'));
      await expectMissing(join(workspaceRoot, shell.appDir, 'dist', 'nested', 'stale.js'));

      const preloadArtifacts = shell.label === 'modern'
        ? ['preload.cjs', 'safe-preload.cjs']
        : ['preload.js', 'safe-preload.js'];
      for (const artifact of [
        'main.cjs',
        'snapshot-worker-entry.cjs',
        ...preloadArtifacts,
        'safe-mode.js',
        'safe-mode.html',
        'mcp/canvasforge-mcp.cjs',
        'photoshop/photoshop-place-smart-object.jsx',
        'photoshop/photoshop-windows-runner.js',
      ]) {
        await expectPresent(join(workspaceRoot, shell.appDir, 'dist', artifact));
      }
    }, 15_000);

    it(`${shell.label} builds a self-contained CommonJS desktop main that loads under the Electron contract`, async () => {
      const packageJson = await readPackageJson(shell);

      expect(packageJson.main).toBe('./dist/main.cjs');
      expect(packageJson.scripts.build).toContain('--format=cjs --outfile=dist/main.cjs');
      expect(packageJson.scripts.build).toContain('--format=cjs --outfile=dist/snapshot-worker-entry.cjs');
      const preloadArtifacts = shell.label === 'modern'
        ? ['preload.cjs', 'safe-preload.cjs']
        : ['preload.js', 'safe-preload.js'];
      expect(packageJson.scripts.build).toContain(`--format=cjs --outfile=dist/${preloadArtifacts[0]}`);
      expect(packageJson.scripts.build).toContain(`--format=cjs --outfile=dist/${preloadArtifacts[1]}`);
      if (shell.label === 'modern') expect(packageJson.scripts.build).toContain('npm run build -w @agent-canvas/mcp-bridge');
      expect(packageJson.scripts.build).not.toContain('--external:archiver');
      expect(packageJson.scripts.build).not.toContain('--external:yauzl');

      const buildResult = runWorkspaceBuild(shell.packageName);
      expect(buildResult.status, buildResult.stderr || buildResult.stdout).toBe(0);

      const builtMainSource = await readFile(join(workspaceRoot, shell.appDir, 'dist', 'main.cjs'), 'utf8');
      expect(builtMainSource).not.toContain('Dynamic require of "');
      expect(builtMainSource).not.toMatch(/(?:from|require\()["']archiver["']/u);
      expect(builtMainSource).not.toMatch(/(?:from|require\()["']yauzl["']/u);
      expect(builtMainSource).toMatch(/ipcMain\.handle\(BRIDGE_CHANNELS\.storage\.getCacheDirectory/u);
      expect(builtMainSource).toMatch(/ipcMain\.handle\(BRIDGE_CHANNELS\.storage\.chooseCacheDirectory/u);
      expect(builtMainSource).toMatch(/ipcMain\.handle\(BRIDGE_CHANNELS\.storage\.resetCacheDirectory/u);
      expect(builtMainSource).toMatch(/ipcMain\.handle\(BRIDGE_CHANNELS\.storage\.openCacheDirectory/u);
      expect(builtMainSource).toContain('openDirectory');
      expect(builtMainSource).toContain('createDirectory');
      expect(builtMainSource).toContain('shell.openPath');
      expect(builtMainSource).toContain('resolveStableUserDataRoot');
      expect(builtMainSource).toContain('migrateLegacyUserData');
      expect(builtMainSource).toMatch(/setPath\(["']userData["']/u);
      expect(builtMainSource).toContain('createWindowsPhotoshopSmartObjectAdapter');
      expect(builtMainSource).toContain('photoshopSmartObjectAdapter');
      if (shell.label === 'modern') {
        expect(builtMainSource).toContain('relayme-direct-network');
        expect(builtMainSource).toContain('persist:relayme-web-login');
        expect(builtMainSource).toContain('mode: "direct"');
        expect(builtMainSource).toContain('requestSession: relayMeNetworkSession');
        expect(builtMainSource).toContain('loginWebAccount');
        expect(builtMainSource).toContain('acquireRelayMeWebToken');
      }

      for (const preloadArtifact of preloadArtifacts) {
        const preloadSource = await readFile(join(workspaceRoot, shell.appDir, 'dist', preloadArtifact), 'utf8');
        expect(preloadSource).not.toMatch(/^\s*import\s/u);
        expect(preloadSource).toMatch(/require\(["']electron["']\)/u);
      }

      const workerEntryPath = join(workspaceRoot, shell.appDir, 'dist', 'snapshot-worker-entry.cjs');
      await expect(readFile(workerEntryPath, 'utf8')).resolves.toContain('buildSnapshotProject');

      await withTempPackage(shell, packageJson, createElectronStubCjs({}), async (packageRoot) => {
        for (const entryPoint of ['main.cjs', 'snapshot-worker-entry.cjs', ...preloadArtifacts]) {
          const entryLoad = spawnArtifactLoad(resolve(packageRoot, 'dist', entryPoint));
          expect(entryLoad.status, `${entryPoint}\n${entryLoad.stderr}\n${entryLoad.stdout}`).toBe(0);
          expect(entryLoad.stderr).not.toContain('Dynamic require of "');
        }
      });
    });

    it(`${shell.label} reports redacted startup failures instead of leaving an unhandled readiness rejection`, async () => {
      const packageJson = await readPackageJson(shell);
      const buildResult = runWorkspaceBuild(shell.packageName);
      expect(buildResult.status, buildResult.stderr || buildResult.stdout).toBe(0);

      await withTempPackage(
        shell,
        packageJson,
        createElectronStubCjs({ whenReadyFailureMessage: 'startup bootstrap failed at C:\\Users\\secret\\project' }),
        async (packageRoot) => {
          const entryLoad = spawnSync(
            process.execPath,
            ['--unhandled-rejections=strict', '-e', loadEntryScript, resolve(packageRoot, 'dist', 'main.cjs')],
            {
              cwd: packageRoot,
              encoding: 'utf8',
            },
          );

          expect(entryLoad.status, `${entryLoad.stderr}\n${entryLoad.stdout}`).toBe(1);
          expect(entryLoad.stderr).toContain('Desktop startup failed:');
          expect(entryLoad.stderr).toContain('[REDACTED_PATH]');
          expect(entryLoad.stderr).not.toContain('C:\\Users\\secret\\project');
          expect(entryLoad.stderr).not.toContain('UnhandledPromiseRejection');
        },
      );
    });
  }
});
