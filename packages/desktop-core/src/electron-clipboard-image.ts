import { win32 } from 'node:path';

const MAX_CLIPBOARD_IMAGE_SIDE = 8192;
const MAX_CLIPBOARD_IMAGE_PIXELS = 64_000_000;
const MAX_CLIPBOARD_PNG_BYTES = 64 * 1024 * 1024;

export interface TrustedClipboardImage {
  readonly bytes: Uint8Array;
  readonly height: number;
  readonly label: string;
  readonly width: number;
}

export interface ClipboardImageAdapter {
  readImage(): Promise<TrustedClipboardImage | null>;
  writeImage?(bytes: Uint8Array): Promise<boolean>;
}

interface ElectronClipboardLike {
  availableFormats?(): string[];
  readBuffer?(format: string): Uint8Array;
  readImage(): ElectronNativeImageLike;
  writeImage?(image: ElectronNativeImageLike): void;
}

interface ElectronNativeImageLike {
  getSize(): { readonly height: number; readonly width: number };
  isEmpty(): boolean;
  toPNG(): Uint8Array;
}

export function createElectronClipboardImageAdapter(
  clipboard: ElectronClipboardLike,
  fileImages: {
    readonly createFromBuffer?: (bytes: Uint8Array) => ElectronNativeImageLike;
    readonly createFromPath?: (path: string) => ElectronNativeImageLike;
  } = {},
): ClipboardImageAdapter {
  return {
    async writeImage(bytes) {
      if (clipboard.writeImage === undefined || fileImages.createFromBuffer === undefined) return false;
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_CLIPBOARD_PNG_BYTES) return false;
      try {
        const image = fileImages.createFromBuffer(bytes);
        if (image.isEmpty()) return false;
        const size = image.getSize();
        if (trustedClipboardPng(image.toPNG(), size.width, size.height) === null) return false;
        clipboard.writeImage(image);
        return true;
      } catch {
        return false;
      }
    },
    async readImage() {
      const image = clipboard.readImage();
      if (!image.isEmpty()) {
        const { width, height } = image.getSize();
        const bytes = image.toPNG();
        const trusted = trustedClipboardPng(bytes, width, height);
        if (trusted !== null) return trusted;
      }
      const formats = clipboard.availableFormats?.() ?? [];
      const pngFormat = formats.find((format) => {
        const normalized = format.toLocaleLowerCase();
        return normalized === 'png' || normalized === 'image/png';
      });
      if (pngFormat !== undefined && clipboard.readBuffer !== undefined) {
        const bytes = clipboard.readBuffer(pngFormat);
        const dimensions = readPngDimensions(bytes);
        if (dimensions !== null) return trustedClipboardPng(bytes, dimensions.width, dimensions.height);
      }
      const imagePath = readExplorerImagePath(clipboard, formats);
      if (imagePath === null || fileImages.createFromPath === undefined) return null;
      try {
        const fileImage = fileImages.createFromPath(imagePath);
        if (fileImage.isEmpty()) return null;
        const { width, height } = fileImage.getSize();
        return trustedClipboardPng(fileImage.toPNG(), width, height);
      } catch {
        return null;
      }
    },
  };
}

function readExplorerImagePath(clipboard: ElectronClipboardLike, formats: readonly string[]): string | null {
  if (clipboard.readBuffer === undefined) return null;
  const formatByLowerName = new Map(formats.map((format) => [format.toLocaleLowerCase(), format]));
  const dropFormat = formatByLowerName.get('cf_hdrop');
  if (dropFormat !== undefined) {
    const paths = parseDropFiles(readClipboardBuffer(clipboard, dropFormat));
    return paths.length === 1 && isSafeLocalImagePath(paths[0]!) ? paths[0]! : null;
  }
  const wideFormat = formatByLowerName.get('filenamew');
  if (wideFormat === undefined) {
    const hiddenPath = parseHiddenSinglePath(readClipboardBuffer(clipboard, 'FileNameW'), true);
    if (hiddenPath !== null && isSafeLocalImagePath(hiddenPath)) return hiddenPath;
  } else {
    const widePaths = parseNullTerminatedPaths(readClipboardBuffer(clipboard, wideFormat), true, 1);
    if (widePaths.length === 1 && isSafeLocalImagePath(widePaths[0]!)) return widePaths[0]!;
  }
  const ansiFormat = formatByLowerName.get('filename');
  if (ansiFormat === undefined) return null;
  const ansiPaths = parseNullTerminatedPaths(readClipboardBuffer(clipboard, ansiFormat), false, 1);
  return ansiPaths.length === 1 && isSafeLocalImagePath(ansiPaths[0]!) ? ansiPaths[0]! : null;
}

function readClipboardBuffer(clipboard: ElectronClipboardLike, format: string): Buffer {
  try {
    return Buffer.from(clipboard.readBuffer?.(format) ?? []);
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
  return decoded.slice(0, terminator).split('\0').map((path) => path.trim()).filter(Boolean);
}

function isSafeLocalImagePath(value: string): boolean {
  if (value.length === 0 || value.length > 32_767 || value.includes('\0')) return false;
  if (!win32.isAbsolute(value) || !/^[a-zA-Z]:\\/u.test(value)) return false;
  return ['.jpg', '.jpeg', '.png'].includes(win32.extname(value).toLocaleLowerCase());
}

function trustedClipboardPng(bytes: Uint8Array, width: number, height: number): TrustedClipboardImage | null {
  if (!isAllowedDimension(width) || !isAllowedDimension(height)) return null;
  if (width * height > MAX_CLIPBOARD_IMAGE_PIXELS) return null;
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CLIPBOARD_PNG_BYTES) return null;
  return { bytes, height, label: 'Clipboard image', width };
}

function readPngDimensions(bytes: Uint8Array): { readonly height: number; readonly width: number } | null {
  if (bytes.byteLength < 24 || bytes.byteLength > MAX_CLIPBOARD_PNG_BYTES) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((value, index) => bytes[index] === value)) return null;
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  return { height, width };
}

function isAllowedDimension(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= MAX_CLIPBOARD_IMAGE_SIDE;
}
