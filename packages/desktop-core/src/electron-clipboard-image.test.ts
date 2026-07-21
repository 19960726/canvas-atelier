import { describe, expect, it, vi } from 'vitest';

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
