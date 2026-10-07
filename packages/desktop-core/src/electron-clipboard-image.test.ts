import { describe, expect, it, vi } from 'vitest';
import { win32 } from 'node:path';

import { createElectronClipboardImageAdapter } from './electron-clipboard-image';
import { createSolidPng } from './test/png-fixture';

describe('Electron clipboard image adapter', () => {
  it('writes validated PNG bytes through the native Electron clipboard', async () => {
    const png = createSolidPng();
    const nativeImage = {
      getSize: () => ({ width: 1, height: 1 }),
      isEmpty: () => false,
      toPNG: () => png,
    };
    const writeImage = vi.fn();
    const createFromBuffer = vi.fn(() => nativeImage);
    const adapter = createElectronClipboardImageAdapter({
      readImage: () => nativeImage,
      writeImage,
    }, { createFromBuffer });

    await expect(adapter.writeImage!(png)).resolves.toBe(true);
    expect(createFromBuffer).toHaveBeenCalledWith(png);
    expect(writeImage).toHaveBeenCalledWith(nativeImage);
  });

  it('publishes a Windows DeviceIndependentBitmap for native editors', async () => {
    const png = createSolidPng();
    const dibPixels = Uint8Array.from([1, 2, 3, 255]);
    const nativeImage = {
      getSize: () => ({ width: 1, height: 1 }),
      isEmpty: () => false,
      toBitmap: () => dibPixels,
      toPNG: () => png,
    };
    const writeBuffer = vi.fn();
    const adapter = createElectronClipboardImageAdapter({
      readImage: () => nativeImage,
      writeImage: vi.fn(),
      writeBuffer,
    }, { createFromBuffer: () => nativeImage });

    await expect(adapter.writeImage!(png)).resolves.toBe(true);
    expect(writeBuffer).toHaveBeenCalledOnce();
    const [format, buffer] = writeBuffer.mock.calls[0]!;
    expect(format).toBe('DeviceIndependentBitmap');
    expect(buffer.readInt32LE(0)).toBe(40);
    expect(buffer.readInt32LE(4)).toBe(1);
    expect(buffer.readInt32LE(8)).toBe(-1);
    expect(buffer.readUInt16LE(14)).toBe(32);
    expect([...buffer.subarray(40)]).toEqual([...dibPixels]);
  });

  it('copies a decoded image without synchronously encoding it to PNG first', async () => {
    const png = createSolidPng();
    const toPNG = vi.fn(() => { throw new Error('Unexpected costly re-encode'); });
    const nativeImage = {
      getSize: () => ({ width: 4096, height: 4096 }),
      isEmpty: () => false,
      toPNG,
    };
    const writeImage = vi.fn();
    const adapter = createElectronClipboardImageAdapter({ readImage: () => nativeImage, writeImage }, {
      createFromBuffer: () => nativeImage,
    });

    await expect(adapter.writeImage!(png)).resolves.toBe(true);
    expect(writeImage).toHaveBeenCalledWith(nativeImage);
    expect(toPNG).not.toHaveBeenCalled();
  });

  it.each([{ width: 8193, height: 1 }, { width: 8192, height: 8192 }])(
    'rejects decoded clipboard writes beyond supported dimensions: %o', async ({ width, height }) => {
      const png = createSolidPng();
      const nativeImage = { getSize: () => ({ width, height }), isEmpty: () => false, toPNG: vi.fn(() => png) };
      const writeImage = vi.fn();
      const adapter = createElectronClipboardImageAdapter({ readImage: () => nativeImage, writeImage }, {
        createFromBuffer: () => nativeImage,
      });

      await expect(adapter.writeImage!(png)).resolves.toBe(false);
      expect(writeImage).not.toHaveBeenCalled();
      expect(nativeImage.toPNG).not.toHaveBeenCalled();
    },
  );

  it('returns only trusted PNG bytes, dimensions, and a safe label', async () => {
    const png = createSolidPng();
    const adapter = createElectronClipboardImageAdapter({
      readImage: () => ({
        getSize: () => ({ width: 1, height: 1 }),
        isEmpty: () => false,
        toPNG: () => png,
      }),
    });

    await expect(adapter.readImage()).resolves.toEqual({
      bytes: png,
      height: 1,
      label: 'Clipboard image',
      width: 1,
    });
  });

  it('falls back to a validated raw PNG clipboard format when Electron readImage is empty', async () => {
    const png = createSolidPng();
    const adapter = createElectronClipboardImageAdapter({
      availableFormats: () => ['PNG', 'DeviceIndependentBitmap'],
      readBuffer: vi.fn(() => png),
      readImage: () => ({
        getSize: () => ({ width: 0, height: 0 }),
        isEmpty: () => true,
        toPNG: () => Buffer.alloc(0),
      }),
    });

    await expect(adapter.readImage()).resolves.toEqual({
      bytes: png,
      height: 1,
      label: 'Clipboard image',
      width: 1,
    });
  });

  it('imports one image file copied from Windows Explorer through FileNameW', async () => {
    const png = createSolidPng();
    const sourcePath = ['C:', 'Users', 'Artist', 'Desktop', 'reference.jpg'].join(win32.sep);
    const createFromPath = vi.fn(() => ({
      getSize: () => ({ width: 1, height: 1 }),
      isEmpty: () => false,
      toPNG: () => png,
    }));
    const adapter = createElectronClipboardImageAdapter({
      availableFormats: () => ['FileNameW', 'Preferred DropEffect'],
      readBuffer: (format) => format === 'FileNameW'
        ? Buffer.from(`${sourcePath}\0`, 'utf16le')
        : Buffer.alloc(0),
      readImage: () => ({
        getSize: () => ({ width: 0, height: 0 }),
        isEmpty: () => true,
        toPNG: () => Buffer.alloc(0),
      }),
    }, { createFromPath });

    await expect(adapter.readImage()).resolves.toEqual({
      bytes: png,
      height: 1,
      label: 'Clipboard image',
      width: 1,
    });
    expect(createFromPath).toHaveBeenCalledWith(sourcePath);
  });

  it('probes FileNameW when Electron advertises a Windows image file only as text/uri-list', async () => {
    const png = createSolidPng();
    const sourcePath = ['C:', 'Users', 'Artist', 'Desktop', 'hidden-reference.png'].join(win32.sep);
    const createFromPath = vi.fn(() => ({
      getSize: () => ({ width: 1, height: 1 }),
      isEmpty: () => false,
      toPNG: () => png,
    }));
    const adapter = createElectronClipboardImageAdapter({
      availableFormats: () => ['text/uri-list'],
      readBuffer: (format) => format === 'FileNameW'
        ? Buffer.from(`${sourcePath}\0`, 'utf16le')
        : Buffer.alloc(0),
      readImage: () => ({
        getSize: () => ({ width: 0, height: 0 }),
        isEmpty: () => true,
        toPNG: () => Buffer.alloc(0),
      }),
    }, { createFromPath });

    await expect(adapter.readImage()).resolves.toMatchObject({ height: 1, label: 'Clipboard image', width: 1 });
    expect(createFromPath).toHaveBeenCalledWith(sourcePath);
  });

  it('rejects multiple hidden FileNameW image paths', async () => {
    const first = ['C:', 'Users', 'Artist', 'Desktop', 'first.png'].join(win32.sep);
    const second = ['C:', 'Users', 'Artist', 'Desktop', 'second.png'].join(win32.sep);
    const createFromPath = vi.fn();
    const adapter = createElectronClipboardImageAdapter({
      availableFormats: () => ['text/uri-list'],
      readBuffer: (format) => format === 'FileNameW'
        ? Buffer.from(`${first}\0${second}\0`, 'utf16le')
        : Buffer.alloc(0),
      readImage: () => ({
        getSize: () => ({ width: 0, height: 0 }),
        isEmpty: () => true,
        toPNG: () => Buffer.alloc(0),
      }),
    }, { createFromPath });

    await expect(adapter.readImage()).resolves.toBeNull();
    expect(createFromPath).not.toHaveBeenCalled();
  });

  it.each([
    { width: 0, height: 480, bytes: 3 },
    { width: 8193, height: 1, bytes: 3 },
    { width: 8192, height: 8192, bytes: 3 },
    { width: 1, height: 1, bytes: 64 * 1024 * 1024 + 1 },
  ])('rejects empty, oversized, or over-budget clipboard images: %o', async ({ width, height, bytes }) => {
    const adapter = createElectronClipboardImageAdapter({
      readImage: vi.fn(() => ({
        getSize: () => ({ width, height }),
        isEmpty: () => width === 0 || height === 0,
        toPNG: () => Buffer.alloc(bytes),
      })),
    });

    await expect(adapter.readImage()).resolves.toBeNull();
  });
});
