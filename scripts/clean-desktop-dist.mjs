import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
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

function isMissingPathError(error) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

async function resolveRegularDirectory(targetPath, label) {
  const stats = await lstat(targetPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Refusing to clean through redirected ${label}`);
  }
  return realpath(targetPath);
}

async function assertConfinedDistTarget() {
  const appsRoot = resolve(repoRoot, 'apps');
  const realRepoRoot = await resolveRegularDirectory(repoRoot, 'repository root');
  const realAppsRoot = await resolveRegularDirectory(appsRoot, 'apps directory');
  const realShellRoot = await resolveRegularDirectory(shellRoot, 'desktop shell directory');

  if (!samePath(realRepoRoot, repoRoot)) {
    throw new Error('Refusing to clean through redirected repository ancestors');
  }
  if (!samePath(realAppsRoot, resolve(realRepoRoot, 'apps'))) {
    throw new Error('Refusing to clean through redirected apps directory');
  }
  if (!samePath(realShellRoot, resolve(realRepoRoot, 'apps', shellName))) {
    throw new Error('Refusing to clean through redirected desktop shell directory');
  }

  try {
    const realDistRoot = await resolveRegularDirectory(distRoot, 'desktop dist directory');
    if (!samePath(realDistRoot, resolve(realShellRoot, 'dist'))) {
      throw new Error('Refusing to clean redirected desktop dist directory');
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
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

await assertConfinedDistTarget();
await rmWithRetry(distRoot);
await mkdir(distRoot, { recursive: true });
