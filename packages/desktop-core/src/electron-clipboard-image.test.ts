import { describe, expect, it, vi } from 'vitest';
import { win32 } from 'node:path';

import { createElectronClipboardImageAdapter } from './electron-clipboard-image';
import { createSolidPng } from './test/png-fixture';

describe('Electron clipboard image adapter', () => {
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
