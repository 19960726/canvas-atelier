import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  createNodeWindowsPhotoshopSmartObjectAdapter,
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

describe('Windows Photoshop smart object adapter', () => {
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
