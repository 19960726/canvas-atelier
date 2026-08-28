import { basename, dirname, join, resolve, sep } from 'node:path';

import { acquireConfinedFileLock, releaseConfinedFileLock } from './confined-file-lock.js';
import { NodeFileSystem, type FileSystem } from './file-system.js';
import {
  assertConfinedAppDataPathForRead,
  assertConfinedAppDataPathForWrite,
  writeConfinedAtomicUpdate,
} from './provider-file-confinement.js';
import { createProviderBridgeError, type ProviderBridgeProvider } from './provider-contracts.js';

const PROVIDER_ACTIVE_FILE = 'provider-active.json';
const PROVIDER_ACTIVE_LOCK_FILE = `${PROVIDER_ACTIVE_FILE}.lock`;

export type ActiveProvider = ProviderBridgeProvider | null;

export interface ProviderActiveState {
  readonly activeProvider: ActiveProvider;
}

export interface ProviderActiveStoreOptions {
  readonly appDataRoot: string;
  readonly fileSystem?: FileSystem;
}

export class ProviderActiveStore {
  private readonly fileSystem: FileSystem;
  private readonly root: string;
  private readonly targetPath: string;
  private readonly lockPath: string;

  constructor(options: ProviderActiveStoreOptions) {
    this.fileSystem = options.fileSystem ?? new NodeFileSystem();
    this.root = resolve(options.appDataRoot);
    this.targetPath = confinedStatePath(this.root, PROVIDER_ACTIVE_FILE);
    this.lockPath = confinedStatePath(this.root, PROVIDER_ACTIVE_LOCK_FILE);
  }

  async getActiveProvider(): Promise<ProviderActiveState> {
    return this.withLock(() => this.readUnlocked());
  }

  async setActiveProvider(activeProvider: ActiveProvider): Promise<ProviderActiveState> {
    const state = parseActiveProviderState({ activeProvider });
    if (state === null) {
      throw createProviderBridgeError('INVALID_REQUEST', 'Active provider is invalid');
    }
    await this.withLock(async () => {
      await writeConfinedAtomicUpdate(this.fileSystem, {
        appDataRoot: this.root,
        targetPath: this.targetPath,
        data: `${JSON.stringify(state)}\n`,
        assertPathForRead: () => this.assertPathForRead(this.targetPath),
        assertPathForWrite: () => this.assertPathForWrite(this.targetPath),
        errorCode: 'PROVIDER_UNAVAILABLE',
        errorMessage: 'Active provider state path is invalid',
      });
    });
    return state;
  }

  private async readUnlocked(): Promise<ProviderActiveState> {
    try {
      await this.assertPathForRead(this.targetPath);
      return parseActiveProviderState(JSON.parse(await this.fileSystem.readFile(this.targetPath, 'utf8')) as unknown)
        ?? { activeProvider: null };
    } catch (error) {
      if (error instanceof SyntaxError || isMissingFileError(error)) return { activeProvider: null };
      throw error;
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.fileSystem.mkdir(this.root, { recursive: true });
    const lock = await acquireConfinedFileLock(this.lockPath, {
      fileSystem: this.fileSystem,
      assertPathForRead: (path) => this.assertPathForRead(path),
      assertPathForWrite: (path) => this.assertPathForWrite(path),
      timeoutMessage: 'Timed out waiting for active provider state lock',
    });
    try {
      return await operation();
    } finally {
      await releaseConfinedFileLock(lock);
    }
  }

  private async assertPathForRead(path: string): Promise<void> {
    await assertConfinedAppDataPathForRead(
      this.fileSystem,
      this.root,
      path,
      'PROVIDER_UNAVAILABLE',
      'Active provider state path is invalid',
    );
  }

  private async assertPathForWrite(path: string): Promise<void> {
    await assertConfinedAppDataPathForWrite(
      this.fileSystem,
      this.root,
      path,
      'PROVIDER_UNAVAILABLE',
      'Active provider state path is invalid',
    );
  }
}

export function createProviderActiveStore(options: ProviderActiveStoreOptions): ProviderActiveStore {
  return new ProviderActiveStore(options);
}

function parseActiveProviderState(value: unknown): ProviderActiveState | null {
  if (!isPlainRecord(value) || Object.keys(value).length !== 1) return null;
  if (value.activeProvider !== null && value.activeProvider !== 'comfly' && value.activeProvider !== 'relayme') return null;
  return { activeProvider: value.activeProvider };
}

function confinedStatePath(root: string, fileName: string): string {
  if (basename(fileName) !== fileName || dirname(fileName) !== '.') {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Active provider state path is invalid');
  }
  const target = resolve(join(root, fileName));
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Active provider state path is invalid');
  }
  return target;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
