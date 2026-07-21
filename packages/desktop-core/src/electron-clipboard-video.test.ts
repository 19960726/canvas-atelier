import { describe, expect, it } from 'vitest';
import { win32 } from 'node:path';

import { createElectronClipboardVideoAdapter } from './electron-clipboard-video';

describe('Electron clipboard video adapter', () => {
  it('reads one Windows Explorer FileNameW MP4 without exposing other clipboard data', async () => {
    const sourcePath = localPath('C:', 'Media', 'turntable.mp4');
    const adapter = createElectronClipboardVideoAdapter({
      availableFormats: () => ['FileNameW', 'text/plain'],
      readBuffer: (format) => format === 'FileNameW'
        ? Buffer.from(`${sourcePath}\0`, 'utf16le')
        : Buffer.from('ignored'),
    });

    await expect(adapter.readVideoPath()).resolves.toEqual({ sourcePath });
  });

  it('reads one wide CF_HDROP MP4 entry', async () => {
    const sourcePath = localPath('D:', 'Projects', 'clip.mp4');
    const adapter = createElectronClipboardVideoAdapter({
      availableFormats: () => ['CF_HDROP'],
      readBuffer: () => createWideDropFiles([sourcePath]),
    });

    await expect(adapter.readVideoPath()).resolves.toEqual({ sourcePath });
  });

  it('reads one ANSI FileName MP4 entry for older Windows clipboard producers', async () => {
    const sourcePath = localPath('C:', 'Media', 'legacy.mp4');
    const adapter = createElectronClipboardVideoAdapter({
      availableFormats: () => ['FileName'],
      readBuffer: () => Buffer.from(`${sourcePath}\0`, 'latin1'),
    });

    await expect(adapter.readVideoPath()).resolves.toEqual({ sourcePath });
  });

  it.each([
    ['FileNameW without a terminator', ['FileNameW'], Buffer.from(localPath('C:', 'Media', 'clip.mp4'), 'utf16le')],
    ['CF_HDROP without the double terminator', ['CF_HDROP'], createWideDropFiles([localPath('C:', 'Media', 'clip.mp4')]).subarray(0, -2)],
    ['CF_HDROP with an invalid offset', ['CF_HDROP'], createWideDropFiles([localPath('C:', 'Media', 'clip.mp4')], 8)],
    ['CF_HDROP with an odd wide offset', ['CF_HDROP'], createWideDropFiles([localPath('C:', 'Media', 'clip.mp4')], 21)],
    ['CF_HDROP with odd UTF-16 bytes', ['CF_HDROP'], createWideDropFiles([localPath('C:', 'Media', 'clip.mp4')]).subarray(0, -1)],
    ['unknown clipboard format', ['text/plain'], Buffer.from('ignored')],
  ])('rejects malformed or unsupported clipboard file data: %s', async (_label, formats, bytes) => {
    const adapter = createElectronClipboardVideoAdapter({
      availableFormats: () => formats,
      readBuffer: () => bytes,
    });

    await expect(adapter.readVideoPath()).resolves.toBeNull();
  });

  it.each([
    ['multiple files', createWideDropFiles([localPath('C:', 'a.mp4'), localPath('C:', 'b.mp4')])],
    ['network path', createWideDropFiles([networkPath('server', 'share', 'a.mp4')])],
    ['device path', createWideDropFiles([devicePath('C:', 'a.mp4')])],
    ['unsupported extension', createWideDropFiles([localPath('C:', 'a.mov')])],
    ['relative path', createWideDropFiles(['a.mp4'])],
  ])('rejects unsafe clipboard file selection: %s', async (_label, bytes) => {
    const adapter = createElectronClipboardVideoAdapter({
      availableFormats: () => ['CF_HDROP'],
      readBuffer: () => bytes,
    });

    await expect(adapter.readVideoPath()).resolves.toBeNull();
  });
});

function createWideDropFiles(paths: readonly string[], offset = 20): Buffer {
  const payload = Buffer.from(`${paths.join('\0')}\0\0`, 'utf16le');
  const payloadOffset = offset >= 20 ? offset : 20;
  const value = Buffer.alloc(payloadOffset + payload.length);
  value.writeUInt32LE(offset, 0);
  value.writeUInt32LE(1, 16);
  payload.copy(value, payloadOffset);
  return value;
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
