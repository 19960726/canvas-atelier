import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  applyPhotoshopColorCorrectionToBgraPixels,
  createElectronPhotoshopWebpDecoder,
  createNodeWindowsPhotoshopSmartObjectAdapter,
  createNodePhotoshopTemporaryFiles,
  createWindowsPhotoshopSmartObjectAdapter,
} from './photoshop-windows-adapter.js';

interface RunnerHarnessOptions {
  readonly primaryError: string;
  readonly duplicateFails?: boolean;
  readonly copyFails?: boolean;
  readonly layerWidth?: number;
  readonly layerHeight?: number;
}

async function runWindowsPlacementFallback(options: RunnerHarnessOptions) {
  const runnerPath = fileURLToPath(new URL('./photoshop-windows-runner.js', import.meta.url));
  const runnerSource = (await readFile(runnerPath, 'utf8')).replace(/WScript\.Quit\(0\);/gu, 'return;');
  const payload = JSON.stringify({
    version: 1,
    imagePathBase64: Buffer.from('E:/managed/source.png', 'utf8').toString('base64'),
    layerNameBase64: Buffer.from('Placed image', 'utf8').toString('base64'),
  });
  const output: string[] = [];
  const targetLayers: unknown[] = [];
  const bounds = {
    left: 17,
    top: 23,
    right: 17 + (options.layerWidth ?? 120),
    bottom: 23 + (options.layerHeight ?? 60),
  };
  const unit = (value: number) => ({ as: (name: string) => {
    if (name !== 'px') throw new Error(`Unexpected unit ${name}`);
    return value;
  } });
  const copiedLayer = {
    kind: 'ordinary-layer',
    name: '',
    get bounds() {
      return [unit(bounds.left), unit(bounds.top), unit(bounds.right), unit(bounds.bottom)];
    },
    resize(horizontal: number, vertical: number) {
      const centerX = (bounds.left + bounds.right) / 2;
      const centerY = (bounds.top + bounds.bottom) / 2;
      const width = (bounds.right - bounds.left) * horizontal / 100;
      const height = (bounds.bottom - bounds.top) * vertical / 100;
      bounds.left = centerX - width / 2;
      bounds.right = centerX + width / 2;
      bounds.top = centerY - height / 2;
      bounds.bottom = centerY + height / 2;
    },
    translate(horizontal: number, vertical: number) {
      bounds.left += horizontal;
      bounds.right += horizontal;
      bounds.top += vertical;
      bounds.bottom += vertical;
    },
    remove() {
      const index = targetLayers.indexOf(copiedLayer);
      if (index >= 0) targetLayers.splice(index, 1);
    },
  };
  const copy = vi.fn(() => {
    if (options.copyFails === true) throw new Error('copy failed');
  });
  const paste = vi.fn(() => {
    targetLayers.push(copiedLayer);
    return copiedLayer;
  });
  const duplicate = vi.fn(() => {
    if (options.duplicateFails === true) throw new Error('duplicate failed');
    targetLayers.push(copiedLayer);
    return copiedLayer;
  });
  const closeSourceDocument = vi.fn();
  const sourceDocument = {
    activeLayer: { copy, duplicate },
    close: closeSourceDocument,
  };
  const targetDocument = {
    width: unit(240),
    height: unit(240),
    activeLayer: copiedLayer,
    paste,
  };
  const openSourceDocument = vi.fn(() => sourceDocument);
  let javaScriptCalls = 0;
  const application = {
    version: '27.0',
    documents: { length: 1 },
    activeDocument: targetDocument,
    open: openSourceDocument,
    DoJavaScript(script: string) {
      javaScriptCalls += 1;
      if (javaScriptCalls === 1) throw new Error(options.primaryError);
      runInNewContext(script, {
        AnchorPosition: { MIDDLECENTER: 'middle-center' },
        DialogModes: { NO: 0 },
        LayerKind: { SMARTOBJECT: 'smart-object' },
        app: application,
        executeAction: (action: string) => {
          if (action !== 'newPlacedLayer') throw new Error(`Unexpected action ${action}`);
          copiedLayer.kind = 'smart-object';
        },
        isFinite,
        Math,
        stringIDToTypeID: (value: string) => value,
      });
    },
  };
  const files = new Map([
    ['C:/temp/place.jsx', 'jsx source'],
    ['C:/temp/payload.json', payload],
  ]);
  runInNewContext(runnerSource, {
    ActiveXObject: function ActiveXObject(name: string) {
      if (name !== 'Scripting.FileSystemObject') throw new Error(`Unexpected ActiveX object ${name}`);
      return {
        OpenTextFile(path: string) {
          return {
            Close() {},
            ReadAll() { return files.get(path) ?? ''; },
          };
        },
      };
    },
    GetObject: () => application,
    WScript: {
      Arguments: {
        length: 2,
        Item: (index: number) => ['C:/temp/place.jsx', 'C:/temp/payload.json'][index],
      },
      Quit() {},
      StdOut: { Write: (value: string) => output.push(value) },
    },
    decodeURIComponent,
    escape,
    isFinite,
    Math,
  });
  return {
    bounds,
    closeSourceDocument,
    copy,
    openSourceDocument,
    output: JSON.parse(output.join('')) as Record<string, unknown>,
    paste,
    targetLayerCount: targetLayers.length,
  };
}

function temporaryFiles() {
  return {
    create: vi.fn().mockResolvedValue({
      directory: 'C:/temp/novus-photoshop-1',
      jsxPath: 'C:/temp/novus-photoshop-1/place.jsx',
      payloadPath: 'C:/temp/novus-photoshop-1/payload.json',
      runnerPath: 'C:/app/photoshop-windows-runner.js',
    }),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

function nativeImages(options: {
  readonly bitmap?: Uint8Array;
  readonly height?: number;
  readonly pathEmpty?: boolean;
  readonly png?: Uint8Array;
  readonly width?: number;
} = {}) {
  const bitmap = Buffer.from(options.bitmap ?? new Uint8Array([80, 100, 120, 255]));
  const png = options.png ?? new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const sourceToBitmap = vi.fn(() => bitmap);
  return {
    bitmap,
    createFromPath: vi.fn().mockReturnValue({
      getSize: () => ({ width: options.width ?? 1, height: options.height ?? 1 }),
      isEmpty: () => options.pathEmpty === true,
      toBitmap: sourceToBitmap,
    }),
    createFromBitmap: vi.fn().mockReturnValue({
      isEmpty: () => false,
      toPNG: () => Buffer.from(png),
    }),
    sourceToBitmap,
  };
}

function rendererCorrectedBgra(
  premultipliedBgra: readonly [number, number, number, number],
  correction: { readonly temperature: number; readonly tint: number; readonly saturation: number; readonly contrast: number; readonly brightness: number },
): number[] {
  const [premultipliedBlue, premultipliedGreen, premultipliedRed, alpha] = premultipliedBgra;
  if (alpha === 0) return [0, 0, 0, 0];
  const straightScale = alpha === 255 ? 1 : 255 / alpha;
  const redSource = premultipliedRed * straightScale;
  const greenSource = premultipliedGreen * straightScale;
  const blueSource = premultipliedBlue * straightScale;
  const temperature = correction.temperature * 0.004;
  const tint = correction.tint * 0.002;
  const redGain = Math.min(1.18, Math.max(0.82, 1 + temperature + tint));
  const greenGain = Math.min(1.18, Math.max(0.82, 1 - (correction.tint * 0.004)));
  const blueGain = Math.min(1.18, Math.max(0.82, 1 - temperature + tint));
  let red = redSource * redGain;
  let green = greenSource * greenGain;
  let blue = blueSource * blueGain;
  const luminance = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
  red = luminance + ((red - luminance) * correction.saturation / 100);
  green = luminance + ((green - luminance) * correction.saturation / 100);
  blue = luminance + ((blue - luminance) * correction.saturation / 100);
  const correct = (value: number) => Math.min(255, Math.max(0,
    ((value - 128) * correction.contrast / 100 + 128) * correction.brightness / 100,
  ));
  const premultipliedScale = alpha === 255 ? 1 : alpha / 255;
  return [...new Uint8ClampedArray([
    correct(blue) * premultipliedScale,
    correct(green) * premultipliedScale,
    correct(red) * premultipliedScale,
    alpha,
  ])];
}

describe('Windows Photoshop smart object adapter', () => {
  it('decodes a managed WebP in a disposable browser and canonicalizes it through nativeImage', async () => {
    const pngDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const decoded = {
      getSize: () => ({ width: 2, height: 1 }),
      isEmpty: () => false,
      toBitmap: () => Buffer.alloc(8),
    };
    const destroy = vi.fn();
    const executeJavaScript = vi.fn().mockResolvedValue({ dataUrl: pngDataUrl, width: 2, height: 1 });
    const loadURL = vi.fn().mockResolvedValue(undefined);
    const createFromDataURL = vi.fn().mockReturnValue(decoded);
    const decodeWebpFromPath = createElectronPhotoshopWebpDecoder({
      createWindow: () => ({
        destroy,
        isDestroyed: () => false,
        loadURL,
        webContents: { executeJavaScript },
      }),
      nativeImage: { createFromDataURL },
    });

    const sourcePath = 'E:/managed/source.webp';
    await expect(decodeWebpFromPath(sourcePath, { width: 2, height: 1 }))
      .resolves.toBe(decoded);
    expect(loadURL).toHaveBeenCalledOnce();
    expect(new URL(loadURL.mock.calls[0]![0])).toMatchObject({
      protocol: 'file:', host: '', pathname: '/' + sourcePath, search: '', hash: '',
    });
    expect(executeJavaScript).toHaveBeenCalledOnce();
    expect(createFromDataURL).toHaveBeenCalledWith(pngDataUrl);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('destroys the disposable browser when Chromium returns dimensions that differ from the managed WebP', async () => {
    const destroy = vi.fn();
    const decodeWebpFromPath = createElectronPhotoshopWebpDecoder({
      createWindow: () => ({
        destroy,
        isDestroyed: () => false,
        loadURL: vi.fn().mockResolvedValue(undefined),
        webContents: {
          executeJavaScript: vi.fn().mockResolvedValue({
            dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
            width: 3,
            height: 1,
          }),
        },
      }),
      nativeImage: { createFromDataURL: vi.fn() },
    });

    await expect(decodeWebpFromPath('E:/managed/source.webp', { width: 2, height: 1 }))
      .rejects.toThrow('dimensions did not match');
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('applies renderer-equivalent correction to opaque premultiplied BGRA pixels', () => {
    const pixel = [80, 100, 120, 255] as const;
    const correction = { temperature: 10, tint: -5, saturation: 110, contrast: 105, brightness: 95 };
    expect([...applyPhotoshopColorCorrectionToBgraPixels(new Uint8Array(pixel), correction)])
      .toEqual(rendererCorrectedBgra(pixel, correction));
  });

  it('unpremultiplies translucent BGRA before correction and premultiplies with the original alpha', () => {
    const pixel = [100, 75, 20, 128] as const;
    const correction = { temperature: 10, tint: -5, saturation: 110, contrast: 105, brightness: 95 };
    expect([...applyPhotoshopColorCorrectionToBgraPixels(new Uint8Array(pixel), correction)])
      .toEqual(rendererCorrectedBgra(pixel, correction));
  });

  it('zeros RGB for fully transparent pixels and preserves zero alpha', () => {
    const pixel = [77, 88, 99, 0] as const;
    const correction = { temperature: 10, tint: -5, saturation: 110, contrast: 105, brightness: 95 };
    expect([...applyPhotoshopColorCorrectionToBgraPixels(new Uint8Array(pixel), correction)])
      .toEqual(rendererCorrectedBgra(pixel, correction));
  });

  it('corrects the copied Electron bitmap in place instead of allocating another full pixel buffer', () => {
    const bitmap = Buffer.from([80, 100, 120, 255]);
    const corrected = applyPhotoshopColorCorrectionToBgraPixels(bitmap, {
      temperature: 10,
      tint: -5,
      saturation: 110,
      contrast: 105,
      brightness: 95,
    });

    expect(corrected.buffer).toBe(bitmap.buffer);
    expect(corrected.byteOffset).toBe(bitmap.byteOffset);
    expect(corrected.byteLength).toBe(bitmap.byteLength);
  });

  it('decodes the managed source, encodes corrected pixels and points Photoshop at the temporary PNG', async () => {
    const root = await mkdtemp(join(tmpdir(), 'photoshop-corrected-test-'));
    const jsxResourcePath = join(root, 'place.jsx');
    const encodedPng = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const images = nativeImages({
      bitmap: new Uint8Array([80, 100, 120, 255, 100, 75, 20, 128]),
      width: 2,
      height: 1,
      png: encodedPng,
    });
    const colorCorrection = { temperature: 10, tint: -5, saturation: 110, contrast: 105, brightness: 95 };
    await writeFile(jsxResourcePath, 'jsx source');
    let temporaryDirectory: string | undefined;
    try {
      const files = await createNodePhotoshopTemporaryFiles({
        absolutePath: 'E:/managed/original.jpg',
        layerName: 'Corrected layer',
        colorCorrection,
      }, {
        jsxResourcePath,
        nativeImage: images,
        runnerResourcePath: 'C:/app/photoshop-windows-runner.js',
        temporaryDirectoryRoot: root,
      });
      temporaryDirectory = files.directory;
      expect(images.createFromPath).toHaveBeenCalledWith('E:/managed/original.jpg');
      expect(images.createFromBitmap).toHaveBeenCalledWith(
        Buffer.from([67, 95, 119, 255, 95, 74, 13, 128]),
        { width: 2, height: 1, scaleFactor: 1 },
      );
      expect(new Uint8Array(await readFile(join(files.directory, 'corrected.png')))).toEqual(encodedPng);
      const payload = JSON.parse(await readFile(files.payloadPath, 'utf8')) as Record<string, unknown>;
      expect(Buffer.from(String(payload.imagePathBase64), 'base64').toString('utf8'))
        .toBe(join(files.directory, 'corrected.png'));
    } finally {
      if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps original imports on the managed path without decoding or re-encoding them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'photoshop-original-test-'));
    const jsxResourcePath = join(root, 'place.jsx');
    const images = nativeImages();
    await writeFile(jsxResourcePath, 'jsx source');
    let temporaryDirectory: string | undefined;
    try {
      const files = await createNodePhotoshopTemporaryFiles({
        absolutePath: 'E:/managed/original.jpg',
        layerName: 'Original layer',
      }, {
        jsxResourcePath,
        nativeImage: images,
        runnerResourcePath: 'C:/app/photoshop-windows-runner.js',
        temporaryDirectoryRoot: root,
      });
      temporaryDirectory = files.directory;
      const payload = JSON.parse(await readFile(files.payloadPath, 'utf8')) as Record<string, unknown>;
      expect(Buffer.from(String(payload.imagePathBase64), 'base64').toString('utf8'))
        .toBe('E:/managed/original.jpg');
      expect(images.createFromPath).not.toHaveBeenCalled();
      expect(images.createFromBitmap).not.toHaveBeenCalled();
    } finally {
      if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the trusted main-process WebP decoder for a real managed file and verifies its full dimensions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'photoshop-webp-test-'));
    const jsxResourcePath = join(root, 'place.jsx');
    const sourcePath = join(root, 'managed.webp');
    const webpBytes = Buffer.from('UklGRh4CAABXRUJQVlA4WAoAAAAwAAAAAQAAAAAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZBTFBIAwAAAAD/gABWUDggJAAAAJABAJ0BKgIAAQABQCYlAE6AG6B2hgD+RogeBxUcnXrS3NuIAA==', 'base64');
    const images = nativeImages({
      pathEmpty: true,
    });
    const decodedBitmap = Buffer.from([80, 100, 120, 255, 80, 100, 120, 255]);
    const decodeWebpFromPath = vi.fn().mockResolvedValue({
      getSize: () => ({ width: 2, height: 1 }),
      isEmpty: () => false,
      toBitmap: () => decodedBitmap,
    });
    await Promise.all([
      writeFile(jsxResourcePath, 'jsx source'),
      writeFile(sourcePath, webpBytes),
    ]);
    let temporaryDirectory: string | undefined;
    try {
      const files = await createNodePhotoshopTemporaryFiles({
        absolutePath: sourcePath,
        layerName: 'WebP layer',
        mediaType: 'image/webp',
        colorCorrection: { temperature: 10, tint: -5, saturation: 110, contrast: 105, brightness: 95 },
      }, {
        jsxResourcePath,
        decodeWebpFromPath,
        nativeImage: images,
        runnerResourcePath: 'C:/app/photoshop-windows-runner.js',
        temporaryDirectoryRoot: root,
      });
      temporaryDirectory = files.directory;
      expect(images.createFromPath).toHaveBeenCalledWith(sourcePath);
      expect(decodeWebpFromPath).toHaveBeenCalledWith(sourcePath, { width: 2, height: 1 });
      expect(images.createFromBitmap).toHaveBeenCalledWith(
        expect.any(Buffer),
        { width: 2, height: 1, scaleFactor: 1 },
      );
      expect(images.createFromBitmap.mock.calls[0]![0]).toHaveLength(8);
    } finally {
      if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects corrected images above the maximum side before allocating a bitmap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'photoshop-size-limit-test-'));
    const jsxResourcePath = join(root, 'place.jsx');
    const images = nativeImages({ width: 8_193, height: 1 });
    await writeFile(jsxResourcePath, 'jsx source');
    try {
      await expect(createNodePhotoshopTemporaryFiles({
        absolutePath: 'E:/managed/too-large.png',
        layerName: 'Too large',
        mediaType: 'image/png',
        colorCorrection: { temperature: 1, tint: 0, saturation: 100, contrast: 100, brightness: 100 },
      }, {
        jsxResourcePath,
        nativeImage: images,
        runnerResourcePath: 'C:/app/photoshop-windows-runner.js',
        temporaryDirectoryRoot: root,
      })).rejects.toThrow('dimensions are invalid');
      expect(images.sourceToBitmap).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('removes its temporary directory when trusted managed-image decoding fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'photoshop-correction-failure-test-'));
    const jsxResourcePath = join(root, 'place.jsx');
    const images = nativeImages();
    images.createFromPath.mockReturnValue({
      getSize: () => ({ width: 0, height: 0 }),
      isEmpty: () => true,
      toBitmap: () => Buffer.alloc(0),
    });
    await writeFile(jsxResourcePath, 'jsx source');
    try {
      await expect(createNodePhotoshopTemporaryFiles({
        absolutePath: 'E:/managed/broken.jpg',
        layerName: 'Broken layer',
        colorCorrection: { temperature: 1, tint: 0, saturation: 100, contrast: 100, brightness: 100 },
      }, {
        jsxResourcePath,
        nativeImage: images,
        runnerResourcePath: 'C:/app/photoshop-windows-runner.js',
        temporaryDirectoryRoot: root,
      })).rejects.toThrow('could not be decoded');
      const entries = await readdir(root, { withFileTypes: true });
      expect(entries.filter((entry) => entry.isDirectory())).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects decoded images above the bounded correction working set before reading their bitmap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'photoshop-correction-size-test-'));
    const jsxResourcePath = join(root, 'place.jsx');
    const images = nativeImages({ width: 4_000, height: 3_000 });
    await writeFile(jsxResourcePath, 'jsx source');
    try {
      await expect(createNodePhotoshopTemporaryFiles({
        absolutePath: 'E:/managed/oversized.png',
        layerName: 'Oversized layer',
        colorCorrection: { temperature: 1, tint: 0, saturation: 100, contrast: 100, brightness: 100 },
      }, {
        jsxResourcePath,
        nativeImage: images,
        runnerResourcePath: 'C:/app/photoshop-windows-runner.js',
        temporaryDirectoryRoot: root,
      })).rejects.toThrow('dimensions are invalid');
      expect(images.createFromPath.mock.results[0]?.value.toBitmap).not.toHaveBeenCalled();
      const entries = await readdir(root, { withFileTypes: true });
      expect(entries.filter((entry) => entry.isDirectory())).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fits and centers a small fallback image as one proportional Smart Object without clipboard transfer', async () => {
    const result = await runWindowsPlacementFallback({
      primaryError: 'place-layer failed',
      layerWidth: 120,
      layerHeight: 60,
    });

    expect(result.output).toMatchObject({ kind: 'success', method: 'direct-com' });
    expect(result.bounds).toEqual({ left: 0, top: 60, right: 240, bottom: 180 });
    expect(result.targetLayerCount).toBe(1);
    expect(result.closeSourceDocument).toHaveBeenCalledOnce();
    expect(result.copy).not.toHaveBeenCalled();
    expect(result.paste).not.toHaveBeenCalled();
  });

  it('closes the fallback source and stops when duplicate fails instead of pasting a possible second layer', async () => {
    const result = await runWindowsPlacementFallback({ primaryError: 'place-layer failed', duplicateFails: true });

    expect(result.output).toMatchObject({ kind: 'placement_failed' });
    expect(result.targetLayerCount).toBe(0);
    expect(result.closeSourceDocument).toHaveBeenCalledOnce();
    expect(result.copy).not.toHaveBeenCalled();
    expect(result.paste).not.toHaveBeenCalled();
  });

  it('creates the production adapter from fixed application resources', () => {
    const adapter = createNodeWindowsPhotoshopSmartObjectAdapter({
      platform: 'darwin',
      jsxResourcePath: '/app/photoshop-place-smart-object.jsx',
      nativeImage: nativeImages(),
      runnerResourcePath: '/app/photoshop-windows-runner.js',
    });
    expect(adapter.place).toBeTypeOf('function');
  });

  it('runs the highest supported installed Photoshop through the active instance', async () => {
    const files = temporaryFiles();
    const execute = vi.fn().mockResolvedValue({ kind: 'success', layerName: 'Layer' });
    const adapter = createWindowsPhotoshopSmartObjectAdapter({
      platform: 'win32',
      discoverInstallations: vi.fn().mockResolvedValue([
        { majorVersion: 20, executablePath: 'C:/Adobe/Photoshop 2019/Photoshop.exe' },
        { majorVersion: 25, executablePath: 'C:/Adobe/Photoshop 2024/Photoshop.exe' },
      ]),
      inspectRunningInstance: vi.fn().mockResolvedValue({ majorVersion: 25, activeDocument: true }),
      execute,
      temporaryFiles: files,
    });

    await expect(adapter.place({ absolutePath: 'E:/managed/a.png', layerName: 'Layer' }))
      .resolves.toEqual({ ok: true, layerName: 'Layer' });
    expect(files.create).toHaveBeenCalledWith({ absolutePath: 'E:/managed/a.png', layerName: 'Layer' });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      installedMajorVersions: [25, 20],
      jsxPath: 'C:/temp/novus-photoshop-1/place.jsx',
      payloadPath: 'C:/temp/novus-photoshop-1/payload.json',
    }));
    expect(files.remove).toHaveBeenCalledWith('C:/temp/novus-photoshop-1');
  });

  it('forwards color-correction parameters to trusted temporary-file creation and removes them after placement', async () => {
    const files = temporaryFiles();
    const colorCorrection = { temperature: -4, tint: 7, saturation: 108, contrast: 102, brightness: 99 };
    const adapter = createWindowsPhotoshopSmartObjectAdapter({
      platform: 'win32',
      discoverInstallations: vi.fn().mockResolvedValue([{ majorVersion: 25, executablePath: 'new.exe' }]),
      inspectRunningInstance: vi.fn().mockResolvedValue({ majorVersion: 25, activeDocument: true }),
      execute: vi.fn().mockResolvedValue({ kind: 'success', layerName: 'Corrected layer' }),
      temporaryFiles: files,
    });

    await expect(adapter.place({
      absolutePath: 'E:/managed/original.jpg',
      layerName: 'Corrected layer',
      colorCorrection,
    })).resolves.toEqual({ ok: true, layerName: 'Corrected layer' });
    expect(files.create).toHaveBeenCalledWith({
      absolutePath: 'E:/managed/original.jpg',
      layerName: 'Corrected layer',
      colorCorrection,
    });
    expect(files.remove).toHaveBeenCalledWith('C:/temp/novus-photoshop-1');
  });

  it('supports the legacy ExtendScript placement path on Photoshop CS6', async () => {
    const files = temporaryFiles();
    const execute = vi.fn().mockResolvedValue({ kind: 'success', layerName: 'Legacy Layer' });
    const adapter = createWindowsPhotoshopSmartObjectAdapter({
      platform: 'win32',
      discoverInstallations: vi.fn().mockResolvedValue([{ majorVersion: 13, executablePath: 'C:/Adobe/Photoshop CS6/Photoshop.exe' }]),
      inspectRunningInstance: vi.fn().mockResolvedValue({ majorVersion: 13, activeDocument: true }),
      execute,
      temporaryFiles: files,
    });

    await expect(adapter.place({ absolutePath: 'E:/managed/legacy.png', layerName: 'Legacy Layer' }))
      .resolves.toEqual({ ok: true, layerName: 'Legacy Layer' });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ installedMajorVersions: [13] }));
  });

  it('uses a supported running Photoshop when a custom installation is absent from the registry', async () => {
    const files = temporaryFiles();
    const execute = vi.fn().mockResolvedValue({ kind: 'success', layerName: 'Portable Layer' });
    const adapter = createWindowsPhotoshopSmartObjectAdapter({
      platform: 'win32',
      discoverInstallations: vi.fn().mockResolvedValue([]),
      inspectRunningInstance: vi.fn().mockResolvedValue({ majorVersion: 27, activeDocument: true }),
      execute,
      temporaryFiles: files,
    });

    await expect(adapter.place({ absolutePath: 'E:/managed/portable.png', layerName: 'Portable Layer' }))
      .resolves.toEqual({ ok: true, layerName: 'Portable Layer' });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ installedMajorVersions: [27] }));
  });

  it.each([
    { platform: 'darwin', installations: [], running: null, expected: 'desktop_bridge_unavailable' },
    { platform: 'win32', installations: [], running: null, expected: 'photoshop_not_installed' },
    { platform: 'win32', installations: [{ majorVersion: 12, executablePath: 'old.exe' }], running: { majorVersion: 12, activeDocument: true }, expected: 'photoshop_version_unsupported' },
    { platform: 'win32', installations: [{ majorVersion: 25, executablePath: 'new.exe' }], running: null, expected: 'photoshop_not_running' },
  ])('returns $expected without writing temporary files', async ({ platform, installations, running, expected }) => {
    const files = temporaryFiles();
    const adapter = createWindowsPhotoshopSmartObjectAdapter({
      platform,
      discoverInstallations: vi.fn().mockResolvedValue(installations),
      inspectRunningInstance: vi.fn().mockResolvedValue(running),
      execute: vi.fn(),
      temporaryFiles: files,
    });
    await expect(adapter.place({ absolutePath: 'E:/managed/a.png', layerName: 'Layer' }))
      .resolves.toEqual({ ok: false, code: expected });
    expect(files.create).not.toHaveBeenCalled();
  });

  it('maps automation denial and always removes temporary files', async () => {
    const files = temporaryFiles();
    const adapter = createWindowsPhotoshopSmartObjectAdapter({
      platform: 'win32',
      discoverInstallations: vi.fn().mockResolvedValue([{ majorVersion: 25, executablePath: 'new.exe' }]),
      inspectRunningInstance: vi.fn().mockResolvedValue({ majorVersion: 25, activeDocument: true }),
      execute: vi.fn().mockResolvedValue({ kind: 'automation_denied' }),
      temporaryFiles: files,
    });

    await expect(adapter.place({ absolutePath: 'E:/managed/a.png', layerName: 'Layer' }))
      .resolves.toEqual({ ok: false, code: 'automation_denied' });
    expect(files.remove).toHaveBeenCalledWith('C:/temp/novus-photoshop-1');
  });

  it('reports an unavailable Photoshop automation instance without disguising it as placement failure', async () => {
    const files = temporaryFiles();
    const adapter = createWindowsPhotoshopSmartObjectAdapter({
      platform: 'win32', discoverInstallations: vi.fn().mockResolvedValue([{ majorVersion: 27, executablePath: 'new.exe' }]),
      inspectRunningInstance: vi.fn().mockResolvedValue({ majorVersion: 27, activeDocument: true }),
      execute: vi.fn().mockResolvedValue({ kind: 'automation_unavailable' }), temporaryFiles: files,
    });
    await expect(adapter.place({ absolutePath: 'E:/managed/a.png', layerName: 'Layer' }))
      .resolves.toEqual({ ok: false, code: 'automation_unavailable' });
  });

  it('serializes automation calls for different images', async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const execute = vi.fn(async ({ payloadPath }: { payloadPath: string }) => {
      order.push(`start:${payloadPath}`);
      if (payloadPath.endsWith('first.json')) {
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
      }
      order.push(`end:${payloadPath}`);
      return { kind: 'success' as const, layerName: 'Layer' };
    });
    let index = 0;
    const adapter = createWindowsPhotoshopSmartObjectAdapter({
      platform: 'win32',
      discoverInstallations: vi.fn().mockResolvedValue([{ majorVersion: 25, executablePath: 'new.exe' }]),
      inspectRunningInstance: vi.fn().mockResolvedValue({ majorVersion: 25, activeDocument: true }),
      execute,
      temporaryFiles: {
        create: vi.fn(async () => {
          index += 1;
          const name = index === 1 ? 'first' : 'second';
          return { directory: `C:/temp/${name}`, jsxPath: `C:/temp/${name}/place.jsx`, payloadPath: `C:/temp/${name}.json`, runnerPath: 'runner.js' };
        }),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    });

    const first = adapter.place({ absolutePath: 'E:/managed/first.png', layerName: 'First' });
    const second = adapter.place({ absolutePath: 'E:/managed/second.png', layerName: 'Second' });
    await vi.waitFor(() => expect(order).toEqual(['start:C:/temp/first.json']));
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual([
      'start:C:/temp/first.json',
      'end:C:/temp/first.json',
      'start:C:/temp/second.json',
      'end:C:/temp/second.json',
    ]);
  });
});
