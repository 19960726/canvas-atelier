import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDir, '..');
const sourcePath = resolve(appRoot, 'src', 'safe-mode.html');
const destinationPath = resolve(appRoot, 'dist', 'safe-mode.html');
const launcherPath = resolve(appRoot, 'dist', 'main.cjs');
const launcherSource = `module.exports = import('./main.js').catch((error) => {
  setImmediate(() => { throw error; });
  throw error;
});
`;

await mkdir(dirname(destinationPath), { recursive: true });
await copyFile(sourcePath, destinationPath);
await writeFile(launcherPath, launcherSource, 'utf8');
