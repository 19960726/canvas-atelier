import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { PhotoshopColorCorrection, PhotoshopImportResult } from './photoshop-contract.js';
import type {
  PhotoshopSmartObjectAdapter,
  PhotoshopSmartObjectPlacementInput,
} from './photoshop-smart-object-service.js';
import { createPhotoshopPlacementPayload } from './photoshop-script.js';

const execFileAsync = promisify(execFile);
const MINIMUM_PHOTOSHOP_MAJOR_VERSION = 13;
const MAX_CORRECTED_IMAGE_SIDE = 8_192;
const MAX_CORRECTED_IMAGE_PIXELS = 10_000_000;
const MAX_CORRECTED_PNG_BYTES = 48 * 1024 * 1024;
const MAX_CORRECTED_PNG_DATA_URL_CHARS = Math.ceil(MAX_CORRECTED_PNG_BYTES * 4 / 3) + 64;
const DECODE_WEBP_TO_PNG_SCRIPT = `(() => {
  const image = document.images.item(0);
  if (image === null || !image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    throw new Error('Managed WebP did not decode');
  }
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Managed WebP canvas is unavailable');
  context.drawImage(image, 0, 0);
  const dataUrl = canvas.toDataURL('image/png');
  const result = { dataUrl, width: canvas.width, height: canvas.height };
  canvas.width = 1;
  canvas.height = 1;
  return result;
})()`;

export interface PhotoshopInstallation {
  readonly majorVersion: number;
  readonly executablePath: string;
}

export interface PhotoshopRunningInstance {
  readonly majorVersion: number;
  readonly activeDocument: boolean;
}
export type PhotoshopInspection = PhotoshopRunningInstance | null | 'automation_unavailable';

export interface PhotoshopTemporaryFiles {
  readonly directory: string;
  readonly jsxPath: string;
  readonly payloadPath: string;
  readonly runnerPath: string;
}

export type PhotoshopWindowsExecutionResult =
  | { readonly kind: 'success'; readonly layerName: string }
  | { readonly kind: 'automation_denied' }
  | { readonly kind: 'automation_unavailable' }
  | { readonly kind: 'no_active_document' }
  | { readonly kind: 'placement_failed' };

export interface WindowsPhotoshopAdapterDependencies {
  readonly platform: string;
  readonly discoverInstallations: () => Promise<readonly PhotoshopInstallation[]>;
  readonly inspectRunningInstance: () => Promise<PhotoshopInspection>;
  readonly execute: (input: PhotoshopTemporaryFiles & {
    readonly installedMajorVersions: readonly number[];
  }) => Promise<PhotoshopWindowsExecutionResult>;
  readonly temporaryFiles: {
    create(input: PhotoshopSmartObjectPlacementInput): Promise<PhotoshopTemporaryFiles>;
    remove(directory: string): Promise<void>;
  };
}

export interface NodeWindowsPhotoshopAdapterOptions {
  readonly decodeWebpFromPath?: PhotoshopManagedWebpDecoder;
  readonly platform?: string;
  readonly jsxResourcePath: string;
  readonly nativeImage: PhotoshopNativeImageFactory;
  readonly runnerResourcePath: string;
  readonly temporaryDirectoryRoot?: string;
}

export interface PhotoshopNativeImageFactory {
  createFromPath(path: string): PhotoshopDecodedImage;
  createFromBitmap(
    buffer: Buffer,
    options: { readonly width: number; readonly height: number; readonly scaleFactor: number },
  ): {
    isEmpty(): boolean;
    toPNG(): Buffer;
  };
}

export interface PhotoshopDecodedImage {
  getSize(): { readonly width: number; readonly height: number };
  isEmpty(): boolean;
  toBitmap(): Buffer;
}

export type PhotoshopManagedWebpDecoder = (
  absolutePath: string,
  expectedSize: { readonly width: number; readonly height: number },
) => Promise<PhotoshopDecodedImage>;

export interface PhotoshopWebpDecodeWindow {
  readonly webContents: {
    executeJavaScript<T>(script: string): Promise<T>;
  };
  destroy(): void;
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
}

export function createElectronPhotoshopWebpDecoder(options: {
  readonly createWindow: () => PhotoshopWebpDecodeWindow;
  readonly nativeImage: {
    createFromDataURL(dataUrl: string): PhotoshopDecodedImage;
  };
}): PhotoshopManagedWebpDecoder {
  return async (absolutePath, expectedSize) => {
    const window = options.createWindow();
    try {
      await window.loadURL(pathToFileURL(absolutePath).href);
      const result = await window.webContents.executeJavaScript<unknown>(DECODE_WEBP_TO_PNG_SCRIPT);
      if (!isRecord(result)
        || result.width !== expectedSize.width
        || result.height !== expectedSize.height) {
        throw new Error('Managed Photoshop WebP dimensions did not match its verified header');
      }
      if (typeof result.dataUrl !== 'string'
        || result.dataUrl.length > MAX_CORRECTED_PNG_DATA_URL_CHARS
        || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(result.dataUrl)) {
        throw new Error('Managed Photoshop WebP decoder returned invalid PNG data');
      }
      const decoded = options.nativeImage.createFromDataURL(result.dataUrl);
      const decodedSize = decoded.getSize();
      if (decoded.isEmpty()
        || decodedSize.width !== expectedSize.width
        || decodedSize.height !== expectedSize.height) {
        throw new Error('Managed Photoshop WebP PNG could not be decoded at full size');
      }
      return decoded;
    } finally {
      if (!window.isDestroyed()) window.destroy();
    }
  };
}

export function applyPhotoshopColorCorrectionToBgraPixels(
  pixels: Uint8Array,
  correction: PhotoshopColorCorrection,
): Uint8Array {
  if (pixels.byteLength % 4 !== 0) throw new Error('Photoshop bitmap has an invalid BGRA byte length');
  const output = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  const temperature = correction.temperature * 0.004;
  const tint = correction.tint * 0.002;
  const redGain = clamp(1 + temperature + tint, 0.82, 1.18);
  const greenGain = clamp(1 - (correction.tint * 0.004), 0.82, 1.18);
  const blueGain = clamp(1 - temperature + tint, 0.82, 1.18);
  const saturation = correction.saturation / 100;
  const contrast = correction.contrast / 100;
  const brightness = correction.brightness / 100;
  for (let index = 0; index < output.length; index += 4) {
    // Electron exposes NativeImage bitmap pixels as premultiplied BGRA. Work
    // in straight color to match the renderer, then restore premultiplication.
    const alpha = output[index + 3]!;
    if (alpha === 0) {
      output[index] = 0;
      output[index + 1] = 0;
      output[index + 2] = 0;
      continue;
    }
    const straightScale = alpha === 255 ? 1 : 255 / alpha;
    const premultipliedScale = alpha === 255 ? 1 : alpha / 255;
    let blue = output[index]! * straightScale * blueGain;
    let green = output[index + 1]! * straightScale * greenGain;
    let red = output[index + 2]! * straightScale * redGain;
    const luminance = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
    red = luminance + ((red - luminance) * saturation);
    green = luminance + ((green - luminance) * saturation);
    blue = luminance + ((blue - luminance) * saturation);
    output[index] = clamp(((blue - 128) * contrast + 128) * brightness, 0, 255) * premultipliedScale;
    output[index + 1] = clamp(((green - 128) * contrast + 128) * brightness, 0, 255) * premultipliedScale;
    output[index + 2] = clamp(((red - 128) * contrast + 128) * brightness, 0, 255) * premultipliedScale;
  }
  return new Uint8Array(output.buffer, output.byteOffset, output.byteLength);
}

export async function createNodePhotoshopTemporaryFiles(
  input: PhotoshopSmartObjectPlacementInput,
  options: Pick<NodeWindowsPhotoshopAdapterOptions, 'decodeWebpFromPath' | 'jsxResourcePath' | 'nativeImage' | 'runnerResourcePath' | 'temporaryDirectoryRoot'>,
): Promise<PhotoshopTemporaryFiles> {
  const directory = await mkdtemp(join(options.temporaryDirectoryRoot ?? tmpdir(), 'novus-photoshop-'));
  try {
    const jsxPath = join(directory, basename(options.jsxResourcePath));
    const payloadPath = join(directory, 'payload.json');
    const placementPath = input.colorCorrection === undefined
      ? input.absolutePath
      : join(directory, 'corrected.png');
    await copyFile(options.jsxResourcePath, jsxPath);
    if (input.colorCorrection !== undefined) {
      const correctedPngBytes = await createCorrectedPngFromManagedImage(
        input.absolutePath,
        input.mediaType,
        input.colorCorrection,
        options.nativeImage,
        options.decodeWebpFromPath,
      );
      await writeFile(placementPath, correctedPngBytes, { flag: 'wx' });
    }
    await writeFile(payloadPath, createPhotoshopPlacementPayload({
      absolutePath: placementPath,
      layerName: input.layerName,
    }), { encoding: 'utf8', flag: 'wx' });
    return { directory, jsxPath, payloadPath, runnerPath: options.runnerResourcePath };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function createCorrectedPngFromManagedImage(
  absolutePath: string,
  mediaType: string | undefined,
  correction: PhotoshopColorCorrection,
  nativeImage: PhotoshopNativeImageFactory,
  decodeWebpFromPath: PhotoshopManagedWebpDecoder | undefined,
): Promise<Buffer> {
  const source = await decodeManagedPhotoshopImage(absolutePath, mediaType, nativeImage, decodeWebpFromPath);
  const { width, height } = source.getSize();
  if (!validCorrectedImageDimension(width) || !validCorrectedImageDimension(height)
    || width * height > MAX_CORRECTED_IMAGE_PIXELS) {
    throw new Error('Managed Photoshop image dimensions are invalid');
  }
  const bitmap = source.toBitmap();
  const expectedBytes = width * height * 4;
  if (bitmap.byteLength !== expectedBytes) throw new Error('Managed Photoshop bitmap size is invalid');
  const correctedBitmap = applyPhotoshopColorCorrectionToBgraPixels(bitmap, correction);
  const corrected = nativeImage.createFromBitmap(
    Buffer.from(correctedBitmap.buffer, correctedBitmap.byteOffset, correctedBitmap.byteLength),
    { width, height, scaleFactor: 1 },
  );
  if (corrected.isEmpty()) throw new Error('Corrected Photoshop image could not be encoded');
  const png = corrected.toPNG();
  if (png.byteLength === 0 || png.byteLength > MAX_CORRECTED_PNG_BYTES) {
    throw new Error('Corrected Photoshop PNG size is invalid');
  }
  return png;
}

async function decodeManagedPhotoshopImage(
  absolutePath: string,
  mediaType: string | undefined,
  nativeImage: PhotoshopNativeImageFactory,
  decodeWebpFromPath: PhotoshopManagedWebpDecoder | undefined,
): Promise<PhotoshopDecodedImage> {
  const source = nativeImage.createFromPath(absolutePath);
  if (!source.isEmpty()) return source;
  if (mediaType !== 'image/webp') throw new Error('Managed Photoshop image could not be decoded');

  const expectedSize = await readManagedWebpDimensions(absolutePath);
  if (!validCorrectedImageDimension(expectedSize.width) || !validCorrectedImageDimension(expectedSize.height)
    || expectedSize.width * expectedSize.height > MAX_CORRECTED_IMAGE_PIXELS) {
    throw new Error('Managed Photoshop image dimensions are invalid');
  }
  if (decodeWebpFromPath === undefined) throw new Error('Managed Photoshop WebP decoder is unavailable');
  const decoded = await decodeWebpFromPath(absolutePath, expectedSize);
  const actualSize = decoded.getSize();
  if (decoded.isEmpty() || actualSize.width !== expectedSize.width || actualSize.height !== expectedSize.height) {
    throw new Error('Managed Photoshop WebP could not be decoded at full size');
  }
  return decoded;
}

async function readManagedWebpDimensions(absolutePath: string): Promise<{ readonly width: number; readonly height: number }> {
  const handle = await open(absolutePath, 'r');
  try {
    const header = Buffer.alloc(30);
    const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
    const dimensions = parseWebpDimensions(header.subarray(0, bytesRead));
    if (dimensions === null) throw new Error('Managed Photoshop WebP header is invalid');
    return dimensions;
  } finally {
    await handle.close();
  }
}

function parseWebpDimensions(header: Buffer): { readonly width: number; readonly height: number } | null {
  if (header.byteLength < 21
    || header.toString('ascii', 0, 4) !== 'RIFF'
    || header.toString('ascii', 8, 12) !== 'WEBP') return null;
  const kind = header.toString('ascii', 12, 16);
  const chunkLength = header.readUInt32LE(16);
  if (kind === 'VP8X') {
    if (chunkLength !== 10 || header.byteLength < 30) return null;
    return {
      width: readUInt24LE(header, 24) + 1,
      height: readUInt24LE(header, 27) + 1,
    };
  }
  if (kind === 'VP8 ') {
    if (chunkLength < 10 || header.byteLength < 30
      || !header.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) return null;
    return {
      width: header.readUInt16LE(26) & 0x3fff,
      height: header.readUInt16LE(28) & 0x3fff,
    };
  }
  if (kind === 'VP8L') {
    if (chunkLength < 5 || header.byteLength < 25 || header[20] !== 0x2f) return null;
    const packed = header.readUInt32LE(21);
    return {
      width: (packed & 0x3fff) + 1,
      height: ((packed >>> 14) & 0x3fff) + 1,
    };
  }
  return null;
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function validCorrectedImageDimension(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= MAX_CORRECTED_IMAGE_SIDE;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function createWindowsPhotoshopSmartObjectAdapter(
  dependencies: WindowsPhotoshopAdapterDependencies,
): PhotoshopSmartObjectAdapter {
  let queue = Promise.resolve();

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  return {
    place(input) {
      return enqueue(async (): Promise<PhotoshopImportResult> => {
        if (dependencies.platform !== 'win32') {
          return { ok: false, code: 'desktop_bridge_unavailable' };
        }

        const installations = [...await dependencies.discoverInstallations()]
          .sort((left, right) => right.majorVersion - left.majorVersion);
        const running = await dependencies.inspectRunningInstance();
        if (running === 'automation_unavailable') return { ok: false, code: 'automation_unavailable' };
        if (installations.length === 0 && running === null) {
          return { ok: false, code: 'photoshop_not_installed' };
        }
        const supportedInstallations = installations.filter((item) => item.majorVersion >= MINIMUM_PHOTOSHOP_MAJOR_VERSION);
        if (running !== null && running.majorVersion < MINIMUM_PHOTOSHOP_MAJOR_VERSION) {
          return { ok: false, code: 'photoshop_version_unsupported' };
        }
        const supportedMajorVersions = [...new Set([
          ...supportedInstallations.map((item) => item.majorVersion),
          ...(running !== null && running.majorVersion >= MINIMUM_PHOTOSHOP_MAJOR_VERSION ? [running.majorVersion] : []),
        ])].sort((left, right) => right - left);
        if (supportedMajorVersions.length === 0) {
          return { ok: false, code: 'photoshop_version_unsupported' };
        }
        if (running === null) return { ok: false, code: 'photoshop_not_running' };
        const files = await dependencies.temporaryFiles.create(input);
        try {
          const result = await dependencies.execute({
            ...files,
            installedMajorVersions: supportedMajorVersions,
          });
          if (result.kind === 'success') return { ok: true, layerName: result.layerName };
          return { ok: false, code: result.kind };
        } catch {
          return { ok: false, code: 'placement_failed' };
        } finally {
          await dependencies.temporaryFiles.remove(files.directory).catch(() => undefined);
        }
      });
    },
  };
}

export function createNodeWindowsPhotoshopSmartObjectAdapter(
  options: NodeWindowsPhotoshopAdapterOptions,
): PhotoshopSmartObjectAdapter {
  const platform = options.platform ?? process.platform;
  const runCscript = async (args: readonly string[]): Promise<unknown> => {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const cscriptPath = join(systemRoot, 'System32', 'cscript.exe');
    const result = await execFileAsync(cscriptPath, ['//B', '//NoLogo', options.runnerResourcePath, ...args], {
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(result.stdout.trim());
  };

  return createWindowsPhotoshopSmartObjectAdapter({
    platform,
    discoverInstallations: async () => discoverPhotoshopInstallations(platform),
    inspectRunningInstance: async () => {
      if (platform !== 'win32') return null;
      try {
        const value = await runCscript(['--inspect']);
        if (!isRecord(value)) return null;
        if (value.kind === 'automation_unavailable') return 'automation_unavailable';
        if (value.kind !== 'running') return null;
        const majorVersion = Number(value.majorVersion);
        return Number.isInteger(majorVersion)
          ? { majorVersion, activeDocument: value.activeDocument === true }
          : null;
      } catch {
        return null;
      }
    },
    execute: async ({ jsxPath, payloadPath }) => {
      try {
        const value = await runCscript([jsxPath, payloadPath]);
        if (!isRecord(value)) return { kind: 'placement_failed' };
        if (value.kind === 'success' && typeof value.layerName === 'string') {
          return { kind: 'success', layerName: value.layerName };
        }
        if (value.kind === 'automation_denied' || value.kind === 'automation_unavailable' || value.kind === 'no_active_document') {
          return { kind: value.kind };
        }
        return { kind: 'placement_failed' };
      } catch {
        return { kind: 'placement_failed' };
      }
    },
    temporaryFiles: {
      create: (input) => createNodePhotoshopTemporaryFiles(input, options),
      remove(directory) {
        return rm(directory, { recursive: true, force: true });
      },
    },
  });
}

export async function discoverPhotoshopInstallations(platform: string): Promise<PhotoshopInstallation[]> {
  if (platform !== 'win32') return [];
  const registryPaths = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  const installations = new Map<number, PhotoshopInstallation>();
  // Adobe installs may be redirected outside Program Files (for example
  // D:\\PS2026). The App Paths registry entry contains the real executable;
  // relying on the uninstall display name alone leaves us with a bogus
  // relative `Photoshop.exe` path and makes a valid install look missing.
  try {
    const appPathResult = await execFileAsync('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Photoshop.exe', '/ve'], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const executablePath = appPathResult.stdout.match(/REG_SZ\s+(.+Photoshop\.exe)\s*$/imu)?.[1]?.trim();
    if (executablePath) {
      const versionMatch = /Photoshop\s+(20\d{2})/iu.exec(executablePath);
      const majorVersion = versionMatch ? Number(versionMatch[1]) - 1999 : 13;
      installations.set(majorVersion, { majorVersion, executablePath });
    }
  } catch {
    // Continue with uninstall entries; older installs may not register App Paths.
  }
  for (const registryPath of registryPaths) {
    try {
      const result = await execFileAsync('reg.exe', ['query', registryPath, '/s', '/f', 'Adobe Photoshop'], {
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      for (const line of result.stdout.split(/\r?\n/u)) {
        const yearMatch = /Adobe Photoshop(?: CC)?\s+(20\d{2})/iu.exec(line);
        const cs6Match = /Adobe Photoshop\s+CS6/iu.test(line);
        if (yearMatch === null && !cs6Match) continue;
        const majorVersion = cs6Match ? 13 : Number(yearMatch![1]) - 1999;
        if (majorVersion < 1 || installations.has(majorVersion)) continue;
        if (!installations.has(majorVersion)) installations.set(majorVersion, { majorVersion, executablePath: 'Photoshop.exe' });
      }
    } catch {
      // Missing registry roots and unmatched searches both produce non-zero exits.
    }
  }
  return [...installations.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
