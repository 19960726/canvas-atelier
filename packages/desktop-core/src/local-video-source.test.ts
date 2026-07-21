import { win32 } from 'node:path';
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { openSafeLocalMp4Source, validateSafeLocalVideoPath } from './local-video-source';

describe('local MP4 source validation', () => {
  it('opens and reads the same verified regular local MP4 handle', async () => {
    const close = vi.fn(async () => undefined);
    const file = createFileSystem({ close });

    const source = await openTestSource(localPath('C:', 'Media', 'clip.mp4'), file);

    expect(source).not.toBeNull();
    expect(source!.byteSize).toBe(1024);
    const chunks: Buffer[] = [];
    for await (const chunk of source!.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(Buffer.from('verified-mp4'));
    await source!.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    ['symbolic link', fileStats({ symbolicLink: true })],
    ['directory', fileStats({ file: false })],
    ['empty file', fileStats({ size: 0 })],
    ['oversized file', fileStats({ size: 4 * 1024 * 1024 * 1024 + 1 })],
  ])('rejects an unsafe file stat before opening: %s', async (_label, before) => {
    const open = vi.fn();

    await expect(openTestSource(localPath('C:', 'Media', 'clip.mp4'), {
      lstat: vi.fn(async () => before),
      open,
    })).resolves.toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it('rejects a file replaced between path validation and handle open', async () => {
    const close = vi.fn(async () => undefined);
    const before = fileStats({ dev: 10, ino: 20 });
    const opened = fileStats({ dev: 11, ino: 21 });

    await expect(openTestSource(localPath('C:', 'Media', 'clip.mp4'), createFileSystem({
      before,
      close,
      opened,
      after: before,
    }))).resolves.toBeNull();
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects a handle that grew beyond the MP4 size limit after the initial path check', async () => {
    const close = vi.fn(async () => undefined);
    const before = fileStats({ size: 1024 });

    await expect(openTestSource(localPath('C:', 'Media', 'clip.mp4'), createFileSystem({
      before,
      close,
      opened: fileStats({ size: 4 * 1024 * 1024 * 1024 + 1 }),
      after: before,
    }))).resolves.toBeNull();
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects a path whose identity or size changes after the verified handle is opened', async () => {
    const close = vi.fn(async () => undefined);
    const before = fileStats({ dev: 10, ino: 20, size: 1024 });

    await expect(openTestSource(localPath('C:', 'Media', 'clip.mp4'), createFileSystem({
      before,
      close,
      opened: before,
      after: fileStats({ dev: 10, ino: 21, size: 2048 }),
    }))).resolves.toBeNull();
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes the verified handle at most once', async () => {
    const close = vi.fn(async () => undefined);
    const source = await openTestSource(localPath('C:', 'Media', 'clip.mp4'), createFileSystem({ close }));

    expect(source).not.toBeNull();
    await source!.close();
    await source!.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects a path changed to a symbolic link after opening', async () => {
    const close = vi.fn(async () => undefined);
    const before = fileStats({ dev: 10, ino: 20 });

    await expect(openTestSource(localPath('C:', 'Media', 'clip.mp4'), createFileSystem({
      before,
      close,
      opened: before,
      after: fileStats({ dev: 10, ino: 20, symbolicLink: true }),
    }))).resolves.toBeNull();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([networkPath('server', 'share', 'clip.mp4'), devicePath('C:', 'clip.mp4'), 'clip.mp4', localPath('C:', 'clip.mov')])
    ('rejects an unsafe path form: %s', async (sourcePath) => {
      const open = vi.fn();
      await expect(openTestSource(sourcePath, {
        lstat: vi.fn(async () => fileStats()),
        open,
      })).resolves.toBeNull();
      expect(open).not.toHaveBeenCalled();
    });

  it('rejects a mapped network drive before inspecting the path', async () => {
    const lstat = vi.fn();

    await expect(validateSafeLocalVideoPath(localPath('Z:', 'Media', 'clip.mp4'), {
      fileSystem: { lstat, realpath: vi.fn() },
      isNetworkPath: vi.fn(async () => true),
    })).resolves.toBeNull();
    expect(lstat).not.toHaveBeenCalled();
  });

  it('rejects a regular file reached through a linked ancestor', async () => {
    const sourcePath = localPath('C:', 'Linked', 'Media', 'clip.mp4');

    await expect(validateSafeLocalVideoPath(sourcePath, {
      fileSystem: {
        lstat: vi.fn(async (path: string) => fileStats({
          file: path === sourcePath,
          symbolicLink: path === localPath('C:', 'Linked'),
        })),
        realpath: vi.fn(async () => sourcePath),
      },
      isNetworkPath: vi.fn(async () => false),
    })).resolves.toBeNull();
  });

  it('rejects a canonical path that resolves onto a network share', async () => {
    const sourcePath = localPath('C:', 'Media', 'clip.mp4');
    const canonicalPath = networkPath('server', 'share', 'clip.mp4');
    const isNetworkPath = vi.fn(async (path: string) => path === canonicalPath);

    await expect(validateSafeLocalVideoPath(sourcePath, {
      fileSystem: {
        lstat: vi.fn(async (path: string) => fileStats({ file: path === sourcePath })),
        realpath: vi.fn(async () => canonicalPath),
      },
      isNetworkPath,
    })).resolves.toBeNull();
    expect(isNetworkPath).toHaveBeenCalledWith(sourcePath);
    expect(isNetworkPath).toHaveBeenCalledWith(canonicalPath);
  });
});

function openTestSource(sourcePath: string, fileSystem: Parameters<typeof openSafeLocalMp4Source>[1]) {
  return openSafeLocalMp4Source(sourcePath, fileSystem, async (path) => path);
}

function createFileSystem(options: {
  readonly after?: TestStats;
  readonly before?: TestStats;
  readonly close?: () => Promise<void>;
  readonly opened?: TestStats;
} = {}) {
  const before = options.before ?? fileStats();
  const after = options.after ?? before;
  const opened = options.opened ?? before;
  const lstat = vi.fn()
    .mockResolvedValueOnce(before)
    .mockResolvedValue(after);
  return {
    lstat,
    open: vi.fn(async () => ({
      close: options.close ?? vi.fn(async () => undefined),
      createReadStream: () => Readable.from([Buffer.from('verified-mp4')]),
      stat: vi.fn(async () => opened),
    })),
  };
}

interface TestStats {
  readonly dev: number;
  readonly ino: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  readonly size: number;
}

function fileStats(options: {
  readonly dev?: number;
  readonly file?: boolean;
  readonly ino?: number;
  readonly size?: number;
  readonly symbolicLink?: boolean;
} = {}): TestStats {
  return {
    dev: options.dev ?? 10,
    ino: options.ino ?? 20,
    isFile: () => options.file ?? true,
    isSymbolicLink: () => options.symbolicLink ?? false,
    size: options.size ?? 1024,
  };
}

function localPath(drive: string, ...segments: string[]): string {
  return [drive, ...segments].join(win32.sep);
}

function networkPath(...segments: string[]): string {
  return `${win32.sep}${win32.sep}${segments.join(win32.sep)}`;
}

function devicePath(drive: string, ...segments: string[]): string {
  return [win32.sep, win32.sep, '?', win32.sep, drive, win32.sep, ...segments].join('');
}
