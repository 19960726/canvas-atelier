import { lstat, open, realpath } from 'node:fs/promises';
import { win32 } from 'node:path';

import { isHistoryNetworkPath } from './history-network-path.js';

const MAX_LOCAL_MP4_BYTES = 4 * 1024 * 1024 * 1024;

interface LocalVideoFileStats {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  readonly size: number;
}

interface LocalVideoFileHandle {
  close(): Promise<void>;
  createReadStream(options: { readonly autoClose: false }): NodeJS.ReadableStream;
  stat(): Promise<LocalVideoFileStats>;
}

export interface LocalVideoSourceFileSystem {
  lstat(sourcePath: string): Promise<LocalVideoFileStats>;
  open(sourcePath: string, flags: 'r'): Promise<LocalVideoFileHandle>;
}

export interface SafeLocalMp4Source {
  readonly byteSize: number;
  close(): Promise<void>;
  readonly stream: NodeJS.ReadableStream;
}

export interface LocalVideoPathValidationOptions {
  readonly fileSystem?: Pick<LocalVideoSourceFileSystem, 'lstat'> & {
    realpath(sourcePath: string): Promise<string>;
  };
  readonly isNetworkPath?: (sourcePath: string) => Promise<boolean>;
}

type LocalVideoPathValidator = (sourcePath: string) => Promise<string | null>;

const defaultFileSystem: LocalVideoSourceFileSystem = { lstat, open };
const defaultPathFileSystem = { lstat, realpath };

export async function openSafeLocalMp4Source(
  sourcePath: string,
  fileSystem: LocalVideoSourceFileSystem = defaultFileSystem,
  validatePath: LocalVideoPathValidator = validateSafeLocalVideoPath,
): Promise<SafeLocalMp4Source | null> {
  if (!isSafeLocalMp4Path(sourcePath)) return null;

  const canonicalBefore = await validatePath(sourcePath);
  if (canonicalBefore === null) return null;

  let before: LocalVideoFileStats;
  try {
    before = await fileSystem.lstat(sourcePath);
  } catch {
    return null;
  }
  if (!isAllowedFileStats(before)) return null;

  let handle: LocalVideoFileHandle;
  try {
    handle = await fileSystem.open(sourcePath, 'r');
  } catch {
    return null;
  }

  try {
    const opened = await handle.stat();
    const after = await fileSystem.lstat(sourcePath);
    const canonicalAfter = await validatePath(sourcePath);
    if (
      !isAllowedFileStats(opened)
      || !isAllowedFileStats(after)
      || canonicalAfter === null
      || normalizePathIdentity(canonicalBefore) !== normalizePathIdentity(canonicalAfter)
      || !sameFileIdentity(before, opened)
      || !sameFileIdentity(opened, after)
    ) {
      await handle.close().catch(() => undefined);
      return null;
    }

    let closed = false;
    return {
      byteSize: opened.size,
      async close() {
        if (closed) return;
        closed = true;
        await handle.close();
      },
      stream: handle.createReadStream({ autoClose: false }),
    };
  } catch {
    await handle.close().catch(() => undefined);
    return null;
  }
}

export async function validateSafeLocalVideoPath(
  sourcePath: string,
  options: LocalVideoPathValidationOptions = {},
): Promise<string | null> {
  if (!isSafeLocalMp4Path(sourcePath)) return null;
  const fileSystem = options.fileSystem ?? defaultPathFileSystem;
  const isNetworkPath = options.isNetworkPath ?? isHistoryNetworkPath;
  try {
    if (await isNetworkPath(sourcePath)) return null;
    const parsed = win32.parse(sourcePath);
    let current = parsed.root;
    const relativeSegments = sourcePath.slice(parsed.root.length).split(/[\\/]+/u).filter(Boolean);
    for (const segment of relativeSegments) {
      current = win32.join(current, segment);
      if ((await fileSystem.lstat(current)).isSymbolicLink()) return null;
    }
    const canonicalPath = await fileSystem.realpath(sourcePath);
    if (await isNetworkPath(canonicalPath)) return null;
    return isSafeLocalMp4Path(canonicalPath) ? canonicalPath : null;
  } catch {
    return null;
  }
}

function isSafeLocalMp4Path(sourcePath: string): boolean {
  return sourcePath.length > 0
    && sourcePath.length <= 32_767
    && win32.isAbsolute(sourcePath)
    && /^[a-zA-Z]:\\/u.test(sourcePath)
    && win32.extname(sourcePath).toLocaleLowerCase() === '.mp4';
}

function isAllowedFileStats(stats: LocalVideoFileStats): boolean {
  return stats.isFile()
    && !stats.isSymbolicLink()
    && Number.isSafeInteger(stats.size)
    && stats.size > 0
    && stats.size <= MAX_LOCAL_MP4_BYTES;
}

function sameFileIdentity(left: LocalVideoFileStats, right: LocalVideoFileStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size;
}

function normalizePathIdentity(path: string): string {
  return win32.normalize(path).toLocaleLowerCase();
}
