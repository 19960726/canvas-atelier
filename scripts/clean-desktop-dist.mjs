import { mkdir, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

const shellName = process.argv[2];

if (shellName !== 'desktop-modern' && shellName !== 'desktop-legacy') {
  throw new Error('Usage: node scripts/clean-desktop-dist.mjs <desktop-modern|desktop-legacy>');
}

const shellRoot = resolve(repoRoot, 'apps', shellName);
const distRoot = resolve(shellRoot, 'dist');
const relativeDistRoot = relative(repoRoot, distRoot);

if (isAbsolute(relativeDistRoot) || relativeDistRoot.startsWith('..') || basename(distRoot) !== 'dist') {
  throw new Error(`Refusing to clean unexpected desktop dist path: ${distRoot}`);
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  });
}

function isRetriableFsError(error) {
  return Boolean(error && typeof error === 'object' && 'code' in error && (
    error.code === 'EPERM' ||
    error.code === 'EBUSY' ||
    error.code === 'ENOTEMPTY'
  ));
}

async function rmWithRetry(targetPath) {
  const delays = [50, 100, 200, 400, 800];

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      await rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === delays.length || !isRetriableFsError(error)) {
        throw error;
      }

      await sleep(delays[attempt]);
    }
  }
}

await rmWithRetry(distRoot);
await mkdir(distRoot, { recursive: true });
