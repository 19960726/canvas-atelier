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

const electronStubCjs = `'use strict';
const { EventEmitter } = require('node:events');

class StubApp extends EventEmitter {
  requestSingleInstanceLock() {
    return true;
  }

  whenReady() {
    return new Promise(() => {});
  }

  quit() {}

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

  close() {}

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
    openExternal: async () => undefined,
  },
};

module.exports = moduleExports;
`;

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

const archiverStubCjs = `'use strict';
module.exports = function createArchiver() {
  return {
    append() {},
    directory() {},
    file() {},
    finalize() {
      return Promise.resolve();
    },
    on() {},
    pipe() {},
  };
};
`;

const archiverStubMjs = `import createArchiver from './index.cjs';
export default createArchiver;
`;

const yauzlStubCjs = `'use strict';
module.exports = {
  fromBuffer(_buffer, _options, callback) {
    if (typeof callback === 'function') {
      callback(new Error('stubbed yauzl.fromBuffer should not be invoked during entry load'));
    }
  },
  fromFd(_fd, _options, callback) {
    if (typeof callback === 'function') {
      callback(new Error('stubbed yauzl.fromFd should not be invoked during entry load'));
    }
  },
  open(_path, _options, callback) {
    if (typeof callback === 'function') {
      callback(new Error('stubbed yauzl.open should not be invoked during entry load'));
    }
  },
};
`;

const yauzlStubMjs = `import yauzl from './index.cjs';
export const fromBuffer = yauzl.fromBuffer;
export const fromFd = yauzl.fromFd;
export const open = yauzl.open;
export default yauzl;
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
    const loaded = require(entryPath);
    if (loaded && typeof loaded.then === 'function') {
      await loaded;
    }
  } else {
    await import(pathToFileURL(entryPath).href);
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
`;

describe('desktop runtime entry contract', () => {
  for (const shell of desktopShells) {
    it(`${shell.label} keeps the Electron ESM entrypoint behind a CommonJS launcher that loads without dynamic require traps`, async () => {
      const packageJsonPath = join(workspaceRoot, shell.appDir, 'package.json');
      const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
        main: string;
        scripts: { build: string };
        type?: string;
      };

      expect(packageJson.main).toBe('./dist/main.cjs');
      expect(packageJson.scripts.build).toContain('--format=esm --outfile=dist/main.js');
      expect(packageJson.scripts.build).toContain('--format=esm --outfile=dist/preload.js');
      expect(packageJson.scripts.build).toContain('--format=esm --outfile=dist/safe-preload.js');
      expect(packageJson.scripts.build).toContain('--external:archiver');
      expect(packageJson.scripts.build).toContain('--external:yauzl');

      const buildResult = runWorkspaceBuild(shell.packageName);

      expect(buildResult.status, buildResult.stderr || buildResult.stdout).toBe(0);
      const builtMainSource = await readFile(join(workspaceRoot, shell.appDir, 'dist', 'main.js'), 'utf8');
      const builtLauncherSource = await readFile(join(workspaceRoot, shell.appDir, 'dist', 'main.cjs'), 'utf8');

      expect(builtMainSource).toContain('from "archiver"');
      expect(builtMainSource).toContain('from "yauzl"');
      expect(builtMainSource).not.toContain('archiver/lib/core.js');
      expect(builtMainSource).not.toContain('yauzl/fd-slicer.js');
      expect(builtMainSource).not.toContain('Dynamic require of "');
      expect(builtLauncherSource).toContain("import('./main.js')");

      const tempRoot = await mkdtemp(join(tmpdir(), `canvas-agent-${shell.label}-runtime-`));
      const packageRoot = join(tempRoot, basename(shell.appDir));
      try {
        await mkdir(join(packageRoot, 'dist'), { recursive: true });
        await mkdir(join(packageRoot, 'node_modules', 'electron'), { recursive: true });
        await mkdir(join(packageRoot, 'node_modules', 'archiver'), { recursive: true });
        await mkdir(join(packageRoot, 'node_modules', 'yauzl'), { recursive: true });
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
        await writeFile(
          join(packageRoot, 'node_modules', 'archiver', 'package.json'),
          JSON.stringify(
            {
              name: 'archiver',
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
        await writeFile(join(packageRoot, 'node_modules', 'archiver', 'index.cjs'), archiverStubCjs, 'utf8');
        await writeFile(join(packageRoot, 'node_modules', 'archiver', 'index.mjs'), archiverStubMjs, 'utf8');
        await writeFile(
          join(packageRoot, 'node_modules', 'yauzl', 'package.json'),
          JSON.stringify(
            {
              name: 'yauzl',
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
        await writeFile(join(packageRoot, 'node_modules', 'yauzl', 'index.cjs'), yauzlStubCjs, 'utf8');
        await writeFile(join(packageRoot, 'node_modules', 'yauzl', 'index.mjs'), yauzlStubMjs, 'utf8');

        for (const entryPoint of ['main.cjs', 'main.js', 'preload.js', 'safe-preload.js']) {
          const entryLoad = spawnSync(process.execPath, ['-e', loadEntryScript, resolve(packageRoot, 'dist', entryPoint)], {
            cwd: packageRoot,
            encoding: 'utf8',
          });

          expect(entryLoad.status, `${entryPoint}\n${entryLoad.stderr}\n${entryLoad.stdout}`).toBe(0);
          expect(entryLoad.stderr).not.toContain('Dynamic require of "');
        }
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    });
  }
});
