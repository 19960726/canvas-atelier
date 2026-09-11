import { win32 } from 'node:path';

export interface TrustedClipboardVideoPath {
  readonly sourcePath: string;
}

export interface ClipboardVideoAdapter {
  readVideoPath(): Promise<TrustedClipboardVideoPath | null>;
}

interface ElectronClipboardFileLike {
  availableFormats(): string[];
  readBuffer(format: string): Uint8Array;
}

export function createElectronClipboardVideoAdapter(clipboard: ElectronClipboardFileLike): ClipboardVideoAdapter {
  return {
    async readVideoPath() {
      const formats = new Map(clipboard.availableFormats().map((format) => [format.toLocaleLowerCase(), format]));
      const dropFormat = formats.get('cf_hdrop');
      if (dropFormat !== undefined) {
        const paths = parseDropFiles(readClipboardBuffer(clipboard, dropFormat));
        return paths.length === 1 && isSafeLocalMp4Path(paths[0]!) ? { sourcePath: paths[0]! } : null;
      }
      // Electron 43 can advertise a Windows Forms/Explorer file drop only as
      // text/uri-list while the native FileNameW buffer remains readable.
      // Probe the two narrow Windows filename formats and keep the existing
      // absolute local MP4 validation as the trust boundary.
      const wideFormat = formats.get('filenamew');
      if (wideFormat === undefined) {
        const hiddenPath = parseHiddenSinglePath(readClipboardBuffer(clipboard, 'FileNameW'), true);
        if (hiddenPath !== null && isSafeLocalMp4Path(hiddenPath)) return { sourcePath: hiddenPath };
      } else {
        const widePaths = parseNullTerminatedPaths(readClipboardBuffer(clipboard, wideFormat), true, 1);
        if (widePaths.length === 1 && isSafeLocalMp4Path(widePaths[0]!)) return { sourcePath: widePaths[0]! };
      }
      const ansiFormat = formats.get('filename');
      if (ansiFormat === undefined) return null;
      const ansiPaths = parseNullTerminatedPaths(readClipboardBuffer(clipboard, ansiFormat), false, 1);
      return ansiPaths.length === 1 && isSafeLocalMp4Path(ansiPaths[0]!) ? { sourcePath: ansiPaths[0]! } : null;
    },
  };
}

function readClipboardBuffer(clipboard: ElectronClipboardFileLike, format: string): Buffer {
  try {
    return Buffer.from(clipboard.readBuffer(format));
  } catch {
    return Buffer.alloc(0);
  }
}

function parseHiddenSinglePath(value: Buffer, wide: boolean): string | null {
  if (value.length === 0 || (wide && value.length % 2 !== 0)) return null;
  const decoded = value.toString(wide ? 'utf16le' : 'latin1');
  if (decoded.length === 0 || /[\r\n]/u.test(decoded)) return null;
  const terminator = decoded.indexOf('\0');
  if (terminator < 0) return decoded;
  return terminator === decoded.length - 1 ? decoded.slice(0, -1) : null;
}

function parseDropFiles(value: Buffer): string[] {
  if (value.length < 20) return [];
  const offset = value.readUInt32LE(0);
  const wide = value.readUInt32LE(16) !== 0;
  if (offset < 20 || offset >= value.length || (wide && offset % 2 !== 0)) return [];
  return parseNullTerminatedPaths(value.subarray(offset), wide, 2);
}

function parseNullTerminatedPaths(value: Buffer, wide: boolean, terminatorCount: 1 | 2): string[] {
  if (value.length === 0 || (wide && value.length % 2 !== 0)) return [];
  const decoded = value.toString(wide ? 'utf16le' : 'latin1');
  const terminator = decoded.indexOf('\0'.repeat(terminatorCount));
  if (terminator < 0 || /[^\0]/u.test(decoded.slice(terminator))) return [];
  const bounded = decoded.slice(0, terminator);
  return bounded.split('\0').map((path) => path.trim()).filter(Boolean);
}

function isSafeLocalMp4Path(value: string): boolean {
  if (value.length === 0 || value.length > 32_767 || value.includes('\0')) return false;
  if (!win32.isAbsolute(value) || !/^[a-zA-Z]:\\/u.test(value)) return false;
  return win32.extname(value).toLocaleLowerCase() === '.mp4';
}
