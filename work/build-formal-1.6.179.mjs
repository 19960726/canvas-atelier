import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { build, Platform } from 'electron-builder';
import { createRequire } from 'node:module';

const version = '1.6.179';
const require = createRequire(import.meta.url);
const integrityModule = require('app-builder-lib/out/electron/electronWin.js');
const writeIntegrity = integrityModule.addWinAsarIntegrity;
integrityModule.addWinAsarIntegrity = async (...args) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await writeIntegrity(...args);
    } catch (error) {
      if (attempt >= 5 || !['UNKNOWN', 'EBUSY', 'EPERM'].includes(error.code)) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
    }
  }
};

const root = resolve(import.meta.dirname, '..');
const desktop = join(root, 'apps/desktop-modern');
const stage = await mkdtemp(join(tmpdir(), 'canvas-formal-179-bundle-'));
const output = process.env.CANVAS_FORMAL_OUTPUT_DIR
  ? resolve(process.env.CANVAS_FORMAL_OUTPUT_DIR)
  : join(desktop, `dist-builder/desktop-modern-${version}-formal-final`);
await cp(join(desktop, 'dist'), join(stage, 'dist'), { recursive: true });
await writeFile(join(stage, 'package.json'), JSON.stringify({
  name: 'canvas-atelier-formal',
  productName: 'Canvas Atelier',
  version,
  description: 'Canvas Atelier',
  author: 'Canvas Atelier',
  main: 'dist/main.cjs',
  type: 'module',
}, null, 2));
await mkdir(output, { recursive: true });
await writeFile(join(output, 'bundle-input.json'), JSON.stringify({
  stage,
  sourceRoot: root,
  version,
  sourceManifest: JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8')).version,
  bundledRuntime: true,
  rootManifestPreserved: true,
}, null, 2));
await build({
  projectDir: stage,
  targets: Platform.WINDOWS.createTarget(process.argv.includes('--dir') ? 'dir' : 'nsis'),
  ...(process.argv.includes('--installer-only') ? { prepackaged: join(output, 'win-unpacked') } : {}),
  config: {
    appId: 'com.canvasatelier.desktop',
    productName: 'Canvas Atelier',
    electronVersion: '43.1.0',
    electronDist: join(process.env.LOCALAPPDATA, 'electron/Cache'),
    npmRebuild: false,
    nodeGypRebuild: false,
    publish: { provider: 'github', owner: '19960726', repo: 'canvas-atelier', releaseType: 'release' },
    directories: { output, buildResources: join(desktop, 'build') },
    files: ['dist/**', 'package.json'],
    extraResources: [
      { from: join(desktop, 'build/app-update.yml'), to: 'app-update.yml' },
      { from: join(root, 'apps/renderer/dist'), to: 'renderer/dist' },
      { from: join(desktop, 'build/icon.ico'), to: 'icon.ico' },
      { from: join(desktop, 'dist/mcp'), to: 'mcp' },
      { from: join(desktop, 'dist/photoshop'), to: 'photoshop' },
      { from: join(desktop, 'build/local-matting-runtime'), to: 'local-matting-runtime' },
      { from: join(desktop, 'build/local-matting-runtime/node_modules'), to: 'local-matting-runtime/node_modules', filter: ['**/*'] },
    ],
    win: { icon: join(desktop, 'build/icon.ico'), signAndEditExecutable: false },
    artifactName: 'CanvasAtelier-Win10-11-x64-${version}.exe',
    nsis: {
      oneClick: false,
      perMachine: true,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      shortcutName: 'Canvas Atelier',
      include: join(desktop, 'build/installer.nsh'),
    },
  },
  publish: 'never',
});
