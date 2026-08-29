import { describe, expect, it, vi } from 'vitest';
import {
  createNodeWindowsPhotoshopSmartObjectAdapter,
  createWindowsPhotoshopSmartObjectAdapter,
} from './photoshop-windows-adapter.js';

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

describe('Windows Photoshop smart object adapter', () => {
  it('creates the production adapter from fixed application resources', () => {
    const adapter = createNodeWindowsPhotoshopSmartObjectAdapter({
      platform: 'darwin',
      jsxResourcePath: '/app/photoshop-place-smart-object.jsx',
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

  it.each([
    { platform: 'darwin', installations: [], running: null, expected: 'desktop_bridge_unavailable' },
    { platform: 'win32', installations: [], running: null, expected: 'photoshop_not_installed' },
    { platform: 'win32', installations: [{ majorVersion: 12, executablePath: 'old.exe' }], running: { majorVersion: 12, activeDocument: true }, expected: 'photoshop_version_unsupported' },
    { platform: 'win32', installations: [{ majorVersion: 25, executablePath: 'new.exe' }], running: null, expected: 'photoshop_not_running' },
    { platform: 'win32', installations: [{ majorVersion: 25, executablePath: 'new.exe' }], running: { majorVersion: 25, activeDocument: false }, expected: 'no_active_document' },
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
