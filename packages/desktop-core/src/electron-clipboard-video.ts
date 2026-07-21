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
      const formats = new Set(clipboard.availableFormats().map((format) => format.toLocaleLowerCase()));
      let paths: string[] = [];
      if (formats.has('cf_hdrop')) {
        paths = parseDropFiles(Buffer.from(clipboard.readBuffer('CF_HDROP')));
      } else if (formats.has('filenamew')) {
        paths = parseNullTerminatedPaths(Buffer.from(clipboard.readBuffer('FileNameW')), true, 1);
      } else if (formats.has('filename')) {
        paths = parseNullTerminatedPaths(Buffer.from(clipboard.readBuffer('FileName')), false, 1);
      }
      if (paths.length !== 1 || !isSafeLocalMp4Path(paths[0]!)) return null;
      return { sourcePath: paths[0]! };
    },
  };
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
