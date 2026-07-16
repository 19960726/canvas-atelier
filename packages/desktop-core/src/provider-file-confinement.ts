import { randomBytes } from 'node:crypto';
import { basename, dirname, join, normalize, resolve, sep } from 'node:path';

import type { FileHandleLike, FileSystem } from './file-system.js';
import { createProviderBridgeError, type ProviderBridgeErrorCode } from './provider-contracts.js';

const CREDENTIALS_FILE = 'provider-credentials.json';
const TASK_MAPPINGS_FILE = 'provider-task-mappings.json';
const CREDENTIALS_LOCK_FILE = `${CREDENTIALS_FILE}.lock`;
const TASK_MAPPINGS_LOCK_FILE = `${TASK_MAPPINGS_FILE}.lock`;

type ConfinementErrorCode = Extract<ProviderBridgeErrorCode, 'CREDENTIALS_LOCKED' | 'PROVIDER_UNAVAILABLE'>;
interface ConfinementRootIdentity {
  readonly realRoot: string;
  readonly resolvedRoot: string;
}

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
  rootIdentity?: ConfinementRootIdentity,
): Promise<void> {
  try {
    if (!await canTouchConfirmedInRootFile(fileSystem, appDataRoot, targetPath, rootIdentity)) return;
    await fileSystem.rm(targetPath, { force: true });
  } catch {
    // Rollback is best-effort after the provider-domain error is already known.
  }
}

export async function writeConfinedAtomicUpdate(
  fileSystem: FileSystem,
  options: {
    readonly appDataRoot: string;
    readonly targetPath: string;
    readonly data: string | Uint8Array;
    readonly assertPathForRead: () => Promise<void>;
    readonly assertPathForWrite: () => Promise<void>;
    readonly errorCode: ConfinementErrorCode;
    readonly errorMessage: string;
  },
): Promise<void> {
  await options.assertPathForWrite();
  const rootIdentity = await captureConfinementRootIdentity(fileSystem, options.appDataRoot);
  const previous = await readExistingTarget(fileSystem, options);
  const tempPath = join(
    dirname(options.targetPath),
    `.${basename(options.targetPath)}.tmp-${randomBytes(8).toString('hex')}`,
  );
  let handle: FileHandleLike | null = null;
  let closed = false;
  let replaced = false;

  try {
    handle = await fileSystem.open(tempPath, 'wx');
    await handle.writeFile(options.data);
    await handle.sync();
    await handle.close();
    closed = true;
    await fileSystem.rename(tempPath, options.targetPath);
    replaced = true;
    await assertOriginalRootPostWriteState(fileSystem, options, rootIdentity);
  } catch (error) {
    if (handle !== null && !closed) {
      try {
        await handle.close();
      } catch {
        // Preserve the original failure.
      }
    }
    await fileSystem.rm(tempPath, { force: true });
    if (replaced) {
      await restoreConfirmedInRootTarget(fileSystem, options, previous, rootIdentity);
    }
    if (isProviderDomainError(error)) throw error;
    throw createProviderBridgeError(options.errorCode, options.errorMessage);
  }
}

async function readExistingTarget(
  fileSystem: FileSystem,
  options: {
    readonly targetPath: string;
    readonly assertPathForRead: () => Promise<void>;
  },
): Promise<{ readonly existed: false } | { readonly existed: true; readonly data: string | Uint8Array }> {
  try {
    await options.assertPathForRead();
    return {
      existed: true,
      data: fileSystem.readFileBuffer === undefined
        ? await fileSystem.readFile(options.targetPath, 'utf8')
        : await fileSystem.readFileBuffer(options.targetPath),
    };
  } catch (error) {
    if (isMissingFileError(error)) return { existed: false };
    throw error;
  }
}

async function restoreConfirmedInRootTarget(
  fileSystem: FileSystem,
  options: {
    readonly appDataRoot: string;
    readonly targetPath: string;
  },
  previous: { readonly existed: false } | { readonly existed: true; readonly data: string | Uint8Array },
  rootIdentity: ConfinementRootIdentity,
): Promise<void> {
  try {
    if (!await canTouchConfirmedInRootFile(fileSystem, options.appDataRoot, options.targetPath, rootIdentity)) return;
    if (previous.existed) {
      const handle = await fileSystem.open(options.targetPath, 'w');
      try {
        await handle.writeFile(previous.data);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else {
      await fileSystem.rm(options.targetPath, { force: true });
    }
  } catch {
    // Do not touch uncertain paths further after the provider-domain failure.
  }
}

async function canTouchConfirmedInRootFile(
  fileSystem: FileSystem,
  appDataRoot: string,
  targetPath: string,
  rootIdentity?: ConfinementRootIdentity,
): Promise<boolean> {
  if (fileSystem.lstat === undefined || fileSystem.realpath === undefined) return false;
  if (await isSymlinkTarget(fileSystem, appDataRoot)) return false;
  const expectedRoot = rootIdentity?.realRoot ?? normalizeRealPath(resolve(appDataRoot));
  const currentRoot = normalizeRealPath(await fileSystem.realpath(resolve(appDataRoot)));
  if (currentRoot !== expectedRoot) return false;
  const parent = normalizeRealPath(await fileSystem.realpath(dirname(targetPath)));
  if (parent !== expectedRoot) return false;
  const target = normalizeRealPath(await fileSystem.realpath(targetPath));
  if (target === expectedRoot || !target.startsWith(`${expectedRoot}${sep}`)) return false;
  const stat = await fileSystem.lstat(targetPath);
  return stat.isFile() && stat.isSymbolicLink?.() !== true;
}

async function assertOriginalRootPostWriteState(
  fileSystem: FileSystem,
  options: {
    readonly appDataRoot: string;
    readonly targetPath: string;
    readonly assertPathForRead: () => Promise<void>;
    readonly errorCode: ConfinementErrorCode;
    readonly errorMessage: string;
  },
  rootIdentity: ConfinementRootIdentity,
): Promise<void> {
  await options.assertPathForRead();
  if (fileSystem.lstat === undefined || fileSystem.realpath === undefined) return;
  if (await isSymlinkTarget(fileSystem, options.appDataRoot)) {
    throw createProviderBridgeError(options.errorCode, options.errorMessage);
  }
  const currentRoot = normalizeRealPath(await fileSystem.realpath(resolve(options.appDataRoot)));
  if (currentRoot !== rootIdentity.realRoot) {
    throw createProviderBridgeError(options.errorCode, options.errorMessage);
  }
  const currentParent = normalizeRealPath(await fileSystem.realpath(dirname(options.targetPath)));
  if (currentParent !== rootIdentity.realRoot) {
    throw createProviderBridgeError(options.errorCode, options.errorMessage);
  }
  const currentTarget = normalizeRealPath(await fileSystem.realpath(options.targetPath));
  if (currentTarget === rootIdentity.realRoot || !currentTarget.startsWith(`${rootIdentity.realRoot}${sep}`)) {
    throw createProviderBridgeError(options.errorCode, options.errorMessage);
  }
  const stat = await fileSystem.lstat(options.targetPath);
  if (!stat.isFile() || stat.isSymbolicLink?.() === true) {
    throw createProviderBridgeError(options.errorCode, options.errorMessage);
  }
}

async function captureConfinementRootIdentity(
  fileSystem: FileSystem,
  appDataRoot: string,
): Promise<ConfinementRootIdentity> {
  const resolvedRoot = normalizeRealPath(resolve(appDataRoot));
  return {
    realRoot: fileSystem.realpath === undefined
      ? resolvedRoot
      : normalizeRealPath(await fileSystem.realpath(resolve(appDataRoot))),
    resolvedRoot,
  };
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

async function isSymlinkTarget(
  fileSystem: FileSystem,
  targetPath: string,
): Promise<boolean> {
  if (fileSystem.lstat === undefined) return false;
  try {
    const stat = await fileSystem.lstat(targetPath);
    return stat.isSymbolicLink?.() === true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

function normalizeRealPath(path: string): string {
  return normalize(resolve(path));
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isProviderDomainError(error: unknown): error is { readonly code: string; readonly retryable: boolean } {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && 'retryable' in error;
}
