import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { createProviderConfigurationStore } from './provider-configuration-store.js';
import { NodeFileSystem } from './file-system.js';
import {
  assertConfinedAppDataPathForRead,
  assertConfinedAppDataPathForWrite,
  rollbackConfirmedInRootFile,
  writeConfinedAtomicUpdate,
} from './provider-file-confinement.js';

describe('provider file confinement rollback', () => {
  it('rejects root swaps immediately before temp open without writing credential bytes outside', async () => {
    const harness = await createConfinementHarness('provider-credentials.json');
    try {
      await writeFile(harness.targetPath, 'safe-credential-before\n', 'utf8');
      await writeFile(harness.outsideTargetPath, 'outside-sentinel\n', 'utf8');

      const fileSystem = new PhaseBoundarySwapFileSystem({
        appDataRoot: harness.appDataRoot,
        outsideRoot: harness.outsideRoot,
        targetPath: harness.targetPath,
        outsideTargetPath: harness.outsideTargetPath,
        phase: 'before_open',
        mode: 'root_symlink',
      });

      await expect(writeConfinedAtomicUpdate(fileSystem, {
        appDataRoot: harness.appDataRoot,
        targetPath: harness.targetPath,
        data: 'rotated-credential-secret\n',
        assertPathForRead: () => assertConfinedAppDataPathForRead(
          fileSystem,
          harness.appDataRoot,
          harness.targetPath,
          'CREDENTIALS_LOCKED',
          'Provider credential metadata path is invalid',
        ),
        assertPathForWrite: () => assertConfinedAppDataPathForWrite(
          fileSystem,
          harness.appDataRoot,
          harness.targetPath,
          'CREDENTIALS_LOCKED',
          'Provider credential metadata path is invalid',
        ),
        errorCode: 'CREDENTIALS_LOCKED',
        errorMessage: 'Provider credential metadata path is invalid',
      })).rejects.toMatchObject({
        code: 'CREDENTIALS_LOCKED',
      });

      await expect(readFile(harness.outsideTargetPath, 'utf8')).resolves.toBe('outside-sentinel\n');
      await expect(readFile(harness.targetPath, 'utf8')).resolves.toBe('safe-credential-before\n');
      await expect(readDirectoryFiles(harness.outsideRoot)).resolves.not.toContain('rotated-credential-secret\n');
    } finally {
      await cleanupHarness(harness);
    }
  });

  it('rejects root swaps immediately before rename without writing ledger bytes outside', async () => {
    const harness = await createConfinementHarness('provider-task-mappings.json');
    try {
      await writeFile(harness.targetPath, 'safe-ledger-before\n', 'utf8');
      await writeFile(harness.outsideTargetPath, 'outside-sentinel\n', 'utf8');

      const fileSystem = new PhaseBoundarySwapFileSystem({
        appDataRoot: harness.appDataRoot,
        outsideRoot: harness.outsideRoot,
        targetPath: harness.targetPath,
        outsideTargetPath: harness.outsideTargetPath,
        phase: 'before_rename',
        mode: 'root_reparse',
      });

      await expect(writeConfinedAtomicUpdate(fileSystem, {
        appDataRoot: harness.appDataRoot,
        targetPath: harness.targetPath,
        data: 'new-ledger-secret\n',
        assertPathForRead: () => assertConfinedAppDataPathForRead(
          fileSystem,
          harness.appDataRoot,
          harness.targetPath,
          'PROVIDER_UNAVAILABLE',
          'Provider task mapping path is invalid',
        ),
        assertPathForWrite: () => assertConfinedAppDataPathForWrite(
          fileSystem,
          harness.appDataRoot,
          harness.targetPath,
          'PROVIDER_UNAVAILABLE',
          'Provider task mapping path is invalid',
        ),
        errorCode: 'PROVIDER_UNAVAILABLE',
        errorMessage: 'Provider task mapping path is invalid',
      })).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
      });

      await expect(readFile(harness.outsideTargetPath, 'utf8')).resolves.toBe('outside-sentinel\n');
      await expect(readFile(harness.targetPath, 'utf8')).resolves.toBe('safe-ledger-before\n');
      await expect(readDirectoryFiles(harness.outsideRoot)).resolves.not.toContain('new-ledger-secret\n');
    } finally {
      await cleanupHarness(harness);
    }
  });

  it('rejects swapped appDataRoot symlinks and restores previous original-root bytes', async () => {
    const harness = await createConfinementHarness('provider-credentials.json');
    try {
      await writeFile(harness.targetPath, 'safe-before\n', 'utf8');
      await writeFile(harness.outsideTargetPath, 'outside-sentinel\n', 'utf8');

      const fileSystem = new SwappedConfinementFileSystem({
        appDataRoot: harness.appDataRoot,
        outsideRoot: harness.outsideRoot,
        targetPath: harness.targetPath,
        outsideTargetPath: harness.outsideTargetPath,
        mode: 'root_symlink',
      });

      await expect(writeConfinedAtomicUpdate(fileSystem, {
        appDataRoot: harness.appDataRoot,
        targetPath: harness.targetPath,
        data: 'rotated-secret\n',
        assertPathForRead: () => assertConfinedAppDataPathForRead(
          fileSystem,
          harness.appDataRoot,
          harness.targetPath,
          'CREDENTIALS_LOCKED',
          'Provider credential metadata path is invalid',
        ),
        assertPathForWrite: () => assertConfinedAppDataPathForWrite(
          fileSystem,
          harness.appDataRoot,
          harness.targetPath,
          'CREDENTIALS_LOCKED',
          'Provider credential metadata path is invalid',
        ),
        errorCode: 'CREDENTIALS_LOCKED',
        errorMessage: 'Provider credential metadata path is invalid',
      })).rejects.toMatchObject({
        code: 'CREDENTIALS_LOCKED',
      });

      await expect(readFile(harness.outsideTargetPath, 'utf8')).resolves.toBe('outside-sentinel\n');
      await expect(readFile(harness.targetPath, 'utf8')).resolves.toBe('safe-before\n');
    } finally {
      await cleanupHarness(harness);
    }
  });

  it('rejects root identity swaps and removes confirmed original-root new targets when there was no previous file', async () => {
    const harness = await createConfinementHarness('provider-task-mappings.json');
    try {
      await writeFile(harness.outsideTargetPath, 'outside-sentinel\n', 'utf8');

      const fileSystem = new SwappedConfinementFileSystem({
        appDataRoot: harness.appDataRoot,
        outsideRoot: harness.outsideRoot,
        targetPath: harness.targetPath,
        outsideTargetPath: harness.outsideTargetPath,
        mode: 'root_reparse',
      });

      await expect(writeConfinedAtomicUpdate(fileSystem, {
        appDataRoot: harness.appDataRoot,
        targetPath: harness.targetPath,
        data: 'new-mapping\n',
        assertPathForRead: () => assertConfinedAppDataPathForRead(
          fileSystem,
          harness.appDataRoot,
          harness.targetPath,
          'PROVIDER_UNAVAILABLE',
          'Provider task mapping path is invalid',
        ),
        assertPathForWrite: () => assertConfinedAppDataPathForWrite(
          fileSystem,
          harness.appDataRoot,
          harness.targetPath,
          'PROVIDER_UNAVAILABLE',
          'Provider task mapping path is invalid',
        ),
        errorCode: 'PROVIDER_UNAVAILABLE',
        errorMessage: 'Provider task mapping path is invalid',
      })).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
      });

      await expect(readFile(harness.outsideTargetPath, 'utf8')).resolves.toBe('outside-sentinel\n');
      await expect(readFile(harness.targetPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await cleanupHarness(harness);
    }
  });

  it('does not remove outside files when rollback sees appDataRoot replaced by a symlink', async () => {
    const harness = await createConfinementHarness('provider-task-mappings.json');
    try {
      await writeFile(harness.targetPath, 'safe-target\n', 'utf8');
      await writeFile(harness.outsideTargetPath, 'outside-sentinel\n', 'utf8');

      const fileSystem = new SwappedConfinementFileSystem({
        appDataRoot: harness.appDataRoot,
        outsideRoot: harness.outsideRoot,
        targetPath: harness.targetPath,
        outsideTargetPath: harness.outsideTargetPath,
        mode: 'root_symlink',
        activateImmediately: true,
      });

      await rollbackConfirmedInRootFile(fileSystem, harness.appDataRoot, harness.targetPath);

      await expect(readFile(harness.outsideTargetPath, 'utf8')).resolves.toBe('outside-sentinel\n');
      await expect(readFile(harness.targetPath, 'utf8')).resolves.toBe('safe-target\n');
    } finally {
      await cleanupHarness(harness);
    }
  });

  it('does not remove outside files when rollback target identity changes', async () => {
    const harness = await createConfinementHarness('provider-task-mappings.json');
    try {
      await writeFile(harness.targetPath, 'safe-target\n', 'utf8');
      await writeFile(harness.outsideTargetPath, 'outside-sentinel\n', 'utf8');

      const fileSystem = new SwappedConfinementFileSystem({
        appDataRoot: harness.appDataRoot,
        outsideRoot: harness.outsideRoot,
        targetPath: harness.targetPath,
        outsideTargetPath: harness.outsideTargetPath,
        mode: 'target_swap',
        activateImmediately: true,
      });

      await rollbackConfirmedInRootFile(fileSystem, harness.appDataRoot, harness.targetPath);

      await expect(readFile(harness.outsideTargetPath, 'utf8')).resolves.toBe('outside-sentinel\n');
      await expect(readFile(harness.targetPath, 'utf8')).resolves.toBe('safe-target\n');
    } finally {
      await cleanupHarness(harness);
    }
  });

  it('does not delete an outside sentinel when configuration rollback sees the root identity swap after its check', async () => {
    const harness = await createConfinementHarness('provider-configuration.json');
    try {
      await writeFile(harness.targetPath, '{"version":1,"baseUrl":"https://safe.example","profiles":[]}\n', 'utf8');
      await writeFile(harness.outsideTargetPath, 'outside-sentinel\n', 'utf8');
      const fileSystem = new DeleteSwapConfigurationFileSystem({
        appDataRoot: harness.appDataRoot,
        outsideRoot: harness.outsideRoot,
        outsideTargetPath: harness.outsideTargetPath,
        targetPath: harness.targetPath,
        mode: 'root_parent_swap',
      });
      const store = createProviderConfigurationStore({
        appDataRoot: harness.appDataRoot,
        fileSystem,
      });

      await expect(store.replace(null)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });

      await expect(readFile(harness.outsideTargetPath, 'utf8')).resolves.toBe('outside-sentinel\n');
      await expect(readFile(harness.targetPath, 'utf8')).resolves.toContain('"baseUrl":"https://safe.example"');
    } finally {
      await cleanupHarness(harness);
    }
  });

  it('does not delete an outside sentinel when configuration rollback sees the target identity swap after its check', async () => {
    const harness = await createConfinementHarness('provider-configuration.json');
    try {
      await writeFile(harness.targetPath, '{"version":1,"baseUrl":"https://safe.example","profiles":[]}\n', 'utf8');
      await writeFile(harness.outsideTargetPath, 'outside-sentinel\n', 'utf8');
      const fileSystem = new DeleteSwapConfigurationFileSystem({
        appDataRoot: harness.appDataRoot,
        outsideRoot: harness.outsideRoot,
        outsideTargetPath: harness.outsideTargetPath,
        targetPath: harness.targetPath,
        mode: 'target_swap',
      });
      const store = createProviderConfigurationStore({
        appDataRoot: harness.appDataRoot,
        fileSystem,
      });

      await expect(store.replace(null)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });

      await expect(readFile(harness.outsideTargetPath, 'utf8')).resolves.toBe('outside-sentinel\n');
      await expect(readFile(harness.targetPath, 'utf8')).resolves.toContain('"baseUrl":"https://safe.example"');
    } finally {
      await cleanupHarness(harness);
    }
  });
});

type SwapMode = 'root_symlink' | 'root_reparse' | 'target_swap';
type PhaseBoundarySwap = 'before_open' | 'before_rename';
type DeleteSwapMode = 'root_parent_swap' | 'target_swap';

class DeleteSwapConfigurationFileSystem extends NodeFileSystem {
  private swapped = false;
  private parentRealpathCount = 0;

  constructor(
    private readonly options: {
      readonly appDataRoot: string;
      readonly outsideRoot: string;
      readonly outsideTargetPath: string;
      readonly targetPath: string;
      readonly mode: DeleteSwapMode;
    },
  ) {
    super();
  }

  override async lstat(path: string) {
    return super.lstat(this.translatePath(path));
  }

  override async readFile(path: string, encoding: BufferEncoding) {
    return super.readFile(this.translatePath(path), encoding);
  }

  override async realpath(path: string) {
    if (!this.swapped && path === dirname(this.options.targetPath)) {
      const resolved = await super.realpath(path);
      this.parentRealpathCount += 1;
      if (this.parentRealpathCount >= 1) {
        this.swapped = true;
      }
      return resolved;
    }
    if (this.swapped && this.options.mode === 'root_parent_swap' && (path === this.options.appDataRoot || path === dirname(this.options.targetPath))) {
      return this.options.outsideRoot;
    }
    if (this.swapped && path === this.options.targetPath) {
      return this.options.outsideTargetPath;
    }
    return super.realpath(this.translatePath(path));
  }

  override async rm(path: string, options?: { force?: boolean; recursive?: boolean }) {
    await super.rm(this.translatePath(path), options);
  }

  private translatePath(path: string): string {
    if (!this.swapped) return path;
    if (path === this.options.targetPath) return this.options.outsideTargetPath;
    return path;
  }
}

class PhaseBoundarySwapFileSystem extends NodeFileSystem {
  private swapped = false;
  private tempLstatCount = 0;

  constructor(
    private readonly options: {
      readonly appDataRoot: string;
      readonly outsideRoot: string;
      readonly outsideTargetPath: string;
      readonly targetPath: string;
      readonly mode: Extract<SwapMode, 'root_symlink' | 'root_reparse'>;
      readonly phase: PhaseBoundarySwap;
    },
  ) {
    super();
  }

  override async lstat(path: string) {
    if (!this.swapped && path.includes('.tmp-')) {
      this.tempLstatCount += 1;
      if (this.options.phase === 'before_open'
        || (this.options.phase === 'before_rename' && this.tempLstatCount >= 2)) {
        this.swapped = true;
      }
    }
    if (this.swapped && this.options.mode === 'root_symlink' && path === this.options.appDataRoot) {
      return createDirectoryStat(true) as Awaited<ReturnType<NodeFileSystem['lstat']>>;
    }
    return super.lstat(this.translatePath(path));
  }

  override async open(path: string, flags: string) {
    if (this.options.phase === 'before_open' && path.includes('.tmp-')) {
      this.swapped = true;
    }
    return super.open(this.translatePath(path), flags);
  }

  override async readFile(path: string, encoding: BufferEncoding) {
    return super.readFile(this.translatePath(path), encoding);
  }

  override async readFileBuffer(path: string) {
    return super.readFileBuffer(this.translatePath(path));
  }

  override async realpath(path: string) {
    if (this.swapped
      && (path === this.options.appDataRoot || path === dirname(this.options.targetPath))) {
      return this.options.outsideRoot;
    }
    if (this.swapped && path === this.options.targetPath) {
      return this.options.outsideTargetPath;
    }
    return super.realpath(this.translatePath(path));
  }

  override async rename(source: string, destination: string) {
    if (this.options.phase === 'before_rename' && destination === this.options.targetPath) {
      const sourceBytes = await super.readFile(source, 'utf8');
      this.swapped = true;
      await super.writeFile(this.translatePath(source), sourceBytes, 'utf8');
    }
    await super.rename(this.translatePath(source), this.translatePath(destination));
  }

  override async rm(path: string, options?: { force?: boolean; recursive?: boolean }) {
    await super.rm(this.translatePath(path), options);
  }

  override async stat(path: string) {
    return super.stat(this.translatePath(path));
  }

  override async unlink(path: string) {
    await super.unlink(this.translatePath(path));
  }

  override async writeFile(path: string, data: string, encoding: BufferEncoding) {
    await super.writeFile(this.translatePath(path), data, encoding);
  }

  private translatePath(path: string): string {
    if (!this.swapped) return path;
    if (path === this.options.appDataRoot) return this.options.outsideRoot;
    if (path === this.options.targetPath) return this.options.outsideTargetPath;
    if (path.startsWith(`${this.options.appDataRoot}\\`) || path.startsWith(`${this.options.appDataRoot}/`)) {
      return join(this.options.outsideRoot, path.slice(this.options.appDataRoot.length + 1));
    }
    return path;
  }
}

class SwappedConfinementFileSystem extends NodeFileSystem {
  private swapped: boolean;

  constructor(
    private readonly options: {
      readonly activateImmediately?: boolean;
      readonly appDataRoot: string;
      readonly outsideRoot: string;
      readonly outsideTargetPath: string;
      readonly targetPath: string;
      readonly mode: SwapMode;
    },
  ) {
    super();
    this.swapped = options.activateImmediately === true;
  }

  override async lstat(path: string) {
    if (this.swapped && this.options.mode === 'root_symlink' && path === this.options.appDataRoot) {
      return createDirectoryStat(true) as Awaited<ReturnType<NodeFileSystem['lstat']>>;
    }
    return super.lstat(this.translatePath(path));
  }

  override open(path: string, flags: string) {
    return super.open(this.translatePath(path), flags);
  }

  override async readFile(path: string, encoding: BufferEncoding) {
    return super.readFile(this.translatePath(path), encoding);
  }

  override async readFileBuffer(path: string) {
    return super.readFileBuffer(this.translatePath(path));
  }

  override async realpath(path: string) {
    if (!this.swapped) {
      return super.realpath(path);
    }
    if ((this.options.mode === 'root_symlink' || this.options.mode === 'root_reparse')
      && (path === this.options.appDataRoot || path === dirname(this.options.targetPath))) {
      return this.options.outsideRoot;
    }
    if ((this.options.mode === 'root_symlink'
      || this.options.mode === 'root_reparse'
      || this.options.mode === 'target_swap')
      && path === this.options.targetPath) {
      return this.options.outsideTargetPath;
    }
    return super.realpath(path);
  }

  override async rename(source: string, destination: string) {
    await super.rename(source, destination);
    if (destination === this.options.targetPath) {
      this.swapped = true;
    }
  }

  override async rm(path: string, options?: { force?: boolean; recursive?: boolean }) {
    await super.rm(this.translatePath(path), options);
  }

  override async stat(path: string) {
    return super.stat(this.translatePath(path));
  }

  override async unlink(path: string) {
    await super.unlink(this.translatePath(path));
  }

  override async writeFile(path: string, data: string, encoding: BufferEncoding) {
    await super.writeFile(this.translatePath(path), data, encoding);
  }

  private translatePath(path: string): string {
    if (!this.swapped) return path;
    if (path === this.options.targetPath) return this.options.outsideTargetPath;
    return path;
  }
}

function createDirectoryStat(symbolicLink: boolean) {
  return {
    isDirectory: () => true,
    isFile: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => symbolicLink,
  };
}

async function createConfinementHarness(fileName: string): Promise<{
  readonly appDataRoot: string;
  readonly outsideRoot: string;
  readonly outsideTargetPath: string;
  readonly root: string;
  readonly targetPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'novus-confinement-'));
  const appDataRoot = join(root, 'app-data');
  const outsideRoot = join(root, 'outside');
  await writeFile(join(root, '.keep'), '', 'utf8');
  await new NodeFileSystem().mkdir(appDataRoot, { recursive: true });
  await new NodeFileSystem().mkdir(outsideRoot, { recursive: true });
  return {
    appDataRoot,
    outsideRoot,
    outsideTargetPath: join(outsideRoot, fileName),
    root,
    targetPath: join(appDataRoot, fileName),
  };
}

async function cleanupHarness(harness: { readonly root: string }): Promise<void> {
  await rm(harness.root, { force: true, recursive: true });
}

async function readDirectoryFiles(root: string): Promise<string[]> {
  const names = await readdir(root);
  return await Promise.all(names.map((name) => readFile(join(root, name), 'utf8')));
}
