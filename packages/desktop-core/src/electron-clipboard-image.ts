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
}

interface ElectronClipboardLike {
  readImage(): ElectronNativeImageLike;
}

interface ElectronNativeImageLike {
  getSize(): { readonly height: number; readonly width: number };
  isEmpty(): boolean;
  toPNG(): Uint8Array;
}

export function createElectronClipboardImageAdapter(clipboard: ElectronClipboardLike): ClipboardImageAdapter {
  return {
    async readImage() {
      const image = clipboard.readImage();
      if (image.isEmpty()) return null;
      const { width, height } = image.getSize();
      if (!isAllowedDimension(width) || !isAllowedDimension(height)) return null;
      if (width * height > MAX_CLIPBOARD_IMAGE_PIXELS) return null;
      const bytes = image.toPNG();
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_CLIPBOARD_PNG_BYTES) return null;
      return { bytes, height, label: 'Clipboard image', width };
    },
  };
}

function isAllowedDimension(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= MAX_CLIPBOARD_IMAGE_SIDE;
}
