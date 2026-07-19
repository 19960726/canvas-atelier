import { randomBytes } from 'node:crypto';
import { link, lstat, open, readFile, readdir, realpath, rename, rm, stat, truncate, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { normalizePersistenceError } from './persistence-error.js';

export interface FileHandleLike {
  close(): Promise<void>;
  sync(): Promise<void>;
  truncate?(length: number): Promise<void>;
  write?(data: Uint8Array): Promise<unknown>;
  writeFile(data: string | Uint8Array): Promise<void>;
}

export interface FileStatLike {
  readonly size?: number;
  readonly mtimeMs?: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isReparsePoint?(): boolean;
  isSymbolicLink?(): boolean;
}

export interface FileSystem {
  link?(source: string, destination: string): Promise<void>;
  lstat?(path: string): Promise<FileStatLike>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  open(path: string, flags: string): Promise<FileHandleLike>;
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
  readFileBuffer?(path: string): Promise<Uint8Array>;
  readdir(path: string): Promise<string[]>;
  realpath?(path: string): Promise<string>;
  rename(source: string, destination: string): Promise<void>;
  rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void>;
  stat(path: string): Promise<FileStatLike>;
  truncate?(path: string, length: number): Promise<void>;
  unlink(path: string): Promise<void>;
  writeFile(path: string, data: string, encoding: BufferEncoding): Promise<void>;
}

export class NodeFileSystem implements FileSystem {
  async link(source: string, destination: string) {
    await link(source, destination);
  }

  async lstat(path: string) {
    return lstat(path);
  }

  async mkdir(path: string, options?: { recursive?: boolean }) {
    await import('node:fs/promises').then((fs) => fs.mkdir(path, options));
  }

  async open(path: string, flags: string) {
    return open(path, flags);
  }

  async readFile(path: string, encoding: BufferEncoding) {
    return readFile(path, encoding);
  }

  async readFileBuffer(path: string) {
    return readFile(path);
  }

  async readdir(path: string) {
    return readdir(path);
  }

  async realpath(path: string) {
    return realpath(path);
  }

  async rename(source: string, destination: string) {
    await rename(source, destination);
  }

  async rm(path: string, options?: { force?: boolean; recursive?: boolean }) {
    await rm(path, options);
  }

  async stat(path: string) {
    return stat(path);
  }

  async truncate(path: string, length: number) {
    await truncate(path, length);
  }

  async unlink(path: string) {
    await unlink(path);
  }

  async writeFile(path: string, data: string, encoding: BufferEncoding) {
    await writeFile(path, data, encoding);
  }
}

export async function writeAtomic(
  fileSystem: FileSystem,
  targetPath: string,
  data: string | Uint8Array,
): Promise<void> {
  const tempPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.tmp-${randomBytes(8).toString('hex')}`,
  );
  let handle: FileHandleLike | null = null;
  let closed = false;

  try {
    handle = await fileSystem.open(tempPath, 'wx');
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    closed = true;
    await fileSystem.rename(tempPath, targetPath);
  } catch (error) {
    const primaryError = normalizePersistenceError(error, 'Atomic project write failed');
    if (handle !== null && !closed) {
      try {
        await handle.close();
      } catch {
        // Preserve the original failure.
      }
    }

    try {
      await fileSystem.rm(tempPath, { force: true });
    } catch {
      // Preserve the primary sanitized persistence failure.
    }
    throw primaryError;
  }
}
