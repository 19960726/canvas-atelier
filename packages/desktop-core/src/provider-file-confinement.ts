import { dirname, normalize, resolve, sep } from 'node:path';

import type { FileSystem } from './file-system.js';
import { createProviderBridgeError, type ProviderBridgeErrorCode } from './provider-contracts.js';

const CREDENTIALS_FILE = 'provider-credentials.json';
const TASK_MAPPINGS_FILE = 'provider-task-mappings.json';
const CREDENTIALS_LOCK_FILE = `${CREDENTIALS_FILE}.lock`;
const TASK_MAPPINGS_LOCK_FILE = `${TASK_MAPPINGS_FILE}.lock`;

type ConfinementErrorCode = Extract<ProviderBridgeErrorCode, 'CREDENTIALS_LOCKED' | 'PROVIDER_UNAVAILABLE'>;

export function confinedCredentialsPath(appDataRoot: string): string {
  return confinedAppDataPath(appDataRoot, CREDENTIALS_FILE, 'CREDENTIALS_LOCKED', 'Provider credential path is invalid');
}

export function confinedCredentialsLockPath(appDataRoot: string): string {
  return confinedAppDataPath(appDataRoot, CREDENTIALS_LOCK_FILE, 'CREDENTIALS_LOCKED', 'Provider credential path is invalid');
}

export function confinedProviderTaskMappingsPath(appDataRoot: string): string {
  return confinedAppDataPath(appDataRoot, TASK_MAPPINGS_FILE, 'PROVIDER_UNAVAILABLE', 'Provider task mapping path is invalid');
}

export function confinedProviderTaskMappingsLockPath(appDataRoot: string): string {
  return confinedAppDataPath(appDataRoot, TASK_MAPPINGS_LOCK_FILE, 'PROVIDER_UNAVAILABLE', 'Provider task mapping path is invalid');
}

export async function assertConfinedProviderTaskPathForWrite(
  fileSystem: FileSystem,
  appDataRoot: string,
  targetPath: string,
): Promise<void> {
  await assertConfinedAppDataPathForWrite(
    fileSystem,
    appDataRoot,
    targetPath,
    'PROVIDER_UNAVAILABLE',
    'Provider task mapping path is invalid',
  );
}

export async function assertConfinedProviderTaskPathForRead(
  fileSystem: FileSystem,
  appDataRoot: string,
  targetPath: string,
): Promise<void> {
  await assertConfinedAppDataPathForRead(
    fileSystem,
    appDataRoot,
    targetPath,
    'PROVIDER_UNAVAILABLE',
    'Provider task mapping path is invalid',
  );
}

export async function assertConfinedAppDataPathForWrite(
  fileSystem: FileSystem,
  appDataRoot: string,
  targetPath: string,
  errorCode: ConfinementErrorCode,
  errorMessage: string,
): Promise<void> {
  await rejectSymlinkTarget(fileSystem, appDataRoot, errorCode, errorMessage);
  await rejectSymlinkTarget(fileSystem, targetPath, errorCode, errorMessage);
  if (fileSystem.realpath === undefined) return;
  const realRoot = normalizeRealPath(await fileSystem.realpath(resolve(appDataRoot)));
  const realParent = normalizeRealPath(await fileSystem.realpath(dirname(targetPath)));
  if (realParent !== realRoot) {
    throw createProviderBridgeError(errorCode, errorMessage);
  }
}

export async function assertConfinedAppDataPathForRead(
  fileSystem: FileSystem,
  appDataRoot: string,
  targetPath: string,
  errorCode: ConfinementErrorCode,
  errorMessage: string,
): Promise<void> {
  await rejectSymlinkTarget(fileSystem, appDataRoot, errorCode, errorMessage);
  await rejectSymlinkTarget(fileSystem, targetPath, errorCode, errorMessage);
  if (fileSystem.realpath === undefined) return;
  const realRoot = normalizeRealPath(await fileSystem.realpath(resolve(appDataRoot)));
  try {
    const realTarget = normalizeRealPath(await fileSystem.realpath(targetPath));
    if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${sep}`)) {
      throw createProviderBridgeError(errorCode, errorMessage);
    }
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    const realParent = normalizeRealPath(await fileSystem.realpath(dirname(targetPath)));
    if (realParent !== realRoot) {
      throw createProviderBridgeError(errorCode, errorMessage);
    }
  }
}

export async function rollbackConfirmedInRootFile(
  fileSystem: FileSystem,
  appDataRoot: string,
  targetPath: string,
): Promise<void> {
  try {
    if (fileSystem.lstat === undefined || fileSystem.realpath === undefined) return;
    const root = normalizeRealPath(await fileSystem.realpath(resolve(appDataRoot)));
    const parent = normalizeRealPath(await fileSystem.realpath(dirname(targetPath)));
    if (parent !== root) return;
    const stat = await fileSystem.lstat(targetPath);
    if (!stat.isFile() || stat.isSymbolicLink?.()) return;
    await fileSystem.rm(targetPath, { force: true });
  } catch {
    // Rollback is best-effort after the provider-domain error is already known.
  }
}

function confinedAppDataPath(
  appDataRoot: string,
  fileName: string,
  errorCode: ConfinementErrorCode,
  errorMessage: string,
): string {
  const root = resolve(appDataRoot);
  const target = resolve(root, fileName);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw createProviderBridgeError(errorCode, errorMessage);
  }
  return target;
}

async function rejectSymlinkTarget(
  fileSystem: FileSystem,
  targetPath: string,
  errorCode: ConfinementErrorCode,
  errorMessage: string,
): Promise<void> {
  if (fileSystem.lstat === undefined) return;
  try {
    const stat = await fileSystem.lstat(targetPath);
    if (stat.isSymbolicLink?.() === true) {
      throw createProviderBridgeError(errorCode, errorMessage);
    }
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }
}

function normalizeRealPath(path: string): string {
  return normalize(resolve(path));
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
