import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

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
  for (const shell of desktopShells) {
    it(`${shell.label} builds a self-contained CommonJS desktop main that loads under the Electron contract`, async () => {
      const packageJson = await readPackageJson(shell);

      expect(packageJson.main).toBe('./dist/main.cjs');
      expect(packageJson.scripts.build).toContain('--format=cjs --outfile=dist/main.cjs');
      expect(packageJson.scripts.build).toContain('--format=cjs --outfile=dist/snapshot-worker-entry.cjs');
      expect(packageJson.scripts.build).not.toContain('--external:archiver');
      expect(packageJson.scripts.build).not.toContain('--external:yauzl');

      const buildResult = runWorkspaceBuild(shell.packageName);
      expect(buildResult.status, buildResult.stderr || buildResult.stdout).toBe(0);

      const builtMainSource = await readFile(join(workspaceRoot, shell.appDir, 'dist', 'main.cjs'), 'utf8');
      expect(builtMainSource).not.toContain('Dynamic require of "');
      expect(builtMainSource).not.toMatch(/(?:from|require\()["']archiver["']/u);
      expect(builtMainSource).not.toMatch(/(?:from|require\()["']yauzl["']/u);

      const workerEntryPath = join(workspaceRoot, shell.appDir, 'dist', 'snapshot-worker-entry.cjs');
      await expect(readFile(workerEntryPath, 'utf8')).resolves.toContain('buildSnapshotProject');

      await withTempPackage(shell, packageJson, createElectronStubCjs({}), async (packageRoot) => {
        for (const entryPoint of ['main.cjs', 'snapshot-worker-entry.cjs', 'preload.js', 'safe-preload.js']) {
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
