import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createPhotoshopPlacementPayload } from './photoshop-script.js';

interface PlacementGeometry {
  readonly layerWidth: number;
  readonly layerHeight: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}

async function runEmbeddedPlacement(input: PlacementGeometry, failResize = false) {
  const scriptPath = fileURLToPath(new URL('./photoshop-place-smart-object.jsx', import.meta.url));
  const source = (await readFile(scriptPath, 'utf8'))
    .replace(/^#target photoshop\s*/u, '')
    .replace('__PAYLOAD_PATH__', 'payload.json');
  const payload = createPhotoshopPlacementPayload({ absolutePath: 'E:/managed/source.png', layerName: 'Placed image' });
  const bounds = {
    left: 17,
    top: 23,
    right: 17 + input.layerWidth,
    bottom: 23 + input.layerHeight,
  };
  const resizeCalls: Array<{ readonly horizontal: number; readonly vertical: number; readonly anchor: string }> = [];
  const layers: unknown[] = [];
  const unit = (value: number) => ({ as: (name: string) => {
    if (name !== 'px') throw new Error(`Unexpected unit ${name}`);
    return value;
  } });
  const layer = {
    kind: 'smart-object',
    name: '',
    get bounds() {
      return [unit(bounds.left), unit(bounds.top), unit(bounds.right), unit(bounds.bottom)];
    },
    resize(horizontal: number, vertical: number, anchor: string) {
      if (failResize) throw new Error('resize unavailable');
      resizeCalls.push({ horizontal, vertical, anchor });
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
      const index = layers.indexOf(layer);
      if (index >= 0) layers.splice(index, 1);
    },
  };
  const documentRef = {
    width: unit(input.canvasWidth),
    height: unit(input.canvasHeight),
    activeLayer: layer,
    get activeHistoryState() { return layers.slice(); },
    set activeHistoryState(state: unknown[]) { layers.splice(0, layers.length, ...state); },
  };
  class FakeFile {
    exists = true;
    encoding = '';
    constructor(readonly path: string) {}
    open() { return true; }
    read() { return this.path === 'payload.json' ? payload : ''; }
    close() {}
  }
  class FakeActionDescriptor {
    putPath() {}
    putEnumerated() {}
  }
  let error: unknown;
  try { runInNewContext(source, {
    ActionDescriptor: FakeActionDescriptor,
    AnchorPosition: { MIDDLECENTER: 'middle-center' },
    DialogModes: { NO: 0 },
    File: FakeFile,
    LayerKind: { SMARTOBJECT: 'smart-object' },
    SaveOptions: { DONOTSAVECHANGES: 2 },
    app: { activeDocument: documentRef, documents: [documentRef] },
    charIDToTypeID: (value: string) => value,
    decodeURIComponent,
    escape,
    executeAction: (action: string) => {
      if (action !== 'Plc ') throw new Error(`Unexpected action ${action}`);
      if (!layers.includes(layer)) layers.push(layer);
      documentRef.activeLayer = layer;
    },
    isFinite,
    Math,
    stringIDToTypeID: (value: string) => value,
  }); } catch (caught) { error = caught; }
  return {
    error,
    bounds,
    layerCount: layers.length,
    resizeCalls,
  };
}

describe('Photoshop placement script contract', () => {
  it('rolls back a partially placed layer when fitting fails', async () => {
    const result = await runEmbeddedPlacement({ layerWidth: 120, layerHeight: 60, canvasWidth: 240, canvasHeight: 240 }, true);
    expect(result.error).toBeDefined();
    expect(result.layerCount).toBe(0);
  });

  it.each([false, true])('does not place a second image after the JSX attempt (lost acknowledgement: %s)', async (lostAcknowledgement) => {
    const runnerPath = fileURLToPath(new URL('./photoshop-windows-runner.js', import.meta.url));
    const source = (await readFile(runnerPath, 'utf8')).replace(/WScript\.Quit\(0\);/gu, 'return;');
    const payload = createPhotoshopPlacementPayload({ absolutePath: 'E:/image.png', layerName: 'Placed image' });
    let layerCount = 0;
    const output: string[] = [];
    const application = {
      version: '27.0', documents: { Count: 1 },
      activeDocument: { activeLayer: { get name() { throw new Error('stale COM layer proxy'); } } },
      DoJavaScript: () => {
        layerCount += 1;
        if (lostAcknowledgement) throw new Error('COM response unavailable after placement');
        return 'canvas-placed:Placed image';
      },
      open: () => ({ activeLayer: { duplicate: () => { layerCount += 1; return { name: 'duplicate' }; } }, close: () => undefined }),
    };
    runInNewContext(source, {
      GetObject: () => application,
      ActiveXObject: function () { return { OpenTextFile: (path: string) => ({ ReadAll: () => path === 'payload.json' ? payload : 'jsx', Close: () => undefined }) }; },
      WScript: { Arguments: { length: 2, Item: (index: number) => index === 0 ? 'place.jsx' : 'payload.json' }, StdOut: { Write: (value: string) => output.push(value) } },
    });
    expect(layerCount).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ kind: lostAcknowledgement ? 'placement_failed' : 'success' });
  });
  it('encodes paths and layer names as data instead of executable source', () => {
    const payload = createPhotoshopPlacementPayload({
      absolutePath: 'E:/image/quote";app.activeDocument.save();//.png',
      layerName: 'Generated\nLayer',
    });

    expect(payload).not.toContain('app.activeDocument.save()');
    expect(JSON.parse(payload)).toEqual({
      version: 1,
      imagePathBase64: Buffer.from('E:/image/quote";app.activeDocument.save();//.png', 'utf8').toString('base64'),
      layerNameBase64: Buffer.from('Generated\nLayer', 'utf8').toString('base64'),
    });
  });

  it('uses a confined embedded-placement script without document or clipboard mutations', async () => {
    const scriptPath = fileURLToPath(new URL('./photoshop-place-smart-object.jsx', import.meta.url));
    const scriptSource = await readFile(scriptPath, 'utf8');

    expect(scriptSource).toContain("executeAction(charIDToTypeID('Plc ')");
    expect(scriptSource).toContain('Math.min(canvasWidth / layerWidth, canvasHeight / layerHeight)');
    expect(scriptSource).toContain('AnchorPosition.MIDDLECENTER');
    expect(scriptSource).not.toMatch(/saveAs|clipboard|placedLayerRelinkToFile/iu);
    expect(scriptSource).not.toMatch(/(?:app\.activeDocument|documentRef)\.(?:save|close)\s*\(/u);
  });

  it.each([
    { name: 'small landscape', layerWidth: 120, layerHeight: 60, expected: { left: 0, top: 60, right: 240, bottom: 180 } },
    { name: 'large landscape', layerWidth: 320, layerHeight: 180, expected: { left: 0, top: 52.5, right: 240, bottom: 187.5 } },
    { name: 'small portrait', layerWidth: 60, layerHeight: 120, expected: { left: 60, top: 0, right: 180, bottom: 240 } },
    { name: 'large portrait', layerWidth: 180, layerHeight: 320, expected: { left: 52.5, top: 0, right: 187.5, bottom: 240 } },
  ])('contains and centers one $name Smart Object', async ({ layerWidth, layerHeight, expected }) => {
    const result = await runEmbeddedPlacement({ layerWidth, layerHeight, canvasWidth: 240, canvasHeight: 240 });

    expect(result.bounds).toEqual(expected);
    expect(result.resizeCalls).toEqual([{
      horizontal: 240 / Math.max(layerWidth, layerHeight) * 100,
      vertical: 240 / Math.max(layerWidth, layerHeight) * 100,
      anchor: 'middle-center',
    }]);
    expect(result.layerCount).toBe(1);
  });

  it('keeps every Photoshop placement path as a proportional embedded Smart Object', async () => {
    const scriptPath = fileURLToPath(new URL('./photoshop-place-smart-object.jsx', import.meta.url));
    const runnerPath = fileURLToPath(new URL('./photoshop-windows-runner.js', import.meta.url));
    const [scriptSource, runnerSource] = await Promise.all([
      readFile(scriptPath, 'utf8'),
      readFile(runnerPath, 'utf8'),
    ]);

    // The ExtendScript fallback and the Windows COM fallback both used to
    // report a copied pixel layer as success when Place was unavailable.
    expect(scriptSource).toContain("stringIDToTypeID('newPlacedLayer')");
    expect(scriptSource).toContain('LayerKind.SMARTOBJECT');
    expect(scriptSource).not.toContain('JSON.parse(raw)');
    expect(scriptSource).toContain("readPayloadString(raw, 'imagePathBase64')");
    expect(runnerSource).toContain('newPlacedLayer');
    expect(runnerSource).toContain('LayerKind.SMARTOBJECT');
    expect(runnerSource).toContain('Math.min(canvasWidth / layerWidth, canvasHeight / layerHeight)');
    expect(runnerSource).toContain('canvasCenterX - layerCenterX');
    expect(runnerSource).toContain('return resolvedLayerName');
    expect(runnerSource).not.toContain('return copiedLayer.name');
    expect(runnerSource).not.toContain('successful duplication is already a valid import');
  });

  it('detects open Photoshop documents through the Windows COM Count property', async () => {
    const runnerPath = fileURLToPath(new URL('./photoshop-windows-runner.js', import.meta.url));
    const source = (await readFile(runnerPath, 'utf8')).replace(/WScript\.Quit\(0\);/gu, 'return;');
    const output: string[] = [];
    runInNewContext(source, {
      GetObject: () => ({ version: '27.0', documents: { Count: 1 } }),
      WScript: { Arguments: { length: 1, Item: () => '--inspect' }, StdOut: { Write: (value: string) => output.push(value) } },
    });
    expect(JSON.parse(output[0]!)).toMatchObject({ kind: 'running', activeDocument: true });
  });

  it('keeps the Windows Script Host runner compatible with legacy JScript syntax', async () => {
    const runnerPath = fileURLToPath(new URL('./photoshop-windows-runner.js', import.meta.url));
    const runnerSource = await readFile(runnerPath, 'utf8');

    expect(runnerSource).not.toContain('/iu');
    expect(runnerSource).not.toContain('/gu');
    expect(runnerSource).not.toMatch(/,\s*[}\]]/u);
    expect(runnerSource).not.toContain('JSON.stringify');
    expect(runnerSource).toContain('majorVersion < 13');
    expect(runnerSource).not.toContain('majorVersion < 20');
  });
});
