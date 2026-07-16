import { basename, dirname, join, resolve, sep } from 'node:path';

import { acquireConfinedFileLock, releaseConfinedFileLock } from './confined-file-lock.js';
import { NodeFileSystem, type FileSystem } from './file-system.js';
import {
  assertConfinedAppDataPathForRead,
  assertConfinedAppDataPathForWrite,
  deleteConfinedAppDataFile,
  writeConfinedAtomicUpdate,
} from './provider-file-confinement.js';
import {
  createProviderBridgeError,
  parseProviderConfigurationSnapshot,
  type ProviderBridgeProfile,
} from './provider-contracts.js';

const PROVIDER_CONFIGURATION_FILE = 'provider-configuration.json';
const PROVIDER_CONFIGURATION_LOCK_FILE = `${PROVIDER_CONFIGURATION_FILE}.lock`;

export interface ProviderConfigurationSnapshot {
  readonly baseUrl: string;
  readonly profiles: readonly ProviderBridgeProfile[];
}

export type PersistedProviderConfigurationState =
  | { readonly exists: false }
  | { readonly exists: true; readonly snapshot: ProviderConfigurationSnapshot };

export interface ProviderConfigurationStore {
  read(fallback: ProviderConfigurationSnapshot): Promise<ProviderConfigurationSnapshot>;
  readPersisted(): Promise<PersistedProviderConfigurationState>;
  write(snapshot: ProviderConfigurationSnapshot): Promise<void>;
  replace(snapshot: ProviderConfigurationSnapshot | null): Promise<void>;
}

export function createProviderConfigurationStore(options: {
  readonly appDataRoot: string;
  readonly fileSystem?: FileSystem;
}): ProviderConfigurationStore {
  const fileSystem = options.fileSystem ?? new NodeFileSystem();
  const targetPath = confinedProviderConfigurationPath(options.appDataRoot, PROVIDER_CONFIGURATION_FILE);
  const lockPath = confinedProviderConfigurationPath(options.appDataRoot, PROVIDER_CONFIGURATION_LOCK_FILE);

  return {
    async read(fallback) {
      const persisted = await readPersisted();
      return persisted.exists ? cloneConfiguration(persisted.snapshot) : cloneConfiguration(fallback);
    },
    readPersisted,
    async write(snapshot) {
      await replace(snapshot);
    },
    replace,
  };

  async function readPersisted(): Promise<PersistedProviderConfigurationState> {
    return withConfigurationLock(async () => {
      try {
        await assertConfigurationPathForRead(targetPath);
        const parsed = parseProviderConfigurationSnapshot(JSON.parse(await fileSystem.readFile(targetPath, 'utf8')) as unknown);
        return {
          exists: true,
          snapshot: cloneConfiguration(parsed),
        };
      } catch (error) {
        if (isMissingFileError(error)) return { exists: false };
        throw error;
      }
    });
  }

  async function replace(snapshot: ProviderConfigurationSnapshot | null): Promise<void> {
    if (snapshot === null) {
      await withConfigurationLock(async () => {
        await fileSystem.mkdir(options.appDataRoot, { recursive: true });
        await deleteConfinedAppDataFile(fileSystem, {
          appDataRoot: options.appDataRoot,
          targetPath,
          errorCode: 'PROVIDER_UNAVAILABLE',
          errorMessage: 'Provider configuration path is invalid',
        });
      });
      return;
    }

    const sanitized = parseProviderConfigurationSnapshot({
      version: 1,
      baseUrl: snapshot.baseUrl,
      profiles: snapshot.profiles,
    });
    await withConfigurationLock(async () => {
      await fileSystem.mkdir(options.appDataRoot, { recursive: true });
      await writeConfinedAtomicUpdate(fileSystem, {
        appDataRoot: options.appDataRoot,
        targetPath,
        data: `${JSON.stringify({
          version: 1,
          baseUrl: sanitized.baseUrl,
          profiles: sanitized.profiles,
        })}\n`,
        assertPathForRead: () => assertConfigurationPathForRead(targetPath),
        assertPathForWrite: () => assertConfigurationPathForWrite(targetPath),
        errorCode: 'PROVIDER_UNAVAILABLE',
        errorMessage: 'Provider configuration path is invalid',
      });
    });
  }

  async function withConfigurationLock<T>(operation: () => Promise<T>): Promise<T> {
    await fileSystem.mkdir(options.appDataRoot, { recursive: true });
    const lock = await acquireConfinedFileLock(lockPath, {
      fileSystem,
      assertPathForRead: assertConfigurationPathForRead,
      assertPathForWrite: assertConfigurationPathForWrite,
      timeoutMessage: 'Timed out waiting for provider configuration lock',
    });
    try {
      return await operation();
    } finally {
      await releaseConfinedFileLock(lock);
    }
  }

  async function assertConfigurationPathForRead(path: string): Promise<void> {
    await assertConfinedAppDataPathForRead(
      fileSystem,
      options.appDataRoot,
      path,
      'PROVIDER_UNAVAILABLE',
      'Provider configuration path is invalid',
    );
  }

  async function assertConfigurationPathForWrite(path: string): Promise<void> {
    await assertConfinedAppDataPathForWrite(
      fileSystem,
      options.appDataRoot,
      path,
      'PROVIDER_UNAVAILABLE',
      'Provider configuration path is invalid',
    );
  }
}

function cloneConfiguration(snapshot: ProviderConfigurationSnapshot): ProviderConfigurationSnapshot {
  return {
    baseUrl: snapshot.baseUrl,
    profiles: snapshot.profiles.map((profile) => ({
      ...profile,
      capabilities: [...profile.capabilities],
    })),
  };
}

function confinedProviderConfigurationPath(appDataRoot: string, fileName: string): string {
  if (basename(fileName) !== fileName || dirname(fileName) !== '.') {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Provider configuration path is invalid');
  }
  const root = resolve(appDataRoot);
  const target = resolve(join(root, fileName));
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Provider configuration path is invalid');
  }
  return target;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
