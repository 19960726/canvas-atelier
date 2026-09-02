import { constants } from 'node:fs';
import { copyFile, cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { createRecentProjectId } from './recent-project-store.js';

// Keep user data under the shipped product name. CanvasForge was the internal
// prototype name and remains a read-only migration source for existing users.
const STABLE_USER_DATA_DIRECTORY = 'Canvas Atelier';
const LEGACY_USER_DATA_DIRECTORIES = [
  'CanvasForge',
  join('@agent-canvas', 'desktop-modern'),
  join('@agent-canvas', 'desktop-legacy'),
] as const;

const PROVIDER_DATA_FILES = [
  'provider-active.json',
  'provider-credentials.json',
  'provider-configuration.json',
  'providers/relayme/provider-credentials.json',
  'providers/relayme/provider-configuration.json',
] as const;

const USER_DATA_FILES = [
  ...PROVIDER_DATA_FILES,
  'recent-projects.index.json',
] as const;

export function resolveStableUserDataRoot(appDataRoot: string): string {
  return join(appDataRoot, STABLE_USER_DATA_DIRECTORY);
}

export function resolveLegacyUserDataRoots(appDataRoot: string, currentUserDataRoot?: string): string[] {
  const stableRoot = normalize(resolveStableUserDataRoot(appDataRoot));
  const candidates = [
    currentUserDataRoot,
    ...LEGACY_USER_DATA_DIRECTORIES.map((directory) => join(appDataRoot, directory)),
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
  return [...new Set(candidates.map((candidate) => normalize(candidate)))]
    .filter((candidate) => candidate.toLocaleLowerCase('en-US') !== stableRoot.toLocaleLowerCase('en-US'));
}

export async function migrateLegacyProviderData(options: {
  readonly stableRoot: string;
  readonly legacyRoots: readonly string[];
}): Promise<{ readonly copied: readonly string[] }> {
  return migrateWhitelistedFiles(options, PROVIDER_DATA_FILES);
}

export async function migrateLegacyUserData(options: {
  readonly stableRoot: string;
  readonly legacyRoots: readonly string[];
}): Promise<{ readonly copied: readonly string[] }> {
  const fileResult = await migrateWhitelistedFiles(options, USER_DATA_FILES);
  const stableRoot = resolve(options.stableRoot);
  const copied = [...fileResult.copied];
  const stableProjectsRoot = resolve(stableRoot, 'projects');
  assertConfinedPath(stableRoot, stableProjectsRoot);

  for (const legacyRootValue of options.legacyRoots) {
    const legacyRoot = resolve(legacyRootValue);
    if (legacyRoot.toLocaleLowerCase('en-US') === stableRoot.toLocaleLowerCase('en-US')) continue;
    const legacyProjectsRoot = resolve(legacyRoot, 'projects');
    assertConfinedPath(legacyRoot, legacyProjectsRoot);
    if (!(await directoryExists(legacyProjectsRoot))) continue;

    await mkdir(stableProjectsRoot, { recursive: true });
    const entries = await readdir(legacyProjectsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.endsWith('.novus-project')) continue;
      const sourcePath = resolve(legacyProjectsRoot, entry.name);
      const targetPath = resolve(stableProjectsRoot, entry.name);
      assertConfinedPath(legacyProjectsRoot, sourcePath);
      assertConfinedPath(stableProjectsRoot, targetPath);
      if (await entryExists(targetPath)) continue;
      try {
        await cp(sourcePath, targetPath, { recursive: true, errorOnExist: true, force: false });
        copied.push(`projects/${entry.name}`);
      } catch (error) {
        if (!hasErrno(error, 'EEXIST')) throw error;
      }
    }
  }

  await rebaseRecentProjectIndex(stableRoot, options.legacyRoots);

  return { copied };
}

async function rebaseRecentProjectIndex(stableRoot: string, legacyRoots: readonly string[]): Promise<void> {
  const indexPath = resolve(stableRoot, 'recent-projects.index.json');
  if (!(await pathExists(indexPath))) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(indexPath, 'utf8'));
  } catch {
    return;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return;
  let changed = false;
  const entries = await Promise.all(parsed.entries.map(async (entry) => {
    if (!isRecord(entry) || typeof entry.root !== 'string') return entry;
    const rebasedRoot = rebaseProjectRoot(entry.root, stableRoot, legacyRoots);
    if (rebasedRoot === null || rebasedRoot === entry.root || !(await directoryExists(rebasedRoot))) return entry;
    changed = true;
    return { ...entry, recentProjectId: createRecentProjectId(rebasedRoot), root: rebasedRoot };
  }));
  if (changed) {
    await writeFile(indexPath, `${JSON.stringify({ ...parsed, entries })}\n`, 'utf8');
  }
}

function rebaseProjectRoot(root: string, stableRoot: string, legacyRoots: readonly string[]): string | null {
  const candidate = resolve(root);
  if (!candidate.toLocaleLowerCase('en-US').endsWith('.novus-project')) return null;
  for (const legacyRootValue of legacyRoots) {
    const legacyProjectsRoot = resolve(legacyRootValue, 'projects');
    const relativePath = relative(legacyProjectsRoot, candidate);
    if (relativePath.startsWith('..') || relativePath.includes(':') || relativePath.length === 0) continue;
    const stableCandidate = resolve(stableRoot, 'projects', relativePath);
    if (stableCandidate.toLocaleLowerCase('en-US') !== candidate.toLocaleLowerCase('en-US')) return stableCandidate;
  }
  return null;
}

async function migrateWhitelistedFiles(options: {
  readonly stableRoot: string;
  readonly legacyRoots: readonly string[];
}, relativePaths: readonly string[]): Promise<{ readonly copied: readonly string[] }> {
  const stableRoot = resolve(options.stableRoot);
  const copied: string[] = [];

  for (const relativePath of relativePaths) {
    const targetPath = resolve(stableRoot, ...relativePath.split('/'));
    assertConfinedPath(stableRoot, targetPath);
    if (await pathExists(targetPath)) continue;

    for (const legacyRootValue of options.legacyRoots) {
      const legacyRoot = resolve(legacyRootValue);
      if (legacyRoot.toLocaleLowerCase('en-US') === stableRoot.toLocaleLowerCase('en-US')) continue;
      const sourcePath = resolve(legacyRoot, ...relativePath.split('/'));
      assertConfinedPath(legacyRoot, sourcePath);
      if (!(await pathExists(sourcePath))) continue;

      await mkdir(dirname(targetPath), { recursive: true });
      try {
        await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
        copied.push(relativePath);
      } catch (error) {
        if (!hasErrno(error, 'EEXIST')) throw error;
      }
      break;
    }
  }

  return { copied };
}

function assertConfinedPath(root: string, targetPath: string): void {
  const relativePath = relative(root, targetPath);
  if (relativePath.startsWith('..') || relativePath.includes(':')) {
    throw new Error('USER_DATA_MIGRATION_PATH_OUTSIDE_ROOT');
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (hasErrno(error, 'ENOENT')) return false;
    throw error;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (hasErrno(error, 'ENOENT')) return false;
    throw error;
  }
}

async function entryExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (hasErrno(error, 'ENOENT')) return false;
    throw error;
  }
}

function hasErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
