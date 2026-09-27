import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDir, '..');
const workspaceRoot = resolve(appRoot, '..', '..');
await build({ entryPoints: [resolve(appRoot, 'src/local-matting-worker-entry.ts')], outfile: resolve(appRoot, 'dist/local-matting-worker-entry.cjs'),
  bundle: true, platform: 'node', target: 'node22', format: 'cjs' });
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
