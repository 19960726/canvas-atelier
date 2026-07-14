import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDir, '..');
const sourcePath = resolve(appRoot, 'src', 'safe-mode.html');
const destinationPath = resolve(appRoot, 'dist', 'safe-mode.html');

await mkdir(dirname(destinationPath), { recursive: true });
await copyFile(sourcePath, destinationPath);
