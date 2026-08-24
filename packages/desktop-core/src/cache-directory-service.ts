import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, parse, resolve } from 'node:path';

export interface CacheDirectoryState {
  readonly path: string;
  readonly isDefault: boolean;
  readonly available: boolean;
  readonly busy: boolean;
  readonly error: string | null;
}

export interface CacheDirectoryServiceAdapters {
  readonly defaultCacheRoot: string;
  readonly stateFilePath: string;
  chooseDirectory(): Promise<string | null>;
  openDirectory(path: string): Promise<boolean>;
  copyDirectory(source: string, target: string): Promise<void>;
  verifyDirectoryCopy(source: string, target: string): Promise<void>;
  removeDirectory(path: string): Promise<void>;
  ensureDirectory(path: string): Promise<void>;
  readConfiguredPath(): Promise<string | null>;
  writeConfiguredPathAtomically(path: string | null): Promise<void>;
  replaceDirectoryAtomically?(source: string, target: string): Promise<void>;
}

export interface CacheDirectoryService {
  getCacheDirectory(): Promise<CacheDirectoryState>;
  chooseCacheDirectory(): Promise<CacheDirectoryState | null>;
  resetCacheDirectory(): Promise<CacheDirectoryState>;
  openCacheDirectory(): Promise<{ opened: boolean }>;
}

export interface NodeCacheDirectoryAdaptersOptions {
  readonly defaultCacheRoot: string;
  readonly stateFilePath: string;
  chooseDirectory(): Promise<string | null>;
  openDirectory(path: string): Promise<boolean>;
}

const CACHE_DIRECTORY_BUSY = 'CACHE_DIRECTORY_BUSY';
const CACHE_DIRECTORY_UNAVAILABLE = 'CACHE_DIRECTORY_UNAVAILABLE';
const CACHE_DIRECTORY_UNSAFE = 'CACHE_DIRECTORY_UNSAFE';
const CACHE_MIGRATION_FAILED = 'CACHE_MIGRATION_FAILED';
const CACHE_OWNERSHIP_MARKER = '.novus-regenerable-cache';

export function createCacheDirectoryService(
  adapters: CacheDirectoryServiceAdapters,
): CacheDirectoryService {
  const defaultRoot = validateCacheRoot(adapters.defaultCacheRoot);
  let busy = false;
  let lastError: string | null = null;

  async function getEffectiveRoot(): Promise<string> {
    const configuredPath = await adapters.readConfiguredPath();
    if (configuredPath === null) return defaultRoot;
    try {
      return validateCacheRoot(configuredPath);
    } catch {
      lastError = CACHE_DIRECTORY_UNSAFE;
      return defaultRoot;
    }
  }

  async function getCacheDirectory(): Promise<CacheDirectoryState> {
    const path = await getEffectiveRoot();
    try {
      await adapters.ensureDirectory(path);
      return createState(path, defaultRoot, true, busy, lastError);
    } catch {
      lastError = CACHE_DIRECTORY_UNAVAILABLE;
      return createState(path, defaultRoot, false, busy, lastError);
    }
  }

  async function migrate(targetPath: string): Promise<CacheDirectoryState> {
    if (busy) throw stableError(CACHE_DIRECTORY_BUSY);
    busy = true;
    lastError = null;
    let temporaryTarget: string | null = null;
    let targetValidated = false;
    try {
    const target = validateCacheRoot(targetPath);
    targetValidated = true;
    const source = await getEffectiveRoot();
    if (samePath(source, target)) {
        await adapters.ensureDirectory(target);
        return createState(target, defaultRoot, true, false, null);
    }

    temporaryTarget = join(
      dirname(target),
      `.${basename(target)}.${randomUUID()}.novus-cache-migration`,
    );
      await adapters.ensureDirectory(source);
      await adapters.copyDirectory(source, temporaryTarget);
      await adapters.verifyDirectoryCopy(source, temporaryTarget);

      if (adapters.replaceDirectoryAtomically !== undefined) {
        await adapters.replaceDirectoryAtomically(temporaryTarget, target);
      } else {
        await adapters.removeDirectory(target);
        await adapters.copyDirectory(temporaryTarget, target);
        await adapters.verifyDirectoryCopy(temporaryTarget, target);
        await adapters.removeDirectory(temporaryTarget);
      }

      await adapters.writeConfiguredPathAtomically(samePath(target, defaultRoot) ? null : target);
      try {
        await adapters.removeDirectory(source);
      } catch {
        // The new verified cache is already active. A stale regenerable cache
        // may be cleaned later, but must not invalidate the successful switch.
      }
      return createState(target, defaultRoot, true, false, null);
    } catch (error) {
      if (!targetValidated && error instanceof Error && error.message === CACHE_DIRECTORY_UNSAFE) {
        lastError = CACHE_DIRECTORY_UNSAFE;
        throw error;
      }
      lastError = CACHE_MIGRATION_FAILED;
      if (temporaryTarget !== null) {
        try {
          await adapters.removeDirectory(temporaryTarget);
        } catch {
          // Preserve the stable migration error and never attempt broad cleanup.
        }
      }
      throw stableError(CACHE_MIGRATION_FAILED);
    } finally {
      busy = false;
    }
  }

  return {
    getCacheDirectory,
    async chooseCacheDirectory() {
      if (busy) throw stableError(CACHE_DIRECTORY_BUSY);
      const selectedPath = await adapters.chooseDirectory();
      if (selectedPath === null) return null;
      try {
        return await migrate(selectedPath);
      } catch (error) {
        if (error instanceof Error && error.message === CACHE_DIRECTORY_UNSAFE) {
          lastError = CACHE_DIRECTORY_UNSAFE;
        }
        throw error;
      }
    },
    resetCacheDirectory() {
      return migrate(defaultRoot);
    },
    async openCacheDirectory() {
      if (busy) throw stableError(CACHE_DIRECTORY_BUSY);
      const state = await getCacheDirectory();
      if (!state.available) return { opened: false };
      try {
        return { opened: await adapters.openDirectory(state.path) };
      } catch {
        lastError = CACHE_DIRECTORY_UNAVAILABLE;
        return { opened: false };
      }
    },
  };
}

export function createNodeCacheDirectoryServiceAdapters(
  options: NodeCacheDirectoryAdaptersOptions,
): CacheDirectoryServiceAdapters {
  const normalizedDefaultRoot = resolve(options.defaultCacheRoot);
  return {
    defaultCacheRoot: options.defaultCacheRoot,
    stateFilePath: options.stateFilePath,
    chooseDirectory: options.chooseDirectory,
    openDirectory: options.openDirectory,
    async copyDirectory(source, target) {
      await mkdir(target);
      await ensureOwnershipMarker(target);
      await cp(source, target, { force: true, recursive: true });
    },
    verifyDirectoryCopy,
    async removeDirectory(path) {
      if (!await mayRemoveCacheDirectory(path, normalizedDefaultRoot)) {
        throw stableError(CACHE_DIRECTORY_UNSAFE);
      }
      await rm(path, { force: true, recursive: true });
    },
    async ensureDirectory(path) {
      await mkdir(path, { recursive: true });
      const metadata = await stat(path);
      if (!metadata.isDirectory()) throw stableError(CACHE_DIRECTORY_UNAVAILABLE);
      if (samePath(path, normalizedDefaultRoot)) await ensureOwnershipMarker(path);
    },
    async readConfiguredPath() {
      try {
        const parsed = JSON.parse(await readFile(options.stateFilePath, 'utf8')) as unknown;
        if (!isPlainRecord(parsed) || !('path' in parsed)) return null;
        return typeof parsed.path === 'string' ? parsed.path : null;
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) return null;
        throw stableError(CACHE_DIRECTORY_UNAVAILABLE);
      }
    },
    async writeConfiguredPathAtomically(path) {
      const stateDirectory = dirname(options.stateFilePath);
      const temporaryState = `${options.stateFilePath}.tmp`;
      await mkdir(stateDirectory, { recursive: true });
      await writeFile(temporaryState, `${JSON.stringify({ path })}\n`, 'utf8');
      await rename(temporaryState, options.stateFilePath);
    },
    async replaceDirectoryAtomically(source, target) {
      if (!await mayReplaceCacheDirectory(target)) throw stableError(CACHE_DIRECTORY_UNSAFE);
      await ensureOwnershipMarker(source);
      const backup = `${target}.novus-cache-backup`;
      if (await pathExists(backup)) throw stableError(CACHE_DIRECTORY_UNSAFE);
      let movedExistingTarget = false;
      try {
        await rename(target, backup);
        movedExistingTarget = true;
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error;
      }
      try {
        await rename(source, target);
        if (movedExistingTarget) await rm(backup, { force: true, recursive: true });
      } catch (error) {
        if (movedExistingTarget) {
          try {
            await rename(backup, target);
          } catch {
            // Preserve the original replacement failure without exposing paths.
          }
        }
        throw error;
      }
    },
  };
}

function createState(
  path: string,
  defaultRoot: string,
  available: boolean,
  busy: boolean,
  error: string | null,
): CacheDirectoryState {
  return {
    path,
    isDefault: samePath(path, defaultRoot),
    available,
    busy,
    error,
  };
}

function validateCacheRoot(path: string): string {
  if (typeof path !== 'string' || path.trim() === '') throw stableError(CACHE_DIRECTORY_UNSAFE);
  const normalized = resolve(path);
  if (samePath(normalized, parse(normalized).root)) throw stableError(CACHE_DIRECTORY_UNSAFE);
  return normalized;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight;
}

async function verifyDirectoryCopy(source: string, target: string): Promise<void> {
  const [sourceInventory, targetInventory] = await Promise.all([
    collectInventory(source),
    collectInventory(target),
  ]);
  if (sourceInventory.size !== targetInventory.size) throw stableError(CACHE_MIGRATION_FAILED);
  for (const [relativePath, size] of sourceInventory) {
    if (targetInventory.get(relativePath) !== size) throw stableError(CACHE_MIGRATION_FAILED);
  }
}

async function collectInventory(root: string): Promise<Map<string, number>> {
  const inventory = new Map<string, number>();
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = join(relativeDirectory, entry.name);
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        inventory.set(relativePath, (await stat(absolutePath)).size);
      } else {
        throw stableError(CACHE_MIGRATION_FAILED);
      }
    }
  }
  await visit(root, '');
  return inventory;
}

async function ensureOwnershipMarker(root: string): Promise<void> {
  await writeFile(join(root, CACHE_OWNERSHIP_MARKER), 'regenerable cache only\n', 'utf8');
}

async function mayReplaceCacheDirectory(path: string): Promise<boolean> {
  try {
    const metadata = await stat(path);
    if (!metadata.isDirectory()) return false;
    const entries = await readdir(path);
    return entries.length === 0 || entries.includes(CACHE_OWNERSHIP_MARKER);
  } catch (error) {
    return isNodeError(error, 'ENOENT');
  }
}

async function mayRemoveCacheDirectory(path: string, defaultRoot: string): Promise<boolean> {
  if (samePath(path, defaultRoot)) return true;
  try {
    const marker = await stat(join(path, CACHE_OWNERSHIP_MARKER));
    return marker.isFile();
  } catch (error) {
    return isNodeError(error, 'ENOENT') && !await pathExists(path);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}
function stableError(code: string): Error {
  return new Error(code);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error
    && 'code' in error
    && (error as Error & { code?: unknown }).code === code
  );
}
