import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDir, '..');
const workspaceRoot = resolve(appRoot, '..', '..');
const staticFiles = [
  {
    source: resolve(appRoot, 'src', 'safe-mode.html'),
    destination: resolve(appRoot, 'dist', 'safe-mode.html'),
  },
  {
    source: resolve(workspaceRoot, 'packages', 'mcp-bridge', 'dist', 'canvasforge-mcp.cjs'),
    destination: resolve(appRoot, 'dist', 'mcp', 'canvasforge-mcp.cjs'),
  },
  {
    source: resolve(workspaceRoot, 'packages', 'desktop-core', 'src', 'photoshop-place-smart-object.jsx'),
    destination: resolve(appRoot, 'dist', 'photoshop', 'photoshop-place-smart-object.jsx'),
  },
  {
    source: resolve(workspaceRoot, 'packages', 'desktop-core', 'src', 'photoshop-windows-runner.js'),
    destination: resolve(appRoot, 'dist', 'photoshop', 'photoshop-windows-runner.js'),
  },
  {
    source: resolve(workspaceRoot, 'packages', 'desktop-core', 'src', 'photoshop-windows-runner.vbs'),
    destination: resolve(appRoot, 'dist', 'photoshop', 'photoshop-windows-runner.vbs'),
  },
];

for (const file of staticFiles) {
  await mkdir(dirname(file.destination), { recursive: true });
  await copyFile(file.source, file.destination);
}
